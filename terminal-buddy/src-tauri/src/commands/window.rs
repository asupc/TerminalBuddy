use tauri::Manager;
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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
    // 窗口已存在时仅显示并聚焦
    if let Some(window) = app.get_webview_window("ai-delivery") {
        window.show().map_err(|e| e.to_string())?;
        let _ = window.unminimize();
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app,
        "ai-delivery",
        WebviewUrl::App("index.html#ai-delivery".into()),
    )
    .title("AI 交付")
    .inner_size(1200.0, 800.0)
    .min_inner_size(900.0, 520.0)
    .center()
    .visible(false) // 页面加载完成后由 on_page_load 回调显示
    .decorations(false)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}
