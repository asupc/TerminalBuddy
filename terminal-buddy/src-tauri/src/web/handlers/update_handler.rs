use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use axum::{extract::{Query, State}, Json};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct UpdateStatusQuery {
    id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatusFile {
    update_id: String,
    status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatusResponse {
    update_id: String,
    status: String,
    log: String,
}

/// 读取独立更新容器写入 /data 的更新状态与完整日志。
///
/// 文件 IO 放入 spawn_blocking；路径固定在数据目录内，不接受客户端路径。
pub async fn status(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Query(query): Query<UpdateStatusQuery>,
) -> Result<Json<UpdateStatusResponse>, ApiError> {
    tokio::task::spawn_blocking(move || {
        if query.id.is_empty() || !query.id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.')) {
            return Err(ApiError::BadRequest("更新编号无效".to_string()));
        }
        let dir = PathBuf::from("/data/.terminal-buddy-update");
        let status_path = dir.join("status.json");
        let file = std::fs::read_to_string(&status_path).map_err(|_| {
            ApiError::NotFound("当前没有可读取的更新记录".to_string())
        })?;
        let status: UpdateStatusFile = serde_json::from_str(&file)
            .map_err(|_| ApiError::Internal("更新状态文件损坏".to_string()))?;
        if status.update_id != query.id {
            return Err(ApiError::NotFound("更新记录不存在".to_string()));
        }
        let log = std::fs::read_to_string(dir.join("update.log")).unwrap_or_default();
        Ok(Json(UpdateStatusResponse {
            update_id: status.update_id,
            status: status.status,
            log,
        }))
    })
    .await
    .map_err(|_| ApiError::Internal("读取更新状态失败".to_string()))?
}
