//! Antigravity 模型供应商配置命令：读取/保存已启用模型与默认推理等级，以及从官网获取可用模型。

use super::claude_task;
use crate::services::antigravity_provider_service::{self, AntigravityProviderConfig};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_antigravity_provider_config() -> Result<AntigravityProviderConfig, String> {
    claude_task(antigravity_provider_service::get_config).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_antigravity_provider_config(
    config: AntigravityProviderConfig,
) -> Result<AntigravityProviderConfig, String> {
    claude_task(move || antigravity_provider_service::save_config(config)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fetch_antigravity_provider_models() -> Result<AntigravityProviderConfig, String> {
    claude_task(antigravity_provider_service::fetch_models).await
}
