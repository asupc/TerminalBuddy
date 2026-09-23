use crate::models::BotChannelConfig;
use crate::services::DatabaseService;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use rand::random;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const WEIXIN_DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
pub const WEIXIN_MAX_TEXT_LENGTH: usize = 2_000;
pub const WEIXIN_REPLY_MARKER: &str = "TerminalBuddy-ID:";

const WEIXIN_APP_CLIENT_VERSION: &str = "131584";
const WEIXIN_CHANNEL_VERSION: &str = "2.2.0";
const WEIXIN_MESSAGE_TYPE_BOT: i64 = 2;
const WEIXIN_MESSAGE_STATE_FINISH: i64 = 2;
const WEIXIN_TEXT_ITEM: i64 = 1;
const WEIXIN_SESSION_EXPIRED: i64 = -14;
const WEIXIN_RATE_LIMIT: i64 = -2;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeixinRuntimeState {
    #[serde(default)]
    pub sync_buf: String,
    #[serde(default)]
    pub context_tokens: HashMap<String, String>,
}

fn state_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_state_unlocked(account_id: &str) -> WeixinRuntimeState {
    DatabaseService::read_weixin_state(account_id)
        .ok()
        .flatten()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn write_state_unlocked(account_id: &str, state: &WeixinRuntimeState) -> Result<(), String> {
    let content = serde_json::to_string(state)
        .map_err(|error| format!("序列化微信连接状态失败: {}", error))?;
    DatabaseService::save_weixin_state(account_id, &content)
}

pub fn load_weixin_state(account_id: &str) -> WeixinRuntimeState {
    let _guard = state_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    read_state_unlocked(account_id)
}

pub fn save_weixin_sync_buf(account_id: &str, sync_buf: &str) -> Result<(), String> {
    let _guard = state_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut state = read_state_unlocked(account_id);
    state.sync_buf = sync_buf.to_string();
    write_state_unlocked(account_id, &state)
}

pub fn save_weixin_context_token(
    account_id: &str,
    user_id: &str,
    token: Option<&str>,
) -> Result<(), String> {
    let _guard = state_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut state = read_state_unlocked(account_id);
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        state
            .context_tokens
            .insert(user_id.to_string(), token.to_string());
    } else {
        state.context_tokens.remove(user_id);
    }
    write_state_unlocked(account_id, &state)
}

pub fn weixin_base_url(channel: &BotChannelConfig) -> Result<String, String> {
    let value = if channel.webhook_url.trim().is_empty() {
        WEIXIN_DEFAULT_BASE_URL
    } else {
        channel.webhook_url.trim_end_matches('/')
    };
    let parsed = reqwest::Url::parse(value)
        .map_err(|error| format!("微信 iLink API 地址无效: {}", error))?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https" || (host != "weixin.qq.com" && !host.ends_with(".weixin.qq.com"))
    {
        return Err("微信 iLink API 地址必须是 weixin.qq.com 的 HTTPS 地址".to_string());
    }
    Ok(value.to_string())
}

fn random_wechat_uin() -> String {
    BASE64_STANDARD.encode(random::<u32>().to_string())
}

async fn weixin_post(
    client: &Client,
    channel: &BotChannelConfig,
    endpoint: &str,
    payload: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let mut payload = payload;
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "微信 iLink 请求体格式无效".to_string())?;
    object.insert(
        "base_info".to_string(),
        json!({ "channel_version": WEIXIN_CHANNEL_VERSION }),
    );
    let body = serde_json::to_string(&payload)
        .map_err(|error| format!("序列化微信 iLink 请求失败: {}", error))?;
    let response = client
        .post(format!("{}/{}", weixin_base_url(channel)?, endpoint))
        .timeout(timeout)
        .header("Content-Type", "application/json")
        .header("AuthorizationType", "ilink_bot_token")
        .header("X-WECHAT-UIN", random_wechat_uin())
        .header("iLink-App-Id", "bot")
        .header("iLink-App-ClientVersion", WEIXIN_APP_CLIENT_VERSION)
        .bearer_auth(&channel.secret)
        .body(body)
        .send()
        .await
        .map_err(|error| format!("请求微信 iLink API 失败: {}", error))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取微信 iLink 响应失败: {}", error))?;
    if !status.is_success() {
        return Err(format!("微信 iLink API 返回 HTTP {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|error| format!("解析微信 iLink 响应失败: {}", error))
}

pub async fn get_weixin_updates(
    client: &Client,
    channel: &BotChannelConfig,
    sync_buf: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    weixin_post(
        client,
        channel,
        "ilink/bot/getupdates",
        json!({ "get_updates_buf": sync_buf }),
        Duration::from_millis(timeout_ms.saturating_add(5_000)),
    )
    .await
}

fn response_code(response: &Value, key: &str) -> i64 {
    response.get(key).and_then(Value::as_i64).unwrap_or(0)
}

pub fn validate_weixin_response(response: &Value, operation: &str) -> Result<(), String> {
    let ret = response_code(response, "ret");
    let errcode = response_code(response, "errcode");
    if ret == 0 && errcode == 0 {
        return Ok(());
    }
    let message = response
        .get("errmsg")
        .or_else(|| response.get("msg"))
        .and_then(Value::as_str)
        .unwrap_or("未知错误");
    Err(format!(
        "微信 iLink {}失败: ret={}, errcode={}, {}",
        operation, ret, errcode, message
    ))
}

fn stale_context_token(response: &Value) -> bool {
    let ret = response_code(response, "ret");
    let errcode = response_code(response, "errcode");
    if ret == WEIXIN_SESSION_EXPIRED || errcode == WEIXIN_SESSION_EXPIRED {
        return true;
    }
    let message = response
        .get("errmsg")
        .and_then(Value::as_str)
        .unwrap_or_default();
    (ret == WEIXIN_RATE_LIMIT || errcode == WEIXIN_RATE_LIMIT)
        && message.eq_ignore_ascii_case("unknown error")
}

async fn send_weixin_chunk(
    client: &Client,
    channel: &BotChannelConfig,
    target_id: &str,
    text: &str,
    context_token: Option<&str>,
    client_id: &str,
) -> Result<bool, String> {
    let build_payload = |context_token: Option<&str>| {
        let mut message = json!({
            "from_user_id": "",
            "to_user_id": target_id,
            "client_id": client_id,
            "message_type": WEIXIN_MESSAGE_TYPE_BOT,
            "message_state": WEIXIN_MESSAGE_STATE_FINISH,
            "item_list": [{
                "type": WEIXIN_TEXT_ITEM,
                "text_item": { "text": text }
            }]
        });
        if let Some(context_token) = context_token.filter(|value| !value.is_empty()) {
            message["context_token"] = Value::String(context_token.to_string());
        }
        json!({ "msg": message })
    };

    let response = weixin_post(
        client,
        channel,
        "ilink/bot/sendmessage",
        build_payload(context_token),
        Duration::from_secs(20),
    )
    .await?;
    if stale_context_token(&response) && context_token.is_some() {
        let retry = weixin_post(
            client,
            channel,
            "ilink/bot/sendmessage",
            build_payload(None),
            Duration::from_secs(20),
        )
        .await?;
        validate_weixin_response(&retry, "发送消息")?;
        return Ok(true);
    }
    validate_weixin_response(&response, "发送消息")?;
    Ok(false)
}

fn split_weixin_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_length = 0usize;
    for character in text.chars() {
        if current_length >= WEIXIN_MAX_TEXT_LENGTH {
            chunks.push(std::mem::take(&mut current));
            current_length = 0;
        }
        current.push(character);
        current_length += 1;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

pub fn new_weixin_message_id() -> String {
    format!("terminal-buddy-weixin-{}", uuid::Uuid::new_v4().simple())
}

pub fn append_weixin_reply_marker(text: &str, message_id: &str) -> String {
    let body = text.trim_end();
    let suffix = format!("\n\n{} {}", WEIXIN_REPLY_MARKER, message_id);
    let available = WEIXIN_MAX_TEXT_LENGTH.saturating_sub(suffix.chars().count());
    let body = if body.chars().count() <= available {
        body.to_string()
    } else {
        let separator = "\n\n…\n\n";
        let separator_length = separator.chars().count();
        let tail_length = available.saturating_sub(separator_length).min(420);
        let head_length = available.saturating_sub(tail_length + separator_length);
        let head = body.chars().take(head_length).collect::<String>();
        let mut tail = body.chars().rev().take(tail_length).collect::<Vec<_>>();
        tail.reverse();
        format!(
            "{}{}{}",
            head,
            separator,
            tail.into_iter().collect::<String>()
        )
    };
    format!("{}{}", body, suffix)
}

pub async fn send_weixin_text_with_id(
    client: &Client,
    channel: &BotChannelConfig,
    target_id: &str,
    text: &str,
    message_id: &str,
) -> Result<(), String> {
    if channel.app_id.trim().is_empty() || channel.secret.trim().is_empty() {
        return Err("微信通道需要 Bot ID 与 Bot Token，请先扫码配置".to_string());
    }
    if target_id.trim().is_empty() {
        return Err("微信通道需要目标用户 ID".to_string());
    }
    if text.trim().is_empty() {
        return Err("微信通知内容为空".to_string());
    }

    let mut context_token = load_weixin_state(&channel.app_id)
        .context_tokens
        .get(target_id)
        .cloned();
    let chunks = split_weixin_text(text);
    let last_index = chunks.len().saturating_sub(1);
    for (index, chunk) in chunks.iter().enumerate() {
        let chunk_id = if index == last_index {
            message_id.to_string()
        } else {
            new_weixin_message_id()
        };
        let used_tokenless_fallback = send_weixin_chunk(
            client,
            channel,
            target_id,
            chunk,
            context_token.as_deref(),
            &chunk_id,
        )
        .await?;
        if used_tokenless_fallback {
            let _ = save_weixin_context_token(&channel.app_id, target_id, None);
            context_token = None;
        }
        if index < last_index {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
    Ok(())
}

pub async fn send_weixin_reply(
    client: &Client,
    channel: &BotChannelConfig,
    target_id: &str,
    text: &str,
) -> Result<(), String> {
    let message_id = new_weixin_message_id();
    send_weixin_text_with_id(client, channel, target_id, text, &message_id).await
}

pub fn extract_weixin_text(message: &Value) -> String {
    let Some(items) = message.get("item_list").and_then(Value::as_array) else {
        return String::new();
    };
    for item in items {
        if item.get("type").and_then(Value::as_i64) == Some(WEIXIN_TEXT_ITEM) {
            return item
                .pointer("/text_item/text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
    }
    String::new()
}

fn marker_from_text(text: &str) -> Option<String> {
    let marker_index = text.rfind(WEIXIN_REPLY_MARKER)?;
    text[marker_index + WEIXIN_REPLY_MARKER.len()..]
        .split_whitespace()
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn extract_weixin_reply_to(message: &Value) -> Option<String> {
    let items = message.get("item_list")?.as_array()?;
    for item in items {
        let Some(reference) = item.get("ref_msg") else {
            continue;
        };
        if let Some(text) = reference
            .pointer("/message_item/text_item/text")
            .and_then(Value::as_str)
        {
            if let Some(message_id) = marker_from_text(text) {
                return Some(message_id);
            }
        }
        for pointer in [
            "/message_id",
            "/client_id",
            "/msg_id",
            "/message_item/message_id",
            "/message_item/client_id",
            "/message_item/msg_id",
        ] {
            if let Some(value) = reference
                .pointer(pointer)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        append_weixin_reply_marker, extract_weixin_reply_to, split_weixin_text,
        WEIXIN_MAX_TEXT_LENGTH,
    };
    use serde_json::json;

    #[test]
    fn text_split_counts_unicode_characters() {
        let chunks = split_weixin_text(&"微".repeat(WEIXIN_MAX_TEXT_LENGTH + 1));
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chars().count(), WEIXIN_MAX_TEXT_LENGTH);
        assert_eq!(chunks[1], "微");
    }

    #[test]
    fn quoted_marker_recovers_outbound_message_id() {
        let message = json!({
            "item_list": [{
                "type": 1,
                "text_item": { "text": "确认" },
                "ref_msg": {
                    "message_item": {
                        "type": 1,
                        "text_item": { "text": "通知\n\nTerminalBuddy-ID: message-123" }
                    }
                }
            }]
        });
        assert_eq!(
            extract_weixin_reply_to(&message).as_deref(),
            Some("message-123")
        );
    }

    #[test]
    fn mobile_quote_extracts_server_message_id_without_text() {
        let message = json!({
            "item_list": [{
                "type": 1,
                "text_item": { "text": "1" },
                "ref_msg": {
                    "message_item": {
                        "type": 0,
                        "msg_id": "7483828209308800008"
                    }
                }
            }]
        });
        assert_eq!(
            extract_weixin_reply_to(&message).as_deref(),
            Some("7483828209308800008")
        );
    }

    #[test]
    fn decision_marker_stays_in_one_message() {
        let text = format!(
            "{}\n\n请引用本消息回复选项编号（如 2）。",
            "问".repeat(3_000)
        );
        let message = append_weixin_reply_marker(&text, "message-123");
        assert_eq!(message.chars().count(), WEIXIN_MAX_TEXT_LENGTH);
        assert!(message.contains("请引用本消息回复选项编号"));
        assert!(message.ends_with("TerminalBuddy-ID: message-123"));
    }
}
