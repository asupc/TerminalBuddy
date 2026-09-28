//! Claude Code 历史会话索引与检索。
//!
//! 数据源：`~/.claude/projects/<路径编码>/*.jsonl`（Claude Code 官方 transcript）。
//! 索引存 SQLite（claude_sessions / claude_session_meta / claude_messages_fts），
//! 回放与导出直接读 JSONL 文件本身。解析逻辑全部为纯函数并带单测：
//! JSONL 是 Claude Code 内部格式，坏行必须跳过而不是报错。

use crate::services::claude_config_service::normalized_dir_expr;
use crate::services::{DatabaseService, PathService};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};

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
const ANALYZER_VERSION: i64 = 2;

// ---------------------------------------------------------------------------
// 对外数据结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionItem {
    pub session_id: String,
    pub project_dir: String,
    pub file_path: String,
    pub title: String,
    pub custom_title: Option<String>,
    pub started_at: Option<i64>,
    pub updated_at: i64,
    pub message_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub model: Option<String>,
    pub starred: bool,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSearchHit {
    pub session_id: String,
    pub title: String,
    pub project_dir: String,
    pub snippet: String,
    pub seq: i64,
    pub timestamp: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeReplayTool {
    pub name: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeReplayMessage {
    pub seq: i64,
    /// "user" | "assistant" | "tool"
    pub role: String,
    pub timestamp: Option<i64>,
    pub text: String,
    pub tools: Vec<ClaudeReplayTool>,
    /// tool 结果对应的工具名（多个用「、」连接）
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeReplayPage {
    pub total: i64,
    pub messages: Vec<ClaudeReplayMessage>,
    pub title: String,
    pub project_dir: String,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub started_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHistoryScanResult {
    pub scanned: i64,
    pub updated: i64,
    pub total: i64,
    /// 本批之后仍需索引的会话文件数（后台补齐据此判断是否还没扫完）
    pub pending: i64,
}

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
    for line in content.lines() {
        let line = line.trim();
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
            "assistant" => ("Claude", message.timestamp),
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
            notes TEXT
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

fn collect_session_files(projects_dir: &Path) -> Result<Vec<SessionFile>, String> {
    let mut files = Vec::new();
    if !projects_dir.is_dir() {
        return Ok(files);
    }
    let project_entries = fs::read_dir(projects_dir)
        .map_err(|error| format!("读取 Claude 项目目录失败: {}", error))?;
    for project_entry in project_entries.flatten() {
        let Ok(session_entries) = fs::read_dir(project_entry.path()) else {
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
    Ok(files)
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
fn prune_missing_sessions(conn: &Connection, seen: &HashSet<&str>) -> Result<(), String> {
    let stale: Vec<String> = {
        let mut statement = conn
            .prepare("SELECT session_id FROM claude_sessions")
            .map_err(|error| format!("查询 Claude 会话索引失败: {}", error))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("查询 Claude 会话索引失败: {}", error))?;
        rows.filter_map(|row| row.ok())
            .filter(|session_id| !seen.contains(session_id.as_str()))
            .collect()
    };
    for session_id in &stale {
        delete_index_rows(conn, session_id)?;
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
    let files = collect_session_files(projects_dir)?;
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
    prune_missing_sessions(conn, &seen)?;
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
    conn.execute("DELETE FROM claude_messages", [])
        .map_err(|error| format!("清空 Claude 消息索引失败: {}", error))?;
    conn.execute("DELETE FROM claude_sessions", [])
        .map_err(|error| format!("清空 Claude 会话索引失败: {}", error))?;
    conn.execute(
        "INSERT INTO claude_index_state (key, value) VALUES ('analyzer_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![ANALYZER_VERSION],
    )
    .map_err(|error| format!("写入 Claude 索引版本失败: {}", error))?;
    Ok(())
}

/// 面板打开时的索引入口：本批只索引最近的少量会话，剩余交给后台补齐任务。
pub fn scan_and_index(app: &AppHandle) -> Result<ClaudeHistoryScanResult, String> {
    let conn = DatabaseService::open()?;
    ensure_analyzer_version(&conn)?;
    let projects_dir = projects_root()?;
    let result = scan_projects_dir(&conn, &projects_dir, INDEX_BATCH_FILES)?;
    if result.pending > 0 {
        spawn_backfill(app.clone(), conn, projects_dir);
    }
    Ok(result)
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

    let _task = tauri::async_runtime::spawn_blocking(move || {
        let _guard = Guard;
        let mut last_pending = i64::MAX;
        loop {
            let result = match scan_projects_dir(&conn, &projects_dir, INDEX_BATCH_FILES) {
                Ok(result) => result,
                Err(error) => {
                    crate::commands::terminal::log_debug(&format!("[claude-history] 补齐失败: {}", error));
                    break;
                }
            };
            let finished = result.pending == 0;
            // 整批都读不动（被占用/无权限）时不再自旋，留到下次打开面板重试
            let stalled = result.pending >= last_pending;
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

/// LIKE 兜底的命中片段：取关键词首次出现位置前后各一段
fn snippet_around(content: &str, keyword: &str) -> String {
    let lower = content.to_lowercase();
    let needle = keyword.to_lowercase();
    match lower.find(&needle) {
        Some(index) => {
            let start = index.saturating_sub(20);
            let end = (index + needle.chars().count() + 40).min(content.chars().count());
            let slice: String = content.chars().skip(start).take(end - start).collect();
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
        conn.execute(
            "UPDATE claude_session_meta SET archived = ?2 WHERE session_id = ?1",
            params![session_id, if archived { 1 } else { 0 }],
        )
        .map_err(|error| format!("更新归档状态失败: {}", error))?;
    }
    Ok(())
}

/// 跨盘移动失败时退化为复制 + 删除
fn move_to_trash(path: &Path, trash_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(trash_dir).map_err(|error| format!("创建回收目录失败: {}", error))?;
    let target = trash_dir.join(format!(
        "{}-{}.jsonl",
        path.file_stem().and_then(|value| value.to_str()).unwrap_or("session"),
        chrono::Utc::now().timestamp_millis()
    ));
    match fs::rename(path, &target) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(path, &target).map_err(|error| format!("备份会话记录失败: {}", error))?;
            fs::remove_file(path).map_err(|error| format!("移除会话记录失败: {}", error))
        }
    }
}

/// 删除会话记录：JSONL 移入回收目录，索引行清理
pub fn delete_session(session_id: &str) -> Result<(), String> {
    let conn = DatabaseService::open()?;
    let file_path: Option<String> = conn
        .query_row(
            "SELECT file_path FROM claude_sessions WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("查询 Claude 会话失败: {}", error))?;
    if let Some(file_path) = file_path {
        let path = PathBuf::from(file_path);
        if path.exists() {
            let trash = PathService::require_data_dir()?
                .join("Trash")
                .join("claude-sessions");
            move_to_trash(&path, &trash)?;
        }
    }
    delete_index_rows(&conn, session_id)
}

/// 导出：markdown 渲染 / jsonl 原样复制
pub fn export_session(session_id: &str, format: &str, dest_path: &str) -> Result<(), String> {
    match format {
        "markdown" => {
            let page = get_replay(session_id, 0, usize::MAX)?;
            let content = render_markdown(
                &page.title,
                &page.project_dir,
                page.model.as_deref(),
                page.total as usize,
                &page.messages,
            );
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
