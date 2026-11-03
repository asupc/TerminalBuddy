//! Agent 会话持久化登记表：`terminalId -> { provider, sessionId, sessionFile, cwd }`。
//!
//! 容器重启后旧 PTY 与 terminalId 已消失，浏览器恢复页签时只能按旧 terminalId
//! 回查这张表，才能重新拼出 `claude --resume` / `codex resume`。
//! 登记表由服务端后台任务与 Hook/扩展上报共同维护；旧 `claude_session_registry.json`
//! 会在首次读取时迁移为 v2 结构，旧文件保留一个版本周期不删除。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use super::{atomic_write, PathService};

const REGISTRY_FILE: &str = "agent_session_registry.json";
const LEGACY_REGISTRY_FILE: &str = "claude_session_registry.json";
/// 会话记录保留 7 天；期间内重启容器都可以恢复。
const MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// 存活会话的 `updatedAt` 每小时刷新一次即可，避免周期性落盘。
const REFRESH_MS: u64 = 60 * 60 * 1000;
/// 登记表上限，防止长期运行无限增长。
const MAX_ENTRIES: usize = 500;
const SESSION_ID_MIN_LEN: usize = 8;
const SESSION_ID_MAX_LEN: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRecord {
    pub provider: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    sessions: HashMap<String, AgentSessionRecord>,
}

impl Default for RegistryFile {
    fn default() -> Self {
        Self { version: default_version(), sessions: HashMap::new() }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRecord {
    session_id: String,
    updated_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRegistryFile {
    #[serde(default)]
    sessions: HashMap<String, LegacyRecord>,
}

fn default_version() -> u32 {
    2
}

fn registry_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn registry_path() -> Result<PathBuf, String> {
    Ok(PathService::require_data_dir()?.join(REGISTRY_FILE))
}

fn legacy_registry_path() -> Result<PathBuf, String> {
    Ok(PathService::require_data_dir()?.join(LEGACY_REGISTRY_FILE))
}

/// 只接受 UUID/十六进制形态的会话 ID：它会被拼进启动命令，必须拒绝空白与 shell 元字符。
pub fn is_valid_session_id(id: &str) -> bool {
    (SESSION_ID_MIN_LEN..=SESSION_ID_MAX_LEN).contains(&id.len())
        && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn valid_provider(provider: &str) -> bool {
    matches!(provider, "claude" | "codex")
}

fn read_legacy() -> RegistryFile {
    let Ok(path) = legacy_registry_path() else { return RegistryFile::default() };
    let Ok(content) = fs::read_to_string(path) else { return RegistryFile::default() };
    let Ok(legacy) = serde_json::from_str::<LegacyRegistryFile>(&content) else { return RegistryFile::default() };
    RegistryFile {
        version: default_version(),
        sessions: legacy
            .sessions
            .into_iter()
            .map(|(terminal_id, record)| {
                (terminal_id, AgentSessionRecord {
                    provider: "claude".to_string(),
                    session_id: record.session_id,
                    session_file: None,
                    cwd: None,
                    updated_at: record.updated_at,
                })
            })
            .collect(),
    }
}

fn read_file() -> RegistryFile {
    let Ok(path) = registry_path() else { return read_legacy() };
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| read_legacy()),
        Err(_) => read_legacy(),
    }
}

/// 返回登记表快照（缺失或损坏时为空表）。
pub fn load() -> HashMap<String, AgentSessionRecord> {
    read_file().sessions
}

/// 按旧 terminal ID 查询仍然有效的统一 Agent 会话记录。
pub fn lookup_agents(ids: &[String], now_ms: u64) -> HashMap<String, AgentSessionRecord> {
    let sessions = load();
    ids.iter()
        .filter_map(|terminal_id| {
            let record = sessions.get(terminal_id)?;
            if now_ms.saturating_sub(record.updated_at) > MAX_AGE_MS {
                return None;
            }
            if !valid_provider(&record.provider) || !is_valid_session_id(&record.session_id) {
                return None;
            }
            Some((terminal_id.clone(), record.clone()))
        })
        .collect()
}

/// 旧 API：只返回 Claude 记录，保持既有调用方语义。
pub fn lookup(ids: &[String], now_ms: u64) -> HashMap<String, String> {
    lookup_agents(ids, now_ms)
        .into_iter()
        .filter(|(_, record)| record.provider == "claude")
        .map(|(terminal_id, record)| (terminal_id, record.session_id))
        .collect()
}

/// 合并统一 Agent 登记记录：新条目写入、存活条目按小时刷新时间戳，并裁剪过期条目。
pub fn merge_agents(discovered: HashMap<String, AgentSessionRecord>, now_ms: u64) -> Result<(), String> {
    if discovered.is_empty() {
        return Ok(());
    }
    let _guard = registry_lock()
        .lock()
        .map_err(|_| "会话登记表锁不可用".to_string())?;
    let mut file = read_file();
    let mut dirty = false;
    for (terminal_id, record) in discovered {
        if !valid_provider(&record.provider) || !is_valid_session_id(&record.session_id) {
            continue;
        }
        match file.sessions.get_mut(&terminal_id) {
            Some(existing)
                if existing.provider == record.provider
                    && existing.session_id == record.session_id
                    && existing.session_file == record.session_file
                    && existing.cwd == record.cwd =>
            {
                if now_ms.saturating_sub(existing.updated_at) >= REFRESH_MS {
                    existing.updated_at = now_ms;
                    dirty = true;
                }
            }
            _ => {
                file.sessions.insert(terminal_id, AgentSessionRecord { updated_at: now_ms, ..record });
                dirty = true;
            }
        }
    }
    let before = file.sessions.len();
    file.sessions.retain(|_, record| {
        now_ms.saturating_sub(record.updated_at) <= MAX_AGE_MS
            && valid_provider(&record.provider)
            && is_valid_session_id(&record.session_id)
    });
    dirty |= file.sessions.len() != before;
    if file.sessions.len() > MAX_ENTRIES {
        let mut entries: Vec<_> = file.sessions.drain().collect();
        entries.sort_by(|left, right| right.1.updated_at.cmp(&left.1.updated_at));
        entries.truncate(MAX_ENTRIES);
        file.sessions = entries.into_iter().collect();
        dirty = true;
    }
    if !dirty {
        return Ok(());
    }
    file.version = default_version();
    let content = serde_json::to_vec_pretty(&file)
        .map_err(|error| format!("序列化会话登记表失败：{}", error))?;
    atomic_write(&registry_path()?, &content)
        .map_err(|error| format!("写入会话登记表失败：{}", error))
}

/// 兼容旧 Claude API。
pub fn merge(discovered: HashMap<String, String>, now_ms: u64) -> Result<(), String> {
    merge_agents(
        discovered
            .into_iter()
            .map(|(terminal_id, session_id)| {
                (terminal_id, AgentSessionRecord {
                    provider: "claude".to_string(),
                    session_id,
                    session_file: None,
                    cwd: None,
                    updated_at: now_ms,
                })
            })
            .collect(),
        now_ms,
    )
}

/// 单条登记（Hook / 扩展上报使用）。
pub fn record(
    terminal_id: &str,
    provider: &str,
    session_id: &str,
    session_file: Option<String>,
    cwd: Option<String>,
    now_ms: u64,
) -> Result<(), String> {
    merge_agents(
        HashMap::from([(
            terminal_id.to_string(),
            AgentSessionRecord {
                provider: provider.to_string(),
                session_id: session_id.to_string(),
                session_file,
                cwd,
                updated_at: now_ms,
            },
        )]),
        now_ms,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_test_data_dir(test: impl FnOnce()) {
        let directory = std::env::temp_dir().join(format!("agent-registry-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        PathService::set_test_data_dir(Some(directory.clone()));
        test();
        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(&directory);
    }

    fn terminal_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn session_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    #[test]
    fn merge_persists_updates_and_keeps_provider() {
        with_test_data_dir(|| {
            let terminal = terminal_id();
            let first = session_id();
            let second = session_id();
            record(&terminal, "codex", &first, Some("/tmp/a.jsonl".into()), Some("/work".into()), 1_000).unwrap();
            let saved = lookup_agents(&[terminal.clone()], 2_000).remove(&terminal).unwrap();
            assert_eq!(saved.provider, "codex");
            assert_eq!(saved.session_id, first);
            assert_eq!(saved.session_file.as_deref(), Some("/tmp/a.jsonl"));

            record(&terminal, "claude", &second, None, None, 2_000).unwrap();
            assert_eq!(lookup(&[terminal.clone()], 3_000).get(&terminal), Some(&second));
        });
    }

    #[test]
    fn legacy_claude_registry_is_migrated_on_read() {
        with_test_data_dir(|| {
            let terminal = terminal_id();
            let session = session_id();
            fs::write(
                legacy_registry_path().unwrap(),
                format!(r#"{{"version":1,"sessions":{{"{terminal}":{{"sessionId":"{session}","updatedAt":1000}}}}}}"#),
            ).unwrap();
            assert_eq!(lookup(&[terminal.clone()], 2_000).get(&terminal), Some(&session));
            let record = lookup_agents(&[terminal.clone()], 2_000).remove(&terminal).unwrap();
            assert_eq!(record.provider, "claude");
        });
    }

    #[test]
    fn expired_entries_are_pruned_and_ignored_by_lookup() {
        with_test_data_dir(|| {
            let old_terminal = terminal_id();
            let fresh_terminal = terminal_id();
            let old_session = session_id();
            let fresh_session = session_id();
            let now = MAX_AGE_MS + 10_000;
            let file = RegistryFile {
                version: 2,
                sessions: HashMap::from([
                    (old_terminal.clone(), AgentSessionRecord {
                        provider: "codex".into(), session_id: old_session, session_file: None, cwd: None, updated_at: 1_000,
                    }),
                    (fresh_terminal.clone(), AgentSessionRecord {
                        provider: "codex".into(), session_id: fresh_session.clone(), session_file: None, cwd: None, updated_at: now - 1_000,
                    }),
                ]),
            };
            fs::write(registry_path().unwrap(), serde_json::to_vec(&file).unwrap()).unwrap();
            assert!(!lookup_agents(&[old_terminal.clone()], now).contains_key(&old_terminal));
            assert_eq!(lookup_agents(&[fresh_terminal.clone()], now).get(&fresh_terminal).unwrap().session_id, fresh_session);
            record(&terminal_id(), "codex", &session_id(), None, None, now).unwrap();
            assert!(!load().contains_key(&old_terminal));
        });
    }

    #[test]
    fn corrupt_file_degrades_to_legacy_or_empty() {
        with_test_data_dir(|| {
            fs::write(registry_path().unwrap(), b"{not json").unwrap();
            assert!(load().is_empty());
            let terminal = terminal_id();
            let session = session_id();
            record(&terminal, "claude", &session, None, None, 1_000).unwrap();
            assert_eq!(lookup(&[terminal.clone()], 2_000).get(&terminal), Some(&session));
        });
    }

    #[test]
    fn invalid_ids_and_providers_are_rejected() {
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("short"));
        assert!(!is_valid_session_id("deadbeef; rm -rf /"));
        assert!(is_valid_session_id(&uuid::Uuid::new_v4().to_string()));
        with_test_data_dir(|| {
            let terminal = terminal_id();
            record(&terminal, "unknown", &session_id(), None, None, 1_000).unwrap();
            assert!(load().is_empty());
            record(&terminal, "codex", "bad id", None, None, 1_000).unwrap();
            assert!(load().is_empty());
        });
    }
}
