use crate::models::workspace::Workspace;
use crate::services::WorkspaceService;

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_all_workspaces() -> Result<Vec<Workspace>, String> {
    WorkspaceService::get_all_workspaces()
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_workspace(id: String) -> Result<Workspace, String> {
    WorkspaceService::get_workspace(&id)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn create_workspace(name: String) -> Result<Workspace, String> {
    WorkspaceService::create_workspace(&name)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn update_workspace(workspace: Workspace) -> Result<(), String> {
    WorkspaceService::update_workspace(&workspace)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn delete_workspace(id: String) -> Result<(), String> {
    WorkspaceService::delete_workspace(&id)
}
