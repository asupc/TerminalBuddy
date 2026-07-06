use axum::{Json, extract::{State, Path}};
use crate::commands::TerminalService;
use crate::models::TerminalOwner;
use crate::models::web_api::{TerminalInfo, StartTerminalRequest};
use crate::services::{ProfileService, WebServiceState};
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use tauri::{Manager, Emitter};

/// 手机端独立会话池：只列出 Web 端（手机）创建的终端，PC 端的终端不可见。
pub async fn list(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<TerminalInfo>>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    let own: Vec<TerminalInfo> = ts
        .list_terminals_info()
        .into_iter()
        .filter(|t| t.owner == TerminalOwner::Web)
        .collect();
    Ok(Json(own))
}

/// 新建终端：归属 Web（手机）池，与 PC 端互不共享，避免不同尺寸视图抢一个 PTY。
pub async fn start(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<StartTerminalRequest>,
) -> Result<Json<TerminalInfo>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    let terminal_id = ts.create_terminal(
        &req.profile_id,
        None,
        req.rows.unwrap_or(0),
        req.cols.unwrap_or(0),
        state.app_handle.clone(),
        TerminalOwner::Web,
    ).map_err(ApiError::Internal)?;

    let profile = ProfileService::get_profile(&req.profile_id).map_err(ApiError::Internal)?;
    let info = TerminalInfo {
        id: terminal_id,
        profile_id: req.profile_id,
        profile_name: profile.name,
        group: profile.group,
        terminal_type: profile.terminal_type,
        owner: TerminalOwner::Web,
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
