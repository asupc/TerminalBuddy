//! 原生 AI 会话的 Tauri 命令层（桌面端，固定使用 `web_api_username` 作为 owner）。
//! 浏览器（dist-web）调用同组能力但以登录账号为 owner，见
//! `web/handlers/desktop_dispatch.rs` 的显式分支。
//!
//! 参数用逐字段形式（不用 `args: Struct`）：Tauri 命令的参数名即前端 invoke 的
//! 键（camelCase ↔ snake_case 自动转换），浏览器分发侧也按同一组扁平键反序列化。
use super::claude_task;
use crate::models::ai_chat::*;
use crate::services::{ai_catalog_service, ai_chat_service as service, codex_history_service};

/// 桌面端原生会话的归属标识。与 Web API 账号一致，保证桌面与手机看到同一批会话。
pub fn desktop_owner() -> String {
    let name = crate::services::SettingsService::get_settings().web_api_username;
    if name.trim().is_empty() { "admin".to_string() } else { name }
}

/// 会话列表（仅元数据，不含正文）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_list() -> Result<Vec<AiSession>, String> {
    claude_task(|| service::list(&desktop_owner())).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_get(id: String) -> Result<AiSession, String> {
    claude_task(move || service::get(&id, &desktop_owner())).await
}

/// 新建会话，或经 `resumeSessionId` 从 CLI 历史恢复（Claude / Codex 共用）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_create(input: CreateAiSession) -> Result<AiSession, String> {
    claude_task(move || service::create(&desktop_owner(), input)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_send(id: String, input: SendAiMessage) -> Result<AiSession, String> {
    claude_task(move || service::send(&id, &desktop_owner(), input)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_stop(id: String) -> Result<(), String> {
    claude_task(move || service::stop(&id, &desktop_owner())).await
}

/// 空闲时切换供应商与模型（仅 Claude）；返回更新后的会话快照。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_switch_model(id: String, provider_id: String, model: String) -> Result<AiSession, String> {
    claude_task(move || service::switch_model(&id, &desktop_owner(), &provider_id, &model)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_answer(id: String, input: AnswerAiApproval) -> Result<(), String> {
    claude_task(move || service::answer(&id, &desktop_owner(), input)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_delete(id: String) -> Result<(), String> {
    claude_task(move || service::delete(&id, &desktop_owner())).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_pending_update(id: String, request_id: String, text: String) -> Result<AiSession, String> {
    claude_task(move || service::update_pending_input(&id, &desktop_owner(), &request_id, text)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_pending_delete(id: String, request_id: String) -> Result<AiSession, String> {
    claude_task(move || service::delete_pending_input(&id, &desktop_owner(), &request_id)).await
}

/// 把指定排队消息立即插话到当前回合；未指定时取队首。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_flush(id: String, request_id: Option<String>) -> Result<(), String> {
    claude_task(move || service::flush(&id, &desktop_owner(), request_id.as_deref())).await
}

/// 供应商与模型目录（不含密钥）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_catalog() -> Result<AiCatalog, String> {
    claude_task(ai_catalog_service::catalog).await
}

/// CLI 历史会话列表（与手机、PC 历史面板共用同一 SQLite 索引）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_history(agent: String, include_archived: bool, project_dir: Option<String>) -> Result<Vec<crate::models::session_history::SessionHistoryItem>, String> {
    claude_task(move || service::list_history(&agent, include_archived, project_dir.as_deref())).await
}

/// 从 CLI 历史会话恢复为原生会话：Claude 走 `create` 的 `resumeSessionId` 分流，
/// Codex 走 `resume_codex_history`（保留原生 threadId）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ai_session_resume_history(agent: String, session_id: String, provider_id: Option<String>, model: Option<String>) -> Result<AiSession, String> {
    let owner = desktop_owner();
    claude_task(move || match agent.as_str() {
        "claude" => service::create(&owner, CreateAiSession {
            provider: "claude".into(), provider_id, project_path: String::new(), model,
            resume_session_id: Some(session_id),
        }),
        "codex" => {
            let history = codex_history_service::get_replay(&session_id, 0, usize::MAX)?;
            let project_dir = history.project_dir.clone();
            service::resume_codex_history(&owner, &session_id, project_dir,
                ResumeCodexHistory { provider_id, model }, history)
        }
        _ => Err("未知 Agent，请选择 Claude 或 Codex".into()),
    }).await
}
