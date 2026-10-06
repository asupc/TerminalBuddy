//! Claude Code 历史会话命令：列表 / 全文检索 / 回放 / 管理 / 导出。
//! 业务逻辑全在 `services::claude_history_service`，这里只做参数转接。
//! 全部走 `claude_task`：扫描与读取的是数百 MB 的 transcript，绝不能占住 UI 线程。

use super::claude_task;
use crate::services::claude_history_service::{
    self, ClaudeHistoryScanResult, ClaudeReplayPage, ClaudeSearchHit, ClaudeSessionItem,
};
use tauri::AppHandle;

#[tauri::command]
pub async fn claude_history_rescan(app: AppHandle) -> Result<ClaudeHistoryScanResult, String> {
    claude_task(move || claude_history_service::scan_and_index(&app)).await
}

#[tauri::command]
pub async fn claude_history_list(
    include_archived: bool,
    project_dir: Option<String>,
) -> Result<Vec<ClaudeSessionItem>, String> {
    claude_task(move || claude_history_service::list_sessions(include_archived, project_dir.as_deref()))
        .await
}

#[tauri::command]
pub async fn claude_history_search(
    query: String,
    project_dir: Option<String>,
) -> Result<Vec<ClaudeSearchHit>, String> {
    claude_task(move || claude_history_service::search(&query, project_dir.as_deref())).await
}

#[tauri::command]
pub async fn claude_history_get_replay(
    session_id: String,
    offset: usize,
    limit: usize,
) -> Result<ClaudeReplayPage, String> {
    claude_task(move || claude_history_service::get_replay(&session_id, offset, limit)).await
}

#[tauri::command]
pub async fn claude_history_rename(session_id: String, title: String) -> Result<(), String> {
    claude_task(move || claude_history_service::rename_session(&session_id, &title)).await
}

#[tauri::command]
pub async fn claude_history_set_flags(
    session_id: String,
    starred: Option<bool>,
    archived: Option<bool>,
) -> Result<(), String> {
    claude_task(move || claude_history_service::set_flags(&session_id, starred, archived)).await
}

#[tauri::command]
pub async fn claude_history_delete(session_id: String) -> Result<(), String> {
    claude_task(move || claude_history_service::delete_session(&session_id)).await
}

#[tauri::command]
pub async fn claude_history_delete_many(session_ids: Vec<String>) -> Result<(), String> {
    claude_task(move || claude_history_service::delete_sessions(&session_ids)).await
}

#[tauri::command]
pub async fn claude_history_export(
    session_id: String,
    format: String,
    dest_path: String,
) -> Result<(), String> {
    claude_task(move || {
        claude_history_service::export_session(&session_id, &format, &dest_path)
    })
    .await
}
