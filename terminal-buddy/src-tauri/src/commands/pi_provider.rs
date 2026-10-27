//! Pi 兼容端点供应商命令；同步文件操作统一交给阻塞线程池。

use super::claude_task;
use crate::models::pi_provider::{PiProviderInput, PiProviderState};
use crate::services::{llm_provider_service::FetchedModel, pi_provider_service};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_pi_provider_state() -> Result<PiProviderState, String> {
    claude_task(pi_provider_service::get_provider_state).await
}

/// 新建/更新供应商并同步到 Pi models.json。Pi 是多 provider 并存模型，
/// 保存即生效（`/model` 重载文件后可见）；`activate` 同时把它设为
/// TerminalBuddy 侧的默认供应商（右键菜单平铺其模型）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_pi_provider(
    input: PiProviderInput,
    activate: bool,
) -> Result<PiProviderState, String> {
    claude_task(move || pi_provider_service::save_provider(input, activate)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn activate_pi_provider(id: String) -> Result<PiProviderState, String> {
    claude_task(move || pi_provider_service::activate_provider(&id)).await
}

/// 取消默认供应商：保留卡片，右键菜单不再平铺。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn clear_default_pi_provider() -> Result<PiProviderState, String> {
    claude_task(pi_provider_service::clear_default_provider).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_pi_provider(id: String) -> Result<PiProviderState, String> {
    claude_task(move || pi_provider_service::delete_provider(&id)).await
}

/// 从 models.json 导入一条完整自定义 provider 并纳入管理。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn import_pi_provider(
    pi_provider_id: String,
) -> Result<PiProviderState, String> {
    claude_task(move || pi_provider_service::import_provider(&pi_provider_id)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fetch_pi_provider_models(
    base_url: String,
    api_key: String,
    provider_id: Option<String>,
) -> Result<Vec<FetchedModel>, String> {
    pi_provider_service::fetch_models(base_url, api_key, provider_id).await
}
