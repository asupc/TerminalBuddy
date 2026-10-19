use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalOwner {
    Pc,
    Web,
}

/// 终端创建端的设备类型（按创建请求的 User-Agent 判定）。
///
/// 语义统一为「电脑创建 / 手机创建」：PC 桌面端（Tauri command）创建的终端
/// 记 `Desktop`；Web 池内再按请求方浏览器细分，用于来源标识与接管提示。
/// 关闭权限按 owner（Pc/Web）判定，与创建端设备无关。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalCreator {
    Desktop,
    Mobile,
}
