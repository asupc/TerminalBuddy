//! Antigravity（agy）多账号管理命令。
use super::claude_task;
use crate::models::antigravity_account::{
    AntigravityAccountState, AntigravityOAuthCompleteInput, AntigravityOAuthStartResult,
    AntigravityTokenInput,
};
use crate::services::antigravity_account_service;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_antigravity_account_state() -> Result<AntigravityAccountState, String> {
    claude_task(antigravity_account_service::get_account_state).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_antigravity_account_token(
    input: AntigravityTokenInput,
) -> Result<AntigravityAccountState, String> {
    antigravity_account_service::save_account_from_token(input).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn import_local_antigravity_account() -> Result<AntigravityAccountState, String> {
    antigravity_account_service::import_local_account().await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_default_antigravity_account(
    id: Option<String>,
) -> Result<AntigravityAccountState, String> {
    claude_task(move || antigravity_account_service::set_default_account(id.as_deref())).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn rename_antigravity_account(
    id: String,
    alias: String,
) -> Result<AntigravityAccountState, String> {
    claude_task(move || antigravity_account_service::rename_account(&id, &alias)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_antigravity_account(id: String) -> Result<AntigravityAccountState, String> {
    claude_task(move || antigravity_account_service::delete_account(&id)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn start_antigravity_oauth_login() -> Result<AntigravityOAuthStartResult, String> {
    claude_task(antigravity_account_service::start_oauth_login).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn complete_antigravity_oauth_login(
    input: AntigravityOAuthCompleteInput,
) -> Result<AntigravityAccountState, String> {
    antigravity_account_service::complete_oauth_login(input).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn cancel_antigravity_oauth_login(login_id: String) -> Result<(), String> {
    claude_task(move || antigravity_account_service::cancel_oauth_login(&login_id)).await
}
