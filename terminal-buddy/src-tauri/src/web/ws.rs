use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use crate::commands::TerminalService;
use crate::models::TerminalOwner;
use crate::models::web_api::{WsClientMessage, WsServerMessage};
use crate::services::{SettingsService, WebServiceState};
use crate::web::auth::verify_token;
use crate::web::server::AppState;
use tauri::Manager;

static WS_CONNECTION_COUNT: AtomicUsize = AtomicUsize::new(0);
const MAX_GLOBAL_WS_CONNECTIONS: usize = 50;
const MAX_PER_TERMINAL_WS_CONNECTIONS: usize = 5;
const MAX_WS_MESSAGE_SIZE: usize = 64 * 1024; // 64KB

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(terminal_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let token = params.get("token").ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let _claims = verify_token(token, &state.jwt_secret)?;

    // 权限检查：不共享模式下，Web 端不能连接 PC 端的终端
    let settings = SettingsService::get_settings();
    if !settings.web_api_share_sessions {
        let ts = state.app_handle.state::<TerminalService>();
        let instances = ts.instances.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(terminal) = instances.get(&terminal_id) {
            if terminal.owner == TerminalOwner::Pc {
                return Err(axum::http::StatusCode::FORBIDDEN);
            }
        }
    }

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, terminal_id, state, true)))
}

async fn handle_socket(socket: WebSocket, terminal_id: String, state: AppState, is_web_client: bool) {
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

    // Peek historical output — will be sent AFTER the frontend sends its first
    // resize, so the output is formatted for the correct terminal dimensions.
    let history: String = {
        let ts = state.app_handle.state::<TerminalService>();
        ts.peek_terminal_output(&terminal_id).unwrap_or_default()
    };

    // Channel for error messages and historical output from recv_task to send_task
    let (error_tx, mut error_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // Signal from recv_task → send_task: frontend has sent its first resize,
    // safe to replay historical output now.
    let (ready_tx, mut ready_rx) = tokio::sync::oneshot::channel::<()>();
    let mut ready_tx = Some(ready_tx);

    // Forward PTY output to WebSocket
    let send_task = tokio::spawn(async move {
        // Wait for frontend's first resize before sending historical output,
        // so escape sequences (cursor positioning, etc.) are correct.
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
                            // Manual JSON to avoid serde overhead on hot path
                            let msg = format!("{{\"type\":\"output\",\"data\":{}}}", serde_json::Value::String(data.to_string()));
                            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                        None => {
                            // 广播通道关闭 = PTY 进程已退出，通知 web 端
                            let exited = serde_json::to_string(&WsServerMessage::Exited { code: 0 }).unwrap_or_default();
                            let _ = ws_sender.send(Message::Text(exited.into())).await;
                            break;
                        }
                    }
                }
                error_msg = error_rx.recv() => {
                    match error_msg {
                        Some(msg) => {
                            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                        None => {}
                    }
                }
            }
        }
        let _ = ws_sender.close().await;
    });

    // Forward WebSocket input to PTY
    let app = state.app_handle.clone();
    let tid = terminal_id.clone();
    let recv_task = tokio::spawn(async move {
        let mut ready_sent = false;
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Text(text) => {
                    // Message size limit
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
                                // 权限检查：不共享模式下，PC 端不能输入 Web 端的终端
                                let settings = SettingsService::get_settings();
                                if !settings.web_api_share_sessions && !is_web_client {
                                    let ts = app.state::<TerminalService>();
                                    let instances = ts.instances.lock().unwrap_or_else(|e| e.into_inner());
                                    if let Some(terminal) = instances.get(&tid) {
                                        if terminal.owner == TerminalOwner::Web {
                                            let error_msg = serde_json::to_string(
                                                &WsServerMessage::Error {
                                                    message: "终端由 Web 端管理，PC 端只读".to_string()
                                                }
                                            ).unwrap_or_default();
                                            let _ = error_tx.send(error_msg);
                                            continue;
                                        }
                                    }
                                }

                                let ts = app.state::<TerminalService>();
                                let _ = ts.write_to_terminal(&tid, &data);
                            }
                            WsClientMessage::Resize { cols, rows } => {
                                let cols = cols.clamp(1, 500);
                                let rows = rows.clamp(1, 500);
                                // 权限检查：不共享模式下，PC 端不能 resize Web 端的终端
                                let settings = SettingsService::get_settings();
                                if !settings.web_api_share_sessions && !is_web_client {
                                    let ts = app.state::<TerminalService>();
                                    let instances = ts.instances.lock().unwrap_or_else(|e| e.into_inner());
                                    if let Some(terminal) = instances.get(&tid) {
                                        if terminal.owner == TerminalOwner::Web {
                                            let error_msg = serde_json::to_string(
                                                &WsServerMessage::Error {
                                                    message: "终端由 Web 端管理，PC 端只读".to_string()
                                                }
                                            ).unwrap_or_default();
                                            let _ = error_tx.send(error_msg);
                                            continue;
                                        }
                                    }
                                }

                                // Allow shrink for Web-owned terminals in non-shared mode;
                                // TUI programs require exact PTY size match for correct rendering.
                                let allow_shrink = !settings.web_api_share_sessions && is_web_client;
                                let ts = app.state::<TerminalService>();
                                let _ = ts.resize_terminal(&tid, rows, cols, allow_shrink);

                                // Signal send_task that the frontend has sent its first
                                // resize — historical output can now be safely replayed.
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
