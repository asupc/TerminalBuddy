use crate::services::PathService;
use std::fs;
use std::path::PathBuf;

pub struct ClientDataService;

impl ClientDataService {
    fn get_client_data_dir() -> PathBuf {
        let dir = PathService::get_data_dir().join("ClientData");
        fs::create_dir_all(&dir).ok();
        dir
    }

    pub fn read(key: &str) -> Result<Option<String>, String> {
        Self::validate_key(key)?;
        let path = Self::get_client_data_dir().join(format!("{}.json", key));
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("读取文件失败: {}", e))?;
        Ok(Some(content))
    }

    pub fn write(key: &str, content: &str) -> Result<(), String> {
        Self::validate_key(key)?;
        // Validate JSON
        serde_json::from_str::<serde_json::Value>(content)
            .map_err(|e| format!("无效的JSON: {}", e))?;
        let pretty = serde_json::to_string_pretty(&serde_json::from_str::<serde_json::Value>(content).unwrap())
            .map_err(|e| format!("格式化JSON失败: {}", e))?;
        let path = Self::get_client_data_dir().join(format!("{}.json", key));
        fs::write(&path, pretty)
            .map_err(|e| format!("写入文件失败: {}", e))?;
        Ok(())
    }

    fn validate_key(key: &str) -> Result<(), String> {
        if key.is_empty() {
            return Err("key 不能为空".to_string());
        }
        if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err("key 只能包含字母、数字、下划线和连字符".to_string());
        }
        Ok(())
    }
}
