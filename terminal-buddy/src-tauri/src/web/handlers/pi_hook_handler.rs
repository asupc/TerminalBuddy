//! Pi Agent Hook 端点：接收 Pi 扩展上报的会话/任务/工具事件。
//!
//! 鉴权沿用终端 token：`Authorization: Bearer <TERMINAL_BUDDY_HOOK_TOKEN>` 与
//! `X-TerminalBuddy-Terminal-Id`。工具确认复用 Claude 的 pending decision 基础设施，
//! 默认关闭；扩展只有在终端环境启用审批时才会发 `ToolApproval` 请求。
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, Ordering};

use crate::runtime::Emitter;
use crate::services::{
    AppNotificationService, ClaudeHookDecisionEvent, ClaudeHookOption, ClaudeHookQuestion,
    ClaudeHookResolution, ClaudeHookService, ClaudeHookTerminalEvent,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiHookRequest {
    session_id: String,
    #[serde(default)]
    session_file: Option<String>,
    event: String,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    tool_input: Option<Value>,
    #[serde(default)]
    last_assistant_message: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
}

fn next_timestamp() -> i64 {
    static LAST: AtomicI64 = AtomicI64::new(0);
    loop {
        let previous = LAST.load(Ordering::SeqCst);
        let now = Utc::now().timestamp_millis();
        let next = now.max(previous.saturating_add(1));
        if LAST.compare_exchange(previous, next, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            return next;
        }
    }
}

fn compact(value: Option<&str>, limit: usize) -> Option<String> {
    let compact = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() { return None; }
    if compact.chars().count() <= limit {
        Some(compact)
    } else {
        let mut text: String = compact.chars().take(limit.saturating_sub(1)).collect();
        text.push('…');
        Some(text)
    }
}

fn tool_summary(input: Option<&Value>) -> String {
    let Some(input) = input else { return String::new(); };
    let text = ["command", "cmd", "file_path", "path", "query", "pattern", "input"]
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_else(|| input.to_string());
    compact(Some(&text), 160).unwrap_or_default()
}

fn emit_event(app: &crate::runtime::AppHandle, terminal_id: &str, request: &PiHookRequest, phase: &str) {
    let task_title = compact(request.prompt.as_deref(), 72);
    let summary = match request.event.as_str() {
        "Stop" => compact(request.last_assistant_message.as_deref(), 220),
        "StopFailure" => compact(request.reason.as_deref(), 220),
        _ => None,
    };
    let occurred_at = next_timestamp();
    let event = ClaudeHookTerminalEvent {
        event_id: uuid::Uuid::new_v4().to_string(),
        terminal_id: terminal_id.to_string(),
        session_id: request.session_id.clone(),
        event_name: request.event.clone(),
        phase: phase.to_string(),
        occurred_at,
        provider: Some("pi".to_string()),
        notification_type: None,
        title: None,
        message: request.reason.clone(),
        task_title,
        summary,
    };
    // relay 阶段表：Pi 以扩展明确的 SessionStart 事件允许换绑；阶段键含 sessionId。
    crate::services::terminal_agent_relay::note_phase(terminal_id, "pi", &request.session_id, phase, occurred_at);
    let _ = app.emit("claude-hook-terminal-event", event.clone());
    AppNotificationService::publish_terminal_result(
        &event,
        crate::services::app_notification_service::terminal_name(app, terminal_id),
    );
}

fn approval_question(request: &PiHookRequest) -> ClaudeHookQuestion {
    let tool_name = request.tool_name.as_deref().unwrap_or("工具");
    let summary = tool_summary(request.tool_input.as_ref());
    ClaudeHookQuestion {
        question: if summary.is_empty() {
            format!("Pi 请求执行工具「{tool_name}」。是否允许？")
        } else {
            format!("Pi 请求执行工具「{tool_name}」：{summary}。是否允许？")
        },
        header: "Pi 工具确认".to_string(),
        options: vec![
            ClaudeHookOption { label: "允许".to_string(), description: Some("本次执行该工具".to_string()) },
            ClaudeHookOption { label: "拒绝".to_string(), description: Some("阻止本次工具调用".to_string()) },
        ],
        multi_select: false,
    }
}

async fn tool_approval(
    app: &crate::runtime::AppHandle,
    terminal_id: &str,
    request: &PiHookRequest,
) -> Response {
    // 审批开始即进入 attention（relay 阶段表与决策卡片独立表示）。
    crate::services::terminal_agent_relay::note_phase(
        terminal_id,
        "pi",
        &request.session_id,
        "attention",
        next_timestamp(),
    );
    let question = approval_question(request);
    let decision_id = format!("pi:{}:{}", request.session_id, uuid::Uuid::new_v4());
    let occurred_at = next_timestamp();
    let ttl_minutes = crate::services::BotSettingsService::get_runtime()
        .map(|settings| settings.decision_ttl_minutes.clamp(1, 1440))
        .unwrap_or(10);
    let expires_at = occurred_at + Duration::minutes(ttl_minutes as i64).num_milliseconds();
    let receiver = match ClaudeHookService::insert_decision(
        decision_id.clone(),
        terminal_id.to_string(),
        vec![question.clone()],
        expires_at,
        occurred_at,
    ) {
        Ok(receiver) => receiver,
        Err(reason) => return (StatusCode::TOO_MANY_REQUESTS, reason.message()).into_response(),
    };
    let event = ClaudeHookDecisionEvent {
        decision_id: decision_id.clone(),
        terminal_id: terminal_id.to_string(),
        questions: vec![question.clone()],
        expires_at,
        occurred_at,
        provider: Some("pi".to_string()),
    };
    let _ = app.emit("claude-hook-decision", &event);
    AppNotificationService::publish_decision(
        &event,
        crate::services::app_notification_service::terminal_name(app, terminal_id),
    );
    // 审批超时默认放行，避免把 Pi 卡死（与计划中的安全约束一致）。
    let wait = std::time::Duration::from_secs((ttl_minutes as u64) * 60)
        .min(ClaudeHookService::http_wait_cap())
        .min(std::time::Duration::from_secs(10 * 60));
    let outcome = tokio::time::timeout(wait, receiver).await;
    let resolution = match &outcome {
        Ok(Ok(ClaudeHookResolution::Answers(answers))) => {
            let allowed = answers
                .values()
                .any(|value| value.contains("允许") || value.eq_ignore_ascii_case("allow"));
            Some(if allowed { "answered" } else { "declined" })
        }
        Ok(Ok(ClaudeHookResolution::Denied)) => Some("declined"),
        Ok(Ok(ClaudeHookResolution::ContinueInTerminal)) => None,
        _ => None,
    };
    AppNotificationService::publish_resolved(
        terminal_id,
        crate::services::app_notification_service::terminal_name(app, terminal_id),
        &decision_id,
    );
    if let Some(resolution) = resolution {
        let _ = app.emit("claude-hook-decision-resolved", json!({
            "decisionId": decision_id,
            "terminalId": terminal_id,
            "occurredAt": next_timestamp(),
            "resolution": resolution,
        }));
    } else {
        ClaudeHookService::expire_decision(&decision_id);
        let _ = app.emit("claude-hook-decision-expired", json!({
            "decisionId": decision_id,
            "terminalId": terminal_id,
            "occurredAt": next_timestamp(),
        }));
    }
    let allow = match outcome {
        Ok(Ok(ClaudeHookResolution::Answers(answers))) => answers
            .values()
            .any(|value| value.contains("允许") || value.eq_ignore_ascii_case("allow")),
        Ok(Ok(ClaudeHookResolution::Denied)) => false,
        // 超时或转回终端：默认放行，保持 Pi 原生行为。
        _ => true,
    };
    // 审批完成 / 超时 / 返回终端后回到 running；已结束或已换绑则不覆盖。
    crate::services::terminal_agent_relay::note_phase_unless_ended(
        terminal_id,
        "pi",
        &request.session_id,
        "running",
        next_timestamp(),
    );
    Json(json!({ "allow": allow })).into_response()
}

pub(crate) async fn pi_hook(
    headers: HeaderMap,
    State(app): State<crate::runtime::AppHandle>,
    Json(request): Json<PiHookRequest>,
) -> Response {
    let terminal_id = header_value(&headers, "x-terminalbuddy-terminal-id");
    let authorization = header_value(&headers, "authorization");
    let token = authorization.strip_prefix("Bearer ").unwrap_or_default();
    if terminal_id.is_empty() || !ClaudeHookService::validate_terminal(terminal_id, token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    crate::services::terminal_task_service::record_agent_session(
        terminal_id,
        "pi",
        &request.session_id,
        request.session_file.as_deref(),
        // 普通 ToolCall / Input 不越过已有不同绑定；仅 SessionStart 可换绑。
        request.event == "SessionStart",
    );
    if let Some(cwd) = request.cwd.as_deref() {
        let _ = crate::services::claude_session_registry_service::record(
            terminal_id,
            "pi",
            &request.session_id,
            request.session_file.clone(),
            Some(cwd.to_string()),
            next_timestamp() as u64,
        );
    }
    match request.event.as_str() {
        "SessionStart" => {
            emit_event(&app, terminal_id, &request, "idle");
            StatusCode::NO_CONTENT.into_response()
        }
        "UserPromptSubmit" | "Input" => {
            emit_event(&app, terminal_id, &request, "running");
            StatusCode::NO_CONTENT.into_response()
        }
        "ToolCall" => {
            emit_event(&app, terminal_id, &request, "running");
            StatusCode::NO_CONTENT.into_response()
        }
        "ToolApproval" => tool_approval(&app, terminal_id, &request).await,
        "Stop" => {
            emit_event(&app, terminal_id, &request, "completed");
            StatusCode::NO_CONTENT.into_response()
        }
        "StopFailure" => {
            emit_event(&app, terminal_id, &request, "failed");
            StatusCode::NO_CONTENT.into_response()
        }
        "SessionEnd" => {
            emit_event(&app, terminal_id, &request, "ended");
            StatusCode::NO_CONTENT.into_response()
        }
        _ => StatusCode::NO_CONTENT.into_response(),
    }
}
