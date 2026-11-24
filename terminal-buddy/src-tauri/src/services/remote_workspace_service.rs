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
    /// 当前选中的连接（可能尚未进入远程工作区）。
    pub connection: Option<RemoteConnectionInfo>,
    /// 已保存的全部远程连接，供「工作区切换」列表展示。
    pub connections: Vec<RemoteConnectionInfo>,
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

impl From<RemoteConnectionInfo> for RemoteConnectionInfoStored {
    fn from(value: RemoteConnectionInfo) -> Self {
        Self {
            id: value.id,
            name: value.name,
            server: value.server,
            username: value.username,
            platform: value.platform,
            is_docker: value.is_docker,
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkspace {
    #[serde(default)]
    active: bool,
    /// 当前选中的连接 id（不一定已处于远程工作区）。
    #[serde(default)]
    current_id: Option<String>,
    #[serde(default)]
    connections: Vec<StoredConnection>,
    /// 旧版单连接配置，仅用于读取后迁移进 `connections`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    connection: Option<StoredConnection>,
}

impl StoredWorkspace {
    /// 兼容旧版单连接文件，并修正指向已删除连接的 `currentId`。
    fn normalize(mut self) -> Self {
        if let Some(legacy) = self.connection.take() {
            let legacy_id = legacy.info.id.clone();
            if !self.connections.iter().any(|item| item.info.id == legacy_id) {
                self.connections.push(legacy);
            }
            if self.current_id.is_none() {
                self.current_id = Some(legacy_id);
            }
        }
        if self.current_id.as_ref().is_some_and(|id| !self.connections.iter().any(|item| &item.info.id == id)) {
            self.current_id = None;
        }
        if self.current_id.is_none() {
            self.current_id = self.connections.first().map(|item| item.info.id.clone());
        }
        self
    }
}

#[derive(Clone)]
struct ActiveConnection {
    info: RemoteConnectionInfo,
    token: String,
}

#[derive(Clone, Default)]
struct WorkspaceStore {
    current_id: Option<String>,
    connections: Vec<ActiveConnection>,
}

impl WorkspaceStore {
    fn current(&self) -> Option<ActiveConnection> {
        let id = self.current_id.as_ref()?;
        self.connections.iter().find(|item| &item.info.id == id).cloned()
    }
}

#[derive(Clone)]
pub struct RemoteWorkspaceService {
    inner: Arc<Inner>,
}

struct Inner {
    client: reqwest::Client,
    store: RwLock<WorkspaceStore>,
    active: std::sync::atomic::AtomicBool,
    proxy_addr: OnceLock<SocketAddr>,
}

impl RemoteWorkspaceService {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let stored = Self::load().normalize();
        let active = stored.active;
        let store = Self::restore(stored);
        Self {
            inner: Arc::new(Inner {
                client,
                store: RwLock::new(store),
                active: std::sync::atomic::AtomicBool::new(active),
                proxy_addr: OnceLock::new(),
            }),
        }
    }

    /// 解密全部已保存连接的登录令牌；无法解密的条目会被跳过并记录日志。
    fn restore(stored: StoredWorkspace) -> WorkspaceStore {
        let mut store = WorkspaceStore { current_id: stored.current_id, connections: Vec::new() };
        for item in stored.connections {
            // 空令牌表示用户主动「删除登录」，保留条目让其在列表中重新登录。
            if item.encrypted_token.is_empty() {
                store.connections.push(ActiveConnection { info: item.into(), token: String::new() });
                continue;
            }
            match crate::services::crypto_service::decrypt_secret_field(&item.encrypted_token) {
                Ok(token) => store.connections.push(ActiveConnection { info: item.into(), token }),
                Err(error) => eprintln!("读取远程工作区登录凭据失败：{}", error),
            }
        }
        if store.current_id.as_ref().is_some_and(|id| !store.connections.iter().any(|item| &item.info.id == id)) {
            store.current_id = store.connections.first().map(|item| item.info.id.clone());
        }
        store
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
        let (current_id, connections) = {
            let store = self.inner.store.read().map_err(|_| "远程连接状态不可用".to_string())?;
            (store.current_id.clone(), store.connections.clone())
        };
        let mut stored_connections = Vec::with_capacity(connections.len());
        for active in connections {
            // 令牌为空表示该连接的凭据已经失效，保留条目让用户重新登录，而不是直接丢弃。
            let encrypted_token = if active.token.is_empty() {
                String::new()
            } else {
                crate::services::crypto_service::encrypt_secret_field(&active.token)
                    .map_err(|error| format!("无法加密保存远程登录凭据：{}", error))?
            };
            stored_connections.push(StoredConnection {
                info: RemoteConnectionInfoStored::from(active.info),
                encrypted_token,
            });
        }
        let stored = StoredWorkspace {
            active: self.inner.active.load(std::sync::atomic::Ordering::Acquire),
            current_id,
            connections: stored_connections,
            connection: None,
        };
        let bytes = serde_json::to_vec_pretty(&stored).map_err(|error| error.to_string())?;
        crate::services::atomic_file::atomic_write(&Self::storage_path()?, &bytes)
            .map_err(|error| format!("保存远程工作区配置失败：{}", error))
    }

    fn snapshot(&self) -> Option<ActiveConnection> {
        self.inner.store.read().ok()?.current()
    }

    fn connection_infos(&self) -> Vec<RemoteConnectionInfo> {
        self.inner.store.read()
            .map(|store| store.connections.iter().map(|item| item.info.clone()).collect())
            .unwrap_or_default()
    }

    pub fn state(&self) -> RemoteWorkspaceState {
        let connection = self.snapshot();
        RemoteWorkspaceState {
            active: self.inner.active.load(std::sync::atomic::Ordering::Acquire),
            connection: connection.map(|item| item.info),
            connections: self.connection_infos(),
        }
    }

    pub fn proxy_origin(&self) -> Result<String, String> {
        self.inner.proxy_addr.get()
            .map(|address| format!("http://{}", address))
            .ok_or_else(|| "远程连接代理尚未启动".into())
    }

    pub async fn start_proxy(&self) -> Result<(), String> {
        if self.inner.proxy_addr.get().is_some() {
            return Ok(());
        }
        // 必须直接在当前异步命令上下文创建 Tokio 监听器；同步命令线程没有 reactor，
        // 调用 TcpListener::from_std 会 panic，并将 release 版进程直接中止。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("启动远程连接代理失败：{}", error))?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
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
        if self.inner.proxy_addr.set(address).is_err() {
            return Ok(());
        }
        crate::runtime::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                eprintln!("远程连接代理已停止：{}", error);
            }
        });
        Ok(())
    }

    /// 添加（或按服务地址更新）一个远程连接，并设为当前连接。
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
        {
            let mut store = self.inner.store.write().map_err(|_| "远程连接状态不可用".to_string())?;
            // 同一服务地址视为同一个连接：更新其凭据与名称，避免列表里堆出重复项。
            let existing = store.connections.iter().position(|item| item.info.server == server);
            let id = existing
                .map(|index| store.connections[index].info.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let info = RemoteConnectionInfo {
                id: id.clone(),
                name,
                server,
                username: username.to_string(),
                platform: runtime.0,
                is_docker: runtime.1,
            };
            let connection = ActiveConnection { info, token };
            match existing {
                Some(index) => store.connections[index] = connection,
                None => store.connections.push(connection),
            }
            store.current_id = Some(id);
        }
        self.inner.active.store(true, std::sync::atomic::Ordering::Release);
        self.save()?;
        Ok(self.state())
    }

    /// 重新登录当前选中的连接。
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
        {
            let mut store = self.inner.store.write().map_err(|_| "远程连接状态不可用".to_string())?;
            let Some(index) = store.connections.iter().position(|item| item.info.id == current.info.id) else {
                return Err("远程连接已被删除，请重新添加".into());
            };
            let info = RemoteConnectionInfo {
                username,
                platform: runtime.0,
                is_docker: runtime.1,
                ..current.info
            };
            store.connections[index] = ActiveConnection { info, token };
        }
        self.inner.active.store(true, std::sync::atomic::Ordering::Release);
        self.save()?;
        Ok(self.state())
    }

    /// 进入远程工作区前确认令牌仍然有效；失效时保留连接信息并返回可识别错误，
    /// 前端据此打开重新登录，而不是进入后满屏 401。
    ///
    /// `id` 为空表示进入当前选中的连接；传入其它连接 id 时先切换再校验，
    /// 校验失败会回滚选择与 `active`，保证不会因为一次失败的切换丢掉正在用的远程工作区。
    pub async fn activate(&self, id: Option<String>) -> Result<RemoteWorkspaceState, String> {
        let (previous_id, previous_active) = {
            let store = self.inner.store.read().map_err(|_| "远程连接状态不可用".to_string())?;
            (store.current_id.clone(), self.inner.active.load(std::sync::atomic::Ordering::Acquire))
        };
        let current = match id.as_deref() {
            Some(id) => {
                let store = self.inner.store.read().map_err(|_| "远程连接状态不可用".to_string())?;
                store.connections.iter().find(|item| item.info.id == id).cloned()
                    .ok_or_else(|| "远程连接不存在，请重新添加".to_string())?
            }
            None => self.require_connection()?,
        };
        // 用户主动删除了登录凭据：直接引导重新登录，不发无令牌请求。
        if current.token.is_empty() {
            return Err("REMOTE_TOKEN_EXPIRED".into());
        }
        let checked = self.check_runtime(&current).await;
        let (platform, is_docker) = match checked {
            Ok(runtime) => runtime,
            Err(error) => {
                self.restore_selection(previous_id, previous_active);
                return Err(error);
            }
        };
        {
            let mut store = self.inner.store.write().map_err(|_| "远程连接状态不可用".to_string())?;
            let Some(index) = store.connections.iter().position(|item| item.info.id == current.info.id) else {
                drop(store);
                self.restore_selection(previous_id, previous_active);
                return Err("远程连接已被删除，请重新添加".into());
            };
            let mut info = current.info;
            info.platform = platform;
            info.is_docker = is_docker;
            store.connections[index] = ActiveConnection { info, token: current.token };
            store.current_id = Some(store.connections[index].info.id.clone());
        }
        self.inner.active.store(true, std::sync::atomic::Ordering::Release);
        self.save()?;
        Ok(self.state())
    }

    /// 校验远程服务可用且版本兼容，返回（平台, 是否 Docker）。
    async fn check_runtime(&self, connection: &ActiveConnection) -> Result<(String, bool), String> {
        let response = self.inner.client
            .get(endpoint(&connection.info.server, "/api/runtime", None)?)
            .bearer_auth(&connection.token)
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
        Ok((
            runtime.get("platform").and_then(|value| value.as_str()).unwrap_or("linux").to_string(),
            runtime.get("isDocker").and_then(|value| value.as_bool()).unwrap_or(false),
        ))
    }

    /// 激活失败时回滚内存中的当前连接与远程状态（不落盘，磁盘上本来就没改）。
    fn restore_selection(&self, current_id: Option<String>, active: bool) {
        if let Ok(mut store) = self.inner.store.write() {
            store.current_id = current_id;
        }
        self.inner.active.store(active, std::sync::atomic::Ordering::Release);
    }

    /// 仅切回本机。进入远程必须走 [`Self::activate`]，以便先校验令牌。
    pub fn set_active(&self, active: bool) -> Result<(), String> {
        if active {
            return Err("请使用进入远程工作区操作".into());
        }
        self.inner.active.store(false, std::sync::atomic::Ordering::Release);
        self.save()
    }

    /// 只删除登录凭据，保留连接条目，方便用户稍后重新登录。
    pub fn disconnect(&self) -> Result<(), String> {
        let current_id = self.snapshot().map(|item| item.info.id);
        if let Some(id) = current_id {
            let mut store = self.inner.store.write().map_err(|_| "远程连接状态不可用".to_string())?;
            if let Some(item) = store.connections.iter_mut().find(|item| item.info.id == id) {
                item.token.clear();
            }
        }
        self.inner.active.store(false, std::sync::atomic::Ordering::Release);
        self.save()
    }

    /// 删除一个已保存的远程连接。
    pub fn remove(&self, id: &str) -> Result<RemoteWorkspaceState, String> {
        let mut store = self.inner.store.write().map_err(|_| "远程连接状态不可用".to_string())?;
        let Some(index) = store.connections.iter().position(|item| item.info.id == id) else {
            return Err("远程连接不存在".into());
        };
        store.connections.remove(index);
        if store.current_id.as_deref() == Some(id) {
            store.current_id = store.connections.first().map(|item| item.info.id.clone());
            // 删掉正在使用的连接必须回到本机，避免代理继续指向已删除的服务。
            self.inner.active.store(false, std::sync::atomic::Ordering::Release);
        }
        drop(store);
        self.save()?;
        Ok(self.state())
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
            // HeaderName 不实现 Copy，查询用引用，转发时再移入 header()。
            if let Some(value) = parts.headers.get(&name) {
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
            if let Some(value) = headers.get(&name) {
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
        // 不能用 http::Request 手工构造握手请求：tungstenite 对 Request 原样透传，
        // 不会补 Sec-WebSocket-Key 等标准头，远端会以 1002 拒绝握手。
        let uri = url.parse::<axum::http::Uri>().map_err(|error| error.to_string())?;
        let mut builder = tokio_tungstenite::tungstenite::ClientRequestBuilder::new(uri);
        if let Some(agent) = headers.get(header::USER_AGENT) {
            let agent = agent.to_str().map_err(|error| error.to_string())?;
            builder = builder.with_header("User-Agent", agent);
        }
        let remote = tokio_tungstenite::connect_async(builder)
            .await.map_err(|error| format!("远程 WebSocket 连接失败：{}", error));
        let (remote, _) = match remote {
            Ok(remote) => remote,
            Err(error) => {
                let mut socket = socket;
                let _ = socket.send(Message::Text(
                    serde_json::json!({"type":"error","message":error}).to_string().into()
                )).await;
                let _ = socket.close().await;
                return Ok(());
            }
        };
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
    let origin_allowed = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| {
            matches!(
                origin,
                "tauri://localhost" | "http://tauri.localhost" | "http://127.0.0.1:1450"
            )
        });
    if !origin_allowed {
        return (StatusCode::FORBIDDEN, "禁止跨域 WebSocket 访问远程代理").into_response();
    }
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

    fn stored_connection(id: &str, server: &str) -> StoredConnection {
        StoredConnection {
            info: RemoteConnectionInfoStored {
                id: id.into(),
                name: server.into(),
                server: server.into(),
                username: "admin".into(),
                platform: "linux".into(),
                is_docker: false,
            },
            encrypted_token: format!("token-{}", id),
        }
    }

    /// 旧版单连接文件要能平滑迁移成列表，并把该连接设为当前连接。
    #[test]
    fn migrates_legacy_single_connection_into_list() {
        let legacy = StoredWorkspace { active: true, current_id: None, connections: Vec::new(), connection: Some(stored_connection("a", "https://a.example")) };
        let migrated = legacy.normalize();
        assert_eq!(migrated.connections.len(), 1);
        assert_eq!(migrated.current_id.as_deref(), Some("a"));
        assert!(migrated.connection.is_none());
        assert!(migrated.active);
    }

    /// currentId 指向不存在的连接时回落到第一个连接，避免列表为空指针。
    #[test]
    fn normalizes_current_id_to_existing_connection() {
        let workspace = StoredWorkspace {
            active: false,
            current_id: Some("gone".into()),
            connections: vec![stored_connection("a", "https://a.example"), stored_connection("b", "https://b.example")],
            connection: None,
        };
        let normalized = workspace.normalize();
        assert_eq!(normalized.current_id.as_deref(), Some("a"));
        assert_eq!(normalized.connections.len(), 2);
    }

    /// 空列表时 currentId 必须清空，不留悬空引用。
    #[test]
    fn clears_current_id_when_no_connections() {
        let workspace = StoredWorkspace { active: false, current_id: Some("gone".into()), connections: Vec::new(), connection: None };
        assert!(workspace.normalize().current_id.is_none());
    }
}
