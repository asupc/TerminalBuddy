//! 终端内运行的 Agent 用量快照（底部状态栏）。
//!
//! 原生聊天会话由 app-server 主动推送 usage；终端里启动的 Claude / Codex 没有这条通道，
//! 只能读 CLI 自己写的 transcript。这里只做只读解析，并把结果按文件 mtime/size 缓存，
//! 供状态栏按终端轮询。
use crate::models::ai_chat::AiTokenUsage;
use crate::services::{
    ai_catalog_service, claude_hook_settings, llm_provider_service,
    terminal_task_service,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentUsage {
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub context_used_tokens: Option<u64>,
    pub context_window_tokens: Option<u64>,
    pub total: AiTokenUsage,
    pub updated_at: i64,
}

#[derive(Clone, Default)]
struct ParsedUsage {
    model: Option<String>,
    context_used: Option<u64>,
    context_window: Option<u64>,
    total: AiTokenUsage,
}

#[derive(Clone, Default)]
struct ClaudeIncremental {
    line_index: usize,
    by_message: HashMap<String, AiTokenUsage>,
    last_main_used: Option<u64>,
    last_main_model: Option<String>,
}

#[derive(Clone, Default)]
struct CodexIncremental {
    model: Option<String>,
    context_used: Option<u64>,
    context_window: Option<u64>,
    total: AiTokenUsage,
    has_totals: bool,
    last_sum: AiTokenUsage,
}

#[derive(Clone, Default)]
struct AntigravityIncremental {
    line_index: usize,
    model: Option<String>,
    context_used: Option<u64>,
    by_step: HashMap<String, AiTokenUsage>,
}

#[derive(Clone)]
enum IncrementalState {
    Claude(ClaudeIncremental),
    Codex(CodexIncremental),
    Antigravity(AntigravityIncremental),
}

impl IncrementalState {
    fn new(provider: &str) -> Self {
        match provider {
            "codex" => Self::Codex(CodexIncremental::default()),
            "antigravity" => Self::Antigravity(AntigravityIncremental::default()),
            _ => Self::Claude(ClaudeIncremental::default()),
        }
    }

    fn feed_line(&mut self, trimmed_line: &str, has_newline: bool) -> bool {
        if !has_newline && trimmed_line.is_empty() {
            return true;
        }
        // `\n` 已落盘的行允许先做廉价子串过滤；末尾无 `\n` 的残行可能是半行写入，
        // 需先尝试解析完整 JSON 才能确认是否推进偏移。
        let parsed_value = if has_newline {
            let matches_prefilter = match self {
                Self::Claude(_) => trimmed_line.contains("\"assistant\""),
                Self::Codex(_) => {
                    trimmed_line.contains("token_count") || trimmed_line.contains("\"model\"")
                }
                Self::Antigravity(_) => trimmed_line.contains("PLANNER_RESPONSE"),
            };
            if !matches_prefilter {
                match self {
                    Self::Claude(state) => state.line_index += 1,
                    Self::Antigravity(state) => state.line_index += 1,
                    Self::Codex(_) => {}
                }
                return true;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed_line) else {
                match self {
                    Self::Claude(state) => state.line_index += 1,
                    Self::Antigravity(state) => state.line_index += 1,
                    Self::Codex(_) => {}
                }
                return true;
            };
            value
        } else {
            let Ok(value) = serde_json::from_str::<Value>(trimmed_line) else {
                // 半行仍未写完：不推进偏移或行号，等待下一轮补齐换行。
                return false;
            };
            value
        };

        match self {
            Self::Claude(state) => {
                let index = state.line_index;
                state.line_index += 1;
                if parsed_value.get("type").and_then(Value::as_str) != Some("assistant") {
                    return true;
                }
                let Some(message) = parsed_value.get("message") else {
                    return true;
                };
                let usage = message.get("usage").unwrap_or(&Value::Null);
                let fresh = number(usage, "input_tokens");
                let cached = number(usage, "cache_read_input_tokens");
                let created = number(usage, "cache_creation_input_tokens");
                let output = number(usage, "output_tokens");
                if fresh.is_none() && cached.is_none() && created.is_none() && output.is_none() {
                    return true;
                }
                let input = add(add(fresh, cached), created);
                let tokens = AiTokenUsage {
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_input_tokens: cached,
                    cache_creation_input_tokens: created,
                    reasoning_output_tokens: usage
                        .pointer("/output_tokens_details/thinking_tokens")
                        .and_then(Value::as_u64),
                };
                let id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("line-{index}"));
                merge_max(state.by_message.entry(id).or_default(), &tokens);
                if parsed_value.get("isSidechain").and_then(Value::as_bool) != Some(true) {
                    if let Some(model) = message
                        .get("model")
                        .and_then(Value::as_str)
                        .filter(|model| !model.is_empty())
                    {
                        state.last_main_model = Some(model.to_string());
                    }
                    if let Some(used) = input.filter(|used| *used > 0) {
                        state.last_main_used = Some(used);
                    }
                }
                true
            }
            Self::Codex(state) => {
                let payload = parsed_value.get("payload").unwrap_or(&parsed_value);
                let kind = parsed_value.get("type").and_then(Value::as_str).unwrap_or("");
                let payload_kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
                if let Some(model) = payload
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|model| !model.is_empty())
                {
                    state.model = Some(model.to_string());
                }
                if kind != "event_msg" || payload_kind != "token_count" {
                    return true;
                }
                let info = payload.get("info").unwrap_or(&Value::Null);
                if let Some(total) = info.get("total_token_usage").filter(|value| value.is_object()) {
                    state.has_totals = true;
                    merge_max(
                        &mut state.total,
                        &AiTokenUsage {
                            input_tokens: number(total, "input_tokens"),
                            output_tokens: number(total, "output_tokens"),
                            cache_read_input_tokens: number(total, "cached_input_tokens"),
                            cache_creation_input_tokens: None,
                            reasoning_output_tokens: number(total, "reasoning_output_tokens"),
                        },
                    );
                } else if !state.has_totals {
                    let last = info.get("last_token_usage").unwrap_or(&Value::Null);
                    state.last_sum = plus(
                        &state.last_sum,
                        &AiTokenUsage {
                            input_tokens: number(last, "input_tokens"),
                            output_tokens: number(last, "output_tokens"),
                            ..Default::default()
                        },
                    );
                }
                if let Some(last) = info.get("last_token_usage").filter(|value| value.is_object()) {
                    let used = number(last, "total_tokens")
                        .or_else(|| add(number(last, "input_tokens"), number(last, "output_tokens")));
                    if let Some(used) = used.filter(|used| *used > 0) {
                        state.context_used = Some(used);
                    }
                }
                if let Some(window) = number(info, "model_context_window")
                    .or_else(|| number(info, "modelContextWindow"))
                {
                    if window > 0 {
                        state.context_window = Some(window);
                    }
                }
                true
            }
            Self::Antigravity(state) => {
                let index = state.line_index;
                state.line_index += 1;
                if parsed_value.get("type").and_then(Value::as_str) != Some("PLANNER_RESPONSE") {
                    return true;
                }
                let source = parsed_value.get("source").and_then(Value::as_str).unwrap_or("");
                if !matches!(source, "" | "MODEL") {
                    return true;
                }
                if let Some(model) = parsed_value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                {
                    state.model = Some(model.to_string());
                }
                let fresh = number(&parsed_value, "input_tokens");
                let cached = number(&parsed_value, "cache_read_tokens");
                let output = number(&parsed_value, "output_tokens");
                if fresh.is_none() && cached.is_none() && output.is_none() {
                    return true;
                }
                let input = add(fresh, cached);
                let tokens = AiTokenUsage {
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_input_tokens: cached,
                    cache_creation_input_tokens: None,
                    reasoning_output_tokens: None,
                };
                let key = parsed_value
                    .get("step_index")
                    .and_then(Value::as_u64)
                    .map(|step| format!("step-{step}"))
                    .unwrap_or_else(|| format!("line-{index}"));
                merge_max(state.by_step.entry(key).or_default(), &tokens);
                if let Some(used) = input.filter(|used| *used > 0) {
                    state.context_used = Some(used);
                }
                true
            }
        }
    }

    fn finalize(&self) -> ParsedUsage {
        match self {
            Self::Claude(state) => {
                let mut result = ParsedUsage {
                    model: state.last_main_model.clone(),
                    context_used: state.last_main_used,
                    context_window: None,
                    total: AiTokenUsage::default(),
                };
                for tokens in state.by_message.values() {
                    result.total = plus(&result.total, tokens);
                }
                result
            }
            Self::Codex(state) => ParsedUsage {
                model: state.model.clone(),
                context_used: state.context_used,
                context_window: state.context_window,
                total: if state.has_totals {
                    state.total.clone()
                } else {
                    state.last_sum.clone()
                },
            },
            Self::Antigravity(state) => {
                let mut result = ParsedUsage {
                    model: state.model.clone(),
                    context_used: state.context_used,
                    context_window: None,
                    total: AiTokenUsage::default(),
                };
                for tokens in state.by_step.values() {
                    result.total = plus(&result.total, tokens);
                }
                result
            }
        }
    }
}

#[derive(Clone)]
struct CachedParse {
    provider: String,
    mtime: u64,
    size: u64,
    parsed_offset: u64,
    state: IncrementalState,
    parsed: ParsedUsage,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CachedParse>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedParse>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn number(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|raw| {
        raw.as_u64()
            .or_else(|| raw.as_str()?.trim().parse::<u64>().ok())
    })
}

fn add(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (None, None) => None,
        _ => Some(a.unwrap_or(0).saturating_add(b.unwrap_or(0))),
    }
}

fn max(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        _ => a.or(b),
    }
}

fn plus(a: &AiTokenUsage, b: &AiTokenUsage) -> AiTokenUsage {
    AiTokenUsage {
        input_tokens: add(a.input_tokens, b.input_tokens),
        output_tokens: add(a.output_tokens, b.output_tokens),
        cache_read_input_tokens: add(a.cache_read_input_tokens, b.cache_read_input_tokens),
        cache_creation_input_tokens: add(a.cache_creation_input_tokens, b.cache_creation_input_tokens),
        reasoning_output_tokens: add(a.reasoning_output_tokens, b.reasoning_output_tokens),
    }
}

/// 同一 API 消息可能被 transcript 重复写入（流式落盘 / 重放）：
/// 同一字段取高水位，不能按行累加。
fn merge_max(target: &mut AiTokenUsage, source: &AiTokenUsage) {
    target.input_tokens = max(target.input_tokens, source.input_tokens);
    target.output_tokens = max(target.output_tokens, source.output_tokens);
    target.cache_read_input_tokens = max(target.cache_read_input_tokens, source.cache_read_input_tokens);
    target.cache_creation_input_tokens = max(target.cache_creation_input_tokens, source.cache_creation_input_tokens);
    target.reasoning_output_tokens = max(target.reasoning_output_tokens, source.reasoning_output_tokens);
}

#[cfg(test)]
fn parse_with_state(provider: &str, content: &str) -> ParsedUsage {
    let mut state = IncrementalState::new(provider);
    for raw in content.split_inclusive('\n') {
        let has_newline = raw.ends_with('\n');
        let trimmed = raw.trim_end_matches(['\r', '\n']);
        state.feed_line(trimmed, has_newline);
    }
    state.finalize()
}

/// Claude transcript：assistant 行既有正文也有 usage。上下文按主线程最后一条
/// 消息的输入量（含缓存读写）计算，累计量覆盖主线程与子代理的全部 API 调用。
#[cfg(test)]
fn parse_claude(content: &str) -> ParsedUsage {
    parse_with_state("claude", content)
}

/// Codex rollout：`token_count` 的 `total_token_usage` 是累计快照（取高水位），
/// `last_token_usage` 是本轮用量，可估算当前上下文占用；`model_context_window`
/// 由 CLI 直接给出。
#[cfg(test)]
fn parse_codex(content: &str) -> ParsedUsage {
    parse_with_state("codex", content)
}

/// Antigravity CLI transcript：`PLANNER_RESPONSE` 行中的 `input_tokens` 为未缓存输入，
/// `cache_read_tokens` 为缓存命中输入；两者之和才是该步总输入与上下文占用。
#[cfg(test)]
fn parse_antigravity(content: &str) -> ParsedUsage {
    parse_with_state("antigravity", content)
}

fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let metadata = fs::metadata(path).ok()?;
    let mtime = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((mtime, metadata.len()))
}

fn parse_file(path: &Path, provider: &str) -> Result<ParsedUsage, String> {
    let (mtime, size) = file_stamp(path)
        .ok_or_else(|| format!("读取会话文件信息失败：{}", path.display()))?;
    let mut resume_from: Option<(u64, IncrementalState)> = None;
    if let Ok(map) = cache().lock() {
        if let Some(cached) = map.get(path) {
            if cached.provider == provider && cached.mtime == mtime && cached.size == size {
                return Ok(cached.parsed.clone());
            }
            if cached.provider == provider && size > cached.size && cached.parsed_offset <= size {
                resume_from = Some((cached.parsed_offset, cached.state.clone()));
            }
        }
    }

    let (mut offset, mut state) =
        resume_from.unwrap_or_else(|| (0, IncrementalState::new(provider)));
    let mut file = File::open(path).map_err(|error| format!("读取会话文件失败：{}", error))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("定位会话文件失败：{}", error))?;
    let mut reader = BufReader::new(file);
    let mut raw_line = String::new();
    loop {
        raw_line.clear();
        let bytes = reader
            .read_line(&mut raw_line)
            .map_err(|error| format!("读取会话文件失败：{}", error))?;
        if bytes == 0 {
            break;
        }
        let has_newline = raw_line.ends_with('\n');
        let trimmed = raw_line.trim_end_matches(['\r', '\n']);
        if state.feed_line(trimmed, has_newline) {
            offset += bytes as u64;
        } else {
            break;
        }
    }
    let parsed = state.finalize();
    if let Ok(mut map) = cache().lock() {
        // 会话数量有限；超过上限时整体清空，避免长期运行后无界增长。
        if map.len() > 32 {
            map.clear();
        }
        map.insert(
            path.to_path_buf(),
            CachedParse {
                provider: provider.to_string(),
                mtime,
                size,
                parsed_offset: offset,
                state,
                parsed: parsed.clone(),
            },
        );
    }
    Ok(parsed)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// settings 里的上下文窗口与思考强度；env 优先于文件里的 effortLevel。
fn settings_values(value: &Value) -> (Option<u64>, Option<String>) {
    let env = value.get("env");
    let window = env
        .and_then(|env| env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"))
        .and_then(|raw| raw.as_u64().or_else(|| raw.as_str()?.trim().parse().ok()))
        .filter(|window| *window > 0);
    let effort = env
        .and_then(|env| env.get("CLAUDE_CODE_EFFORT_LEVEL"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            value
                .get("effortLevel")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .map(str::to_string);
    (window, effort)
}

/// Claude 配置优先级：项目本地 → 项目共享 → 用户级，先命中的值生效。
fn claude_settings(cwd: Option<&str>) -> (Option<u64>, Option<String>) {
    let mut paths = Vec::new();
    if let Some(cwd) = cwd.filter(|cwd| !cwd.trim().is_empty()) {
        paths.push(Path::new(cwd).join(".claude").join("settings.local.json"));
        paths.push(Path::new(cwd).join(".claude").join("settings.json"));
    }
    if let Ok(dir) = claude_hook_settings::resolve_claude_config_dir(None) {
        paths.push(dir.join("settings.json"));
    }
    let mut window = None;
    let mut effort = None;
    for path in paths {
        let Some(value) = read_json(&path) else { continue };
        let (found_window, found_effort) = settings_values(&value);
        window = window.or(found_window);
        effort = effort.or(found_effort);
    }
    (window, effort)
}

/// 供应商目录里的思考强度：终端启动时无法从命令反查供应商，按模型匹配兜底。
fn catalog_effort(provider: &str, model: Option<&str>) -> Option<String> {
    let model = model?;
    let catalog = ai_catalog_service::catalog().ok()?;
    catalog
        .providers
        .iter()
        .filter(|provider_option| provider_option.agent == provider)
        .flat_map(|provider_option| provider_option.models.iter())
        .find(|option| option.id == model && !option.effort.trim().is_empty())
        .map(|option| option.effort.trim().to_string())
}

/// 没有显式配置时，只对能确定的 Claude 模型给出常见窗口；未知模型不猜，
/// 避免把错误的分母显示成占用率。
fn default_claude_window(model: Option<&str>) -> Option<u64> {
    let model = model?.to_ascii_lowercase();
    if model.contains("[1m]") || model.contains("-1m") {
        return Some(1_000_000);
    }
    if ["claude", "opus", "sonnet", "haiku", "fable", "mythos"]
        .iter()
        .any(|key| model.contains(key))
    {
        return Some(200_000);
    }
    None
}

fn antigravity_model_effort_suffix(model: Option<&str>) -> Option<String> {
    let lower = model?.trim().to_ascii_lowercase();
    for (suffix, level) in [
        ("-xhigh", "xhigh"),
        ("-medium", "medium"),
        ("-high", "high"),
        ("-low", "low"),
        ("-max", "max"),
    ] {
        if lower.ends_with(suffix) {
            return Some(level.to_string());
        }
    }
    None
}

fn resolve_antigravity_effort(launch_effort: Option<&str>, model: Option<&str>) -> Option<String> {
    launch_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| antigravity_model_effort_suffix(model))
}

fn default_antigravity_window(model: Option<&str>, context_used: Option<u64>) -> Option<u64> {
    let lower = model?.to_ascii_lowercase();
    if lower.contains("gemini") {
        return Some(1_000_000);
    }
    if ["claude", "opus", "sonnet", "haiku", "fable", "mythos"]
        .iter()
        .any(|key| lower.contains(key))
    {
        if lower.contains("[1m]")
            || lower.contains("-1m")
            || context_used.is_some_and(|used| used > 200_000)
        {
            return Some(1_000_000);
        }
        return Some(200_000);
    }
    None
}

/// 当前选中终端背后的 Agent 用量；终端尚未绑定 Agent 时返回 None。
pub fn usage(terminal_id: &str) -> Result<Option<TerminalAgentUsage>, String> {
    let launch = llm_provider_service::terminal_launch_config(terminal_id);
    let task_hints = terminal_task_service::launch_hints(terminal_id);
    let Some(location) = terminal_task_service::locate_transcript(terminal_id) else {
        // 绑定已经建立、但 transcript 还没落盘（Claude 首轮对话之前 / Codex 或 agy 刚启动）
        // 或暂时找不到文件时，先用启动配置给状态栏一个快照，避免整条 Agent 信息
        // 在会话最初几秒里消失；用量留空，下一轮轮询会补齐。
        let Some(provider) = terminal_task_service::current_binding(terminal_id)
            .map(|(provider, _)| provider)
            .or_else(|| {
                task_hints
                    .as_ref()
                    .and_then(|hints| hints.provider.clone())
                    .filter(|provider| provider == "antigravity")
            })
        else {
            return Ok(None);
        };
        if provider == "antigravity" {
            let model = task_hints.as_ref().and_then(|hints| hints.model.clone());
            let effort = resolve_antigravity_effort(
                task_hints.as_ref().and_then(|hints| hints.effort.as_deref()),
                model.as_deref(),
            );
            let context_window_tokens = default_antigravity_window(model.as_deref(), None);
            return Ok(Some(TerminalAgentUsage {
                provider,
                model,
                effort,
                context_window_tokens,
                updated_at: chrono::Utc::now().timestamp_millis(),
                ..Default::default()
            }));
        }
        return Ok(Some(TerminalAgentUsage {
            provider,
            model: launch.as_ref().and_then(|config| config.model.clone()),
            effort: launch.as_ref().and_then(|config| config.effort.clone()),
            context_window_tokens: launch.as_ref().and_then(|config| config.context_window),
            updated_at: chrono::Utc::now().timestamp_millis(),
            ..Default::default()
        }));
    };
    let parsed = parse_file(&location.path, &location.provider)?;
    let is_antigravity = location.provider == "antigravity";
    let is_claude = location.provider == "claude";
    let model = parsed.model.clone().or_else(|| {
        if is_antigravity {
            task_hints.as_ref().and_then(|hints| hints.model.clone())
        } else {
            launch.as_ref().and_then(|config| config.model.clone())
        }
    });
    let (settings_window, settings_effort) = if is_claude {
        claude_settings(terminal_task_service::current_cwd(terminal_id).as_deref())
    } else {
        (None, None)
    };
    let effort = if is_antigravity {
        resolve_antigravity_effort(
            task_hints.as_ref().and_then(|hints| hints.effort.as_deref()),
            model.as_deref(),
        )
    } else {
        launch
            .as_ref()
            .and_then(|config| config.effort.clone())
            .or(settings_effort)
            .or_else(|| catalog_effort(&location.provider, model.as_deref()))
    };
    let context_window = if is_antigravity {
        parsed
            .context_window
            .or_else(|| default_antigravity_window(model.as_deref(), parsed.context_used))
    } else {
        parsed
            .context_window
            .or_else(|| launch.as_ref().and_then(|config| config.context_window))
            .or(settings_window)
            .or_else(|| if is_claude { default_claude_window(model.as_deref()) } else { None })
    };
    Ok(Some(TerminalAgentUsage {
        provider: location.provider,
        model,
        effort,
        context_used_tokens: parsed.context_used,
        context_window_tokens: context_window,
        total: parsed.total,
        updated_at: chrono::Utc::now().timestamp_millis(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn jsonl(records: Vec<Value>) -> String {
        records.into_iter().map(|record| record.to_string()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn claude_usage_dedupes_messages_and_keeps_main_thread_context() {
        let content = jsonl(vec![
            json!({"type":"assistant","isSidechain":false,"message":{"id":"a","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":900,"cache_creation_input_tokens":50}}}),
            // 同一消息重复落盘：取高水位而不是累加。
            json!({"type":"assistant","isSidechain":false,"message":{"id":"a","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":12,"cache_read_input_tokens":900,"cache_creation_input_tokens":50}}}),
            json!({"type":"assistant","isSidechain":false,"message":{"id":"b","model":"claude-sonnet-4-5","usage":{"input_tokens":120,"output_tokens":8,"cache_read_input_tokens":1800,"cache_creation_input_tokens":0}}}),
            // 子代理的调用计入累计，但不覆盖主线程上下文与模型。
            json!({"type":"assistant","isSidechain":true,"message":{"id":"c","model":"claude-haiku-4-5","usage":{"input_tokens":30,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}),
        ]);
        let parsed = parse_claude(&content);
        assert_eq!(parsed.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(parsed.context_used, Some(1920));
        assert_eq!(parsed.total.input_tokens, Some(3000));
        assert_eq!(parsed.total.output_tokens, Some(25));
        assert_eq!(parsed.total.cache_read_input_tokens, Some(2700));
        assert_eq!(parsed.total.cache_creation_input_tokens, Some(50));
    }

    #[test]
    fn codex_usage_uses_high_water_totals_and_last_turn_context() {
        let content = jsonl(vec![
            json!({"type":"turn_context","payload":{"model":"gpt-5-codex"}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":10},"last_token_usage":{"input_tokens":40,"output_tokens":5,"total_tokens":45},"model_context_window":258400}}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":200,"output_tokens":25},"last_token_usage":{"input_tokens":60,"output_tokens":5,"total_tokens":65},"model_context_window":258400}}}),
        ]);
        let parsed = parse_codex(&content);
        assert_eq!(parsed.model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(parsed.context_used, Some(65));
        assert_eq!(parsed.context_window, Some(258400));
        assert_eq!(parsed.total.input_tokens, Some(300));
        assert_eq!(parsed.total.output_tokens, Some(25));
        assert_eq!(parsed.total.cache_read_input_tokens, Some(200));
    }

    #[test]
    fn tracked_terminal_transcript_returns_usage_snapshot() {
        let dir = std::env::temp_dir().join(format!("tb-usage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("创建临时目录");
        let session_id = uuid::Uuid::new_v4().to_string();
        let path = dir.join(format!("{session_id}.jsonl"));
        fs::write(&path, jsonl(vec![
            json!({"type":"assistant","isSidechain":false,"message":{"id":"a","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":90,"cache_creation_input_tokens":0}}}),
        ])).expect("写入会话文件");
        let terminal_id = format!("usage-test-{}", uuid::Uuid::new_v4());
        terminal_task_service::prepare_launch(&terminal_id, "bash", None, &[], Vec::new());
        terminal_task_service::record_agent_session(
            &terminal_id,
            "claude",
            &session_id,
            Some(&path.to_string_lossy()),
            true,
        );
        let snapshot = usage(&terminal_id).expect("读取用量").expect("应返回快照");
        terminal_task_service::forget_terminal(&terminal_id);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(snapshot.provider, "claude");
        assert_eq!(snapshot.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(snapshot.context_used_tokens, Some(100));
        assert_eq!(snapshot.total.input_tokens, Some(100));
        assert_eq!(snapshot.total.cache_read_input_tokens, Some(90));
    }

    #[test]
    fn antigravity_usage_sums_fresh_and_cached_and_dedupes_steps() {
        let content = jsonl(vec![
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"hi"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","model":"gemini-3.1-pro-low","input_tokens":100,"cache_read_tokens":900,"output_tokens":20}),
            // 同一步骤重复写入时按字段取高水位，不能重复累加。
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","model":"gemini-3.1-pro-low","input_tokens":100,"cache_read_tokens":900,"output_tokens":25}),
            json!({"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","model":"claude-opus-4-6-thinking","input_tokens":150,"cache_read_tokens":1850,"output_tokens":30}),
        ]);
        let parsed = parse_antigravity(&content);
        assert_eq!(parsed.model.as_deref(), Some("claude-opus-4-6-thinking"));
        assert_eq!(parsed.context_used, Some(2000));
        assert_eq!(parsed.total.input_tokens, Some(3000));
        assert_eq!(parsed.total.output_tokens, Some(55));
        assert_eq!(parsed.total.cache_read_input_tokens, Some(2750));
    }

    #[test]
    fn antigravity_window_and_effort_resolution() {
        assert_eq!(default_antigravity_window(Some("gemini-3.1-pro-high"), None), Some(1_000_000));
        assert_eq!(default_antigravity_window(Some("claude-sonnet-4-6"), Some(50_000)), Some(200_000));
        assert_eq!(default_antigravity_window(Some("claude-opus-4-6-thinking"), Some(250_000)), Some(1_000_000));
        assert_eq!(default_antigravity_window(Some("gpt-oss-120b-medium"), None), None);

        assert_eq!(antigravity_model_effort_suffix(Some("gemini-3.1-pro-high")).as_deref(), Some("high"));
        assert_eq!(antigravity_model_effort_suffix(Some("gpt-oss-120b-medium")).as_deref(), Some("medium"));
        assert_eq!(antigravity_model_effort_suffix(Some("claude-opus-4-6-thinking")), None);

        assert_eq!(
            resolve_antigravity_effort(Some("MAX"), Some("gemini-3.1-pro-low")).as_deref(),
            Some("max")
        );
        assert_eq!(
            resolve_antigravity_effort(None, Some("gemini-3.1-pro-low")).as_deref(),
            Some("low")
        );
        assert_eq!(resolve_antigravity_effort(None, Some("claude-opus-4-6-thinking")), None);
    }

    #[test]
    fn tracked_antigravity_terminal_returns_usage_snapshot() {
        let dir = std::env::temp_dir().join(format!("tb-agy-usage-{}", uuid::Uuid::new_v4()));
        let conv_id = uuid::Uuid::new_v4().to_string();
        let logs_dir = dir.join("brain").join(&conv_id).join(".system_generated").join("logs");
        fs::create_dir_all(&logs_dir).expect("创建临时日志目录");
        fs::write(
            logs_dir.join("transcript_full.jsonl"),
            jsonl(vec![json!({
                "step_index": 1,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "model": "gemini-3.1-pro-high",
                "input_tokens": 15000,
                "cache_read_tokens": 420000,
                "output_tokens": 800
            })]),
        )
        .expect("写入 Antigravity 转录");

        let terminal_id = format!("agy-usage-test-{}", uuid::Uuid::new_v4());
        terminal_task_service::prepare_launch(
            &terminal_id,
            "powershell",
            None,
            &[("ANTIGRAVITY_CLI_HOME".to_string(), dir.to_string_lossy().into_owned())],
            vec![format!(
                "agy --dangerously-skip-permissions --model gemini-3.1-pro-high --effort high --conversation {conv_id}"
            )],
        );
        let snapshot = usage(&terminal_id).expect("读取 Antigravity 用量").expect("应返回快照");
        terminal_task_service::forget_terminal(&terminal_id);
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(snapshot.provider, "antigravity");
        assert_eq!(snapshot.model.as_deref(), Some("gemini-3.1-pro-high"));
        assert_eq!(snapshot.effort.as_deref(), Some("high"));
        assert_eq!(snapshot.context_used_tokens, Some(435_000));
        assert_eq!(snapshot.context_window_tokens, Some(1_000_000));
        assert_eq!(snapshot.total.input_tokens, Some(435_000));
        assert_eq!(snapshot.total.output_tokens, Some(800));
        assert_eq!(snapshot.total.cache_read_input_tokens, Some(420_000));
    }

    #[test]
    fn incremental_parse_file_handles_append_partial_line_and_truncate() {
        let dir = std::env::temp_dir().join(format!("tb-usage-inc-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("创建临时目录");
        let path = dir.join("claude.jsonl");

        let line1 = json!({"type":"assistant","isSidechain":false,"message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":90,"cache_creation_input_tokens":0}}}).to_string();
        let line2 = json!({"type":"assistant","isSidechain":false,"message":{"id":"m2","model":"claude-sonnet-4-5","usage":{"input_tokens":20,"output_tokens":8,"cache_read_input_tokens":180,"cache_creation_input_tokens":0}}}).to_string();
        let split_at = line2.len() / 2;

        // 写入首行与半行（无换行结尾）：应先统计 line1，保留半行到下一轮。
        fs::write(&path, format!("{line1}\n{}", &line2[..split_at])).unwrap();
        let first = parse_file(&path, "claude").unwrap();
        assert_eq!(first.total.input_tokens, Some(100));
        assert_eq!(first.total.output_tokens, Some(5));

        // 补全第二行（无换行结尾同样完整 JSON），再追加噪声行（确保走过预过滤分支）。
        let noise = json!({"type":"user","message":{"role":"user","content":"ping"}}).to_string();
        fs::write(&path, format!("{line1}\n{line2}\n{noise}\n")).unwrap();
        let appended = parse_file(&path, "claude").unwrap();
        let full = parse_claude(&format!("{line1}\n{line2}\n{noise}\n"));
        assert_eq!(appended.total.input_tokens, full.total.input_tokens);
        assert_eq!(appended.total.output_tokens, full.total.output_tokens);
        assert_eq!(appended.context_used, full.context_used);

        // 文件被截断缩小后应重置解析状态。
        fs::write(&path, format!("{line1}\n")).unwrap();
        let truncated = parse_file(&path, "claude").unwrap();
        assert_eq!(truncated.total.input_tokens, Some(100));
        assert_eq!(truncated.total.output_tokens, Some(5));

        let _ = fs::remove_dir_all(&dir);
    }
}
