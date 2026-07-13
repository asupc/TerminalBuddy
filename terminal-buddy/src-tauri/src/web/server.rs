use axum::Router;
use axum::routing::{get, post, delete};
use tower_http::cors::CorsLayer;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::watch;

#[cfg(not(debug_assertions))]
use axum::response::IntoResponse;

use crate::web::auth::HasJwtSecret;
use crate::web::handlers;
use crate::web::ws;

#[derive(Clone)]
pub struct AppState {
    pub jwt_secret: String,
    pub app_handle: tauri::AppHandle,
}

impl HasJwtSecret for AppState {
    fn jwt_secret(&self) -> &str {
        &self.jwt_secret
    }
}

// Embed web frontend files for release mode
#[cfg(not(debug_assertions))]
static WEB_DIST: include_dir::Dir<'_> = include_dir::include_dir!("$CARGO_MANIFEST_DIR/../web/dist");

pub fn build_router(state: AppState) -> Router {
    let router = Router::new()
        // 认证
        .route("/api/auth/login", post(handlers::auth_handler::login))
        .route("/api/auth/status", get(handlers::auth_handler::status))
        // 机器人平台回调使用各自签名/Token，不走 Web API JWT。
        .route("/api/bot/feishu/events", post(handlers::bot_handler::feishu_events))
        .route("/api/bot/inbound/{channel_id}", post(handlers::bot_handler::bridge_inbound))
        // 连接（profile）只读列表 —— 手机端不管理 profile，照搬电脑端已配置的导航
        .route("/api/profiles", get(handlers::profile_handler::list))
        // 终端会话：列表 / 新建 / 关闭
        .route("/api/terminals", get(handlers::terminal_handler::list).post(handlers::terminal_handler::start))
        .route("/api/terminals/{id}", delete(handlers::terminal_handler::close))
        // 会话列表实时同步（meta WS，App 级单连接）
        .route("/ws/meta", get(ws::meta_ws_handler))
        // 终端 I/O（per-terminal WS）
        .route("/ws/terminal/{id}", get(ws::terminal_ws_handler));

    #[cfg(debug_assertions)]
    let router = {
        use tower_http::services::{ServeDir, ServeFile};
        const WEB_DIST_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/dist");
        const INDEX_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/dist/index.html");
        router.fallback_service(
            ServeDir::new(WEB_DIST_PATH).not_found_service(ServeFile::new(INDEX_PATH))
        )
    };

    #[cfg(not(debug_assertions))]
    let router = router.fallback(serve_embedded_file);

    // 鉴权用 JWT（非 cookie），CSRF 无忧；放行任意 origin/method/header 方便手机端
    // 从任意局域网 IP 同源或跨源访问（dev 时 vite :5173 → axum :9600 也走这里）。
    router
        .with_state(state)
        .layer(CorsLayer::very_permissive())
}

#[cfg(not(debug_assertions))]
async fn serve_embedded_file(req: axum::extract::Request) -> axum::response::Response {
    let path = req.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match WEB_DIST.get_file(path) {
        Some(file) => {
            let content_type = guess_content_type(path);
            ([(axum::http::header::CONTENT_TYPE, content_type)], file.contents()).into_response()
        }
        None => {
            // SPA fallback: serve index.html for unknown paths
            match WEB_DIST.get_file("index.html") {
                Some(index) => {
                    ([(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")], index.contents()).into_response()
                }
                None => axum::http::StatusCode::NOT_FOUND.into_response(),
            }
        }
    }
}

#[cfg(not(debug_assertions))]
fn guess_content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

pub async fn run_server(port: u16, jwt_secret: String, app_handle: tauri::AppHandle, mut shutdown_rx: watch::Receiver<bool>) {
    let state = AppState { jwt_secret, app_handle };
    let app = build_router(state);

    // 绑定 0.0.0.0：让同一局域网的手机端可访问（旧实现绑定 127.0.0.1 仅本机可达）。
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[WebAPI] 端口 {} 绑定失败: {}", port, e);
            return;
        }
    };

    eprintln!("[WebAPI] 服务器启动成功 http://{}", addr);
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            loop {
                if *shutdown_rx.borrow() {
                    break;
                }
                shutdown_rx.changed().await.ok();
            }
        })
        .await
        .ok();
}
