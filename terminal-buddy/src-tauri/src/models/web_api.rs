use crate::models::TerminalOwner;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub token: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatusResponse {
    pub enabled: bool,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorResponse {
    pub error: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub group: String,
    pub terminal_type: String,
    pub loading_mode: String,
    pub owner: TerminalOwner,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_param_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_param_tag_color: Option<String>,
    /// 启动时使用的额外参数快照（供 Web 端「以此配置新建终端」复用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_startup_params: Option<String>,
    /// 额外参数模式：append / independent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_startup_mode: Option<String>,
}

/// meta WebSocket 推送的消息（会话列表实时同步）。
/// 与终端 I/O 的 WsServerMessage 分开，因为 meta 通道只承载列表快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MetaServerMessage {
    #[serde(rename = "sessions")]
    Sessions { terminals: Vec<TerminalInfo> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WsClientMessage {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WsServerMessage {
    #[serde(rename = "output")]
    Output { data: String },
    #[serde(rename = "exited")]
    Exited { code: i32 },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTerminalRequest {
    pub profile_id: String,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
    #[serde(default)]
    pub extra_startup_params: Option<String>,
    #[serde(default)]
    pub extra_startup_mode: Option<String>,
    #[serde(default)]
    pub extra_param_tag: Option<String>,
    #[serde(default)]
    pub extra_param_tag_color: Option<String>,
}
