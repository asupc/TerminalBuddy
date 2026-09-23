use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehavior {
    Exit,
    Tray,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LaunchWindowMode {
    Windowed,
    Maximized,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalLoadingMode {
    Default,
    VsCode,
}

fn default_close_behavior() -> CloseBehavior {
    CloseBehavior::Exit
}

fn default_launch_window_mode() -> LaunchWindowMode {
    LaunchWindowMode::Windowed
}

fn default_terminal_loading_mode() -> TerminalLoadingMode {
    TerminalLoadingMode::Default
}

fn default_tab_sidebar_width() -> u32 {
    200
}

fn default_config_nav_width() -> u32 {
    250
}

fn default_file_nav_width() -> u32 {
    250
}

fn default_enable_tab_navigation() -> bool {
    true
}

fn default_single_instance() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_close_behavior")]
    pub close_behavior: CloseBehavior,
    #[serde(default = "default_launch_window_mode")]
    pub launch_window_mode: LaunchWindowMode,
    #[serde(default = "default_terminal_loading_mode")]
    pub terminal_loading_mode: TerminalLoadingMode,
    #[serde(default)]
    pub data_path: Option<String>,
    #[serde(default = "default_tab_sidebar_width")]
    pub tab_sidebar_width: u32,
    #[serde(default = "default_config_nav_width")]
    pub config_nav_width: u32,
    #[serde(default = "default_file_nav_width")]
    pub file_nav_width: u32,
    #[serde(default = "default_enable_tab_navigation")]
    pub enable_tab_navigation: bool,
    #[serde(default = "default_single_instance")]
    pub single_instance: bool,
    #[serde(default = "default_web_api_enabled")]
    pub web_api_enabled: bool,
    #[serde(default = "default_web_api_port")]
    pub web_api_port: u16,
    #[serde(default = "default_web_api_username")]
    pub web_api_username: String,
    #[serde(default = "default_web_api_password_hash")]
    pub web_api_password_hash: String,
    #[serde(default)]
    pub ssh_download_dir: Option<String>,
    #[serde(default = "default_server_monitor_interval")]
    pub server_monitor_interval: u32,
    #[serde(default)]
    pub web_api_share_sessions: bool,
    #[serde(default = "default_launch_at_login")]
    pub launch_at_login: bool,
    #[serde(default)]
    pub claude_hook_config_dir: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Exit,
            launch_window_mode: LaunchWindowMode::Windowed,
            terminal_loading_mode: TerminalLoadingMode::Default,
            data_path: None,
            tab_sidebar_width: 200,
            config_nav_width: 250,
            file_nav_width: 250,
            enable_tab_navigation: true,
            single_instance: true,
            web_api_enabled: false,
            web_api_port: 9600,
            web_api_username: "admin".to_string(),
            web_api_password_hash: String::new(),
            ssh_download_dir: None,
            server_monitor_interval: 3,
            web_api_share_sessions: false,
            launch_at_login: false,
            claude_hook_config_dir: None,
        }
    }
}

fn default_web_api_enabled() -> bool {
    false
}

fn default_web_api_port() -> u16 {
    9600
}

fn default_web_api_username() -> String {
    "admin".to_string()
}

fn default_web_api_password_hash() -> String {
    String::new()
}

fn default_server_monitor_interval() -> u32 {
    3
}

fn default_launch_at_login() -> bool {
    false
}
