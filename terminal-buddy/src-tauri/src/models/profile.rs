use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const DPAPI_MARKER: &str = "dpapi:";

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
}

impl Profile {
    /// Decrypt password fields after loading from disk (transparent decryption).
    pub fn decrypt_sensitive_fields(&mut self) {
        self.ssh_password = self.ssh_password.as_ref().and_then(|p| {
            decrypt_password(p).ok().filter(|d| !d.is_empty()).or_else(|| Some(p.clone()))
        });
        self.mstsc_password = self.mstsc_password.as_ref().and_then(|p| {
            decrypt_password(p).ok().filter(|d| !d.is_empty()).or_else(|| Some(p.clone()))
        });
    }

    /// Encrypt password fields before saving to disk (transparent encryption).
    pub fn encrypt_sensitive_fields(&mut self) {
        if let Some(ref p) = self.ssh_password {
            if !p.is_empty() && !p.starts_with(DPAPI_MARKER) {
                if let Ok(encrypted) = crate::services::crypto_service::encrypt_string(p) {
                    self.ssh_password = Some(format!("{}{}", DPAPI_MARKER, encrypted));
                }
            }
        }
        if let Some(ref p) = self.mstsc_password {
            if !p.is_empty() && !p.starts_with(DPAPI_MARKER) {
                if let Ok(encrypted) = crate::services::crypto_service::encrypt_string(p) {
                    self.mstsc_password = Some(format!("{}{}", DPAPI_MARKER, encrypted));
                }
            }
        }
    }
}

fn decrypt_password(value: &str) -> Result<String, String> {
    if let Some(encoded) = value.strip_prefix(DPAPI_MARKER) {
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
