//! Claude 配置命令：项目发现 / Memory 浏览 / CLAUDE.md 编辑。
//! 业务逻辑在 `services::claude_config_service`，这里只做参数转接。

use super::claude_task;
use crate::services::claude_config_service::{self, ClaudeMemoryFile, ClaudeProjectInfo};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_claude_projects() -> Result<Vec<ClaudeProjectInfo>, String> {
    claude_task(move || Ok(claude_config_service::list_projects())).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_claude_memory_files(
    project_dir: String,
) -> Result<Vec<ClaudeMemoryFile>, String> {
    claude_task(move || claude_config_service::list_memory_files(&project_dir)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn read_claude_memory_file(
    project_dir: String,
    name: String,
) -> Result<String, String> {
    claude_task(move || claude_config_service::read_memory_file(&project_dir, &name)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn write_claude_memory_file(
    project_dir: String,
    name: String,
    content: String,
) -> Result<(), String> {
    claude_task(move || claude_config_service::write_memory_file(&project_dir, &name, &content))
        .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn create_claude_memory_file(
    project_dir: String,
    name: String,
    memory_type: String,
    description: String,
) -> Result<String, String> {
    claude_task(move || {
        claude_config_service::create_memory_file(&project_dir, &name, &memory_type, &description)
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_claude_memory_file(
    project_dir: String,
    name: String,
) -> Result<(), String> {
    claude_task(move || claude_config_service::delete_memory_file(&project_dir, &name)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn read_claude_md(kind: String, project_dir: String) -> Result<Option<String>, String> {
    claude_task(move || claude_config_service::read_claude_md(&kind, &project_dir)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn write_claude_md(
    kind: String,
    project_dir: String,
    content: String,
) -> Result<(), String> {
    claude_task(move || claude_config_service::write_claude_md(&kind, &project_dir, &content))
        .await
}
