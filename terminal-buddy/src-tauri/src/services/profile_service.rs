use crate::models::validate_profile_connection_fields;
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
    fn get_profiles_dir() -> Result<PathBuf, String> {
        PathService::get_profiles_dir()
    }

    fn invalidate_cache() {
        if let Ok(mut cache) = CACHED_PROFILES.write() {
            *cache = None;
        }
    }

    fn read_all_from_disk() -> Vec<Profile> {
        // 读路径：目录不可用时返回空列表（get_all_profiles 会正常返回空集），
        // 状态缓存里已记录不可用原因，设置页与启动横幅会展示。
        let dir = match Self::get_profiles_dir() {
            Ok(dir) => dir,
            Err(_) => return Vec::new(),
        };
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
        profiles
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("Profile not found: {}", id))
    }

    fn find_profile_by_name_in_group(name: &str, group: &str) -> Option<Profile> {
        let normalized_group = if group.is_empty() { "默认" } else { group };
        Self::get_all_profiles().ok().and_then(|profiles| {
            profiles.into_iter().find(|p| {
                let p_group = if p.group.is_empty() {
                    "默认"
                } else {
                    &p.group
                };
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
            pinned: false,
        };

        let path = Self::get_profiles_dir()?.join(format!("{}.json", profile.id));
        let content = serde_json::to_string_pretty(&profile)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))?;
        Self::invalidate_cache();
        Ok(profile)
    }

    pub fn update_profile(profile: &Profile) -> Result<(), String> {
        // 连接字段会被拼进写往 cmd.exe 的命令行，非法值必须在落盘前挡掉。
        validate_profile_connection_fields(profile)?;

        // Check for duplicate name within the same group (exclude self)
        let profile_group = if profile.group.is_empty() {
            "默认"
        } else {
            &profile.group
        };
        if let Some(existing) = Self::find_profile_by_name_in_group(&profile.name, profile_group) {
            if existing.id != profile.id {
                return Err(format!(
                    "该分组下名称 '{}' 已存在，请使用其他名称",
                    profile.name
                ));
            }
        }

        // Delete old name-based file if it exists (migration from name-based naming)
        if let Ok(old_profile) = Self::get_profile(&profile.id) {
            if old_profile.name != profile.name {
                if let Ok(old_name_path) = Self::get_profiles_dir()
                    .map(|dir| dir.join(format!("{}.json", sanitize_filename(&old_profile.name))))
                {
                    if old_name_path.exists() {
                        fs::remove_file(&old_name_path).ok();
                    }
                }
            }
        }

        // Encrypt sensitive fields before writing to disk
        let mut to_save = profile.clone();
        to_save.encrypt_sensitive_fields();

        let path = Self::get_profiles_dir()?.join(format!("{}.json", to_save.id));
        let content = serde_json::to_string_pretty(&to_save)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))?;
        Self::invalidate_cache();
        Ok(())
    }

    pub fn delete_profile(id: &str) -> Result<(), String> {
        let profile = Self::get_profile(id)?;
        // Try id-based file first, then fall back to name-based file (migration)
        let dir = Self::get_profiles_dir()?;
        let id_path = dir.join(format!("{}.json", profile.id));
        let name_path = dir.join(format!("{}.json", sanitize_filename(&profile.name)));
        let path = if id_path.exists() { id_path } else { name_path };
        fs::remove_file(&path).map_err(|e| format!("Failed to delete profile: {}", e))?;
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
        fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))
    }

    pub fn import_profiles(path: &str) -> Result<Vec<Profile>, String> {
        let content =
            fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;
        let profiles: Vec<Profile> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse profiles: {}", e))?;
        // 先整体校验再写盘：导入文件同样可能带着能改变命令结构的字段，而且不能只导入
        // 一半就中断，否则用户很难判断磁盘上到底留下了什么。
        for profile in &profiles {
            validate_profile_connection_fields(profile)
                .map_err(|e| format!("连接「{}」导入失败：{}", profile.name, e))?;
        }
        let mut imported = Vec::new();
        for mut profile in profiles {
            profile.id = Uuid::new_v4().to_string();
            profile.created_at = chrono::Utc::now().to_rfc3339();
            profile.last_used_at = None;
            profile.encrypt_sensitive_fields();
            let save_path = Self::get_profiles_dir()?.join(format!("{}.json", profile.id));
            let json = serde_json::to_string_pretty(&profile)
                .map_err(|e| format!("Failed to serialize: {}", e))?;
            fs::write(&save_path, json).map_err(|e| format!("Failed to write file: {}", e))?;
            // Decrypt for return value (frontend needs plaintext)
            profile.decrypt_sensitive_fields();
            imported.push(profile);
        }
        Self::invalidate_cache();
        Ok(imported)
    }
}
