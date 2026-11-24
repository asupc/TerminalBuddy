use crate::services::PathService;
use std::fs;
use std::path::PathBuf;

pub struct TemplateService;

impl TemplateService {
    fn get_template_path() -> PathBuf {
        PathService::get_data_dir().join("command_templates.json")
    }

    fn require_template_path() -> Result<PathBuf, String> {
        let dir = PathService::require_data_dir()?;
        fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
        Ok(dir.join("command_templates.json"))
    }

    pub fn get_templates() -> String {
        let path = Self::get_template_path();
        match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => String::from("[]"),
        }
    }

    pub fn save_templates(content: &str) -> Result<(), String> {
        let _: serde_json::Value =
            serde_json::from_str(content).map_err(|e| format!("无效的JSON: {}", e))?;
        let path = Self::require_template_path()?;
        super::atomic_file::atomic_write(&path, content.as_bytes()).map_err(|e| format!("写入失败: {}", e))
    }

    pub fn init_templates_if_missing(default_content: &str) -> Result<bool, String> {
        let path = Self::require_template_path()?;
        if !path.exists() {
            super::atomic_file::atomic_write(&path, default_content.as_bytes()).map_err(|e| format!("初始化失败: {}", e))?;
            return Ok(true);
        }
        Ok(false)
    }
}
