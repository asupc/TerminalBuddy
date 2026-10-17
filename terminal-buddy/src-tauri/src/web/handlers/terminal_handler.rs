use crate::commands::{TerminalCloseReason, TerminalService};
use crate::models::web_api::{StartTerminalRequest, TerminalInfo};
use crate::models::{TerminalAccessError, TerminalActor, TerminalCreator, TerminalOwner};
use crate::web::auth::ClaimsFromRequest;
use crate::web::client_kind::client_kind_from_headers;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use crate::runtime::{Emitter, Manager};

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
/// profile_id 为空时走项目启动路径：PowerShell 空白终端 + 启动目录 + 注入启动命令，
/// 与 PC 端 openProjectTerminal 的 startBlankTerminal 链路一致。
/// 创建端设备按请求 User-Agent 记录（手机 SPA 创建 → Mobile），供手机端
/// 关闭权限细分使用。
pub async fn start(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    headers: HeaderMap,
    Json(req): Json<StartTerminalRequest>,
) -> Result<Json<TerminalInfo>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    let creator = match client_kind_from_headers(&headers) {
        crate::models::TerminalClientKind::Mobile => TerminalCreator::Mobile,
        crate::models::TerminalClientKind::Desktop => TerminalCreator::Desktop,
    };
    let terminal_id = if req.profile_id.trim().is_empty() {
        ts.create_blank_terminal(
            crate::commands::terminal::default_terminal_type(),
            req.display_name.as_deref(),
            req.startup_group.as_deref(),
            req.rows.unwrap_or(0),
            req.cols.unwrap_or(0),
            req.startup_path.as_deref(),
            req.startup_command.as_deref(),
            req.extra_param_tag.as_deref(),
            req.extra_param_tag_color.as_deref(),
            state.app_handle.clone(),
            TerminalOwner::Web,
            creator,
        )
    } else {
        ts.create_terminal(
            &req.profile_id,
            req.display_name.as_deref(),
            req.extra_startup_params.as_deref(),
            req.extra_startup_mode.as_deref(),
            req.rows.unwrap_or(0),
            req.cols.unwrap_or(0),
            req.startup_path.as_deref(),
            req.extra_param_tag.as_deref(),
            req.extra_param_tag_color.as_deref(),
            state.app_handle.clone(),
            TerminalOwner::Web,
            creator,
        )
    }
    // 创建失败的中文原因（引用失效 / 旧路径过期 / 参数校验）必须原样提示给
    // 用户，不能走 Internal 的通用 500 文案；「拒绝启动并提示重新选择」是
    // 设计的验收要求。
    .map_err(ApiError::BadRequest)?;

    // 两种创建路径统一从实例表取 TerminalInfo：空白终端没有 profile，
    // 手工拼装会在这里分叉两份字段映射，list_terminals_info 已是唯一权威来源。
    let info = ts
        .list_terminals_info()
        .into_iter()
        .find(|info| info.id == terminal_id)
        .ok_or_else(|| ApiError::Internal("终端已创建但查询信息失败".to_string()))?;
    let _ = state.app_handle.emit("terminal-created", info.clone());
    Ok(Json(info))
}

/// 关闭终端：只能关 Web 池的，PC 端的终端手机端即使在共享模式下也无权关闭
/// （「接管」不等于「关闭 PC 终端」）。Web 池内再按设备细分：手机端只能关
/// 手机端自己创建的会话，电脑端可关全部。资源释放与事件发送统一由
/// `TerminalService::close_terminal` 负责，这里不再重复清理订阅者或补发事件。
pub async fn close(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    ts.close_terminal(
        &state.app_handle,
        &id,
        TerminalActor::Web,
        client_kind_from_headers(&headers),
        TerminalCloseReason::WebClose,
    )
    .map_err(|error| match error {
        TerminalAccessError::NotFound => ApiError::NotFound(error.to_string()),
        TerminalAccessError::Denied { .. } | TerminalAccessError::DeniedMobileClose => {
            ApiError::Forbidden(error.to_string())
        }
    })?;
    Ok(Json(serde_json::json!({ "closed": true })))
}
