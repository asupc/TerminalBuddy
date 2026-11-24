//! 全平台大模型供应商服务：`llm_providers.json` CRUD、模型列表拉取、
//! 引用展开（`__TB_CLAUDE_REF__` → 临时 `--settings` 文件）、临时文件清理。
//!
//! 引用展开走临时 `--settings` 文件，不依赖用户级 `settings.json`；
//! 只有供应商显式设置了 `defaultModel` 时，保存后才会把用户级
//! `~/.claude/settings.json` 改写为该供应商 + 模型，供普通启动与历史会话恢复使用。

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::atomic_file::{atomic_write, atomic_write_private};
use super::crypto_service::{decrypt_secret_field, encrypt_secret_field};
use super::path_service::PathService;
use crate::models::llm_provider::{
    resolve_model_effort, LlmLaunchModel, LlmLaunchTarget, LlmProvider, LlmProviderFile,
    LlmProviderInput, LlmProviderView, CLAUDE_PROVIDER_REF_PREFIX, CLAUDE_REF_PREFIX,
    CLAUDE_TEMP_SETTINGS_PREFIX, EFFORT_LEVELS,
};
use crate::models::profile_validation::{quote_cmd_argument, reject_control_chars};

const PROVIDERS_FILE: &str = "llm_providers.json";
const TEMP_MAP_FILE: &str = "claude_temp_map.json";
/// 启动时清扫超过此时长的残留临时 settings。
const STALE_TEMP_SETTINGS_AGE: Duration = Duration::from_secs(24 * 3600);
/// 模型列表拉取：单个候选 URL 超时。
const FETCH_TIMEOUT_SECS: u64 = 15;

/// 供应商文件读改写互斥锁：并发 save 不丢更新，list 读到一致快照。
fn providers_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn lock_error() -> String {
    "供应商配置读写锁不可用，请重试".to_string()
}

fn providers_path() -> Result<PathBuf, String> {
    Ok(PathService::require_data_dir()?.join(PROVIDERS_FILE))
}

fn temp_map_path() -> Result<PathBuf, String> {
    Ok(PathService::require_data_dir()?.join(TEMP_MAP_FILE))
}

/// 内存映射：`terminalId → 临时 settings 路径`。落盘小表是持久备份，
/// 内存映射供关闭清理时免读盘。
fn temp_file_registry() -> &'static Mutex<HashMap<String, PathBuf>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_providers_file() -> Result<LlmProviderFile, String> {
    let path = providers_path()?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(LlmProviderFile::default()),
        Err(error) => return Err(format!("读取供应商配置失败：{}", error)),
    };
    if content.trim().is_empty() {
        return Ok(LlmProviderFile::default());
    }
    serde_json::from_str(&content)
        .map_err(|_| format!("供应商配置文件已损坏（{}），请修复或删除后重试", path.display()))
}

fn write_providers_file(file: &LlmProviderFile) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(file).map_err(|_| "无法编码供应商配置".to_string())?;
    atomic_write_private(&providers_path()?, &content)
        .map_err(|error| format!("写入供应商配置失败：{}", error))
}

fn sort_providers(providers: &mut [LlmProvider]) {
    providers.sort_by(|a, b| {
        a.sort_index
            .cmp(&b.sort_index)
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// 已保存密文 → 解密 Key。解密失败说明密钥材料损坏，显式报错不静默。
fn decrypted_key(provider: &LlmProvider) -> Result<String, String> {
    if provider.api_key.is_empty() {
        return Ok(String::new());
    }
    decrypt_secret_field(&provider.api_key).map_err(|_| {
        format!(
            "供应商「{}」的密钥无法解密，请重新录入密钥",
            provider.name
        )
    })
}

fn to_view(provider: &LlmProvider) -> Result<LlmProviderView, String> {
    let key = decrypted_key(provider)?;
    Ok(provider.to_view(&key))
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/// 列出全部供应商（脱敏视图），按 `sortIndex` 排序。
pub fn list_providers() -> Result<Vec<LlmProviderView>, String> {
    let _guard = providers_lock().lock().map_err(|_| lock_error())?;
    let mut file = read_providers_file()?;
    sort_providers(&mut file.providers);
    file.providers.iter().map(to_view).collect()
}

/// 新建 + 更新合一：`input.id` 为空是新建，否则按 id 更新。
/// 返回脱敏视图。 Key 留空沿用已保存密钥。
pub fn save_provider(input: LlmProviderInput) -> Result<LlmProviderView, String> {
    let _guard = providers_lock().lock().map_err(|_| lock_error())?;
    let mut file = read_providers_file()?;
    let is_update = !input.id.trim().is_empty();
    let previous_key = if is_update {
        let previous = file
            .providers
            .iter()
            .find(|provider| provider.id == input.id.trim())
            .ok_or_else(|| "供应商不存在，可能已被删除".to_string())?;
        Some(decrypted_key(previous)?)
    } else {
        None
    };
    let (mut provider, key) = input.validate(previous_key.as_deref())?;
    let now = Utc::now().to_rfc3339();
    if is_update {
        let id = provider.id.clone();
        let slot_index = file
            .providers
            .iter()
            .position(|provider| provider.id == id)
            .ok_or_else(|| "供应商不存在，可能已被删除".to_string())?;
        if file.providers[slot_index].created_at.is_empty() {
            provider.created_at = now.clone();
        } else {
            provider.created_at.clone_from(&file.providers[slot_index].created_at);
        }
        provider.updated_at.clone_from(&now);
        provider.api_key = encrypt_secret_field(&key)?;
        if provider.is_default {
            for other in file.providers.iter_mut() {
                other.is_default = other.id == id;
            }
        }
        // 默认模型是全局唯一的一份 Claude 默认配置，其他供应商的旧标记要清掉。
        if !provider.default_model.is_empty() {
            for other in file.providers.iter_mut() {
                if other.id != id {
                    other.default_model.clear();
                }
            }
        }
        file.providers[slot_index] = provider.clone();
    } else {
        provider.id = uuid::Uuid::new_v4().to_string();
        provider.created_at = now.clone();
        provider.updated_at = now;
        provider.api_key = encrypt_secret_field(&key)?;
        if provider.is_default || file.providers.is_empty() {
            for other in file.providers.iter_mut() {
                other.is_default = false;
            }
            provider.is_default = true;
        }
        if !provider.default_model.is_empty() {
            for other in file.providers.iter_mut() {
                other.default_model.clear();
            }
        }
        file.providers.push(provider.clone());
    }
    sort_providers(&mut file.providers);
    write_providers_file(&file)?;
    let view = to_view(&provider)?;
    let has_default_model = !provider.default_model.is_empty();
    // 写用户级 settings 要拿另一把锁，先释放供应商文件锁，避免锁顺序耦合。
    drop(_guard);
    if has_default_model {
        write_default_claude_settings(&provider, &key).map_err(|error| {
            format!("供应商已保存，但写入 Claude 默认配置失败：{}", error)
        })?;
    }
    Ok(view)
}

/// 删除供应商。删除默认供应商后允许没有默认（右键菜单不再平铺任何模型）。
/// 不阻止删除：引用该供应商的页签快照在启动/恢复时按失效分支提示。
pub fn delete_provider(id: &str) -> Result<Vec<LlmProviderView>, String> {
    let _guard = providers_lock().lock().map_err(|_| lock_error())?;
    let mut file = read_providers_file()?;
    let position = file
        .providers
        .iter()
        .position(|provider| provider.id == id)
        .ok_or_else(|| "供应商不存在，可能已被删除".to_string())?;
    file.providers.remove(position);
    sort_providers(&mut file.providers);
    write_providers_file(&file)?;
    file.providers.iter().map(to_view).collect()
}

pub fn set_default_provider(id: &str) -> Result<Vec<LlmProviderView>, String> {
    let _guard = providers_lock().lock().map_err(|_| lock_error())?;
    let mut file = read_providers_file()?;
    if !file.providers.iter().any(|provider| provider.id == id) {
        return Err("供应商不存在，可能已被删除".to_string());
    }
    let now = Utc::now().to_rfc3339();
    for provider in file.providers.iter_mut() {
        let is_default = provider.id == id;
        if provider.is_default != is_default {
            provider.is_default = is_default;
            provider.updated_at.clone_from(&now);
        }
    }
    sort_providers(&mut file.providers);
    write_providers_file(&file)?;
    file.providers.iter().map(to_view).collect()
}

/// 取消所有默认标记：允许没有默认供应商，此时右键菜单不平铺任何模型。
pub fn clear_default_provider() -> Result<Vec<LlmProviderView>, String> {
    let _guard = providers_lock().lock().map_err(|_| lock_error())?;
    let mut file = read_providers_file()?;
    let now = Utc::now().to_rfc3339();
    for provider in file.providers.iter_mut() {
        if provider.is_default {
            provider.is_default = false;
            provider.updated_at.clone_from(&now);
        }
    }
    write_providers_file(&file)?;
    file.providers.iter().map(to_view).collect()
}

/// 按 `ids` 顺序重排 `sortIndex`（0 起）。列表须与现有 id 集合完全一致。
pub fn update_provider_order(ids: &[String]) -> Result<Vec<LlmProviderView>, String> {
    let _guard = providers_lock().lock().map_err(|_| lock_error())?;
    let mut file = read_providers_file()?;
    if ids.len() != file.providers.len()
        || !ids.iter().all(|id| file.providers.iter().any(|provider| &provider.id == id))
    {
        return Err("排序列表与现有供应商不一致，请刷新后重试".to_string());
    }
    let now = Utc::now().to_rfc3339();
    for (index, id) in ids.iter().enumerate() {
        if let Some(provider) = file.providers.iter_mut().find(|provider| &provider.id == id) {
            provider.sort_index = index as i32;
            provider.updated_at.clone_from(&now);
        }
    }
    sort_providers(&mut file.providers);
    write_providers_file(&file)?;
    file.providers.iter().map(to_view).collect()
}

/// 右键菜单数据源：仅可用模型（`enabled`），不含 Key。
/// 按"默认优先、再 `sortIndex`"排序，`effort` 为解析后档位。
pub fn list_launch_targets() -> Result<Vec<LlmLaunchTarget>, String> {
    let _guard = providers_lock().lock().map_err(|_| lock_error())?;
    let mut file = read_providers_file()?;
    file.providers.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.sort_index.cmp(&b.sort_index))
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(file
        .providers
        .iter()
        .map(|provider| LlmLaunchTarget {
            provider_id: provider.id.clone(),
            provider_name: provider.name.clone(),
            is_default: provider.is_default,
            models: provider
                .enabled_models
                .iter()
                .filter(|model| model.enabled)
                .map(|model| LlmLaunchModel {
                    id: model.id.clone(),
                    effort: resolve_model_effort(model, &provider.default_effort_level),
                    context_window: model.context_window,
                })
                .collect(),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// 模型列表拉取
// ---------------------------------------------------------------------------

/// 拉取到的模型 id 列表（去重、trim、过滤空与控制字符）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
}

/// 候选 URL 策略（按序）：显式 `modelsUrl` ＞ `baseUrl` 本身以 `/v1` 结尾则
/// `{base}/models` ＞ `{base}/v1/models` ＞ `{base}/models` ＞ 剥离已知兼容后缀
/// 后重拼 `/v1/models` 与 `/models`。
pub fn candidate_models_urls(base_url: &str, models_url: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let push = |list: &mut Vec<String>, url: String| {
        if !url.is_empty() && !list.contains(&url) {
            list.push(url);
        }
    };
    let models_url = models_url.trim().trim_end_matches('/');
    if !models_url.is_empty() {
        push(&mut candidates, models_url.to_string());
    }
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return candidates;
    }
    if base.ends_with("/v1") {
        push(&mut candidates, format!("{}/models", base));
    }
    push(&mut candidates, format!("{}/v1/models", base.trim_end_matches("/v1")));
    push(&mut candidates, format!("{}/models", base.trim_end_matches("/v1")));
    const COMPAT_SUFFIXES: &[&str] = &["/api/anthropic", "/anthropic", "/claudecode", "/claude-code", "/api"];
    for suffix in COMPAT_SUFFIXES {
        if let Some(stripped) = base.strip_suffix(suffix) {
            let stripped = stripped.trim_end_matches('/');
            if stripped.is_empty() {
                continue;
            }
            push(&mut candidates, format!("{}/v1/models", stripped));
            push(&mut candidates, format!("{}/models", stripped));
        }
    }
    candidates
}

fn parse_models_payload(payload: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    let mut collect = |value: &Value| match value {
        Value::String(id) => ids.push(id.clone()),
        Value::Object(map) => {
            if let Some(id) = map.get("id").or_else(|| map.get("name")).and_then(Value::as_str) {
                ids.push(id.to_string());
            }
        }
        _ => {}
    };
    if let Some(list) = payload.get("data").or_else(|| payload.get("models")).and_then(Value::as_array) {
        for item in list {
            collect(item);
        }
    }
    let mut seen = std::collections::HashSet::new();
    ids.into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && !id.chars().any(char::is_control) && seen.insert(id.clone()))
        .collect()
}

fn sanitize_fetch_error(body: &str, api_key: &str) -> String {
    let mut text: String = body.chars().take(200).collect();
    if !api_key.is_empty() {
        text = text.replace(api_key, "***");
    }
    // 控制字符会污染日志与前端展示，压成空白。
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// 手动拉取供应商的模型列表（只读，不落盘）。`api_key` 为空且带 `provider_id`
/// 时用已保存的解密 Key。404/405 换下一个候选继续，其他状态直接返回错误。
pub async fn fetch_provider_models(
    base_url: &str,
    api_key: &str,
    models_url: &str,
    provider_id: Option<&str>,
) -> Result<Vec<FetchedModel>, String> {
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("请先填写 API 地址".to_string());
    }
    let mut key = api_key.trim().to_string();
    if key.is_empty() {
        if let Some(id) = provider_id.map(str::trim).filter(|id| !id.is_empty()) {
            let _guard = providers_lock().lock().map_err(|_| lock_error())?;
            let file = read_providers_file()?;
            let provider = file
                .providers
                .iter()
                .find(|provider| provider.id == id)
                .ok_or_else(|| "供应商不存在，可能已被删除".to_string())?;
            key = decrypted_key(provider)?;
        }
    }
    let candidates = candidate_models_urls(&base_url, models_url);
    if candidates.is_empty() {
        return Err("无法从 API 地址推导出模型列表端点".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("创建网络请求失败：{}", error))?;
    let mut last_error = String::from("所有候选端点均不可用");
    for url in &candidates {
        let mut request = client.get(url);
        if !key.is_empty() {
            let bearer = format!("Bearer {}", key);
            request = request.header("Authorization", bearer).header("x-api-key", &key);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = if error.is_timeout() {
                    format!("请求 {} 超时（{} 秒）", url, FETCH_TIMEOUT_SECS)
                } else {
                    format!("请求 {} 失败：{}", url, error)
                };
                continue;
            }
        };
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            last_error = format!("{} 返回 {}", url, status.as_u16());
            continue;
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "拉取模型列表失败（HTTP {}）：{}",
                status.as_u16(),
                sanitize_fetch_error(&body, &key)
            ));
        }
        let payload: Value = response
            .json()
            .await
            .map_err(|error| format!("模型列表响应不是有效 JSON：{}", error))?;
        let ids = parse_models_payload(&payload);
        return Ok(ids.into_iter().map(|id| FetchedModel { id }).collect());
    }
    Err(last_error)
}

// ---------------------------------------------------------------------------
// 引用展开：`__TB_CLAUDE_REF__:<providerId>:<modelId>` → 临时 `--settings`
// ---------------------------------------------------------------------------

/// 解析引用标记：返回 `(providerId, modelId, 引用 token 结束位置)`。
/// `modelId` 取首个空白分隔 token 的剩余部分（保存时已禁空白，无歧义）。
fn parse_claude_ref(command: &str) -> Option<(String, String, usize)> {
    let trimmed = command.trim_start();
    let rest = trimmed.strip_prefix(CLAUDE_REF_PREFIX)?;
    let token_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let token = &rest[..token_end];
    let (provider_id, model_id) = token.split_once(':')?;
    if provider_id.is_empty() || model_id.is_empty() {
        return None;
    }
    let token_start = trimmed.len() - rest.len() - CLAUDE_REF_PREFIX.len();
    Some((provider_id.to_string(), model_id.to_string(), token_start + CLAUDE_REF_PREFIX.len() + token.len()))
}

/// claude 按 `${ANTHROPIC_BASE_URL}/v1/messages` 拼接请求路径（实测 CLI 2.1.292），
/// 供应商地址若带 `/v1` 后缀（中转站常见粘贴形态）会被拼成 `/v1/v1/messages` 而 404。
/// 只改写进 env 的 API 根地址；`llm_providers.json` 保存用户原输入，
/// 模型列表拉取的候选 URL 策略对两种形态本就兼容。
fn api_root(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    trimmed.strip_suffix("/v1").unwrap_or(trimmed).to_string()
}

/// 生成临时 settings JSON。附带 TerminalBuddy hooks（`managed_hooks_object`）：
/// hook 随一次性文件下发，不再写入用户级 settings.json（旧版残留由桌面端启动时清理）。
/// 所有档位都写 `env.CLAUDE_CODE_EFFORT_LEVEL`：该 env 键优先级最高，用户级
/// settings.json 里残留的同名值会穿透临时文件未写的键，把所选档位压回去。
/// 同理，四档 `ANTHROPIC_DEFAULT_*_MODEL` 与 `CLAUDE_CODE_SUBAGENT_MODEL` 也全部
/// 写成所选模型：残留值会把 /model 档位切换、后台任务（Haiku）、子代理引到
/// 当前供应商上不存在的模型。
/// `level=max` 时不写 `effortLevel` / `modelSettings`（文件键仅收录到 xhigh）。
/// 上下文窗口两键互斥：配置了真实窗口写 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
/// （auto-compact 按真实值触发）；未配置写 `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_
/// WINDOW_ENFORCEMENT`，关闭 Claude Code 2.1.292+ 对未知模型按 200k 假设窗口的
/// 黄色告警（恢复旧行为）。
fn build_temp_settings(
    provider: &LlmProvider,
    decrypted_key: &str,
    model_id: &str,
    context_window: u32,
    max_output_tokens: u32,
    level: &str,
) -> Value {
    let mut env = serde_json::Map::new();
    env.insert("ANTHROPIC_BASE_URL".to_string(), json!(api_root(&provider.base_url)));
    env.insert(provider.auth_type.clone(), json!(decrypted_key));
    env.insert("ANTHROPIC_MODEL".to_string(), json!(model_id));
    // 档位映射与子代理模型全部锚定到所选模型：这些 env 键同样按 key 合并，
    // 用户级 settings.json 的残留值会穿透未写键（同 CLAUDE_CODE_EFFORT_LEVEL）。
    for key in [
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        env.insert(key.to_string(), json!(model_id));
    }
    if context_window > 0 {
        env.insert(
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(),
            json!(context_window.to_string()),
        );
    } else {
        // 未配置窗口：关闭 Claude Code 对未知模型的 200k 假设强制（官方出口），
        // 恢复旧行为并消除黄色告警。
        env.insert(
            "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT".to_string(),
            json!("1"),
        );
    }
    if max_output_tokens > 0 {
        env.insert(
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS".to_string(),
            json!(max_output_tokens.to_string()),
        );
    }
    env.insert("CLAUDE_CODE_EFFORT_LEVEL".to_string(), json!(level));
    let mut root = serde_json::Map::new();
    if level != "max" {
        root.insert("effortLevel".to_string(), json!(level));
        root.insert(
            "modelSettings".to_string(),
            json!({ model_id: { "effortLevel": level } }),
        );
    }
    root.insert("model".to_string(), json!(model_id));
    root.insert("env".to_string(), Value::Object(env));
    // TerminalBuddy hooks 随临时文件下发；各 settings 来源的 hooks 会合并执行，
    // 用户级残留已在启动时清理，避免同一事件触发两次。
    root.insert(
        "hooks".to_string(),
        super::claude_hook_settings::managed_hooks_object(),
    );
    Value::Object(root)
}

fn find_provider_for_ref(provider_id: &str) -> Result<(LlmProvider, String), String> {
    let _guard = providers_lock().lock().map_err(|_| lock_error())?;
    let file = read_providers_file()?;
    let provider = file
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| {
            "模型会话配置已失效：供应商已被删除，请从右键菜单重新选择模型启动".to_string()
        })?
        .clone();
    let key = decrypted_key(&provider)?;
    if key.is_empty() {
        return Err(format!(
            "供应商「{}」未配置密钥，请先补填密钥",
            provider.name
        ));
    }
    Ok((provider, key))
}

fn write_temp_settings(content: &Value) -> Result<PathBuf, String> {
    let bytes = serde_json::to_vec_pretty(content).map_err(|_| "无法编码临时模型配置".to_string())?;
    let path = std::env::temp_dir().join(format!(
        "{}{}.json",
        CLAUDE_TEMP_SETTINGS_PREFIX,
        uuid::Uuid::new_v4()
    ));
    atomic_write_private(&path, &bytes).map_err(|error| format!("写入临时模型配置失败：{}", error))?;
    Ok(path)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TempMapEntry {
    path: String,
    created_at: String,
}

fn read_temp_map() -> Result<BTreeMap<String, TempMapEntry>, String> {
    let path = temp_map_path()?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(format!("读取临时模型配置映射失败：{}", error)),
    };
    if content.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_str(&content).map_err(|_| {
        format!(
            "临时模型配置映射文件已损坏，请删除 {} 后重试",
            path.to_string_lossy()
        )
    })
}

fn write_temp_map(map: &BTreeMap<String, TempMapEntry>) -> Result<(), String> {
    let path = temp_map_path()?;
    let bytes = serde_json::to_vec_pretty(map).map_err(|_| "无法编码临时模型配置映射".to_string())?;
    // 落盘小表只增不改、无密钥；路径解析失败显式报错，绝不静默回退。
    atomic_write(&path, &bytes).map_err(|error| format!("写入临时模型配置映射失败：{}", error))
}

/// 某终端启动时的临时模型配置快照：只取状态栏需要的模型、上下文窗口与思考强度，
/// 不把含密钥的完整 settings 暴露给调用方。
#[derive(Clone, Debug, Default)]
pub struct TerminalLaunchConfig {
    pub model: Option<String>,
    pub context_window: Option<u64>,
    pub effort: Option<String>,
}

pub fn terminal_launch_config(terminal_id: &str) -> Option<TerminalLaunchConfig> {
    let path = read_temp_map().ok()?.get(terminal_id)?.path.clone();
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let env = value.get("env");
    let text = |key: &str| {
        env.and_then(|env| env.get(key)).and_then(|raw| {
            raw.as_str()
                .map(str::to_string)
                .or_else(|| raw.as_u64().map(|number| number.to_string()))
        })
    };
    Some(TerminalLaunchConfig {
        model: value.get("model").and_then(Value::as_str).map(str::to_string),
        context_window: text("CLAUDE_CODE_MAX_CONTEXT_TOKENS")
            .and_then(|window| window.trim().parse::<u64>().ok())
            .filter(|window| *window > 0),
        effort: text("CLAUDE_CODE_EFFORT_LEVEL")
            .or_else(|| value.get("effortLevel").and_then(Value::as_str).map(str::to_string)),
    })
}

fn temp_map_disk_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn register_temp_file(terminal_id: &str, path: &PathBuf) -> Result<(), String> {
    let _disk_guard = temp_map_disk_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read_temp_map()?;
    // 同一终端第二条 __TB_CLAUDE_REF__ 启动命令会覆盖映射；旧临时 settings
    // 含明文 key，必须同时删除，否则它会成为孤儿文件永久留在磁盘上。
    if let Some(previous) = map.insert(
        terminal_id.to_string(),
        TempMapEntry {
            path: path.to_string_lossy().to_string(),
            created_at: Utc::now().to_rfc3339(),
        },
    ) {
        if previous.path != path.to_string_lossy() {
            remove_temp_settings_file(&previous.path);
        }
    }
    write_temp_map(&map)?;
    // 落盘成功后才登记内存映射，失败时调用方负责删除临时文件。
    if let Ok(mut registry) = temp_file_registry().lock() {
        registry.insert(terminal_id.to_string(), path.clone());
    }
    Ok(())
}

/// 严格按「文件 + 前缀 + `.json` 后缀」删除，勿碰安装器目录。
fn remove_temp_settings_file(candidate: &str) {
    let path = PathBuf::from(candidate);
    if is_temp_settings_file(&path) {
        let _ = fs::remove_file(&path);
    }
}

/// 旧版临时 settings 路径兜底判定：命令里出现旧版绝对路径形态（含
/// `terminal-buddy-claude-settings-` 的 token）且对应文件已不存在 → 拒绝启动；
/// 文件尚存（如崩溃后、24h 清扫前）按普通命令原样放行。
fn legacy_temp_settings_missing(command: &str) -> bool {
    let mut saw_candidate = false;
    for token in command.split_whitespace() {
        let trimmed = token.trim_matches(|c| c == '"' || c == '\'');
        if !trimmed.contains(CLAUDE_TEMP_SETTINGS_PREFIX) {
            continue;
        }
        saw_candidate = true;
        if Path::new(trimmed).exists() {
            return false;
        }
    }
    saw_candidate
}

/// 构造写入用户级 `~/.claude/settings.json` 的补丁：以「供应商 + 默认模型」的
/// 临时配置为基底，去掉 Hook 段，并把可能与新供应商冲突的旧键显式置为 null
/// （`claude_settings_service::write_settings` 的深合并用 null 表示删除）。
fn build_default_settings_patch(
    provider: &LlmProvider,
    decrypted_key: &str,
) -> Result<Value, String> {
    let model = provider
        .enabled_models
        .iter()
        .find(|model| model.enabled && model.id == provider.default_model)
        .ok_or_else(|| {
            format!(
                "默认模型「{}」不在已启用的模型列表中，请重新选择",
                provider.default_model
            )
        })?;
    let level = resolve_model_effort(model, &provider.default_effort_level);
    if !EFFORT_LEVELS.contains(&level.as_str()) {
        return Err(format!(
            "供应商「{}」的推理等级配置无效，请重新保存",
            provider.name
        ));
    }
    let mut settings = build_temp_settings(
        provider,
        decrypted_key,
        &model.id,
        model.context_window,
        model.max_output_tokens,
        &level,
    );
    let object = settings
        .as_object_mut()
        .ok_or_else(|| "无法构造 Claude 默认配置".to_string())?;
    // Hook 归 Hook 安装器 / 设置页管理，不能随供应商覆盖。
    object.remove("hooks");
    // 旧版密钥助手会绕过 env 里的供应商凭据，必须清掉。
    for key in ["apiKeyHelper", "apiKey"] {
        object.insert(key.to_string(), Value::Null);
    }
    if level == "max" {
        // 与临时 settings 一致：max 只经 env 通道生效，文件里的旧档位要清掉。
        object.insert("effortLevel".to_string(), Value::Null);
        object.insert("modelSettings".to_string(), Value::Null);
    }
    let env = object
        .get_mut("env")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "无法构造 Claude 默认配置 env".to_string())?;
    // 另一种认证方式必须删除，避免两套凭据同时存在。
    let other_auth = if provider.auth_type == "ANTHROPIC_API_KEY" {
        "ANTHROPIC_AUTH_TOKEN"
    } else {
        "ANTHROPIC_API_KEY"
    };
    env.insert(other_auth.to_string(), Value::Null);
    env.insert("ANTHROPIC_SMALL_FAST_MODEL".to_string(), Value::Null);
    // 旧的档位显示名会继续出现在 /model 菜单里，与新供应商模型不符，一并清掉。
    for key in [
        "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
        "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    ] {
        env.insert(key.to_string(), Value::Null);
    }
    // 上下文窗口两键互斥，清理另一侧残留。
    if model.context_window > 0 {
        env.insert(
            "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT".to_string(),
            Value::Null,
        );
    } else {
        env.insert("CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(), Value::Null);
    }
    if model.max_output_tokens == 0 {
        env.insert("CLAUDE_CODE_MAX_OUTPUT_TOKENS".to_string(), Value::Null);
    }
    // 默认配置直接走第三方供应商，关掉云平台协议开关。
    for key in [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ] {
        env.insert(key.to_string(), json!("0"));
    }
    Ok(settings)
}

/// 把供应商 + 默认模型写入用户级 `~/.claude/settings.json`。
/// 普通 `claude` 启动（含双击恢复历史会话）会读取这份默认配置，
/// 因此不经过模型引用也能使用该供应商与模型。
fn write_default_claude_settings(
    provider: &LlmProvider,
    decrypted_key: &str,
) -> Result<(), String> {
    let patch = build_default_settings_patch(provider, decrypted_key)?;
    // 单测绝不能改写开发者本人的 ~/.claude/settings.json；补丁内容由
    // build_default_settings_patch 的用例覆盖。
    #[cfg(test)]
    {
        let _ = patch;
        Ok(())
    }
    #[cfg(not(test))]
    {
        super::claude_settings_service::write_settings(&patch).map(|_| ())
    }
}

/// 展开单条命令开头的引用标记并登记 `terminalId → 临时文件` 映射。
/// 不含引用的命令原样返回；引用失效（供应商被删）或旧路径残留则拒绝启动。
/// 原生会话复用供应商的模型、推理等级和上下文配置；不修改全局 Claude 设置。
pub(crate) fn native_session_settings(provider_id: &str, model_id: &str) -> Result<Value, String> {
    let (provider, key) = find_provider_for_ref(provider_id)?;
    let model = provider.enabled_models.iter().find(|model| model.enabled && model.id == model_id)
        .ok_or("模型已从供应商配置中移除，请刷新后重新选择")?;
    let effort = resolve_model_effort(model, &provider.default_effort_level);
    let mut settings = build_temp_settings(&provider, &key, model_id, model.context_window, model.max_output_tokens, &effort);
    // 此处只准备模型配置；原生会话登记独立 Hook 目标后，再注入桌面同款 HTTP Hook。
    if let Some(object) = settings.as_object_mut() { object.remove("hooks"); }
    Ok(settings)
}

/// Claude 订阅供应商引用：`__TB_CLAUDE_PROVIDER_REF__:<rawProviderId>[:<modelId>]`
/// → 临时 `--settings`（含 managed hooks）。供应商主键是 UUID，首个 `:` 无歧义；
/// 模型允许为空（Claude 供应商目录里存在空模型项）。临时文件按终端登记，
/// 终端 teardown 时统一清理。
fn expand_leading_claude_provider_ref(command: &str, terminal_id: &str) -> Result<String, String> {
    let trimmed = command.trim_start();
    let rest = trimmed
        .strip_prefix(CLAUDE_PROVIDER_REF_PREFIX)
        .ok_or_else(|| "Claude 供应商引用格式无效".to_string())?;
    let token_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let token = &rest[..token_end];
    let (provider_id, model_id) = match token.split_once(':') {
        Some((provider, model)) => (provider, model),
        None => (token, ""),
    };
    if provider_id.is_empty() || model_id.contains(':') {
        return Err("Claude 供应商引用格式无效，请重新选择模型".into());
    }
    reject_control_chars("Claude 供应商引用", token)?;
    let mut settings = super::claude_provider_service::native_session_settings(provider_id, model_id)?;
    // `native_session_settings` 只准备模型配置，HTTP Hook 必须在这里补，
    // 否则终端里的 CLI 不会上报绑定与阶段事件。
    if let Some(object) = settings.as_object_mut() {
        object.insert("hooks".to_string(), super::claude_hook_settings::managed_hooks_object());
    }
    let path = write_temp_settings(&settings)?;
    if let Err(error) = register_temp_file(terminal_id, &path) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    let quoted_path = quote_cmd_argument("临时模型配置", &path.to_string_lossy())?;
    let mut expanded = format!("claude --settings {}", quoted_path);
    if !model_id.is_empty() {
        let quoted_model = quote_cmd_argument("模型", model_id)?;
        expanded.push_str(&format!(" --model {}", quoted_model));
    }
    let suffix = rest[token_end..].trim_start();
    if !suffix.is_empty() {
        expanded.push(' ');
        expanded.push_str(suffix);
    }
    Ok(expanded)
}

pub fn expand_leading_claude_ref(command: &str, terminal_id: &str) -> Result<String, String> {
    if command.trim_start().starts_with(CLAUDE_PROVIDER_REF_PREFIX) {
        return expand_leading_claude_provider_ref(command, terminal_id);
    }
    if command.trim_start().starts_with(super::codex_provider_service::CODEX_REF_PREFIX) {
        return super::codex_provider_service::expand_leading_codex_ref(command);
    }
    let Some((provider_id, model_id, token_end)) = parse_claude_ref(command) else {
        // 旧路径兜底：含旧版绝对路径形态且文件已不存在 → 拒绝，不静默降级；
        // 文件尚存则按普通命令原样放行。
        if legacy_temp_settings_missing(command) {
            return Err("模型会话配置已过期，请从右键菜单重新选择模型启动".to_string());
        }
        return Ok(command.to_string());
    };
    reject_control_chars("模型引用", &format!("{}:{}", provider_id, model_id))?;
    let (provider, key) = find_provider_for_ref(&provider_id)?;
    // 只校验 providerId，不校验 modelId：供应商侧下线模型时 claude 启动后
    // 自然报错，错误信息比我们代报更准确。
    let configured = provider.enabled_models.iter().find(|model| model.id == model_id);
    let context_window = configured.map(|model| model.context_window).unwrap_or(0);
    let max_output_tokens = configured.map(|model| model.max_output_tokens).unwrap_or(0);
    let level = configured
        .map(|model| resolve_model_effort(model, &provider.default_effort_level))
        .unwrap_or_else(|| provider.default_effort_level.clone());
    if !EFFORT_LEVELS.contains(&level.as_str()) {
        return Err(format!("供应商「{}」的推理等级配置无效，请重新保存", provider.name));
    }
    let settings = build_temp_settings(&provider, &key, &model_id, context_window, max_output_tokens, &level);
    let path = write_temp_settings(&settings)?;
    if let Err(error) = register_temp_file(terminal_id, &path) {
        // 映射落盘失败：删掉刚生成的临时文件，避免展开成功但启动被拒后泄漏。
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    let quoted_path = quote_cmd_argument("临时模型配置", &path.to_string_lossy())?;
    let quoted_model = quote_cmd_argument("模型", &model_id)?;
    let suffix = command.trim_start()[token_end..].trim_start();
    let mut expanded = format!(
        "claude --settings {} --model {} --effort {}",
        quoted_path, quoted_model, level
    );
    if !suffix.is_empty() {
        expanded.push(' ');
        expanded.push_str(suffix);
    }
    Ok(expanded)
}

/// 对合成后的启动命令逐条展开（profile 路在 apply 后 / build 前调用）。
pub fn expand_claude_refs_in_commands(
    commands: Vec<String>,
    terminal_id: &str,
) -> Result<Vec<String>, String> {
    commands
        .into_iter()
        .map(|command| expand_leading_claude_ref(&command, terminal_id))
        .collect()
}

/// 本地 shell 类型：只有这些终端里的命令在本机执行，才能注入临时 `--settings`
/// 文件；ssh / docker / k8s 的命令在远端执行，本机路径与 HTTP Hook 都不可达。
pub fn is_local_shell_terminal(terminal_type: &str) -> bool {
    matches!(
        terminal_type,
        "powershell" | "pwsh" | "cmd" | "bash" | "sh" | "zsh"
    )
}

fn is_claude_program(token: &str) -> bool {
    let token = token.trim_matches(|c| c == '"' || c == '\'');
    let token = token.trim_end_matches(|c| c == '&' || c == ';' || c == '|');
    let token = token.trim_matches(|c| c == '"' || c == '\'');
    let name = token.rsplit(['/', '\\']).next().unwrap_or(token);
    matches!(name, "claude" | "claude.exe" | "claude.cmd" | "claude.bat")
}

/// 命令里「执行 claude」那个 token 的结束字节位置。
/// 只认命令起始位置（行首或 `&&` / `||` / `;` / `|` 之后）的 token，
/// 避免把 `echo "claude ..."` 里的参数误当成启动命令。
fn claude_command_end(command: &str) -> Option<usize> {
    let bytes = command.as_bytes();
    let mut index = 0;
    let mut at_command_start = true;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let token = &command[start..index];
        if at_command_start && is_claude_program(token) {
            return Some(index);
        }
        // 链式分隔符结尾的 token 开启下一条命令（如 `cd x &&`、`foo;`）。
        at_command_start = token.ends_with("&&")
            || token.ends_with("||")
            || token.ends_with(';')
            || token.ends_with('|');
    }
    None
}

fn has_settings_arg(command: &str) -> bool {
    command
        .split_whitespace()
        .any(|token| token == "--settings" || token.starts_with("--settings="))
}

fn temp_settings_registered(terminal_id: &str) -> bool {
    temp_file_registry()
        .lock()
        .map(|registry| registry.contains_key(terminal_id))
        .unwrap_or(false)
}

/// 给没有模型引用的本地 Claude 启动命令补一个只含 TerminalBuddy hooks 的
/// 一次性 `--settings` 文件。
///
/// 历史会话双击恢复、profile / Agent 基础命令启动都不经过引用展开，命令里
/// 没有 `--settings`，Claude Code 就收不到 Hook 桥接（任务状态、决策弹窗、
/// 完成/失败通知全部失效）。临时文件只写 `hooks` 键，其余配置仍按官方优先级
/// 从用户级 settings.json 继承；引用展开的命令已随临时配置下发 hooks，跳过。
pub fn inject_managed_hooks_in_commands(
    commands: Vec<String>,
    terminal_id: &str,
    terminal_type: &str,
) -> Result<Vec<String>, String> {
    if !is_local_shell_terminal(terminal_type) || temp_settings_registered(terminal_id) {
        return Ok(commands);
    }
    let mut injected = false;
    let mut output = Vec::with_capacity(commands.len());
    for command in commands {
        if injected || has_settings_arg(&command) {
            output.push(command);
            continue;
        }
        let Some(insert_at) = claude_command_end(&command) else {
            output.push(command);
            continue;
        };
        let settings = json!({ "hooks": super::claude_hook_settings::managed_hooks_object() });
        let path = write_temp_settings(&settings)?;
        let quoted = match quote_cmd_argument("临时 Hook 配置", &path.to_string_lossy()) {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
        };
        if let Err(error) = register_temp_file(terminal_id, &path) {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        let mut next = String::with_capacity(command.len() + quoted.len() + 12);
        next.push_str(&command[..insert_at]);
        next.push_str(" --settings ");
        next.push_str(&quoted);
        next.push_str(&command[insert_at..]);
        output.push(next);
        injected = true;
    }
    Ok(output)
}

/// 单条命令版本（空白终端入队前调用）。
pub fn inject_managed_hooks(
    command: String,
    terminal_id: &str,
    terminal_type: &str,
) -> Result<String, String> {
    let mut commands = inject_managed_hooks_in_commands(vec![command], terminal_id, terminal_type)?;
    Ok(commands.remove(0))
}

/// 删除指定终端的临时 settings 文件与映射条目（幂等，供关闭清理调用）。
/// 清理路径不阻断终端关闭，映射读写失败仅记录（文件删除仍尽力执行）。
pub fn cleanup_temp_settings_for_terminal(terminal_id: &str) {
    let candidates = {
        let _disk_guard = temp_map_disk_lock().lock().unwrap_or_else(|e| e.into_inner());
        let path = temp_file_registry()
            .lock()
            .ok()
            .and_then(|mut registry| registry.remove(terminal_id));
        let mut candidates: Vec<String> = path.map(|path| path.to_string_lossy().to_string()).into_iter().collect();
        match read_temp_map() {
            Ok(mut map) => {
                if let Some(entry) = map.remove(terminal_id) {
                    candidates.push(entry.path);
                }
                if let Err(error) = write_temp_map(&map) {
                    eprintln!("[TerminalBuddy] {}", error);
                }
            }
            Err(error) => eprintln!("[TerminalBuddy] {}", error),
        }
        candidates
    };
    for candidate in &candidates {
        remove_temp_settings_file(candidate);
    }
}

fn is_temp_settings_file(path: &PathBuf) -> bool {
    path.is_file()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(CLAUDE_TEMP_SETTINGS_PREFIX) && name.ends_with(".json"))
}

/// 启动时清扫残留：先按落盘小表精确删除后清空表，再兜底删除 `temp_dir()` 下
/// 超过 24h 的 `terminal-buddy-claude-settings-*.json` 文件。
pub fn cleanup_stale_temp_settings() {
    match read_temp_map() {
        Ok(map) => {
            if !map.is_empty() {
                for entry in map.values() {
                    remove_temp_settings_file(&entry.path);
                }
                if let Err(error) = write_temp_map(&BTreeMap::new()) {
                    eprintln!("[TerminalBuddy] {}", error);
                }
            }
        }
        Err(error) => eprintln!("[TerminalBuddy] {}", error),
    }
    let temp_dir = std::env::temp_dir();
    let entries = fs::read_dir(&temp_dir).into_iter().flatten().flatten();
    for entry in entries {
        let path = entry.path();
        if !is_temp_settings_file(&path) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > STALE_TEMP_SETTINGS_AGE);
        if stale {
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::llm_provider::LlmModelConfig;
    use crate::services::PathService;

    fn test_provider() -> LlmProvider {
        LlmProvider {
            id: "provider-1".to_string(),
            name: "测试供应商".to_string(),
            base_url: "https://ai.example.com/v1".to_string(),
            auth_type: "ANTHROPIC_AUTH_TOKEN".to_string(),
            api_key: String::new(),
            is_default: true,
            default_effort_level: "high".to_string(),
            default_model: String::new(),
            models_url: String::new(),
            enabled_models: vec![LlmModelConfig {
                id: "claude-opus-9".to_string(),
                enabled: true,
                context_window: 200000,
                effort_level: "xhigh".to_string(),
                max_output_tokens: 0,
            }],
            sort_index: 0,
            created_at: "2026-10-15T00:00:00Z".to_string(),
            updated_at: "2026-10-15T00:00:00Z".to_string(),
        }
    }

    fn with_test_data_dir(test: impl FnOnce()) {
        let directory = std::env::temp_dir().join(format!("llm-provider-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        PathService::set_test_data_dir(Some(directory.clone()));
        test();
        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn api_root_strips_trailing_v1_and_slashes() {
        assert_eq!(api_root("https://ai.example.com/v1"), "https://ai.example.com");
        assert_eq!(api_root("https://ai.example.com/v1/"), "https://ai.example.com");
        assert_eq!(api_root("https://ai.example.com"), "https://ai.example.com");
        assert_eq!(api_root("https://ai.example.com/anthropic"), "https://ai.example.com/anthropic");
        assert_eq!(api_root("https://ai.example.com/v1/v1"), "https://ai.example.com/v1");
    }

    #[test]
    fn temp_settings_inject_managed_hooks() {        let provider = test_provider();
        for level in ["low", "high", "xhigh", "max"] {
            let settings = build_temp_settings(&provider, "secret", "claude-opus-9", 200000, 0, level);
            // hooks 随临时文件下发（与 managed_hooks_object 完全一致），不再依赖用户级安装
            assert_eq!(
                settings["hooks"],
                crate::services::claude_hook_settings::managed_hooks_object(),
                "level={} hooks 注入不符",
                level
            );
            // env 写的是 API 根地址：claude 会自行拼 `${base}/v1/messages`
            assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], "https://ai.example.com");
            assert_eq!(settings["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
            assert_eq!(settings["model"], "claude-opus-9");
        }
    }

    #[test]
    fn temp_settings_max_level_uses_env_channel_only() {
        let provider = test_provider();
        let settings = build_temp_settings(&provider, "secret", "claude-opus-9", 200000, 0, "max");
        assert!(settings.get("effortLevel").is_none());
        assert!(settings.get("modelSettings").is_none());
        assert_eq!(settings["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "max");
        let settings = build_temp_settings(&provider, "secret", "claude-opus-9", 200000, 0, "xhigh");
        assert_eq!(settings["effortLevel"], "xhigh");
        assert_eq!(settings["modelSettings"]["claude-opus-9"]["effortLevel"], "xhigh");
        // 非 max 档也必须写 env 键，压制用户级 settings.json 残留的同名值
        assert_eq!(settings["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "xhigh");
    }

    #[test]
    fn temp_settings_context_window_env_pairing() {
        let provider = test_provider();
        // 未配置窗口：写兜底开关关闭未知模型窗口强制，不写窗口覆盖。
        let settings = build_temp_settings(&provider, "secret", "claude-opus-9", 0, 0, "high");
        assert!(settings["env"].get("CLAUDE_CODE_MAX_CONTEXT_TOKENS").is_none());
        assert_eq!(
            settings["env"]["CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"],
            "1"
        );
        // 配置了窗口：写真实窗口，不写兜底开关（两键互斥）。
        let settings = build_temp_settings(&provider, "secret", "claude-opus-9", 200000, 32000, "high");
        assert_eq!(settings["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "200000");
        assert!(settings["env"]
            .get("CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT")
            .is_none());
        assert_eq!(settings["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "32000");
    }

    #[test]
    fn temp_settings_uses_configured_auth_key() {
        let mut provider = test_provider();
        provider.auth_type = "ANTHROPIC_API_KEY".to_string();
        let settings = build_temp_settings(&provider, "secret", "claude-opus-9", 0, 0, "high");
        assert_eq!(settings["env"]["ANTHROPIC_API_KEY"], "secret");
        assert!(settings["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
    }

    #[test]
    fn temp_settings_pins_tier_and_subagent_models_to_selection() {
        let provider = test_provider();
        let settings = build_temp_settings(&provider, "secret", "glm-4.7", 0, 0, "high");
        // 档位映射与子代理全部锚定所选模型：残留的同名值会穿透未写键。
        for key in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
        ] {
            assert_eq!(settings["env"][key], "glm-4.7", "键 {} 未锚定所选模型", key);
        }
    }

    #[test]
    fn default_settings_patch_switches_provider_and_cleans_conflicts() {
        let mut provider = test_provider();
        provider.default_model = "claude-opus-9".to_string();
        let patch = build_default_settings_patch(&provider, "secret").unwrap();
        // Hooks 归安装器管理，不能随供应商写入用户级配置。
        assert!(patch.get("hooks").is_none());
        assert_eq!(patch["model"], "claude-opus-9");
        assert_eq!(patch["env"]["ANTHROPIC_BASE_URL"], "https://ai.example.com");
        assert_eq!(patch["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
        // 另一种认证方式与废弃模型键显式删除，避免旧供应商残留。
        assert_eq!(patch["env"]["ANTHROPIC_API_KEY"], Value::Null);
        assert_eq!(patch["env"]["ANTHROPIC_SMALL_FAST_MODEL"], Value::Null);
        assert_eq!(patch["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"], Value::Null);
        assert_eq!(patch["env"]["ANTHROPIC_MODEL"], "claude-opus-9");
        assert_eq!(patch["env"]["CLAUDE_CODE_USE_BEDROCK"], "0");
        // 模型档位 xhigh 与真实上下文窗口都写入默认配置。
        assert_eq!(patch["effortLevel"], "xhigh");
        assert_eq!(patch["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "200000");
        assert_eq!(
            patch["env"]["CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"],
            Value::Null
        );
        // 默认模型为空或不在启用列表时拒绝生成补丁。
        provider.default_model = String::new();
        assert!(build_default_settings_patch(&provider, "secret").is_err());
        provider.default_model = "missing".to_string();
        assert!(build_default_settings_patch(&provider, "secret").is_err());
    }

    #[test]
    fn default_settings_patch_max_level_clears_file_effort_fields() {
        let mut provider = test_provider();
        provider.default_model = "claude-opus-9".to_string();
        provider.enabled_models[0].effort_level = "max".to_string();
        let patch = build_default_settings_patch(&provider, "secret").unwrap();
        // max 只经 env 通道生效，旧的文件档位字段要删掉。
        assert_eq!(patch["effortLevel"], Value::Null);
        assert_eq!(patch["modelSettings"], Value::Null);
        assert_eq!(patch["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "max");
    }

    #[test]
    fn parse_claude_ref_extracts_ids_and_suffix() {
        let (provider_id, model_id, end) =
            parse_claude_ref("__TB_CLAUDE_REF__:p1:claude-opus-9 --resume abc").unwrap();
        assert_eq!(provider_id, "p1");
        assert_eq!(model_id, "claude-opus-9");
        assert_eq!("__TB_CLAUDE_REF__:p1:claude-opus-9 --resume abc"[end..].trim(), "--resume abc");
        // 前导空格容忍
        assert!(parse_claude_ref("  __TB_CLAUDE_REF__:p1:m1").is_some());
        // 非引用 / 残缺引用
        assert!(parse_claude_ref("claude --resume abc").is_none());
        assert!(parse_claude_ref("__TB_CLAUDE_REF__:only-one-part").is_none());
        assert!(parse_claude_ref("__TB_CLAUDE_REF__::m1").is_none());
    }

    #[test]
    fn candidate_urls_follow_defined_order() {
        // 显式 modelsUrl 优先
        let urls = candidate_models_urls("https://a.example/v1", "https://m.example/list");
        assert_eq!(urls[0], "https://m.example/list");
        // 本身以 /v1 结尾：{base}/models 第一候选
        let urls = candidate_models_urls("https://a.example/v1", "");
        assert_eq!(urls[0], "https://a.example/v1/models");
        assert!(urls.contains(&"https://a.example/v1/models".to_string()));
        // 普通 base：{base}/v1/models > {base}/models
        let urls = candidate_models_urls("https://a.example/openai", "");
        assert_eq!(urls[0], "https://a.example/openai/v1/models");
        assert_eq!(urls[1], "https://a.example/openai/models");
        // 兼容后缀剥离后重拼
        let urls = candidate_models_urls("https://a.example/api/anthropic", "");
        assert!(urls.contains(&"https://a.example/v1/models".to_string()));
        assert!(urls.contains(&"https://a.example/models".to_string()));
    }

    #[test]
    fn parse_models_payload_supports_both_shapes() {
        let openai = json!({ "data": [{ "id": "m1" }, "m2", { "name": "m3" }, "", "m1", "a\nb"] });
        assert_eq!(parse_models_payload(&openai), vec!["m1", "m2", "m3"]);
        let alt = json!({ "models": ["x1", { "id": "x2" }] });
        assert_eq!(parse_models_payload(&alt), vec!["x1", "x2"]);
        assert!(parse_models_payload(&json!({})).is_empty());
    }

    #[test]
    fn crud_default_succession_and_order() {
        with_test_data_dir(|| {
            let mut first = LlmProviderInput {
                id: String::new(),
                name: "首选".to_string(),
                base_url: "https://a.example/v1".to_string(),
                auth_type: "ANTHROPIC_AUTH_TOKEN".to_string(),
                api_key: Some("secret-a".to_string()),
                is_default: true,
                default_effort_level: "high".to_string(),
                default_model: String::new(),
                models_url: String::new(),
                enabled_models: vec![],
                sort_index: 0,
            };
            let saved_first = save_provider(first.clone()).unwrap();
            assert!(saved_first.is_default);
            assert_eq!(saved_first.key_tail, "et-a");
            first.name = "次选".to_string();
            first.base_url = "https://b.example/v1".to_string();
            first.api_key = Some("secret-b".to_string());
            first.is_default = false;
            first.sort_index = 1;
            let saved_second = save_provider(first).unwrap();
            assert!(!saved_second.is_default);
            // 落盘加密
            let raw = fs::read_to_string(providers_path().unwrap()).unwrap();
            assert!(!raw.contains("secret-a") && !raw.contains("secret-b"));
            // 删除默认 → 允许没有默认（右键菜单不平铺任何模型）
            let remaining = delete_provider(&saved_first.id).unwrap();
            assert_eq!(remaining.len(), 1);
            assert!(!remaining[0].is_default);
            // 显式取消默认同样允许空默认；再设默认恢复唯一标记
            set_default_provider(&saved_second.id).unwrap();
            let cleared = clear_default_provider().unwrap();
            assert!(cleared.iter().all(|provider| !provider.is_default));
            let restored = set_default_provider(&saved_second.id).unwrap();
            assert!(restored.iter().filter(|provider| provider.is_default).count() == 1);
        });
    }

    #[test]
    fn default_model_is_exclusive_across_providers() {
        with_test_data_dir(|| {
            let input = |name: &str, model: &str| LlmProviderInput {
                id: String::new(),
                name: name.to_string(),
                base_url: format!("https://{}.example/v1", name),
                auth_type: "ANTHROPIC_AUTH_TOKEN".to_string(),
                api_key: Some("secret".to_string()),
                is_default: false,
                default_effort_level: "high".to_string(),
                default_model: model.to_string(),
                models_url: String::new(),
                enabled_models: vec![LlmModelConfig {
                    id: model.to_string(),
                    enabled: true,
                    context_window: 0,
                    effort_level: String::new(),
                    max_output_tokens: 0,
                }],
                sort_index: 0,
            };
            let first = save_provider(input("a", "m1")).unwrap();
            assert_eq!(first.default_model, "m1");
            let second = save_provider(input("b", "m2")).unwrap();
            assert_eq!(second.default_model, "m2");
            let list = list_providers().unwrap();
            let first_after = list.iter().find(|provider| provider.id == first.id).unwrap();
            // 默认模型全局唯一：后设置者生效，旧标记随之清除。
            assert_eq!(first_after.default_model, "");
            // 脱敏视图同样携带 defaultModel（前端据此回填编辑弹窗）。
            assert!(serde_json::to_string(&list).unwrap().contains("defaultModel"));
        });
    }

    #[test]
    fn delete_last_provider_leaves_empty_list() {
        with_test_data_dir(|| {
            let saved = save_provider(LlmProviderInput {
                id: String::new(),
                name: "唯一".to_string(),
                base_url: "https://a.example/v1".to_string(),
                auth_type: "ANTHROPIC_AUTH_TOKEN".to_string(),
                api_key: Some("secret".to_string()),
                is_default: true,
                default_effort_level: "high".to_string(),
                default_model: String::new(),
                models_url: String::new(),
                enabled_models: vec![],
                sort_index: 0,
            })
            .unwrap();
            let remaining = delete_provider(&saved.id).unwrap();
            assert!(remaining.is_empty());
        });
    }

    #[test]
    fn launch_targets_only_enabled_models_with_resolved_effort() {
        with_test_data_dir(|| {
            save_provider(LlmProviderInput {
                id: String::new(),
                name: "站".to_string(),
                base_url: "https://a.example/v1".to_string(),
                auth_type: "ANTHROPIC_AUTH_TOKEN".to_string(),
                api_key: Some("secret".to_string()),
                is_default: true,
                default_effort_level: "high".to_string(),
                default_model: String::new(),
                models_url: String::new(),
                enabled_models: vec![
                    LlmModelConfig {
                        id: "m-on".to_string(),
                        enabled: true,
                        context_window: 100,
                        effort_level: String::new(),
                        max_output_tokens: 0,
                    },
                    LlmModelConfig {
                        id: "m-off".to_string(),
                        enabled: false,
                        context_window: 0,
                        effort_level: "max".to_string(),
                        max_output_tokens: 0,
                    },
                ],
                sort_index: 0,
            })
            .unwrap();
            let targets = list_launch_targets().unwrap();
            assert_eq!(targets.len(), 1);
            assert_eq!(targets[0].models.len(), 1);
            assert_eq!(targets[0].models[0].id, "m-on");
            assert_eq!(targets[0].models[0].effort, "high");
        });
    }

    #[test]
    fn expand_ref_generates_temp_settings_and_suffix_passthrough() {
        with_test_data_dir(|| {
            let saved = save_provider(LlmProviderInput {
                id: String::new(),
                name: "站".to_string(),
                base_url: "https://a.example/v1".to_string(),
                auth_type: "ANTHROPIC_AUTH_TOKEN".to_string(),
                api_key: Some("secret".to_string()),
                is_default: true,
                default_effort_level: "high".to_string(),
                default_model: String::new(),
                models_url: String::new(),
                enabled_models: vec![LlmModelConfig {
                    id: "m1".to_string(),
                    enabled: true,
                    context_window: 0,
                    effort_level: String::new(),
                    max_output_tokens: 0,
                }],
                sort_index: 0,
            })
            .unwrap();
            let command = format!("__TB_CLAUDE_REF__:{}:m1 --resume deadbeef", saved.id);
            let expanded = expand_leading_claude_ref(&command, "term-1").unwrap();
            assert!(expanded.starts_with("claude --settings "), "实际：{}", expanded);
            // 引号风格随平台（quote_cmd_argument）：Windows 双引号、POSIX 单引号。
            #[cfg(windows)]
            let expected_args = "--model m1 --effort high --resume deadbeef";
            #[cfg(not(windows))]
            let expected_args = "--model 'm1' --effort high --resume deadbeef";
            assert!(expanded.contains(expected_args), "实际：{}", expanded);
            // 临时文件真实存在且无 hooks
            let path: PathBuf = expanded
                .split_whitespace()
                .nth(2)
                .map(|token| token.trim_matches(|c| c == '"' || c == '\'').to_string())
                .map(PathBuf::from)
                .unwrap();
            let content: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            // hooks 随临时文件真实落盘
            assert!(content.pointer("/hooks/Stop/0/hooks/0/url").is_some());
            assert_eq!(content["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
            // 清理删除文件与映射
            cleanup_temp_settings_for_terminal("term-1");
            assert!(!path.exists());
            // 不含引用的命令原样返回
            assert_eq!(
                expand_leading_claude_ref("claude --resume x", "term-2").unwrap(),
                "claude --resume x"
            );
        });
    }

    #[test]
    fn expand_ref_rejects_deleted_provider() {
        with_test_data_dir(|| {
            let error = expand_leading_claude_ref("__TB_CLAUDE_REF__:missing:m1", "term-1").unwrap_err();
            assert!(error.contains("重新选择模型"), "实际：{}", error);
        });
    }

    #[test]
    fn legacy_path_rejected_only_when_file_missing() {
        with_test_data_dir(|| {
            // 旧版绝对路径形态的临时文件尚存 → 按普通命令原样放行
            let path = std::env::temp_dir().join(format!(
                "{}legacy-{}.json",
                CLAUDE_TEMP_SETTINGS_PREFIX,
                uuid::Uuid::new_v4()
            ));
            fs::write(&path, b"{}").unwrap();
            let command = format!(
                "claude --settings {} --model m1",
                quote_cmd_argument("临时模型配置", &path.to_string_lossy()).unwrap()
            );
            assert_eq!(
                expand_leading_claude_ref(&command, "term-1").unwrap(),
                command
            );
            // 文件已不存在 → 拒绝启动，提示重新选择
            fs::remove_file(&path).unwrap();
            let error = expand_leading_claude_ref(&command, "term-1").unwrap_err();
            assert!(error.contains("已过期"), "实际：{}", error);
            // 普通命令不含旧路径形态 → 原样放行
            assert_eq!(
                expand_leading_claude_ref("claude --resume x", "term-2").unwrap(),
                "claude --resume x"
            );
        });
    }

    #[test]
    fn claude_command_end_only_matches_command_position() {
        assert_eq!(claude_command_end("claude --resume abc"), Some(6));
        assert_eq!(claude_command_end("  claude.cmd --resume abc"), Some(12));
        assert_eq!(claude_command_end("cd /tmp && claude --resume abc"), Some(17));
        assert_eq!(claude_command_end("cd /tmp; claude --resume abc"), Some(15));
        // 引号包裹的非 claude 参数不应被当成启动命令
        assert_eq!(claude_command_end("echo \"claude --resume\""), None);
        assert_eq!(claude_command_end("git log --grep claude"), None);
        assert_eq!(claude_command_end("codex --resume abc"), None);
    }

    #[test]
    fn inject_hooks_only_for_local_claude_commands() {
        assert!(!is_local_shell_terminal("ssh"));
        assert!(is_local_shell_terminal("powershell"));
        with_test_data_dir(|| {
            // 远端命令原样返回
            let commands = inject_managed_hooks_in_commands(
                vec!["claude --resume abc".to_string()],
                "term-ssh",
                "ssh",
            )
            .unwrap();
            assert_eq!(commands, vec!["claude --resume abc".to_string()]);
            // 已带 --settings 的命令（引用展开结果）跳过
            let commands = inject_managed_hooks_in_commands(
                vec!["claude --settings /tmp/x.json --resume abc".to_string()],
                "term-ref",
                "powershell",
            )
            .unwrap();
            assert_eq!(commands, vec!["claude --settings /tmp/x.json --resume abc".to_string()]);
            // 本地恢复命令补上 hooks 临时文件
            let commands = inject_managed_hooks_in_commands(
                vec!["claude --dangerously-skip-permissions --resume abc".to_string()],
                "term-local",
                "powershell",
            )
            .unwrap();
            let command = &commands[0];
            assert!(command.starts_with("claude --settings "), "实际：{}", command);
            assert!(command.ends_with("--resume abc"), "实际：{}", command);
            let path = command
                .split_whitespace()
                .nth(2)
                .map(|token| token.trim_matches(|c| c == '"' || c == '\''))
                .map(PathBuf::from)
                .unwrap();
            let content: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(
                content["hooks"],
                crate::services::claude_hook_settings::managed_hooks_object()
            );
            // 同一终端第二次注入会复用已有临时文件，不叠加 --settings
            let commands = inject_managed_hooks_in_commands(
                vec!["claude --resume def".to_string()],
                "term-local",
                "powershell",
            )
            .unwrap();
            assert_eq!(commands, vec!["claude --resume def".to_string()]);
            cleanup_temp_settings_for_terminal("term-local");
        });
    }
}
