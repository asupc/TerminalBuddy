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

/// 列出 Web 端有权查看的终端：非共享模式下只有 Web 池创建的，
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
/// 创建端设备按请求 User-Agent 记录（手机 SPA 创建 → Mobile），用于来源标识与接管提示。
pub async fn start(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    headers: HeaderMap,
    Json(req): Json<StartTerminalRequest>,
) -> Result<Json<TerminalInfo>, ApiError> {
    let app_handle = state.app_handle;
    // 配置读取、PTY 创建和初始化在阻塞线程执行，避免占用 HTTP/WS 调度线程。
    tokio::task::spawn_blocking(move || {
        let ts = app_handle.state::<TerminalService>();
        let creator = match client_kind_from_headers(&headers) {
            crate::models::TerminalClientKind::Mobile => TerminalCreator::Mobile,
            crate::models::TerminalClientKind::Desktop => TerminalCreator::Desktop,
        };
        if !req.profile_id.trim().is_empty() {
            crate::services::ProfileService::get_profile(&req.profile_id)
                .map_err(|_| ApiError::BadRequest("该配置已删除或不存在，请刷新项目配置后重试".to_string()))?;
        }
        let terminal_id = if req.profile_id.trim().is_empty() {
            ts.create_blank_terminal(
                crate::commands::terminal::default_terminal_type(),
                req.display_name.as_deref(),
                req.startup_group.as_deref(),
                req.rows.unwrap_or(0),
                req.cols.unwrap_or(0),
                req.startup_path.as_deref(),
                req.startup_command.as_deref(),
                req.inject_claude_hooks.unwrap_or(false),
                app_handle.clone(),
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
                req.inject_claude_hooks.unwrap_or(false),
                app_handle.clone(),
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
        let _ = app_handle.emit("terminal-created", info.clone());
        Ok(Json(info))
    })
    .await
    .map_err(|error| ApiError::Internal(error.to_string()))?

}

/// 关闭 Web 池终端：手机和电脑浏览器均可关闭，与创建端设备无关。
/// PC 端终端即使在共享模式下也无权关闭（「接管」不等于「关闭 PC 终端」）。
/// 资源释放与事件发送统一由 `TerminalService::close_terminal` 负责。
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
