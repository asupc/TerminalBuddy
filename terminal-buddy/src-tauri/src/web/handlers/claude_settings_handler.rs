//! Claude 默认配置文件 REST：读 / 写 / 备份列表 / 恢复。
//! 与 PC 端 Tauri 命令共用 `services::claude_settings_service`；用户级数据，
//! 不套 `ensure_project_scope`。响应含密钥材料（`env.ANTHROPIC_*`），
//! 统一加 `Cache-Control: no-store`。

use axum::extract::{Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::services::claude_settings_service;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;

fn no_store_json<T: serde::Serialize>(value: &T) -> Result<Response, ApiError> {
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

pub async fn read(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Response, ApiError> {
    let view = tokio::task::spawn_blocking(claude_settings_service::read_settings)
        .await
        .map_err(|error| ApiError::Internal(format!("读取任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    no_store_json(&view)
}

pub async fn write(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(content): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let result = tokio::task::spawn_blocking(move || claude_settings_service::write_settings(&content))
        .await
        .map_err(|error| ApiError::Internal(format!("写入任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    no_store_json(&result)
}

pub async fn list_backups(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Response, ApiError> {
    let backups = tokio::task::spawn_blocking(claude_settings_service::list_backups)
        .await
        .map_err(|error| ApiError::Internal(format!("查询任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    no_store_json(&backups)
}

pub async fn restore_backup(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let result =
        tokio::task::spawn_blocking(move || claude_settings_service::restore_backup(&id))
            .await
            .map_err(|error| ApiError::Internal(format!("恢复任务执行失败: {}", error)))?
            .map_err(ApiError::Internal)?;
    no_store_json(&result)
}
