//! 终端访问策略：桌面端 / Web 端对某个终端可以做什么，集中在这里判定。
//!
//! REST handler、WebSocket handler 和 Tauri command 都必须调用本模块，
//! 不允许各自硬编码 owner 比较，否则权限矩阵会再次漂移。

use super::TerminalOwner;

/// 发起终端操作的一侧。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalActor {
    /// 桌面应用（Tauri 前端 / Tauri command）
    Pc,
    /// Web 端（REST + WebSocket，含手机浏览器）
    Web,
}

/// 终端上的操作类别。权限按操作粒度判定，不再使用单一的「只读」布尔。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalAction {
    /// 只读访问：出现在会话列表、读取历史输出、订阅实时输出、回执渲染流控。
    View,
    /// 写入按键数据。
    Input,
    /// 调整 PTY 尺寸。
    Resize,
    /// 修改显示名等元数据。
    RenameMetadata,
    /// 关闭终端。
    Close,
}

impl TerminalAction {
    fn label(self) -> &'static str {
        match self {
            Self::View => "查看",
            Self::Input => "输入",
            Self::Resize => "调整尺寸",
            Self::RenameMetadata => "重命名",
            Self::Close => "关闭",
        }
    }
}

/// 判定某一侧能否对指定归属的终端执行指定操作。
///
/// 规则（`share_sessions` 即设置项 `webApiShareSessions`）：
///
/// | share | actor | owner | View | Input/Resize/Rename | Close |
/// | --- | --- | --- | --- | --- | --- |
/// | false | Web | Web | 是 | 是 | 是 |
/// | false | Web | Pc  | 否 | 否 | 否 |
/// | true  | Web | Web | 是 | 是 | 是 |
/// | true  | Web | Pc  | 是 | 是 | **否** |
/// | false | Pc  | Pc  | 是 | 是 | 是 |
/// | false | Pc  | Web | 是（只读） | 否 | 否 |
/// | true  | Pc  | Pc  | 是 | 是 | 是 |
/// | true  | Pc  | Web | 是 | 是 | 是 |
pub fn is_terminal_action_allowed(
    actor: TerminalActor,
    owner: &TerminalOwner,
    action: TerminalAction,
    share_sessions: bool,
) -> bool {
    let same_side = matches!(
        (actor, owner),
        (TerminalActor::Pc, TerminalOwner::Pc) | (TerminalActor::Web, TerminalOwner::Web)
    );
    if same_side {
        return true;
    }
    match (actor, action) {
        // 桌面端对 Web 终端：始终允许只读查看（产品合同），写操作仅共享模式开放。
        (TerminalActor::Pc, TerminalAction::View) => true,
        (TerminalActor::Pc, _) => share_sessions,
        // Web 端「接管」PC 终端永远不等于「关闭 PC 终端」。
        (TerminalActor::Web, TerminalAction::Close) => false,
        (TerminalActor::Web, _) => share_sessions,
    }
}

/// 授权失败的原因。调用方据此区分 404 与 403，不需要对错误文本做字符串匹配。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalAccessError {
    /// 终端不存在，或已经被关闭 / 自然退出。
    NotFound,
    /// 终端存在，但发起方当前无权执行该操作。
    Denied {
        actor: TerminalActor,
        action: TerminalAction,
    },
}

impl std::fmt::Display for TerminalAccessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => f.write_str("终端不存在或已关闭"),
            Self::Denied { actor, action } => {
                f.write_str(&terminal_action_denied_message(*actor, *action))
            }
        }
    }
}

/// 拒绝时给用户的中文提示，包含可执行的处理建议。
///
/// 共享开关目前没有设置页 UI，只能改 `settings.json`，因此提示直接给出设置项名，
/// 与 `docs/完整使用与配置指南.md` §17.4 保持一致。
pub fn terminal_action_denied_message(actor: TerminalActor, action: TerminalAction) -> String {
    match (actor, action) {
        (TerminalActor::Web, TerminalAction::Close) => {
            "无权关闭桌面端创建的终端，请在桌面端关闭该标签页。".to_string()
        }
        (TerminalActor::Web, _) => format!(
            "该终端由桌面端创建，Web 端当前无权{}。请在桌面端 settings.json 中把「与桌面共享终端会话」(webApiShareSessions) 设为 true 后重连。",
            action.label()
        ),
        (TerminalActor::Pc, _) => format!(
            "该终端由 Web 端创建，桌面端当前为只读，无权{}。请在 settings.json 中把「与桌面共享终端会话」(webApiShareSessions) 设为 true 后重试。",
            action.label()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACTIONS: [TerminalAction; 5] = [
        TerminalAction::View,
        TerminalAction::Input,
        TerminalAction::Resize,
        TerminalAction::RenameMetadata,
        TerminalAction::Close,
    ];

    fn allowed(
        actor: TerminalActor,
        owner: TerminalOwner,
        share: bool,
    ) -> Vec<(TerminalAction, bool)> {
        ACTIONS
            .iter()
            .map(|action| {
                (
                    *action,
                    is_terminal_action_allowed(actor, &owner, *action, share),
                )
            })
            .collect()
    }

    /// 同归属：不论共享设置，全部操作放行。
    #[test]
    fn same_side_owner_always_has_full_control() {
        for share in [false, true] {
            for (actor, owner) in [
                (TerminalActor::Pc, TerminalOwner::Pc),
                (TerminalActor::Web, TerminalOwner::Web),
            ] {
                for (action, ok) in allowed(actor, owner.clone(), share) {
                    assert!(ok, "{:?} 对自己的终端应允许 {:?}", actor, action);
                }
            }
        }
    }

    /// 非共享模式：Web 完全看不到、也操作不了 PC 终端。
    #[test]
    fn web_is_fully_isolated_from_pc_terminals_when_not_shared() {
        for (action, ok) in allowed(TerminalActor::Web, TerminalOwner::Pc, false) {
            assert!(!ok, "非共享模式下 Web 不应能 {:?} PC 终端", action);
        }
    }

    /// 共享模式：Web 可读写 PC 终端，但仍不能关闭。
    #[test]
    fn web_may_take_over_but_never_close_pc_terminals() {
        for (action, ok) in allowed(TerminalActor::Web, TerminalOwner::Pc, true) {
            match action {
                TerminalAction::Close => assert!(!ok, "Web 永远不能关闭 PC 终端"),
                _ => assert!(ok, "共享模式下 Web 应能 {:?} PC 终端", action),
            }
        }
    }

    /// 非共享模式：桌面端只读查看 Web 终端。
    #[test]
    fn pc_is_read_only_on_web_terminals_when_not_shared() {
        for (action, ok) in allowed(TerminalActor::Pc, TerminalOwner::Web, false) {
            match action {
                TerminalAction::View => assert!(ok, "桌面端应可只读查看 Web 终端"),
                _ => assert!(!ok, "非共享模式下桌面端不应能 {:?} Web 终端", action),
            }
        }
    }

    /// 共享模式：桌面端对 Web 终端拥有全部操作。
    #[test]
    fn pc_gains_full_control_of_web_terminals_when_shared() {
        for (action, ok) in allowed(TerminalActor::Pc, TerminalOwner::Web, true) {
            assert!(ok, "共享模式下桌面端应能 {:?} Web 终端", action);
        }
    }

    #[test]
    fn denial_messages_are_actionable_chinese_text() {
        let web_close =
            terminal_action_denied_message(TerminalActor::Web, TerminalAction::Close);
        assert!(web_close.contains("桌面端关闭"));
        let web_input =
            terminal_action_denied_message(TerminalActor::Web, TerminalAction::Input);
        assert!(web_input.contains("共享终端会话"));
        let pc_input = terminal_action_denied_message(TerminalActor::Pc, TerminalAction::Input);
        assert!(pc_input.contains("共享终端会话"));
    }

    /// 错误枚举必须能独立区分「不存在」和「无权限」，调用方不再匹配错误文本。
    #[test]
    fn access_error_renders_distinct_chinese_messages() {
        assert_eq!(TerminalAccessError::NotFound.to_string(), "终端不存在或已关闭");
        let denied = TerminalAccessError::Denied {
            actor: TerminalActor::Web,
            action: TerminalAction::Close,
        };
        assert_eq!(
            denied.to_string(),
            terminal_action_denied_message(TerminalActor::Web, TerminalAction::Close)
        );
    }
}
