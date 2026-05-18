use tauri::command;
use crate::models::workspace::Workspace;
use crate::services::WorkspaceService;

#[command]
pub fn get_all_workspaces() -> Result<Vec<Workspace>, String> {
    WorkspaceService::get_all_workspaces()
}

#[command]
pub fn get_workspace(id: String) -> Result<Workspace, String> {
    WorkspaceService::get_workspace(&id)
}

#[command]
pub fn create_workspace(name: String) -> Result<Workspace, String> {
    WorkspaceService::create_workspace(&name)
}

#[command]
pub fn update_workspace(workspace: Workspace) -> Result<(), String> {
    WorkspaceService::update_workspace(&workspace)
}

#[command]
pub fn delete_workspace(id: String) -> Result<(), String> {
    WorkspaceService::delete_workspace(&id)
}
