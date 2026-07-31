use crate::commands::TerminalService;
use crate::models::web_api::{StartTerminalRequest, TerminalInfo};
use crate::models::TerminalOwner;
use crate::services::{ProfileService, WebServiceState};
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use axum::{
    extract::{Path, State},
    Json,
};
use tauri::{Emitter, Manager};

/// 列出全部存活终端：Web（手机自己的）+ PC 端的。前端按 owner 区分
/// 「继续」（Web，直接接入）和「接管」（PC，接入时 PTY 切到手机尺寸）。
pub async fn list(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<TerminalInfo>>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    Ok(Json(ts.list_terminals_info()))
}

/// 新建终端：归属 Web（手机）池，与 PC 端互不共享，避免不同尺寸视图抢一个 PTY。
pub async fn start(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<StartTerminalRequest>,
) -> Result<Json<TerminalInfo>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    let terminal_id = ts
        .create_terminal(
            &req.profile_id,
            None,
            req.extra_startup_params.as_deref(),
            req.rows.unwrap_or(0),
            req.cols.unwrap_or(0),
            None,
            req.extra_param_tag.as_deref(),
            req.extra_param_tag_color.as_deref(),
            state.app_handle.clone(),
            TerminalOwner::Web,
        )
        .map_err(ApiError::Internal)?;

    let profile = ProfileService::get_profile(&req.profile_id).map_err(ApiError::Internal)?;
    let loading_mode = ts
        .terminal_loading_mode(&terminal_id)
        .map_err(ApiError::Internal)?
        .to_string();
    let info = TerminalInfo {
        id: terminal_id,
        profile_id: req.profile_id,
        profile_name: profile.name,
        group: profile.group,
        terminal_type: profile.terminal_type,
        loading_mode,
        owner: TerminalOwner::Web,
        extra_param_tag: req.extra_param_tag,
        extra_param_tag_color: req.extra_param_tag_color,
    };
    let _ = state.app_handle.emit("terminal-created", info.clone());
    Ok(Json(info))
}

/// 关闭终端：只能关 Web 池的，PC 端的终端手机无权关。
pub async fn close(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    ts.close_terminal_with_check(&id, Some(TerminalOwner::Web))
        .map_err(|e| {
            if e.contains("无权限") {
                ApiError::Forbidden(e)
            } else {
                ApiError::Internal(e)
            }
        })?;
    state.app_handle.state::<WebServiceState>().close_all(&id);
    let _ = state.app_handle.emit("terminal-closed", &id);
    Ok(Json(serde_json::json!({ "closed": true })))
}
