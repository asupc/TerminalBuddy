use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use tauri::{Emitter, Manager};

use crate::commands::{send_bot_notification, TerminalService};
use crate::models::{BotDecisionOption, BotNotificationRequest};
use crate::services::{
    card_decision_id, BotSettingsService, ClaudeHookDecisionEvent, ClaudeHookQuestion,
    ClaudeHookResolution, ClaudeHookService, ClaudeHookTerminalEvent,
};

#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeHookRequest {
    session_id: String,
    hook_event_name: String,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    last_assistant_message: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    tool_use_id: Option<String>,
    #[serde(default)]
    tool_input: Option<ClaudeHookToolInput>,
    #[serde(default)]
    background_tasks: Vec<Value>,
    #[serde(default)]
    session_crons: Vec<Value>,
    #[serde(default)]
    notification_type: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeHookToolInput {
    #[serde(default)]
    questions: Vec<ClaudeHookQuestion>,
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
}

fn terminal_name(app: &tauri::AppHandle, terminal_id: &str) -> String {
    app.state::<TerminalService>()
        .list_terminals_info()
        .into_iter()
        .find(|terminal| terminal.id == terminal_id)
        .map(|terminal| terminal.profile_name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Claude Code".to_string())
}

fn next_hook_timestamp() -> i64 {
    static LAST_TIMESTAMP: AtomicI64 = AtomicI64::new(0);
    loop {
        let previous = LAST_TIMESTAMP.load(Ordering::SeqCst);
        let now = Utc::now().timestamp_millis();
        let next = now.max(previous.saturating_add(1));
        if LAST_TIMESTAMP
            .compare_exchange(previous, next, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return next;
        }
    }
}

fn compact_whitespace(value: &str) -> Option<String> {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!compact.is_empty()).then_some(compact)
}

fn truncate_unicode(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    if max_chars == 0 {
        return String::new();
    }
    let mut result = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

fn compact_hook_text(value: Option<&str>, max_chars: usize) -> Option<String> {
    compact_whitespace(value?)
        .map(|compact| truncate_unicode(&compact, max_chars))
        .filter(|compact| !compact.is_empty())
}

fn task_content(
    terminal_id: &str,
    request: &ClaudeHookRequest,
) -> (Option<String>, Option<String>) {
    match request.hook_event_name.as_str() {
        "Stop" => (
            ClaudeHookService::recent_prompt(terminal_id, &request.session_id)
                .and_then(|prompt| compact_hook_text(Some(&prompt), 72)),
            compact_hook_text(request.last_assistant_message.as_deref(), 220),
        ),
        "StopFailure" => (
            ClaudeHookService::recent_prompt(terminal_id, &request.session_id)
                .and_then(|prompt| compact_hook_text(Some(&prompt), 72)),
            compact_hook_text(request.reason.as_deref(), 220)
                .or_else(|| compact_hook_text(request.message.as_deref(), 220))
                .or_else(|| compact_hook_text(request.last_assistant_message.as_deref(), 220)),
        ),
        _ => (None, None),
    }
}

fn is_actionable_notification(request: &ClaudeHookRequest) -> bool {
    request.notification_type.as_deref() == Some("permission_prompt")
}

fn emit_terminal_event(
    app: &tauri::AppHandle,
    terminal_id: &str,
    request: &ClaudeHookRequest,
    phase: &str,
) {
    let (task_title, summary) = task_content(terminal_id, request);
    let event = ClaudeHookTerminalEvent {
        event_id: uuid::Uuid::new_v4().to_string(),
        terminal_id: terminal_id.to_string(),
        session_id: request.session_id.clone(),
        event_name: request.hook_event_name.clone(),
        phase: phase.to_string(),
        occurred_at: next_hook_timestamp(),
        notification_type: request.notification_type.clone(),
        title: request.title.clone(),
        message: request.message.clone(),
        task_title,
        summary,
    };
    let _ = app.emit("claude-hook-terminal-event", event);
}

pub(crate) async fn claude_hook(
    headers: HeaderMap,
    State(app): State<tauri::AppHandle>,
    Json(request): Json<ClaudeHookRequest>,
) -> Response {
    let terminal_id = header_value(&headers, "x-terminalbuddy-terminal-id");
    let authorization = header_value(&headers, "authorization");
    let token = authorization.strip_prefix("Bearer ").unwrap_or_default();
    if terminal_id.is_empty() || !ClaudeHookService::validate_terminal(terminal_id, token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    match request.hook_event_name.as_str() {
        "SessionStart" => {
            ClaudeHookService::clear_session_prompt(terminal_id, &request.session_id);
            emit_terminal_event(&app, terminal_id, &request, "idle");
            return StatusCode::NO_CONTENT.into_response();
        }
        "UserPromptSubmit" => {
            if let Some(prompt) = compact_hook_text(request.prompt.as_deref(), 72) {
                ClaudeHookService::remember_prompt(terminal_id, &request.session_id, prompt);
            }
            emit_terminal_event(&app, terminal_id, &request, "running");
            return StatusCode::NO_CONTENT.into_response();
        }
        "Notification" => {
            if is_actionable_notification(&request) {
                emit_terminal_event(&app, terminal_id, &request, "attention");
            }
            return StatusCode::NO_CONTENT.into_response();
        }
        "Stop" => {
            if request.background_tasks.is_empty() && request.session_crons.is_empty() {
                emit_terminal_event(&app, terminal_id, &request, "completed");
            }
            return StatusCode::NO_CONTENT.into_response();
        }
        "StopFailure" => {
            emit_terminal_event(&app, terminal_id, &request, "failed");
            return StatusCode::NO_CONTENT.into_response();
        }
        "SessionEnd" => {
            emit_terminal_event(&app, terminal_id, &request, "ended");
            ClaudeHookService::clear_session_prompt(terminal_id, &request.session_id);
            return StatusCode::NO_CONTENT.into_response();
        }
        _ => {}
    }

    if request.hook_event_name != "PreToolUse"
        || request.tool_name.as_deref() != Some("AskUserQuestion")
    {
        return StatusCode::NO_CONTENT.into_response();
    }
    let Some(tool_use_id) = request
        .tool_use_id
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return (StatusCode::BAD_REQUEST, "缺少 tool_use_id").into_response();
    };
    let questions = request
        .tool_input
        .as_ref()
        .map(|input| input.questions.clone())
        .unwrap_or_default();
    if questions.is_empty() {
        return StatusCode::NO_CONTENT.into_response();
    }

    emit_terminal_event(&app, terminal_id, &request, "attention");
    let decision_id = format!(
        "{}:{}:{}",
        request.session_id,
        tool_use_id,
        uuid::Uuid::new_v4()
    );
    let bot_settings = BotSettingsService::get_runtime().unwrap_or_default();
    let ttl_minutes = bot_settings.decision_ttl_minutes.clamp(1, 1440);
    let occurred_at = next_hook_timestamp();
    let expires_at = occurred_at + Duration::minutes(ttl_minutes as i64).num_milliseconds();
    // 上限检查失败：不建通道、不发通知卡片，hook 请求立刻带原因失败，
    // 不占用 HTTP 连接和 pending 资源。
    let receiver = match ClaudeHookService::insert_decision(
        decision_id.clone(),
        terminal_id.to_string(),
        questions.clone(),
        expires_at,
        occurred_at,
    ) {
        Ok(receiver) => receiver,
        Err(reject_reason) => {
            eprintln!(
                "[ClaudeHook] 决策请求被拒绝，terminal={}，原因：{}",
                terminal_id,
                reject_reason.message()
            );
            return (StatusCode::TOO_MANY_REQUESTS, reject_reason.message()).into_response();
        }
    };
    let event = ClaudeHookDecisionEvent {
        decision_id: decision_id.clone(),
        terminal_id: terminal_id.to_string(),
        questions: questions.clone(),
        expires_at,
        occurred_at,
    };
    let _ = app.emit("claude-hook-decision", &event);

    // 业务 TTL（decisionTtlMinutes）决定决策在 pending 表的存活期；
    // 单次 HTTP 连接的挂起时间另设上限，24 小时 TTL 不会把连接挂 24 小时。
    // 连接先断时决策仍留在 pending 表，TTL 内可在桌面上继续回答。
    let http_wait = std::time::Duration::from_secs((ttl_minutes as u64) * 60)
        .min(ClaudeHookService::http_wait_cap());
    match tokio::time::timeout(http_wait, receiver).await
    {
        Ok(Ok(ClaudeHookResolution::Answers(answers))) => {
            let _ = app.emit(
                "claude-hook-decision-resolved",
                json!({
                    "decisionId": decision_id,
                    "terminalId": terminal_id,
                    "occurredAt": next_hook_timestamp(),
                    "resolution": "answered",
                }),
            );
            Json(json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "已通过 TerminalBuddy 收集用户决策",
                    "updatedInput": {
                        "questions": questions,
                        "answers": answers
                    }
                }
            }))
            .into_response()
        }
        Ok(Ok(ClaudeHookResolution::ContinueInTerminal)) => {
            let _ = app.emit(
                "claude-hook-decision-resolved",
                json!({
                    "decisionId": decision_id,
                    "terminalId": terminal_id,
                    "occurredAt": next_hook_timestamp(),
                    "resolution": "continueInTerminal",
                }),
            );
            StatusCode::NO_CONTENT.into_response()
        }
        _ => {
            ClaudeHookService::expire_decision(&decision_id);
            let _ = app.emit(
                "claude-hook-decision-expired",
                json!({
                    "decisionId": decision_id,
                    "terminalId": terminal_id,
                    "occurredAt": next_hook_timestamp(),
                }),
            );
            StatusCode::NO_CONTENT.into_response()
        }
    }
}

#[tauri::command]
pub fn answer_claude_hook_decision(
    decision_id: String,
    answers: HashMap<String, String>,
) -> Result<(), String> {
    ClaudeHookService::answer_all(&decision_id, answers)
}

#[tauri::command]
pub fn continue_claude_hook_in_terminal(decision_id: String) -> Result<(), String> {
    ClaudeHookService::continue_in_terminal(&decision_id)
}

#[tauri::command]
pub fn get_pending_claude_hook_decisions() -> Vec<ClaudeHookDecisionEvent> {
    ClaudeHookService::list_pending_decisions()
}

#[tauri::command]
pub async fn send_claude_hook_decision_notification(
    app: tauri::AppHandle,
    decision_id: String,
) -> Result<(), String> {
    let Some(lease) = ClaudeHookService::begin_notification(&decision_id) else {
        return Ok(());
    };
    let terminal_id = lease.terminal_id;
    let questions = lease.questions;
    let generation = lease.generation;
    let name = terminal_name(&app, &terminal_id);
    for (question_index, question) in questions.iter().enumerate() {
        if !ClaudeHookService::notification_is_current(&decision_id, generation) {
            ClaudeHookService::cancel_notification_cards(&decision_id, questions.len());
            return Ok(());
        }
        let options = question
            .options
            .iter()
            .enumerate()
            .map(|(index, option)| BotDecisionOption {
                label: option.label.clone(),
                description: option.description.clone(),
                move_count: index as i16,
                recommended: index == 0 && !question.multi_select,
                selected: false,
            })
            .collect::<Vec<_>>();
        let notification = BotNotificationRequest {
            event_id: uuid::Uuid::new_v4().to_string(),
            decision_id: Some(card_decision_id(&decision_id, question_index)),
            terminal_id: terminal_id.clone(),
            terminal_name: name.clone(),
            kind: "question".to_string(),
            title: "Claude Code 等待回答".to_string(),
            summary: question.question.clone(),
            decision_title: Some(question.header.clone()),
            decision_question: Some(question.question.clone()),
            decision_options: Some(options),
            decision_multi_select: question.multi_select,
            decision_submit_move_count: None,
            custom_option_down_count: None,
        };
        let reports = match send_bot_notification(notification).await {
            Ok(reports) => reports,
            Err(error) => {
                ClaudeHookService::finish_notification(&decision_id, generation, false);
                return Err(error);
            }
        };
        if !ClaudeHookService::notification_is_current(&decision_id, generation) {
            ClaudeHookService::cancel_notification_cards(&decision_id, questions.len());
            return Ok(());
        }
        for report in reports.into_iter().filter(|report| !report.success) {
            eprintln!(
                "[ClaudeHook] 通道“{}”发送失败: {}",
                report.channel_name,
                report.error.unwrap_or_default()
            );
        }
    }
    ClaudeHookService::finish_notification(&decision_id, generation, true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        compact_hook_text, is_actionable_notification, next_hook_timestamp, task_content,
        truncate_unicode, ClaudeHookRequest,
    };
    use crate::services::ClaudeHookService;
    use serde_json::json;

    #[test]
    fn hook_timestamps_are_strictly_monotonic() {
        let first = next_hook_timestamp();
        let second = next_hook_timestamp();
        assert!(second > first);
    }

    #[test]
    fn hook_text_is_compact_and_truncated_on_unicode_boundaries() {
        assert_eq!(
            compact_hook_text(Some("  第一行\n\t第二行   内容  "), 20).as_deref(),
            Some("第一行 第二行 内容")
        );
        assert_eq!(truncate_unicode("甲乙丙丁戊", 4), "甲乙丙…");
        assert_eq!(truncate_unicode("Claude", 6), "Claude");
    }

    #[test]
    fn stop_uses_recent_prompt_and_last_assistant_message() {
        let terminal_id = format!("terminal-{}", uuid::Uuid::new_v4());
        let session_id = format!("session-{}", uuid::Uuid::new_v4());
        ClaudeHookService::remember_prompt(
            &terminal_id,
            &session_id,
            "  修复\n通知逻辑  ".to_string(),
        );
        let request: ClaudeHookRequest = serde_json::from_value(json!({
            "session_id": session_id,
            "hook_event_name": "Stop",
            "last_assistant_message": " 已完成修改。\n 编译检查通过。 "
        }))
        .unwrap();

        let (title, summary) = task_content(&terminal_id, &request);
        assert_eq!(title.as_deref(), Some("修复 通知逻辑"));
        assert_eq!(summary.as_deref(), Some("已完成修改。 编译检查通过。"));
        ClaudeHookService::unregister_terminal(&terminal_id);
    }

    #[test]
    fn stop_failure_prefers_reason_and_falls_back_to_message() {
        let with_reason: ClaudeHookRequest = serde_json::from_value(json!({
            "session_id": "failure-session",
            "hook_event_name": "StopFailure",
            "reason": " 工具执行失败 ",
            "message": "备用信息"
        }))
        .unwrap();
        let (_, summary) = task_content("failure-terminal", &with_reason);
        assert_eq!(summary.as_deref(), Some("工具执行失败"));

        let with_message: ClaudeHookRequest = serde_json::from_value(json!({
            "session_id": "failure-session",
            "hook_event_name": "StopFailure",
            "reason": "  ",
            "message": " 网络连接中断 "
        }))
        .unwrap();
        let (_, summary) = task_content("failure-terminal", &with_message);
        assert_eq!(summary.as_deref(), Some("网络连接中断"));

        let with_last_message: ClaudeHookRequest = serde_json::from_value(json!({
            "session_id": "failure-session",
            "hook_event_name": "StopFailure",
            "last_assistant_message": " 无法完成请求 "
        }))
        .unwrap();
        let (_, summary) = task_content("failure-terminal", &with_last_message);
        assert_eq!(summary.as_deref(), Some("无法完成请求"));
    }

    #[test]
    fn only_permission_notifications_require_attention() {
        let permission: ClaudeHookRequest = serde_json::from_value(json!({
            "session_id": "notification-session",
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt"
        }))
        .unwrap();
        let idle: ClaudeHookRequest = serde_json::from_value(json!({
            "session_id": "notification-session",
            "hook_event_name": "Notification",
            "notification_type": "idle_prompt"
        }))
        .unwrap();

        assert!(is_actionable_notification(&permission));
        assert!(!is_actionable_notification(&idle));
    }
}
