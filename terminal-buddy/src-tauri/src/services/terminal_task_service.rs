//! 将终端关联到确切的 AI 会话；不能用项目目录的「最新会话」代替当前会话。
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use rusqlite::OptionalExtension;
use serde::Serialize;

use super::{claude_history_service, codex_history_service, codex_transcript, pi_history_service, pi_transcript, DatabaseService, PathService};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTaskSummary {
    pub provider: String,
    pub session_id: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Clone, Default)]
struct TrackedTerminal {
    revision: u64,
    started_at: Option<SystemTime>,
    last_process_scan: Option<SystemTime>,
    cwd: Option<String>,
    /// 终端启动过/输入过 pi：目录扫描兜底只对这类终端生效，避免把其他会话误绑。
    pi_candidate: bool,
    claude_root: PathBuf,
    codex_root: PathBuf,
    pi_root: PathBuf,
    codex_log_dir: Option<PathBuf>,
    log_offset: u64,
    log_pending: String,
    binding: Option<(String, String)>,
    prompt: Option<String>,
    transcript: Option<PathBuf>,
    stamp: Option<(SystemTime, u64)>,
    title: Option<String>,
    model: Option<String>,
}

fn terminals() -> &'static Mutex<HashMap<String, TrackedTerminal>> {
    static TERMINALS: OnceLock<Mutex<HashMap<String, TrackedTerminal>>> = OnceLock::new();
    TERMINALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn env_root(env: &[(String, String)], key: &str, fallback: PathBuf, cwd: Option<&str>) -> PathBuf {
    let root = match env.iter().find(|(name, _)| name.eq_ignore_ascii_case(key)) {
        Some((_, value)) if !value.trim().is_empty() => PathBuf::from(value),
        Some(_) => fallback,
        None => std::env::var_os(key).filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or(fallback),
    };
    if root.is_absolute() { root } else { Path::new(cwd.unwrap_or(".")).join(root) }
}

/// Pi 会话根目录：PI_CODING_AGENT_SESSION_DIR → PI_CODING_AGENT_DIR/sessions → 默认。
fn pi_root(env: &[(String, String)], cwd: Option<&str>) -> PathBuf {
    if env.iter().any(|(name, _)| name.eq_ignore_ascii_case("PI_CODING_AGENT_SESSION_DIR")) {
        let fallback = pi_history_service::resolve_session_root().unwrap_or_default();
        return env_root(env, "PI_CODING_AGENT_SESSION_DIR", fallback, cwd);
    }
    if env.iter().any(|(name, _)| name.eq_ignore_ascii_case("PI_CODING_AGENT_DIR")) {
        let agent = env_root(env, "PI_CODING_AGENT_DIR", dirs::home_dir().unwrap_or_default().join(".pi/agent"), cwd);
        return agent.join("sessions");
    }
    pi_history_service::resolve_session_root().unwrap_or_else(|_| {
        dirs::home_dir().unwrap_or_default().join(".pi/agent/sessions")
    })
}

/// 只识别命令首个可执行 token 为 `pi` 的简单形式；复杂 shell 片段交给扩展/扫描。
fn pi_executable_end(command: &str) -> Option<usize> {
    // 命令拼接、管道、脚本包装一律跳过注入，保持原命令语义。
    if command.contains("&&") || command.contains("||") || command.contains(';') || command.contains('|') {
        return None;
    }
    let mut start = command.len() - command.trim_start().len();
    if command[start..].starts_with("& ") { start += 2; }
    if command[start..].get(..5).is_some_and(|s| s.eq_ignore_ascii_case("call ")) { start += 5; }
    start += command[start..].len() - command[start..].trim_start().len();
    let first = *command.as_bytes().get(start)?;
    let (token, end) = if matches!(first, b'\'' | b'"') {
        let end = start + 1 + command[start + 1..].find(first as char)?;
        (&command[start + 1..end], end + 1)
    } else {
        let end = command[start..].find(char::is_whitespace).map_or(command.len(), |n| start + n);
        (&command[start..end], end)
    };
    let name = token.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    matches!(name.as_str(), "pi" | "pi.exe" | "pi.cmd" | "pi.bat").then_some(end)
}

/// `__TB_PI_REF__:<provider>:<model>[:thinking]` → `pi --provider ... --model ...`。
/// 模型 ID 可能自带冒号（如 `cn:mimo-v2.6-pro`）：provider 取首个冒号前，
/// 仅当末段恰为合法思考级别时才剥离为 thinking，其余冒号段全部归 model。
/// 模型 ID 只允许安全字符，避免把任意文本拼进启动命令。
fn expand_pi_ref(command: &str) -> String {
    const PREFIX: &str = "__TB_PI_REF__:";
    let trimmed = command.trim_start();
    let Some(rest) = trimmed.strip_prefix(PREFIX) else { return command.to_string(); };
    let mut parts = rest.splitn(2, char::is_whitespace);
    let reference = parts.next().unwrap_or_default();
    let tail = parts.next().unwrap_or_default().trim();
    let Some((provider, mut model)) = reference.split_once(':') else { return command.to_string(); };
    let mut thinking = None;
    if let Some((head, level)) = model.rsplit_once(':') {
        if matches!(level, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") {
            thinking = Some(level);
            model = head;
        }
    }
    let safe = |value: &str| !value.is_empty()
        && value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':'));
    if !safe(provider) || !safe(model) {
        return command.to_string();
    }
    // 剔除与引用冲突的参数（模型/供应商/思考级别/密钥）。
    let cleaned = tail
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = strip_pi_conflict_args(&cleaned);
    let mut result = format!("pi --provider {provider} --model {model}");
    if let Some(thinking) = thinking {
        result.push_str(&format!(" --thinking {thinking}"));
    }
    if !cleaned.is_empty() {
        result.push(' ');
        result.push_str(&cleaned);
    }
    result
}

fn strip_pi_conflict_args(args: &str) -> String {
    let tokens: Vec<&str> = args.split_whitespace().collect();
    let mut result = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        let flag = token.split('=').next().unwrap_or(token);
        if matches!(flag, "--model" | "--provider" | "--thinking" | "--models" | "--api-key") {
            if !token.contains('=') { index += 1; }
            index += 1;
            continue;
        }
        result.push(token);
        index += 1;
    }
    result.join(" ")
}

/// 存活终端的当前绑定快照，供服务端周期性写入统一登记表。
pub fn session_bindings() -> HashMap<String, super::claude_session_registry_service::AgentSessionRecord> {
    let now = std::time::SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    terminals()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .filter_map(|(terminal_id, tracked)| {
            let (provider, session_id) = tracked.binding.clone()?;
            Some((terminal_id.clone(), super::claude_session_registry_service::AgentSessionRecord {
                provider,
                session_id,
                session_file: tracked.transcript.as_ref().map(|path| path.to_string_lossy().into_owned()),
                cwd: tracked.cwd.clone(),
                updated_at: now,
            }))
        })
        .collect()
}

/// 运行中的 Pi 会话：绑定表里仍存在该 session ID 即视为活动。
pub fn is_agent_session_active(session_id: &str) -> bool {
    terminals()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .values()
        .any(|tracked| tracked.binding.as_ref().is_some_and(|(_, id)| id == session_id))
}

// 只识别启动命令的可执行文件，避免误改提示词、echo、管道或脚本中的 codex 字样。
fn codex_executable_end(command: &str) -> Option<usize> {
    let mut start = command.len() - command.trim_start().len();
    if command[start..].starts_with("& ") { start += 2; }
    if command[start..].get(..5).is_some_and(|s| s.eq_ignore_ascii_case("call ")) { start += 5; }
    start += command[start..].len() - command[start..].trim_start().len();
    let first = *command.as_bytes().get(start)?;
    let (token, end) = if matches!(first, b'\'' | b'"') {
        let end = start + 1 + command[start + 1..].find(first as char)?;
        (&command[start + 1..end], end + 1)
    } else {
        let end = command[start..].find(char::is_whitespace).map_or(command.len(), |n| start + n);
        (&command[start..end], end)
    };
    let name = token.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    matches!(name.as_str(), "codex" | "codex.exe" | "codex.cmd" | "codex.bat").then_some(end)
}

fn bind(tracked: &mut TrackedTerminal, provider: &str, session_id: &str) {
    if uuid::Uuid::parse_str(session_id).is_err() { return; }
    if tracked.binding.as_ref().is_some_and(|(p, id)| p == provider && id == session_id) { return; }
    tracked.revision = tracked.revision.wrapping_add(1);
    tracked.binding = Some((provider.to_string(), session_id.to_string()));
    tracked.transcript = None;
    tracked.stamp = None;
    tracked.title = None;
    tracked.model = None;
    tracked.prompt = None;
}

/// 仅改变本次 Codex 的日志位置，配置、认证和历史仍使用原来的 CODEX_HOME。
/// 无论显示开关是否打开都记录关联，保证运行中的窗口也能随时开启摘要。
pub fn prepare_launch(
    terminal_id: &str, terminal_type: &str, cwd: Option<&str>,
    env: &[(String, String)], commands: Vec<String>,
) -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut tracked = TrackedTerminal {
        started_at: Some(SystemTime::now()),
        cwd: cwd.map(str::to_string),
        claude_root: env_root(env, "CLAUDE_CONFIG_DIR", home.join(".claude"), cwd),
        codex_root: env_root(env, "CODEX_HOME", home.join(".codex"), cwd),
        pi_root: pi_root(env, cwd),
        ..Default::default()
    };
    let local = matches!(terminal_type, "cmd" | "powershell" | "pwsh" | "bash" | "sh" | "zsh");
    let extension = crate::services::pi_extension_service::ensure_extension().ok();
    let commands = commands.into_iter().map(|command| {
        if !local { return command; }
        let command = expand_pi_ref(&command);
        if let Some(end) = pi_executable_end(&command) {
            tracked.pi_candidate = true;
            let mut args = command[end..].to_string();
            // 未显式指定扩展时注入 TerminalBuddy 扩展（精确绑定/状态上报）。
            let has_extension = args.split_whitespace().any(|token| {
                token == "--extension" || token == "-e" || token.starts_with("--extension=")
            });
            if !has_extension {
                if let Some(extension) = &extension {
                    let quoted = extension.to_string_lossy().replace('"', "\\\"");
                    args.push_str(&format!(" --extension \"{quoted}\""));
                }
            }
            // 恢复会话：命令自带 --session <id> 时直接绑定；新启动不注入会话参数，
            // 绑定由 Pi 扩展上报与目录扫描兜底完成。
            if let Some(id) = pi_session_arg(&args) {
                if uuid::Uuid::parse_str(&id).is_ok() {
                    bind(&mut tracked, "pi", &id);
                }
            }
            return format!("{}{}", &command[..end], args);
        }
        let Some(end) = codex_executable_end(&command) else { return command; };
        let args: Vec<_> = command[end..].split_whitespace().collect();
        if let Some(id) = args.windows(2).find(|pair| pair[0] == "resume").map(|pair| pair[1]) {
            bind(&mut tracked, "codex", id.trim_matches(['\'', '"']));
        }
        let Ok(data_dir) = PathService::require_data_dir() else { return command; };
        let log_dir = data_dir.join("TaskSessions").join(terminal_id);
        let path = log_dir.to_string_lossy();
        // TOML 字面量字符串；不让特殊路径改变原命令的含义。
        if path.contains(['\'', '"', '\r', '\n', '\0']) || (terminal_type == "cmd" && path.contains(['%', '!'])) {
            return command;
        }
        if fs::create_dir_all(&log_dir).is_err() { return command; }
        let config = format!("log_dir='{}'", path);
        let argument = if terminal_type == "cmd" {
            format!("\"{}\"", config)
        } else {
            format!("'{}'", config.replace('\'', if matches!(terminal_type, "powershell" | "pwsh") { "''" } else { "'\\''" }))
        };
        tracked.codex_log_dir = Some(log_dir);
        format!("{} -c {}{}", &command[..end], argument, &command[end..])
    }).collect();
    terminals().lock().unwrap_or_else(|e| e.into_inner()).insert(terminal_id.to_string(), tracked);
    commands
}

fn pi_session_arg(args: &str) -> Option<String> {
    let tokens: Vec<_> = args.split_whitespace().collect();
    for (index, token) in tokens.iter().enumerate() {
        let token = token.trim_matches(['\'', '"']);
        if let Some(value) = token.strip_prefix("--session=") {
            return Some(value.trim_matches(['\'', '"']).to_string());
        }
        if matches!(token, "--session" | "--session-id") {
            return tokens.get(index + 1).map(|value| value.trim_matches(['\'', '"']).to_string());
        }
    }
    None
}

/// 终端 cd 后更新扫描兜底使用的 cwd（手动启动 Pi 时按目录找会话）。
pub fn update_cwd(terminal_id: &str, directory: &str) {
    let mut all = terminals().lock().unwrap_or_else(|error| error.into_inner());
    if let Some(tracked) = all.get_mut(terminal_id) {
        if tracked.cwd.as_deref() != Some(directory) {
            tracked.cwd = Some(directory.to_string());
            tracked.transcript = None;
            tracked.stamp = None;
        }
    }
}

/// 记录用户在终端里敲过 `pi`（用于手动启动时的目录扫描兜底）。
pub fn note_terminal_input(terminal_id: &str, data: &str) {
    let runs_pi = data
        .split(['\r', '\n'])
        .any(|line| line.trim_start().starts_with("pi ") || line.trim() == "pi");
    if !runs_pi { return; }
    let mut all = terminals().lock().unwrap_or_else(|error| error.into_inner());
    if let Some(tracked) = all.get_mut(terminal_id) {
        tracked.pi_candidate = true;
    }
}

pub fn record_agent_session(terminal_id: &str, provider: &str, session_id: &str, session_file: Option<&str>) {    let mut all = terminals().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tracked) = all.get_mut(terminal_id) {
        bind(tracked, provider, session_id);
        if let Some(file) = session_file.filter(|file| !file.trim().is_empty()) {
            let path = PathBuf::from(file);
            if path.is_file() {
                tracked.transcript = Some(path);
            }
        }
    }
}

pub fn record_claude_session(terminal_id: &str, session_id: &str, prompt: Option<&str>) {
    let mut all = terminals().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tracked) = all.get_mut(terminal_id) {
        bind(tracked, "claude", session_id);
        if tracked.prompt.is_none() {
            tracked.prompt = prompt.and_then(compact_title);
            if tracked.prompt.is_some() { tracked.revision = tracked.revision.wrapping_add(1); }
        }
    }
}

pub fn forget_terminal(terminal_id: &str) -> Option<PathBuf> {
    let tracked = terminals().lock().unwrap_or_else(|e| e.into_inner()).remove(terminal_id);
    tracked.and_then(|tracked| tracked.codex_log_dir)
}

fn compact_title(value: &str) -> Option<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() { return None; }
    Some(codex_transcript::excerpt(&value, 80))
}

fn read_codex_binding(tracked: &mut TrackedTerminal) {
    let Some(dir) = &tracked.codex_log_dir else { return; };
    let Ok(mut file) = File::open(dir.join("codex-tui.log")) else { return; };
    let Ok(metadata) = file.metadata() else { return; };
    if metadata.len() < tracked.log_offset {
        tracked.log_offset = 0;
        tracked.log_pending.clear();
    }
    // 日志可很大：每次只取新增部分，首次取最后 256 KiB。
    let start = tracked.log_offset.max(metadata.len().saturating_sub(256 * 1024));
    if file.seek(SeekFrom::Start(start)).is_err() { return; }
    let mut bytes = Vec::new();
    if file.take(256 * 1024).read_to_end(&mut bytes).is_err() { return; }
    tracked.log_offset = start + bytes.len() as u64;
    let content = format!("{}{}", tracked.log_pending, String::from_utf8_lossy(&bytes));
    let Some(end) = content.rfind('\n') else {
        tracked.log_pending = content.chars().take(8192).collect();
        return;
    };
    tracked.log_pending = content[end + 1..].to_string();
    for line in content[..end].lines() {
        // 嵌套子代理 span 可能还有 thread_id，只取最外层 session_loop 的 ID。
        let Some(rest) = line.split_once("session_loop{thread_id=").map(|(_, rest)| rest) else { continue; };
        if let Some(id) = rest.get(..36).filter(|id| uuid::Uuid::parse_str(id).is_ok()) {
            bind(tracked, "codex", id);
        }
    }
}

fn find_transcript(root: &Path, provider: &str, id: &str) -> Option<PathBuf> {
    if provider == "pi" {
        return pi_history_service::find_session_file(root, id);
    }
    let wanted = if provider == "claude" { format!("{}.jsonl", id) } else { format!("-{}.jsonl", id) };
    let mut dirs = vec![root.join(if provider == "claude" { "projects" } else { "sessions" })];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(dir) else { continue; };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue; };
            if kind.is_dir() { dirs.push(entry.path()); }
            else if kind.is_file() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if (provider == "claude" && name == wanted) || (provider == "codex" && name.ends_with(&wanted)) {
                    return Some(entry.path());
                }
            }
        }
    }
    None
}

/// 标题在头部或尾部；限制读取量，避免每次把整个长对话加载进内存。
fn transcript_excerpt(path: &Path) -> Option<String> {
    const PART: u64 = 512 * 1024;
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let mut head = Vec::new();
    (&mut file).take(PART).read_to_end(&mut head).ok()?;
    if length > PART {
        // 不把截断的 JSON 行与尾部粘在一起。
        if let Some(end) = head.iter().rposition(|b| *b == b'\n') { head.truncate(end + 1); }
        file.seek(SeekFrom::Start(PART.max(length.saturating_sub(PART)))).ok()?;
        let mut tail = Vec::new();
        file.take(PART).read_to_end(&mut tail).ok()?;
        if let Some(start) = tail.iter().position(|b| *b == b'\n') { head.extend_from_slice(&tail[start..]); }
    }
    Some(String::from_utf8_lossy(&head).into_owned())
}

fn resolve_title(
    tracked: &mut TrackedTerminal,
    registries: &mut HashMap<PathBuf, HashMap<String, String>>,
) -> Option<TerminalTaskSummary> {
    let (provider, id) = tracked.binding.clone()?;
    let root = match provider.as_str() {
        "claude" => &tracked.claude_root,
        "pi" => &tracked.pi_root,
        _ => &tracked.codex_root,
    };
    let conn = DatabaseService::open().ok();
    let custom = conn.as_ref().and_then(|conn| {
        let sql = match provider.as_str() {
            "claude" => "SELECT custom_title FROM claude_session_meta WHERE session_id=?1",
            "pi" => "SELECT custom_title FROM pi_session_meta WHERE session_id=?1",
            _ => "SELECT custom_title FROM codex_session_meta WHERE session_id=?1",
        };
        conn.query_row(sql, [&id], |row| row.get::<_, Option<String>>(0)).optional().ok().flatten().flatten()
    }).and_then(|value| compact_title(&value));
    if tracked.transcript.as_ref().map_or(true, |path| !path.is_file()) {
        tracked.transcript = find_transcript(root, &provider, &id);
    }
    if let Some(path) = &tracked.transcript {
        let stamp = fs::metadata(path).ok().and_then(|meta| Some((meta.modified().ok()?, meta.len())));
        if stamp.is_some() && stamp != tracked.stamp {
            if let Some(content) = transcript_excerpt(path) {
                let (title, model) = match provider.as_str() {
                    "claude" => {
                        let analysis = claude_history_service::analyze_transcript(&content);
                        let title = claude_history_service::display_title(None, analysis.title.as_deref(), analysis.first_prompt.as_deref(), "");
                        (compact_title(&title), analysis.model)
                    }
                    "pi" => {
                        let transcript = pi_transcript::parse(&content);
                        (transcript.title.and_then(|value| compact_title(&value)), transcript.model)
                    }
                    _ => {
                        let transcript = codex_transcript::parse(&content);
                        (transcript.title.and_then(|value| compact_title(&value)), transcript.model)
                    }
                };
                tracked.title = title;
                tracked.model = model;
                tracked.stamp = stamp;
            }
        }
    }
    let registry = if provider == "codex" {
        registries.entry(root.clone()).or_insert_with(|| codex_history_service::thread_names(root)).get(&id).cloned()
    } else { None };
    let summary = custom.or(registry).or_else(|| tracked.title.clone()).or_else(|| tracked.prompt.clone())?;
    Some(TerminalTaskSummary { provider, session_id: id, summary, model: tracked.model.clone() })
}

/// 原生 AI 会话复用桌面端的摘要来源，缓存确切会话的文件位置与修改时间。
#[derive(Default)]
pub struct SessionSummaryTracker {
    tracked: TrackedTerminal,
    last_refresh: Option<Instant>,
}

impl SessionSummaryTracker {
    pub fn refresh(&mut self, provider: &str, session_id: &str, cwd: &str, force: bool) -> Option<String> {
        if !matches!(provider, "claude" | "codex" | "pi") || uuid::Uuid::parse_str(session_id).is_err() { return None; }
        let home = dirs::home_dir().unwrap_or_default();
        let claude_root = env_root(&[], "CLAUDE_CONFIG_DIR", home.join(".claude"), Some(cwd));
        let codex_root = env_root(&[], "CODEX_HOME", home.join(".codex"), Some(cwd));
        let pi_root = pi_root(&[], Some(cwd));
        if self.tracked.claude_root != claude_root || self.tracked.codex_root != codex_root || self.tracked.pi_root != pi_root {
            self.tracked = TrackedTerminal { cwd: Some(cwd.to_string()), claude_root, codex_root, pi_root, ..Default::default() };
            self.last_refresh = None;
        }
        if self.tracked.binding.as_ref().map_or(true, |(p, id)| p != provider || id != session_id) {
            bind(&mut self.tracked, provider, session_id);
            self.last_refresh = None;
        }
        // 多个客户端共用检查间隔；流式消息仍可每 300ms 推送一次。
        if !force && self.last_refresh.is_some_and(|last| last.elapsed() < Duration::from_secs(2)) { return None; }
        let summary = resolve_title(&mut self.tracked, &mut HashMap::new()).map(|task| task.summary);
        self.last_refresh = Some(Instant::now());
        summary
    }
}

fn normalize_cwd(value: &str) -> String {
    value.trim().trim_end_matches(['/', '\\']).replace('\\', "/").to_ascii_lowercase()
}

/// 目录扫描兜底：只绑定启动后修改、cwd 匹配且唯一候选的 Pi 会话；多候选不猜。
fn discover_pi_session(tracked: &TrackedTerminal) -> Option<(String, PathBuf)> {
    let cwd = tracked.cwd.as_deref().map(normalize_cwd)?;
    let started = tracked.started_at.unwrap_or(SystemTime::UNIX_EPOCH);
    let since = started.checked_sub(Duration::from_secs(5)).unwrap_or(SystemTime::UNIX_EPOCH);
    let mut dirs = vec![tracked.pi_root.clone()];
    let mut candidates: HashMap<String, PathBuf> = HashMap::new();
    let mut visited = 0_usize;
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(dir) else { continue; };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 5000 { return None; }
            let Ok(kind) = entry.file_type() else { continue; };
            if kind.is_dir() { dirs.push(entry.path()); continue; }
            if !kind.is_file() || entry.path().extension().map_or(true, |ext| ext != "jsonl") { continue; }
            if entry.metadata().and_then(|meta| meta.modified()).is_ok_and(|modified| modified < since) { continue; }
            let path = entry.path();
            let Ok(file) = File::open(&path) else { continue; };
            let mut first = String::new();
            if BufReader::new(file).read_line(&mut first).is_err() { continue; }
            let Ok(header) = serde_json::from_str::<serde_json::Value>(&first) else { continue; };
            if header.get("type").and_then(serde_json::Value::as_str) != Some("session") { continue; }
            let Some(header_cwd) = header.get("cwd").and_then(serde_json::Value::as_str) else { continue; };
            if normalize_cwd(header_cwd) != cwd { continue; }
            let Some(id) = header.get("id").and_then(serde_json::Value::as_str) else { continue; };
            if uuid::Uuid::parse_str(id).is_err() { continue; }
            candidates.insert(id.to_string(), path);
        }
    }
    if candidates.len() == 1 { candidates.into_iter().next() } else { None }
}

pub fn summaries(terminal_pids: Vec<(String, u32)>) -> HashMap<String, TerminalTaskSummary> {
    // 扫描可同时由手机和桌面发起；串行扫描，但不持有 Hook 使用的关联表锁。
    static SCAN_LOCK: Mutex<()> = Mutex::new(());
    let _scan = SCAN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all: HashMap<_, _> = {
        let current = terminals().lock().unwrap_or_else(|e| e.into_inner());
        terminal_pids.iter().filter_map(|(id, _)| current.get(id).map(|tracked| (id.clone(), tracked.clone()))).collect()
    };
    let revisions: HashMap<_, _> = all.iter().map(|(id, tracked)| (id.clone(), tracked.revision)).collect();
    let roots = terminal_pids.iter().filter_map(|(id, _)| all.get(id).map(|tracked| (id.clone(), tracked.claude_root.clone()))).collect();
    let claude_sessions = crate::commands::claude_session::discover_claude_sessions(&terminal_pids, &roots);
    let scopes = terminal_pids.iter().filter_map(|(id, pid)| {
        let tracked = all.get(id)?;
        Some(super::terminal_task_process::CodexProcessScope {
            terminal_id: id.clone(), process_id: *pid, root: tracked.codex_root.clone(),
            started_at: tracked.last_process_scan.or(tracked.started_at).unwrap_or(SystemTime::UNIX_EPOCH)
                .checked_sub(std::time::Duration::from_secs(5)).unwrap_or(SystemTime::UNIX_EPOCH),
        })
    }).collect();
    let codex_sessions = super::terminal_task_process::discover(scopes);
    let mut registries = HashMap::new();
    let mut result = HashMap::new();
    for (terminal_id, _) in terminal_pids {
        let Some(tracked) = all.get_mut(&terminal_id) else { continue; };
        tracked.last_process_scan = Some(SystemTime::now());
        read_codex_binding(tracked);
        if tracked.binding.is_none() && tracked.pi_candidate {
            if let Some((id, path)) = discover_pi_session(tracked) {
                bind(tracked, "pi", &id);
                tracked.transcript = Some(path);
            }
        }
        if let Some((id, path)) = codex_sessions.get(&terminal_id) {
            bind(tracked, "codex", id);
            tracked.transcript = Some(path.clone());
        }
        if let Some(id) = claude_sessions.get(&terminal_id) { bind(tracked, "claude", id); }
        if let Some(summary) = resolve_title(tracked, &mut registries) { result.insert(terminal_id, summary); }
    }
    let mut current = terminals().lock().unwrap_or_else(|e| e.into_inner());
    for (id, tracked) in all {
        if let Some(existing) = current.get_mut(&id).filter(|entry| Some(&entry.revision) == revisions.get(&id)) {
            *existing = tracked;
        } else {
            // 扫描期间会话已切换或终端已关闭，不返回过期标题。
            result.remove(&id);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_simple_pi_commands_without_touching_shell_fragments() {
        assert_eq!(pi_executable_end("pi --approve"), Some(2));
        assert_eq!(pi_executable_end("  pi -p \"hello\""), Some(4));
        assert_eq!(pi_executable_end("pi.cmd --session-id abc"), Some(6));
        assert!(pi_executable_end("echo pi").is_none());
        assert!(pi_executable_end("pi --approve && echo done").is_none());
        assert!(pi_executable_end("cd /work; pi").is_none());
        assert!(pi_executable_end("codex resume x").is_none());
    }

    #[test]
    fn extracts_pi_session_arg_for_resume_binding() {
        assert_eq!(pi_session_arg("--session-id 01900000-0000-7000-8000-000000000001"), Some("01900000-0000-7000-8000-000000000001".to_string()));
        assert_eq!(pi_session_arg("--session 01900000-0000-7000-8000-000000000002"), Some("01900000-0000-7000-8000-000000000002".to_string()));
        assert_eq!(pi_session_arg("--session=/tmp/a.jsonl"), Some("/tmp/a.jsonl".to_string()));
        assert_eq!(pi_session_arg("--approve --model x"), None);
    }

    #[test]
    fn expands_pi_model_refs_and_strips_conflicting_flags() {
        let expanded = expand_pi_ref("__TB_PI_REF__:anthropic:claude-sonnet-4-5:high --approve --model old --thinking low");
        assert!(expanded.starts_with("pi --provider anthropic --model claude-sonnet-4-5 --thinking high"), "{expanded}");
        assert!(expanded.contains("--approve"));
        assert!(!expanded.contains("--model old"));
        assert!(!expanded.contains("--thinking low"));
        assert_eq!(expand_pi_ref("pi --approve"), "pi --approve");
        assert_eq!(expand_pi_ref("__TB_PI_REF__:bad provider:model"), "__TB_PI_REF__:bad provider:model");
    }

    #[test]
    fn expands_pi_model_refs_with_colons_in_model_ids() {
        // 模型 ID 自带冒号时不能被当成 provider/thinking 拆散（如 sub2api 的 `cn:mimo-v2.6-pro`）。
        assert_eq!(
            expand_pi_ref("__TB_PI_REF__:sub2api:cn:mimo-v2.6-pro --approve"),
            "pi --provider sub2api --model cn:mimo-v2.6-pro --approve"
        );
        assert_eq!(
            expand_pi_ref("__TB_PI_REF__:sub2api:cn:deepseek-v4.1-flash:high"),
            "pi --provider sub2api --model cn:deepseek-v4.1-flash --thinking high"
        );
    }

    #[test]
    fn normalizes_cwds_for_pi_scan_fallback() {
        assert_eq!(normalize_cwd(r"D:\Work\Demo\"), "d:/work/demo");
        assert_eq!(normalize_cwd("/workspace/demo/"), "/workspace/demo");
        assert_ne!(normalize_cwd("/workspace/demo"), normalize_cwd("/workspace/demo2"));
    }
}
