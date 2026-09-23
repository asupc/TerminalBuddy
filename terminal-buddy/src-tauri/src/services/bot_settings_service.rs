use crate::models::{BotChannelConfig, BotSettings};
use crate::services::{atomic_write, crypto_service, PathService};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBotChannel {
    id: String,
    name: String,
    platform: String,
    enabled: bool,
    target_id: String,
    receive_id_type: String,
    webhook_url: String,
    app_id: String,
    #[serde(default)]
    encrypted_secret: String,
    #[serde(default)]
    encrypted_callback_token: String,
    #[serde(default)]
    allowed_user_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBotSettings {
    enabled: bool,
    send_decision_notifications: bool,
    send_completion_notifications: bool,
    decision_ttl_minutes: u32,
    append_enter: bool,
    #[serde(default)]
    channels: Vec<StoredBotChannel>,
}

impl Default for StoredBotSettings {
    fn default() -> Self {
        let settings = BotSettings::default();
        Self {
            enabled: settings.enabled,
            send_decision_notifications: settings.send_decision_notifications,
            send_completion_notifications: settings.send_completion_notifications,
            decision_ttl_minutes: settings.decision_ttl_minutes,
            append_enter: settings.append_enter,
            channels: Vec::new(),
        }
    }
}

fn settings_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub struct BotSettingsService;

impl BotSettingsService {
    /// 读路径兜底：目录不可用时落到注定读不到的相对路径，read_stored 返回默认值，
    /// 可用性状态由 PathService 缓存供 UI 展示。写路径在 save() 里显式失败。
    fn path() -> PathBuf {
        PathService::require_data_dir()
            .map(|dir| dir.join("Bots"))
            .unwrap_or_else(|_| PathBuf::from("Bots"))
            .join("channels.json")
    }

    fn read_stored() -> StoredBotSettings {
        let Ok(content) = fs::read_to_string(Self::path()) else {
            return StoredBotSettings::default();
        };
        serde_json::from_str(&content).unwrap_or_default()
    }

    pub fn get_public() -> BotSettings {
        let _guard = settings_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let stored = Self::read_stored();
        BotSettings {
            enabled: stored.enabled,
            send_decision_notifications: stored.send_decision_notifications,
            send_completion_notifications: stored.send_completion_notifications,
            decision_ttl_minutes: stored.decision_ttl_minutes,
            append_enter: stored.append_enter,
            channels: stored
                .channels
                .into_iter()
                .map(|channel| BotChannelConfig {
                    id: channel.id,
                    name: channel.name,
                    platform: channel.platform,
                    enabled: channel.enabled,
                    target_id: channel.target_id,
                    receive_id_type: channel.receive_id_type,
                    webhook_url: channel.webhook_url,
                    app_id: channel.app_id,
                    secret: String::new(),
                    callback_token: String::new(),
                    allowed_user_ids: channel.allowed_user_ids,
                    has_secret: !channel.encrypted_secret.is_empty(),
                    has_callback_token: !channel.encrypted_callback_token.is_empty(),
                })
                .collect(),
        }
    }

    pub fn get_runtime() -> Result<BotSettings, String> {
        let _guard = settings_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let stored = Self::read_stored();
        let channels = stored
            .channels
            .into_iter()
            .map(|channel| {
                let secret = crypto_service::decrypt_string(&channel.encrypted_secret)?;
                let callback_token =
                    crypto_service::decrypt_string(&channel.encrypted_callback_token)?;
                Ok(BotChannelConfig {
                    id: channel.id,
                    name: channel.name,
                    platform: channel.platform,
                    enabled: channel.enabled,
                    target_id: channel.target_id,
                    receive_id_type: channel.receive_id_type,
                    webhook_url: channel.webhook_url,
                    app_id: channel.app_id,
                    secret,
                    callback_token,
                    allowed_user_ids: channel.allowed_user_ids,
                    has_secret: !channel.encrypted_secret.is_empty(),
                    has_callback_token: !channel.encrypted_callback_token.is_empty(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(BotSettings {
            enabled: stored.enabled,
            send_decision_notifications: stored.send_decision_notifications,
            send_completion_notifications: stored.send_completion_notifications,
            decision_ttl_minutes: stored.decision_ttl_minutes,
            append_enter: stored.append_enter,
            channels,
        })
    }

    pub fn save(settings: BotSettings) -> Result<BotSettings, String> {
        let _guard = settings_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let existing = Self::read_stored();
        let channels = settings
            .channels
            .into_iter()
            .map(|channel| {
                let previous = existing.channels.iter().find(|item| item.id == channel.id);
                let encrypted_secret = if channel.secret.is_empty() {
                    previous
                        .filter(|item| item.platform == channel.platform)
                        .map(|item| item.encrypted_secret.clone())
                        .unwrap_or_default()
                } else {
                    crypto_service::encrypt_string(&channel.secret)?
                };
                let encrypted_callback_token = if channel.callback_token.is_empty() {
                    previous
                        .filter(|item| item.platform == channel.platform)
                        .map(|item| item.encrypted_callback_token.clone())
                        .unwrap_or_default()
                } else {
                    crypto_service::encrypt_string(&channel.callback_token)?
                };
                Ok(StoredBotChannel {
                    id: channel.id,
                    name: channel.name.trim().to_string(),
                    platform: channel.platform.trim().to_lowercase(),
                    enabled: channel.enabled,
                    target_id: channel.target_id.trim().to_string(),
                    receive_id_type: if channel.receive_id_type.trim().is_empty() {
                        "chat_id".to_string()
                    } else {
                        channel.receive_id_type.trim().to_string()
                    },
                    webhook_url: channel.webhook_url.trim().to_string(),
                    app_id: channel.app_id.trim().to_string(),
                    encrypted_secret,
                    encrypted_callback_token,
                    allowed_user_ids: channel
                        .allowed_user_ids
                        .into_iter()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .collect(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let stored = StoredBotSettings {
            enabled: settings.enabled,
            send_decision_notifications: settings.send_decision_notifications,
            send_completion_notifications: settings.send_completion_notifications,
            decision_ttl_minutes: settings.decision_ttl_minutes.clamp(1, 1440),
            append_enter: settings.append_enter,
            channels,
        };
        let content = serde_json::to_string_pretty(&stored)
            .map_err(|error| format!("序列化机器人设置失败: {}", error))?;
        let dir = PathService::get_bots_dir()?;
        let path = dir.join("channels.json");
        atomic_write(&path, content.as_bytes())
            .map_err(|error| format!("保存机器人设置失败: {}", error))?;
        drop(_guard);
        Ok(Self::get_public())
    }

    pub fn requires_callback_server() -> bool {
        Self::get_public().enabled
            && Self::get_public().channels.iter().any(|channel| {
                channel.enabled && matches!(channel.platform.as_str(), "qq" | "bridge")
            })
    }
}
