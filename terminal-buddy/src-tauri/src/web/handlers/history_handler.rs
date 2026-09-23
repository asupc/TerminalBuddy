use crate::services::ClientDataService;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use axum::{extract::State, Json};

/// 命令历史的持久化 key（与 PC 端共享 ClientData/command_history.json）。
const HISTORY_KEY: &str = "command_history";

/// 读取命令历史列表。文件不存在或解析失败时返回空数组。
pub async fn list(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<serde_json::Value>, ApiError> {
    let raw = ClientDataService::read(HISTORY_KEY).map_err(ApiError::Internal)?;
    let value: serde_json::Value = match raw {
        Some(content) => {
            serde_json::from_str(&content).unwrap_or_else(|_| serde_json::Value::Array(vec![]))
        }
        None => serde_json::Value::Array(vec![]),
    };
    Ok(Json(value))
}

/// 整体替换命令历史列表（与 PC 端 writeClientData 的全量写入语义一致）。
pub async fn replace(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(value): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !value.is_array() {
        return Err(ApiError::BadRequest("历史列表必须是数组".to_string()));
    }
    let serialized =
        serde_json::to_string(&value).map_err(|e| ApiError::Internal(e.to_string()))?;
    ClientDataService::write(HISTORY_KEY, &serialized).map_err(ApiError::Internal)?;
    Ok(Json(value))
}
