//! 将终端关联到确切的 AI 会话；不能用项目目录的「最新会话」代替当前会话。
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use rusqlite::OptionalExtension;
use serde::Serialize;

use super::{claude_history_service, codex_history_service, codex_transcript, DatabaseService, PathService};

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
    claude_root: PathBuf,
    codex_root: PathBuf,
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
        claude_root: env_root(env, "CLAUDE_CONFIG_DIR", home.join(".claude"), cwd),
        codex_root: env_root(env, "CODEX_HOME", home.join(".codex"), cwd),
        ..Default::default()
    };
    let local = matches!(terminal_type, "cmd" | "powershell" | "pwsh" | "bash" | "sh" | "zsh");
    let commands = commands.into_iter().map(|command| {
        if !local { return command; }
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
    let root = if provider == "claude" { &tracked.claude_root } else { &tracked.codex_root };
    let conn = DatabaseService::open().ok();
    let custom = conn.as_ref().and_then(|conn| {
        let sql = if provider == "claude" {
            "SELECT custom_title FROM claude_session_meta WHERE session_id=?1"
        } else { "SELECT custom_title FROM codex_session_meta WHERE session_id=?1" };
        conn.query_row(sql, [&id], |row| row.get::<_, Option<String>>(0)).optional().ok().flatten().flatten()
    }).and_then(|value| compact_title(&value));
    if tracked.transcript.as_ref().map_or(true, |path| !path.is_file()) {
        tracked.transcript = find_transcript(root, &provider, &id);
    }
    if let Some(path) = &tracked.transcript {
        let stamp = fs::metadata(path).ok().and_then(|meta| Some((meta.modified().ok()?, meta.len())));
        if stamp.is_some() && stamp != tracked.stamp {
            if let Some(content) = transcript_excerpt(path) {
                let (title, model) = if provider == "claude" {
                    let analysis = claude_history_service::analyze_transcript(&content);
                    let title = claude_history_service::display_title(None, analysis.title.as_deref(), analysis.first_prompt.as_deref(), "");
                    (compact_title(&title), analysis.model)
                } else {
                    let transcript = codex_transcript::parse(&content);
                    (transcript.title.and_then(|value| compact_title(&value)), transcript.model)
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
        if !matches!(provider, "claude" | "codex") || uuid::Uuid::parse_str(session_id).is_err() { return None; }
        let home = dirs::home_dir().unwrap_or_default();
        let claude_root = env_root(&[], "CLAUDE_CONFIG_DIR", home.join(".claude"), Some(cwd));
        let codex_root = env_root(&[], "CODEX_HOME", home.join(".codex"), Some(cwd));
        if self.tracked.claude_root != claude_root || self.tracked.codex_root != codex_root {
            self.tracked = TrackedTerminal { claude_root, codex_root, ..Default::default() };
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
