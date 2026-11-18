//! Windows 桌面端的远程 TerminalBuddy 工作区。
//!
//! 远程业务流量经过仅绑定回环地址的临时代理，JWT 由本服务持有并用 DPAPI 加密落盘；
//! 前端仍以 Web 身份访问远程服务，窗口控制等本机能力不会经过该代理。

use axum::{
    body::{Body, Bytes},
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    http::{header, HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, OnceLock, RwLock},
    time::Duration,
};
use tokio_util::io::ReaderStream;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const MAX_PROXY_BODY_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionInfo {
    pub id: String,
    pub name: String,
    pub server: String,
    pub username: String,
    pub platform: String,
    pub is_docker: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceState {
    pub active: bool,
    pub connection: Option<RemoteConnectionInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRemoteWorkspaceInput {
    pub name: Option<String>,
    pub server: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLoginInput {
    pub username: Option<String>,
    pub password: String,
    pub setup: Option<bool>,
    pub confirm_password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConnection {
    #[serde(flatten)]
    info: RemoteConnectionInfoStored,
    encrypted_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConnectionInfoStored {
    id: String,
    name: String,
    server: String,
    username: String,
    platform: String,
    is_docker: bool,
}

impl From<StoredConnection> for RemoteConnectionInfo {
    fn from(value: StoredConnection) -> Self {
        Self {
            id: value.info.id,
            name: value.info.name,
            server: value.info.server,
            username: value.info.username,
            platform: value.info.platform,
            is_docker: value.info.is_docker,
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct StoredWorkspace {
    #[serde(default)]
    active: bool,
    connection: Option<StoredConnection>,
}

#[derive(Clone)]
struct ActiveConnection {
    info: RemoteConnectionInfo,
    token: String,
}

#[derive(Clone)]
pub struct RemoteWorkspaceService {
    inner: Arc<Inner>,
}

struct Inner {
    client: reqwest::Client,
    connection: RwLock<Option<ActiveConnection>>,
    active: std::sync::atomic::AtomicBool,
    proxy_addr: OnceLock<SocketAddr>,
}

impl RemoteWorkspaceService {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let stored = Self::load();
        let active = stored.active;
        let connection = stored.connection.and_then(|stored| {
            let token = crate::services::crypto_service::decrypt_secret_field(&stored.encrypted_token)
                .map_err(|error| eprintln!("读取远程工作区登录凭据失败：{}", error))
                .ok()?;
            Some(ActiveConnection { info: stored.into(), token })
        });
        Self {
            inner: Arc::new(Inner {
                client,
                connection: RwLock::new(connection),
                active: std::sync::atomic::AtomicBool::new(active),
                proxy_addr: OnceLock::new(),
            }),
        }
    }

    fn storage_path() -> Result<PathBuf, String> {
        Ok(crate::services::PathService::require_data_dir()?.join("remote_workspace.json"))
    }

    fn load() -> StoredWorkspace {
        let Some(path) = Self::storage_path().ok() else { return StoredWorkspace::default() };
        let Ok(bytes) = std::fs::read(path) else { return StoredWorkspace::default() };
        match serde_json::from_slice::<StoredWorkspace>(&bytes) {
            Ok(stored) => stored,
            Err(error) => {
                eprintln!("解析远程工作区配置失败：{}", error);
                StoredWorkspace::default()
            }
        }
    }

    fn save(&self) -> Result<(), String> {
        let connection = self.snapshot();
        let stored = StoredWorkspace {
            active: self.inner.active.load(std::sync::atomic::Ordering::Acquire),
            connection: connection.map(|active| {
                let encrypted_token = crate::services::crypto_service::encrypt_secret_field(&active.token)
                    .unwrap_or_default();
                StoredConnection {
                    info: RemoteConnectionInfoStored {
                        id: active.info.id,
                        name: active.info.name,
                        server: active.info.server,
                        username: active.info.username,
                        platform: active.info.platform,
                        is_docker: active.info.is_docker,
                    },
                    encrypted_token,
                }
            }),
        };
        if stored.connection.as_ref().is_some_and(|item| item.encrypted_token.is_empty()) {
            return Err("无法加密保存远程登录凭据，请重新连接".into());
        }
        let bytes = serde_json::to_vec_pretty(&stored).map_err(|error| error.to_string())?;
        crate::services::atomic_file::atomic_write(&Self::storage_path()?, &bytes)
    }

    fn snapshot(&self) -> Option<ActiveConnection> {
        self.inner.connection.read().ok()?.clone()
    }

    pub fn state(&self) -> RemoteWorkspaceState {
        let connection = self.snapshot();
        RemoteWorkspaceState {
            active: self.inner.active.load(std::sync::atomic::Ordering::Acquire),
            connection: connection.map(|item| item.info),
        }
    }

    pub fn proxy_origin(&self) -> Result<String, String> {
        self.inner.proxy_addr.get()
            .map(|address| format!("http://{}", address))
            .ok_or_else(|| "远程连接代理尚未启动".into())
    }

    pub fn start_proxy(&self) -> Result<(), String> {
        if self.inner.proxy_addr.get().is_some() {
            return Ok(());
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("启动远程连接代理失败：{}", error))?;
        listener.set_nonblocking(true).map_err(|error| error.to_string())?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let listener = tokio::net::TcpListener::from_std(listener).map_err(|error| error.to_string())?;
        let service = self.clone();
        // WebView2 页面与回环代理不同源，上传/长任务响应需要 CORS；回环地址不对外暴露。
        // 只接受本机 WebView 的来源：发布包为 tauri://localhost / http://tauri.localhost，
        // 开发模式是 Vite 的 http://127.0.0.1:1450。页面不携带 Cookie，令牌始终由代理注入。
        let origin = |value: &str| axum::http::HeaderValue::from_str(value).ok();
        let cors = tower_http::cors::CorsLayer::new()
            .allow_origin([
                origin("tauri://localhost"),
                origin("http://tauri.localhost"),
                origin("http://127.0.0.1:1450"),
            ].into_iter().flatten().collect::<Vec<_>>())
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any);
        let router = Router::new()
            .route("/__tb_remote/ws/{*path}", axum::routing::get(proxy_socket))
            .fallback(proxy_request)
            .layer(cors)
            .layer(axum::extract::DefaultBodyLimit::max(MAX_PROXY_BODY_BYTES))
            .with_state(service);
        self.inner.proxy_addr.set(address).map_err(|_| "远程连接代理已启动".to_string())?;
        crate::runtime::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                eprintln!("远程连接代理已停止：{}", error);
            }
        });
        Ok(())
    }

    pub async fn connect(&self, input: ConnectRemoteWorkspaceInput) -> Result<RemoteWorkspaceState, String> {
        let server = normalize_server(&input.server)?;
        let username = input.username.trim();
        if username.is_empty() {
            return Err("请输入服务账号".into());
        }
        let token = login(&self.inner.client, &server, username, &input.password, false, None).await?;
        let runtime = runtime_info(&self.inner.client, &server).await?;
        let name = input.name.as_deref().map(str::trim).filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| server.clone());
        let info = RemoteConnectionInfo {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            server,
            username: username.to_string(),
            platform: runtime.0,
            is_docker: runtime.1,
        };
        *self.inner.connection.write().map_err(|_| "远程连接状态不可用".to_string())? =
            Some(ActiveConnection { info, token });
        self.inner.active.store(true, std::sync::atomic::Ordering::Release);
        self.save()?;
        Ok(self.state())
    }

    pub async fn authenticate(&self, input: RemoteLoginInput) -> Result<RemoteWorkspaceState, String> {
        let current = self.snapshot().ok_or_else(|| "请先添加远程服务".to_string())?;
        let setup = input.setup.unwrap_or(false);
        let username = input.username.as_deref().map(str::trim).filter(|value| !value.is_empty())
            .unwrap_or(&current.info.username).to_string();
        let token = login(
            &self.inner.client,
            &current.info.server,
            &username,
            &input.password,
            setup,
            input.confirm_password.as_deref(),
        ).await?;
        let runtime = runtime_info(&self.inner.client, &current.info.server).await?;
        let info = RemoteConnectionInfo {
            username,
            platform: runtime.0,
            is_docker: runtime.1,
            ..current.info
        };
        *self.inner.connection.write().map_err(|_| "远程连接状态不可用".to_string())? =
            Some(ActiveConnection { info, token });
        self.inner.active.store(true, std::sync::atomic::Ordering::Release);
        self.save()?;
        Ok(self.state())
    }

    /// 进入远程工作区前确认令牌仍然有效；失效时保留连接信息并返回可识别错误，
    /// 前端据此打开重新登录，而不是进入后满屏 401。
    pub async fn activate(&self) -> Result<RemoteWorkspaceState, String> {
        let current = self.require_connection()?;
        let response = self.inner.client
            .get(endpoint(&current.info.server, "/api/runtime", None)?)
            .bearer_auth(&current.token)
            .timeout(CONNECT_TIMEOUT)
            .send().await.map_err(network_error)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("REMOTE_TOKEN_EXPIRED".into());
        }
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        let runtime: serde_json::Value = response.json().await.map_err(|_| "目标服务版本不兼容".to_string())?;
        if !runtime.get("fullInterface").and_then(|value| value.as_bool()).unwrap_or(false) {
            return Err("服务端版本不支持完整远程工作区，请先升级 TerminalBuddy 服务端".into());
        }
        let mut info = current.info;
        info.platform = runtime.get("platform").and_then(|value| value.as_str()).unwrap_or("linux").to_string();
        info.is_docker = runtime.get("isDocker").and_then(|value| value.as_bool()).unwrap_or(false);
        *self.inner.connection.write().map_err(|_| "远程连接状态不可用".to_string())? =
            Some(ActiveConnection { info, token: current.token });
        self.inner.active.store(true, std::sync::atomic::Ordering::Release);
        self.save()?;
        Ok(self.state())
    }

    /// 仅切回本机。进入远程必须走 [`Self::activate`]，以便先校验令牌。
    pub fn set_active(&self, active: bool) -> Result<(), String> {
        if active {
            return Err("请使用进入远程工作区操作".into());
        }
        self.inner.active.store(false, std::sync::atomic::Ordering::Release);
        self.save()
    }

    pub fn disconnect(&self) -> Result<(), String> {
        self.inner.active.store(false, std::sync::atomic::Ordering::Release);
        *self.inner.connection.write().map_err(|_| "远程连接状态不可用".to_string())? = None;
        self.save()
    }

    pub fn quick_access_url(&self) -> Result<String, String> {
        let connection = self.snapshot().ok_or_else(|| "当前未连接远程服务".to_string())?;
        if connection.token.is_empty() {
            return Err("远程登录已过期，请重新登录".into());
        }
        Ok(format!("{}/?token={}", connection.info.server.trim_end_matches('/'), urlencoding::encode(&connection.token)))
    }

    pub async fn download(&self, remote_path: String, destination: String) -> Result<(), String> {
        let connection = self.require_connection()?;
        let url = endpoint(&connection.info.server, "/api/desktop/download", Some(&[("path", remote_path.as_str()), ("token", connection.token.as_str())]))?;
        let response = self.inner.client.get(url).send().await.map_err(network_error)?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        let destination = PathBuf::from(destination);
        let parent = destination.parent().ok_or_else(|| "保存位置无效".to_string())?;
        let temporary = parent.join(format!(".terminal-buddy-download-{}", uuid::Uuid::new_v4()));
        let result = async {
            let mut file = tokio::fs::File::create(&temporary).await.map_err(|error| format!("创建下载文件失败：{}", error))?;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(network_error)?;
                tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await.map_err(|error| format!("写入下载文件失败：{}", error))?;
            }
            tokio::io::AsyncWriteExt::flush(&mut file).await.map_err(|error| error.to_string())?;
            drop(file);
            tokio::fs::rename(&temporary, &destination).await.map_err(|error| format!("保存下载文件失败：{}", error))?;
            Ok::<(), String>(())
        }.await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
        }
        result
    }

    pub async fn upload(&self, paths: Vec<String>) -> Result<Vec<String>, String> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.require_connection()?;
        let mut form = reqwest::multipart::Form::new();
        for path in paths {
            let path = PathBuf::from(&path);
            let metadata = tokio::fs::metadata(&path).await.map_err(|error| format!("读取本机文件失败：{}", error))?;
            if !metadata.is_file() {
                return Err(format!("只能上传文件，请先选择文件：{}", path.display()));
            }
            let length = metadata.len();
            let file = tokio::fs::File::open(&path).await.map_err(|error| format!("读取本机文件失败：{}", error))?;
            let name = path.file_name().and_then(|value| value.to_str()).ok_or_else(|| "文件名无效".to_string())?;
            let part = reqwest::multipart::Part::stream_with_length(
                reqwest::Body::wrap_stream(ReaderStream::new(file)), length,
            ).file_name(name.to_string());
            form = form.part("files", part);
        }
        let url = endpoint(&connection.info.server, "/api/desktop/upload", None)?;
        let response = self.inner.client.post(url).bearer_auth(&connection.token).multipart(form)
            .send().await.map_err(network_error)?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        let body: UploadResponse = response.json().await.map_err(|error| format!("解析上传结果失败：{}", error))?;
        Ok(body.paths)
    }

    fn require_connection(&self) -> Result<ActiveConnection, String> {
        self.snapshot().ok_or_else(|| "当前未连接远程服务".to_string())
    }

    async fn forward(&self, request: Request<Body>) -> Result<Response, String> {
        let connection = self.require_connection()?;
        let path = request.uri().path().strip_prefix("/__tb_remote").unwrap_or("");
        let base = endpoint(&connection.info.server, path, None)?;
        let url = match request.uri().query() {
            Some(query) => format!("{}?{}", base, query),
            None => base,
        };
        let (parts, body) = request.into_parts();
        let bytes = axum::body::to_bytes(body, MAX_PROXY_BODY_BYTES).await.map_err(|error| format!("读取请求失败：{}", error))?;
        let mut outgoing = self.inner.client.request(parts.method, url)
            .timeout(REQUEST_TIMEOUT)
            .body(bytes);
        for name in [header::ACCEPT, header::CONTENT_TYPE] {
            if let Some(value) = parts.headers.get(name) {
                outgoing = outgoing.header(name, value);
            }
        }
        if !connection.token.is_empty() {
            outgoing = outgoing.bearer_auth(&connection.token);
        }
        let response = outgoing.send().await.map_err(network_error)?;
        let status = response.status();
        let headers = response.headers().clone();
        let mut builder = Response::builder().status(status);
        for name in [header::CONTENT_TYPE, header::CONTENT_DISPOSITION, header::CACHE_CONTROL] {
            if let Some(value) = headers.get(name) {
                builder = builder.header(name, value);
            }
        }
        builder.body(Body::from_stream(response.bytes_stream())).map_err(|error| error.to_string())
    }

    async fn forward_socket(&self, socket: WebSocket, path: String, query: Option<String>, headers: HeaderMap) -> Result<(), String> {
        let connection = self.require_connection()?;
        // 前端只传终端协议参数（viewport/takeover/replay），token 由本服务统一注入。
        let query = query.unwrap_or_default();
        let query = query.split('&')
            .filter(|pair| !pair.is_empty() && !pair.starts_with("token="))
            .collect::<Vec<_>>().join("&");
        let url = endpoint(&connection.info.server, &path, Some(&[("token", connection.token.as_str())]))?;
        let url = if query.is_empty() { url } else { format!("{}&{}", url, query) };
        let url = if let Some(value) = url.strip_prefix("https://") {
            format!("wss://{}", value)
        } else if let Some(value) = url.strip_prefix("http://") {
            format!("ws://{}", value)
        } else {
            return Err("远程服务地址协议无效".into());
        };
        use axum::http::Request as HttpRequest;
        let mut builder = HttpRequest::builder().uri(url);
        if let Some(agent) = headers.get(header::USER_AGENT) {
            builder = builder.header(header::USER_AGENT, agent);
        }
        let (remote, _) = tokio_tungstenite::connect_async(builder.body(()).map_err(|error| error.to_string())?)
            .await.map_err(|error| format!("远程 WebSocket 连接失败：{}", error))?;
        let (mut local_sender, mut local_receiver) = socket.split();
        let (mut remote_sender, mut remote_receiver) = remote.split();
        loop {
            tokio::select! {
                message = local_receiver.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => remote_sender.send(tokio_tungstenite::tungstenite::Message::Text(text.to_string().into())).await.map_err(|error| error.to_string())?,
                        Some(Ok(Message::Binary(bytes))) => remote_sender.send(tokio_tungstenite::tungstenite::Message::Binary(bytes)).await.map_err(|error| error.to_string())?,
                        Some(Ok(Message::Ping(bytes))) => remote_sender.send(tokio_tungstenite::tungstenite::Message::Ping(bytes)).await.map_err(|error| error.to_string())?,
                        Some(Ok(Message::Pong(bytes))) => remote_sender.send(tokio_tungstenite::tungstenite::Message::Pong(bytes)).await.map_err(|error| error.to_string())?,
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    }
                }
                message = remote_receiver.next() => {
                    match message {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => local_sender.send(Message::Text(text.to_string().into())).await.map_err(|error| error.to_string())?,
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(bytes))) => local_sender.send(Message::Binary(Bytes::from(bytes))).await.map_err(|error| error.to_string())?,
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(bytes))) => local_sender.send(Message::Ping(Bytes::from(bytes))).await.map_err(|error| error.to_string())?,
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Pong(bytes))) => local_sender.send(Message::Pong(Bytes::from(bytes))).await.map_err(|error| error.to_string())?,
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None | Some(Err(_)) => break,
                        Some(Ok(_)) => {}
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct UploadResponse {
    paths: Vec<String>,
}

async fn proxy_request(State(service): State<RemoteWorkspaceService>, request: Request<Body>) -> Response {
    let path = request.uri().path().to_string();
    if path.starts_with("/__tb_remote/ws/") {
        return (StatusCode::UPGRADE_REQUIRED, "需要 WebSocket 升级").into_response();
    }
    match service.forward(request).await {
        Ok(response) => response,
        Err(error) => (StatusCode::BAD_GATEWAY, error).into_response(),
    }
}

/// WebSocket 升级必须在读取 HTTP body 前处理，因此与通用代理分开挂载。
async fn proxy_socket(
    State(service): State<RemoteWorkspaceService>,
    upgrade: WebSocketUpgrade,
    uri: axum::http::Uri,
    headers: HeaderMap,
) -> Response {
    let path = uri.path().strip_prefix("/__tb_remote").unwrap_or("").to_string();
    let query = uri.query().map(str::to_string);
    upgrade.on_upgrade(move |socket| async move {
        if let Err(error) = service.forward_socket(socket, path, query, headers).await {
            eprintln!("远程 WebSocket 代理结束：{}", error);
        }
    })
}

fn normalize_server(input: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(input.trim()).map_err(|_| "请输入完整服务地址，例如 https://192.168.1.10:9600".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("服务地址仅支持 HTTP 或 HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("服务地址不能包含账号、密码、查询参数或页面锚点".into());
    }
    let path = url.path().trim_end_matches('/').strip_suffix("/api")
        .map(str::to_string).unwrap_or_else(|| url.path().trim_end_matches('/').to_string());
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn endpoint(server: &str, path: &str, query: Option<&[(&str, &str)]>) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&format!("{}{}", server.trim_end_matches('/'), path)).map_err(|error| error.to_string())?;
    if let Some(query) = query {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    Ok(url.to_string())
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "连接远程服务超时，请检查地址、网络和服务状态".into()
    } else {
        format!("连接远程服务失败：{}", error)
    }
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    if let Ok(body) = serde_json::from_slice::<serde_json::Value>(&body) {
        if let Some(message) = body.get("message").and_then(|value| value.as_str()) {
            return message.to_string();
        }
    }
    format!("远程服务请求失败：{}", status)
}

async fn login(
    client: &reqwest::Client,
    server: &str,
    username: &str,
    password: &str,
    setup: bool,
    confirm_password: Option<&str>,
) -> Result<String, String> {
    if password.is_empty() {
        return Err("请输入密码".into());
    }
    let path = if setup { "/api/auth/setup" } else { "/api/auth/login" };
    let body = if setup {
        serde_json::json!({ "password": password, "confirmPassword": confirm_password.unwrap_or("") })
    } else {
        serde_json::json!({ "username": username, "password": password })
    };
    let response = client.post(endpoint(server, path, None)?).json(&body).timeout(CONNECT_TIMEOUT)
        .send().await.map_err(network_error)?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let body: serde_json::Value = response.json().await.map_err(|error| format!("登录响应无效：{}", error))?;
    body.get("token").and_then(|value| value.as_str()).map(str::to_string)
        .ok_or_else(|| "远程服务未返回登录令牌，请升级服务端".into())
}

async fn runtime_info(client: &reqwest::Client, server: &str) -> Result<(String, bool), String> {
    let response = client.get(endpoint(server, "/api/runtime", None)?).timeout(CONNECT_TIMEOUT)
        .send().await.map_err(network_error)?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let body: serde_json::Value = response.json().await.map_err(|_| "目标地址不是兼容的 TerminalBuddy 服务".to_string())?;
    if !body.get("fullInterface").and_then(|value| value.as_bool()).unwrap_or(false) {
        return Err("服务端版本不支持完整远程工作区，请先升级 TerminalBuddy 服务端".into());
    }
    Ok((
        body.get("platform").and_then(|value| value.as_str()).unwrap_or("linux").to_string(),
        body.get("isDocker").and_then(|value| value.as_bool()).unwrap_or(false),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_server_address_and_reverse_proxy_prefix() {
        assert_eq!(normalize_server("https://example.com/terminalbuddy/").unwrap(), "https://example.com/terminalbuddy");
        assert_eq!(normalize_server("http://127.0.0.1:9600/api/").unwrap(), "http://127.0.0.1:9600");
    }

    #[test]
    fn rejects_credentials_and_non_http_addresses() {
        assert!(normalize_server("https://user:pass@example.com").is_err());
        assert!(normalize_server("file:///tmp/server").is_err());
    }
}
