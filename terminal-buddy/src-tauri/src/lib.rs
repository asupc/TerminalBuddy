pub mod commands;
mod hook_client;
pub mod models;
pub mod services;
pub mod web;

use crate::web::handlers::claude_hook_handler::{
    answer_claude_hook_decision, continue_claude_hook_in_terminal,
    get_pending_claude_hook_decisions, send_claude_hook_decision_notification,
};
use commands::{
    acknowledge_terminal_output, check_app_update, close_terminal, connect_ssh_session,
    create_profile, delete_path, delete_profile,
    drain_terminal_output, ensure_dir, export_all_data, fetch_ark_usage,
    fetch_deepseek_usage, fetch_minimax_usage, fetch_qianfan_usage, get_all_profiles,
    get_app_settings, get_claude_sessions_for_terminals,
    get_command_templates, get_data_path, get_data_path_status, get_downloads_directory,
    get_file_meta, get_file_size,
    get_git_repository_status, get_profile, get_server_stats, get_ssh_home_dir,
    get_ssh_temp_directory, get_terminal_loading_mode,
    get_vscode_terminal_support, get_web_api_status, get_web_quick_access_url,
    get_web_server_address, get_windows_build_number, git_checkout_branch,
    git_commit_paths, git_get_changed_files, git_get_history, git_get_history_file_diff,
    git_get_history_files, git_list_branches, git_preview_push, git_pull, git_push_with_options,
    import_all_data,
    init_command_templates, list_directory, open_in_explorer, open_path,
    read_client_data, read_clipboard_file_paths,
    read_clipboard_image_as_file, read_file_content, remote_chmod, remote_copy, remote_create_dir,
    remote_create_file, remote_download, remote_download_dir, remote_list_dir, remote_move,
    remote_remove, remote_rename, remote_upload, rename_path, resize_terminal, restart_web_server,
    save_close_behavior, save_config_nav_width, save_enable_tab_navigation,
    save_file_nav_width, save_launch_at_login, save_launch_window_mode,
    save_server_monitor_interval, save_single_instance, save_ssh_download_dir,
    save_tab_sidebar_width, save_terminal_loading_mode, save_web_api_settings,
    set_data_path, show_claude_code_notification,
    start_blank_terminal, start_mstsc, start_terminal, sync_launch_at_login, update_profile,
    update_profile_last_used, update_terminal_display_name, window_close,
    window_exit_app, window_minimize, window_toggle_maximize, write_client_data,
    write_file_content, write_to_terminal,
};
use commands::{
    bot_scan_begin, bot_scan_poll, get_bot_callback_base_url,
    get_bot_long_connection_status, get_bot_settings, save_bot_settings, send_bot_notification,
    test_bot_channel, test_bot_decision_channel, verify_bot_channel,
};
use commands::{
    get_claude_hook_settings_status, install_claude_hooks, repair_claude_hooks,
    save_claude_hook_config_dir, uninstall_claude_hooks,
};
use commands::{MonitorCache, TerminalService};
use models::{CloseBehavior, LaunchWindowMode};
use services::{SettingsService, SshSessionService, WebServiceState};
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::Emitter;
use tauri::Manager;

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW, GWLP_WNDPROC,
    WM_ENDSESSION, WM_QUERYENDSESSION, WNDPROC,
};

pub use hook_client::{is_claude_hook_client_process, run_claude_hook_client};

/// 进程启动时间锚点；全链路启动日志统一以此为 0 点。
static BOOT_START: OnceLock<Instant> = OnceLock::new();
static MAIN_WINDOW_REVEALED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static MAIN_WINDOW_PROC: OnceLock<WNDPROC> = OnceLock::new();

fn boot_ms() -> u128 {
    BOOT_START
        .get()
        .map(|b| b.elapsed().as_millis())
        .unwrap_or(0)
}

/// 启动日志：同时输出到 stderr 和临时文件（temp_dir/terminalbuddy_boot.log），
/// 便于自动化启动后读取分析（不依赖终端重定向，dev/release 均生效）。
pub(crate) fn boot_log(msg: impl AsRef<str>) {
    let line = format!("[boot] rust+{}ms {}", boot_ms(), msg.as_ref());
    eprintln!("{}", line);
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("terminalbuddy_boot.log"))
    {
        let _ = writeln!(f, "{}", line);
    }
}

/// 前端通过 invoke 调用，把 JS 侧启动日志转发过来（与 Rust 日志并排写入同一文件，统一时间线）。
#[tauri::command]
fn log_boot(msg: String, ts: Option<f64>) {
    let js_ms = ts
        .map(|t| format!("{:.0}ms", t))
        .unwrap_or_else(|| "-".to_string());
    boot_log(format!("js+{} {}", js_ms, msg));
}

fn prepare_startup_window(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        boot_log("main window not found while preparing startup window");
        return;
    };

    let settings = SettingsService::get_settings();
    match settings.launch_window_mode {
        LaunchWindowMode::Windowed => {
            if let Err(e) = window.set_fullscreen(false) {
                boot_log(format!("set fullscreen false failed: {}", e));
            }
            if let Err(e) = window.unmaximize() {
                boot_log(format!("unmaximize failed: {}", e));
            }
            if let Err(e) = window.center() {
                boot_log(format!("center window failed: {}", e));
            }
            boot_log("startup window mode applied: windowed");
        }
        LaunchWindowMode::Maximized => {
            if let Err(e) = window.maximize() {
                boot_log(format!("maximize failed: {}", e));
            }
            boot_log("startup window mode applied: maximized");
        }
    }
}

/// 展示主窗口：取消最小化 + 显示 + 聚焦（托盘/单实例回调共用）。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn reveal_main_window(webview: &tauri::Webview) {
    if MAIN_WINDOW_REVEALED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }

    let window = webview.window();
    if let Err(e) = window.show() {
        MAIN_WINDOW_REVEALED.store(false, Ordering::Release);
        boot_log(format!("show window after page load failed: {}", e));
        return;
    }
    if let Err(e) = window.set_focus() {
        boot_log(format!("focus window after page load failed: {}", e));
    }
    boot_log("main window revealed after page load");
}

#[cfg(windows)]
unsafe extern "system" fn main_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_QUERYENDSESSION {
        commands::git::stop_git_commands();
    } else if message == WM_ENDSESSION {
        if wparam.0 == 0 {
            commands::git::resume_git_commands();
        } else {
            commands::git::stop_git_commands();
        }
    }

    if let Some(window_proc) = MAIN_WINDOW_PROC.get().and_then(|proc| *proc) {
        unsafe { CallWindowProcW(Some(window_proc), hwnd, message, wparam, lparam) }
    } else {
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }
}

#[cfg(windows)]
fn install_system_shutdown_handler(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        boot_log("main window not found while installing shutdown handler");
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        boot_log("main window handle unavailable while installing shutdown handler");
        return;
    };

    let previous_proc = unsafe { GetWindowLongPtrW(hwnd, GWLP_WNDPROC) };
    if previous_proc == 0 {
        boot_log("main window procedure unavailable while installing shutdown handler");
        return;
    }

    let previous_proc: WNDPROC = unsafe { std::mem::transmute(previous_proc) };
    if MAIN_WINDOW_PROC.set(previous_proc).is_err() {
        boot_log("shutdown handler was already installed");
        return;
    }

    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWLP_WNDPROC,
            main_window_proc as *const () as usize as isize,
        );
    }
    boot_log("system shutdown handler installed");
}

/// 托盘是否构建成功。`closeBehavior=tray` 的关闭行为在运行时据此降级。
static TRAY_AVAILABLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn tray_available() -> bool {
    TRAY_AVAILABLE.load(std::sync::atomic::Ordering::Relaxed)
}

/// 构建系统托盘：菜单（打开窗口/退出）+ 双击展示主窗口。
///
/// 托盘是辅助功能：任何一步失败只记 boot log 并返回 false，**不得**阻止
/// 主窗口启动。`closeBehavior=tray` 的设置在关闭时检测到托盘不可用会降级
/// 为直接退出，避免应用隐藏到无法恢复。
fn bootstrap_tray(app: &tauri::App) -> bool {
    use std::sync::atomic::Ordering;
    let result = (|| -> tauri::Result<()> {
        let show_item = MenuItemBuilder::with_id("show", "打开窗口").build(app)?;
        let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
        let menu = MenuBuilder::new(app)
            .item(&show_item)
            .item(&quit_item)
            .build()?;

        // default_window_icon 缺失不该 panic：没有图标就跳过托盘并记录
        let Some(icon) = app.default_window_icon().cloned() else {
            boot_log("tray skipped: default window icon unavailable");
            return Ok(());
        };

        let _tray = TrayIconBuilder::new()
            .icon(icon)
            .menu(&menu)
            .tooltip("TerminalBuddy")
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => show_main_window(app),
                "quit" => {
                    show_main_window(app);
                    let _ = app.emit("tray-exit-requested", ());
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                    show_main_window(tray.app_handle());
                }
            })
            .build(app)?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            TRAY_AVAILABLE.store(true, Ordering::Relaxed);
            boot_log("tray built");
            true
        }
        Err(error) => {
            boot_log(format!("tray build failed, continuing without tray: {error}"));
            false
        }
    }
}

/// Web API 或机器人回调任一需要时启动统一 HTTP 服务。
fn bootstrap_http_server(app: &tauri::AppHandle) -> std::io::Result<()> {
    let settings = SettingsService::get_settings();
    if settings.web_api_enabled || crate::services::BotSettingsService::requires_callback_server()
    {
        boot_log(format!(
            "starting HTTP server on port {}",
            settings.web_api_port
        ));
        crate::commands::web::sync_http_server_for_bot(app.clone()).map_err(std::io::Error::other)?;
        boot_log("HTTP server task spawned");
    }
    Ok(())
}

/// 同步机器人长连接任务（WebSocket 推送等）。
fn bootstrap_bot_connections(app: &tauri::AppHandle) -> std::io::Result<()> {
    crate::services::sync_bot_long_connections(app.clone()).map_err(std::io::Error::other)?;
    boot_log("Bot long-connection tasks synchronized");
    Ok(())
}

/// 修复并启动 Claude hook 本地 HTTP 服务（失败仅记录日志，不阻塞启动）。
fn bootstrap_claude_hook(app: &tauri::AppHandle) {
    match crate::services::repair_claude_http_hooks_if_managed(None) {
        Ok(status) => boot_log(format!("Claude hooks status: {}", status.status)),
        Err(error) => boot_log(format!("Claude hooks inspection failed: {}", error)),
    }
    match crate::web::claude_hook_server::bind() {
        Ok(listener) => {
            let port = crate::services::ClaudeHookService::server_port();
            tauri::async_runtime::spawn(crate::web::claude_hook_server::run(
                app.clone(),
                listener,
            ));
            boot_log(format!(
                "Claude hook HTTP server task spawned on port {}",
                port
            ));
        }
        Err(error) => boot_log(format!("Claude hook HTTP server disabled: {}", error)),
    }
}

pub fn run() {
    let _ = BOOT_START.set(Instant::now());
    boot_log("=== TerminalBuddy process start ===");
    let settings = SettingsService::get_settings();
    boot_log(format!(
        "settings loaded (single_instance={}, web_api_enabled={}, launch_window_mode={:?})",
        settings.single_instance, settings.web_api_enabled, settings.launch_window_mode
    ));

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(TerminalService::new())
        .manage(SshSessionService::new())
        .manage(WebServiceState::new())
        .manage(MonitorCache::new());

    if settings.single_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }));
    }

    builder
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                match webview.label() {
                    "main" => {
                        boot_log(format!("main page load finished: {}", payload.url()));
                        reveal_main_window(webview);
                    }
                    _ => {}
                }
            }
        })
        .setup(|app| {
            boot_log("setup enter");
            #[cfg(windows)]
            install_system_shutdown_handler(app);
            // 托盘构建失败只降级，不阻止主窗口启动
            bootstrap_tray(app);
            prepare_startup_window(app);

            // Sync launch_at_login setting with Windows Registry
            let _ = commands::sync_launch_at_login();
            boot_log("after sync_launch_at_login");

            bootstrap_http_server(app.handle())?;
            bootstrap_bot_connections(app.handle())?;
            bootstrap_claude_hook(app.handle());

            boot_log("setup done — waiting for WebView page load before showing window");
            Ok(())
        })
                .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 主窗口：根据设置决定"关闭到托盘"或真正退出
                if window.label() == "main" {
                    let settings = SettingsService::get_settings();
                    if settings.close_behavior == CloseBehavior::Tray && tray_available() {
                        api.prevent_close();
                        window.hide().ok();
                    }
                    // closeBehavior=tray 但托盘不可用：直接放行关闭（真退出），
                    // 避免应用被隐藏后用户无法找回。
                    // 若从未提示过，向前端发一次通知让用户知道行为变更。
                    else if settings.close_behavior == CloseBehavior::Tray {
                        use std::sync::atomic::Ordering;
                        static TRAY_FALLBACK_NOTIFIED: std::sync::atomic::AtomicBool =
                            std::sync::atomic::AtomicBool::new(false);
                        if !TRAY_FALLBACK_NOTIFIED.swap(true, Ordering::Relaxed) {
                            boot_log("close-to-tray requested but tray unavailable; exiting instead");
                            let _ = window.emit("tray-unavailable-exit", ());
                        }
                    }
                }
            }
        })

        .invoke_handler(tauri::generate_handler![
            get_all_profiles,
            get_profile,
            get_ssh_temp_directory,
            get_ssh_home_dir,
            create_profile,
            update_profile,
            delete_profile,
            update_profile_last_used,
            connect_ssh_session,
            start_terminal,
            start_mstsc,
            get_claude_sessions_for_terminals,
            show_claude_code_notification,
            check_app_update,
            get_bot_settings,
            get_bot_long_connection_status,
            get_bot_callback_base_url,
            save_bot_settings,
            send_bot_notification,
            test_bot_channel,
            verify_bot_channel,
            test_bot_decision_channel,
            bot_scan_begin,
            bot_scan_poll,
            answer_claude_hook_decision,
            continue_claude_hook_in_terminal,
            get_pending_claude_hook_decisions,
            send_claude_hook_decision_notification,
            get_claude_hook_settings_status,
            save_claude_hook_config_dir,
            install_claude_hooks,
            repair_claude_hooks,
            uninstall_claude_hooks,
            get_terminal_loading_mode,
            update_terminal_display_name,
            write_to_terminal,
            resize_terminal,
            acknowledge_terminal_output,
            close_terminal,
            start_blank_terminal,
            drain_terminal_output,
            list_directory,
            open_path,
            open_in_explorer,
            delete_path,
            rename_path,
            get_git_repository_status,
            git_list_branches,
            git_checkout_branch,
            git_pull,
            git_preview_push,
            git_push_with_options,
            git_get_changed_files,
            git_get_history_files,
            git_get_history_file_diff,
            git_commit_paths,
            git_get_history,
            remote_chmod,
            remote_copy,
            remote_create_dir,
            remote_create_file,
            remote_download,
            remote_download_dir,
            remote_list_dir,
            remote_move,
            remote_remove,
            remote_rename,
            remote_upload,
            read_clipboard_file_paths,
            read_clipboard_image_as_file,
            get_app_settings,
            get_vscode_terminal_support,
            save_close_behavior,
            save_launch_window_mode,
            save_terminal_loading_mode,
            get_data_path,
            get_data_path_status,
            set_data_path,
            save_tab_sidebar_width,
            save_config_nav_width,
            save_file_nav_width,
            save_enable_tab_navigation,
            save_single_instance,
            get_command_templates,
            init_command_templates,
            // 以下三个命令桌面端有真实调用（DataSettings 导入/导出全部数据）
            export_all_data,
            ensure_dir,
            import_all_data,
            get_windows_build_number,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_exit_app,
            fetch_qianfan_usage,
            fetch_deepseek_usage,
            fetch_minimax_usage,
            fetch_ark_usage,
            save_web_api_settings,
            get_web_api_status,
            restart_web_server,
            get_web_server_address,
            get_web_quick_access_url,
            read_file_content,
            write_file_content,
            get_file_size,
            get_file_meta,
            read_client_data,
            write_client_data,
            get_server_stats,
            get_downloads_directory,
            save_ssh_download_dir,
            save_server_monitor_interval,
            save_launch_at_login,
            sync_launch_at_login,
            log_boot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
