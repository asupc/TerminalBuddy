//! Codex 通用供应商命令；同步文件操作统一交给阻塞线程池。

use super::claude_task;
use crate::models::codex_provider::{CodexProviderInput, CodexProviderState};
use crate::services::{codex_provider_service, llm_provider_service::FetchedModel};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_codex_provider_state() -> Result<CodexProviderState, String> {
    claude_task(codex_provider_service::get_provider_state).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_codex_provider(
    input: CodexProviderInput,
    activate: bool,
) -> Result<CodexProviderState, String> {
    claude_task(move || codex_provider_service::save_provider(input, activate)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn activate_codex_provider(id: String) -> Result<CodexProviderState, String> {
    claude_task(move || codex_provider_service::activate_provider(&id)).await
}

/// 取消默认供应商：恢复 Codex 自身登录/默认配置，但保留已保存的供应商。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn clear_default_codex_provider() -> Result<CodexProviderState, String> {
    claude_task(codex_provider_service::clear_default_provider).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_codex_provider(id: String) -> Result<CodexProviderState, String> {
    claude_task(move || codex_provider_service::delete_provider(&id)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn import_codex_provider() -> Result<CodexProviderState, String> {
    claude_task(codex_provider_service::import_provider).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fetch_codex_provider_models(
    base_url: String,
    api_key: String,
    provider_id: Option<String>,
) -> Result<Vec<FetchedModel>, String> {
    codex_provider_service::fetch_models(base_url, api_key, provider_id).await
}
