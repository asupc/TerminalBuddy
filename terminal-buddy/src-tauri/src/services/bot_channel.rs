//! 机器人通道适配器：飞书 / 钉钉 / 微信 / 桥接的 HTTP 客户端与消息格式化。
//! 决策生命周期的其余部分（binding 管理、回复解析、终端写入）在 commands/bot.rs。

use crate::models::{BotChannelConfig, BotNotificationRequest};
use crate::services::{append_weixin_reply_marker, new_weixin_message_id, send_weixin_text_with_id};
use chrono::Utc;
use reqwest::Client;
use serde_json::{json, Value};

#[derive(Debug)]
pub(crate) struct AdapterResult {
    pub(crate) message_id: Option<String>,
}

/// 构造通道 HTTP 客户端：同一超时策略集中管理。
pub(crate) fn bot_client(timeout_secs: u64) -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|error| format!("创建机器人 HTTP 客户端失败: {}", error))
}

fn truncate_decision_text(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max_chars {
        return compact;
    }
    let mut truncated = compact
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

pub(crate) fn weixin_decision_body(request: &BotNotificationRequest) -> String {
    let title = request
        .decision_title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(request.title.trim());
    let question = request
        .decision_question
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(request.summary.trim());
    let mut parts = vec![
        truncate_decision_text(title, 120),
        format!(
            "终端：{}\n时间：{}",
            request.terminal_name.trim(),
            Utc::now().format("%Y-%m-%d %H:%M:%S")
        ),
    ];
    if !question.trim().is_empty() {
        parts.push(truncate_decision_text(question, 500));
    }

    let options = request.decision_options.as_deref().unwrap_or_default();
    if options.is_empty() {
        parts.push("请引用本消息回复“确认”采用推荐选项，其他内容将作为自定义消息。".to_string());
        return parts.join("\n\n");
    }

    // 微信手机端会重排 Markdown 列表的缩进续行，选项统一输出为单行纯文本。
    let option_lines = options
        .iter()
        .enumerate()
        .map(|(index, option)| {
            let mut flags = Vec::new();
            if option.recommended {
                flags.push("推荐");
            }
            if request.decision_multi_select && option.selected {
                flags.push("已选");
            }
            let suffix = if flags.is_empty() {
                String::new()
            } else {
                format!("（{}）", flags.join("、"))
            };
            let mut line = format!(
                "{}. {}{}",
                index + 1,
                truncate_decision_text(&option.label, 120),
                suffix
            );
            if let Some(description) = option
                .description
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                line.push('：');
                line.push_str(&truncate_decision_text(description, 180));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n");
    parts.push(option_lines);
    parts.push(if request.decision_multi_select {
        "请引用本消息回复选项编号，多个编号用逗号分隔（如 1,3）。".to_string()
    } else {
        "请引用本消息回复选项编号（如 2）；回复“确认”采用推荐选项。".to_string()
    });
    parts.join("\n\n")
}

/// 多选 form 卡片元素（decision_multi_select 且有选项时使用）。
fn build_multi_select_form(request: &BotNotificationRequest, options: &[crate::models::BotDecisionOption]) -> Value {
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
    json!({
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
    })
}

/// 无选项时的“采用推荐选项”按钮元素。
fn build_recommend_only_action() -> Value {
    json!({
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
    })
}

/// 单选逐项按钮元素列表（单选项场景）。
fn build_single_option_actions(options: &[crate::models::BotDecisionOption]) -> Vec<Value> {
    options
        .iter()
        .map(|option| {
            let mut content = option.label.trim().to_string();
            if let Some(description) = option
                .description
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                content.push('\n');
                content.push_str(description.trim());
            }
            let button_label = if option.recommended {
                format!("选择 {}（推荐）", option.label.trim())
            } else {
                format!("选择 {}", option.label.trim())
            };
            let button_label = button_label.chars().take(40).collect::<String>();
            json!({
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
            })
        })
        .collect()
}

/// 飞书交互卡片：多选 form / 无选项推荐按钮 / 单选逐项按钮三个分支。
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
        elements.push(build_multi_select_form(request, options));
    } else if options.is_empty() {
        elements.push(build_recommend_only_action());
    } else {
        elements.extend(build_single_option_actions(options));
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
    let client = bot_client(15)?;
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
    Ok(AdapterResult { message_id })
}

async fn send_weixin(
    client: &Client,
    channel: &BotChannelConfig,
    request: &BotNotificationRequest,
    body: &str,
) -> Result<AdapterResult, String> {
    let message_id = new_weixin_message_id();
    let content = if request.decision_id.is_some() {
        append_weixin_reply_marker(&weixin_decision_body(request), &message_id)
    } else {
        body.to_string()
    };
    send_weixin_text_with_id(client, channel, &channel.target_id, &content, &message_id).await?;
    Ok(AdapterResult {
        message_id: Some(message_id),
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
    Ok(AdapterResult { message_id })
}

pub(crate) async fn dispatch_channel(
    client: &Client,
    channel: &BotChannelConfig,
    request: &BotNotificationRequest,
    body: &str,
) -> Result<AdapterResult, String> {
    match channel.platform.as_str() {
        "feishu" => send_feishu(client, channel, request, body).await,
        "dingtalk" => send_dingtalk(client, channel, body).await,
        "weixin" => send_weixin(client, channel, request, body).await,
        "qq" | "bridge" => send_bridge(client, channel, request, body).await,
        other => Err(format!("不支持的机器人平台: {}", other)),
    }
}
