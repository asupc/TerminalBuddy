use crate::commands::TerminalService;
use crate::models::{
    BotChannelConfig, BotDeliveryReport, BotNotificationRequest, BotSettings, BridgeInboundMessage,
    DecisionBinding,
};
use crate::services::{BotBindingService, BotSettingsService};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::{Duration, Utc};
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde_json::{json, Value};
use sha2::Sha256;
use tauri::{AppHandle, Emitter};

#[derive(Debug)]
struct AdapterResult {
    message_id: Option<String>,
    screenshot_sent: bool,
}

fn notification_body(request: &BotNotificationRequest) -> String {
    let mut parts = vec![
        request.title.trim().to_string(),
        format!("终端：{}", request.terminal_name.trim()),
        format!("时间：{}", Utc::now().format("%Y-%m-%d %H:%M:%S")),
    ];
    if !request.summary.trim().is_empty() {
        parts.push(request.summary.trim().to_string());
    }
    if let Some(excerpt) = request
        .prompt_excerpt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("终端消息：\n{}", excerpt));
    }
    if request.decision_id.is_some() {
        parts.push("请引用此消息回复，回复只会发送到本次待决策会话。".to_string());
    }
    parts.join("\n\n")
}

fn decode_screenshot(value: Option<&str>) -> Result<Option<Vec<u8>>, String> {
    let Some(value) = value else { return Ok(None) };
    let encoded = value.split_once(',').map(|(_, data)| data).unwrap_or(value);
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|error| format!("解析终端截图失败: {}", error))?;
    if bytes.len() > 3 * 1024 * 1024 {
        return Err("终端截图超过 3MB 限制".to_string());
    }
    Ok(Some(bytes))
}

async fn feishu_access_token(
    client: &Client,
    channel: &BotChannelConfig,
) -> Result<String, String> {
    let response = client
        .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
        .json(&json!({ "app_id": channel.app_id, "app_secret": channel.secret }))
        .send()
        .await
        .map_err(|error| format!("飞书认证请求失败: {}", error))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("解析飞书认证响应失败: {}", error))?;
    if !status.is_success() || body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(format!("飞书认证失败: {}", body));
    }
    body.get("tenant_access_token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "飞书认证响应缺少 tenant_access_token".to_string())
}

async fn feishu_send_message(
    client: &Client,
    channel: &BotChannelConfig,
    token: &str,
    msg_type: &str,
    content: Value,
) -> Result<String, String> {
    let receive_type = if channel.receive_id_type.is_empty() {
        "chat_id"
    } else {
        &channel.receive_id_type
    };
    let response = client
        .post(format!(
            "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={}",
            urlencoding::encode(receive_type)
        ))
        .bearer_auth(token)
        .json(&json!({
            "receive_id": channel.target_id,
            "msg_type": msg_type,
            "content": content.to_string(),
        }))
        .send()
        .await
        .map_err(|error| format!("发送飞书消息失败: {}", error))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("解析飞书消息响应失败: {}", error))?;
    if !status.is_success() || body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(format!("发送飞书消息失败: {}", body));
    }
    body.pointer("/data/message_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "飞书消息响应缺少 message_id".to_string())
}

pub(crate) async fn send_feishu_reply(
    channel: &BotChannelConfig,
    reply_to_message_id: &str,
    text: &str,
) -> Result<(), String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| format!("创建飞书回执客户端失败: {}", error))?;
    let token = feishu_access_token(&client, channel).await?;
    let response = client
        .post(format!(
            "https://open.feishu.cn/open-apis/im/v1/messages/{}/reply",
            urlencoding::encode(reply_to_message_id),
        ))
        .bearer_auth(token)
        .json(&json!({
            "msg_type": "text",
            "content": json!({ "text": text }).to_string(),
        }))
        .send()
        .await
        .map_err(|error| format!("发送飞书回执失败: {}", error))?;
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("解析飞书回执失败: {}", error))?;
    if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(format!("发送飞书回执失败: {}", body));
    }
    Ok(())
}

async fn send_feishu(
    client: &Client,
    channel: &BotChannelConfig,
    body: &str,
    screenshot: Option<&[u8]>,
) -> Result<AdapterResult, String> {
    if channel.app_id.is_empty() || channel.secret.is_empty() || channel.target_id.is_empty() {
        return Err("飞书通道需要 App ID、App Secret 和接收目标".to_string());
    }
    let token = feishu_access_token(client, channel).await?;
    let message_id =
        feishu_send_message(client, channel, &token, "text", json!({ "text": body })).await?;
    let mut screenshot_sent = false;
    if let Some(bytes) = screenshot {
        let part = reqwest::multipart::Part::bytes(bytes.to_vec())
            .file_name("terminal.png")
            .mime_str("image/png")
            .map_err(|error| format!("构造飞书图片上传请求失败: {}", error))?;
        let response = client
            .post("https://open.feishu.cn/open-apis/im/v1/images")
            .bearer_auth(&token)
            .multipart(
                reqwest::multipart::Form::new()
                    .text("image_type", "message")
                    .part("image", part),
            )
            .send()
            .await
            .map_err(|error| format!("上传飞书终端截图失败: {}", error))?;
        let upload: Value = response
            .json()
            .await
            .map_err(|error| format!("解析飞书图片响应失败: {}", error))?;
        if upload.get("code").and_then(Value::as_i64).unwrap_or(-1) == 0 {
            if let Some(image_key) = upload.pointer("/data/image_key").and_then(Value::as_str) {
                feishu_send_message(
                    client,
                    channel,
                    &token,
                    "image",
                    json!({ "image_key": image_key }),
                )
                .await?;
                screenshot_sent = true;
            }
        }
    }
    Ok(AdapterResult {
        message_id: Some(message_id),
        screenshot_sent,
    })
}

fn signed_dingtalk_url(channel: &BotChannelConfig) -> Result<String, String> {
    if channel.secret.is_empty() {
        return Ok(channel.webhook_url.clone());
    }
    let timestamp = Utc::now().timestamp_millis();
    let payload = format!("{}\n{}", timestamp, channel.secret);
    let mut mac = Hmac::<Sha256>::new_from_slice(channel.secret.as_bytes())
        .map_err(|error| format!("初始化 DingTalk 签名失败: {}", error))?;
    mac.update(payload.as_bytes());
    let sign = BASE64_STANDARD.encode(mac.finalize().into_bytes());
    let separator = if channel.webhook_url.contains('?') {
        '&'
    } else {
        '?'
    };
    Ok(format!(
        "{}{}timestamp={}&sign={}",
        channel.webhook_url,
        separator,
        timestamp,
        urlencoding::encode(&sign)
    ))
}

async fn send_dingtalk(
    client: &Client,
    channel: &BotChannelConfig,
    body: &str,
) -> Result<AdapterResult, String> {
    if channel.webhook_url.is_empty() {
        return Err("DingTalk 通道需要 Webhook URL".to_string());
    }
    let response = client
        .post(signed_dingtalk_url(channel)?)
        .json(&json!({ "msgtype": "text", "text": { "content": body } }))
        .send()
        .await
        .map_err(|error| format!("发送 DingTalk 消息失败: {}", error))?;
    let result: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 DingTalk 响应失败: {}", error))?;
    if result.get("errcode").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(format!("发送 DingTalk 消息失败: {}", result));
    }
    Ok(AdapterResult {
        message_id: None,
        screenshot_sent: false,
    })
}

async fn send_wecom(
    client: &Client,
    channel: &BotChannelConfig,
    body: &str,
    screenshot: Option<&[u8]>,
) -> Result<AdapterResult, String> {
    if channel.webhook_url.is_empty() {
        return Err("企业微信通道需要 Webhook URL".to_string());
    }
    let response = client
        .post(&channel.webhook_url)
        .json(&json!({ "msgtype": "text", "text": { "content": body } }))
        .send()
        .await
        .map_err(|error| format!("发送企业微信消息失败: {}", error))?;
    let result: Value = response
        .json()
        .await
        .map_err(|error| format!("解析企业微信响应失败: {}", error))?;
    if result.get("errcode").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(format!("发送企业微信消息失败: {}", result));
    }
    let mut screenshot_sent = false;
    if let Some(bytes) = screenshot {
        let image_response = client
            .post(&channel.webhook_url)
            .json(&json!({
                "msgtype": "image",
                "image": {
                    "base64": BASE64_STANDARD.encode(bytes),
                    "md5": format!("{:x}", md5::compute(bytes)),
                }
            }))
            .send()
            .await
            .map_err(|error| format!("发送企业微信终端截图失败: {}", error))?;
        let image_result: Value = image_response
            .json()
            .await
            .map_err(|error| format!("解析企业微信图片响应失败: {}", error))?;
        screenshot_sent = image_result
            .get("errcode")
            .and_then(Value::as_i64)
            .unwrap_or(-1)
            == 0;
    }
    Ok(AdapterResult {
        message_id: None,
        screenshot_sent,
    })
}

async fn send_bridge(
    client: &Client,
    channel: &BotChannelConfig,
    request: &BotNotificationRequest,
    body: &str,
) -> Result<AdapterResult, String> {
    if channel.webhook_url.is_empty() {
        return Err("桥接通道需要发送 URL".to_string());
    }
    let mut builder = client.post(&channel.webhook_url).json(&json!({
        "eventId": request.event_id,
        "decisionId": request.decision_id,
        "platform": channel.platform,
        "targetId": channel.target_id,
        "terminalId": request.terminal_id,
        "terminalName": request.terminal_name,
        "kind": request.kind,
        "text": body,
        "screenshotBase64": request.screenshot_base64,
        "callbackChannelId": channel.id,
    }));
    if !channel.secret.is_empty() {
        builder = builder.bearer_auth(&channel.secret);
    }
    let response = builder
        .send()
        .await
        .map_err(|error| format!("发送桥接消息失败: {}", error))?;
    let status = response.status();
    let result: Value = response
        .json()
        .await
        .map_err(|error| format!("解析桥接响应失败: {}", error))?;
    if !status.is_success() || result.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(format!("发送桥接消息失败: {}", result));
    }
    let message_id = result
        .get("messageId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let screenshot_sent = result
        .get("screenshotSent")
        .and_then(Value::as_bool)
        .unwrap_or(request.screenshot_base64.is_some());
    Ok(AdapterResult {
        message_id,
        screenshot_sent,
    })
}

async fn dispatch_channel(
    client: &Client,
    channel: &BotChannelConfig,
    request: &BotNotificationRequest,
    body: &str,
    screenshot: Option<&[u8]>,
) -> Result<AdapterResult, String> {
    match channel.platform.as_str() {
        "feishu" => send_feishu(client, channel, body, screenshot).await,
        "dingtalk" => send_dingtalk(client, channel, body).await,
        "wecom" => send_wecom(client, channel, body, screenshot).await,
        "qq" | "bridge" => send_bridge(client, channel, request, body).await,
        other => Err(format!("不支持的机器人平台: {}", other)),
    }
}

#[tauri::command]
pub fn get_bot_settings() -> BotSettings {
    BotSettingsService::get_public()
}

#[tauri::command]
pub fn get_bot_callback_base_url() -> String {
    let settings = crate::services::SettingsService::get_settings();
    let host = (|| {
        let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
        socket.connect("8.8.8.8:80").ok()?;
        socket
            .local_addr()
            .ok()
            .map(|address| address.ip().to_string())
    })()
    .unwrap_or_else(|| "localhost".to_string());
    format!("http://{}:{}", host, settings.web_api_port)
}

#[tauri::command]
pub async fn save_bot_settings(
    app: AppHandle,
    settings: BotSettings,
) -> Result<BotSettings, String> {
    let saved = BotSettingsService::save(settings)?;
    crate::commands::web::sync_http_server_for_bot(app)?;
    Ok(saved)
}

#[tauri::command]
pub async fn send_bot_notification(
    request: BotNotificationRequest,
) -> Result<Vec<BotDeliveryReport>, String> {
    let settings = BotSettingsService::get_runtime()?;
    if !settings.enabled {
        return Ok(Vec::new());
    }
    let is_completion = request.kind == "completed";
    if (is_completion && !settings.send_completion_notifications)
        || (!is_completion && !settings.send_decision_notifications)
    {
        return Ok(Vec::new());
    }
    let screenshot = if settings.attach_screenshot {
        decode_screenshot(request.screenshot_base64.as_deref())?
    } else {
        None
    };
    let body = notification_body(&request);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建机器人 HTTP 客户端失败: {}", error))?;
    let mut reports = Vec::new();
    for channel in settings.channels.iter().filter(|channel| channel.enabled) {
        match dispatch_channel(&client, channel, &request, &body, screenshot.as_deref()).await {
            Ok(result) => {
                if let (Some(decision_id), Some(message_id)) =
                    (&request.decision_id, &result.message_id)
                {
                    BotBindingService::add(DecisionBinding {
                        decision_id: decision_id.clone(),
                        terminal_id: request.terminal_id.clone(),
                        terminal_name: request.terminal_name.clone(),
                        channel_id: channel.id.clone(),
                        target_id: channel.target_id.clone(),
                        external_message_id: message_id.clone(),
                        status: "pending".to_string(),
                        expires_at: (Utc::now()
                            + Duration::minutes(settings.decision_ttl_minutes as i64))
                        .timestamp_millis(),
                    })?;
                }
                reports.push(BotDeliveryReport {
                    channel_id: channel.id.clone(),
                    channel_name: channel.name.clone(),
                    success: true,
                    message_id: result.message_id,
                    screenshot_sent: result.screenshot_sent,
                    error: None,
                });
            }
            Err(error) => reports.push(BotDeliveryReport {
                channel_id: channel.id.clone(),
                channel_name: channel.name.clone(),
                success: false,
                message_id: None,
                screenshot_sent: false,
                error: Some(error),
            }),
        }
    }
    Ok(reports)
}

#[tauri::command]
pub async fn test_bot_channel(channel_id: String) -> Result<BotDeliveryReport, String> {
    let settings = BotSettingsService::get_runtime()?;
    let channel = settings
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| "机器人通道不存在".to_string())?;
    let request = BotNotificationRequest {
        event_id: uuid::Uuid::new_v4().to_string(),
        decision_id: None,
        terminal_id: "test".to_string(),
        terminal_name: "连接测试".to_string(),
        kind: "completed".to_string(),
        title: "TerminalBuddy 机器人连接测试".to_string(),
        summary: "如果你看到这条消息，说明文字通知通道配置正确。".to_string(),
        prompt_excerpt: None,
        screenshot_base64: None,
    };
    let body = notification_body(&request);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建机器人 HTTP 客户端失败: {}", error))?;
    match dispatch_channel(&client, channel, &request, &body, None).await {
        Ok(result) => Ok(BotDeliveryReport {
            channel_id: channel.id.clone(),
            channel_name: channel.name.clone(),
            success: true,
            message_id: result.message_id,
            screenshot_sent: false,
            error: None,
        }),
        Err(error) => Ok(BotDeliveryReport {
            channel_id: channel.id.clone(),
            channel_name: channel.name.clone(),
            success: false,
            message_id: None,
            screenshot_sent: false,
            error: Some(error),
        }),
    }
}

#[tauri::command]
pub fn cancel_bot_decision(decision_id: String) -> Result<(), String> {
    BotBindingService::cancel(&decision_id)
}

fn sanitize_reply(text: &str, append_enter: bool) -> Result<String, String> {
    let mut sanitized = String::with_capacity(text.len() + 1);
    for character in text.trim().chars().take(4_000) {
        match character {
            '\0' | '\u{1b}' => {}
            '\r' => {}
            '\n' => sanitized.push('\r'),
            character if character.is_control() && character != '\t' => {}
            character => sanitized.push(character),
        }
    }
    if sanitized.trim().is_empty() {
        return Err("回复内容为空".to_string());
    }
    if append_enter && !sanitized.ends_with('\r') {
        sanitized.push('\r');
    }
    Ok(sanitized)
}

pub fn process_bot_reply(
    app: &AppHandle,
    terminal_service: &TerminalService,
    channel: &BotChannelConfig,
    inbound: &BridgeInboundMessage,
) -> Result<String, String> {
    if channel.allowed_user_ids.is_empty()
        || !channel
            .allowed_user_ids
            .iter()
            .any(|id| id == &inbound.sender_id)
    {
        return Err("发送者不在允许名单中".to_string());
    }
    if channel.receive_id_type == "chat_id"
        && !channel.target_id.is_empty()
        && channel.target_id != inbound.conversation_id
    {
        return Err("消息不属于配置的目标会话".to_string());
    }
    let reply_to = inbound
        .reply_to_message_id
        .as_deref()
        .ok_or_else(|| "请引用需要决策的机器人消息后再回复".to_string())?;
    let settings = BotSettingsService::get_runtime()?;
    let data = sanitize_reply(&inbound.text, settings.append_enter)?;
    let binding = BotBindingService::consume_with(&channel.id, reply_to, |binding| {
        let exists = terminal_service
            .instances
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&binding.terminal_id);
        if !exists {
            return Err("对应终端已经关闭".to_string());
        }
        terminal_service.write_to_terminal(&binding.terminal_id, &data)
    })?;
    let _ = app.emit(
        "claude-bot-reply-forwarded",
        json!({
            "decisionId": binding.decision_id,
            "terminalId": binding.terminal_id,
            "terminalName": binding.terminal_name,
            "channelId": channel.id,
            "senderId": inbound.sender_id,
            "messageId": inbound.message_id,
        }),
    );
    Ok(format!("已发送到终端：{}", binding.terminal_name))
}
