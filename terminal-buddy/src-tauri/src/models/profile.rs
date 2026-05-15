use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub group: String,
    #[serde(rename = "terminalType")]
    pub terminal_type: String,
    pub startup_path: String,
    pub startup_commands: Vec<String>,
    pub environment_variables: HashMap<String, String>,
    pub color_theme: String,
    pub tab_color: Option<String>,
    pub window_size: Option<WindowSize>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}
