//! 大模型供应商命令：CRUD / 默认 / 排序 / 拉取模型 / 右键菜单数据源。
//! 业务逻辑在 `services::llm_provider_service`，这里只做参数转接。
//! CRUD 走 `claude_task` 阻塞池；`fetch` 是纯 async 网络请求，直接 await。

use super::claude_task;
use crate::models::llm_provider::{LlmLaunchTarget, LlmProviderInput, LlmProviderView};
use crate::services::llm_provider_service::{self, FetchedModel};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_llm_providers() -> Result<Vec<LlmProviderView>, String> {
    claude_task(move || llm_provider_service::list_providers()).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_llm_provider(input: LlmProviderInput) -> Result<LlmProviderView, String> {
    claude_task(move || llm_provider_service::save_provider(input)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_llm_provider(id: String) -> Result<Vec<LlmProviderView>, String> {
    claude_task(move || llm_provider_service::delete_provider(&id)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_default_llm_provider(id: String) -> Result<Vec<LlmProviderView>, String> {
    claude_task(move || llm_provider_service::set_default_provider(&id)).await
}

/// 取消默认供应商：允许没有默认，此时右键菜单不平铺任何模型。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn clear_default_llm_provider() -> Result<Vec<LlmProviderView>, String> {
    claude_task(llm_provider_service::clear_default_provider).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_llm_provider_order(ids: Vec<String>) -> Result<Vec<LlmProviderView>, String> {
    claude_task(move || llm_provider_service::update_provider_order(&ids)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fetch_llm_provider_models(
    base_url: String,
    api_key: String,
    models_url: String,
    provider_id: Option<String>,
) -> Result<Vec<FetchedModel>, String> {
    llm_provider_service::fetch_provider_models(
        &base_url,
        &api_key,
        &models_url,
        provider_id.as_deref(),
    )
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_claude_launch_targets() -> Result<Vec<LlmLaunchTarget>, String> {
    claude_task(move || llm_provider_service::list_launch_targets()).await
}
