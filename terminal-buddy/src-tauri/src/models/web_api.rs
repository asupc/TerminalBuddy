use crate::models::{TerminalCreator, TerminalOwner};
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

#[cfg(not(feature = "desktop"))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupAdminRequest {
    pub password: String,
    pub confirm_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatusResponse {
    pub enabled: bool,
    pub port: u16,
    pub setup_required: bool,
    pub username: String,
    /// Docker 网页主页标题（浏览器标签 + 登录页大标题），空串 = 默认标题。
    #[serde(default)]
    pub page_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorResponse {
    pub error: String,
    pub message: String,
}

// ----- Claude 历史会话（Web 端）-----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRenameRequest {
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeFlagsRequest {
    #[serde(default)]
    pub starred: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDeleteBatchRequest {
    pub session_ids: Vec<String>,
}

// ----- Web 端文件树 / Git -----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutRequest {
    pub repo: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRequest {
    pub repo: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoRequest {
    pub repo: String,
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
    /// 创建端设备（"desktop" | "mobile"），用于来源标识与接管提示。
    pub creator: TerminalCreator,
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
    /// 会话当前目录（启动目录，或前端检测到 cd 后上报的最新值）。
    /// 其他端据此跟随文件导航与会话历史，避免各客户端目录状态互相不可见。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
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
    /// 声明 viewport=1 的查看端按 PTY 实际尺寸渲染，避免电脑与手机抢宽度。
    #[serde(rename = "viewport")]
    Viewport { cols: u16, rows: u16, takeover: bool },
    #[serde(rename = "output")]
    Output { data: String },
    /// 按输出产生时的网格尺寸回放；仅发送给声明 replay=1 的客户端。
    #[serde(rename = "replay")]
    Replay { frames: Vec<TerminalReplayFrame> },
    #[serde(rename = "exited")]
    Exited { code: i32 },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReplayFrame {
    pub data: String,
    pub cols: u16,
    pub rows: u16,
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
    /// 自定义标签名（与 PC 端 startTerminal 的 displayName 对齐）
    #[serde(default)]
    pub display_name: Option<String>,
    /// 覆盖启动目录（profile 模式与项目模式共用）
    #[serde(default)]
    pub startup_path: Option<String>,
    /// profile_id 为空时的空白终端归属分组（项目启动传项目名）
    #[serde(default)]
    pub startup_group: Option<String>,
    /// profile_id 为空时注入的启动命令（项目自定义启动命令 / claude --resume）
    #[serde(default)]
    pub startup_command: Option<String>,
    /// 历史会话恢复：命令没有模型引用时补 hooks 临时 settings
    #[serde(default)]
    pub inject_claude_hooks: Option<bool>,
}

#[cfg(test)]
mod replay_protocol_tests {
    use super::*;

    #[test]
    fn replay_carries_grid_dimensions_and_legacy_output_stays_compatible() {
        let replay = WsServerMessage::Replay {
            frames: vec![TerminalReplayFrame { data: "画面".into(), cols: 120, rows: 30 }],
        };
        assert_eq!(serde_json::to_value(replay).unwrap(), serde_json::json!({
            "type": "replay", "frames": [{ "data": "画面", "cols": 120, "rows": 30 }],
        }));
        assert_eq!(serde_json::to_value(WsServerMessage::Output { data: "output".into() }).unwrap(),
            serde_json::json!({ "type": "output", "data": "output" }));
        assert_eq!(serde_json::to_value(WsServerMessage::Replay { frames: vec![] }).unwrap(),
            serde_json::json!({ "type": "replay", "frames": [] }));
    }
}
