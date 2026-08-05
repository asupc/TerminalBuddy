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

fn notification_content(
    terminal_name: &str,
    notification_kind: &str,
    custom_title: Option<&str>,
    custom_summary: Option<&str>,
) -> Result<(String, String), String> {
    let (fallback_title, fallback_summary) = match notification_kind {
        "confirmation" => ("Claude Code 等待确认", "需要你的确认"),
        "question" => ("Claude Code 等待回答", "有一个问题需要你回答"),
        "completed" => ("Claude Code 任务已完成", "已完成当前任务"),
        "failed" => ("Claude Code 任务执行失败", "未能完成当前任务"),
        _ => {
            return Err(format!(
                "无效的 Claude Code 通知类型: {}",
                notification_kind
            ))
        }
    };
    let title = custom_title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_title)
        .to_string();
    let summary = custom_summary
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_summary);
    let name = terminal_name.trim();
    let name = if name.is_empty() { "Claude Code" } else { name };
    Ok((title, format!("{}：{}", name, summary)))
}

#[tauri::command]
pub fn show_claude_code_notification(
    app: AppHandle,
    terminal_id: String,
    terminal_name: String,
    notification_kind: String,
    custom_title: Option<String>,
    custom_summary: Option<String>,
) -> Result<(), String> {
    let (title, body) = notification_content(
        &terminal_name,
        &notification_kind,
        custom_title.as_deref(),
        custom_summary.as_deref(),
    )?;
    // --no-bundle 产物没有安装器注册 AppUserModelID，需要在当前用户范围补充注册。
    let app_id = app.config().identifier.clone();
    ensure_portable_app_id(&app_id)?;
    let activated_app = app.clone();
    let activated_terminal_id = terminal_id.clone();

    Toast::new(&app_id)
        .title(&title)
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

#[cfg(test)]
mod tests {
    use super::notification_content;

    #[test]
    fn custom_task_content_is_used_and_terminal_name_prefixes_body() {
        let (title, body) = notification_content(
            "本地终端",
            "completed",
            Some("修复终端通知"),
            Some("已完成 Hook 状态和通知链路重构"),
        )
        .unwrap();

        assert_eq!(title, "修复终端通知");
        assert_eq!(body, "本地终端：已完成 Hook 状态和通知链路重构");
    }

    #[test]
    fn blank_custom_content_uses_generic_fallback() {
        let (title, body) =
            notification_content("terminal-buddy", "failed", Some("  "), Some("\n")).unwrap();

        assert_eq!(title, "Claude Code 任务执行失败");
        assert_eq!(body, "terminal-buddy：未能完成当前任务");
    }
}
