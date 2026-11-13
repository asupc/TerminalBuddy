//! Claude Code 历史会话索引与检索。
//!
//! 数据源：`~/.claude/projects/<路径编码>/*.jsonl`（Claude Code 官方 transcript）。
//! 索引存 SQLite（claude_sessions / claude_session_meta / claude_messages_fts），
//! 回放与导出直接读 JSONL 文件本身。解析逻辑全部为纯函数并带单测：
//! JSONL 是 Claude Code 内部格式，坏行必须跳过而不是报错。

use crate::services::claude_config_service::normalized_dir_expr;
use crate::services::{DatabaseService, PathService};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;
use crate::runtime::{AppHandle, Emitter};

/// tool_result 索引截断长度（防日志类结果爆炸）
const TOOL_RESULT_INDEX_LIMIT: usize = 4 * 1024;
/// 回放页 tool_result 展示截断长度
const TOOL_RESULT_DISPLAY_LIMIT: usize = 4 * 1024;
/// 工具入参摘要截断长度
const TOOL_INPUT_SUMMARY_LIMIT: usize = 160;
/// 标题兜底截断长度
const TITLE_FALLBACK_LIMIT: usize = 80;
/// 搜索结果上限
const SEARCH_LIMIT: i64 = 100;
/// 单批索引的文件数上限。首屏只索引最近一批，其余后台分批补齐——全量 transcript
/// 可达数百 MB，一批一事务既能压住单次耗时，也避免逐行 autocommit。
const INDEX_BATCH_FILES: usize = 60;
/// 后台补齐每完成一批就广播，前端据此刷新列表。
const INDEXED_EVENT: &str = "claude-history-indexed";
/// 解析规则版本。改动标题/消息的解析口径就 +1：索引里存量行是旧规则算出来的，
/// 而文件 mtime+size 没变就不会被增量判断捞出来，必须整体作废重建一次才生效。
const ANALYZER_VERSION: i64 = 3;

// ---------------------------------------------------------------------------
// 对外数据结构
// ---------------------------------------------------------------------------

pub use crate::models::session_history::{
    SessionHistoryItem as ClaudeSessionItem,
    SessionSearchHit as ClaudeSearchHit,
    SessionReplayTool as ClaudeReplayTool,
    SessionReplayMessage as ClaudeReplayMessage,
    SessionReplayPage as ClaudeReplayPage,
    SessionHistoryScanResult as ClaudeHistoryScanResult,
};

// ---------------------------------------------------------------------------
// 纯解析逻辑（可测）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct IndexMessage {
    pub seq: i64,
    pub role: String,
    pub content: String,
    pub timestamp: Option<i64>,
}

#[derive(Debug, Default, PartialEq)]
pub struct TranscriptAnalysis {
    pub project_dir: String,
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub message_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub model: Option<String>,
    pub messages: Vec<IndexMessage>,
}

fn parse_timestamp(value: &Value) -> Option<i64> {
    let raw = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|time| time.timestamp_millis())
}

/// 提取 content 中的纯文本（字符串 content 或 text 块拼接）
fn extract_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(blocks) = content.as_array() {
        let parts: Vec<&str> = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect();
        return parts.join("\n");
    }
    String::new()
}

/// 提取 tool_result 内容（string 或 [{type:"text",...}] 块），拼接后截断
fn extract_tool_results(content: &Value) -> String {
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let body = block.get("content").map(extract_text).unwrap_or_default();
        let errored = block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let text = if errored {
            format!("[错误] {}", body)
        } else {
            body
        };
        if !text.trim().is_empty() {
            parts.push(text);
        }
    }
    truncate_unicode(&parts.join("\n"), TOOL_RESULT_INDEX_LIMIT)
}

fn has_tool_result(content: &Value) -> bool {
    content.as_array().is_some_and(|blocks| {
        blocks
            .iter()
            .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
    })
}

/// 工具入参摘要：优先文件路径/命令等关键字段，否则紧凑 JSON 截断
fn compact_tool_input(input: &Value) -> String {
    for key in ["file_path", "path", "notebook_path", "command", "pattern", "query", "url"] {
        if let Some(text) = input.get(key).and_then(Value::as_str) {
            return truncate_unicode(text.trim(), TOOL_INPUT_SUMMARY_LIMIT);
        }
    }
    serde_json::to_string(input)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(TOOL_INPUT_SUMMARY_LIMIT)
        .collect()
}

fn tool_uses(message: &Value) -> Vec<(String, String, String)> {
    let mut result = Vec::new();
    let Some(blocks) = message.get("content").and_then(Value::as_array) else {
        return result;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let id = block
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let summary = block
            .get("input")
            .map(compact_tool_input)
            .unwrap_or_default();
        result.push((id, name, summary));
    }
    result
}

fn truncate_unicode(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut result: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    result.push('…');
    result
}

// ---------------------------------------------------------------------------
// Skill 展开识别（与实时链路 `ai_chat_service::expanded_skill` 同一口径）
// ---------------------------------------------------------------------------

/// Skill 展开正文的首行前缀：`Base directory for this skill: <技能目录>`。
const SKILL_EXPANSION_PREFIX: &str = "Base directory for this skill:";

/// `parent_tool_use_id` 的 Skill 前缀：CLI 把斜杠命令展开成串并写入转录时带这个标记。
const SKILL_PARENT_PREFIX: &str = "forked-command-";

/// 从命令展开文本里取 `<command-name>`：`/git-commit-helper` → `git-commit-helper`。
fn command_name(text: &str) -> Option<String> {
    let name = tagged_text(text, "command-name")?;
    let name = name.trim_start_matches('/');
    (!name.is_empty()).then(|| name.to_string())
}

/// 本次 Skill 调用的名称：优先取同一回合里前一条斜杠命令，缺失时用技能目录名兜底。
fn skill_name_before(lines: &[&str], line_index: usize, body: &str) -> String {
    // 只回看最近若干行：命令与展开紧邻，过远的 `<command-name>` 属于更早的回合。
    let start = line_index.saturating_sub(SKILL_LOOKBACK_LINES);
    for line in lines[start..line_index].iter().rev() {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue; };
        if value.get("type").and_then(Value::as_str) != Some("user") { continue; }
        if let Some(name) = command_name(&extract_text(&value.get("message").and_then(|m| m.get("content")).unwrap_or(&Value::Null))) {
            return name;
        }
    }
    skill_directory_name(body).unwrap_or_else(|| "skill".to_string())
}

/// 从展开正文首行取技能目录名（`Base directory for this skill: .../skills/git-commit-helper`）。
fn skill_directory_name(body: &str) -> Option<String> {
    let first = body.lines().next()?.trim();
    let path = first.strip_prefix(SKILL_EXPANSION_PREFIX)?.trim();
    let name = path.rsplit(['/', '\\']).next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// 判断一条 user 事件是否为 Skill 展开，是则返回（技能名、展开正文）。
///
/// 判定顺序与实时链路一致：`parent_tool_use_id` 的 `forked-command-` 前缀最可靠；
/// 转录里更常见的是 `isMeta: true` 且正文以「Base directory for this skill:」开头的
/// 注入消息。两者都不满足时不做猜测——普通提问的正文里也可能出现同样的句子。
fn skill_expansion(value: &Value, text: &str) -> Option<(String, String)> {
    let flagged = value.get("parent_tool_use_id").and_then(Value::as_str)
        .and_then(|parent| parent.strip_prefix(SKILL_PARENT_PREFIX).map(str::to_string));
    if flagged.is_none() && value.get("isMeta").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    if !text.trim_start().starts_with(SKILL_EXPANSION_PREFIX) {
        return None;
    }
    Some((flagged.unwrap_or_default(), text.trim().to_string()))
}

/// 回看斜杠命令的行数上限。
const SKILL_LOOKBACK_LINES: usize = 20;

/// 一行 transcript 是否属于回放要忽略的注入消息：`isMeta: true` 的 user 消息是 CLI
/// 写给模型的提示（Skill 展开、Stop hook 条件、系统提醒等），不是用户发出的内容。
/// Skill 展开由 `skill_expansion` 另行处理成可展开条目，其余注入内容整条丢弃——
/// 否则恢复历史会话时它们会被当成用户提问显示出来。
fn is_injected_user(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("user")
        && value.get("isMeta").and_then(Value::as_bool) == Some(true)
}

/// 解析整份 transcript 文本，产出索引摘要与消息列表。
/// 无法解析的行直接跳过（内部格式会演化）。
pub fn analyze_transcript(content: &str) -> TranscriptAnalysis {
    let mut analysis = TranscriptAnalysis::default();
    let mut summary_title: Option<String> = None;
    let mut ai_title: Option<String> = None;
    let mut renamed_title: Option<String> = None;
    let mut first_prompt_plain: Option<String> = None;
    let mut first_prompt_sidechain: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            // 官方 /resume 列表的标题来源：改名条目 > AI 摘要标题，都取文件里最后一条。
            // summary 是旧版格式，现网 transcript 已不再写，仅作兜底保留。
            Some("summary") => summary_title = field_text(&value, "summary").or(summary_title),
            Some("ai-title") => ai_title = field_text(&value, "aiTitle").or(ai_title),
            Some("custom-title") => {
                renamed_title = field_text(&value, "customTitle").or(renamed_title);
            }
            Some(kind @ ("user" | "assistant")) => {
                let Some(message) = value.get("message") else {
                    continue;
                };
                if analysis.project_dir.is_empty() {
                    if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
                        analysis.project_dir = cwd.to_string();
                    }
                }
                let timestamp = value.get("timestamp").and_then(parse_timestamp);
                if let Some(ts) = timestamp {
                    analysis.started_at = Some(analysis.started_at.map_or(ts, |start| start.min(ts)));
                    analysis.updated_at = Some(analysis.updated_at.map_or(ts, |end| end.max(ts)));
                }
                let is_sidechain = value
                    .get("isSidechain")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let seq = analysis.message_count;
                analysis.message_count += 1;

                let content = message.get("content").unwrap_or(&Value::Null);
                if kind == "user" {
                    if has_tool_result(content) {
                        let text = extract_tool_results(content);
                        if !text.trim().is_empty() {
                            analysis.messages.push(IndexMessage {
                                seq,
                                role: "tool".to_string(),
                                content: text,
                                timestamp,
                            });
                        }
                    } else if is_injected_user(&value) {
                        // isMeta 注入消息（Skill 展开、hook 提示等）不是用户的提问：
                        // 既不进索引正文，也不参与首条提问标题的推导。
                    } else {
                        let text = extract_text(content);
                        if !text.trim().is_empty() {
                            if is_sidechain {
                                if first_prompt_sidechain.is_none() {
                                    first_prompt_sidechain = Some(text.clone());
                                }
                            } else if first_prompt_plain.is_none() {
                                first_prompt_plain = Some(text.clone());
                            }
                            analysis.messages.push(IndexMessage {
                                seq,
                                role: "user".to_string(),
                                content: text,
                                timestamp,
                            });
                        }
                    }
                } else {
                    if let Some(model) = message.get("model").and_then(Value::as_str) {
                        if !model.is_empty() {
                            analysis.model = Some(model.to_string());
                        }
                    }
                    if let Some(usage) = message.get("usage") {
                        analysis.input_tokens += usage
                            .get("input_tokens")
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        analysis.output_tokens += usage
                            .get("output_tokens")
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                    }
                    let mut text = extract_text(content);
                    for (_id, name, summary) in tool_uses(message) {
                        text.push_str(&format!("\n[tool] {} {}", name, summary));
                    }
                    let text = text.trim().to_string();
                    if !text.is_empty() {
                        analysis.messages.push(IndexMessage {
                            seq,
                            role: "assistant".to_string(),
                            content: text,
                            timestamp,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    analysis.title = renamed_title.or(ai_title).or(summary_title);
    analysis.first_prompt = first_prompt_plain.or(first_prompt_sidechain);
    analysis
}

/// 取条目上的单个标题字段，空白视为无值。
fn field_text(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// 回放消息（role: user / assistant / tool），seq 与索引消息保持一致
pub fn parse_replay_messages(content: &str) -> Vec<ClaudeReplayMessage> {
    // 预扫 tool_use_id → 工具名，供 tool_result 行回填
    let mut tool_names: HashMap<String, String> = HashMap::new();
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(message) = value.get("message") {
            for (id, name, _summary) in tool_uses(message) {
                if !id.is_empty() {
                    tool_names.insert(id, name);
                }
            }
        }
    }

    let mut messages = Vec::new();
    let mut seq = 0_i64;
    // 保留原始行切片：Skill 展开要回看同一回合的斜杠命令来取名。
    let lines: Vec<&str> = content.lines().map(str::trim).collect();
    for (line_index, line) in lines.iter().copied().enumerate() {
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            continue;
        };
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        let timestamp = value.get("timestamp").and_then(parse_timestamp);
        let content = message.get("content").unwrap_or(&Value::Null);
        let current = seq;
        seq += 1;

        if kind == "user" {
            // Skill 展开：标记成 skill 条目，前端渲染为可展开卡片而不是用户气泡。
            if let Some((flagged, text)) = skill_expansion(&value, &extract_text(content)) {
                let name = if flagged.is_empty() {
                    skill_name_before(&lines, line_index, &text)
                } else { flagged };
                messages.push(ClaudeReplayMessage {
                    seq: current,
                    role: "user".to_string(),
                    timestamp,
                    text,
                    tools: Vec::new(),
                    tool_name: None,
                    skill_name: Some(name),
                });
                continue;
            }
            // isMeta 注入消息（Stop hook 条件、系统提醒等）不是用户发出的内容，整条丢弃。
            if is_injected_user(&value) {
                continue;
            }
            if has_tool_result(content) {
                let Some(blocks) = content.as_array() else {
                    continue;
                };
                let mut names: Vec<String> = Vec::new();
                let mut parts: Vec<String> = Vec::new();
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
                        if let Some(name) = tool_names.get(id) {
                            if !names.contains(name) {
                                names.push(name.clone());
                            }
                        }
                    }
                    let body = block.get("content").map(extract_text).unwrap_or_default();
                    let errored = block
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let text = if errored {
                        format!("[错误] {}", body)
                    } else {
                        body
                    };
                    if !text.trim().is_empty() {
                        parts.push(text);
                    }
                }
                let text = truncate_unicode(&parts.join("\n\n"), TOOL_RESULT_DISPLAY_LIMIT);
                if text.trim().is_empty() {
                    continue;
                }
                messages.push(ClaudeReplayMessage {
                    seq: current,
                    role: "tool".to_string(),
                    timestamp,
                    text,
                    tools: Vec::new(),
                    tool_name: if names.is_empty() {
                        None
                    } else {
                        Some(names.join("、"))
                    },
                    skill_name: None,
                });
            } else {
                let text = extract_text(content);
                if text.trim().is_empty() {
                    continue;
                }
                messages.push(ClaudeReplayMessage {
                    seq: current,
                    role: "user".to_string(),
                    timestamp,
                    text,
                    tools: Vec::new(),
                    tool_name: None,
                    skill_name: None,
                });
            }
        } else {
            let text = extract_text(content);
            let tools = tool_uses(message)
                .into_iter()
                .map(|(_id, name, summary)| ClaudeReplayTool { name, summary })
                .collect::<Vec<_>>();
            if text.trim().is_empty() && tools.is_empty() {
                continue;
            }
            messages.push(ClaudeReplayMessage {
                seq: current,
                role: "assistant".to_string(),
                timestamp,
                text,
                tools,
                tool_name: None,
                skill_name: None,
            });
        }
    }
    messages
}

/// 显示标题：本应用内改名 > 官方会话标题（transcript 里的改名 / AI 摘要）>
/// 斜杠命令参数 > 首条提问 > 会话 ID
pub fn display_title(
    custom_title: Option<&str>,
    title: Option<&str>,
    first_prompt: Option<&str>,
    session_id: &str,
) -> String {
    let command = first_prompt.and_then(command_title);
    for candidate in [custom_title, title, command.as_deref(), first_prompt] {
        if let Some(text) = candidate.map(str::trim).filter(|text| !text.is_empty()) {
            return truncate_unicode(text, TITLE_FALLBACK_LIMIT);
        }
    }
    session_id.to_string()
}

/// 斜杠命令（`/name args`）在 transcript 里存成 `<command-*>` 标签块，整坨当标题没法读，
/// 取命令参数当标题；参数为空时退回命令名。
fn command_title(text: &str) -> Option<String> {
    if !text.contains("<command-message>") {
        return None;
    }
    ["command-args", "command-name"]
        .into_iter()
        .find_map(|tag| tagged_text(text, tag))
}

/// 取 `<tag>…</tag>` 之间的文本，内部换行与连续空白压成单个空格（标题是单行展示的）。
fn tagged_text(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    let value = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then_some(value)
}

/// Markdown 导出渲染
pub fn render_markdown(
    title: &str,
    project_dir: &str,
    model: Option<&str>,
    message_count: usize,
    messages: &[ClaudeReplayMessage],
) -> String {
    render_markdown_for_assistant(title, project_dir, model, message_count, messages, "Claude")
}

pub(super) fn render_markdown_for_assistant(
    title: &str,
    project_dir: &str,
    model: Option<&str>,
    message_count: usize,
    messages: &[ClaudeReplayMessage],
    assistant: &str,
) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", title));
    if !project_dir.is_empty() {
        out.push_str(&format!("- 项目: `{}`\n", project_dir));
    }
    if let Some(model) = model {
        out.push_str(&format!("- 模型: {}\n", model));
    }
    out.push_str(&format!("- 消息数: {}\n", message_count));
    out.push_str("\n---\n\n");
    for message in messages {
        let (role_label, time) = match message.role.as_str() {
            "user" => ("你", message.timestamp),
            "assistant" => (assistant, message.timestamp),
            "system" => ("系统摘要", message.timestamp),
            _ => ("工具结果", message.timestamp),
        };
        out.push_str(&format!("## {}", role_label));
        if let Some(ts) = time {
            if let Some(text) = format_timestamp(ts) {
                out.push_str(&format!(" · {}", text));
            }
        }
        if let Some(name) = &message.tool_name {
            out.push_str(&format!(" · {}", name));
        }
        out.push_str("\n\n");
        if !message.text.is_empty() {
            out.push_str(message.text.trim());
            out.push_str("\n\n");
        }
        for tool in &message.tools {
            out.push_str(&format!("- `{}` {}\n", tool.name, tool.summary));
        }
        if !message.tools.is_empty() {
            out.push('\n');
        }
    }
    out
}

fn format_timestamp(millis: i64) -> Option<String> {
    let time = chrono::DateTime::from_timestamp_millis(millis)?;
    Some(time.format("%Y-%m-%d %H:%M:%S").to_string())
}

// ---------------------------------------------------------------------------
// 数据库层
// ---------------------------------------------------------------------------

/// 建表（迁移与测试共用）。
/// 检索走 LIKE 而非 FTS5：FTS5 默认分词把中文整句当一个 token，子串搜不动；
/// trigram 分词又要求查询 ≥3 字。本地会话量级下 LIKE 全表扫足够快且中文正确。
pub fn init_claude_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS claude_sessions (
            session_id TEXT PRIMARY KEY,
            project_dir TEXT NOT NULL DEFAULT '',
            file_path TEXT NOT NULL,
            file_mtime INTEGER NOT NULL,
            file_size INTEGER NOT NULL,
            title TEXT,
            first_prompt TEXT,
            started_at INTEGER,
            updated_at INTEGER NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            model TEXT,
            indexed_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS claude_session_meta (
            session_id TEXT PRIMARY KEY,
            custom_title TEXT,
            starred INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            notes TEXT,
            -- 自动归档时的会话 updated_at：用户手动取消归档后，同一版本不再被自动归档。
            auto_archive_mark INTEGER
         );
         CREATE TABLE IF NOT EXISTS claude_messages (
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER
         );
         CREATE TABLE IF NOT EXISTS claude_index_state (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
         );

         CREATE INDEX IF NOT EXISTS idx_claude_messages_session
            ON claude_messages (session_id);",
    )
    .map_err(|error| format!("创建 Claude 历史表失败: {}", error))
}

fn upsert_session(conn: &Connection, file: &SessionFile, analysis: &TranscriptAnalysis) -> Result<(), String> {
    let title = analysis.title.clone();
    let indexed_at = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO claude_sessions
            (session_id, project_dir, file_path, file_mtime, file_size, title, first_prompt,
             started_at, updated_at, message_count, input_tokens, output_tokens, model, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(session_id) DO UPDATE SET
            project_dir = excluded.project_dir,
            file_path = excluded.file_path,
            file_mtime = excluded.file_mtime,
            file_size = excluded.file_size,
            title = excluded.title,
            first_prompt = excluded.first_prompt,
            started_at = excluded.started_at,
            updated_at = excluded.updated_at,
            message_count = excluded.message_count,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            model = excluded.model,
            indexed_at = excluded.indexed_at",
        params![
            file.session_id,
            analysis.project_dir,
            file.path.to_string_lossy().to_string(),
            file.mtime,
            file.size,
            title,
            analysis.first_prompt,
            analysis.started_at,
            analysis.updated_at.unwrap_or(file.mtime),
            analysis.message_count,
            analysis.input_tokens,
            analysis.output_tokens,
            analysis.model,
            indexed_at,
        ],
    )
    .map_err(|error| format!("写入 Claude 会话索引失败: {}", error))?;
    Ok(())
}

/// 待索引的会话文件（一次枚举，供增量判断、排序与失效清理共用）。
struct SessionFile {
    session_id: String,
    path: PathBuf,
    mtime: i64,
    size: i64,
}

/// 一次枚举的结果：会话文件 + 本次读取失败的编码目录。
/// 读取失败的目录可能是同步盘占位符/短暂锁定（审查 M-8）：其中的会话
/// 只是「暂时不可见」而非真删除，prune 必须跳过这些目录。
struct SessionFileList {
    files: Vec<SessionFile>,
    unreadable_dirs: std::collections::HashSet<PathBuf>,
    /// 根目录完全不存在（全新机器，或网络盘/符号链接断开）。无法区分二者时
    /// 一律不执行 prune：断挂载时清空索引比保留陈旧条目代价大得多。
    root_missing: bool,
}

fn collect_session_files(projects_dir: &Path) -> Result<SessionFileList, String> {
    let mut files = Vec::new();
    let mut unreadable_dirs = std::collections::HashSet::new();
    if !projects_dir.exists() {
        // 全新机器还没有 ~/.claude/projects：没有会话可索引，属正常空集。
        return Ok(SessionFileList { files, unreadable_dirs, root_missing: true });
    }
    if !projects_dir.is_dir() {
        return Err(format!("Claude 项目目录不可用: {}", projects_dir.display()));
    }
    // 根目录存在却读不动（网络盘/漫游断开）必须报错而不是返回空集：
    // 空集会让 prune 把全部会话索引连同用户标记一起清空（审查 M-8 复核补充）。
    let project_entries = fs::read_dir(projects_dir)
        .map_err(|error| format!("读取 Claude 项目目录失败: {}", error))?;
    for project_entry in project_entries.flatten() {
        let Ok(session_entries) = fs::read_dir(project_entry.path()) else {
            unreadable_dirs.insert(project_entry.path());
            continue;
        };
        for entry in session_entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(session_id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let Ok(meta) = fs::metadata(&path) else { continue };
            let Some(mtime) = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as i64)
            else {
                continue;
            };
            files.push(SessionFile {
                session_id: session_id.to_string(),
                path,
                mtime,
                size: meta.len() as i64,
            });
        }
    }
    Ok(SessionFileList { files, unreadable_dirs, root_missing: false })
}

fn is_indexed_unchanged(conn: &Connection, file: &SessionFile) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM claude_sessions
         WHERE session_id = ?1 AND file_mtime = ?2 AND file_size = ?3",
        params![file.session_id, file.mtime, file.size],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(|error| format!("查询 Claude 会话索引失败: {}", error))
}

/// 逐行 autocommit 在数百 MB 量级、且数据目录常被同步盘接管时是索引耗时的主要来源，
/// 因此一个会话一个事务。读盘与解析放在事务外，不长时间占着 SQLite 写锁。
fn index_files(conn: &Connection, files: &[&SessionFile]) -> Result<i64, String> {
    let mut updated = 0_i64;
    for file in files {
        let Ok(content) = fs::read_to_string(&file.path) else {
            continue;
        };
        let analysis = analyze_transcript(&content);
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| format!("开始 Claude 历史索引事务失败: {}", error))?;
        upsert_session(&transaction, file, &analysis)?;
        transaction
            .execute(
                "DELETE FROM claude_messages WHERE session_id = ?1",
                [file.session_id.as_str()],
            )
            .map_err(|error| format!("清理 Claude 消息索引失败: {}", error))?;
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO claude_messages (session_id, seq, role, content, timestamp)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|error| format!("写入 Claude 消息索引失败: {}", error))?;
            for message in &analysis.messages {
                statement
                    .execute(params![
                        file.session_id,
                        message.seq,
                        message.role,
                        message.content,
                        message.timestamp
                    ])
                    .map_err(|error| format!("写入 Claude 消息索引失败: {}", error))?;
            }
        }
        transaction
            .commit()
            .map_err(|error| format!("提交 Claude 历史索引事务失败: {}", error))?;
        updated += 1;
    }
    Ok(updated)
}

/// 磁盘上已不存在的会话：清掉索引（记录本身已不存在）。seen 来自完整枚举，与本批
/// 索引了多少文件无关，所以分批扫描中途执行也是安全的。
/// 只清索引行、保留 claude_session_meta（审查 M-8）：收藏/改名/归档是用户数据，
/// 「暂时不可见」的会话恢复后标记必须还在；显式删除走 delete_index_rows 连 meta 清。
fn prune_missing_sessions(
    conn: &Connection,
    seen: &HashSet<&str>,
    unreadable_dirs: &std::collections::HashSet<PathBuf>,
    root_missing: bool,
) -> Result<(), String> {
    // 根目录不存在可能是全新机器，也可能是网络盘/符号链接断开。后者若继续
    // 清理，会把全部索引删光；宁可保留陈旧索引，等挂载恢复后由增量扫描修正。
    if root_missing {
        return Ok(());
    }
    let same_dir = |a: &Path, b: &Path| {
        a.to_string_lossy().to_lowercase().replace('\\', "/").trim_end_matches('/')
            == b.to_string_lossy().to_lowercase().replace('\\', "/").trim_end_matches('/')
    };
    let stale: Vec<String> = {
        let mut statement = conn
            .prepare("SELECT session_id, file_path FROM claude_sessions")
            .map_err(|error| format!("查询 Claude 会话索引失败: {}", error))?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| format!("查询 Claude 会话索引失败: {}", error))?;
        rows.filter_map(|row| row.ok())
            .filter(|(session_id, file_path)| {
                if seen.contains(session_id.as_str()) {
                    return false;
                }
                // 会话文件所在目录本次枚举读取失败（同步盘/锁定）：
                // 只是暂时不可见，不作为已删除清理（审查 M-8）。
                if let Some(parent) = Path::new(file_path).parent() {
                    if unreadable_dirs.iter().any(|dir| same_dir(dir, parent)) {
                        return false;
                    }
                }
                true
            })
            .map(|(session_id, _)| session_id)
            .collect()
    };
    for session_id in &stale {
        delete_index_rows_keep_meta(conn, session_id)?;
    }
    Ok(())
}

/// 增量索引指定 projects 目录（测试可注入路径），每批最多 `limit` 个文件、按修改时间
/// 从近到远取。调用方反复调用直到 `pending` 归零即为全量索引完成。
pub fn scan_projects_dir(
    conn: &Connection,
    projects_dir: &Path,
    limit: usize,
) -> Result<ClaudeHistoryScanResult, String> {
    let listing = collect_session_files(projects_dir)?;
    let files = listing.files;
    let mut outdated: Vec<&SessionFile> = Vec::new();
    for file in &files {
        if !is_indexed_unchanged(conn, file)? {
            outdated.push(file);
        }
    }
    outdated.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    let batch = &outdated[..limit.min(outdated.len())];
    let updated = index_files(conn, batch)?;
    let seen: HashSet<&str> = files
        .iter()
        .map(|file| file.session_id.as_str())
        .collect();
    prune_missing_sessions(conn, &seen, &listing.unreadable_dirs, listing.root_missing)?;
    let total = conn
        .query_row("SELECT COUNT(*) FROM claude_sessions", [], |row| row.get(0))
        .map_err(|error| format!("统计 Claude 会话数失败: {}", error))?;
    Ok(ClaudeHistoryScanResult {
        scanned: files.len() as i64,
        updated,
        total,
        pending: (outdated.len() - batch.len()) as i64,
    })
}

/// 索引清理专用：只删索引行，保留用户标记（收藏/改名/归档，审查 M-8）。
fn delete_index_rows_keep_meta(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM claude_messages WHERE session_id = ?1",
        [session_id],
    )
    .map_err(|error| format!("清理 Claude 消息索引失败: {}", error))?;
    conn.execute(
        "DELETE FROM claude_sessions WHERE session_id = ?1",
        [session_id],
    )
    .map_err(|error| format!("清理 Claude 会话索引失败: {}", error))?;
    Ok(())
}

fn delete_index_rows(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM claude_messages WHERE session_id = ?1",
        [session_id],
    )
    .map_err(|error| format!("清理 Claude 消息索引失败: {}", error))?;
    conn.execute(
        "DELETE FROM claude_sessions WHERE session_id = ?1",
        [session_id],
    )
    .map_err(|error| format!("清理 Claude 会话索引失败: {}", error))?;
    conn.execute(
        "DELETE FROM claude_session_meta WHERE session_id = ?1",
        [session_id],
    )
    .map_err(|error| format!("清理 Claude 会话元数据失败: {}", error))?;
    Ok(())
}

fn projects_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home.join(".claude").join("projects"))
}

/// 解析规则升级后作废整份会话索引，下一次扫描按新规则重建。
/// 只清 claude_sessions / claude_messages：claude_session_meta 存的是用户在本应用里的
/// 改名、收藏与归档，属于用户数据，不随索引重建丢失。
fn ensure_analyzer_version(conn: &Connection) -> Result<(), String> {
    let stored: Option<i64> = conn
        .query_row(
            "SELECT value FROM claude_index_state WHERE key = 'analyzer_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取 Claude 索引版本失败: {}", error))?;
    if stored == Some(ANALYZER_VERSION) {
        return Ok(());
    }
    // 清空与版本写入放进同一事务（审查 M-10，对齐 codex 侧）：中途失败不会留下
    // 「已清空但版本未写」的中间态（该状态下搜索缺结果，直到下次检测再重建）。
    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| format!("开启 Claude 索引重建事务失败: {}", error))?;
    transaction
        .execute("DELETE FROM claude_messages", [])
        .map_err(|error| format!("清空 Claude 消息索引失败: {}", error))?;
    transaction
        .execute("DELETE FROM claude_sessions", [])
        .map_err(|error| format!("清空 Claude 会话索引失败: {}", error))?;
    transaction
        .execute(
            "INSERT INTO claude_index_state (key, value) VALUES ('analyzer_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![ANALYZER_VERSION],
        )
        .map_err(|error| format!("写入 Claude 索引版本失败: {}", error))?;
    transaction
        .commit()
        .map_err(|error| format!("提交 Claude 索引重建事务失败: {}", error))?;
    Ok(())
}

/// 面板打开时的索引入口：本批只索引最近的少量会话，剩余交给后台补齐任务。
pub fn scan_and_index(app: &AppHandle) -> Result<ClaudeHistoryScanResult, String> {
    let conn = DatabaseService::open()?;
    ensure_analyzer_version(&conn)?;
    let projects_dir = projects_root()?;
    let result = {
        let _guard = index_lock()?;
        scan_projects_dir(&conn, &projects_dir, INDEX_BATCH_FILES)?
    };
    if result.pending > 0 {
        spawn_backfill(app.clone(), conn, projects_dir);
    } else {
        // 索引已是最新：顺手执行一次自动归档，让刚打开的列表直接反映归档状态。
        crate::services::session_auto_archive_service::run_and_emit(app);
    }
    Ok(result)
}

/// 索引互斥锁（审查 M-11，对齐 codex 侧 INDEX_LOCK）：删除会话（文件移入回收 +
/// 事务清行）与索引扫描/后台补齐互斥，避免已删会话被在飞扫描重新插回索引。
static INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn index_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    INDEX_LOCK
        .lock()
        .map_err(|_| "Claude 会话索引锁不可用".to_string())
}

/// 后台分批补齐剩余会话，每批一个事务、一次广播，界面全程可用。
/// 同一时刻只跑一个补齐任务：反复开关面板不会叠加扫描。
fn spawn_backfill(app: AppHandle, conn: Connection, projects_dir: PathBuf) {
    static BACKFILLING: AtomicBool = AtomicBool::new(false);
    if BACKFILLING.swap(true, Ordering::SeqCst) {
        return;
    }
    /// 任务 panic 也要交还执行权，否则补齐永久不再启动。
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            BACKFILLING.store(false, Ordering::SeqCst);
        }
    }

    let _task = crate::runtime::async_runtime::spawn_blocking(move || {
        let _guard = Guard;
        let mut last_pending = i64::MAX;
        loop {
            let result = match (|| {
                let _guard = index_lock()?;
                scan_projects_dir(&conn, &projects_dir, INDEX_BATCH_FILES)
            })() {
                Ok(result) => result,
                Err(error) => {
                    crate::commands::terminal::log_debug(&format!("[claude-history] 补齐失败: {}", error));
                    break;
                }
            };
            let finished = result.pending == 0;
            // 整批都读不动（被占用/无权限）时不再自旋，留到下次打开面板重试
            let stalled = result.pending >= last_pending;
            // 索引补齐到尽头后再自动归档：先归档再广播，面板重取列表时已是归档后的状态。
            if finished || stalled {
                crate::services::session_auto_archive_service::run_and_emit(&app);
            }
            let _ = app.emit(INDEXED_EVENT, &result);
            if finished || stalled {
                break;
            }
            last_pending = result.pending;
        }
    });
}

pub fn list_sessions(include_archived: bool, project_dir: Option<&str>) -> Result<Vec<ClaudeSessionItem>, String> {
    let conn = DatabaseService::open()?;
    list_sessions_in(&conn, include_archived, project_dir)
}

fn list_sessions_in(
    conn: &Connection,
    include_archived: bool,
    project_dir: Option<&str>,
) -> Result<Vec<ClaudeSessionItem>, String> {
    let sql = format!(
        "SELECT s.session_id, s.project_dir, s.file_path, s.title, s.first_prompt,
                s.started_at, s.updated_at, s.message_count, s.input_tokens, s.output_tokens,
                s.model, m.custom_title,
                COALESCE(m.starred, 0), COALESCE(m.archived, 0)
         FROM claude_sessions s
         LEFT JOIN claude_session_meta m ON m.session_id = s.session_id
         WHERE (?1 = 1 OR COALESCE(m.archived, 0) = 0)
           AND (?2 IS NULL OR {indexed} = {wanted}
                OR substr({indexed}, 1, length({wanted}) + 1) = {wanted} || '/')
         ORDER BY s.updated_at DESC",
        indexed = normalized_dir_expr("s.project_dir"),
        wanted = normalized_dir_expr("?2"),
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("查询 Claude 会话列表失败: {}", error))?;
    let rows = statement
        .query_map(params![include_archived, project_dir], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, i64>(12)? != 0,
                row.get::<_, i64>(13)? != 0,
            ))
        })
        .map_err(|error| format!("读取 Claude 会话列表失败: {}", error))?;
    let mut items = Vec::new();
    for row in rows {
        let (
            session_id,
            project_dir,
            file_path,
            title,
            first_prompt,
            started_at,
            updated_at,
            message_count,
            input_tokens,
            output_tokens,
            model,
            custom_title,
            starred,
            archived,
        ) = row.map_err(|error| format!("读取 Claude 会话列表失败: {}", error))?;
        items.push(ClaudeSessionItem {
            session_id: session_id.clone(),
            project_dir,
            file_path,
            title: display_title(
                custom_title.as_deref(),
                title.as_deref(),
                first_prompt.as_deref(),
                &session_id,
            ),
            custom_title,
            started_at,
            updated_at,
            message_count,
            input_tokens,
            output_tokens,
            model,
            starred,
            archived,
        });
    }
    Ok(items)
}

pub fn search(query: &str, project_dir: Option<&str>) -> Result<Vec<ClaudeSearchHit>, String> {
    let conn = DatabaseService::open()?;
    search_in(&conn, query, project_dir)
}

/// 按内容子串检索全部会话（LIKE，见 init_claude_schema 注释）
fn search_in(
    conn: &Connection,
    query: &str,
    project_dir: Option<&str>,
) -> Result<Vec<ClaudeSearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", trimmed.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let sql = format!(
        "SELECT m.session_id, m.seq, m.timestamp, m.content,
                s.title, s.first_prompt, s.project_dir, s.updated_at, meta.custom_title
         FROM claude_messages m
         JOIN claude_sessions s ON s.session_id = m.session_id
         LEFT JOIN claude_session_meta meta ON meta.session_id = m.session_id
         WHERE m.content LIKE ?1 ESCAPE '\\'
           AND (?3 IS NULL OR {indexed} = {wanted}
                OR substr({indexed}, 1, length({wanted}) + 1) = {wanted} || '/')
         LIMIT ?2",
        indexed = normalized_dir_expr("s.project_dir"),
        wanted = normalized_dir_expr("?3"),
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("全文检索失败: {}", error))?;
    let rows = statement
        .query_map(params![pattern, SEARCH_LIMIT, project_dir], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|error| format!("全文检索失败: {}", error))?;
    let mut hits = Vec::new();
    for row in rows {
        let (session_id, seq, timestamp, content, title, first, project_dir, updated_at, custom) =
            row.map_err(|error| format!("全文检索失败: {}", error))?;
        hits.push(ClaudeSearchHit {
            title: display_title(
                custom.as_deref(),
                title.as_deref(),
                first.as_deref(),
                &session_id,
            ),
            snippet: snippet_around(&content, trimmed),
            session_id,
            seq,
            timestamp,
            project_dir,
            updated_at,
        });
    }
    Ok(hits)
}

/// LIKE 兜底的命中片段：取关键词首次出现位置前后各一段。
/// 位置一律按字符计算（审查 M-7）：`str::find` 返回 UTF-8 字节偏移，
/// 中文密集内容直接当字符数用会错位；命中靠后时 `end - start` 还会
/// usize 下溢（debug 直接 panic、release 切出全错片段）。
fn snippet_around(content: &str, keyword: &str) -> String {
    let lower = content.to_lowercase();
    let needle = keyword.to_lowercase();
    match lower.find(&needle) {
        Some(byte_index) => {
            // 字节偏移 → 字符位置
            let position = lower[..byte_index].chars().count();
            let total = content.chars().count();
            let start = position.saturating_sub(20);
            let take = needle.chars().count() + 40;
            let slice: String = content.chars().skip(start).take(take.min(total.saturating_sub(start))).collect();
            format!("…{}…", slice.trim())
        }
        None => truncate_unicode(content.trim(), 80),
    }
}

pub fn get_replay(session_id: &str, offset: usize, limit: usize) -> Result<ClaudeReplayPage, String> {
    let conn = DatabaseService::open()?;
    let row = conn
        .query_row(
            "SELECT s.file_path, s.title, s.first_prompt, s.project_dir, s.model,
                    s.input_tokens, s.output_tokens, s.started_at, s.updated_at, m.custom_title
             FROM claude_sessions s
             LEFT JOIN claude_session_meta m ON m.session_id = s.session_id
             WHERE s.session_id = ?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("查询 Claude 会话失败: {}", error))?
        .ok_or_else(|| "会话记录不存在（可能已被删除）".to_string())?;
    let (file_path, title, first_prompt, project_dir, model, input_tokens, output_tokens, started_at, updated_at, custom_title) = row;

    let content = fs::read_to_string(&file_path)
        .map_err(|error| format!("读取会话记录失败: {}", error))?;
    let all = parse_replay_messages(&content);
    let total = all.len() as i64;
    let messages = all
        .into_iter()
        .skip(offset)
        .take(limit.max(1))
        .collect::<Vec<_>>();
    Ok(ClaudeReplayPage {
        total,
        messages,
        title: display_title(
            custom_title.as_deref(),
            title.as_deref(),
            first_prompt.as_deref(),
            session_id,
        ),
        project_dir,
        model,
        input_tokens,
        output_tokens,
        started_at,
        updated_at,
    })
}

fn upsert_meta_flag(
    conn: &Connection,
    session_id: &str,
    column: &str,
    value: Option<String>,
) -> Result<(), String> {
    // 仅允许白名单列，杜绝拼接注入
    if !matches!(column, "custom_title" | "notes") {
        return Err("不支持的元数据字段".to_string());
    }
    conn.execute(
        "INSERT INTO claude_session_meta (session_id) VALUES (?1)
         ON CONFLICT(session_id) DO NOTHING",
        [session_id],
    )
    .map_err(|error| format!("创建 Claude 会话元数据失败: {}", error))?;
    let sql = format!("UPDATE claude_session_meta SET {} = ?2 WHERE session_id = ?1", column);
    conn.execute(&sql, params![session_id, value])
        .map(|_| ())
        .map_err(|error| format!("更新 Claude 会话元数据失败: {}", error))
}

pub fn rename_session(session_id: &str, title: &str) -> Result<(), String> {
    let conn = DatabaseService::open()?;
    let trimmed = title.trim();
    upsert_meta_flag(
        &conn,
        session_id,
        "custom_title",
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        },
    )
}

pub fn set_flags(session_id: &str, starred: Option<bool>, archived: Option<bool>) -> Result<(), String> {
    let conn = DatabaseService::open()?;
    conn.execute(
        "INSERT INTO claude_session_meta (session_id) VALUES (?1)
         ON CONFLICT(session_id) DO NOTHING",
        [session_id],
    )
    .map_err(|error| format!("创建 Claude 会话元数据失败: {}", error))?;
    if let Some(starred) = starred {
        conn.execute(
            "UPDATE claude_session_meta SET starred = ?2 WHERE session_id = ?1",
            params![session_id, if starred { 1 } else { 0 }],
        )
        .map_err(|error| format!("更新收藏状态失败: {}", error))?;
    }
    if let Some(archived) = archived {
        // 手动取消归档时同步记下当前版本：自动归档不会在下一轮把同一版本再次归档，
        // 只有会话再次更新、重新超过阈值后才会再次获得自动归档资格。
        conn.execute(
            "UPDATE claude_session_meta
             SET archived = ?2,
                 auto_archive_mark = CASE WHEN ?2 = 0 THEN COALESCE(
                     (SELECT updated_at FROM claude_sessions WHERE session_id = ?1),
                     auto_archive_mark)
                 ELSE auto_archive_mark END
             WHERE session_id = ?1",
            params![session_id, if archived { 1 } else { 0 }],
        )
        .map_err(|error| format!("更新归档状态失败: {}", error))?;
    }
    Ok(())
}

/// 跨盘移动失败时退化为复制 + 删除。
pub(super) fn move_to_trash(path: &Path, trash_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(trash_dir).map_err(|error| format!("创建回收目录失败: {}", error))?;
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("session");
    let timestamp = chrono::Utc::now().timestamp_millis();
    let mut suffix = 0_u32;
    let target = loop {
        let name = if suffix == 0 {
            format!("{}-{}.jsonl", stem, timestamp)
        } else {
            format!("{}-{}-{}.jsonl", stem, timestamp, suffix)
        };
        let candidate = trash_dir.join(name);
        if !candidate.exists() {
            break candidate;
        }
        suffix = suffix.saturating_add(1);
    };
    match fs::rename(path, &target) {
        Ok(()) => Ok(target),
        Err(_) => {
            fs::copy(path, &target).map_err(|error| format!("备份会话记录失败: {}", error))?;
            if let Err(error) = fs::remove_file(path) {
                let _ = fs::remove_file(&target);
                return Err(format!("移除会话记录失败: {}", error));
            }
            Ok(target)
        }
    }
}

fn restore_from_trash(trash_path: &Path, original_path: &Path) -> Result<(), String> {
    if original_path.exists() {
        return Err(format!("原路径已存在: {}", original_path.display()));
    }
    if let Some(parent) = original_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("恢复目录失败: {}", error))?;
    }
    match fs::rename(trash_path, original_path) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(trash_path, original_path).map_err(|error| format!("复制回原位置失败: {}", error))?;
            fs::remove_file(trash_path).map_err(|error| format!("清理回收文件失败: {}", error))
        }
    }
}

fn restore_moved_files(moved_files: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (original_path, trash_path) in moved_files.iter().rev() {
        if trash_path.exists() {
            if let Err(error) = restore_from_trash(trash_path, original_path) {
                errors.push(format!("{}: {}", original_path.display(), error));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub(super) fn with_file_restore_error(error: String, moved_files: &[(PathBuf, PathBuf)]) -> String {
    match restore_moved_files(moved_files) {
        Ok(()) => error,
        Err(restore_error) => format!("{}；同时恢复会话文件失败：{}", error, restore_error),
    }
}

/// 批量删除会话记录：所有索引表在一个 SQLite 事务内提交，JSONL 文件移入回收目录。
pub fn delete_sessions(session_ids: &[String]) -> Result<(), String> {
    let _guard = index_lock()?;
    let mut unique_session_ids = Vec::new();
    let mut seen_session_ids = HashSet::new();
    for session_id in session_ids {
        if !session_id.is_empty() && seen_session_ids.insert(session_id.as_str()) {
            unique_session_ids.push(session_id.as_str());
        }
    }
    if unique_session_ids.is_empty() {
        return Ok(());
    }

    let mut conn = DatabaseService::open()?;
    let file_paths = {
        let mut statement = conn
            .prepare("SELECT file_path FROM claude_sessions WHERE session_id = ?1")
            .map_err(|error| format!("准备查询 Claude 会话失败: {}", error))?;
        let mut seen_paths = HashSet::new();
        let mut paths = Vec::new();
        for session_id in &unique_session_ids {
            let file_path: Option<String> = statement
                .query_row([*session_id], |row| row.get(0))
                .optional()
                .map_err(|error| format!("查询 Claude 会话失败: {}", error))?;
            if let Some(file_path) = file_path {
                let path = PathBuf::from(file_path);
                if seen_paths.insert(path.clone()) {
                    paths.push(path);
                }
            }
        }
        paths
    };

    let trash_dir = PathService::require_data_dir()?
        .join("Trash")
        .join("claude-sessions");
    let mut moved_files = Vec::new();
    for path in file_paths {
        if !path.exists() {
            continue;
        }
        match move_to_trash(&path, &trash_dir) {
            Ok(trash_path) => moved_files.push((path, trash_path)),
            Err(error) => return Err(with_file_restore_error(error, &moved_files)),
        }
    }

    let transaction = match conn.transaction() {
        Ok(transaction) => transaction,
        Err(error) => {
            return Err(with_file_restore_error(
                format!("开启 Claude 会话批量删除事务失败: {}", error),
                &moved_files,
            ));
        }
    };
    for session_id in &unique_session_ids {
        if let Err(error) = delete_index_rows(&transaction, session_id) {
            let rollback_error = transaction
                .rollback()
                .err()
                .map(|error| format!("；回滚数据库事务失败: {}", error))
                .unwrap_or_default();
            return Err(with_file_restore_error(
                format!("{}{}", error, rollback_error),
                &moved_files,
            ));
        }
    }
    if let Err(error) = transaction.commit() {
        return Err(with_file_restore_error(
            format!("提交 Claude 会话批量删除事务失败: {}", error),
            &moved_files,
        ));
    }
    Ok(())
}

/// 删除单条会话记录，复用批量事务实现。
pub fn delete_session(session_id: &str) -> Result<(), String> {
    delete_sessions(&[session_id.to_string()])
}

/// 导出：markdown 渲染 / jsonl 原样复制
pub fn export_session(session_id: &str, format: &str, dest_path: &str) -> Result<(), String> {
    match format {
        "markdown" => {
            let content = export_session_content(session_id, "markdown")?;
            fs::write(dest_path, content).map_err(|error| format!("写入导出文件失败: {}", error))
        }
        "jsonl" => {
            let conn = DatabaseService::open()?;
            let file_path = conn
                .query_row(
                    "SELECT file_path FROM claude_sessions WHERE session_id = ?1",
                    [session_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("查询 Claude 会话失败: {}", error))?
                .ok_or_else(|| "会话记录不存在（可能已被删除）".to_string())?;
            fs::copy(&file_path, dest_path)
                .map(|_| ())
                .map_err(|error| format!("复制会话记录失败: {}", error))
        }
        other => Err(format!("不支持的导出格式: {}", other)),
    }
}

/// 导出内容到内存：Web 端浏览器下载用（REST 返回文本，前端 Blob 落盘）。
/// markdown 复用导出渲染；jsonl 原样读出转录文件。
pub fn export_session_content(session_id: &str, format: &str) -> Result<String, String> {
    match format {
        "markdown" => {
            let page = get_replay(session_id, 0, usize::MAX)?;
            Ok(render_markdown(
                &page.title,
                &page.project_dir,
                page.model.as_deref(),
                page.total as usize,
                &page.messages,
            ))
        }
        "jsonl" => {
            let conn = DatabaseService::open()?;
            let file_path = conn
                .query_row(
                    "SELECT file_path FROM claude_sessions WHERE session_id = ?1",
                    [session_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("查询 Claude 会话失败: {}", error))?
                .ok_or_else(|| "会话记录不存在（可能已被删除）".to_string())?;
            fs::read_to_string(&file_path).map_err(|error| format!("读取会话记录失败: {}", error))
        }
        other => Err(format!("不支持的导出格式: {}", other)),
    }
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_transcript_lines() -> String {
        // 逐行拼出 JSONL（json! 数组序列化不是 JSONL，测试直接拼行）
        let lines = [
            r#"{"type":"summary","summary":"给侧边栏加重构计划","leafUuid":"u0"}"#,
            r#"{"type":"user","sessionId":"s1","cwd":"D:\\gitee\\TerminalBuddy","timestamp":"2026-09-24T06:00:00.000Z","message":{"role":"user","content":"给侧边栏加上重构计划"}}"#,
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-09-24T06:00:05.000Z","message":{"role":"assistant","model":"claude-opus-4","content":[{"type":"text","text":"我先看现有布局。"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo check"}}],"usage":{"input_tokens":100,"output_tokens":20}}}"#,
            r#"{"type":"user","sessionId":"s1","timestamp":"2026-09-24T06:00:10.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"error: could not compile"}]}}"#,
            r#"{"type":"user","sessionId":"s1","timestamp":"2026-09-24T06:01:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}}"#,
            r#"{"type":"user","sessionId":"s1","timestamp":"2026-09-24T06:02:00.000Z","isSidechain":true,"message":{"role":"user","content":"子代理提问"}}"#,
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-09-24T06:02:05.000Z","message":{"role":"assistant","model":"claude-opus-4","content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"src/App.tsx"}}],"usage":{"input_tokens":5,"output_tokens":5}}}"#,
            r#"{"type":"system","content":"忽略我"}"#,
            "not-json",
        ];
        lines.join("\n")
    }

    #[test]
    fn analyze_counts_and_title() {
        let analysis = analyze_transcript(&sample_transcript_lines());
        assert_eq!(analysis.project_dir, "D:\\gitee\\TerminalBuddy");
        assert_eq!(analysis.title.as_deref(), Some("给侧边栏加重构计划"));
        assert_eq!(analysis.first_prompt.as_deref(), Some("给侧边栏加上重构计划"));
        assert_eq!(analysis.message_count, 6); // user/assistant 行数（system 与坏行不计）
        assert_eq!(analysis.input_tokens, 105);
        assert_eq!(analysis.output_tokens, 25);
        assert_eq!(analysis.model.as_deref(), Some("claude-opus-4"));
        assert!(analysis.started_at.is_some());
        assert!(analysis.updated_at.is_some());
    }

    #[test]
    fn analyze_indexes_tool_results_and_tools() {
        let analysis = analyze_transcript(&sample_transcript_lines());
        // user 文本 1 + assistant 2 + tool 结果 2 + sidechain user 1
        assert_eq!(analysis.messages.len(), 6);
        let roles: Vec<&str> = analysis.messages.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, vec!["user", "assistant", "tool", "tool", "user", "assistant"]);
        // 工具名与文件路径进入索引内容
        assert!(analysis.messages[1].content.contains("[tool] Bash cargo check"));
        assert!(analysis.messages[5].content.contains("src/App.tsx"));
    }

    #[test]
    fn analyze_title_follows_official_resume_sources() {
        // AI 摘要标题优先于旧版 summary 条目
        let with_ai = [
            r#"{"type":"summary","summary":"旧版摘要标题"}"#,
            r#"{"type":"ai-title","aiTitle":"更新内容整理与版本号+1"}"#,
        ]
        .join("\n");
        assert_eq!(
            analyze_transcript(&with_ai).title.as_deref(),
            Some("更新内容整理与版本号+1")
        );

        // 用户在 claude 里改过名则以最后一次为准
        let renamed = [
            r#"{"type":"ai-title","aiTitle":"AI 起的标题"}"#,
            r#"{"type":"custom-title","customTitle":"Claude 增强"}"#,
            r#"{"type":"custom-title","customTitle":"Claude 增强-mutable-pumpkin"}"#,
        ]
        .join("\n");
        assert_eq!(
            analyze_transcript(&renamed).title.as_deref(),
            Some("Claude 增强-mutable-pumpkin")
        );

        // 空值条目不覆盖已取到的标题
        let blank = [
            r#"{"type":"ai-title","aiTitle":"有效标题"}"#,
            r#"{"type":"ai-title","aiTitle":"   "}"#,
        ]
        .join("\n");
        assert_eq!(
            analyze_transcript(&blank).title.as_deref(),
            Some("有效标题")
        );
    }

    #[test]
    fn analyzer_version_reset_drops_index_but_keeps_user_meta() {
        let conn = Connection::open_in_memory().expect("打开内存库");
        init_claude_schema(&conn).expect("建表");
        conn.execute(
            "INSERT INTO claude_sessions
                (session_id, project_dir, file_path, file_mtime, file_size, updated_at, indexed_at)
             VALUES ('s1', '', '', 0, 0, 0, 0)",
            [],
        )
        .expect("写入存量会话");
        conn.execute(
            "INSERT INTO claude_session_meta (session_id, starred) VALUES ('s1', 1)",
            [],
        )
        .expect("写入存量元数据");

        ensure_analyzer_version(&conn).expect("首次对齐版本");

        let sessions: i64 = conn
            .query_row("SELECT COUNT(*) FROM claude_sessions", [], |row| row.get(0))
            .expect("统计会话");
        assert_eq!(sessions, 0, "存量索引应按新规则重建");
        let starred: i64 = conn
            .query_row(
                "SELECT starred FROM claude_session_meta WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .expect("读取元数据");
        assert_eq!(starred, 1, "改名/收藏/归档不能随索引一起丢");

        // 版本已对齐后再次调用不得清库
        conn.execute(
            "INSERT INTO claude_sessions
                (session_id, project_dir, file_path, file_mtime, file_size, updated_at, indexed_at)
             VALUES ('s2', '', '', 0, 0, 0, 0)",
            [],
        )
        .expect("写入新会话");
        ensure_analyzer_version(&conn).expect("二次调用幂等");
        let sessions: i64 = conn
            .query_row("SELECT COUNT(*) FROM claude_sessions", [], |row| row.get(0))
            .expect("统计会话");
        assert_eq!(sessions, 1);
    }

    #[test]
    fn analyze_skips_bad_lines_and_resilient_to_missing_fields() {
        let analysis = analyze_transcript("{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n{{{\n");
        assert_eq!(analysis.message_count, 1);
        assert_eq!(analysis.messages.len(), 1);
        assert_eq!(analysis.project_dir, "");
    }

    #[test]
    fn first_prompt_prefers_non_sidechain() {
        let content = concat!(
            "{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"role\":\"user\",\"content\":\"子代理\"}}\n",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"真正提问\"}}",
        );
        let analysis = analyze_transcript(content);
        assert_eq!(analysis.first_prompt.as_deref(), Some("真正提问"));
    }

    #[test]
    fn replay_pairs_tool_result_with_tool_name() {
        let messages = parse_replay_messages(&sample_transcript_lines());
        // 6 条 user/assistant 行全部产出（空文本行被丢弃的除外）
        assert_eq!(messages.len(), 6);
        let tool_messages: Vec<&ClaudeReplayMessage> =
            messages.iter().filter(|m| m.role == "tool").collect();
        assert_eq!(tool_messages.len(), 2);
        assert_eq!(tool_messages[0].tool_name.as_deref(), Some("Bash"));
        assert!(tool_messages[0].text.contains("could not compile"));
        // seq 与行序一致：user=0 … assistant=5
        let seqs: Vec<i64> = messages.iter().map(|m| m.seq).collect();
        assert_eq!(seqs, vec![0, 1, 2, 3, 4, 5]);
        // assistant 消息带工具摘要
        assert_eq!(messages[1].tools.len(), 1);
        assert_eq!(messages[1].tools[0].name, "Bash");
        assert_eq!(messages[1].tools[0].summary, "cargo check");
    }

    #[test]
    fn replay_marks_skill_expansion_instead_of_user_bubble() {
        // 真实 transcript 形态：user 发斜杠命令 → CLI 回一条 isMeta 的技能全文。
        let content = [
            r#"{"type":"user","sessionId":"s1","timestamp":"2026-09-24T06:00:00.000Z","message":{"role":"user","content":"<command-name>/code-review</command-name>\n<command-message>code-review</command-message>\n<command-args>src</command-args>"}}"#,
            r#"{"type":"user","sessionId":"s1","isMeta":true,"timestamp":"2026-09-24T06:00:01.000Z","message":{"role":"user","content":"Base directory for this skill: /home/u/.claude/skills/code-review\n\n# Code Review\n\n逐文件审查。"}}"#,
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-09-24T06:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"开始审查"}]}}"#,
        ]
        .join("\n");
        let messages = parse_replay_messages(&content);
        assert_eq!(messages.len(), 3, "三条都应保留");
        // 斜杠命令本身仍是用户消息
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].skill_name, None);
        // 技能全文标记为 Skill 条目，名字取自同一回合的 <command-name>
        assert_eq!(messages[1].skill_name.as_deref(), Some("code-review"));
        assert!(messages[1].text.starts_with("Base directory for this skill:"));
        // 名称缺失时用技能目录名兜底
        let fallback = parse_replay_messages(
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Base directory for this skill: /tmp/x/bundled-skills/dataviz\n\n# Data"}}"#,
        );
        assert_eq!(fallback[0].skill_name.as_deref(), Some("dataviz"));
    }

    #[test]
    fn replay_drops_non_skill_meta_injections() {
        // isMeta 的 hook 条件、系统提醒不属于用户发言，不能当气泡渲染。
        let content = [
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"A session-scoped Stop hook is now active with condition: \"x\""}}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"[Your previous response had no visible output.]"}}"#,
            r#"{"type":"user","timestamp":"2026-09-24T06:00:00.000Z","message":{"role":"user","content":"真正提问"}}"#,
        ]
        .join("\n");
        let messages = parse_replay_messages(&content);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "真正提问");
        assert_eq!(messages[0].skill_name, None);
    }

    #[test]
    fn analyze_ignores_meta_injection_for_first_prompt_and_index() {
        let content = [
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"A session-scoped Stop hook is now active"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"真正提问"}}"#,
        ]
        .join("\n");
        let analysis = analyze_transcript(&content);
        assert_eq!(analysis.first_prompt.as_deref(), Some("真正提问"));
        assert_eq!(analysis.messages.len(), 1);
    }

    #[test]
    fn compact_tool_input_prefers_path_fields() {
        assert_eq!(
            compact_tool_input(&serde_json::json!({"file_path": "src/a.rs", "old_string": "x"})),
            "src/a.rs"
        );
        assert_eq!(
            compact_tool_input(&serde_json::json!({"command": "ls -la"})),
            "ls -la"
        );
        let long = compact_tool_input(&serde_json::json!({"note": "长文本".repeat(100)}));
        assert!(long.chars().count() <= TOOL_INPUT_SUMMARY_LIMIT);
    }

    #[test]
    fn display_title_fallbacks() {
        assert_eq!(
            display_title(Some("自定义"), Some("summary"), Some("prompt"), "id"),
            "自定义"
        );
        assert_eq!(display_title(None, Some("summary"), Some("prompt"), "id"), "summary");
        assert_eq!(display_title(None, None, Some("prompt"), "id"), "prompt");
        assert_eq!(display_title(None, None, None, "id"), "id");
    }

    #[test]
    fn display_title_prefers_command_args_over_raw_tags() {
        let raw = "<command-message>guide-deck</command-message>\n\
                   <command-name>/guide-deck</command-name>\n\
                   <command-args>为新版\n本重新生成\n一份演示。</command-args>";
        assert_eq!(
            display_title(None, None, Some(raw), "id"),
            "为新版 本重新生成 一份演示。"
        );
        // 参数为空时退回命令名
        assert_eq!(
            display_title(
                None,
                None,
                Some("<command-message>x</command-message><command-name>/help</command-name><command-args>  </command-args>"),
                "id"
            ),
            "/help"
        );
        // 自定义标题仍优先
        assert_eq!(display_title(Some("自定义"), None, Some(raw), "id"), "自定义");
        // 不含标签块的普通提问不受影响
        assert_eq!(display_title(None, None, Some("普通提问"), "id"), "普通提问");
    }

    #[test]
    fn render_markdown_contains_dialog_and_tools() {
        let messages = parse_replay_messages(&sample_transcript_lines());
        let md = render_markdown("标题", "D:\\proj", Some("claude-opus-4"), 6, &messages);
        assert!(md.contains("# 标题"));
        assert!(md.contains("## 你"));
        assert!(md.contains("## Claude"));
        assert!(md.contains("`Bash` cargo check"));
        assert!(md.contains("D:\\proj"));
    }

    #[test]
    fn schema_and_scan_and_search_roundtrip() {
        let conn = Connection::open_in_memory().expect("打开内存库");
        init_claude_schema(&conn).expect("建表");

        let root = std::env::temp_dir().join(format!("tb-claude-hist-{}", uuid::Uuid::new_v4()));
        let project_dir = root.join("D--gitee-TerminalBuddy");
        fs::create_dir_all(&project_dir).expect("创建临时项目目录");
        let file = project_dir.join("s1.jsonl");
        fs::write(&file, sample_transcript_lines()).expect("写入临时 transcript");

        let result = scan_projects_dir(&conn, &root, usize::MAX).expect("扫描");
        assert_eq!(result.scanned, 1);
        assert_eq!(result.updated, 1);
        assert_eq!(result.total, 1);
        assert_eq!(result.pending, 0);

        // 再扫一遍：文件未变则跳过
        let again = scan_projects_dir(&conn, &root, usize::MAX).expect("再扫描");
        assert_eq!(again.updated, 0);

        let items = {
            let mut statement = conn
                .prepare("SELECT session_id, project_dir, title FROM claude_sessions")
                .expect("查询");
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0).unwrap(),
                        row.get::<_, String>(1).unwrap(),
                        row.get::<_, String>(2).unwrap(),
                    ))
                })
                .expect("映射");
            rows.collect::<Vec<_>>()
        };
        assert_eq!(items.len(), 1);
        let row = items[0].as_ref().unwrap();
        assert_eq!(row.0, "s1");
        assert_eq!(row.1, "D:\\gitee\\TerminalBuddy");
        assert_eq!(row.2, "给侧边栏加重构计划");

        // 中文子串搜索应命中（这正是不用 FTS5 的原因）
        let hits = search_in(&conn, "布局", None).expect("搜索");
        assert!(!hits.is_empty(), "应命中「布局」");
        assert_eq!(hits[0].session_id, "s1");
        assert!(hits[0].snippet.contains("布局"), "snippet={}", hits[0].snippet);

        // 删除文件后重扫应清掉索引
        fs::remove_file(&file).expect("删除临时 transcript");
        let after = scan_projects_dir(&conn, &root, usize::MAX).expect("清扫");
        assert_eq!(after.total, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn batched_scan_reports_pending_and_completes_on_next_pass() {
        let conn = Connection::open_in_memory().expect("打开内存库");
        init_claude_schema(&conn).expect("建表");

        let root = std::env::temp_dir().join(format!("tb-claude-batch-{}", uuid::Uuid::new_v4()));
        let project_dir = root.join("D--gitee-TerminalBuddy");
        fs::create_dir_all(&project_dir).expect("创建临时项目目录");
        for name in ["old", "new"] {
            fs::write(
                project_dir.join(format!("{}.jsonl", name)),
                sample_transcript_lines(),
            )
            .expect("写入临时 transcript");
        }

        // 一批一个：首扫只索引最近的一个，剩下的报为 pending
        let first = scan_projects_dir(&conn, &root, 1).expect("首批扫描");
        assert_eq!(first.scanned, 2);
        assert_eq!(first.updated, 1);
        assert_eq!(first.pending, 1);

        // pending 递减到 0 即补齐完成，total 覆盖全部会话
        let second = scan_projects_dir(&conn, &root, 1).expect("次批扫描");
        assert_eq!(second.updated, 1);
        assert_eq!(second.pending, 0);
        assert_eq!(second.total, 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_sessions_filters_project_dir_regardless_of_case_and_separator() {
        let conn = Connection::open_in_memory().expect("打开内存库");
        init_claude_schema(&conn).expect("建表");
        let root = std::env::temp_dir().join(format!("tb-claude-scope-{}", uuid::Uuid::new_v4()));
        let project_dir = root.join("D--gitee-TerminalBuddy");
        fs::create_dir_all(&project_dir).expect("创建临时项目目录");
        fs::write(project_dir.join("s1.jsonl"), sample_transcript_lines())
            .expect("写入临时 transcript");
        scan_projects_dir(&conn, &root, usize::MAX).expect("扫描");

        // transcript 里的 cwd 是 `D:\gitee\TerminalBuddy`，前端推算出的目录在大小写、
        // 分隔符与结尾斜杠上都可能不同，仍须命中
        for candidate in [
            r"D:\gitee\TerminalBuddy",
            "d:/gitee/terminalbuddy/",
            r"D:\gitee\TerminalBuddy\",
        ] {
            let items = list_sessions_in(&conn, false, Some(candidate)).expect("按项目过滤");
            assert_eq!(items.len(), 1, "候选 {} 应命中", candidate);
        }
        assert!(list_sessions_in(&conn, false, Some(r"D:\other"))
            .expect("其他项目")
            .is_empty());
        // 不传目录 = 全局视图
        assert_eq!(list_sessions_in(&conn, false, None).expect("全局").len(), 1);

        conn.execute(
            "INSERT INTO claude_sessions (session_id, project_dir, file_path, file_mtime, file_size, updated_at, indexed_at)
             VALUES ('child', 'D:\\gitee\\TerminalBuddy\\src', 'child.jsonl', 0, 0, 0, 0),
                    ('sibling', 'D:\\gitee\\TerminalBuddyExtra', 'sibling.jsonl', 0, 0, 0, 0)",
            [],
        ).expect("插入子目录和同名前缀目录");
        let scoped = list_sessions_in(&conn, false, Some(r"D:\gitee\TerminalBuddy"))
            .expect("按项目包含子目录");
        assert_eq!(scoped.len(), 2);
        assert!(scoped.iter().any(|item| item.session_id == "child"));
        assert!(scoped.iter().all(|item| item.session_id != "sibling"));
        conn.execute(
            "INSERT INTO claude_messages (session_id, seq, role, content)
             VALUES ('child', 0, 'user', 'scope-check'),
                    ('sibling', 0, 'user', 'scope-check')",
            [],
        ).expect("插入检索消息");
        let hits = search_in(&conn, "scope-check", Some(r"D:\gitee\TerminalBuddy"))
            .expect("全文检索按项目过滤");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "child");

        let _ = fs::remove_dir_all(&root);
    }
}
