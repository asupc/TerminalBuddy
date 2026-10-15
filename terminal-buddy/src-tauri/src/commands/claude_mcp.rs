//! Claude MCP 命令：按作用域读写 + `claude mcp list` 连通探测。
//! 业务逻辑在 `services::claude_mcp_service`，这里只做参数转接。

use super::claude_task;
use crate::services::claude_mcp_service::{self, McpProbeStatus, McpServerConfig};
use serde_json::Value;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_claude_mcp_servers(
    scope: String,
    project_dir: Option<String>,
) -> Result<Vec<McpServerConfig>, String> {
    claude_task(move || claude_mcp_service::list_servers(&scope, project_dir.as_deref())).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_claude_mcp_server(
    scope: String,
    project_dir: Option<String>,
    name: String,
    config: Value,
) -> Result<(), String> {
    claude_task(move || {
        claude_mcp_service::save_server(&scope, project_dir.as_deref(), &name, config)
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_claude_mcp_server(
    scope: String,
    project_dir: Option<String>,
    name: String,
) -> Result<(), String> {
    claude_task(move || {
        claude_mcp_service::delete_server(&scope, project_dir.as_deref(), &name)
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_claude_mcp_config_path(
    scope: String,
    project_dir: Option<String>,
) -> Result<String, String> {
    claude_task(move || claude_mcp_service::config_path(&scope, project_dir.as_deref())).await
}

/// 连通探测：运行 `claude mcp list`，秒级到几十秒，必须在后台线程等。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn probe_claude_mcp(timeout_secs: Option<u64>) -> Result<Vec<McpProbeStatus>, String> {
    claude_task(move || claude_mcp_service::probe(timeout_secs.unwrap_or(60).clamp(5, 180))).await
}
