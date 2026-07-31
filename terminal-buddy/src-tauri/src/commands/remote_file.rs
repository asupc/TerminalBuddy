use crate::models::ssh_types::RemoteFileEntry;
use crate::services::profile_service::ProfileService;
use crate::services::ssh_session_service::SshSessionService;
use tauri::{command, AppHandle, State};

/// Escape a path for safe use in shell commands (single-quote wrapping).
fn shell_escape(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

#[command]
pub fn connect_ssh_session(
    terminal_id: String,
    profile_id: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    let profile = ProfileService::get_profile(&profile_id)?;
    ssh_service.get_or_create_session(&terminal_id, &profile)
}

#[command]
pub fn remote_list_dir(
    terminal_id: String,
    path: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<Vec<RemoteFileEntry>, String> {
    ssh_service.list_dir(&terminal_id, &path)
}

#[command]
pub fn remote_create_dir(
    terminal_id: String,
    path: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.mkdir(&terminal_id, &path)
}

#[command]
pub fn remote_create_file(
    terminal_id: String,
    path: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    let cmd = format!("touch {}", shell_escape(&path));
    ssh_service.exec(&terminal_id, &cmd)?;
    Ok(())
}

#[command]
pub fn remote_remove(
    terminal_id: String,
    path: String,
    is_dir: bool,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.remove(&terminal_id, &path, is_dir)
}

#[command]
pub fn remote_rename(
    terminal_id: String,
    from: String,
    to: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.rename(&terminal_id, &from, &to)
}

#[command]
pub fn remote_move(
    terminal_id: String,
    from: String,
    to: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    let cmd = format!("mv {} {}", shell_escape(&from), shell_escape(&to));
    ssh_service.exec(&terminal_id, &cmd)?;
    Ok(())
}

#[command]
pub fn remote_copy(
    terminal_id: String,
    from: String,
    to: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    let cmd = format!("cp -r {} {}", shell_escape(&from), shell_escape(&to));
    ssh_service.exec(&terminal_id, &cmd)?;
    Ok(())
}

#[command]
pub fn remote_chmod(
    terminal_id: String,
    path: String,
    mode: i32,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.chmod(&terminal_id, &path, mode)
}

#[command]
pub fn remote_download(
    terminal_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    profile_id: String,
    app: AppHandle,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    if profile_id.is_empty() {
        return Err("profileId is empty".to_string());
    }
    let profile = ProfileService::get_profile(&profile_id)?;
    ssh_service.download_async(
        &transfer_id,
        &terminal_id,
        &remote_path,
        &local_path,
        profile,
        app,
    )
}

#[command]
pub fn remote_download_dir(
    terminal_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    profile_id: String,
    app: AppHandle,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    if profile_id.is_empty() {
        return Err("profileId is empty".to_string());
    }
    let profile = ProfileService::get_profile(&profile_id)?;
    ssh_service.download_dir_async(
        &transfer_id,
        &terminal_id,
        &remote_path,
        &local_path,
        profile,
        app,
    )
}

#[command]
pub fn remote_upload(
    terminal_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    profile_id: String,
    app: AppHandle,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    if profile_id.is_empty() {
        return Err("profileId is empty".to_string());
    }
    let profile = ProfileService::get_profile(&profile_id)?;
    ssh_service.upload_async(
        &transfer_id,
        &terminal_id,
        &local_path,
        &remote_path,
        profile,
        app,
    )
}

#[command]
pub fn get_ssh_home_dir(
    terminal_id: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<String, String> {
    ssh_service.get_home_dir(&terminal_id)
}

#[command]
pub fn get_ssh_temp_directory() -> Result<String, String> {
    Ok(std::env::temp_dir()
        .join("TerminalBuddy")
        .join("ssh_edit")
        .to_string_lossy()
        .to_string())
}

#[command]
pub fn ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {}", e))
}
