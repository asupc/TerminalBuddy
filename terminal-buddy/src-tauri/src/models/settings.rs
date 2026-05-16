use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehavior {
    Exit,
    Tray,
}

fn default_close_behavior() -> CloseBehavior {
    CloseBehavior::Exit
}

fn default_tab_sidebar_width() -> u32 {
    200
}

fn default_enable_tab_navigation() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_close_behavior")]
    pub close_behavior: CloseBehavior,
    #[serde(default)]
    pub data_path: Option<String>,
    #[serde(default = "default_tab_sidebar_width")]
    pub tab_sidebar_width: u32,
    #[serde(default = "default_enable_tab_navigation")]
    pub enable_tab_navigation: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Exit,
            data_path: None,
            tab_sidebar_width: 200,
            enable_tab_navigation: true,
        }
    }
}
