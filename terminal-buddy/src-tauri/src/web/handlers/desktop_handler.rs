//! 完整桌面界面的网页适配层；始终以 Web 身份访问终端。
use axum::{extract::{Multipart, Path, Query, State, ws::{WebSocketUpgrade, Message}}, response::{IntoResponse, Response}, Json};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use futures_util::SinkExt;
use std::{collections::{HashMap, HashSet}, path::PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use crate::{commands::{TerminalService, TerminalCloseReason}, models::{TerminalActor, TerminalAction, TerminalClientKind, TerminalCreator, TerminalOwner}, runtime::{Emitter, EventBus, Manager}, services::PathService, web::{auth::{ClaimsFromRequest, verify_token}, client_kind::client_kind_from_headers, error::ApiError, server::AppState}};

#[path = "desktop_dispatch.rs"]
mod desktop_dispatch;

pub(super) fn argument<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, ApiError> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| ApiError::BadRequest(format!("参数 {} 无效：{}", key, e)))
}
pub(super) fn data<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::Internal(e.to_string()))
}
pub(super) fn result<T: Serialize>(value: Result<T, String>) -> Result<Value, ApiError> {
    data(value.map_err(ApiError::BadRequest)?)
}

pub async fn runtime_info() -> Json<Value> {
    // agentCommands 供 Web 前端把 Agent 基础启动命令用于模型启动与历史恢复，免拉全量设置。
    let agent_commands = crate::services::SettingsService::get_settings().agent_commands;
    Json(json!({"platform": std::env::consts::OS, "mode": if cfg!(feature = "desktop") { "desktop" } else { "server" },
        "defaultTerminalType": crate::commands::terminal::default_terminal_type(), "fullInterface": true,
        "windowsBuildNumber": crate::services::platform_service::windows_build_number(),
        "isDocker": super::container_environment::is_docker_runtime(),
        "agentCommands": {"claude": agent_commands.claude, "codex": agent_commands.codex, "pi": agent_commands.pi}}))
}

fn scoped_file(path: &str) -> Result<(), ApiError> {
    let cache = PathService::require_data_dir().map_err(ApiError::Internal)?.join("ClientData");
    let file = super::canonical_scope_key(path)?;
    let root = super::canonical_scope_key(&cache.to_string_lossy())?;
    if file == root || file.starts_with(&format!("{}/", root)) {
        return Ok(());
    }
    super::ensure_project_scope(path).map(|_| ())
}

/// 终端访问失败按变体映射：不存在 404、无权限 403（§4.8）。
/// 之前一律 403，客户端无法用 404 修剪已关闭终端。
fn access_map_error(error: crate::models::TerminalAccessError) -> ApiError {
    match error {
        crate::models::TerminalAccessError::NotFound => ApiError::NotFound(error.to_string()),
        crate::models::TerminalAccessError::Denied { .. } => ApiError::Forbidden(error.to_string()),
    }
}

fn check_arguments(command: &str, args: &Value, app: &crate::runtime::AppHandle) -> Result<(), ApiError> {
    for id in [args.get("id"), args.get("profile").and_then(|v| v.get("id")), args.get("workspace").and_then(|v| v.get("id"))].into_iter().flatten().filter_map(Value::as_str) {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
            return Err(ApiError::BadRequest("配置或会话标识符无效".to_string()));
        }
    }
    if command == "rename_path" {
        let name: String = argument(args, "newName")?;
        if name.is_empty() || name.contains(['/', '\\']) || matches!(name.as_str(), "." | "..") {
            return Err(ApiError::BadRequest("新名称必须是单个文件或目录名称".to_string()));
        }
    }
    if let Some(id) = args.get("terminalId").and_then(Value::as_str) {
        app.state::<TerminalService>().authorize(id, TerminalActor::Web, TerminalAction::View)
            .map_err(access_map_error)?;
    }
    // Agent 回复会写入 PTY：在通用 View 检查之上提级到 Input（业务层仍会重新鉴权）。
    if command == "terminal_agent_reply" {
        if let Some(id) = args.get("terminalId").and_then(Value::as_str) {
            app.state::<TerminalService>().authorize(id, TerminalActor::Web, TerminalAction::Input)
                .map_err(access_map_error)?;
        }
    }
    // SSH 路径属于远端主机，不能拿服务器文件范围来比较。
    let path_keys: &[&str] = if command.starts_with("remote_") { &["localPath", "localDir"] } else {
        &["path", "startupPath", "projectDir", "filePath", "newPath"]
    };
    for key in path_keys {
        if let Some(path) = args.get(*key).and_then(Value::as_str).filter(|p| !p.trim().is_empty()) { scoped_file(path)?; }
    }
    if let Some(path) = args.get("options").and_then(|v| v.get("path")).and_then(Value::as_str) { scoped_file(path)?; }
    if matches!(command, "get_claude_sessions_for_terminals" | "get_agent_sessions_for_terminals" | "get_terminal_task_summaries") {
        let ids: Vec<String> = argument(args, "terminalIds")?;
        let service = app.state::<TerminalService>();
        for id in ids {
            // 已结束的 terminal ID 只用于回查持久化会话登记表（容器重启后恢复页签），
            // 不参与权限判定；仍存活的终端继续严格鉴权。
            if service.terminal_owner(&id).is_some() {
                service.authorize(&id, TerminalActor::Web, TerminalAction::View)
                    .map_err(access_map_error)?;
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalRequest {
    #[serde(default)] profile_id: String,
    #[serde(default)] terminal_type: String,
    display_name: Option<String>, extra_startup_params: Option<String>, extra_startup_mode: Option<String>,
    #[serde(default)] initial_rows: u16,
    #[serde(default)] initial_cols: u16,
    startup_path: Option<String>, initial_command: Option<String>, extra_param_tag: Option<String>, extra_param_tag_color: Option<String>,
    /// 项目启动的空白终端归属分组（桌面端浏览器版恢复页签时带上项目名）。
    group_override: Option<String>,
}

struct Job {
    created: std::time::Instant,
    outcome: Mutex<Option<Result<Value, String>>>,
}
fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn job(State(_state): State<AppState>, _claims: ClaimsFromRequest, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let job = jobs().lock().map_err(|_| ApiError::Internal("后台任务锁不可用".to_string()))?.get(&id).cloned()
        .ok_or_else(|| ApiError::NotFound("后台任务不存在或已过期".to_string()))?;
    let outcome = job.outcome.lock().map_err(|_| ApiError::Internal("后台任务状态锁不可用".to_string()))?;
    Ok(Json(match &*outcome {
        None => json!({"status":"running"}),
        Some(Ok(value)) => json!({"status":"done", "value":value}),
        Some(Err(error)) => json!({"status":"failed", "message":error}),
    }))
}

pub async fn invoke(State(state): State<AppState>, _claims: ClaimsFromRequest, headers: axum::http::HeaderMap, Path(command): Path<String>, Json(args): Json<Value>) -> Result<Json<Value>, ApiError> {
    // 请求方设备类型用于创建终端时记录 creator，供来源标识与接管提示使用。
    // 完整界面（电脑浏览器）通常为 Desktop；手机直接访问 /api 时按 UA 判定。
    let client_kind = client_kind_from_headers(&headers);
    check_arguments(&command, &args, &state.app_handle)?;
    let git_mutation = matches!(command.as_str(), "git_pull" | "git_push_with_options" | "git_checkout_branch" | "git_commit_paths");
    let long_operation = git_mutation || matches!(command.as_str(), "probe_claude_mcp" | "claude_history_rescan" | "codex_history_rescan" | "pi_history_rescan");
    if long_operation {
        let lease = if git_mutation {
            let path = args.get("path").or_else(|| args.get("options").and_then(|v| v.get("path"))).and_then(Value::as_str)
                .ok_or_else(|| ApiError::BadRequest("缺少仓库路径".to_string()))?;
            Some(super::git_handler::reserve_desktop_operation(path, &command)?)
        } else { None };
        let job = Arc::new(Job { created: std::time::Instant::now(), outcome: Mutex::new(None) });
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut map = jobs().lock().map_err(|_| ApiError::Internal("后台任务锁不可用".to_string()))?;
            map.retain(|_, job| job.created.elapsed().as_secs() < 600);
            if map.len() >= 128 { return Err(ApiError::Conflict("后台任务过多，请稍后重试".to_string())); }
            map.insert(id.clone(), job.clone());
        }
        tokio::spawn(async move {
            let outcome = execute(&command, args, client_kind, state.app_handle).await.map_err(|error| format!("{:?}", error));
            if let Some(lease) = lease { lease.finish(&outcome); }
            if let Ok(mut slot) = job.outcome.lock() { *slot = Some(outcome); }
        });
        return Ok(Json(json!({"$jobId":id})));
    }
    Ok(Json(execute(&command, args, client_kind, state.app_handle).await?))
}

async fn execute(command: &str, args: Value, client_kind: TerminalClientKind, app: crate::runtime::AppHandle) -> Result<Value, ApiError> {
    let value = match command {
        "start_terminal" | "start_blank_terminal" => {
            let request: TerminalRequest = serde_json::from_value(args).map_err(|e| ApiError::BadRequest(e.to_string()))?;
            if request.startup_path.as_ref().is_some_and(|path| !path.trim().is_empty() && !std::path::Path::new(path).is_dir()) {
                return Err(ApiError::BadRequest("终端启动目录不存在或不是目录".to_string()));
            }
            let blank = command == "start_blank_terminal";
            if !blank {
                let profile = crate::services::ProfileService::get_profile(&request.profile_id).map_err(ApiError::BadRequest)?;
                if let Some(path) = crate::services::ProfileService::effective_startup_path(&profile) { scoped_file(&path)?; }
            }
            // 创建端设备按请求 UA 记录（手机端创建的会话手机端才能关）
            let creator = match client_kind { TerminalClientKind::Mobile => TerminalCreator::Mobile, TerminalClientKind::Desktop => TerminalCreator::Desktop };
            crate::runtime::async_runtime::spawn_blocking(move || {
                let service = app.state::<TerminalService>();
                let id = if blank { service.create_blank_terminal(
                    if request.terminal_type.is_empty() { crate::commands::terminal::default_terminal_type() } else { &request.terminal_type },
                    request.display_name.as_deref(), request.group_override.as_deref(), request.initial_rows, request.initial_cols,
                    request.startup_path.as_deref(), request.initial_command.as_deref(), request.extra_param_tag.as_deref(),
                    request.extra_param_tag_color.as_deref(), app.clone(), TerminalOwner::Web, creator,
                ) } else { service.create_terminal(
                    &request.profile_id, request.display_name.as_deref(), request.extra_startup_params.as_deref(), request.extra_startup_mode.as_deref(),
                    request.initial_rows, request.initial_cols, request.startup_path.as_deref(), request.extra_param_tag.as_deref(), request.extra_param_tag_color.as_deref(),
                    app.clone(), TerminalOwner::Web, creator,
                ) }.map_err(ApiError::BadRequest)?;
                if let Some(info) = service.list_terminals_info_for(TerminalActor::Web).into_iter().find(|i| i.id == id) {
                    let _ = app.emit("terminal-created", info);
                }
                data(id)
            }).await.map_err(|e| ApiError::Internal(e.to_string()))??
        }
        "list_terminals" => data(app.state::<TerminalService>().list_terminals_info_for(TerminalActor::Web))?,
        "get_terminal_loading_mode" => {
            let id: String = argument(&args, "id")?;
            data(app.state::<TerminalService>().terminal_loading_mode(&id, TerminalActor::Web).map_err(ApiError::Forbidden)?)?
        }
        "drain_terminal_output" | "peek_terminal_output" => {
            let id: String = argument(&args, "id")?;
            result(app.state::<TerminalService>().peek_terminal_output(&id, TerminalActor::Web))?
        }
        "write_to_terminal" => {
            result(app.state::<TerminalService>().write_to_terminal(&argument::<String>(&args,"id")?, &argument::<String>(&args,"data")?, TerminalActor::Web))?
        }
        "resize_terminal" => {
            result(app.state::<TerminalService>().resize_terminal(&argument::<String>(&args,"id")?, argument(&args,"rows")?, argument(&args,"cols")?, false, TerminalActor::Web))?
        }
        "acknowledge_terminal_output" => {
            result(app.state::<TerminalService>().acknowledge_terminal_output(&argument::<String>(&args,"id")?, argument(&args,"charCount")?, TerminalActor::Web))?
        }
        "update_terminal_display_name" => {
            result(app.state::<TerminalService>().update_terminal_display_name(&argument::<String>(&args,"id")?, &argument::<String>(&args,"displayName")?, TerminalActor::Web))?
        }
        "report_session_directory" => {
            result(app.state::<TerminalService>().set_session_directory(&app, &argument::<String>(&args,"id")?, &argument::<String>(&args,"directory")?, TerminalActor::Web))?
        }
        "close_terminal" => {
            app.state::<TerminalService>().close_terminal(&app, &argument::<String>(&args,"id")?, TerminalActor::Web, TerminalCloseReason::WebClose)
                .map_err(|e| ApiError::Forbidden(e.to_string()))?;
            Value::Null
        }
        "log_boot" => Value::Null,
        _ => desktop_dispatch::dispatch(&command, args, app).await?,
    };
    Ok(value)
}

pub async fn upload(State(_state): State<AppState>, _claims: ClaimsFromRequest, mut multipart: Multipart) -> Result<Json<Value>, ApiError> {
    let root = PathService::require_data_dir().map_err(ApiError::Internal)?.join("ClientData").join("web-uploads");
    tokio::fs::create_dir_all(&root).await.map_err(|e| ApiError::Internal(e.to_string()))?;
    let mut paths = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(|e| ApiError::BadRequest(e.to_string()))? {
        let name = field.file_name().unwrap_or("文件").rsplit(['/', '\\']).next().unwrap_or("文件")
            .chars().map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect::<String>();
        let path = root.join(format!("{}-{}", uuid::Uuid::new_v4(), name));
        let bytes = field.bytes().await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
        tokio::fs::write(&path, bytes).await.map_err(|e| ApiError::Internal(e.to_string()))?;
        paths.push(path.to_string_lossy().to_string());
    }
    Ok(Json(json!({"paths": paths})))
}

pub async fn file(State(state): State<AppState>, Query(query): Query<HashMap<String,String>>) -> Result<Response, ApiError> {
    verify_token(query.get("token").ok_or_else(|| ApiError::Unauthorized("请先登录".to_string()))?, &state.jwt_secret).map_err(|_| ApiError::Unauthorized("登录已过期".to_string()))?;
    let path = query.get("path").ok_or_else(|| ApiError::BadRequest("缺少路径".to_string()))?;
    scoped_file(path)?;
    let bytes = tokio::fs::read(path).await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let mime = match PathBuf::from(path).extension().and_then(|v| v.to_str()).unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", _ => "application/octet-stream",
    };
    Ok(([("content-type", mime), ("x-content-type-options", "nosniff")], bytes).into_response())
}

pub async fn events(ws: WebSocketUpgrade, State(state): State<AppState>, Query(query): Query<HashMap<String,String>>) -> Result<Response, ApiError> {
    let claims = verify_token(query.get("token").ok_or_else(|| ApiError::Unauthorized("请先登录".to_string()))?, &state.jwt_secret).map_err(|_| ApiError::Unauthorized("登录已过期".to_string()))?;
    let slot = crate::web::ws::WsConnectionSlot::acquire().ok_or_else(|| ApiError::Conflict("连接数已达上限，请关闭闲置网页".to_string()))?;
    Ok(ws.max_message_size(64 * 1024).on_upgrade(move |mut socket| async move {
        let _slot = slot;
        let mut events = state.app_handle.state::<EventBus>().0.subscribe();
        let mut sessions = state.app_handle.state::<TerminalService>().session_change_tx.subscribe();
        let mut known: HashSet<String> = state.app_handle.state::<TerminalService>().list_terminals_info_for(TerminalActor::Web).into_iter().map(|v| v.id).collect();
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(10));
        let mut last_activity = std::time::Instant::now();
        loop {
            tokio::select! {
                changed = sessions.recv() => {
                    if matches!(changed, Err(tokio::sync::broadcast::error::RecvError::Closed)) { break; }
                    if socket.send(Message::Text(json!({"event":"web-resync", "payload":null}).to_string().into())).await.is_err() { break; }
                }
                _ = heartbeat.tick() => {
                    if chrono::Utc::now().timestamp() >= claims.exp as i64 || last_activity.elapsed().as_secs() > 30 { break; }
                    if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                }
                received = socket.recv() => match received {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => last_activity = std::time::Instant::now(),
                },
                event = events.recv() => {
                    let event = match event { Ok(event) => event, Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = socket.send(Message::Text(json!({"event":"web-resync", "payload":null}).to_string().into())).await;
                        continue;
                    }, Err(_) => break };
                    if event.event.starts_with("terminal_output_") { continue; }
                    let id = event.payload.get("terminalId").or_else(|| event.payload.get("id")).and_then(Value::as_str)
                        .or_else(|| if event.event == "terminal-closed" { event.payload.as_str() } else { None });
                    if let Some(id) = id {
                        if event.event == "terminal-closed" { if !known.remove(id) { continue; } }
                        else {
                            if state.app_handle.state::<TerminalService>().authorize(id, TerminalActor::Web, TerminalAction::View).is_err() { continue; }
                            known.insert(id.to_string());
                        }
                    }
                    if socket.send(Message::Text(serde_json::to_string(&event).unwrap_or_default().into())).await.is_err() { break; }
                }
            }
        }
        let _ = socket.close().await;
    }).into_response())
}
