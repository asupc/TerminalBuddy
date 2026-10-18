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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayTool {
    pub name: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
