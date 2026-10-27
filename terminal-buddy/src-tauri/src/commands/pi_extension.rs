//! Pi 扩展命令：状态、全局安装与卸载。
use super::claude_task;
use crate::services::pi_extension_service::{self, PiExtensionState};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_pi_extension_state() -> Result<PiExtensionState, String> {
    claude_task(pi_extension_service::state).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn install_pi_extension() -> Result<(), String> {
    claude_task(pi_extension_service::install_global).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn uninstall_pi_extension() -> Result<(), String> {
    claude_task(pi_extension_service::uninstall_global).await
}
