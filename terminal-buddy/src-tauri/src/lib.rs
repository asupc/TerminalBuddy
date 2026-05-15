pub mod commands;
pub mod models;
pub mod services;

use commands::{get_all_profiles, get_profile, create_profile, update_profile, delete_profile, update_profile_last_used, export_all_profiles, import_all_profiles, start_terminal, write_to_terminal, resize_terminal, close_terminal, start_blank_terminal, list_directory, open_path, open_in_explorer, delete_path, rename_path, get_all_themes, create_theme, update_theme, delete_theme, read_clipboard_file_paths};
use commands::TerminalService;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TerminalService::new())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
