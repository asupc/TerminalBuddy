use crate::models::Profile;
use crate::services::PathService;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
}

pub struct ProfileService;

impl ProfileService {
    fn get_profiles_dir() -> PathBuf {
        PathService::get_profiles_dir()
    }

    pub fn get_all_profiles() -> Result<Vec<Profile>, String> {
        let dir = Self::get_profiles_dir();
        let mut profiles = Vec::new();

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map_or(false, |e| e == "json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(profile) = serde_json::from_str::<Profile>(&content) {
                            // Deduplicate by ID (old {id}.json and new {name}.json may coexist)
                            if !profiles.iter().any(|p: &Profile| p.id == profile.id) {
                                profiles.push(profile);
                            }
                        }
                    }
                }
            }
        }

        Ok(profiles)
    }

    pub fn get_profile(id: &str) -> Result<Profile, String> {
        let profiles = Self::get_all_profiles()?;
        profiles.into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("Profile not found: {}", id))
    }

    fn find_profile_by_name(name: &str) -> Option<Profile> {
        Self::get_all_profiles().ok().and_then(|profiles| {
            profiles.into_iter().find(|p| p.name == name)
        })
    }

    pub fn create_profile(name: &str, group: &str, terminal_type: &str) -> Result<Profile, String> {
        // Check for duplicate name
        if Self::find_profile_by_name(name).is_some() {
            return Err(format!("配置名称 '{}' 已存在，请使用其他名称", name));
        }

        let profile = Profile {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            group: group.to_string(),
            terminal_type: terminal_type.to_string(),
            startup_path: String::new(),
            startup_commands: Vec::new(),
            environment_variables: std::collections::HashMap::new(),
            color_theme: "dark-default".to_string(),
            tab_color: None,
            window_size: None,
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_auth_type: None,
            ssh_key_path: None,
            docker_container_id: None,
            docker_container_name: None,
            k8s_namespace: None,
            k8s_pod_name: None,
            k8s_container_name: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            last_used_at: None,
        };

        let path = Self::get_profiles_dir().join(format!("{}.json", sanitize_filename(&profile.name)));
        let content = serde_json::to_string_pretty(&profile)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        Ok(profile)
    }

    pub fn update_profile(profile: &Profile) -> Result<(), String> {
        // Check for duplicate name (exclude self)
        if let Some(existing) = Self::find_profile_by_name(&profile.name) {
            if existing.id != profile.id {
                return Err(format!("配置名称 '{}' 已存在，请使用其他名称", profile.name));
            }
        }

        // Delete old-format file ({id}.json) if it exists (migration)
        let old_id_path = Self::get_profiles_dir().join(format!("{}.json", profile.id));
        if old_id_path.exists() {
            fs::remove_file(&old_id_path).ok();
        }

        // If name changed, delete old name-based file
        if let Ok(old_profile) = Self::get_profile(&profile.id) {
            if old_profile.name != profile.name {
                let old_path = Self::get_profiles_dir().join(format!("{}.json", sanitize_filename(&old_profile.name)));
                fs::remove_file(&old_path).ok();
            }
        }

        let path = Self::get_profiles_dir().join(format!("{}.json", sanitize_filename(&profile.name)));
        let content = serde_json::to_string_pretty(profile)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))
    }

    pub fn delete_profile(id: &str) -> Result<(), String> {
        let profile = Self::get_profile(id)?;
        let path = Self::get_profiles_dir().join(format!("{}.json", sanitize_filename(&profile.name)));
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete profile: {}", e))
    }

    pub fn update_last_used(id: &str) -> Result<(), String> {
        let mut profile = Self::get_profile(id)?;
        profile.last_used_at = Some(chrono::Utc::now().to_rfc3339());
        Self::update_profile(&profile)
    }

    pub fn export_all_profiles(path: &str) -> Result<(), String> {
        let profiles = Self::get_all_profiles()?;
        let content = serde_json::to_string_pretty(&profiles)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(path, content)
            .map_err(|e| format!("Failed to write file: {}", e))
    }

    pub fn import_profiles(path: &str) -> Result<Vec<Profile>, String> {
        let content = fs::read_to_string(path)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        let profiles: Vec<Profile> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse profiles: {}", e))?;
        let mut imported = Vec::new();
        for mut profile in profiles {
            profile.id = Uuid::new_v4().to_string();
            profile.created_at = chrono::Utc::now().to_rfc3339();
            profile.last_used_at = None;
            let save_path = Self::get_profiles_dir().join(format!("{}.json", sanitize_filename(&profile.name)));
            let json = serde_json::to_string_pretty(&profile)
                .map_err(|e| format!("Failed to serialize: {}", e))?;
            fs::write(&save_path, json)
                .map_err(|e| format!("Failed to write file: {}", e))?;
            imported.push(profile);
        }
        Ok(imported)
    }
}
