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
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub ssh_auth_type: Option<String>,
    pub ssh_key_path: Option<String>,
    pub docker_container_id: Option<String>,
    pub docker_container_name: Option<String>,
    pub k8s_namespace: Option<String>,
    pub k8s_pod_name: Option<String>,
    pub k8s_container_name: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}
