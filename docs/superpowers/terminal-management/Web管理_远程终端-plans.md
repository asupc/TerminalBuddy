# Web管理_远程终端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TerminalBuddy 添加 Web API 服务和 Web 前端，通过浏览器远程管理连接配置和操作终端。

**Architecture:** 在 Tauri 进程中嵌入 axum HTTP 服务器（REST API + WebSocket），Web 前端（React + xterm.js）构建后通过 include_dir! 嵌入 Rust 二进制。终端输出通过 OutputBroadcaster 同时推送到 Tauri 事件（桌面端）和 WebSocket（Web端），两者共享 TerminalService 中的终端实例。

**Tech Stack:** axum 0.8 + tokio-tungstenite + jsonwebtoken + bcrypt（后端），React 18 + xterm.js 5.5 + zustand + axios（前端）

**Skills for implementation:** minimax-skills:fullstack-dev — full-stack architecture, REST API + WebSocket, auth flows

---

## 文件结构总览

```
terminal-buddy/
├── src-tauri/
│   ├── Cargo.toml                              # [修改] 添加新依赖
│   ├── src/
│   │   ├── lib.rs                              # [修改] 注册新命令，setup中启停Web服务
│   │   ├── models/
│   │   │   ├── mod.rs                          # [修改] 添加 web_api 模块
│   │   │   ├── settings.rs                     # [修改] 扩展 AppSettings 字段
│   │   │   └── web_api.rs                      # [新建] Web API 相关数据模型
│   │   ├── services/
│   │   │   ├── mod.rs                          # [修改] 添加 web_service 模块
│   │   │   └── web_service.rs                  # [新建] Web服务状态管理
│   │   ├── commands/
│   │   │   ├── mod.rs                          # [修改] 添加 web 模块
│   │   │   ├── settings.rs                     # [修改] 添加 Web API 设置命令
│   │   │   └── web.rs                          # [新建] Web服务控制命令
│   │   └── web/                                # [新建目录]
│   │       ├── mod.rs                          # [新建] Web 模块入口
│   │       ├── server.rs                       # [新建] axum 路由和服务器
│   │       ├── auth.rs                         # [新建] JWT 中间件
│   │       ├── error.rs                        # [新建] 统一错误类型
│   │       ├── ws.rs                           # [新建] WebSocket 处理
│   │       └── handlers/
│   │           ├── mod.rs                      # [新建]
│   │           ├── auth_handler.rs             # [新建] 登录/状态
│   │           ├── profile_handler.rs          # [新建] 连接配置 CRUD
│   │           └── terminal_handler.rs         # [新建] 终端管理
│   └── static/                                 # [新建] 构建时嵌入目录
└── web/                                        # [新建目录] Web 前端项目
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    ├── tsconfig.json
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── App.css
        ├── api/
        │   ├── client.ts
        │   ├── auth.ts
        │   ├── profiles.ts
        │   └── terminals.ts
        ├── hooks/
        │   └── useTerminal.ts
        ├── components/
        │   ├── LoginPage.tsx
        │   ├── MainLayout.tsx
        │   ├── TerminalView.tsx
        │   ├── ProfileList.tsx
        │   ├── ProfileDialog.tsx
        │   ├── TabBar.tsx
        │   └── Sidebar.tsx
        ├── stores/
        │   └── appStore.ts
        ├── types/
        │   └── index.ts
        └── styles/
            └── index.css
```

---

### Task 1: 后端依赖与设置模型扩展

**Skills:** _none_ — 纯配置和数据结构修改，无领域 skill 需求

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/models/settings.rs`
- Create: `src-tauri/src/models/web_api.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/services/settings_service.rs`
- Modify: `src-tauri/src/commands/settings.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: 添加 Rust 依赖**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 末尾添加：

```toml
axum = { version = "0.8", features = ["ws"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["cors", "fs"] }
tokio-tungstenite = "0.26"
jsonwebtoken = "9"
bcrypt = "0.17"
include_dir = "0.7"
rand = "0.8"
```

- [ ] **Step 2: 创建 Web API 数据模型**

创建 `src-tauri/src/models/web_api.rs`：

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    pub token: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiStatusResponse {
    pub enabled: bool,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiErrorResponse {
    pub error: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInfo {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub terminal_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsClientMessage {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsServerMessage {
    #[serde(rename = "output")]
    Output { data: String },
    #[serde(rename = "exited")]
    Exited { code: i32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartTerminalRequest {
    pub profile_id: String,
}
```

- [ ] **Step 3: 扩展 AppSettings 模型**

在 `src-tauri/src/models/settings.rs` 中添加新字段和默认函数：

```rust
// 在文件末尾, CloseBehavior 之后添加默认函数:

fn default_web_api_enabled() -> bool {
    false
}

fn default_web_api_port() -> u16 {
    9600
}

fn default_web_api_username() -> String {
    "admin".to_string()
}

fn default_web_api_password_hash() -> String {
    String::new()
}
```

在 `AppSettings` 结构体中添加字段（`single_instance` 之后）：

```rust
    #[serde(default = "default_web_api_enabled")]
    pub web_api_enabled: bool,
    #[serde(default = "default_web_api_port")]
    pub web_api_port: u16,
    #[serde(default = "default_web_api_username")]
    pub web_api_username: String,
    #[serde(default = "default_web_api_password_hash")]
    pub web_api_password_hash: String,
```

在 `impl Default for AppSettings` 中添加：

```rust
            web_api_enabled: false,
            web_api_port: 9600,
            web_api_username: "admin".to_string(),
            web_api_password_hash: String::new(),
```

- [ ] **Step 4: 更新 models/mod.rs**

```rust
pub mod profile;
pub mod settings;
pub mod theme;
pub mod web_api;
pub mod workspace;
pub use profile::*;
pub use settings::*;
pub use theme::*;
pub use web_api::*;
pub use workspace::*;
```

- [ ] **Step 5: 更新 services/settings_service.rs — 暴露 settings.json 路径**

在 `impl SettingsService` 中将 `get_settings_path` 改为 `pub`：

```rust
    pub fn get_settings_path() -> PathBuf {
        // 保持原有实现不变
    }
```

- [ ] **Step 6: 添加 Web API 设置保存命令**

在 `src-tauri/src/commands/settings.rs` 末尾添加：

```rust
use crate::models::web_api::*;
use crate::services::SettingsService;
use bcrypt::{hash, DEFAULT_COST};

#[tauri::command]
pub fn save_web_api_settings(
    enabled: bool,
    port: u16,
    username: String,
    password: String,
) -> Result<(), String> {
    let mut settings = SettingsService::get_settings();
    settings.web_api_enabled = enabled;
    settings.web_api_port = port;
    settings.web_api_username = username;
    if !password.is_empty() {
        settings.web_api_password_hash = hash(password, DEFAULT_COST)
            .map_err(|e| format!("密码加密失败: {}", e))?;
    }
    SettingsService::save_settings(&settings)
}

#[tauri::command]
pub fn get_web_api_status() -> serde_json::Value {
    let settings = SettingsService::get_settings();
    serde_json::json!({
        "enabled": settings.web_api_enabled,
        "port": settings.web_api_port,
        "username": settings.web_api_username,
        "hasPassword": !settings.web_api_password_hash.is_empty(),
    })
}
```

- [ ] **Step 7: 更新 commands/mod.rs**

添加新命令模块：

```rust
pub mod web;
// ... 在现有 pub use 中
pub use web::*;
```

- [ ] **Step 8: 编译验证**

```bash
cd terminal-buddy/src-tauri && cargo check 2>&1
```

预期：编译成功（此时新字段可以序列化/反序列化，Web 命令已注册）

- [ ] **Step 9: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/src/models/settings.rs src-tauri/src/models/web_api.rs src-tauri/src/models/mod.rs src-tauri/src/services/settings_service.rs src-tauri/src/commands/settings.rs src-tauri/src/commands/mod.rs
git commit -m "feat: 添加Web API依赖和设置模型扩展"
```

---

### Task 2: Web API 服务器核心（axum 路由 + JWT 认证 + 错误处理）

**Skills:** minimax-skills:fullstack-dev — REST API 架构、认证流程、错误处理

**Skill-Derived Code Examples:**

**`minimax-skills:fullstack-dev` pattern** — axum Router 组织、JWT 中间件模式、统一错误响应：

```rust
// server.rs - Router with nested routes and auth middleware
pub fn build_router(jwt_secret: String) -> Router {
    Router::new()
        .route("/api/auth/login", post(handlers::auth_handler::login))
        .route("/api/auth/status", get(handlers::auth_handler::status))
        .nest("/api", protected_routes())
        .layer(CorsLayer::permissive())
}

fn protected_routes() -> Router {
    Router::new()
        .route("/profiles", get(handlers::profile_handler::list).post(handlers::profile_handler::create))
        .route("/profiles/:id", put(handlers::profile_handler::update).delete(handlers::profile_handler::delete))
        .route("/terminals", get(handlers::terminal_handler::list).post(handlers::terminal_handler::start))
        .route("/terminals/:id", delete(handlers::terminal_handler::close))
        .layer(from_fn_with_state(jwt_secret, auth_middleware))
}
```

```rust
// auth.rs - JWT middleware extracting claims into request extensions
pub async fn auth_middleware(
    State(jwt_secret): State<String>,
    headers: HeaderMap,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = extract_bearer_token(&headers)?;
    let claims = verify_token(&token, &jwt_secret)?;
    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}
```

```rust
// error.rs - Unified error type implementing IntoResponse
pub enum ApiError {
    Unauthorized(String),
    BadRequest(String),
    NotFound(String),
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            ApiError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "unauthorized", msg),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "bad_request", msg),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, "not_found", msg),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", msg),
        };
        (status, Json(json!({ "error": error, "message": message }))).into_response()
    }
}
```

**Files:**
- Create: `src-tauri/src/web/mod.rs`
- Create: `src-tauri/src/web/error.rs`
- Create: `src-tauri/src/web/auth.rs`
- Create: `src-tauri/src/web/server.rs`
- Create: `src-tauri/src/web/handlers/mod.rs`
- Create: `src-tauri/src/web/handlers/auth_handler.rs`
- Create: `src-tauri/src/web/ws.rs`

- [ ] **Step 1: 创建 web/mod.rs — 模块入口**

```rust
pub mod server;
pub mod auth;
pub mod error;
pub mod ws;
pub mod handlers;
```

- [ ] **Step 2: 创建 web/error.rs — 统一错误类型**

```rust
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub enum ApiError {
    Unauthorized(String),
    BadRequest(String),
    NotFound(String),
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            ApiError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "unauthorized", msg),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "bad_request", msg),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, "not_found", msg),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", msg),
        };
        (status, Json(json!({ "error": error, "message": message }))).into_response()
    }
}
```

- [ ] **Step 3: 创建 web/auth.rs — JWT 认证中间件**

```rust
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use chrono::{Utc, Duration};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,      // username
    pub exp: usize,       // expiry
    pub iat: usize,       // issued at
}

pub fn generate_jwt(username: &str, secret: &str) -> Result<String, String> {
    let now = Utc::now();
    let claims = Claims {
        sub: username.to_string(),
        iat: now.timestamp() as usize,
        exp: (now + Duration::hours(24)).timestamp() as usize,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))
        .map_err(|e| format!("JWT 生成失败: {}", e))
}

pub fn verify_token(token: &str, secret: &str) -> Result<Claims, StatusCode> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| StatusCode::UNAUTHORIZED)
}

fn extract_bearer_token(auth_header: Option<&str>) -> Result<&str, StatusCode> {
    let header = auth_header.ok_or(StatusCode::UNAUTHORIZED)?;
    header
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)
}

/// Axum extractor for JWT claims — use in handlers via `Claims: ClaimsFromRequest`
pub struct ClaimsFromRequest(pub Claims);

impl<S> FromRequestParts<S> for ClaimsFromRequest
where
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let secret = parts
            .extensions
            .get::<String>()
            .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

        let auth_header = parts
            .headers
            .get("Authorization")
            .and_then(|v| v.to_str().ok());

        let token = extract_bearer_token(auth_header)?;
        let claims = verify_token(token, secret)?;
        Ok(ClaimsFromRequest(claims))
    }
}

/// Generate a random 256-bit secret for JWT signing
pub fn generate_jwt_secret() -> String {
    use rand::Rng;
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}
```

需要在 Cargo.toml 补充 `hex` 依赖：

```toml
hex = "0.4"
```

- [ ] **Step 4: 创建 web/handlers/mod.rs**

```rust
pub mod auth_handler;
pub mod profile_handler;
pub mod terminal_handler;
```

- [ ] **Step 5: 创建 web/handlers/auth_handler.rs**

```rust
use axum::{Json, extract::State};
use crate::models::web_api::{LoginRequest, LoginResponse, ApiStatusResponse};
use crate::services::SettingsService;
use crate::web::auth::{generate_jwt, ClaimsFromRequest};
use crate::web::error::ApiError;
use bcrypt::verify;

pub async fn login(
    State(state): State<crate::web::server::AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let settings = SettingsService::get_settings();

    if !settings.web_api_enabled {
        return Err(ApiError::BadRequest("Web API 未启用".into()));
    }

    if settings.web_api_password_hash.is_empty() {
        return Err(ApiError::BadRequest("未设置 Web API 密码".into()));
    }

    if req.username != settings.web_api_username {
        return Err(ApiError::Unauthorized("用户名或密码错误".into()));
    }

    let valid = verify(&req.password, &settings.web_api_password_hash)
        .unwrap_or(false);
    if !valid {
        return Err(ApiError::Unauthorized("用户名或密码错误".into()));
    }

    let token = generate_jwt(&req.username, &state.jwt_secret)
        .map_err(|e| ApiError::Internal(e))?;

    Ok(Json(LoginResponse {
        token,
        username: req.username,
    }))
}

pub async fn status() -> Json<ApiStatusResponse> {
    let settings = SettingsService::get_settings();
    Json(ApiStatusResponse {
        enabled: settings.web_api_enabled,
        port: settings.web_api_port,
    })
}
```

- [ ] **Step 6: 创建 web/server.rs — axum 路由与服务器**

```rust
use axum::Router;
use axum::routing::{get, post, put, delete};
use tower_http::cors::{CorsLayer, Any};
use std::sync::Arc;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::web::handlers;

#[derive(Clone)]
pub struct AppState {
    pub jwt_secret: String,
}

pub fn build_router(state: AppState) -> Router {
    let public = Router::new()
        .route("/api/auth/login", post(handlers::auth_handler::login))
        .route("/api/auth/status", get(handlers::auth_handler::status));

    let protected = Router::new()
        .route("/profiles", get(handlers::profile_handler::list).post(handlers::profile_handler::create))
        .route("/profiles/{id}", put(handlers::profile_handler::update).delete(handlers::profile_handler::delete))
        .route("/terminals", get(handlers::terminal_handler::list).post(handlers::terminal_handler::start))
        .route("/terminals/{id}", delete(handlers::terminal_handler::close));

    public
        .merge(protected)
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
```

- [ ] **Step 7: 创建 web/ws.rs — WebSocket 终端桥接（占位）**

先创建基本结构，终端连接逻辑在 Task 4 中完善：

```rust
use axum::extract::ws::{WebSocket, Message, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use std::collections::HashMap;
use crate::web::server::AppState;
use crate::web::auth::verify_token;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(terminal_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let token = params.get("token").ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let _claims = verify_token(token, &state.jwt_secret)?;
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, terminal_id)))
}

async fn handle_socket(socket: WebSocket, terminal_id: String) {
    // 占位 — 在 Task 4 中实现具体逻辑
    let (mut _sender, mut _receiver) = socket.split();
    tracing::info!("WebSocket connected for terminal {}", terminal_id);
}
```

- [ ] **Step 8: 编译验证**

```bash
cd terminal-buddy/src-tauri && cargo check 2>&1
```

解决编译错误后提交。

- [ ] **Step 9: 提交**

```bash
git add src-tauri/src/web/ src-tauri/Cargo.toml
git commit -m "feat: 实现Web API服务器核心（路由+JWT认证+错误处理）"
```

---

### Task 3: 后端处理器 — Profile CRUD + 终端管理 + WebSocket

**Skills:** minimax-skills:fullstack-dev — REST API handlers, WebSocket bidirectional communication

**Skill-Derived Code Examples:**

**`minimax-skills:fullstack-dev` pattern** — Handler 通过 State 访问共享服务，返回统一 Json 或 ApiError：

```rust
pub async fn list(
    State(state): State<AppState>,
    ClaimsFromRequest(claims): ClaimsFromRequest,
) -> Result<Json<Vec<Profile>>, ApiError> {
    let profiles = ProfileService::get_all_profiles()?;
    Ok(Json(profiles))
}
```

**Files:**
- Create: `src-tauri/src/web/handlers/profile_handler.rs`
- Create: `src-tauri/src/web/handlers/terminal_handler.rs`
- Modify: `src-tauri/src/web/ws.rs`
- Modify: `src-tauri/src/web/server.rs`（注册 WS 路由）
- Create: `src-tauri/src/services/web_service.rs`
- Modify: `src-tauri/src/services/mod.rs`

- [ ] **Step 1: 创建 web_service.rs — Web 服务状态管理**

```rust
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::sync::watch;

pub struct WebServiceState {
    pub shutdown_tx: Option<watch::Sender<bool>>,
    pub jwt_secret: String,
    /// 终端输出订阅者: terminal_id → Vec<发送通道>
    pub output_subscribers: Arc<Mutex<std::collections::HashMap<String, Vec<mpsc::UnboundedSender<String>>>>>,
}

impl WebServiceState {
    pub fn new() -> Self {
        Self {
            shutdown_tx: None,
            jwt_secret: String::new(),
            output_subscribers: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub fn subscribe(&self, terminal_id: &str) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut subs = self.output_subscribers.lock().unwrap();
        subs.entry(terminal_id.to_string()).or_default().push(tx);
        rx
    }

    pub fn unsubscribe(&self, terminal_id: &str) {
        let mut subs = self.output_subscribers.lock().unwrap();
        subs.remove(terminal_id);
    }

    pub fn broadcast(&self, terminal_id: &str, data: &str) {
        let subs = self.output_subscribers.lock().unwrap();
        if let Some(senders) = subs.get(terminal_id) {
            for tx in senders {
                let _ = tx.send(data.to_string());
            }
        }
    }
}
```

- [ ] **Step 2: 更新 services/mod.rs**

```rust
pub mod history_service;
pub mod path_service;
pub mod profile_service;
pub mod settings_service;
pub mod template_service;
pub mod theme_service;
pub mod web_service;
pub mod workspace_service;
pub use history_service::*;
pub use path_service::*;
pub use profile_service::*;
pub use settings_service::*;
pub use template_service::*;
pub use theme_service::*;
pub use web_service::*;
pub use workspace_service::*;
```

- [ ] **Step 3: 创建 web/handlers/profile_handler.rs**

```rust
use axum::{Json, extract::{State, Path}};
use crate::models::Profile;
use crate::services::ProfileService;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;

pub async fn list(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<Profile>>, ApiError> {
    ProfileService::get_all_profiles().map(Json).map_err(|e| ApiError::Internal(e))
}

pub async fn create(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(profile): Json<Profile>,
) -> Result<Json<Profile>, ApiError> {
    let created = ProfileService::create_profile(&profile.name, &profile.group, &profile.terminal_type)
        .map_err(|e| ApiError::Internal(e))?;
    // 更新完整 profile 信息
    let mut full = profile;
    full.id = created.id;
    full.created_at = created.created_at;
    full.last_used_at = created.last_used_at;
    ProfileService::update_profile(&full).map_err(|e| ApiError::Internal(e))?;
    Ok(Json(full))
}

pub async fn update(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
    Json(profile): Json<Profile>,
) -> Result<Json<Profile>, ApiError> {
    if profile.id != id {
        return Err(ApiError::BadRequest("ID 不匹配".into()));
    }
    ProfileService::update_profile(&profile).map_err(|e| ApiError::Internal(e))?;
    Ok(Json(profile))
}

pub async fn delete(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    ProfileService::delete_profile(&id).map_err(|e| ApiError::Internal(e))?;
    Ok(Json(serde_json::json!({ "deleted": true })))
}
```

- [ ] **Step 4: 创建 web/handlers/terminal_handler.rs**

```rust
use axum::{Json, extract::{State, Path}};
use crate::models::web_api::{TerminalInfo, StartTerminalRequest};
use crate::services::ProfileService;
use crate::commands::TerminalService;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use tauri::Manager;

pub async fn list(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<TerminalInfo>>, ApiError> {
    let app = state.app_handle.clone();
    let ts = app.state::<TerminalService>();
    let instances = ts.instances.lock().unwrap();
    let terminals: Vec<TerminalInfo> = instances.values().map(|inst| {
        let profile = ProfileService::get_profile(&inst.profile_id).ok();
        TerminalInfo {
            id: inst.id.clone(),
            profile_id: inst.profile_id.clone(),
            profile_name: profile.map(|p| p.name).unwrap_or_default(),
            terminal_type: profile.map(|p| p.terminal_type).unwrap_or_default(),
        }
    }).collect();
    Ok(Json(terminals))
}

pub async fn start(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<StartTerminalRequest>,
) -> Result<Json<TerminalInfo>, ApiError> {
    let app = state.app_handle.clone();
    let ts = app.state::<TerminalService>();
    let terminal_id = ts.create_terminal(&req.profile_id, app.inner.clone())
        .map_err(|e| ApiError::Internal(e))?;
    let profile = ProfileService::get_profile(&req.profile_id)
        .map_err(|e| ApiError::Internal(e))?;
    Ok(Json(TerminalInfo {
        id: terminal_id,
        profile_id: req.profile_id,
        profile_name: profile.name,
        terminal_type: profile.terminal_type,
    }))
}

pub async fn close(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let app = state.app_handle.clone();
    let ts = app.state::<TerminalService>();
    ts.close_terminal(&id).map_err(|e| ApiError::Internal(e))?;
    Ok(Json(serde_json::json!({ "closed": true })))
}
```

需要在 `AppState` 中添加 `app_handle` 字段。更新 `web/server.rs` 的 `AppState`：

```rust
#[derive(Clone)]
pub struct AppState {
    pub jwt_secret: String,
    pub app_handle: tauri::AppHandle,
}
```

同时也需要让 `TerminalService::instances` 字段和 `create_terminal`、`close_terminal` 方法可被外部访问。需要在 `commands/terminal.rs` 中将 `instances` 改为 `pub`，`create_terminal` 已为 `pub`，需要额外暴露 `profile_id` 字段。

在 `commands/terminal.rs` 的 `TerminalInstance` 结构体中添加 `profile_id` 字段：

```rust
pub struct TerminalInstance {
    pub id: String,
    pub profile_id: String,  // 新增
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    pub writer: Option<Box<dyn Write + Send>>,
    pub output_buffer: Arc<Mutex<Vec<String>>>,
}
```

并在 `create_terminal` 中设置 `profile_id: profile_id.to_string()`。

- [ ] **Step 5: 完善 web/ws.rs — WebSocket 终端 I/O 双向通信**

```rust
use axum::extract::ws::{WebSocket, Message, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use crate::commands::TerminalService;
use crate::models::web_api::{WsClientMessage, WsServerMessage};
use crate::services::WebServiceState;
use crate::web::auth::verify_token;
use crate::web::server::AppState;
use tauri::Manager;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(terminal_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let token = params.get("token").ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let _claims = verify_token(token, &state.jwt_secret)?;
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, terminal_id, state)))
}

async fn handle_socket(socket: WebSocket, terminal_id: String, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    let web_state = state.app_handle.state::<WebServiceState>();
    let mut output_rx = web_state.subscribe(&terminal_id);

    // Drain historical output
    {
        let ts = state.app_handle.state::<TerminalService>();
        if let Ok(history) = ts.drain_terminal_output(&terminal_id) {
            if !history.is_empty() {
                let msg = serde_json::to_string(&WsServerMessage::Output { data: history }).unwrap();
                let _ = ws_sender.send(Message::Text(msg.into())).await;
            }
        }
    }

    // Forward PTY output to WebSocket
    let send_task = tokio::spawn(async move {
        loop {
            match output_rx.recv().await {
                Some(data) => {
                    let msg = serde_json::to_string(&WsServerMessage::Output { data }).unwrap();
                    if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                None => break,
            }
        }
        let _ = ws_sender.close().await;
    });

    // Forward WebSocket input to PTY
    let app = state.app_handle.clone();
    let tid = terminal_id.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(cmd) = serde_json::from_str::<WsClientMessage>(&text) {
                        match cmd {
                            WsClientMessage::Input { data } => {
                                let ts = app.state::<TerminalService>();
                                let _ = ts.write_to_terminal(&tid, &data);
                            }
                            WsClientMessage::Resize { cols, rows } => {
                                let ts = app.state::<TerminalService>();
                                let _ = ts.resize_terminal(&tid, rows, cols);
                            }
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Wait for either task to finish
    tokio::select! {
        _ = send_task => {}
        _ = recv_task => {}
    }

    web_state.unsubscribe(&terminal_id);
}
```

需要在 Cargo.toml 添加 `futures-util`：

```toml
futures-util = "0.3"
```

- [ ] **Step 6: 更新 web/server.rs — 注册 WS 路由**

在 `build_router` 的 `protected` Router 中添加：

```rust
.route("/ws/terminal/{id}", get(crate::web::ws::ws_handler))
```

同时需要更新 `run_server` 来接受 `app_handle`，并将 `AppState` 传递给路由。

- [ ] **Step 7: 修改 TerminalService — 终端输出广播到 Web 端**

在 `commands/terminal.rs` 的 PTY reader thread 中，发送 Tauri 事件后添加 Web 端广播。但由于 reader thread 是 `std::thread` 而非 tokio task，需要通过 `tauri::AppHandle` 访问 `WebServiceState`：

在 PTY reader thread 的 emit 之后添加：

```rust
// 广播到 Web 端
let web_state = app_clone.state::<crate::services::WebServiceState>();
web_state.broadcast(&tid, &output);
```

- [ ] **Step 8: 编译验证**

```bash
cd terminal-buddy/src-tauri && cargo check 2>&1
```

- [ ] **Step 9: 提交**

```bash
git add src-tauri/src/web/handlers/ src-tauri/src/services/web_service.rs src-tauri/src/services/mod.rs src-tauri/src/commands/terminal.rs
git commit -m "feat: 实现Profile CRUD、终端管理处理器和WebSocket双向通信"
```

---

### Task 4: 服务器生命周期集成与静态文件服务

**Skills:** _none_ — 配置集成和构建脚本

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/web/server.rs`（静态文件服务）
- Create: `src-tauri/src/commands/web.rs`
- Create: `src-tauri/build.rs`（如果不存在）

- [ ] **Step 1: 在 lib.rs setup 中启动 Web 服务器**

在 `lib.rs` 的 `setup` 闭包中，追加 Web 服务启动逻辑：

```rust
use crate::services::WebServiceState;
use crate::web::server;
use crate::web::auth::generate_jwt_secret;
use tokio::sync::watch;

// 在 builder 链中，修改 setup 闭包:

builder
    .manage(TerminalService::new())
    .manage(WebServiceState::new()); // 新增

// 在 setup 闭包中，tray 初始化之后添加:

let app_handle = app.handle().clone();
let settings = SettingsService::get_settings();
if settings.web_api_enabled && !settings.web_api_password_hash.is_empty() {
    let port = settings.web_api_port;
    let jwt_secret = generate_jwt_secret();

    // 存储 jwt_secret
    {
        let web_state = app_handle.state::<WebServiceState>();
        let mut state = web_state; // 需要内部可变性
        // WebServiceState 需要用 Arc<Mutex<>> 包装内部字段
    }

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    {
        let web_state = app_handle.state::<WebServiceState>();
        web_state.shutdown_tx.lock().unwrap().replace(shutdown_tx);
    }

    tauri::async_runtime::spawn(server::run_server(port, jwt_secret, app_handle.clone(), shutdown_rx));
}
```

需要重新设计 `WebServiceState` 使用内部可变性：

```rust
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, watch};

pub struct WebServiceState {
    pub shutdown_tx: Mutex<Option<watch::Sender<bool>>>,
    pub jwt_secret: Mutex<String>,
    pub output_subscribers: Arc<Mutex<std::collections::HashMap<String, Vec<mpsc::UnboundedSender<String>>>>>,
}
```

- [ ] **Step 2: 创建 commands/web.rs — Web 服务控制命令**

```rust
use tauri::{AppHandle, command, State, Manager};
use crate::services::{SettingsService, WebServiceState};
use crate::web::server;
use crate::web::auth::generate_jwt_secret;
use tokio::sync::watch;

#[command]
pub async fn restart_web_server(app: AppHandle) -> Result<String, String> {
    let settings = SettingsService::get_settings();
    let web_state = app.state::<WebServiceState>();

    // 先停止现有服务
    if let Some(tx) = web_state.shutdown_tx.lock().unwrap().take() {
        let _ = tx.send(true);
    }

    if !settings.web_api_enabled || settings.web_api_password_hash.is_empty() {
        return Ok("Web API 已停止".into());
    }

    let jwt_secret = generate_jwt_secret();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    *web_state.jwt_secret.lock().unwrap() = jwt_secret.clone();
    *web_state.shutdown_tx.lock().unwrap() = Some(shutdown_tx);

    tauri::async_runtime::spawn(server::run_server(
        settings.web_api_port,
        jwt_secret,
        app.clone(),
        shutdown_rx,
    ));

    Ok(format!("Web API 已启动，端口: {}", settings.web_api_port))
}

#[command]
pub fn get_web_server_address() -> Result<String, String> {
    let settings = SettingsService::get_settings();
    if !settings.web_api_enabled {
        return Ok("Web API 未启用".into());
    }
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "localhost".to_string());
    Ok(format!("http://{}:{}", hostname, settings.web_api_port))
}
```

需要添加 `hostname` 依赖：

```toml
hostname = "0.4"
```

- [ ] **Step 3: lib.rs 注册新命令**

在 `invoke_handler!` 中添加：

```rust
restart_web_server,
get_web_server_address,
save_web_api_settings,
get_web_api_status,
```

并在 `lib.rs` 顶部导入新命令。

- [ ] **Step 4: 更新 web/server.rs — 添加静态文件服务**

在 `build_router` 中添加 SPA 静态文件服务（使用 `include_dir!` 嵌入的静态资源）：

```rust
use include_dir::{include_dir, Dir};
use tower_http::services::ServeDir;

static WEB_DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../web/dist");

// 在 build_router 中添加 fallback 路由:

let static_service = tower_http::services::ServeDir::new("web/dist");
// 但由于使用了 include_dir!，需要用 ServeDir 指向临时目录或直接 serve 嵌入的目录

// 实际使用 axum 的 fallback 模式:
let spa_router = Router::new()
    .fallback_service(
        axum::routing::get(|req: axum::http::Request<axum::body::Body>| async move {
            // 返回 index.html 对于 SPA 路由
            serve_static(req).await
        })
    );
```

具体实现需要根据 include_dir 的用法调整。对于开发模式，直接使用 `ServeDir`：

```rust
#[cfg(debug_assertions)]
fn static_service() -> Router {
    Router::new()
        .nest_service("/", ServeDir::new("../web/dist"))
}

#[cfg(not(debug_assertions))]
fn static_service() -> Router {
    // 生产模式使用嵌入的静态文件
    Router::new()
        .fallback_service(get(|req| async move {
            serve_embedded(req).await
        }))
}
```

- [ ] **Step 5: 编译验证**

```bash
cd terminal-buddy/src-tauri && cargo check 2>&1
```

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands/web.rs src-tauri/src/web/server.rs src-tauri/Cargo.toml
git commit -m "feat: 实现Web服务器生命周期集成和静态文件服务"
```

---

### Task 5: Web 前端项目搭建

**Skills:** minimax-skills:frontend-dev — React 项目搭建、Vite 配置

**Skill-Derived Code Examples:**

**`minimax-skills:frontend-dev` pattern** — Vite + React 项目结构，proxy 配置用于开发模式：

```typescript
// vite.config.ts - 开发时代理 API 到 Rust 后端
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:9600',
      '/ws': { target: 'ws://localhost:9600', ws: true },
    },
  },
  build: { outDir: 'dist' },
})
```

**Files:**
- Create: `web/package.json`
- Create: `web/vite.config.ts`
- Create: `web/tsconfig.json`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/App.css`
- Create: `web/src/types/index.ts`
- Create: `web/src/styles/index.css`

- [ ] **Step 1: 创建 web/package.json**

```json
{
  "name": "terminal-buddy-web",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/xterm": "^5.5.0",
    "axios": "^1.7.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "typescript": "^5.6.3",
    "vite": "^5.4.11"
  }
}
```

- [ ] **Step 2: 创建 web/vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:9600',
      '/ws': { target: 'ws://localhost:9600', ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
```

- [ ] **Step 3: 创建 web/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: 创建 web/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TerminalBuddy Web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 创建 web/src/main.tsx**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 6: 创建 web/src/App.tsx（基础路由框架）**

```tsx
import { useWebAppStore } from './stores/appStore';
import LoginPage from './components/LoginPage';
import MainLayout from './components/MainLayout';

function App() {
  const token = useWebAppStore((s) => s.token);

  if (!token) {
    return <LoginPage />;
  }

  return <MainLayout />;
}

export default App;
```

- [ ] **Step 7: 创建 web/src/types/index.ts**

```typescript
export type TerminalType = 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s';

export interface Profile {
  id: string;
  name: string;
  group: string;
  terminalType: TerminalType;
  startupPath: string;
  startupCommands: string[];
  environmentVariables: Record<string, string>;
  colorTheme: string;
  tabColor: string | null;
  windowSize: { width: number; height: number } | null;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'key';
  sshKeyPath?: string;
  dockerContainerId?: string;
  dockerContainerName?: string;
  k8sNamespace?: string;
  k8sPodName?: string;
  k8sContainerName?: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface WebTerminalSession {
  id: string;
  profileId: string;
  profileName: string;
  terminalType: TerminalType;
}

export interface TerminalInfo {
  id: string;
  profile_id: string;
  profile_name: string;
  terminal_type: string;
}
```

- [ ] **Step 8: 创建 web/src/App.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #root { height: 100%; overflow: hidden; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #1a1a2e;
  color: #e0e0e0;
}
```

- [ ] **Step 9: 创建 web/src/styles/index.css**

```css
:root {
  --bg-primary: #1a1a2e;
  --bg-secondary: #16162e;
  --bg-terminal: #0c0c1e;
  --border-color: #2a2a4a;
  --text-primary: #e0e0e0;
  --text-secondary: #8a8aaa;
  --accent: #6a6ad5;
  --danger: #ff6b6b;
  --success: #4caf50;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body, #root { height: 100%; overflow: hidden; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
}

input {
  background: #12122a;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  padding: 10px 14px;
  font-size: 14px;
  outline: none;
  width: 100%;
}

input:focus { border-color: var(--accent); }

button {
  cursor: pointer;
  transition: all 0.2s;
}

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #3a3a5a; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #5a5a7a; }
```

- [ ] **Step 10: 安装依赖并构建验证**

```bash
cd web && npm install && npx tsc --noEmit && npm run build
```

预期：TypeScript 编译无错误，构建成功产出 `web/dist/`。

- [ ] **Step 11: 提交**

```bash
git add web/
git commit -m "feat: 搭建Web前端项目基础结构"
```

---

### Task 6: Web 前端 — API 客户端 + 状态管理

**Skills:** minimax-skills:fullstack-dev — API client with JWT interceptor, state management

**Skill-Derived Code Examples:**

**`minimax-skills:fullstack-dev` pattern** — axios 实例 + 响应拦截器处理 401：

```typescript
const client = axios.create({ baseURL: '/api' });
client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      useWebAppStore.getState().logout();
    }
    return Promise.reject(err);
  }
);
```

**Files:**
- Create: `web/src/api/client.ts`
- Create: `web/src/api/auth.ts`
- Create: `web/src/api/profiles.ts`
- Create: `web/src/api/terminals.ts`
- Create: `web/src/stores/appStore.ts`

- [ ] **Step 1: 创建 web/src/api/client.ts**

```typescript
import axios from 'axios';
import { useWebAppStore } from '../stores/appStore';

const client = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

client.interceptors.request.use((config) => {
  const token = useWebAppStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useWebAppStore.getState().logout();
    }
    return Promise.reject(error);
  }
);

export default client;
```

- [ ] **Step 2: 创建 web/src/api/auth.ts**

```typescript
import client from './client';

export async function login(username: string, password: string): Promise<{ token: string; username: string }> {
  const { data } = await client.post('/auth/login', { username, password });
  return data;
}

export async function getApiStatus(): Promise<{ enabled: boolean; port: number }> {
  const { data } = await client.get('/auth/status');
  return data;
}
```

- [ ] **Step 3: 创建 web/src/api/profiles.ts**

```typescript
import client from './client';
import type { Profile } from '../types';

export async function listProfiles(): Promise<Profile[]> {
  const { data } = await client.get('/profiles');
  return data;
}

export async function createProfile(profile: Profile): Promise<Profile> {
  const { data } = await client.post('/profiles', profile);
  return data;
}

export async function updateProfile(id: string, profile: Profile): Promise<Profile> {
  const { data } = await client.put(`/profiles/${id}`, profile);
  return data;
}

export async function deleteProfile(id: string): Promise<void> {
  await client.delete(`/profiles/${id}`);
}
```

- [ ] **Step 4: 创建 web/src/api/terminals.ts**

```typescript
import client from './client';
import type { TerminalInfo } from '../types';

export async function listTerminals(): Promise<TerminalInfo[]> {
  const { data } = await client.get('/terminals');
  return data;
}

export async function startTerminal(profileId: string): Promise<TerminalInfo> {
  const { data } = await client.post('/terminals', { profile_id: profileId });
  return data;
}

export async function closeTerminal(id: string): Promise<void> {
  await client.delete(`/terminals/${id}`);
}
```

- [ ] **Step 5: 创建 web/src/stores/appStore.ts**

```typescript
import { create } from 'zustand';
import type { Profile, WebTerminalSession } from '../types';

interface WebAppState {
  token: string | null;
  username: string | null;
  profiles: Profile[];
  sessions: WebTerminalSession[];
  activeSessionId: string | null;
  sidebarOpen: boolean;

  setAuth: (token: string, username: string) => void;
  logout: () => void;
  setProfiles: (profiles: Profile[]) => void;
  addProfile: (profile: Profile) => void;
  updateProfile: (profile: Profile) => void;
  removeProfile: (id: string) => void;
  addSession: (session: WebTerminalSession) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

export const useWebAppStore = create<WebAppState>((set) => ({
  token: null,
  username: null,
  profiles: [],
  sessions: [],
  activeSessionId: null,
  sidebarOpen: true,

  setAuth: (token, username) => set({ token, username }),
  logout: () => set({ token: null, username: null, sessions: [], activeSessionId: null }),

  setProfiles: (profiles) => set({ profiles }),
  addProfile: (profile) => set((s) => ({ profiles: [...s.profiles, profile] })),
  updateProfile: (profile) =>
    set((s) => ({ profiles: s.profiles.map((p) => (p.id === profile.id ? profile : p)) })),
  removeProfile: (id) => set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) })),

  addSession: (session) =>
    set((s) => ({ sessions: [...s.sessions, session], activeSessionId: session.id })),
  removeSession: (id) =>
    set((s) => {
      const sessions = s.sessions.filter((t) => t.id !== id);
      return {
        sessions,
        activeSessionId: s.activeSessionId === id ? sessions[0]?.id ?? null : s.activeSessionId,
      };
    }),
  setActiveSession: (id) => set({ activeSessionId: id }),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
}));
```

- [ ] **Step 6: 编译验证**

```bash
cd web && npx tsc --noEmit 2>&1
```

- [ ] **Step 7: 提交**

```bash
git add web/src/api/ web/src/stores/
git commit -m "feat: 实现Web端API客户端和状态管理"
```

---

### Task 7: Web 前端 — 登录页 + 主布局 + 侧边栏 + 连接管理

**Skills:** minimax-skills:frontend-dev — UI 组件实现、响应式布局

**Skill-Derived Code Examples:**

**`minimax-skills:frontend-dev` pattern** — React 组件结构、CSS module 替代方案（inline styles + CSS custom properties）：

```tsx
const LoginPage: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // ...
};
```

**Files:**
- Create: `web/src/components/LoginPage.tsx`
- Create: `web/src/components/MainLayout.tsx`
- Create: `web/src/components/Sidebar.tsx`
- Create: `web/src/components/ProfileList.tsx`
- Create: `web/src/components/ProfileDialog.tsx`

- [ ] **Step 1: 创建 LoginPage.tsx**

```tsx
import React, { useState } from 'react';
import { login } from '../api/auth';
import { getApiStatus } from '../api/auth';
import { useWebAppStore } from '../stores/appStore';

const LoginPage: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const setAuth = useWebAppStore((s) => s.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const status = await getApiStatus();
      if (!status.enabled) {
        setError('Web API 服务未启用');
        return;
      }
      const result = await login(username, password);
      setAuth(result.token, result.username);
    } catch (err: any) {
      setError(err.response?.data?.message || '登录失败，请检查用户名和密码');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: '#1e1e3a', border: '1px solid #3a3a5a', borderRadius: 12,
        padding: 40, width: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      }}>
        <h1 style={{ textAlign: 'center', marginBottom: 8, fontSize: 22, color: '#a0a0ff' }}>
          TerminalBuddy
        </h1>
        <p style={{ textAlign: 'center', color: '#7a7a9a', fontSize: 13, marginBottom: 32 }}>
          Web 远程终端管理
        </p>
        <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 6 }}>
          用户名
        </label>
        <input
          type="text" value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="请输入用户名"
          style={{ marginBottom: 20 }}
        />
        <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 6 }}>
          密码
        </label>
        <input
          type="password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入密码"
          style={{ marginBottom: 24 }}
        />
        <button type="submit" disabled={loading} style={{
          width: '100%', padding: 12, border: 'none', borderRadius: 8,
          background: 'linear-gradient(135deg, #5b5bb5, #4a4aaa)',
          color: '#fff', fontSize: 15, opacity: loading ? 0.7 : 1,
        }}>
          {loading ? '登录中...' : '登 录'}
        </button>
        {error && (
          <p style={{ color: '#ff6b6b', fontSize: 13, textAlign: 'center', marginTop: 12 }}>
            {error}
          </p>
        )}
      </form>
    </div>
  );
};

export default LoginPage;
```

- [ ] **Step 2: 创建 MainLayout.tsx — 响应式主布局**

```tsx
import React from 'react';
import Sidebar from './Sidebar';
import TabBar from './TabBar';
import TerminalView from './TerminalView';
import { useWebAppStore } from '../stores/appStore';

const MainLayout: React.FC = () => {
  const sidebarOpen = useWebAppStore((s) => s.sidebarOpen);
  const activeSessionId = useWebAppStore((s) => s.activeSessionId);
  const sessions = useWebAppStore((s) => s.sessions);
  const toggleSidebar = useWebAppStore((s) => s.toggleSidebar);
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <div style={{ height: '100vh', display: 'flex' }}>
      {/* Desktop sidebar */}
      <div style={{
        width: sidebarOpen ? 220 : 0,
        overflow: 'hidden',
        transition: 'width 0.2s',
        flexShrink: 0,
        display: window.innerWidth < 768 ? 'none' : 'block',
      }}>
        <Sidebar />
      </div>

      {/* Mobile drawer overlay */}
      {window.innerWidth < 768 && sidebarOpen && (
        <>
          <div onClick={toggleSidebar} style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200,
          }} />
          <div style={{
            position: 'fixed', left: 0, top: 0, bottom: 0, width: 260, zIndex: 300,
            background: '#16162e',
          }}>
            <Sidebar />
          </div>
        </>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Mobile header */}
        {window.innerWidth < 768 && (
          <div style={{
            display: 'flex', alignItems: 'center', background: '#16162e',
            borderBottom: '1px solid #2a2a4a', padding: '8px 12px', gap: 8,
          }}>
            <button onClick={toggleSidebar} style={{
              width: 36, height: 36, borderRadius: 6, border: '1px solid #3a3a5a',
              background: '#2a2a4a', color: '#a0a0d0', fontSize: 18,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              ☰
            </button>
            <span style={{ fontSize: 13, color: '#a0a0d0' }}>连接</span>
          </div>
        )}

        <TabBar />
        <div style={{ flex: 1, background: '#0c0c1e' }}>
          {activeSession ? (
            <TerminalView session={activeSession} />
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', color: '#6a6a8a', fontSize: 14,
            }}>
              选择一个连接开始使用终端
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MainLayout;
```

以上使用 `window.innerWidth` 判断需要改为响应式 hook。后续会改用 CSS media query + React state。

- [ ] **Step 3: 创建 Sidebar.tsx**

```tsx
import React from 'react';
import ProfileList from './ProfileList';
import { useWebAppStore } from '../stores/appStore';

const Sidebar: React.FC = () => {
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: '#16162e', borderRight: '1px solid #2a2a4a',
    }}>
      <div style={{
        padding: '16px', borderBottom: '1px solid #2a2a4a',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <h2 style={{ fontSize: 14, color: '#a0a0d0' }}>连接</h2>
      </div>
      <ProfileList />
    </div>
  );
};

export default Sidebar;
```

- [ ] **Step 4: 创建 ProfileList.tsx**

```tsx
import React, { useEffect, useState } from 'react';
import { listProfiles } from '../api/profiles';
import { useWebAppStore } from '../stores/appStore';
import ProfileDialog from './ProfileDialog';
import type { Profile } from '../types';

const ProfileList: React.FC = () => {
  const profiles = useWebAppStore((s) => s.profiles);
  const setProfiles = useWebAppStore((s) => s.setProfiles);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    try {
      const result = await listProfiles();
      setProfiles(result);
    } catch (err) {
      console.error('加载连接列表失败', err);
    }
  };

  const grouped = profiles.reduce<Record<string, Profile[]>>((acc, p) => {
    const g = p.group || '默认';
    if (!acc[g]) acc[g] = [];
    acc[g].push(p);
    return acc;
  }, {});

  const typeIcon: Record<string, { bg: string; color: string; label: string }> = {
    powershell: { bg: '#012456', color: '#01a4ef', label: 'PS' },
    cmd: { bg: '#2a2a2a', color: '#c0c0c0', label: '>' },
    ssh: { bg: '#1a3a1a', color: '#4caf50', label: 'SSH' },
    docker: { bg: '#1a2a3a', color: '#2496ed', label: 'DK' },
    k8s: { bg: '#1a1a3a', color: '#326ce5', label: 'K8' },
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group}>
          <div style={{
            fontSize: 11, color: '#6a6a8a', padding: '8px 8px 4px',
            textTransform: 'uppercase', letterSpacing: 1,
          }}>
            {group}
          </div>
          {items.map((profile) => {
            const icon = typeIcon[profile.terminalType] || typeIcon.powershell;
            return (
              <div
                key={profile.id}
                onClick={() => handleStartTerminal(profile)}
                onContextMenu={(e) => { e.preventDefault(); setEditingProfile(profile); setDialogOpen(true); }}
                style={{
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 10,
                  marginBottom: 2, transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#2a2a4a')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: 6, background: icon.bg,
                  color: icon.color, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 14, flexShrink: 0,
                }}>
                  {icon.label}
                </div>
                <div>
                  <div style={{ fontSize: 13, color: '#d0d0e0' }}>{profile.name}</div>
                  <div style={{ fontSize: 11, color: '#6a6a8a' }}>
                    {profile.terminalType === 'ssh' ? profile.sshHost :
                     profile.terminalType === 'docker' ? profile.dockerContainerName :
                     profile.terminalType === 'k8s' ? profile.k8sPodName : '本地'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <button
        onClick={() => { setEditingProfile(null); setDialogOpen(true); }}
        style={{
          width: '100%', padding: '10px', marginTop: 8, borderRadius: 8,
          border: '1px dashed #3a3a5a', background: 'transparent',
          color: '#8a8aaa', fontSize: 13,
        }}
      >
        + 新建连接
      </button>
      {dialogOpen && (
        <ProfileDialog
          profile={editingProfile}
          onClose={() => setDialogOpen(false)}
          onSaved={() => { setDialogOpen(false); loadProfiles(); }}
        />
      )}
    </div>
  );

  async function handleStartTerminal(profile: Profile) {
    try {
      const { startTerminal } = await import('../api/terminals');
      const info = await startTerminal(profile.id);
      useWebAppStore.getState().addSession({
        id: info.id,
        profileId: info.profile_id,
        profileName: info.profile_name,
        terminalType: info.terminal_type as any,
      });
    } catch (err) {
      console.error('启动终端失败', err);
    }
  }
};

export default ProfileList;
```

- [ ] **Step 5: 创建 ProfileDialog.tsx**

```tsx
import React, { useState, useEffect } from 'react';
import { createProfile, updateProfile } from '../api/profiles';
import type { Profile } from '../types';

interface Props {
  profile: Profile | null;
  onClose: () => void;
  onSaved: () => void;
}

const ProfileDialog: React.FC<Props> = ({ profile, onClose, onSaved }) => {
  const [name, setName] = useState(profile?.name || '');
  const [group, setGroup] = useState(profile?.group || '');
  const [terminalType, setTerminalType] = useState(profile?.terminalType || 'powershell');
  const [sshHost, setSshHost] = useState(profile?.sshHost || '');
  const [sshPort, setSshPort] = useState(profile?.sshPort?.toString() || '22');
  const [sshUser, setSshUser] = useState(profile?.sshUser || '');
  const [dockerName, setDockerName] = useState(profile?.dockerContainerName || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const data: Profile = {
        id: profile?.id || crypto.randomUUID(),
        name, group, terminalType: terminalType as any,
        startupPath: '', startupCommands: [],
        environmentVariables: {},
        colorTheme: 'dark-default', tabColor: null,
        windowSize: null,
        sshHost: terminalType === 'ssh' ? sshHost : undefined,
        sshPort: terminalType === 'ssh' ? parseInt(sshPort) || 22 : undefined,
        sshUser: terminalType === 'ssh' ? sshUser : undefined,
        dockerContainerName: terminalType === 'docker' ? dockerName : undefined,
        createdAt: profile?.createdAt || new Date().toISOString(),
        lastUsedAt: profile?.lastUsedAt || null,
      };
      if (profile) {
        await updateProfile(profile.id, data);
      } else {
        await createProfile(data);
      }
      onSaved();
    } catch (err) {
      console.error('保存连接失败', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#1e1e3a', border: '1px solid #3a3a5a', borderRadius: 12,
        padding: 24, width: 420, maxWidth: '90vw',
      }}>
        <h3 style={{ fontSize: 16, color: '#a0a0d0', marginBottom: 20 }}>
          {profile ? '编辑连接' : '新建连接'}
        </h3>

        <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>
          名称
        </label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：生产服务器" />

        <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>
          分组
        </label>
        <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="例如：远程服务器" />

        <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>
          类型
        </label>
        <select value={terminalType} onChange={(e) => setTerminalType(e.target.value)} style={{
          width: '100%', padding: '8px 12px', border: '1px solid #3a3a5a', borderRadius: 6,
          background: '#12122a', color: '#e0e0e0', fontSize: 13, outline: 'none', cursor: 'pointer',
        }}>
          <option value="powershell">PowerShell</option>
          <option value="cmd">CMD</option>
          <option value="ssh">SSH</option>
          <option value="docker">Docker</option>
          <option value="k8s">Kubernetes</option>
        </select>

        {terminalType === 'ssh' && (
          <>
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>
              主机地址
            </label>
            <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>
              端口
            </label>
            <input value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>
              用户名
            </label>
            <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
          </>
        )}

        {terminalType === 'docker' && (
          <>
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>
              容器名称
            </label>
            <input value={dockerName} onChange={(e) => setDockerName(e.target.value)} placeholder="例如：mysql-container" />
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={{
            padding: '8px 20px', border: '1px solid #3a3a5a', borderRadius: 6,
            background: 'transparent', color: '#8a8aaa',
          }}>
            取消
          </button>
          <button onClick={handleSave} disabled={saving || !name} style={{
            padding: '8px 20px', border: 'none', borderRadius: 6,
            background: '#5b5bb5', color: '#fff',
            opacity: saving || !name ? 0.6 : 1,
          }}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProfileDialog;
```

- [ ] **Step 6: 编译验证**

```bash
cd web && npx tsc --noEmit 2>&1
```

- [ ] **Step 7: 提交**

```bash
git add web/src/components/LoginPage.tsx web/src/components/MainLayout.tsx web/src/components/Sidebar.tsx web/src/components/ProfileList.tsx web/src/components/ProfileDialog.tsx
git commit -m "feat: 实现Web端登录页、主布局、侧边栏和连接管理"
```

---

### Task 8: Web 前端 — 标签栏 + 终端视图 + WebSocket Hook

**Skills:** minimax-skills:fullstack-dev — WebSocket 连接管理、xterm.js 集成

**Skill-Derived Code Examples:**

**`minimax-skills:fullstack-dev` pattern** — WebSocket 重连机制：

```typescript
function useTerminal(terminalId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);

  const connect = useCallback(() => {
    const token = useWebAppStore.getState().token;
    const ws = new WebSocket(`ws://${location.host}/ws/terminal/${terminalId}?token=${token}`);
    ws.onmessage = (e) => { /* handle message */ };
    ws.onclose = () => {
      if (retryCountRef.current < 5) {
        retryCountRef.current++;
        setTimeout(connect, Math.pow(2, retryCountRef.current) * 1000);
      }
    };
    wsRef.current = ws;
  }, [terminalId]);
  // ...
}
```

**Files:**
- Create: `web/src/components/TabBar.tsx`
- Create: `web/src/components/TerminalView.tsx`
- Create: `web/src/hooks/useTerminal.ts`

- [ ] **Step 1: 创建 TabBar.tsx**

```tsx
import React from 'react';
import { useWebAppStore } from '../stores/appStore';
import { closeTerminal } from '../api/terminals';

const TabBar: React.FC = () => {
  const sessions = useWebAppStore((s) => s.sessions);
  const activeSessionId = useWebAppStore((s) => s.activeSessionId);
  const setActiveSession = useWebAppStore((s) => s.setActiveSession);
  const removeSession = useWebAppStore((s) => s.removeSession);

  const handleClose = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try { await closeTerminal(id); } catch {}
    removeSession(id);
  };

  return (
    <div style={{
      display: 'flex', background: '#16162e', borderBottom: '1px solid #2a2a4a',
      padding: '0 8px', height: 40, gap: 2, overflowX: 'auto',
    }}>
      {sessions.map((session) => (
        <div
          key={session.id}
          onClick={() => setActiveSession(session.id)}
          style={{
            padding: '6px 16px', borderRadius: '6px 6px 0 0',
            fontSize: 13, color: session.id === activeSessionId ? '#e0e0ff' : '#8a8aaa',
            cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex',
            alignItems: 'center', gap: 8, transition: 'all 0.15s',
            background: session.id === activeSessionId ? '#1e1e3a' : 'transparent',
            borderBottom: session.id === activeSessionId ? '2px solid #6a6ad5' : 'none',
          }}
        >
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: '#4caf50', flexShrink: 0,
          }} />
          {session.profileName}
          <button
            onClick={(e) => handleClose(e, session.id)}
            style={{
              width: 16, height: 16, borderRadius: 4, border: 'none',
              background: 'transparent', color: '#6a6a8a', cursor: 'pointer',
              fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};

export default TabBar;
```

- [ ] **Step 2: 创建 hooks/useTerminal.ts**

```tsx
import { useEffect, useRef, useCallback } from 'react';
import { useWebAppStore } from '../stores/appStore';

interface TerminalCallbacks {
  onOutput: (data: string) => void;
  onExited: (code: number) => void;
}

export function useTerminal(terminalId: string | null, callbacks: TerminalCallbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const connect = useCallback(() => {
    if (!terminalId) return;

    const token = useWebAppStore.getState().token;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/terminal/${terminalId}?token=${token}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          callbacksRef.current.onOutput(msg.data);
        } else if (msg.type === 'exited') {
          callbacksRef.current.onExited(msg.code);
        }
      } catch {}
    };

    ws.onclose = () => {
      if (retryCountRef.current < 5) {
        retryCountRef.current++;
        const delay = Math.min(Math.pow(2, retryCountRef.current) * 1000, 16000);
        setTimeout(connect, delay);
      }
    };

    ws.onopen = () => {
      retryCountRef.current = 0;
    };
  }, [terminalId]);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      retryCountRef.current = 99; // Prevent reconnect on unmount
      wsRef.current?.close();
    };
  }, [connect]);

  return { sendInput, sendResize };
}
```

- [ ] **Step 3: 创建 TerminalView.tsx**

```tsx
import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminal } from '../hooks/useTerminal';
import type { WebTerminalSession } from '../types';

interface Props {
  session: WebTerminalSession;
}

const TerminalView: React.FC<Props> = ({ session }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const { sendInput, sendResize } = useTerminal(session.id, {
    onOutput: (data) => {
      termRef.current?.write(data);
    },
    onExited: (code) => {
      termRef.current?.writeln(`\r\n\n[进程已退出，退出码: ${code}]`);
    },
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Cascadia Code, Consolas, 'Courier New', monospace",
      theme: {
        background: '#0c0c1e',
        foreground: '#e0e0e0',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    term.onData((data) => {
      sendInput(data);
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const handleResize = () => {
      fitAddon.fit();
      const dims = term;
      sendResize(dims.cols, dims.rows);
    };

    window.addEventListener('resize', handleResize);

    // Initial resize
    setTimeout(() => {
      fitAddon.fit();
      sendResize(term.cols, term.rows);
    }, 100);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      termRef.current = null;
    };
  }, [session.id]);

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', padding: '8px' }}
    />
  );
};

export default TerminalView;
```

- [ ] **Step 4: 编译验证**

```bash
cd web && npx tsc --noEmit 2>&1
```

- [ ] **Step 5: 提交**

```bash
git add web/src/components/TabBar.tsx web/src/components/TerminalView.tsx web/src/hooks/
git commit -m "feat: 实现Web端标签栏、终端视图和WebSocket通信"
```

---

### Task 9: 桌面端设置界面扩展

**Skills:** minimax-skills:frontend-dev — React 表单组件、Tauri invoke 调用

**Files:**
- Modify: `src/utils/settings.ts`（扩展 AppSettings 类型）
- Modify: `src/services/tauri.ts`（添加新 invoke 函数）
- Modify: `src/components/SettingsPage.tsx`（添加 Web 管理设置分区）

- [ ] **Step 1: 扩展 src/utils/settings.ts**

在 `AppSettings` 接口中添加字段：

```typescript
export interface AppSettings {
  // ... 现有字段保持不变
  // 新增:
  webApiEnabled: boolean;
  webApiPort: number;
  webApiUsername: string;
}
```

在 `DEFAULT_SETTINGS` 中添加默认值：

```typescript
  webApiEnabled: false,
  webApiPort: 9600,
  webApiUsername: 'admin',
```

- [ ] **Step 2: 在 src/services/tauri.ts 中添加新的 invoke 函数**

```typescript
export async function saveWebApiSettings(
  enabled: boolean,
  port: number,
  username: string,
  password: string
): Promise<void> {
  return invoke('save_web_api_settings', { enabled, port, username, password });
}

export async function getWebApiStatus(): Promise<{
  enabled: boolean;
  port: number;
  username: string;
  hasPassword: boolean;
}> {
  return invoke('get_web_api_status');
}

export async function restartWebServer(): Promise<string> {
  return invoke('restart_web_server');
}

export async function getWebServerAddress(): Promise<string> {
  return invoke('get_web_server_address');
}
```

- [ ] **Step 3: 在 SettingsPage.tsx 中添加 "Web管理" 设置分区**

在 `SECTIONS` 数组中追加：

```typescript
  { id: 'web', label: 'Web管理' },
```

在 JSX 中添加 "web" 分区对应的 UI（放在 AI用量 分区之后）：

```tsx
{currentSection === 'web' && (
  <>
    <div className="settings-section-title">
      <Icon icon="mdi:web" />
      <span>Web 远程管理</span>
    </div>
    <div className="settings-section-desc">
      启用后可<a href="#" onClick={(e) => { e.preventDefault(); /* 打开浏览器 */ }}>通过浏览器</a>访问终端
    </div>

    <div className="settings-row">
      <div className="settings-label">启用 Web API</div>
      <div className="settings-control">
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.webApiEnabled}
            onChange={(e) => setSettings({ ...settings, webApiEnabled: e.target.checked })}
          />
          <span className="slider"></span>
        </label>
      </div>
    </div>

    {settings.webApiEnabled && (
      <>
        <div className="settings-row">
          <div className="settings-label">端口</div>
          <div className="settings-control">
            <input
              type="number"
              value={settings.webApiPort}
              min={1024}
              max={65535}
              onChange={(e) => setSettings({ ...settings, webApiPort: parseInt(e.target.value) || 9600 })}
              className="settings-input"
            />
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-label">用户名</div>
          <div className="settings-control">
            <input
              type="text"
              value={settings.webApiUsername}
              onChange={(e) => setSettings({ ...settings, webApiUsername: e.target.value })}
              className="settings-input"
            />
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-label">密码</div>
          <div className="settings-control">
            <input
              type="password"
              value={localPassword}
              onChange={(e) => setLocalPassword(e.target.value)}
              placeholder="留空则不修改"
              className="settings-input"
            />
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-label">服务状态</div>
          <div className="settings-control">
            <span style={{ color: '#4caf50' }}>● 运行中 — {serverAddress}</span>
          </div>
        </div>
      </>
    )}
  </>
)}
```

需要添加 `localPassword` 状态和 `serverAddress` 状态，以及保存逻辑。

- [ ] **Step 4: 在 SettingsPage 中添加保存处理**

在确认保存的 `handleConfirm` 中，当 Web API 设置变更时调用：

```typescript
if (webSettingsChanged) {
  await saveWebApiSettings(
    settings.webApiEnabled,
    settings.webApiPort,
    settings.webApiUsername,
    localPassword
  );
  const result = await restartWebServer();
  setServerAddress(await getWebServerAddress());
}
```

- [ ] **Step 5: 编译验证**

```bash
cd terminal-buddy && npx tsc --noEmit 2>&1
```

- [ ] **Step 6: 提交**

```bash
git add src/utils/settings.ts src/services/tauri.ts src/components/SettingsPage.tsx
git commit -m "feat: 桌面端设置页添加Web管理分区"
```

---

### Task 10: 构建集成与端到端衔接

**Skills:** _none_ — 构建配置和集成

**Files:**
- Modify: `src-tauri/src/web/server.rs`（静态文件嵌入）
- Modify: `src-tauri/Cargo.toml`（build.rs 配置）
- Create/Modify: Build scripts

- [ ] **Step 1: 完善静态文件服务**

在 `web/server.rs` 中实现静态文件服务：

```rust
use include_dir::{include_dir, Dir};
use axum::response::Response;
use axum::body::Body;
use axum::http::{StatusCode, header};

#[cfg(not(debug_assertions))]
static WEB_DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../web/dist");

#[cfg(debug_assertions)]
fn serve_static(path: &str) -> Option<Response> {
    None // 开发模式下不使用内嵌静态文件
}

#[cfg(not(debug_assertions))]
fn serve_static(path: &str) -> Option<Response> {
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = WEB_DIST.get_file(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return Some(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(Body::from(file.contents().to_vec()))
            .unwrap());
    }

    // SPA fallback: return index.html for non-file routes
    if let Some(file) = WEB_DIST.get_file("index.html") {
        return Some(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(file.contents().to_vec()))
            .unwrap());
    }

    None
}
```

- [ ] **Step 2: 添加 mime_guess 依赖**

在 `Cargo.toml` 中添加：

```toml
mime_guess = "2"
```

- [ ] **Step 3: 更新 build_router 集成静态文件服务**

在 `build_router` 中添加 fallback：

```rust
let spa_fallback = axum::routing::get(|req: axum::http::Request<Body>| async move {
    serve_static(req.uri().path())
        .unwrap_or_else(|| {
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("Not Found"))
                .unwrap()
        })
});

// 在最终 Router 中
api_routes
    .merge(ws_routes)
    .fallback_service(spa_fallback)
```

- [ ] **Step 4: 全长编译验证**

```bash
cd web && npm run build
cd ../src-tauri && cargo check 2>&1
```

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/web/server.rs src-tauri/Cargo.toml
git commit -m "feat: 集成静态文件服务和SPA回退路由"
```

---

### Task 11: 端到端集成测试与修复

**Skills:** _none_ — 测试和修复

- [ ] **Step 1: 确保 web/dist 目录存在**

```bash
cd terminal-buddy/web && npm run build
```

确保 `web/dist/index.html` 存在。

- [ ] **Step 2: Rust 完整编译**

```bash
cd terminal-buddy/src-tauri && cargo build 2>&1
```

修复所有编译错误。

- [ ] **Step 3: 验证依赖完整性**

确认所有新增 crate 版本兼容：
- `axum 0.8` 与 `tokio 1` 兼容
- `tower-http 0.6` 与 `axum 0.8` 兼容
- `jsonwebtoken 9` 与当前 Rust edition 兼容

- [ ] **Step 4: 解决编译错误并提交**

```bash
git add -A
git commit -m "fix: 端到端编译修复"
```

---

## 实施顺序

```
Task 1: 后端依赖与设置模型扩展
  ↓
Task 2: Web API 服务器核心（路由+JWT+错误处理）
  ↓
Task 3: 处理器（Profile CRUD+终端+WebSocket）
  ↓
Task 4: 服务器生命周期集成
  ↓
Task 5: Web 前端项目搭建
  ↓
Task 6: API 客户端 + 状态管理
  ↓
Task 7: 登录页+主布局+侧边栏+连接管理
  ↓
Task 8: 标签栏+终端视图+WebSocket
  ↓
Task 9: 桌面端设置界面扩展
  ↓
Task 10: 构建集成
  ↓
Task 11: 端到端集成测试与修复
```

## 注意事项

1. **开发模式**：前端开发时运行 `cd web && npm run dev`（Vite dev server 在 5173 端口），Rust 端运行 `cargo tauri dev`。Vite proxy 将 `/api` 和 `/ws` 请求代理到 Rust 后端（9600 端口）。

2. **静态文件嵌入**：`include_dir!` 宏在编译时读取 `web/dist/` 嵌入二进制。开发模式下（`debug_assertions`）使用 `ServeDir` 指向磁盘文件以支持热更新，仅生产构建使用嵌入文件。

3. **WebSocket 鉴权**：token 通过 URL 查询参数传递，因为浏览器 WebSocket API 不支持自定义 header。

4. **TerminalService 共享**：Web 端和桌面端共享同一 `TerminalService` 实例（通过 Tauri 的 `State` 机制）。需要确保 `TerminalInstance` 的 `profile_id` 字段被持久化以便 Web API 查询。

5. **OutputBroadcaster**：PTY reader thread 同时推送到 Tauri 事件（桌面端）和 WebSocket（通过 `WebServiceState::broadcast`）。`WebServiceState` 使用 `tokio::sync::mpsc::unbounded_channel` 进行订阅分发。

6. **不实现的功能**（按设计文档范围排除）：文件导航、命令补全、命令历史、主题切换、工作区管理、多用户、SSL/TLS。
