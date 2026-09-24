//! Claude MCP 管理：用户级（~/.claude.json 的 mcpServers）与项目级（<proj>/.mcp.json），
//! 以及 `claude mcp list` 连通探测（该命令无 --json，按行解析，解析器带单测）。
//!
//! ~/.claude.json 还承载登录态等大量其它字段：整体读为 Value，只动 mcpServers 键，
//! 解析失败直接报错不写回，杜绝把配置写坏。

use crate::services::atomic_write;
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    /// "stdio" | "sse" | "http"
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    /// 原始配置对象（编辑回写用）
    pub raw: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpProbeStatus {
    pub name: String,
    /// "connected" | "pending" | "failed" | "unknown"
    pub status: String,
    pub detail: String,
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

fn mcp_config_path(scope: &str, project_dir: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "user" => dirs::home_dir()
            .map(|home| home.join(".claude.json"))
            .ok_or_else(|| "无法获取用户主目录".to_string()),
        "project" => {
            let dir = project_dir.ok_or("项目级操作缺少项目路径")?;
            if !PathBuf::from(dir).is_absolute() {
                return Err("非法项目路径".to_string());
            }
            Ok(PathBuf::from(dir).join(".mcp.json"))
        }
        other => Err(format!("未知作用域: {}", other)),
    }
}

fn validate_server_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err("服务器名称只能包含字母、数字、下划线、连字符、点".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 解析（纯函数，可测）
// ---------------------------------------------------------------------------

fn infer_transport(config: &Value) -> String {
    match config.get("type").and_then(Value::as_str) {
        Some("sse") => "sse".to_string(),
        Some("http") => "http".to_string(),
        Some("stdio") => "stdio".to_string(),
        _ => {
            if config.get("url").is_some() {
                "http".to_string()
            } else {
                "stdio".to_string()
            }
        }
    }
}

fn servers_from_map(map: &Map<String, Value>) -> Vec<McpServerConfig> {
    let mut result: Vec<McpServerConfig> = map
        .iter()
        .filter_map(|(name, config)| {
            let config = config.as_object()?;
            let raw = Value::Object(config.clone());
            let server = McpServerConfig {
                name: name.clone(),
                transport: infer_transport(&raw),
                command: config
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                args: config
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                url: config.get("url").and_then(Value::as_str).map(str::to_string),
                raw,
            };
            Some(server)
        })
        .collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

/// 解析 `claude mcp list` 文本输出（实测格式，无 --json）：
/// ```text
/// Checking MCP server health…
/// codegraph: codegraph serve --mcp - ✔ Connected
/// dbhub: http://192.168.77.24:8484/mcp (HTTP) - ✔ Connected
/// demo: ... - ⏸ Pending approval / ✖ Failed
/// ```
pub fn parse_mcp_list_output(text: &str) -> Vec<McpProbeStatus> {
    let mut result = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 状态取最后一个「 - 」之后（detail 内也可能出现该分隔符，从右切）
        let Some((head, status_raw)) = line.rsplit_once(" - ") else {
            continue; // "Checking MCP server health…" 等提示行
        };
        let Some((name, detail)) = head.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let status = if status_raw.contains("Connected") {
            "connected"
        } else if status_raw.contains("Pending approval") {
            "pending"
        } else if status_raw.contains("Failed") {
            "failed"
        } else {
            "unknown"
        };
        result.push(McpProbeStatus {
            name: name.to_string(),
            status: status.to_string(),
            detail: detail.trim().to_string(),
        });
    }
    result
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

fn load_config_file(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let content = fs::read_to_string(path).map_err(|error| format!("读取 MCP 配置失败: {}", error))?;
    if content.trim().is_empty() {
        return Ok(Map::new());
    }
    serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("MCP 配置不是合法 JSON（未做任何修改）: {}", error))?
        .as_object()
        .cloned()
        .ok_or_else(|| "MCP 配置顶层必须是对象（未做任何修改）".to_string())
}

fn save_config_file(path: &Path, root: &Map<String, Value>) -> Result<(), String> {
    let content = serde_json::to_string_pretty(&Value::Object(root.clone()))
        .map_err(|error| format!("序列化 MCP 配置失败: {}", error))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {}", error))?;
    }
    atomic_write(path, content.as_bytes()).map_err(|error| format!("保存 MCP 配置失败: {}", error))
}

pub fn list_servers(scope: &str, project_dir: Option<&str>) -> Result<Vec<McpServerConfig>, String> {
    let path = mcp_config_path(scope, project_dir)?;
    let root = load_config_file(&path)?;
    match root.get("mcpServers") {
        Some(Value::Object(map)) => Ok(servers_from_map(map)),
        Some(_) => Err("mcpServers 字段不是对象（未做任何修改）".to_string()),
        None => Ok(Vec::new()),
    }
}

pub fn save_server(
    scope: &str,
    project_dir: Option<&str>,
    name: &str,
    config: Value,
) -> Result<(), String> {
    validate_server_name(name)?;
    if !config.is_object() {
        return Err("服务器配置必须是 JSON 对象".to_string());
    }
    let path = mcp_config_path(scope, project_dir)?;
    let mut root = load_config_file(&path)?;
    let entry = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let map = entry
        .as_object_mut()
        .ok_or("mcpServers 字段不是对象（未做任何修改）")?;
    map.insert(name.trim().to_string(), config);
    save_config_file(&path, &root)
}

pub fn delete_server(scope: &str, project_dir: Option<&str>, name: &str) -> Result<(), String> {
    let path = mcp_config_path(scope, project_dir)?;
    let mut root = load_config_file(&path)?;
    let removed = root
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .map(|map| map.remove(name.trim()).is_some())
        .unwrap_or(false);
    if !removed {
        return Err("该作用域下没有这个服务器".to_string());
    }
    save_config_file(&path, &root)
}

/// 配置文件路径（前端「在资源管理器显示配置」用）
pub fn config_path(scope: &str, project_dir: Option<&str>) -> Result<String, String> {
    mcp_config_path(scope, project_dir)?
        .to_str()
        .map(String::from)
        .ok_or_else(|| "路径不可用".to_string())
}

// ---------------------------------------------------------------------------
// 连通探测
// ---------------------------------------------------------------------------

/// 运行 `claude mcp list` 并解析。同步轮询带超时，防 CLI 卡死占住线程。
pub fn probe(timeout_secs: u64) -> Result<Vec<McpProbeStatus>, String> {
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("cmd");
        command.args(["/C", "claude", "mcp", "list"]);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(windows))]
    let mut command = Command::new("claude");
    #[cfg(not(windows))]
    {
        command.args(["mcp", "list"]);
    }

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 claude CLI 失败（需在 PATH 中）: {}", error))?;

    let started = Instant::now();
    let (stdout_text, stderr_text) = loop {
        match child
            .try_wait()
            .map_err(|error| format!("检测 claude mcp list 状态失败: {}", error))?
        {
            Some(status) => {
                let mut stdout_text = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut stdout_text);
                }
                let mut stderr_text = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut stderr_text);
                }
                if !status.success() && stdout_text.trim().is_empty() {
                    return Err(format!(
                        "claude mcp list 失败（退出码 {:?}）：{}",
                        status.code(),
                        stderr_text.trim().chars().take(300).collect::<String>()
                    ));
                }
                break (stdout_text, stderr_text);
            }
            None => {
                if started.elapsed() > Duration::from_secs(timeout_secs) {
                    let _ = child.kill();
                    return Err(format!("检测超时（claude mcp list 未在 {}s 内返回）", timeout_secs));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    };

    let mut statuses = parse_mcp_list_output(&stdout_text);
    // 有的版本把结果打到 stderr：stdout 解析不出再试 stderr
    if statuses.is_empty() {
        statuses = parse_mcp_list_output(&stderr_text);
    }
    Ok(statuses)
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_real_world_output() {
        let text = concat!(
            "Checking MCP server health…\n",
            "codegraph: codegraph serve --mcp - ✔ Connected\n",
            "playwright: cmd /c npx @playwright/mcp@latest - ✔ Connected\n",
            "dbhub: http://192.168.77.24:8484/mcp (HTTP) - ✔ Connected\n",
            "demo-sse: http://localhost:3001/sse (SSE) - ✖ Failed: connect ECONNREFUSED\n",
            "pending-one: npx something - ⏸ Pending approval\n",
        );
        let statuses = parse_mcp_list_output(text);
        assert_eq!(statuses.len(), 5);
        assert_eq!(
            statuses[0],
            McpProbeStatus {
                name: "codegraph".into(),
                status: "connected".into(),
                detail: "codegraph serve --mcp".into(),
            }
        );
        assert_eq!(statuses[1].name, "playwright");
        assert_eq!(statuses[1].detail, "cmd /c npx @playwright/mcp@latest");
        assert_eq!(statuses[2].name, "dbhub");
        assert_eq!(statuses[2].status, "connected");
        assert_eq!(statuses[3].status, "failed");
        assert_eq!(statuses[4].status, "pending");
    }

    #[test]
    fn parse_skips_noise_lines() {
        let text = "\nSome other note without separator\nname-no-colon - ✔ Connected\n\n";
        assert!(parse_mcp_list_output(text).is_empty());
    }

    #[test]
    fn transport_inference() {
        assert_eq!(infer_transport(&json!({"command": "npx", "args": ["x"]})), "stdio");
        assert_eq!(infer_transport(&json!({"type": "http", "url": "https://a/mcp"})), "http");
        assert_eq!(infer_transport(&json!({"type": "sse", "url": "https://a/sse"})), "sse");
        assert_eq!(infer_transport(&json!({"url": "https://a/mcp"})), "http");
    }

    #[test]
    fn save_and_delete_roundtrip_preserves_other_keys() {
        let dir = std::env::temp_dir().join(format!("tb-mcp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".mcp.json");
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({"otherKey": 42, "mcpServers": {"old": {"command": "x"}}}))
                .unwrap(),
        )
        .unwrap();

        let root = load_config_file(&path).unwrap();
        assert_eq!(root.get("otherKey"), Some(&json!(42)));

        // 直接驱动内部函数验证保留语义
        let mut root2 = load_config_file(&path).unwrap();
        root2
            .get_mut("mcpServers")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("new".into(), json!({"type": "http", "url": "https://x/mcp"}));
        save_config_file(&path, &root2).unwrap();

        let servers = servers_from_map(
            load_config_file(&path)
                .unwrap()
                .get("mcpServers")
                .unwrap()
                .as_object()
                .unwrap(),
        );
        assert_eq!(servers.len(), 2);
        assert!(servers.iter().any(|server| server.name == "new" && server.transport == "http"));
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["otherKey"], json!(42), "其它键必须保留");

        let _ = fs::remove_dir_all(&dir);
    }
}
