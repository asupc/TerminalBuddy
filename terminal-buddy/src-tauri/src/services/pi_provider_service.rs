//! Pi 兼容端点供应商：应用内 `pi_providers.json` CRUD，
//! 每次保存/删除同步写回 `<agent-dir>/models.json` 的 `providers` 段。
//!
//! 同步规则：
//! - 只读写带 `x-terminal-buddy-id` 标记的 provider 条目；用户手写条目与
//!   内置 provider 覆盖（如 `anthropic: { baseUrl }`）原样保留。
//! - 标记值是供应商卡片的 UUID；按 id 匹配条目，改名（`piProviderId`）时
//!   删除旧键、写入新键，不残留。
//! - `auth.json` 的 `/login` 凭证优先于 models.json 的 `apiKey`，因此同步
//!   不会破坏用户已有的 Pi 登录；冲突键名在保存时直接拒绝。
//! - 密钥形态：`literal` 在应用数据中加密保存，同步时解密明文写入
//!   models.json（Pi 只认明文）；`env`/`command` 存原文、同步时原文写入。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use serde_json::{json, Map, Value};

use super::atomic_file::atomic_write_private;
use super::codex_provider_service::{read_optional, write_transaction};
use super::crypto_service::{decrypt_secret_field, encrypt_secret_field};
use super::llm_provider_service::{self, FetchedModel};
use super::path_service::PathService;
use crate::models::llm_provider::validate_base_url;
use crate::models::pi_provider::{
    normalize_available_models, PiCompatConfig, PiModelConfig, PiProvider, PiProviderFile,
    PiProviderInput, PiProviderState, PiThinkingLevelMap, PI_MANAGED_MARKER,
};

const PROVIDERS_FILE: &str = "pi_providers.json";
const BACKUP_DIR: &str = "terminal-buddy-backups";

fn config_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn lock_error() -> String {
    "Pi 供应商配置锁不可用，请重试".to_string()
}

/// Pi agent 目录：`PI_CODING_AGENT_DIR` → `~/.pi/agent`。
/// 与 `pi_history_service::agent_dir` 同规则，独立实现以便单元测试注入。
fn resolve_agent_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("PI_CODING_AGENT_DIR").filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        return if path.is_absolute() {
            Ok(path)
        } else {
            std::env::current_dir()
                .map(|dir| dir.join(path))
                .map_err(|error| format!("无法解析 PI_CODING_AGENT_DIR：{}", error))
        };
    }
    dirs::home_dir()
        .map(|dir| dir.join(".pi/agent"))
        .ok_or_else(|| "无法确定 Pi 配置目录".to_string())
}

struct ProviderStore {
    path: PathBuf,
    agent_dir: PathBuf,
}

fn store() -> Result<ProviderStore, String> {
    Ok(ProviderStore {
        path: PathService::require_data_dir()?.join(PROVIDERS_FILE),
        agent_dir: resolve_agent_dir()?,
    })
}

fn models_path(agent_dir: &Path) -> PathBuf {
    agent_dir.join("models.json")
}

fn key_for(provider: &PiProvider) -> Result<String, String> {
    if provider.key_mode == "literal" {
        decrypt_secret_field(&provider.api_key)
            .map_err(|_| format!("供应商「{}」的密钥无法解密，请重新录入", provider.name))
    } else {
        // env / command 形态存原文。
        Ok(provider.api_key.clone())
    }
}

fn encode_key(provider: &PiProvider, key: &str) -> Result<String, String> {
    if provider.key_mode == "literal" {
        encrypt_secret_field(key)
    } else {
        Ok(key.to_string())
    }
}

// ---------------------------------------------------------------------------
// models.json 编解码
// ---------------------------------------------------------------------------

/// 解析 models.json；文件不存在视为空文档。损坏则报错且不写回。
fn parse_models(bytes: &[u8]) -> Result<Map<String, Value>, String> {
    if bytes.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| "Pi models.json 不是有效 JSON，请修复后重试；原文件未更改".to_string())?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err("Pi models.json 顶层必须是 JSON 对象；原文件未更改".to_string()),
    }
}

fn providers_map(doc: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    match doc.get("providers") {
        None => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(_) => Err("Pi models.json 的 providers 必须是对象；原文件未更改".to_string()),
    }
}

fn compat_to_json(compat: &PiCompatConfig) -> Option<Value> {
    let mut map = Map::new();
    if let Some(force) = compat.force_adaptive_thinking {
        map.insert("forceAdaptiveThinking".to_string(), Value::Bool(force));
    }
    if let Some(format) = compat.thinking_format.as_deref() {
        map.insert("thinkingFormat".to_string(), Value::String(format.to_string()));
    }
    for (key, value) in &compat.extra {
        map.insert(key.clone(), value.clone());
    }
    if map.is_empty() { None } else { Some(Value::Object(map)) }
}

fn thinking_map_to_json(map: &PiThinkingLevelMap) -> Option<Value> {
    if map.levels.is_empty() {
        return None;
    }
    let mut object = Map::new();
    for (level, value) in &map.levels {
        object.insert(
            level.clone(),
            value.clone().map(Value::String).unwrap_or(Value::Null),
        );
    }
    Some(Value::Object(object))
}

fn model_to_json(model: &PiModelConfig) -> Value {
    let mut map = Map::new();
    map.insert("id".to_string(), Value::String(model.id.clone()));
    if !model.name.is_empty() {
        map.insert("name".to_string(), Value::String(model.name.clone()));
    }
    if model.reasoning {
        map.insert("reasoning".to_string(), Value::Bool(true));
    }
    if let Some(levels) = thinking_map_to_json(&model.thinking_level_map) {
        map.insert("thinkingLevelMap".to_string(), levels);
    }
    map.insert(
        "input".to_string(),
        if model.image_input {
            json!(["text", "image"])
        } else {
            json!(["text"])
        },
    );
    if model.context_window > 0 {
        map.insert("contextWindow".to_string(), json!(model.context_window));
    }
    if model.max_tokens > 0 {
        map.insert("maxTokens".to_string(), json!(model.max_tokens));
    }
    if let Some(compat) = compat_to_json(&model.compat) {
        map.insert("compat".to_string(), compat);
    }
    Value::Object(map)
}

fn provider_to_json(provider: &PiProvider, key: &str) -> Value {
    let mut map = Map::new();
    map.insert("name".to_string(), Value::String(provider.name.clone()));
    map.insert("baseUrl".to_string(), Value::String(provider.base_url.clone()));
    map.insert("api".to_string(), Value::String(provider.api.clone()));
    if !key.is_empty() {
        map.insert("apiKey".to_string(), Value::String(key.to_string()));
    }
    if provider.auth_header {
        map.insert("authHeader".to_string(), Value::Bool(true));
    }
    if !provider.headers.is_empty() {
        let mut headers = Map::new();
        for (name, value) in &provider.headers {
            headers.insert(name.clone(), Value::String(value.clone()));
        }
        map.insert("headers".to_string(), Value::Object(headers));
    }
    if let Some(compat) = compat_to_json(&provider.compat) {
        map.insert("compat".to_string(), compat);
    }
    map.insert(
        "models".to_string(),
        Value::Array(provider.models.iter().map(model_to_json).collect()),
    );
    map.insert(PI_MANAGED_MARKER.to_string(), Value::String(provider.id.clone()));
    Value::Object(map)
}

/// 反向解析：models.json 条目 → 导入用 Input。只接受"完整自定义 provider"
/// 形态（有 baseUrl + api + models）；内置覆盖与扩展 provider 返回 None。
fn parse_managed_entry(id: &str, entry: &Value) -> Option<PiProviderInput> {
    let object = entry.as_object()?;
    let base_url = object.get("baseUrl")?.as_str()?;
    let api = object.get("api")?.as_str()?;
    let models = object.get("models")?.as_array()?;
    if base_url.trim().is_empty() || api.trim().is_empty() || models.is_empty() {
        return None;
    }
    let mut parsed = Vec::new();
    for model in models {
        let model = model.as_object()?;
        let id = model.get("id")?.as_str()?;
        if id.trim().is_empty() {
            return None;
        }
        let mut levels = std::collections::BTreeMap::new();
        if let Some(Value::Object(map)) = model.get("thinkingLevelMap") {
            for (level, value) in map {
                match value {
                    Value::Null => {
                        levels.insert(level.clone(), None);
                    }
                    Value::String(text) => {
                        levels.insert(level.clone(), Some(text.clone()));
                    }
                    _ => return None,
                }
            }
        }
        parsed.push(PiModelConfig {
            id: id.to_string(),
            name: model.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            reasoning: model.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
            default_thinking: None,
            thinking_level_map: PiThinkingLevelMap { levels },
            image_input: model
                .get("input")
                .and_then(Value::as_array)
                .is_none_or(|inputs| {
                    inputs.iter().any(|item| item.as_str() == Some("image"))
                })
                // 缺 `input` 键时沿用默认 true；显式 `["text"]` 则为 false。
                || model.get("input").is_none(),
            context_window: model
                .get("contextWindow")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
                .unwrap_or(0),
            max_tokens: model
                .get("maxTokens")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
                .unwrap_or(0),
            compat: parse_compat(model.get("compat"))?,
        });
    }
    let mut headers = std::collections::BTreeMap::new();
    if let Some(Value::Object(map)) = object.get("headers") {
        for (name, value) in map {
            headers.insert(name.clone(), value.as_str()?.to_string());
        }
    }
    let api_key = object.get("apiKey").and_then(Value::as_str).unwrap_or("").trim();
    let key_mode = if api_key.starts_with('$') {
        "env"
    } else if api_key.starts_with('!') {
        "command"
    } else {
        "literal"
    };
    Some(PiProviderInput {
        id: id.to_string(),
        name: object.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        pi_provider_id: String::new(),
        base_url: base_url.to_string(),
        api_key: if api_key.is_empty() { None } else { Some(api_key.to_string()) },
        key_mode: key_mode.to_string(),
        api: api.to_string(),
        auth_header: object.get("authHeader").and_then(Value::as_bool).unwrap_or(false),
        headers,
        model: parsed.first()?.id.clone(),
        models: parsed,
        available_models: None,
        compat: parse_compat(object.get("compat"))?,
    })
}

fn parse_compat(value: Option<&Value>) -> Option<PiCompatConfig> {
    let mut compat = PiCompatConfig::default();
    let Some(entry) = value else {
        return Some(compat);
    };
    let object = entry.as_object()?;
    for (key, val) in object {
        match key.as_str() {
            "forceAdaptiveThinking" => {
                compat.force_adaptive_thinking = Some(val.as_bool()?);
            }
            "thinkingFormat" => {
                compat.thinking_format = Some(val.as_str()?.to_string());
            }
            _ => {
                compat.extra.insert(key.clone(), val.clone());
            }
        }
    }
    Some(compat)
}

// ---------------------------------------------------------------------------
// ProviderStore
// ---------------------------------------------------------------------------

impl ProviderStore {
    fn read(&self) -> Result<PiProviderFile, String> {
        let Some(bytes) = read_optional(&self.path)? else {
            return Ok(PiProviderFile::default());
        };
        serde_json::from_slice(&bytes)
            .map_err(|_| "Pi 供应商数据已损坏，请修复 pi_providers.json 后重试".to_string())
    }

    fn read_models_doc(&self) -> Result<Option<Map<String, Value>>, String> {
        Ok(read_optional(&models_path(&self.agent_dir))?.map(|bytes| parse_models(&bytes)).transpose()?)
    }

    /// 非本应用管理的 provider 键名（内置覆盖 / 手写 / 扩展注册都在 models.json 里可见）。
    fn external_ids(&self, providers: &Map<String, Value>) -> Vec<String> {
        let mut ids: Vec<String> = providers
            .iter()
            .filter(|(_, entry)| entry.get(PI_MANAGED_MARKER).and_then(Value::as_str).is_none())
            .map(|(key, _)| key.clone())
            .collect();
        ids.sort();
        ids
    }

    fn view(&self, file: &PiProviderFile) -> Result<PiProviderState, String> {
        let (external_provider_ids, config_error) = match self.read_models_doc()? {
            Some(doc) => match providers_map(&doc) {
                Ok(providers) => (self.external_ids(&providers), None),
                Err(error) => (Vec::new(), Some(error)),
            },
            None => (Vec::new(), None),
        };
        let providers = file
            .providers
            .iter()
            .map(|p| Ok(p.to_view(&key_for(p)?)))
            .collect::<Result<Vec<_>, String>>()?;
        Ok(PiProviderState {
            active_provider_id: file
                .current_provider_id
                .clone()
                .filter(|id| providers.iter().any(|p| &p.id == id)),
            providers,
            agent_dir: self.agent_dir.to_string_lossy().to_string(),
            models_path: models_path(&self.agent_dir).to_string_lossy().to_string(),
            config_error,
            external_provider_ids,
        })
    }

    /// 提交应用数据 + 同步 models.json。`sync_ids` 为需要同步的卡片 id 集合
    /// （保存/删除涉及的卡片）；`removed` 为已删除卡片的 (id, 旧 pi_provider_id)。
    /// `takeover_unmanaged` 仅导入流程为 true：允许接管无标记的同名条目
    /// （导入前已校验该条目是完整自定义 provider 且未被任何卡片管理）。
    fn commit(
        &self,
        file: &PiProviderFile,
        sync: Option<(&PiProvider, Option<String>)>,
        removed: Option<(&str, &str)>,
        takeover_unmanaged: bool,
    ) -> Result<(), String> {
        let bytes =
            serde_json::to_vec_pretty(file).map_err(|_| "编码 Pi 供应商失败".to_string())?;
        let mut writes = Vec::new();
        let mut backup = false;
        if sync.is_some() || removed.is_some() {
            let path = models_path(&self.agent_dir);
            let current = read_optional(&path)?.unwrap_or_default();
            let mut doc = parse_models(&current)?;
            let mut providers = providers_map(&doc)?;
            if let Some((id, _)) = removed {
                // 按标记 id 删除旧条目（键名可能已被用户改过，按标记找最可靠）。
                providers.retain(|_, entry| {
                    entry.get(PI_MANAGED_MARKER).and_then(Value::as_str) != Some(id)
                });
            }
            if let Some((provider, previous_key)) = sync {
                // 改名时先删旧键。
                if let Some(old) = previous_key.filter(|old| old != &provider.pi_provider_id) {
                    providers.remove(&old);
                }
                // 同键已有非本卡片管理的条目 → 拒绝，避免覆盖用户手写/其他卡片。
                // 导入接管时允许覆盖无标记条目（有标记=其他卡片管理，仍拒绝）。
                if let Some(entry) = providers.get(&provider.pi_provider_id) {
                    let owned = entry.get(PI_MANAGED_MARKER).and_then(Value::as_str) == Some(provider.id.as_str());
                    let unmarked = entry.get(PI_MANAGED_MARKER).and_then(Value::as_str).is_none();
                    if !owned && !(takeover_unmanaged && unmarked) {
                        return Err(format!(
                            "Pi models.json 已存在「{}」配置（非本应用管理），请换一个 Pi 供应商 ID 或手动合并",
                            provider.pi_provider_id
                        ));
                    }
                }
                // 同一标记残留在其他键下（用户手动改过键名）→ 清理后写入新键。
                providers.retain(|key, entry| {
                    key == &provider.pi_provider_id
                        || entry.get(PI_MANAGED_MARKER).and_then(Value::as_str) != Some(provider.id.as_str())
                });
                let key = key_for(provider)?;
                providers.insert(provider.pi_provider_id.clone(), provider_to_json(provider, &key));
            }
            // 保留 $schema 等顶层键，只替换 providers。
            doc.insert("providers".to_string(), Value::Object(providers));
            if !doc.contains_key("$schema") {
                doc.insert(
                    "$schema".to_string(),
                    Value::String("https://pi.dev/schemas/models.schema.json".to_string()),
                );
            }
            let updated = serde_json::to_vec_pretty(&Value::Object(doc))
                .map_err(|_| "编码 Pi models.json 失败".to_string())?;
            if updated != current {
                writes.push((path, updated));
                backup = true;
            }
        }
        writes.push((self.path.clone(), bytes));
        let root = self.agent_dir.join(BACKUP_DIR);
        write_transaction(&writes, backup.then(|| root.as_path()), atomic_write_private)
    }

    fn save(
        &self,
        input: PiProviderInput,
        activate: bool,
        previous_key_hint: Option<String>,
    ) -> Result<PiProviderState, String> {
        let mut file = self.read()?;
        let previous = if input.id.trim().is_empty() {
            None
        } else {
            Some(
                file.providers
                    .iter()
                    .find(|p| p.id == input.id.trim())
                    .ok_or_else(|| "Pi 供应商不存在，可能已被删除".to_string())?,
            )
        };
        let replacing_key = input
            .api_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty());
        let previous_key;
        let previous_key_mode;
        if replacing_key {
            previous_key = None;
            previous_key_mode = None;
        } else if let Some(hint) = previous_key_hint {
            // 导入流程：密钥来自 models.json 明文。
            previous_key = Some(hint);
            previous_key_mode = previous.map(|p| p.key_mode.as_str());
        } else {
            previous_key = previous.map(key_for).transpose()?;
            previous_key_mode = previous.map(|p| p.key_mode.as_str());
        }
        let keep_available_models = input.available_models.is_none();
        let (mut provider, key) = input.validate(
            previous_key.as_deref(),
            previous_key_mode,
        )?;
        // pi_provider_id 在卡片间唯一。
        if file.providers.iter().any(|p| p.id != provider.id && p.pi_provider_id == provider.pi_provider_id) {
            return Err(format!("Pi 供应商 ID「{}」已被另一张卡片使用", provider.pi_provider_id));
        }
        if keep_available_models {
            if let Some(prev) = previous.filter(|p| {
                p.base_url.trim_end_matches('/') == provider.base_url.trim_end_matches('/')
                    && key_for(p).is_ok_and(|saved| saved == key)
            }) {
                provider.available_models = prev.available_models.clone();
            }
        }
        let previous_pi_key = previous.map(|p| p.pi_provider_id.clone());
        provider.created_at = previous
            .map(|p| p.created_at.clone())
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        provider.updated_at = Utc::now().to_rfc3339();
        provider.api_key = encode_key(&provider, &key)?;
        if provider.id.is_empty() {
            provider.id = uuid::Uuid::new_v4().to_string();
        }
        let is_first = !file.providers.iter().any(|p| p.id == provider.id);
        if let Some(slot) = file.providers.iter_mut().find(|p| p.id == provider.id) {
            *slot = provider.clone();
        } else {
            file.providers.push(provider.clone());
        }
        // 与 Codex 一致的默认逻辑：首个供应商自动设默认、保存当前默认或
        // 显式"保存并设为默认"时更新默认标记。
        let should_activate = activate
            || (is_first && file.providers.len() == 1)
            || file.current_provider_id.as_deref() == Some(provider.id.as_str());
        if should_activate {
            file.current_provider_id = Some(provider.id.clone());
        }
        self.commit(&file, Some((&provider, previous_pi_key)), None, false)?;
        self.view(&file)
    }

    fn delete(&self, id: &str) -> Result<PiProviderState, String> {
        let mut file = self.read()?;
        if file.current_provider_id.as_deref() == Some(id) {
            return Err("请先取消默认供应商，再删除默认供应商".to_string());
        }
        let index = file
            .providers
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| "Pi 供应商不存在，可能已被删除".to_string())?;
        let removed = file.providers.remove(index);
        self.commit(&file, None, Some((&removed.id, &removed.pi_provider_id)), false)?;
        self.view(&file)
    }

    /// 从 models.json 导入一条"完整自定义 provider"（有 baseUrl + api + models）。
    /// 已被管理的条目、内置覆盖、缺模型的条目不可导入。
    fn import(&self, pi_provider_id: &str) -> Result<PiProviderState, String> {
        let pi_provider_id = pi_provider_id.trim().to_string();
        if pi_provider_id.is_empty() {
            return Err("请选择要导入的 Pi 供应商".to_string());
        }
        let mut file = self.read()?;
        if file.providers.iter().any(|p| p.pi_provider_id == pi_provider_id) {
            return Err(format!("「{pi_provider_id}」已在供应商列表中"));
        }
        let doc = self.read_models_doc()?.ok_or_else(|| "Pi models.json 不存在，没有可导入的配置".to_string())?;
        let providers = providers_map(&doc)?;
        let entry = providers.get(&pi_provider_id).ok_or_else(|| format!("models.json 中没有「{pi_provider_id}」"))?;
        if entry.get(PI_MANAGED_MARKER).and_then(Value::as_str).is_some() {
            return Err(format!("「{pi_provider_id}」已由本应用管理"));
        }
        let mut input = parse_managed_entry("", entry).ok_or_else(|| {
            format!("「{pi_provider_id}」不是完整的自定义供应商（需要 baseUrl、api 与模型列表），内置 provider 覆盖无需导入")
        })?;
        input.pi_provider_id = pi_provider_id.clone();
        if input.name.trim().is_empty() {
            input.name = pi_provider_id.clone();
        }
        let key_hint = input.api_key.clone();
        // 无密钥条目（如本地 Ollama 占位）允许导入：先以占位通过校验，
        // 落盘与同步时均以空密钥处理（不写 apiKey）。
        let keyless = key_hint.as_deref().is_none_or(|key| key.trim().is_empty());
        if keyless {
            input.api_key = Some("pi-import-placeholder".to_string());
        }
        // 导入只保存应用数据并打上管理标记；条目内容以 models.json 现状为准回写
        // （补齐标记与默认结构，不改变连接语义）。
        let (mut provider, key) = input.validate(key_hint.as_deref(), key_hint.as_ref().map(|_| {
            if key_hint.as_deref().is_some_and(|k| k.starts_with('$')) { "env" }
            else if key_hint.as_deref().is_some_and(|k| k.starts_with('!')) { "command" }
            else { "literal" }
        }))?;
        let key = if keyless { String::new() } else { key };
        provider.id = uuid::Uuid::new_v4().to_string();
        provider.created_at = Utc::now().to_rfc3339();
        provider.updated_at = provider.created_at.clone();
        provider.api_key = encode_key(&provider, &key)?;
        file.providers.push(provider.clone());
        self.commit(&file, Some((&provider, None)), None, true)?;
        self.view(&file)
    }

    /// 只更新与本次请求相同地址和密钥的供应商，避免在途请求覆盖已修改的配置。
    fn cache_models(&self, id: &str, base_url: &str, key: &str, models: Vec<String>) -> Result<(), String> {
        let mut file = self.read()?;
        let Some(provider) = file.providers.iter_mut().find(|p| p.id == id) else {
            return Ok(());
        };
        if provider.base_url.trim_end_matches('/') != base_url.trim_end_matches('/')
            || key_for(provider)? != key
        {
            return Ok(());
        }
        provider.available_models = normalize_available_models(models)?;
        provider.updated_at = Utc::now().to_rfc3339();
        // 更新列表不改写 Pi 的 models.json。
        self.commit(&file, None, None, false)
    }

    /// 设为默认供应商（仅记录 TerminalBuddy 侧标记，不改 models.json）。
    fn activate(&self, id: &str) -> Result<PiProviderState, String> {
        let mut file = self.read()?;
        if !file.providers.iter().any(|p| p.id == id) {
            return Err("Pi 供应商不存在，可能已被删除".to_string());
        }
        file.current_provider_id = Some(id.to_string());
        // 只更新应用数据，不需要同步 models.json。
        self.commit(&file, None, None, false)?;
        self.view(&file)
    }

    /// 取消默认供应商：保留卡片，右键菜单不再平铺。
    fn clear_default(&self) -> Result<PiProviderState, String> {
        let mut file = self.read()?;
        file.current_provider_id = None;
        self.commit(&file, None, None, false)?;
        self.view(&file)
    }
}

pub fn get_provider_state() -> Result<PiProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    let store = store()?;
    store.view(&store.read()?)
}

pub fn save_provider(input: PiProviderInput, activate: bool) -> Result<PiProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    store()?.save(input, activate, None)
}

pub fn delete_provider(id: &str) -> Result<PiProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    store()?.delete(id)
}

pub fn activate_provider(id: &str) -> Result<PiProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    store()?.activate(id)
}

pub fn clear_default_provider() -> Result<PiProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    store()?.clear_default()
}

/// TerminalBuddy 侧的启动默认值（供 pi_model_service 联查，不读 models.json、不解密）：
/// 默认供应商的 Pi 侧键名，与每张卡片各模型的默认思考级别。
pub struct PiLaunchDefaults {
    pub default_provider: Option<String>,
    /// `pi_provider_id` → (`model id` → thinking level)。
    pub default_thinking: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

pub fn launch_defaults() -> PiLaunchDefaults {
    let empty = PiLaunchDefaults {
        default_provider: None,
        default_thinking: std::collections::HashMap::new(),
    };
    let Ok(store) = store() else {
        return empty;
    };
    let file = match store.read() {
        Ok(file) => file,
        Err(_) => return empty,
    };
    PiLaunchDefaults {
        default_provider: file
            .current_provider_id
            .as_deref()
            .and_then(|id| {
                file.providers
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| p.pi_provider_id.clone())
            }),
        default_thinking: file
            .providers
            .iter()
            .map(|p| {
                let models = p
                    .models
                    .iter()
                    .filter_map(|m| {
                        m.default_thinking
                            .clone()
                            .map(|level| (m.id.clone(), level))
                    })
                    .collect();
                (p.pi_provider_id.clone(), models)
            })
            .collect(),
    }
}

pub fn import_provider(pi_provider_id: &str) -> Result<PiProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    store()?.import(pi_provider_id)
}

pub async fn fetch_models(
    base_url: String,
    api_key: String,
    provider_id: Option<String>,
) -> Result<Vec<FetchedModel>, String> {
    let base_url = validate_base_url(&base_url)?;
    let lookup_id = provider_id.clone();
    let key = crate::runtime::async_runtime::spawn_blocking(move || {
        let _guard = config_lock().lock().map_err(|_| lock_error())?;
        if !api_key.trim().is_empty() {
            return Ok(api_key.trim().to_string());
        }
        let store = store()?;
        let file = store.read()?;
        let provider = file
            .providers
            .iter()
            .find(|p| Some(&p.id) == lookup_id.as_ref())
            .ok_or_else(|| "请先填写 API 密钥".to_string())?;
        key_for(provider)
    })
    .await
    .map_err(|error| format!("读取 Pi 密钥失败：{}", error))??;
    let fetched = llm_provider_service::fetch_provider_models(&base_url, &key, "", None).await?;
    let ids = normalize_available_models(fetched.into_iter().map(|model| model.id).collect())?;
    if let Some(id) = provider_id.filter(|id| !id.is_empty()) {
        let models = ids.clone();
        crate::runtime::async_runtime::spawn_blocking(move || {
            let _guard = config_lock().lock().map_err(|_| lock_error())?;
            store()?.cache_models(&id, &base_url, &key, models)
        })
        .await
        .map_err(|error| format!("保存 Pi 模型列表失败：{}", error))??;
    }
    Ok(ids.into_iter().map(|id| FetchedModel { id }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::pi_provider::PI_API_KINDS;

    struct TestStore(ProviderStore);

    impl TestStore {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("pi-provider-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            PathService::set_test_data_dir(Some(root.clone()));
            let agent = root.join("agent");
            fs::create_dir_all(&agent).unwrap();
            Self(ProviderStore {
                path: root.join(PROVIDERS_FILE),
                agent_dir: agent,
            })
        }

        fn models_json(&self) -> Value {
            let bytes = fs::read(models_path(&self.0.agent_dir)).unwrap();
            serde_json::from_slice(&bytes).unwrap()
        }
    }

    impl Drop for TestStore {
        fn drop(&mut self) {
            PathService::set_test_data_dir(None);
            let _ = fs::remove_dir_all(self.0.path.parent().unwrap());
        }
    }

    fn model(id: &str) -> PiModelConfig {
        PiModelConfig {
            id: id.to_string(),
            name: String::new(),
            reasoning: false,
            default_thinking: None,
            thinking_level_map: PiThinkingLevelMap::default(),
            image_input: true,
            context_window: 0,
            max_tokens: 0,
            compat: PiCompatConfig::default(),
        }
    }

    fn input(name: &str) -> PiProviderInput {
        PiProviderInput {
            id: String::new(),
            name: name.to_string(),
            pi_provider_id: "acme".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            api_key: Some("sk-pi-test-secret-1234".to_string()),
            key_mode: "literal".to_string(),
            api: "openai-completions".to_string(),
            auth_header: false,
            headers: Default::default(),
            model: "test-model".to_string(),
            models: vec![model("test-model")],
            available_models: None,
            compat: PiCompatConfig::default(),
        }
    }

    #[test]
    fn api_kinds_cover_expected_protocols() {
        for api in ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] {
            assert!(PI_API_KINDS.contains(&api), "{api}");
        }
    }

    #[test]
    fn save_syncs_models_json_and_preserves_user_entries() {
        let store = TestStore::new();
        // 预置用户手写条目与内置覆盖，同步不得破坏。
        fs::write(
            models_path(&store.0.agent_dir),
            serde_json::to_vec_pretty(&json!({
                "$schema": "https://pi.dev/schemas/models.schema.json",
                "providers": {
                    "anthropic": { "baseUrl": "https://proxy.example.com/v1" },
                    "handwritten": {
                        "baseUrl": "http://localhost:11434/v1",
                        "api": "openai-completions",
                        "apiKey": "ollama",
                        "models": [{ "id": "qwen2.5-coder:7b" }]
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let state = store.0.save(input("Acme"), false, None).unwrap();
        assert_eq!(state.providers.len(), 1);
        assert_eq!(state.providers[0].key_tail, "1234");
        assert!(state.providers[0].key_set);
        let doc = store.models_json();
        let providers = doc.get("providers").unwrap().as_object().unwrap();
        // 用户条目原样保留。
        assert_eq!(providers.get("anthropic").unwrap().get("baseUrl").unwrap(), "https://proxy.example.com/v1");
        assert!(providers.get("handwritten").unwrap().get(PI_MANAGED_MARKER).is_none());
        // 本应用条目带标记、可被 Pi 读取。
        let entry = providers.get("acme").unwrap();
        assert_eq!(entry.get("api").unwrap(), "openai-completions");
        assert_eq!(entry.get("apiKey").unwrap(), "sk-pi-test-secret-1234");
        assert_eq!(entry.get(PI_MANAGED_MARKER).unwrap(), &json!(state.providers[0].id));
        // external 列表只含非管理条目。
        assert_eq!(state.external_provider_ids, vec!["anthropic", "handwritten"]);
    }

    #[test]
    fn rename_moves_key_and_delete_removes_entry() {
        let store = TestStore::new();
        let state = store.0.save(input("Acme"), false, None).unwrap();
        let id = state.providers[0].id.clone();
        let mut renamed = input("Acme Renamed");
        renamed.id = id.clone();
        renamed.pi_provider_id = "acme-v2".to_string();
        store.0.save(renamed, false, None).unwrap();
        let providers = store.models_json().get("providers").unwrap().clone();
        assert!(providers.get("acme").is_none());
        assert!(providers.get("acme-v2").is_some());
        // 首个保存的供应商是默认供应商，先取消默认再删除。
        store.0.clear_default().unwrap();
        // 删除后 models.json 不再残留，应用数据同步清空。
        let state = store.0.delete(&id).unwrap();
        assert!(state.providers.is_empty());
        let providers = store.models_json().get("providers").unwrap().clone();
        assert!(providers.get("acme-v2").is_none());
    }

    #[test]
    fn conflicting_external_key_is_rejected() {
        let store = TestStore::new();
        fs::write(
            models_path(&store.0.agent_dir),
            serde_json::to_vec_pretty(&json!({
                "providers": { "acme": { "baseUrl": "http://other/v1", "api": "openai-completions", "models": [{ "id": "x" }] } }
            }))
            .unwrap(),
        )
        .unwrap();
        let error = store.0.save(input("Acme"), false, None).unwrap_err();
        assert!(error.contains("非本应用管理"), "{error}");
    }

    #[test]
    fn env_key_mode_stores_verbatim() {
        let store = TestStore::new();
        let mut draft = input("Env");
        draft.api_key = Some("$MY_API_KEY".to_string());
        draft.key_mode = "env".to_string();
        let state = store.0.save(draft, false, None).unwrap();
        assert_eq!(state.providers[0].key_mode, "env");
        assert_eq!(state.providers[0].key_tail, "$MY_API_KEY");
        let entry = store.models_json().get("providers").unwrap().get("acme").unwrap().clone();
        assert_eq!(entry.get("apiKey").unwrap(), "$MY_API_KEY");
    }

    #[test]
    fn import_marks_existing_entry() {
        let store = TestStore::new();
        fs::write(
            models_path(&store.0.agent_dir),
            serde_json::to_vec_pretty(&json!({
                "providers": {
                    "ollama": {
                        "baseUrl": "http://localhost:11434/v1",
                        "api": "openai-completions",
                        "apiKey": "ollama",
                        "models": [{ "id": "qwen2.5-coder:7b", "reasoning": false }]
                    },
                    "proxy-only": { "baseUrl": "https://proxy.example.com/v1" }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        // 内置覆盖形态不可导入。
        assert!(store.0.import("proxy-only").is_err());
        let state = store.0.import("ollama").unwrap();
        assert_eq!(state.providers.len(), 1);
        assert_eq!(state.providers[0].pi_provider_id, "ollama");
        assert_eq!(state.providers[0].model, "qwen2.5-coder:7b");
        let entry = store.models_json().get("providers").unwrap().get("ollama").unwrap().clone();
        assert_eq!(entry.get(PI_MANAGED_MARKER).unwrap(), &json!(state.providers[0].id));
        // 连接语义不变。
        assert_eq!(entry.get("apiKey").unwrap(), "ollama");
    }

    #[test]
    fn thinking_map_round_trips_with_null_levels() {
        let store = TestStore::new();
        let mut draft = input("Thinking");
        let mut levels = std::collections::BTreeMap::new();
        levels.insert("off".to_string(), None);
        levels.insert("max".to_string(), Some("Max".to_string()));
        draft.models = vec![PiModelConfig {
            reasoning: true,
            thinking_level_map: PiThinkingLevelMap { levels },
            ..model("thinker")
        }];
        draft.model = "thinker".to_string();
        store.0.save(draft, false, None).unwrap();
        let models = store.models_json()
            .get("providers").unwrap()
            .get("acme").unwrap()
            .get("models").unwrap()
            .clone();
        let map = models[0].get("thinkingLevelMap").unwrap();
        assert_eq!(map.get("off").unwrap(), &Value::Null);
        assert_eq!(map.get("max").unwrap(), "Max");
    }

    #[test]
    fn default_provider_lifecycle() {
        let store = TestStore::new();
        // 首个供应商自动设为默认。
        let first = store.0.save(input("Acme"), false, None).unwrap();
        let first_id = first.providers[0].id.clone();
        assert_eq!(first.active_provider_id.as_deref(), Some(first_id.as_str()));
        // 第二个供应商不自动激活。
        let mut second = input("Beta");
        second.pi_provider_id = "beta".to_string();
        let second_state = store.0.save(second, false, None).unwrap();
        let second_id = second_state.providers.iter().find(|p| p.pi_provider_id == "beta").unwrap().id.clone();
        assert_eq!(second_state.active_provider_id.as_deref(), Some(first_id.as_str()));
        // 设为默认 / 取消默认。
        let state = store.0.activate(&second_id).unwrap();
        assert_eq!(state.active_provider_id.as_deref(), Some(second_id.as_str()));
        let state = store.0.clear_default().unwrap();
        assert!(state.active_provider_id.is_none());
        // 取消默认后可删除。
        store.0.delete(&second_id).unwrap();
        // 默认供应商删除被拒绝。
        let state = store.0.activate(&first_id).unwrap();
        assert_eq!(state.active_provider_id.as_deref(), Some(first_id.as_str()));
        let error = store.0.delete(&first_id).unwrap_err();
        assert!(error.contains("请先取消默认"), "{error}");
        // 取消默认后即可删除。
        store.0.clear_default().unwrap();
        let state = store.0.delete(&first_id).unwrap();
        assert!(state.providers.is_empty());
        assert!(state.active_provider_id.is_none());
    }

    #[test]
    fn default_thinking_stays_app_side_and_feeds_launch_defaults() {
        let store = TestStore::new();
        let mut draft = input("Thinking");
        draft.models = vec![PiModelConfig {
            reasoning: true,
            default_thinking: Some("high".to_string()),
            ..model("thinker")
        }];
        draft.model = "thinker".to_string();
        let state = store.0.save(draft, false, None).unwrap();
        assert_eq!(state.providers[0].models[0].default_thinking.as_deref(), Some("high"));
        // 不写入 models.json（Pi schema 没有该字段）。
        let entry = store.models_json().get("providers").unwrap().get("acme").unwrap().clone();
        let model_json = entry.get("models").unwrap().as_array().unwrap()[0].clone();
        assert!(model_json.get("defaultThinking").is_none());
        // launch_defaults 输出默认供应商键名与模型默认思考级别。
        // 注意：launch_defaults 走 PathService，测试环境已注入临时目录。
        std::env::set_var("PI_CODING_AGENT_DIR", store.0.agent_dir.to_string_lossy().as_ref());
        let defaults = launch_defaults();
        assert_eq!(defaults.default_provider.as_deref(), Some("acme"));
        assert_eq!(
            defaults.default_thinking.get("acme").and_then(|m| m.get("thinker")).map(String::as_str),
            Some("high")
        );
        std::env::remove_var("PI_CODING_AGENT_DIR");
    }

    #[test]
    fn default_thinking_requires_reasoning_and_valid_level() {
        let store = TestStore::new();
        let mut draft = input("Bad");
        draft.models = vec![PiModelConfig {
            default_thinking: Some("high".to_string()),
            ..model("plain")
        }];
        draft.model = "plain".to_string();
        let error = store.0.save(draft, false, None).unwrap_err();
        assert!(error.contains("不能设置默认思考级别"), "{error}");

        let mut draft = input("BadLevel");
        draft.models = vec![PiModelConfig {
            reasoning: true,
            default_thinking: Some("ultra".to_string()),
            ..model("thinker")
        }];
        draft.model = "thinker".to_string();
        let error = store.0.save(draft, false, None).unwrap_err();
        assert!(error.contains("不受支持"), "{error}");
    }
}
