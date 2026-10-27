//! Pi 兼容端点供应商：读写 `<agent-dir>/models.json` 的 `providers` 段。
//! 密钥在应用数据中加密保存；同步到 models.json 时按 Pi 格式明文写入
//! （Pi 只认明文 / `$ENV` / `!command` 三种形态，前两者不加密存储）。
//! 只管理带 `x-terminal-buddy-id` 标记的条目，用户手写条目原样保留。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::llm_provider::validate_base_url;
use super::profile_validation::reject_control_chars;

/// Pi `models.json` 中 TerminalBuddy 管理条目的归属标记。
/// Pi 会忽略未知字段，该标记对 Pi 无影响。
pub const PI_MANAGED_MARKER: &str = "x-terminal-buddy-id";

/// Pi Thinking 档位（schema `ThinkingLevelMap` 的键全集）。
pub const PI_THINKING_LEVELS: &[&str] = &[
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// Provider 级 `api` 可选值（Pi 1.4.0 内置实现全集）。
pub const PI_API_KINDS: &[&str] = &[
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "anthropic-messages",
    "google-generative-ai",
    "azure-openai-responses",
    "mistral-conversations",
    "bedrock-converse-stream",
];

/// `compat.thinkingFormat` 可选值（`auto` = 省略该字段，由 Pi 按 URL 自动检测）。
pub const PI_THINKING_FORMATS: &[&str] = &[
    "auto",
    "openai",
    "openrouter",
    "deepseek",
    "together",
    "baseten",
    "zai",
    "qwen",
    "chat-template",
    "qwen-chat-template",
    "string-thinking",
    "ant-ling",
];

/// Pi provider ID 允许字符：`pi --provider` 的取值，需与启动参数兼容。
fn is_valid_pi_provider_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

/// 模型 ID 校验：Pi 的 `--model` 模式匹配支持 `/` 与 `:`（如 `cn:deepseek-v4.1-flash`）。
fn validate_model_id(field: &str, value: &str) -> Result<String, String> {
    let id = value.trim().to_string();
    if id.is_empty() || id.len() > 256 {
        return Err(format!("{field}不能为空，且不能超过 256 字节"));
    }
    if id
        .chars()
        .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!("{field}不能包含空白或控制字符"));
    }
    Ok(id)
}

fn validate_header_map(
    field: &str,
    headers: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    if headers.len() > 32 {
        return Err(format!("{field}最多配置 32 个请求头"));
    }
    let mut normalized = BTreeMap::new();
    for (name, value) in headers {
        let name = name.trim().to_string();
        if name.is_empty() || name.len() > 128 {
            return Err(format!("{field}请求头名称不能为空，且不能超过 128 字节"));
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_graphic() && c != ':' && !c.is_whitespace())
        {
            return Err(format!("{field}请求头名称「{name}」包含非法字符"));
        }
        reject_control_chars(&format!("{field}请求头「{name}」的值"), value)?;
        if value.len() > 8192 {
            return Err(format!("{field}请求头「{name}」的值不能超过 8192 字节"));
        }
        normalized.insert(name, value.clone());
    }
    Ok(normalized)
}

/// 思考级别映射：`None`（JSON null）= 该档位不支持；缺键 = 跟随 Pi 默认。
/// 空 map 表示未配置 thinking（reasoning=false 时必须为空）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiThinkingLevelMap {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub levels: BTreeMap<String, Option<String>>,
}

impl PiThinkingLevelMap {
    fn validate(self) -> Result<Self, String> {
        for (level, value) in &self.levels {
            if !PI_THINKING_LEVELS.contains(&level.as_str()) {
                return Err(format!("不支持的思考级别「{level}」"));
            }
            if let Some(mapped) = value {
                let mapped = mapped.trim();
                if mapped.is_empty() || mapped.len() > 128 {
                    return Err(format!("思考级别「{level}」的映射值不能为空，且不能超过 128 字节"));
                }
                if mapped.chars().any(|c| c.is_whitespace() || c.is_control()) {
                    return Err(format!("思考级别「{level}」的映射值不能包含空白或控制字符"));
                }
            }
        }
        Ok(Self {
            levels: self
                .levels
                .into_iter()
                .map(|(level, value)| (level, value.map(|v| v.trim().to_string())))
                .collect(),
        })
    }
}

/// 兼容性覆盖精简子集：常用两项结构化，其余走 `extra` 原始透传。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiCompatConfig {
    /// Anthropic 兼容端点强制 adaptive thinking（如参考配置中的 forceAdaptiveThinking）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_adaptive_thinking: Option<bool>,
    /// 推理参数格式；`auto`/空 = 省略，由 Pi 自动检测。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_format: Option<String>,
    /// 其他 compat 字段的原始透传（JSON 对象形态）。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl PiCompatConfig {
    fn validate(self) -> Result<Self, String> {
        if let Some(format) = &self.thinking_format {
            let format = format.trim();
            if format.is_empty() || format == "auto" {
                // 归一化为空，后续序列化时省略。
            } else if !PI_THINKING_FORMATS.contains(&format) {
                return Err(format!("不支持的 thinkingFormat「{format}」"));
            }
        }
        let thinking_format = self
            .thinking_format
            .map(|format| format.trim().to_string())
            .filter(|format| !format.is_empty() && format != "auto");
        if self.extra.len() > 64 {
            return Err("compat 透传字段不能超过 64 个".to_string());
        }
        for (key, value) in &self.extra {
            if key.trim().is_empty() || key.len() > 128 {
                return Err("compat 透传字段名不能为空，且不能超过 128 字节".to_string());
            }
            reject_control_chars("compat 透传字段名", key)?;
            let encoded = serde_json::to_string(value).unwrap_or_default();
            if encoded.len() > 8192 {
                return Err(format!("compat 透传字段「{key}」的值不能超过 8192 字节"));
            }
        }
        Ok(Self {
            force_adaptive_thinking: self.force_adaptive_thinking,
            thinking_format,
            extra: self.extra,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.force_adaptive_thinking.is_none()
            && self.thinking_format.is_none()
            && self.extra.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModelConfig {
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default)]
    pub reasoning: bool,
    /// 默认思考级别（仅 TerminalBuddy 启动时展开为 `--thinking`，
    /// 不写入 Pi 的 models.json）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_thinking: Option<String>,
    #[serde(default)]
    pub thinking_level_map: PiThinkingLevelMap,
    /// 是否支持图片输入；输出时映射为 `input: ["text"]` / `["text", "image"]`。
    #[serde(default = "default_image_input")]
    pub image_input: bool,
    /// 0 表示使用 Pi 默认值（contextWindow 128000 / maxTokens 16384）。
    #[serde(default)]
    pub context_window: u32,
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default)]
    pub compat: PiCompatConfig,
}

fn default_image_input() -> bool {
    true
}

impl PiModelConfig {
    fn validate(self) -> Result<Self, String> {
        let id = validate_model_id("模型 ID", &self.id)?;
        let name = self.name.trim().to_string();
        if name.chars().count() > 80 {
            return Err("模型显示名称不能超过 80 个字符".to_string());
        }
        reject_control_chars("模型显示名称", &name)?;
        let thinking_level_map = self.thinking_level_map.validate()?;
        if !self.reasoning && !thinking_level_map.levels.is_empty() {
            return Err(format!("模型「{id}」未开启推理时不能配置思考级别映射"));
        }
        let default_thinking = self
            .default_thinking
            .map(|level| level.trim().to_string())
            .filter(|level| !level.is_empty());
        if let Some(level) = &default_thinking {
            if !self.reasoning {
                return Err(format!("模型「{id}」未开启推理时不能设置默认思考级别"));
            }
            if !PI_THINKING_LEVELS.contains(&level.as_str()) {
                return Err(format!("模型「{id}」的默认思考级别「{level}」不受支持"));
            }
        }
        Ok(Self {
            id,
            name,
            reasoning: self.reasoning,
            default_thinking,
            thinking_level_map,
            image_input: self.image_input,
            context_window: self.context_window,
            max_tokens: self.max_tokens,
            compat: self.compat.validate()?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProvider {
    pub id: String,
    pub name: String,
    /// Pi 侧 provider 键名（`pi --provider` 取值），全局唯一。
    pub pi_provider_id: String,
    pub base_url: String,
    /// 密钥形态：`literal` 明文（加密落盘，同步时明文写入 models.json）、
    /// `env`（`$NAME` 原文存储，同步时原文写入）、`command`（`!cmd` 同上）。
    pub api_key: String,
    #[serde(default)]
    pub key_mode: String,
    pub api: String,
    #[serde(default)]
    pub auth_header: bool,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// 默认模型（用于常规启动与导入回填），必须在 models 中。
    pub model: String,
    #[serde(default)]
    pub models: Vec<PiModelConfig>,
    /// 最近拉取的完整模型列表候选，与已配置模型分开保存。
    #[serde(default)]
    pub available_models: Vec<String>,
    #[serde(default)]
    pub compat: PiCompatConfig,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProviderFile {
    #[serde(default)]
    pub providers: Vec<PiProvider>,
    /// TerminalBuddy 侧的默认供应商卡片 id（右键菜单平铺 / 直接启动用）；
    /// Pi 的 models.json 没有全局默认概念，此值不写回 models.json。
    #[serde(default)]
    pub current_provider_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProviderInput {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub pi_provider_id: String,
    pub base_url: String,
    /// 编辑时留空沿用已保存密钥（`keyMode` 不变）。
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub key_mode: String,
    pub api: String,
    #[serde(default)]
    pub auth_header: bool,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub model: String,
    #[serde(default)]
    pub models: Vec<PiModelConfig>,
    #[serde(default)]
    pub available_models: Option<Vec<String>>,
    #[serde(default)]
    pub compat: PiCompatConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProviderView {
    pub id: String,
    pub name: String,
    pub pi_provider_id: String,
    pub base_url: String,
    pub key_set: bool,
    pub key_tail: String,
    pub key_mode: String,
    pub api: String,
    pub auth_header: bool,
    pub headers: BTreeMap<String, String>,
    pub model: String,
    pub models: Vec<PiModelConfig>,
    pub available_models: Vec<String>,
    pub compat: PiCompatConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProviderState {
    pub providers: Vec<PiProviderView>,
    /// TerminalBuddy 侧的默认供应商卡片 id（与 Claude/Codex 的默认供应商一致：
    /// 右键菜单平铺该供应商的模型）。
    pub active_provider_id: Option<String>,
    pub agent_dir: String,
    pub models_path: String,
    pub config_error: Option<String>,
    /// models.json 中非本应用管理的 provider 键名（只读展示，避免键名冲突）。
    pub external_provider_ids: Vec<String>,
}

pub fn normalize_available_models(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.len() > 10000 {
        return Err("模型列表不能超过 10000 个模型".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for id in ids {
        let id = validate_model_id("模型 ID", &id)?;
        if seen.insert(id.clone()) {
            models.push(id);
        }
    }
    Ok(models)
}

impl PiProviderInput {
    /// 校验表单载荷并归一化。返回 `(provider 草稿, 生效的密钥原文)`：
    /// - `literal` 模式：密钥由调用方加密落盘，同步 models.json 时再解密明文写入；
    /// - `env` / `command` 模式：原文即配置值，直接存储（不加密）。
    pub fn validate(
        self,
        previous_key: Option<&str>,
        previous_key_mode: Option<&str>,
    ) -> Result<(PiProvider, String), String> {
        let name = self.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 80 {
            return Err("供应商名称不能为空，且不能超过 80 个字符".to_string());
        }
        reject_control_chars("供应商名称", &name)?;
        let pi_provider_id = self.pi_provider_id.trim().to_string();
        if !is_valid_pi_provider_id(&pi_provider_id) {
            return Err("Pi 供应商 ID 只能包含字母、数字、-、_、.，且不能超过 64 字节".to_string());
        }
        let base_url = validate_base_url(&self.base_url)?;
        let api = self.api.trim().to_string();
        if !PI_API_KINDS.contains(&api.as_str()) {
            return Err("不支持的 Pi API 协议".to_string());
        }
        let key_mode = self.key_mode.trim().to_string();
        if !matches!(key_mode.as_str(), "literal" | "env" | "command") {
            return Err("不支持的密钥形态（literal/env/command）".to_string());
        }
        let raw_key = self
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty());
        // 沿用旧密钥时 keyMode 必须与旧值一致，否则用户可能误把明文当变量名。
        // 导入的无密钥条目（previous_key 为 Some("")）允许继续为空。
        let (key, key_mode) = match raw_key {
            Some(key) => (key.to_string(), key_mode),
            None => {
                let mode = previous_key_mode.unwrap_or("literal").to_string();
                if mode != key_mode {
                    return Err("沿用已保存密钥时不能切换密钥形态，请重新填写密钥".to_string());
                }
                match previous_key {
                    Some(previous) => (previous.to_string(), mode),
                    None => return Err("请输入 API 密钥；编辑时可留空沿用已保存的密钥".to_string()),
                }
            }
        };
        if key.is_empty() {
            // 导入的无密钥条目：跳过形态校验，同步时不写 apiKey。
        } else {
            match key_mode.as_str() {
                "literal" => {
                    if key.len() > 8192 {
                        return Err("API 密钥不能超过 8192 字节".to_string());
                    }
                    reject_control_chars("API 密钥", &key)?;
                }
                "env" => {
                    // `$NAME` / `${NAME}` 形态；Pi 解析时支持 `$$` 转义，此处只做基本形态检查。
                    let body = key
                        .strip_prefix('$')
                        .ok_or_else(|| "环境变量形态必须以 $ 开头，如 $MY_API_KEY".to_string())?;
                    let name = body
                        .strip_prefix('{')
                        .and_then(|rest| rest.strip_suffix('}'))
                        .unwrap_or(body);
                    if name.is_empty()
                        || name.len() > 128
                        || !name
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_')
                    {
                        return Err("环境变量名只能包含字母、数字与下划线，如 $MY_API_KEY".to_string());
                    }
                }
                "command" => {
                    let command = key
                        .strip_prefix('!')
                        .map(str::trim)
                        .filter(|command| !command.is_empty())
                        .ok_or_else(|| "命令形态必须以 ! 开头，如 !cat ~/.secret".to_string())?;
                    if command.len() > 1024 {
                        return Err("取密钥命令不能超过 1024 字节".to_string());
                    }
                    reject_control_chars("取密钥命令", command)?;
                }
                _ => unreachable!(),
            }
        }
        if self.models.len() > 200 {
            return Err("每个供应商最多配置 200 个模型".to_string());
        }
        let mut models = Vec::with_capacity(self.models.len());
        let mut seen = std::collections::HashSet::new();
        for model in self.models {
            let model = model.validate()?;
            if !seen.insert(model.id.clone()) {
                return Err(format!("模型「{}」重复配置", model.id));
            }
            models.push(model);
        }
        let model = self.model.trim().to_string();
        if model.is_empty() {
            return Err("默认模型不能为空".to_string());
        }
        if !models.iter().any(|entry| entry.id == model) {
            return Err("默认模型必须在已配置的模型列表中".to_string());
        }
        Ok((
            PiProvider {
                id: self.id.trim().to_string(),
                name,
                pi_provider_id,
                base_url,
                api_key: String::new(),
                key_mode,
                api,
                auth_header: self.auth_header,
                headers: validate_header_map("供应商", &self.headers)?,
                model,
                models,
                available_models: normalize_available_models(
                    self.available_models.unwrap_or_default(),
                )?,
                compat: self.compat.validate()?,
                created_at: String::new(),
                updated_at: String::new(),
            },
            key,
        ))
    }
}

impl PiProvider {
    pub fn to_view(&self, key: &str) -> PiProviderView {
        // 短密钥不展示，避免末四位等于完整密钥；env/command 形态展示原文（非敏感）。
        let key_tail = if self.key_mode == "literal" {
            if key.chars().count() > 4 {
                key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()
            } else {
                String::new()
            }
        } else {
            key.to_string()
        };
        PiProviderView {
            id: self.id.clone(),
            name: self.name.clone(),
            pi_provider_id: self.pi_provider_id.clone(),
            base_url: self.base_url.clone(),
            key_set: !key.is_empty(),
            key_tail,
            key_mode: self.key_mode.clone(),
            api: self.api.clone(),
            auth_header: self.auth_header,
            headers: self.headers.clone(),
            model: self.model.clone(),
            models: self.models.clone(),
            available_models: self.available_models.clone(),
            compat: self.compat.clone(),
        }
    }
}
