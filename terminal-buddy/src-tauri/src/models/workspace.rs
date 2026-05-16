use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub groups: Vec<WorkspaceGroup>,
    pub created_at: String,
    pub last_used_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGroup {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub terminals: Vec<WorkspaceTerminal>,
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTerminal {
    pub profile_id: Option<String>,
    pub terminal_type: String,
    pub startup_path: Option<String>,
    pub startup_commands: Option<Vec<String>>,
    pub environment_variables: Option<std::collections::HashMap<String, String>>,
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
    pub color_theme: Option<String>,
    pub tab_color: Option<String>,
}
