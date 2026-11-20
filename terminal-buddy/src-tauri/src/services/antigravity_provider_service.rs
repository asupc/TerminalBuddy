//! Antigravity CLI 模型配置：保存用户勾选启用的模型清单与推理等级（Effort）。
//! Antigravity CLI 复用用户本机 Google 账号登录态，因此无需保存 API Key 或站点地址；
//! 用户可从官网（`agy models`）拉取可用模型，挑选需要的模型并同步到项目右键与历史恢复菜单。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use super::agent_cli_service::{self, AntigravityModel};
use super::atomic_file::atomic_write;
use super::path_service::PathService;

const FILE_NAME: &str = "antigravity_providers.json";
pub const ANTIGRAVITY_EFFORT_LEVELS: [&str; 6] = ["", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityModelEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub effort_level: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityProviderConfig {
    #[serde(default)]
    pub default_effort_level: String,
    #[serde(default)]
    pub available_models: Vec<AntigravityModel>,
    #[serde(default)]
    pub enabled_models: Vec<AntigravityModelEntry>,
}

fn config_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn lock_error() -> String {
    "Antigravity 模型配置锁不可用，请重试".to_string()
}

fn read_path() -> PathBuf {
    PathService::get_data_dir().join(FILE_NAME)
}

fn write_path() -> Result<PathBuf, String> {
    Ok(PathService::require_data_dir()?.join(FILE_NAME))
}

pub(crate) fn normalize_effort(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_ascii_lowercase();
    if ANTIGRAVITY_EFFORT_LEVELS.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(format!("不支持的 Antigravity 推理等级：{}", raw.trim()))
    }
}

pub(crate) fn validate_model_id(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.ends_with(':')
        || trimmed.ends_with('.')
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/'))
    {
        return Err(format!("无效的 Antigravity 模型 ID：{}", raw.trim()));
    }
    Ok(trimmed.to_string())
}

fn is_valid_available_id(id: &str) -> bool {
    validate_model_id(id).is_ok()
}

pub(crate) fn normalize_config(
    config: AntigravityProviderConfig,
) -> Result<AntigravityProviderConfig, String> {
    let default_effort_level = normalize_effort(&config.default_effort_level)?;

    let mut seen_available = HashSet::new();
    let mut available_models = Vec::new();
    let mut available_names = HashMap::new();
    for item in config.available_models {
        let id = item.id.trim();
        if !is_valid_available_id(id) || !seen_available.insert(id.to_string()) {
            continue;
        }
        let name = item.name.trim();
        let display = if name.is_empty() { id } else { name }.to_string();
        available_names.insert(id.to_string(), display.clone());
        available_models.push(AntigravityModel {
            id: id.to_string(),
            name: display,
        });
    }

    let mut seen_enabled = HashSet::new();
    let mut enabled_models = Vec::new();
    for entry in config.enabled_models {
        let id = validate_model_id(&entry.id)?;
        if !seen_enabled.insert(id.clone()) {
            continue;
        }
        let effort_level = normalize_effort(&entry.effort_level)?;
        let raw_name = entry.name.trim();
        let name = if !raw_name.is_empty() {
            raw_name.to_string()
        } else {
            available_names
                .get(&id)
                .cloned()
                .unwrap_or_else(|| id.clone())
        };
        enabled_models.push(AntigravityModelEntry {
            id,
            name,
            effort_level,
        });
    }

    Ok(AntigravityProviderConfig {
        default_effort_level,
        available_models,
        enabled_models,
    })
}

fn read_config_at(path: &PathBuf) -> Result<AntigravityProviderConfig, String> {
    match fs::read_to_string(path) {
        Ok(content) => {
            let parsed: AntigravityProviderConfig = serde_json::from_str(&content)
                .map_err(|error| format!("读取 Antigravity 模型配置失败：{}", error))?;
            normalize_config(parsed)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(AntigravityProviderConfig::default())
        }
        Err(error) => Err(format!("读取 Antigravity 模型配置失败：{}", error)),
    }
}

fn write_config_at(
    path: &PathBuf,
    config: &AntigravityProviderConfig,
) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化 Antigravity 模型配置失败：{}", error))?;
    atomic_write(path, serialized.as_bytes())
        .map_err(|error| format!("保存 Antigravity 模型配置失败：{}", error))
}

pub fn get_config() -> Result<AntigravityProviderConfig, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    read_config_at(&read_path())
}

pub fn save_config(
    config: AntigravityProviderConfig,
) -> Result<AntigravityProviderConfig, String> {
    let normalized = normalize_config(config)?;
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    let path = write_path()?;
    write_config_at(&path, &normalized)?;
    Ok(normalized)
}

pub fn fetch_models() -> Result<AntigravityProviderConfig, String> {
    let fetched = agent_cli_service::list_antigravity_models(true)?;
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    let path = write_path()?;
    let mut current = match read_config_at(&path) {
        Ok(cfg) => cfg,
        Err(_) => AntigravityProviderConfig::default(),
    };
    let latest_names: HashMap<String, String> = fetched
        .iter()
        .map(|model| (model.id.clone(), model.name.clone()))
        .collect();
    current.available_models = fetched;
    for entry in &mut current.enabled_models {
        if let Some(latest_name) = latest_names.get(&entry.id) {
            entry.name = latest_name.clone();
        }
    }
    let normalized = normalize_config(current)?;
    write_config_at(&path, &normalized)?;
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tb-agy-provider-test-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&dir).unwrap();
            PathService::set_test_data_dir(Some(dir.clone()));
            Self(dir)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            PathService::set_test_data_dir(None);
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_file_returns_default_config() {
        let _dir = TestDir::new();
        let cfg = get_config().expect("missing file yields default");
        assert_eq!(cfg, AntigravityProviderConfig::default());
    }

    #[test]
    fn normalize_dedupes_preserves_order_and_fills_names() {
        let input = AntigravityProviderConfig {
            default_effort_level: " High ".into(),
            available_models: vec![
                AntigravityModel {
                    id: "gemini-3-pro".into(),
                    name: "Gemini 3 Pro".into(),
                },
                AntigravityModel {
                    id: "gemini-3-pro".into(),
                    name: "Duplicate".into(),
                },
                AntigravityModel {
                    id: "bad id with space".into(),
                    name: "Bad".into(),
                },
            ],
            enabled_models: vec![
                AntigravityModelEntry {
                    id: "claude-sonnet-4".into(),
                    name: " ".into(),
                    effort_level: "XHIGH".into(),
                },
                AntigravityModelEntry {
                    id: "gemini-3-pro".into(),
                    name: "".into(),
                    effort_level: "".into(),
                },
                AntigravityModelEntry {
                    id: "claude-sonnet-4".into(),
                    name: "Duplicate".into(),
                    effort_level: "low".into(),
                },
            ],
        };
        let normalized = normalize_config(input).expect("valid config");
        assert_eq!(normalized.default_effort_level, "high");
        assert_eq!(normalized.available_models.len(), 1);
        assert_eq!(normalized.enabled_models.len(), 2);
        assert_eq!(normalized.enabled_models[0].id, "claude-sonnet-4");
        assert_eq!(normalized.enabled_models[0].name, "claude-sonnet-4");
        assert_eq!(normalized.enabled_models[0].effort_level, "xhigh");
        assert_eq!(normalized.enabled_models[1].id, "gemini-3-pro");
        assert_eq!(normalized.enabled_models[1].name, "Gemini 3 Pro");
    }

    #[test]
    fn rejects_invalid_effort_and_model_id() {
        let bad_effort = AntigravityProviderConfig {
            default_effort_level: "turbo".into(),
            ..Default::default()
        };
        assert!(normalize_config(bad_effort).is_err());

        let bad_id = AntigravityProviderConfig {
            enabled_models: vec![AntigravityModelEntry {
                id: "foo bar; rm -rf".into(),
                name: "Bad".into(),
                effort_level: "".into(),
            }],
            ..Default::default()
        };
        assert!(normalize_config(bad_id).is_err());
    }

    #[test]
    fn roundtrips_save_and_get_config() {
        let _dir = TestDir::new();
        let saved = save_config(AntigravityProviderConfig {
            default_effort_level: "medium".into(),
            available_models: vec![AntigravityModel {
                id: "gemini-3-pro-high".into(),
                name: "Gemini 3 Pro (High)".into(),
            }],
            enabled_models: vec![AntigravityModelEntry {
                id: "gemini-3-pro-high".into(),
                name: "Gemini 3 Pro (High)".into(),
                effort_level: "high".into(),
            }],
        })
        .expect("save config");
        let loaded = get_config().expect("load config");
        assert_eq!(loaded, saved);
    }
}
