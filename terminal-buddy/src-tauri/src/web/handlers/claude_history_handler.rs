//! Claude 历史会话 REST：列表 / 检索 / 回放 / 管理 / 导出。
//! 服务层与 PC 端 Tauri 命令共用（`services::claude_history_service`）；
//! transcript 读取与索引扫描是重 IO，全部 `spawn_blocking`，不占连接线程。

use crate::models::web_api::{ClaudeDeleteBatchRequest, ClaudeFlagsRequest, ClaudeRenameRequest};
use crate::services::claude_history_service::{
    self, ClaudeHistoryScanResult, ClaudeReplayPage, ClaudeSearchHit, ClaudeSessionItem,
};
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub project_dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    #[serde(default)]
    pub project_dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayQuery {
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_replay_limit")]
    pub limit: usize,
}

fn default_replay_limit() -> usize {
    50
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportQuery {
    pub format: String,
}

/// 打开历史面板时增量索引：本批同步返回，剩余由后台补齐任务继续
/// （与 PC 端 `claude_history_rescan` 同一入口；Web 端暂不监听补齐广播，下次刷新可见）。
pub async fn rescan(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<ClaudeHistoryScanResult>, ApiError> {
    let app = state.app_handle.clone();
    let result = tokio::task::spawn_blocking(move || claude_history_service::scan_and_index(&app))
        .await
        .map_err(|error| ApiError::Internal(format!("索引任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    Ok(Json(result))
}

pub async fn list(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<ClaudeSessionItem>>, ApiError> {
    let items = tokio::task::spawn_blocking(move || {
        claude_history_service::list_sessions(q.include_archived, q.project_dir.as_deref())
    })
    .await
    .map_err(|error| ApiError::Internal(format!("查询任务执行失败: {}", error)))?
    .map_err(ApiError::Internal)?;
    Ok(Json(items))
}

pub async fn search(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Vec<ClaudeSearchHit>>, ApiError> {
    let hits = tokio::task::spawn_blocking(move || {
        claude_history_service::search(&q.query, q.project_dir.as_deref())
    })
    .await
    .map_err(|error| ApiError::Internal(format!("检索任务执行失败: {}", error)))?
    .map_err(ApiError::Internal)?;
    Ok(Json(hits))
}

pub async fn replay(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(session_id): Path<String>,
    Query(q): Query<ReplayQuery>,
) -> Result<Json<ClaudeReplayPage>, ApiError> {
    let page = tokio::task::spawn_blocking(move || {
        claude_history_service::get_replay(&session_id, q.offset, q.limit)
    })
    .await
    .map_err(|error| ApiError::Internal(format!("回放任务执行失败: {}", error)))?
    .map_err(ApiError::Internal)?;
    Ok(Json(page))
}

pub async fn rename(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(session_id): Path<String>,
    Json(req): Json<ClaudeRenameRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    tokio::task::spawn_blocking(move || {
        claude_history_service::rename_session(&session_id, &req.title)
    })
    .await
    .map_err(|error| ApiError::Internal(format!("重命名任务执行失败: {}", error)))?
    .map_err(ApiError::Internal)?;
    Ok(Json(serde_json::json!({ "renamed": true })))
}

pub async fn set_flags(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(session_id): Path<String>,
    Json(req): Json<ClaudeFlagsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    tokio::task::spawn_blocking(move || {
        claude_history_service::set_flags(&session_id, req.starred, req.archived)
    })
    .await
    .map_err(|error| ApiError::Internal(format!("更新状态任务执行失败: {}", error)))?
    .map_err(ApiError::Internal)?;
    Ok(Json(serde_json::json!({ "updated": true })))
}

pub async fn delete(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    tokio::task::spawn_blocking(move || claude_history_service::delete_session(&session_id))
        .await
        .map_err(|error| ApiError::Internal(format!("删除任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    Ok(Json(serde_json::json!({ "deleted": true })))
}

pub async fn delete_batch(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<ClaudeDeleteBatchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let count = req.session_ids.len();
    tokio::task::spawn_blocking(move || {
        claude_history_service::delete_sessions(&req.session_ids)
    })
    .await
    .map_err(|error| ApiError::Internal(format!("批量删除任务执行失败: {}", error)))?
    .map_err(ApiError::Internal)?;
    Ok(Json(serde_json::json!({ "deleted": count })))
}

/// 导出为文本响应（text/plain），前端拿内容生成 Blob 下载，文件名由前端命名。
pub async fn export(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(session_id): Path<String>,
    Query(q): Query<ExportQuery>,
) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || {
        claude_history_service::export_session_content(&session_id, &q.format)
    })
    .await
    .map_err(|error| ApiError::Internal(format!("导出任务执行失败: {}", error)))?
    .map_err(ApiError::Internal)
}
