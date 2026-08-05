use tauri::{AppHandle, WebviewWindow};

/// Direct ntdll call — pure in-memory, no process spawn, takes microseconds.
#[allow(non_snake_case)]
#[repr(C)]
struct OSVERSIONINFOW {
    dwOSVersionInfoSize: u32,
    dwMajorVersion: u32,
    dwMinorVersion: u32,
    dwBuildNumber: u32,
    dwPlatformId: u32,
    szCSDVersion: [u16; 128],
}

#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
}

#[tauri::command]
pub fn get_windows_build_number() -> Result<u32, String> {
    unsafe {
        let mut info: OSVERSIONINFOW = std::mem::zeroed();
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        let status = RtlGetVersion(&mut info);
        if status >= 0 {
            Ok(info.dwBuildNumber)
        } else {
            Err(format!("RtlGetVersion failed with status {}", status))
        }
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
