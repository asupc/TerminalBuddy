//! Pi 历史会话命令：列表 / 全文检索 / 回放 / 管理 / 导出。
//! 业务逻辑在 `services::pi_history_service`，这里只做参数转接；
//! 扫描与读取 transcript 全部走阻塞线程池，不占 UI 线程。
use super::claude_task;
use crate::models::session_history::{
    SessionHistoryItem, SessionHistoryScanResult, SessionReplayPage, SessionSearchHit,
};
use crate::runtime::AppHandle;
use crate::services::pi_history_service;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pi_history_rescan(app: AppHandle) -> Result<SessionHistoryScanResult, String> {
    claude_task(move || pi_history_service::scan_and_index(&app)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pi_history_list(
    include_archived: bool,
    project_dir: Option<String>,
) -> Result<Vec<SessionHistoryItem>, String> {
    claude_task(move || pi_history_service::list_sessions(include_archived, project_dir.as_deref())).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pi_history_search(
    query: String,
    project_dir: Option<String>,
) -> Result<Vec<SessionSearchHit>, String> {
    claude_task(move || pi_history_service::search(&query, project_dir.as_deref())).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pi_history_get_replay(
    session_id: String,
    offset: usize,
    limit: usize,
) -> Result<SessionReplayPage, String> {
    claude_task(move || pi_history_service::get_replay(&session_id, offset, limit)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pi_history_rename(session_id: String, title: String) -> Result<(), String> {
    claude_task(move || pi_history_service::rename_session(&session_id, &title)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pi_history_set_flags(
    session_id: String,
    starred: Option<bool>,
    archived: Option<bool>,
) -> Result<(), String> {
    claude_task(move || pi_history_service::set_flags(&session_id, starred, archived)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pi_history_delete(session_id: String) -> Result<(), String> {
    claude_task(move || pi_history_service::delete_session(&session_id)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pi_history_delete_many(session_ids: Vec<String>) -> Result<(), String> {
    claude_task(move || pi_history_service::delete_sessions(&session_ids)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pi_history_export(session_id: String, format: String, dest_path: String) -> Result<(), String> {
    claude_task(move || pi_history_service::export_session(&session_id, &format, &dest_path)).await
}
