use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use tauri::Manager;

use crate::commands::{process_bot_reply, send_feishu_reply, TerminalService};
use crate::models::BridgeInboundMessage;
use crate::services::BotSettingsService;
use crate::web::server::AppState;

fn json_error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "success": false, "error": message.into() })),
    )
        .into_response()
}

pub async fn bridge_inbound(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    headers: HeaderMap,
    Json(inbound): Json<BridgeInboundMessage>,
) -> Response {
    let settings = match BotSettingsService::get_runtime() {
        Ok(settings) => settings,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let Some(channel) = settings.channels.iter().find(|channel| {
        channel.enabled
            && channel.id == channel_id
            && matches!(channel.platform.as_str(), "bridge" | "qq")
    }) else {
        return json_error(StatusCode::NOT_FOUND, "机器人桥接通道不存在");
    };
    let authorization = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let expected = format!("Bearer {}", channel.callback_token);
    if channel.callback_token.is_empty() || authorization != expected {
        return json_error(StatusCode::UNAUTHORIZED, "机器人回调认证失败");
    }
    let terminal_service = state.app_handle.state::<TerminalService>();
    match process_bot_reply(&state.app_handle, &terminal_service, channel, &inbound) {
        Ok(message) => Json(json!({ "success": true, "message": message })).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error),
    }
}

pub async fn feishu_events(State(state): State<AppState>, Json(payload): Json<Value>) -> Response {
    let settings = match BotSettingsService::get_runtime() {
        Ok(settings) => settings,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let token = payload
        .pointer("/header/token")
        .or_else(|| payload.get("token"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let challenge = payload.get("challenge").and_then(Value::as_str);
    if let Some(challenge) = challenge {
        let valid = settings.channels.iter().any(|channel| {
            channel.enabled
                && channel.platform == "feishu"
                && !channel.callback_token.is_empty()
                && channel.callback_token == token
        });
        if valid {
            return Json(json!({ "challenge": challenge })).into_response();
        }
        return json_error(StatusCode::UNAUTHORIZED, "飞书回调验证失败");
    }

    let event_type = payload
        .pointer("/header/event_type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if event_type != "im.message.receive_v1" {
        return Json(json!({ "code": 0 })).into_response();
    }
    let message = payload.pointer("/event/message").unwrap_or(&Value::Null);
    let sender = payload
        .pointer("/event/sender/sender_id")
        .unwrap_or(&Value::Null);
    let conversation_id = message
        .get("chat_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(channel) = settings.channels.iter().find(|channel| {
        channel.enabled
            && channel.platform == "feishu"
            && !channel.callback_token.is_empty()
            && channel.callback_token == token
            && (channel.receive_id_type != "chat_id" || channel.target_id == conversation_id)
    }) else {
        return json_error(StatusCode::UNAUTHORIZED, "飞书消息不属于已配置通道");
    };
    let sender_id = sender
        .get("open_id")
        .or_else(|| sender.get("user_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let text = serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|value| {
            value
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let inbound = BridgeInboundMessage {
        sender_id: sender_id.to_string(),
        conversation_id: conversation_id.to_string(),
        message_id: message
            .get("message_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        reply_to_message_id: message
            .get("parent_id")
            .or_else(|| message.get("root_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        text,
    };
    let terminal_service = state.app_handle.state::<TerminalService>();
    match process_bot_reply(&state.app_handle, &terminal_service, channel, &inbound) {
        Ok(message) => {
            if let Err(error) = send_feishu_reply(channel, &inbound.message_id, &message).await {
                eprintln!("[Bot/Feishu] 发送回执失败: {}", error);
            }
            Json(json!({ "code": 0 })).into_response()
        }
        Err(error) => {
            eprintln!("[Bot/Feishu] 忽略入站消息: {}", error);
            if channel
                .allowed_user_ids
                .iter()
                .any(|id| id == &inbound.sender_id)
            {
                if let Err(reply_error) =
                    send_feishu_reply(channel, &inbound.message_id, &error).await
                {
                    eprintln!("[Bot/Feishu] 发送拒绝回执失败: {}", reply_error);
                }
            }
            Json(json!({ "code": 0 })).into_response()
        }
    }
}
