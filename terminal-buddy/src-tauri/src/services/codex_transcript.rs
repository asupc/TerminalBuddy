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

fn title_candidate(text: &str) -> Option<String> {
    let trimmed = text.trim();
    // Codex 把项目说明与运行环境写成 user 消息，不能拿它们充当用户的问题。
    if trimmed.is_empty()
        || [
            "# AGENTS.md instructions",
            "<environment_context>",
            "<INSTRUCTIONS>",
            "<permissions instructions>",
        ]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
    {
        return None;
    }
    Some(excerpt(
        &trimmed.split_whitespace().collect::<Vec<_>>().join(" "),
        80,
    ))
}

pub(super) fn parse(content: &str) -> CodexTranscript {
    let mut result = CodexTranscript::default();
    let mut canonical = Vec::<(usize, SessionReplayMessage)>::new();
    let mut events = Vec::<(usize, SessionReplayMessage)>::new();
    let mut tool_names = HashMap::<String, String>::new();
    let mut last_usage = (0_i64, 0_i64);
    let mut has_totals = false;
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
        };
        if kind == "response_item" || kind == "message" {
            match payload_kind {
                "message" => {
                    let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
                    if !matches!(role, "user" | "assistant" | "tool") {
                        continue;
                    }
                    message.role = role.to_string();
                    message.text = text_content(&payload["content"]);
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
                events.push((line_index, message));
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
    result.messages = canonical
        .into_iter()
        .enumerate()
        .map(|(seq, (_, mut message))| {
            if result.title.is_none() && message.role == "user" {
                result.title = title_candidate(&message.text);
            }
            message.seq = seq as i64;
            message
        })
        .collect();
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
        assert_eq!(result.messages.len(), 3);
        assert_eq!(result.messages[2].seq, 2);
        assert_eq!(result.started_at, Some(1792281600000));
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
