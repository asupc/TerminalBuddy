use axum::extract::{ConnectInfo, DefaultBodyLimit, Request};
use axum::http::{HeaderValue, StatusCode};
use axum::routing::{delete, get, post, put};
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

#[cfg(all(not(debug_assertions), feature = "desktop"))]
use axum::response::{IntoResponse, Redirect};

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
/// 端口被占用时的绑定重试窗口：同端口的「先停旧服务再起新服务」之间，旧监听
/// socket 的释放与新 bind 存在调度间隙，偶发 AddrInUse；短暂重试即可避开，
/// 真被其他程序占用时到点仍按原样报错。
const BIND_RETRY_WINDOW: Duration = Duration::from_secs(2);
/// 关停时等待在飞连接排空的上限。正常请求毫秒级排空；卡死的客户端（如上传
/// 中途断连）可能遥遥无期，到点放弃等待，剩余连接随各自 task 在后台自然结束。
const GRACEFUL_DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct AppState {
    pub jwt_secret: String,
    pub app_handle: crate::runtime::AppHandle,
    /// 登录限流器：按 IP 的失败计数 + 指数退避封禁 + bcrypt 并发闸门。
    pub login_throttle: std::sync::Arc<LoginThrottle>,
}

impl HasJwtSecret for AppState {
    fn jwt_secret(&self) -> &str {
        &self.jwt_secret
    }
}

// Embed web frontend files for release mode
#[cfg(all(not(debug_assertions), feature = "desktop"))]
static WEB_DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../web/dist");

/// 桌面版内嵌的完整网页界面：src/ 前端以 `--mode browser` 构建（独立服务端在 `/`
/// 服务的就是这份产物）。桌面版浏览器访问与独立服务端同款布局——`/` 完整界面、
/// `/m/` 手机 SPA（`WEB_DIST`），手机 UA 访问 `/` 自动分流到手机版。
#[cfg(all(not(debug_assertions), feature = "desktop"))]
static WEB_DESKTOP_DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../dist-web");

pub fn build_router(state: AppState) -> Router {
    // AI 会话的长文本和历史记录不设正文大小、请求处理时长或实时连接配额。
    let ai_router = Router::new()
        .route("/api/ai/catalog", get(handlers::ai_chat_handler::catalog))
        // CLI 历史会话（按项目 + Agent 浏览，与 PC 端共享同一索引）
        .route("/api/ai/history", get(handlers::ai_chat_handler::history))
        .route("/api/ai/history/rescan", post(handlers::ai_chat_handler::history_rescan))
        .route("/api/ai/sessions", get(handlers::ai_chat_handler::list).post(handlers::ai_chat_handler::create))
        .route("/api/ai/sessions/{id}", get(handlers::ai_chat_handler::get).delete(handlers::ai_chat_handler::delete))
        .route("/api/ai/sessions/{id}/messages", post(handlers::ai_chat_handler::send))
        .route("/api/ai/sessions/{id}/flush", post(handlers::ai_chat_handler::flush))
        .route("/api/ai/sessions/{id}/stop", post(handlers::ai_chat_handler::stop))
        .route("/api/ai/sessions/{id}/approvals", post(handlers::ai_chat_handler::answer))
        .route("/ws/ai", get(handlers::ai_chat_handler::notifications_socket))
        .route("/ws/ai/{id}", get(handlers::ai_chat_handler::socket))
        .layer(DefaultBodyLimit::disable());
    let router = Router::new()
        // 认证
        .route("/api/auth/login", post(handlers::auth_handler::login))
        .route("/api/auth/status", get(handlers::auth_handler::status))
        .route("/api/runtime", get(handlers::desktop_handler::runtime_info))
        .route("/api/container/environment", get(handlers::container_environment::status))
        .route("/api/container/environment/{tool}", get(handlers::container_environment::tool_status))
        .route("/api/container/environment/{tool}/install", post(handlers::container_environment::install))
        .route("/api/container/environment/{tool}/update", post(handlers::container_environment::update))
        .route("/api/container/claude/providers", get(handlers::claude_provider_handler::list).post(handlers::claude_provider_handler::create))
        .route("/api/container/claude/providers/import-current", post(handlers::claude_provider_handler::import_current))
        .route("/api/container/claude/providers/deactivate", post(handlers::claude_provider_handler::deactivate))
        .route("/api/container/claude/providers/{id}", axum::routing::put(handlers::claude_provider_handler::update).delete(handlers::claude_provider_handler::remove))
        .route("/api/container/claude/providers/{id}/activate", post(handlers::claude_provider_handler::activate))
        .route("/api/desktop/invoke/{command}", post(handlers::desktop_handler::invoke))
        .route("/api/desktop/jobs/{id}", get(handlers::desktop_handler::job))
        .route("/api/desktop/upload", post(handlers::desktop_handler::upload).layer(DefaultBodyLimit::max(32 * 1024 * 1024)))
        .route("/api/desktop/file", get(handlers::desktop_handler::file))
        .route("/ws/events", get(handlers::desktop_handler::events))
        .route("/api/health", get(|| async { "正常" }))
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
        // 项目只读列表 —— Web 端「启动项目」用（目录 + 自定义启动命令）
        .route("/api/projects", get(handlers::profile_handler::list_projects))
        // 目录选择器独立发现浏览入口，仅列出目录。
        .route("/api/fs/roots", get(handlers::fs_handler::roots))
        .route("/api/fs/directories", get(handlers::fs_handler::directories))
        // 项目文件树（只读浏览，白名单=已登记项目目录）
        .route("/api/fs/list", get(handlers::fs_handler::list))
        // Git：状态 / 分支为同步查询；切换 / 提交 / 拉取 / 推送为后台任务 + 轮询
        .route("/api/git/status", get(handlers::git_handler::status))
        .route("/api/git/branches", get(handlers::git_handler::branches))
        .route("/api/git/operation", get(handlers::git_handler::operation))
        .route("/api/git/checkout", post(handlers::git_handler::checkout))
        .route("/api/git/commit", post(handlers::git_handler::commit))
        .route("/api/git/pull", post(handlers::git_handler::pull))
        .route("/api/git/push", post(handlers::git_handler::push))
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
        // Claude 历史会话（与 PC 端共享 SQLite 索引与 ~/.claude/projects 转录）
        .route(
            "/api/claude-history",
            get(handlers::claude_history_handler::list),
        )
        .route(
            "/api/claude-history/search",
            get(handlers::claude_history_handler::search),
        )
        .route(
            "/api/claude-history/rescan",
            post(handlers::claude_history_handler::rescan),
        )
        .route(
            "/api/claude-history/delete-batch",
            post(handlers::claude_history_handler::delete_batch),
        )
        .route(
            "/api/claude-history/{id}/replay",
            get(handlers::claude_history_handler::replay),
        )
        .route(
            "/api/claude-history/{id}/rename",
            post(handlers::claude_history_handler::rename),
        )
        .route(
            "/api/claude-history/{id}/flags",
            post(handlers::claude_history_handler::set_flags),
        )
        .route(
            "/api/claude-history/{id}/export",
            get(handlers::claude_history_handler::export),
        )
        .route(
            "/api/claude-history/{id}",
            delete(handlers::claude_history_handler::delete),
        )
        // Claude 默认配置文件（与 PC 端共享 ~/.claude/settings.json）
        .route(
            "/api/claude/settings",
            get(handlers::claude_settings_handler::read)
                .put(handlers::claude_settings_handler::write),
        )
        .route(
            "/api/claude/settings/backups",
            get(handlers::claude_settings_handler::list_backups),
        )
        .route(
            "/api/claude/settings/backups/{id}/restore",
            post(handlers::claude_settings_handler::restore_backup),
        )
        // 大模型供应商（与 PC 端共享 llm_providers.json）
        .route(
            "/api/llm-providers",
            get(handlers::llm_provider_handler::list).post(handlers::llm_provider_handler::create),
        )
        .route(
            "/api/llm-providers/fetch-models",
            post(handlers::llm_provider_handler::fetch_models),
        )
        .route(
            "/api/llm-providers/launch-targets",
            get(handlers::llm_provider_handler::launch_targets),
        )
        .route(
            "/api/llm-providers/order",
            put(handlers::llm_provider_handler::update_order),
        )
        .route(
            "/api/llm-providers/{id}",
            put(handlers::llm_provider_handler::update)
                .delete(handlers::llm_provider_handler::remove),
        )
        .route(
            "/api/llm-providers/{id}/set-default",
            post(handlers::llm_provider_handler::set_default),
        )
        .route(
            "/api/llm-providers/clear-default",
            post(handlers::llm_provider_handler::clear_default),
        )
        // 会话列表实时同步（meta WS，App 级单连接）
        .route("/ws/meta", get(ws::meta_ws_handler))
        // 终端 I/O（per-terminal WS）
        .route("/ws/terminal/{id}", get(ws::terminal_ws_handler));

    // 桌面版继续由桌面设置管理密码，仅独立服务端提供首次初始化入口。
    #[cfg(not(feature = "desktop"))]
    let router = router.route("/api/auth/setup", post(handlers::auth_handler::setup_admin));

    // 桌面版 debug：直连场景服务 web/dist（手机 SPA），完整界面走 vite dev server。
    #[cfg(all(debug_assertions, feature = "desktop"))]
    let router = {
        use tower_http::services::{ServeDir, ServeFile};
        let dist = std::env::var("TERMINAL_BUDDY_WEB_DIST").unwrap_or_else(|_| format!("{}/../web/dist", env!("CARGO_MANIFEST_DIR")));
        router.fallback_service(
            ServeDir::new(&dist).not_found_service(ServeFile::new(std::path::Path::new(&dist).join("index.html"))),
        )
    };

    // 独立服务端（Docker）：/ 服务完整界面（dist-web），/m/ 服务手机 SPA（web/dist），
    // 访问 / 时按 User-Agent 分流——手机 UA 自动跳转手机版。静态资源互不冲突
    // （手机 SPA 以相对路径 base 构建，其资源都在 /m/ 前缀下）。
    #[cfg(not(feature = "desktop"))]
    let router = {
        use axum::response::{IntoResponse, Redirect};
        use tower_http::services::{ServeDir, ServeFile};
        let dist = std::env::var("TERMINAL_BUDDY_WEB_DIST").unwrap_or_else(|_| format!("{}/../dist-web", env!("CARGO_MANIFEST_DIR")));
        let mobile_dist = std::env::var("TERMINAL_BUDDY_MOBILE_DIST").unwrap_or_else(|_| format!("{}/../web/dist", env!("CARGO_MANIFEST_DIR")));
        let index_path = std::path::Path::new(&dist).join("index.html");
        let root_entry = move |headers: axum::http::HeaderMap| {
            let index_path = index_path.clone();
            async move {
                if crate::web::client_kind::client_kind_from_headers(&headers)
                    == crate::models::TerminalClientKind::Mobile
                {
                    return Redirect::to("/m/").into_response();
                }
                match tokio::fs::read(&index_path).await {
                    Ok(bytes) => {
                        ([("content-type", "text/html; charset=utf-8")], bytes).into_response()
                    }
                    Err(_) => axum::http::StatusCode::NOT_FOUND.into_response(),
                }
            }
        };
        router
            // 精确路由优先于 fallback：/ 在这里按设备分流，其余静态资源仍走 fallback。
            .route("/", get(root_entry))
            .nest_service(
                "/m",
                ServeDir::new(&mobile_dist).not_found_service(ServeFile::new(
                    std::path::Path::new(&mobile_dist).join("index.html"),
                )),
            )
            .fallback_service(
                ServeDir::new(&dist).not_found_service(ServeFile::new(
                    std::path::Path::new(&dist).join("index.html"),
                )),
            )
    };

    #[cfg(all(not(debug_assertions), feature = "desktop"))]
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
        // 普通 API 继续使用请求保护，AI 路由在应用这些中间件后合并。
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .merge(ai_router)
        .with_state(state)
        // CORS 放最外层让 408 等错误响应也带跨域头，便于开发期排查。
        .layer(cors)
}

#[cfg(all(not(debug_assertions), feature = "desktop"))]
async fn serve_embedded_file(req: axum::extract::Request) -> axum::response::Response {
    let path = req.uri().path();
    // 手机 UA 访问根路径自动分流到手机版（与独立服务端一致），查询串原样带过去
    // （?token= 免密登录在两个界面里都支持）。
    if path == "/"
        && crate::web::client_kind::client_kind_from_headers(req.headers())
            == crate::models::TerminalClientKind::Mobile
    {
        let target = match req.uri().query() {
            Some(query) => format!("/m/?{}", query),
            None => "/m/".to_string(),
        };
        return Redirect::to(&target).into_response();
    }
    // 手机 SPA 以相对路径 base 构建，/m 缺斜杠时资源会解析到根前缀，补上再进。
    if path == "/m" {
        return Redirect::to("/m/").into_response();
    }
    // /m/ 前缀 → 手机 SPA（web/dist）；其余路径 → 完整桌面界面（dist-web）
    if let Some(mobile_path) = path.strip_prefix("/m/") {
        return serve_from_embedded(&WEB_DIST, mobile_path);
    }
    serve_from_embedded(&WEB_DESKTOP_DIST, path.trim_start_matches('/'))
}

/// 从 include_dir 目录服务静态文件：空路径与未知路径回退 index.html（SPA 路由），
/// 连 index.html 都缺（前端产物未随二进制嵌入）时 404。只接受 `'static` 目录
/// （两个嵌入产物都是 static），contents() 因此零拷贝进响应体。
#[cfg(all(not(debug_assertions), feature = "desktop"))]
fn serve_from_embedded(dir: &'static include_dir::Dir<'static>, path: &str) -> axum::response::Response {
    let file = if path.is_empty() { None } else { dir.get_file(path) };
    match file.or_else(|| dir.get_file("index.html")) {
        Some(file) => {
            let content_type = file
                .path()
                .to_str()
                .map(guess_content_type)
                .unwrap_or("application/octet-stream");
            (
                [(axum::http::header::CONTENT_TYPE, content_type)],
                file.contents(),
            )
                .into_response()
        }
        None => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(all(not(debug_assertions), feature = "desktop"))]
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
    app_handle: crate::runtime::AppHandle,
    mut shutdown_rx: watch::Receiver<bool>,
) -> std::io::Result<()> {
    let state = AppState {
        jwt_secret,
        app_handle,
        login_throttle: std::sync::Arc::new(LoginThrottle::new()),
    };
    let router = build_router(state);

    // 独立服务端同样清扫模型终端残留的临时 --settings 文件（桌面端在 setup 里
    // 已做过一次，本调用幂等，重复执行无害）。
    let _cleanup_task = tokio::task::spawn_blocking(|| {
        crate::services::llm_provider_service::cleanup_stale_temp_settings();
    });

    // 绑定 0.0.0.0：让同一局域网的手机端可访问（旧实现绑定 127.0.0.1 仅本机可达）
    #[cfg(feature = "desktop")]
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    #[cfg(not(feature = "desktop"))]
    let addr = SocketAddr::new(
        std::env::var("TERMINAL_BUDDY_LISTEN_ADDRESS").unwrap_or_else(|_| "0.0.0.0".to_string())
            .parse().map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?,
        port,
    );
    let listener = {
        let deadline = tokio::time::Instant::now() + BIND_RETRY_WINDOW;
        loop {
            match TcpListener::bind(addr).await {
                Ok(listener) => break listener,
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse
                    && tokio::time::Instant::now() < deadline =>
                {
                    // 旧服务实例还在释放端口，稍候重试
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) => {
                    eprintln!("[WebAPI] 端口 {} 绑定失败: {}。", port, e);
                    return Err(e);
                }
            }
        }
    };

    println!("[WebAPI] 服务器启动成功，监听 http://{}。", addr);

    // 不用 axum::serve：它不给 hyper 配置 Timer，空闲连接的 header_read_timeout
    // 永远不会触发。自写 accept 循环，逐连接配 TokioTimer + 空闲超时，
    // 客户端建连后不发请求头的半开连接会在 30 秒后被断开。
    // GracefulShutdown 故意不实现 Clone 且 shutdown(self) 按值消费；但 watcher(&self)
    // 产出的是独立 'static 的 Watcher，连接 task 只需携带 Watcher——关停方独占本体，
    // 不与任何连接共享引用。旧实现用 Arc 共享本体再 Arc::into_inner 回收所有权，
    // 关停瞬间只要有存活连接（浏览器 keep-alive、在途请求）就回收失败 panic，
    // 而 release 的 panic=abort 会直接崩掉整个进程。
    let graceful = GracefulShutdown::new();

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
                // 关停信号已到却恰好又 accept 到连接：直接丢弃，别再起新 task——
                // 信号发出之后才订阅的 Watcher 收不到这次关停，会拖住排空。
                if *shutdown_rx.borrow() {
                    break;
                }

                let service = TowerToHyperService::new(ConnectInfoService {
                    inner: router.clone(),
                    remote_addr,
                });
                let watcher = graceful.watcher();
                tokio::spawn(async move {
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
                    let _ = watcher.watch(conn).await;
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
    // 通知在飞连接排空并等待其结束。此刻可能仍有连接存活——这正是优雅关停要处理
    // 的常态，等待有上限；已升级的 WebSocket 长连接在升级完成时就已归还 Watcher，
    // 由终端关闭流程各自收尾。
    if tokio::time::timeout(GRACEFUL_DRAIN_TIMEOUT, graceful.shutdown())
        .await
        .is_err()
    {
        eprintln!(
            "[WebAPI] 等待在飞连接排空超过 {} 秒，剩余连接将在后台自行结束。",
            GRACEFUL_DRAIN_TIMEOUT.as_secs()
        );
    }
    println!("[WebAPI] 服务器已停止。");
    Ok(())
}
