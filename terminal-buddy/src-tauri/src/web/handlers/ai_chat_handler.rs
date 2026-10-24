//! 原生 AI 消息 API。复用现有 JWT 和项目范围，任务启动后立即返回。
use axum::{extract::{Path, Query, State, ws::{Message, WebSocketUpgrade}}, response::IntoResponse, Json};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::{collections::HashMap, time::Duration};
use crate::{models::ai_chat::*, services::{ai_chat_service as service, SettingsService}, web::{auth::{ClaimsFromRequest, verify_token}, error::ApiError, server::AppState}};

fn service_error(error: String) -> ApiError {
    if error == "AI 会话不存在" { ApiError::NotFound(error) }
    else if error.contains("正在") { ApiError::Conflict(error) }
    else { ApiError::BadRequest(error) }
}
async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<Json<T>, ApiError> {
    tokio::task::spawn_blocking(job).await.map_err(|e| ApiError::Internal(e.to_string()))?.map(Json).map_err(service_error)
}
pub async fn catalog(_claims: ClaimsFromRequest) -> Result<Json<AiCatalog>, ApiError> {
    blocking(crate::services::ai_catalog_service::catalog).await
}
pub async fn list(claims: ClaimsFromRequest) -> Result<Json<Vec<AiSession>>, ApiError> {
    blocking(move || service::list(&claims.0.sub)).await
}
pub async fn create(claims: ClaimsFromRequest, Json(mut input): Json<CreateAiSession>) -> Result<Json<AiSession>, ApiError> {
    tokio::task::spawn_blocking(move || {
        input.project_path = super::ensure_project_scope(&input.project_path)?;
        if !std::path::Path::new(&input.project_path).is_dir() { return Err(ApiError::BadRequest("项目目录不可访问".into())); }
        service::create(&claims.0.sub, input).map(Json).map_err(service_error)
    }).await.map_err(|e| ApiError::Internal(e.to_string()))?
}
pub async fn get(claims: ClaimsFromRequest, Path(id): Path<String>) -> Result<Json<AiSession>, ApiError> {
    blocking(move || service::get_with_summary(&id, &claims.0.sub)).await
}
pub async fn send(claims: ClaimsFromRequest, Path(id): Path<String>, Json(input): Json<SendAiMessage>) -> Result<Json<AiSession>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let session = service::get(&id, &claims.0.sub).map_err(service_error)?;
        super::ensure_project_scope(&session.project_path)?;
        service::send(&id, &claims.0.sub, input).map(Json).map_err(service_error)
    }).await.map_err(|e| ApiError::Internal(e.to_string()))?
}
pub async fn stop(claims: ClaimsFromRequest, Path(id): Path<String>) -> Result<Json<()>, ApiError> {
    blocking(move || service::stop(&id, &claims.0.sub)).await
}
pub async fn answer(claims: ClaimsFromRequest, Path(id): Path<String>, Json(input): Json<AnswerAiApproval>) -> Result<Json<()>, ApiError> {
    blocking(move || service::answer(&id, &claims.0.sub, input)).await
}
pub async fn delete(claims: ClaimsFromRequest, Path(id): Path<String>) -> Result<Json<()>, ApiError> {
    blocking(move || service::delete(&id, &claims.0.sub)).await
}
pub async fn socket(ws: WebSocketUpgrade, State(state): State<AppState>, Path(id): Path<String>, Query(params): Query<HashMap<String, String>>) -> Result<impl IntoResponse, ApiError> {
    let token = params.get("token").cloned().ok_or_else(|| ApiError::Unauthorized("请先登录".into()))?;
    let claims = verify_token(&token, &state.jwt_secret).map_err(|_| ApiError::Unauthorized("登录已过期，请重新登录".into()))?;
    let owner = claims.sub;
    let initial = { let id = id.clone(); let owner = owner.clone(); blocking(move || service::get_with_summary(&id, &owner)).await?.0 };
    Ok(ws.max_message_size(usize::MAX).max_frame_size(usize::MAX).on_upgrade(move |socket| async move {
        let (mut sender, mut receiver) = socket.split();
        let send_updates = async {
            let mut revision = initial.revision;
            let mut previous: HashMap<String, String> = initial.messages.iter().map(|m| (m.id.clone(), m.text.clone())).collect();
            let first = json!({"type":"session","session":initial}).to_string();
            if sender.send(Message::Text(first.into())).await.is_err() { return; }
            let mut interval = tokio::time::interval(Duration::from_millis(300));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut heartbeat = tokio::time::Instant::now();
            loop {
                interval.tick().await;
                if heartbeat.elapsed() > Duration::from_secs(10) {
                    if sender.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                    heartbeat = tokio::time::Instant::now();
                }
                let current = { let id = id.clone(); let owner = owner.clone(); tokio::task::spawn_blocking(move || service::get_with_summary(&id, &owner)).await };
                let Ok(Ok(session)) = current else { break; };
                if session.revision == revision { continue; }
                revision = session.revision;
                // 首帧完整恢复，后续仅推送发生变化的消息，避免每段回复都重传全部历史。
                let changed: Vec<_> = session.messages.iter().filter(|m| previous.get(&m.id) != Some(&m.text)).cloned().collect();
                previous = session.messages.iter().map(|m| (m.id.clone(), m.text.clone())).collect();
                let mut metadata = session; metadata.messages.clear();
                let body = json!({"type":"update","session":metadata,"messages":changed}).to_string();
                if sender.send(Message::Text(body.into())).await.is_err() { break; }
            }
        };
        // 独立读取与复核鉴权，大消息发送等待不会阻塞令牌和服务开关检查。
        let watch_connection = async {
            let mut interval = tokio::time::interval(Duration::from_secs(10));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    message = receiver.next() => match message {
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        Some(Ok(_)) => {},
                    },
                    _ = interval.tick() => {
                        if verify_token(&token, &state.jwt_secret).is_err() || !SettingsService::get_settings().web_api_enabled { break; }
                    }
                }
            }
        };
        tokio::select! {
            _ = send_updates => {},
            _ = watch_connection => {},
        }
    }))
}
