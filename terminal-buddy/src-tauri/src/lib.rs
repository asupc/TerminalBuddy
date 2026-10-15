pub mod commands;
#[cfg(feature = "desktop")]
mod hook_client;
pub mod models;
pub mod services;
pub mod web;
pub mod runtime;
#[cfg(all(feature = "desktop", feature = "server"))]
compile_error!("desktop 与 server 特性互斥；服务端请使用 --no-default-features --features server");
#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
pub use desktop::{run, is_claude_hook_client_process, run_claude_hook_client};
#[cfg(feature = "desktop")]
pub(crate) use desktop::boot_log;
// handoff 建终端时唤起主窗口（commands/terminal.rs 以 crate::show_main_window 调用）。
#[cfg(feature = "desktop")]
pub(crate) use desktop::show_main_window;
#[cfg(not(feature = "desktop"))]
pub(crate) fn boot_log(message: impl AsRef<str>) { eprintln!("{}", message.as_ref()); }
