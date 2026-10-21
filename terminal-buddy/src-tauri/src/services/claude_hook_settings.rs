//! Claude Code hooks 定义、用户级 settings.json 残留检测与清理。
//! Hook 不再写入用户级 `settings.json`：模型终端启动时由
//! `llm_provider_service::build_temp_settings` 把 [`managed_hooks_object`]
//! 注入一次性 `--settings` 临时文件；本模块只负责旧版残留的检测与卸载。
//! 与决策注册表 / 通知状态机（super::claude_hook_service）零耦合，
//! 仅共享服务器状态与 URL 常量。

use super::atomic_file::atomic_write;
use super::claude_hook_service::{
    hook_server_port, hook_server_running, CLAUDE_HOOK_CLIENT_ARG, CLAUDE_HOOK_URL,
};
use super::settings_service::SettingsService;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy)]
struct HookDefinition {
    key: &'static str,
    event: &'static str,
    matcher: Option<&'static str>,
    status_message: &'static str,
}

const HOOK_DEFINITIONS: &[HookDefinition] = &[
    HookDefinition {
        key: "sessionStart",
        event: "SessionStart",
        matcher: None,
        status_message: "TerminalBuddy 正在识别 Claude Code 会话",
    },
    HookDefinition {
        key: "running",
        event: "UserPromptSubmit",
        matcher: None,
        status_message: "TerminalBuddy 正在同步任务状态",
    },
    HookDefinition {
        key: "attention",
        event: "Notification",
        matcher: Some("permission_prompt"),
        status_message: "TerminalBuddy 正在同步待处理状态",
    },
    HookDefinition {
        key: "decision",
        event: "PreToolUse",
        // 全工具匹配：AskUserQuestion 走决策流程，其余工具调用作为 running 心跳
        // 刷新指示灯，防止长任务超过 30 分钟无事件时被过期兜底误灭
        matcher: None,
        status_message: "TerminalBuddy 正在同步执行状态",
    },
    HookDefinition {
        key: "completion",
        event: "Stop",
        matcher: None,
        status_message: "通知 TerminalBuddy 任务完成",
    },
    HookDefinition {
        key: "failure",
        event: "StopFailure",
        matcher: None,
        status_message: "通知 TerminalBuddy 任务失败",
    },
    HookDefinition {
        key: "sessionEnd",
        event: "SessionEnd",
        matcher: None,
        status_message: "TerminalBuddy 正在结束 Claude Code 会话",
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookSettingsStatus {
    pub config_dir: String,
    pub settings_path: String,
    pub status: String,
    pub installed_events: Vec<String>,
    pub missing_events: Vec<String>,
    pub server_running: bool,
    pub server_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub(crate) fn claude_settings_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn normalize_claude_config_dir(selected_dir: &str) -> Result<String, String> {
    let selected = selected_dir.trim();
    if selected.is_empty() {
        return Err("Claude 配置目录不能为空".to_string());
    }
    let path = PathBuf::from(selected);
    if !path.is_absolute() {
        return Err("Claude 配置目录必须使用绝对路径".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized.to_string_lossy().to_string())
}

pub(crate) fn resolve_claude_config_dir(selected_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(selected) = selected_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return normalize_claude_config_dir(selected).map(PathBuf::from);
    }
    if let Some(configured) = SettingsService::get_settings()
        .claude_hook_config_dir
        .filter(|value| !value.trim().is_empty())
    {
        return normalize_claude_config_dir(&configured).map(PathBuf::from);
    }
    if let Some(configured) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        let configured = PathBuf::from(configured);
        if configured.is_absolute() {
            return Ok(configured);
        }
        return std::env::current_dir()
            .map(|current| current.join(configured))
            .map_err(|error| format!("无法解析 CLAUDE_CONFIG_DIR: {}", error));
    }
    dirs::home_dir()
        .map(|path| path.join(".claude"))
        .ok_or_else(|| "无法定位 Claude 配置目录".to_string())
}

fn read_settings(path: &Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取 Claude 设置失败: {}", error))?;
    let root = serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("解析 Claude 设置失败: {}", error))?;
    if !root.is_object() {
        return Err("Claude 设置根节点不是对象".to_string());
    }
    Ok(root)
}

fn backup_and_write_settings(path: &Path, root: &serde_json::Value) -> Result<(), String> {
    let config_dir = path
        .parent()
        .ok_or_else(|| "Claude 设置路径无效".to_string())?;
    fs::create_dir_all(config_dir)
        .map_err(|error| format!("创建 Claude 配置目录失败: {}", error))?;
    if path.exists() {
        let backup = config_dir.join("settings.json.terminalbuddy.bak");
        if !backup.exists() {
            let original =
                fs::read(path).map_err(|error| format!("读取 Claude 设置备份源失败: {}", error))?;
            atomic_write(&backup, &original)
                .map_err(|error| format!("备份 Claude 设置失败: {}", error))?;
        }
    }
    let content = serde_json::to_string_pretty(root)
        .map_err(|error| format!("序列化 Claude 设置失败: {}", error))?;
    atomic_write(path, content.as_bytes())
        .map_err(|error| format!("保存 Claude 设置失败: {}", error))
}

fn hook_handler(definition: HookDefinition) -> serde_json::Value {
    serde_json::json!({
        "type": "http",
        "url": CLAUDE_HOOK_URL,
        "headers": {
            "Authorization": "Bearer ${TERMINAL_BUDDY_HOOK_TOKEN}",
            "X-TerminalBuddy-Terminal-Id": "${TERMINAL_BUDDY_TERMINAL_ID}"
        },
        "allowedEnvVars": ["TERMINAL_BUDDY_HOOK_TOKEN", "TERMINAL_BUDDY_TERMINAL_ID"],
        "timeout": 90000,
        "statusMessage": definition.status_message
    })
}

/// 构建注入模型终端临时 `--settings` 文件的 `hooks` 对象（全部事件）。
/// Claude Code 会合并执行各 settings 来源的 hooks，因此用户级 settings.json
/// 里的旧版残留必须先清掉（见 [`uninstall_claude_http_hooks_at`]），
/// 否则同一事件会触发两次。
pub fn managed_hooks_object() -> serde_json::Value {
    let mut hooks = serde_json::Map::new();
    for definition in HOOK_DEFINITIONS {
        let mut group = serde_json::json!({ "hooks": [hook_handler(*definition)] });
        if let Some(matcher) = definition.matcher {
            group["matcher"] = serde_json::Value::String(matcher.to_string());
        }
        hooks.insert(definition.event.to_string(), serde_json::Value::Array(vec![group]));
    }
    serde_json::Value::Object(hooks)
}

fn matcher_matches(group: &serde_json::Value, matcher: Option<&str>) -> bool {
    match matcher {
        Some(expected) => {
            group.get("matcher").and_then(serde_json::Value::as_str) == Some(expected)
        }
        None => group.get("matcher").is_none(),
    }
}

fn is_managed_handler(value: &serde_json::Value) -> bool {
    value.get("url").and_then(serde_json::Value::as_str) == Some(CLAUDE_HOOK_URL)
        || value
            .get("command")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|command| command.contains(CLAUDE_HOOK_CLIENT_ARG))
}

fn hook_registered(root: &serde_json::Value, definition: HookDefinition) -> bool {
    let expected = hook_handler(definition);
    root.pointer(&format!("/hooks/{}", definition.event))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|groups| {
            groups.iter().any(|group| {
                matcher_matches(group, definition.matcher)
                    && group
                        .get("hooks")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|items| items.iter().any(|item| item == &expected))
            })
        })
}

fn has_any_managed_hook(root: &serde_json::Value) -> bool {
    root.get("hooks")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|hooks| {
            hooks.values().any(|groups| {
                groups.as_array().is_some_and(|groups| {
                    groups.iter().any(|group| {
                        group
                            .get("hooks")
                            .and_then(serde_json::Value::as_array)
                            .is_some_and(|items| items.iter().any(is_managed_handler))
                    })
                })
            })
        })
}

/// 检测用户级 settings.json 里的 TerminalBuddy 残留 hooks（旧版安装产物）。
/// `installedEvents` / `missingEvents` 描述残留情况，`notInstalled` 表示无残留；
/// 新版 Hook 随模型终端临时文件注入，此状态仅用于提示清理。
pub fn get_claude_hook_settings_status(
    selected_dir: Option<&str>,
) -> Result<ClaudeHookSettingsStatus, String> {
    let config_dir = resolve_claude_config_dir(selected_dir)?;
    let settings_path = config_dir.join("settings.json");
    let base = |status: &str, installed_events: Vec<String>, missing_events: Vec<String>, error| {
        ClaudeHookSettingsStatus {
            config_dir: config_dir.to_string_lossy().to_string(),
            settings_path: settings_path.to_string_lossy().to_string(),
            status: status.to_string(),
            installed_events,
            missing_events,
            server_running: hook_server_running().load(Ordering::SeqCst),
            server_port: hook_server_port().load(Ordering::SeqCst),
            error,
        }
    };
    if !settings_path.exists() {
        return Ok(base(
            "notInstalled",
            Vec::new(),
            HOOK_DEFINITIONS
                .iter()
                .map(|item| item.key.to_string())
                .collect(),
            None,
        ));
    }
    let root = match read_settings(&settings_path) {
        Ok(root) => root,
        Err(error) => {
            return Ok(base(
                "invalid",
                Vec::new(),
                HOOK_DEFINITIONS
                    .iter()
                    .map(|item| item.key.to_string())
                    .collect(),
                Some(error),
            ));
        }
    };
    let installed_events = HOOK_DEFINITIONS
        .iter()
        .filter(|definition| hook_registered(&root, **definition))
        .map(|definition| definition.key.to_string())
        .collect::<Vec<_>>();
    let missing_events = HOOK_DEFINITIONS
        .iter()
        .filter(|definition| !hook_registered(&root, **definition))
        .map(|definition| definition.key.to_string())
        .collect::<Vec<_>>();
    let status = if missing_events.is_empty() {
        "installed"
    } else if installed_events.is_empty() && !has_any_managed_hook(&root) {
        "notInstalled"
    } else {
        "partialInstalled"
    };
    Ok(base(status, installed_events, missing_events, None))
}

/// 清理用户级 settings.json 里的 TerminalBuddy 残留 hooks（幂等）。
/// 桌面端启动时调用一次，用于卸载旧版安装的 hooks，避免与临时注入重复触发。
pub fn uninstall_claude_http_hooks_at(
    selected_dir: Option<&str>,
) -> Result<ClaudeHookSettingsStatus, String> {
    let _guard = claude_settings_write_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let config_dir = resolve_claude_config_dir(selected_dir)?;
    let path = config_dir.join("settings.json");
    if !path.exists() {
        return get_claude_hook_settings_status(Some(&config_dir.to_string_lossy()));
    }
    let mut root = read_settings(&path)?;
    if remove_managed_hooks(&mut root)? {
        backup_and_write_settings(&path, &root)?;
    }
    get_claude_hook_settings_status(Some(&config_dir.to_string_lossy()))
}

fn remove_managed_hooks(root: &mut serde_json::Value) -> Result<bool, String> {
    let Some(hooks) = root
        .as_object_mut()
        .ok_or_else(|| "Claude 设置根节点不是对象".to_string())?
        .get_mut("hooks")
    else {
        return Ok(false);
    };
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| "Claude hooks 设置不是对象".to_string())?;
    let event_names = hooks.keys().cloned().collect::<Vec<_>>();
    let mut changed = false;
    let mut empty_events = Vec::new();
    for event_name in event_names {
        let Some(groups) = hooks
            .get_mut(&event_name)
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        for group in groups.iter_mut() {
            let Some(items) = group
                .get_mut("hooks")
                .and_then(serde_json::Value::as_array_mut)
            else {
                continue;
            };
            let previous_len = items.len();
            items.retain(|item| !is_managed_handler(item));
            changed |= previous_len != items.len();
        }
        groups.retain(|group| {
            let is_empty = group
                .get("hooks")
                .and_then(serde_json::Value::as_array)
                .is_some_and(Vec::is_empty);
            let only_hook_fields = group
                .as_object()
                .is_some_and(|object| object.keys().all(|key| key == "hooks" || key == "matcher"));
            !(is_empty && only_hook_fields)
        });
        if groups.is_empty() {
            empty_events.push(event_name);
        }
    }
    for event_name in empty_events {
        hooks.remove(&event_name);
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::{
        hook_handler, managed_hooks_object, matcher_matches, normalize_claude_config_dir,
        remove_managed_hooks, CLAUDE_HOOK_URL, HOOK_DEFINITIONS,
    };
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn all_hook_definitions_generate_authenticated_http_handlers() {
        for definition in HOOK_DEFINITIONS {
            let handler = hook_handler(*definition);
            assert_eq!(
                handler.get("type").and_then(|value| value.as_str()),
                Some("http")
            );
            assert_eq!(
                handler.get("url").and_then(|value| value.as_str()),
                Some(CLAUDE_HOOK_URL)
            );
            assert!(handler.get("command").is_none());
            assert_eq!(
                handler
                    .pointer("/headers/Authorization")
                    .and_then(|value| value.as_str()),
                Some("Bearer ${TERMINAL_BUDDY_HOOK_TOKEN}")
            );
            assert_eq!(
                handler
                    .pointer("/headers/X-TerminalBuddy-Terminal-Id")
                    .and_then(|value| value.as_str()),
                Some("${TERMINAL_BUDDY_TERMINAL_ID}")
            );
            assert_eq!(
                handler
                    .get("allowedEnvVars")
                    .and_then(|value| value.as_array())
                    .map(Vec::len),
                Some(2)
            );
        }
    }

    #[test]
    fn managed_hooks_object_covers_all_events_with_expected_shape() {
        let hooks = managed_hooks_object();
        assert_eq!(
            hooks.as_object().map(serde_json::Map::len),
            Some(HOOK_DEFINITIONS.len())
        );
        for definition in HOOK_DEFINITIONS {
            let groups = hooks
                .pointer(&format!("/{}", definition.event))
                .and_then(|value| value.as_array())
                .unwrap_or_else(|| panic!("{} 事件缺失", definition.event));
            assert_eq!(groups.len(), 1, "{} 应只有一个分组", definition.event);
            assert!(matcher_matches(&groups[0], definition.matcher));
            assert_eq!(
                groups[0].pointer("/hooks/0").unwrap(),
                &hook_handler(*definition)
            );
        }
        // permission_prompt 匹配器只挂在 Notification 事件上
        assert_eq!(
            hooks
                .pointer("/Notification/0/matcher")
                .and_then(|value| value.as_str()),
            Some("permission_prompt")
        );
        assert!(hooks.pointer("/PreToolUse/0/matcher").is_none());
    }

    #[test]
    fn config_directory_must_be_absolute_and_is_lexically_normalized() {
        assert!(normalize_claude_config_dir("relative\\.claude").is_err());
        let base = std::env::current_dir().unwrap();
        let selected = base.join("one").join("..").join("two");
        let normalized = normalize_claude_config_dir(&selected.to_string_lossy()).unwrap();
        assert_eq!(PathBuf::from(normalized), base.join("two"));
    }

    #[test]
    fn uninstall_only_removes_terminal_buddy_hooks() {
        let mut root = json!({
            "hooks": {
                "Stop": [{
                    "hooks": [
                        { "type": "command", "command": "existing" },
                        { "type": "http", "url": CLAUDE_HOOK_URL }
                    ]
                }]
            },
            "theme": "dark"
        });

        assert!(remove_managed_hooks(&mut root).unwrap());
        assert_eq!(
            root.pointer("/hooks/Stop/0/hooks/0/command")
                .and_then(|value| value.as_str()),
            Some("existing")
        );
        assert_eq!(
            root.get("theme").and_then(|value| value.as_str()),
            Some("dark")
        );
    }
}
