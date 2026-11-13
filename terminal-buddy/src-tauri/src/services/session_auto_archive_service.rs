//! Agent 历史会话自动归档：把超过设定天数未使用的 Claude / Codex 会话标记为已归档。
//!
//! 「未使用」以历史索引里的 `updated_at` 为准（会话最后一次产生内容的时间）。
//! 收藏的会话永不自动归档；用户手动取消归档的会话不会被下一轮立刻重新归档：
//! `auto_archive_mark` 记录自动归档时的 `updated_at`，只有会话再次更新
//! （`updated_at` 前移）并重新超过阈值后才会再次获得归档资格。
use crate::runtime::{AppHandle, Emitter};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use super::{DatabaseService, SettingsService};

/// 自动归档完成后广播：打开着的历史面板据此重取列表。
pub const AUTO_ARCHIVED_EVENT: &str = "agent-history-auto-archived";
/// 自动归档天数允许范围：1 天到 10 年，防止误设 0 把所有会话一次清空。
pub const MIN_DAYS: u32 = 1;
pub const MAX_DAYS: u32 = 3650;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// 启动首轮延后：避开启动阶段的索引与设置加载，之后每 6 小时检查一次。
const STARTUP_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// 同一时刻只允许一个归档任务（启动定时、面板扫描完成、手动保存可能并发）。
static RUN_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoArchiveResult {
    pub claude: usize,
    pub codex: usize,
    pub days: u32,
}

/// 为历史元数据表补上自动归档标记列（老库由数据库迁移调用，新库建表时已包含）。
pub(crate) fn ensure_auto_archive_column(conn: &Connection, table: &str) -> Result<(), String> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info(?1) WHERE name = 'auto_archive_mark'",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("读取 {table} 表结构失败: {error}"))?
        .is_some();
    if exists {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN auto_archive_mark INTEGER"),
        [],
    )
    .map(|_| ())
    .map_err(|error| format!("为 {table} 增加自动归档标记失败: {error}"))
}

/// 按当前设置执行一次自动归档（启动定时任务、扫描完成、保存设置后调用）。
pub fn run_from_settings() -> Result<AutoArchiveResult, String> {
    let settings = SettingsService::get_settings();
    archive_stale(settings.agent_auto_archive_enabled, settings.agent_auto_archive_days)
}

/// 执行一次自动归档；`enabled = false` 时直接返回，不做任何查询。
pub fn archive_stale(enabled: bool, days: u32) -> Result<AutoArchiveResult, String> {
    let days = days.clamp(MIN_DAYS, MAX_DAYS);
    if !enabled {
        return Ok(AutoArchiveResult { days, ..Default::default() });
    }
    let _guard = RUN_LOCK.lock().map_err(|_| "自动归档锁不可用".to_string())?;
    let conn = DatabaseService::open()?;
    let cutoff = chrono::Utc::now().timestamp_millis() - i64::from(days) * DAY_MS;
    let claude = archive_claude(&conn, cutoff)?;
    let codex = archive_codex(&conn, cutoff)?;
    Ok(AutoArchiveResult { claude, codex, days })
}

/// 执行一次并广播结果：只在确实归档了会话时通知，避免面板无意义地反复刷新。
pub fn run_and_emit(app: &AppHandle) {
    match run_from_settings() {
        Ok(result) if result.claude + result.codex > 0 => {
            let _ = app.emit(AUTO_ARCHIVED_EVENT, &result);
        }
        Ok(_) => {}
        Err(error) => {
            crate::commands::terminal::log_debug(&format!("[auto-archive] {error}"));
        }
    }
}

/// 启动后台周期任务：启动 30 秒后检查一次，之后每 6 小时一次。
/// 归档依赖历史索引，未打开过历史面板时索引里可能还没有旧会话；
/// 因此面板扫描完成处也会补跑一次（见各历史服务的 scan_and_index / 后台补齐）。
pub fn start(app: AppHandle) {
    crate::runtime::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            let job = app.clone();
            let _ = crate::runtime::async_runtime::spawn_blocking(move || run_and_emit(&job)).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

fn archive_claude(conn: &Connection, cutoff: i64) -> Result<usize, String> {
    conn.execute(
        "INSERT INTO claude_session_meta (session_id, starred, archived, auto_archive_mark)
         SELECT s.session_id, 0, 1, s.updated_at
         FROM claude_sessions s
         LEFT JOIN claude_session_meta m ON m.session_id = s.session_id
         WHERE s.updated_at < ?1
           AND COALESCE(m.starred, 0) = 0
           AND COALESCE(m.archived, 0) = 0
           AND (m.auto_archive_mark IS NULL OR m.auto_archive_mark < s.updated_at)
         ON CONFLICT(session_id) DO UPDATE SET
           archived = 1,
           auto_archive_mark = excluded.auto_archive_mark",
        [cutoff],
    )
    .map_err(|error| format!("自动归档 Claude 会话失败: {error}"))
}

fn archive_codex(conn: &Connection, cutoff: i64) -> Result<usize, String> {
    conn.execute(
        "INSERT INTO codex_session_meta (session_id, starred, archived, auto_archive_mark)
         SELECT s.session_id, 0, 1, s.updated_at
         FROM codex_sessions s
         LEFT JOIN codex_session_meta m ON m.session_id = s.session_id
         WHERE s.updated_at < ?1
           AND COALESCE(m.starred, 0) = 0
           AND COALESCE(m.archived, 0) = 0
           AND (m.auto_archive_mark IS NULL OR m.auto_archive_mark < s.updated_at)
         ON CONFLICT(session_id) DO UPDATE SET
           archived = 1,
           auto_archive_mark = excluded.auto_archive_mark",
        [cutoff],
    )
    .map_err(|error| format!("自动归档 Codex 会话失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::claude_history_service::init_claude_schema;
    use crate::services::codex_history_service::init_codex_schema;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().expect("内存库");
        init_claude_schema(&conn).expect("Claude 建表");
        init_codex_schema(&conn).expect("Codex 建表");
        conn
    }

    fn insert_session(conn: &Connection, id: &str, updated_at: i64) {
        conn.execute(
            "INSERT INTO claude_sessions (session_id, project_dir, file_path, file_mtime, file_size,
                title, first_prompt, started_at, updated_at, message_count, input_tokens,
                output_tokens, model, indexed_at)
             VALUES (?1, '', '/tmp/x.jsonl', 0, 0, 't', 'p', 0, ?2, 1, 0, 0, NULL, 0)",
            rusqlite::params![id, updated_at],
        ).expect("写 Claude 会话");
        conn.execute(
            "INSERT INTO codex_sessions (session_id, file_path, file_mtime, file_size,
                project_dir, updated_at, item_json)
             VALUES (?1, '/tmp/r.jsonl', 0, 0, '', ?2, '{}')",
            rusqlite::params![id, updated_at],
        ).expect("写 Codex 会话");
    }

    fn archived(conn: &Connection, claude: bool, id: &str) -> bool {
        let table = if claude { "claude_session_meta" } else { "codex_session_meta" };
        // 没有元数据行时视为未归档：用子查询保证始终返回一行。
        conn.query_row(
            &format!("SELECT COALESCE((SELECT archived FROM {table} WHERE session_id = ?1), 0)"),
            [id],
            |row| row.get::<_, i64>(0),
        ).expect("读归档状态") != 0
    }

    #[test]
    fn archives_only_stale_unstarred_sessions() {
        let conn = conn();
        let now = chrono::Utc::now().timestamp_millis();
        let old = now - 40 * DAY_MS;
        insert_session(&conn, "old", old);
        insert_session(&conn, "fresh", now);
        insert_session(&conn, "starred", old);
        conn.execute(
            "INSERT INTO claude_session_meta (session_id, starred) VALUES ('starred', 1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO codex_session_meta (session_id, starred) VALUES ('starred', 1)",
            [],
        ).unwrap();

        let cutoff = now - i64::from(30) * DAY_MS;
        assert_eq!(archive_claude(&conn, cutoff).unwrap(), 1);
        assert_eq!(archive_codex(&conn, cutoff).unwrap(), 1);
        assert!(archived(&conn, true, "old"));
        assert!(archived(&conn, false, "old"));
        assert!(!archived(&conn, true, "fresh"));
        assert!(!archived(&conn, true, "starred"));
    }

    #[test]
    fn manual_unarchive_is_not_reapplied_until_session_changes() {
        let conn = conn();
        let now = chrono::Utc::now().timestamp_millis();
        let old = now - 40 * DAY_MS;
        insert_session(&conn, "old", old);
        let cutoff = now - i64::from(30) * DAY_MS;
        assert_eq!(archive_claude(&conn, cutoff).unwrap(), 1);

        // 用户手动取消归档：同一 updated_at 下不应被下一轮重新归档。
        conn.execute("UPDATE claude_session_meta SET archived = 0 WHERE session_id = 'old'", []).unwrap();
        assert_eq!(archive_claude(&conn, cutoff).unwrap(), 0);
        assert!(!archived(&conn, true, "old"));

        // 会话再次被使用后 updated_at 前移，过期后重新获得归档资格。
        conn.execute("UPDATE claude_sessions SET updated_at = ?1 WHERE session_id = 'old'", [old + 1]).unwrap();
        assert_eq!(archive_claude(&conn, cutoff).unwrap(), 1);
        assert!(archived(&conn, true, "old"));
    }

    #[test]
    fn disabled_does_nothing() {
        let result = archive_stale(false, 30).unwrap();
        assert_eq!(result.claude + result.codex, 0);
    }
}
