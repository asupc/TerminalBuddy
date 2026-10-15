use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const DPAPI_MARKER: &str = "dpapi:";
const SERVER_MARKER: &str = "aesgcm:";

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
    pub ssh_password: Option<String>,
    pub docker_container_id: Option<String>,
    pub docker_container_name: Option<String>,
    pub k8s_namespace: Option<String>,
    pub k8s_pod_name: Option<String>,
    pub k8s_container_name: Option<String>,
    pub mstsc_host: Option<String>,
    pub mstsc_port: Option<u16>,
    pub mstsc_user: Option<String>,
    pub mstsc_password: Option<String>,
    pub mstsc_resolution: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub pinned: bool,
}

impl Profile {
    /// Decrypt password fields after loading from disk (transparent decryption).
    pub fn decrypt_sensitive_fields(&mut self) {
        self.ssh_password = self.ssh_password.as_ref().and_then(|p| {
            decrypt_password(p)
                .ok()
                .filter(|d| !d.is_empty())
                .or_else(|| Some(p.clone()))
        });
        self.mstsc_password = self.mstsc_password.as_ref().and_then(|p| {
            decrypt_password(p)
                .ok()
                .filter(|d| !d.is_empty())
                .or_else(|| Some(p.clone()))
        });
    }

    /// Encrypt password fields before saving to disk (transparent encryption).
    pub fn encrypt_sensitive_fields(&mut self) -> Result<(), String> {
        let marker = if cfg!(feature = "desktop") { DPAPI_MARKER } else { SERVER_MARKER };
        for field in [&mut self.ssh_password, &mut self.mstsc_password] {
            if let Some(value) = field.as_ref().filter(|value| !value.is_empty()) {
                if value.starts_with(DPAPI_MARKER) || value.starts_with(SERVER_MARKER) {
                    // 不能解密的导入密文不得当作明文密码使用。
                    decrypt_password(value)?;
                    continue;
                }
                let encrypted = crate::services::crypto_service::encrypt_string(value)?;
                *field = Some(format!("{}{}", marker, encrypted));
            }
        }
        Ok(())
    }
}

fn decrypt_password(value: &str) -> Result<String, String> {
    if let Some(encoded) = value.strip_prefix(DPAPI_MARKER).or_else(|| value.strip_prefix(SERVER_MARKER)) {
        crate::services::crypto_service::decrypt_string(encoded)
    } else {
        Ok(value.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}
