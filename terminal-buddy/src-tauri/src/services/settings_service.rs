use crate::models::AppSettings;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

static CACHED_SETTINGS: RwLock<Option<AppSettings>> = RwLock::new(None);
/// 串行化所有设置写入：`mutate_settings` 的「读缓存 → 修改 → 写回」必须整体
/// 原子，否则并发保存（如改 Web 密码与保存界面设置）会互相覆盖丢更新。
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub struct SettingsService;

impl SettingsService {
    pub fn get_settings_path() -> PathBuf {
        if let Some(directory) = std::env::var_os("TERMINAL_BUDDY_DATA_DIR") {
            return PathBuf::from(directory).join("settings.json");
        }
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

    /// 只读单个布尔字段，避免权限判定热路径上整体 clone `AppSettings`。
    pub fn share_sessions_enabled() -> bool {
        {
            if let Ok(cache) = CACHED_SETTINGS.read() {
                if let Some(ref settings) = *cache {
                    return settings.web_api_share_sessions;
                }
            }
        }
        Self::get_settings().web_api_share_sessions
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
        // 读改写全程持锁；内部调用 `write_settings_unlocked` 避免重入死锁。
        let _guard = SETTINGS_WRITE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
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
        Self::write_settings_unlocked(&settings)
    }

    pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
        let _guard = SETTINGS_WRITE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Self::write_settings_unlocked(settings)
    }

    fn write_settings_unlocked(settings: &AppSettings) -> Result<(), String> {
        let path = Self::get_settings_path();
        let content =
            serde_json::to_string_pretty(settings).map_err(|e| format!("序列化设置失败: {}", e))?;
        super::atomic_file::atomic_write(&path, content.as_bytes())
            .map_err(|e| format!("写入设置文件失败: {}", e))?;
        // Update memory cache
        if let Ok(mut cache) = CACHED_SETTINGS.write() {
            *cache = Some(settings.clone());
        }
        Ok(())
    }

    /// 仅允许首次初始化；持有设置锁直到原子落盘，避免并发请求覆盖管理员。
    #[cfg(not(feature = "desktop"))]
    pub fn initialize_web_admin(password_hash: String) -> Result<Option<String>, String> {
        let mut cache = CACHED_SETTINGS.write().map_err(|_| "设置锁不可用".to_string())?;
        let mut settings = cache.clone().unwrap_or_else(Self::read_settings_from_disk);
        if !settings.web_api_password_hash.is_empty() {
            return Ok(None);
        }
        if !settings.web_api_enabled {
            return Err("Web API 未启用".to_string());
        }
        settings.web_api_password_hash = password_hash;
        let content = serde_json::to_vec_pretty(&settings).map_err(|e| format!("序列化设置失败: {}", e))?;
        super::atomic_file::atomic_write(&Self::get_settings_path(), &content)
            .map_err(|e| format!("保存管理员失败: {}", e))?;
        let username = settings.web_api_username.clone();
        *cache = Some(settings);
        Ok(Some(username))
    }

    /// Invalidate cache when data_path changes (causes different base directory)
    pub fn invalidate_cache() {
        if let Ok(mut cache) = CACHED_SETTINGS.write() {
            *cache = None;
        }
    }
}
