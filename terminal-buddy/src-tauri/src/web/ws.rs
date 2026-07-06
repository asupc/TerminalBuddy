use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use crate::commands::TerminalService;
use crate::models::TerminalOwner;
use crate::models::web_api::{MetaServerMessage, TerminalInfo, WsClientMessage, WsServerMessage};
use crate::services::WebServiceState;
use crate::web::auth::verify_token;
use crate::web::server::AppState;
use tauri::Manager;

static WS_CONNECTION_COUNT: AtomicUsize = AtomicUsize::new(0);
const MAX_GLOBAL_WS_CONNECTIONS: usize = 50;
const MAX_PER_TERMINAL_WS_CONNECTIONS: usize = 5;
const MAX_WS_MESSAGE_SIZE: usize = 64 * 1024; // 64KB

// ───────────────────────── 终端 I/O WebSocket ─────────────────────────

pub async fn terminal_ws_handler(
    ws: WebSocketUpgrade,
    Path(terminal_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let token = params.get("token").ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let _claims = verify_token(token, &state.jwt_secret)?;

    // 独立池：手机端只能连自己（Web）的终端，PC 端终端一律拒绝，避免抢同一个 PTY。
    {
        let ts = state.app_handle.state::<TerminalService>();
        let instances = ts.instances.lock().unwrap_or_else(|e| e.into_inner());
        match instances.get(&terminal_id) {
            Some(inst) if inst.owner == TerminalOwner::Web => {}
            _ => return Err(axum::http::StatusCode::FORBIDDEN),
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

    // Forward PTY output → WebSocket
    let send_task = tokio::spawn(async move {
        let mut history_sent = false;
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
                error_msg = error_rx.recv() => {
                    if let Some(msg) = error_msg {
                        if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
        let _ = ws_sender.close().await;
    });

    // Forward WebSocket input → PTY
    let app = state.app_handle.clone();
    let tid = terminal_id.clone();
    let recv_task = tokio::spawn(async move {
        let mut ready_sent = false;
        while let Some(Ok(msg)) = ws_receiver.next().await {
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
                                let _ = ts.resize_terminal(&tid, rows, cols, true);

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

    tokio::select! {
        _ = send_task => {}
        _ = recv_task => {}
    }

    web_state.unsubscribe(&terminal_id, &sub_id);
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

/// 手机端独立池：meta 推送只含 Web（手机）终端，PC 端终端不推送。
fn web_terminals(ts: &TerminalService) -> Vec<TerminalInfo> {
    ts.list_terminals_info()
        .into_iter()
        .filter(|t| t.owner == TerminalOwner::Web)
        .collect()
}

async fn handle_meta_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let ts = state.app_handle.state::<TerminalService>();
    let mut change_rx = ts.session_change_tx.subscribe();

    // 连上立即推一次当前会话列表。
    let initial = MetaServerMessage::Sessions { terminals: web_terminals(&ts) };
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
                            &MetaServerMessage::Sessions { terminals: web_terminals(&ts) }
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
