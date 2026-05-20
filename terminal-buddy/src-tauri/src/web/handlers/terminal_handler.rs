use axum::{Json, extract::{State, Path}};
use crate::commands::TerminalService;
use crate::models::web_api::{TerminalInfo, StartTerminalRequest};
use crate::services::ProfileService;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use tauri::Manager;

pub async fn list(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<TerminalInfo>>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    let instances = ts.instances.lock().unwrap();
    let terminals: Vec<TerminalInfo> = instances.values().map(|inst| {
        let profile = ProfileService::get_profile(&inst.profile_id).ok();
        TerminalInfo {
            id: inst.id.clone(),
            profile_id: inst.profile_id.clone(),
            profile_name: profile.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
            terminal_type: profile.as_ref().map(|p| p.terminal_type.clone()).unwrap_or_default(),
        }
    }).collect();
    Ok(Json(terminals))
}

pub async fn start(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<StartTerminalRequest>,
) -> Result<Json<TerminalInfo>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    let terminal_id = ts.create_terminal(&req.profile_id, state.app_handle.clone())
        .map_err(|e| ApiError::Internal(e))?;
    let profile = ProfileService::get_profile(&req.profile_id)
        .map_err(|e| ApiError::Internal(e))?;
    Ok(Json(TerminalInfo {
        id: terminal_id,
        profile_id: req.profile_id,
        profile_name: profile.name,
        terminal_type: profile.terminal_type,
    }))
}

pub async fn close(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    ts.close_terminal(&id).map_err(|e| ApiError::Internal(e))?;
    Ok(Json(serde_json::json!({ "closed": true })))
}
