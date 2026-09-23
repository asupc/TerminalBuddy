use tauri::{AppHandle, Manager, WebviewWindow};

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
    // 退出前统一收尾所有终端：注销 hook token、关闭 SSH session 与 Web 订阅者，
    // 并只向 PTY 发终止信号而不 wait，避免退出流程被 child.wait() 卡住。
    app.state::<crate::commands::TerminalService>()
        .shutdown_all_terminals(&app);
    // 逐终端 unregister 之后兜底释放剩余 pending decision 的 receiver/sender，
    // 退出时不遗留挂起的 hook 等待状态。
    crate::services::ClaudeHookService::release_all_on_shutdown();
    app.exit(0);
    Ok(())
}
