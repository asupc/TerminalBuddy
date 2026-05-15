use crate::models::AppSettings;
use std::fs;
use std::path::PathBuf;

pub struct SettingsService;

impl SettingsService {
    fn get_settings_path() -> PathBuf {
        let base = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("TerminalBuddy");
        fs::create_dir_all(&base).ok();
        base.join("settings.json")
    }

    pub fn get_settings() -> AppSettings {
        let path = Self::get_settings_path();
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(settings) = serde_json::from_str(&content) {
                return settings;
            }
        }
        AppSettings::default()
    }

    pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
        let path = Self::get_settings_path();
        let content = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("序列化设置失败: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("写入设置文件失败: {}", e))
    }
}
