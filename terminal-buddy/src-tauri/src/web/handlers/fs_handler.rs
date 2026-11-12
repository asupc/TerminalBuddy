//! Web 端项目文件树（只读浏览）：可浏览服务器任意目录，不要求目录已登记为项目。
//! 目录读取复用 PC 端 `list_directory`；排除模式 Web 端暂不可配置，用固定常见集。

use crate::services::directory_browser_service::{self, ServerDirectory};
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use axum::{extract::{Query, State}, Json};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListQuery {
    pub path: String,
}

/// Web 文件树默认排除：PC 端排除模式可配置，Web 端第一版先用固定集合。
fn web_exclusions() -> Vec<String> {
    [
        ".git", "node_modules", "target", "dist", "build", "out", "bin", "obj",
        ".venv", "venv", "__pycache__", ".idea", ".next", ".gradle", ".sass-cache",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// 列出目录内容（目录在前、按名称排序，与 PC 端一致）。
/// 只读浏览不限制目录是否已登记；文件内容读取与写入仍由各自接口校验项目范围。
pub async fn list(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Query(q): Query<FsListQuery>,
) -> Result<Json<Vec<crate::commands::fs::FileNode>>, ApiError> {
    let path = q.path;
    let exclusions = web_exclusions();
    let nodes = tokio::task::spawn_blocking(move || {
        crate::commands::fs::list_directory(path, Some(exclusions))
    })
    .await
    .map_err(|error| ApiError::Internal(format!("读取目录任务执行失败: {}", error)))?
    .map_err(ApiError::Internal)?;
    Ok(Json(nodes))
}


fn browse_roots() -> Result<Vec<ServerDirectory>, ApiError> {
    let projects = crate::commands::profile::get_projects()
        .map_err(ApiError::Internal)?
        .into_iter()
        .map(|project| ServerDirectory { name: project.name, path: project.path })
        .collect();
    Ok(directory_browser_service::browse_roots(projects, super::is_docker_runtime()))
}

/// 项目选择器入口：文件系统根、配置目录、工作区、Docker 挂载目录及已登记项目。
pub async fn roots(_claims: ClaimsFromRequest) -> Result<Json<Vec<ServerDirectory>>, ApiError> {
    let roots = tokio::task::spawn_blocking(browse_roots)
        .await
        .map_err(|error| ApiError::Internal(format!("读取浏览入口失败：{}", error)))??;
    Ok(Json(roots))
}

/// 添加项目时允许浏览服务器任意目录，不要求目录已登记。
pub async fn directories(
    _claims: ClaimsFromRequest,
    Query(q): Query<FsListQuery>,
) -> Result<Json<Vec<ServerDirectory>>, ApiError> {
    let directories = tokio::task::spawn_blocking(move || {
        let path = directory_browser_service::resolve_directory(&q.path).map_err(ApiError::Forbidden)?;
        directory_browser_service::list_directories(&path).map_err(ApiError::BadRequest)
    })
    .await
    .map_err(|error| ApiError::Internal(format!("读取目录任务执行失败：{}", error)))??;
    Ok(Json(directories))
}
