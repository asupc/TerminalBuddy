//! Codex 通用 API 供应商；密钥在应用数据中加密保存，前端只接收脱敏视图。

use serde::{Deserialize, Serialize};

use super::llm_provider::validate_base_url;
use super::profile_validation::reject_control_chars;

pub const CODEX_REASONING_EFFORTS: &[&str] = &[
    "", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

fn default_effort() -> String {
    "high".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// 可快速启动的模型；旧配置自动包含原默认模型。
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default = "default_effort")]
    pub reasoning_effort: String,
    /// 0 表示使用 Codex / 模型默认值。
    #[serde(default)]
    pub context_window: u32,
    #[serde(default)]
    pub auto_compact_token_limit: u32,
    #[serde(default = "default_true")]
    pub disable_response_storage: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderFile {
    #[serde(default)]
    pub providers: Vec<CodexProvider>,
    #[serde(default)]
    pub current_provider_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderInput {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// 编辑时留空沿用已保存密钥。
    #[serde(default)]
    pub api_key: Option<String>,
    pub model: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default = "default_effort")]
    pub reasoning_effort: String,
    #[serde(default)]
    pub context_window: u32,
    #[serde(default)]
    pub auto_compact_token_limit: u32,
    #[serde(default = "default_true")]
    pub disable_response_storage: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderView {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub key_set: bool,
    pub key_tail: String,
    pub model: String,
    pub models: Vec<String>,
    pub reasoning_effort: String,
    pub context_window: u32,
    pub auto_compact_token_limit: u32,
    pub disable_response_storage: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderState {
    pub providers: Vec<CodexProviderView>,
    pub active_provider_id: Option<String>,
    pub config_dir: String,
    pub config_error: Option<String>,
}

impl CodexProviderInput {
    pub fn validate(self, previous_key: Option<&str>) -> Result<(CodexProvider, String), String> {
        let name = self.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 80 {
            return Err("供应商名称不能为空，且不能超过 80 个字符".to_string());
        }
        reject_control_chars("供应商名称", &name)?;
        let base_url = validate_base_url(&self.base_url)?;
        let model = self.model.trim().to_string();
        if model.is_empty()
            || model.len() > 256
            || model.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(
                "模型 ID 不能为空、不能超过 256 字节，且不能包含空白或控制字符".to_string(),
            );
        }
        if self.models.len() > 200 {
            return Err("每个供应商最多配置 200 个模型".to_string());
        }
        let mut models = vec![model.clone()];
        for id in self.models {
            let id = id.trim().to_string();
            if id.is_empty() || id.len() > 256 || id.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err("模型 ID 不能为空、不能超过 256 字节，且不能包含空白或控制字符".to_string());
            }
            if !models.contains(&id) { models.push(id); }
        }
        let reasoning_effort = self.reasoning_effort.trim().to_string();
        if !CODEX_REASONING_EFFORTS.contains(&reasoning_effort.as_str()) {
            return Err("Codex 推理等级无效".to_string());
        }
        if self.context_window > 0 && self.auto_compact_token_limit > self.context_window {
            return Err("自动压缩阈值不能大于上下文窗口".to_string());
        }
        let key = self
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .or(previous_key)
            .filter(|key| !key.is_empty())
            .ok_or_else(|| "请输入 API 密钥；编辑时可留空沿用已保存的密钥".to_string())?
            .to_string();
        if key.len() > 8192 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("API 密钥不能超过 8192 字节，且不能包含空白或控制字符".to_string());
        }
        Ok((
            CodexProvider {
                id: self.id.trim().to_string(),
                name,
                base_url,
                api_key: String::new(),
                model,
                models,
                reasoning_effort,
                context_window: self.context_window,
                auto_compact_token_limit: self.auto_compact_token_limit,
                disable_response_storage: self.disable_response_storage,
                created_at: String::new(),
                updated_at: String::new(),
            },
            key,
        ))
    }
}

impl CodexProvider {
    pub fn model_ids(&self) -> Vec<String> {
        let mut ids = vec![self.model.clone()];
        for id in &self.models {
            if !ids.contains(id) { ids.push(id.clone()); }
        }
        ids
    }

    pub fn to_view(&self, key: &str) -> CodexProviderView {
        // 短密钥不展示，避免末四位等于完整密钥。
        let key_tail = if key.chars().count() > 4 {
            key.chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        } else {
            String::new()
        };
        CodexProviderView {
            id: self.id.clone(),
            name: self.name.clone(),
            base_url: self.base_url.clone(),
            key_set: !key.is_empty(),
            key_tail,
            model: self.model.clone(),
            models: self.model_ids(),
            reasoning_effort: self.reasoning_effort.clone(),
            context_window: self.context_window,
            auto_compact_token_limit: self.auto_compact_token_limit,
            disable_response_storage: self.disable_response_storage,
        }
    }
}
