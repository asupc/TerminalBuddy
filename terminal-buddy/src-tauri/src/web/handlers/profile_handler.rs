use axum::{Json, extract::{State, Path}};
use crate::models::Profile;
use crate::services::ProfileService;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;

pub async fn list(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<Profile>>, ApiError> {
    ProfileService::get_all_profiles().map(Json).map_err(|e| ApiError::Internal(e))
}

pub async fn create(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(profile): Json<Profile>,
) -> Result<Json<Profile>, ApiError> {
    if profile.name.trim().is_empty() {
        return Err(ApiError::BadRequest("连接名称不能为空".to_string()));
    }
    let valid_types = ["powershell", "cmd", "ssh", "docker", "k8s", "mstsc"];
    if !valid_types.contains(&profile.terminal_type.as_str()) {
        return Err(ApiError::BadRequest(format!("不支持的终端类型: {}", profile.terminal_type)));
    }
    let created = ProfileService::create_profile(&profile.name, &profile.group, &profile.terminal_type)
        .map_err(|e| ApiError::Internal(e))?;
    let mut full = profile;
    full.id = created.id;
    full.created_at = created.created_at;
    full.last_used_at = created.last_used_at;
    ProfileService::update_profile(&full).map_err(|e| ApiError::Internal(e))?;
    Ok(Json(full))
}

pub async fn update(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
    Json(profile): Json<Profile>,
) -> Result<Json<Profile>, ApiError> {
    if profile.id != id {
        return Err(ApiError::BadRequest("ID 不匹配".into()));
    }
    ProfileService::update_profile(&profile).map_err(|e| ApiError::Internal(e))?;
    Ok(Json(profile))
}

pub async fn delete(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    ProfileService::delete_profile(&id).map_err(|e| ApiError::Internal(e))?;
    Ok(Json(serde_json::json!({ "deleted": true })))
}
