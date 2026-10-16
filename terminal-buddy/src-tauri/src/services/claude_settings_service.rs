//! Claude 默认配置文件（`~/.claude/settings.json`）读写与备份。
//!
//! 与 Hook 安装、旧供应商 `activate` 共用 `claude_settings_write_lock()` 互斥。
//! 写回语义为深合并：`content` 中的 `null` 表示删除该键（恢复默认），
//! 未出现的键保留磁盘值（用户文件中的未知键原样保留，前向兼容官方新键）。

use std::fs;
use std::path::PathBuf;

use chrono::{Local, NaiveDateTime};
use serde::Serialize;
use serde_json::Value;

use super::atomic_file::atomic_write_private;
use super::claude_hook_settings::{claude_settings_write_lock, resolve_claude_config_dir};

/// 备份保留个数。
const BACKUP_KEEP_COUNT: usize = 10;
/// Hook 安装用的单文件备份，不归本服务管理。
const HOOK_BACKUP_NAME: &str = "settings.json.terminalbuddy.bak";
const BACKUP_PREFIX: &str = "settings.json.";
const BACKUP_SUFFIX: &str = ".bak";

fn lock_error() -> String {
    "Claude 配置写入锁不可用，请重试".to_string()
}

fn settings_path() -> Result<PathBuf, String> {
    let config_dir = resolve_claude_config_dir(None)?;
    Ok(config_dir.join("settings.json"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettingsView {
    pub path: String,
    pub exists: bool,
    pub content: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettingsWriteResult {
    pub path: String,
    /// 本次写前备份的文件名；文件之前不存在则为空串。
    pub backup_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettingsBackup {
    pub id: String,
    pub created_at: String,
    pub size: u64,
}

/// 读取 settings 文件。文件不存在视为全新，返回空对象。
pub fn read_settings() -> Result<ClaudeSettingsView, String> {
    let _guard = claude_settings_write_lock().lock().map_err(|_| lock_error())?;
    let path = settings_path()?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ClaudeSettingsView {
                path: path.to_string_lossy().to_string(),
                exists: false,
                content: Value::Object(Default::default()),
            });
        }
        Err(error) => return Err(format!("读取 Claude 设置失败：{}", error)),
    };
    let content: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Claude settings.json 不是有效 JSON，请修复后重试；原文件未更改".to_string())?;
    if !content.is_object() {
        return Err("Claude 设置根节点必须是 JSON 对象；原文件未更改".to_string());
    }
    Ok(ClaudeSettingsView {
        path: path.to_string_lossy().to_string(),
        exists: true,
        content,
    })
}

/// 深合并：`patch` 为 `None`（JSON null）表示删除该键；两边都是对象则递归合并；
/// 其余情况 `patch` 覆盖。返回 `None` 表示该键应被删除。
fn deep_merge(base: &Value, patch: &Value) -> Option<Value> {
    if patch.is_null() {
        return None;
    }
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            let mut merged = base_map.clone();
            for (key, patch_value) in patch_map {
                match merged.get(key) {
                    Some(base_value) => match deep_merge(base_value, patch_value) {
                        Some(value) => {
                            merged.insert(key.clone(), value);
                        }
                        None => {
                            merged.remove(key);
                        }
                    },
                    None => {
                        if !patch_value.is_null() {
                            merged.insert(key.clone(), patch_value.clone());
                        }
                    }
                }
            }
            Some(Value::Object(merged))
        }
        _ => Some(patch.clone()),
    }
}

/// 写回 settings：与磁盘当前内容深合并后原子写入，写前备份上一版。
pub fn write_settings(content: &Value) -> Result<ClaudeSettingsWriteResult, String> {
    let _guard = claude_settings_write_lock().lock().map_err(|_| lock_error())?;
    if !content.is_object() {
        return Err("写入的 Claude 设置必须是 JSON 对象".to_string());
    }
    let path = settings_path()?;
    let current: Value = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Claude settings.json 不是有效 JSON，请修复后重试；原文件未更改".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Object(Default::default()),
        Err(error) => return Err(format!("读取 Claude 设置失败：{}", error)),
    };
    if !current.is_object() || current.get("env").is_some_and(|env| !env.is_object()) {
        return Err("Claude 设置及 env 必须是 JSON 对象，请修复后重试；原文件未更改".to_string());
    }
    let merged = deep_merge(&current, content).unwrap_or(Value::Object(Default::default()));
    if !merged.is_object() || merged.get("env").is_some_and(|env| !env.is_object()) {
        return Err("合并后的 Claude 设置非法（根节点/env 必须是对象），已拒绝写入".to_string());
    }
    let backup_id = backup_current(&path)?;
    let bytes = serde_json::to_vec_pretty(&merged).map_err(|_| "无法编码 Claude 设置".to_string())?;
    atomic_write_private(&path, &bytes).map_err(|error| format!("写入 Claude 设置失败：{}", error))?;
    prune_backups(&path);
    Ok(ClaudeSettingsWriteResult {
        path: path.to_string_lossy().to_string(),
        backup_id,
    })
}

/// 写前备份上一版，返回备份文件名（`backupId`）。文件之前不存在则返回空串。
fn backup_current(path: &PathBuf) -> Result<String, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(format!("读取 Claude 设置失败：{}", error)),
    };
    let Some(parent) = path.parent() else {
        return Err("Claude 设置路径无效".to_string());
    };
    let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut name = format!("{}{}{}", BACKUP_PREFIX, stamp, BACKUP_SUFFIX);
    let mut counter = 0;
    while parent.join(&name).exists() {
        counter += 1;
        name = format!("{}{}-{}{}", BACKUP_PREFIX, stamp, counter, BACKUP_SUFFIX);
    }
    atomic_write_private(&parent.join(&name), &bytes)
        .map_err(|error| format!("备份 Claude 设置失败：{}", error))?;
    Ok(name)
}

fn is_managed_backup(file_name: &str) -> bool {
    file_name != HOOK_BACKUP_NAME
        && file_name.starts_with(BACKUP_PREFIX)
        && file_name.ends_with(BACKUP_SUFFIX)
        && file_name.len() > BACKUP_PREFIX.len() + BACKUP_SUFFIX.len()
}

/// 从备份文件名解析创建时间（`%Y%m%d-%H%M%S`），解析失败回退文件 mtime。
fn backup_created_at(parent: &std::path::Path, file_name: &str) -> String {
    let fallback = || {
        fs::metadata(parent.join(file_name))
            .and_then(|metadata| metadata.modified())
            .ok()
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
            .unwrap_or_default()
    };
    let middle = file_name
        .strip_prefix(BACKUP_PREFIX)
        .and_then(|name| name.strip_suffix(BACKUP_SUFFIX))
        .unwrap_or_default();
    // 同秒追加的 -<n> 后缀先剥掉。
    let stamp = middle.split('-').take(2).collect::<Vec<_>>().join("-");
    match NaiveDateTime::parse_from_str(&stamp, "%Y%m%d-%H%M%S") {
        Ok(naive) => naive.and_local_timezone(Local).single().map(|local| local.to_rfc3339()).unwrap_or_else(fallback),
        Err(_) => fallback(),
    }
}

fn collect_backups(path: &PathBuf) -> Vec<ClaudeSettingsBackup> {
    let Some(parent) = path.parent() else {
        return Vec::new();
    };
    let mut backups = Vec::new();
    let entries = fs::read_dir(parent).into_iter().flatten().flatten();
    for entry in entries {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !is_managed_backup(&file_name) {
            continue;
        }
        let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        backups.push(ClaudeSettingsBackup {
            id: file_name.clone(),
            created_at: backup_created_at(parent, &file_name),
            size,
        });
    }
    // 按文件名时间倒序（文件名即时间戳，字典序等价于时间序）。
    backups.sort_by(|a, b| b.id.cmp(&a.id));
    backups
}

/// 列出本服务管理的备份（排除 Hook 单文件备份），按时间倒序。
pub fn list_backups() -> Result<Vec<ClaudeSettingsBackup>, String> {
    let _guard = claude_settings_write_lock().lock().map_err(|_| lock_error())?;
    Ok(collect_backups(&settings_path()?))
}

/// 一键恢复指定备份（加写锁、原子回写）。恢复前同样备份当前版本。
pub fn restore_backup(id: &str) -> Result<ClaudeSettingsWriteResult, String> {
    let _guard = claude_settings_write_lock().lock().map_err(|_| lock_error())?;
    if !is_managed_backup(id) || id.contains(['/', '\\']) {
        return Err("备份不存在".to_string());
    }
    let path = settings_path()?;
    let Some(parent) = path.parent() else {
        return Err("Claude 设置路径无效".to_string());
    };
    let backup_path = parent.join(id);
    let bytes = fs::read(&backup_path).map_err(|_| "备份不存在，可能已被删除".to_string())?;
    let content: Value = serde_json::from_slice(&bytes).map_err(|_| "备份文件已损坏，无法恢复".to_string())?;
    if !content.is_object() {
        return Err("备份文件已损坏，无法恢复".to_string());
    }
    let backup_id = backup_current(&path)?;
    let pretty = serde_json::to_vec_pretty(&content).map_err(|_| "无法编码 Claude 设置".to_string())?;
    atomic_write_private(&path, &pretty).map_err(|error| format!("恢复 Claude 设置失败：{}", error))?;
    prune_backups(&path);
    Ok(ClaudeSettingsWriteResult {
        path: path.to_string_lossy().to_string(),
        backup_id,
    })
}

/// 保留最近 N 个备份（按文件名倒序），其余删除。
fn prune_backups(path: &PathBuf) {
    let backups = collect_backups(path);
    if backups.len() <= BACKUP_KEEP_COUNT {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    for backup in backups.iter().skip(BACKUP_KEEP_COUNT) {
        let _ = fs::remove_file(parent.join(&backup.id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deep_merge_overrides_recursively_and_null_deletes() {
        let base = json!({
            "theme": "dark",
            "env": { "ANTHROPIC_MODEL": "m1", "KEEP": "yes" },
            "permissions": { "defaultMode": "ask", "allow": ["Read"] },
            "hooks": { "Stop": [] },
        });
        let patch = json!({
            "theme": "light",
            "env": { "ANTHROPIC_MODEL": null, "NEW_KEY": "v" },
            "permissions": { "defaultMode": "acceptEdits" },
        });
        let merged = deep_merge(&base, &patch).unwrap();
        assert_eq!(merged["theme"], "light");
        // null 删除目标叶子
        assert!(merged["env"].get("ANTHROPIC_MODEL").is_none());
        // 未出现的键保留
        assert_eq!(merged["env"]["KEEP"], "yes");
        assert_eq!(merged["hooks"], base["hooks"]);
        // 子键路径只动目标叶子，不整段覆盖
        assert_eq!(merged["permissions"]["defaultMode"], "acceptEdits");
        assert_eq!(merged["permissions"]["allow"], json!(["Read"]));
    }

    #[test]
    fn deep_merge_type_change_replaces_wholescale() {
        let base = json!({ "statusLine": { "type": "command" }, "n": 1 });
        let patch = json!({ "statusLine": "plain", "n": null });
        let merged = deep_merge(&base, &patch).unwrap();
        assert_eq!(merged["statusLine"], "plain");
        assert!(merged.get("n").is_none());
    }

    #[test]
    fn backup_name_rules_exclude_hook_single_backup() {
        assert!(is_managed_backup("settings.json.20261015-120000.bak"));
        assert!(is_managed_backup("settings.json.20261015-120000-1.bak"));
        assert!(!is_managed_backup("settings.json.terminalbuddy.bak"));
        assert!(!is_managed_backup("settings.json"));
        assert!(!is_managed_backup("settings.json..bak"));
        assert!(!is_managed_backup("other.20261015-120000.bak"));
    }

    #[test]
    fn backup_created_at_parses_stamp_with_counter() {
        let dir = std::env::temp_dir();
        let with_counter = backup_created_at(&dir, "settings.json.20261015-120305-2.bak");
        assert!(with_counter.starts_with("2026-10-15T12:03:05"), "实际：{}", with_counter);
        // 非法文件名回退（文件不存在则回退空串，不断言具体值，只断言不 panic）
        let _ = backup_created_at(&dir, "settings.json.not-a-stamp.bak");
    }

    #[test]
    fn prune_backups_keeps_newest_ten_and_spares_hook_backup() {
        let dir = std::env::temp_dir().join(format!("tb-settings-bak-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, b"{}").unwrap();
        for day in 1..=15u32 {
            fs::write(dir.join(format!("settings.json.202601{:02}-120000.bak", day)), b"{}").unwrap();
        }
        fs::write(dir.join(HOOK_BACKUP_NAME), b"{}").unwrap();
        prune_backups(&path);
        let mut managed: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| is_managed_backup(name))
            .collect();
        managed.sort();
        // 只保留最近 10 个（1月6日–1月15日），最旧的被淘汰
        assert_eq!(managed.len(), 10, "实际：{:?}", managed);
        assert_eq!(managed.first().unwrap(), "settings.json.20260106-120000.bak");
        assert_eq!(managed.last().unwrap(), "settings.json.20260115-120000.bak");
        // Hook 单文件备份不归本服务管理，不受轮转影响
        assert!(dir.join(HOOK_BACKUP_NAME).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backup_current_never_overwrites_within_same_second() {
        let dir = std::env::temp_dir().join(format!("tb-settings-bak-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, b"{\"a\":1}").unwrap();
        let first = backup_current(&path).unwrap();
        let second = backup_current(&path).unwrap();
        assert!(!first.is_empty() && !second.is_empty());
        // 同秒多次写入追加 -<n> 防覆盖
        assert_ne!(first, second);
        assert!(dir.join(&first).exists() && dir.join(&second).exists());
        fs::remove_dir_all(&dir).ok();
    }
}
