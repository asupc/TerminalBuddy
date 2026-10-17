//! Web 端设备类型识别：按请求 User-Agent 判定发起方是手机还是电脑。
//!
//! 供两处使用：
//! - 创建终端时记录 `TerminalCreator`（「谁创建的」）；
//! - 关闭终端时判定 `TerminalClientKind`（「谁来关」），配合
//!   `terminal_access::is_web_close_allowed_by_client` 实现手机端关闭权限细分。
//!
//! 这是产品行为限制（防手机误关电脑上的会话），不是安全边界——
//! User-Agent 可被伪造，但同一管理员账号下无防伪造诉求。

use axum::http::{header, HeaderMap};
use crate::models::TerminalClientKind;

/// 手机 UA 特征关键词。`Android` 不带 `Mobile` 也算（Android 平板请求桌面版
/// UA 时不含 Mobile 字样，平板同样适合手机版界面）；`HarmonyOS` 覆盖鸿蒙系。
/// iPadOS 13+ 的 Safari 默认请求桌面 UA（Macintosh），会被判为 Desktop——
/// 属于用户主动选择桌面体验，接受该误差。
const MOBILE_UA_KEYWORDS: [&str; 7] = [
    "iPhone",
    "iPad",
    "iPod",
    "Android",
    "Mobile",
    "HarmonyOS",
    "Windows Phone",
];

/// 按 User-Agent 字符串判定设备类型；缺失 UA 时按电脑处理（保守：不限制关闭）。
pub fn client_kind_from_user_agent(ua: &str) -> TerminalClientKind {
    if MOBILE_UA_KEYWORDS.iter().any(|keyword| ua.contains(keyword)) {
        TerminalClientKind::Mobile
    } else {
        TerminalClientKind::Desktop
    }
}

/// 从请求头提取 User-Agent 并判定设备类型。
pub fn client_kind_from_headers(headers: &HeaderMap) -> TerminalClientKind {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    client_kind_from_user_agent(ua)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_common_mobile_user_agents() {
        let samples = [
            // iPhone Safari
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
            // Android Chrome（手机）
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
            // Android 平板（无 Mobile 字样）
            "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            // 微信内置浏览器（iPhone）
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49",
            // 鸿蒙
            "Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile",
        ];
        for ua in samples {
            assert_eq!(client_kind_from_user_agent(ua), TerminalClientKind::Mobile, "应识别为手机：{}", ua);
        }
    }

    #[test]
    fn recognizes_desktop_user_agents() {
        let samples = [
            // Windows Chrome
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            // macOS Safari
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
            // Linux Firefox
            "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
            // iPadOS 13+ 桌面模式（自称 Macintosh，接受判为桌面）
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        ];
        for ua in samples {
            assert_eq!(client_kind_from_user_agent(ua), TerminalClientKind::Desktop, "应识别为电脑：{}", ua);
        }
    }

    #[test]
    fn missing_or_empty_user_agent_defaults_to_desktop() {
        assert_eq!(client_kind_from_user_agent(""), TerminalClientKind::Desktop);
    }
}
