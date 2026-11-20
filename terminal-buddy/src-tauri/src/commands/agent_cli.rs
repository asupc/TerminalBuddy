//! Agent 管理（桌面端）：检测、安装与更新 Claude Code / Codex / Antigravity CLI。
//! 逻辑与 Docker 网页版 REST 接口共用 services/agent_cli_service.rs。
use super::claude_task;
use crate::services::agent_cli_service::{self, AntigravityModel, CliTool, Environment, Operation};

fn parse_tool(tool: &str) -> Result<CliTool, String> {
    match tool {
        "claude" => Ok(CliTool::Claude),
        "codex" => Ok(CliTool::Codex),
        "antigravity" => Ok(CliTool::Antigravity),
        _ => Err(format!("未知的 Agent：{tool}")),
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_agent_cli_environment() -> Result<Environment, String> {
    // 同步命令会在 UI 线程内联执行：检测要逐个启动 `--version` 并扫描安装目录，
    // 必须放到阻塞线程池，否则设置页一打开（以及安装期间每 2 秒轮询）整个窗口都会假死。
    claude_task(agent_cli_service::environment).await
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

/// 切换源时清理旧版本查询；安装任务执行期间不允许切换。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_agent_download_source(source: crate::models::AgentDownloadSource) -> Result<(), String> {
    claude_task(move || agent_cli_service::save_download_source(source)).await
}

/// 获取 Antigravity CLI 当前登录账号可用的模型列表（`agy models`）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_antigravity_models(refresh: Option<bool>) -> Result<Vec<AntigravityModel>, String> {
    let force = refresh.unwrap_or(false);
    claude_task(move || agent_cli_service::list_antigravity_models(force)).await
}
