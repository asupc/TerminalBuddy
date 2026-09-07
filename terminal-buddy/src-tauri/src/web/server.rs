use axum::extract::{ConnectInfo, DefaultBodyLimit, Request};
use axum::http::{HeaderValue, StatusCode};
use axum::routing::{delete, get, post};
use axum::Router;
use hyper::body::Incoming;
use hyper_util::rt::{TokioExecutor, TokioTimer};
use hyper_util::server::conn::auto::Builder as HttpBuilder;
use hyper_util::server::graceful::GracefulShutdown;
use hyper_util::service::TowerToHyperService;
use std::net::SocketAddr;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::timeout::TimeoutLayer;

#[cfg(not(debug_assertions))]
use axum::response::IntoResponse;

use crate::web::auth::HasJwtSecret;
use crate::web::handlers;
use crate::web::rate_limit::LoginThrottle;
use crate::web::ws;

/// 请求 body 上限（2MB，与 axum 默认一致，此处显式声明作为安全合同）。
/// 登录 JSON、参数预设和命令历史同步都远小于这个值。
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
/// 单个 HTTP 请求（从收完 body 到响应头就绪）的最长处理时间。
/// WebSocket 升级请求的 handler 立即返回，升级后的长连接不再经过 HTTP 层，
/// 因此不受此限制影响。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 连接上等待请求头（含 keep-alive 请求间隙）的最长空闲时间。
/// 注意：只有给 hyper 配置了 Timer 该超时才生效，axum::serve 没配，
/// 这正是这里手写 accept 循环的原因。
const IDLE_HEADER_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct AppState {
    pub jwt_secret: String,
    pub app_handle: tauri::AppHandle,
    /// 登录限流器：按 IP 的失败计数 + 指数退避封禁 + bcrypt 并发闸门。
    pub login_throttle: std::sync::Arc<LoginThrottle>,
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
        // 认证
        .route("/api/auth/login", post(handlers::auth_handler::login))
        .route("/api/auth/status", get(handlers::auth_handler::status))
        // 机器人平台回调使用各自签名的 Token，不走 Web API JWT
        .route(
            "/api/bot/feishu/events",
            post(handlers::bot_handler::feishu_events),
        )
        .route(
            "/api/bot/inbound/{channel_id}",
            post(handlers::bot_handler::bridge_inbound),
        )
        // 连接（profile）只读列表 —— 手机端不管理 profile，照搬电脑端已配置的导航
        .route("/api/profiles", get(handlers::profile_handler::list))
        // 启动参数预设（与 PC 端共享 ClientData/extra_param_presets.json）
        .route(
            "/api/extra-param-presets",
            get(handlers::preset_handler::list).put(handlers::preset_handler::replace),
        )
        // 命令历史（与 PC 端共享 ClientData/command_history.json）
        .route(
            "/api/command-history",
            get(handlers::history_handler::list).put(handlers::history_handler::replace),
        )
        // 终端会话：列表 / 新建 / 关闭
        .route(
            "/api/terminals",
            get(handlers::terminal_handler::list).post(handlers::terminal_handler::start),
        )
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
            ServeDir::new(WEB_DIST_PATH).not_found_service(ServeFile::new(INDEX_PATH)),
        )
    };

    #[cfg(not(debug_assertions))]
    let router = router.fallback(serve_embedded_file);

    // CORS 只为浏览器跨域放行服务。认证走 JWT（非 cookie），CSRF 无忧，但也不必全放行：
    // - 生产：Web SPA 由本服务同源托管，浏览器不发跨域请求；不给任何 CORS 头，
    //   其他来源的站点无法读取 API 响应。
    // - 开发：前端一般走 vite :5173 的 /api、/ws 代理（服务器侧转发，不涉 CORS），
    //   这里额外放行本机 vite origin，覆盖前端改用直连地址调试的情况。
    let cors = if cfg!(debug_assertions) {
        CorsLayer::new().allow_origin(AllowOrigin::list([
            HeaderValue::from_static("http://localhost:5173"),
            HeaderValue::from_static("http://127.0.0.1:5173"),
        ]))
    } else {
        CorsLayer::new()
    };

    router
        .with_state(state)
        // 顺序（外 → 内）：CORS → 超时 → body 上限 → 路由。
        // CORS 放最外层让 408 等错误响应也带跨域头，便于开发期排查。
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .layer(cors)
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

/// 每连接的 service 适配层：把 hyper 交来的 `Request<Incoming>` 换成 axum 需要的
/// `Request<Body>`，并注入 `ConnectInfo` 扩展（登录限流按客户端 IP 判定）。
#[derive(Clone)]
struct ConnectInfoService<S> {
    inner: S,
    remote_addr: SocketAddr,
}

impl<S> tower::Service<Request<Incoming>> for ConnectInfoService<S>
where
    S: tower::Service<
        Request,
        Response = axum::response::Response,
        Error = std::convert::Infallible,
    >,
{
    type Response = axum::response::Response;
    type Error = std::convert::Infallible;
    type Future = S::Future;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<Incoming>) -> Self::Future {
        let mut req = req.map(axum::body::Body::new);
        req.extensions_mut().insert(ConnectInfo(self.remote_addr));
        self.inner.call(req)
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
        login_throttle: std::sync::Arc::new(LoginThrottle::new()),
    };
    let router = build_router(state);

    // 绑定 0.0.0.0：让同一局域网的手机端可访问（旧实现绑定 127.0.0.1 仅本机可达）
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[WebAPI] 端口 {} 绑定失败: {}。", port, e);
            return;
        }
    };

    println!("[WebAPI] 服务器启动成功，监听 http://{}（局域网可访问）。", addr);

    // 不用 axum::serve：它不给 hyper 配置 Timer，空闲连接的 header_read_timeout
    // 永远不会触发。自写 accept 循环，逐连接配 TokioTimer + 空闲超时，
    // 客户端建连后不发请求头的半开连接会在 30 秒后被断开。
    // Arc：watcher 的 future 要 'static 进 spawn，关停时又需要拿回所有权调 shutdown()
    let graceful = std::sync::Arc::new(GracefulShutdown::new());

    loop {
        tokio::select! {
            conn = listener.accept() => {
                let (io, remote_addr) = match conn {
                    Ok(pair) => pair,
                    Err(e) => {
                        eprintln!("[WebAPI] 接受连接失败: {}。", e);
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };

                let service = TowerToHyperService::new(ConnectInfoService {
                    inner: router.clone(),
                    remote_addr,
                });
                tokio::spawn({
                    let graceful = std::sync::Arc::clone(&graceful);
                    async move {
                        // Builder 按引用借用连接，必须在每个连接的 task 内构造（与 axum::serve 一致）
                        let mut builder = HttpBuilder::new(TokioExecutor::new());
                        // http2 的 CONNECT 协议是 WebSocket 升级所需（与 axum::serve 默认行为一致）
                        builder.http2().enable_connect_protocol();
                        // header_read_timeout 需要 timer 才生效
                        builder
                            .http1()
                            .timer(TokioTimer::new())
                            .header_read_timeout(IDLE_HEADER_TIMEOUT);
                        let conn = builder.serve_connection_with_upgrades(
                            hyper_util::rt::TokioIo::new(io),
                            service,
                        );
                        // 连接错误（客户端断开、空闲超时）不必上报，hyper 已记录
                        let _ = graceful.watcher().watch(conn).await;
                    }
                });
            }

            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    break;
                }
            }
        }
    }

    drop(listener);
    // 等待在途请求排空后返回；已升级的 WebSocket 长连接由终端关闭流程各自收尾
    std::sync::Arc::into_inner(graceful)
        .expect("accept 循环结束后不应再有连接 task 持有引用")
        .shutdown()
        .await;
    println!("[WebAPI] 服务器已停止。");
}
