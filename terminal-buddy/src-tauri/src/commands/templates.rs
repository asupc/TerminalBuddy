use crate::services::TemplateService;

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_command_templates() -> String {
    TemplateService::get_templates()
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_command_templates(content: String) -> Result<(), String> {
    TemplateService::save_templates(&content)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn init_command_templates(default_content: String) -> Result<bool, String> {
    TemplateService::init_templates_if_missing(&default_content)
}
