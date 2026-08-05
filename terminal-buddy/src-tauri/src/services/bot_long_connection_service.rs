use crate::commands::{
    process_bot_card_selection, process_bot_multi_selection, process_bot_reply, TerminalService,
};
use crate::models::{BotChannelConfig, BotLongConnectionStatus, BridgeInboundMessage};
use crate::services::bot_channel::send_feishu_reply;
use crate::services::{
    extract_weixin_reply_to, extract_weixin_text, get_weixin_updates, load_weixin_state,
    save_weixin_context_token, save_weixin_sync_buf, send_weixin_reply, validate_weixin_response,
    BotSettingsService,
};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use lark_channel::lark_openapi::{
    OpenApiClient, ReqwestOpenApiTransport, TokioTungsteniteWebSocketTransport, WebSocketEventAck,
};
use lark_channel::{
    ChannelConfig, ChannelEvent, EventLoop, EventLoopOptions, OpenApiWebSocketEventConnector,
};
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

fn tasks() -> &'static Mutex<Vec<tauri::async_runtime::JoinHandle<()>>> {
    static TASKS: OnceLock<Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>> = OnceLock::new();
    TASKS.get_or_init(|| Mutex::new(Vec::new()))
}

fn statuses() -> &'static Mutex<HashMap<String, BotLongConnectionStatus>> {
    static STATUSES: OnceLock<Mutex<HashMap<String, BotLongConnectionStatus>>> = OnceLock::new();
    STATUSES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_status(channels: &[BotChannelConfig], state: &str, error: Option<String>) {
    let mut current = statuses().lock().unwrap_or_else(|value| value.into_inner());
    for channel in channels {
        current.insert(
            channel.id.clone(),
            BotLongConnectionStatus {
                channel_id: channel.id.clone(),
                state: state.to_string(),
                error: error.clone(),
            },
        );
    }
}

fn matching_channel<'a>(
    channels: &'a [BotChannelConfig],
    conversation_id: &str,
    sender_id: &str,
) -> Option<&'a BotChannelConfig> {
    channels.iter().find(|channel| {
        channel.target_id.is_empty()
            || if channel.receive_id_type == "chat_id" {
                channel.target_id == conversation_id
            } else {
                channel.target_id == sender_id
            }
    })
}

fn card_ack(success: bool, message: &str) -> WebSocketEventAck {
    let payload = json!({
        "toast": {
            "type": if success { "success" } else { "error" },
            "content": message,
        }
    });
    WebSocketEventAck::ok().with_base64_data(BASE64_STANDARD.encode(payload.to_string()))
}

async fn handle_event(
    app: AppHandle,
    channels: Vec<BotChannelConfig>,
    event: lark_channel::ReceivedEvent,
) -> WebSocketEventAck {
    match event.event {
        ChannelEvent::CardAction(action) => {
            let action_name = action
                .action
                .value
                .get("action")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if action_name != "select_option"
                && action_name != "use_recommended"
                && action_name != "submit_multi_select"
            {
                return card_ack(false, "不支持的卡片操作");
            }
            let conversation_id = action
                .card_context
                .as_ref()
                .and_then(|context| context.open_chat_id.as_deref())
                .unwrap_or_default();
            let card_message_id = action
                .card_context
                .as_ref()
                .and_then(|context| context.open_message_id.as_deref())
                .unwrap_or_default();
            let sender_id = action
                .operator
                .open_id
                .as_deref()
                .or(action.operator.user_id.as_deref())
                .unwrap_or_default();
            if card_message_id.is_empty() {
                return card_ack(false, "卡片事件缺少消息标识");
            }
            let Some(channel) = matching_channel(&channels, conversation_id, sender_id) else {
                return card_ack(false, "卡片不属于已配置通道");
            };
            let terminal_service = app.state::<TerminalService>();
            let result = if action_name == "submit_multi_select" {
                let selected_move_counts = action
                    .action
                    .form_value
                    .as_ref()
                    .and_then(|value| value.get("selectedOptions"))
                    .and_then(|value| value.as_array())
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| value.as_str()?.parse::<i16>().ok())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_else(|| {
                        action
                            .action
                            .options
                            .iter()
                            .filter_map(|value| value.parse::<i16>().ok())
                            .collect()
                    });
                let initial_selected_move_counts = action
                    .action
                    .value
                    .get("initialSelectedMoveCounts")
                    .and_then(|value| value.as_array())
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| value.as_i64())
                            .filter_map(|value| i16::try_from(value).ok())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let submit_move_count = action
                    .action
                    .value
                    .get("submitMoveCount")
                    .and_then(|value| value.as_i64())
                    .and_then(|value| i16::try_from(value).ok())
                    .unwrap_or(i16::MAX);
                process_bot_multi_selection(
                    &app,
                    &terminal_service,
                    channel,
                    sender_id,
                    conversation_id,
                    &action.context.event_id,
                    card_message_id,
                    &selected_move_counts,
                    &initial_selected_move_counts,
                    submit_move_count,
                )
            } else {
                let move_count = if action_name == "use_recommended" {
                    0
                } else {
                    action
                        .action
                        .value
                        .get("moveCount")
                        .and_then(|value| value.as_i64())
                        .and_then(|value| i16::try_from(value).ok())
                        .unwrap_or(i16::MAX)
                };
                process_bot_card_selection(
                    &app,
                    &terminal_service,
                    channel,
                    sender_id,
                    conversation_id,
                    &action.context.event_id,
                    card_message_id,
                    move_count,
                )
            };
            match result {
                Ok(message) => card_ack(true, &message),
                Err(error) => card_ack(false, &error),
            }
        }
        ChannelEvent::Message(message) => {
            let Some(channel) = matching_channel(&channels, &message.chat_id, &message.sender_id)
            else {
                return WebSocketEventAck::ok();
            };
            let inbound = BridgeInboundMessage {
                sender_id: message.sender_id.clone(),
                conversation_id: message.chat_id.clone(),
                message_id: message.message_id.clone(),
                reply_to_message_id: message
                    .parent_id
                    .clone()
                    .or_else(|| message.root_id.clone()),
                text: message.text.clone(),
            };
            let terminal_service = app.state::<TerminalService>();
            let reply = process_bot_reply(&app, &terminal_service, channel, &inbound);
            let response = match reply {
                Ok(message) => message,
                Err(error) => error,
            };
            if channel
                .allowed_user_ids
                .iter()
                .any(|id| id == &inbound.sender_id)
            {
                if let Err(error) = send_feishu_reply(channel, &inbound.message_id, &response).await
                {
                    eprintln!("[Bot/Feishu/WS] 发送回复回执失败: {}", error);
                }
            }
            WebSocketEventAck::ok()
        }
        ChannelEvent::Unknown { .. } => WebSocketEventAck::ok(),
    }
}

async fn run_feishu_connection(app: AppHandle, channels: Vec<BotChannelConfig>) {
    let Some(primary) = channels.first() else {
        return;
    };
    set_status(&channels, "connecting", None);
    let config = ChannelConfig::new(primary.app_id.clone(), primary.secret.clone());
    let openapi = OpenApiClient::new(config, ReqwestOpenApiTransport::new());
    let connector =
        OpenApiWebSocketEventConnector::new(openapi, TokioTungsteniteWebSocketTransport::new());
    let options = EventLoopOptions::new()
        .with_unlimited_reconnects()
        .with_reconnect_delay(Duration::from_secs(2));
    let mut event_loop = EventLoop::with_options(connector, options);
    set_status(&channels, "connected", None);
    let handler_channels = channels.clone();
    let result = event_loop
        .run(move |event| {
            let app = app.clone();
            let channels = handler_channels.clone();
            async move { Ok(handle_event(app, channels, event).await) }
        })
        .await;
    if let Err(error) = result {
        let message = error.to_string();
        eprintln!("[Bot/Feishu/WS] 长连接退出: {}", message);
        set_status(&channels, "error", Some(message));
    } else {
        set_status(&channels, "disconnected", None);
    }
}

async fn handle_weixin_message(
    app: &AppHandle,
    client: &Client,
    channels: &[BotChannelConfig],
    state: &mut crate::services::WeixinRuntimeState,
    message: &Value,
) {
    if message.get("message_type").and_then(Value::as_i64) == Some(2) {
        return;
    }
    let sender_id = message
        .get("from_user_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if sender_id.is_empty() {
        return;
    }
    let Some(channel) = matching_channel(channels, sender_id, sender_id).cloned() else {
        return;
    };
    if sender_id == channel.app_id {
        return;
    }

    if let Some(context_token) = message
        .get("context_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        state
            .context_tokens
            .insert(sender_id.to_string(), context_token.to_string());
        if let Err(error) =
            save_weixin_context_token(&channel.app_id, sender_id, Some(context_token))
        {
            eprintln!("[Bot/Weixin] 保存 context_token 失败: {}", error);
        }
    }

    let text = extract_weixin_text(message);
    let reply_to_message_id = extract_weixin_reply_to(message);
    if text.trim().is_empty() {
        return;
    }
    let inbound = BridgeInboundMessage {
        sender_id: sender_id.to_string(),
        conversation_id: sender_id.to_string(),
        message_id: message
            .get("message_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        reply_to_message_id,
        text,
    };
    let terminal_service = app.state::<TerminalService>();
    let result = process_bot_reply(app, &terminal_service, &channel, &inbound);
    if channel
        .allowed_user_ids
        .iter()
        .any(|allowed| allowed == sender_id)
    {
        let response = match result {
            Ok(message) => message,
            Err(error) => error,
        };
        if let Err(error) = send_weixin_reply(client, &channel, sender_id, &response).await {
            eprintln!("[Bot/Weixin] 发送回复回执失败: {}", error);
        }
    }
}

async fn run_weixin_connection(app: AppHandle, channels: Vec<BotChannelConfig>) {
    let Some(primary) = channels.first().cloned() else {
        return;
    };
    set_status(&channels, "connecting", None);
    let client = match Client::builder().build() {
        Ok(client) => client,
        Err(error) => {
            set_status(
                &channels,
                "error",
                Some(format!("创建微信 iLink 客户端失败: {}", error)),
            );
            return;
        }
    };
    let mut state = load_weixin_state(&primary.app_id);
    let mut timeout_ms = 35_000u64;
    let mut consecutive_failures = 0u8;
    let mut recent_message_ids = HashSet::new();
    let mut message_id_order = VecDeque::new();
    set_status(&channels, "connected", None);

    loop {
        let response =
            match get_weixin_updates(&client, &primary, &state.sync_buf, timeout_ms).await {
                Ok(response) => response,
                Err(error) => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    if consecutive_failures >= 3 {
                        set_status(&channels, "error", Some(error.clone()));
                    }
                    eprintln!("[Bot/Weixin] 长轮询失败: {}", error);
                    tokio::time::sleep(Duration::from_secs(if consecutive_failures >= 3 {
                        30
                    } else {
                        2
                    }))
                    .await;
                    if consecutive_failures >= 3 {
                        consecutive_failures = 0;
                    }
                    continue;
                }
            };
        if let Err(error) = validate_weixin_response(&response, "接收消息") {
            let session_expired = response.get("ret").and_then(Value::as_i64) == Some(-14)
                || response.get("errcode").and_then(Value::as_i64) == Some(-14);
            let display_error = if session_expired {
                "微信登录会话已过期，请重新扫码配置".to_string()
            } else {
                error.clone()
            };
            set_status(&channels, "error", Some(display_error));
            eprintln!("[Bot/Weixin] iLink 长轮询返回错误: {}", error);
            tokio::time::sleep(Duration::from_secs(if session_expired { 60 } else { 2 })).await;
            continue;
        }

        consecutive_failures = 0;
        set_status(&channels, "connected", None);
        if let Some(suggested) = response
            .get("longpolling_timeout_ms")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
        {
            timeout_ms = suggested;
        }
        if let Some(sync_buf) = response
            .get("get_updates_buf")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            state.sync_buf = sync_buf.to_string();
            if let Err(error) = save_weixin_sync_buf(&primary.app_id, &state.sync_buf) {
                eprintln!("[Bot/Weixin] 保存同步游标失败: {}", error);
            }
        }
        if let Some(messages) = response.get("msgs").and_then(Value::as_array) {
            for message in messages {
                if let Some(message_id) = message
                    .get("message_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    if !recent_message_ids.insert(message_id.to_string()) {
                        continue;
                    }
                    message_id_order.push_back(message_id.to_string());
                    if message_id_order.len() > 1_024 {
                        if let Some(oldest) = message_id_order.pop_front() {
                            recent_message_ids.remove(&oldest);
                        }
                    }
                }
                handle_weixin_message(&app, &client, &channels, &mut state, message).await;
            }
        }
    }
}

pub fn sync_bot_long_connections(app: AppHandle) -> Result<(), String> {
    {
        let mut running = tasks().lock().unwrap_or_else(|value| value.into_inner());
        for task in running.drain(..) {
            task.abort();
        }
    }
    statuses()
        .lock()
        .unwrap_or_else(|value| value.into_inner())
        .clear();

    let settings = BotSettingsService::get_runtime()?;
    if !settings.enabled {
        return Ok(());
    }
    let mut feishu_grouped: HashMap<(String, String), Vec<BotChannelConfig>> = HashMap::new();
    let mut weixin_grouped: HashMap<(String, String, String), Vec<BotChannelConfig>> =
        HashMap::new();
    let mut seen_channels = HashSet::new();
    for channel in settings
        .channels
        .into_iter()
        .filter(|channel| channel.enabled)
    {
        if !seen_channels.insert(channel.id.clone()) {
            continue;
        }
        match channel.platform.as_str() {
            "feishu" if !channel.app_id.is_empty() && !channel.secret.is_empty() => {
                feishu_grouped
                    .entry((channel.app_id.clone(), channel.secret.clone()))
                    .or_default()
                    .push(channel);
            }
            "weixin" if !channel.app_id.is_empty() && !channel.secret.is_empty() => {
                weixin_grouped
                    .entry((
                        channel.app_id.clone(),
                        channel.secret.clone(),
                        channel.webhook_url.clone(),
                    ))
                    .or_default()
                    .push(channel);
            }
            _ => {}
        }
    }

    let mut running = tasks().lock().unwrap_or_else(|value| value.into_inner());
    for channels in feishu_grouped.into_values() {
        let app = app.clone();
        let task = tauri::async_runtime::spawn(run_feishu_connection(app, channels));
        running.push(task);
    }
    for channels in weixin_grouped.into_values() {
        let app = app.clone();
        let task = tauri::async_runtime::spawn(run_weixin_connection(app, channels));
        running.push(task);
    }
    Ok(())
}

pub fn get_bot_long_connection_statuses() -> Vec<BotLongConnectionStatus> {
    statuses()
        .lock()
        .unwrap_or_else(|value| value.into_inner())
        .values()
        .cloned()
        .collect()
}
