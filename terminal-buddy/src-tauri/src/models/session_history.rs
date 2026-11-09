//! Claude Code 与 Codex 会话共用的列表、检索和回放协议。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryItem {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    pub session_id: String,
    pub title: String,
    pub project_dir: String,
    pub snippet: String,
    pub seq: i64,
    pub timestamp: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayTool {
    pub name: String,
    pub summary: String,
}

/// 镜像同步按完整字段（seq/role/text/timestamp/tools/toolName）比较，
/// 因此派生 PartialEq（见 terminal_agent_relay::diff_content）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayMessage {
    pub seq: i64,
    /// "user" | "assistant" | "tool"
    pub role: String,
    pub timestamp: Option<i64>,
    pub text: String,
    pub tools: Vec<SessionReplayTool>,
    /// tool 结果对应的工具名（多个用「、」连接）
    pub tool_name: Option<String>,
    /// Skill 展开条目：正文是 Skill 全文，值为技能名（如 `code-review`）。
    /// 与实时链路 `AiMessage::skill_name` 同义，用于把展开正文渲染成可折叠卡片，
    /// 而不是误当成用户发出的消息。普通消息为 None。
    /// `#[serde(default)]` 保证旧客户端与旧落盘数据的兼容。
    #[serde(default)]
    pub skill_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayPage {
    pub total: i64,
    pub messages: Vec<SessionReplayMessage>,
    pub title: String,
    pub project_dir: String,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub started_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryScanResult {
    pub scanned: i64,
    pub updated: i64,
    pub total: i64,
    /// 本批之后仍需索引的会话文件数（后台补齐据此判断是否还没扫完）
    pub pending: i64,
}
