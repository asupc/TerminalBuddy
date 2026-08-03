use axum::routing::{delete, get, post, put};
use axum::Router;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tower_http::cors::CorsLayer;

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
static WEB_DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../web/dist");

pub fn build_router(state: AppState) -> Router {
    let router = Router::new()
        // 璁よ瘉
        .route("/api/auth/login", post(handlers::auth_handler::login))
        .route("/api/auth/status", get(handlers::auth_handler::status))
        // 鏈哄櫒浜哄钩鍙板洖璋冧娇鐢ㄥ悇鑷鍚?Token锛屼笉璧?Web API JWT銆?
        .route(
            "/api/bot/feishu/events",
            post(handlers::bot_handler::feishu_events),
        )
        .route(
            "/api/bot/inbound/{channel_id}",
            post(handlers::bot_handler::bridge_inbound),
        )
        // 杩炴帴锛坧rofile锛夊彧璇诲垪琛?鈥斺€?鎵嬫満绔笉绠＄悊 profile锛岀収鎼數鑴戠宸查厤缃殑瀵艰埅
        .route("/api/profiles", get(handlers::profile_handler::list))
        // AI 浜や粯锛氳繙绔粎瑙傚療銆佹壒鍑嗕换鍔″浘涓庡洖绛斿緟鍐崇瓥椤癸紝涓嶈Е鍙戞湰鏈?CLI銆?
        .route(
            "/api/ai-delivery/projects",
            get(handlers::ai_delivery_handler::projects),
        )
        .route(
            "/api/ai-delivery/projects/{project_id}/deliveries",
            get(handlers::ai_delivery_handler::deliveries),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}",
            get(handlers::ai_delivery_handler::snapshot),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/approve",
            post(handlers::ai_delivery_handler::approve),
        )
        .route(
            "/api/ai-delivery/decisions/{id}/answer",
            post(handlers::ai_delivery_handler::answer_decision),
        )
        .route(
            "/api/ai-delivery/deliveries",
            post(handlers::ai_delivery_handler::create_delivery),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/plan",
            post(handlers::ai_delivery_handler::plan),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/dispatch",
            post(handlers::ai_delivery_handler::dispatch),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/complete",
            post(handlers::ai_delivery_handler::complete_attempt),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/merge",
            post(handlers::ai_delivery_handler::merge),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/continue-merge",
            post(handlers::ai_delivery_handler::continue_merge),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/cleanup-integration",
            post(handlers::ai_delivery_handler::cleanup_integration),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/retry",
            post(handlers::ai_delivery_handler::retry_task),
        )
        .route(
            "/api/ai-delivery/attempts/{attempt_id}/output",
            get(handlers::ai_delivery_handler::attempt_output),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}",
            put(handlers::ai_delivery_handler::update_delivery),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/tasks",
            post(handlers::ai_delivery_handler::create_task),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/tasks/{task_id}",
            put(handlers::ai_delivery_handler::update_task),
        )
        .route(
            "/api/ai-delivery/deliveries/{id}/tasks/{task_id}",
            delete(handlers::ai_delivery_handler::delete_task),
        )
        // 鍚姩鍙傛暟棰勮锛堜笌 PC 绔叡浜?ClientData/extra_param_presets.json锛?
        .route(
            "/api/extra-param-presets",
            get(handlers::preset_handler::list).put(handlers::preset_handler::replace),
        )
        // 鍛戒护鍘嗗彶锛堜笌 PC 绔叡浜?ClientData/command_history.json锛?
        .route(
            "/api/command-history",
            get(handlers::history_handler::list).put(handlers::history_handler::replace),
        )
        // 缁堢浼氳瘽锛氬垪琛?/ 鏂板缓 / 鍏抽棴
        .route(
            "/api/terminals",
            get(handlers::terminal_handler::list).post(handlers::terminal_handler::start),
        )
        .route(
            "/api/terminals/{id}",
            delete(handlers::terminal_handler::close),
        )
        // 浼氳瘽鍒楄〃瀹炴椂鍚屾锛坢eta WS锛孉pp 绾у崟杩炴帴锛?
        .route("/ws/meta", get(ws::meta_ws_handler))
        // 缁堢 I/O锛坧er-terminal WS锛?
        .route("/ws/terminal/{id}", get(ws::terminal_ws_handler));

    #[cfg(debug_assertions)]
    let router = {
        use tower_http::services::{ServeDir, ServeFile};
        const WEB_DIST_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/dist");
        const INDEX_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/dist/index.html");
        router.fallback_service(
            ServeDir::new(WEB_DIST_PATH).not_found_service(ServeFile::new(INDEX_PATH)),
        )
    };

    #[cfg(not(debug_assertions))]
    let router = router.fallback(serve_embedded_file);

    // 閴存潈鐢?JWT锛堥潪 cookie锛夛紝CSRF 鏃犲咖锛涙斁琛屼换鎰?origin/method/header 鏂逛究鎵嬫満绔?
    // 浠庝换鎰忓眬鍩熺綉 IP 鍚屾簮鎴栬法婧愯闂紙dev 鏃?vite :5173 鈫?axum :9600 涔熻蛋杩欓噷锛夈€?
    router.with_state(state).layer(CorsLayer::very_permissive())
}

#[cfg(not(debug_assertions))]
async fn serve_embedded_file(req: axum::extract::Request) -> axum::response::Response {
    let path = req.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match WEB_DIST.get_file(path) {
        Some(file) => {
            let content_type = guess_content_type(path);
            (
                [(axum::http::header::CONTENT_TYPE, content_type)],
                file.contents(),
            )
                .into_response()
        }
        None => {
            // SPA fallback: serve index.html for unknown paths
            match WEB_DIST.get_file("index.html") {
                Some(index) => (
                    [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
                    index.contents(),
                )
                    .into_response(),
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

pub async fn run_server(
    port: u16,
    jwt_secret: String,
    app_handle: tauri::AppHandle,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let state = AppState {
        jwt_secret,
        app_handle,
    };
    let app = build_router(state);

    // 缁戝畾 0.0.0.0锛氳鍚屼竴灞€鍩熺綉鐨勬墜鏈虹鍙闂紙鏃у疄鐜扮粦瀹?127.0.0.1 浠呮湰鏈哄彲杈撅級銆?
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[WebAPI] 绔彛 {} 缁戝畾澶辫触: {}", port, e);
            return;
        }
    };

    eprintln!("[WebAPI] 鏈嶅姟鍣ㄥ惎鍔ㄦ垚鍔?http://{}", addr);
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
