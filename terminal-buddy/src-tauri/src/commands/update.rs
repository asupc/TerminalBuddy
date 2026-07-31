use crate::models::UpdateInfo;
use crate::services::update_service;

/// 启动时调用：拉取远端 version.json；拉取失败 → 返回 None。
#[tauri::command]
pub async fn check_app_update() -> Option<UpdateInfo> {
    update_service::fetch_update_info().await
}
