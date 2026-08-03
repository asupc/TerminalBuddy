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
    create_profile, create_workspace, delete_path, delete_profile, delete_workspace,
    drain_terminal_output, ensure_dir, export_all_data, export_all_profiles, fetch_ark_usage,
    fetch_deepseek_usage, fetch_minimax_usage, fetch_qianfan_usage, get_all_profiles,
    get_all_workspaces, get_app_settings, get_claude_session_for_cwd,
    get_claude_session_for_terminal, get_claude_sessions_for_terminals, get_command_templates,
    get_data_path, get_downloads_directory, get_file_meta, get_file_size,
    get_git_repository_status, get_profile, get_server_stats, get_ssh_home_dir,
    get_ssh_temp_directory, get_terminal_loading_mode, get_terminal_process_id,
    get_vscode_terminal_support, get_web_api_status, get_web_quick_access_url,
    get_web_server_address, get_windows_build_number, get_workspace, git_checkout_branch,
    git_commit_all, git_commit_paths, git_get_changed_files, git_get_history,
    git_get_history_file_diff, git_get_history_files, git_list_branches, git_preview_push,
    git_pull, git_push, git_push_with_options, import_all_data, import_all_profiles,
    init_command_templates, list_directory, list_terminals, open_in_explorer, open_path,
    peek_terminal_output, read_client_data, read_clipboard_file_paths,
    read_clipboard_image_as_file, read_file_content, remote_chmod, remote_copy, remote_create_dir,
    remote_create_file, remote_download, remote_download_dir, remote_list_dir, remote_move,
    remote_remove, remote_rename, remote_upload, rename_path, resize_terminal, restart_web_server,
    save_close_behavior, save_command_templates, save_config_nav_width, save_enable_tab_navigation,
    save_file_nav_width, save_launch_at_login, save_launch_window_mode,
    save_server_monitor_interval, save_single_instance, save_ssh_download_dir,
    save_tab_sidebar_width, save_terminal_loading_mode, save_web_api_settings,
    save_web_api_share_sessions, set_data_path, show_claude_code_notification,
    start_blank_terminal, start_mstsc, start_terminal, sync_launch_at_login, update_profile,
    update_profile_last_used, update_terminal_display_name, update_workspace, window_close,
    window_exit_app, window_minimize, window_toggle_maximize, open_ai_delivery_window, write_client_data,
    write_file_content, write_to_terminal,
};
use commands::{
    allocate_ai_task_worktree, create_ai_project, create_ai_task_contract, delete_ai_agent,
    delete_ai_project, delete_ai_role, delete_ai_runtime, delete_ai_workflow, detect_ai_runtimes,
    generate_ai_quality_gate_commands, get_ai_agents, get_ai_projects, get_ai_roles,
    get_ai_runtimes, get_ai_task_contracts, get_ai_workflows, refresh_ai_project_repositories,
    save_ai_agent, save_ai_role, save_ai_runtime, save_ai_workflow, update_ai_project,
};
use commands::{
    answer_ai_decision_request, approve_ai_delivery, cancel_ai_attempt, cancel_ai_delivery,
    cancel_ai_task_node, complete_ai_attempt, confirm_ai_policy_violation_site,
    continue_ai_merge_after_conflict, create_ai_delivery_template, delete_ai_delivery_template,
    list_ai_delivery_templates, mark_ai_task_skipped, save_ai_delivery_as_template,
    update_ai_delivery_template,
    cleanup_ai_delivery_integration, create_ai_decision_request, create_ai_delivery,
    create_ai_task_node, delete_ai_delivery, dispatch_ai_ready_tasks, dispatch_ai_task_node,
    delete_ai_task_node, update_ai_task_node,
    get_ai_attempts, read_ai_attempt_output, list_ai_delivery_artifacts, read_ai_delivery_artifact,
    export_ai_delivery_artifacts_zip, get_ai_decision_requests, get_ai_deliveries, get_ai_delivery_events,
    get_ai_merge_records, get_ai_review_gates, get_ai_task_nodes, merge_ai_delivery_locally,
    pause_ai_delivery, plan_ai_delivery_with_manager, refresh_ai_ready_task_nodes,
    replan_legacy_ai_delivery,
    resolve_ai_review_gate, resume_ai_delivery, retry_ai_task_node, run_ai_quality_gate,
    start_ai_attempt, update_ai_delivery, get_ai_review_diff, add_ai_review_line_comment,
    list_ai_startup_presets, create_ai_startup_preset, update_ai_startup_preset,
    delete_ai_startup_preset, test_ai_workflow_step, replan_ai_delivery_accepting_current_state,
};
use commands::{
    bot_scan_begin, bot_scan_poll, cancel_bot_decision, get_bot_callback_base_url,
    get_bot_long_connection_status, get_bot_settings, save_bot_settings, send_bot_notification,
    test_bot_channel, test_bot_decision_channel, verify_bot_channel,
};
use commands::{
    get_claude_hook_settings_status, install_claude_hooks, repair_claude_hooks,
    save_claude_hook_config_dir, uninstall_claude_hooks,
};
use commands::{MonitorCache, TerminalService};
// AiAgent 仅用于 debug 构建下的测试派发入口（见 setup 中的
// TERMINAL_BUDDY_TEST_DISPATCH_TASK_ID 分支），release 构建会编译掉该块。
#[cfg(debug_assertions)]
use models::ai_delivery::AiAgent;
use models::{CloseBehavior, LaunchWindowMode};
use services::{AiDeliveryService, SettingsService, SshSessionService, WebServiceState};
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
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                match webview.label() {
                    "main" => {
                        boot_log(format!("main page load finished: {}", payload.url()));
                        reveal_main_window(webview);
                    }
                    "ai-delivery" => {
                        boot_log("ai-delivery page load finished (hidden, shown on demand)");
                    }
                    _ => {}
                }
            }
        })
        .setup(|app| {
            boot_log("setup enter");
            // 注入全局 AppHandle：append_event 统一实时推送 ai-delivery-event
            let _ = services::ai_delivery_service::APP_HANDLE.set(app.handle().clone());
            #[cfg(windows)]
            install_system_shutdown_handler(app);
            let show_item = MenuItemBuilder::with_id("show", "打开窗口").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .item(&quit_item)
                .build()?;

            let icon = app
                .default_window_icon()
                .cloned()
                .expect("Failed to load default window icon for tray");

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("TerminalBuddy")
                .on_menu_event(|app, event| match event.id().as_ref() {
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

            prepare_startup_window(app);

            match AiDeliveryService::recover_interrupted_attempts() {
                Ok(0) => {}
                Ok(count) => boot_log(format!(
                    "recovered {} interrupted AI delivery attempts",
                    count
                )),
                Err(error) => boot_log(format!("AI delivery recovery failed: {}", error)),
            }

            // 重建活跃 attempt 内存索引（N18），此后容量检查不再逐次全量读盘。
            match AiDeliveryService::rebuild_active_attempt_index() {
                Ok(count) => boot_log(format!("active attempt index rebuilt: {} items", count)),
                Err(error) => boot_log(format!("active attempt index rebuild failed: {}", error)),
            }

            // 应用重启后，自动恢复运行中交付的就绪任务派发。
            let app_handle = app.handle().clone();
            let terminal_service = app.state::<TerminalService>().inner().clone();
            #[cfg(debug_assertions)]
            if let Ok(task_id) = std::env::var("TERMINAL_BUDDY_TEST_DISPATCH_TASK_ID") {
                if !task_id.trim().is_empty() {
                    let dispatch_handle = app_handle.clone();
                    let dispatch_terminal = terminal_service.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let result = (|| {
                            let runtime = AiDeliveryService::get_all_runtimes()?
                                .into_iter()
                                .find(|rt| rt.enabled && rt.kind.trim().eq_ignore_ascii_case("opencode"))
                                .ok_or_else(|| "未找到已启用的 OpenCode Runtime".to_string())?;
                            let agent = AiDeliveryService::get_all_agents()?
                                .into_iter()
                                .find(|a| a.enabled && a.runtime_id == runtime.id && a.runtime_args.iter().any(|arg| arg == "--auto"))
                                .map(Ok)
                                .unwrap_or_else(|| {
                                    AiDeliveryService::save_agent(AiAgent {
                                        id: String::new(),
                                        name: "OpenCode（免费模型）".to_string(),
                                        runtime_id: runtime.id,
                                        runtime_args: vec!["--auto".to_string()],
                                        startup_preset_name: Some("AI 交付自动批准".to_string()),
                                        max_concurrency: 1,
                                        enabled: true,
                                        default_timeout_seconds: None,
                                        created_at: String::new(),
                                        updated_at: String::new(),
                                    })
                                })?;
                            let existing = AiDeliveryService::get_task_node(&task_id)?;
                            let task = if matches!(existing.state.as_str(), "failed" | "rework" | "cancelled") {
                                AiDeliveryService::retry_task_node(&task_id)?
                            } else {
                                AiDeliveryService::refresh_ready_task_nodes(&existing.delivery_id)?;
                                AiDeliveryService::get_task_node(&task_id)?
                            };
                            let attempt = AiDeliveryService::dispatch_task_node(&task.id, Some(&agent.id))?;
                            AiDeliveryService::start_attempt(&attempt.id, dispatch_handle, dispatch_terminal)
                        })();
                        match result {
                            Ok(a) => boot_log(format!("test task dispatched: {}", a.id)),
                            Err(e) => boot_log(format!("test task dispatch failed: {}", e)),
                        }
                    });
                }
            }
            tauri::async_runtime::spawn_blocking(move || {
                for delivery in AiDeliveryService::get_all_deliveries(None).unwrap_or_default() {
                    if delivery.state != "running" {
                        continue;
                    }
                    match AiDeliveryService::dispatch_ready_and_start(
                        &delivery.id,
                        app_handle.clone(),
                        terminal_service.clone(),
                    ) {
                        Ok(started) => {
                            if started > 0 {
                                boot_log(format!(
                                    "auto-dispatched {} ready tasks for delivery {}",
                                    started,
                                    delivery.id
                                ));
                            }
                        }
                        Err(error) => {
                            boot_log(format!(
                                "auto-dispatch failed for delivery {}: {}",
                                delivery.id, error
                            ));
                        }
                    }
                }
            });

            // Sync launch_at_login setting with Windows Registry
            let _ = commands::sync_launch_at_login();
            boot_log("after sync_launch_at_login");

            // Web API 或机器人回调任一需要时启动统一 HTTP 服务。
            let app_handle = app.handle().clone();
            let settings_clone = SettingsService::get_settings();
            if settings_clone.web_api_enabled
                || crate::services::BotSettingsService::requires_callback_server()
            {
                boot_log(format!(
                    "starting HTTP server on port {}",
                    settings_clone.web_api_port
                ));
                crate::commands::web::sync_http_server_for_bot(app_handle)
                    .map_err(std::io::Error::other)?;
                boot_log("HTTP server task spawned");
            }
            crate::services::sync_bot_long_connections(app.handle().clone())
                .map_err(std::io::Error::other)?;
            boot_log("Bot long-connection tasks synchronized");

            match crate::services::repair_claude_http_hooks_if_managed(None) {
                Ok(status) => boot_log(format!("Claude hooks status: {}", status.status)),
                Err(error) => boot_log(format!("Claude hooks inspection failed: {}", error)),
            }
            match crate::web::claude_hook_server::bind() {
                Ok(listener) => {
                    let port = crate::services::ClaudeHookService::server_port();
                    tauri::async_runtime::spawn(crate::web::claude_hook_server::run(
                        app.handle().clone(),
                        listener,
                    ));
                    boot_log(format!(
                        "Claude hook HTTP server task spawned on port {}",
                        port
                    ));
                }
                Err(error) => boot_log(format!("Claude hook HTTP server disabled: {}", error)),
            }

            boot_log("setup done — waiting for WebView page load before showing window");
            Ok(())
        })
                .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 主窗口：根据设置决定"关闭到托盘"或真正退出
                if window.label() == "main" {
                    let settings = SettingsService::get_settings();
                    if settings.close_behavior == CloseBehavior::Tray {
                        api.prevent_close();
                        window.hide().ok();
                    }
                } else if window.label() == "ai-delivery" {
                    // AI 交付窗口关闭时仅隐藏，保留窗口以便再次打开；后台任务不受影响
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })

        .invoke_handler(tauri::generate_handler![
            get_ai_projects,
            create_ai_project,
            refresh_ai_project_repositories,
            update_ai_project,
            generate_ai_quality_gate_commands,
            delete_ai_project,
            detect_ai_runtimes,
            get_ai_runtimes,
            save_ai_runtime,
            delete_ai_runtime,
            get_ai_agents,
            save_ai_agent,
            delete_ai_agent,
            get_ai_roles,
            save_ai_role,
            delete_ai_role,
            get_ai_workflows,
            save_ai_workflow,
            delete_ai_workflow,
            get_ai_task_contracts,
            create_ai_task_contract,
            allocate_ai_task_worktree,
            get_ai_deliveries,
            create_ai_delivery,
            update_ai_delivery,
            plan_ai_delivery_with_manager,
            replan_legacy_ai_delivery,
            replan_ai_delivery_accepting_current_state,
            delete_ai_delivery,
            get_ai_task_nodes,
            create_ai_task_node,
            update_ai_task_node,
            delete_ai_task_node,
            approve_ai_delivery,
            pause_ai_delivery,
            resume_ai_delivery,
            cancel_ai_delivery,
            refresh_ai_ready_task_nodes,
            get_ai_delivery_events,
            get_ai_decision_requests,
            create_ai_decision_request,
            answer_ai_decision_request,
            get_ai_attempts,
            read_ai_attempt_output,
            list_ai_delivery_artifacts,
            read_ai_delivery_artifact,
            export_ai_delivery_artifacts_zip,
            dispatch_ai_task_node,
            dispatch_ai_ready_tasks,
            retry_ai_task_node,
            start_ai_attempt,
            cancel_ai_attempt,
            cancel_ai_task_node,
            mark_ai_task_skipped,
            confirm_ai_policy_violation_site,
            complete_ai_attempt,
            get_ai_review_gates,
            run_ai_quality_gate,
            resolve_ai_review_gate,
            get_ai_review_diff,
            add_ai_review_line_comment,
            list_ai_startup_presets,
            create_ai_startup_preset,
            update_ai_startup_preset,
            delete_ai_startup_preset,
            test_ai_workflow_step,
            get_ai_merge_records,
            merge_ai_delivery_locally,
            continue_ai_merge_after_conflict,
            cleanup_ai_delivery_integration,
            list_ai_delivery_templates,
            create_ai_delivery_template,
            update_ai_delivery_template,
            delete_ai_delivery_template,
            save_ai_delivery_as_template,
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
            cancel_bot_decision,
            answer_claude_hook_decision,
            continue_claude_hook_in_terminal,
            get_pending_claude_hook_decisions,
            send_claude_hook_decision_notification,
            get_claude_hook_settings_status,
            save_claude_hook_config_dir,
            install_claude_hooks,
            repair_claude_hooks,
            uninstall_claude_hooks,
            get_terminal_process_id,
            get_terminal_loading_mode,
            update_terminal_display_name,
            write_to_terminal,
            resize_terminal,
            acknowledge_terminal_output,
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
            git_preview_push,
            git_push_with_options,
            git_commit_all,
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
            open_ai_delivery_window,
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
