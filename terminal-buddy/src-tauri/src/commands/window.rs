use tauri::Manager;
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

/// 创建或聚焦 AI 交付独立窗口。
///
/// 窗口关闭后 AI 交付任务继续在后台运行（由 AiDeliveryService 管理），
/// 再次调用此命令会重新打开窗口。
#[tauri::command]
pub fn open_ai_delivery_window(app: AppHandle) -> Result<(), String> {
    // AI 交付窗口在启动时由配置创建（hidden），此处仅显示/聚焦，避免运行时 build() 挂起
    if let Some(window) = app.get_webview_window("ai-delivery") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    Err("AI 交付窗口未初始化".to_string())
}
