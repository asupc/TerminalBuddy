use crate::services::SettingsService;
use std::fs;
use std::path::PathBuf;

pub struct PathService;

impl PathService {
    fn get_default_base_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("TerminalBuddy")
    }

    pub fn get_data_dir() -> PathBuf {
        let settings = SettingsService::get_settings();
        if let Some(ref custom) = settings.data_path {
            let path = PathBuf::from(custom);
            if path.is_absolute() && path.exists() {
                return path;
            }
        }
        Self::get_default_base_dir()
    }

    pub fn get_profiles_dir() -> PathBuf {
        let dir = Self::get_data_dir().join("Profiles");
        fs::create_dir_all(&dir).ok();
        dir
    }

    pub fn get_themes_dir() -> PathBuf {
        let dir = Self::get_data_dir().join("Themes");
        fs::create_dir_all(&dir).ok();
        dir
    }

    pub fn get_debug_log_path() -> PathBuf {
        let dir = Self::get_data_dir();
        fs::create_dir_all(&dir).ok();
        dir.join("debug.log")
    }

    pub fn get_current_data_path() -> String {
        Self::get_data_dir().to_string_lossy().to_string()
    }

    pub fn validate_data_path(path: &str) -> Result<PathBuf, String> {
        let p = PathBuf::from(path);
        if !p.is_absolute() {
            return Err("路径必须是绝对路径".to_string());
        }
        if p.exists() && !p.is_dir() {
            return Err("路径必须是一个目录".to_string());
        }
        if !p.exists() {
            fs::create_dir_all(&p)
                .map_err(|e| format!("无法创建目录: {}", e))?;
        }
        let test_file = p.join(".terminalbuddy_write_test");
        fs::write(&test_file, "test").map_err(|e| format!("目录不可写: {}", e))?;
        fs::remove_file(&test_file).ok();
        Ok(p)
    }
}

pub fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {}", e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("复制文件失败: {}", e))?;
        }
    }
    Ok(())
}
