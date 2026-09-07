use crate::commands::TerminalService;
use crate::models::web_api::{MetaServerMessage, WsClientMessage, WsServerMessage};
use crate::models::{TerminalAccessError, TerminalAction, TerminalActor, TerminalOwner};
use crate::services::{UnsubscribeOutcome, WebServiceState};
use crate::web::auth::verify_token;
use crate::web::server::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::{self, Instant, MissedTickBehavior};

static WS_CONNECTION_COUNT: AtomicUsize = AtomicUsize::new(0);
const MAX_GLOBAL_WS_CONNECTIONS: usize = 50;
const MAX_PER_TERMINAL_WS_CONNECTIONS: usize = 5;
const MAX_WS_MESSAGE_SIZE: usize = 64 * 1024; // 64KB
const WS_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const WS_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
/// 授权复核周期：共享开关在连接存续期间被关闭后，主动断开不再获授权的连接，
/// 避免 PC 终端的输出继续流向 Web 端。
const WS_AUTH_RECHECK_INTERVAL: Duration = Duration::from_secs(5);

/// 全局 WS 连接配额守卫：early return、abort、panic 都会在 drop 时归还配额。
struct WsConnectionSlot;

impl WsConnectionSlot {
    /// 超过全局上限时返回 `None`，且不占用配额。
    fn acquire() -> Option<Self> {
        let previous = WS_CONNECTION_COUNT.fetch_add(1, Ordering::Relaxed);
        if previous >= MAX_GLOBAL_WS_CONNECTIONS {
            WS_CONNECTION_COUNT.fetch_sub(1, Ordering::Relaxed);
            return None;
        }
        Some(Self)
    }
}

impl Drop for WsConnectionSlot {
    fn drop(&mut self) {
        WS_CONNECTION_COUNT.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 把失败原因回传给手机端；通道已关闭时静默丢弃。
fn send_ws_error(error_tx: &UnboundedSender<String>, message: String) {
    if let Ok(msg) = serde_json::to_string(&WsServerMessage::Error { message }) {
        let _ = error_tx.send(msg);
    }
}

// ───────────────────────── 终端 I/O WebSocket ─────────────────────────

pub async fn terminal_ws_handler(
    ws: WebSocketUpgrade,
    Path(terminal_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let token = params
        .get("token")
        .ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let _claims = verify_token(token, &state.jwt_secret)?;

    // 授权必须发生在 upgrade / subscribe / peek history 之前：非共享模式下即使
    // 手机端已经知道 terminal id，也读不到 PC 终端的任何输出。
    let owner = {
        let ts = state.app_handle.state::<TerminalService>();
        ts.authorize(&terminal_id, TerminalActor::Web, TerminalAction::View)
            .map_err(|error| match error {
                TerminalAccessError::NotFound => axum::http::StatusCode::NOT_FOUND,
                TerminalAccessError::Denied { .. } => axum::http::StatusCode::FORBIDDEN,
            })?;
        ts.terminal_owner(&terminal_id)
            .ok_or(axum::http::StatusCode::NOT_FOUND)?
    };
    // 接入 PC 终端即「接管」：PTY 会切到手机尺寸（allow_shrink=true），电脑端
    // 视图随之重排，因此收尾时要通知桌面端恢复。Web 自己的终端不算接管。
    let is_pc_takeover = owner == TerminalOwner::Pc;

    Ok(ws.on_upgrade(move |socket| {
        handle_terminal_socket(socket, terminal_id, state, is_pc_takeover)
    }))
}

async fn handle_terminal_socket(
    socket: WebSocket,
    terminal_id: String,
    state: AppState,
    is_pc_takeover: bool,
) {
    let Some(_connection_slot) = WsConnectionSlot::acquire() else {
        eprintln!(
            "[WS] Global connection limit reached: {}",
            MAX_GLOBAL_WS_CONNECTIONS
        );
        return;
    };

    let (mut ws_sender, mut ws_receiver) = socket.split();

    let web_state = state.app_handle.state::<WebServiceState>();

    // 每终端上限检查与订阅注册在同一把锁内完成，不留并发超限窗口。
    let Some((sub_id, mut output_rx)) =
        web_state.subscribe_within_limit(&terminal_id, MAX_PER_TERMINAL_WS_CONNECTIONS)
    else {
        eprintln!(
            "[WS] Per-terminal connection limit reached for {}",
            terminal_id
        );
        return;
    };

    // Peek historical output — sent AFTER the frontend's first resize so escape
    // sequences (cursor positioning, etc.) are formatted for the correct size.
    let history: String = {
        let ts = state.app_handle.state::<TerminalService>();
        ts.peek_terminal_output(&terminal_id, TerminalActor::Web)
            .unwrap_or_default()
    };

    // recv_task → send_task: error messages channel.
    let (error_tx, mut error_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // recv_task → send_task: frontend sent its first resize, safe to replay history.
    let (ready_tx, mut ready_rx) = tokio::sync::oneshot::channel::<()>();
    let mut ready_tx = Some(ready_tx);
    // Browsers automatically answer protocol-level Ping frames with Pong. This lets
    // the server release a takeover even when a dead client never sends Close.
    let (activity_tx, mut activity_rx) = tokio::sync::watch::channel(Instant::now());
    let heartbeat_terminal_id = terminal_id.clone();

    // Forward PTY output → WebSocket
    let mut send_task = tokio::spawn(async move {
        let mut history_sent = false;
        let mut error_channel_open = true;
        let mut heartbeat = time::interval_at(
            Instant::now() + WS_HEARTBEAT_INTERVAL,
            WS_HEARTBEAT_INTERVAL,
        );
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                ready = &mut ready_rx, if !history_sent => {
                    if ready.is_ok() && !history.is_empty() {
                        if let Ok(msg) = serde_json::to_string(&WsServerMessage::Output { data: history.clone() }) {
                            let _ = ws_sender.send(Message::Text(msg.into())).await;
                        }
                    }
                    history_sent = true;
                }
                _ = heartbeat.tick() => {
                    if ws_sender.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
                data = output_rx.recv() => {
                    match data {
                        Some(data) => {
                            // Manual JSON to avoid serde overhead on the hot path.
                            let msg = format!("{{\"type\":\"output\",\"data\":{}}}", serde_json::Value::String(data.to_string()));
                            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                        None => {
                            // 订阅通道关闭 = PTY 已退出（见 spawn_output_forwarder 的 close_all）。
                            let exited = serde_json::to_string(&WsServerMessage::Exited { code: 0 }).unwrap_or_default();
                            let _ = ws_sender.send(Message::Text(exited.into())).await;
                            break;
                        }
                    }
                }
                error_msg = error_rx.recv(), if error_channel_open => {
                    match error_msg {
                        Some(msg) => {
                            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                        None => error_channel_open = false,
                    }
                }
            }
        }
        let _ = ws_sender.close().await;
    });

    // Forward WebSocket input → PTY
    let app = state.app_handle.clone();
    let tid = terminal_id.clone();
    // 授权复核发生在外层循环，需要一份独立的错误通道句柄把原因告知手机端。
    let auth_error_tx = error_tx.clone();
    let mut recv_task = tokio::spawn(async move {
        let mut ready_sent = false;
        while let Some(result) = ws_receiver.next().await {
            let msg = match result {
                Ok(msg) => msg,
                Err(_) => break,
            };
            activity_tx.send_replace(Instant::now());
            match msg {
                Message::Text(text) => {
                    if text.len() > MAX_WS_MESSAGE_SIZE {
                        eprintln!(
                            "[WS] Message too large: {} bytes, max: {}",
                            text.len(),
                            MAX_WS_MESSAGE_SIZE
                        );
                        send_ws_error(
                            &error_tx,
                            format!(
                                "单条消息超过 {} KB 上限，已丢弃。请减少一次粘贴的内容量。",
                                MAX_WS_MESSAGE_SIZE / 1024
                            ),
                        );
                        continue;
                    }

                    if let Ok(cmd) = serde_json::from_str::<WsClientMessage>(&text) {
                        match cmd {
                            WsClientMessage::Input { data } => {
                                // 逐消息复核：write_to_terminal 内部按当前共享设置授权，
                                // 因此连接存续期间关闭共享后，输入会立刻被拒绝。
                                let ts = app.state::<TerminalService>();
                                if let Err(error) =
                                    ts.write_to_terminal(&tid, &data, TerminalActor::Web)
                                {
                                    send_ws_error(&error_tx, error);
                                }
                            }
                            WsClientMessage::Resize { cols, rows } => {
                                let cols = cols.clamp(1, 500);
                                let rows = rows.clamp(1, 500);
                                // 手机端允许缩小 PTY：让 PTY 列数跟随手机 xterm，
                                // 否则 TUI（如 Claude Code）按更宽的列数绘制会在窄屏溢出。
                                // 多端同看一终端时桌面视图会随之变化，属可接受折中。
                                let ts = app.state::<TerminalService>();
                                match ts.resize_terminal(&tid, rows, cols, true, TerminalActor::Web)
                                {
                                    Ok(()) => {
                                        let _ = app.emit(
                                            "terminal-web-resize",
                                            serde_json::json!({
                                                "terminalId": tid,
                                                "rows": rows,
                                                "cols": cols,
                                            }),
                                        );
                                    }
                                    Err(error) => send_ws_error(&error_tx, error),
                                }

                                // 首个 resize 到达 → 通知 send_task 可以回放历史输出了。
                                if !ready_sent {
                                    ready_sent = true;
                                    if let Some(tx) = ready_tx.take() {
                                        let _ = tx.send(());
                                    }
                                }
                            }
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    enum SocketExit {
        Send,
        Receive,
        HeartbeatTimeout,
        /// 连接存续期间失去 View 授权（共享开关被关闭），携带告知手机端的原因。
        Unauthorized(String),
    }

    // This deadline is outside the sender task so TCP write backpressure cannot
    // prevent a dead connection from being reclaimed.
    let mut heartbeat_deadline = Box::pin(time::sleep(WS_HEARTBEAT_TIMEOUT));
    // 只有接管 PC 终端的连接才可能失去授权，Web 自己的终端无需复核。
    let mut auth_recheck = time::interval_at(
        Instant::now() + WS_AUTH_RECHECK_INTERVAL,
        WS_AUTH_RECHECK_INTERVAL,
    );
    auth_recheck.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let exit_reason = loop {
        tokio::select! {
            _ = &mut send_task => break SocketExit::Send,
            _ = &mut recv_task => break SocketExit::Receive,
            _ = &mut heartbeat_deadline => break SocketExit::HeartbeatTimeout,
            _ = auth_recheck.tick(), if is_pc_takeover => {
                let ts = state.app_handle.state::<TerminalService>();
                // 只有明确的「无权限」才主动断开；NotFound 交给输出通道关闭路径，
                // 那条路径会先给手机端发 Exited。
                if let Err(error @ TerminalAccessError::Denied { .. }) =
                    ts.authorize(&terminal_id, TerminalActor::Web, TerminalAction::View)
                {
                    break SocketExit::Unauthorized(error.to_string());
                }
            }
            activity = activity_rx.changed() => {
                if activity.is_err() {
                    break SocketExit::Receive;
                }
                let last_activity = *activity_rx.borrow_and_update();
                heartbeat_deadline.as_mut().reset(last_activity + WS_HEARTBEAT_TIMEOUT);
            }
        }
    };
    match exit_reason {
        SocketExit::Send => {
            recv_task.abort();
            let _ = recv_task.await;
        }
        SocketExit::Receive => {
            send_task.abort();
            let _ = send_task.await;
        }
        SocketExit::HeartbeatTimeout => {
            eprintln!(
                "[WS] Heartbeat timeout for terminal {}",
                heartbeat_terminal_id
            );
            send_task.abort();
            recv_task.abort();
            let _ = send_task.await;
            let _ = recv_task.await;
        }
        SocketExit::Unauthorized(reason) => {
            eprintln!(
                "[WS] Authorization revoked for terminal {}",
                heartbeat_terminal_id
            );
            // 先停止输入，再把原因冲刷给手机端；超时就直接收尾。
            recv_task.abort();
            let _ = recv_task.await;
            send_ws_error(&auth_error_tx, reason);
            let _ = time::timeout(Duration::from_millis(300), &mut send_task).await;
            send_task.abort();
            let _ = send_task.await;
        }
    }

    let outcome = web_state.unsubscribe(&terminal_id, &sub_id);
    // 只有真正接管过 PC 终端、且本连接是最后一个订阅者时才通知桌面端恢复尺寸。
    // `close_all` 之后 outcome 为 NotFound，终端已经关闭，无需再发恢复事件。
    if is_pc_takeover && outcome == UnsubscribeOutcome::RemovedLast {
        let _ = state
            .app_handle
            .emit("terminal-web-takeover-ended", &terminal_id);
    }
    // 全局配额由 `_connection_slot` 在函数返回时归还，此处不再手工减计数。
}

// ───────────────────────── meta WebSocket（会话列表实时同步） ─────────────────────────

pub async fn meta_ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let token = params
        .get("token")
        .ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let _claims = verify_token(token, &state.jwt_secret)?;

    Ok(ws.on_upgrade(move |socket| handle_meta_socket(socket, state)))
}

async fn handle_meta_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let ts = state.app_handle.state::<TerminalService>();
    let mut change_rx = ts.session_change_tx.subscribe();

    // 连上立即推一次当前会话列表：非共享模式下只有 Web 自己创建的终端，
    // 共享模式下才包含可接管的 PC 终端。过滤逻辑集中在 list_terminals_info_for。
    let initial = MetaServerMessage::Sessions {
        terminals: ts.list_terminals_info_for(TerminalActor::Web),
    };
    let initial_msg = serde_json::to_string(&initial).unwrap_or_default();
    if ws_sender
        .send(Message::Text(initial_msg.into()))
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            biased;
            res = change_rx.recv() => {
                match res {
                    Ok(()) => {
                        let msg = serde_json::to_string(
                            &MetaServerMessage::Sessions { terminals: ts.list_terminals_info_for(TerminalActor::Web) }
                        ).unwrap_or_default();
                        if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                    // 短暂滞后（多次变更合并）→ 跳过本轮，下条广播会再带最新列表。
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = ws_receiver.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
    let _ = ws_sender.close().await;
}
