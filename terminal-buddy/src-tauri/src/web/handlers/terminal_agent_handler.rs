//! 终端 Agent 会话接力的 REST + WS 入口（Android / 其他 REST 客户端专用）。
//! 统一以 `TerminalActor::Web` 调用共享 use case；网页版 React 走
//! `desktop_dispatch` 的显式分支（同身份），不经过这里。
//! 权限判定全部在 `services::terminal_agent_relay` 内完成，handler 不硬编码 owner。
use axum::extract::{Path, Query, State, ws::{Message, WebSocketUpgrade}};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::collections::HashMap;

use crate::models::TerminalActor;
use crate::runtime::Manager;
use crate::services::terminal_agent_relay as relay;
use crate::web::auth::{verify_token, ClaimsFromRequest};
use crate::web::error::ApiError;
use crate::web::server::AppState;
use futures_util::{SinkExt, StreamExt};

/// 列表：可接力的终端会话（§4.2）。
pub async fn list(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Json<Vec<relay::TerminalAgentSession>> {
    Json(relay::sessions_for(&state.app_handle, TerminalActor::Web).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesQuery {
    after_seq: Option<i64>,
    limit: Option<usize>,
    revision: Option<u64>,
}

/// 消息页：首屏快照或限界增量（§4.4）。非法参数一律 400。
pub async fn messages(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(terminal_id): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> Result<Json<relay::TerminalAgentPage>, ApiError> {
    let page = relay::page_for(
        &state.app_handle,
        TerminalActor::Web,
        &terminal_id,
        query.after_seq,
        query.revision,
        query.limit,
    )
    .await?;
    Ok(Json(page))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyRequest {
    text: String,
    request_id: String,
}

/// 受限回复（§4.6）。
pub async fn reply(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(terminal_id): Path<String>,
    Json(request): Json<ReplyRequest>,
) -> Result<Json<relay::ReplyOutcome>, ApiError> {
    let outcome = relay::reply(
        &state.app_handle,
        TerminalActor::Web,
        &terminal_id,
        &request.text,
        &request.request_id,
    )
    .await?;
    Ok(Json(outcome))
}

/// 镜像 WS（§4.5，Android 专用）。握手前完成 JWT 与 authorize(View)：
/// 未知 404、无权 403；全局 WS 配额不足 409。镜像连接只占全局配额，
/// 不占终端输出的每终端配额。
pub async fn socket(
    ws: WebSocketUpgrade,
    Path(terminal_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    use crate::models::{TerminalAction, TerminalAccessError};
    use crate::commands::TerminalService;

    // 路径参数字符集非法一律 400（§4.9），不进入 authorize。
    if !relay::valid_terminal_id(&terminal_id) {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }
    let token = params.get("token").ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let claims = verify_token(token, &state.jwt_secret)?;
    let exp = claims.exp;
    // 授权必须发生在 upgrade / subscribe 之前（非共享模式下连 PC 终端的镜像也读不到）。
    state
        .app_handle
        .state::<TerminalService>()
        .authorize(&terminal_id, TerminalActor::Web, TerminalAction::View)
        .map_err(|error| match error {
            TerminalAccessError::NotFound => axum::http::StatusCode::NOT_FOUND,
            TerminalAccessError::Denied { .. } => axum::http::StatusCode::FORBIDDEN,
        })?;
    let slot = crate::web::ws::WsConnectionSlot::acquire().ok_or(axum::http::StatusCode::CONFLICT)?;
    let (outcome, receiver) = relay::subscribe(&state.app_handle, TerminalActor::Web, &terminal_id, true)
        .await
        .map_err(|error| ApiError::from(error).into_response().status())?;
    let mut receiver = receiver.expect("WS 订阅应有接收端");
    let subscription_id = outcome.subscription_id;
    let initial = outcome.initial_frame;
    let app_state = state.clone();
    let terminal_id_for_guard = terminal_id.clone();
    Ok(ws.on_upgrade(move |socket| async move {
        // 全局 WS 配额由连接本身持有：升级闭包存活期间占一条，连接结束释放。
        // （若在 handler 层持有，返回升级响应时即被释放，配额合同失效。）
        let _slot = slot;
        // RAII：连接结束（任何路径）释放租约。
        let _guard = SubscriptionGuard { terminal_id: terminal_id_for_guard, subscription_id };
        let (mut sender, mut receiver_socket) = socket.split();
        if let Ok(text) = serde_json::to_string(&initial) {
            if sender.send(Message::Text(text.into())).await.is_err() {
                return;
            }
        }
        let mut ping = tokio::time::interval(std::time::Duration::from_secs(10));
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut recheck = tokio::time::interval(std::time::Duration::from_secs(5));
        recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            tokio::select! {
                frame = receiver.recv() => {
                    let Some(frame) = frame else { break };
                    let Ok(text) = serde_json::to_string(&frame) else { continue };
                    deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
                    if sender.send(Message::Text(text.into())).await.is_err() { break; }
                }
                _ = ping.tick() => {
                    if sender.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                }
                _ = recheck.tick() => {
                    // 每 5 秒复核权限与 JWT 有效期：失权立即断开。
                    if chrono::Utc::now().timestamp() >= exp as i64
                        || app_state
                            .app_handle
                            .state::<crate::commands::TerminalService>()
                            .authorize(&_guard.terminal_id, TerminalActor::Web, TerminalAction::View)
                            .is_err()
                    {
                        break;
                    }
                }
                received = receiver_socket.next() => {
                    match received {
                        // 客户端只需回应协议级 Ping；不接受任何业务输入。
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        Some(Ok(_)) => {
                            deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
                        }
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    // 30 秒无 Pong / 无任何客户端帧即断，避免死连接占用 watcher。
                    break;
                }
            }
        }
        let _ = sender.close().await;
    }))
}

/// 连接结束释放 WS 租约（RAII）。
struct SubscriptionGuard {
    terminal_id: String,
    subscription_id: String,
}

impl Drop for SubscriptionGuard {
    fn drop(&mut self) {
        relay::unsubscribe(&self.terminal_id, &self.subscription_id);
    }
}
