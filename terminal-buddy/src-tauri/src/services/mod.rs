pub mod agent_cli_service;
pub mod app_notification_service;
pub mod atomic_file;
pub mod bot_binding_service;
pub mod bot_channel;
pub mod bot_long_connection_service;
pub mod bot_scan;
pub mod bot_settings_service;
pub mod bot_weixin_service;
pub mod claude_assets_service;
pub mod claude_config_service;
pub mod claude_hook_service;
pub mod claude_hook_settings;
pub mod claude_history_service;
pub mod claude_mcp_service;
pub mod claude_provider_service;
pub mod claude_settings_service;
pub mod claude_session_registry_service;
pub mod client_data_service;
pub mod cli_update_service;
pub mod codex_catalog;
pub mod codex_history_service;
mod codex_transcript;
pub mod codex_provider_service;
pub mod crypto_service;
pub mod database_service;
pub mod directory_browser_service;
pub mod default_terminal_protocol;
#[cfg(feature = "desktop")]
pub mod default_terminal_service;
#[cfg(all(feature = "desktop", windows))]
#[path = "handoff_server.rs"]
pub mod handoff_server;
#[cfg(all(feature = "desktop", not(windows)))]
#[path = "handoff_server_stub.rs"]
pub mod handoff_server;
pub mod llm_provider_service;
pub mod path_service;
pub mod platform_service;
pub mod profile_service;
pub mod settings_service;
pub mod ssh_session_service;
pub mod ssh_transfer;
pub mod template_service;
pub mod terminal_task_service;
pub mod terminal_agent_relay;
mod terminal_task_process;
pub mod update_service;
#[cfg(feature = "desktop")]
pub mod vscode_terminal_service;
#[cfg(not(feature = "desktop"))]
#[path = "vscode_terminal_server.rs"]
pub mod vscode_terminal_service;
pub mod web_service;
pub mod workspace_service;
pub use atomic_file::*;
pub use app_notification_service::*;
pub use bot_binding_service::*;
pub use bot_long_connection_service::*;
pub use bot_scan::*;
pub use bot_settings_service::*;
pub use bot_weixin_service::*;
pub use claude_assets_service::*;
pub use claude_config_service::*;
pub use claude_hook_service::*;
pub use claude_hook_settings::*;
pub use claude_session_registry_service::*;
pub use claude_history_service::*;
pub use claude_mcp_service::*;
pub use claude_settings_service::*;
pub use client_data_service::*;
pub use crypto_service::*;
pub use database_service::*;
pub use default_terminal_protocol::*;
#[cfg(feature = "desktop")]
pub use default_terminal_service::*;
#[cfg(feature = "desktop")]
pub use handoff_server::*;
pub use llm_provider_service::*;
pub use path_service::*;
pub use profile_service::*;
pub use settings_service::*;
pub use ssh_session_service::*;
pub use template_service::*;
pub use update_service::*;
pub use vscode_terminal_service::*;
pub use web_service::*;
pub use workspace_service::*;

pub mod ai_chat_service;
mod ai_chat_approval;
pub(crate) mod ai_chat_claude_hooks;
mod ai_chat_usage;

pub mod ai_catalog_service;

pub(crate) mod ai_permission_service;
