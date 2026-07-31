use crate::models::{AiAgent, AiAgentRuntime, DecisionBinding};
use crate::services::PathService;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::time::Duration;

const AI_ENTITY_DIRECTORIES: &[&str] = &[
    "Projects",
    "Runtimes",
    "Agents",
    "Roles",
    "Workflows",
    "TaskContracts",
    "Deliveries",
    "TaskNodes",
    "DecisionRequests",
    "Events",
    "Attempts",
    "ReviewGates",
    "MergeRecords",
];

fn runtime_deduplication_key(runtime: &AiAgentRuntime) -> String {
    let command = runtime.command.trim();
    #[cfg(windows)]
    let command = command.to_ascii_lowercase();
    #[cfg(not(windows))]
    let command = command.to_string();
    format!(
        "{}\u{0}{}",
        runtime.kind.trim().to_ascii_lowercase(),
        command
    )
}

pub struct DatabaseService;

impl DatabaseService {
    fn open() -> Result<Connection, String> {
        let data_dir = PathService::get_data_dir();
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
                 CREATE TABLE IF NOT EXISTS ai_entities (
                    kind TEXT NOT NULL,
                    id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    PRIMARY KEY (kind, id)
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
        if !Self::has_migration(connection, "legacy-ai-entities-v1")? {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开始 AI 交付迁移失败: {}", error))?;
            let root = PathService::get_data_dir().join("AiDelivery");
            for kind in AI_ENTITY_DIRECTORIES {
                let directory = root.join(kind);
                let Ok(entries) = fs::read_dir(directory) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().is_none_or(|extension| extension != "json") {
                        continue;
                    }
                    let Ok(content) = fs::read_to_string(&path) else {
                        continue;
                    };
                    if serde_json::from_str::<Value>(&content).is_err() {
                        continue;
                    }
                    let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
                        continue;
                    };
                    transaction
                        .execute(
                            "INSERT OR IGNORE INTO ai_entities (kind, id, content) VALUES (?1, ?2, ?3)",
                            params![kind, id, content],
                        )
                        .map_err(|error| format!("迁移 AI 交付数据失败: {}", error))?;
                }
            }
            Self::complete_migration(&transaction, "legacy-ai-entities-v1")?;
            transaction
                .commit()
                .map_err(|error| format!("提交 AI 交付迁移失败: {}", error))?;
        }

        if !Self::has_migration(connection, "ai-runtime-deduplication-v1")? {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开始 Runtime 去重失败: {}", error))?;
            Self::deduplicate_ai_runtimes(&transaction)?;
            Self::complete_migration(&transaction, "ai-runtime-deduplication-v1")?;
            transaction
                .commit()
                .map_err(|error| format!("提交 Runtime 去重失败: {}", error))?;
        }

        if !Self::has_migration(connection, "legacy-command-history-v1")? {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开始命令历史迁移失败: {}", error))?;
            let data_dir = PathService::get_data_dir();
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
            let path = PathService::get_bots_dir().join("decision_bindings.json");
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(bindings) = serde_json::from_str::<Vec<DecisionBinding>>(&content) {
                    Self::replace_bindings(&transaction, &bindings)?;
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
            let directory = PathService::get_bots_dir().join("weixin");
            if let Ok(entries) = fs::read_dir(directory) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().is_none_or(|extension| extension != "json") {
                        continue;
                    }
                    let Some(encoded_id) = path.file_stem().and_then(|value| value.to_str()) else {
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
            Self::complete_migration(&transaction, "legacy-weixin-runtime-v1")?;
            transaction
                .commit()
                .map_err(|error| format!("提交微信状态迁移失败: {}", error))?;
        }
        Ok(())
    }

    fn deduplicate_ai_runtimes(transaction: &Transaction<'_>) -> Result<(), String> {
        let mut runtimes = {
            let mut statement = transaction
                .prepare("SELECT id, content FROM ai_entities WHERE kind = 'Runtimes'")
                .map_err(|error| format!("读取 Runtime 记录失败: {}", error))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("读取 Runtime 记录失败: {}", error))?;
            rows.map(|row| {
                let (id, content) =
                    row.map_err(|error| format!("读取 Runtime 记录失败: {}", error))?;
                let mut runtime = serde_json::from_str::<AiAgentRuntime>(&content)
                    .map_err(|error| format!("解析 Runtime 记录失败: {}", error))?;
                runtime.id = id.clone();
                Ok((id, runtime))
            })
            .collect::<Result<Vec<_>, String>>()?
        };
        runtimes.sort_by(|left, right| {
            left.1
                .created_at
                .cmp(&right.1.created_at)
                .then_with(|| left.0.cmp(&right.0))
        });

        let mut canonical_by_key = HashMap::<String, (String, AiAgentRuntime)>::new();
        let mut duplicate_to_canonical = HashMap::<String, String>::new();
        for (id, runtime) in runtimes {
            let key = runtime_deduplication_key(&runtime);
            if let Some((canonical_id, canonical)) = canonical_by_key.get_mut(&key) {
                duplicate_to_canonical.insert(id, canonical_id.clone());
                canonical.enabled |= runtime.enabled;
                if runtime.updated_at > canonical.updated_at {
                    canonical.updated_at = runtime.updated_at;
                }
            } else {
                canonical_by_key.insert(key, (id, runtime));
            }
        }
        if duplicate_to_canonical.is_empty() {
            return Ok(());
        }

        for (id, runtime) in canonical_by_key.values() {
            let content = serde_json::to_string(runtime)
                .map_err(|error| format!("序列化 Runtime 记录失败: {}", error))?;
            transaction
                .execute(
                    "UPDATE ai_entities SET content = ?1 WHERE kind = 'Runtimes' AND id = ?2",
                    params![content, id],
                )
                .map_err(|error| format!("更新 Runtime 记录失败: {}", error))?;
        }

        let agents = {
            let mut statement = transaction
                .prepare("SELECT id, content FROM ai_entities WHERE kind = 'Agents'")
                .map_err(|error| format!("读取 Agent 记录失败: {}", error))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("读取 Agent 记录失败: {}", error))?;
            rows.map(|row| {
                let (id, content) =
                    row.map_err(|error| format!("读取 Agent 记录失败: {}", error))?;
                let agent = serde_json::from_str::<AiAgent>(&content)
                    .map_err(|error| format!("解析 Agent 记录失败: {}", error))?;
                Ok((id, agent))
            })
            .collect::<Result<Vec<_>, String>>()?
        };
        for (id, mut agent) in agents {
            let Some(runtime_id) = duplicate_to_canonical.get(&agent.runtime_id) else {
                continue;
            };
            agent.runtime_id = runtime_id.clone();
            let content = serde_json::to_string(&agent)
                .map_err(|error| format!("序列化 Agent 记录失败: {}", error))?;
            transaction
                .execute(
                    "UPDATE ai_entities SET content = ?1 WHERE kind = 'Agents' AND id = ?2",
                    params![content, id],
                )
                .map_err(|error| format!("更新 Agent 记录失败: {}", error))?;
        }
        for duplicate_id in duplicate_to_canonical.keys() {
            transaction
                .execute(
                    "DELETE FROM ai_entities WHERE kind = 'Runtimes' AND id = ?1",
                    [duplicate_id],
                )
                .map_err(|error| format!("删除重复 Runtime 记录失败: {}", error))?;
        }
        Ok(())
    }

    pub fn list_ai_entities<T: DeserializeOwned>(kind: &str) -> Result<Vec<T>, String> {
        let connection = Self::open()?;
        let mut statement = connection
            .prepare("SELECT content FROM ai_entities WHERE kind = ?1")
            .map_err(|error| format!("查询 AI 交付数据失败: {}", error))?;
        let rows = statement
            .query_map([kind], |row| row.get::<_, String>(0))
            .map_err(|error| format!("读取 AI 交付数据失败: {}", error))?;
        rows.map(|row| {
            let content = row.map_err(|error| format!("读取 AI 交付记录失败: {}", error))?;
            serde_json::from_str(&content)
                .map_err(|error| format!("解析 AI 交付记录失败: {}", error))
        })
        .collect()
    }

    pub fn get_ai_entity<T: DeserializeOwned>(
        kind: &str,
        id: &str,
        label: &str,
    ) -> Result<T, String> {
        let connection = Self::open()?;
        let content = connection
            .query_row(
                "SELECT content FROM ai_entities WHERE kind = ?1 AND id = ?2",
                params![kind, id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("读取{}失败: {}", label, error))?
            .ok_or_else(|| format!("{}不存在", label))?;
        serde_json::from_str(&content).map_err(|error| format!("解析{}失败: {}", label, error))
    }

    pub fn save_ai_entity<T: Serialize>(kind: &str, id: &str, value: &T) -> Result<(), String> {
        let content = serde_json::to_string(value)
            .map_err(|error| format!("序列化 AI 交付记录失败: {}", error))?;
        let connection = Self::open()?;
        connection
            .execute(
                "INSERT INTO ai_entities (kind, id, content) VALUES (?1, ?2, ?3)
                 ON CONFLICT(kind, id) DO UPDATE SET content = excluded.content",
                params![kind, id, content],
            )
            .map_err(|error| format!("保存 AI 交付记录失败: {}", error))?;
        Ok(())
    }

    pub fn delete_ai_entity(kind: &str, id: &str, label: &str) -> Result<(), String> {
        let connection = Self::open()?;
        let affected = connection
            .execute(
                "DELETE FROM ai_entities WHERE kind = ?1 AND id = ?2",
                params![kind, id],
            )
            .map_err(|error| format!("删除{}失败: {}", label, error))?;
        if affected == 0 {
            return Err(format!("{}不存在", label));
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
            transaction
                .execute(
                    "INSERT INTO bot_decision_bindings
                     (channel_id, external_message_id, decision_id, status, expires_at, created_at, content)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
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
