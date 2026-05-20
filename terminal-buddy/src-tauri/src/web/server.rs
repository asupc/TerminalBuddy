use axum::Router;
use axum::routing::{get, post};
use tower_http::cors::{Any, CorsLayer};
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::web::auth::HasJwtSecret;
use crate::web::handlers;

#[derive(Clone)]
pub struct AppState {
    pub jwt_secret: String,
}

impl HasJwtSecret for AppState {
    fn jwt_secret(&self) -> &str {
        &self.jwt_secret
    }
}

pub fn build_router(state: AppState) -> Router {
    let public = Router::new()
        .route("/api/auth/login", post(handlers::auth_handler::login))
        .route("/api/auth/status", get(handlers::auth_handler::status));

    public
        .with_state(state)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
}

pub async fn run_server(port: u16, jwt_secret: String, mut shutdown_rx: watch::Receiver<bool>) {
    let state = AppState { jwt_secret };
    let app = build_router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[WebAPI] 端口 {} 绑定失败: {}", port, e);
            return;
        }
    };

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
