use crate::models::Profile;
use crate::services::PathService;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;
use uuid::Uuid;

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
}

static CACHED_PROFILES: RwLock<Option<Vec<Profile>>> = RwLock::new(None);

pub struct ProfileService;

impl ProfileService {
    fn get_profiles_dir() -> PathBuf {
        PathService::get_profiles_dir()
    }

    fn invalidate_cache() {
        if let Ok(mut cache) = CACHED_PROFILES.write() {
            *cache = None;
        }
    }

    fn read_all_from_disk() -> Vec<Profile> {
        let dir = Self::get_profiles_dir();
        let mut profiles = Vec::new();
        let mut seen_ids = std::collections::HashSet::new();

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map_or(false, |e| e == "json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(mut profile) = serde_json::from_str::<Profile>(&content) {
                            if seen_ids.insert(profile.id.clone()) {
                                profile.decrypt_sensitive_fields();
                                profiles.push(profile);
                            }
                        }
                    }
                }
            }
        }

        profiles
    }

    pub fn get_all_profiles() -> Result<Vec<Profile>, String> {
        if let Ok(cache) = CACHED_PROFILES.read() {
            if let Some(ref profiles) = *cache {
                return Ok(profiles.clone());
            }
        }
        let profiles = Self::read_all_from_disk();
        if let Ok(mut cache) = CACHED_PROFILES.write() {
            *cache = Some(profiles.clone());
        }
        Ok(profiles)
    }

    pub fn get_profile(id: &str) -> Result<Profile, String> {
        let profiles = Self::get_all_profiles()?;
        profiles.into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("Profile not found: {}", id))
    }

    fn find_profile_by_name_in_group(name: &str, group: &str) -> Option<Profile> {
        let normalized_group = if group.is_empty() { "默认" } else { group };
        Self::get_all_profiles().ok().and_then(|profiles| {
            profiles.into_iter().find(|p| {
                let p_group = if p.group.is_empty() { "默认" } else { &p.group };
                p.name == name && p_group == normalized_group
            })
        })
    }

    pub fn create_profile(name: &str, group: &str, terminal_type: &str) -> Result<Profile, String> {
        // Check for duplicate name within the same group
        if Self::find_profile_by_name_in_group(name, group).is_some() {
            return Err(format!("该分组下名称 '{}' 已存在，请使用其他名称", name));
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
            ssh_password: None,
            docker_container_id: None,
            docker_container_name: None,
            k8s_namespace: None,
            k8s_pod_name: None,
            k8s_container_name: None,
            mstsc_host: None,
            mstsc_port: None,
            mstsc_user: None,
            mstsc_password: None,
            mstsc_resolution: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            last_used_at: None,
        };

        let path = Self::get_profiles_dir().join(format!("{}.json", profile.id));
        let content = serde_json::to_string_pretty(&profile)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        Self::invalidate_cache();
        Ok(profile)
    }

    pub fn update_profile(profile: &Profile) -> Result<(), String> {
        // Check for duplicate name within the same group (exclude self)
        let profile_group = if profile.group.is_empty() { "默认" } else { &profile.group };
        if let Some(existing) = Self::find_profile_by_name_in_group(&profile.name, profile_group) {
            if existing.id != profile.id {
                return Err(format!("该分组下名称 '{}' 已存在，请使用其他名称", profile.name));
            }
        }

        // Delete old name-based file if it exists (migration from name-based naming)
        if let Ok(old_profile) = Self::get_profile(&profile.id) {
            if old_profile.name != profile.name {
                let old_name_path = Self::get_profiles_dir().join(format!("{}.json", sanitize_filename(&old_profile.name)));
                if old_name_path.exists() {
                    fs::remove_file(&old_name_path).ok();
                }
            }
        }

        // Encrypt sensitive fields before writing to disk
        let mut to_save = profile.clone();
        to_save.encrypt_sensitive_fields();

        let path = Self::get_profiles_dir().join(format!("{}.json", to_save.id));
        let content = serde_json::to_string_pretty(&to_save)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        Self::invalidate_cache();
        Ok(())
    }

    pub fn delete_profile(id: &str) -> Result<(), String> {
        let profile = Self::get_profile(id)?;
        // Try id-based file first, then fall back to name-based file (migration)
        let id_path = Self::get_profiles_dir().join(format!("{}.json", profile.id));
        let name_path = Self::get_profiles_dir().join(format!("{}.json", sanitize_filename(&profile.name)));
        let path = if id_path.exists() { id_path } else { name_path };
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete profile: {}", e))?;
        Self::invalidate_cache();
        Ok(())
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
            profile.encrypt_sensitive_fields();
            let save_path = Self::get_profiles_dir().join(format!("{}.json", profile.id));
            let json = serde_json::to_string_pretty(&profile)
                .map_err(|e| format!("Failed to serialize: {}", e))?;
            fs::write(&save_path, json)
                .map_err(|e| format!("Failed to write file: {}", e))?;
            // Decrypt for return value (frontend needs plaintext)
            profile.decrypt_sensitive_fields();
            imported.push(profile);
        }
        Self::invalidate_cache();
        Ok(imported)
    }
}
