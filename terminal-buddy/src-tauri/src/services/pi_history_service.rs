//! Pi Agent 历史：扫描 `~/.pi/agent/sessions`（或自定义 sessionDir）的 JSONL，
//! 索引到独立 SQLite 表。原始会话只读；删除移动到应用回收目录，不改写 Pi 数据。
use super::claude_config_service::normalized_dir_expr;
use super::claude_history_service::{
    move_to_trash, render_markdown_for_assistant, with_file_restore_error,
};
use super::pi_transcript::{self, excerpt};
use super::{DatabaseService, PathService};
use crate::models::session_history::{
    SessionHistoryItem, SessionHistoryScanResult, SessionReplayPage, SessionSearchHit,
};
use crate::runtime::{AppHandle, Emitter};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

const BATCH_SIZE: usize = 60;
const ANALYZER_VERSION: i64 = 1;
static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn index_lock() -> Result<MutexGuard<'static, ()>, String> {
    INDEX_LOCK
        .lock()
        .map_err(|_| "Pi 会话索引锁不可用".to_string())
}

pub fn init_pi_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pi_sessions (
            session_id TEXT PRIMARY KEY, file_path TEXT NOT NULL,
            file_mtime INTEGER NOT NULL, file_size INTEGER NOT NULL,
            project_dir TEXT NOT NULL, updated_at INTEGER NOT NULL, item_json TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS pi_session_meta (
            session_id TEXT PRIMARY KEY, custom_title TEXT,
            starred INTEGER NOT NULL DEFAULT 0, archived INTEGER
         );
         CREATE TABLE IF NOT EXISTS pi_messages (
            session_id TEXT NOT NULL, seq INTEGER NOT NULL, content TEXT NOT NULL, timestamp INTEGER,
            PRIMARY KEY (session_id, seq)
         );
         CREATE TABLE IF NOT EXISTS pi_index_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS idx_pi_sessions_updated ON pi_sessions (updated_at DESC);"
    ).map_err(|error| format!("创建 Pi 历史索引失败: {error}"))
}

/// 解析 Pi 的会话根目录：环境变量 → settings.json 的 sessionDir → `~/.pi/agent/sessions`。
fn agent_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("用户主目录未正确配置")?;
    Ok(std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".pi/agent")))
}

fn resolve_dir(value: &Path, base: &Path) -> PathBuf {
    if let Some(rest) = value.to_str().and_then(|text| text.strip_prefix("~/")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if value.is_absolute() { value.to_path_buf() } else { base.join(value) }
}

pub(super) fn resolve_session_root() -> Result<PathBuf, String> {
    let agent = agent_dir()?;
    if let Some(value) = std::env::var_os("PI_CODING_AGENT_SESSION_DIR").filter(|value| !value.is_empty()) {
        return Ok(resolve_dir(Path::new(&value), &agent));
    }
    let settings = agent.join("settings.json");
    if let Ok(content) = fs::read_to_string(&settings) {
        if let Ok(value) = serde_json::from_str::<Value>(&content) {
            if let Some(session_dir) = value
                .get("sessionDir")
                .or_else(|| value.get("session_dir"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                return Ok(resolve_dir(Path::new(session_dir.trim()), &agent));
            }
        }
    }
    Ok(agent.join("sessions"))
}

fn session_id_from_file(path: &Path) -> Option<String> {
    // 文件名：<timestamp>_<session-id>.jsonl
    let stem = path.file_stem()?.to_str()?;
    if let Some((_, suffix)) = stem.rsplit_once('_') {
        if uuid::Uuid::parse_str(suffix).is_ok() {
            return Some(suffix.to_string());
        }
    }
    let reader = BufReader::new(fs::File::open(path).ok()?);
    for line in reader.lines().take(8).map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            if let Some(id) = value.get("id").and_then(Value::as_str).filter(|id| !id.trim().is_empty()) {
                return Some(id.to_string());
            }
        }
    }
    None
}

#[derive(Clone)]
struct SessionFile {
    id: String,
    path: PathBuf,
    mtime: i64,
    size: i64,
}

fn collect_files(root: &Path) -> Result<Vec<SessionFile>, String> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if dir == root {
                    return Ok(Vec::new());
                }
                continue;
            }
            Err(error) => return Err(format!("读取 Pi 会话目录 {} 失败: {error}", dir.display())),
        };
        for entry in entries {
            let entry = entry.map_err(|error| format!("读取 Pi 会话目录条目失败: {error}"))?;
            let kind = entry.file_type().map_err(|error| format!("读取 Pi 会话文件类型失败: {error}"))?;
            if kind.is_dir() {
                dirs.push(entry.path());
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.ends_with(".jsonl") {
                continue;
            }
            let path = entry.path();
            let Some(id) = session_id_from_file(&path) else { continue; };
            let metadata = entry.metadata().map_err(|error| format!("读取 Pi 会话文件属性失败: {error}"))?;
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);
            files.push(SessionFile { id, path, mtime, size: metadata.len() as i64 });
        }
    }
    Ok(files)
}

/// 按 session ID 找到 Pi 的会话文件（用于任务摘要与页签恢复）。
/// 优先用文件名 `<timestamp>_<id>.jsonl` 定位，避免为每轮摘要解析所有文件头。
pub(super) fn find_session_file(root: &Path, id: &str) -> Option<PathBuf> {
    let wanted = format!("_{id}.jsonl");
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue; };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue; };
            if kind.is_dir() { dirs.push(entry.path()); continue; }
            if !kind.is_file() { continue; }
            if entry.file_name().to_string_lossy().ends_with(&wanted) {
                return Some(entry.path());
            }
        }
    }
    None
}

fn scan_root(conn: &Connection, root: &Path, limit: usize) -> Result<SessionHistoryScanResult, String> {
    let version = conn
        .query_row(
            "SELECT value FROM pi_index_state WHERE key = 'analyzer_version'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if version != Some(ANALYZER_VERSION) {
        let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
        transaction
            .execute_batch("DELETE FROM pi_messages; DELETE FROM pi_sessions;")
            .map_err(|error| error.to_string())?;
        transaction
            .execute("INSERT OR REPLACE INTO pi_index_state (key, value) VALUES ('analyzer_version', ?1)", [ANALYZER_VERSION])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let all_files = collect_files(root)?;
    let mut by_id = HashMap::<String, SessionFile>::new();
    for file in all_files {
        let replace = by_id.get(&file.id).is_none_or(|old| file.mtime > old.mtime);
        if replace {
            by_id.insert(file.id.clone(), file);
        }
    }
    let files: Vec<_> = by_id.into_values().filter(|file| file.size <= 64 * 1024 * 1024).collect();
    let mut outdated = Vec::new();
    let mut check = conn
        .prepare("SELECT 1 FROM pi_sessions WHERE session_id = ?1 AND file_path = ?2 AND file_mtime = ?3 AND file_size = ?4")
        .map_err(|error| error.to_string())?;
    for file in &files {
        let unchanged = check
            .query_row(params![file.id, file.path.to_string_lossy(), file.mtime, file.size], |_| Ok(()))
            .optional()
            .map_err(|error| error.to_string())?
            .is_some();
        if !unchanged {
            outdated.push(file);
        }
    }
    outdated.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    let mut updated = 0;
    for file in outdated.iter().take(limit) {
        let Ok(content) = fs::read_to_string(&file.path) else { continue; };
        let transcript = pi_transcript::parse(&content);
        let item = SessionHistoryItem {
            session_id: file.id.clone(),
            project_dir: transcript.project_dir,
            file_path: file.path.to_string_lossy().into_owned(),
            title: transcript
                .title
                .unwrap_or_else(|| format!("Pi 会话 {}", excerpt(&file.id, 8))),
            custom_title: None,
            started_at: transcript.started_at,
            updated_at: transcript.updated_at.unwrap_or(file.mtime),
            message_count: transcript.messages.len() as i64,
            input_tokens: transcript.input_tokens,
            output_tokens: transcript.output_tokens,
            model: transcript.model,
            starred: false,
            archived: false,
        };
        let json = serde_json::to_string(&item).map_err(|error| error.to_string())?;
        let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO pi_sessions (session_id, file_path, file_mtime, file_size, project_dir, updated_at, item_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(session_id) DO UPDATE SET file_path=excluded.file_path, file_mtime=excluded.file_mtime,
             file_size=excluded.file_size, project_dir=excluded.project_dir, updated_at=excluded.updated_at, item_json=excluded.item_json",
            params![file.id, item.file_path, file.mtime, file.size, item.project_dir, item.updated_at, json],
        ).map_err(|error| format!("写入 Pi 会话索引失败: {error}"))?;
        transaction
            .execute("DELETE FROM pi_messages WHERE session_id = ?1", [&file.id])
            .map_err(|error| error.to_string())?;
        {
            let mut insert = transaction
                .prepare("INSERT INTO pi_messages (session_id, seq, content, timestamp) VALUES (?1, ?2, ?3, ?4)")
                .map_err(|error| error.to_string())?;
            for message in transcript.messages {
                let text = std::iter::once(message.text)
                    .chain(message.tools.into_iter().map(|tool| format!("{} {}", tool.name, tool.summary)))
                    .collect::<Vec<_>>()
                    .join("\n");
                insert
                    .execute(params![file.id, message.seq, text, message.timestamp])
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction.commit().map_err(|error| format!("提交 Pi 会话索引失败: {error}"))?;
        updated += 1;
    }
    let seen: HashSet<_> = files.iter().map(|file| file.id.as_str()).collect();
    let mut statement = conn
        .prepare("SELECT session_id, file_path FROM pi_sessions")
        .map_err(|error| error.to_string())?;
    let stored = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    for (id, path) in stored {
        let path = Path::new(&path);
        // 正在追加或暂时不可读的文件保留索引，下次扫描继续尝试。
        if !seen.contains(id.as_str()) && (!path.exists() || !path.starts_with(root)) {
            delete_rows(&transaction, &id, false)?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    let total = conn
        .query_row("SELECT COUNT(*) FROM pi_sessions", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(SessionHistoryScanResult {
        scanned: files.len() as i64,
        updated,
        total,
        pending: outdated.len().saturating_sub(limit) as i64,
    })
}

pub fn scan_and_index(app: &AppHandle) -> Result<SessionHistoryScanResult, String> {
    let root = resolve_session_root()?;
    let conn = DatabaseService::open()?;
    let result = {
        let _guard = index_lock()?;
        scan_root(&conn, &root, BATCH_SIZE)?
    };
    if result.pending > 0 {
        spawn_backfill(app.clone(), conn, root);
    }
    Ok(result)
}

fn spawn_backfill(app: AppHandle, conn: Connection, root: PathBuf) {
    static BACKFILLING: AtomicBool = AtomicBool::new(false);
    if BACKFILLING.swap(true, Ordering::SeqCst) {
        return;
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            BACKFILLING.store(false, Ordering::SeqCst);
        }
    }
    let _task = crate::runtime::async_runtime::spawn_blocking(move || {
        let _guard = Guard;
        let mut previous = i64::MAX;
        loop {
            let result = (|| {
                let _guard = index_lock()?;
                scan_root(&conn, &root, BATCH_SIZE)
            })();
            match result {
                Ok(result) => {
                    let finished = result.pending == 0 || result.pending >= previous;
                    previous = result.pending;
                    let _ = app.emit("pi-history-indexed", &result);
                    if finished {
                        break;
                    }
                }
                Err(error) => {
                    crate::commands::terminal::log_debug(&format!("[pi-history] {error}"));
                    break;
                }
            }
        }
    });
}

fn read_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionHistoryItem> {
    let json: String = row.get(0)?;
    let mut item: SessionHistoryItem = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    item.custom_title = row.get(1)?;
    item.starred = row.get::<_, i64>(2)? != 0;
    item.archived = row.get::<_, Option<bool>>(3)?.unwrap_or(item.archived);
    if let Some(title) = &item.custom_title {
        item.title = title.clone();
    }
    Ok(item)
}

fn list_in(
    conn: &Connection,
    include_archived: bool,
    project_dir: Option<&str>,
) -> Result<Vec<SessionHistoryItem>, String> {
    let sql = format!(
        "SELECT s.item_json, m.custom_title, COALESCE(m.starred, 0), m.archived FROM pi_sessions s
         LEFT JOIN pi_session_meta m ON m.session_id = s.session_id
         WHERE (?1 IS NULL OR {indexed} = {wanted} OR substr({indexed}, 1, length({wanted}) + 1) = {wanted} || '/')
         ORDER BY s.updated_at DESC",
        indexed = normalized_dir_expr("s.project_dir"),
        wanted = normalized_dir_expr("?1"),
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_dir], read_item)
        .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    for item in rows {
        let item = item.map_err(|error| format!("读取 Pi 会话失败: {error}"))?;
        if include_archived || !item.archived {
            result.push(item);
        }
    }
    Ok(result)
}

pub fn list_sessions(include_archived: bool, project_dir: Option<&str>) -> Result<Vec<SessionHistoryItem>, String> {
    list_in(&DatabaseService::open()?, include_archived, project_dir)
}

fn search_in(
    conn: &Connection,
    query: &str,
    project_dir: Option<&str>,
) -> Result<Vec<SessionSearchHit>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!(
        "%{}%",
        query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    let sql = format!(
        "SELECT s.item_json, m.custom_title, COALESCE(m.starred, 0), m.archived, msg.seq, msg.content, msg.timestamp
         FROM pi_messages msg JOIN pi_sessions s ON s.session_id = msg.session_id
         LEFT JOIN pi_session_meta m ON m.session_id = s.session_id
         WHERE msg.content LIKE ?1 ESCAPE '\\'
           AND (?2 IS NULL OR {indexed} = {wanted} OR substr({indexed}, 1, length({wanted}) + 1) = {wanted} || '/')
         ORDER BY s.updated_at DESC, msg.seq LIMIT 100",
        indexed = normalized_dir_expr("s.project_dir"),
        wanted = normalized_dir_expr("?2"),
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![pattern, project_dir], |row| {
            let item = read_item(row)?;
            let content: String = row.get(5)?;
            Ok(SessionSearchHit {
                session_id: item.session_id,
                title: item.title,
                project_dir: item.project_dir,
                snippet: snippet(&content, query),
                seq: row.get(4)?,
                timestamp: row.get(6)?,
                updated_at: item.updated_at,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("搜索 Pi 会话失败: {error}"))
}

fn snippet(content: &str, query: &str) -> String {
    let lowered = content.to_lowercase();
    let Some(byte) = lowered.find(&query.to_lowercase()) else {
        return excerpt(content, 100);
    };
    let position = lowered[..byte].chars().count();
    let start = position.saturating_sub(24);
    let text: String = content.chars().skip(start).take(query.chars().count() + 72).collect();
    format!("{}{}", if start > 0 { "…" } else { "" }, text)
}

pub fn search(query: &str, project_dir: Option<&str>) -> Result<Vec<SessionSearchHit>, String> {
    search_in(&DatabaseService::open()?, query, project_dir)
}

fn item_in(conn: &Connection, session_id: &str) -> Result<SessionHistoryItem, String> {
    conn.query_row(
        "SELECT s.item_json, m.custom_title, COALESCE(m.starred, 0), m.archived FROM pi_sessions s
         LEFT JOIN pi_session_meta m ON m.session_id = s.session_id WHERE s.session_id = ?1",
        [session_id],
        read_item,
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "Pi 会话记录不存在（可能已被删除）".to_string())
}

pub fn get_replay(session_id: &str, offset: usize, limit: usize) -> Result<SessionReplayPage, String> {
    let item = item_in(&DatabaseService::open()?, session_id)?;
    let content = fs::read_to_string(&item.file_path)
        .map_err(|error| format!("读取 Pi 会话失败: {error}"))?;
    let transcript = pi_transcript::parse(&content);
    let total = transcript.messages.len() as i64;
    Ok(SessionReplayPage {
        total,
        messages: transcript.messages.into_iter().skip(offset).take(limit.max(1)).collect(),
        title: item.title,
        project_dir: item.project_dir,
        model: transcript.model.or(item.model),
        input_tokens: transcript.input_tokens,
        output_tokens: transcript.output_tokens,
        started_at: transcript.started_at.or(item.started_at),
        updated_at: transcript.updated_at.unwrap_or(item.updated_at),
    })
}

pub fn rename_session(session_id: &str, title: &str) -> Result<(), String> {
    let conn = DatabaseService::open()?;
    item_in(&conn, session_id)?;
    let title = title.trim();
    conn.execute(
        "INSERT INTO pi_session_meta (session_id, custom_title) VALUES (?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET custom_title = excluded.custom_title",
        params![session_id, if title.is_empty() { None } else { Some(title) }],
    )
    .map(|_| ())
    .map_err(|error| format!("重命名 Pi 会话失败: {error}"))
}

pub fn set_flags(session_id: &str, starred: Option<bool>, archived: Option<bool>) -> Result<(), String> {
    let conn = DatabaseService::open()?;
    item_in(&conn, session_id)?;
    conn.execute(
        "INSERT INTO pi_session_meta (session_id, starred, archived) VALUES (?1, COALESCE(?2, 0), ?3)
         ON CONFLICT(session_id) DO UPDATE SET starred=COALESCE(?2, pi_session_meta.starred),
         archived=COALESCE(?3, pi_session_meta.archived)",
        params![session_id, starred, archived],
    )
    .map(|_| ())
    .map_err(|error| format!("更新 Pi 会话标记失败: {error}"))
}

fn delete_rows(conn: &Connection, session_id: &str, metadata: bool) -> Result<(), String> {
    conn.execute("DELETE FROM pi_messages WHERE session_id = ?1", [session_id])
        .map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM pi_sessions WHERE session_id = ?1", [session_id])
        .map_err(|error| error.to_string())?;
    if metadata {
        conn.execute("DELETE FROM pi_session_meta WHERE session_id = ?1", [session_id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn delete_in(conn: &mut Connection, root: &Path, trash: &Path, session_ids: &[String]) -> Result<(), String> {
    let ids: HashSet<_> = session_ids.iter().map(String::as_str).filter(|id| !id.is_empty()).collect();
    let files = collect_files(root)?;
    for id in &ids {
        // 运行中的 Pi 会话拒绝删除：绑定表里仍有该会话即视为活动。
        if super::terminal_task_service::is_agent_session_active(id) {
            return Err("该 Pi 会话正在运行，请先关闭对应终端再删除".to_string());
        }
        let path = conn
            .query_row("SELECT file_path FROM pi_sessions WHERE session_id = ?1", [*id], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(path) = path {
            if Path::new(&path).exists() && !files.iter().any(|file| file.path == Path::new(&path)) {
                return Err("会话文件当前不可读取，请刷新列表后重试".to_string());
            }
        }
    }
    let mut moved = Vec::new();
    for file in files.into_iter().filter(|file| ids.contains(file.id.as_str())) {
        match move_to_trash(&file.path, trash) {
            Ok(target) => moved.push((file.path, target)),
            Err(error) => return Err(with_file_restore_error(error, &moved)),
        }
    }
    let outcome = (|| {
        let transaction = conn.transaction().map_err(|error| error.to_string())?;
        for id in ids {
            delete_rows(&transaction, id, true)?;
        }
        transaction.commit().map_err(|error| error.to_string())
    })();
    outcome.map_err(|error| with_file_restore_error(format!("删除 Pi 会话失败: {error}"), &moved))
}

pub fn delete_sessions(session_ids: &[String]) -> Result<(), String> {
    let _guard = index_lock()?;
    let root = resolve_session_root()?;
    let trash = PathService::require_data_dir()?.join("Trash").join("pi-sessions");
    delete_in(&mut DatabaseService::open()?, &root, &trash, session_ids)
}

pub fn delete_session(session_id: &str) -> Result<(), String> {
    delete_sessions(&[session_id.to_string()])
}

pub fn export_session(session_id: &str, format: &str, dest_path: &str) -> Result<(), String> {
    let item = item_in(&DatabaseService::open()?, session_id)?;
    if Path::new(dest_path)
        .canonicalize()
        .ok()
        .is_some_and(|dest| Some(dest) == Path::new(&item.file_path).canonicalize().ok())
    {
        return Err("导出路径不能与原始会话文件相同".to_string());
    }
    match format {
        "jsonl" => fs::copy(&item.file_path, dest_path)
            .map(|_| ())
            .map_err(|error| format!("导出 Pi 会话失败: {error}")),
        "markdown" => {
            let page = get_replay(session_id, 0, usize::MAX)?;
            let content = render_markdown_for_assistant(
                &page.title,
                &page.project_dir,
                page.model.as_deref(),
                page.total as usize,
                &page.messages,
                "Pi",
            );
            fs::write(dest_path, content).map_err(|error| format!("导出 Pi 会话失败: {error}"))
        }
        _ => Err("不支持的导出格式".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("tb-pi-history-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn write(&self, relative: &str, id: &str, cwd: &str, text: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let lines = [
                json!({"type":"session","version":3,"id":id,"timestamp":"2026-10-20T00:00:00Z","cwd":cwd}),
                json!({"type":"message","id":"a","parentId":null,"timestamp":"2026-10-20T00:00:01Z","message":{"role":"user","content":text}}),
                json!({"type":"message","id":"b","parentId":"a","timestamp":"2026-10-20T00:00:02Z","message":{"role":"assistant","model":"test/model","content":"这是回复","usage":{"input":100,"output":10}}}),
            ];
            fs::write(
                &path,
                lines.into_iter().map(|line| line.to_string()).collect::<Vec<_>>().join("\n") + "\n{partial",
            )
            .unwrap();
            path
        }
        fn connection(&self) -> Connection {
            let conn = Connection::open_in_memory().unwrap();
            init_pi_schema(&conn).unwrap();
            conn
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn indexes_pi_sessions_incrementally_and_keeps_meta() {
        let fixture = Fixture::new();
        let conn = fixture.connection();
        fixture.write("--workspace-demo--/2026-10-20T00_01900000-0000-7000-8000-000000000001.jsonl", "01900000-0000-7000-8000-000000000001", "/workspace/demo", "中文问题");
        fixture.write("--other--/2026-10-20T00_01900000-0000-7000-8000-000000000002.jsonl", "01900000-0000-7000-8000-000000000002", "/workspace/other", "另一个问题");
        let scan = scan_root(&conn, &fixture.0, 60).unwrap();
        assert_eq!((scan.scanned, scan.updated, scan.total, scan.pending), (2, 2, 2, 0));
        let items = list_in(&conn, false, Some("/workspace/demo")).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].message_count, 2);
        assert_eq!(items[0].model.as_deref(), Some("test/model"));
        conn.execute("INSERT INTO pi_session_meta (session_id, custom_title, starred) VALUES ('01900000-0000-7000-8000-000000000001', '自定义 Pi', 1)", []).unwrap();
        let items = list_in(&conn, false, None).unwrap();
        assert!(items.iter().any(|item| item.title == "自定义 Pi"));
        let repeat = scan_root(&conn, &fixture.0, 60).unwrap();
        assert_eq!(repeat.updated, 0);
    }

    #[test]
    fn searches_chinese_and_literal_wildcards() {
        let fixture = Fixture::new();
        let conn = fixture.connection();
        fixture.write("a/2026-10-20T00_01900000-0000-7000-8000-000000000003.jsonl", "01900000-0000-7000-8000-000000000003", "/work/app", "命中中文 100%_ end");
        scan_root(&conn, &fixture.0, 60).unwrap();
        let hits = search_in(&conn, "命中中文", Some("/work/app")).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("命中中文"));
        assert_eq!(search_in(&conn, "100%_", None).unwrap().len(), 1);
        assert!(search_in(&conn, " ", None).unwrap().is_empty());
    }

    #[test]
    fn delete_moves_file_to_trash_and_removes_index() {
        let fixture = Fixture::new();
        let mut conn = fixture.connection();
        let path = fixture.write("a/2026-10-20T00_01900000-0000-7000-8000-000000000004.jsonl", "01900000-0000-7000-8000-000000000004", "/work", "待删除");
        scan_root(&conn, &fixture.0, 60).unwrap();
        let trash = fixture.0.join("Trash");
        delete_in(&mut conn, &fixture.0, &trash, &["01900000-0000-7000-8000-000000000004".to_string()]).unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&trash).unwrap().count(), 1);
        assert_eq!(list_in(&conn, false, None).unwrap().len(), 0);
    }

    #[test]
    fn analyzer_rebuild_is_idempotent_and_independent() {
        let fixture = Fixture::new();
        let conn = fixture.connection();
        super::super::claude_history_service::init_claude_schema(&conn).unwrap();
        fixture.write("a/2026-10-20T00_01900000-0000-7000-8000-000000000005.jsonl", "01900000-0000-7000-8000-000000000005", "/work", "Pi 标题");
        scan_root(&conn, &fixture.0, 60).unwrap();
        conn.execute("INSERT INTO pi_session_meta (session_id, custom_title) VALUES ('01900000-0000-7000-8000-000000000005', 'Pi 自定义')", []).unwrap();
        conn.execute("UPDATE pi_index_state SET value=0 WHERE key='analyzer_version'", []).unwrap();
        scan_root(&conn, &fixture.0, 60).unwrap();
        assert_eq!(list_in(&conn, false, None).unwrap()[0].title, "Pi 自定义");
    }
}
