use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use crate::runtime::{Emitter, Manager};

use crate::commands::TerminalService;
use crate::services::ai_chat_claude_hooks::{self as native_hooks, NativeHookEvent};
use crate::services::{
    AppNotificationService, ClaudeHookDecisionEvent, ClaudeHookQuestion,
    ClaudeHookResolution, ClaudeHookService, ClaudeHookTerminalEvent,
};

#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeHookRequest {
    session_id: String,
    hook_event_name: String,
    #[serde(default)]
    prompt_id: Option<String>,
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

fn terminal_name(app: &crate::runtime::AppHandle, terminal_id: &str) -> String {
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
        "UserPromptSubmit" => (
            compact_hook_text(request.prompt.as_deref(), 72)
                .or_else(|| ClaudeHookService::recent_prompt(terminal_id, &request.session_id)
                    .and_then(|prompt| compact_hook_text(Some(&prompt), 72))),
            None,
        ),
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

/// 只把仍在执行的后台工作算作忙碌；未来定时唤醒和辅助任务不会延长当前回合。
fn has_active_background_work(tasks: &[Value]) -> bool {
    tasks.iter().any(|task| {
        if task["ambient"] == true || task["awaited"] == true || task["type"] == "post_turn_memory" { return false; }
        !matches!(task["status"].as_str(), Some("completed" | "failed" | "stopped" | "cancelled" | "canceled"))
    })
}

fn is_actionable_notification(request: &ClaudeHookRequest) -> bool {
    request.notification_type.as_deref() == Some("permission_prompt")
}

fn emit_terminal_event(
    app: &crate::runtime::AppHandle,
    terminal_id: &str,
    request: &ClaudeHookRequest,
    phase: &str,
) -> bool {
    let session_start = request.hook_event_name == "SessionStart";
    crate::services::terminal_task_service::record_claude_session(
        terminal_id, &request.session_id, request.prompt.as_deref(), session_start,
    );
    let (task_title, summary) = task_content(terminal_id, request);
    let occurred_at = next_hook_timestamp();
    let event = ClaudeHookTerminalEvent {
        event_id: uuid::Uuid::new_v4().to_string(),
        terminal_id: terminal_id.to_string(),
        session_id: request.session_id.clone(),
        event_name: request.hook_event_name.clone(),
        phase: phase.to_string(),
        occurred_at,
        provider: Some("claude".to_string()),
        notification_type: request.notification_type.clone(),
        title: request.title.clone(),
        message: request.message.clone(),
        task_title,
        summary,
    };
    // relay 阶段表：键含 sessionId，且只有与当前绑定完全匹配才写入
    // （旧会话的迟到 SessionEnd 不会污染换绑后的新会话）。
    if !crate::services::terminal_agent_relay::note_claude_hook_phase(
        terminal_id, &request.session_id, &request.hook_event_name, request.prompt_id.as_deref(), phase, occurred_at,
    ) {
        eprintln!("[ClaudeHook] 忽略过期状态 terminal={} session={} event={} phase={}",
            terminal_id, request.session_id, request.hook_event_name, phase);
        return false;
    }
    if matches!(phase, "running" | "attention") {
        crate::services::terminal_agent_relay::monitor_claude_activity(app, terminal_id);
    }
    let _ = app.emit("claude-hook-terminal-event", event.clone());
    if matches!(phase, "completed" | "failed") {
        AppNotificationService::publish_terminal_result(&event, terminal_name(app, terminal_id));
    }
    true
}

fn settle_decision(
    app: &crate::runtime::AppHandle, terminal_id: &str, decision_id: &str, resolution: Option<&str>,
) {
    if native_hooks::is_native_target(terminal_id) {
        let _ = native_hooks::publish(terminal_id, NativeHookEvent::Settled(decision_id.into()));
    } else {
        let event = if resolution.is_some() { "claude-hook-decision-resolved" } else { "claude-hook-decision-expired" };
        let mut payload = json!({"decisionId":decision_id,"terminalId":terminal_id,"occurredAt":next_hook_timestamp()});
        if let Some(resolution) = resolution { payload["resolution"] = json!(resolution); }
        let _ = app.emit(event, payload);
        AppNotificationService::publish_resolved(
            terminal_id,
            terminal_name(app, terminal_id),
            decision_id,
        );
    }
}

pub(crate) async fn claude_hook(
    headers: HeaderMap,
    State(app): State<crate::runtime::AppHandle>,
    Json(request): Json<ClaudeHookRequest>,
) -> Response {
    let terminal_id = header_value(&headers, "x-terminalbuddy-terminal-id");
    let authorization = header_value(&headers, "authorization");
    let token = authorization.strip_prefix("Bearer ").unwrap_or_default();
    if terminal_id.is_empty() || !ClaudeHookService::validate_terminal(terminal_id, token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let native = native_hooks::is_native_target(terminal_id);
    if native && request.hook_event_name != "PreToolUse" { return StatusCode::NO_CONTENT.into_response(); }
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
            let background_pending = has_active_background_work(&request.background_tasks);
            eprintln!("[ClaudeHook] Stop terminal={} background_tasks={} blocking={} scheduled_crons={}",
                terminal_id, request.background_tasks.len(), background_pending, request.session_crons.len());
            if background_pending {
                if crate::services::terminal_agent_relay::hold_for_background_work(
                    terminal_id, &request.session_id, request.prompt_id.as_deref(), next_hook_timestamp(),
                ) {
                    crate::services::terminal_agent_relay::monitor_claude_activity(&app, terminal_id);
                }
            } else {
                // session_crons 是未来唤醒计划，不代表此刻仍在执行。
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

    if request.hook_event_name != "PreToolUse" {
        return StatusCode::NO_CONTENT.into_response();
    }
    if request.tool_name.as_deref() != Some("AskUserQuestion") {
        // 工具调用心跳：Claude 正在活跃执行，刷新 running 指示灯，
        // 避免长任务超过 30 分钟无事件时被过期兜底误灭
        if !native { emit_terminal_event(&app, terminal_id, &request, "running"); }
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

    if !native && !emit_terminal_event(&app, terminal_id, &request, "attention") {
        return StatusCode::NO_CONTENT.into_response();
    }
    let decision_id = if native { uuid::Uuid::new_v4().to_string() } else { format!(
        "{}:{}:{}", request.session_id, tool_use_id, uuid::Uuid::new_v4()
    ) };
    let occurred_at = next_hook_timestamp();
    let expires_at = occurred_at + ClaudeHookService::http_wait_cap().as_millis() as i64;
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
        provider: Some("claude".to_string()),
    };
    if native {
        if native_hooks::publish(terminal_id, NativeHookEvent::Decision(event)).is_err() {
            ClaudeHookService::expire_decision(&decision_id);
            return (StatusCode::GONE, "Claude 会话已结束").into_response();
        }
    } else {
        let _ = app.emit("claude-hook-decision", &event);
        AppNotificationService::publish_decision(&event, terminal_name(&app, terminal_id));
    }

    // 决策只跟随当前 Hook 请求等待，不使用用户可配置的延迟。
    // 原生会话过期后返回 deny，避免再退回 stdio 产生第二次用户提问。
    let outcome = tokio::time::timeout(ClaudeHookService::http_wait_cap(), receiver).await;
    let resolution = match &outcome {
        Ok(Ok(ClaudeHookResolution::Answers(_))) => Some("answered"),
        Ok(Ok(ClaudeHookResolution::ContinueInTerminal)) => Some("continueInTerminal"),
        Ok(Ok(ClaudeHookResolution::Denied)) => Some("declined"),
        _ => { ClaudeHookService::expire_decision(&decision_id); None }
    };
    settle_decision(&app, terminal_id, &decision_id, resolution);
    match outcome {
        Ok(Ok(ClaudeHookResolution::Answers(answers))) => Json(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "已通过 TerminalBuddy 收集用户决策",
                "updatedInput": { "questions": questions, "answers": answers }
            }
        })).into_response(),
        Ok(Ok(ClaudeHookResolution::ContinueInTerminal)) if !native => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(ClaudeHookResolution::Denied | ClaudeHookResolution::ContinueInTerminal)) => Json(json!({
            "hookSpecificOutput": {"hookEventName":"PreToolUse","permissionDecision":"deny",
                "permissionDecisionReason":"用户暂不回答或会话已结束，请根据现有信息继续。"}
        })).into_response(),
        _ if native => Json(json!({
            "hookSpecificOutput": {"hookEventName":"PreToolUse","permissionDecision":"deny",
                "permissionDecisionReason":"本次决策已过期，请根据现有信息继续，必要时重新提问。"}
        })).into_response(),
        _ => StatusCode::NO_CONTENT.into_response(),
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn answer_claude_hook_decision(
    decision_id: String,
    answers: HashMap<String, String>,
) -> Result<(), String> {
    ClaudeHookService::answer_all(&decision_id, answers)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn continue_claude_hook_in_terminal(decision_id: String) -> Result<(), String> {
    ClaudeHookService::continue_in_terminal(&decision_id)
}

// ── 浏览器侧决策权限修正（终端 Agent 接力同里程碑交付，§5.5） ──
// 此前浏览器调用这三个命令可枚举并回答 PC 终端的待决策；现在按 Web View/Input
// 逐终端授权过滤。Pc 原生命令行为不变。

/// 浏览器：只返回 Web 当前可查看的待决策（按 View 过滤目标终端）。
pub(crate) fn pending_decisions_for_web(app: &crate::runtime::AppHandle) -> Vec<ClaudeHookDecisionEvent> {
    let service = app.state::<crate::commands::TerminalService>();
    get_pending_claude_hook_decisions()
        .into_iter()
        .filter(|decision| {
            service
                .authorize(&decision.terminal_id, crate::models::TerminalActor::Web, crate::models::TerminalAction::View)
                .is_ok()
        })
        .collect()
}

/// 回答 / 返回终端都要求对该决策所在终端有 Input 权限；
/// 决策已不存在时交给底层返回「已失效」，不在此处猜结果。
fn ensure_web_decision_input(app: &crate::runtime::AppHandle, decision_id: &str) -> Result<(), String> {
    let Some(decision) = ClaudeHookService::list_pending_decisions()
        .into_iter()
        .find(|decision| decision.decision_id == decision_id)
    else {
        return Ok(());
    };
    app.state::<crate::commands::TerminalService>()
        .authorize(&decision.terminal_id, crate::models::TerminalActor::Web, crate::models::TerminalAction::Input)
        .map_err(|error| error.to_string())
}

pub(crate) fn answer_decision_for_web(
    app: &crate::runtime::AppHandle,
    decision_id: &str,
    answers: HashMap<String, String>,
) -> Result<(), String> {
    ensure_web_decision_input(app, decision_id)?;
    answer_claude_hook_decision(decision_id.to_string(), answers)
}

pub(crate) fn continue_decision_for_web(app: &crate::runtime::AppHandle, decision_id: &str) -> Result<(), String> {
    ensure_web_decision_input(app, decision_id)?;
    continue_claude_hook_in_terminal(decision_id.to_string())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_pending_claude_hook_decisions() -> Vec<ClaudeHookDecisionEvent> {
    ClaudeHookService::list_pending_decisions().into_iter()
        .filter(|decision| !native_hooks::is_native_target(&decision.terminal_id)).collect()
}

#[cfg(test)]
mod tests {
    use super::{
        compact_hook_text, has_active_background_work, is_actionable_notification, next_hook_timestamp, task_content,
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
    fn scheduled_wakeups_and_finished_background_tasks_do_not_keep_a_turn_running() {
        let request: ClaudeHookRequest = serde_json::from_value(json!({
            "session_id":"session", "hook_event_name":"Stop",
            "background_tasks":[{"status":"completed"},{"status":"failed"},{"status":"stopped"}],
            "session_crons":[{"id":"later","schedule":"*/5 * * * *"}]
        })).unwrap();
        assert!(!request.session_crons.is_empty());
        assert!(!has_active_background_work(&request.background_tasks));
        assert!(!has_active_background_work(&[
            json!({"status":"running","ambient":true}),
            json!({"status":"running","awaited":true}),
            json!({"status":"running","type":"post_turn_memory"}),
        ]));
        assert!(has_active_background_work(&[json!({"status":"running","type":"local_bash"})]));
        assert!(has_active_background_work(&[json!({"status":"pending","type":"local_agent"})]));
        assert!(has_active_background_work(&[json!({"id":"unknown-status"})]), "未知状态保守保留后台执行");
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
