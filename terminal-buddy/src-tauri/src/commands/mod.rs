pub mod ai_usage;
pub mod bot;
pub mod claude_assets;
pub mod claude_config;
pub mod claude_history;
pub mod claude_mcp;
pub mod claude_session;
pub mod client_data;
pub mod clipboard;
pub mod default_terminal;
pub mod fs;
pub mod git;
pub mod git_parse;
pub mod hooks;
pub mod mstsc;
pub mod notification;
pub mod profile;
pub mod remote_file;
pub mod server_monitor;
pub mod settings;
pub mod templates;
pub mod terminal;
pub mod update;
pub mod web;
pub mod window;
pub mod workspace;
pub use ai_usage::*;
pub use bot::*;
pub use claude_assets::*;
pub use claude_config::*;
pub use claude_history::*;
pub use claude_mcp::*;
pub use claude_session::*;
pub use client_data::*;
pub use clipboard::*;
pub use default_terminal::*;
pub use fs::*;
pub use git::*;
pub use hooks::*;
pub use mstsc::*;
pub use notification::*;
pub use profile::*;
pub use remote_file::*;
pub use server_monitor::*;
pub use settings::*;
pub use templates::*;
pub use terminal::*;
pub use update::*;
pub use web::*;
pub use window::*;
pub use workspace::*;

/// 把阻塞型任务丢到阻塞线程池：同步 `#[tauri::command]` 在 UI 线程内联执行，
/// 文件系统与 SQLite 扫描一慢整个窗口就失去响应。Claude 相关命令一律走这里。
pub(crate) async fn claude_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Claude 后台任务失败：{}", error))?
}
