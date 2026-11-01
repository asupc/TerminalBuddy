//! 终端 Agent 会话接力的 Tauri 命令（原生桌面端，Pc 身份）。
//! 浏览器（dist-web）调用同组 use case 但以 Web 身份执行，见
//! `web/handlers/desktop_dispatch.rs` 的显式分支——禁止把这里的命令函数直接
//! dispatch 给浏览器，否则会在非共享模式错误放开 Web→PC 写入。
//!
//! 参数用逐字段形式（不用 `args: Struct`）：Tauri 命令的参数名即前端 invoke 的
//! 键（camelCase ↔ snake_case 自动转换），浏览器分发侧也按同一组扁平键反序列化。
use crate::models::TerminalActor;
use crate::runtime::AppHandle;
use crate::services::terminal_agent_relay as relay;
use serde::{Deserialize, Serialize};

/// Tauri 命令没有 HTTP 状态码，统一用结构化错误（§4.8）；
/// 浏览器 `/api/desktop/invoke` 适配器按相同错误码映射 HTTP 状态与 Retry-After。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentCommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

impl TerminalAgentCommandError {
    fn from_relay(error: relay::RelayError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.message(),
            decision_id: error.decision_id(),
            retry_after: error.retry_after_secs(),
        }
    }
}

impl From<relay::RelayError> for TerminalAgentCommandError {
    fn from(error: relay::RelayError) -> Self {
        Self::from_relay(error)
    }
}

/// 浏览器分发侧共享的参数结构（对扁平 JSON 反序列化，camelCase）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessagesArgs {
    pub terminal_id: String,
    #[serde(default)]
    pub after_seq: Option<i64>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub revision: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReplyArgs {
    pub terminal_id: String,
    pub text: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUnsubscribeArgs {
    pub terminal_id: String,
    pub subscription_id: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentHeartbeatArgs {
    #[serde(default)]
    pub subscriptions: Vec<relay::HeartbeatLease>,
}

/// 可接力的终端会话列表（§4.2），按调用端（Pc）过滤。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn terminal_agent_list(
    app: AppHandle,
) -> Result<Vec<relay::TerminalAgentSession>, TerminalAgentCommandError> {
    Ok(relay::sessions_for(&app, TerminalActor::Pc).await)
}

/// 消息页（§4.4）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn terminal_agent_messages(
    app: AppHandle,
    terminal_id: String,
    after_seq: Option<i64>,
    limit: Option<usize>,
    revision: Option<u64>,
) -> Result<relay::TerminalAgentPage, TerminalAgentCommandError> {
    relay::page_for(&app, TerminalActor::Pc, &terminal_id, after_seq, revision, limit)
        .await
        .map_err(TerminalAgentCommandError::from_relay)
}

/// 受限回复（§4.6）：桌面以 Pc 身份写入自己可见的终端。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn terminal_agent_reply(
    app: AppHandle,
    terminal_id: String,
    text: String,
    request_id: String,
) -> Result<relay::ReplyOutcome, TerminalAgentCommandError> {
    relay::reply(&app, TerminalActor::Pc, &terminal_id, &text, &request_id)
        .await
        .map_err(TerminalAgentCommandError::from_relay)
}

/// 建立带 Pc 身份的事件租约；首帧同步返回，后续帧经 terminal-agent-update 事件推送
/// （payload 含 subscriptionIds，React 按自己的句柄过滤）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn terminal_agent_subscribe(
    app: AppHandle,
    terminal_id: String,
) -> Result<relay::SubscribeOutcome, TerminalAgentCommandError> {
    let (outcome, _receiver) = relay::subscribe(&app, TerminalActor::Pc, &terminal_id, false)
        .await
        .map_err(TerminalAgentCommandError::from_relay)?;
    Ok(outcome)
}

/// 释放指定租约；重复释放幂等。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn terminal_agent_unsubscribe(
    terminal_id: String,
    subscription_id: String,
) -> Result<(), TerminalAgentCommandError> {
    relay::unsubscribe(&terminal_id, &subscription_id);
    Ok(())
}

/// 续租 30 秒；返回仍然存活的租约。心跳失败或 alive 不含当前句柄时，
/// 客户端应退订旧句柄再重新 subscribe，以 initialFrame 原子替换。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn terminal_agent_heartbeat(
    subscriptions: Vec<relay::HeartbeatLease>,
) -> Result<relay::HeartbeatOutcome, TerminalAgentCommandError> {
    Ok(relay::HeartbeatOutcome { alive: relay::heartbeat(TerminalActor::Pc, &subscriptions) })
}
