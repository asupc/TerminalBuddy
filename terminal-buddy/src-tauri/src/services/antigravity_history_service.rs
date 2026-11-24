//! Antigravity CLI（`agy`）历史会话索引、检索、回放、管理与导出。
//!
//! 数据源：`~/.gemini/antigravity-cli`（支持 `ANTIGRAVITY_CLI_HOME` 覆盖）：
//! - 以**只读**方式查询 `conversation_summaries.db` 获取标题与工作区目录并过滤子代理，
//!   不可写或破坏 `agy` 自有数据库（失败时优雅降级到 `cache/conversation_metadata.json`）。
//! - 扫描 `brain/<conversation_id>/.system_generated/logs/transcript_full.jsonl`（回退 `transcript.jsonl`）
//!   存入应用自身 SQLite 的 `antigravity_*` 表，支持全文检索、分页回放、导出、自动归档与移入回收目录删除。

use super::antigravity_transcript::{self, excerpt, parse_timestamp_str};
use super::atomic_file::atomic_write;
use super::claude_config_service::normalized_dir_expr;
use super::claude_history_service::{
    move_to_trash, render_markdown_for_assistant, with_file_restore_error,
};
use super::{DatabaseService, PathService};
use crate::models::session_history::{
    SessionHistoryItem, SessionHistoryScanResult, SessionReplayPage, SessionSearchHit,
};
use crate::runtime::{AppHandle, Emitter};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, UNIX_EPOCH};

pub const INDEXED_EVENT: &str = "antigravity-history-indexed";
const BATCH_SIZE: usize = 40;
const ANALYZER_VERSION: i64 = 1;
const MAX_CACHE_META_BYTES: u64 = 16 * 1024 * 1024;
static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn index_lock() -> Result<MutexGuard<'static, ()>, String> {
    INDEX_LOCK
        .lock()
        .map_err(|_| "Antigravity 会话索引锁不可用".to_string())
}

pub fn init_antigravity_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS antigravity_sessions (
            session_id TEXT PRIMARY KEY,
            file_path TEXT NOT NULL,
            file_mtime INTEGER NOT NULL,
            file_size INTEGER NOT NULL,
            project_dir TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            item_json TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS antigravity_session_meta (
            session_id TEXT PRIMARY KEY,
            custom_title TEXT,
            starred INTEGER NOT NULL DEFAULT 0,
            archived INTEGER,
            auto_archive_mark INTEGER
         );
         CREATE TABLE IF NOT EXISTS antigravity_messages (
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER,
            PRIMARY KEY (session_id, seq)
         );
         CREATE TABLE IF NOT EXISTS antigravity_index_state (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_antigravity_sessions_updated ON antigravity_sessions (updated_at DESC);",
    )
    .map_err(|error| format!("创建 Antigravity 历史索引失败: {error}"))
}

pub(super) fn resolve_antigravity_home() -> Result<PathBuf, String> {
    if let Some(custom) = std::env::var_os("ANTIGRAVITY_CLI_HOME").filter(|p| !p.is_empty()) {
        let path = PathBuf::from(custom);
        return if path.is_absolute() {
            Ok(path)
        } else {
            std::env::current_dir()
                .map(|dir| dir.join(path))
                .map_err(|error| format!("无法解析 ANTIGRAVITY_CLI_HOME：{error}"))
        };
    }
    dirs::home_dir()
        .map(|home| home.join(".gemini").join("antigravity-cli"))
        .ok_or_else(|| "无法确定 Antigravity CLI 数据目录".to_string())
}

#[derive(Debug, Clone, Default)]
struct SummaryMeta {
    title: String,
    project_dir: String,
    updated_at: Option<i64>,
    is_subagent: bool,
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn workspace_uri_to_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed
        .as_bytes()
        .get(..7)
        .is_none_or(|prefix| !prefix.eq_ignore_ascii_case(b"file://"))
    {
        return None;
    }
    let decoded = percent_decode(&trimmed[7..]);
    let mut path = decoded.replace('\\', "/");
    // 本地 Windows URI 为 `file:///D:/...` -> stripped `file://` 后首字符为 `/` 且紧跟盘符
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
        let mut chars: Vec<char> = path[1..].chars().collect();
        chars[0] = chars[0].to_ascii_uppercase();
        path = chars.into_iter().collect();
    } else if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let mut chars: Vec<char> = path.chars().collect();
        chars[0] = chars[0].to_ascii_uppercase();
        path = chars.into_iter().collect();
    }

    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        if cfg!(windows) {
            path = path.replace('/', "\\");
            while path.len() > 3 && path.ends_with('\\') {
                path.pop();
            }
        } else {
            while path.len() > 3 && path.ends_with('/') {
                path.pop();
            }
        }
    } else {
        while path.len() > 1 && path.ends_with('/') {
            path.pop();
        }
    }

    (!path.is_empty()).then_some(path)
}

fn first_workspace_path_from_json_array(raw: &str) -> String {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return String::new();
    };
    items
        .iter()
        .filter_map(Value::as_str)
        .find_map(workspace_uri_to_path)
        .unwrap_or_default()
}

fn read_summary_metadata(root: &Path) -> HashMap<String, SummaryMeta> {
    let mut map = HashMap::new();
    let db_path = root.join("conversation_summaries.db");
    if db_path.is_file() {
        if let Ok(conn) = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            let _ = conn.busy_timeout(Duration::from_secs(2));
            if let Ok(mut stmt) = conn.prepare(
                "SELECT conversation_id, title, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth
                 FROM conversation_summaries",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    ))
                }) {
                    for row in rows.flatten() {
                        let (id, title, modified, uris, parent_id, depth) = row;
                        let id = id.trim().to_string();
                        if id.is_empty() {
                            continue;
                        }
                        map.insert(
                            id,
                            SummaryMeta {
                                title: title.trim().to_string(),
                                project_dir: first_workspace_path_from_json_array(&uris),
                                updated_at: parse_timestamp_str(&modified),
                                is_subagent: !parent_id.trim().is_empty() || depth > 0,
                            },
                        );
                    }
                    if !map.is_empty() {
                        return map;
                    }
                }
            }
        }
    }

    // 兜底读取 cache/conversation_metadata.json
    let cache_path = root.join("cache").join("conversation_metadata.json");
    if !fs::metadata(&cache_path).is_ok_and(|meta| meta.len() <= MAX_CACHE_META_BYTES) {
        return map;
    }
    let Ok(content) = fs::read_to_string(&cache_path) else {
        return map;
    };
    let Ok(Value::Object(root_obj)) = serde_json::from_str::<Value>(&content) else {
        return map;
    };
    let Some(conversations) = root_obj.get("conversations").and_then(Value::as_object) else {
        return map;
    };
    for (id, entry) in conversations {
        let Some(summary) = entry.get("summary") else {
            continue;
        };
        let title = summary
            .get("Title")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let parent_id = summary
            .get("ParentConversationID")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let depth = summary
            .get("NestingDepth")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let project_dir = summary
            .get("Workspaces")
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter().find_map(|ws| {
                    ws.get("WorkspaceFolderAbsoluteUri")
                        .and_then(Value::as_str)
                        .and_then(workspace_uri_to_path)
                })
            })
            .unwrap_or_default();
        let updated_at = summary
            .get("LastModifiedTime")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_str);
        map.insert(
            id.clone(),
            SummaryMeta {
                title,
                project_dir,
                updated_at,
                is_subagent: !parent_id.is_empty() || depth > 0,
            },
        );
    }
    map
}

/// 供终端摘要读取只读会话标题，跳过空标题条目。
pub(super) fn summary_titles(root: &Path) -> HashMap<String, String> {
    read_summary_metadata(root)
        .into_iter()
        .filter_map(|(id, meta)| {
            let trimmed = meta.title.trim();
            (!trimmed.is_empty()).then(|| (id, trimmed.to_string()))
        })
        .collect()
}

/// 收集子代理会话 ID，防止嵌套子代理抢走主会话的终端绑定。
pub(super) fn subagent_conversation_ids(root: &Path) -> HashSet<String> {
    let db_path = root.join("conversation_summaries.db");
    if db_path.is_file() {
        if let Ok(conn) = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            let _ = conn.busy_timeout(Duration::from_secs(2));
            if let Ok(mut stmt) = conn.prepare(
                "SELECT conversation_id FROM conversation_summaries
                 WHERE COALESCE(parent_conversation_id, '') != '' OR COALESCE(nesting_depth, 0) > 0",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                    let mut ids = HashSet::new();
                    for id in rows.flatten() {
                        let trimmed = id.trim();
                        if !trimmed.is_empty() {
                            ids.insert(trimmed.to_string());
                        }
                    }
                    return ids;
                }
            }
        }
    }
    read_summary_metadata(root)
        .into_iter()
        .filter_map(|(id, meta)| meta.is_subagent.then_some(id))
        .collect()
}

#[derive(Clone)]
struct SessionFile {
    id: String,
    path: PathBuf,
    mtime: i64,
    size: i64,
}

fn find_transcript_in_brain_dir(brain_dir: &Path) -> Option<PathBuf> {
    let logs_dir = brain_dir.join(".system_generated").join("logs");
    for name in ["transcript_full.jsonl", "transcript.jsonl"] {
        let candidate = logs_dir.join(name);
        if candidate
            .symlink_metadata()
            .is_ok_and(|meta| meta.file_type().is_file())
        {
            return Some(candidate);
        }
    }
    None
}

fn collect_files(root: &Path, summaries: &HashMap<String, SummaryMeta>) -> Result<Vec<SessionFile>, String> {
    let brain_root = root.join("brain");
    let entries = match fs::read_dir(&brain_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "读取 Antigravity 会话目录 {} 失败: {error}",
                brain_root.display()
            ))
        }
    };

    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取 Antigravity 会话目录条目失败: {error}"))?;
        let kind = entry
            .file_type()
            .map_err(|error| format!("读取 Antigravity 会话目录类型失败: {error}"))?;
        // 不跟随符号链接，避免跳出会话目录边界。
        if !kind.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if id.is_empty() || id.starts_with('.') {
            continue;
        }
        if summaries.get(&id).is_some_and(|meta| meta.is_subagent) {
            continue;
        }
        let Some(path) = find_transcript_in_brain_dir(&entry.path()) else {
            continue;
        };
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("读取 Antigravity 会话文件属性失败: {error}"))?;
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        files.push(SessionFile {
            id,
            path,
            mtime,
            size: metadata.len() as i64,
        });
    }
    Ok(files)
}

fn scan_root(
    conn: &Connection,
    root: &Path,
    limit: usize,
) -> Result<SessionHistoryScanResult, String> {
    let version = conn
        .query_row(
            "SELECT value FROM antigravity_index_state WHERE key = 'analyzer_version'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if version != Some(ANALYZER_VERSION) {
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch("DELETE FROM antigravity_messages; DELETE FROM antigravity_sessions;")
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO antigravity_index_state (key, value) VALUES ('analyzer_version', ?1)",
                [ANALYZER_VERSION],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    let summaries = read_summary_metadata(root);
    let files = collect_files(root, &summaries)?;
    let existing = {
        let mut statement = conn
            .prepare("SELECT session_id, file_path, file_mtime, file_size FROM antigravity_sessions")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ),
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut map = HashMap::new();
        for row in rows {
            let (id, info) = row.map_err(|error| error.to_string())?;
            map.insert(id, info);
        }
        map
    };
    let mut outdated = Vec::new();
    for file in &files {
        let path_str = file.path.to_string_lossy();
        let unchanged = existing.get(&file.id).is_some_and(|(p, mtime, size)| {
            p.as_str() == path_str.as_ref() && *mtime == file.mtime && *size == file.size
        });
        if !unchanged {
            outdated.push(file);
        }
    }
    outdated.sort_by(|a, b| b.mtime.cmp(&a.mtime));

    let mut updated = 0;
    for file in outdated.iter().take(limit) {
        let Ok(content) = fs::read_to_string(&file.path) else {
            continue;
        };
        let transcript = antigravity_transcript::parse(&content);
        let summary = summaries.get(&file.id);
        let title = summary
            .map(|m| m.title.trim())
            .filter(|t| !t.is_empty())
            .map(|t| excerpt(t, 80))
            .or_else(|| {
                (!transcript.first_prompt.is_empty()).then(|| excerpt(&transcript.first_prompt, 80))
            })
            .unwrap_or_else(|| format!("Antigravity 会话 {}", excerpt(&file.id, 8)));
        let project_dir = summary
            .map(|m| m.project_dir.clone())
            .unwrap_or_default();
        let updated_at = transcript
            .updated_at
            .or_else(|| summary.and_then(|m| m.updated_at))
            .unwrap_or(file.mtime);

        let item = SessionHistoryItem {
            session_id: file.id.clone(),
            project_dir,
            file_path: file.path.to_string_lossy().into_owned(),
            title,
            custom_title: None,
            started_at: transcript.started_at,
            updated_at,
            message_count: transcript.message_count,
            input_tokens: transcript.input_tokens,
            output_tokens: transcript.output_tokens,
            model: transcript.model,
            starred: false,
            archived: false,
        };
        let json = serde_json::to_string(&item).map_err(|error| error.to_string())?;
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO antigravity_sessions (session_id, file_path, file_mtime, file_size, project_dir, updated_at, item_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(session_id) DO UPDATE SET file_path=excluded.file_path, file_mtime=excluded.file_mtime,
                 file_size=excluded.file_size, project_dir=excluded.project_dir, updated_at=excluded.updated_at, item_json=excluded.item_json",
                params![file.id, item.file_path, file.mtime, file.size, item.project_dir, item.updated_at, json],
            )
            .map_err(|error| format!("写入 Antigravity 会话索引失败: {error}"))?;
        transaction
            .execute(
                "DELETE FROM antigravity_messages WHERE session_id = ?1",
                [&file.id],
            )
            .map_err(|error| error.to_string())?;
        {
            let mut insert = transaction
                .prepare("INSERT INTO antigravity_messages (session_id, seq, content, timestamp) VALUES (?1, ?2, ?3, ?4)")
                .map_err(|error| error.to_string())?;
            for message in transcript.messages {
                let text = std::iter::once(message.text)
                    .chain(
                        message
                            .tools
                            .into_iter()
                            .map(|tool| format!("{} {}", tool.name, tool.summary)),
                    )
                    .filter(|part| !part.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if text.is_empty() {
                    continue;
                }
                insert
                    .execute(params![file.id, message.seq, text, message.timestamp])
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction
            .commit()
            .map_err(|error| format!("提交 Antigravity 会话索引失败: {error}"))?;
        updated += 1;
    }

    let seen: HashSet<_> = files.iter().map(|file| file.id.as_str()).collect();
    let brain_root = root.join("brain");
    let mut statement = conn
        .prepare("SELECT session_id, file_path FROM antigravity_sessions")
        .map_err(|error| error.to_string())?;
    let stored = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    for (id, path) in stored {
        let path = Path::new(&path);
        let in_root = path.starts_with(&brain_root);
        let is_subagent = summaries.get(&id).is_some_and(|meta| meta.is_subagent);
        if is_subagent || (!seen.contains(id.as_str()) && (!path.exists() || !in_root)) {
            delete_rows(&transaction, &id, false)?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;

    let total = conn
        .query_row("SELECT COUNT(*) FROM antigravity_sessions", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(SessionHistoryScanResult {
        scanned: files.len() as i64,
        updated,
        total,
        pending: outdated.len().saturating_sub(limit) as i64,
    })
}

pub fn scan_and_index(app: &AppHandle) -> Result<SessionHistoryScanResult, String> {
    let root = resolve_antigravity_home()?;
    let conn = DatabaseService::open()?;
    let result = {
        let _guard = index_lock()?;
        scan_root(&conn, &root, BATCH_SIZE)?
    };
    if result.pending > 0 {
        spawn_backfill(app.clone(), conn, root);
    } else {
        crate::services::session_auto_archive_service::run_and_emit(app);
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
                    if finished {
                        crate::services::session_auto_archive_service::run_and_emit(&app);
                    }
                    let _ = app.emit(INDEXED_EVENT, &result);
                    if finished {
                        break;
                    }
                }
                Err(error) => {
                    crate::commands::terminal::log_debug(&format!("[antigravity-history] {error}"));
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
    if let Some(title) = item.custom_title.as_ref().filter(|t| !t.trim().is_empty()) {
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
        "SELECT s.item_json, m.custom_title, COALESCE(m.starred, 0), m.archived
         FROM antigravity_sessions s
         LEFT JOIN antigravity_session_meta m ON m.session_id = s.session_id
         WHERE (?1 IS NULL OR {indexed} = {wanted} OR substr({indexed}, 1, length({wanted}) + 1) = {wanted} || '/')
         ORDER BY COALESCE(m.starred, 0) DESC, s.updated_at DESC",
        indexed = normalized_dir_expr("s.project_dir"),
        wanted = normalized_dir_expr("?1"),
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_dir], read_item)
        .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    for item in rows {
        let item = item.map_err(|error| format!("读取 Antigravity 会话失败: {error}"))?;
        if include_archived || !item.archived {
            result.push(item);
        }
    }
    Ok(result)
}

pub fn list_sessions(
    include_archived: bool,
    project_dir: Option<&str>,
) -> Result<Vec<SessionHistoryItem>, String> {
    list_in(&DatabaseService::open()?, include_archived, project_dir)
}

fn snippet(content: &str, query: &str) -> String {
    let lowered = content.to_lowercase();
    let Some(byte) = lowered.find(&query.to_lowercase()) else {
        return excerpt(content, 100);
    };
    let position = lowered[..byte].chars().count();
    let start = position.saturating_sub(24);
    let text: String = content
        .chars()
        .skip(start)
        .take(query.chars().count() + 72)
        .collect();
    format!("{}{}", if start > 0 { "…" } else { "" }, text)
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
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let sql = format!(
        "SELECT s.item_json, m.custom_title, COALESCE(m.starred, 0), m.archived, msg.seq, msg.content, msg.timestamp
         FROM antigravity_messages msg
         JOIN antigravity_sessions s ON s.session_id = msg.session_id
         LEFT JOIN antigravity_session_meta m ON m.session_id = s.session_id
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
        .map_err(|error| format!("搜索 Antigravity 会话失败: {error}"))
}

pub fn search(query: &str, project_dir: Option<&str>) -> Result<Vec<SessionSearchHit>, String> {
    search_in(&DatabaseService::open()?, query, project_dir)
}

fn item_in(conn: &Connection, session_id: &str) -> Result<SessionHistoryItem, String> {
    conn.query_row(
        "SELECT s.item_json, m.custom_title, COALESCE(m.starred, 0), m.archived
         FROM antigravity_sessions s
         LEFT JOIN antigravity_session_meta m ON m.session_id = s.session_id
         WHERE s.session_id = ?1",
        [session_id],
        read_item,
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "Antigravity 会话记录不存在（可能已被删除）".to_string())
}

fn get_replay_in(
    conn: &Connection,
    session_id: &str,
    offset: usize,
    limit: usize,
) -> Result<SessionReplayPage, String> {
    let item = item_in(conn, session_id)?;
    let content = fs::read_to_string(&item.file_path)
        .map_err(|error| format!("读取 Antigravity 会话失败: {error}"))?;
    let transcript = antigravity_transcript::parse(&content);
    let total = transcript.messages.len() as i64;
    Ok(SessionReplayPage {
        total,
        messages: transcript
            .messages
            .into_iter()
            .skip(offset)
            .take(limit.max(1))
            .collect(),
        title: item.title,
        project_dir: item.project_dir,
        model: transcript.model.or(item.model),
        input_tokens: transcript.input_tokens,
        output_tokens: transcript.output_tokens,
        started_at: transcript.started_at.or(item.started_at),
        updated_at: transcript.updated_at.unwrap_or(item.updated_at),
    })
}

pub fn get_replay(
    session_id: &str,
    offset: usize,
    limit: usize,
) -> Result<SessionReplayPage, String> {
    get_replay_in(&DatabaseService::open()?, session_id, offset, limit)
}

fn rename_in(conn: &Connection, session_id: &str, title: &str) -> Result<(), String> {
    item_in(conn, session_id)?;
    let title = title.trim();
    conn.execute(
        "INSERT INTO antigravity_session_meta (session_id, custom_title) VALUES (?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET custom_title = excluded.custom_title",
        params![
            session_id,
            if title.is_empty() { None } else { Some(title) }
        ],
    )
    .map(|_| ())
    .map_err(|error| format!("重命名 Antigravity 会话失败: {error}"))
}

pub fn rename_session(session_id: &str, title: &str) -> Result<(), String> {
    rename_in(&DatabaseService::open()?, session_id, title)
}

fn set_flags_in(
    conn: &Connection,
    session_id: &str,
    starred: Option<bool>,
    archived: Option<bool>,
) -> Result<(), String> {
    item_in(conn, session_id)?;
    conn.execute(
        "INSERT INTO antigravity_session_meta (session_id, starred, archived) VALUES (?1, COALESCE(?2, 0), ?3)
         ON CONFLICT(session_id) DO UPDATE SET
         starred = COALESCE(?2, antigravity_session_meta.starred),
         archived = COALESCE(?3, antigravity_session_meta.archived)",
        params![session_id, starred, archived],
    )
    .map(|_| ())
    .map_err(|error| format!("更新 Antigravity 会话标记失败: {error}"))?;
    if archived == Some(false) {
        conn.execute(
            "UPDATE antigravity_session_meta
             SET auto_archive_mark = COALESCE(
                 (SELECT updated_at FROM antigravity_sessions WHERE session_id = ?1),
                 auto_archive_mark)
             WHERE session_id = ?1",
            [session_id],
        )
        .map_err(|error| format!("更新 Antigravity 自动归档标记失败: {error}"))?;
    }
    Ok(())
}

pub fn set_flags(
    session_id: &str,
    starred: Option<bool>,
    archived: Option<bool>,
) -> Result<(), String> {
    set_flags_in(&DatabaseService::open()?, session_id, starred, archived)
}

fn delete_rows(conn: &Connection, session_id: &str, metadata: bool) -> Result<(), String> {
    conn.execute(
        "DELETE FROM antigravity_messages WHERE session_id = ?1",
        [session_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM antigravity_sessions WHERE session_id = ?1",
        [session_id],
    )
    .map_err(|error| error.to_string())?;
    if metadata {
        conn.execute(
            "DELETE FROM antigravity_session_meta WHERE session_id = ?1",
            [session_id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn collect_session_log_files(root: &Path, id: &str) -> Vec<PathBuf> {
    let logs_dir = root.join("brain").join(id).join(".system_generated").join("logs");
    let mut paths = Vec::new();
    for name in ["transcript_full.jsonl", "transcript.jsonl"] {
        let candidate = logs_dir.join(name);
        if candidate
            .symlink_metadata()
            .is_ok_and(|meta| meta.file_type().is_file())
        {
            paths.push(candidate);
        }
    }
    paths
}

fn delete_in(
    conn: &mut Connection,
    root: &Path,
    trash: &Path,
    session_ids: &[String],
) -> Result<(), String> {
    let ids: HashSet<_> = session_ids
        .iter()
        .map(String::as_str)
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(());
    }

    let brain_root = root.join("brain");
    let mut seen_paths = HashSet::new();
    let mut to_move = Vec::new();
    for &id in &ids {
        for path in collect_session_log_files(root, id) {
            if seen_paths.insert(path.clone()) {
                to_move.push(path);
            }
        }
        if let Some(stored_path) = conn
            .query_row(
                "SELECT file_path FROM antigravity_sessions WHERE session_id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
        {
            let path = PathBuf::from(stored_path);
            if path.starts_with(&brain_root)
                && path
                    .symlink_metadata()
                    .is_ok_and(|meta| meta.file_type().is_file())
                && seen_paths.insert(path.clone())
            {
                to_move.push(path);
            }
        }
    }

    let mut moved = Vec::new();
    for path in to_move {
        match move_to_trash(&path, trash) {
            Ok(target) => moved.push((path, target)),
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
    outcome.map_err(|error| {
        with_file_restore_error(format!("删除 Antigravity 会话失败: {error}"), &moved)
    })
}

pub fn delete_sessions(session_ids: &[String]) -> Result<(), String> {
    let _guard = index_lock()?;
    let root = resolve_antigravity_home()?;
    let trash = PathService::require_data_dir()?
        .join("Trash")
        .join("antigravity-sessions");
    delete_in(&mut DatabaseService::open()?, &root, &trash, session_ids)
}

pub fn delete_session(session_id: &str) -> Result<(), String> {
    delete_sessions(&[session_id.to_string()])
}

fn export_in(
    conn: &Connection,
    session_id: &str,
    format: &str,
    dest_path: &str,
) -> Result<(), String> {
    let item = item_in(conn, session_id)?;
    if Path::new(dest_path)
        .canonicalize()
        .ok()
        .is_some_and(|dest| Some(dest) == Path::new(&item.file_path).canonicalize().ok())
    {
        return Err("导出路径不能与原始会话文件相同".to_string());
    }
    match format {
        "jsonl" => {
            let bytes = fs::read(&item.file_path)
                .map_err(|error| format!("读取 Antigravity 会话失败: {error}"))?;
            atomic_write(Path::new(dest_path), &bytes)
                .map_err(|error| format!("导出 Antigravity 会话失败: {error}"))
        }
        "markdown" => {
            let page = get_replay_in(conn, session_id, 0, usize::MAX)?;
            let content = render_markdown_for_assistant(
                &page.title,
                &page.project_dir,
                page.model.as_deref(),
                page.total as usize,
                &page.messages,
                "Antigravity",
            );
            atomic_write(Path::new(dest_path), content.as_bytes())
                .map_err(|error| format!("导出 Antigravity 会话失败: {error}"))
        }
        _ => Err("不支持的导出格式".to_string()),
    }
}

pub fn export_session(session_id: &str, format: &str, dest_path: &str) -> Result<(), String> {
    export_in(&DatabaseService::open()?, session_id, format, dest_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("tb-agy-history-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn write_transcript(&self, id: &str, user_text: &str, assistant_text: &str) -> PathBuf {
            let path = self
                .0
                .join("brain")
                .join(id)
                .join(".system_generated")
                .join("logs")
                .join("transcript_full.jsonl");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let lines = [
                json!({
                    "step_index": 0,
                    "source": "USER_EXPLICIT",
                    "type": "USER_INPUT",
                    "created_at": "2026-11-18T04:00:00Z",
                    "content": format!("<USER_REQUEST>\n{user_text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"),
                }),
                json!({
                    "step_index": 1,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "created_at": "2026-11-18T04:00:10Z",
                    "model": "gemini-3-pro-high",
                    "input_tokens": 100,
                    "output_tokens": 40,
                    "content": assistant_text,
                }),
            ];
            fs::write(
                &path,
                lines
                    .into_iter()
                    .map(|l| l.to_string())
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
            .unwrap();
            path
        }

        fn create_summaries_db(&self, rows: &[(&str, &str, &str, &str, i64)]) {
            let db_path = self.0.join("conversation_summaries.db");
            let conn = Connection::open(db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE conversation_summaries (
                    conversation_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '',
                    last_modified_time TEXT NOT NULL DEFAULT '',
                    workspace_uris TEXT NOT NULL DEFAULT '[]',
                    parent_conversation_id TEXT NOT NULL DEFAULT '',
                    nesting_depth INTEGER NOT NULL DEFAULT 0
                );",
            )
            .unwrap();
            for (id, title, uris, parent, depth) in rows {
                conn.execute(
                    "INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth)
                     VALUES (?1, ?2, '2026-11-18 04:05:00+00:00', ?3, ?4, ?5)",
                    params![id, title, uris, parent, depth],
                )
                .unwrap();
            }
        }

        fn connection(&self) -> Connection {
            let conn = Connection::open_in_memory().unwrap();
            init_antigravity_schema(&conn).unwrap();
            conn
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn converts_workspace_uris_to_local_paths() {
        let win = workspace_uri_to_path("file:///d%3A/terminal-buddy");
        let win_plain = workspace_uri_to_path("file:///D:/repo%20name/");
        let unix = workspace_uri_to_path("file:///home/user/my%20app/");
        if cfg!(windows) {
            assert_eq!(win.as_deref(), Some(r"D:\terminal-buddy"));
            assert_eq!(win_plain.as_deref(), Some(r"D:\repo name"));
        } else {
            assert_eq!(win.as_deref(), Some("D:/terminal-buddy"));
            assert_eq!(win_plain.as_deref(), Some("D:/repo name"));
        }
        assert_eq!(unix.as_deref(), Some("/home/user/my app"));
        assert_eq!(workspace_uri_to_path("https://example.com"), None);
    }

    #[test]
    fn indexes_top_level_filters_subagents_searches_replays_exports_and_deletes_to_trash() {
        let fixture = Fixture::new();
        let mut conn = fixture.connection();

        let main_id = "11111111-1111-4111-8111-111111111111";
        let sub_id = "22222222-2222-4222-8222-222222222222";
        fixture.write_transcript(main_id, "如何优化终端渲染", "使用 WebGL 渲染器。");
        fixture.write_transcript(sub_id, "子代理内部任务", "子代理输出");

        let uri = if cfg!(windows) {
            r#"["file:///d%3A/terminal-buddy"]"#
        } else {
            r#"["file:///home/user/terminal-buddy"]"#
        };
        let expected_dir = if cfg!(windows) {
            r"D:\terminal-buddy"
        } else {
            "/home/user/terminal-buddy"
        };

        fixture.create_summaries_db(&[
            (main_id, "终端渲染优化", uri, "", 0),
            (sub_id, "子代理", uri, main_id, 1),
        ]);

        let scan = scan_root(&conn, &fixture.0, 20).unwrap();
        assert_eq!(scan.scanned, 1);
        assert_eq!(scan.updated, 1);

        let items = list_in(&conn, false, Some(expected_dir)).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].session_id, main_id);
        assert_eq!(items[0].title, "终端渲染优化");
        assert_eq!(items[0].project_dir, expected_dir);

        // 重命名 + 搜索 + 回放 + 星标/归档
        rename_in(&conn, main_id, "自定义标题").unwrap();
        let hits = search_in(&conn, "WebGL", Some(expected_dir)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "自定义标题");
        assert_eq!(hits[0].seq, 1);

        let replay = get_replay_in(&conn, main_id, 0, 50).unwrap();
        assert_eq!(replay.title, "自定义标题");
        assert_eq!(replay.messages.len(), 2);

        set_flags_in(&conn, main_id, Some(true), Some(true)).unwrap();
        assert_eq!(list_in(&conn, false, None).unwrap().len(), 0);
        let with_archived = list_in(&conn, true, None).unwrap();
        assert_eq!(with_archived.len(), 1);
        assert!(with_archived[0].starred);

        // 导出 Markdown 与 JSONL
        let md_dest = fixture.0.join("export.md");
        export_in(&conn, main_id, "markdown", md_dest.to_str().unwrap()).unwrap();
        let md_text = fs::read_to_string(&md_dest).unwrap();
        assert!(md_text.contains("## Antigravity"));
        assert!(md_text.contains("自定义标题"));

        let jsonl_dest = fixture.0.join("export.jsonl");
        export_in(&conn, main_id, "jsonl", jsonl_dest.to_str().unwrap()).unwrap();
        assert!(jsonl_dest.is_file());

        // 删除：移入回收目录并清库，不触碰 conversation_summaries.db
        let trash = fixture.0.join("Trash");
        delete_in(&mut conn, &fixture.0, &trash, &[main_id.to_string()]).unwrap();
        assert_eq!(list_in(&conn, true, None).unwrap().len(), 0);
        assert!(trash.exists());
        assert_eq!(fs::read_dir(&trash).unwrap().count(), 1);
        assert!(fixture.0.join("conversation_summaries.db").is_file());
    }

    #[test]
    fn workspace_uri_to_path_handles_non_ascii_without_panicking() {
        assert_eq!(workspace_uri_to_path("中文项目名"), None);
        assert_eq!(workspace_uri_to_path("普通文本12345"), None);
        assert!(workspace_uri_to_path("file:///tmp/%E4%B8%AD%E6%96%87").is_some());
    }
}
