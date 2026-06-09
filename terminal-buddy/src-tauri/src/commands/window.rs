use tauri::{AppHandle, WebviewWindow};

#[tauri::command]
pub fn get_windows_build_number() -> Result<u32, String> {
    let output = std::process::Command::new("cmd")
        .args(["/c", "ver"])
        .output()
        .map_err(|e| format!("Failed to run ver command: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Output looks like: "Microsoft Windows [Version 10.0.26200.5001]"
    // We want the third number (build number)
    let version_start = stdout
        .find("Version ")
        .ok_or_else(|| "Could not find version in ver output".to_string())?;
    let version_str = &stdout[version_start + 8..]; // skip "Version "
    let version_end = version_str.find(']').unwrap_or(version_str.len());
    let version = version_str[..version_end].trim();
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() >= 3 {
        parts[2].parse::<u32>().map_err(|e| format!("Failed to parse build number: {}", e))
    } else {
        Err(format!("Unexpected version format: {}", version))
    }
}

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) -> Result<(), String> {
    let is_max = window.is_maximized().map_err(|e| e.to_string())?;
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_exit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}
