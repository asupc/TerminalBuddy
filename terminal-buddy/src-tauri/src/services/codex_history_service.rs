//! Codex 历史：扫描 CODEX_HOME（默认 ~/.codex）的 rollout，索引与用户标记独立于 Claude。
//! 原始 JSONL 用于回放与导出；删除移到应用回收目录，不改写 Codex 的共享 registry / state DB。
use super::claude_config_service::normalized_dir_expr;
use super::claude_history_service::{
    move_to_trash, render_markdown_for_assistant, with_file_restore_error,
};
use super::codex_transcript::{self, excerpt};
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
const ANALYZER_VERSION: i64 = 2;
static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn index_lock() -> Result<MutexGuard<'static, ()>, String> {
    INDEX_LOCK
        .lock()
        .map_err(|_| "Codex 会话索引锁不可用".to_string())
}

pub fn init_codex_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS codex_sessions (
            session_id TEXT PRIMARY KEY, file_path TEXT NOT NULL,
            file_mtime INTEGER NOT NULL, file_size INTEGER NOT NULL,
            project_dir TEXT NOT NULL, updated_at INTEGER NOT NULL, item_json TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS codex_session_meta (
            session_id TEXT PRIMARY KEY, custom_title TEXT,
            starred INTEGER NOT NULL DEFAULT 0, archived INTEGER,
            auto_archive_mark INTEGER
         );
         CREATE TABLE IF NOT EXISTS codex_messages (
            session_id TEXT NOT NULL, seq INTEGER NOT NULL, content TEXT NOT NULL, timestamp INTEGER,
            PRIMARY KEY (session_id, seq)
         );
         CREATE TABLE IF NOT EXISTS codex_index_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS idx_codex_sessions_updated ON codex_sessions (updated_at DESC);"
    ).map_err(|error| format!("创建 Codex 历史索引失败: {error}"))
}

#[derive(Clone)]
struct SessionFile {
    id: String,
    path: PathBuf,
    mtime: i64,
    size: i64,
    archived: bool,
}

fn session_id(path: &Path) -> Option<String> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    for line in reader.lines().take(64).map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value["type"] == "session_meta" {
            if let Some(id) = value["payload"]["id"]
                .as_str()
                .filter(|id| !id.trim().is_empty())
            {
                return Some(id.to_string());
            }
        }
    }
    let name = path.file_stem()?.to_str()?;
    let suffix = name.get(name.len().checked_sub(36)?..)?;
    uuid::Uuid::parse_str(suffix)
        .ok()
        .map(|_| suffix.to_string())
}

fn collect_files(root: &Path) -> Result<Vec<SessionFile>, String> {
    let mut files = Vec::new();
    for (name, archived) in [("sessions", false), ("archived_sessions", true)] {
        let mut dirs = vec![root.join(name)];
        while let Some(dir) = dirs.pop() {
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "读取 Codex 会话目录 {} 失败: {error}",
                        dir.display()
                    ))
                }
            };
            for entry in entries {
                let entry =
                    entry.map_err(|error| format!("读取 Codex 会话目录条目失败: {error}"))?;
                let kind = entry
                    .file_type()
                    .map_err(|error| format!("读取 Codex 会话文件类型失败: {error}"))?;
                if kind.is_dir() {
                    dirs.push(entry.path());
                    continue;
                }
                // 不跟随符号链接，避免循环目录以及误操作历史目录外的文件。
                if !kind.is_file() {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                    continue;
                }
                let path = entry.path();
                let Some(id) = session_id(&path) else {
                    continue;
                };
                let metadata = entry
                    .metadata()
                    .map_err(|error| format!("读取 Codex 会话文件属性失败: {error}"))?;
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
                    archived,
                });
            }
        }
    }
    Ok(files)
}

pub(super) fn thread_names(root: &Path) -> HashMap<String, String> {
    let path = root.join("session_index.jsonl");
    // registry 只用来补标题；缺失、损坏或过大都不影响 rollout 本身。
    if !fs::metadata(&path).is_ok_and(|meta| meta.len() <= 8 * 1024 * 1024) {
        return HashMap::new();
    }
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    parse_thread_names(&content)
}

fn parse_thread_names(content: &str) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for line in content.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = row
            .get("id")
            .or_else(|| row.get("session_id"))
            .and_then(Value::as_str);
        let title = row
            .get("thread_name")
            .or_else(|| row.get("threadName"))
            .and_then(Value::as_str);
        if let (Some(id), Some(title)) = (id, title) {
            if !id.trim().is_empty() && !title.trim().is_empty() {
                names.insert(id.to_string(), excerpt(title.trim(), 80));
            }
        }
    }
    names
}

fn scan_root(
    conn: &Connection,
    root: &Path,
    limit: usize,
) -> Result<SessionHistoryScanResult, String> {
    let version = conn
        .query_row(
            "SELECT value FROM codex_index_state WHERE key = 'analyzer_version'",
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
            .execute_batch("DELETE FROM codex_messages; DELETE FROM codex_sessions;")
            .map_err(|error| error.to_string())?;
        transaction.execute("INSERT OR REPLACE INTO codex_index_state (key, value) VALUES ('analyzer_version', ?1)", [ANALYZER_VERSION])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let all_files = collect_files(root)?;
    // 同一 ID 的备份副本只列一条，优先活动目录，其次取最新文件。
    let mut by_id = HashMap::<String, SessionFile>::new();
    for file in all_files {
        let replace = by_id.get(&file.id).is_none_or(|old| {
            (old.archived && !file.archived)
                || (old.archived == file.archived && file.mtime > old.mtime)
        });
        if replace {
            by_id.insert(file.id.clone(), file);
        }
    }
    let files: Vec<_> = by_id.into_values().collect();
    let mut outdated = Vec::new();
    let mut check = conn.prepare("SELECT 1 FROM codex_sessions WHERE session_id = ?1 AND file_path = ?2 AND file_mtime = ?3 AND file_size = ?4")
        .map_err(|error| error.to_string())?;
    for file in &files {
        let unchanged = check
            .query_row(
                params![file.id, file.path.to_string_lossy(), file.mtime, file.size],
                |_| Ok(()),
            )
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
        let Ok(content) = fs::read_to_string(&file.path) else {
            continue;
        };
        let transcript = codex_transcript::parse(&content);
        let item = SessionHistoryItem {
            session_id: file.id.clone(),
            project_dir: transcript.project_dir,
            file_path: file.path.to_string_lossy().into_owned(),
            title: transcript
                .title
                .unwrap_or_else(|| format!("Codex 会话 {}", excerpt(&file.id, 8))),
            custom_title: None,
            started_at: transcript.started_at,
            updated_at: transcript.updated_at.unwrap_or(file.mtime),
            message_count: transcript.messages.len() as i64,
            input_tokens: transcript.input_tokens,
            output_tokens: transcript.output_tokens,
            model: transcript.model,
            starred: false,
            archived: file.archived,
        };
        let json = serde_json::to_string(&item).map_err(|error| error.to_string())?;
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO codex_sessions (session_id, file_path, file_mtime, file_size, project_dir, updated_at, item_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(session_id) DO UPDATE SET file_path=excluded.file_path, file_mtime=excluded.file_mtime,
             file_size=excluded.file_size, project_dir=excluded.project_dir, updated_at=excluded.updated_at, item_json=excluded.item_json",
            params![file.id, item.file_path, file.mtime, file.size, item.project_dir, item.updated_at, json],
        ).map_err(|error| format!("写入 Codex 会话索引失败: {error}"))?;
        transaction
            .execute(
                "DELETE FROM codex_messages WHERE session_id = ?1",
                [&file.id],
            )
            .map_err(|error| error.to_string())?;
        {
            let mut insert = transaction.prepare("INSERT INTO codex_messages (session_id, seq, content, timestamp) VALUES (?1, ?2, ?3, ?4)")
                .map_err(|error| error.to_string())?;
            for message in transcript.messages {
                let text = std::iter::once(message.text)
                    .chain(
                        message
                            .tools
                            .into_iter()
                            .map(|tool| format!("{} {}", tool.name, tool.summary)),
                    )
                    .collect::<Vec<_>>()
                    .join("\n");
                insert
                    .execute(params![file.id, message.seq, text, message.timestamp])
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction
            .commit()
            .map_err(|error| format!("提交 Codex 会话索引失败: {error}"))?;
        updated += 1;
    }
    let seen: HashSet<_> = files.iter().map(|file| file.id.as_str()).collect();
    let mut statement = conn
        .prepare("SELECT session_id, file_path FROM codex_sessions")
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
        // 正在追加或暂时不可读的文件保留索引，下次扫描继续尝试。
        let path = Path::new(&path);
        let in_root = path.starts_with(root.join("sessions"))
            || path.starts_with(root.join("archived_sessions"));
        if !seen.contains(id.as_str()) && (!path.exists() || !in_root) {
            delete_rows(&transaction, &id, false)?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    let total = conn
        .query_row("SELECT COUNT(*) FROM codex_sessions", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(SessionHistoryScanResult {
        scanned: files.len() as i64,
        updated,
        total,
        pending: outdated.len().saturating_sub(limit) as i64,
    })
}

pub fn scan_and_index(app: &AppHandle) -> Result<SessionHistoryScanResult, String> {
    let root = super::codex_provider_service::resolve_config_dir()?;
    let conn = DatabaseService::open()?;
    let result = {
        let _guard = index_lock()?;
        scan_root(&conn, &root, BATCH_SIZE)?
    };
    if result.pending > 0 {
        spawn_backfill(app.clone(), conn, root);
    } else {
        // 索引已是最新：顺手执行一次自动归档，让刚打开的列表直接反映归档状态。
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
                    // 索引补齐到尽头后再自动归档：先归档再广播，面板重取列表时已是归档后的状态。
                    if finished {
                        crate::services::session_auto_archive_service::run_and_emit(&app);
                    }
                    let _ = app.emit("codex-history-indexed", &result);
                    if finished {
                        break;
                    }
                }
                Err(error) => {
                    crate::commands::terminal::log_debug(&format!("[codex-history] {error}"));
                    break;
                }
            }
        }
    });
}

fn read_item(
    row: &rusqlite::Row<'_>,
    names: &HashMap<String, String>,
) -> rusqlite::Result<SessionHistoryItem> {
    let json: String = row.get(0)?;
    let mut item: SessionHistoryItem = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    item.custom_title = row.get(1)?;
    item.starred = row.get::<_, i64>(2)? != 0;
    item.archived = row.get::<_, Option<bool>>(3)?.unwrap_or(item.archived);
    if let Some(title) = item
        .custom_title
        .as_ref()
        .or_else(|| names.get(&item.session_id))
    {
        item.title = title.clone();
    }
    Ok(item)
}

fn list_in(
    conn: &Connection,
    names: &HashMap<String, String>,
    include_archived: bool,
    project_dir: Option<&str>,
) -> Result<Vec<SessionHistoryItem>, String> {
    let sql = format!(
        "SELECT s.item_json, m.custom_title, COALESCE(m.starred, 0), m.archived FROM codex_sessions s
         LEFT JOIN codex_session_meta m ON m.session_id = s.session_id
         WHERE (?1 IS NULL OR {indexed} = {wanted} OR substr({indexed}, 1, length({wanted}) + 1) = {wanted} || '/')
         ORDER BY s.updated_at DESC",
        indexed=normalized_dir_expr("s.project_dir"), wanted=normalized_dir_expr("?1"),
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_dir], |row| read_item(row, names))
        .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    for item in rows {
        let item = item.map_err(|error| format!("读取 Codex 会话失败: {error}"))?;
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
    let root = super::codex_provider_service::resolve_config_dir()?;
    list_in(
        &DatabaseService::open()?,
        &thread_names(&root),
        include_archived,
        project_dir,
    )
}

fn search_in(
    conn: &Connection,
    names: &HashMap<String, String>,
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
         FROM codex_messages msg JOIN codex_sessions s ON s.session_id = msg.session_id
         LEFT JOIN codex_session_meta m ON m.session_id = s.session_id
         WHERE msg.content LIKE ?1 ESCAPE '\\'
           AND (?2 IS NULL OR {indexed} = {wanted} OR substr({indexed}, 1, length({wanted}) + 1) = {wanted} || '/')
         ORDER BY s.updated_at DESC, msg.seq LIMIT 100",
        indexed=normalized_dir_expr("s.project_dir"), wanted=normalized_dir_expr("?2"),
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![pattern, project_dir], |row| {
            let item = read_item(row, names)?;
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
        .map_err(|error| format!("搜索 Codex 会话失败: {error}"))
}

fn snippet(content: &str, query: &str) -> String {
    let lowered = content.to_lowercase();
    let Some(byte) = lowered.find(&query.to_lowercase()) else {
        return excerpt(content, 100);
    };
    // 先按字符计算位置，中文命中不能把 UTF-8 字节偏移当成字符数量。
    let position = lowered[..byte].chars().count();
    let start = position.saturating_sub(24);
    let text: String = content
        .chars()
        .skip(start)
        .take(query.chars().count() + 72)
        .collect();
    format!("{}{}", if start > 0 { "…" } else { "" }, text)
}

pub fn search(query: &str, project_dir: Option<&str>) -> Result<Vec<SessionSearchHit>, String> {
    let root = super::codex_provider_service::resolve_config_dir()?;
    search_in(
        &DatabaseService::open()?,
        &thread_names(&root),
        query,
        project_dir,
    )
}

fn item_in(
    conn: &Connection,
    names: &HashMap<String, String>,
    session_id: &str,
) -> Result<SessionHistoryItem, String> {
    conn.query_row(
        "SELECT s.item_json, m.custom_title, COALESCE(m.starred, 0), m.archived FROM codex_sessions s
         LEFT JOIN codex_session_meta m ON m.session_id = s.session_id WHERE s.session_id = ?1",
        [session_id], |row| read_item(row, names),
    ).optional().map_err(|error| error.to_string())?.ok_or_else(|| "Codex 会话记录不存在（可能已被删除）".to_string())
}

pub fn get_replay(
    session_id: &str,
    offset: usize,
    limit: usize,
) -> Result<SessionReplayPage, String> {
    let root = super::codex_provider_service::resolve_config_dir()?;
    let item = item_in(&DatabaseService::open()?, &thread_names(&root), session_id)?;
    let content = fs::read_to_string(&item.file_path)
        .map_err(|error| format!("读取 Codex 会话失败: {error}"))?;
    let transcript = codex_transcript::parse(&content);
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

pub fn rename_session(session_id: &str, title: &str) -> Result<(), String> {
    let conn = DatabaseService::open()?;
    item_in(&conn, &HashMap::new(), session_id)?;
    let title = title.trim();
    conn.execute(
        "INSERT INTO codex_session_meta (session_id, custom_title) VALUES (?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET custom_title = excluded.custom_title",
        params![
            session_id,
            if title.is_empty() { None } else { Some(title) }
        ],
    )
    .map(|_| ())
    .map_err(|error| format!("重命名 Codex 会话失败: {error}"))
}

pub fn set_flags(
    session_id: &str,
    starred: Option<bool>,
    archived: Option<bool>,
) -> Result<(), String> {
    let conn = DatabaseService::open()?;
    item_in(&conn, &HashMap::new(), session_id)?;
    conn.execute(
        "INSERT INTO codex_session_meta (session_id, starred, archived) VALUES (?1, COALESCE(?2, 0), ?3)
         ON CONFLICT(session_id) DO UPDATE SET starred=COALESCE(?2, codex_session_meta.starred),
         archived=COALESCE(?3, codex_session_meta.archived)", params![session_id, starred, archived],
    ).map(|_| ()).map_err(|error| format!("更新 Codex 会话标记失败: {error}"))?;
    // 手动取消归档时同步记下当前版本，避免下一轮自动归档立刻把同一版本又归档回去。
    if archived == Some(false) {
        conn.execute(
            "UPDATE codex_session_meta
             SET auto_archive_mark = COALESCE(
                 (SELECT updated_at FROM codex_sessions WHERE session_id = ?1),
                 auto_archive_mark)
             WHERE session_id = ?1",
            [session_id],
        )
        .map_err(|error| format!("更新 Codex 自动归档标记失败: {error}"))?;
    }
    Ok(())
}

fn delete_rows(conn: &Connection, session_id: &str, metadata: bool) -> Result<(), String> {
    conn.execute(
        "DELETE FROM codex_messages WHERE session_id = ?1",
        [session_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM codex_sessions WHERE session_id = ?1",
        [session_id],
    )
    .map_err(|error| error.to_string())?;
    if metadata {
        conn.execute(
            "DELETE FROM codex_session_meta WHERE session_id = ?1",
            [session_id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
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
    // 收集相同 ID 的全部 rollout 副本，避免删除后被另一个副本重新索引。
    let files = collect_files(root)?;
    for id in &ids {
        let path = conn
            .query_row(
                "SELECT file_path FROM codex_sessions WHERE session_id = ?1",
                [*id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(path) = path {
            if Path::new(&path).exists()
                && !files
                    .iter()
                    .any(|file| file.path == Path::new(&path) && ids.contains(file.id.as_str()))
            {
                return Err("会话文件当前不可读取，请刷新列表后重试".to_string());
            }
        }
    }
    let mut moved = Vec::new();
    for file in files
        .into_iter()
        .filter(|file| ids.contains(file.id.as_str()))
    {
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
    outcome
        .map_err(|error| with_file_restore_error(format!("删除 Codex 会话失败: {error}"), &moved))
}

pub fn delete_sessions(session_ids: &[String]) -> Result<(), String> {
    let _guard = index_lock()?;
    let root = super::codex_provider_service::resolve_config_dir()?;
    let trash = PathService::require_data_dir()?
        .join("Trash")
        .join("codex-sessions");
    delete_in(&mut DatabaseService::open()?, &root, &trash, session_ids)
}

pub fn delete_session(session_id: &str) -> Result<(), String> {
    delete_sessions(&[session_id.to_string()])
}

pub fn export_session(session_id: &str, format: &str, dest_path: &str) -> Result<(), String> {
    let root = super::codex_provider_service::resolve_config_dir()?;
    let item = item_in(&DatabaseService::open()?, &thread_names(&root), session_id)?;
    // 防止导出覆盖正在使用的原始转录。
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
            .map_err(|error| format!("导出 Codex 会话失败: {error}")),
        "markdown" => {
            let page = get_replay(session_id, 0, usize::MAX)?;
            let content = render_markdown_for_assistant(
                &page.title,
                &page.project_dir,
                page.model.as_deref(),
                page.total as usize,
                &page.messages,
                "Codex",
            );
            fs::write(dest_path, content).map_err(|error| format!("导出 Codex 会话失败: {error}"))
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
            let root =
                std::env::temp_dir().join(format!("tb-codex-history-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn write(&self, relative: &str, id: &str, cwd: &str, text: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let lines = [
                json!({"type":"session_meta","timestamp":"2026-10-18T00:00:00Z","payload":{"id":id,"cwd":cwd}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"这是回复"}]}}),
            ];
            fs::write(
                &path,
                lines
                    .into_iter()
                    .map(|line| line.to_string())
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\n{partial",
            )
            .unwrap();
            path
        }
        fn connection(&self) -> Connection {
            let conn = Connection::open_in_memory().unwrap();
            init_codex_schema(&conn).unwrap();
            conn
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn indexes_nested_rollouts_native_archives_and_metadata_id() {
        let fixture = Fixture::new();
        let conn = fixture.connection();
        fixture.write(
            "sessions/2026/10/18/rollout-wrong-name.jsonl",
            "real-id",
            r"D:\项目\子目录",
            "中文问题",
        );
        fixture.write(
            "archived_sessions/rollout-old.jsonl",
            "archived-id",
            r"D:\其他",
            "旧问题",
        );
        fs::write(fixture.0.join("sessions/ignored.jsonl"), "not a rollout").unwrap();
        let scan = scan_root(&conn, &fixture.0, 60).unwrap();
        assert_eq!(
            (scan.scanned, scan.updated, scan.total, scan.pending),
            (2, 2, 2, 0)
        );
        let names = parse_thread_names("{broken\n{\"id\":\"real-id\",\"thread_name\":\"旧标题\"}\n{\"id\":\"real-id\",\"thread_name\":\"官方新标题\"}");
        let items = list_in(&conn, &names, false, Some("d:/项目")).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].session_id, "real-id");
        assert_eq!(items[0].title, "官方新标题");
        assert_eq!(items[0].message_count, 2);
        assert_eq!(list_in(&conn, &names, true, None).unwrap().len(), 2);
        assert!(list_in(&conn, &names, true, Some(r"D:\项目外"))
            .unwrap()
            .is_empty());
        let repeat = scan_root(&conn, &fixture.0, 60).unwrap();
        assert_eq!(repeat.updated, 0);
    }

    #[test]
    fn batches_incremental_updates_preserve_marks_and_prune_missing_files() {
        let fixture = Fixture::new();
        let conn = fixture.connection();
        let a = fixture.write("sessions/rollout-a.jsonl", "a", "/work/app", "first");
        fixture.write("sessions/rollout-b.jsonl", "b", "/work/other", "second");
        let first = scan_root(&conn, &fixture.0, 1).unwrap();
        assert_eq!((first.total, first.pending), (1, 1));
        assert_eq!(scan_root(&conn, &fixture.0, 1).unwrap().total, 2);
        conn.execute("INSERT INTO codex_session_meta (session_id, custom_title, starred, archived) VALUES ('a', '自定义', 1, 1)", []).unwrap();
        fixture.write(
            "sessions/rollout-a.jsonl",
            "a",
            "/work/app",
            "changed question",
        );
        assert_eq!(scan_root(&conn, &fixture.0, 60).unwrap().updated, 1);
        let items = list_in(&conn, &HashMap::new(), true, Some("/work/app")).unwrap();
        assert_eq!(items[0].title, "自定义");
        assert!(items[0].starred && items[0].archived);
        fs::remove_file(a).unwrap();
        assert_eq!(scan_root(&conn, &fixture.0, 60).unwrap().total, 1);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM codex_messages WHERE session_id='a'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        // 索引重建与磁盘暂时缺失均保留用户标记。
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM codex_session_meta WHERE session_id='a'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn searches_chinese_literal_wildcards_and_keeps_replay_sequence() {
        let fixture = Fixture::new();
        let conn = fixture.connection();
        fixture.write(
            "sessions/rollout-a.jsonl",
            "a",
            "/work/app/child",
            &format!("{}命中中文 100%_ end", "前".repeat(100)),
        );
        fixture.write(
            "sessions/rollout-b.jsonl",
            "b",
            "/work/application",
            "100xx",
        );
        scan_root(&conn, &fixture.0, 60).unwrap();
        let names = HashMap::new();
        let hits = search_in(&conn, &names, "命中中文", Some("/work/app")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].seq, 0);
        assert!(hits[0].snippet.contains("命中中文"));
        assert_eq!(search_in(&conn, &names, "100%_", None).unwrap().len(), 1);
        assert!(search_in(&conn, &names, " ", None).unwrap().is_empty());
    }

    #[test]
    fn batch_delete_restores_files_on_database_error_and_removes_duplicate_rollouts() {
        let fixture = Fixture::new();
        let mut conn = fixture.connection();
        let a = fixture.write("sessions/rollout-a.jsonl", "same-id", "/work", "保留原文");
        let b = fixture.write(
            "archived_sessions/rollout-copy.jsonl",
            "same-id",
            "/work",
            "保留原文",
        );
        let registry = fixture.0.join("session_index.jsonl");
        fs::write(&registry, "shared registry bytes").unwrap();
        scan_root(&conn, &fixture.0, 60).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON codex_sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        let trash = fixture.0.join("Trash");
        assert!(delete_in(&mut conn, &fixture.0, &trash, &["same-id".to_string()]).is_err());
        assert!(a.exists() && b.exists());
        assert_eq!(
            list_in(&conn, &HashMap::new(), true, None).unwrap().len(),
            1
        );
        conn.execute_batch("DROP TRIGGER reject_delete;").unwrap();
        delete_in(
            &mut conn,
            &fixture.0,
            &trash,
            &["same-id".to_string(), "same-id".to_string()],
        )
        .unwrap();
        assert!(!a.exists() && !b.exists());
        assert_eq!(fs::read_dir(&trash).unwrap().count(), 2);
        assert_eq!(
            fs::read_to_string(&registry).unwrap(),
            "shared registry bytes"
        );
        assert_eq!(scan_root(&conn, &fixture.0, 60).unwrap().total, 0);
    }

    #[test]
    fn analyzer_rebuild_keeps_marks_and_claude_index_is_independent() {
        let fixture = Fixture::new();
        let conn = fixture.connection();
        super::super::claude_history_service::init_claude_schema(&conn).unwrap();
        conn.execute("INSERT INTO claude_session_meta (session_id, custom_title) VALUES ('a', 'Claude 标题')", []).unwrap();
        fixture.write("sessions/rollout-a.jsonl", "a", "/work", "Codex 标题");
        scan_root(&conn, &fixture.0, 60).unwrap();
        conn.execute("INSERT INTO codex_session_meta (session_id, custom_title) VALUES ('a', 'Codex 自定义')", []).unwrap();
        conn.execute(
            "UPDATE codex_index_state SET value=0 WHERE key='analyzer_version'",
            [],
        )
        .unwrap();
        scan_root(&conn, &fixture.0, 60).unwrap();
        assert_eq!(
            list_in(&conn, &HashMap::new(), false, None).unwrap()[0].title,
            "Codex 自定义"
        );
        assert_eq!(
            conn.query_row(
                "SELECT custom_title FROM claude_session_meta WHERE session_id='a'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "Claude 标题"
        );
        let messages = codex_transcript::parse("{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"回复\"}}").messages;
        let markdown = render_markdown_for_assistant("标题", "/work", None, 1, &messages, "Codex");
        assert!(markdown.contains("## Codex"));
        assert!(!markdown.contains("## Claude"));
    }
}
