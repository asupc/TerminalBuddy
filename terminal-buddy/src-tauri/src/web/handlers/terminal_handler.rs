use axum::{Json, extract::{State, Path}};
use crate::commands::TerminalService;
use crate::models::TerminalOwner;
use crate::models::web_api::{TerminalInfo, StartTerminalRequest};
use crate::services::{ProfileService, SettingsService};
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use tauri::{Manager, Emitter};

pub async fn list(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<TerminalInfo>>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();

    // 获取设置
    let settings = SettingsService::get_settings();

    // Collect IDs while holding lock, then release before reading profiles
    let instance_ids: Vec<(String, String, TerminalOwner)> = {
        let instances = ts.instances.lock().unwrap();
        instances.values()
            .filter(|inst| {
                // 共享模式：返回所有终端
                // 不共享模式：只返回 Web 端创建的终端
                settings.web_api_share_sessions || inst.owner == TerminalOwner::Web
            })
            .map(|inst| (inst.id.clone(), inst.profile_id.clone(), inst.owner.clone()))
            .collect()
    };
    let terminals: Vec<TerminalInfo> = instance_ids.into_iter().map(|(id, profile_id, owner)| {
        let profile = ProfileService::get_profile(&profile_id).ok();
        TerminalInfo {
            id,
            profile_id: profile_id.clone(),
            profile_name: profile.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
            terminal_type: profile.as_ref().map(|p| p.terminal_type.clone()).unwrap_or_default(),
            owner,
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

    let terminal_id = ts.create_terminal(&req.profile_id, None, req.rows.unwrap_or(0), req.cols.unwrap_or(0), state.app_handle.clone(), TerminalOwner::Web)
        .map_err(|e| ApiError::Internal(e))?;
    let profile = ProfileService::get_profile(&req.profile_id)
        .map_err(|e| ApiError::Internal(e))?;
    let info = TerminalInfo {
        id: terminal_id,
        profile_id: req.profile_id,
        profile_name: profile.name,
        terminal_type: profile.terminal_type,
        owner: TerminalOwner::Web,
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
    let settings = SettingsService::get_settings();

    let check_owner = if !settings.web_api_share_sessions {
        Some(TerminalOwner::Web)
    } else {
        None
    };

    ts.close_terminal_with_check(&id, check_owner).map_err(|e| {
        if e.contains("无权限") {
            ApiError::Forbidden(e)
        } else {
            ApiError::Internal(e)
        }
    })?;
    let _ = state.app_handle.emit("terminal-closed", &id);
    Ok(Json(serde_json::json!({ "closed": true })))
}
