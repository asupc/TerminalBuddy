use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tokio::sync::oneshot;

pub const CLAUDE_HOOK_PORT: u16 = 19601;
pub const CLAUDE_HOOK_URL: &str = "http://127.0.0.1:19601/api/claude/hooks";

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
}

struct PendingDecision {
    terminal_id: String,
    questions: Vec<ClaudeHookQuestion>,
    answers: HashMap<String, String>,
    response: Option<oneshot::Sender<ClaudeHookResolution>>,
    notification_sent: bool,
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

pub struct ClaudeHookService;

impl ClaudeHookService {
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
        let mut current = pending().lock().unwrap_or_else(|value| value.into_inner());
        current.retain(|_, decision| decision.terminal_id != terminal_id);
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
                    answers: HashMap::new(),
                    response: Some(tx),
                    notification_sent: false,
                },
            );
        rx
    }

    pub fn take_notification(decision_id: &str) -> Option<(String, Vec<ClaudeHookQuestion>)> {
        let mut current = pending().lock().unwrap_or_else(|value| value.into_inner());
        let decision = current.get_mut(decision_id)?;
        if decision.notification_sent {
            return None;
        }
        decision.notification_sent = true;
        Some((decision.terminal_id.clone(), decision.questions.clone()))
    }

    pub fn expire_decision(decision_id: &str) {
        let question_count = pending()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .remove(decision_id)
            .map(|decision| decision.questions.len())
            .unwrap_or_default();
        for index in 0..question_count {
            let _ =
                crate::services::BotBindingService::cancel(&card_decision_id(decision_id, index));
        }
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
        for index in 0..question_count {
            let _ =
                crate::services::BotBindingService::cancel(&card_decision_id(decision_id, index));
        }
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
        if complete {
            let answers = decision.answers.clone();
            if let Some(response) = decision.response.take() {
                let _ = response.send(ClaudeHookResolution::Answers(answers));
            }
            current.remove(decision_id);
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
        for index in 0..question_count {
            let _ =
                crate::services::BotBindingService::cancel(&card_decision_id(decision_id, index));
        }
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
        if complete {
            let answers = decision.answers.clone();
            if let Some(response) = decision.response.take() {
                let _ = response.send(ClaudeHookResolution::Answers(answers));
            }
            current.remove(decision_id);
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

pub fn install_claude_http_hooks() -> Result<(), String> {
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|path| path.join(".claude")))
        .ok_or_else(|| "无法定位 Claude 配置目录".to_string())?;
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("创建 Claude 配置目录失败: {}", error))?;
    let path = config_dir.join("settings.json");
    let mut root = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("读取 Claude 设置失败: {}", error))?;
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|error| format!("解析 Claude 设置失败: {}", error))?
    } else {
        serde_json::json!({})
    };
    let decision_hook_changed = ensure_hook(&mut root, "PreToolUse", Some("AskUserQuestion"))?;
    let completion_hook_changed = ensure_hook(&mut root, "Stop", None)?;
    if !decision_hook_changed && !completion_hook_changed {
        return Ok(());
    }
    if path.exists() {
        let backup = config_dir.join("settings.json.terminalbuddy.bak");
        if !backup.exists() {
            fs::copy(&path, &backup).map_err(|error| format!("备份 Claude 设置失败: {}", error))?;
        }
    }
    let content = serde_json::to_string_pretty(&root)
        .map_err(|error| format!("序列化 Claude 设置失败: {}", error))?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, content).map_err(|error| format!("写入 Claude 设置失败: {}", error))?;
    fs::rename(&temp, &path).map_err(|error| format!("保存 Claude 设置失败: {}", error))
}

fn ensure_hook(
    root: &mut serde_json::Value,
    event: &str,
    matcher: Option<&str>,
) -> Result<bool, String> {
    let root_object = root
        .as_object_mut()
        .ok_or_else(|| "Claude 设置根节点不是对象".to_string())?;
    let hooks = root_object
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "Claude hooks 设置不是对象".to_string())?;
    let groups = hooks
        .entry(event)
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("Claude {} hooks 设置不是数组", event))?;
    let handler = serde_json::json!({
        "type": "http",
        "url": CLAUDE_HOOK_URL,
        "headers": {
            "Authorization": "Bearer ${TERMINAL_BUDDY_HOOK_TOKEN}",
            "X-TerminalBuddy-Terminal-Id": "${TERMINAL_BUDDY_TERMINAL_ID}"
        },
        "allowedEnvVars": ["TERMINAL_BUDDY_HOOK_TOKEN", "TERMINAL_BUDDY_TERMINAL_ID"],
        "timeout": 90000,
        "statusMessage": if matcher.is_some() { "等待 TerminalBuddy 决策" } else { "通知 TerminalBuddy" }
    });
    let mut changed = false;
    for group in groups.iter_mut() {
        let matcher_matches = match matcher {
            Some(expected) => {
                group.get("matcher").and_then(serde_json::Value::as_str) == Some(expected)
            }
            None => group.get("matcher").is_none(),
        };
        if let Some(items) = group
            .get_mut("hooks")
            .and_then(serde_json::Value::as_array_mut)
        {
            if !matcher_matches {
                let previous_len = items.len();
                items.retain(|item| {
                    item.get("url").and_then(serde_json::Value::as_str) != Some(CLAUDE_HOOK_URL)
                });
                changed |= previous_len != items.len();
                continue;
            }
            if let Some(existing) = items.iter_mut().find(|item| {
                item.get("url").and_then(serde_json::Value::as_str) == Some(CLAUDE_HOOK_URL)
            }) {
                if existing == &handler {
                    return Ok(changed);
                }
                *existing = handler;
                return Ok(true);
            }
        }
    }
    let mut group = serde_json::json!({ "hooks": [handler] });
    if let Some(matcher) = matcher {
        group["matcher"] = serde_json::Value::String(matcher.to_string());
    }
    groups.push(group);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{
        card_decision_id, ensure_hook, parse_card_decision_id, ClaudeHookOption,
        ClaudeHookQuestion, ClaudeHookResolution, ClaudeHookService, CLAUDE_HOOK_URL,
    };
    use serde_json::json;

    #[test]
    fn card_decision_id_round_trip() {
        let value = card_decision_id("session:tool", 2);
        assert_eq!(parse_card_decision_id(&value), Some(("session:tool", 2)));
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
        assert!(ensure_hook(&mut root, "PreToolUse", Some("AskUserQuestion")).unwrap());
        assert!(!ensure_hook(&mut root, "PreToolUse", Some("AskUserQuestion")).unwrap());
        assert!(ensure_hook(&mut root, "Stop", None).unwrap());
        assert!(!ensure_hook(&mut root, "Stop", None).unwrap());
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

        assert!(ensure_hook(&mut root, "PreToolUse", Some("AskUserQuestion")).unwrap());
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
        );

        ClaudeHookService::continue_in_terminal(decision_id).unwrap();
        assert!(matches!(
            receiver.await.unwrap(),
            ClaudeHookResolution::ContinueInTerminal
        ));
    }
}
