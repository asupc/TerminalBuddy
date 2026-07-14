use axum::{routing::post, Router};
use std::net::SocketAddr;
use tokio::net::TcpListener;

use crate::services::CLAUDE_HOOK_PORT;
use crate::web::handlers::claude_hook_handler;

pub async fn run(app: tauri::AppHandle) {
    let router = Router::new()
        .route("/api/claude/hooks", post(claude_hook_handler::claude_hook))
        .with_state(app);
    let address = SocketAddr::from(([127, 0, 0, 1], CLAUDE_HOOK_PORT));
    let listener = match TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[ClaudeHook] 本机服务绑定失败 {}: {}", address, error);
            return;
        }
    };
    eprintln!("[ClaudeHook] 本机服务已启动 http://{}", address);
    if let Err(error) = axum::serve(listener, router).await {
        eprintln!("[ClaudeHook] 本机服务异常退出: {}", error);
    }
}
