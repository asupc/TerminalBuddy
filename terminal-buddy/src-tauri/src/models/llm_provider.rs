//! 全平台大模型供应商：`<dataDir>/llm_providers.json` 数据模型与校验。
//!
//! 与旧 Docker 容器链路（`claude_provider_service`，SQLite + 重写 live `settings.json`）
//! 是两套独立数据源：本文件只管 JSON 落盘与校验，不读写用户级 `settings.json`。
//! 启动时走 `--settings` 临时文件按官方优先级覆盖基线，天然兼容。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::profile_validation::reject_control_chars;

/// 推理等级五档（`--effort` 取值与 settings `effortLevel` 的并集）。
/// 文件内 `effortLevel` 官方仅收录前四档，`max` 经 `env.CLAUDE_CODE_EFFORT_LEVEL` +
/// `--effort max` 双通道生效，不写入 `effortLevel` 字段。
pub const EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// 密钥写入临时 settings 时的 env 键形态。
pub const AUTH_TYPES: &[&str] = &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

/// 引用标记前缀：`__TB_CLAUDE_REF__:<providerId>:<modelId>`。
pub const CLAUDE_REF_PREFIX: &str = "__TB_CLAUDE_REF__:";

/// 临时 settings 文件名前缀（`terminal-buddy-claude-<uuid>` 已被安装器占用，勿混用）。
pub const CLAUDE_TEMP_SETTINGS_PREFIX: &str = "terminal-buddy-claude-settings-";

fn default_auth_type() -> String {
    "ANTHROPIC_AUTH_TOKEN".to_string()
}

pub fn is_valid_effort_level(level: &str) -> bool {
    EFFORT_LEVELS.contains(&level)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelConfig {
    pub id: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 0 / 缺省表示不覆盖（不写 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，继承环境）。
    #[serde(default)]
    pub context_window: u32,
    /// 空串 = 跟随供应商默认；非空时须为五档之一。
    #[serde(default)]
    pub effort_level: String,
    /// 预留：→ `CLAUDE_CODE_MAX_OUTPUT_TOKENS`。一期无 UI，后端同样按 0=不覆盖处理。
    #[serde(default)]
    pub max_output_tokens: u32,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default = "default_auth_type")]
    pub auth_type: String,
    /// 落盘形态为加密串（`dpapi:` / `aesgcm:` marker），内存中短暂持有解密 Key。
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub is_default: bool,
    pub default_effort_level: String,
    #[serde(default)]
    pub models_url: String,
    #[serde(default)]
    pub enabled_models: Vec<LlmModelConfig>,
    #[serde(default)]
    pub sort_index: i32,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderFile {
    #[serde(default)]
    pub providers: Vec<LlmProvider>,
}

/// 前端表单载荷：`id` 为空表示新建。`apiKey` 为空/缺省表示沿用已保存密钥。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderInput {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default = "default_auth_type")]
    pub auth_type: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    pub default_effort_level: String,
    #[serde(default)]
    pub models_url: String,
    #[serde(default)]
    pub enabled_models: Vec<LlmModelConfig>,
    #[serde(default)]
    pub sort_index: i32,
}

/// 返回给前端的脱敏视图：`keySet` + 末 4 位，`keyTail` 仅展示、保存时忽略。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderView {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub auth_type: String,
    pub key_set: bool,
    pub key_tail: String,
    pub is_default: bool,
    pub default_effort_level: String,
    pub models_url: String,
    pub enabled_models: Vec<LlmModelConfig>,
    pub sort_index: i32,
    pub created_at: String,
    pub updated_at: String,
}

/// 右键菜单数据源：仅可用模型，不含 Key。`effort` 为解析后档位。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmLaunchTarget {
    pub provider_id: String,
    pub provider_name: String,
    pub is_default: bool,
    pub models: Vec<LlmLaunchModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmLaunchModel {
    pub id: String,
    pub effort: String,
    pub context_window: u32,
}

/// 解析模型生效档位：模型级空值跟随供应商默认。
pub fn resolve_model_effort(model: &LlmModelConfig, default_effort: &str) -> String {
    if model.effort_level.trim().is_empty() {
        default_effort.to_string()
    } else {
        model.effort_level.clone()
    }
}

pub(crate) fn validate_base_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/').to_string();
    let url = reqwest::Url::parse(&trimmed).map_err(|_| "请输入有效的 HTTP 或 HTTPS API 地址".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || trimmed.len() > 2048
        || trimmed.chars().any(char::is_control)
    {
        return Err("API 地址仅支持 HTTP/HTTPS，不能包含账号密码、查询参数或片段".to_string());
    }
    Ok(trimmed)
}

fn validate_models_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let url = reqwest::Url::parse(&trimmed).map_err(|_| "自定义模型列表端点不是有效的 HTTP 或 HTTPS 地址".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || trimmed.len() > 2048
        || trimmed.chars().any(char::is_control)
    {
        return Err("自定义模型列表端点仅支持 HTTP/HTTPS 地址".to_string());
    }
    Ok(trimmed)
}

fn validate_model_config(model: &LlmModelConfig) -> Result<LlmModelConfig, String> {
    let id = model.id.trim().to_string();
    if id.is_empty() {
        return Err("模型 ID 不能为空".to_string());
    }
    if id.len() > 256 {
        return Err(format!("模型「{}」超过 256 字节", id));
    }
    if id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(format!(
            "模型「{}」不能包含空白字符或控制字符",
            id
        ));
    }
    let effort_level = model.effort_level.trim().to_string();
    if !effort_level.is_empty() && !is_valid_effort_level(&effort_level) {
        return Err(format!("模型「{}」的推理等级无效", id));
    }
    Ok(LlmModelConfig {
        id,
        enabled: model.enabled,
        context_window: model.context_window,
        effort_level,
        max_output_tokens: model.max_output_tokens,
    })
}

impl LlmProviderInput {
    /// 校验表单载荷并归一化。`previous_key` 为已保存的解密 Key（更新时沿用）。
    /// 返回 `(归一化后的 provider 草稿, 生效的解密 Key)`，Key 由调用方负责加密落盘。
    pub fn validate(self, previous_key: Option<&str>) -> Result<(LlmProvider, String), String> {
        let name = self.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 80 {
            return Err("供应商名称不能为空，且不能超过 80 个字符".to_string());
        }
        reject_control_chars("供应商名称", &name)?;
        let base_url = validate_base_url(&self.base_url)?;
        if !AUTH_TYPES.contains(&self.auth_type.as_str()) {
            return Err("不支持的密钥认证方式".to_string());
        }
        let key = self
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| previous_key.map(str::to_string))
            .ok_or_else(|| "请输入 API 密钥；编辑时可留空沿用已保存的密钥".to_string())?;
        if key.len() > 8192 {
            return Err("API 密钥格式无效".to_string());
        }
        reject_control_chars("API 密钥", &key)?;
        let default_effort_level = self.default_effort_level.trim().to_string();
        if !is_valid_effort_level(&default_effort_level) {
            return Err("默认推理等级必选（low/medium/high/xhigh/max）".to_string());
        }
        let models_url = validate_models_url(&self.models_url)?;
        let mut enabled_models = Vec::with_capacity(self.enabled_models.len());
        let mut seen_models = HashSet::with_capacity(self.enabled_models.len());
        for model in &self.enabled_models {
            let model = validate_model_config(model)?;
            if !seen_models.insert(model.id.clone()) {
                return Err(format!("模型「{}」重复，请删除重复项后再保存", model.id));
            }
            enabled_models.push(model);
        }
        Ok((
            LlmProvider {
                id: self.id.trim().to_string(),
                name,
                base_url,
                auth_type: self.auth_type,
                api_key: String::new(),
                is_default: self.is_default,
                default_effort_level,
                models_url,
                enabled_models,
                sort_index: self.sort_index,
                created_at: String::new(),
                updated_at: String::new(),
            },
            key,
        ))
    }
}

impl LlmProvider {
    /// 脱敏视图：只给 `keySet` + 末 4 位。
    pub fn to_view(&self, decrypted_key: &str) -> LlmProviderView {
        let key_tail = if decrypted_key.is_empty() {
            String::new()
        } else {
            decrypted_key
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        };
        LlmProviderView {
            id: self.id.clone(),
            name: self.name.clone(),
            base_url: self.base_url.clone(),
            auth_type: self.auth_type.clone(),
            key_set: !decrypted_key.is_empty(),
            key_tail,
            is_default: self.is_default,
            default_effort_level: self.default_effort_level.clone(),
            models_url: self.models_url.clone(),
            enabled_models: self.enabled_models.clone(),
            sort_index: self.sort_index,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_input() -> LlmProviderInput {
        LlmProviderInput {
            id: String::new(),
            name: "公司中转站".to_string(),
            base_url: "https://ai-proxy.company.com/v1/".to_string(),
            auth_type: "ANTHROPIC_AUTH_TOKEN".to_string(),
            api_key: Some("sk-test-key-1234".to_string()),
            is_default: true,
            default_effort_level: "high".to_string(),
            models_url: String::new(),
            enabled_models: vec![LlmModelConfig {
                id: "claude-opus-5-5".to_string(),
                enabled: true,
                context_window: 200000,
                effort_level: "max".to_string(),
                max_output_tokens: 0,
            }],
            sort_index: 0,
        }
    }

    #[test]
    fn validates_and_normalizes_provider_input() {
        let (provider, key) = valid_input().validate(None).expect("合法输入应通过");
        assert_eq!(provider.base_url, "https://ai-proxy.company.com/v1");
        assert_eq!(key, "sk-test-key-1234");
        assert_eq!(provider.enabled_models.len(), 1);
    }

    #[test]
    fn rejects_invalid_base_url_auth_and_effort() {
        for base_url in [
            "file:///tmp/config",
            "https://key@example.com/x",
            "https://example.com?key=secret",
            "not-a-url",
            "https://example.com/x#frag",
        ] {
            let mut input = valid_input();
            input.base_url = base_url.to_string();
            assert!(input.validate(None).is_err(), "地址「{}」应被拒绝", base_url);
        }
        let mut input = valid_input();
        input.auth_type = "BEARER".to_string();
        assert!(input.validate(None).is_err());
        let mut input = valid_input();
        input.default_effort_level = "ultracode".to_string();
        assert!(input.validate(None).is_err());
        let mut input = valid_input();
        input.default_effort_level = String::new();
        assert!(input.validate(None).is_err());
    }

    #[test]
    fn model_id_rejects_whitespace_and_control_chars() {
        for id in ["claude opus", "a\tb", "a\nb", " a", ""] {
            let mut input = valid_input();
            input.enabled_models[0].id = id.to_string();
            // 纯首尾空白会被 trim 后接受（" a" → "a"），其余拒绝
            if id.trim().chars().any(|c| c.is_control() || c.is_whitespace()) || id.trim().is_empty() {
                assert!(input.validate(None).is_err(), "模型「{:?}」应被拒绝", id);
            }
        }
        let mut input = valid_input();
        input.enabled_models[0].id = " a ".to_string();
        let (provider, _) = input.validate(None).expect("首尾空白应被 trim");
        assert_eq!(provider.enabled_models[0].id, "a");
        let mut input = valid_input();
        input.enabled_models[0].id = "a".repeat(257);
        assert!(input.validate(None).is_err());
    }

    #[test]
    fn rejects_duplicate_model_ids_after_trimming() {
        let mut input = valid_input();
        input.enabled_models.push(LlmModelConfig {
            id: " claude-opus-5-5 ".to_string(),
            enabled: true,
            context_window: 0,
            effort_level: String::new(),
            max_output_tokens: 0,
        });
        let error = input.validate(None).expect_err("重复模型应被拒绝");
        assert!(error.contains("claude-opus-5-5"), "{error}");
        assert!(error.contains("重复"), "{error}");
    }

    #[test]
    fn model_effort_empty_follows_default() {
        let mut input = valid_input();
        input.enabled_models[0].effort_level = String::new();
        let (provider, _) = input.validate(None).expect("空档位应通过");
        assert_eq!(
            resolve_model_effort(&provider.enabled_models[0], &provider.default_effort_level),
            "high"
        );
        let mut input = valid_input();
        input.enabled_models[0].effort_level = "bogus".to_string();
        assert!(input.validate(None).is_err());
    }

    #[test]
    fn empty_key_falls_back_to_previous_and_never_accepts_mask() {
        // 更新时留空沿用旧 Key
        let mut input = valid_input();
        input.id = "existing-id".to_string();
        input.api_key = None;
        let (_, key) = input.validate(Some("old-secret")).expect("留空应沿用旧 Key");
        assert_eq!(key, "old-secret");
        // 新建无 Key 拒绝
        let mut input = valid_input();
        input.api_key = Some("   ".to_string());
        assert!(input.validate(None).is_err());
    }

    #[test]
    fn view_masks_key_with_last_four_chars() {
        let (provider, key) = valid_input().validate(None).unwrap();
        let view = provider.to_view(&key);
        assert!(view.key_set);
        assert_eq!(view.key_tail, "1234");
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("sk-test-key-1234"));
        // camelCase 序列化
        assert!(json.contains("keySet") && json.contains("defaultEffortLevel"));
    }
}
