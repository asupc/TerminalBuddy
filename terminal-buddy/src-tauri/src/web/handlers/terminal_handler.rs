use crate::commands::{TerminalCloseReason, TerminalService};
use crate::models::web_api::{StartTerminalRequest, TerminalInfo};
use crate::models::{TerminalAccessError, TerminalActor, TerminalOwner};
use crate::services::ProfileService;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use axum::{
    extract::{Path, State},
    Json,
};
use tauri::{Emitter, Manager};

/// 列出 Web 端有权查看的终端：非共享模式下只有 Web（手机）自己创建的，
/// 共享模式下才包含 PC 端的。前端按 owner 区分「继续」（Web，直接接入）
/// 和「接管」（PC，接入时 PTY 切到手机尺寸）。
pub async fn list(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<TerminalInfo>>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    Ok(Json(ts.list_terminals_info_for(TerminalActor::Web)))
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
            req.extra_startup_mode.as_deref(),
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
        .terminal_loading_mode(&terminal_id, TerminalActor::Web)
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
        extra_startup_params: req.extra_startup_params,
        extra_startup_mode: req.extra_startup_mode,
    };
    let _ = state.app_handle.emit("terminal-created", info.clone());
    Ok(Json(info))
}

/// 关闭终端：只能关 Web 池的，PC 端的终端手机端即使在共享模式下也无权关闭
/// （「接管」不等于「关闭 PC 终端」）。资源释放与事件发送统一由
/// `TerminalService::close_terminal` 负责，这里不再重复清理订阅者或补发事件。
pub async fn close(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    ts.close_terminal(
        &state.app_handle,
        &id,
        TerminalActor::Web,
        TerminalCloseReason::WebClose,
    )
    .map_err(|error| match error {
        TerminalAccessError::NotFound => ApiError::NotFound(error.to_string()),
        TerminalAccessError::Denied { .. } => ApiError::Forbidden(error.to_string()),
    })?;
    Ok(Json(serde_json::json!({ "closed": true })))
}
