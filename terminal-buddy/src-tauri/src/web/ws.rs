use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use crate::commands::TerminalService;
use crate::models::TerminalOwner;
use crate::models::web_api::{WsClientMessage, WsServerMessage};
use crate::services::{SettingsService, WebServiceState};
use crate::web::auth::verify_token;
use crate::web::server::AppState;
use tauri::Manager;

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
        let instances = ts.instances.lock().unwrap();
        if let Some(terminal) = instances.get(&terminal_id) {
            if terminal.owner == TerminalOwner::Pc {
                return Err(axum::http::StatusCode::FORBIDDEN);
            }
        }
    }

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, terminal_id, state, true)))
}

async fn handle_socket(socket: WebSocket, terminal_id: String, state: AppState, is_web_client: bool) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    let web_state = state.app_handle.state::<WebServiceState>();
    let (sub_id, mut output_rx) = web_state.subscribe(&terminal_id);

    // Send historical output (peek without clearing, so reconnecting viewers also get history)
    {
        let ts = state.app_handle.state::<TerminalService>();
        if let Ok(history) = ts.peek_terminal_output(&terminal_id) {
            if !history.is_empty() {
                if let Ok(msg) = serde_json::to_string(&WsServerMessage::Output { data: history }) {
                    let _ = ws_sender.send(Message::Text(msg.into())).await;
                }
            }
        }
    }

    // Channel for error messages from recv_task to send_task
    let (error_tx, mut error_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Forward PTY output to WebSocket
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                data = output_rx.recv() => {
                    match data {
                        Some(data) => {
                            // Manual JSON to avoid serde overhead on hot path
                            let msg = format!("{{\"type\":\"output\",\"data\":{}}}", serde_json::Value::String(data.to_string()));
                            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break,
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
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(cmd) = serde_json::from_str::<WsClientMessage>(&text) {
                        match cmd {
                            WsClientMessage::Input { data } => {
                                // 权限检查：不共享模式下，PC 端不能输入 Web 端的终端
                                let settings = SettingsService::get_settings();
                                if !settings.web_api_share_sessions && !is_web_client {
                                    let ts = app.state::<TerminalService>();
                                    let instances = ts.instances.lock().unwrap();
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
                                // 权限检查：不共享模式下，PC 端不能 resize Web 端的终端
                                let settings = SettingsService::get_settings();
                                if !settings.web_api_share_sessions && !is_web_client {
                                    let ts = app.state::<TerminalService>();
                                    let instances = ts.instances.lock().unwrap();
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
                                let _ = ts.resize_terminal(&tid, rows, cols, false);
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
}
