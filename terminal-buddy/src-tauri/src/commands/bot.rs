use crate::commands::TerminalService;
use crate::models::{
    BotChannelConfig, BotDecisionOption, BotDeliveryReport, BotNotificationRequest, BotSettings,
    BridgeInboundMessage, DecisionBinding,
};
use crate::services::{
    begin_scan, get_feishu_long_connection_status, install_claude_http_hooks, poll_scan,
    sync_feishu_long_connections, BotBindingService, BotSettingsService, ScanBeginResult,
    ScanPollResult,
};
use chrono::{Duration, Utc};
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter};

#[derive(Debug)]
struct AdapterResult {
    message_id: Option<String>,
}

const BOT_TEST_TERMINAL_ID: &str = "__terminal_buddy_bot_decision_test__";

fn notification_body(request: &BotNotificationRequest) -> String {
    let mut parts = vec![
        request.title.trim().to_string(),
        format!("终端：{}", request.terminal_name.trim()),
        format!("时间：{}", Utc::now().format("%Y-%m-%d %H:%M:%S")),
    ];
    if !request.summary.trim().is_empty() {
        parts.push(request.summary.trim().to_string());
    }
    if request.decision_id.is_some() {
        parts.push(
            "请引用此消息回复：“确认”采用推荐选项，其他内容将作为自定义消息。"
                .to_string(),
        );
    }
    parts.join("\n\n")
}

fn feishu_decision_card(request: &BotNotificationRequest) -> Value {
    let metadata = [
        format!("终端：{}", request.terminal_name.trim()),
        format!("时间：{}", Utc::now().format("%Y-%m-%d %H:%M:%S")),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let card_title = request
        .decision_title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(request.title.trim());
    let question = request
        .decision_question
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(request.summary.trim());
    let mut elements = vec![
        json!({
            "tag": "div",
            "text": {
                "tag": "plain_text",
                "content": metadata
            }
        }),
        json!({
            "tag": "div",
            "text": {
                "tag": "plain_text",
                "content": question
            }
        }),
        json!({ "tag": "hr" }),
    ];
    let options = request.decision_options.as_deref().unwrap_or_default();
    if request.decision_multi_select && !options.is_empty() {
        let form_options = options
            .iter()
            .map(|option| {
                json!({
                    "text": {
                        "tag": "plain_text",
                        "content": option.label.trim()
                    },
                    "value": option.move_count.to_string()
                })
            })
            .collect::<Vec<_>>();
        let selected_values = options
            .iter()
            .filter(|option| option.selected)
            .map(|option| option.move_count.to_string())
            .collect::<Vec<_>>();
        let initial_selected_move_counts = options
            .iter()
            .filter(|option| option.selected)
            .map(|option| option.move_count)
            .collect::<Vec<_>>();
        elements.push(json!({
            "tag": "form",
            "name": "decisionForm",
            "elements": [
                {
                    "tag": "multi_select_static",
                    "name": "selectedOptions",
                    "placeholder": {
                        "tag": "plain_text",
                        "content": "请选择一个或多个选项"
                    },
                    "selected_values": selected_values,
                    "options": form_options
                },
                {
                    "tag": "button",
                    "name": "submitDecision",
                    "type": "primary",
                    "action_type": "form_submit",
                    "text": {
                        "tag": "plain_text",
                        "content": "提交选择"
                    },
                    "value": {
                        "action": "submit_multi_select",
                        "initialSelectedMoveCounts": initial_selected_move_counts,
                        "submitMoveCount": request.decision_submit_move_count
                    },
                    "confirm": {
                        "title": { "tag": "plain_text", "content": "确认提交所选选项？" },
                        "text": { "tag": "plain_text", "content": "确认后将立即在终端勾选并提交。" }
                    }
                }
            ]
        }));
    } else if options.is_empty() {
        elements.push(json!({
            "tag": "action",
            "actions": [{
                "tag": "button",
                "type": "primary",
                "text": {
                    "tag": "plain_text",
                    "content": "采用推荐选项"
                },
                "value": {
                    "action": "select_option",
                    "moveCount": 0
                },
                "confirm": {
                    "title": { "tag": "plain_text", "content": "确认采用推荐选项？" },
                    "text": { "tag": "plain_text", "content": "确认后将立即提交当前高亮选项。" }
                }
            }]
        }));
    } else {
        for option in options {
            let mut content = option.label.trim().to_string();
            if let Some(description) = option
                .description
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                content.push('\n');
                content.push_str(description.trim());
            }
            elements.push(json!({
                "tag": "div",
                "text": { "tag": "plain_text", "content": content }
            }));
            let button_label = if option.recommended {
                format!("选择 {}（推荐）", option.label.trim())
            } else {
                format!("选择 {}", option.label.trim())
            };
            let button_label = button_label.chars().take(40).collect::<String>();
            elements.push(json!({
                "tag": "action",
                "actions": [{
                    "tag": "button",
                    "type": if option.recommended { "primary" } else { "default" },
                    "text": { "tag": "plain_text", "content": button_label },
                    "value": {
                        "action": "select_option",
                        "moveCount": option.move_count
                    },
                    "confirm": {
                        "title": { "tag": "plain_text", "content": "确认提交该选项？" },
                        "text": { "tag": "plain_text", "content": option.label.trim() }
                    }
                }]
            }));
        }
    }
    elements.push(json!({
        "tag": "note",
        "elements": [{
            "tag": "plain_text",
            "content": "需要自定义处理时，请引用此卡片回复消息。"
        }]
    }));

    json!({
        "config": {
            "wide_screen_mode": true,
            "enable_forward": false
        },
        "header": {
            "template": "blue",
            "title": {
                "tag": "plain_text",
                "content": card_title
            }
        },
        "elements": elements
    })
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
    request: &BotNotificationRequest,
    body: &str,
) -> Result<AdapterResult, String> {
    if channel.app_id.is_empty() || channel.secret.is_empty() || channel.target_id.is_empty() {
        return Err("飞书通道需要 App ID、App Secret 和接收目标".to_string());
    }
    let token = feishu_access_token(client, channel).await?;
    let message_id = if request.decision_id.is_some() {
        feishu_send_message(
            client,
            channel,
            &token,
            "interactive",
            feishu_decision_card(request),
        )
        .await?
    } else {
        feishu_send_message(client, channel, &token, "text", json!({ "text": body })).await?
    };
    Ok(AdapterResult {
        message_id: Some(message_id),
    })
}

async fn dingtalk_access_token(
    client: &Client,
    channel: &BotChannelConfig,
) -> Result<String, String> {
    let response = client
        .post("https://api.dingtalk.com/v1.0/oauth2/accessToken")
        .json(&json!({
            "appKey": channel.app_id,
            "appSecret": channel.secret,
        }))
        .send()
        .await
        .map_err(|error| format!("请求钉钉 access_token 失败: {}", error))?;
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("解析钉钉 access_token 响应失败: {}", error))?;
    body.get("accessToken")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("获取钉钉 access_token 失败: {}", body))
}

async fn send_dingtalk(
    client: &Client,
    channel: &BotChannelConfig,
    body: &str,
) -> Result<AdapterResult, String> {
    if channel.app_id.is_empty() || channel.secret.is_empty() {
        return Err("钉钉通道需要 AppKey 与 AppSecret，请扫码配置".to_string());
    }
    if channel.target_id.is_empty() {
        return Err("钉钉通道需要收件人 userId".to_string());
    }
    let token = dingtalk_access_token(client, channel).await?;
    // sampleText 的 msgParam 为 stringified JSON {"content": "..."}。
    let msg_param = serde_json::to_string(&json!({ "content": body }))
        .map_err(|error| format!("构造钉钉消息参数失败: {}", error))?;
    let response = client
        .post("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend")
        .header("x-acs-dingtalk-access-token", &token)
        .json(&json!({
            "robotCode": channel.app_id,
            "userIds": [channel.target_id],
            "msgKey": "sampleText",
            "msgParam": msg_param,
        }))
        .send()
        .await
        .map_err(|error| format!("发送钉钉消息失败: {}", error))?;
    let status = response.status();
    let result: Value = response
        .json()
        .await
        .map_err(|error| format!("解析钉钉消息响应失败: {}", error))?;
    if !status.is_success() {
        return Err(format!("发送钉钉消息失败: {}", result));
    }
    // oToMessages/batchSend 返回 {messageId: {userId: msgId}}，取第一条。
    let message_id = result
        .pointer("/messageId")
        .and_then(Value::as_object)
        .and_then(|map| map.values().next())
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(AdapterResult {
        message_id,
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
    Ok(AdapterResult {
        message_id,
    })
}

async fn dispatch_channel(
    client: &Client,
    channel: &BotChannelConfig,
    request: &BotNotificationRequest,
    body: &str,
) -> Result<AdapterResult, String> {
    match channel.platform.as_str() {
        "feishu" => send_feishu(client, channel, request, body).await,
        "dingtalk" => send_dingtalk(client, channel, body).await,
        "qq" | "bridge" => send_bridge(client, channel, request, body).await,
        other => Err(format!("不支持的机器人平台: {}", other)),
    }
}

#[tauri::command]
pub fn get_bot_settings() -> BotSettings {
    BotSettingsService::get_public()
}

#[tauri::command]
pub fn get_bot_long_connection_status() -> Vec<crate::models::BotLongConnectionStatus> {
    get_feishu_long_connection_status()
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
    if settings.enabled {
        install_claude_http_hooks().map_err(|error| {
            format!("启用机器人通知失败，Claude Code Hooks 注册失败: {}", error)
        })?;
    }
    let saved = BotSettingsService::save(settings)?;
    sync_feishu_long_connections(app.clone())?;
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
    let body = notification_body(&request);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建机器人 HTTP 客户端失败: {}", error))?;
    let mut reports = Vec::new();
    for channel in settings.channels.iter().filter(|channel| channel.enabled) {
        match dispatch_channel(&client, channel, &request, &body).await {
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
                        custom_option_down_count: request.custom_option_down_count,
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
                    error: None,
                });
            }
            Err(error) => reports.push(BotDeliveryReport {
                channel_id: channel.id.clone(),
                channel_name: channel.name.clone(),
                success: false,
                message_id: None,
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
        decision_title: None,
        decision_question: None,
        decision_options: None,
        decision_multi_select: false,
        decision_submit_move_count: None,
        custom_option_down_count: None,
    };
    let body = notification_body(&request);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建机器人 HTTP 客户端失败: {}", error))?;
    match dispatch_channel(&client, channel, &request, &body).await {
        Ok(result) => Ok(BotDeliveryReport {
            channel_id: channel.id.clone(),
            channel_name: channel.name.clone(),
            success: true,
            message_id: result.message_id,
            error: None,
        }),
        Err(error) => Ok(BotDeliveryReport {
            channel_id: channel.id.clone(),
            channel_name: channel.name.clone(),
            success: false,
            message_id: None,
            error: Some(error),
        }),
    }
}

#[tauri::command]
pub async fn test_bot_decision_channel(
    channel_id: String,
) -> Result<BotDeliveryReport, String> {
    let settings = BotSettingsService::get_runtime()?;
    if !settings.enabled {
        return Err("请先启用机器人通知".to_string());
    }
    let channel = settings
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| "机器人通道不存在".to_string())?;
    if channel.platform != "feishu" {
        return Err("测试决策卡片目前仅支持飞书通道".to_string());
    }
    if !channel.enabled {
        return Err("请先启用飞书通道".to_string());
    }
    if channel.allowed_user_ids.is_empty() {
        return Err("请先配置允许操作卡片的用户 ID".to_string());
    }
    let decision_id = uuid::Uuid::new_v4().to_string();
    let request = BotNotificationRequest {
        event_id: uuid::Uuid::new_v4().to_string(),
        decision_id: Some(decision_id.clone()),
        terminal_id: BOT_TEST_TERMINAL_ID.to_string(),
        terminal_name: "通知功能测试".to_string(),
        kind: "question".to_string(),
        title: "TerminalBuddy 测试决策".to_string(),
        summary: "请选择一个测试选项。".to_string(),
        decision_title: Some("决策通知测试".to_string()),
        decision_question: Some(
            "请选择一个选项，用于验证飞书卡片、二次确认和长连接事件。".to_string(),
        ),
        decision_options: Some(vec![
            BotDecisionOption {
                label: "选项 A - 推荐方案".to_string(),
                description: Some("验证当前高亮选项的确认流程。".to_string()),
                move_count: 0,
                recommended: true,
                selected: false,
            },
            BotDecisionOption {
                label: "选项 B - 备用方案".to_string(),
                description: Some("验证方向键选择和确认流程。".to_string()),
                move_count: 1,
                recommended: false,
                selected: false,
            },
            BotDecisionOption {
                label: "选项 C - 其他方案".to_string(),
                description: Some("验证多选项卡片展示。".to_string()),
                move_count: 2,
                recommended: false,
                selected: false,
            },
        ]),
        decision_multi_select: false,
        decision_submit_move_count: None,
        custom_option_down_count: Some(3),
    };
    let body = notification_body(&request);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建机器人 HTTP 客户端失败: {}", error))?;
    match dispatch_channel(&client, channel, &request, &body).await {
        Ok(result) => {
            let Some(message_id) = result.message_id.clone() else {
                return Ok(BotDeliveryReport {
                    channel_id: channel.id.clone(),
                    channel_name: channel.name.clone(),
                    success: false,
                    message_id: None,
                    error: Some("飞书响应缺少消息标识".to_string()),
                });
            };
            BotBindingService::add(DecisionBinding {
                decision_id,
                terminal_id: BOT_TEST_TERMINAL_ID.to_string(),
                terminal_name: "通知功能测试".to_string(),
                channel_id: channel.id.clone(),
                target_id: channel.target_id.clone(),
                external_message_id: message_id,
                custom_option_down_count: Some(3),
                status: "pending".to_string(),
                expires_at: (Utc::now()
                    + Duration::minutes(settings.decision_ttl_minutes as i64))
                .timestamp_millis(),
            })?;
            Ok(BotDeliveryReport {
                channel_id: channel.id.clone(),
                channel_name: channel.name.clone(),
                success: true,
                message_id: result.message_id,
                error: None,
            })
        }
        Err(error) => Ok(BotDeliveryReport {
            channel_id: channel.id.clone(),
            channel_name: channel.name.clone(),
            success: false,
            message_id: None,
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

fn is_recommended_reply(text: &str) -> bool {
    matches!(
        text.trim().to_lowercase().as_str(),
        "确认" | "推荐" | "回车" | "enter" | "ok"
    )
}

fn validate_bot_sender(
    channel: &BotChannelConfig,
    sender_id: &str,
    conversation_id: &str,
) -> Result<(), String> {
    if channel.allowed_user_ids.is_empty()
        || !channel.allowed_user_ids.iter().any(|id| id == sender_id)
    {
        return Err("发送者不在允许名单中".to_string());
    }
    if channel.receive_id_type == "chat_id"
        && !channel.target_id.is_empty()
        && channel.target_id != conversation_id
    {
        return Err("消息不属于配置的目标会话".to_string());
    }
    Ok(())
}

fn emit_bot_reply_forwarded(
    app: &AppHandle,
    binding: &DecisionBinding,
    channel_id: &str,
    sender_id: &str,
    message_id: &str,
) {
    let _ = app.emit(
        "claude-bot-reply-forwarded",
        json!({
            "decisionId": binding.decision_id,
            "terminalId": binding.terminal_id,
            "terminalName": binding.terminal_name,
            "channelId": channel_id,
            "senderId": sender_id,
            "messageId": message_id,
        }),
    );
}

pub fn process_bot_card_selection(
    app: &AppHandle,
    terminal_service: &TerminalService,
    channel: &BotChannelConfig,
    sender_id: &str,
    conversation_id: &str,
    message_id: &str,
    card_message_id: &str,
    move_count: i16,
) -> Result<String, String> {
    validate_bot_sender(channel, sender_id, conversation_id)?;
    if move_count.unsigned_abs() > 20 {
        return Err("选项位置无效，请返回终端操作".to_string());
    }
    let binding = BotBindingService::consume_with(&channel.id, card_message_id, |binding| {
        if move_count >= 0
            && crate::services::ClaudeHookService::answer_card(
                &binding.decision_id,
                &[move_count as usize],
            )?
        {
            return Ok(());
        }
        if binding.terminal_id == BOT_TEST_TERMINAL_ID {
            return Ok(());
        }
        let exists = terminal_service
            .instances
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&binding.terminal_id);
        if !exists {
            return Err("对应终端已经关闭".to_string());
        }
        let arrow = if move_count >= 0 { "\x1b[B" } else { "\x1b[A" };
        let data = format!("{}\r", arrow.repeat(move_count.unsigned_abs() as usize));
        terminal_service.write_to_terminal(&binding.terminal_id, &data)
    })?;
    if binding.terminal_id == BOT_TEST_TERMINAL_ID {
        return Ok("测试决策回调成功".to_string());
    }
    emit_bot_reply_forwarded(app, &binding, &channel.id, sender_id, message_id);
    Ok(format!("已提交选项：{}", binding.terminal_name))
}

fn multi_select_input(
    selected_move_counts: &[i16],
    initial_selected_move_counts: &[i16],
    submit_move_count: i16,
) -> Result<String, String> {
    if submit_move_count.unsigned_abs() > 20
        || selected_move_counts
            .iter()
            .chain(initial_selected_move_counts)
            .any(|value| value.unsigned_abs() > 20)
    {
        return Err("多选项位置无效，请返回终端操作".to_string());
    }
    let selected = selected_move_counts.iter().copied().collect::<HashSet<_>>();
    let initial = initial_selected_move_counts
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let mut toggles = selected
        .symmetric_difference(&initial)
        .copied()
        .collect::<Vec<_>>();
    toggles.sort_unstable();

    let mut data = String::new();
    let mut cursor = 0i16;
    for target in toggles {
        let delta = target - cursor;
        let arrow = if delta >= 0 { "\x1b[B" } else { "\x1b[A" };
        data.push_str(&arrow.repeat(delta.unsigned_abs() as usize));
        data.push(' ');
        cursor = target;
    }
    let delta = submit_move_count - cursor;
    let arrow = if delta >= 0 { "\x1b[B" } else { "\x1b[A" };
    data.push_str(&arrow.repeat(delta.unsigned_abs() as usize));
    data.push('\r');
    Ok(data)
}

pub fn process_bot_multi_selection(
    app: &AppHandle,
    terminal_service: &TerminalService,
    channel: &BotChannelConfig,
    sender_id: &str,
    conversation_id: &str,
    message_id: &str,
    card_message_id: &str,
    selected_move_counts: &[i16],
    initial_selected_move_counts: &[i16],
    submit_move_count: i16,
) -> Result<String, String> {
    validate_bot_sender(channel, sender_id, conversation_id)?;
    let binding = BotBindingService::consume_with(&channel.id, card_message_id, |binding| {
        let selected_indexes = selected_move_counts
            .iter()
            .map(|value| usize::try_from(*value).map_err(|_| "多选项位置无效".to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        if crate::services::ClaudeHookService::answer_card(
            &binding.decision_id,
            &selected_indexes,
        )? {
            return Ok(());
        }
        let data = multi_select_input(
            selected_move_counts,
            initial_selected_move_counts,
            submit_move_count,
        )?;
        if binding.terminal_id == BOT_TEST_TERMINAL_ID {
            return Ok(());
        }
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
    if binding.terminal_id == BOT_TEST_TERMINAL_ID {
        return Ok("测试多选决策回调成功".to_string());
    }
    emit_bot_reply_forwarded(app, &binding, &channel.id, sender_id, message_id);
    Ok(format!("已提交多选项：{}", binding.terminal_name))
}

pub fn process_bot_reply(
    app: &AppHandle,
    terminal_service: &TerminalService,
    channel: &BotChannelConfig,
    inbound: &BridgeInboundMessage,
) -> Result<String, String> {
    validate_bot_sender(channel, &inbound.sender_id, &inbound.conversation_id)?;
    let reply_to = inbound
        .reply_to_message_id
        .as_deref()
        .ok_or_else(|| "请引用需要决策的机器人消息后再回复".to_string())?;
    let settings = BotSettingsService::get_runtime()?;
    let use_recommended = is_recommended_reply(&inbound.text);
    let binding = BotBindingService::consume_with(&channel.id, reply_to, |binding| {
        let hook_reply = if use_recommended {
            crate::services::ClaudeHookService::answer_card(&binding.decision_id, &[0])?
        } else {
            crate::services::ClaudeHookService::answer_card_text(
                &binding.decision_id,
                &inbound.text,
            )?
        };
        if hook_reply {
            return Ok(());
        }
        if binding.terminal_id == BOT_TEST_TERMINAL_ID {
            return Ok(());
        }
        let exists = terminal_service
            .instances
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&binding.terminal_id);
        if !exists {
            return Err("对应终端已经关闭".to_string());
        }
        let data = if use_recommended {
            "\r".to_string()
        } else {
            let down_count = binding.custom_option_down_count.ok_or_else(|| {
                "无法识别自定义输入选项，请回复“确认”采用推荐选项或返回终端操作"
                    .to_string()
            })?;
            if down_count > 20 {
                return Err("自定义输入选项位置无效，请返回终端操作".to_string());
            }
            let custom_reply = sanitize_reply(&inbound.text, settings.append_enter)?;
            format!("{}\r{}", "\x1b[B".repeat(down_count as usize), custom_reply)
        };
        terminal_service.write_to_terminal(&binding.terminal_id, &data)
    })?;
    if binding.terminal_id == BOT_TEST_TERMINAL_ID {
        return Ok("测试决策回复成功".to_string());
    }
    emit_bot_reply_forwarded(
        app,
        &binding,
        &channel.id,
        &inbound.sender_id,
        &inbound.message_id,
    );
    let action = if use_recommended {
        "已采用推荐选项"
    } else {
        "已写入自定义消息"
    };
    Ok(format!("{}：{}", action, binding.terminal_name))
}

#[tauri::command]
pub async fn bot_scan_begin(platform: String) -> Result<ScanBeginResult, String> {
    begin_scan(&platform).await
}

#[tauri::command]
pub async fn bot_scan_poll(begin: ScanBeginResult) -> Result<ScanPollResult, String> {
    poll_scan(&begin).await
}

#[cfg(test)]
mod tests {
    use super::multi_select_input;

    #[test]
    fn multi_select_keeps_default_and_submits() {
        assert_eq!(multi_select_input(&[0], &[0], 3).unwrap(), "\x1b[B\x1b[B\x1b[B\r");
    }

    #[test]
    fn multi_select_adds_an_option_before_submitting() {
        assert_eq!(
            multi_select_input(&[0, 1], &[0], 3).unwrap(),
            "\x1b[B \x1b[B\x1b[B\r"
        );
    }

    #[test]
    fn multi_select_replaces_the_default_option() {
        assert_eq!(
            multi_select_input(&[1], &[0], 3).unwrap(),
            " \x1b[B \x1b[B\x1b[B\r"
        );
    }

    #[test]
    fn multi_select_rejects_out_of_range_positions() {
        assert!(multi_select_input(&[21], &[], 3).is_err());
    }
}
