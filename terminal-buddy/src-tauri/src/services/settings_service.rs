use crate::models::AppSettings;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

static CACHED_SETTINGS: RwLock<Option<AppSettings>> = RwLock::new(None);

pub struct SettingsService;

impl SettingsService {
    pub fn get_settings_path() -> PathBuf {
        let base = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("TerminalBuddy");
        fs::create_dir_all(&base).ok();
        base.join("settings.json")
    }

    pub fn get_settings() -> AppSettings {
        // Try memory cache first
        if let Ok(cache) = CACHED_SETTINGS.read() {
            if let Some(ref settings) = *cache {
                return settings.clone();
            }
        }
        // Read from disk and cache
        let settings = Self::read_settings_from_disk();
        if let Ok(mut cache) = CACHED_SETTINGS.write() {
            *cache = Some(settings.clone());
        }
        settings
    }

    fn read_settings_from_disk() -> AppSettings {
        let path = Self::get_settings_path();
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(settings) = serde_json::from_str(&content) {
                return settings;
            }
        }
        AppSettings::default()
    }

    /// Modify a single field in settings, saving immediately.
    /// Avoids the clone-on-read of `get_settings()` for write-heavy callers.
    pub fn mutate_settings(f: impl FnOnce(&mut AppSettings)) -> Result<(), String> {
        let mut settings = {
            if let Ok(cache) = CACHED_SETTINGS.read() {
                if let Some(ref s) = *cache {
                    s.clone()
                } else {
                    Self::read_settings_from_disk()
                }
            } else {
                Self::read_settings_from_disk()
            }
        };
        f(&mut settings);
        Self::save_settings(&settings)
    }

    pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
        let path = Self::get_settings_path();
        let content = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("序列化设置失败: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("写入设置文件失败: {}", e))?;
        // Update memory cache
        if let Ok(mut cache) = CACHED_SETTINGS.write() {
            *cache = Some(settings.clone());
        }
        Ok(())
    }

    /// Invalidate cache when data_path changes (causes different base directory)
    pub fn invalidate_cache() {
        if let Ok(mut cache) = CACHED_SETTINGS.write() {
            *cache = None;
        }
    }
}
