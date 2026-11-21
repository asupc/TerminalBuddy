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

    /// 供 import_all_data 等直写磁盘的路径使用：写盘后失效内存缓存。
    pub fn invalidate_cache() {
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

    fn with_cached_profiles<T>(f: impl FnOnce(&[Profile]) -> T) -> T {
        if let Ok(cache) = CACHED_PROFILES.read() {
            if let Some(ref profiles) = *cache {
                return f(profiles);
            }
        }
        let profiles = Self::read_all_from_disk();
        let result = f(&profiles);
        if let Ok(mut cache) = CACHED_PROFILES.write() {
            *cache = Some(profiles);
        }
        result
    }

    pub fn get_all_profiles() -> Result<Vec<Profile>, String> {
        Ok(Self::with_cached_profiles(|profiles| profiles.to_vec()))
    }

    /// Resolve an optional per-profile override against its project's required base path.
    pub fn effective_startup_path(profile: &Profile) -> Option<String> {
        let base = std::fs::read(PathService::get_data_dir().join("projects.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<serde_json::Value>>(&bytes).ok())
            .and_then(|projects| projects.into_iter().find(|project| {
                project["name"].as_str() == Some(if profile.group.trim().is_empty() { "默认" } else { profile.group.as_str() })
            }))
            .and_then(|project| project["path"].as_str().map(str::to_string))
            .unwrap_or_default();
        let override_path = profile.startup_path.trim();
        if override_path.is_empty() {
            return if base.is_empty() { None } else { Some(base) };
        }
        let path = std::path::Path::new(override_path);
        if path.is_absolute() { Some(override_path.to_string()) }
        else if base.is_empty() { None }
        else { Some(std::path::Path::new(&base).join(path).to_string_lossy().to_string()) }
    }

    pub fn get_profile(id: &str) -> Result<Profile, String> {
        Self::with_cached_profiles(|profiles| profiles.iter().find(|p| p.id == id).cloned())
            .ok_or_else(|| format!("Profile not found: {}", id))
    }

    /// 轻量查询终端展示所需的 `(group, terminal_type)`，避免克隆完整 Profile。
    pub fn get_profile_terminal_meta(id: &str) -> Option<(String, String)> {
        Self::with_cached_profiles(|profiles| {
            profiles
                .iter()
                .find(|p| p.id == id)
                .map(|p| (p.group.clone(), p.terminal_type.clone()))
        })
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
        super::atomic_file::atomic_write(&path, content.as_bytes()).map_err(|e| format!("Failed to write file: {}", e))?;
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
        to_save.encrypt_sensitive_fields()?;

        let path = Self::get_profiles_dir()?.join(format!("{}.json", to_save.id));
        let content = serde_json::to_string_pretty(&to_save)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        super::atomic_file::atomic_write(&path, content.as_bytes()).map_err(|e| format!("Failed to write file: {}", e))?;
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
        super::atomic_file::atomic_write(std::path::Path::new(path), content.as_bytes()).map_err(|e| format!("Failed to write file: {}", e))
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
            profile.encrypt_sensitive_fields()?;
            let save_path = Self::get_profiles_dir()?.join(format!("{}.json", profile.id));
            let json = serde_json::to_string_pretty(&profile)
                .map_err(|e| format!("Failed to serialize: {}", e))?;
            super::atomic_file::atomic_write(&save_path, json.as_bytes()).map_err(|e| format!("Failed to write file: {}", e))?;
            // Decrypt for return value (frontend needs plaintext)
            profile.decrypt_sensitive_fields();
            imported.push(profile);
        }
        Self::invalidate_cache();
        Ok(imported)
    }
}
