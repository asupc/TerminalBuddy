use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use tauri::Manager;

use crate::commands::{
    process_bot_card_selection, process_bot_multi_selection, process_bot_reply, TerminalService,
};
use crate::models::BridgeInboundMessage;
use crate::services::bot_channel::send_feishu_reply;
use crate::services::BotSettingsService;
use crate::web::server::AppState;

fn json_error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "success": false, "error": message.into() })),
    )
        .into_response()
}

fn feishu_card_result(success: bool, message: impl Into<String>) -> Response {
    Json(json!({
        "toast": {
            "type": if success { "success" } else { "error" },
            "content": message.into(),
        }
    }))
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
    let is_card_action = event_type == "card.action.trigger"
        || (event_type.is_empty() && payload.get("action").is_some());
    if is_card_action {
        let action = payload
            .pointer("/event/action/value/action")
            .or_else(|| payload.pointer("/action/value/action"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if action != "select_option"
            && action != "use_recommended"
            && action != "submit_multi_select"
        {
            return feishu_card_result(false, "不支持的卡片操作");
        }
        let conversation_id = payload
            .pointer("/event/context/open_chat_id")
            .or_else(|| payload.get("open_chat_id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let sender_id = payload
            .pointer("/event/operator/operator_id/open_id")
            .or_else(|| payload.pointer("/event/operator/operator_id/user_id"))
            .or_else(|| payload.get("open_id"))
            .or_else(|| payload.get("user_id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let message_id = payload
            .pointer("/event/context/open_message_id")
            .or_else(|| payload.get("open_message_id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if message_id.is_empty() {
            return feishu_card_result(false, "卡片回调缺少消息标识");
        }
        let Some(channel) = settings.channels.iter().find(|channel| {
            channel.enabled
                && channel.platform == "feishu"
                && !channel.callback_token.is_empty()
                && channel.callback_token == token
                && (channel.receive_id_type != "chat_id" || channel.target_id == conversation_id)
        }) else {
            return feishu_card_result(false, "卡片不属于已配置通道");
        };
        let callback_message_id = payload
            .pointer("/header/event_id")
            .and_then(Value::as_str)
            .unwrap_or(message_id);
        let terminal_service = state.app_handle.state::<TerminalService>();
        let result = if action == "submit_multi_select" {
            let selected_move_counts = payload
                .pointer("/event/action/form_value/selectedOptions")
                .or_else(|| payload.pointer("/action/form_value/selectedOptions"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str()?.parse::<i16>().ok())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let initial_selected_move_counts = payload
                .pointer("/event/action/value/initialSelectedMoveCounts")
                .or_else(|| payload.pointer("/action/value/initialSelectedMoveCounts"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_i64)
                        .filter_map(|value| i16::try_from(value).ok())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let submit_move_count = payload
                .pointer("/event/action/value/submitMoveCount")
                .or_else(|| payload.pointer("/action/value/submitMoveCount"))
                .and_then(Value::as_i64)
                .and_then(|value| i16::try_from(value).ok())
                .unwrap_or(i16::MAX);
            process_bot_multi_selection(
                &state.app_handle,
                &terminal_service,
                channel,
                sender_id,
                conversation_id,
                callback_message_id,
                message_id,
                &selected_move_counts,
                &initial_selected_move_counts,
                submit_move_count,
            )
        } else {
            let move_count = if action == "use_recommended" {
                0
            } else {
                payload
                    .pointer("/event/action/value/moveCount")
                    .or_else(|| payload.pointer("/action/value/moveCount"))
                    .and_then(Value::as_i64)
                    .and_then(|value| i16::try_from(value).ok())
                    .unwrap_or(i16::MAX)
            };
            process_bot_card_selection(
                &state.app_handle,
                &terminal_service,
                channel,
                sender_id,
                conversation_id,
                callback_message_id,
                message_id,
                move_count,
            )
        };
        return match result {
            Ok(message) => feishu_card_result(true, message),
            Err(error) => {
                eprintln!("[Bot/Feishu] 卡片操作失败: {}", error);
                feishu_card_result(false, error)
            }
        };
    }
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
