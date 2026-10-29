//! 原生 AI 消息 API。复用现有 JWT 和项目范围，任务启动后立即返回。
use axum::{extract::{Path, Query, State, ws::{Message, WebSocketUpgrade}}, response::IntoResponse, Json};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashMap, time::Duration};
use crate::{models::{ai_chat::*, session_history::{SessionHistoryItem, SessionHistoryScanResult}}, services::{ai_chat_service as service, SettingsService}, web::{auth::{ClaimsFromRequest, verify_token}, error::ApiError, server::AppState}};

fn service_error(error: String) -> ApiError {
    if error.contains("不存在") { ApiError::NotFound(error) }
    else if error.contains("正在") { ApiError::Conflict(error) }
    else { ApiError::BadRequest(error) }
}
async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<Json<T>, ApiError> {
    tokio::task::spawn_blocking(job).await.map_err(|e| ApiError::Internal(e.to_string()))?.map(Json).map_err(service_error)
}
/// 以最具体的已登记项目决定可用 Agent，避免子项目禁用后仍继承父目录的权限。
fn ensure_agent_project(path: &str, agent: &str) -> Result<String, ApiError> {
    let project_path = super::ensure_project_scope(path)?;
    if !std::path::Path::new(&project_path).is_dir() { return Err(ApiError::BadRequest("项目目录不可访问".into())); }
    let projects = crate::commands::profile::get_projects().map_err(ApiError::Internal)?;
    let project = projects.iter().filter_map(|project| {
        super::canonical_scope_key(&project.path).ok().map(|key| (key, project))
    }).filter(|(key, _)| project_path == *key || project_path.starts_with(&format!("{key}/")))
        .max_by_key(|(key, _)| key.len());
    let enabled = project.is_some_and(|(_, project)| match agent {
        "claude" => project.enabled_agents.claude,
        "codex" => project.enabled_agents.codex,
        "pi" => project.enabled_agents.pi,
        _ => false,
    });
    if !enabled { return Err(ApiError::Forbidden("该项目未启用所选 Agent，请先在服务端配置并刷新工作台".into())); }
    Ok(project_path)
}
pub async fn catalog(_claims: ClaimsFromRequest) -> Result<Json<AiCatalog>, ApiError> {
    blocking(crate::services::ai_catalog_service::catalog).await
}
pub async fn list(claims: ClaimsFromRequest) -> Result<Json<Vec<AiSession>>, ApiError> {
    blocking(move || service::list(&claims.0.sub)).await
}
pub async fn create(claims: ClaimsFromRequest, Json(mut input): Json<CreateAiSession>) -> Result<Json<AiSession>, ApiError> {
    tokio::task::spawn_blocking(move || {
        // 恢复历史会话时以历史会话所在项目为准，请求携带的项目路径仅用于初始选择。
        if input.resume_session_id.as_deref().is_some_and(|id| !id.trim().is_empty()) {
            let page = service::replay_page(&input.provider, input.resume_session_id.as_deref().unwrap_or(""), 0, 1).map_err(service_error)?;
            input.project_path = page.project_dir;
        }
        input.project_path = ensure_agent_project(&input.project_path, &input.provider)?;
        service::create(&claims.0.sub, input).map(Json).map_err(service_error)
    }).await.map_err(|e| ApiError::Internal(e.to_string()))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub project_dir: Option<String>,
    #[serde(default)]
    pub include_archived: bool,
}

/// App 端按项目 + Agent 浏览 CLI 历史会话（与 PC 端共享同一 SQLite 索引）。
pub async fn history(_claims: ClaimsFromRequest, Query(q): Query<HistoryQuery>) -> Result<Json<Vec<SessionHistoryItem>>, ApiError> {
    blocking(move || service::list_history(&q.agent, q.include_archived, q.project_dir.as_deref())).await
}

/// 展开历史列表前的增量索引：本批同步返回，剩余由后台补齐（与 PC 端历史面板一致）。
pub async fn history_rescan(State(state): State<AppState>, _claims: ClaimsFromRequest, Query(q): Query<HistoryQuery>) -> Result<Json<SessionHistoryScanResult>, ApiError> {
    let app = state.app_handle.clone();
    blocking(move || service::rescan_history(&app, &q.agent)).await
}
pub async fn resume_codex_history(claims: ClaimsFromRequest, Path(id): Path<String>, Json(input): Json<ResumeCodexHistory>) -> Result<Json<AiSession>, ApiError> {
    tokio::task::spawn_blocking(move || {
        uuid::Uuid::parse_str(&id).map_err(|_| ApiError::BadRequest("Codex 历史会话标识无效".into()))?;
        let history = crate::services::codex_history_service::get_replay(&id, 0, usize::MAX).map_err(service_error)?;
        let project_path = ensure_agent_project(&history.project_dir, "codex")?;
        service::resume_codex_history(&claims.0.sub, &id, project_path, input, history).map(Json).map_err(service_error)
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
/// 「立即发送」排队消息：中断当前回复并优先处理（可指定移到队首的消息）。
pub async fn flush(claims: ClaimsFromRequest, Path(id): Path<String>, Json(input): Json<FlushAiQueue>) -> Result<Json<AiSession>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let session = service::get(&id, &claims.0.sub).map_err(service_error)?;
        super::ensure_project_scope(&session.project_path)?;
        service::flush(&id, &claims.0.sub, input.request_id.as_deref()).map_err(service_error)?;
        service::get(&id, &claims.0.sub).map(Json).map_err(service_error)
    }).await.map_err(|e| ApiError::Internal(e.to_string()))?
}
pub async fn update_pending_input(
    claims: ClaimsFromRequest, Path((id, request_id)): Path<(String, String)>, Json(input): Json<UpdateAiPendingInput>,
) -> Result<Json<AiSession>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let session = service::get(&id, &claims.0.sub).map_err(service_error)?;
        super::ensure_project_scope(&session.project_path)?;
        service::update_pending_input(&id, &claims.0.sub, &request_id, input.text).map(Json).map_err(service_error)
    }).await.map_err(|e| ApiError::Internal(e.to_string()))?
}
pub async fn delete_pending_input(
    claims: ClaimsFromRequest, Path((id, request_id)): Path<(String, String)>,
) -> Result<Json<AiSession>, ApiError> {
    blocking(move || service::delete_pending_input(&id, &claims.0.sub, &request_id)).await
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

// 通知连接只承载短摘要，发送卡住或客户端不再响应心跳时及时回收。
// 与不设固定时限的对话正文流分开，避免大量失效后台连接长期驻留服务端。
const NOTIFICATION_SEND_TIMEOUT: Duration = Duration::from_secs(15);
const NOTIFICATION_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);

async fn send_notification_frame(
    sender: &mut futures_util::stream::SplitSink<axum::extract::ws::WebSocket, Message>,
    message: Message,
) -> bool {
    matches!(tokio::time::timeout(NOTIFICATION_SEND_TIMEOUT, sender.send(message)).await, Ok(Ok(())))
}

/// 账号级通知连接独立于对话页面，持续发现空闲会话、跨端新任务与待处理决策。
pub async fn notifications_socket(ws: WebSocketUpgrade, State(state): State<AppState>, Query(params): Query<HashMap<String, String>>) -> Result<impl IntoResponse, ApiError> {
    let token = params.get("token").cloned().ok_or_else(|| ApiError::Unauthorized("请先登录".into()))?;
    let claims = verify_token(&token, &state.jwt_secret).map_err(|_| ApiError::Unauthorized("登录已过期，请重新登录".into()))?;
    let owner = claims.sub;
    let initial = { let owner = owner.clone(); blocking(move || service::list(&owner)).await?.0 };
    Ok(ws.max_message_size(usize::MAX).max_frame_size(usize::MAX).on_upgrade(move |socket| async move {
        let (mut sender, mut receiver) = socket.split();
        let send_updates = async {
            let mut previous: Vec<_> = initial.iter().map(|s| (s.id.clone(), s.revision)).collect();
            if !send_notification_frame(&mut sender, Message::Text(json!({"type":"sessions","sessions":initial}).to_string().into())).await { return; }
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut heartbeat = tokio::time::Instant::now();
            loop {
                interval.tick().await;
                let heartbeat_due = heartbeat.elapsed() >= Duration::from_secs(10);
                // 即使会话持续变化也定期 Ping，不能只发送数据而永远不确认接收端存活。
                if heartbeat_due && !send_notification_frame(&mut sender, Message::Ping(Vec::new().into())).await { break; }
                let current = { let owner = owner.clone(); tokio::task::spawn_blocking(move || service::list(&owner)).await };
                let Ok(Ok(sessions)) = current else { break; };
                let versions: Vec<_> = sessions.iter().map(|s| (s.id.clone(), s.revision)).collect();
                // 保留应用层心跳，兼容旧客户端的最后接收时间与摘要补偿。
                if versions != previous || heartbeat_due {
                    if !send_notification_frame(&mut sender, Message::Text(json!({"type":"sessions","sessions":sessions}).to_string().into())).await { break; }
                    previous = versions;
                }
                if heartbeat_due { heartbeat = tokio::time::Instant::now(); }
            }
        };
        let watch_connection = async {
            let mut interval = tokio::time::interval(Duration::from_secs(10));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let deadline = tokio::time::sleep(NOTIFICATION_HEARTBEAT_TIMEOUT);
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    _ = &mut deadline => break,
                    message = receiver.next() => match message {
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        Some(Ok(_)) => deadline.as_mut().reset(tokio::time::Instant::now() + NOTIFICATION_HEARTBEAT_TIMEOUT),
                    },
                    _ = interval.tick() => {
                        if verify_token(&token, &state.jwt_secret).is_err() || !SettingsService::get_settings().web_api_enabled { break; }
                    }
                }
            }
        };
        tokio::select! { _ = send_updates => {}, _ = watch_connection => {} }
    }))
}
