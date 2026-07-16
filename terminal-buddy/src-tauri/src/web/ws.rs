use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use crate::commands::TerminalService;
use crate::models::web_api::{MetaServerMessage, WsClientMessage, WsServerMessage};
use crate::services::WebServiceState;
use crate::web::auth::verify_token;
use crate::web::server::AppState;
use tauri::{Emitter, Manager};
use tokio::time::{self, Instant, MissedTickBehavior};

static WS_CONNECTION_COUNT: AtomicUsize = AtomicUsize::new(0);
const MAX_GLOBAL_WS_CONNECTIONS: usize = 50;
const MAX_PER_TERMINAL_WS_CONNECTIONS: usize = 5;
const MAX_WS_MESSAGE_SIZE: usize = 64 * 1024; // 64KB
const WS_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const WS_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);

// ───────────────────────── 终端 I/O WebSocket ─────────────────────────

pub async fn terminal_ws_handler(
    ws: WebSocketUpgrade,
    Path(terminal_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let token = params.get("token").ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let _claims = verify_token(token, &state.jwt_secret)?;

    // 终端存在即可接入：Web（手机自己的）直接继续；PC 端的接入即"接管"，
    // PTY 会切到手机尺寸（allow_shrink=true），电脑端视图随之重排。
    {
        let ts = state.app_handle.state::<TerminalService>();
        let instances = ts.instances.lock().unwrap_or_else(|e| e.into_inner());
        if !instances.contains_key(&terminal_id) {
            return Err(axum::http::StatusCode::NOT_FOUND);
        }
    }

    Ok(ws.on_upgrade(move |socket| handle_terminal_socket(socket, terminal_id, state)))
}

async fn handle_terminal_socket(socket: WebSocket, terminal_id: String, state: AppState) {
    // Global connection limit check
    let current_count = WS_CONNECTION_COUNT.fetch_add(1, Ordering::Relaxed);
    if current_count >= MAX_GLOBAL_WS_CONNECTIONS {
        WS_CONNECTION_COUNT.fetch_sub(1, Ordering::Relaxed);
        eprintln!("[WS] Global connection limit reached: {}", MAX_GLOBAL_WS_CONNECTIONS);
        return;
    }

    let (mut ws_sender, mut ws_receiver) = socket.split();

    let web_state = state.app_handle.state::<WebServiceState>();

    // Per-terminal connection limit check
    let sub_count = web_state.get_subscriber_count(&terminal_id);
    if sub_count >= MAX_PER_TERMINAL_WS_CONNECTIONS {
        WS_CONNECTION_COUNT.fetch_sub(1, Ordering::Relaxed);
        eprintln!("[WS] Per-terminal connection limit reached for {}", terminal_id);
        return;
    }

    let (sub_id, mut output_rx) = web_state.subscribe(&terminal_id);

    // Peek historical output — sent AFTER the frontend's first resize so escape
    // sequences (cursor positioning, etc.) are formatted for the correct size.
    let history: String = {
        let ts = state.app_handle.state::<TerminalService>();
        ts.peek_terminal_output(&terminal_id).unwrap_or_default()
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
                        eprintln!("[WS] Message too large: {} bytes, max: {}", text.len(), MAX_WS_MESSAGE_SIZE);
                        let err_msg = serde_json::to_string(&WsServerMessage::Error {
                            message: "消息过大".to_string(),
                        }).unwrap_or_default();
                        let _ = error_tx.send(err_msg);
                        continue;
                    }

                    if let Ok(cmd) = serde_json::from_str::<WsClientMessage>(&text) {
                        match cmd {
                            WsClientMessage::Input { data } => {
                                let ts = app.state::<TerminalService>();
                                let _ = ts.write_to_terminal(&tid, &data);
                            }
                            WsClientMessage::Resize { cols, rows } => {
                                let cols = cols.clamp(1, 500);
                                let rows = rows.clamp(1, 500);
                                // 手机端允许缩小 PTY：让 PTY 列数跟随手机 xterm，
                                // 否则 TUI（如 Claude Code）按更宽的列数绘制会在窄屏溢出。
                                // 多端同看一终端时桌面视图会随之变化，属可接受折中。
                                let ts = app.state::<TerminalService>();
                                if ts.resize_terminal(&tid, rows, cols, true).is_ok() {
                                    let _ = app.emit("terminal-web-resize", serde_json::json!({
                                        "terminalId": tid,
                                        "rows": rows,
                                        "cols": cols,
                                    }));
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
    }

    // This deadline is outside the sender task so TCP write backpressure cannot
    // prevent a dead connection from being reclaimed.
    let mut heartbeat_deadline = Box::pin(time::sleep(WS_HEARTBEAT_TIMEOUT));
    let exit_reason = loop {
        tokio::select! {
            _ = &mut send_task => break SocketExit::Send,
            _ = &mut recv_task => break SocketExit::Receive,
            _ = &mut heartbeat_deadline => break SocketExit::HeartbeatTimeout,
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
            eprintln!("[WS] Heartbeat timeout for terminal {}", heartbeat_terminal_id);
            send_task.abort();
            recv_task.abort();
            let _ = send_task.await;
            let _ = recv_task.await;
        }
    }

    web_state.unsubscribe_and_notify_if_last(&terminal_id, &sub_id, || {
        let _ = state.app_handle.emit("terminal-web-takeover-ended", &terminal_id);
    });
    WS_CONNECTION_COUNT.fetch_sub(1, Ordering::Relaxed);
}

// ───────────────────────── meta WebSocket（会话列表实时同步） ─────────────────────────

pub async fn meta_ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let token = params.get("token").ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let _claims = verify_token(token, &state.jwt_secret)?;

    Ok(ws.on_upgrade(move |socket| handle_meta_socket(socket, state)))
}

async fn handle_meta_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let ts = state.app_handle.state::<TerminalService>();
    let mut change_rx = ts.session_change_tx.subscribe();

    // 连上立即推一次当前会话列表（含 Web 自己的 + PC 端可接管的）。
    let initial = MetaServerMessage::Sessions { terminals: ts.list_terminals_info() };
    let initial_msg = serde_json::to_string(&initial).unwrap_or_default();
    if ws_sender.send(Message::Text(initial_msg.into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            biased;
            res = change_rx.recv() => {
                match res {
                    Ok(()) => {
                        let msg = serde_json::to_string(
                            &MetaServerMessage::Sessions { terminals: ts.list_terminals_info() }
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
