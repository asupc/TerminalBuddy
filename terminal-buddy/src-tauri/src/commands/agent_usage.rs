//! 终端内 Agent 的用量快照：业务解析在 `services::agent_usage_service`，
//! 这里只做参数转接。读 transcript 是磁盘 I/O，走 `claude_task` 不占 UI 线程。
use super::claude_task;
use crate::services::agent_usage_service::{self, TerminalAgentUsage};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn terminal_agent_usage(terminal_id: String) -> Result<Option<TerminalAgentUsage>, String> {
    claude_task(move || agent_usage_service::usage(&terminal_id)).await
}
