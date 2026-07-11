use tauri::{AppHandle, Emitter, Manager};
use tauri_winrt_notification::{Duration, Sound, Toast};
use windows_registry::CURRENT_USER;

fn ensure_portable_app_id(app_id: &str) -> Result<(), String> {
    let key = CURRENT_USER
        .create(format!(r"SOFTWARE\Classes\AppUserModelId\{}", app_id))
        .map_err(|error| format!("注册通知应用标识失败: {}", error))?;
    key.set_string("DisplayName", "TerminalBuddy")
        .map_err(|error| format!("设置通知应用名称失败: {}", error))?;
    key.set_string("IconBackgroundColor", "0")
        .map_err(|error| format!("设置通知图标背景失败: {}", error))?;
    Ok(())
}

#[tauri::command]
pub fn show_claude_code_notification(
    app: AppHandle,
    terminal_id: String,
    terminal_name: String,
    notification_kind: String,
) -> Result<(), String> {
    let (title, body) = match notification_kind.as_str() {
        "confirmation" => (
            "Claude Code 等待确认",
            format!("{} 需要你的确认", terminal_name),
        ),
        "question" => (
            "Claude Code 等待回答",
            format!("{} 有一个问题需要你回答", terminal_name),
        ),
        "completed" => (
            "Claude Code 任务已完成",
            format!("{} 已完成当前任务", terminal_name),
        ),
        _ => return Err(format!("无效的 Claude Code 通知类型: {}", notification_kind)),
    };
    // --no-bundle 产物没有安装器注册 AppUserModelID，需要在当前用户范围补充注册。
    let app_id = app.config().identifier.clone();
    ensure_portable_app_id(&app_id)?;
    let activated_app = app.clone();
    let activated_terminal_id = terminal_id.clone();

    Toast::new(&app_id)
        .title(title)
        .text1(&body)
        .sound(Some(Sound::Default))
        .duration(Duration::Short)
        .add_button("打开终端", "open-terminal")
        .on_activated(move |_| {
            if let Some(window) = activated_app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = activated_app.emit(
                "claude-notification-activated",
                activated_terminal_id.clone(),
            );
            Ok(())
        })
        .show()
        .map_err(|error| format!("发送 Claude Code 通知失败: {}", error))
}
