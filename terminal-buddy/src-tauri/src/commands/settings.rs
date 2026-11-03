use crate::models::{
    validate_profile_connection_fields, AppSettings, CloseBehavior,
    LaunchWindowMode, Profile, TerminalLoadingMode,
};
use crate::services::{
    copy_dir_recursive, PathService, SettingsService, VsCodeTerminalProcess, VsCodeTerminalSupport,
};
use serde_json::{json, Value};
use std::collections::HashMap;
#[cfg(all(windows, feature = "desktop"))]
use std::ffi::OsStr;
use std::fs;
#[cfg(all(windows, feature = "desktop"))]
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use crate::runtime::AppHandle;

#[cfg(not(all(windows, feature = "desktop")))]
fn set_autostart_registry(_enabled: bool) -> Result<(), String> {
    Err("独立服务端由 Docker 或系统服务管理启动".to_string())
}

#[cfg(not(all(windows, feature = "desktop")))]
fn read_autostart_registry() -> bool { false }

#[cfg(all(windows, feature = "desktop"))]
fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(all(windows, feature = "desktop"))]
fn set_autostart_registry(enabled: bool) -> Result<(), String> {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::*;

    let key_wide = to_wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let name_wide = to_wide("TerminalBuddy");

    unsafe {
        let mut hkey = HKEY::default();
        let result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            windows::core::PCWSTR(key_wide.as_ptr()),
            Some(0),
            KEY_SET_VALUE,
            &mut hkey,
        );
        if result != ERROR_SUCCESS {
            return Err(format!("打开注册表失败: {}", result.to_hresult().0));
        }

        if enabled {
            let exe_path =
                std::env::current_exe().map_err(|e| format!("获取程序路径失败: {}", e))?;
            let path_str = format!("\"{}\"", exe_path.to_string_lossy());
            let wide = to_wide(&path_str);
            let bytes: Vec<u8> = wide.iter().flat_map(|w| w.to_le_bytes()).collect();
            let result = RegSetValueExW(
                hkey,
                windows::core::PCWSTR(name_wide.as_ptr()),
                Some(0),
                REG_SZ,
                Some(&bytes),
            );
            let _ = RegCloseKey(hkey);
            if result != ERROR_SUCCESS {
                return Err(format!("写入注册表失败: {}", result.to_hresult().0));
            }
        } else {
            let result = RegDeleteValueW(hkey, windows::core::PCWSTR(name_wide.as_ptr()));
            let _ = RegCloseKey(hkey);
            if result != ERROR_SUCCESS && result.to_hresult().0 != 2 {
                return Err(format!("删除注册表项失败: {}", result.to_hresult().0));
            }
        }
    }
    Ok(())
}

#[cfg(all(windows, feature = "desktop"))]
fn read_autostart_registry() -> bool {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::*;

    let key_wide = to_wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let name_wide = to_wide("TerminalBuddy");

    unsafe {
        let mut hkey = HKEY::default();
        let result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            windows::core::PCWSTR(key_wide.as_ptr()),
            Some(0),
            KEY_READ,
            &mut hkey,
        );
        if result != ERROR_SUCCESS {
            return false;
        }

        let mut buf = [0u16; 512];
        let mut buf_len = (buf.len() * 2) as u32;
        let mut reg_type = REG_SZ;
        let result = RegQueryValueExW(
            hkey,
            windows::core::PCWSTR(name_wide.as_ptr()),
            None,
            Some(&mut reg_type),
            Some(buf.as_mut_ptr() as *mut u8),
            Some(&mut buf_len),
        );
        let _ = RegCloseKey(hkey);
        result == ERROR_SUCCESS
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_show_task_summary(enabled: bool) -> Result<(), String> {
    SettingsService::mutate_settings(|settings| settings.show_task_summary = enabled)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_app_settings() -> AppSettings {
    SettingsService::get_settings()
}

#[cfg_attr(feature = "desktop", tauri::command)]
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_launch_window_mode(mode: String) -> Result<(), String> {
    let mode = match mode.as_str() {
        "windowed" => LaunchWindowMode::Windowed,
        "maximized" => LaunchWindowMode::Maximized,
        _ => return Err(format!("无效的启动窗口模式: {}", mode)),
    };
    SettingsService::mutate_settings(|s| s.launch_window_mode = mode)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_vscode_terminal_support(app: AppHandle) -> VsCodeTerminalSupport {
    VsCodeTerminalProcess::probe_support(&app)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_terminal_loading_mode(mode: String, app: AppHandle) -> Result<(), String> {
    let mode = match mode.as_str() {
        "default" => TerminalLoadingMode::Default,
        "vsCode" => {
            let support = VsCodeTerminalProcess::probe_support(&app);
            if !support.available {
                return Err(support.reason);
            }
            TerminalLoadingMode::VsCode
        }
        _ => return Err(format!("无效的终端加载方案: {}", mode)),
    };
    SettingsService::mutate_settings(|settings| settings.terminal_loading_mode = mode)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_data_path() -> String {
    PathService::get_current_data_path()
}

/// 数据目录当前可用性状态，供设置页与启动横幅展示。
/// `null` 表示进程尚未解析过数据目录（极早期）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_data_path_status() -> serde_json::Value {
    match PathService::get_data_dir_status() {
        Some(status) => serde_json::json!({
            "kind": match status {
                crate::services::DataDirStatus::Default => "default",
                crate::services::DataDirStatus::Ok { .. } => "ok",
                crate::services::DataDirStatus::Unavailable { .. } => "unavailable",
            },
            "summary": status.summary(),
        }),
        None => serde_json::Value::Null,
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn set_data_path(new_path: String) -> Result<(), String> {
    let validated = PathService::validate_data_path(&new_path)?;
    let old_dir = PathService::get_data_dir();
    let new_dir = validated;

    if old_dir == new_dir {
        return Ok(());
    }

    // 目标在源内部、目录链接环路都由 copy_dir_recursive 拒绝；任一子目录
    // 复制失败立即中止，不写 settings.json，当前数据目录保持原样。
    for subdir in &["Profiles", "Workspaces", "ClientData", "Bots"] {
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_enable_tab_navigation(enabled: bool) -> Result<(), String> {
    SettingsService::mutate_settings(|s| s.enable_tab_navigation = enabled)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_tab_sidebar_width(width: u32) -> Result<(), String> {
    let mut settings = SettingsService::get_settings();
    settings.tab_sidebar_width = width.clamp(150, 400);
    SettingsService::save_settings(&settings)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_config_nav_width(width: u32) -> Result<(), String> {
    let mut settings = SettingsService::get_settings();
    settings.config_nav_width = width.clamp(150, 400);
    SettingsService::save_settings(&settings)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_file_nav_width(width: u32) -> Result<(), String> {
    let mut settings = SettingsService::get_settings();
    settings.file_nav_width = width.clamp(150, 500);
    SettingsService::save_settings(&settings)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_single_instance(enabled: bool) -> Result<(), String> {
    SettingsService::mutate_settings(|s| s.single_instance = enabled)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_downloads_directory() -> Result<String, String> {
    dirs::download_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Failed to get downloads directory".to_string())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_ssh_download_dir(dir: String) -> Result<(), String> {
    SettingsService::mutate_settings(|s| s.ssh_download_dir = Some(dir))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_server_monitor_interval(interval: u32) -> Result<(), String> {
    SettingsService::mutate_settings(|s| s.server_monitor_interval = interval)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_web_api_share_sessions(enabled: bool) -> Result<(), String> {
    SettingsService::mutate_settings(|s| s.web_api_share_sessions = enabled)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_launch_at_login(enabled: bool) -> Result<(), String> {
    set_autostart_registry(enabled)?;
    SettingsService::mutate_settings(|s| s.launch_at_login = enabled)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn sync_launch_at_login() -> bool {
    let registry_enabled = read_autostart_registry();
    let mut settings = SettingsService::get_settings();
    if settings.launch_at_login != registry_enabled {
        settings.launch_at_login = registry_enabled;
        let _ = SettingsService::save_settings(&settings);
    }
    registry_enabled
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
            let value: Value =
                serde_json::from_str(&content).map_err(|e| format!("解析JSON失败: {}", e))?;
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
    let value: Value =
        serde_json::from_str(&content).map_err(|e| format!("解析JSON失败: {}", e))?;
    Ok(Some(value))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn export_all_data(file_path: String) -> Result<(), String> {
    let data_dir = PathService::get_data_dir();

    let mut export = json!({
        "version": "1.0",
        "exportTime": chrono::Utc::now().to_rfc3339(),
    });

    // Collect subdirectory data
    for subdir in &["Profiles", "Workspaces", "ClientData", "Bots"] {
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
    for filename in &[
        "command_history.json",
        "command_templates.json",
        "settings.json",
    ] {
        let path = data_dir.join(filename);
        let stem = filename.trim_end_matches(".json");
        match read_json_file(&path) {
            Ok(Some(value)) => {
                export[stem] = value;
            }
            Ok(None) => {}
            Err(e) => return Err(e),
        }
    }

    let json_str =
        serde_json::to_string_pretty(&export).map_err(|e| format!("序列化JSON失败: {}", e))?;
    fs::write(&file_path, json_str).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(())
}

fn write_json_files(dir: &PathBuf, map: &HashMap<String, Value>) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {}", e))?;
    for (name, value) in map {
        let path = dir.join(format!("{}.json", name));
        let content =
            serde_json::to_string_pretty(value).map_err(|e| format!("序列化JSON失败: {}", e))?;
        fs::write(&path, content).map_err(|e| format!("写入文件失败: {}", e))?;
    }
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn import_all_data(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err("导入文件不存在".to_string());
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    let data: Value = serde_json::from_str(&content).map_err(|e| format!("解析JSON失败: {}", e))?;

    // 验证顶层结构必须是 Object
    if !data.is_object() {
        return Err("导入文件格式错误：顶层必须是 JSON 对象".to_string());
    }

    // 验证可识别的 key
    // Themes is accepted for backward compatibility with older backups, but is no longer restored.
    let valid_keys: &[&str] = &[
        "Profiles",
        "Themes",
        "Workspaces",
        "ClientData",
        "Bots",
        "command_history",
        "command_templates",
        "settings",
    ];
    for key in data.as_object().unwrap().keys() {
        if !valid_keys.contains(&key.as_str()) {
            return Err(format!("导入文件包含未知数据类型: {}", key));
        }
    }

    let data_dir = PathService::get_data_dir();
    fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;

    // 这条路径直接把 JSON 原样写进 Profiles/，不经过 ProfileService，所以必须在这里
    // 自行校验连接字段，否则备份文件就能绕过保存时的校验把非法值放上磁盘。
    // 反序列化失败的条目跳过校验：旧版本备份可能缺字段，而缺字段的 JSON 本来也不会被
    // ProfileService 读成 Profile，进不了命令行。
    if let Some(obj) = data.get("Profiles").and_then(|v| v.as_object()) {
        for value in obj.values() {
            if let Ok(profile) = serde_json::from_value::<Profile>(value.clone()) {
                validate_profile_connection_fields(&profile)
                    .map_err(|e| format!("连接「{}」导入失败：{}", profile.name, e))?;
            }
        }
    }

    // Restore subdirectory data
    for subdir in &["Profiles", "Workspaces", "ClientData", "Bots"] {
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
            fs::write(&path, content).map_err(|e| format!("写入文件失败: {}", e))?;
        }
    }

    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_web_api_settings(
    enabled: bool,
    port: u16,
    username: String,
    password: String,
    share_sessions: bool,
) -> Result<(), String> {
    let mut settings = SettingsService::get_settings();
    settings.web_api_enabled = enabled;
    settings.web_api_port = port;
    settings.web_api_username = username;
    if !password.is_empty() {
        settings.web_api_password_hash = bcrypt::hash(password, bcrypt::DEFAULT_COST)
            .map_err(|e| format!("密码加密失败: {}", e))?;
    }
    settings.web_api_share_sessions = share_sessions;
    SettingsService::save_settings(&settings)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_web_api_status() -> serde_json::Value {
    let settings = SettingsService::get_settings();
    serde_json::json!({
        "enabled": settings.web_api_enabled,
        "port": settings.web_api_port,
        "username": settings.web_api_username,
        "hasPassword": !settings.web_api_password_hash.is_empty(),
        "pageTitle": settings.web_page_title,
        "shareSessions": settings.web_api_share_sessions,
    })
}

/// 网页主页标题的长度上限（按字符数计，中文与字母均算 1 个字符）。
pub const WEB_PAGE_TITLE_MAX_CHARS: usize = 60;

/// 规范化网页主页标题：去除首尾空白并校验长度；空串放行（表示恢复默认标题）。
pub fn normalize_web_page_title(title: &str) -> Result<String, String> {
    let trimmed = title.trim();
    if trimmed.chars().count() > WEB_PAGE_TITLE_MAX_CHARS {
        return Err(format!("主页标题最多 {} 个字符", WEB_PAGE_TITLE_MAX_CHARS));
    }
    Ok(trimmed.to_string())
}

/// Docker 网页端修改管理员登录密码：需验证旧密码，新密码复用统一的强度校验。
/// bcrypt 的 verify 与 hash 都是 CPU 密集操作，与登录接口共用全局并发闸门并放到阻塞线程池执行。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn change_web_admin_password(
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    if SettingsService::get_settings().web_api_password_hash.is_empty() {
        return Err("管理员密码尚未初始化，请先在登录页完成创建".to_string());
    }
    crate::web::auth::validate_admin_password(&new_password)?;
    let Some(_verify_slot) = crate::web::rate_limit::acquire_password_verify_slot().await else {
        return Err(format!(
            "服务器正忙，请在 {} 秒后重试",
            crate::web::rate_limit::PASSWORD_VERIFY_RETRY_AFTER_SECS
        ));
    };
    crate::runtime::async_runtime::spawn_blocking(move || {
        // 阻塞线程内重读最新 hash，避免排队期间管理员被并发初始化/修改
        let hash = SettingsService::get_settings().web_api_password_hash;
        if hash.is_empty() {
            return Err("管理员密码尚未初始化，请先在登录页完成创建".to_string());
        }
        match bcrypt::verify(&old_password, &hash) {
            Ok(true) => {}
            Ok(false) => return Err("旧密码不正确".to_string()),
            Err(e) => return Err(format!("密码校验失败：{}", e)),
        }
        let new_hash = bcrypt::hash(&new_password, bcrypt::DEFAULT_COST)
            .map_err(|e| format!("密码加密失败：{}", e))?;
        SettingsService::mutate_settings(|s| s.web_api_password_hash = new_hash)
    })
    .await
    .map_err(|e| format!("密码修改任务失败：{}", e))?
}

/// 保存 Docker 网页主页标题（浏览器标签 + 登录页大标题），空串恢复默认。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_web_page_title(title: String) -> Result<(), String> {
    let normalized = normalize_web_page_title(&title)?;
    SettingsService::mutate_settings(|s| s.web_page_title = normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_web_page_title_trims_input() {
        assert_eq!(normalize_web_page_title("  我的终端  ").unwrap(), "我的终端");
    }

    #[test]
    fn normalize_web_page_title_allows_empty_for_default() {
        assert_eq!(normalize_web_page_title("   ").unwrap(), "");
    }

    #[test]
    fn normalize_web_page_title_rejects_over_limit() {
        // 61 个 ASCII 字符应被拒绝
        let long = "a".repeat(WEB_PAGE_TITLE_MAX_CHARS + 1);
        assert!(normalize_web_page_title(&long).is_err());
        // 恰好 60 个字符（含中文，按字符数而非字节数计）应放行
        let chinese = "终".repeat(WEB_PAGE_TITLE_MAX_CHARS);
        assert!(normalize_web_page_title(&chinese).is_ok());
        // 61 个中文（183 字节）应被拒绝
        let chinese_long = "终".repeat(WEB_PAGE_TITLE_MAX_CHARS + 1);
        assert!(normalize_web_page_title(&chinese_long).is_err());
    }
}
