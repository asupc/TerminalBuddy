use crate::models::{AppSettings, CloseBehavior};
use crate::services::SettingsService;

#[tauri::command]
pub fn get_app_settings() -> AppSettings {
    SettingsService::get_settings()
}

#[tauri::command]
pub fn save_close_behavior(behavior: String) -> Result<(), String> {
    let behavior = match behavior.as_str() {
        "exit" => CloseBehavior::Exit,
        "tray" => CloseBehavior::Tray,
        _ => return Err(format!("无效的关闭行为: {}", behavior)),
    };
    let mut settings = SettingsService::get_settings();
    settings.close_behavior = behavior;
    SettingsService::save_settings(&settings)
}
