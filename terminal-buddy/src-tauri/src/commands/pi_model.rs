//! Pi 模型目录命令：由 Pi 自己的 `--list-models` 提供数据。
use super::claude_task;
use crate::services::pi_model_service::{self, PiModelProvider};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_pi_models(force: Option<bool>) -> Result<Vec<PiModelProvider>, String> {
    claude_task(move || pi_model_service::list_models(force.unwrap_or(false))).await
}
