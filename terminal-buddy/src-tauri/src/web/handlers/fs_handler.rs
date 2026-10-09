//! Web 端项目文件树（只读浏览）：仅暴露已登记项目目录内的内容。
//! 目录读取复用 PC 端 `list_directory`；排除模式 Web 端暂不可配置，用固定常见集。

use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::handlers::ensure_project_scope;
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

/// 列出项目目录内容（目录在前、按名称排序，与 PC 端一致）。
pub async fn list(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Query(q): Query<FsListQuery>,
) -> Result<Json<Vec<crate::commands::fs::FileNode>>, ApiError> {
    ensure_project_scope(&q.path)?;
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
