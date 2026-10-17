//! 全平台大模型供应商服务：`llm_providers.json` CRUD、模型列表拉取、
//! 引用展开（`__TB_CLAUDE_REF__` → 临时 `--settings` 文件）、临时文件清理。
//!
//! 与旧 Docker 链路（`claude_provider_service`）互不读写：旧链路写用户级
//! `settings.json` 做基线，本服务生成的 `--settings` 临时文件按官方优先级覆盖基线。

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
    LlmProviderInput, LlmProviderView, CLAUDE_REF_PREFIX, CLAUDE_TEMP_SETTINGS_PREFIX,
    EFFORT_LEVELS,
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
        let was_default = file.providers[slot_index].is_default;
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
        } else if was_default
            && !file.providers.iter().any(|other| other.id != id && other.is_default)
        {
            // 取消唯一的默认：保持至少一个默认（sortIndex 最小的接任）。
            provider.is_default = true;
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
        file.providers.push(provider.clone());
    }
    sort_providers(&mut file.providers);
    write_providers_file(&file)?;
    to_view(&provider)
}

/// 删除供应商。删除默认供应商时 `sortIndex` 最小的剩余供应商自动接任默认。
/// 不阻止删除：引用该供应商的页签快照在启动/恢复时按失效分支提示。
pub fn delete_provider(id: &str) -> Result<Vec<LlmProviderView>, String> {
    let _guard = providers_lock().lock().map_err(|_| lock_error())?;
    let mut file = read_providers_file()?;
    let position = file
        .providers
        .iter()
        .position(|provider| provider.id == id)
        .ok_or_else(|| "供应商不存在，可能已被删除".to_string())?;
    let was_default = file.providers[position].is_default;
    file.providers.remove(position);
    if was_default {
        if let Some(next) = file.providers.iter_mut().min_by_key(|provider| provider.sort_index) {
            next.is_default = true;
            next.updated_at = Utc::now().to_rfc3339();
        }
    }
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

/// 生成临时 settings JSON。**永不含 `hooks` 键**（用户级 hook 照常生效）。
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

fn register_temp_file(terminal_id: &str, path: &PathBuf) -> Result<(), String> {
    let mut map = read_temp_map()?;
    map.insert(
        terminal_id.to_string(),
        TempMapEntry {
            path: path.to_string_lossy().to_string(),
            created_at: Utc::now().to_rfc3339(),
        },
    );
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

/// 展开单条命令开头的引用标记并登记 `terminalId → 临时文件` 映射。
/// 不含引用的命令原样返回；引用失效（供应商被删）或旧路径残留则拒绝启动。
pub fn expand_leading_claude_ref(command: &str, terminal_id: &str) -> Result<String, String> {
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

/// 删除指定终端的临时 settings 文件与映射条目（幂等，供关闭清理调用）。
/// 清理路径不阻断终端关闭，映射读写失败仅记录（文件删除仍尽力执行）。
pub fn cleanup_temp_settings_for_terminal(terminal_id: &str) {
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
    fn temp_settings_never_contain_hooks() {        let provider = test_provider();
        for level in ["low", "high", "xhigh", "max"] {
            let settings = build_temp_settings(&provider, "secret", "claude-opus-9", 200000, 0, level);
            assert!(settings.get("hooks").is_none(), "level={} 不得含 hooks", level);
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
            // 删除默认 → sortIndex 最小的接任
            let remaining = delete_provider(&saved_first.id).unwrap();
            assert_eq!(remaining.len(), 1);
            assert!(remaining[0].is_default);
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
            assert!(expanded.contains("--model m1 --effort high --resume deadbeef"), "实际：{}", expanded);
            // 临时文件真实存在且无 hooks
            let path: PathBuf = expanded
                .split_whitespace()
                .nth(2)
                .map(|token| token.trim_matches('"').to_string())
                .map(PathBuf::from)
                .unwrap();
            let content: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert!(content.get("hooks").is_none());
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
}
