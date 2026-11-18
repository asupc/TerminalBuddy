use crate::services::remote_workspace_service::{
    ConnectRemoteWorkspaceInput, RemoteLoginInput, RemoteWorkspaceService, RemoteWorkspaceState,
};
use tauri::State;

#[tauri::command]
pub fn get_remote_workspace_state(service: State<'_, RemoteWorkspaceService>) -> RemoteWorkspaceState {
    service.state()
}

#[tauri::command]
pub fn get_remote_workspace_proxy(service: State<'_, RemoteWorkspaceService>) -> Result<String, String> {
    service.start_proxy()?;
    service.proxy_origin()
}

#[tauri::command]
pub async fn connect_remote_workspace(
    input: ConnectRemoteWorkspaceInput,
    service: State<'_, RemoteWorkspaceService>,
) -> Result<RemoteWorkspaceState, String> {
    service.connect(input).await
}

#[tauri::command]
pub async fn authenticate_remote_workspace(
    input: RemoteLoginInput,
    service: State<'_, RemoteWorkspaceService>,
) -> Result<RemoteWorkspaceState, String> {
    service.authenticate(input).await
}

#[tauri::command]
pub async fn activate_remote_workspace(service: State<'_, RemoteWorkspaceService>) -> Result<RemoteWorkspaceState, String> {
    service.activate().await
}

#[tauri::command]
pub fn set_remote_workspace_active(active: bool, service: State<'_, RemoteWorkspaceService>) -> Result<(), String> {
    service.set_active(active)
}

#[tauri::command]
pub fn disconnect_remote_workspace(service: State<'_, RemoteWorkspaceService>) -> Result<(), String> {
    service.disconnect()
}

#[tauri::command]
pub fn get_remote_workspace_quick_access_url(service: State<'_, RemoteWorkspaceService>) -> Result<String, String> {
    service.quick_access_url()
}

/// 文件传输全程使用 tokio 异步流，不在 async 线程中做同步阻塞读写。
#[tauri::command]
pub async fn upload_remote_workspace_files(
    paths: Vec<String>,
    service: State<'_, RemoteWorkspaceService>,
) -> Result<Vec<String>, String> {
    service.upload(paths).await
}

#[tauri::command]
pub async fn download_remote_workspace_file(
    path: String,
    destination: String,
    service: State<'_, RemoteWorkspaceService>,
) -> Result<(), String> {
    service.download(path, destination).await
}
