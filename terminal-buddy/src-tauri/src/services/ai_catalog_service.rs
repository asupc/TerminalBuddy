//! 手机首页使用的供应商目录，以及原生会话的供应商启动配置。
use crate::models::ai_chat::{AiCatalog, AiModelOption, AiProviderOption};
use super::{antigravity_account_service, atomic_file::atomic_write_private, claude_provider_service, codex_provider_service, llm_provider_service};
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
    // Antigravity 通过官方 ACP（agy acp）和 Google 账号运行，支持本机默认账号及已录入的多账号隔离启动。
    let agy_state = antigravity_account_service::get_account_state().unwrap_or_default();
    for account in &agy_state.accounts {
        let display = if account.email.is_empty() || account.alias == account.email {
            account.alias.clone()
        } else {
            format!("{} ({})", account.alias, account.email)
        };
        providers.push(AiProviderOption {
            id: format!("antigravity:{}", account.id),
            agent: "antigravity".into(),
            name: display,
            is_default: account.is_default,
            models: vec![AiModelOption {
                id: String::new(),
                label: "Antigravity 默认模型".into(),
                effort: String::new(),
            }],
        });
    }
    providers.push(AiProviderOption {
        id: "default:antigravity".into(),
        agent: "antigravity".into(),
        name: "Google 账号（系统默认）".into(),
        is_default: agy_state.active_account_id.is_none(),
        models: vec![AiModelOption {
            id: String::new(),
            label: "Antigravity 默认模型".into(),
            effort: String::new(),
        }],
    });
    Ok(AiCatalog { providers })
}

/// 在目录中按 ID 查找供应商。未带来源前缀的原始 ID（桌面端项目模型菜单传的是
/// 终端启动用的供应商主键）依次尝试已知前缀；只有前缀确实存在时才命中，
/// 不改变「供应商被删除」的报错语义。
fn find_target<'a>(providers: &'a [AiProviderOption], agent: &str, id: &str) -> Option<&'a AiProviderOption> {
    if let Some(target) = providers.iter().find(|target| target.agent == agent && target.id == id) {
        return Some(target);
    }
    if id.contains(':') { return None; }
    ["llm", "claude", "codex", "antigravity"].into_iter()
        .find_map(|source| providers.iter().find(|target| target.agent == agent && target.id == format!("{source}:{id}")))
}

/// 创建时固化选择；已删除供应商或移除模型必须提示重新选择，不能回退到其他供应商。
pub fn selection(agent: &str, id: Option<&str>, model: Option<&str>) -> Result<Option<(String, String)>> {
    let Some(id) = id else { return Ok(None); }; // 兼容旧版客户端的默认 CLI 配置。
    let providers = catalog()?.providers;
    let target = find_target(&providers, agent, id).ok_or("所选供应商已不存在，请刷新后重新选择")?;
    // ACP Agent（如 Antigravity）的模型列表由会话启动后通过 configOptions 动态下发，
    // 目录中只有默认空模型占位；允许携带具体模型 ID 以便后续透传给 ACP。
    if agent != "antigravity" && !target.models.iter().any(|candidate| candidate.id == model.unwrap_or_default()) {
        return Err("所选模型已被移除或停用，请刷新后重新选择".into());
    }
    Ok(Some((target.id.clone(), target.name.clone())))
}

pub struct NativeLaunch {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub context_window: Option<u64>,
    settings: Option<PathBuf>,
}
impl NativeLaunch {
    /// 和桌面模型终端使用同一组临时 HTTP Hook，默认 CLI 配置也需要生成临时文件。
    pub fn enable_claude_hooks(&mut self) -> Result<()> {
        let mut settings = if let Some(path) = &self.settings {
            serde_json::from_slice::<Value>(&fs::read(path).map_err(|e| format!("读取会话模型配置失败：{e}"))?)
                .map_err(|e| format!("解析会话模型配置失败：{e}"))?
        } else { json!({}) };
        settings["hooks"] = super::claude_hook_settings::managed_hooks_object();
        // 没有供应商配置（服务端默认 CLI）时 `prepare` 不生成临时 settings，
        // 任务工具开关只能在这里补：否则默认配置的会话永远拿不到清单。
        if let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) { enable_task_tools(env); }
        else {
            let mut map = serde_json::Map::new(); enable_task_tools(&mut map);
            settings["env"] = Value::Object(map);
        }
        let path = self.settings.clone().unwrap_or_else(|| std::env::temp_dir()
            .join(format!("terminal-buddy-native-settings-{}.json", uuid::Uuid::new_v4())));
        atomic_write_private(&path, &serde_json::to_vec(&settings).map_err(|_| "无法编码会话配置")?)
            .map_err(|e| format!("写入会话决策 Hook 失败：{e}"))?;
        if self.settings.is_none() {
            self.args.extend(["--settings".into(), path.to_string_lossy().into_owned()]);
            self.settings = Some(path);
        }
        Ok(())
    }
}
impl Drop for NativeLaunch {
    fn drop(&mut self) { if let Some(path) = &self.settings { let _ = fs::remove_file(path); } }
}

pub fn prepare(agent: &str, provider_id: Option<&str>, model: Option<&str>) -> Result<NativeLaunch> {
    let Some(id) = provider_id else { return Ok(NativeLaunch { args: Vec::new(), env: Vec::new(), context_window: inherited_context_window(agent), settings: None }); };
    if id == format!("default:{agent}") { return Ok(NativeLaunch { args: Vec::new(), env: Vec::new(), context_window: inherited_context_window(agent), settings: None }); }
    let (source, id) = id.split_once(':').ok_or("供应商配置无效，请重新选择")?;
    if source == "antigravity" && agent == "antigravity" {
        let (profile_dir, env) = antigravity_account_service::prepare_isolated_env(id)?;
        let dir_str = super::path_service::PathService::normalize_child_process_path_str(&profile_dir.to_string_lossy());
        return Ok(NativeLaunch {
            args: vec!["--gemini-dir".into(), dir_str, "--app-data-dir".into(), "antigravity-acp".into()],
            env,
            context_window: None,
            settings: None,
        });
    }
    if source == "codex" && agent == "codex" {
        let args = codex_provider_service::native_session_args(id, model.unwrap_or_default())?;
        let context_window = args.iter().find_map(|arg| arg.strip_prefix("model_context_window=")?.parse::<u64>().ok()).filter(|n| *n > 0);
        return Ok(NativeLaunch { args, env: Vec::new(), context_window, settings: None });
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
        // 任务清单面板依赖 CLI 的任务工具：默认构建里它们被开关门控，
        // 关掉时模型看不到 TodoWrite / TaskCreate，底部清单卡永远为空。
        enable_task_tools(env);
    }
    let context_window = settings.pointer("/env/CLAUDE_CODE_MAX_CONTEXT_TOKENS")
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok())).filter(|n| *n > 0)
        .or_else(|| inherited_context_window(agent));
    let path = std::env::temp_dir().join(format!("terminal-buddy-native-settings-{}.json", uuid::Uuid::new_v4()));
    atomic_write_private(&path, &serde_json::to_vec(&settings).map_err(|_| "无法编码会话配置")?)
        .map_err(|e| format!("创建会话模型配置失败：{e}"))?;
    Ok(NativeLaunch { args: vec!["--settings".into(), path.to_string_lossy().into_owned()], env: Vec::new(), context_window, settings: Some(path) })
}

/// 打开 Claude CLI 的任务工具（`TodoWrite` / `TaskCreate` / `TaskUpdate` / `TaskList`）。
/// 这些工具在 CLI 2.1.x 默认关闭：关着时 `system/init.tools` 里根本没有它们，
/// 模型也明确回答"工具不存在"，原生会话的底部任务清单卡就永远是空的。
/// 原生会话的 `--settings` 临时文件由本服务统一生成，因此在这里补上开关即可；
/// 用户已有的同名键不覆盖，保留其显式配置。
fn enable_task_tools(env: &mut serde_json::Map<String, Value>) {
    for key in ["CLAUDE_CODE_ENABLE_TODO_TOOLS", "CLAUDE_CODE_ENABLE_TASKS"] {
        env.entry(key.to_string()).or_insert_with(|| json!("1"));
    }
}

fn inherited_context_window(agent: &str) -> Option<u64> {
    if agent != "claude" { return None; }
    env_context_window().or_else(user_settings_context_window)
}

fn env_context_window() -> Option<u64> {
    std::env::var("CLAUDE_CODE_MAX_CONTEXT_TOKENS").ok()?.parse::<u64>().ok()
        .filter(|n| *n > 0 && *n <= i64::MAX as u64)
}

/// 用户级 `~/.claude/settings.json` 里的窗口配置。原生会话带 `--settings`
/// 启动时，临时文件未写的 env 键会穿透到用户级配置，CLI 实际按它执行；
/// 例如供应商模型没有配置窗口、但用户级设置了 600k 时，启动阶段也应显示 600k。
fn user_settings_context_window() -> Option<u64> {
    let dir = super::claude_hook_settings::resolve_claude_config_dir(None).ok()?;
    let bytes = fs::read(dir.join("settings.json")).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let raw = value.pointer("/env/CLAUDE_CODE_MAX_CONTEXT_TOKENS")?;
    raw.as_u64().or_else(|| raw.as_str()?.parse().ok())
        .filter(|n| *n > 0 && *n <= i64::MAX as u64)
}

/// 创建会话时即可确定的上下文窗口。复用 `prepare()` 的完整优先级
/// （供应商模型配置 → 供应商 settings 的 env → 用户级 settings / 进程环境变量），
/// 与真正启动 CLI 时的取值保持一致，不必等第一份用量报告。
pub(crate) fn configured_context_window(agent: &str, provider_id: Option<&str>, model: Option<&str>) -> Option<u64> {
    prepare(agent, provider_id, model).ok().and_then(|launch| launch.context_window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, agent: &str) -> AiProviderOption {
        AiProviderOption {
            id: id.into(), agent: agent.into(), name: format!("{id}-name"), is_default: false,
            models: vec![AiModelOption { id: "m1".into(), label: "m1".into(), effort: String::new() }],
        }
    }

    #[test]
    fn raw_provider_ids_fall_back_to_prefixed_catalog_ids() {
        let providers = vec![provider("llm:abc", "claude"), provider("claude:abc", "claude"), provider("codex:xyz", "codex")];
        assert_eq!(find_target(&providers, "claude", "llm:abc").map(|t| t.id.as_str()), Some("llm:abc"));
        // 桌面端项目模型菜单传的是原始主键：优先 llm 前缀，其次 claude。
        assert_eq!(find_target(&providers, "claude", "abc").map(|t| t.id.as_str()), Some("llm:abc"));
        assert_eq!(find_target(&providers, "codex", "xyz").map(|t| t.id.as_str()), Some("codex:xyz"));
    }

    #[test]
    fn unknown_or_cross_agent_ids_do_not_fall_back() {
        let providers = vec![provider("llm:abc", "claude"), provider("codex:xyz", "codex")];
        // 供应商确实不存在时必须继续报「已不存在」，不能退化成模糊匹配。
        assert!(find_target(&providers, "claude", "missing").is_none());
        assert!(find_target(&providers, "claude", "xyz").is_none());
        // 已带前缀的 ID 只做精确匹配。
        assert!(find_target(&providers, "codex", "llm:abc").is_none());
    }

    #[test]
    fn task_tools_are_enabled_without_overriding_user_choice() {
        let mut env = serde_json::Map::new();
        enable_task_tools(&mut env);
        assert_eq!(env["CLAUDE_CODE_ENABLE_TODO_TOOLS"], "1");
        assert_eq!(env["CLAUDE_CODE_ENABLE_TASKS"], "1");
        // 用户显式关掉时保留其配置，不强行打开。
        let mut env = serde_json::Map::new();
        env.insert("CLAUDE_CODE_ENABLE_TODO_TOOLS".into(), json!("0"));
        enable_task_tools(&mut env);
        assert_eq!(env["CLAUDE_CODE_ENABLE_TODO_TOOLS"], "0");
    }
}
