use axum::{Json, extract::{State, Path}};
use crate::commands::TerminalService;
use crate::models::web_api::{TerminalInfo, StartTerminalRequest};
use crate::services::ProfileService;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use tauri::{Manager, Emitter};

pub async fn list(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<TerminalInfo>>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    // Collect IDs while holding lock, then release before reading profiles
    let instance_ids: Vec<(String, String)> = {
        let instances = ts.instances.lock().unwrap();
        instances.values().map(|inst| (inst.id.clone(), inst.profile_id.clone())).collect()
    };
    let terminals: Vec<TerminalInfo> = instance_ids.into_iter().map(|(id, profile_id)| {
        let profile = ProfileService::get_profile(&profile_id).ok();
        TerminalInfo {
            id,
            profile_id: profile_id.clone(),
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

    // Reuse existing terminal for the same profile if already running
    {
        let instances = ts.instances.lock().unwrap();
        for inst in instances.values() {
            if inst.profile_id == req.profile_id {
                let profile = ProfileService::get_profile(&req.profile_id)
                    .map_err(|e| ApiError::Internal(e))?;
                let info = TerminalInfo {
                    id: inst.id.clone(),
                    profile_id: req.profile_id,
                    profile_name: profile.name,
                    terminal_type: profile.terminal_type,
                };
                let _ = state.app_handle.emit("terminal-created", info.clone());
                return Ok(Json(info));
            }
        }
    }

    let terminal_id = ts.create_terminal(&req.profile_id, state.app_handle.clone())
        .map_err(|e| ApiError::Internal(e))?;
    let profile = ProfileService::get_profile(&req.profile_id)
        .map_err(|e| ApiError::Internal(e))?;
    let info = TerminalInfo {
        id: terminal_id,
        profile_id: req.profile_id,
        profile_name: profile.name,
        terminal_type: profile.terminal_type,
    };
    let _ = state.app_handle.emit("terminal-created", info.clone());
    Ok(Json(info))
}

pub async fn close(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    ts.close_terminal(&id).map_err(|e| ApiError::Internal(e))?;
    let _ = state.app_handle.emit("terminal-closed", &id);
    Ok(Json(serde_json::json!({ "closed": true })))
}
