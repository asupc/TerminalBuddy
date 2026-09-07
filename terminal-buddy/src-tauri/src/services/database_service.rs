use crate::models::DecisionBinding;
use crate::services::PathService;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use std::fs;
use std::time::Duration;

pub struct DatabaseService;

impl DatabaseService {
    fn open() -> Result<Connection, String> {
        // 数据库是持久写入方，必须走 require：自定义目录不可用时显式失败，
        // 绝不能在默认目录另开一个数据库。
        let data_dir = PathService::require_data_dir()?;
        fs::create_dir_all(&data_dir).map_err(|error| format!("创建数据库目录失败: {}", error))?;
        let mut connection = Connection::open(data_dir.join("terminal_buddy.db"))
            .map_err(|error| format!("打开 SQLite 数据库失败: {}", error))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("设置 SQLite 超时失败: {}", error))?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS schema_migrations (
                    name TEXT PRIMARY KEY
                 );
                 CREATE TABLE IF NOT EXISTS app_documents (
                    key TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS bot_decision_bindings (
                    channel_id TEXT NOT NULL,
                    external_message_id TEXT NOT NULL,
                    decision_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    PRIMARY KEY (channel_id, external_message_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_bot_decision_bindings_decision
                    ON bot_decision_bindings (decision_id);
                 CREATE INDEX IF NOT EXISTS idx_bot_decision_bindings_expiry
                    ON bot_decision_bindings (expires_at);
                 CREATE TABLE IF NOT EXISTS weixin_runtime_states (
                    account_id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                 );",
            )
            .map_err(|error| format!("初始化 SQLite 数据库失败: {}", error))?;
        Self::run_migrations(&mut connection)?;
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

        if !Self::has_migration(connection, "legacy-bot-bindings-v1")? {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开始机器人绑定迁移失败: {}", error))?;
            // 读迁移：目录不可用时跳过，迁移本身仍标记完成
            if let Ok(path) = PathService::get_bots_dir().map(|dir| dir.join("decision_bindings.json")) {
                if let Ok(content) = fs::read_to_string(path) {
                    if let Ok(bindings) = serde_json::from_str::<Vec<DecisionBinding>>(&content) {
                        Self::replace_bindings(&transaction, &bindings)?;
                    }
                }
            }
            Self::complete_migration(&transaction, "legacy-bot-bindings-v1")?;
            transaction
                .commit()
                .map_err(|error| format!("提交机器人绑定迁移失败: {}", error))?;
        }

        if !Self::has_migration(connection, "legacy-weixin-runtime-v1")? {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开始微信状态迁移失败: {}", error))?;
            // 读迁移：目录不可用时跳过
            if let Ok(directory) = PathService::get_bots_dir().map(|dir| dir.join("weixin")) {
                if let Ok(entries) = fs::read_dir(directory) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().is_none_or(|extension| extension != "json") {
                            continue;
                        }
                        let Some(encoded_id) =
                            path.file_stem().and_then(|value| value.to_str())
                        else {
                            continue;
                        };
                        let Ok(account_id) = hex::decode(encoded_id)
                            .ok()
                            .and_then(|bytes| String::from_utf8(bytes).ok())
                            .ok_or(())
                        else {
                            continue;
                        };
                        let Ok(content) = fs::read_to_string(path) else {
                            continue;
                        };
                        if serde_json::from_str::<Value>(&content).is_err() {
                            continue;
                        }
                        transaction
                            .execute(
                                "INSERT OR IGNORE INTO weixin_runtime_states (account_id, content, updated_at) VALUES (?1, ?2, ?3)",
                                params![account_id, content, chrono::Utc::now().timestamp_millis()],
                            )
                            .map_err(|error| format!("迁移微信连接状态失败: {}", error))?;
                    }
                }
            }
            Self::complete_migration(&transaction, "legacy-weixin-runtime-v1")?;
            transaction
                .commit()
                .map_err(|error| format!("提交微信状态迁移失败: {}", error))?;
        }
        Ok(())
    }

    pub fn read_command_history() -> Result<Option<String>, String> {
        Self::read_document("command_history")
    }

    pub fn save_command_history(content: &str) -> Result<(), String> {
        Self::save_document("command_history", content)
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

    fn replace_bindings(
        transaction: &Transaction<'_>,
        bindings: &[DecisionBinding],
    ) -> Result<(), String> {
        transaction
            .execute("DELETE FROM bot_decision_bindings", [])
            .map_err(|error| format!("清理机器人决策绑定失败: {}", error))?;
        for binding in bindings {
            let content = serde_json::to_string(binding)
                .map_err(|error| format!("序列化机器人决策绑定失败: {}", error))?;
            // 使用 ON CONFLICT DO UPDATE 而非裸 INSERT：
            // 1) legacy-bot-bindings-v1 迁移导入的旧 JSON 可能含重复 (channel_id, external_message_id)；
            // 2) 历史 cancel() 的占位条目共用 ("","") 主键也曾触发本错误；
            // 重复时后写入者覆盖前写入者，与 BotBindingService::add 内 retain 行为一致。
            transaction
                .execute(
                    "INSERT INTO bot_decision_bindings
                     (channel_id, external_message_id, decision_id, status, expires_at, created_at, content)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(channel_id, external_message_id) DO UPDATE SET
                        decision_id = excluded.decision_id,
                        status = excluded.status,
                        expires_at = excluded.expires_at,
                        created_at = excluded.created_at,
                        content = excluded.content",
                    params![
                        binding.channel_id,
                        binding.external_message_id,
                        binding.decision_id,
                        binding.status,
                        binding.expires_at,
                        binding.created_at,
                        content,
                    ],
                )
                .map_err(|error| format!("保存机器人决策绑定失败: {}", error))?;
        }
        Ok(())
    }

    pub fn list_decision_bindings() -> Result<Vec<DecisionBinding>, String> {
        let connection = Self::open()?;
        let mut statement = connection
            .prepare("SELECT content FROM bot_decision_bindings ORDER BY created_at")
            .map_err(|error| format!("查询机器人决策绑定失败: {}", error))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("读取机器人决策绑定失败: {}", error))?;
        rows.map(|row| {
            let content = row.map_err(|error| format!("读取机器人决策绑定失败: {}", error))?;
            serde_json::from_str(&content)
                .map_err(|error| format!("解析机器人决策绑定失败: {}", error))
        })
        .collect()
    }

    pub fn save_decision_bindings(bindings: &[DecisionBinding]) -> Result<(), String> {
        let mut connection = Self::open()?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开始保存机器人决策绑定失败: {}", error))?;
        Self::replace_bindings(&transaction, bindings)?;
        transaction
            .commit()
            .map_err(|error| format!("提交机器人决策绑定失败: {}", error))
    }

    pub fn read_weixin_state(account_id: &str) -> Result<Option<String>, String> {
        let connection = Self::open()?;
        connection
            .query_row(
                "SELECT content FROM weixin_runtime_states WHERE account_id = ?1",
                [account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取微信连接状态失败: {}", error))
    }

    pub fn save_weixin_state(account_id: &str, content: &str) -> Result<(), String> {
        let connection = Self::open()?;
        connection
            .execute(
                "INSERT INTO weixin_runtime_states (account_id, content, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(account_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
                params![account_id, content, chrono::Utc::now().timestamp_millis()],
            )
            .map_err(|error| format!("保存微信连接状态失败: {}", error))?;
        Ok(())
    }
}
