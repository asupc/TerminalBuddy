//! Agent 管理（桌面端）：检测、安装与更新 Claude Code / Codex CLI。
//! 逻辑与 Docker 网页版 REST 接口共用 services/agent_cli_service.rs。
use crate::services::agent_cli_service::{self, CliTool, Environment, Operation};

fn parse_tool(tool: &str) -> Result<CliTool, String> {
    match tool {
        "claude" => Ok(CliTool::Claude),
        "codex" => Ok(CliTool::Codex),
        _ => Err(format!("未知的 Agent：{tool}")),
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_agent_cli_environment() -> Result<Environment, String> {
    agent_cli_service::environment()
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_agent_cli_status(tool: String, check_updates: bool) -> Result<agent_cli_service::CliStatus, String> {
    agent_cli_service::load_status(parse_tool(&tool)?, check_updates).await
        .map_err(|error| error.message().to_string())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn install_agent_cli(tool: String) -> Result<agent_cli_service::CliStatus, String> {
    agent_cli_service::start_operation(parse_tool(&tool)?, Operation::Install).await
        .map_err(|error| error.message().to_string())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_agent_cli(tool: String) -> Result<agent_cli_service::CliStatus, String> {
    agent_cli_service::start_operation(parse_tool(&tool)?, Operation::Update).await
        .map_err(|error| error.message().to_string())
}
