pub mod commands;
pub mod models;
pub mod services;

use commands::{get_all_profiles, get_profile, create_profile, update_profile, delete_profile, update_profile_last_used, export_all_profiles, import_all_profiles, start_terminal, write_to_terminal, resize_terminal, close_terminal, start_blank_terminal, drain_terminal_output, list_directory, open_path, open_in_explorer, delete_path, rename_path, get_all_themes, create_theme, update_theme, delete_theme, read_clipboard_file_paths, get_app_settings, save_close_behavior};
use commands::TerminalService;
use models::CloseBehavior;
use services::SettingsService;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TerminalService::new())
        .setup(|app| {
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
                                window.show().ok();
                                window.set_focus().ok();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            window.show().ok();
                            window.set_focus().ok();
                        }
                    }
                })
                .build(app)?;

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
            create_profile,
            update_profile,
            delete_profile,
            update_profile_last_used,
            export_all_profiles,
            import_all_profiles,
            start_terminal,
            write_to_terminal,
            resize_terminal,
            close_terminal,
            start_blank_terminal,
            drain_terminal_output,
            list_directory,
            open_path,
            open_in_explorer,
            delete_path,
            rename_path,
            get_all_themes,
            create_theme,
            update_theme,
            delete_theme,
            read_clipboard_file_paths,
            get_app_settings,
            save_close_behavior,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
