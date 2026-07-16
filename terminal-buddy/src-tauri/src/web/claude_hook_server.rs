use axum::{routing::post, Router};
use std::net::SocketAddr;
use tokio::net::TcpListener;

use crate::services::{ClaudeHookService, CLAUDE_HOOK_PORT};
use crate::web::handlers::claude_hook_handler;

pub fn bind() -> Result<std::net::TcpListener, String> {
    let preferred_address = SocketAddr::from(([127, 0, 0, 1], CLAUDE_HOOK_PORT));
    let listener = match std::net::TcpListener::bind(preferred_address) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "[ClaudeHook] 首选端口绑定失败 {}: {}，尝试随机端口",
                preferred_address, error
            );
            match std::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))) {
                Ok(listener) => listener,
                Err(error) => {
                    ClaudeHookService::set_server_state(false, 0);
                    return Err(format!("Claude Hook 本机服务绑定失败: {}", error));
                }
            }
        }
    };
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Claude Hook listener 配置失败: {}", error))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("读取 Claude Hook 服务地址失败: {}", error))?;
    ClaudeHookService::set_server_state(true, address.port());
    eprintln!("[ClaudeHook] 本机服务已启动 http://{}", address);
    Ok(listener)
}

pub async fn run(app: tauri::AppHandle, listener: std::net::TcpListener) {
    let router = Router::new()
        .route("/api/claude/hooks", post(claude_hook_handler::claude_hook))
        .with_state(app);
    let listener = match TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(error) => {
            ClaudeHookService::set_server_state(false, 0);
            eprintln!("[ClaudeHook] listener 转换失败: {}", error);
            return;
        }
    };
    if let Err(error) = axum::serve(listener, router).await {
        eprintln!("[ClaudeHook] 本机服务异常退出: {}", error);
    }
    ClaudeHookService::set_server_state(false, 0);
}
