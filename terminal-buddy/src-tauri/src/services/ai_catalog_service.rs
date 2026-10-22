//! 手机首页使用的供应商目录，以及原生会话的供应商启动配置。
use crate::models::ai_chat::{AiCatalog, AiModelOption, AiProviderOption};
use super::{atomic_file::atomic_write_private, claude_provider_service, codex_provider_service, llm_provider_service};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

type Result<T> = std::result::Result<T, String>;

pub fn catalog() -> Result<AiCatalog> {
    let mut providers: Vec<_> = llm_provider_service::list_launch_targets()?.into_iter().map(|target| AiProviderOption {
        id: format!("llm:{}", target.provider_id), agent: "claude".into(), name: target.provider_name,
        is_default: target.is_default,
        models: target.models.into_iter().map(|model| AiModelOption { label: model.id.clone(), id: model.id, effort: model.effort }).collect(),
    }).collect();
    providers.extend(claude_provider_service::native_launch_targets()?);
    let codex = codex_provider_service::get_provider_state()?;
    for provider in codex.providers {
        let mut models = provider.models;
        if models.is_empty() && !provider.model.is_empty() { models.push(provider.model.clone()); }
        providers.push(AiProviderOption {
            id: format!("codex:{}", provider.id), agent: "codex".into(), name: provider.name,
            is_default: codex.active_provider_id.as_deref() == Some(provider.id.as_str()),
            models: models.into_iter().map(|id| AiModelOption {
                label: id.clone(), effort: provider.model_reasoning_efforts.get(&id).cloned().unwrap_or_default(), id,
            }).collect(),
        });
    }
    providers.sort_by_key(|provider| !provider.is_default);
    for agent in ["claude", "codex"] {
        providers.push(AiProviderOption { id: format!("default:{agent}"), agent: agent.into(), name: "服务端默认配置".into(),
            is_default: false, models: vec![AiModelOption { id: String::new(), label: "服务端默认模型".into(), effort: String::new() }] });
    }
    Ok(AiCatalog { providers })
}

/// 创建时固化选择；已删除供应商或移除模型必须提示重新选择，不能回退到其他供应商。
pub fn selection(agent: &str, id: Option<&str>, model: Option<&str>) -> Result<Option<(String, String)>> {
    let Some(id) = id else { return Ok(None); }; // 兼容旧版客户端的默认 CLI 配置。
    let target = catalog()?.providers.into_iter().find(|target| target.agent == agent && target.id == id)
        .ok_or("所选供应商已不存在，请刷新后重新选择")?;
    if !target.models.iter().any(|candidate| candidate.id == model.unwrap_or_default()) {
        return Err("所选模型已被移除或停用，请刷新后重新选择".into());
    }
    Ok(Some((target.id, target.name)))
}

pub struct NativeLaunch {
    pub args: Vec<String>,
    pub context_window: Option<u64>,
    settings: Option<PathBuf>,
}
impl Drop for NativeLaunch {
    fn drop(&mut self) { if let Some(path) = &self.settings { let _ = fs::remove_file(path); } }
}

pub fn prepare(agent: &str, provider_id: Option<&str>, model: Option<&str>) -> Result<NativeLaunch> {
    let Some(id) = provider_id else { return Ok(NativeLaunch { args: Vec::new(), context_window: inherited_context_window(agent), settings: None }); };
    if id == format!("default:{agent}") { return Ok(NativeLaunch { args: Vec::new(), context_window: inherited_context_window(agent), settings: None }); }
    let (source, id) = id.split_once(':').ok_or("供应商配置无效，请重新选择")?;
    if source == "codex" && agent == "codex" {
        let args = codex_provider_service::native_session_args(id, model.unwrap_or_default())?;
        let context_window = args.iter().find_map(|arg| arg.strip_prefix("model_context_window=")?.parse::<u64>().ok()).filter(|n| *n > 0);
        return Ok(NativeLaunch { args, context_window, settings: None });
    }
    let mut settings = match (source, agent) {
        ("llm", "claude") => llm_provider_service::native_session_settings(id, model.unwrap_or_default())?,
        ("claude", "claude") => claude_provider_service::native_session_settings(id, model.unwrap_or_default())?,
        _ => return Err("供应商与当前 AI 类型不匹配，请重新选择".into()),
    };
    // 所选 HTTP 供应商覆盖其他配置来源中的认证方式及云平台开关。
    if let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) {
        let auth = if env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str).is_some_and(|key| !key.is_empty()) {
            "ANTHROPIC_API_KEY"
        } else { "ANTHROPIC_AUTH_TOKEN" };
        env.insert(auth.into(), json!(""));
        for key in ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] { env.insert(key.into(), json!("0")); }
    }
    let context_window = settings.pointer("/env/CLAUDE_CODE_MAX_CONTEXT_TOKENS")
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok())).filter(|n| *n > 0)
        .or_else(|| inherited_context_window(agent));
    let path = std::env::temp_dir().join(format!("terminal-buddy-native-settings-{}.json", uuid::Uuid::new_v4()));
    atomic_write_private(&path, &serde_json::to_vec(&settings).map_err(|_| "无法编码会话配置")?)
        .map_err(|e| format!("创建会话模型配置失败：{e}"))?;
    Ok(NativeLaunch { args: vec!["--settings".into(), path.to_string_lossy().into_owned()], context_window, settings: Some(path) })
}

fn inherited_context_window(agent: &str) -> Option<u64> {
    if agent != "claude" { return None; }
    std::env::var("CLAUDE_CODE_MAX_CONTEXT_TOKENS").ok()?.parse::<u64>().ok().filter(|n| *n > 0 && *n <= i64::MAX as u64)
}
