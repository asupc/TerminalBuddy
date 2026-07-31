use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tokio::sync::oneshot;

use super::atomic_file::atomic_write;
use super::settings_service::SettingsService;

pub const CLAUDE_HOOK_PORT: u16 = 19601;
pub const CLAUDE_HOOK_URL: &str = "http://127.0.0.1:19601/api/claude/hooks";
pub const CLAUDE_HOOK_CLIENT_ARG: &str = "__terminal_buddy_claude_hook";

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
        matcher: Some("AskUserQuestion"),
        status_message: "等待 TerminalBuddy 决策",
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookQuestion {
    pub question: String,
    pub header: String,
    pub options: Vec<ClaudeHookOption>,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookDecisionEvent {
    pub decision_id: String,
    pub terminal_id: String,
    pub questions: Vec<ClaudeHookQuestion>,
    pub expires_at: i64,
    pub occurred_at: i64,
}

struct PendingDecision {
    terminal_id: String,
    questions: Vec<ClaudeHookQuestion>,
    expires_at: i64,
    occurred_at: i64,
    answers: HashMap<String, String>,
    response: Option<oneshot::Sender<ClaudeHookResolution>>,
    notification_state: DecisionNotificationState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DecisionNotificationState {
    Pending,
    Sending(u64),
    Sent,
}

pub struct ClaudeHookNotificationLease {
    pub terminal_id: String,
    pub questions: Vec<ClaudeHookQuestion>,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookTerminalEvent {
    pub event_id: String,
    pub terminal_id: String,
    pub session_id: String,
    pub event_name: String,
    pub phase: String,
    pub occurred_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

pub enum ClaudeHookResolution {
    Answers(HashMap<String, String>),
    ContinueInTerminal,
}

fn pending() -> &'static Mutex<HashMap<String, PendingDecision>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingDecision>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn terminal_tokens() -> &'static Mutex<HashMap<String, String>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn recent_prompts() -> &'static Mutex<HashMap<(String, String), String>> {
    static PROMPTS: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    PROMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn hook_server_running() -> &'static AtomicBool {
    static RUNNING: OnceLock<AtomicBool> = OnceLock::new();
    RUNNING.get_or_init(|| AtomicBool::new(false))
}

fn hook_server_port() -> &'static AtomicU16 {
    static PORT: OnceLock<AtomicU16> = OnceLock::new();
    PORT.get_or_init(|| AtomicU16::new(0))
}

fn claude_settings_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn next_notification_generation() -> u64 {
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    GENERATION.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
}

fn cancel_decision_cards(decision_id: &str, question_count: usize) {
    for index in 0..question_count {
        let _ = crate::services::BotBindingService::cancel(&card_decision_id(decision_id, index));
    }
}

pub struct ClaudeHookService;

impl ClaudeHookService {
    pub fn set_server_state(running: bool, port: u16) {
        hook_server_running().store(running, Ordering::SeqCst);
        hook_server_port().store(if running { port } else { 0 }, Ordering::SeqCst);
    }

    pub fn server_port() -> u16 {
        hook_server_port().load(Ordering::SeqCst)
    }

    pub fn register_terminal(terminal_id: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        terminal_tokens()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .insert(terminal_id.to_string(), token.clone());
        token
    }

    pub fn unregister_terminal(terminal_id: &str) {
        terminal_tokens()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .remove(terminal_id);
        recent_prompts()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .retain(|(registered_terminal_id, _), _| registered_terminal_id != terminal_id);
        let removed = {
            let mut current = pending().lock().unwrap_or_else(|value| value.into_inner());
            let removed = current
                .iter()
                .filter(|(_, decision)| decision.terminal_id == terminal_id)
                .map(|(decision_id, decision)| (decision_id.clone(), decision.questions.len()))
                .collect::<Vec<_>>();
            for (decision_id, _) in &removed {
                current.remove(decision_id);
            }
            removed
        };
        for (decision_id, question_count) in removed {
            cancel_decision_cards(&decision_id, question_count);
        }
    }

    pub fn validate_terminal(terminal_id: &str, token: &str) -> bool {
        terminal_tokens()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .get(terminal_id)
            .is_some_and(|expected| expected == token)
    }

    pub fn insert_decision(
        decision_id: String,
        terminal_id: String,
        questions: Vec<ClaudeHookQuestion>,
        expires_at: i64,
        occurred_at: i64,
    ) -> oneshot::Receiver<ClaudeHookResolution> {
        let (tx, rx) = oneshot::channel();
        pending()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .insert(
                decision_id,
                PendingDecision {
                    terminal_id,
                    questions,
                    expires_at,
                    occurred_at,
                    answers: HashMap::new(),
                    response: Some(tx),
                    notification_state: DecisionNotificationState::Pending,
                },
            );
        rx
    }

    pub fn remember_prompt(terminal_id: &str, session_id: &str, prompt: String) {
        recent_prompts()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .insert((terminal_id.to_string(), session_id.to_string()), prompt);
    }

    pub fn recent_prompt(terminal_id: &str, session_id: &str) -> Option<String> {
        recent_prompts()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .get(&(terminal_id.to_string(), session_id.to_string()))
            .cloned()
    }

    pub fn clear_session_prompt(terminal_id: &str, session_id: &str) {
        recent_prompts()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .remove(&(terminal_id.to_string(), session_id.to_string()));
    }

    pub fn list_pending_decisions() -> Vec<ClaudeHookDecisionEvent> {
        let mut decisions = pending()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .iter()
            .map(|(decision_id, decision)| ClaudeHookDecisionEvent {
                decision_id: decision_id.clone(),
                terminal_id: decision.terminal_id.clone(),
                questions: decision.questions.clone(),
                expires_at: decision.expires_at,
                occurred_at: decision.occurred_at,
            })
            .collect::<Vec<_>>();
        decisions.sort_by_key(|decision| decision.occurred_at);
        decisions
    }

    pub fn begin_notification(decision_id: &str) -> Option<ClaudeHookNotificationLease> {
        let mut current = pending().lock().unwrap_or_else(|value| value.into_inner());
        let decision = current.get_mut(decision_id)?;
        if decision.notification_state != DecisionNotificationState::Pending {
            return None;
        }
        let generation = next_notification_generation();
        decision.notification_state = DecisionNotificationState::Sending(generation);
        Some(ClaudeHookNotificationLease {
            terminal_id: decision.terminal_id.clone(),
            questions: decision.questions.clone(),
            generation,
        })
    }

    pub fn notification_is_current(decision_id: &str, generation: u64) -> bool {
        pending()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .get(decision_id)
            .is_some_and(|decision| {
                decision.notification_state == DecisionNotificationState::Sending(generation)
            })
    }

    pub fn finish_notification(decision_id: &str, generation: u64, sent: bool) -> bool {
        let mut current = pending().lock().unwrap_or_else(|value| value.into_inner());
        let Some(decision) = current.get_mut(decision_id) else {
            return false;
        };
        if decision.notification_state != DecisionNotificationState::Sending(generation) {
            return false;
        }
        decision.notification_state = if sent {
            DecisionNotificationState::Sent
        } else {
            DecisionNotificationState::Pending
        };
        true
    }

    pub fn cancel_notification_cards(decision_id: &str, question_count: usize) {
        cancel_decision_cards(decision_id, question_count);
    }

    pub fn expire_decision(decision_id: &str) {
        let question_count = pending()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .remove(decision_id)
            .map(|decision| decision.questions.len())
            .unwrap_or_default();
        cancel_decision_cards(decision_id, question_count);
    }

    pub fn answer_all(decision_id: &str, answers: HashMap<String, String>) -> Result<(), String> {
        let mut current = pending().lock().unwrap_or_else(|value| value.into_inner());
        let decision = current
            .get_mut(decision_id)
            .ok_or_else(|| "该 Claude 决策已失效".to_string())?;
        for question in &decision.questions {
            if !answers.contains_key(&question.question) {
                return Err(format!("问题“{}”尚未回答", question.question));
            }
        }
        let question_count = decision.questions.len();
        let response = decision
            .response
            .take()
            .ok_or_else(|| "该 Claude 决策已处理".to_string())?;
        let _ = response.send(ClaudeHookResolution::Answers(answers));
        current.remove(decision_id);
        drop(current);
        cancel_decision_cards(decision_id, question_count);
        Ok(())
    }

    pub fn answer_card(card_decision_id: &str, selected_indexes: &[usize]) -> Result<bool, String> {
        let Some((decision_id, question_index)) = parse_card_decision_id(card_decision_id) else {
            return Ok(false);
        };
        let mut current = pending().lock().unwrap_or_else(|value| value.into_inner());
        let decision = current
            .get_mut(decision_id)
            .ok_or_else(|| "该 Claude 决策已失效".to_string())?;
        let question = decision
            .questions
            .get(question_index)
            .ok_or_else(|| "Claude 决策问题不存在".to_string())?;
        let labels = selected_indexes
            .iter()
            .map(|index| {
                question
                    .options
                    .get(*index)
                    .map(|option| option.label.clone())
                    .ok_or_else(|| "Claude 决策选项不存在".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if labels.is_empty() {
            return Err("请至少选择一个选项".to_string());
        }
        decision
            .answers
            .insert(question.question.clone(), labels.join(", "));
        let complete = decision
            .questions
            .iter()
            .all(|item| decision.answers.contains_key(&item.question));
        let question_count = if complete {
            let answers = decision.answers.clone();
            if let Some(response) = decision.response.take() {
                let _ = response.send(ClaudeHookResolution::Answers(answers));
            }
            let question_count = decision.questions.len();
            current.remove(decision_id);
            Some(question_count)
        } else {
            None
        };
        drop(current);
        if let Some(question_count) = question_count {
            cancel_decision_cards(decision_id, question_count);
        }
        Ok(true)
    }

    pub fn continue_in_terminal(decision_id: &str) -> Result<(), String> {
        let mut current = pending().lock().unwrap_or_else(|value| value.into_inner());
        let mut decision = current
            .remove(decision_id)
            .ok_or_else(|| "该 Claude 决策已失效".to_string())?;
        let question_count = decision.questions.len();
        let response = decision
            .response
            .take()
            .ok_or_else(|| "该 Claude 决策已处理".to_string())?;
        let _ = response.send(ClaudeHookResolution::ContinueInTerminal);
        drop(current);
        cancel_decision_cards(decision_id, question_count);
        Ok(())
    }

    pub fn answer_card_text(card_decision_id: &str, text: &str) -> Result<bool, String> {
        let Some((decision_id, question_index)) = parse_card_decision_id(card_decision_id) else {
            return Ok(false);
        };
        let answer = text.trim();
        if answer.is_empty() {
            return Err("回复内容为空".to_string());
        }
        let mut current = pending().lock().unwrap_or_else(|value| value.into_inner());
        let decision = current
            .get_mut(decision_id)
            .ok_or_else(|| "该 Claude 决策已失效".to_string())?;
        let question = decision
            .questions
            .get(question_index)
            .ok_or_else(|| "Claude 决策问题不存在".to_string())?;
        decision
            .answers
            .insert(question.question.clone(), answer.to_string());
        let complete = decision
            .questions
            .iter()
            .all(|item| decision.answers.contains_key(&item.question));
        let question_count = if complete {
            let answers = decision.answers.clone();
            if let Some(response) = decision.response.take() {
                let _ = response.send(ClaudeHookResolution::Answers(answers));
            }
            let question_count = decision.questions.len();
            current.remove(decision_id);
            Some(question_count)
        } else {
            None
        };
        drop(current);
        if let Some(question_count) = question_count {
            cancel_decision_cards(decision_id, question_count);
        }
        Ok(true)
    }
}

pub fn card_decision_id(decision_id: &str, question_index: usize) -> String {
    format!("{}::q{}", decision_id, question_index)
}

fn parse_card_decision_id(value: &str) -> Option<(&str, usize)> {
    let (decision_id, suffix) = value.rsplit_once("::q")?;
    Some((decision_id, suffix.parse().ok()?))
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

fn resolve_claude_config_dir(selected_dir: Option<&str>) -> Result<PathBuf, String> {
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

pub fn install_claude_http_hooks_at(
    selected_dir: Option<&str>,
) -> Result<ClaudeHookSettingsStatus, String> {
    let _guard = claude_settings_write_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let config_dir = resolve_claude_config_dir(selected_dir)?;
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("创建 Claude 配置目录失败: {}", error))?;
    let path = config_dir.join("settings.json");
    let mut root = read_settings(&path)?;
    let mut changed = false;
    for definition in HOOK_DEFINITIONS {
        changed |= ensure_hook(&mut root, *definition)?;
    }
    if changed {
        backup_and_write_settings(&path, &root)?;
    }
    get_claude_hook_settings_status(Some(&config_dir.to_string_lossy()))
}

pub fn install_claude_http_hooks() -> Result<(), String> {
    install_claude_http_hooks_at(None).map(|_| ())
}

pub fn repair_claude_http_hooks_if_managed(
    selected_dir: Option<&str>,
) -> Result<ClaudeHookSettingsStatus, String> {
    let status = get_claude_hook_settings_status(selected_dir)?;
    if status.status == "partialInstalled" {
        install_claude_http_hooks_at(Some(&status.config_dir))
    } else {
        Ok(status)
    }
}

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

fn ensure_hook(root: &mut serde_json::Value, definition: HookDefinition) -> Result<bool, String> {
    let root_object = root
        .as_object_mut()
        .ok_or_else(|| "Claude 设置根节点不是对象".to_string())?;
    let hooks = root_object
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "Claude hooks 设置不是对象".to_string())?;
    let groups = hooks
        .entry(definition.event)
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("Claude {} hooks 设置不是数组", definition.event))?;
    let handler = hook_handler(definition);
    let mut changed = false;
    let mut found = false;
    for group in groups.iter_mut() {
        let group_matches = matcher_matches(group, definition.matcher);
        if let Some(items) = group
            .get_mut("hooks")
            .and_then(serde_json::Value::as_array_mut)
        {
            let previous = std::mem::take(items);
            for item in previous {
                if !is_managed_handler(&item) {
                    items.push(item);
                } else if group_matches && !found {
                    changed |= item != handler;
                    items.push(handler.clone());
                    found = true;
                } else {
                    changed = true;
                }
            }
        }
    }
    if found {
        return Ok(changed);
    }
    let mut group = serde_json::json!({ "hooks": [handler] });
    if let Some(matcher) = definition.matcher {
        group["matcher"] = serde_json::Value::String(matcher.to_string());
    }
    groups.push(group);
    Ok(true)
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
        card_decision_id, ensure_hook, hook_handler, normalize_claude_config_dir,
        parse_card_decision_id, remove_managed_hooks, ClaudeHookOption, ClaudeHookQuestion,
        ClaudeHookResolution, ClaudeHookService, HookDefinition, CLAUDE_HOOK_CLIENT_ARG,
        CLAUDE_HOOK_URL, HOOK_DEFINITIONS,
    };
    use serde_json::json;
    use std::path::PathBuf;

    fn definition(key: &str) -> HookDefinition {
        *HOOK_DEFINITIONS
            .iter()
            .find(|definition| definition.key == key)
            .unwrap()
    }

    #[test]
    fn card_decision_id_round_trip() {
        let value = card_decision_id("session:tool", 2);
        assert_eq!(parse_card_decision_id(&value), Some(("session:tool", 2)));
    }

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
    fn hook_installation_preserves_existing_hooks_and_is_idempotent() {
        let mut root = json!({
            "hooks": {
                "PreToolUse": [{
                    "matcher": "Write|Edit",
                    "hooks": [{ "type": "command", "command": "existing" }]
                }]
            }
        });
        assert!(ensure_hook(&mut root, definition("decision")).unwrap());
        assert!(!ensure_hook(&mut root, definition("decision")).unwrap());
        assert!(ensure_hook(&mut root, definition("completion")).unwrap());
        assert!(!ensure_hook(&mut root, definition("completion")).unwrap());
        let pre_tool_use = root
            .pointer("/hooks/PreToolUse")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(pre_tool_use.len(), 2);
        assert_eq!(
            pre_tool_use[0]
                .pointer("/hooks/0/command")
                .and_then(|value| value.as_str()),
            Some("existing")
        );
        assert_eq!(
            pre_tool_use[1]
                .pointer("/hooks/0/url")
                .and_then(|value| value.as_str()),
            Some(CLAUDE_HOOK_URL)
        );
        assert_eq!(
            root.pointer("/hooks/Stop/0/hooks/0/timeout")
                .and_then(|value| value.as_u64()),
            Some(90_000)
        );
    }

    #[test]
    fn hook_installation_repairs_a_terminal_buddy_hook_with_the_wrong_matcher() {
        let mut root = json!({
            "hooks": {
                "PreToolUse": [{
                    "matcher": "Write|Edit",
                    "hooks": [{ "type": "http", "url": CLAUDE_HOOK_URL }]
                }]
            }
        });

        assert!(ensure_hook(&mut root, definition("decision")).unwrap());
        let groups = root
            .pointer("/hooks/PreToolUse")
            .unwrap()
            .as_array()
            .unwrap();
        assert!(groups[0].pointer("/hooks/0").is_none());
        assert_eq!(
            groups[1].get("matcher").and_then(|value| value.as_str()),
            Some("AskUserQuestion")
        );
        assert_eq!(
            groups[1]
                .pointer("/hooks/0/url")
                .and_then(|value| value.as_str()),
            Some(CLAUDE_HOOK_URL)
        );
    }

    #[test]
    fn hook_installation_migrates_legacy_command_hooks_to_http() {
        let legacy_command = format!("terminal-buddy.exe {}", CLAUDE_HOOK_CLIENT_ARG);
        let mut root = json!({
            "hooks": {
                "Stop": [{
                    "hooks": [
                        { "type": "command", "command": legacy_command },
                        {
                            "type": "http",
                            "url": CLAUDE_HOOK_URL,
                            "headers": {}
                        }
                    ]
                }]
            }
        });

        assert!(ensure_hook(&mut root, definition("completion")).unwrap());
        assert!(!ensure_hook(&mut root, definition("completion")).unwrap());

        let handlers = root
            .pointer("/hooks/Stop/0/hooks")
            .and_then(|value| value.as_array())
            .unwrap();
        assert_eq!(handlers.len(), 1);
        assert_eq!(
            handlers[0].get("type").and_then(|value| value.as_str()),
            Some("http")
        );
        assert_eq!(
            handlers[0]
                .pointer("/headers/Authorization")
                .and_then(|value| value.as_str()),
            Some("Bearer ${TERMINAL_BUDDY_HOOK_TOKEN}")
        );
        assert_eq!(
            handlers[0]
                .pointer("/allowedEnvVars/1")
                .and_then(|value| value.as_str()),
            Some("TERMINAL_BUDDY_TERMINAL_ID")
        );
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
    fn notification_generation_allows_only_one_current_sender() {
        let decision_id = format!("notification-test-{}", uuid::Uuid::new_v4());
        let _receiver = ClaudeHookService::insert_decision(
            decision_id.clone(),
            "terminal-test".to_string(),
            Vec::new(),
            123,
            100,
        );
        let first = ClaudeHookService::begin_notification(&decision_id).unwrap();
        assert!(ClaudeHookService::notification_is_current(
            &decision_id,
            first.generation
        ));
        assert!(ClaudeHookService::begin_notification(&decision_id).is_none());
        assert!(ClaudeHookService::finish_notification(
            &decision_id,
            first.generation,
            false
        ));

        let second = ClaudeHookService::begin_notification(&decision_id).unwrap();
        assert_ne!(second.generation, first.generation);
        assert!(ClaudeHookService::finish_notification(
            &decision_id,
            second.generation,
            true
        ));
        assert!(ClaudeHookService::begin_notification(&decision_id).is_none());
        ClaudeHookService::expire_decision(&decision_id);
    }

    #[test]
    fn recent_prompts_are_isolated_by_terminal_and_session_and_cleared_on_unregister() {
        let terminal_id = format!("prompt-terminal-{}", uuid::Uuid::new_v4());
        let other_terminal_id = format!("prompt-terminal-{}", uuid::Uuid::new_v4());
        ClaudeHookService::remember_prompt(&terminal_id, "session-a", "任务 A".to_string());
        ClaudeHookService::remember_prompt(&terminal_id, "session-b", "任务 B".to_string());
        ClaudeHookService::remember_prompt(
            &other_terminal_id,
            "session-a",
            "其他终端任务".to_string(),
        );

        assert_eq!(
            ClaudeHookService::recent_prompt(&terminal_id, "session-a").as_deref(),
            Some("任务 A")
        );
        ClaudeHookService::clear_session_prompt(&terminal_id, "session-a");
        assert!(ClaudeHookService::recent_prompt(&terminal_id, "session-a").is_none());
        assert_eq!(
            ClaudeHookService::recent_prompt(&terminal_id, "session-b").as_deref(),
            Some("任务 B")
        );

        ClaudeHookService::unregister_terminal(&terminal_id);
        assert!(ClaudeHookService::recent_prompt(&terminal_id, "session-b").is_none());
        assert_eq!(
            ClaudeHookService::recent_prompt(&other_terminal_id, "session-a").as_deref(),
            Some("其他终端任务")
        );
        ClaudeHookService::unregister_terminal(&other_terminal_id);
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

    #[tokio::test]
    async fn card_answer_resolves_structured_hook_response() {
        let decision_id = "session:tool-test";
        let receiver = ClaudeHookService::insert_decision(
            decision_id.to_string(),
            "terminal-test".to_string(),
            vec![ClaudeHookQuestion {
                question: "选择语言".to_string(),
                header: "语言".to_string(),
                options: vec![
                    ClaudeHookOption {
                        label: "中文".to_string(),
                        description: None,
                    },
                    ClaudeHookOption {
                        label: "English".to_string(),
                        description: None,
                    },
                ],
                multi_select: false,
            }],
            123,
            100,
        );
        assert!(ClaudeHookService::answer_card(&card_decision_id(decision_id, 0), &[1]).unwrap());
        let ClaudeHookResolution::Answers(answers) = receiver.await.unwrap() else {
            panic!("应返回结构化回答");
        };
        assert_eq!(answers.get("选择语言").map(String::as_str), Some("English"));
    }

    #[tokio::test]
    async fn continue_in_terminal_releases_the_hook_without_answers() {
        let decision_id = "session:terminal-test";
        let receiver = ClaudeHookService::insert_decision(
            decision_id.to_string(),
            "terminal-test".to_string(),
            vec![ClaudeHookQuestion {
                question: "继续处理？".to_string(),
                header: "处理方式".to_string(),
                options: vec![],
                multi_select: false,
            }],
            123,
            100,
        );

        ClaudeHookService::continue_in_terminal(decision_id).unwrap();
        assert!(matches!(
            receiver.await.unwrap(),
            ClaudeHookResolution::ContinueInTerminal
        ));
    }
}
