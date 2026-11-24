use crate::services::PathService;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

fn migrated_dbs() -> &'static Mutex<HashSet<PathBuf>> {
    static MIGRATED_DBS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    MIGRATED_DBS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub struct DatabaseService;

impl DatabaseService {
    /// 把 WAL 合并回主库（迁移数据目录前调用），减少 db 与 -wal 非同一快照的窗口。
    pub(crate) fn checkpoint() -> Result<(), String> {
        let connection = Self::open()?;
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|error| format!("SQLite checkpoint 失败: {}", error))
    }

    pub(crate) fn open() -> Result<Connection, String> {
        // 数据库是持久写入方，必须走 require：自定义目录不可用时显式失败，
        // 绝不能在默认目录另开一个数据库。
        let data_dir = PathService::require_data_dir()?;
        Self::open_at(&data_dir)
    }

    /// 在指定数据目录打开数据库（导入到默认目录时不能沿用当前自定义目录）。
    pub(crate) fn open_at(data_dir: &std::path::Path) -> Result<Connection, String> {
        fs::create_dir_all(data_dir).map_err(|error| format!("创建数据库目录失败: {}", error))?;
        let db_path = data_dir.join("terminal_buddy.db");
        let existed_before_open = db_path.exists();
        let mut connection = Connection::open(&db_path)
            .map_err(|error| format!("打开 SQLite 数据库失败: {}", error))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("设置 SQLite 超时失败: {}", error))?;
        let already_migrated = existed_before_open
            && migrated_dbs()
                .lock()
                .map(|set| set.contains(&db_path))
                .unwrap_or(false);
        if already_migrated {
            connection
                .execute_batch(
                    "PRAGMA foreign_keys = ON;
                     PRAGMA synchronous = NORMAL;
                     PRAGMA temp_store = MEMORY;
                     PRAGMA cache_size = -4000;",
                )
                .map_err(|error| format!("配置 SQLite 连接失败: {}", error))?;
            return Ok(connection);
        }
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA temp_store = MEMORY;
                 PRAGMA cache_size = -4000;
                 CREATE TABLE IF NOT EXISTS schema_migrations (
                    name TEXT PRIMARY KEY
                 );
                 CREATE TABLE IF NOT EXISTS app_documents (
                    key TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
",
            )
            .map_err(|error| format!("初始化 SQLite 数据库失败: {}", error))?;
        Self::run_migrations(&mut connection)?;
        if let Ok(mut set) = migrated_dbs().lock() {
            if set.len() >= 16 {
                set.clear();
            }
            set.insert(db_path);
        }
        Ok(connection)
    }

    fn has_migration(connection: &Connection, name: &str) -> Result<bool, String> {
        connection
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE name = ?1",
                [name],
                |_| Ok(()),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(|error| format!("读取数据库迁移状态失败: {}", error))
    }

    fn complete_migration(transaction: &Transaction<'_>, name: &str) -> Result<(), String> {
        transaction
            .execute("INSERT INTO schema_migrations (name) VALUES (?1)", [name])
            .map_err(|error| format!("记录数据库迁移状态失败: {}", error))?;
        Ok(())
    }

    fn run_migrations(connection: &mut Connection) -> Result<(), String> {
        if !Self::has_migration(connection, "claude-providers-v1")? {
            let transaction = connection.transaction().map_err(|e| format!("开始模型配置迁移失败: {e}"))?;
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS claude_providers (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    encrypted_config TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS claude_provider_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    active_provider_id TEXT REFERENCES claude_providers(id),
                    encrypted_baseline TEXT
                 );
                 INSERT OR IGNORE INTO claude_provider_state (id) VALUES (1);"
            ).map_err(|e| format!("创建模型配置表失败: {e}"))?;
            Self::complete_migration(&transaction, "claude-providers-v1")?;
            transaction.commit().map_err(|e| format!("提交模型配置迁移失败: {e}"))?;
        }
        if !Self::has_migration(connection, "legacy-command-history-v1")? {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开始命令历史迁移失败: {}", error))?;
            // 读迁移：目录不可用时跳过这条迁移内容，不影响数据库本身打开
            let data_dir = PathService::require_data_dir().unwrap_or_default();
            let client_data = data_dir.join("ClientData").join("command_history.json");
            let legacy_data = data_dir.join("command_history.json");
            let content = fs::read_to_string(&client_data)
                .or_else(|_| fs::read_to_string(&legacy_data))
                .ok();
            if let Some(content) =
                content.filter(|value| serde_json::from_str::<Value>(value).is_ok())
            {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO app_documents (key, content, updated_at) VALUES ('command_history', ?1, ?2)",
                        params![content, chrono::Utc::now().timestamp_millis()],
                    )
                    .map_err(|error| format!("迁移命令历史失败: {}", error))?;
            }
            Self::complete_migration(&transaction, "legacy-command-history-v1")?;
            transaction
                .commit()
                .map_err(|error| format!("提交命令历史迁移失败: {}", error))?;
        }

        if !Self::has_migration(connection, "claude-history-v1")? {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开始 Claude 历史索引迁移失败: {}", error))?;
            crate::services::claude_history_service::init_claude_schema(&transaction)?;
            Self::complete_migration(&transaction, "claude-history-v1")?;
            transaction
                .commit()
                .map_err(|error| format!("提交 Claude 历史索引迁移失败: {}", error))?;
        }

        // 建表只在 v1 跑过一次，后续往 init_claude_schema 里加表必须再来一档，
        // 否则老库永远拿不到新表（init_claude_schema 全部是 IF NOT EXISTS，可重复执行）。
        if !Self::has_migration(connection, "claude-history-v2")? {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开始 Claude 索引状态表迁移失败: {}", error))?;
            crate::services::claude_history_service::init_claude_schema(&transaction)?;
            Self::complete_migration(&transaction, "claude-history-v2")?;
            transaction
                .commit()
                .map_err(|error| format!("提交 Claude 索引状态表迁移失败: {}", error))?;
        }
        if !Self::has_migration(connection, "codex-history-v1")? {
            let transaction = connection.transaction().map_err(|error| format!("开始 Codex 历史迁移失败: {error}"))?;
            crate::services::codex_history_service::init_codex_schema(&transaction)?;
            Self::complete_migration(&transaction, "codex-history-v1")?;
            transaction.commit().map_err(|error| format!("提交 Codex 历史迁移失败: {error}"))?;
        }
        // 自动归档需要记录「上次自动归档时的会话版本」：老库用 ALTER 补列，
        // 新库在建表语句里已包含该列，这里只做幂等检查。
        if !Self::has_migration(connection, "claude-history-v3")? {
            let transaction = connection.transaction().map_err(|error| format!("开始 Claude 自动归档列迁移失败: {error}"))?;
            crate::services::session_auto_archive_service::ensure_auto_archive_column(&transaction, "claude_session_meta")?;
            Self::complete_migration(&transaction, "claude-history-v3")?;
            transaction.commit().map_err(|error| format!("提交 Claude 自动归档列迁移失败: {error}"))?;
        }
        if !Self::has_migration(connection, "codex-history-v2")? {
            let transaction = connection.transaction().map_err(|error| format!("开始 Codex 自动归档列迁移失败: {error}"))?;
            crate::services::session_auto_archive_service::ensure_auto_archive_column(&transaction, "codex_session_meta")?;
            Self::complete_migration(&transaction, "codex-history-v2")?;
            transaction.commit().map_err(|error| format!("提交 Codex 自动归档列迁移失败: {error}"))?;
        }
        if !Self::has_migration(connection, "antigravity-history-v1")? {
            let transaction = connection.transaction().map_err(|error| format!("开始 Antigravity 历史迁移失败: {error}"))?;
            crate::services::antigravity_history_service::init_antigravity_schema(&transaction)?;
            Self::complete_migration(&transaction, "antigravity-history-v1")?;
            transaction.commit().map_err(|error| format!("提交 Antigravity 历史迁移失败: {error}"))?;
        }
        if !Self::has_migration(connection, "claude-history-v4")? {
            let transaction = connection.transaction().map_err(|error| format!("开始 Claude 会话索引迁移失败: {error}"))?;
            crate::services::claude_history_service::init_claude_schema(&transaction)?;
            Self::complete_migration(&transaction, "claude-history-v4")?;
            transaction.commit().map_err(|error| format!("提交 Claude 会话索引迁移失败: {error}"))?;
        }

        Ok(())
    }

    pub fn read_command_history() -> Result<Option<String>, String> {
        Self::read_document("command_history")
    }

    pub fn save_command_history(content: &str) -> Result<(), String> {
        Self::save_document("command_history", content)
    }

    /// 把命令历史写入指定数据目录（导入备份时目标目录可能与当前目录不同）。
    pub(crate) fn save_command_history_at(data_dir: &std::path::Path, content: &str) -> Result<(), String> {
        let connection = Self::open_at(data_dir)?;
        connection
            .execute(
                "INSERT INTO app_documents (key, content, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
                params!["command_history", content, chrono::Utc::now().timestamp_millis()],
            )
            .map_err(|error| format!("保存命令历史失败: {}", error))?;
        Ok(())
    }

    fn read_document(key: &str) -> Result<Option<String>, String> {
        let connection = Self::open()?;
        connection
            .query_row(
                "SELECT content FROM app_documents WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取应用数据失败: {}", error))
    }

    fn save_document(key: &str, content: &str) -> Result<(), String> {
        let connection = Self::open()?;
        connection
            .execute(
                "INSERT INTO app_documents (key, content, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
                params![key, content, chrono::Utc::now().timestamp_millis()],
            )
            .map_err(|error| format!("保存应用数据失败: {}", error))?;
        Ok(())
    }


}
