//! 服务端任务通知事件：向 App 提供终端完成事件与待处理决策。
//! 事件保存在内存中，App 重连时补发仍在等待的决策。
use crate::services::claude_hook_service::{
    ClaudeHookDecisionEvent, ClaudeHookQuestion, ClaudeHookTerminalEvent,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio::sync::broadcast;

use crate::runtime::{AppHandle, Manager};

/// 与服务端终端列表保持同一名称来源；终端已关闭时回退为通用名称。
pub fn terminal_name(app: &AppHandle, terminal_id: &str) -> String {
    app.state::<crate::commands::TerminalService>()
        .list_terminals_info()
        .into_iter()
        .find(|terminal| terminal.id == terminal_id)
        .map(|terminal| terminal.profile_name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "服务端终端".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppNotificationEvent {
    /// 事件去重标识；决策使用 `decision:<decisionId>`，完成事件使用 `terminal:<eventId>`。
    pub id: String,
    /// decision | completed | failed | resolved
    pub kind: String,
    pub terminal_id: String,
    pub terminal_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub title: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<ClaudeHookQuestion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub occurred_at: i64,
}

pub struct AppNotificationService;

impl AppNotificationService {
    pub fn subscribe() -> broadcast::Receiver<AppNotificationEvent> {
        channel().subscribe()
    }

    /// App 重连时补发仍在等待的决策；完成事件不补发，避免重复提醒。
    pub fn pending_decisions() -> Vec<AppNotificationEvent> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut decisions = pending()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .values()
            .filter(|event| event.expires_at.map_or(true, |expires_at| expires_at > now))
            .cloned()
            .collect::<Vec<_>>();
        decisions.sort_by_key(|event| event.occurred_at);
        decisions
    }

    pub fn publish_decision(event: &ClaudeHookDecisionEvent, terminal_name: String) {
        let provider = event.provider.clone();
        let title = format!("{} 等待回答", agent_name(provider.as_deref()));
        let summary = event
            .questions
            .first()
            .map(|question| question.question.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("有 {} 项待处理，请打开 App 查看并回复", event.questions.len()));
        publish(AppNotificationEvent {
            id: format!("decision:{}", event.decision_id),
            kind: "decision".to_string(),
            terminal_id: event.terminal_id.clone(),
            terminal_name,
            provider,
            title,
            summary,
            decision_id: Some(event.decision_id.clone()),
            questions: event.questions.clone(),
            expires_at: Some(event.expires_at),
            occurred_at: event.occurred_at,
        });
    }

    /// 只发布完成 / 失败事件；运行中的心跳不进入通知通道。
    pub fn publish_terminal_result(event: &ClaudeHookTerminalEvent, terminal_name: String) {
        let failed = match event.phase.as_str() {
            "completed" => false,
            "failed" => true,
            _ => return,
        };
        let provider = event.provider.clone();
        let agent = agent_name(provider.as_deref());
        let task_title = event
            .task_title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let title = match task_title {
            Some(task) => format!("{}：{}", if failed { "任务失败" } else { "任务完成" }, task),
            None => format!("{agent} 任务{}", if failed { "执行失败" } else { "已完成" }),
        };
        let summary = event
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if failed {
                    format!("{agent} 未能完成当前任务。")
                } else {
                    format!("{agent} 已完成当前任务。")
                }
            });
        publish(AppNotificationEvent {
            id: format!("terminal:{}", event.event_id),
            kind: if failed { "failed" } else { "completed" }.to_string(),
            terminal_id: event.terminal_id.clone(),
            terminal_name,
            provider,
            title,
            summary,
            decision_id: None,
            questions: Vec::new(),
            expires_at: None,
            occurred_at: event.occurred_at,
        });
    }

    /// 终端列表变化（创建 / 关闭）：不产生通知栏提醒，仅作为 App 列表页的
    /// 实时刷新信号——手机端「最近会话」据此与电脑端保持同步，无需退出重进。
    pub fn publish_terminals_changed(terminal_id: &str, terminal_name: String, created: bool) {
        publish(AppNotificationEvent {
            id: format!("terminals:{}", uuid::Uuid::new_v4()),
            kind: "terminals_changed".to_string(),
            terminal_id: terminal_id.to_string(),
            terminal_name,
            provider: None,
            title: if created { "终端已创建".to_string() } else { "终端已关闭".to_string() },
            summary: String::new(),
            decision_id: None,
            questions: Vec::new(),
            expires_at: None,
            occurred_at: chrono::Utc::now().timestamp_millis(),
        });
    }

    pub fn publish_resolved(terminal_id: &str, terminal_name: String, decision_id: &str) {        publish(AppNotificationEvent {
            id: format!("resolved:{decision_id}"),
            kind: "resolved".to_string(),
            terminal_id: terminal_id.to_string(),
            terminal_name,
            provider: None,
            title: "决策已处理".to_string(),
            summary: String::new(),
            decision_id: Some(decision_id.to_string()),
            questions: Vec::new(),
            expires_at: None,
            occurred_at: chrono::Utc::now().timestamp_millis(),
        });
    }
}

fn publish(event: AppNotificationEvent) {
    if event.kind == "decision" {
        if let Some(decision_id) = event.decision_id.as_ref() {
            pending()
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .insert(decision_id.clone(), event.clone());
        }
    } else if event.kind == "resolved" {
        if let Some(decision_id) = event.decision_id.as_ref() {
            pending()
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .remove(decision_id);
        }
    }
    let _ = channel().send(event);
}

fn channel() -> &'static broadcast::Sender<AppNotificationEvent> {
    static CHANNEL: OnceLock<broadcast::Sender<AppNotificationEvent>> = OnceLock::new();
    CHANNEL.get_or_init(|| broadcast::channel(256).0)
}

fn pending() -> &'static Mutex<HashMap<String, AppNotificationEvent>> {
    static PENDING: OnceLock<Mutex<HashMap<String, AppNotificationEvent>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn agent_name(provider: Option<&str>) -> &'static str {
    match provider {
        Some("codex") => "Codex",
        _ => "Claude Code",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::claude_hook_service::{ClaudeHookOption, ClaudeHookQuestion};

    fn decision_event(id: &str) -> ClaudeHookDecisionEvent {
        ClaudeHookDecisionEvent {
            decision_id: id.to_string(),
            terminal_id: "terminal-test".to_string(),
            questions: vec![ClaudeHookQuestion {
                question: "继续吗？".to_string(),
                header: "确认".to_string(),
                options: vec![ClaudeHookOption { label: "继续".to_string(), description: None }],
                multi_select: false,
            }],
            expires_at: 9_999_999_999_999,
            occurred_at: 100,
            provider: Some("claude".to_string()),
        }
    }

    fn terminal_event(id: &str, phase: &str) -> ClaudeHookTerminalEvent {
        ClaudeHookTerminalEvent {
            event_id: id.to_string(),
            terminal_id: "terminal-test".to_string(),
            session_id: "session-test".to_string(),
            event_name: "Stop".to_string(),
            phase: phase.to_string(),
            occurred_at: 100,
            provider: Some("claude".to_string()),
            notification_type: None,
            title: None,
            message: None,
            task_title: Some("修复通知".to_string()),
            summary: Some("已完成".to_string()),
        }
    }

    #[test]
    fn decision_is_kept_until_resolved() {
        let id = format!("decision-test-{}", uuid::Uuid::new_v4());
        AppNotificationService::publish_decision(&decision_event(&id), "构建终端".to_string());
        assert!(AppNotificationService::pending_decisions()
            .iter()
            .any(|event| event.decision_id.as_deref() == Some(id.as_str())));
        AppNotificationService::publish_resolved("terminal-test", "构建终端".to_string(), &id);
        assert!(!AppNotificationService::pending_decisions()
            .iter()
            .any(|event| event.decision_id.as_deref() == Some(id.as_str())));
    }

    #[test]
    fn only_completed_or_failed_terminal_events_are_published() {
        let running = terminal_event(&uuid::Uuid::new_v4().to_string(), "running");
        AppNotificationService::publish_terminal_result(&running, "构建终端".to_string());
        let completed = terminal_event(&uuid::Uuid::new_v4().to_string(), "completed");
        let expected = format!("terminal:{}", completed.event_id);
        let mut receiver = AppNotificationService::subscribe();
        AppNotificationService::publish_terminal_result(&completed, "构建终端".to_string());
        let event = loop {
            match receiver.try_recv() {
                Ok(event) if event.id == expected => break event,
                Ok(_) => continue,
                Err(error) => panic!("未收到完成事件：{error}"),
            }
        };
        assert_eq!(event.kind, "completed");
        assert_eq!(event.title, "任务完成：修复通知");
        assert_eq!(event.id, expected);
    }
}

