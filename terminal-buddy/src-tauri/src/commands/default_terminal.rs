//! 默认终端（实验）的 Tauri 命令层。

use crate::services::{default_terminal_service, DefaultTerminalStatus};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_default_terminal_status() -> DefaultTerminalStatus {
    default_terminal_service::get_status(crate::services::handoff_server::is_com_registered())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_default_terminal_enabled(
    enabled: bool,
) -> Result<DefaultTerminalStatus, String> {
    default_terminal_service::set_enabled(enabled)
}
