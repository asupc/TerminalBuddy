//! Pi 模型目录：直接读取 `pi --list-models`，不复制 Pi 的 provider/auth 体系。
//! 结果按 provider 分组缓存 5 分钟；未安装或未登录时返回明确错误。
use serde::Serialize;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::agent_cli_service::{executable_command, resolve_binary, CliTool};

const CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModel {
    pub id: String,
    /// Pi 的 --thinking 可用级别；前端据此展开思考级别选择。
    pub thinking: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModelProvider {
    pub provider: String,
    pub models: Vec<PiModel>,
}

struct Cache {
    fetched_at: Option<Instant>,
    providers: Vec<PiModelProvider>,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache { fetched_at: None, providers: Vec::new() }))
}

fn pi_command() -> Result<Command, String> {
    let binary = resolve_binary(CliTool::Pi)
        .ok_or_else(|| "未检测到 Pi，请先在 Agent 管理中安装 Pi".to_string())?;
    Ok(executable_command(&binary, &["--list-models"]))
}

fn run_with_timeout(command: &mut Command, timeout: Duration) -> Result<String, String> {
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "未检测到 Pi，请先在 Agent 管理中安装 Pi".to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().map_err(|error| error.to_string())?;
                if !status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    if stderr.contains("not found") || stderr.contains("不是内部或外部命令") {
                        return Err("未检测到 Pi，请先在 Agent 管理中安装 Pi".to_string());
                    }
                    return Err(if stderr.is_empty() {
                        "读取 Pi 模型失败，请先在终端运行 pi 并完成登录".to_string()
                    } else {
                        format!("读取 Pi 模型失败：{stderr}")
                    });
                }
                return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("读取 Pi 模型超时，请检查 Pi 是否可正常启动".to_string());
            }
            Err(error) => return Err(format!("读取 Pi 模型失败：{error}")),
        }
    }
}

fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            // 跳过 CSI 序列 ESC [ ... 终止字符。
            if chars.next() == Some('[') {
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() { break; }
                }
            }
            continue;
        }
        result.push(ch);
    }
    result
}

/// 解析 `pi --list-models` 的表格输出。兼容 `provider  model ...` 与 `provider/model` 两种形式。
fn parse_models(text: &str) -> Vec<PiModelProvider> {
    let text = strip_ansi(text);
    let mut providers: Vec<PiModelProvider> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('-') || line.starts_with('─') || line.starts_with('━') {
            continue;
        }
        let lowered = line.to_ascii_lowercase();
        if (lowered.contains("provider") && lowered.contains("model"))
            || lowered.starts_with("usage")
            || lowered.starts_with("available")
        {
            continue;
        }
        let columns: Vec<&str> = line
            .split(['\t', '|'])
            .flat_map(|part| part.split("  "))
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        let (provider, model) = if columns.len() >= 2 {
            (columns[0], columns[1])
        } else if let Some((provider, model)) = columns.first().and_then(|value| value.split_once('/')) {
            (provider.trim(), model.trim())
        } else {
            // 单空格分隔的表格作为兜底；至少要有 provider 与 model 两列。
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.len() < 2 {
                continue;
            }
            (tokens[0], tokens[1])
        };
        let provider = provider.trim_end_matches(':').trim();
        let model = model.trim();
        if provider.is_empty() || model.is_empty() || provider.contains(' ') || model.contains(' ') {
            continue;
        }
        let thinking = vec!["off".to_string(), "minimal".into(), "low".into(), "medium".into(), "high".into(), "xhigh".into(), "max".into()];
        match providers.iter_mut().find(|entry| entry.provider == provider) {
            Some(entry) => {
                if !entry.models.iter().any(|entry| entry.id == model) {
                    entry.models.push(PiModel { id: model.to_string(), thinking: thinking.clone() });
                }
            }
            None => providers.push(PiModelProvider {
                provider: provider.to_string(),
                models: vec![PiModel { id: model.to_string(), thinking }],
            }),
        }
    }
    providers
}

pub fn list_models(force: bool) -> Result<Vec<PiModelProvider>, String> {
    if !force {
        if let Ok(cache) = cache().lock() {
            if cache.fetched_at.is_some_and(|time| time.elapsed() < CACHE_TTL) {
                return Ok(cache.providers.clone());
            }
        }
    }
    let output = run_with_timeout(&mut pi_command()?, Duration::from_secs(15))?;
    let providers = parse_models(&output);
    if providers.is_empty() {
        return Err("Pi 没有返回可用模型，请先在终端运行 pi 并完成 /login".to_string());
    }
    if let Ok(mut cache) = cache().lock() {
        cache.fetched_at = Some(Instant::now());
        cache.providers = providers.clone();
    }
    Ok(providers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_table_and_deduplicates_models() {
        let providers = parse_models(
            "PROVIDER     MODEL                    CONTEXT\n\
             anthropic    claude-sonnet-4-5        200K\n\
             anthropic    claude-sonnet-4-5        200K\n\
             openai       gpt-5                    400K\n\
             openrouter   qwen/qwen3-coder         128K\n",
        );
        assert_eq!(providers.len(), 3);
        let anthropic = providers.iter().find(|entry| entry.provider == "anthropic").unwrap();
        assert_eq!(anthropic.models.len(), 1);
        assert_eq!(anthropic.models[0].id, "claude-sonnet-4-5");
        assert!(anthropic.models[0].thinking.contains(&"high".to_string()));
    }

    #[test]
    fn ignores_headers_and_empty_output() {
        assert!(parse_models("usage: pi --list-models").is_empty());
        assert!(parse_models("").is_empty());
    }
}
