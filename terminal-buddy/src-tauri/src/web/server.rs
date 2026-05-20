use axum::Router;
use axum::routing::{get, post, put, delete};
use tower_http::cors::{Any, CorsLayer};
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::watch;

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

pub fn build_router(state: AppState) -> Router {
    let mut router = Router::new()
        .route("/api/auth/login", post(handlers::auth_handler::login))
        .route("/api/auth/status", get(handlers::auth_handler::status))
        .route("/api/profiles", get(handlers::profile_handler::list).post(handlers::profile_handler::create))
        .route("/api/profiles/{id}", put(handlers::profile_handler::update).delete(handlers::profile_handler::delete))
        .route("/api/terminals", get(handlers::terminal_handler::list).post(handlers::terminal_handler::start))
        .route("/api/terminals/{id}", delete(handlers::terminal_handler::close))
        .route("/ws/terminal/{id}", get(ws::ws_handler));

    #[cfg(debug_assertions)]
    {
        use tower_http::services::ServeDir;
        // In axum 0.8, nest_service("/", ...) acts as a fallback:
        // explicit routes above take priority, then static files are served.
        router = router.nest_service("/", ServeDir::new("../web/dist"));
    }

    router
        .with_state(state)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
}

pub async fn run_server(port: u16, jwt_secret: String, app_handle: tauri::AppHandle, mut shutdown_rx: watch::Receiver<bool>) {
    let state = AppState { jwt_secret, app_handle };
    let app = build_router(state);

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
