use crate::commands::TerminalService;
use crate::models::{
    BotChannelConfig, BotDecisionOption, BotDeliveryReport, BotNotificationRequest, BotSettings,
    BridgeInboundMessage, DecisionBinding, TerminalActor,
};
use crate::services::bot_channel::{bot_client, dispatch_channel};
use crate::services::{
    begin_scan, get_bot_long_connection_statuses, install_claude_http_hooks, poll_scan,
    sync_bot_long_connections, BotBindingService, BotSettingsService, ScanBeginResult,
    ScanPollResult,
};
use chrono::{Duration, Utc};
use serde_json::json;
use std::collections::HashSet;
use tauri::{AppHandle, Emitter};

const BOT_TEST_TERMINAL_ID: &str = "__terminal_buddy_bot_decision_test__";

/// 终端方向键移动位置上限：超出说明终端状态与卡片不一致，拒绝合成按键序列。
const OPTION_POSITION_LIMIT: u16 = 20;

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
        parts.push("请引用此消息回复：“确认”采用推荐选项，其他内容将作为自定义消息。".to_string());
    }
    parts.join("\n\n")
}

fn is_mobile_bot_notification(kind: &str, decision_id: Option<&str>) -> bool {
    kind == "completed" || decision_id.is_some()
}

#[tauri::command]
pub fn get_bot_settings() -> BotSettings {
    BotSettingsService::get_public()
}

#[tauri::command]
pub fn get_bot_long_connection_status() -> Vec<crate::models::BotLongConnectionStatus> {
    get_bot_long_connection_statuses()
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
    sync_bot_long_connections(app.clone())?;
    crate::commands::web::sync_http_server_for_bot(app)?;
    Ok(saved)
}

/// 由通知请求与通道构造决策绑定记录（send_bot_notification / 通道决策测试共用）。
fn build_decision_binding(
    decision_id: &str,
    request: &BotNotificationRequest,
    channel: &BotChannelConfig,
    message_id: String,
    decision_ttl_minutes: i64,
) -> DecisionBinding {
    let options = request.decision_options.as_deref().unwrap_or_default();
    DecisionBinding {
        decision_id: decision_id.to_string(),
        terminal_id: request.terminal_id.clone(),
        terminal_name: request.terminal_name.clone(),
        channel_id: channel.id.clone(),
        target_id: channel.target_id.clone(),
        external_message_id: message_id,
        custom_option_down_count: request.custom_option_down_count,
        option_move_counts: options.iter().map(|option| option.move_count).collect(),
        option_labels: options
            .iter()
            .map(|option| option.label.trim().to_string())
            .collect(),
        initial_selected_move_counts: options
            .iter()
            .filter(|option| option.selected)
            .map(|option| option.move_count)
            .collect(),
        recommended_move_count: options
            .iter()
            .find(|option| option.recommended)
            .map(|option| option.move_count),
        multi_select: request.decision_multi_select,
        submit_move_count: request.decision_submit_move_count,
        created_at: Utc::now().timestamp_millis(),
        status: "pending".to_string(),
        expires_at: (Utc::now() + Duration::minutes(decision_ttl_minutes)).timestamp_millis(),
    }
}

#[tauri::command]
pub async fn send_bot_notification(
    request: BotNotificationRequest,
) -> Result<Vec<BotDeliveryReport>, String> {
    let settings = BotSettingsService::get_runtime()?;
    if !settings.enabled {
        return Ok(Vec::new());
    }
    if !is_mobile_bot_notification(&request.kind, request.decision_id.as_deref()) {
        return Ok(Vec::new());
    }
    let is_completion = request.kind == "completed";
    if (is_completion && !settings.send_completion_notifications)
        || (!is_completion && !settings.send_decision_notifications)
    {
        return Ok(Vec::new());
    }
    let body = notification_body(&request);
    let client = bot_client(20)?;
    let mut reports = Vec::new();
    for channel in settings.channels.iter().filter(|channel| channel.enabled) {
        match dispatch_channel(&client, channel, &request, &body).await {
            Ok(result) => {
                if let (Some(decision_id), Some(message_id)) =
                    (&request.decision_id, &result.message_id)
                {
                    BotBindingService::add(build_decision_binding(
                        decision_id,
                        &request,
                        channel,
                        message_id.clone(),
                        settings.decision_ttl_minutes as i64,
                    ))?;
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

fn bot_connection_test_request() -> BotNotificationRequest {
    BotNotificationRequest {
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
    }
}

async fn dispatch_connection_test(channel: &BotChannelConfig) -> Result<BotDeliveryReport, String> {
    let request = bot_connection_test_request();
    let body = notification_body(&request);
    let client = bot_client(20)?;
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
pub async fn test_bot_channel(channel_id: String) -> Result<BotDeliveryReport, String> {
    let settings = BotSettingsService::get_runtime()?;
    let channel = settings
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| "机器人通道不存在".to_string())?;
    dispatch_connection_test(channel).await
}

#[tauri::command]
pub async fn verify_bot_channel(channel: BotChannelConfig) -> Result<BotDeliveryReport, String> {
    dispatch_connection_test(&channel).await
}

#[tauri::command]
pub async fn test_bot_decision_channel(channel_id: String) -> Result<BotDeliveryReport, String> {
    let settings = BotSettingsService::get_runtime()?;
    if !settings.enabled {
        return Err("请先启用机器人通知".to_string());
    }
    let channel = settings
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| "机器人通道不存在".to_string())?;
    if !matches!(channel.platform.as_str(), "feishu" | "weixin") {
        return Err("测试决策目前仅支持飞书和微信通道".to_string());
    }
    if !channel.enabled {
        return Err("请先启用该机器人通道".to_string());
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
        decision_question: Some("请选择一个选项，用于验证机器人决策通知和回复事件。".to_string()),
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
    let client = bot_client(20)?;
    match dispatch_channel(&client, channel, &request, &body).await {
        Ok(result) => {
            let Some(message_id) = result.message_id.clone() else {
                return Ok(BotDeliveryReport {
                    channel_id: channel.id.clone(),
                    channel_name: channel.name.clone(),
                    success: false,
                    message_id: None,
                    error: Some("机器人响应缺少消息标识".to_string()),
                });
            };
            BotBindingService::add(build_decision_binding(
                &decision_id,
                &request,
                channel,
                message_id,
                settings.decision_ttl_minutes as i64,
            ))?;
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

#[derive(Debug, Clone, PartialEq)]
enum ParsedDecisionReply {
    Recommended(i16),
    Single { number: usize, move_count: i16 },
    Multi(Vec<(usize, i16)>),
    Custom,
}

fn parse_decision_reply(
    text: &str,
    binding: &DecisionBinding,
) -> Result<ParsedDecisionReply, String> {
    if is_recommended_reply(text) {
        return Ok(ParsedDecisionReply::Recommended(
            binding.recommended_move_count.unwrap_or(0),
        ));
    }
    if binding.option_move_counts.is_empty() {
        return Ok(ParsedDecisionReply::Custom);
    }

    let trimmed = text.trim();
    let is_separator = |character: char| {
        character == ',' || character == '，' || character == '、' || character.is_whitespace()
    };
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_digit() || is_separator(character))
        || !trimmed.chars().any(|character| character.is_ascii_digit())
    {
        return Ok(ParsedDecisionReply::Custom);
    }

    let mut indexes = Vec::new();
    let mut seen = HashSet::new();
    for token in trimmed
        .split(is_separator)
        .filter(|value| !value.is_empty())
    {
        let number = token
            .parse::<usize>()
            .map_err(|_| "选项编号格式无效".to_string())?;
        if number == 0 || number > binding.option_move_counts.len() {
            return Err(format!(
                "选项编号 {} 无效，请回复 1-{}",
                number,
                binding.option_move_counts.len()
            ));
        }
        if seen.insert(number) {
            indexes.push(number - 1);
        }
    }
    if indexes.is_empty() {
        return Err("请至少回复一个选项编号".to_string());
    }
    if !binding.multi_select && indexes.len() != 1 {
        return Err("该决策只能选择一个选项".to_string());
    }

    let selections = indexes
        .into_iter()
        .map(|index| (index + 1, binding.option_move_counts[index]))
        .collect::<Vec<_>>();
    if binding.multi_select {
        Ok(ParsedDecisionReply::Multi(selections))
    } else {
        Ok(ParsedDecisionReply::Single {
            number: selections[0].0,
            move_count: selections[0].1,
        })
    }
}

fn option_feedback(binding: &DecisionBinding, number: usize) -> String {
    let label = binding
        .option_labels
        .get(number.saturating_sub(1))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("未命名选项");
    format!("{}：{}", number, label)
}

fn decision_reply_feedback(binding: &DecisionBinding, reply: &ParsedDecisionReply) -> String {
    match reply {
        ParsedDecisionReply::Recommended(move_count) => {
            let number = binding
                .option_move_counts
                .iter()
                .position(|value| value == move_count)
                .map(|index| index + 1)
                .unwrap_or(1);
            format!("已采用推荐选项 {}", option_feedback(binding, number))
        }
        ParsedDecisionReply::Single { number, .. } => {
            format!("您选择了 {}", option_feedback(binding, *number))
        }
        ParsedDecisionReply::Multi(selections) => {
            let choices = selections
                .iter()
                .map(|(number, _)| option_feedback(binding, *number))
                .collect::<Vec<_>>()
                .join("；");
            format!("您选择了 {}", choices)
        }
        ParsedDecisionReply::Custom => format!("已写入自定义消息：{}", binding.terminal_name),
    }
}

fn single_select_input(move_count: i16) -> Result<String, String> {
    if move_count.unsigned_abs() > OPTION_POSITION_LIMIT {
        return Err("选项位置无效，请返回终端操作".to_string());
    }
    let arrow = if move_count >= 0 { "\x1b[B" } else { "\x1b[A" };
    Ok(format!(
        "{}\r",
        arrow.repeat(move_count.unsigned_abs() as usize)
    ))
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
    if move_count.unsigned_abs() > OPTION_POSITION_LIMIT {
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
        terminal_service.write_to_terminal(&binding.terminal_id, &data, TerminalActor::Pc)
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
    if submit_move_count.unsigned_abs() > OPTION_POSITION_LIMIT
        || selected_move_counts
            .iter()
            .chain(initial_selected_move_counts)
            .any(|value| value.unsigned_abs() > OPTION_POSITION_LIMIT)
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
        if crate::services::ClaudeHookService::answer_card(&binding.decision_id, &selected_indexes)?
        {
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
        terminal_service.write_to_terminal(&binding.terminal_id, &data, TerminalActor::Pc)
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
    let settings = BotSettingsService::get_runtime()?;
    let mut parsed_reply: Option<ParsedDecisionReply> = None;
    let binding = BotBindingService::consume_reply_with(
        &channel.id,
        &inbound.sender_id,
        &inbound.conversation_id,
        inbound.reply_to_message_id.as_deref(),
        |binding| {
            let reply = parse_decision_reply(&inbound.text, binding)?;
            parsed_reply = Some(reply.clone());
            let hook_reply = match &reply {
                ParsedDecisionReply::Recommended(move_count)
                | ParsedDecisionReply::Single { move_count, .. }
                    if *move_count >= 0 =>
                {
                    crate::services::ClaudeHookService::answer_card(
                        &binding.decision_id,
                        &[*move_count as usize],
                    )?
                }
                ParsedDecisionReply::Multi(selections)
                    if selections.iter().all(|(_, move_count)| *move_count >= 0) =>
                {
                    let selected_indexes = selections
                        .iter()
                        .map(|(_, move_count)| *move_count as usize)
                        .collect::<Vec<_>>();
                    crate::services::ClaudeHookService::answer_card(
                        &binding.decision_id,
                        &selected_indexes,
                    )?
                }
                ParsedDecisionReply::Custom => {
                    crate::services::ClaudeHookService::answer_card_text(
                        &binding.decision_id,
                        &inbound.text,
                    )?
                }
                _ => false,
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
            let data = match reply {
                ParsedDecisionReply::Recommended(move_count)
                | ParsedDecisionReply::Single { move_count, .. } => {
                    single_select_input(move_count)?
                }
                ParsedDecisionReply::Multi(selections) => {
                    let move_counts = selections
                        .iter()
                        .map(|(_, move_count)| *move_count)
                        .collect::<Vec<_>>();
                    multi_select_input(
                        &move_counts,
                        &binding.initial_selected_move_counts,
                        binding
                            .submit_move_count
                            .ok_or_else(|| "多选决策缺少提交位置，请返回终端操作".to_string())?,
                    )?
                }
                ParsedDecisionReply::Custom => {
                    let down_count = binding.custom_option_down_count.ok_or_else(|| {
                        "无法识别自定义输入选项，请回复编号、回复“确认”或返回终端操作".to_string()
                    })?;
                    if down_count > OPTION_POSITION_LIMIT {
                        return Err("自定义输入选项位置无效，请返回终端操作".to_string());
                    }
                    let custom_reply = sanitize_reply(&inbound.text, settings.append_enter)?;
                    format!("{}\r{}", "\x1b[B".repeat(down_count as usize), custom_reply)
                }
            };
            terminal_service.write_to_terminal(&binding.terminal_id, &data, TerminalActor::Pc)
        },
    )?;
    let reply = parsed_reply.ok_or_else(|| "内部错误：回复解析结果缺失".to_string())?;
    let feedback = decision_reply_feedback(&binding, &reply);
    if binding.terminal_id == BOT_TEST_TERMINAL_ID {
        return Ok(feedback);
    }
    emit_bot_reply_forwarded(
        app,
        &binding,
        &channel.id,
        &inbound.sender_id,
        &inbound.message_id,
    );
    Ok(feedback)
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
    use super::{
        decision_reply_feedback, multi_select_input, parse_decision_reply, ParsedDecisionReply,
    };
    use crate::models::{BotDecisionOption, BotNotificationRequest, DecisionBinding};
    use crate::services::bot_channel::weixin_decision_body;

    fn decision_binding(multi_select: bool) -> DecisionBinding {
        DecisionBinding {
            decision_id: "decision".to_string(),
            terminal_id: "terminal".to_string(),
            terminal_name: "测试终端".to_string(),
            channel_id: "channel".to_string(),
            target_id: "target".to_string(),
            external_message_id: "message".to_string(),
            custom_option_down_count: Some(3),
            option_move_counts: vec![0, 2, 1],
            option_labels: vec![
                "允许执行".to_string(),
                "拒绝".to_string(),
                "返回终端".to_string(),
            ],
            initial_selected_move_counts: vec![0],
            recommended_move_count: Some(0),
            multi_select,
            submit_move_count: Some(3),
            created_at: 0,
            status: "pending".to_string(),
            expires_at: i64::MAX,
        }
    }

    #[test]
    fn multi_select_keeps_default_and_submits() {
        assert_eq!(
            multi_select_input(&[0], &[0], 3).unwrap(),
            "\x1b[B\x1b[B\x1b[B\r"
        );
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

    #[test]
    fn numbered_reply_maps_to_original_move_count() {
        assert_eq!(
            parse_decision_reply("2", &decision_binding(false)).unwrap(),
            ParsedDecisionReply::Single {
                number: 2,
                move_count: 2,
            }
        );
    }

    #[test]
    fn numbered_multi_reply_accepts_chinese_separator() {
        assert_eq!(
            parse_decision_reply("1，3", &decision_binding(true)).unwrap(),
            ParsedDecisionReply::Multi(vec![(1, 0), (3, 1)])
        );
    }

    #[test]
    fn numbered_reply_rejects_out_of_range_option() {
        assert!(parse_decision_reply("4", &decision_binding(false)).is_err());
    }

    #[test]
    fn mobile_bot_only_accepts_decisions_and_completions() {
        assert!(!super::is_mobile_bot_notification("confirmation", None));
        assert!(!super::is_mobile_bot_notification("question", None));
        assert!(super::is_mobile_bot_notification(
            "question",
            Some("decision")
        ));
        assert!(super::is_mobile_bot_notification("completed", None));
    }

    #[test]
    fn single_reply_feedback_contains_number_and_label() {
        let binding = decision_binding(false);
        let reply = parse_decision_reply("1", &binding).unwrap();
        assert_eq!(
            decision_reply_feedback(&binding, &reply),
            "您选择了 1：允许执行"
        );
    }

    #[test]
    fn weixin_decision_body_contains_numbered_options() {
        let request = BotNotificationRequest {
            event_id: "event".to_string(),
            decision_id: Some("decision".to_string()),
            terminal_id: "terminal".to_string(),
            terminal_name: "测试终端".to_string(),
            kind: "question".to_string(),
            title: "需要确认".to_string(),
            summary: "请选择处理方式".to_string(),
            decision_title: Some("执行命令".to_string()),
            decision_question: Some("是否允许执行？".to_string()),
            decision_options: Some(vec![
                BotDecisionOption {
                    label: "允许执行".to_string(),
                    description: Some("继续运行命令".to_string()),
                    move_count: 0,
                    recommended: true,
                    selected: false,
                },
                BotDecisionOption {
                    label: "拒绝".to_string(),
                    description: None,
                    move_count: 1,
                    recommended: false,
                    selected: false,
                },
            ]),
            decision_multi_select: false,
            decision_submit_move_count: None,
            custom_option_down_count: Some(2),
        };
        let body = weixin_decision_body(&request);
        assert!(body.contains("1. 允许执行（推荐）：继续运行命令\n2. 拒绝"));
        assert!(!body.contains('#'));
        assert!(!body.contains("**"));
        assert!(body.contains("回复选项编号"));
    }
}
