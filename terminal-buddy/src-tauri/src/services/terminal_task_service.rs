//! 将终端关联到确切的 AI 会话；不能用项目目录的「最新会话」代替当前会话。
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use rusqlite::OptionalExtension;
use serde::Serialize;

use super::{
    antigravity_history_service, antigravity_transcript, claude_history_service,
    codex_history_service, codex_transcript, DatabaseService, PathService,
};

const ANTIGRAVITY_STARTUP_GRACE: Duration = Duration::from_secs(12);

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
pub struct TerminalLaunchHints {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone, Default)]
struct TrackedTerminal {
    revision: u64,
    started_at: Option<SystemTime>,
    last_process_scan: Option<SystemTime>,
    cwd: Option<String>,
    claude_root: PathBuf,
    codex_root: PathBuf,
    antigravity_root: PathBuf,
    codex_log_dir: Option<PathBuf>,
    log_offset: u64,
    log_pending: String,
    launch_provider: Option<String>,
    launch_model: Option<String>,
    launch_effort: Option<String>,
    antigravity_seen_alive: bool,
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

pub fn is_agent_session_active(session_id: &str) -> bool {
    terminals()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .values()
        .any(|tracked| tracked.binding.as_ref().is_some_and(|(_, id)| id == session_id))
}

// 只识别启动命令的可执行文件，避免误改提示词、echo、管道或脚本中的 codex / agy 字样。
fn leading_executable(command: &str) -> Option<(String, usize)> {
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
    Some((name, end))
}

fn codex_executable_end(command: &str) -> Option<usize> {
    let (name, end) = leading_executable(command)?;
    matches!(name.as_str(), "codex" | "codex.exe" | "codex.cmd" | "codex.bat").then_some(end)
}

fn extract_inline_env_var(command: &str, var_name: &str) -> Option<String> {
    // PowerShell: $env:VAR='value' 或 $env:VAR="value"
    let ps_prefix = format!("$env:{var_name}=");
    if let Some(pos) = command.find(&ps_prefix) {
        let rest = &command[pos + ps_prefix.len()..];
        if let Some(after_quote) = rest.strip_prefix('\'') {
            let mut val = String::new();
            let mut chars = after_quote.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\'' {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                        val.push('\'');
                    } else {
                        break;
                    }
                } else {
                    val.push(c);
                }
            }
            if !val.trim().is_empty() {
                return Some(val);
            }
        } else if let Some(after_quote) = rest.strip_prefix('"') {
            if let Some(end) = after_quote.find('"') {
                let val = &after_quote[..end];
                if !val.trim().is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    // POSIX: VAR='value' 或 VAR="value"（要求位于行首或空白/分号之后，避免误匹配子串）
    let posix_prefix = format!("{var_name}=");
    let mut search_start = 0;
    while let Some(rel) = command[search_start..].find(&posix_prefix) {
        let pos = search_start + rel;
        let boundary_ok = pos == 0
            || matches!(
                command.as_bytes()[pos - 1],
                b' ' | b'\t' | b';' | b'\n' | b'&'
            );
        search_start = pos + posix_prefix.len();
        if !boundary_ok {
            continue;
        }
        let rest = &command[search_start..];
        if let Some(after_quote) = rest.strip_prefix('\'') {
            let mut val = String::new();
            let mut i = 0;
            let bytes = after_quote.as_bytes();
            while i < bytes.len() {
                if after_quote[i..].starts_with("'\\''") {
                    val.push('\'');
                    i += 4;
                } else if bytes[i] == b'\'' {
                    break;
                } else if let Some(ch) = after_quote[i..].chars().next() {
                    val.push(ch);
                    i += ch.len_utf8();
                } else {
                    break;
                }
            }
            if !val.trim().is_empty() {
                return Some(val);
            }
        } else if let Some(after_quote) = rest.strip_prefix('"') {
            if let Some(end) = after_quote.find('"') {
                let val = &after_quote[..end];
                if !val.trim().is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

fn resolve_antigravity_root_from_command(command: &str) -> Option<PathBuf> {
    if let Some(cli_home) = extract_inline_env_var(command, "ANTIGRAVITY_CLI_HOME") {
        return Some(PathBuf::from(cli_home));
    }
    if let Some(gemini_home) = extract_inline_env_var(command, "GEMINI_HOME") {
        return Some(PathBuf::from(gemini_home).join("antigravity-cli"));
    }
    if let Some(home) = extract_inline_env_var(command, "USERPROFILE")
        .or_else(|| extract_inline_env_var(command, "HOME"))
    {
        return Some(PathBuf::from(home).join(".gemini").join("antigravity-cli"));
    }
    None
}

fn skip_leading_env_assignments(command: &str) -> usize {
    let mut offset = 0;
    loop {
        let rest = &command[offset..];
        let trimmed_len = rest.len() - rest.trim_start().len();
        offset += trimmed_len;
        let rest = &command[offset..];
        if rest.is_empty() {
            break;
        }
        // PowerShell: $env:NAME=...;
        if rest.starts_with("$env:") {
            let mut quote: Option<char> = None;
            let mut end = None;
            let mut chars = rest.char_indices().peekable();
            while let Some((idx, c)) = chars.next() {
                if let Some(q) = quote {
                    if c == q {
                        if q == '\'' && chars.peek().is_some_and(|(_, next)| *next == '\'') {
                            chars.next();
                        } else {
                            quote = None;
                        }
                    }
                } else if c == '\'' || c == '"' {
                    quote = Some(c);
                } else if c == ';' {
                    end = Some(idx + 1);
                    break;
                }
            }
            if let Some(e) = end {
                offset += e;
                continue;
            }
            break;
        }
        // POSIX: NAME=VALUE ...
        let bytes = rest.as_bytes();
        let mut eq_idx = None;
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'=' && i > 0 {
                eq_idx = Some(i);
                break;
            }
            if !(b.is_ascii_alphanumeric() || b == b'_') {
                break;
            }
        }
        if let Some(eq) = eq_idx {
            let mut quote: Option<char> = None;
            let mut end = rest.len();
            let mut i = eq + 1;
            while i < rest.len() {
                if let Some(q) = quote {
                    if q == '\'' && rest[i..].starts_with("'\\''") {
                        i += 4;
                        continue;
                    }
                    let ch = rest[i..].chars().next().unwrap();
                    i += ch.len_utf8();
                    if ch == q {
                        quote = None;
                    }
                } else {
                    let ch = rest[i..].chars().next().unwrap();
                    if ch.is_whitespace() {
                        end = i;
                        break;
                    }
                    if ch == '\'' || ch == '"' {
                        quote = Some(ch);
                    }
                    i += ch.len_utf8();
                }
            }
            offset += end;
            continue;
        }
        break;
    }
    offset
}

fn agy_executable_end(command: &str) -> Option<usize> {
    if let Some((name, end)) = leading_executable(command) {
        if matches!(name.as_str(), "agy" | "agy.exe" | "agy.cmd" | "agy.bat" | "agy.ps1") {
            return Some(end);
        }
    }
    let offset = skip_leading_env_assignments(command);
    if offset > 0 && offset < command.len() {
        let (name, end) = leading_executable(&command[offset..])?;
        if matches!(name.as_str(), "agy" | "agy.exe" | "agy.cmd" | "agy.bat" | "agy.ps1") {
            return Some(offset + end);
        }
    }
    None
}

fn tokenize_cli_args(rest: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut chars = rest.chars().peekable();
    while let Some(&ch) = chars.peek() {
        if ch.is_whitespace() {
            chars.next();
            continue;
        }
        if matches!(ch, ';' | '|') {
            break;
        }
        if ch == '&' {
            let mut lookahead = chars.clone();
            lookahead.next();
            if lookahead.peek() == Some(&'&') {
                break;
            }
        }
        let mut token = String::new();
        let mut quote: Option<char> = None;
        while let Some(&c) = chars.peek() {
            if let Some(q) = quote {
                chars.next();
                if c == q {
                    quote = None;
                } else {
                    token.push(c);
                }
                continue;
            }
            if c.is_whitespace() || matches!(c, ';' | '|') {
                break;
            }
            if c == '&' {
                let mut lookahead = chars.clone();
                lookahead.next();
                if lookahead.peek() == Some(&'&') {
                    break;
                }
            }
            chars.next();
            if matches!(c, '\'' | '"') {
                quote = Some(c);
            } else {
                token.push(c);
            }
        }
        if !token.is_empty() {
            tokens.push(token);
        }
    }
    tokens
}

fn extract_cli_option(rest: &str, flags: &[&str]) -> Option<String> {
    let tokens = tokenize_cli_args(rest);
    let mut found = None;
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if flags.contains(&token.as_str()) {
            if let Some(next) = tokens.get(index + 1) {
                let trimmed = next.trim();
                if !trimmed.is_empty() && !trimmed.starts_with('-') {
                    found = Some(trimmed.to_string());
                    index += 2;
                    continue;
                }
            }
            index += 1;
            continue;
        }
        if let Some((name, value)) = token.split_once('=') {
            if flags.contains(&name) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    found = Some(trimmed.to_string());
                }
            }
        }
        index += 1;
    }
    found
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
        antigravity_root: {
            let default_agy = env
                .iter()
                .rev()
                .find(|(k, _)| k.eq_ignore_ascii_case("GEMINI_HOME"))
                .map(|(_, v)| v.trim())
                .filter(|v| !v.is_empty())
                .map(|v| PathBuf::from(v).join("antigravity-cli"))
                .unwrap_or_else(|| home.join(".gemini").join("antigravity-cli"));
            env_root(env, "ANTIGRAVITY_CLI_HOME", default_agy, cwd)
        },
        ..Default::default()
    };
    let local = matches!(terminal_type, "cmd" | "powershell" | "pwsh" | "bash" | "sh" | "zsh");
    let commands = commands.into_iter().map(|command| {
        if !local { return command; }
        if let Some(end) = agy_executable_end(&command) {
            if let Some(root) = resolve_antigravity_root_from_command(&command) {
                tracked.antigravity_root = root;
            }
            let rest = &command[end..];
            tracked.launch_provider = Some("antigravity".to_string());
            if let Some(model) = extract_cli_option(rest, &["--model", "-m"]) {
                tracked.launch_model = Some(model);
            }
            if let Some(effort) = extract_cli_option(rest, &["--effort"]) {
                let lower = effort.to_ascii_lowercase();
                if matches!(lower.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
                    tracked.launch_effort = Some(lower);
                }
            }
            if let Some(id) = extract_cli_option(rest, &["--conversation"]) {
                bind(&mut tracked, "antigravity", &id);
            }
            return command;
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

/// 终端 cd 后更新扫描兜底使用的 cwd。
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

/// 原子换绑规则（终端 Agent 会话接力 §4.7）：当前无绑定或绑定相同 → 允许；
/// 已绑定到另一个会话时，只有明确的 SessionStart 事件允许换绑。
/// 其余事件（含 SessionEnd、迟到的旧会话事件）不得改写当前绑定，也不得写入阶段。
fn rebind_allowed(tracked: &TrackedTerminal, provider: &str, session_id: &str, session_start: bool) -> bool {
    match &tracked.binding {
        None => true,
        Some((bound_provider, bound_id)) if bound_provider == provider && bound_id == session_id => true,
        Some(_) => session_start,
    }
}

/// 上报式绑定登记：Codex 日志等来源。`session_start` 为 true 表示
/// 这是明确的 SessionStart 事件（允许跨会话换绑）。
pub fn record_agent_session(
    terminal_id: &str,
    provider: &str,
    session_id: &str,
    session_file: Option<&str>,
    session_start: bool,
) {
    let mut all = terminals().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tracked) = all.get_mut(terminal_id) {
        if !rebind_allowed(tracked, provider, session_id, session_start) {
            return;
        }
        bind(tracked, provider, session_id);
        if let Some(file) = session_file.filter(|file| !file.trim().is_empty()) {
            let path = PathBuf::from(file);
            if path.is_file() {
                tracked.transcript = Some(path);
            }
        }
    }
}

/// Claude Hook 绑定登记。`session_start` 语义同 [`record_agent_session`]：
/// 非 SessionStart 事件不越过已有不同绑定，prompt 也不落到别人的会话上。
pub fn record_claude_session(
    terminal_id: &str,
    session_id: &str,
    prompt: Option<&str>,
    session_start: bool,
) {
    let mut all = terminals().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tracked) = all.get_mut(terminal_id) {
        if !rebind_allowed(tracked, "claude", session_id, session_start) {
            return;
        }
        bind(tracked, "claude", session_id);
        if tracked.prompt.is_none() {
            tracked.prompt = prompt.and_then(compact_title);
            if tracked.prompt.is_some() { tracked.revision = tracked.revision.wrapping_add(1); }
        }
    }
}

/// 当前绑定快照 (provider, sessionId)，供 relay 阶段表与回复闸门比对身份。
pub fn current_binding(terminal_id: &str) -> Option<(String, String)> {
    terminals()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(terminal_id)?
        .binding
        .clone()
}

/// 启动命令中解析出的工具、模型与思考强度提示。
pub fn launch_hints(terminal_id: &str) -> Option<TerminalLaunchHints> {
    let all = terminals().lock().unwrap_or_else(|e| e.into_inner());
    let tracked = all.get(terminal_id)?;
    Some(TerminalLaunchHints {
        provider: tracked.launch_provider.clone(),
        model: tracked.launch_model.clone(),
        effort: tracked.launch_effort.clone(),
    })
}

/// 批量返回当前已识别的 terminal_id -> provider（不受 showTaskSummary 开关影响）。
pub fn current_providers(terminal_ids: &[String]) -> HashMap<String, String> {
    let all = terminals().lock().unwrap_or_else(|e| e.into_inner());
    terminal_ids
        .iter()
        .filter_map(|id| {
            let tracked = all.get(id)?;
            let provider = tracked
                .binding
                .as_ref()
                .map(|(provider, _)| provider.clone())
                .or_else(|| tracked.launch_provider.clone())?;
            Some((id.clone(), provider))
        })
        .collect()
}

/// 终端最近一次记录的 cwd；用于定位项目级 `.claude/settings*.json`。
pub fn current_cwd(terminal_id: &str) -> Option<String> {
    terminals()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(terminal_id)?
        .cwd
        .clone()
}

/// 定位当前绑定的转录文件：`tracked.transcript` 仍存在时优先，否则按 provider
/// 根目录递归查找。tracked 锁内只复制必要数据，目录 I/O 在锁外完成。
pub struct TranscriptLocation {
    pub provider: String,
    pub session_id: String,
    pub path: PathBuf,
    pub root: PathBuf,
}

pub fn locate_transcript(terminal_id: &str) -> Option<TranscriptLocation> {
    let snapshot = {
        let all = terminals().lock().unwrap_or_else(|e| e.into_inner());
        let tracked = all.get(terminal_id)?;
        let (provider, session_id) = tracked.binding.clone()?;
        let root = match provider.as_str() {
            "claude" => tracked.claude_root.clone(),
            "antigravity" => tracked.antigravity_root.clone(),
            _ => tracked.codex_root.clone(),
        };
        (provider, session_id, tracked.transcript.clone(), root)
    };
    let (provider, session_id, transcript, root) = snapshot;
    if let Some(path) = transcript.as_ref().filter(|path| path.is_file()) {
        return Some(TranscriptLocation { provider, session_id, path: path.clone(), root });
    }
    let path = find_transcript(&root, &provider, &session_id)?;
    Some(TranscriptLocation { provider, session_id, path, root })
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
    if provider == "antigravity" {
        let logs = root.join("brain").join(id).join(".system_generated").join("logs");
        for name in ["transcript_full.jsonl", "transcript.jsonl"] {
            let candidate = logs.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        return None;
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

#[derive(Default)]
enum CachedRegistry {
    #[default]
    Empty,
    Shared(std::sync::Arc<HashMap<String, String>>),
    Owned(HashMap<String, String>),
}

impl CachedRegistry {
    fn get(&self, id: &str) -> Option<&String> {
        match self {
            Self::Empty => None,
            Self::Shared(map) => map.get(id),
            Self::Owned(map) => map.get(id),
        }
    }
}

fn resolve_title(
    tracked: &mut TrackedTerminal,
    registries: &mut HashMap<(String, PathBuf), CachedRegistry>,
    db_conn: Option<&rusqlite::Connection>,
) -> Option<TerminalTaskSummary> {
    let (provider, id) = tracked.binding.clone()?;
    let root = match provider.as_str() {
        "claude" => &tracked.claude_root,
        "antigravity" => &tracked.antigravity_root,
        _ => &tracked.codex_root,
    };
    let custom = db_conn.and_then(|conn| {
        let sql = match provider.as_str() {
            "claude" => "SELECT custom_title FROM claude_session_meta WHERE session_id=?1",
            "antigravity" => "SELECT custom_title FROM antigravity_session_meta WHERE session_id=?1",
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
                    "antigravity" => {
                        let transcript = antigravity_transcript::parse(&content);
                        (compact_title(&transcript.first_prompt), transcript.model)
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
    let registry = match provider.as_str() {
        "codex" => registries
            .entry(("codex".to_string(), root.clone()))
            .or_insert_with(|| CachedRegistry::Shared(codex_history_service::thread_names(root)))
            .get(&id)
            .cloned(),
        "antigravity" => registries
            .entry(("antigravity".to_string(), root.clone()))
            .or_insert_with(|| CachedRegistry::Owned(antigravity_history_service::summary_titles(root)))
            .get(&id)
            .cloned()
            .and_then(|value| compact_title(&value)),
        _ => None,
    };
    let summary = custom.or(registry).or_else(|| tracked.title.clone()).or_else(|| tracked.prompt.clone())?;
    Some(TerminalTaskSummary { provider, session_id: id, summary, model: tracked.model.clone() })
}

fn clear_antigravity_state(tracked: &mut TrackedTerminal) {
    tracked.antigravity_seen_alive = false;
    if tracked.binding.as_ref().is_some_and(|(provider, _)| provider == "antigravity") {
        tracked.revision = tracked.revision.wrapping_add(1);
        tracked.binding = None;
        tracked.transcript = None;
        tracked.stamp = None;
        tracked.title = None;
        tracked.model = None;
        tracked.prompt = None;
    }
    if tracked.launch_provider.as_deref() == Some("antigravity") {
        tracked.launch_provider = None;
        tracked.launch_model = None;
        tracked.launch_effort = None;
    }
}

/// 原生 AI 会话复用桌面端的摘要来源，缓存确切会话的文件位置与修改时间。
#[derive(Default)]
pub struct SessionSummaryTracker {
    tracked: TrackedTerminal,
    last_refresh: Option<Instant>,
}

impl SessionSummaryTracker {
    pub fn refresh(&mut self, provider: &str, session_id: &str, cwd: &str, force: bool) -> Option<String> {
        if !matches!(provider, "claude" | "codex") || uuid::Uuid::parse_str(session_id).is_err() { return None; }
        let home = dirs::home_dir().unwrap_or_default();
        let claude_root = env_root(&[], "CLAUDE_CONFIG_DIR", home.join(".claude"), Some(cwd));
        let codex_root = env_root(&[], "CODEX_HOME", home.join(".codex"), Some(cwd));
        if self.tracked.claude_root != claude_root || self.tracked.codex_root != codex_root {
            self.tracked = TrackedTerminal { cwd: Some(cwd.to_string()), claude_root, codex_root, ..Default::default() };
            self.last_refresh = None;
        }
        if self.tracked.binding.as_ref().map_or(true, |(p, id)| p != provider || id != session_id) {
            bind(&mut self.tracked, provider, session_id);
            self.last_refresh = None;
        }
        // 多个客户端共用检查间隔；流式消息仍可每 300ms 推送一次。
        if !force && self.last_refresh.is_some_and(|last| last.elapsed() < Duration::from_secs(2)) { return None; }
        let db_conn = DatabaseService::open().ok();
        let summary = resolve_title(&mut self.tracked, &mut HashMap::new(), db_conn.as_ref()).map(|task| task.summary);
        self.last_refresh = Some(Instant::now());
        summary
    }
}

pub fn summaries(terminal_pids: Vec<(String, u32)>) -> HashMap<String, TerminalTaskSummary> {
    summaries_with_live_agents(terminal_pids).0
}

pub(crate) fn summaries_with_live_agents(
    terminal_pids: Vec<(String, u32)>,
) -> (HashMap<String, TerminalTaskSummary>, HashSet<String>, HashSet<String>) {
    // 扫描可同时由手机和桌面发起；串行扫描，但不持有 Hook 使用的关联表锁。
    static SCAN_LOCK: Mutex<()> = Mutex::new(());
    let _scan = SCAN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if terminal_pids.is_empty() {
        return (HashMap::new(), HashSet::new(), HashSet::new());
    }
    let mut all: HashMap<_, _> = {
        let current = terminals().lock().unwrap_or_else(|e| e.into_inner());
        terminal_pids.iter().filter_map(|(id, _)| current.get(id).map(|tracked| (id.clone(), tracked.clone()))).collect()
    };
    let revisions: HashMap<_, _> = all.iter().map(|(id, tracked)| (id.clone(), tracked.revision)).collect();
    let all_processes = crate::commands::claude_session::get_all_processes();
    let roots = terminal_pids.iter().filter_map(|(id, _)| all.get(id).map(|tracked| (id.clone(), tracked.claude_root.clone()))).collect();
    let claude_sessions = crate::commands::claude_session::discover_claude_sessions_with_processes(
        &terminal_pids,
        &roots,
        &all_processes,
    );
    let scopes = terminal_pids.iter().filter_map(|(id, pid)| {
        let tracked = all.get(id)?;
        Some(super::terminal_task_process::CodexProcessScope {
            terminal_id: id.clone(), process_id: *pid, root: tracked.codex_root.clone(),
            started_at: tracked.last_process_scan.or(tracked.started_at).unwrap_or(SystemTime::UNIX_EPOCH)
                .checked_sub(std::time::Duration::from_secs(5)).unwrap_or(SystemTime::UNIX_EPOCH),
        })
    }).collect();
    let (codex_sessions, codex_live) = super::terminal_task_process::discover_with_processes(scopes, &all_processes);
    let agy_scopes = terminal_pids.iter().filter_map(|(id, pid)| {
        let tracked = all.get(id)?;
        Some(super::terminal_task_process::AntigravityProcessScope {
            terminal_id: id.clone(),
            process_id: *pid,
            root: tracked.antigravity_root.clone(),
            started_at: tracked.started_at.unwrap_or(SystemTime::UNIX_EPOCH)
                .checked_sub(std::time::Duration::from_secs(5)).unwrap_or(SystemTime::UNIX_EPOCH),
        })
    }).collect();
    let agy_discovery = super::terminal_task_process::discover_antigravity_with_processes(agy_scopes, &all_processes);
    let mut registries = HashMap::new();
    let mut result = HashMap::new();
    let db_conn = DatabaseService::open().ok();
    for (terminal_id, _) in terminal_pids {
        let Some(tracked) = all.get_mut(&terminal_id) else { continue; };
        tracked.last_process_scan = Some(SystemTime::now());
        if agy_discovery.live_terminals.contains(&terminal_id) {
            tracked.antigravity_seen_alive = true;
            if let Some(id) = agy_discovery.sessions.get(&terminal_id) {
                bind(tracked, "antigravity", id);
            } else if tracked.binding.is_none() && tracked.launch_provider.is_none() {
                tracked.launch_provider = Some("antigravity".to_string());
            }
        } else {
            let past_grace = tracked.started_at.is_none_or(|started| {
                started.elapsed().unwrap_or_default() >= ANTIGRAVITY_STARTUP_GRACE
            });
            if tracked.antigravity_seen_alive || past_grace {
                clear_antigravity_state(tracked);
            }
        }
        read_codex_binding(tracked);
        if let Some((id, path)) = codex_sessions.get(&terminal_id) {
            bind(tracked, "codex", id);
            tracked.transcript = Some(path.clone());
        }
        if let Some(id) = claude_sessions.get(&terminal_id) { bind(tracked, "claude", id); }
        if let Some(summary) = resolve_title(tracked, &mut registries, db_conn.as_ref()) {
            result.insert(terminal_id, summary);
        }
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
    (result, codex_live, agy_discovery.live_terminals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_codex_commands_without_touching_shell_fragments() {
        assert!(codex_executable_end("codex resume x").is_some());
        assert!(codex_executable_end("echo codex").is_none());
    }

    #[test]
    fn identifies_agy_commands_and_extracts_launch_hints() {
        assert!(agy_executable_end("echo agy").is_none());
        assert!(agy_executable_end("agy --dangerously-skip-permissions").is_some());
        assert!(agy_executable_end("& 'C:\\Program Files\\agy.cmd' --help").is_some());
        let ps_isolated = "$env:USERPROFILE='C:\\Users\\Admin\\profile-1'; $env:HOME='C:\\Users\\Admin\\profile-1'; $env:GEMINI_HOME='C:\\Users\\Admin\\profile-1\\.gemini'; $env:AGY_ACP_FORCE_FILE_STORAGE='1'; agy --dangerously-skip-permissions --conversation abc-123";
        assert!(agy_executable_end(ps_isolated).is_some());
        assert_eq!(
            resolve_antigravity_root_from_command(ps_isolated),
            Some(PathBuf::from("C:\\Users\\Admin\\profile-1\\.gemini").join("antigravity-cli"))
        );
        let posix_isolated = "HOME='/tmp/profile-1' GEMINI_HOME='/tmp/profile-1/.gemini' AGY_ACP_FORCE_FILE_STORAGE='1' agy --dangerously-skip-permissions";
        assert!(agy_executable_end(posix_isolated).is_some());
        assert_eq!(
            resolve_antigravity_root_from_command(posix_isolated),
            Some(PathBuf::from("/tmp/profile-1/.gemini").join("antigravity-cli"))
        );

        let conv_id = uuid::Uuid::new_v4().to_string();
        let terminal_id = format!("agy-launch-test-{}", uuid::Uuid::new_v4());
        prepare_launch(
            &terminal_id,
            "powershell",
            None,
            &[],
            vec![format!(
                "agy --dangerously-skip-permissions --model gemini-3.1-pro-high --effort HIGH --conversation {conv_id}"
            )],
        );
        let hints = launch_hints(&terminal_id).expect("应记录 launch_hints");
        let binding = current_binding(&terminal_id).expect("应立即绑定 conversation");
        let providers = current_providers(&[terminal_id.clone()]);
        forget_terminal(&terminal_id);

        assert_eq!(hints.provider.as_deref(), Some("antigravity"));
        assert_eq!(hints.model.as_deref(), Some("gemini-3.1-pro-high"));
        assert_eq!(hints.effort.as_deref(), Some("high"));
        assert_eq!(binding, ("antigravity".to_string(), conv_id));
        assert_eq!(providers.get(&terminal_id).map(String::as_str), Some("antigravity"));
    }

    #[test]
    fn locates_antigravity_transcript_preferring_full() {
        let root = std::env::temp_dir().join(format!("tb-agy-loc-{}", uuid::Uuid::new_v4()));
        let conv_id = uuid::Uuid::new_v4().to_string();
        let logs = root.join("brain").join(&conv_id).join(".system_generated").join("logs");
        fs::create_dir_all(&logs).expect("创建临时 logs 目录");
        let fallback = logs.join("transcript.jsonl");
        let full = logs.join("transcript_full.jsonl");
        fs::write(&fallback, "{}\n").expect("写入 transcript.jsonl");
        assert_eq!(find_transcript(&root, "antigravity", &conv_id), Some(fallback));
        fs::write(&full, "{}\n").expect("写入 transcript_full.jsonl");
        assert_eq!(find_transcript(&root, "antigravity", &conv_id), Some(full));
        let _ = fs::remove_dir_all(&root);
    }
}
