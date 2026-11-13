//! Codex rollout 解析。参考 CLI-Manager 的 session_meta / response_item / token_count 读取方式。
//! response_item 是正文；event_msg 只补齐没有对应正文的旧记录，避免 TUI 重放事件重复计数。
use crate::models::session_history::{SessionReplayMessage, SessionReplayTool};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct CodexTranscript {
    pub session_id: Option<String>,
    pub project_dir: String,
    pub title: Option<String>,
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub messages: Vec<SessionReplayMessage>,
}

pub(super) fn timestamp(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .map(|date| date.timestamp_millis())
}

pub(super) fn excerpt(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let mut result: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        result.push('…');
    }
    result
}

fn text_content(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    value
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(
                    |block| match block.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" | "input_text" | "output_text" | "summary_text" => {
                            block.get("text").and_then(Value::as_str)
                        }
                        "input_image" | "image" => Some("[图片]"),
                        _ => None,
                    },
                )
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn tool_summary(value: &Value) -> String {
    let parsed = value
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let input = parsed.as_ref().unwrap_or(value);
    let text = [
        "command",
        "cmd",
        "file_path",
        "path",
        "query",
        "pattern",
        "input",
    ]
    .iter()
    .find_map(|key| input.get(key).and_then(Value::as_str))
    .map(str::to_owned)
    .unwrap_or_else(|| {
        input
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| input.to_string())
    });
    excerpt(text.trim(), 160)
}

/// 折叠空白后截断，作为标题/摘要的统一出口。
fn compact(text: &str) -> Option<String> {
    let value = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        return None;
    }
    Some(excerpt(&value, 80))
}

/// 这些 user 消息由 Codex 注入给模型，不是用户发出的内容。
///
/// 新版 rollout 在 payload 的 `internal_chat_message_metadata_passthrough`
/// 里给出 `content_item_kinds`（普通用户输入是 `user.text`），可精确判定；
/// 旧版没有该字段时按正文前缀兜底。`# Environment` 是部分版本的旧格式，
/// 当前实际为 `<environment_context>`。
fn is_injected_user_context(text: &str) -> bool {
    let trimmed = text.trim_start();
    [
        "# AGENTS.md instructions",
        "# Environment",
        "<environment_context>",
        "<codex_internal_context",
        "<INSTRUCTIONS>",
        "<permissions instructions>",
    ]
    .iter()
    .any(|prefix| trimmed.starts_with(prefix))
}

fn user_content_kind(kind: &str) -> bool {
    kind.starts_with("user.")
}

/// 按新版 rollout 的 block 级 metadata 只保留用户内容。
///
/// `content_item_kinds` 与 content blocks 一一对应：AGENTS.md、环境上下文、
/// 权限说明等 kind 不属于 `user.*`，不能进入聊天镜像；图片、音频等用户内容
/// 也以 `user.*` 标注，必须保留。若 metadata 缺失或与
/// content 数量不一致，则退回整段文本，由调用方按旧格式前缀兜底。
fn visible_user_text(payload: &Value) -> Option<String> {
    let content = payload.get("content").unwrap_or(&Value::Null);
    let kinds = payload
        .get("internal_chat_message_metadata_passthrough")?
        .get("content_item_kinds")?
        .as_array()?;
    let blocks = content.as_array()?;
    if kinds.len() != blocks.len() {
        return None;
    }
    let visible = blocks
        .iter()
        .zip(kinds)
        .filter(|(_, kind)| kind.as_str().is_some_and(user_content_kind))
        .map(|(block, _)| block.clone())
        .collect::<Vec<_>>();
    Some(text_content(&Value::Array(visible)))
}

/// Codex 把项目说明、运行环境与 /goal 内部提示写成 user 消息，不能拿它们充当用户的问题。
fn title_candidate(text: &str) -> Option<String> {
    if is_injected_user_context(text) {
        return None;
    }
    compact(text.trim())
}

/// /goal 功能注入的内部上下文不是用户输入，但目标本身值得作为标题兜底：
/// `source="user_goal"` 里是 `User set the goal: "…"`，`source="goal"` 里是 `<objective>…</objective>`。
fn goal_candidate(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if !trimmed.starts_with("<codex_internal_context") {
        return None;
    }
    let goal = trimmed
        .split_once("User set the goal:")
        .and_then(|(_, rest)| {
            let rest = rest.trim_start();
            let rest = rest.strip_prefix('"')?;
            let end = rest.find('"').unwrap_or(rest.len());
            Some(&rest[..end])
        })
        .or_else(|| {
            let rest = trimmed.split_once("<objective>")?.1;
            let end = rest.find("</objective>").unwrap_or(rest.len());
            Some(&rest[..end])
        })?;
    compact(goal)
}

pub(super) fn parse(content: &str) -> CodexTranscript {
    let mut result = CodexTranscript::default();
    let mut canonical = Vec::<(usize, SessionReplayMessage)>::new();
    let mut events = Vec::<(usize, SessionReplayMessage)>::new();
    let mut tool_names = HashMap::<String, String>::new();
    let mut last_usage = (0_i64, 0_i64);
    let mut has_totals = false;
    // 注入上下文不展示，但 /goal 的目标仍可在没有真实提问时充当标题。
    let mut goal_title = None;
    for (line_index, line) in content.lines().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = value.get("payload").unwrap_or(&value);
        let payload_kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        let time = value
            .get("timestamp")
            .and_then(timestamp)
            .or_else(|| payload.get("timestamp").and_then(timestamp));
        if let Some(time) = time {
            result.started_at = Some(result.started_at.map_or(time, |old| old.min(time)));
            result.updated_at = Some(result.updated_at.map_or(time, |old| old.max(time)));
        }
        if kind == "session_meta" {
            if let Some(id) = payload
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
            {
                result.session_id = Some(id.to_string());
            }
            if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                result.project_dir = cwd.to_string();
            }
            if let Some(title) = payload
                .get("title")
                .or_else(|| payload.get("thread_name"))
                .and_then(Value::as_str)
            {
                result.title = title_candidate(title);
            }
        }
        if matches!(kind, "turn_context" | "session_meta") {
            if result.project_dir.is_empty() {
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                    result.project_dir = cwd.to_string();
                }
            }
        }
        if let Some(model) = payload
            .get("model")
            .and_then(Value::as_str)
            .filter(|model| !model.is_empty())
        {
            result.model = Some(model.to_string());
        }
        if kind == "event_msg" && payload_kind == "token_count" {
            let info = &payload["info"];
            let usage = info
                .get("total_token_usage")
                .filter(|usage| usage.is_object());
            if let Some(usage) = usage {
                has_totals = true;
                // 累计快照可能重复、倒退；取高水位，不能把累计值相加，也不叠加 token_usage_record。
                result.input_tokens = result
                    .input_tokens
                    .max(usage["input_tokens"].as_i64().unwrap_or(0));
                result.output_tokens = result
                    .output_tokens
                    .max(usage["output_tokens"].as_i64().unwrap_or(0));
            } else if !has_totals {
                last_usage.0 += info["last_token_usage"]["input_tokens"]
                    .as_i64()
                    .unwrap_or(0)
                    .max(0);
                last_usage.1 += info["last_token_usage"]["output_tokens"]
                    .as_i64()
                    .unwrap_or(0)
                    .max(0);
            }
        }
        let mut message = SessionReplayMessage {
            seq: 0,
            role: String::new(),
            timestamp: time,
            text: String::new(),
            tools: Vec::new(),
            tool_name: None,
            skill_name: None,
        };
        if kind == "response_item" || kind == "message" {
            match payload_kind {
                "message" => {
                    let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
                    if !matches!(role, "user" | "assistant" | "tool") {
                        continue;
                    }
                    message.role = role.to_string();
                    let raw_text = text_content(&payload["content"]);
                    if role == "user" {
                        if let Some(visible) = visible_user_text(payload) {
                            if visible.trim().is_empty() {
                                goal_title = goal_title.or_else(|| goal_candidate(&raw_text));
                                continue;
                            }
                            message.text = visible;
                        } else if is_injected_user_context(&raw_text) {
                            goal_title = goal_title.or_else(|| goal_candidate(&raw_text));
                            continue;
                        } else {
                            message.text = raw_text;
                        }
                    } else {
                        message.text = raw_text;
                    }
                }
                "function_call" | "custom_tool_call" | "tool_call" | "mcp_tool_call" => {
                    let name = payload
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("工具")
                        .to_string();
                    if let Some(id) = payload
                        .get("call_id")
                        .or_else(|| payload.get("id"))
                        .and_then(Value::as_str)
                    {
                        tool_names.insert(id.to_string(), name.clone());
                    }
                    message.role = "assistant".to_string();
                    message.tools.push(SessionReplayTool {
                        name,
                        summary: tool_summary(
                            payload
                                .get("arguments")
                                .or_else(|| payload.get("input"))
                                .unwrap_or(&Value::Null),
                        ),
                    });
                }
                "function_call_output"
                | "custom_tool_call_output"
                | "tool_result"
                | "mcp_tool_call_output" => {
                    message.role = "tool".to_string();
                    let output = payload
                        .get("output")
                        .or_else(|| payload.get("content"))
                        .unwrap_or(&Value::Null);
                    message.text = excerpt(&text_content(output), 4096);
                    if message.text.is_empty() && !output.is_null() {
                        message.text = excerpt(&output.to_string(), 4096);
                    }
                    message.tool_name = payload
                        .get("call_id")
                        .and_then(Value::as_str)
                        .and_then(|id| tool_names.get(id))
                        .cloned();
                }
                // 加密推理与内部状态不作为正文展示或索引。
                _ => continue,
            }
            if !message.text.trim().is_empty() || !message.tools.is_empty() {
                canonical.push((line_index, message));
            }
        } else if kind == "event_msg" && matches!(payload_kind, "user_message" | "agent_message") {
            message.role = if payload_kind == "user_message" {
                "user"
            } else {
                "assistant"
            }
            .to_string();
            message.text = text_content(
                payload
                    .get("message")
                    .or_else(|| payload.get("text"))
                    .unwrap_or(&Value::Null),
            );
            if !message.text.trim().is_empty() {
                if message.role == "user" && is_injected_user_context(&message.text) {
                    goal_title = goal_title.or_else(|| goal_candidate(&message.text));
                } else {
                    events.push((line_index, message));
                }
            }
        }
    }
    if !has_totals {
        result.input_tokens = last_usage.0;
        result.output_tokens = last_usage.1;
    }
    let mut counts = HashMap::<(String, String), usize>::new();
    for (_, message) in &canonical {
        if !message.text.is_empty() {
            *counts
                .entry((message.role.clone(), message.text.clone()))
                .or_default() += 1;
        }
    }
    for event in events {
        let key = (event.1.role.clone(), event.1.text.clone());
        if let Some(count) = counts.get_mut(&key).filter(|count| **count > 0) {
            *count -= 1;
        } else {
            canonical.push(event);
        }
    }
    canonical.sort_by_key(|(index, _)| *index);
    // 真实用户提问优先；只有整段会话都是 /goal 注入时才退回用目标当标题。
    result.messages = canonical
        .into_iter()
        .enumerate()
        .map(|(seq, (_, mut message))| {
            if result.title.is_none() && message.role == "user" {
                if let Some(title) = title_candidate(&message.text) {
                    result.title = Some(title);
                } else if goal_title.is_none() {
                    goal_title = goal_candidate(&message.text);
                }
            }
            message.seq = seq as i64;
            message
        })
        .collect();
    if result.title.is_none() {
        result.title = goal_title;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn jsonl(records: Vec<Value>) -> String {
        records
            .into_iter()
            .map(|record| record.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn parses_metadata_deduplicates_replay_events_and_skips_injected_title() {
        let content = jsonl(vec![
            json!({"type":"session_meta","payload":{"id":"real-id","cwd":"D:\\项目"},"timestamp":"2026-10-18T00:00:00Z"}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for repo\n说明"}]}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"修复中文搜索"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"修复中文搜索"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"已修复"}]}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"已修复"}}),
            json!({"type":"turn_context","payload":{"model":"gpt-5-codex"}}),
            json!({"type":"response_item","payload":{"type":"reasoning","encrypted_content":"secret"}}),
        ]);
        let result = parse(&(content + "\n{broken\n"));
        assert_eq!(result.session_id.as_deref(), Some("real-id"));
        assert_eq!(result.project_dir, "D:\\项目");
        assert_eq!(result.title.as_deref(), Some("修复中文搜索"));
        assert_eq!(result.model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[0].text, "修复中文搜索");
        assert_eq!(result.messages[1].seq, 1);
        assert!(result.messages.iter().all(|message| !message.text.contains("AGENTS.md")));
        assert_eq!(result.started_at, Some(1792281600000));
    }

    #[test]
    fn hides_chunked_agents_and_environment_context_but_keeps_user_text() {
        // Codex 0.168 的真实格式：AGENTS.md 与环境上下文同在一个 user 消息里，
        // content_item_kinds 按 block 标注，普通输入是 user.text。
        let result = parse(&jsonl(vec![
            json!({"type":"response_item","payload":{
                "type":"message","role":"user",
                "content":[
                    {"type":"input_text","text":"# AGENTS.md instructions for repo\n\n<INSTRUCTIONS>\n# AGENTS.md\n全量说明"},
                    {"type":"input_text","text":"<environment_context>\n<cwd>/work</cwd>\n</environment_context>"}
                ],
                "internal_chat_message_metadata_passthrough":{
                    "content_item_kinds":["agents_md.instructions","environments.environment_context"]
                }
            }}),
            json!({"type":"response_item","payload":{
                "type":"message","role":"user",
                "content":[{"type":"input_text","text":"你好"}],
                "internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text"]}
            }}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好！"}]}}),
        ]));
        assert_eq!(result.title.as_deref(), Some("你好"));
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[0].role, "user");
        assert_eq!(result.messages[0].text, "你好");
        assert_eq!(result.messages[0].seq, 0);
        assert!(result.messages.iter().all(|message| !message.text.contains("AGENTS.md")));
    }

    #[test]
    fn keeps_only_user_blocks_from_mixed_metadata_message() {
        let result = parse(&jsonl(vec![json!({"type":"response_item","payload":{
            "type":"message","role":"user",
            "content":[
                {"type":"input_text","text":"用户粘贴的提问"},
                {"type":"input_text","text":"<environment_context>内部环境</environment_context>"}
            ],
            "internal_chat_message_metadata_passthrough":{
                "content_item_kinds":["user.text","environments.environment_context"]
            }
        }})]));
        assert_eq!(result.messages.len(), 1);
        assert_eq!(result.messages[0].text, "用户粘贴的提问");
        assert_eq!(result.title.as_deref(), Some("用户粘贴的提问"));
    }

    #[test]
    fn hides_legacy_injected_context_without_metadata() {
        let result = parse(&jsonl(vec![
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for repo\n旧格式"}]}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"# Environment\n旧环境"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"真实提问"}}),
        ]));
        assert_eq!(result.messages.len(), 1);
        assert_eq!(result.messages[0].text, "真实提问");
        assert_eq!(result.title.as_deref(), Some("真实提问"));
    }

    #[test]
    fn derives_title_from_goal_internal_context() {
        let goal_message = |source: &str, body: &str| {
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":format!("<codex_internal_context source=\"{source}\">\n{body}\n</codex_internal_context>")}]}})
        };
        let result = parse(&jsonl(vec![
            goal_message(
                "user_goal",
                "User set the goal: \"全仓库代码BUG检查和修复。\"\nUser set goal status: \"active\".",
            ),
            goal_message(
                "goal",
                "Continue working toward the active thread goal.\n\n<objective>\n全仓库代码BUG检查和修复。\n</objective>",
            ),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"开始检查"}]}}),
        ]));
        assert_eq!(result.title.as_deref(), Some("全仓库代码BUG检查和修复。"));
    }

    #[test]
    fn prefers_real_user_prompt_over_goal_context() {
        let result = parse(&jsonl(vec![
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<codex_internal_context source=\"user_goal\">\nUser set the goal: \"修复登录失败\"\n</codex_internal_context>"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我加上重试"}]}}),
        ]));
        assert_eq!(result.title.as_deref(), Some("帮我加上重试"));
    }

    #[test]
    fn retains_legacy_events_and_repeated_real_turns() {
        let result = parse(&jsonl(vec![
            json!({"type":"event_msg","payload":{"type":"user_message","message":"继续"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":"继续"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"继续"}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"旧版回复"}}),
        ]));
        assert_eq!(result.messages.len(), 3);
        assert_eq!(result.messages[1].text, "继续");
        assert_eq!(result.messages[2].role, "assistant");
    }

    #[test]
    fn cumulative_usage_is_not_summed_or_double_counted() {
        let mut rows = vec![];
        for (input, output) in [(100, 10), (100, 10), (50, 5), (300, 25)] {
            rows.push(json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":input,"cached_input_tokens":50,"output_tokens":output},"last_token_usage":{"input_tokens":input,"output_tokens":output}}}}));
            rows.push(json!({"type":"token_usage_record","payload":{"usage":{"input_tokens":input,"output_tokens":output}}}));
        }
        let result = parse(&jsonl(rows));
        assert_eq!((result.input_tokens, result.output_tokens), (300, 25));
        assert!(result.messages.is_empty());
    }

    #[test]
    fn links_tools_and_preserves_unicode() {
        let result = parse(&jsonl(vec![
            json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"c1","arguments":"{\"cmd\":\"查看文件\"}"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"中".repeat(5000)}}),
        ]));
        assert_eq!(result.messages[0].tools[0].summary, "查看文件");
        assert_eq!(
            result.messages[1].tool_name.as_deref(),
            Some("exec_command")
        );
        assert_eq!(result.messages[1].text.chars().count(), 4097);
        assert_eq!(result.messages[1].role, "tool");
    }
}
