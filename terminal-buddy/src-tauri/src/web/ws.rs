use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use std::collections::HashMap;
use crate::web::auth::verify_token;
use crate::web::server::AppState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(terminal_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(_state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let token = params
        .get("token")
        .ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let _claims = verify_token(token, &_state.jwt_secret)?;
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, terminal_id)))
}

async fn handle_socket(_socket: WebSocket, _terminal_id: String) {
    // Placeholder — full implementation in Task 3
}
