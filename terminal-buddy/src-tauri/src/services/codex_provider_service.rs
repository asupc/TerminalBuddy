//! 参考 CC Switch 的通用 Codex 直连配置：auth.json + config.toml。
//! 应用内供应商独立保存；启用时保留其他 TOML 设置，备份并事务式写回两个 live 文件。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use serde_json::{json, Value};
use toml_edit::{value, DocumentMut, Item, Table};

use super::atomic_file::atomic_write_private;
use super::crypto_service::{decrypt_secret_field, encrypt_secret_field};
use super::llm_provider_service::{self, FetchedModel};
use super::path_service::PathService;
use crate::models::codex_provider::{
    normalize_available_models, CodexProvider, CodexProviderFile, CodexProviderInput, CodexProviderState, CODEX_REASONING_EFFORTS,
};
use crate::models::llm_provider::validate_base_url;

const PROVIDER_ID: &str = "custom";
const BACKUP_DIR: &str = "terminal-buddy-backups";

fn config_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn lock_error() -> String {
    "Codex 供应商配置锁不可用，请重试".to_string()
}

fn resolve_config_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CODEX_HOME").filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        return if path.is_absolute() {
            Ok(path)
        } else {
            std::env::current_dir()
                .map(|dir| dir.join(path))
                .map_err(|error| format!("无法解析 CODEX_HOME：{}", error))
        };
    }
    dirs::home_dir()
        .map(|dir| dir.join(".codex"))
        .ok_or_else(|| "无法确定 Codex 配置目录".to_string())
}

struct ProviderStore {
    path: PathBuf,
    config_dir: PathBuf,
}

fn store() -> Result<ProviderStore, String> {
    Ok(ProviderStore {
        path: PathService::require_data_dir()?.join("codex_providers.json"),
        config_dir: resolve_config_dir()?,
    })
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取 {} 失败：{}", path.display(), error)),
    }
}

fn parse_config(bytes: &[u8]) -> Result<DocumentMut, String> {
    // 不把解析错误中的源码片段回传，TOML 里可能包含用户凭据。
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| {
            "Codex config.toml 不是有效的 UTF-8 TOML，请修复后重试；原文件未更改".to_string()
        })
}

fn key_for(provider: &CodexProvider) -> Result<String, String> {
    decrypt_secret_field(&provider.api_key)
        .map_err(|_| format!("供应商「{}」的密钥无法解密，请重新录入", provider.name))
}

/// 只替换通用供应商相关字段；MCP、项目权限、功能开关及其注释保留。
fn build_config(current: &[u8], provider: &CodexProvider, key: &str) -> Result<Vec<u8>, String> {
    let mut doc = parse_config(current)?;
    if doc
        .get("model_providers")
        .is_some_and(|item| !item.is_table())
    {
        return Err("Codex model_providers 必须是 TOML 表；原文件未更改".to_string());
    }
    doc["model_provider"] = value(PROVIDER_ID);
    doc["model"] = value(&provider.model);
    doc["disable_response_storage"] = value(provider.disable_response_storage);
    // 本流程把 Key 写进 auth.json，显式选择文件凭据存储以兼容原先使用 keyring 的配置。
    doc["cli_auth_credentials_store"] = value("file");
    if provider.reasoning_effort.is_empty() {
        doc.remove("model_reasoning_effort");
    } else {
        doc["model_reasoning_effort"] = value(&provider.reasoning_effort);
    }
    for (name, tokens) in [
        ("model_context_window", provider.context_window),
        (
            "model_auto_compact_token_limit",
            provider.auto_compact_token_limit,
        ),
    ] {
        if tokens == 0 {
            doc.remove(name);
        } else {
            doc[name] = value(i64::from(tokens));
        }
    }
    let mut table = Table::new();
    table["name"] = value(&provider.name);
    table["base_url"] = value(&provider.base_url);
    table["wire_api"] = value("responses");
    // 与 CC Switch 的 live/project/codex.rs 一致：新版自定义供应商通过表内
    // bearer token 认证；requires_openai_auth=false 避免无官方登录时卡在登录页。
    table["experimental_bearer_token"] = value(key);
    table["requires_openai_auth"] = value(false);
    if !doc.contains_key("model_providers") {
        doc["model_providers"] = Item::Table(Table::new());
    }
    // 替换该供应商的整张表，避免旧 env_key / auth 命令覆盖本次配置的密钥。
    doc["model_providers"][PROVIDER_ID] = Item::Table(table);
    Ok(doc.to_string().into_bytes())
}

/// 先收集完整旧值并备份；任一写入失败则恢复已写过的文件（包括原先不存在的文件）。
fn write_transaction(
    writes: &[(PathBuf, Vec<u8>)],
    backup_root: Option<&Path>,
    writer: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), String> {
    let previous = writes
        .iter()
        .map(|(path, _)| read_optional(path))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(root) = backup_root {
        let dir = root.join(format!(
            "{}-{}",
            Utc::now().format("%Y%m%d-%H%M%S"),
            uuid::Uuid::new_v4()
        ));
        for ((path, _), bytes) in writes.iter().zip(&previous) {
            if let Some(bytes) = bytes {
                let name = path
                    .file_name()
                    .ok_or_else(|| "备份文件名无效".to_string())?;
                atomic_write_private(&dir.join(name), bytes)
                    .map_err(|error| format!("备份 Codex 配置失败：{}", error))?;
            }
        }
    }
    for (index, (path, bytes)) in writes.iter().enumerate() {
        if let Err(error) = writer(path, bytes) {
            let mut rollback_errors = Vec::new();
            for ((old_path, _), old_bytes) in writes[..index].iter().zip(&previous) {
                let result = match old_bytes {
                    Some(bytes) => atomic_write_private(old_path, bytes),
                    None => fs::remove_file(old_path),
                };
                if let Err(error) = result {
                    rollback_errors.push(format!("{}：{}", old_path.display(), error));
                }
            }
            return Err(if rollback_errors.is_empty() {
                format!("写入 {} 失败，已恢复原配置：{}", path.display(), error)
            } else {
                format!(
                    "写入失败：{}；部分恢复失败，请从 {} 恢复：{}",
                    error,
                    backup_root
                        .unwrap_or_else(|| Path::new(BACKUP_DIR))
                        .display(),
                    rollback_errors.join("；")
                )
            });
        }
    }
    Ok(())
}

impl ProviderStore {
    fn read(&self) -> Result<CodexProviderFile, String> {
        let Some(bytes) = read_optional(&self.path)? else {
            return Ok(CodexProviderFile::default());
        };
        serde_json::from_slice(&bytes)
            .map_err(|_| "Codex 供应商数据已损坏，请修复 codex_providers.json 后重试".to_string())
    }

    fn read_live(&self) -> Result<Option<(CodexProviderInput, String)>, String> {
        let Some(bytes) = read_optional(&self.config_dir.join("config.toml"))? else {
            return Ok(None);
        };
        let doc = parse_config(&bytes)?;
        let provider_id = doc
            .get("model_provider")
            .and_then(Item::as_str)
            .unwrap_or("openai");
        let table = doc
            .get("model_providers")
            .and_then(|providers| providers.get(provider_id));
        if table.is_some_and(|table| {
            ["env_key", "auth", "aws"]
                .iter()
                .any(|name| table.get(name).is_some())
        }) {
            // 这些凭据通道优先于静态 API Key，不冒充已经导入或启用了它们。
            return Ok(None);
        }
        let base_url = table
            .and_then(|table| table.get("base_url"))
            .and_then(Item::as_str)
            .or_else(|| {
                (provider_id == "openai").then(|| {
                    doc.get("openai_base_url")
                        .and_then(Item::as_str)
                        .unwrap_or("https://api.openai.com/v1")
                })
            });
        let Some(base_url) = base_url else {
            return Ok(None);
        };
        if table
            .and_then(|table| table.get("wire_api"))
            .and_then(Item::as_str)
            .is_some_and(|api| api != "responses")
        {
            return Ok(None);
        }
        let auth: Value = match read_optional(&self.config_dir.join("auth.json"))? {
            Some(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "Codex auth.json 不是有效 JSON，请修复后重试".to_string())?,
            None => json!({}),
        };
        // 与 CC Switch 一样兼容已有 bearer token 形态；不导入 ChatGPT 登录票据。
        let key = table
            .and_then(|table| table.get("experimental_bearer_token"))
            .and_then(Item::as_str)
            .or_else(|| auth.get("OPENAI_API_KEY").and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string();
        if key.is_empty() {
            return Ok(None);
        }
        let number = |name| {
            doc.get(name)
                .and_then(Item::as_integer)
                .and_then(|v| u32::try_from(v).ok())
                .unwrap_or(0)
        };
        Ok(Some((
            CodexProviderInput {
                id: String::new(),
                name: table
                    .and_then(|table| table.get("name"))
                    .and_then(Item::as_str)
                    .unwrap_or("当前 Codex 配置")
                    .to_string(),
                base_url: base_url.to_string(),
                api_key: Some(key.clone()),
                model: doc
                    .get("model")
                    .and_then(Item::as_str)
                    .unwrap_or("")
                    .to_string(),
                models: Vec::new(),
                available_models: None,
                reasoning_effort: doc
                    .get("model_reasoning_effort")
                    .and_then(Item::as_str)
                    .unwrap_or("")
                    .to_string(),
                context_window: number("model_context_window"),
                auto_compact_token_limit: number("model_auto_compact_token_limit"),
                disable_response_storage: doc
                    .get("disable_response_storage")
                    .and_then(Item::as_bool)
                    .unwrap_or(false),
            },
            key,
        )))
    }

    fn active_id(&self, file: &CodexProviderFile) -> Result<Option<String>, String> {
        let Some((live, key)) = self.read_live()? else {
            return Ok(None);
        };
        let matches = |provider: &&CodexProvider| -> bool {
            provider.base_url.trim_end_matches('/') == live.base_url.trim_end_matches('/')
                && provider.model == live.model
                && provider.reasoning_effort == live.reasoning_effort
                && provider.context_window == live.context_window
                && provider.auto_compact_token_limit == live.auto_compact_token_limit
                && provider.disable_response_storage == live.disable_response_storage
                && key_for(provider).is_ok_and(|saved| saved == key)
        };
        // 同样配置可以另存多张卡，优先识别上次由本应用启用的那张。
        let preferred = file
            .providers
            .iter()
            .find(|provider| Some(&provider.id) == file.current_provider_id.as_ref())
            .filter(matches);
        Ok(preferred
            .or_else(|| file.providers.iter().find(matches))
            .map(|p| p.id.clone()))
    }

    fn view(&self, file: &CodexProviderFile) -> Result<CodexProviderState, String> {
        let (active_provider_id, config_error) = match self.active_id(file) {
            Ok(id) => (id, None),
            Err(error) => (None, Some(error)),
        };
        let providers = file
            .providers
            .iter()
            .map(|p| Ok(p.to_view(&key_for(p)?)))
            .collect::<Result<Vec<_>, String>>()?;
        Ok(CodexProviderState {
            providers,
            active_provider_id,
            config_dir: self.config_dir.to_string_lossy().to_string(),
            config_error,
        })
    }

    fn commit(&self, file: &CodexProviderFile, live: Option<&CodexProvider>) -> Result<(), String> {
        let bytes =
            serde_json::to_vec_pretty(file).map_err(|_| "编码 Codex 供应商失败".to_string())?;
        let mut writes = Vec::new();
        if let Some(provider) = live {
            let path = self.config_dir.join("config.toml");
            let current = read_optional(&path)?.unwrap_or_default();
            let key = key_for(provider)?;
            writes.push((path, build_config(&current, provider, &key)?));
            // 保留 auth.json 的通用 API Key 形态，兼容仍从该文件取 Key 的旧版客户端。
            let auth = serde_json::to_vec_pretty(&json!({"OPENAI_API_KEY": key}))
                .map_err(|_| "编码 Codex 凭据失败".to_string())?;
            writes.push((self.config_dir.join("auth.json"), auth));
        }
        writes.push((self.path.clone(), bytes));
        let root = self.config_dir.join(BACKUP_DIR);
        write_transaction(&writes, live.map(|_| root.as_path()), atomic_write_private)
    }

    fn save(
        &self,
        input: CodexProviderInput,
        activate: bool,
    ) -> Result<CodexProviderState, String> {
        let mut file = self.read()?;
        let previous = if input.id.trim().is_empty() {
            None
        } else {
            Some(
                file.providers
                    .iter()
                    .find(|p| p.id == input.id.trim())
                    .ok_or_else(|| "Codex 供应商不存在，可能已被删除".to_string())?,
            )
        };
        let replacing_key = input
            .api_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty());
        let previous_key = if replacing_key {
            None
        } else {
            previous.map(key_for).transpose()?
        };
        let should_activate = activate
            || file.providers.is_empty()
            || previous
                .is_some_and(|p| self.active_id(&file).ok().flatten().as_deref() == Some(&p.id));
        let keep_available_models = input.available_models.is_none();
        let (mut provider, key) = input.validate(previous_key.as_deref())?;
        if keep_available_models {
            if let Some(previous) = previous.filter(|p| {
                p.base_url.trim_end_matches('/') == provider.base_url.trim_end_matches('/')
                    && key_for(p).is_ok_and(|saved| saved == key)
            }) {
                provider.available_models = previous.available_models.clone();
            }
        }
        provider.created_at = previous
            .map(|p| p.created_at.clone())
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        provider.updated_at = Utc::now().to_rfc3339();
        provider.api_key = encrypt_secret_field(&key)?;
        if provider.id.is_empty() {
            provider.id = uuid::Uuid::new_v4().to_string();
        }
        if let Some(slot) = file.providers.iter_mut().find(|p| p.id == provider.id) {
            *slot = provider.clone();
        } else {
            file.providers.push(provider.clone());
        }
        if should_activate {
            file.current_provider_id = Some(provider.id.clone());
        }
        self.commit(&file, should_activate.then_some(&provider))?;
        self.view(&file)
    }

    /// 只更新与本次请求相同地址和密钥的供应商，避免在途请求覆盖已修改的配置。
    fn cache_models(&self, id: &str, base_url: &str, key: &str, models: Vec<String>) -> Result<(), String> {
        let mut file = self.read()?;
        let Some(provider) = file.providers.iter_mut().find(|p| p.id == id) else {
            return Ok(());
        };
        if provider.base_url.trim_end_matches('/') != base_url.trim_end_matches('/')
            || key_for(provider)? != key {
            return Ok(());
        }
        provider.available_models = normalize_available_models(models)?;
        provider.updated_at = Utc::now().to_rfc3339();
        // 更新列表不改写或重新启用 Codex 的当前配置。
        self.commit(&file, None)
    }

    /// 注册独立供应商；CLI 参数选择本次会话的供应商，不切换全局默认及登录凭据。
    fn prepare_launch(&self, provider_id: &str, model_id: &str) -> Result<String, String> {
        let model = crate::models::profile_validation::quote_cmd_argument("Codex 模型", model_id)?;
        let file = self.read()?;
        let provider = file.providers.iter().find(|p| p.id == provider_id)
            .ok_or_else(|| "Codex 供应商已被删除，请重新选择模型启动".to_string())?;
        if !provider.model_ids().iter().any(|id| id == model_id) {
            return Err("Codex 模型已从供应商配置中移除，请重新选择模型启动".to_string());
        }
        if !CODEX_REASONING_EFFORTS.contains(&provider.reasoning_effort.as_str()) {
            return Err("Codex 推理等级无效，请重新保存供应商配置".to_string());
        }
        let id = uuid::Uuid::parse_str(&provider.id)
            .map_err(|_| "Codex 供应商 ID 无效，请重新添加".to_string())?;
        let launch_id = format!("terminal_buddy_{}", id.simple());
        let path = self.config_dir.join("config.toml");
        let current = read_optional(&path)?.unwrap_or_default();
        let mut doc = parse_config(&current)?;
        if doc.get("model_providers").is_some_and(|item| !item.is_table()) {
            return Err("Codex model_providers 必须是 TOML 表；原文件未更改".to_string());
        }
        if !doc.contains_key("model_providers") {
            doc["model_providers"] = Item::Table(Table::new());
        }
        let selected = parse_config(&build_config(b"", provider, &key_for(provider)?)?)?;
        doc["model_providers"][&launch_id] = selected["model_providers"][PROVIDER_ID].clone();
        let updated = doc.to_string().into_bytes();
        if updated != current {
            write_transaction(&[(path, updated)], Some(&self.config_dir.join(BACKUP_DIR)), atomic_write_private)?;
        }
        // -c 在新旧版 Codex 中均支持；不混用新版独立 profile 文件与旧版 profiles 表。
        // 参数只含非敏感配置，API 密钥始终留在受限权限的配置文件中。
        let mut command = format!("codex -c model_provider={} --model {}", launch_id, model);
        if !provider.reasoning_effort.is_empty() {
            command.push_str(&format!(" -c model_reasoning_effort={}", provider.reasoning_effort));
        }
        command.push_str(&format!(" -c disable_response_storage={}", provider.disable_response_storage));
        for (name, tokens) in [("model_context_window", provider.context_window),
            ("model_auto_compact_token_limit", provider.auto_compact_token_limit)] {
            if tokens > 0 { command.push_str(&format!(" -c {}={}", name, tokens)); }
        }
        Ok(command)
    }

    fn activate(&self, id: &str) -> Result<CodexProviderState, String> {
        let mut file = self.read()?;
        let provider = file
            .providers
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| "Codex 供应商不存在，可能已被删除".to_string())?;
        file.current_provider_id = Some(id.to_string());
        self.commit(&file, Some(provider))?;
        self.view(&file)
    }

    fn delete(&self, id: &str) -> Result<CodexProviderState, String> {
        let mut file = self.read()?;
        if self.active_id(&file)?.as_deref() == Some(id) {
            return Err("请先启用其他供应商，再删除当前启用的供应商".to_string());
        }
        let index = file
            .providers
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| "Codex 供应商不存在，可能已被删除".to_string())?;
        file.providers.remove(index);
        if file.current_provider_id.as_deref() == Some(id) {
            file.current_provider_id = None;
        }
        // 删除快速启动注册的供应商表，避免已删除供应商的密钥留在当前配置中。
        let path = self.config_dir.join("config.toml");
        let mut config = read_optional(&path)?.map(|bytes| parse_config(&bytes)).transpose()?;
        let removed = uuid::Uuid::parse_str(id).ok().is_some_and(|uuid| {
            config.as_mut().and_then(|doc| doc.get_mut("model_providers"))
                .and_then(Item::as_table_mut)
                .and_then(|table| table.remove(&format!("terminal_buddy_{}", uuid.simple())))
                .is_some()
        });
        if removed {
            let bytes = serde_json::to_vec_pretty(&file).map_err(|_| "编码 Codex 供应商失败".to_string())?;
            write_transaction(&[(path, config.unwrap().to_string().into_bytes()), (self.path.clone(), bytes)],
                Some(&self.config_dir.join(BACKUP_DIR)), atomic_write_private)?;
        } else {
            self.commit(&file, None)?;
        }
        self.view(&file)
    }

    fn import(&self) -> Result<CodexProviderState, String> {
        let (input, _) = self.read_live()?.ok_or_else(|| {
            "当前没有可导入的 Codex 通用 API 配置；需要 Responses 端点、模型和 API 密钥".to_string()
        })?;
        let (mut provider, key) = input.validate(None)?;
        let mut file = self.read()?;
        if self.active_id(&file)?.is_some() {
            return Err("当前 Codex 配置已存在于供应商列表中".to_string());
        }
        provider.id = uuid::Uuid::new_v4().to_string();
        provider.created_at = Utc::now().to_rfc3339();
        provider.updated_at = provider.created_at.clone();
        provider.api_key = encrypt_secret_field(&key)?;
        file.current_provider_id = Some(provider.id.clone());
        file.providers.push(provider);
        // 导入只保存应用数据，绝不改写已有 Codex 配置。
        self.commit(&file, None)?;
        self.view(&file)
    }
}

pub const CODEX_REF_PREFIX: &str = "__TB_CODEX_REF__:";

/// 启动记录仅保存供应商/模型引用，密钥不会出现在命令或终端日志中。
pub fn expand_leading_codex_ref(command: &str) -> Result<String, String> {
    let trimmed = command.trim_start();
    let Some(rest) = trimmed.strip_prefix(CODEX_REF_PREFIX) else { return Ok(command.to_string()); };
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let (provider_id, model_id) = rest[..end].split_once(':')
        .filter(|(p, m)| !p.is_empty() && !m.is_empty())
        .ok_or_else(|| "Codex 模型引用无效，请重新选择模型启动".to_string())?;
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    let mut expanded = store()?.prepare_launch(provider_id, model_id)?;
    let suffix = rest[end..].trim_start();
    if !suffix.is_empty() { expanded.push(' '); expanded.push_str(suffix); }
    Ok(expanded)
}

pub fn get_provider_state() -> Result<CodexProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    let store = store()?;
    store.view(&store.read()?)
}

pub fn save_provider(
    input: CodexProviderInput,
    activate: bool,
) -> Result<CodexProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    store()?.save(input, activate)
}

pub fn activate_provider(id: &str) -> Result<CodexProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    store()?.activate(id)
}

pub fn delete_provider(id: &str) -> Result<CodexProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    store()?.delete(id)
}

pub fn import_provider() -> Result<CodexProviderState, String> {
    let _guard = config_lock().lock().map_err(|_| lock_error())?;
    store()?.import()
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
    .map_err(|error| format!("读取 Codex 密钥失败：{}", error))??;
    let fetched = llm_provider_service::fetch_provider_models(&base_url, &key, "", None).await?;
    let ids = normalize_available_models(fetched.into_iter().map(|model| model.id).collect())?;
    if let Some(id) = provider_id.filter(|id| !id.is_empty()) {
        let models = ids.clone();
        crate::runtime::async_runtime::spawn_blocking(move || {
            let _guard = config_lock().lock().map_err(|_| lock_error())?;
            store()?.cache_models(&id, &base_url, &key, models)
        }).await.map_err(|error| format!("保存 Codex 模型列表失败：{}", error))??;
    }
    Ok(ids.into_iter().map(|id| FetchedModel { id }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct TestStore(ProviderStore);

    impl TestStore {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("codex-provider-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            PathService::set_test_data_dir(Some(root.clone()));
            Self(ProviderStore {
                path: root.join("codex_providers.json"),
                config_dir: root.join("codex"),
            })
        }

        fn config(&self) -> Vec<u8> {
            fs::read(self.0.config_dir.join("config.toml")).unwrap()
        }

        fn auth(&self) -> Vec<u8> {
            fs::read(self.0.config_dir.join("auth.json")).unwrap()
        }
    }

    impl Drop for TestStore {
        fn drop(&mut self) {
            PathService::set_test_data_dir(None);
            let _ = fs::remove_dir_all(self.0.path.parent().unwrap());
        }
    }

    fn input(name: &str) -> CodexProviderInput {
        CodexProviderInput {
            id: String::new(),
            name: name.to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            api_key: Some("sk-codex-test-secret-1234".to_string()),
            model: "test-model".to_string(),
            models: Vec::new(),
            available_models: None,
            reasoning_effort: "high".to_string(),
            context_window: 0,
            auto_compact_token_limit: 0,
            disable_response_storage: true,
        }
    }

    #[test]
    fn multiple_models_are_normalized_and_legacy_files_still_work() {
        let store = TestStore::new();
        let mut draft = input("多模型");
        draft.models = vec![" second-model ".into(), "test-model".into(), "second-model".into()];
        let state = store.0.save(draft, false).unwrap();
        assert_eq!(state.providers[0].models, vec!["test-model", "second-model"]);
        let mut old: Value = serde_json::from_slice(&fs::read(&store.0.path).unwrap()).unwrap();
        old["providers"][0].as_object_mut().unwrap().remove("models");
        atomic_write_private(&store.0.path, &serde_json::to_vec(&old).unwrap()).unwrap();
        let state = store.0.view(&store.0.read().unwrap()).unwrap();
        assert_eq!(state.providers[0].models, vec!["test-model"]);
        let mut invalid = input("无效模型");
        invalid.models = vec!["bad model".into()];
        assert!(invalid.validate(None).is_err());
    }

    #[test]
    fn available_catalog_is_persisted_separately_from_launch_models() {
        let store = TestStore::new();
        let mut draft = input("保存模型列表");
        // 列表允许超过已配置模型的 200 个限制，且不会自动加入启动菜单。
        let catalog: Vec<String> = (0..250).map(|i| format!("model-{}", i)).collect();
        draft.available_models = Some(catalog.clone());
        let state = store.0.save(draft, false).unwrap();
        assert_eq!(state.providers[0].available_models, catalog);
        assert_eq!(state.providers[0].models, vec!["test-model"]);
        let reopened = store.0.view(&store.0.read().unwrap()).unwrap();
        assert_eq!(reopened.providers[0].available_models, catalog);
        let mut legacy: Value = serde_json::from_slice(&fs::read(&store.0.path).unwrap()).unwrap();
        legacy["providers"][0].as_object_mut().unwrap().remove("availableModels");
        atomic_write_private(&store.0.path, &serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(store.0.view(&store.0.read().unwrap()).unwrap().providers[0].available_models.is_empty());
        let mut invalid = input("无效列表");
        invalid.available_models = Some(vec!["bad model".into()]);
        assert!(invalid.validate(None).is_err());
    }

    #[test]
    fn updating_catalog_keeps_live_config_and_ignores_outdated_requests() {
        let store = TestStore::new();
        let state = store.0.save(input("更新模型列表"), false).unwrap();
        let id = &state.providers[0].id;
        let config = store.config();
        let auth = store.auth();
        let url = "https://api.example.com/v1/";
        let key = "sk-codex-test-secret-1234";
        store.0.cache_models(id, url, key, vec![" model-a ".into(), "model-a".into(), "model-b".into()]).unwrap();
        let reopened = store.0.view(&store.0.read().unwrap()).unwrap();
        assert_eq!(reopened.providers[0].available_models, vec!["model-a", "model-b"]);
        assert_eq!(reopened.providers[0].models, vec!["test-model"]);
        assert_eq!(reopened.active_provider_id, state.active_provider_id);
        assert_eq!(store.config(), config);
        assert_eq!(store.auth(), auth);
        let data = fs::read(&store.0.path).unwrap();
        for (request_id, request_url, request_key) in [
            (id.as_str(), "https://other.example/v1", key),
            (id.as_str(), url, "different-key"),
            ("deleted-provider", url, key),
        ] {
            store.0.cache_models(request_id, request_url, request_key, vec!["stale-model".into()]).unwrap();
            assert_eq!(fs::read(&store.0.path).unwrap(), data);
        }
        store.0.cache_models(id, url, key, Vec::new()).unwrap();
        assert!(store.0.view(&store.0.read().unwrap()).unwrap().providers[0].available_models.is_empty());
    }

    #[test]
    fn saving_legacy_input_preserves_catalog_until_credentials_change_or_explicit_clear() {
        let store = TestStore::new();
        let mut draft = input("兼容旧客户端");
        draft.available_models = Some(vec!["model-a".into()]);
        let state = store.0.save(draft, false).unwrap();
        let mut legacy = input("修改名称");
        legacy.id = state.providers[0].id.clone();
        legacy.api_key = None;
        let state = store.0.save(legacy.clone(), false).unwrap();
        assert_eq!(state.providers[0].available_models, vec!["model-a"]);
        let mut other_url = legacy.clone();
        other_url.base_url = "https://other.example/v1".into();
        assert!(store.0.save(other_url, false).unwrap().providers[0].available_models.is_empty());
        legacy.available_models = Some(vec!["model-b".into()]);
        store.0.save(legacy.clone(), false).unwrap();
        legacy.available_models = Some(Vec::new());
        assert!(store.0.save(legacy.clone(), false).unwrap().providers[0].available_models.is_empty());
        legacy.available_models = Some(vec!["model-c".into()]);
        store.0.save(legacy.clone(), false).unwrap();
        legacy.available_models = None;
        legacy.api_key = Some("sk-replaced-key".into());
        assert!(store.0.save(legacy, false).unwrap().providers[0].available_models.is_empty());
    }

    #[test]
    fn model_launch_keeps_global_default_auth_and_other_profiles() {
        let store = TestStore::new();
        let first = store.0.save(input("默认供应商"), false).unwrap();
        let mut draft = input("另一个供应商");
        draft.base_url = "https://other.example/v1".into();
        draft.api_key = Some("sk-other-provider-secret".into());
        draft.models = vec!["second-model".into()];
        draft.context_window = 128000;
        let second = store.0.save(draft, false).unwrap();
        let id = &second.providers[1].id;
        let auth = store.auth();
        let data = fs::read(&store.0.path).unwrap();
        let mut doc = parse_config(&store.config()).unwrap();
        doc["profiles"] = Item::Table(Table::new());
        doc["profiles"]["user_profile"] = Item::Table(Table::new());
        doc["profiles"]["user_profile"]["model"] = value("user-model");
        atomic_write_private(&store.0.config_dir.join("config.toml"), doc.to_string().as_bytes()).unwrap();
        let command = store.0.prepare_launch(id, "second-model").unwrap();
        assert!(command.starts_with("codex -c model_provider=terminal_buddy_"));
        assert!(command.contains("second-model"));
        assert!(command.contains("model_context_window=128000"));
        assert!(!command.contains("secret"));
        assert!(!command.contains("https://"));
        let current = parse_config(&store.config()).unwrap();
        assert_eq!(current["model"].as_str(), Some("test-model"));
        assert_eq!(current["profiles"]["user_profile"]["model"].as_str(), Some("user-model"));
        assert_eq!(store.auth(), auth);
        assert_eq!(fs::read(&store.0.path).unwrap(), data);
        assert_eq!(store.0.view(&store.0.read().unwrap()).unwrap().active_provider_id, first.active_provider_id);
        let launch_id = format!("terminal_buddy_{}", uuid::Uuid::parse_str(id).unwrap().simple());
        assert_eq!(current["model_providers"][&launch_id]["base_url"].as_str(), Some("https://other.example/v1"));
        assert_eq!(current["model_providers"][&launch_id]["experimental_bearer_token"].as_str(), Some("sk-other-provider-secret"));
        let before = store.config();
        assert_eq!(store.0.prepare_launch(id, "second-model").unwrap(), command);
        assert_eq!(store.config(), before);
        store.0.prepare_launch(&first.providers[0].id, "test-model").unwrap();
        let current = parse_config(&store.config()).unwrap();
        assert!(current["model_providers"].get(&launch_id).is_some());
        assert_eq!(store.auth(), auth);
        store.0.delete(id).unwrap();
        let current = parse_config(&store.config()).unwrap();
        assert!(current["model_providers"].get(&launch_id).is_none());
        assert!(!String::from_utf8(store.config()).unwrap().contains("sk-other-provider-secret"));
    }

    #[test]
    fn missing_provider_or_removed_model_never_changes_launch_config() {
        let store = TestStore::new();
        let state = store.0.save(input("供应商"), false).unwrap();
        let before = store.config();
        assert!(store.0.prepare_launch("missing", "test-model").is_err());
        assert!(store.0.prepare_launch(&state.providers[0].id, "removed-model").is_err());
        assert_eq!(store.config(), before);
        let mut file = store.0.read().unwrap();
        file.providers[0].reasoning_effort = "high && invalid-command".into();
        store.0.commit(&file, None).unwrap();
        assert!(store.0.prepare_launch(&state.providers[0].id, "test-model").is_err());
        assert_eq!(store.config(), before);
        assert!(expand_leading_codex_ref("__TB_CODEX_REF__:bad").is_err());
        assert_eq!(expand_leading_codex_ref("codex --resume").unwrap(), "codex --resume");
    }

    #[test]
    fn first_save_activates_and_only_returns_masked_keys() {
        let store = TestStore::new();
        let view = store.0.save(input("测试供应商"), false).unwrap();
        assert_eq!(
            view.active_provider_id.as_deref(),
            Some(view.providers[0].id.as_str())
        );
        assert_eq!(view.providers[0].key_tail, "1234");
        let disk = fs::read_to_string(&store.0.path).unwrap();
        assert!(!disk.contains("sk-codex-test-secret"));
        assert!(!serde_json::to_string(&view)
            .unwrap()
            .contains("sk-codex-test-secret"));
        let auth: Value = serde_json::from_slice(&store.auth()).unwrap();
        assert_eq!(auth["OPENAI_API_KEY"], "sk-codex-test-secret-1234");
        let doc = parse_config(&store.config()).unwrap();
        assert_eq!(
            doc["model_providers"]["custom"]["experimental_bearer_token"].as_str(),
            Some("sk-codex-test-secret-1234")
        );
        assert_eq!(
            doc["model_providers"]["custom"]["requires_openai_auth"].as_bool(),
            Some(false)
        );
        assert!(store.0.config_dir.join("config.toml").exists());
    }

    #[test]
    fn switching_preserves_other_settings_comments_and_backs_up_both_files() {
        let store = TestStore::new();
        let config = b"# user comment\nmodel_provider = 'old'\nmodel = 'old-model'\nmodel_context_window = 999\nmodel_auto_compact_token_limit = 900\n[features]\ncustom_flag = true # retained\n[mcp_servers.demo]\ncommand = 'demo'\n[model_providers.old]\nbase_url = 'https://old.example/v1'\n[model_providers.custom]\nenv_key = 'OLD_KEY'\n";
        let auth = br#"{"tokens":{"access_token":"keep-in-backup"},"last_refresh":"now"}"#;
        atomic_write_private(&store.0.config_dir.join("config.toml"), config).unwrap();
        atomic_write_private(&store.0.config_dir.join("auth.json"), auth).unwrap();
        store.0.save(input("新供应商"), true).unwrap();
        let content = String::from_utf8(store.config()).unwrap();
        let doc = parse_config(content.as_bytes()).unwrap();
        assert_eq!(doc["mcp_servers"]["demo"]["command"].as_str(), Some("demo"));
        assert!(content.contains("# user comment"));
        assert!(content.contains("# retained"));
        assert_eq!(
            doc["model_providers"]["old"]["base_url"].as_str(),
            Some("https://old.example/v1")
        );
        assert!(doc["model_providers"]["custom"].get("env_key").is_none());
        assert!(doc.get("model_context_window").is_none());
        assert!(doc.get("model_auto_compact_token_limit").is_none());
        assert_eq!(
            doc["model_providers"]["custom"]["wire_api"].as_str(),
            Some("responses")
        );
        assert_eq!(doc["cli_auth_credentials_store"].as_str(), Some("file"));
        let backup = fs::read_dir(store.0.config_dir.join(BACKUP_DIR))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(backup.join("config.toml")).unwrap(), config);
        assert_eq!(fs::read(backup.join("auth.json")).unwrap(), auth);
        assert!(!String::from_utf8(store.auth())
            .unwrap()
            .contains("keep-in-backup"));
    }

    #[test]
    fn saving_inactive_provider_does_not_touch_live_and_editing_active_keeps_key() {
        let store = TestStore::new();
        let first = store.0.save(input("一"), false).unwrap();
        let before = (store.config(), store.auth());
        let state = store.0.save(input("二"), false).unwrap();
        assert_eq!(state.active_provider_id, first.active_provider_id);
        assert_eq!((store.config(), store.auth()), before);
        let mut edit = input("一（修改）");
        edit.id = first.providers[0].id.clone();
        edit.api_key = None;
        edit.model = "new-model".to_string();
        let state = store.0.save(edit, false).unwrap();
        assert_eq!(state.providers[0].model, "new-model");
        assert_eq!(state.providers[0].key_tail, "1234");
        assert_eq!(
            parse_config(&store.config()).unwrap()["model"].as_str(),
            Some("new-model")
        );
    }

    #[test]
    fn invalid_live_toml_never_changes_auth_or_app_data() {
        let store = TestStore::new();
        let broken = b"model = [ invalid-secret\n";
        atomic_write_private(&store.0.config_dir.join("config.toml"), broken).unwrap();
        atomic_write_private(&store.0.config_dir.join("auth.json"), b"original-auth").unwrap();
        let error = store.0.save(input("测试"), true).unwrap_err();
        assert!(!error.contains("invalid-secret"));
        assert_eq!(store.config(), broken);
        assert_eq!(store.auth(), b"original-auth");
        assert!(!store.0.path.exists());
    }

    #[test]
    fn import_is_non_destructive_and_rejects_duplicates() {
        let store = TestStore::new();
        let (provider, key) = input("现有供应商").validate(None).unwrap();
        let config = build_config(b"# existing\n", &provider, &key).unwrap();
        let auth = serde_json::to_vec(&json!({"OPENAI_API_KEY": key})).unwrap();
        atomic_write_private(&store.0.config_dir.join("config.toml"), &config).unwrap();
        atomic_write_private(&store.0.config_dir.join("auth.json"), &auth).unwrap();
        let state = store.0.import().unwrap();
        assert_eq!(state.providers[0].name, "现有供应商");
        assert!(state.active_provider_id.is_some());
        assert_eq!(store.config(), config);
        assert_eq!(store.auth(), auth);
        assert!(store.0.import().is_err());
        assert_eq!(store.0.read().unwrap().providers.len(), 1);
    }

    #[test]
    fn external_changes_clear_active_status_and_active_cannot_be_deleted() {
        let store = TestStore::new();
        let state = store.0.save(input("测试"), false).unwrap();
        let id = &state.providers[0].id;
        assert!(store.0.delete(id).is_err());
        let mut doc = parse_config(&store.config()).unwrap();
        doc["model"] = value("externally-changed-model");
        atomic_write_private(
            &store.0.config_dir.join("config.toml"),
            doc.to_string().as_bytes(),
        )
        .unwrap();
        assert!(store
            .0
            .view(&store.0.read().unwrap())
            .unwrap()
            .active_provider_id
            .is_none());
        let before = store.config();
        assert!(store.0.delete(id).unwrap().providers.is_empty());
        assert_eq!(store.config(), before);
    }

    #[test]
    fn explicit_activation_writes_saved_provider_and_default_fields_can_be_cleared() {
        let store = TestStore::new();
        store.0.save(input("一"), false).unwrap();
        let mut second = input("二");
        second.reasoning_effort.clear();
        second.context_window = 1_000_000;
        second.auto_compact_token_limit = 900_000;
        second.disable_response_storage = false;
        let state = store.0.save(second, false).unwrap();
        let id = &state.providers[1].id;
        assert_eq!(
            store.0.activate(id).unwrap().active_provider_id.as_ref(),
            Some(id)
        );
        let doc = parse_config(&store.config()).unwrap();
        assert!(doc.get("model_reasoning_effort").is_none());
        assert_eq!(doc["model_context_window"].as_integer(), Some(1_000_000));
        assert_eq!(
            doc["model_auto_compact_token_limit"].as_integer(),
            Some(900_000)
        );
        assert_eq!(doc["disable_response_storage"].as_bool(), Some(false));
    }

    #[test]
    fn failed_transaction_restores_existing_and_removes_new_files() {
        let store = TestStore::new();
        let existing = store.0.config_dir.join("config.toml");
        let new_auth = store.0.config_dir.join("auth.json");
        atomic_write_private(&existing, b"original").unwrap();
        let calls = Cell::new(0);
        let writes = vec![
            (existing.clone(), b"changed".to_vec()),
            (new_auth.clone(), b"new".to_vec()),
            (store.0.path.clone(), b"state".to_vec()),
        ];
        let result = write_transaction(
            &writes,
            Some(&store.0.config_dir.join(BACKUP_DIR)),
            |path, bytes| {
                calls.set(calls.get() + 1);
                if calls.get() == 3 {
                    return Err(std::io::Error::other("simulated disk failure"));
                }
                atomic_write_private(path, bytes)
            },
        );
        assert!(result.unwrap_err().contains("已恢复原配置"));
        assert_eq!(fs::read(existing).unwrap(), b"original");
        assert!(!new_auth.exists());
        assert!(!store.0.path.exists());
    }

    #[test]
    fn validation_covers_urls_keys_models_and_context_limits() {
        for url in [
            "file:///tmp/api",
            "https://user:pass@example.com/v1",
            "https://example.com/v1?key=secret",
        ] {
            let mut draft = input("测试");
            draft.base_url = url.to_string();
            assert!(draft.validate(None).is_err());
        }
        let mut draft = input("测试");
        draft.api_key = None;
        assert!(draft.clone().validate(None).is_err());
        assert!(draft.validate(Some("existing-key")).is_ok());
        let mut draft = input("测试");
        draft.model = "invalid model".to_string();
        assert!(draft.validate(None).is_err());
        let mut draft = input("测试");
        draft.api_key = Some("key\nvalue".to_string());
        assert!(draft.validate(None).is_err());
        let mut draft = input("测试");
        draft.context_window = 100;
        draft.auto_compact_token_limit = 101;
        assert!(draft.validate(None).is_err());
        let mut draft = input("测试");
        draft.reasoning_effort = "unknown".to_string();
        assert!(draft.validate(None).is_err());
        let (provider, _) = input("测试").validate(None).unwrap();
        assert!(provider.to_view("1234").key_tail.is_empty());
    }

    #[test]
    fn chatgpt_login_without_api_key_cannot_be_imported() {
        let store = TestStore::new();
        atomic_write_private(
            &store.0.config_dir.join("config.toml"),
            b"model = 'test-model'\n",
        )
        .unwrap();
        atomic_write_private(
            &store.0.config_dir.join("auth.json"),
            br#"{"tokens":{"access_token":"chatgpt-token"}}"#,
        )
        .unwrap();
        assert!(store.0.import().is_err());
        assert!(!store.0.path.exists());
    }

    #[test]
    fn bearer_only_config_can_be_imported_without_changing_auth() {
        let store = TestStore::new();
        let (provider, key) = input("CC Switch 供应商").validate(None).unwrap();
        let config = build_config(b"", &provider, &key).unwrap();
        atomic_write_private(&store.0.config_dir.join("config.toml"), &config).unwrap();
        let state = store.0.import().unwrap();
        assert!(state.active_provider_id.is_some());
        assert_eq!(state.providers[0].key_tail, "1234");
        assert_eq!(store.config(), config);
        assert!(!store.0.config_dir.join("auth.json").exists());
    }
}
