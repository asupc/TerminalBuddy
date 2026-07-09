pub mod commands;
pub mod models;
pub mod services;
pub mod web;

use commands::{get_all_profiles, get_profile, create_profile, update_profile, delete_profile, update_profile_last_used, export_all_profiles, import_all_profiles, connect_ssh_session, start_terminal, start_mstsc, get_claude_session_for_cwd, get_claude_session_for_terminal, get_claude_sessions_for_terminals, get_terminal_process_id, write_to_terminal, resize_terminal, close_terminal, start_blank_terminal, drain_terminal_output, peek_terminal_output, list_terminals, list_directory, open_path, open_in_explorer, delete_path, rename_path, get_git_repository_status, git_list_branches, git_checkout_branch, git_pull, git_push, git_push_with_options, git_commit_all, git_get_changed_files, git_commit_paths, git_get_history, get_all_themes, create_theme, update_theme, delete_theme, read_clipboard_file_paths, read_clipboard_image_as_file, get_app_settings, save_close_behavior, save_launch_window_mode, get_data_path, set_data_path, save_tab_sidebar_width, save_config_nav_width, save_file_nav_width, save_enable_tab_navigation, save_single_instance, get_all_workspaces, get_workspace, create_workspace, update_workspace, delete_workspace, get_command_templates, save_command_templates, init_command_templates, export_all_data, import_all_data, get_windows_build_number, window_minimize, window_toggle_maximize, window_close, window_exit_app, fetch_qianfan_usage, fetch_deepseek_usage, fetch_minimax_usage, fetch_ark_usage, save_web_api_settings, get_web_api_status, restart_web_server, get_web_server_address, get_web_quick_access_url, read_file_content, write_file_content, get_file_size, get_file_meta, read_client_data, write_client_data, ensure_dir, get_ssh_temp_directory, get_ssh_home_dir, get_downloads_directory, save_ssh_download_dir, save_server_monitor_interval, save_web_api_share_sessions, save_launch_at_login, sync_launch_at_login, remote_chmod, remote_copy, remote_create_dir, remote_create_file, remote_download, remote_download_dir, remote_list_dir, remote_move, remote_remove, remote_rename, remote_upload, get_server_stats};
use commands::{TerminalService, MonitorCache};
use models::{CloseBehavior, LaunchWindowMode};
use services::{SettingsService, SshSessionService, WebServiceState};
use tauri::Manager;
use tauri::Emitter;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use std::sync::OnceLock;
use std::time::Instant;
use std::fs::OpenOptions;
use std::io::Write;

/// 进程启动时间锚点；全链路启动日志统一以此为 0 点。
static BOOT_START: OnceLock<Instant> = OnceLock::new();

fn boot_ms() -> u128 {
    BOOT_START.get().map(|b| b.elapsed().as_millis()).unwrap_or(0)
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
    let js_ms = ts.map(|t| format!("{:.0}ms", t)).unwrap_or_else(|| "-".to_string());
    boot_log(format!("js+{} {}", js_ms, msg));
}

fn apply_startup_window_mode(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        boot_log("main window not found while applying startup window mode");
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

    if let Err(e) = window.show() {
        boot_log(format!("show window failed: {}", e));
    }
    if let Err(e) = window.set_focus() {
        boot_log(format!("focus window failed: {}", e));
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
        .manage(TerminalService::new())
        .manage(SshSessionService::new())
        .manage(WebServiceState::new())
        .manage(MonitorCache::new());

    if settings.single_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            boot_log("setup enter");
            let show_item = MenuItemBuilder::with_id("show", "打开窗口").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .item(&quit_item)
                .build()?;

            let icon = app.default_window_icon()
                .cloned()
                .expect("Failed to load default window icon for tray");

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("TerminalBuddy")
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                window.show().ok();
                                window.set_focus().ok();
                            }
                        }
                        "quit" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                window.show().ok();
                                window.set_focus().ok();
                            }
                            let _ = app.emit("tray-exit-requested", ());
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.unminimize();
                            window.show().ok();
                            window.set_focus().ok();
                        }
                    }
                })
                .build(app)?;
            boot_log("tray built");

            apply_startup_window_mode(app);

            // Sync launch_at_login setting with Windows Registry
            let _ = commands::sync_launch_at_login();
            boot_log("after sync_launch_at_login");

            // Conditionally start Web API server
            let app_handle = app.handle().clone();
            let settings_clone = SettingsService::get_settings();
            if settings_clone.web_api_enabled && !settings_clone.web_api_password_hash.is_empty() {
                boot_log(format!("starting Web API server on port {}", settings_clone.web_api_port));
                let jwt_secret = crate::web::auth::generate_jwt_secret();
                let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
                *crate::commands::web::SHUTDOWN_TX.lock().unwrap() = Some(shutdown_tx);
                *crate::commands::web::JWT_SECRET.lock().unwrap() = Some(jwt_secret.clone());

                tauri::async_runtime::spawn(crate::web::server::run_server(
                    settings_clone.web_api_port,
                    jwt_secret,
                    app_handle,
                    shutdown_rx,
                ));
                boot_log("Web API server task spawned");
            }

            boot_log("setup done — WebView about to load URL");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let settings = SettingsService::get_settings();
                if settings.close_behavior == CloseBehavior::Tray {
                    api.prevent_close();
                    window.hide().ok();
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
            export_all_profiles,
            import_all_profiles,
            connect_ssh_session,
            start_terminal,
            start_mstsc,
            get_claude_session_for_cwd,
            get_claude_session_for_terminal,
            get_claude_sessions_for_terminals,
            get_terminal_process_id,
            write_to_terminal,
            resize_terminal,
            close_terminal,
            start_blank_terminal,
            drain_terminal_output,
            peek_terminal_output,
            list_terminals,
            list_directory,
            open_path,
            open_in_explorer,
            delete_path,
            rename_path,
            get_git_repository_status,
            git_list_branches,
            git_checkout_branch,
            git_pull,
            git_push,
            git_push_with_options,
            git_commit_all,
            git_get_changed_files,
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
            get_all_themes,
            create_theme,
            update_theme,
            delete_theme,
            read_clipboard_file_paths,
            read_clipboard_image_as_file,
            get_app_settings,
            save_close_behavior,
            save_launch_window_mode,
            get_data_path,
            set_data_path,
            save_tab_sidebar_width,
            save_config_nav_width,
            save_file_nav_width,
            save_enable_tab_navigation,
            save_single_instance,
            get_all_workspaces,
            get_workspace,
            create_workspace,
            update_workspace,
            delete_workspace,
            get_command_templates,
            save_command_templates,
            init_command_templates,
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
            save_web_api_share_sessions,
            save_launch_at_login,
            sync_launch_at_login,
            log_boot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
