//! Codex 历史会话命令：列表 / 全文检索 / 回放 / 管理 / 导出。
//! 业务逻辑全在 `services::codex_history_service`，这里只做参数转接。
//! 全部走 `claude_task`：扫描与读取的是数百 MB 的 transcript，绝不能占住 UI 线程。

use super::claude_task;
use crate::models::session_history::{
    SessionHistoryItem, SessionHistoryScanResult, SessionReplayPage, SessionSearchHit,
};
use crate::runtime::AppHandle;
use crate::services::codex_history_service;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn codex_history_rescan(app: AppHandle) -> Result<SessionHistoryScanResult, String> {
    claude_task(move || codex_history_service::scan_and_index(&app)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn codex_history_list(
    include_archived: bool,
    project_dir: Option<String>,
) -> Result<Vec<SessionHistoryItem>, String> {
    claude_task(move || {
        codex_history_service::list_sessions(include_archived, project_dir.as_deref())
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn codex_history_search(
    query: String,
    project_dir: Option<String>,
) -> Result<Vec<SessionSearchHit>, String> {
    claude_task(move || codex_history_service::search(&query, project_dir.as_deref())).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn codex_history_get_replay(
    session_id: String,
    offset: usize,
    limit: usize,
) -> Result<SessionReplayPage, String> {
    claude_task(move || codex_history_service::get_replay(&session_id, offset, limit)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn codex_history_rename(session_id: String, title: String) -> Result<(), String> {
    claude_task(move || codex_history_service::rename_session(&session_id, &title)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn codex_history_set_flags(
    session_id: String,
    starred: Option<bool>,
    archived: Option<bool>,
) -> Result<(), String> {
    claude_task(move || codex_history_service::set_flags(&session_id, starred, archived)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn codex_history_delete(session_id: String) -> Result<(), String> {
    claude_task(move || codex_history_service::delete_session(&session_id)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn codex_history_delete_many(session_ids: Vec<String>) -> Result<(), String> {
    claude_task(move || codex_history_service::delete_sessions(&session_ids)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn codex_history_export(
    session_id: String,
    format: String,
    dest_path: String,
) -> Result<(), String> {
    claude_task(move || codex_history_service::export_session(&session_id, &format, &dest_path))
        .await
}
