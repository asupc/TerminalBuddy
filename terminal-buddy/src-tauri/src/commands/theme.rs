use crate::models::CustomTheme;
use crate::services::ThemeService;
use tauri::command;

#[command]
pub fn get_all_themes() -> Result<Vec<CustomTheme>, String> {
    ThemeService::get_all_themes()
}

#[command]
pub fn create_theme(name: String) -> Result<CustomTheme, String> {
    ThemeService::create_theme(&name)
}

#[command]
pub fn update_theme(theme: CustomTheme) -> Result<(), String> {
    ThemeService::update_theme(&theme)
}

#[command]
pub fn delete_theme(id: String) -> Result<(), String> {
    ThemeService::delete_theme(&id)
}
