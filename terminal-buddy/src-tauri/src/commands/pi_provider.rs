//! Pi 兼容端点供应商命令；同步文件操作统一交给阻塞线程池。

use super::claude_task;
use crate::models::pi_provider::{PiProviderInput, PiProviderState};
use crate::services::{llm_provider_service::FetchedModel, pi_provider_service};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_pi_provider_state() -> Result<PiProviderState, String> {
    claude_task(pi_provider_service::get_provider_state).await
}

/// 新建/更新供应商并同步到 Pi models.json。Pi 是多 provider 并存模型，
/// 没有全局"默认激活"概念，保存即生效（`/model` 重载文件后可见）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_pi_provider(input: PiProviderInput) -> Result<PiProviderState, String> {
    claude_task(move || pi_provider_service::save_provider(input)).await
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
