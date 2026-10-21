use crate::services::{
    get_claude_hook_settings_status as read_status, normalize_claude_config_dir,
    uninstall_claude_http_hooks_at, ClaudeHookSettingsStatus, SettingsService,
};

fn persist_config_dir(config_dir: &str) -> Result<String, String> {
    let normalized = normalize_claude_config_dir(config_dir)?;
    SettingsService::mutate_settings(|settings| {
        settings.claude_hook_config_dir = Some(normalized.clone());
    })?;
    Ok(normalized)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_claude_hook_settings_status(
    selected_dir: Option<String>,
) -> Result<ClaudeHookSettingsStatus, String> {
    read_status(selected_dir.as_deref())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_claude_hook_config_dir(selected_dir: Option<String>) -> Result<(), String> {
    let selected_dir = selected_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(selected_dir) = selected_dir {
        persist_config_dir(selected_dir)?;
    } else {
        SettingsService::mutate_settings(|settings| settings.claude_hook_config_dir = None)?;
    }
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn uninstall_claude_hooks(
    selected_dir: Option<String>,
) -> Result<ClaudeHookSettingsStatus, String> {
    let status = uninstall_claude_http_hooks_at(selected_dir.as_deref())?;
    persist_config_dir(&status.config_dir)?;
    Ok(status)
}
