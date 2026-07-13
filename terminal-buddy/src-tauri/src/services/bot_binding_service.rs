use crate::models::DecisionBinding;
use crate::services::PathService;
use chrono::Utc;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

fn binding_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub struct BotBindingService;

impl BotBindingService {
    fn path() -> PathBuf {
        PathService::get_bots_dir().join("decision_bindings.json")
    }

    fn read() -> Vec<DecisionBinding> {
        let Ok(content) = fs::read_to_string(Self::path()) else {
            return Vec::new();
        };
        serde_json::from_str(&content).unwrap_or_default()
    }

    fn write(bindings: &[DecisionBinding]) -> Result<(), String> {
        let content = serde_json::to_string_pretty(bindings)
            .map_err(|error| format!("序列化决策绑定失败: {}", error))?;
        let path = Self::path();
        let temp = path.with_extension("json.tmp");
        fs::write(&temp, content).map_err(|error| format!("写入决策绑定失败: {}", error))?;
        fs::rename(&temp, &path).map_err(|error| format!("保存决策绑定失败: {}", error))
    }

    fn prune(bindings: &mut Vec<DecisionBinding>) {
        let now = Utc::now().timestamp_millis();
        for binding in bindings.iter_mut() {
            if binding.status == "pending" && binding.expires_at <= now {
                binding.status = "expired".to_string();
            }
        }
        let retention = now - 7 * 24 * 60 * 60 * 1_000;
        bindings.retain(|binding| binding.status == "pending" || binding.expires_at >= retention);
    }

    pub fn add(binding: DecisionBinding) -> Result<(), String> {
        let _guard = binding_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut bindings = Self::read();
        Self::prune(&mut bindings);
        if bindings
            .iter()
            .any(|item| item.decision_id == binding.decision_id && item.status != "pending")
        {
            return Ok(());
        }
        bindings.retain(|item| {
            !(item.channel_id == binding.channel_id
                && item.external_message_id == binding.external_message_id)
        });
        bindings.push(binding);
        Self::write(&bindings)
    }

    pub fn cancel(decision_id: &str) -> Result<(), String> {
        let _guard = binding_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut bindings = Self::read();
        let mut changed = false;
        for binding in &mut bindings {
            if binding.decision_id == decision_id && binding.status == "pending" {
                binding.status = "cancelled".to_string();
                changed = true;
            }
        }
        if !bindings
            .iter()
            .any(|binding| binding.decision_id == decision_id)
        {
            bindings.push(DecisionBinding {
                decision_id: decision_id.to_string(),
                terminal_id: String::new(),
                terminal_name: String::new(),
                channel_id: String::new(),
                target_id: String::new(),
                external_message_id: String::new(),
                status: "cancelled".to_string(),
                expires_at: Utc::now().timestamp_millis() + 24 * 60 * 60 * 1_000,
            });
            changed = true;
        }
        if changed {
            Self::write(&bindings)?;
        }
        Ok(())
    }

    pub fn consume_with<F>(
        channel_id: &str,
        external_message_id: &str,
        write: F,
    ) -> Result<DecisionBinding, String>
    where
        F: FnOnce(&DecisionBinding) -> Result<(), String>,
    {
        let _guard = binding_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut bindings = Self::read();
        Self::prune(&mut bindings);
        let index = bindings
            .iter()
            .position(|binding| {
                binding.channel_id == channel_id
                    && binding.external_message_id == external_message_id
            })
            .ok_or_else(|| "未找到被引用的待决策消息".to_string())?;
        let binding = bindings[index].clone();
        match binding.status.as_str() {
            "pending" => {}
            "consumed" => return Err("该决策已经处理".to_string()),
            "expired" => return Err("该决策已经过期".to_string()),
            _ => return Err("该决策已经取消".to_string()),
        }
        if binding.expires_at <= Utc::now().timestamp_millis() {
            bindings[index].status = "expired".to_string();
            Self::write(&bindings)?;
            return Err("该决策已经过期".to_string());
        }
        write(&binding)?;
        for item in &mut bindings {
            if item.decision_id == binding.decision_id && item.status == "pending" {
                item.status = "consumed".to_string();
            }
        }
        Self::write(&bindings)?;
        Ok(binding)
    }
}
