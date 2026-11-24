//! 完整桌面界面的网页适配层；始终以 Web 身份访问终端。
use axum::{body::Body, extract::{Multipart, Path, Query, State, ws::{WebSocketUpgrade, Message}}, http::{header, HeaderValue}, response::{IntoResponse, Response}, Json};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use futures_util::{SinkExt, Stream};
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
    // nativeChatSessions 供手机端「开始对话」决定开原生会话还是终端接力，与桌面端同一开关。
    let settings = crate::services::SettingsService::get_settings();
    let agent_commands = settings.agent_commands;
    Json(json!({"platform": std::env::consts::OS, "mode": if cfg!(feature = "desktop") { "desktop" } else { "server" },
        "defaultTerminalType": crate::commands::terminal::default_terminal_type(), "fullInterface": true,
        "windowsBuildNumber": crate::services::platform_service::windows_build_number(),
        "isDocker": super::is_docker_runtime(), "nativeChatSessions": settings.native_chat_sessions,
        "agentCommands": {"claude": agent_commands.claude, "codex": agent_commands.codex, "antigravity": agent_commands.antigravity}}))
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

/// Web 端不允许新登记的「过宽」项目目录：文件系统根 / 盘根、系统目录、
/// 用户家目录。注册这类目录会让 `ensure_project_scope` 的白名单整体失效
/// （审查 M-2 / N-3：`/`、`C:\` 会被尾斜杠折叠，`/home`、`C:\Users` 等
/// 才是真实入口，因此按规范化路径判定而非封禁字面量）。
fn is_overbroad_project_path(raw: &str) -> bool {
    let stripped = PathService::normalize_child_process_path_str(raw);
    let normalized = stripped.replace('\\', "/").to_lowercase();
    let trimmed = normalized.trim().trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|part| !part.is_empty()).collect();
    // 文件系统根 / Windows 盘根（"c:"）与 UNC 根（"//server"）
    if parts.is_empty() {
        return true;
    }
    if parts[0].len() == 2 && parts[0].ends_with(':') && parts[0].as_bytes()[0].is_ascii_alphabetic() {
        if parts.len() == 1 {
            return true;
        }
        if parts[1] == "users" && parts.len() <= 3 {
            return true;
        }
        if matches!(
            parts[1],
            "windows" | "program files" | "program files (x86)" | "programdata"
        ) {
            return true;
        }
    }
    if parts.len() == 1 && matches!(parts[0], "etc" | "usr" | "var" | "bin" | "sbin" | "lib" | "lib64"
        | "boot" | "dev" | "proc" | "sys" | "tmp" | "root" | "home" | "users" | "mnt" | "media"
        | "srv" | "opt" | "run" | "windows" | "programdata") {
        return true;
    }
    // 类 Unix 用户家目录：/home/<user>、/Users/<user>
    if parts.len() == 2 && (parts[0] == "home" || parts[0] == "users") {
        return true;
    }
    // 本进程的 HOME / USERPROFILE
    for env_key in ["HOME", "USERPROFILE"] {
        if let Ok(home) = std::env::var(env_key) {
            let home_norm = PathService::normalize_child_process_path_str(&home)
                .replace('\\', "/")
                .to_lowercase();
            let home_norm = home_norm.trim().trim_end_matches('/');
            if !home_norm.is_empty() && trimmed == home_norm {
                return true;
            }
        }
    }
    false
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
    // 文件管理器的浏览、预览、下载、读写、删除、重命名都不要求目录已登记为项目。
    // 项目范围只约束依赖项目登记的功能（Git 操作、AI 会话等）。
    let file_manager_command = matches!(
        command,
        "list_directory" | "get_file_size" | "get_file_meta" | "read_file_content"
            | "write_file_content" | "delete_path" | "rename_path" | "open_path" | "open_in_explorer"
    );
    // SSH 路径属于远端主机，不能拿服务器文件范围来比较。
    let is_git_command = command == "get_git_repository_status" || command.starts_with("git_");
    let path_keys: &[&str] = if command.starts_with("remote_") { &["localPath", "localDir"] } else if file_manager_command { &[] } else {
        // destPath：claude/codex_history_export 直接落盘写文件，必须与 path 一样受
        // scope 约束，否则持 JWT 可向任意路径写文件（审查 M-1）。
        &["path", "startupPath", "projectDir", "filePath", "newPath", "destPath"]
    };
    for key in path_keys {
        // Git 的 filePath 是仓库内相对路径（如 src/App.tsx），命令层用
        // ensure_repo_relative_path 拒绝绝对路径与 `..`；这里若按服务器绝对路径
        // 校验，网页端所有 diff 预览都会被 403「必须使用服务器绝对路径」拒掉。
        if is_git_command && *key == "filePath" { continue; }
        if let Some(path) = args.get(*key).and_then(Value::as_str).filter(|p| !p.trim().is_empty()) { scoped_file(path)?; }
    }
    if let Some(path) = args.get("options").and_then(|v| v.get("path")).and_then(Value::as_str) { scoped_file(path)?; }
    // Git 命令以「向上回溯 .git」得到的仓库根为操作根：登记目录可能只是外层仓库的
    // 子目录（monorepo 场景），须对回溯根二次校验，防止对外层整仓提交/推送越过
    // 登记边界（审查 H-3）。require_repo_root 会跑一次 git rev-parse（几十毫秒），
    // Git 操作低频，可接受。
    if command == "get_git_repository_status" || command.starts_with("git_") {
        for path in args.get("path").and_then(Value::as_str).into_iter()
            .chain(args.get("options").and_then(|v| v.get("path")).and_then(Value::as_str)) {
            if path.trim().is_empty() { continue; }
            if let Ok(root) = crate::commands::git::require_repo_root(path) {
                scoped_file(&root.to_string_lossy())?;
            }
        }
    }
    // save_projects 全量覆盖项目白名单——白名单本身是 Web 端文件访问的边界，
    // 不能允许 Web 端登记盘根/系统目录/用户家目录这类过宽目录使边界失效
    // （审查 M-2；注册 `/home`、`C:\` 后 write_file_content/delete_path/git
    // 即全盘放行）。仅约束新增路径：桌面端历史上已注册的条目原样保留。
    if command == "save_projects" {
        let incoming: Vec<String> = args.get("projects")
            .and_then(Value::as_array)
            .map(|items| items.iter()
                .filter_map(|item| item.get("path").and_then(Value::as_str).map(str::to_string))
                .collect())
            .unwrap_or_default();
        let existing: Vec<String> = crate::commands::profile::get_projects()
            .map_err(ApiError::Internal)?
            .into_iter().map(|project| project.path).collect();
        for path in incoming {
            if path.trim().is_empty() { continue; }
            let already = existing.iter().any(|old| old.trim_end_matches(['/', '\\'])
                .eq_ignore_ascii_case(path.trim_end_matches(['/', '\\'])));
            if already { continue; }
            // 纯字符串分段判断可被 `..`、符号链接和「把文件当项目」绕过：
            // 注册 /etc/../etc 或 /etc/shadow 时原串不过宽，访问时
            // ensure_project_scope 却会 canonicalize 成 /etc 或该文件本身。
            // 因此先拒绝 `..`，再 canonicalize 后按真实路径判定，且必须是目录。
            if path.split(['/', '\\']).any(|part| part == "..") {
                return Err(ApiError::Forbidden(format!(
                    "项目路径不能包含上级目录引用（..）：{}",
                    path
                )));
            }
            let canonical = std::fs::canonicalize(path.trim()).map_err(|_| {
                ApiError::Forbidden(format!("项目目录不存在或不可访问：{}", path))
            })?;
            if !canonical.is_dir() {
                return Err(ApiError::Forbidden(format!("项目路径不是目录：{}", path)));
            }
            let canonical = canonical.to_string_lossy();
            if is_overbroad_project_path(&canonical) {
                return Err(ApiError::Forbidden(format!(
                    "Web 端不能登记系统级或用户根目录（{}），请改用更具体的项目目录",
                    path
                )));
            }
        }
    }
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
    startup_path: Option<String>, initial_command: Option<String>,
    /// 项目启动的空白终端归属分组（桌面端浏览器版恢复页签时带上项目名）。
    group_override: Option<String>,
    /// 历史会话恢复：命令没有模型引用时补 hooks 临时 settings。
    #[serde(default)]
    inject_claude_hooks: Option<bool>,
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
    let finished = {
        let outcome = job.outcome.lock().map_err(|_| ApiError::Internal("后台任务状态锁不可用".to_string()))?;
        match &*outcome {
            None => None,
            Some(Ok(value)) => Some(json!({"status":"done", "value":value})),
            Some(Err(error)) => Some(json!({"status":"failed", "message":error})),
        }
    };
    if let Some(payload) = finished {
        // 终态被客户端取走后立即移除，避免大型响应体继续滞留 JOBS 队列 600s。
        if let Ok(mut map) = jobs().lock() {
            map.remove(&id);
        }
        return Ok(Json(payload));
    }
    Ok(Json(json!({"status":"running"})))
}

pub async fn invoke(State(state): State<AppState>, claims: ClaimsFromRequest, headers: axum::http::HeaderMap, Path(command): Path<String>, Json(args): Json<Value>) -> Result<Json<Value>, ApiError> {
    // 浏览器端原生 AI 会话以登录账号为 owner，与手机 REST/WS 看到同一批会话。
    let owner = claims.0.sub.clone();
    // 请求方设备类型用于创建终端时记录 creator，供来源标识与接管提示使用。
    // 完整界面（电脑浏览器）通常为 Desktop；手机直接访问 /api 时按 UA 判定。
    let client_kind = client_kind_from_headers(&headers);
    let check_cmd = command.clone();
    let check_args = args.clone();
    let check_app = state.app_handle.clone();
    tokio::task::spawn_blocking(move || check_arguments(&check_cmd, &check_args, &check_app))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))??;
    let git_mutation = matches!(command.as_str(), "git_pull" | "git_push_with_options" | "git_checkout_branch" | "git_commit_paths");
    let long_operation = git_mutation || matches!(
        command.as_str(),
        "probe_claude_mcp"
            | "claude_history_rescan"
            | "codex_history_rescan"
            | "antigravity_history_rescan"
    );
    if long_operation {
        let lease = if git_mutation {
            let path = args.get("path").or_else(|| args.get("options").and_then(|v| v.get("path"))).and_then(Value::as_str)
                .ok_or_else(|| ApiError::BadRequest("缺少仓库路径".to_string()))?;
            Some(super::git_handler::reserve_desktop_operation(path, &command).await?)
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
            let outcome = execute(&command, args, client_kind, state.app_handle, owner)
                .await
                .map_err(|error| error.message().to_string());
            if let Some(lease) = lease { lease.finish(&outcome); }
            if let Ok(mut slot) = job.outcome.lock() { *slot = Some(outcome); }
        });
        return Ok(Json(json!({"$jobId":id})));
    }
    Ok(Json(execute(&command, args, client_kind, state.app_handle, owner).await?))
}

async fn execute(command: &str, args: Value, client_kind: TerminalClientKind, app: crate::runtime::AppHandle, owner: String) -> Result<Value, ApiError> {
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
                    request.startup_path.as_deref(), request.initial_command.as_deref(),
                    request.inject_claude_hooks.unwrap_or(false),
                    app.clone(), TerminalOwner::Web, creator,
                ) } else { service.create_terminal(
                    &request.profile_id, request.display_name.as_deref(), request.extra_startup_params.as_deref(), request.extra_startup_mode.as_deref(),
                    request.initial_rows, request.initial_cols, request.startup_path.as_deref(),
                    request.inject_claude_hooks.unwrap_or(false), app.clone(), TerminalOwner::Web, creator,
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
            let id: String = argument(&args, "id")?;
            let payload: String = argument(&args, "data")?;
            let outcome = crate::runtime::async_runtime::spawn_blocking(move || {
                app.state::<TerminalService>().write_to_terminal(&id, &payload, TerminalActor::Web)
            })
            .await
            .map_err(|e| ApiError::Internal(e.to_string()))?;
            result(outcome)?
        }
        "resize_terminal" => {
            result(app.state::<TerminalService>().resize_terminal(&argument::<String>(&args,"id")?, argument(&args,"rows")?, argument(&args,"cols")?, false, TerminalActor::Web))?
        }
        "acknowledge_terminal_output" => {
            result(app.state::<TerminalService>().acknowledge_terminal_output(&app, &argument::<String>(&args,"id")?, argument(&args,"charCount")?, TerminalActor::Web))?
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
        _ => desktop_dispatch::dispatch(&command, args, app, &owner).await?,
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
    let file = tokio::fs::File::open(path).await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let meta = file.metadata().await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
    if !meta.is_file() {
        return Err(ApiError::BadRequest("仅支持读取普通文件".to_string()));
    }
    let mime = match PathBuf::from(path).extension().and_then(|v| v.to_str()).unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", _ => "application/octet-stream",
    };
    let mut response = Response::new(Body::from_stream(tokio_util::io::ReaderStream::new(file)));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(meta.len()));
    headers.insert(header::HeaderName::from_static("x-content-type-options"), HeaderValue::from_static("nosniff"));
    Ok(response)
}

/// 浏览器端下载：文件直接流式输出，目录先打包成 ZIP 再流式输出。
///
/// 路由注册在请求超时层之外，大文件 / 大目录下载不会因为 REQUEST_TIMEOUT 被中断。
/// 鉴权与 `/api/desktop/file` 一致：浏览器直接导航无法带 Authorization 头，
/// 因此沿用查询串里的 JWT。与文件管理器一致，下载路径不要求目录已登记。
/// 目录 ZIP 使用与响应同生命周期的临时文件，连接结束即清理。
pub async fn download(State(state): State<AppState>, Query(query): Query<HashMap<String,String>>) -> Result<Response, ApiError> {
    verify_token(query.get("token").ok_or_else(|| ApiError::Unauthorized("请先登录".to_string()))?, &state.jwt_secret)
        .map_err(|_| ApiError::Unauthorized("登录已过期".to_string()))?;
    let path = query.get("path").ok_or_else(|| ApiError::BadRequest("缺少路径".to_string()))?;
    let source = PathBuf::from(path);
    let metadata = tokio::fs::metadata(&source).await
        .map_err(|e| ApiError::BadRequest(format!("无法读取文件：{}", e)))?;
    let name = source.file_name().and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::BadRequest("无法确定下载文件名".to_string()))?
        .to_string();
    if metadata.is_dir() {
        let temp_dir = PathService::require_data_dir().map_err(ApiError::Internal)?
            .join("ClientData").join("web-downloads");
        tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| ApiError::Internal(e.to_string()))?;
        let temp_path = temp_dir.join(format!("{}.zip", uuid::Uuid::new_v4()));
        let source_for_zip = source.clone();
        let target = temp_path.clone();
        let root_name = name.clone();
        tokio::task::spawn_blocking(move || build_directory_zip(&source_for_zip, &target, &root_name))
            .await.map_err(|e| ApiError::Internal(e.to_string()))?
            .map_err(|e| ApiError::Internal(format!("打包文件夹失败：{}", e)))?;
        return respond_with_file(temp_path.clone(), format!("{}.zip", name), "application/zip", Some(temp_path)).await;
    }
    if !metadata.is_file() {
        return Err(ApiError::BadRequest("仅支持下载普通文件或文件夹".to_string()));
    }
    respond_with_file(source, name, "application/octet-stream", None).await
}

/// 下载响应的 `Content-Disposition`。`filename*` 按 RFC 5987 编码 UTF-8 文件名，
/// `filename` 只保留 ASCII 兜底值（旧浏览器不支持 `filename*` 时仍能拿到合理名称）。
fn content_disposition(name: &str) -> String {
    let fallback: String = name.chars().map(|ch| {
        if ch.is_ascii() && !ch.is_ascii_control() && !matches!(ch, '"' | '\\') { ch } else { '_' }
    }).collect();
    format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", fallback, urlencoding::encode(name))
}

/// 临时 ZIP 文件的生命周期守卫：响应体（含流）被丢弃时删除文件。
struct TempFileCleanup(PathBuf);

impl Drop for TempFileCleanup {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

/// 带清理守卫的流式响应体。
struct DownloadStream {
    inner: tokio_util::io::ReaderStream<tokio::fs::File>,
    _cleanup: Option<TempFileCleanup>,
}

impl Stream for DownloadStream {
    type Item = <tokio_util::io::ReaderStream<tokio::fs::File> as Stream>::Item;

    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.inner).poll_next(cx)
    }
}

async fn respond_with_file(path: PathBuf, download_name: String, content_type: &'static str, cleanup: Option<PathBuf>) -> Result<Response, ApiError> {
    // 守卫先于打开文件构造：即使下面提前返回，临时 ZIP 也会在作用域结束时删除。
    let cleanup = cleanup.map(TempFileCleanup);
    let file = tokio::fs::File::open(&path).await
        .map_err(|e| ApiError::BadRequest(format!("无法打开文件：{}", e)))?;
    let size = file.metadata().await.map(|meta| meta.len()).unwrap_or(0);
    let mut response = Response::new(Body::from_stream(DownloadStream {
        inner: tokio_util::io::ReaderStream::new(file),
        _cleanup: cleanup,
    }));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    headers.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&content_disposition(&download_name))
        .map_err(|e| ApiError::Internal(e.to_string()))?);
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    Ok(response)
}

/// 把目录打包成 ZIP 临时文件。跳过符号链接，避免通过链接把项目目录之外的文件打进去。
fn build_directory_zip(source: &std::path::Path, target: &std::path::Path, root_name: &str) -> Result<(), String> {
    let file = std::fs::File::create(target).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let file_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let dir_options = file_options.unix_permissions(0o755);
    let root = root_name.replace(['/', '\\'], "_");
    let root = if root.is_empty() { "download".to_string() } else { root };
    zip.add_directory(format!("{}/", root), dir_options).map_err(|e| e.to_string())?;
    append_zip_directory(&mut zip, source, std::path::Path::new(&root), file_options, dir_options)?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn append_zip_directory(
    zip: &mut zip::ZipWriter<std::fs::File>,
    directory: &std::path::Path,
    prefix: &std::path::Path,
    file_options: zip::write::SimpleFileOptions,
    dir_options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let entries = std::fs::read_dir(directory)
        .map_err(|e| format!("读取目录 {} 失败：{}", directory.display(), e))?;
    for entry in entries {
        let entry = match entry { Ok(entry) => entry, Err(_) => continue };
        // DirEntry::file_type 不跟随符号链接，链接本身直接跳过。
        let file_type = match entry.file_type() { Ok(file_type) => file_type, Err(_) => continue };
        if file_type.is_symlink() { continue; }
        let path = entry.path();
        let relative = prefix.join(entry.file_name());
        // ZIP 规范固定用 `/` 作为分隔符。
        let entry_name = relative.to_string_lossy().replace('\\', "/");
        if file_type.is_dir() {
            zip.add_directory(format!("{}/", entry_name), dir_options).map_err(|e| e.to_string())?;
            append_zip_directory(zip, &path, &relative, file_options, dir_options)?;
        } else if file_type.is_file() {
            let mut input = match std::fs::File::open(&path) { Ok(input) => input, Err(_) => continue };
            zip.start_file(entry_name, file_options).map_err(|e| e.to_string())?;
            std::io::copy(&mut input, zip).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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

#[cfg(test)]
mod download_tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn content_disposition_keeps_ascii_fallback_and_encodes_utf8() {
        let value = content_disposition("日志 2026.log");
        assert!(value.starts_with("attachment; filename=\"__ 2026.log\""));
        assert!(value.contains("filename*=UTF-8''"));
        // 百分号编码后的中文文件名不应包含原始非 ASCII 字符。
        assert!(value.is_ascii());
    }

    #[test]
    fn directory_zip_contains_nested_files() {
        let root = std::env::temp_dir().join(format!("tb-download-test-{}", uuid::Uuid::new_v4()));
        let source = root.join("项目");
        std::fs::create_dir_all(source.join("sub")).unwrap();
        std::fs::write(source.join("a.txt"), b"hello").unwrap();
        std::fs::write(source.join("sub/b.txt"), b"world").unwrap();
        let target = root.join("out.zip");
        build_directory_zip(&source, &target, "项目").unwrap();

        let file = std::fs::File::open(&target).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().unwrap().to_string())
            .collect();
        assert!(names.contains(&"项目/a.txt".to_string()));
        assert!(names.contains(&"项目/sub/b.txt".to_string()));
        let mut content = String::new();
        archive.by_name("项目/a.txt").unwrap().read_to_string(&mut content).unwrap();
        assert_eq!(content, "hello");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn overbroad_project_path_handles_windows_verbatim_and_users_depth() {
        assert!(is_overbroad_project_path(r"\\?\C:\"));
        assert!(is_overbroad_project_path(r"\\?\C:\Windows"));
        assert!(is_overbroad_project_path(r"\\?\C:\Users"));
        assert!(is_overbroad_project_path(r"\\?\C:\Users\alice"));
        assert!(!is_overbroad_project_path(r"\\?\C:\Users\alice\projects\app"));
        assert!(!is_overbroad_project_path("/srv/projects/app"));
    }
}
