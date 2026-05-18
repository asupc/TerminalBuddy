use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use crate::models::{AppSettings, CloseBehavior};
use crate::services::{SettingsService, PathService, copy_dir_recursive};
use serde_json::{json, Value};

#[tauri::command]
pub fn get_app_settings() -> AppSettings {
    SettingsService::get_settings()
}

#[tauri::command]
pub fn save_close_behavior(behavior: String) -> Result<(), String> {
    let behavior = match behavior.as_str() {
        "exit" => CloseBehavior::Exit,
        "tray" => CloseBehavior::Tray,
        _ => return Err(format!("无效的关闭行为: {}", behavior)),
    };
    let mut settings = SettingsService::get_settings();
    settings.close_behavior = behavior;
    SettingsService::save_settings(&settings)
}

#[tauri::command]
pub fn get_data_path() -> String {
    PathService::get_current_data_path()
}

#[tauri::command]
pub fn set_data_path(new_path: String) -> Result<(), String> {
    let validated = PathService::validate_data_path(&new_path)?;
    let old_dir = PathService::get_data_dir();
    let new_dir = validated;

    if old_dir == new_dir {
        return Ok(());
    }

    for subdir in &["Profiles", "Themes"] {
        let src = old_dir.join(subdir);
        let dst = new_dir.join(subdir);
        if src.exists() {
            copy_dir_recursive(&src, &dst)?;
        }
    }

    let mut settings = SettingsService::get_settings();
    settings.data_path = Some(new_dir.to_string_lossy().to_string());
    SettingsService::save_settings(&settings)?;

    Ok(())
}

#[tauri::command]
pub fn save_enable_tab_navigation(enabled: bool) -> Result<(), String> {
    let mut settings = SettingsService::get_settings();
    settings.enable_tab_navigation = enabled;
    SettingsService::save_settings(&settings)
}

#[tauri::command]
pub fn save_tab_sidebar_width(width: u32) -> Result<(), String> {
    let mut settings = SettingsService::get_settings();
    settings.tab_sidebar_width = width.clamp(150, 400);
    SettingsService::save_settings(&settings)
}

#[tauri::command]
pub fn save_single_instance(enabled: bool) -> Result<(), String> {
    let mut settings = SettingsService::get_settings();
    settings.single_instance = enabled;
    SettingsService::save_settings(&settings)
}

fn read_json_files(dir: &PathBuf) -> Result<HashMap<String, Value>, String> {
    let mut map = HashMap::new();
    if !dir.exists() {
        return Ok(map);
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let content = fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))?;
            let value: Value = serde_json::from_str(&content).map_err(|e| format!("解析JSON失败: {}", e))?;
            map.insert(name, value);
        }
    }
    Ok(map)
}

fn read_json_file(path: &PathBuf) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|e| format!("读取文件失败: {}", e))?;
    let value: Value = serde_json::from_str(&content).map_err(|e| format!("解析JSON失败: {}", e))?;
    Ok(Some(value))
}

#[tauri::command]
pub fn export_all_data(file_path: String) -> Result<(), String> {
    let data_dir = PathService::get_data_dir();

    let mut export = json!({
        "version": "1.0",
        "exportTime": chrono::Utc::now().to_rfc3339(),
    });

    // Collect subdirectory data (Profiles, Themes, Workspaces)
    for subdir in &["Profiles", "Themes", "Workspaces"] {
        let dir = data_dir.join(subdir);
        match read_json_files(&dir) {
            Ok(map) => {
                if !map.is_empty() {
                    export[subdir] = json!(map);
                }
            }
            Err(e) => return Err(e),
        }
    }

    // Collect single-file data
    for filename in &["command_history.json", "command_templates.json", "settings.json"] {
        let path = data_dir.join(filename);
        let stem = filename.trim_end_matches(".json");
        match read_json_file(&path) {
            Ok(Some(value)) => { export[stem] = value; }
            Ok(None) => {}
            Err(e) => return Err(e),
        }
    }

    let json_str = serde_json::to_string_pretty(&export)
        .map_err(|e| format!("序列化JSON失败: {}", e))?;
    fs::write(&file_path, json_str)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(())
}

fn write_json_files(dir: &PathBuf, map: &HashMap<String, Value>) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {}", e))?;
    for (name, value) in map {
        let path = dir.join(format!("{}.json", name));
        let content = serde_json::to_string_pretty(value)
            .map_err(|e| format!("序列化JSON失败: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("写入文件失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn import_all_data(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err("导入文件不存在".to_string());
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("读取文件失败: {}", e))?;
    let data: Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析JSON失败: {}", e))?;

    let data_dir = PathService::get_data_dir();
    fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;

    // Restore subdirectory data
    for subdir in &["Profiles", "Themes", "Workspaces"] {
        if let Some(obj) = data.get(subdir).and_then(|v| v.as_object()) {
            let mut map = HashMap::new();
            for (key, value) in obj {
                map.insert(key.clone(), value.clone());
            }
            write_json_files(&data_dir.join(subdir), &map)?;
        }
    }

    // Restore single-file data
    for filename in &["command_history", "command_templates", "settings"] {
        if let Some(value) = data.get(filename) {
            let path = data_dir.join(format!("{}.json", filename));
            let content = serde_json::to_string_pretty(value)
                .map_err(|e| format!("序列化JSON失败: {}", e))?;
            fs::write(&path, content)
                .map_err(|e| format!("写入文件失败: {}", e))?;
        }
    }

    Ok(())
}
