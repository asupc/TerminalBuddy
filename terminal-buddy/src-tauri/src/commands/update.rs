use crate::models::UpdateInfo;
use crate::services::{update_service, SettingsService};

/// 启动时调用：拉取远端 version.json；开关关闭或拉取失败 → 返回 None。
#[tauri::command]
pub async fn check_app_update() -> Option<UpdateInfo> {
    let settings = SettingsService::get_settings();
    if !settings.update_check_enabled {
        return None;
    }
    update_service::fetch_update_info().await
}