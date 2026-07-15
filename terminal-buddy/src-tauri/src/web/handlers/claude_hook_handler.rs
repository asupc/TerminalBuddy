use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{Emitter, Manager};

use crate::commands::{send_bot_notification, TerminalService};
use crate::models::{BotDecisionOption, BotNotificationRequest};
use crate::services::{
    card_decision_id, BotSettingsService, ClaudeHookDecisionEvent, ClaudeHookQuestion,
    ClaudeHookResolution, ClaudeHookService,
};

#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeHookRequest {
    session_id: String,
    hook_event_name: String,
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

    if request.hook_event_name == "Stop" {
        if !request.background_tasks.is_empty() || !request.session_crons.is_empty() {
            return StatusCode::NO_CONTENT.into_response();
        }
        let _ = app.emit("claude-hook-completed", json!({
            "terminalId": terminal_id,
            "sessionId": request.session_id,
        }));
        return StatusCode::NO_CONTENT.into_response();
    }

    if request.hook_event_name != "PreToolUse"
        || request.tool_name.as_deref() != Some("AskUserQuestion")
    {
        return StatusCode::NO_CONTENT.into_response();
    }
    let Some(tool_use_id) = request.tool_use_id.filter(|value| !value.is_empty()) else {
        return (StatusCode::BAD_REQUEST, "缺少 tool_use_id").into_response();
    };
    let questions = request.tool_input.map(|input| input.questions).unwrap_or_default();
    if questions.is_empty() {
        return StatusCode::NO_CONTENT.into_response();
    }

    let decision_id = format!("{}:{}", request.session_id, tool_use_id);
    let bot_settings = BotSettingsService::get_runtime().unwrap_or_default();
    let ttl_minutes = bot_settings.decision_ttl_minutes.clamp(1, 1440);
    let expires_at = (Utc::now() + Duration::minutes(ttl_minutes as i64)).timestamp_millis();
    let receiver = ClaudeHookService::insert_decision(
        decision_id.clone(),
        terminal_id.to_string(),
        questions.clone(),
    );
    let event = ClaudeHookDecisionEvent {
        decision_id: decision_id.clone(),
        terminal_id: terminal_id.to_string(),
        questions: questions.clone(),
        expires_at,
    };
    let _ = app.emit("claude-hook-decision", &event);

    match tokio::time::timeout(
        std::time::Duration::from_secs((ttl_minutes as u64) * 60),
        receiver,
    )
    .await
    {
        Ok(Ok(ClaudeHookResolution::Answers(answers))) => {
            let _ = app.emit("claude-hook-decision-resolved", json!({ "decisionId": decision_id }));
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
            let _ = app.emit("claude-hook-decision-resolved", json!({ "decisionId": decision_id }));
            StatusCode::NO_CONTENT.into_response()
        }
        _ => {
            ClaudeHookService::expire_decision(&decision_id);
            let _ = app.emit("claude-hook-decision-expired", json!({ "decisionId": decision_id }));
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
pub async fn send_claude_hook_decision_notification(
    app: tauri::AppHandle,
    decision_id: String,
) -> Result<(), String> {
    let Some((terminal_id, questions)) = ClaudeHookService::take_notification(&decision_id) else {
        return Ok(());
    };
    let name = terminal_name(&app, &terminal_id);
    for (question_index, question) in questions.iter().enumerate() {
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
        let reports = send_bot_notification(notification).await?;
        for report in reports.into_iter().filter(|report| !report.success) {
            eprintln!("[ClaudeHook] 通道“{}”发送失败: {}", report.channel_name, report.error.unwrap_or_default());
        }
    }
    Ok(())
}
