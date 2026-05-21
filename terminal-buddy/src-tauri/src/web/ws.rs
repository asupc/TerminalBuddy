use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use crate::commands::TerminalService;
use crate::models::web_api::{WsClientMessage, WsServerMessage};
use crate::services::WebServiceState;
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
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, terminal_id, state)))
}

async fn handle_socket(socket: WebSocket, terminal_id: String, state: AppState) {
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

    // Forward PTY output to WebSocket
    let send_task = tokio::spawn(async move {
        loop {
            match output_rx.recv().await {
                Some(data) => {
                    if let Ok(msg) = serde_json::to_string(&WsServerMessage::Output { data }) {
                        if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                }
                None => break,
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
                                let ts = app.state::<TerminalService>();
                                let _ = ts.write_to_terminal(&tid, &data);
                            }
                            WsClientMessage::Resize { cols, rows } => {
                                let ts = app.state::<TerminalService>();
                                // Web clients: only grow, never shrink —
                                // prevents mobile/small viewports from
                                // shrinking the PTY under the desktop viewer.
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
