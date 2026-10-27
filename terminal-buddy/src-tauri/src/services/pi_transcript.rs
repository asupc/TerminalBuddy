//! Pi Agent 会话 JSONL 解析（v1/v2/v3）。
//!
//! Pi 的会话是树形结构：首行是 `session` 头，其余每行是一个带 `id/parentId` 的
//! entry。回放只展示活动分支（从最后一个 entry 沿 parentId 回溯），搜索与索引也只
//! 使用活动分支，避免把废弃分支混进对话。解析器只读文件，任何损坏行都跳过。

use crate::models::session_history::{SessionReplayMessage, SessionReplayTool};
use serde_json::Value;
use std::collections::HashMap;

/// 单条消息正文上限，防止图片/base64/超长工具输出撑爆 SQLite。
pub(super) const MAX_CONTENT_CHARS: usize = 64 * 1024;
const MAX_TOOL_SUMMARY_CHARS: usize = 160;

#[derive(Default)]
pub(super) struct PiTranscript {
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

#[derive(Clone)]
struct Entry {
    id: Option<String>,
    parent_id: Option<String>,
    kind: String,
    timestamp: Option<i64>,
    value: Value,
}

fn timestamp(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        // 兼容秒级时间戳；毫秒值远大于 10^12。
        return Some(if number < 10_000_000_000 { number * 1000 } else { number });
    }
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

fn truncate_content(text: String) -> String {
    if text.chars().count() <= MAX_CONTENT_CHARS {
        text
    } else {
        let mut result: String = text.chars().take(MAX_CONTENT_CHARS).collect();
        result.push_str("\n…（内容过长已截断）");
        result
    }
}

fn block_text(block: &Value) -> Option<String> {
    match block.get("type").and_then(Value::as_str).unwrap_or("") {
        "text" | "input_text" | "output_text" => block.get("text").and_then(Value::as_str).map(str::to_string),
        "thinking" | "reasoning" => block
            .get("thinking")
            .or_else(|| block.get("text"))
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(|text| format!("[思考] {text}")),
        "image" | "input_image" => Some("[图片]".to_string()),
        _ => None,
    }
}

fn content_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if let Some(blocks) = value.as_array() {
        return blocks
            .iter()
            .filter_map(block_text)
            .collect::<Vec<_>>()
            .join("\n");
    }
    String::new()
}

fn tool_summary(input: &Value) -> String {
    let value = input
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| input.clone());
    let text = ["command", "cmd", "file_path", "path", "query", "pattern", "input"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_else(|| value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string()));
    excerpt(text.trim(), MAX_TOOL_SUMMARY_CHARS)
}

fn usage_pair(message: &Value) -> (i64, i64) {
    let Some(usage) = message.get("usage").filter(|value| value.is_object()) else { return (0, 0); };
    let read = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| usage.get(*key).and_then(Value::as_i64))
            .unwrap_or(0)
            .max(0)
    };
    (
        read(&["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]),
        read(&["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]),
    )
}

fn model_of(message: &Value) -> Option<String> {
    message
        .get("model")
        .or_else(|| message.get("modelId"))
        .or_else(|| message.get("model_id"))
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .map(str::to_string)
}

fn title_candidate(text: &str) -> Option<String> {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact = compact.trim();
    if compact.is_empty() {
        return None;
    }
    // Pi 也会把上下文文件与环境说明作为 user 消息写入；不拿它们当标题。
    if ["# AGENTS.md", "<environment_context>", "<INSTRUCTIONS>", "# CLAUDE.md"]
        .iter()
        .any(|prefix| compact.starts_with(prefix))
    {
        return None;
    }
    Some(excerpt(compact, 80))
}

fn message_from_entry(entry: &Entry) -> Option<SessionReplayMessage> {
    let message = entry.value.get("message")?;
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    let mut result = SessionReplayMessage {
        seq: 0,
        role: role.to_string(),
        timestamp: entry.timestamp,
        text: String::new(),
        tools: Vec::new(),
        tool_name: None,
    };
    match role {
        "user" => {
            result.text = truncate_content(content_text(&message["content"]));
        }
        "assistant" => {
            let content = &message["content"];
            result.text = truncate_content(content_text(content));
            if let Some(blocks) = content.as_array() {
                for block in blocks {
                    let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
                    if kind == "toolCall" || kind == "tool_call" || kind == "tool_use" {
                        let name = block
                            .get("name")
                            .or_else(|| block.get("toolName"))
                            .and_then(Value::as_str)
                            .unwrap_or("工具")
                            .to_string();
                        let input = block
                            .get("arguments")
                            .or_else(|| block.get("input"))
                            .unwrap_or(&Value::Null);
                        result.tools.push(SessionReplayTool { name, summary: tool_summary(input) });
                    }
                }
            }
        }
        "toolResult" | "tool_result" | "tool" => {
            result.role = "tool".to_string();
            result.text = truncate_content(content_text(&message["content"]));
            if result.text.is_empty() && !message["content"].is_null() {
                result.text = excerpt(&message["content"].to_string(), MAX_CONTENT_CHARS);
            }
            result.tool_name = message
                .get("toolName")
                .or_else(|| message.get("tool_name"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        "bashExecution" | "bash_execution" => {
            result.role = "tool".to_string();
            result.text = message
                .get("output")
                .and_then(Value::as_str)
                .map(|text| truncate_content(text.to_string()))
                .unwrap_or_default();
            if message.get("cancelled").and_then(Value::as_bool) == Some(true) {
                result.text.push_str("\n（命令已取消）");
            } else if let Some(code) = message.get("exitCode").and_then(Value::as_i64).filter(|code| *code != 0) {
                result.text.push_str(&format!("\n（退出码 {code}）"));
            }
            let command = message.get("command").and_then(Value::as_str).unwrap_or("");
            if !command.trim().is_empty() {
                result.tools.push(SessionReplayTool {
                    name: "bash".to_string(),
                    summary: excerpt(command.trim(), MAX_TOOL_SUMMARY_CHARS),
                });
            }
            result.tool_name = Some("bash".to_string());
        }
        // 系统提示包含完整工具声明，历史索引跳过。
        _ => return None,
    }
    if result.text.trim().is_empty() && result.tools.is_empty() {
        return None;
    }
    Some(result)
}

fn summary_from_entry(entry: &Entry) -> Option<SessionReplayMessage> {
    let value = &entry.value;
    let text = ["summary", "text", "message", "content"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| value.get("content").map(content_text))
        .filter(|text| !text.trim().is_empty())?;
    let label = match entry.kind.as_str() {
        "compaction" => "压缩摘要",
        "branch_summary" => "分支摘要",
        _ => "系统摘要",
    };
    Some(SessionReplayMessage {
        seq: 0,
        role: "system".to_string(),
        timestamp: entry.timestamp,
        text: truncate_content(format!("[{label}] {text}")),
        tools: Vec::new(),
        tool_name: None,
    })
}

/// 活动分支：文件中最后一个非头 entry 作为叶节点，沿 parentId 回溯。
/// v1 没有 parentId 时退化为文件顺序。
fn active_branch(entries: &[Entry]) -> Vec<&Entry> {
    let by_id: HashMap<&str, usize> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| entry.id.as_deref().map(|id| (id, index)))
        .collect();
    let Some(leaf_index) = entries.iter().rposition(|entry| entry.id.is_some()) else {
        return entries.iter().collect();
    };
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut current = Some(leaf_index);
    while let Some(index) = current {
        let entry = &entries[index];
        if !seen.insert(index) {
            break;
        }
        chain.push(entry);
        current = entry
            .parent_id
            .as_deref()
            .and_then(|parent| by_id.get(parent).copied())
            .filter(|parent| *parent != index);
    }
    if chain.len() <= 1 && entries.len() > 1 {
        // 树信息缺失或损坏：线性回退，至少不要丢掉整个文件。
        return entries.iter().collect();
    }
    chain.reverse();
    chain
}

pub(super) fn parse(content: &str) -> PiTranscript {
    let mut result = PiTranscript::default();
    let mut header: Option<Value> = None;
    let mut entries = Vec::new();
    let mut usage_totals: Option<(i64, i64)> = None;
    let mut session_name: Option<String> = None;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            // 损坏行（例如写入过程中被截断）只跳过，不影响整个会话。
            continue;
        };
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        if kind == "session" || kind == "header" {
            header = Some(value);
            continue;
        }
        let entry = Entry {
            id: value.get("id").and_then(Value::as_str).filter(|id| !id.trim().is_empty()).map(str::to_string),
            parent_id: value
                .get("parentId")
                .or_else(|| value.get("parent_id"))
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::to_string),
            kind: kind.clone(),
            timestamp: value.get("timestamp").and_then(timestamp),
            value,
        };
        if entry.kind == "session_info" {
            if let Some(name) = entry.value.get("name").and_then(Value::as_str) {
                if !name.trim().is_empty() {
                    session_name = Some(name.trim().to_string());
                }
            }
        }
        if entry.kind == "usage" {
            let usage = entry.value.get("usage").unwrap_or(&entry.value);
            let read = |keys: &[&str]| {
                keys.iter()
                    .find_map(|key| usage.get(*key).and_then(Value::as_i64))
                    .unwrap_or(0)
                    .max(0)
            };
            usage_totals = Some((
                read(&["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]),
                read(&["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]),
            ));
        }
        if let Some(time) = entry.timestamp {
            result.started_at = Some(result.started_at.map_or(time, |old| old.min(time)));
            result.updated_at = Some(result.updated_at.map_or(time, |old| old.max(time)));
        }
        entries.push(entry);
    }
    if let Some(header) = header {
        result.session_id = header.get("id").and_then(Value::as_str).map(str::to_string);
        result.project_dir = header.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Some(time) = header.get("timestamp").and_then(timestamp) {
            result.started_at = Some(result.started_at.map_or(time, |old| old.min(time)));
            result.updated_at = Some(result.updated_at.map_or(time, |old| old.max(time)));
        }
    }
    let branch = active_branch(&entries);
    let mut messages = Vec::new();
    let mut usage_sum = (0_i64, 0_i64);
    let mut has_assistant_usage = false;
    for entry in branch {
        match entry.kind.as_str() {
            "message" => {
                if let Some(message) = message_from_entry(entry) {
                    if message.role == "assistant" {
                        if let Some(model) = model_of(&entry.value["message"]) {
                            result.model = Some(model);
                        }
                        let (input, output) = usage_pair(&entry.value["message"]);
                        if input > 0 || output > 0 {
                            has_assistant_usage = true;
                            usage_sum.0 += input;
                            usage_sum.1 += output;
                        }
                    }
                    if result.title.is_none() && message.role == "user" {
                        result.title = title_candidate(&message.text);
                    }
                    messages.push(message);
                }
            }
            "bash_execution" | "bashExecution" => {
                let command = entry.value.get("command").and_then(Value::as_str).unwrap_or("");
                let output = entry
                    .value
                    .get("output")
                    .or_else(|| entry.value.get("result"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let mut text = String::new();
                if !output.trim().is_empty() {
                    text = truncate_content(output.to_string());
                }
                messages.push(SessionReplayMessage {
                    seq: 0,
                    role: "tool".to_string(),
                    timestamp: entry.timestamp,
                    text,
                    tools: if command.trim().is_empty() {
                        Vec::new()
                    } else {
                        vec![SessionReplayTool { name: "bash".to_string(), summary: excerpt(command.trim(), MAX_TOOL_SUMMARY_CHARS) }]
                    },
                    tool_name: Some("bash".to_string()),
                });
            }
            "compaction" | "branch_summary" => {
                if let Some(message) = summary_from_entry(entry) {
                    messages.push(message);
                }
            }
            "model_change" => {
                if let Some(model) = model_of(&entry.value) {
                    result.model = Some(model);
                }
            }
            _ => {}
        }
    }
    if !has_assistant_usage {
        if let Some((input, output)) = usage_totals {
            usage_sum = (input, output);
        }
    }
    result.input_tokens = usage_sum.0;
    result.output_tokens = usage_sum.1;
    if let Some(name) = session_name {
        result.title = Some(name);
    }
    for (index, message) in messages.iter_mut().enumerate() {
        message.seq = index as i64;
    }
    result.messages = messages;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn jsonl(rows: Vec<Value>) -> String {
        rows.into_iter().map(|row| row.to_string()).collect::<Vec<_>>().join("\n")
    }

    fn header(version: u32) -> Value {
        json!({"type":"session","version":version,"id":"01900000-0000-7000-8000-000000000001","timestamp":"2026-10-20T10:00:00Z","cwd":"/workspace/demo"})
    }

    #[test]
    fn parses_active_branch_and_ignores_abandoned_branch() {
        let content = jsonl(vec![
            header(3),
            json!({"type":"message","id":"a","parentId":null,"timestamp":"2026-10-20T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"实现 Pi 历史"}]}}),
            json!({"type":"message","id":"b","parentId":"a","timestamp":"2026-10-20T10:00:02Z","message":{"role":"assistant","model":"anthropic/claude-sonnet","content":[{"type":"text","text":"旧分支回答"}],"usage":{"input":10,"output":5}}}),
            json!({"type":"message","id":"c","parentId":"a","timestamp":"2026-10-20T10:00:03Z","message":{"role":"assistant","model":"openai/gpt-5","content":[{"type":"text","text":"活动分支回答"}],"usage":{"input":20,"output":8},"stopReason":"end_turn"}}),
            json!({"type":"session_info","id":"d","parentId":"c","timestamp":"2026-10-20T10:00:04Z","name":"Pi 历史实现"}),
        ]);
        let result = parse(&(content + "\n{broken"));
        assert_eq!(result.session_id.as_deref(), Some("01900000-0000-7000-8000-000000000001"));
        assert_eq!(result.project_dir, "/workspace/demo");
        assert_eq!(result.title.as_deref(), Some("Pi 历史实现"));
        assert_eq!(result.model.as_deref(), Some("openai/gpt-5"));
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[1].text, "活动分支回答");
        assert_eq!((result.input_tokens, result.output_tokens), (20, 8));
    }

    #[test]
    fn fallback_to_linear_order_for_v1_and_missing_tree() {
        let content = jsonl(vec![
            header(1),
            json!({"type":"message","id":"x","timestamp":"2026-10-20T10:00:01Z","message":{"role":"user","content":"你好"}}),
            json!({"type":"message","id":"y","timestamp":"2026-10-20T10:00:02Z","message":{"role":"assistant","content":"你好，有什么可以帮你？"}}),
            json!({"type":"message","id":"z","timestamp":"2026-10-20T10:00:03Z","message":{"role":"assistant","content":"第二条回复"}}),
        ]);
        let result = parse(&content);
        assert_eq!(result.messages.len(), 3);
        assert_eq!(result.messages[1].text, "你好，有什么可以帮你？");
        assert_eq!(result.messages[2].text, "第二条回复");
        assert_eq!(result.title.as_deref(), Some("你好"));
    }

    #[test]
    fn handles_compaction_tools_images_and_usage_entries() {
        let content = jsonl(vec![
            header(3),
            json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"看图"},{"type":"image","data":"base64..."}]}}),
            json!({"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":[{"type":"thinking","thinking":"先分析"},{"type":"toolCall","name":"bash","arguments":{"command":"ls -la"}},{"type":"text","text":"执行完成"}]}}),
            json!({"type":"message","id":"c","parentId":"b","message":{"role":"toolResult","toolName":"bash","content":[{"type":"text","text":"文件列表"}]}}),
            json!({"type":"compaction","id":"d","parentId":"c","summary":"前面的对话摘要"}),
            json!({"type":"usage","id":"e","parentId":"d","usage":{"input":100,"output":20}}),
        ]);
        let result = parse(&content);
        assert_eq!(result.messages.len(), 4);
        assert_eq!(result.messages[0].text, "看图\n[图片]");
        assert!(result.messages[1].text.contains("[思考] 先分析"));
        assert_eq!(result.messages[1].tools[0].name, "bash");
        assert_eq!(result.messages[1].tools[0].summary, "ls -la");
        assert_eq!(result.messages[2].role, "tool");
        assert_eq!(result.messages[2].tool_name.as_deref(), Some("bash"));
        assert_eq!(result.messages[3].role, "system");
        assert!(result.messages[3].text.contains("压缩摘要"));
        // 助手消息没有 usage 时才回退 usage entry。
        assert_eq!((result.input_tokens, result.output_tokens), (100, 20));
    }

    #[test]
    fn system_messages_and_empty_content_are_skipped() {
        let content = jsonl(vec![
            header(3),
            json!({"type":"message","id":"a","parentId":null,"message":{"role":"system","content":"完整系统提示"}}),
            json!({"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":[{"type":"text","text":"   "}]}}),
        ]);
        let result = parse(&content);
        assert!(result.messages.is_empty());
    }
}
