use crate::models::CustomTheme;
use crate::services::PathService;
use std::fs;
use std::path::PathBuf;

pub struct ThemeService;

impl ThemeService {
    fn get_themes_dir() -> PathBuf {
        PathService::get_themes_dir()
    }

    pub fn get_all_themes() -> Result<Vec<CustomTheme>, String> {
        let dir = Self::get_themes_dir();
        let mut themes = Vec::new();

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map_or(false, |e| e == "json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(theme) = serde_json::from_str::<CustomTheme>(&content) {
                            themes.push(theme);
                        }
                    }
                }
            }
        }

        Ok(themes)
    }

    pub fn create_theme(name: &str) -> Result<CustomTheme, String> {
        let theme = CustomTheme::new(name);
        let path = Self::get_themes_dir().join(format!("{}.json", theme.id));
        let content = serde_json::to_string_pretty(&theme)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        Ok(theme)
    }

    pub fn update_theme(theme: &CustomTheme) -> Result<(), String> {
        let path = Self::get_themes_dir().join(format!("{}.json", theme.id));
        let content = serde_json::to_string_pretty(theme)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))
    }

    pub fn delete_theme(id: &str) -> Result<(), String> {
        let path = Self::get_themes_dir().join(format!("{}.json", id));
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete theme: {}", e))
    }
}
