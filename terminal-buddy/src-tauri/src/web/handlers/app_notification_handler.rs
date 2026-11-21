//! App 服务端任务通知：完成 / 失败事件实时推送，待决策事件支持快照补发与回答。
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    Path, Query, State,
};
use axum::response::IntoResponse;
use axum::Json;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::broadcast;

use crate::services::{
    app_notification_service::{AppNotificationEvent, AppNotificationService},
    ClaudeHookService, SettingsService,
};
use crate::web::{
    auth::{verify_token, ClaimsFromRequest},
    error::ApiError,
    server::AppState,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerDecisionRequest {
    #[serde(default)]
    pub answers: HashMap<String, String>,
}

/// App 重连后主动拉取仍未处理的决策，作为 WebSocket 快照之外的补偿入口。
pub async fn list(_claims: ClaimsFromRequest) -> Json<Vec<AppNotificationEvent>> {
    Json(AppNotificationService::pending_decisions())
}

/// 回答 Claude 终端决策。答案按原始问题文本索引，全部回答后回填 CLI。
pub async fn answer(
    _claims: ClaimsFromRequest,
    Path(decision_id): Path<String>,
    Json(input): Json<AnswerDecisionRequest>,
) -> Result<Json<Value>, ApiError> {
    ClaudeHookService::answer_all(&decision_id, input.answers).map_err(|error| {
        if error.contains("失效") || error.contains("不存在") {
            ApiError::NotFound(error)
        } else {
            ApiError::BadRequest(error)
        }
    })?;
    Ok(Json(json!({ "success": true })))
}

/// 慢客户端或失效连接不能长期占用发送任务；超时后由外层回收。
async fn send_frame(
    sender: &mut SplitSink<WebSocket, Message>,
    message: Message,
) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(15), sender.send(message)).await,
        Ok(Ok(()))
    )
}

/// 账号级通知连接：先发当前待决策快照，再持续推送完成 / 失败 / 决策事件。
pub async fn socket(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    let token = params
        .get("token")
        .cloned()
        .ok_or_else(|| ApiError::Unauthorized("请先登录".into()))?;
    verify_token(&token, &state.jwt_secret)
        .map_err(|_| ApiError::Unauthorized("登录已过期，请重新登录".into()))?;
    let jwt_secret = state.jwt_secret.clone();
    Ok(ws
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| async move {
            let (mut sender, mut receiver) = socket.split();
            let mut events = AppNotificationService::subscribe();
            let snapshot = AppNotificationService::pending_decisions();
            if !send_frame(
                &mut sender,
                Message::Text(json!({"type":"snapshot","decisions":snapshot}).to_string().into()),
            )
            .await
            {
                return;
            }
            let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = heartbeat.tick() => {
                        if verify_token(&token, &jwt_secret).is_err()
                            || !SettingsService::get_settings().web_api_enabled
                        {
                            break;
                        }
                        // 文本心跳同时用于客户端判断接收链路仍存活；Ping 负责传输层保活。
                        if !send_frame(&mut sender, Message::Text(json!({"type":"heartbeat"}).to_string().into())).await
                            || !send_frame(&mut sender, Message::Ping(Vec::new().into())).await
                        {
                            break;
                        }
                    }
                    message = receiver.next() => match message {
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => {},
                    },
                    event = events.recv() => match event {
                        Ok(event) => {
                            if !send_frame(&mut sender, Message::Text(
                                json!({"type":"event","event":event}).to_string().into(),
                            )).await {
                                break;
                            }
                        }
                        // 慢客户端落后时用最新待决策快照重新对齐，不中断连接。
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let snapshot = AppNotificationService::pending_decisions();
                            if !send_frame(&mut sender, Message::Text(
                                json!({"type":"snapshot","decisions":snapshot}).to_string().into(),
                            )).await {
                                break;
                            }
                        }
                        Err(_) => break,
                    },
                }
            }
        }))
}
