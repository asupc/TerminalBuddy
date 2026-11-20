//! Antigravity CLI（`agy`）对话转录解析。
//!
//! 数据源：`~/.gemini/antigravity-cli/brain/<conversation_id>/.system_generated/logs/transcript_full.jsonl`
//!（缺失时回退同目录 `transcript.jsonl`）。每行一个 JSON 步骤对象，损坏行跳过，不因单行坏 JSON 中断整份会话。

use crate::models::session_history::{SessionReplayMessage, SessionReplayTool};
use serde_json::Value;

const TOOL_SUMMARY_LIMIT: usize = 120;
const TOOL_OUTPUT_LIMIT: usize = 4000;
const FIRST_PROMPT_LIMIT: usize = 200;

#[derive(Default)]
pub(super) struct ParsedAntigravityTranscript {
    pub first_prompt: String,
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub message_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub model: Option<String>,
    pub messages: Vec<SessionReplayMessage>,
}

pub(super) fn parse_timestamp_str(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // `conversation_summaries.db` 的 `last_modified_time` 用空格分隔日期与时间，例如
    // `2026-11-18 04:09:02.3646961+00:00`；RFC3339 解析需要 `T`。
    let normalized = if trimmed.len() > 10 && trimmed.as_bytes()[10] == b' ' {
        trimmed.replacen(' ', "T", 1)
    } else {
        trimmed.to_string()
    };
    let millis = chrono::DateTime::parse_from_rfc3339(&normalized)
        .ok()?
        .timestamp_millis();
    // 过滤 Go / SQLite 默认零值日期（如 `0001-01-01 00:00:00+00:00`）。
    (millis > 946_684_800_000).then_some(millis)
}

fn timestamp_from_value(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_str).and_then(parse_timestamp_str)
}

pub(super) fn excerpt(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let mut result: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        result.push('…');
    }
    result
}

/// 剥离 `<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>` 等包装块（未闭合时截到末尾）。
fn strip_tag_block(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut current = text.to_string();
    while let Some(start) = current.find(&open) {
        let after_open = start + open.len();
        let next = if let Some(rel_end) = current[after_open..].find(&close) {
            let end = after_open + rel_end + close.len();
            format!("{}{}", &current[..start], &current[end..])
        } else {
            current[..start].to_string()
        };
        current = next;
    }
    current
}

/// 从 `USER_INPUT.content` 提取用户实际输入，剔除 `<USER_REQUEST>` 外壳与系统注入的元数据。
pub(super) fn extract_user_request(raw: &str) -> String {
    if let Some(start) = raw.find("<USER_REQUEST>") {
        let after = start + "<USER_REQUEST>".len();
        if let Some(rel_end) = raw[after..].find("</USER_REQUEST>") {
            return raw[after..after + rel_end].trim().to_string();
        }
    }
    let mut cleaned = raw.to_string();
    for tag in [
        "ADDITIONAL_METADATA",
        "USER_SETTINGS_CHANGE",
        "SYSTEM_MESSAGE",
        "ENVIRONMENT_INFO",
    ] {
        cleaned = strip_tag_block(&cleaned, tag);
    }
    cleaned.trim().to_string()
}

fn unquote_if_json_string(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        if let Ok(unquoted) = serde_json::from_str::<String>(trimmed) {
            return unquoted;
        }
    }
    trimmed.to_string()
}

fn extract_tool_summary(args: Option<&Value>) -> String {
    let Some(args) = args else {
        return String::new();
    };
    let parsed_str = args
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let target = parsed_str.as_ref().unwrap_or(args);

    let preferred = [
        "toolSummary",
        "CommandLine",
        "command",
        "cmd",
        "Path",
        "path",
        "TargetFile",
        "file_path",
        "Query",
        "query",
        "Description",
    ];
    for key in preferred {
        if let Some(text) = target.get(key).and_then(Value::as_str) {
            let cleaned = unquote_if_json_string(text);
            let compact = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
            if !compact.is_empty() {
                return excerpt(&compact, TOOL_SUMMARY_LIMIT);
            }
        }
    }
    if let Some(map) = target.as_object() {
        for value in map.values() {
            if let Some(text) = value.as_str() {
                let cleaned = unquote_if_json_string(text);
                let compact = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
                if !compact.is_empty() {
                    return excerpt(&compact, TOOL_SUMMARY_LIMIT);
                }
            }
        }
    }
    if let Some(text) = target.as_str() {
        let cleaned = unquote_if_json_string(text);
        let compact = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
        if !compact.is_empty() {
            return excerpt(&compact, TOOL_SUMMARY_LIMIT);
        }
    }
    String::new()
}

fn extract_tools(row: &Value) -> Vec<SessionReplayTool> {
    let Some(calls) = row.get("tool_calls").and_then(Value::as_array) else {
        return Vec::new();
    };
    calls
        .iter()
        .filter_map(|call| {
            let name = call
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())?;
            let summary = extract_tool_summary(call.get("args"));
            Some(SessionReplayTool {
                name: name.to_string(),
                summary,
            })
        })
        .collect()
}

/// 转录末尾的回合状态，供定时任务判定完成：
/// - 最后一条可识别记录是「无工具调用且有文本」的 `PLANNER_RESPONSE` → `idle`（回合已结束）；
/// - 用户输入、工具结果或带工具调用的计划响应 → `running`；
/// - 没有可识别记录 → `idle`（会话尚未产生消息）。
///
/// Antigravity 没有 Hook，这是唯一可靠的完成信号：正常回合总是以一条纯文本
/// `PLANNER_RESPONSE` 收尾，工具执行期间最后一条则是 `GENERIC` / 带工具的响应。
pub(super) fn turn_phase(content: &str) -> &'static str {
    for line in content.lines().rev() {
        let Ok(row) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let row_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        let source = row.get("source").and_then(Value::as_str).unwrap_or("");
        match (row_type, source) {
            ("USER_INPUT", "USER_EXPLICIT") | ("GENERIC", "MODEL") => return "running",
            ("PLANNER_RESPONSE", "MODEL") => {
                let has_tools = row
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .is_some_and(|calls| !calls.is_empty());
                let has_text = row
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty());
                return if has_tools || !has_text { "running" } else { "idle" };
            }
            _ => continue,
        }
    }
    "idle"
}

pub(super) fn parse(content: &str) -> ParsedAntigravityTranscript {
    let mut parsed = ParsedAntigravityTranscript::default();
    let mut next_seq: i64 = 0;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let timestamp = timestamp_from_value(row.get("created_at"));
        if let Some(ts) = timestamp {
            parsed.started_at = Some(parsed.started_at.map_or(ts, |old| old.min(ts)));
            parsed.updated_at = Some(parsed.updated_at.map_or(ts, |old| old.max(ts)));
        }

        let row_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        let source = row.get("source").and_then(Value::as_str).unwrap_or("");

        match (row_type, source) {
            ("USER_INPUT", "USER_EXPLICIT") => {
                let raw = row.get("content").and_then(Value::as_str).unwrap_or("");
                let text = extract_user_request(raw);
                if text.is_empty() {
                    continue;
                }
                if parsed.first_prompt.is_empty() {
                    let single_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
                    parsed.first_prompt = excerpt(&single_line, FIRST_PROMPT_LIMIT);
                }
                parsed.messages.push(SessionReplayMessage {
                    seq: next_seq,
                    role: "user".to_string(),
                    timestamp,
                    text,
                    tools: Vec::new(),
                    tool_name: None,
                    skill_name: None,
                });
                next_seq += 1;
            }
            ("PLANNER_RESPONSE", "MODEL") => {
                if let Some(model) = row
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                {
                    parsed.model = Some(model.to_string());
                }
                parsed.input_tokens += row
                    .get("input_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(0);
                parsed.output_tokens += row
                    .get("output_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(0);

                let text = row
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string();
                let tools = extract_tools(&row);
                if text.is_empty() && tools.is_empty() {
                    continue;
                }
                parsed.messages.push(SessionReplayMessage {
                    seq: next_seq,
                    role: "assistant".to_string(),
                    timestamp,
                    text,
                    tools,
                    tool_name: None,
                    skill_name: None,
                });
                next_seq += 1;
            }
            ("GENERIC", "MODEL") => {
                let raw = row
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                if raw.is_empty() {
                    continue;
                }
                parsed.messages.push(SessionReplayMessage {
                    seq: next_seq,
                    role: "tool".to_string(),
                    timestamp,
                    text: excerpt(raw, TOOL_OUTPUT_LIMIT),
                    tools: Vec::new(),
                    tool_name: None,
                    skill_name: None,
                });
                next_seq += 1;
            }
            _ => {}
        }
    }

    parsed.message_count = parsed.messages.len() as i64;
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unwraps_user_request_and_strips_metadata_blocks() {
        let content = "<USER_REQUEST>\n帮我检查终端标签样式\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>x</USER_SETTINGS_CHANGE>";
        assert_eq!(extract_user_request(content), "帮我检查终端标签样式");

        let plain = "直接问题\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>\n<SYSTEM_MESSAGE>sys</SYSTEM_MESSAGE>";
        assert_eq!(extract_user_request(plain), "直接问题");
    }

    #[test]
    fn parses_planner_tools_tokens_generic_and_skips_noise() {
        let long_output = "a".repeat(TOOL_OUTPUT_LIMIT + 150);
        let lines = [
            json!({
                "step_index": 0,
                "source": "USER_EXPLICIT",
                "type": "USER_INPUT",
                "created_at": "2026-11-18T04:00:00Z",
                "content": "<USER_REQUEST>\n分析 Cargo.toml\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>"
            })
            .to_string(),
            json!({
                "step_index": 1,
                "source": "SYSTEM",
                "type": "CHECKPOINT",
                "created_at": "2026-11-18T04:00:01Z",
                "content": "checkpoint"
            })
            .to_string(),
            json!({
                "step_index": 2,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "created_at": "2026-11-18T04:00:05Z",
                "model": "gemini-3-pro-high",
                "input_tokens": 1200,
                "output_tokens": 300,
                "thinking": "internal thinking",
                "tool_calls": [
                    { "name": "read_file", "args": { "Path": "\"D:\\\\repo\\\\Cargo.toml\"" } }
                ]
            })
            .to_string(),
            json!({
                "step_index": 3,
                "source": "MODEL",
                "type": "GENERIC",
                "created_at": "2026-11-18T04:00:06Z",
                "content": long_output
            })
            .to_string(),
            json!({
                "step_index": 4,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "created_at": "2026-11-18T04:00:10Z",
                "model": "gemini-3-pro-high",
                "input_tokens": 800,
                "output_tokens": 150,
                "content": "已完成分析。"
            })
            .to_string(),
            "{broken json".to_string(),
        ];

        let parsed = parse(&lines.join("\n"));
        assert_eq!(parsed.first_prompt, "分析 Cargo.toml");
        assert_eq!(parsed.model.as_deref(), Some("gemini-3-pro-high"));
        assert_eq!(parsed.input_tokens, 2000);
        assert_eq!(parsed.output_tokens, 450);
        assert_eq!(parsed.message_count, 4);
        assert_eq!(parsed.messages[0].role, "user");
        assert_eq!(parsed.messages[0].seq, 0);
        assert_eq!(parsed.messages[1].role, "assistant");
        assert_eq!(parsed.messages[1].tools[0].name, "read_file");
        assert_eq!(parsed.messages[1].tools[0].summary, r"D:\repo\Cargo.toml");
        assert_eq!(parsed.messages[2].role, "tool");
        assert_eq!(
            parsed.messages[2].text.chars().count(),
            TOOL_OUTPUT_LIMIT + 1
        );
        assert_eq!(parsed.messages[3].role, "assistant");
        assert_eq!(parsed.messages[3].text, "已完成分析。");
        assert_eq!(parsed.messages[3].seq, 3);
    }

    #[test]
    fn turn_phase_follows_the_last_transcript_step() {
        let user = json!({
            "step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT",
            "status": "DONE", "created_at": "2026-11-18T04:00:00Z",
            "content": "<USER_REQUEST>汇总提交</USER_REQUEST>"
        });
        let tool_result = json!({
            "step_index": 1, "source": "MODEL", "type": "GENERIC",
            "status": "DONE", "created_at": "2026-11-18T04:00:01Z", "content": "output"
        });
        let tool_plan = json!({
            "step_index": 2, "source": "MODEL", "type": "PLANNER_RESPONSE",
            "status": "DONE", "created_at": "2026-11-18T04:00:02Z",
            "content": "", "tool_calls": [{ "name": "read_file", "args": {} }]
        });
        let final_answer = json!({
            "step_index": 3, "source": "MODEL", "type": "PLANNER_RESPONSE",
            "status": "DONE", "created_at": "2026-11-18T04:00:03Z",
            "content": "已完成分析。"
        });
        let system = json!({
            "step_index": 4, "source": "SYSTEM", "type": "SYSTEM_MESSAGE",
            "status": "DONE", "created_at": "2026-11-18T04:00:04Z", "content": "done"
        });
        let join = |rows: &[&Value]| rows.iter().map(|row| row.to_string()).collect::<Vec<_>>().join("\n");

        assert_eq!(turn_phase(""), "idle");
        assert_eq!(turn_phase(&join(&[&user])), "running");
        assert_eq!(turn_phase(&join(&[&user, &tool_result])), "running");
        assert_eq!(turn_phase(&join(&[&user, &tool_plan])), "running");
        assert_eq!(turn_phase(&join(&[&user, &final_answer])), "idle");
        // 收尾后追加的系统消息不改变判定。
        assert_eq!(turn_phase(&join(&[&user, &final_answer, &system])), "idle");
    }

    #[test]
    fn parses_space_separated_timestamp_and_rejects_epoch_zero() {
        assert!(parse_timestamp_str("2026-11-18 04:09:02.3646961+00:00").is_some());
        assert_eq!(parse_timestamp_str("0001-01-01 00:00:00+00:00"), None);
    }
}
