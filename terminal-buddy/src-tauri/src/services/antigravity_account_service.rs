//! Antigravity（agy）多账号管理服务。
//!
//! 设计边界：
//! 1. 录入授权 Token 后仅做标准 Google OAuth 身份解析（JWT `id_token` 解码 / `openidconnect.googleapis.com/v1/userinfo`），
//!    **绝不使用授权 Token 发起任何 LLM 推理或模型接口调用**。
//! 2. 浏览器 OAuth 登录通过隔离目录拉起官方 `agy acp --login` 完成，不硬编码客户端密钥，100% 兼容 `agy` 原生凭据格式。
//! 3. 每个账号物化独立的 `GEMINI_HOME` 隔离目录并写入 `antigravity-keyring-unavailable` 标记，
//!    支持桌面端同时并发运行多个不同账号的原生 ACP 会话与终端 CLI 会话。
use crate::models::antigravity_account::{
    AntigravityAccountRecord, AntigravityAccountState, AntigravityAccountStoreFile,
    AntigravityAccountView, AntigravityOAuthCompleteInput, AntigravityOAuthStartResult,
    AntigravityTokenInput,
};
use super::agent_cli_service::{self, CliTool};
use super::atomic_file::atomic_write_private;
use super::crypto_service::{decrypt_secret_field, encrypt_secret_field};
use super::path_service::PathService;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::Utc;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

/// 终端命令行引用前缀：后端在启动终端前展开为带隔离 `GEMINI_HOME` 的启动命令，不把凭据暴露进命令行。
pub const ANTIGRAVITY_REF_PREFIX: &str = "__tb_agy_account__:";

const STORE_FILE_NAME: &str = "antigravity_accounts.json";
const PROFILES_DIR_NAME: &str = "antigravity-profiles";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const ISOLATED_SSH_CONNECTION: &str = "127.0.0.1 0 127.0.0.1 0";

#[derive(Debug, Clone, Default)]
struct AccountIdentity {
    email: String,
    name: String,
    picture: String,
    subject: String,
}

struct PendingOAuthLogin {
    child: Child,
    stdin: Option<ChildStdin>,
    staging_dir: PathBuf,
    output_rx: mpsc::Receiver<String>,
    created_at: Instant,
}

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn pending_oauth_logins() -> &'static Mutex<HashMap<String, PendingOAuthLogin>> {
    static MAP: OnceLock<Mutex<HashMap<String, PendingOAuthLogin>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn store_path() -> Result<PathBuf> {
    Ok(PathService::require_data_dir()?.join(STORE_FILE_NAME))
}

fn profiles_root() -> Result<PathBuf> {
    Ok(PathService::require_data_dir()?.join(PROFILES_DIR_NAME))
}

fn load_store_from(path: &Path) -> Result<AntigravityAccountStoreFile> {
    if !path.exists() {
        return Ok(AntigravityAccountStoreFile::default());
    }
    let bytes = fs::read(path).map_err(|e| format!("读取 Antigravity 账号配置失败：{e}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "Antigravity 账号配置已损坏，请检查 antigravity_accounts.json".to_string())
}

fn save_store_to(path: &Path, store: &AntigravityAccountStoreFile) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|e| format!("序列化 Antigravity 账号配置失败：{e}"))?;
    atomic_write_private(path, &bytes)
        .map_err(|e| format!("保存 Antigravity 账号配置失败：{e}"))
}

fn to_state(store: &AntigravityAccountStoreFile) -> AntigravityAccountState {
    let active = store.active_account_id.as_deref();
    let mut accounts: Vec<AntigravityAccountView> = store
        .accounts
        .iter()
        .map(|rec| AntigravityAccountView {
            id: rec.id.clone(),
            alias: rec.alias.clone(),
            email: rec.email.clone(),
            name: rec.name.clone(),
            picture: rec.picture.clone(),
            auth_source: rec.auth_source.clone(),
            has_refresh_token: rec.has_refresh_token,
            token_hint: rec.token_hint.clone(),
            updated_at: rec.updated_at.clone(),
            is_default: active == Some(rec.id.as_str()),
        })
        .collect();
    accounts.sort_by_key(|a| !a.is_default);
    AntigravityAccountState {
        accounts,
        active_account_id: store.active_account_id.clone(),
    }
}

pub fn get_account_state() -> Result<AntigravityAccountState> {
    let _guard = store_lock().lock().map_err(|_| "账号存储锁不可用")?;
    let store = load_store_from(&store_path()?)?;
    Ok(to_state(&store))
}

pub fn set_default_account(id: Option<&str>) -> Result<AntigravityAccountState> {
    let _guard = store_lock().lock().map_err(|_| "账号存储锁不可用")?;
    let path = store_path()?;
    let mut store = load_store_from(&path)?;
    match id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(target_id) => {
            if !store.accounts.iter().any(|a| a.id == target_id) {
                return Err("所选 Antigravity 账号不存在".into());
            }
            store.active_account_id = Some(target_id.to_string());
        }
        None => store.active_account_id = None,
    }
    save_store_to(&path, &store)?;
    Ok(to_state(&store))
}

pub fn delete_account(id: &str) -> Result<AntigravityAccountState> {
    let _guard = store_lock().lock().map_err(|_| "账号存储锁不可用")?;
    let path = store_path()?;
    let mut store = load_store_from(&path)?;
    let before = store.accounts.len();
    store.accounts.retain(|a| a.id != id);
    if store.accounts.len() == before {
        return Err("未找到要删除的 Antigravity 账号".into());
    }
    if store.active_account_id.as_deref() == Some(id) {
        store.active_account_id = None;
    }
    save_store_to(&path, &store)?;
    if let Ok(root) = profiles_root() {
        let dir = root.join(sanitize_account_dir_name(id));
        if dir.exists() {
            let _ = fs::remove_dir_all(&dir);
        }
    }
    Ok(to_state(&store))
}

pub fn rename_account(id: &str, alias: &str) -> Result<AntigravityAccountState> {
    let trimmed = alias.trim();
    if trimmed.is_empty() {
        return Err("账号别名不能为空".into());
    }
    let _guard = store_lock().lock().map_err(|_| "账号存储锁不可用")?;
    let path = store_path()?;
    let mut store = load_store_from(&path)?;
    let Some(account) = store.accounts.iter_mut().find(|a| a.id == id) else {
        return Err("未找到指定的 Antigravity 账号".into());
    };
    account.alias = trimmed.to_string();
    account.updated_at = Utc::now().to_rfc3339();
    save_store_to(&path, &store)?;
    Ok(to_state(&store))
}

/// 根据账号 ID 物化独立的 `GEMINI_HOME` 目录，并返回启动 `agy` / `agy acp` 所需的隔离环境。
pub fn prepare_isolated_env(account_id: &str) -> Result<(PathBuf, Vec<(String, String)>)> {
    let _guard = store_lock().lock().map_err(|_| "账号存储锁不可用")?;
    let store = load_store_from(&store_path()?)?;
    let account = store
        .accounts
        .iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| "所选 Antigravity 账号已不存在，请重新选择".to_string())?;
    let token_json = decrypt_secret_field(&account.encrypted_token_json)?;
    let profile_dir = profiles_root()?.join(sanitize_account_dir_name(&account.id));
    materialize_profile_dir(&profile_dir, &token_json)?;
    let env = isolated_env_for_dir(&profile_dir);
    Ok((profile_dir, env))
}

pub fn isolated_env_for_dir(profile_dir: &Path) -> Vec<(String, String)> {
    let dir_str = PathService::normalize_child_process_path_str(&profile_dir.to_string_lossy());
    let mut env = vec![
        ("GEMINI_HOME".into(), dir_str),
        ("AGY_ACP_FORCE_FILE_STORAGE".into(), "1".into()),
        ("SSH_CONNECTION".into(), ISOLATED_SSH_CONNECTION.into()),
        ("AGY_CLI_DISABLE_AUTO_UPDATE".into(), "1".into()),
    ];
    #[cfg(not(windows))]
    env.push(("WSL_INTEROP".into(), "1".into()));
    env
}

fn materialize_profile_dir(profile_dir: &Path, token_json: &str) -> Result<()> {
    for sub in ["antigravity-acp", "antigravity-cli"] {
        let app_dir = profile_dir.join(sub);
        let cache_dir = app_dir.join("cache");
        fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("创建 Antigravity 账号隔离目录失败：{e}"))?;
        let token_path = app_dir.join("antigravity-oauth-token");
        atomic_write_private(&token_path, token_json.as_bytes())
            .map_err(|e| format!("写入 Antigravity 账号凭据失败：{e}"))?;
        let marker = cache_dir.join("antigravity-keyring-unavailable");
        if !marker.exists() {
            let _ = fs::write(&marker, b"1");
        }
    }
    Ok(())
}

fn sanitize_account_dir_name(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// 展开终端命令开头的 `__tb_agy_account__:<accountId> <agy command>`。
/// 只注入隔离目录路径环境变量，不在命令行中包含任何 Token 明文。
pub fn expand_leading_antigravity_ref(command: &str) -> Result<String> {
    let trimmed = command.trim_start();
    let Some(rest) = trimmed.strip_prefix(ANTIGRAVITY_REF_PREFIX) else {
        return Ok(command.to_string());
    };
    let (account_id, tail) = match rest.find(char::is_whitespace) {
        Some(idx) => (&rest[..idx], rest[idx..].trim_start()),
        None => (rest, ""),
    };
    if account_id.is_empty() || !account_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Antigravity 账号引用格式无效".into());
    }
    let (profile_dir, _env) = prepare_isolated_env(account_id)?;
    let dir_str = PathService::normalize_child_process_path_str(&profile_dir.to_string_lossy());
    let launch_cmd = if tail.is_empty() {
        "agy --dangerously-skip-permissions"
    } else {
        tail
    };
    Ok(format_isolated_cli_command(&dir_str, launch_cmd))
}

fn format_isolated_cli_command(profile_dir: &str, launch_cmd: &str) -> String {
    #[cfg(windows)]
    {
        let escaped = profile_dir.replace('\'', "''");
        format!(
            "$env:GEMINI_HOME='{}'; $env:AGY_ACP_FORCE_FILE_STORAGE='1'; $env:SSH_CONNECTION='{}'; $env:AGY_CLI_DISABLE_AUTO_UPDATE='1'; {}",
            escaped, ISOLATED_SSH_CONNECTION, launch_cmd
        )
    }
    #[cfg(not(windows))]
    {
        let escaped = profile_dir.replace('\'', "'\\''");
        format!(
            "GEMINI_HOME='{}' AGY_ACP_FORCE_FILE_STORAGE='1' SSH_CONNECTION='{}' WSL_INTEROP='1' AGY_CLI_DISABLE_AUTO_UPDATE='1' {}",
            escaped, ISOLATED_SSH_CONNECTION, launch_cmd
        )
    }
}

/// 手动录入授权 Token：解析/刷新仅用于获取 Google 账号信息，不调用任何 LLM 接口。
pub async fn save_account_from_token(input: AntigravityTokenInput) -> Result<AntigravityAccountState> {
    let raw_token = input.token.as_deref().map(str::trim).unwrap_or("");
    if raw_token.is_empty() {
        if let Some(id) = input.id.as_deref().filter(|s| !s.trim().is_empty()) {
            let alias = input.alias.as_deref().unwrap_or("").trim();
            return rename_account(id, alias);
        }
        return Err("请输入授权 Token（支持 OAuth JSON、access_token 或 refresh_token）".into());
    }

    let mut token_obj = normalize_token_input(
        raw_token,
        input.client_id.as_deref(),
        input.client_secret.as_deref(),
    )?;

    let identity = resolve_identity_from_token(&mut token_obj).await?;
    let token_json = serde_json::to_string(&Value::Object(token_obj.clone()))
        .map_err(|e| format!("序列化 Token 数据失败：{e}"))?;

    upsert_account_record(
        input.id.as_deref(),
        input.alias.as_deref(),
        &identity,
        &token_json,
        &token_obj,
        "token",
    )
}

/// 导入本机当前已登录的 `agy` 文件凭据（只读，不修改原文件）。
pub async fn import_local_account() -> Result<AntigravityAccountState> {
    let token_path = find_local_agy_token_file()
        .ok_or_else(|| "未检测到本机 ~/.gemini 下的 Antigravity 凭据文件；若登录态保存在系统密钥链中，请使用「浏览器 OAuth 登录」或手动粘贴 Token".to_string())?;
    let raw = fs::read_to_string(&token_path)
        .map_err(|e| format!("读取本机 Antigravity 凭据失败：{e}"))?;
    let mut token_obj = normalize_token_input(&raw, None, None)?;
    let identity = resolve_identity_from_token(&mut token_obj).await?;
    let token_json = serde_json::to_string(&Value::Object(token_obj.clone()))
        .map_err(|e| format!("序列化 Token 数据失败：{e}"))?;
    upsert_account_record(None, None, &identity, &token_json, &token_obj, "local_import")
}

fn find_local_agy_token_file() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let gemini = home.join(".gemini");
    for sub in ["antigravity-cli", "antigravity-acp"] {
        let candidate = gemini.join(sub).join("antigravity-oauth-token");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 启动隔离目录中的 `agy acp --login`，捕获官方 Google 浏览器 OAuth 链接返回前端。
pub fn start_oauth_login() -> Result<AntigravityOAuthStartResult> {
    cleanup_stale_oauth_logins();
    let binary = resolve_agy_binary();
    let login_id = Uuid::new_v4().to_string();
    let staging_dir = std::env::temp_dir().join(format!("tb-agy-oauth-{}", login_id));
    let acp_cache = staging_dir.join("antigravity-acp").join("cache");
    fs::create_dir_all(&acp_cache)
        .map_err(|e| format!("创建临时 OAuth 登录目录失败：{e}"))?;
    let _ = fs::write(acp_cache.join("antigravity-keyring-unavailable"), b"1");

    let normalized_staging = PathService::normalize_child_process_path_str(&staging_dir.to_string_lossy());
    let mut cmd = Command::new(&binary);
    cmd.args([
        "acp",
        "--gemini-dir",
        &normalized_staging,
        "--app-data-dir",
        "antigravity-acp",
        "--login",
    ]);
    for (k, v) in isolated_env_for_dir(&staging_dir) {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        let _ = fs::remove_dir_all(&staging_dir);
        format!("无法启动 Antigravity CLI（{}）：{}", binary, e)
    })?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (tx, rx) = mpsc::channel::<String>();
    if let Some(out) = stdout {
        let tx_out = tx.clone();
        thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(std::result::Result::ok) {
                let _ = tx_out.send(line);
            }
        });
    }
    if let Some(err) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(std::result::Result::ok) {
                let _ = tx.send(line);
            }
        });
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut collected_lines = Vec::new();
    let mut found_url: Option<String> = None;
    while Instant::now() < deadline {
        let remain = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remain.min(Duration::from_millis(250))) {
            Ok(line) => {
                if let Some(url) = extract_oauth_url(&line) {
                    found_url = Some(url);
                    break;
                }
                collected_lines.push(line);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(Some(status)) = child.try_wait() {
                    let tail = collected_lines.join("\n");
                    let _ = fs::remove_dir_all(&staging_dir);
                    return Err(format!(
                        "Antigravity 登录进程提前退出（{status}）：{}",
                        tail.trim()
                    ));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let Some(auth_url) = found_url else {
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&staging_dir);
        let tail = collected_lines.join(" ");
        return Err(format!(
            "未能从 agy 获取 Google OAuth 授权链接，请确认已安装新版 Antigravity CLI。输出：{}",
            tail.trim()
        ));
    };

    let mut map = pending_oauth_logins().lock().map_err(|_| "OAuth 登录状态锁不可用")?;
    map.insert(
        login_id.clone(),
        PendingOAuthLogin {
            child,
            stdin,
            staging_dir,
            output_rx: rx,
            created_at: Instant::now(),
        },
    );

    Ok(AntigravityOAuthStartResult { login_id, auth_url })
}

/// 提交浏览器授权后拿到的授权码，等待 `agy` 换票落盘并解析账号信息入库。
pub async fn complete_oauth_login(input: AntigravityOAuthCompleteInput) -> Result<AntigravityAccountState> {
    let code = input.code.trim().to_string();
    if code.is_empty() {
        return Err("请粘贴浏览器授权完成后显示的授权码".into());
    }
    let login_id = input.login_id.trim().to_string();
    let alias = input.alias.clone();

    let token_raw = tokio::task::spawn_blocking(move || -> Result<String> {
        let mut pending = {
            let mut map = pending_oauth_logins().lock().map_err(|_| "OAuth 登录状态锁不可用")?;
            map.remove(&login_id)
                .ok_or_else(|| "OAuth 登录会话已过期或不存在，请重新点击浏览器登录".to_string())?
        };
        let staging_dir = pending.staging_dir.clone();
        let result = (|| -> Result<String> {
            if let Some(mut stdin) = pending.stdin.take() {
                writeln!(stdin, "{code}")
                    .and_then(|_| stdin.flush())
                    .map_err(|e| format!("向 agy 写入授权码失败：{e}"))?;
            }
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut logs = Vec::new();
            let status = loop {
                while let Ok(line) = pending.output_rx.try_recv() {
                    logs.push(line);
                }
                if let Some(status) = pending
                    .child
                    .try_wait()
                    .map_err(|e| format!("等待 agy 登录完成失败：{e}"))?
                {
                    break status;
                }
                if Instant::now() >= deadline {
                    let _ = pending.child.kill();
                    let _ = pending.child.wait();
                    return Err("等待 agy 换取授权 Token 超时，请确认授权码有效后重试".into());
                }
                thread::sleep(Duration::from_millis(120));
            };
            while let Ok(line) = pending.output_rx.try_recv() {
                logs.push(line);
            }
            let token_path = staging_dir.join("antigravity-acp").join("antigravity-oauth-token");
            let fallback_path = staging_dir.join("antigravity-cli").join("antigravity-oauth-token");
            let actual_path = if token_path.is_file() {
                token_path
            } else if fallback_path.is_file() {
                fallback_path
            } else {
                let tail = logs.join(" ");
                return Err(format!(
                    "授权未生成凭据文件（退出码 {status}），请确认粘贴了最新一次授权链接的授权码。{}",
                    tail.trim()
                ));
            };
            fs::read_to_string(&actual_path)
                .map_err(|e| format!("读取授权生成的凭据文件失败：{e}"))
        })();
        let _ = fs::remove_dir_all(&staging_dir);
        result
    })
    .await
    .map_err(|e| format!("OAuth 后台任务异常：{e}"))??;

    let mut token_obj = normalize_token_input(&token_raw, None, None)?;
    let identity = resolve_identity_from_token(&mut token_obj).await?;
    let token_json = serde_json::to_string(&Value::Object(token_obj.clone()))
        .map_err(|e| format!("序列化 Token 数据失败：{e}"))?;

    upsert_account_record(None, alias.as_deref(), &identity, &token_json, &token_obj, "oauth")
}

pub fn cancel_oauth_login(login_id: &str) -> Result<()> {
    let mut map = pending_oauth_logins().lock().map_err(|_| "OAuth 登录状态锁不可用")?;
    if let Some(mut pending) = map.remove(login_id) {
        let _ = pending.child.kill();
        let _ = pending.child.wait();
        let _ = fs::remove_dir_all(&pending.staging_dir);
    }
    Ok(())
}

fn cleanup_stale_oauth_logins() {
    if let Ok(mut map) = pending_oauth_logins().lock() {
        let expired: Vec<String> = map
            .iter()
            .filter(|(_, p)| p.created_at.elapsed() > Duration::from_secs(600))
            .map(|(k, _)| k.clone())
            .collect();
        for key in expired {
            if let Some(mut pending) = map.remove(&key) {
                let _ = pending.child.kill();
                let _ = pending.child.wait();
                let _ = fs::remove_dir_all(&pending.staging_dir);
            }
        }
    }
}

fn resolve_agy_binary() -> String {
    if let Ok(explicit) = std::env::var("TERMINAL_BUDDY_ANTIGRAVITY_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    agent_cli_service::find_executable(CliTool::Antigravity)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "agy".into())
}

fn extract_oauth_url(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let cleaned = token.trim_matches(|c: char| matches!(c, '"' | '\'' | '(' | ')' | '<' | '>' | ',' | ';'));
        if cleaned.starts_with("https://accounts.google.com/")
            || (cleaned.starts_with("https://") && cleaned.contains("oauth"))
        {
            return Some(cleaned.to_string());
        }
    }
    None
}

fn normalize_token_input(
    raw: &str,
    client_id: Option<&str>,
    client_secret: Option<&str>,
) -> Result<Map<String, Value>> {
    let trimmed = raw.trim();
    let mut obj = if trimmed.starts_with('{') {
        let value: Value = serde_json::from_str(trimmed)
            .map_err(|_| "授权 Token JSON 格式无效，请检查是否完整复制".to_string())?;
        let map = value
            .as_object()
            .ok_or_else(|| "授权 Token JSON 必须是对象格式".to_string())?;
        let mut normalized = map.clone();
        // 兼容驼峰字段名，统一补充 snake_case 以便 agy 直接读取。
        for (camel, snake) in [
            ("accessToken", "access_token"),
            ("refreshToken", "refresh_token"),
            ("idToken", "id_token"),
            ("tokenType", "token_type"),
            ("clientId", "client_id"),
            ("clientSecret", "client_secret"),
        ] {
            if !normalized.contains_key(snake) {
                if let Some(v) = normalized.get(camel).cloned() {
                    normalized.insert(snake.into(), v);
                }
            }
        }
        normalized
    } else if looks_like_jwt(trimmed) {
        let mut map = Map::new();
        map.insert("id_token".into(), Value::String(trimmed.to_string()));
        map
    } else if trimmed.starts_with("1//") {
        let mut map = Map::new();
        map.insert("refresh_token".into(), Value::String(trimmed.to_string()));
        map.insert("token_type".into(), Value::String("Bearer".into()));
        map
    } else {
        let mut map = Map::new();
        map.insert("access_token".into(), Value::String(trimmed.to_string()));
        map.insert("token_type".into(), Value::String("Bearer".into()));
        map
    };

    if let Some(cid) = client_id.map(str::trim).filter(|s| !s.is_empty()) {
        obj.insert("client_id".into(), Value::String(cid.to_string()));
    }
    if let Some(csec) = client_secret.map(str::trim).filter(|s| !s.is_empty()) {
        obj.insert("client_secret".into(), Value::String(csec.to_string()));
    }
    if !obj.contains_key("token_type") {
        obj.insert("token_type".into(), Value::String("Bearer".into()));
    }

    let has_any = ["access_token", "refresh_token", "id_token"]
        .iter()
        .any(|k| obj.get(*k).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty()));
    if !has_any {
        return Err("Token 内容中未包含 access_token、refresh_token 或 id_token".into());
    }
    Ok(obj)
}

fn looks_like_jwt(s: &str) -> bool {
    let mut parts = s.split('.');
    matches!((parts.next(), parts.next(), parts.next(), parts.next()), (Some(a), Some(b), Some(c), None) if !a.is_empty() && !b.is_empty() && !c.is_empty())
}

/// 解析账号信息（严格只调用 Google OAuth / UserInfo，绝不调用任何 LLM 接口）。
async fn resolve_identity_from_token(token_obj: &mut Map<String, Value>) -> Result<AccountIdentity> {
    let mut identity = token_obj
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(decode_jwt_identity)
        .unwrap_or_default();

    let access_token = token_obj
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    if let Some(at) = access_token {
        match fetch_google_userinfo(&at).await {
            Ok(remote) => merge_identity(&mut identity, remote),
            Err(err) => {
                // access_token 可能已过期：若配有 refresh_token + client_id，仅刷新一次换取新 access_token 查 UserInfo。
                if let Some(refreshed) = try_refresh_google_token(token_obj).await? {
                    if let Some(id_tok) = refreshed.get("id_token").and_then(Value::as_str) {
                        if let Some(decoded) = decode_jwt_identity(id_tok) {
                            merge_identity(&mut identity, decoded);
                        }
                    }
                    if let Some(new_at) = refreshed.get("access_token").and_then(Value::as_str) {
                        if let Ok(remote) = fetch_google_userinfo(new_at).await {
                            merge_identity(&mut identity, remote);
                        }
                    }
                } else if identity.email.is_empty() {
                    return Err(format!("无法通过授权 Token 获取 Google 账号信息：{err}"));
                }
            }
        }
    } else if let Some(refreshed) = try_refresh_google_token(token_obj).await? {
        if let Some(id_tok) = refreshed.get("id_token").and_then(Value::as_str) {
            if let Some(decoded) = decode_jwt_identity(id_tok) {
                merge_identity(&mut identity, decoded);
            }
        }
        if let Some(new_at) = refreshed.get("access_token").and_then(Value::as_str) {
            let remote = fetch_google_userinfo(new_at).await?;
            merge_identity(&mut identity, remote);
        }
    } else if identity.email.is_empty() {
        return Err("仅提供 refresh_token 且缺少 OAuth client_id 时无法单独拉取账号信息；请粘贴完整的 antigravity-oauth-token JSON，或直接使用「浏览器 OAuth 登录」".into());
    }

    if identity.email.is_empty() && identity.name.is_empty() {
        return Err("未能从授权 Token 中解析出账号邮箱或名称，请检查 Token 是否有效".into());
    }
    Ok(identity)
}

fn merge_identity(target: &mut AccountIdentity, incoming: AccountIdentity) {
    if !incoming.email.is_empty() {
        target.email = incoming.email;
    }
    if !incoming.name.is_empty() {
        target.name = incoming.name;
    }
    if !incoming.picture.is_empty() {
        target.picture = incoming.picture;
    }
    if !incoming.subject.is_empty() {
        target.subject = incoming.subject;
    }
}

fn decode_jwt_identity(jwt: &str) -> Option<AccountIdentity> {
    let payload_b64 = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .or_else(|_| URL_SAFE.decode(payload_b64))
        .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let email = value["email"].as_str().unwrap_or("").trim().to_string();
    let name = value["name"].as_str().unwrap_or("").trim().to_string();
    let picture = value["picture"].as_str().unwrap_or("").trim().to_string();
    let subject = value["sub"].as_str().unwrap_or("").trim().to_string();
    if email.is_empty() && name.is_empty() && subject.is_empty() {
        return None;
    }
    Some(AccountIdentity { email, name, picture, subject })
}

async fn fetch_google_userinfo(access_token: &str) -> Result<AccountIdentity> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))?;
    let resp = client
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("请求 Google UserInfo 失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Google UserInfo 返回状态码 {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Google UserInfo 响应失败：{e}"))?;
    Ok(AccountIdentity {
        email: body["email"].as_str().unwrap_or("").trim().to_string(),
        name: body["name"].as_str().unwrap_or("").trim().to_string(),
        picture: body["picture"].as_str().unwrap_or("").trim().to_string(),
        subject: body["sub"].as_str().unwrap_or("").trim().to_string(),
    })
}

async fn try_refresh_google_token(token_obj: &mut Map<String, Value>) -> Result<Option<Value>> {
    let refresh_token = match token_obj.get("refresh_token").and_then(Value::as_str).map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Ok(None),
    };
    let client_id = match token_obj.get("client_id").and_then(Value::as_str).map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Ok(None),
    };
    let mut form = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh_token),
        ("client_id".to_string(), client_id),
    ];
    if let Some(secret) = token_obj
        .get("client_secret")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        form.push(("client_secret".to_string(), secret.to_string()));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))?;
    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("刷新 Google OAuth Token 失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Google OAuth Token 刷新失败（HTTP {}）", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Google OAuth Token 响应失败：{e}"))?;
    if let Some(at) = body["access_token"].as_str() {
        token_obj.insert("access_token".into(), Value::String(at.to_string()));
    }
    if let Some(id_tok) = body["id_token"].as_str() {
        token_obj.insert("id_token".into(), Value::String(id_tok.to_string()));
    }
    if let Some(exp_in) = body["expires_in"].as_i64() {
        let expiry = (Utc::now() + chrono::Duration::seconds(exp_in)).to_rfc3339();
        token_obj.insert("expiry".into(), Value::String(expiry));
    }
    Ok(Some(body))
}

fn token_hint_from_obj(token_obj: &Map<String, Value>) -> String {
    let source = token_obj
        .get("refresh_token")
        .or_else(|| token_obj.get("access_token"))
        .or_else(|| token_obj.get("id_token"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let chars: Vec<char> = source.chars().collect();
    if chars.len() <= 8 {
        return "••••".into();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

fn upsert_account_record(
    explicit_id: Option<&str>,
    alias_input: Option<&str>,
    identity: &AccountIdentity,
    token_json: &str,
    token_obj: &Map<String, Value>,
    auth_source: &str,
) -> Result<AntigravityAccountState> {
    let encrypted = encrypt_secret_field(token_json)?;
    let has_refresh = token_obj
        .get("refresh_token")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    let hint = token_hint_from_obj(token_obj);
    let now = Utc::now().to_rfc3339();

    let _guard = store_lock().lock().map_err(|_| "账号存储锁不可用")?;
    let path = store_path()?;
    let mut store = load_store_from(&path)?;

    let existing_idx = explicit_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|id| store.accounts.iter().position(|a| a.id == id))
        .or_else(|| {
            if !identity.subject.is_empty() {
                store.accounts.iter().position(|a| a.subject == identity.subject)
            } else {
                None
            }
        })
        .or_else(|| {
            if !identity.email.is_empty() {
                store
                    .accounts
                    .iter()
                    .position(|a| a.email.eq_ignore_ascii_case(&identity.email))
            } else {
                None
            }
        });

    let default_alias = if !identity.name.is_empty() {
        identity.name.clone()
    } else if !identity.email.is_empty() {
        identity.email.clone()
    } else {
        "Antigravity 账号".into()
    };

    let account_id = if let Some(idx) = existing_idx {
        let rec = &mut store.accounts[idx];
        if let Some(a) = alias_input.map(str::trim).filter(|s| !s.is_empty()) {
            rec.alias = a.to_string();
        } else if rec.alias.trim().is_empty() {
            rec.alias = default_alias;
        }
        if !identity.email.is_empty() {
            rec.email = identity.email.clone();
        }
        if !identity.name.is_empty() {
            rec.name = identity.name.clone();
        }
        if !identity.picture.is_empty() {
            rec.picture = identity.picture.clone();
        }
        if !identity.subject.is_empty() {
            rec.subject = identity.subject.clone();
        }
        rec.auth_source = auth_source.to_string();
        rec.encrypted_token_json = encrypted;
        rec.has_refresh_token = has_refresh;
        rec.token_hint = hint;
        rec.updated_at = now;
        rec.id.clone()
    } else {
        let id = Uuid::new_v4().to_string();
        let alias = alias_input
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or(default_alias);
        store.accounts.push(AntigravityAccountRecord {
            id: id.clone(),
            alias,
            email: identity.email.clone(),
            name: identity.name.clone(),
            picture: identity.picture.clone(),
            subject: identity.subject.clone(),
            auth_source: auth_source.to_string(),
            encrypted_token_json: encrypted,
            has_refresh_token: has_refresh,
            token_hint: hint,
            updated_at: now,
        });
        id
    };

    save_store_to(&path, &store)?;
    if let Ok(root) = profiles_root() {
        let profile_dir = root.join(sanitize_account_dir_name(&account_id));
        let _ = materialize_profile_dir(&profile_dir, token_json);
    }
    Ok(to_state(&store))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_jwt(email: &str, name: &str, sub: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(
            json!({
                "email": email,
                "name": name,
                "sub": sub,
                "picture": "https://example.com/avatar.png"
            })
            .to_string(),
        );
        format!("{header}.{payload}.sig")
    }

    #[test]
    fn decodes_jwt_identity_without_network_calls() {
        let jwt = sample_jwt("alice@example.com", "Alice", "sub-123");
        let id = decode_jwt_identity(&jwt).expect("should decode jwt");
        assert_eq!(id.email, "alice@example.com");
        assert_eq!(id.name, "Alice");
        assert_eq!(id.subject, "sub-123");
        assert_eq!(id.picture, "https://example.com/avatar.png");
    }

    #[test]
    fn normalizes_camel_case_json_and_raw_tokens() {
        let obj = normalize_token_input(
            r#"{"accessToken":"ya29.abc","refreshToken":"1//xyz"}"#,
            Some("cid-1"),
            None,
        )
        .unwrap();
        assert_eq!(obj["access_token"], "ya29.abc");
        assert_eq!(obj["refresh_token"], "1//xyz");
        assert_eq!(obj["client_id"], "cid-1");

        let raw_refresh = normalize_token_input("1//refresh-only", None, None).unwrap();
        assert_eq!(raw_refresh["refresh_token"], "1//refresh-only");
    }

    #[test]
    fn extracts_google_oauth_url_from_cli_output() {
        let line = "Please open: https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&scope=openid";
        assert_eq!(
            extract_oauth_url(line).as_deref(),
            Some("https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&scope=openid")
        );
    }

    #[test]
    fn materializes_isolated_profile_dir_for_both_acp_and_cli() {
        let dir = std::env::temp_dir().join(format!("tb-agy-test-{}", Uuid::new_v4()));
        let token = r#"{"access_token":"ya29.secret","refresh_token":"1//ref"}"#;
        materialize_profile_dir(&dir, token).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("antigravity-acp/antigravity-oauth-token")).unwrap(),
            token
        );
        assert_eq!(
            fs::read_to_string(dir.join("antigravity-cli/antigravity-oauth-token")).unwrap(),
            token
        );
        assert!(dir.join("antigravity-acp/cache/antigravity-keyring-unavailable").is_file());
        assert!(dir.join("antigravity-cli/cache/antigravity-keyring-unavailable").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_isolated_cli_command_contains_gemini_home_and_no_secrets() {
        let cmd = format_isolated_cli_command("/tmp/profile-a", "agy --dangerously-skip-permissions");
        assert!(cmd.contains("GEMINI_HOME"));
        assert!(cmd.contains("/tmp/profile-a"));
        assert!(cmd.contains("AGY_ACP_FORCE_FILE_STORAGE"));
        assert!(cmd.contains("agy --dangerously-skip-permissions"));
    }
}
