use crate::models::{
    validate_profile_connection_fields, AgentCommands, AppSettings, CloseBehavior,
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

/// 保存 Agent 管理中配置的基础启动命令；空串表示回退内置默认。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_agent_commands(claude: String, codex: String) -> Result<(), String> {
    SettingsService::mutate_settings(|settings| {
        settings.agent_commands = AgentCommands {
            claude: claude.trim().to_string(),
            codex: codex.trim().to_string(),
        };
    })
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
    SettingsService::mutate_settings(|settings| settings.close_behavior = behavior)
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

/// 两条路径是否指向同一目录：先 canonicalize，再按 Unix 的 dev+inode 判等，
/// 以覆盖符号链接、相对路径与 bind mount。
fn same_directory(left: &std::path::Path, right: &std::path::Path) -> bool {
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        if a == b {
            return true;
        }
    }
    same_file_identity(left, right)
}

fn same_file_identity(left: &std::path::Path, right: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(a), Ok(b)) = (std::fs::metadata(left), std::fs::metadata(right)) {
            return a.dev() == b.dev() && a.ino() == b.ino();
        }
        false
    }
    #[cfg(not(unix))]
    {
        let _ = (left, right);
        false
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn set_data_path(new_path: String) -> Result<(), String> {
    let validated = PathService::validate_data_path(&new_path)?;
    // require（审查 L-11）：旧的自定义目录不可用时 get_data_dir 会静默回退
    // 默认目录，迁移就从错误的来源复制出一套半吊子数据；此处显式报错。
    let old_dir = PathService::require_data_dir()?;
    let new_dir = validated;

    if old_dir == new_dir || same_directory(&old_dir, &new_dir) {
        return Ok(());
    }

    // 迁移前尽量把 WAL 合并回主库，减少「复制 db 与 wal 不是同一快照」的窗口。
    // 失败不阻断迁移（可能数据库尚未创建）。
    let _ = crate::services::DatabaseService::checkpoint();

    // 迁移整个数据目录根（审查 H-5）：此前只复制 4 个硬编码子目录，
    // terminal_buddy.db（历史索引+命令历史）、AiSessions/、projects.json、
    // command_templates.json、providers*.json、jwt.key、server.key、ClaudeAssets/
    // 等十余项全部留在旧目录，迁移后表现为「数据丢失」。
    // 任一条目复制失败立即中止，不写 settings.json，当前数据目录保持原样。
    {
        let entries = fs::read_dir(&old_dir)
            .map_err(|e| format!("读取旧数据目录失败: {}", e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
            let name = entry.file_name().to_string_lossy().to_string();
            // 调试日志按需重新生成，不随迁移携带。
            if name == "debug.log" {
                continue;
            }
            let src = entry.path();
            let dst = new_dir.join(&name);
            // 新旧目录可能是同一目录的另一种写法（符号链接 / bind mount）：
            // 此时 fs::copy 会先截断目标再读源，源文件被清空。目录与文件都先按
            // 真实身份（Unix dev+inode）判等，相同则跳过。
            if same_file_identity(&src, &dst) {
                continue;
            }
            if src.is_dir() {
                copy_dir_recursive(&src, &dst)?;
            } else {
                fs::copy(&src, &dst)
                    .map_err(|e| format!("复制文件 {} 失败: {}", name, e))?;
            }
        }
    }

    let data_path = Some(new_dir.to_string_lossy().to_string());
    SettingsService::mutate_settings(move |settings| settings.data_path = data_path)?;

    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_enable_tab_navigation(enabled: bool) -> Result<(), String> {
    SettingsService::mutate_settings(|s| s.enable_tab_navigation = enabled)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_tab_sidebar_width(width: u32) -> Result<(), String> {
    SettingsService::mutate_settings(|settings| settings.tab_sidebar_width = width.clamp(150, 400))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_config_nav_width(width: u32) -> Result<(), String> {
    SettingsService::mutate_settings(|settings| settings.config_nav_width = width.clamp(150, 400))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_file_nav_width(width: u32) -> Result<(), String> {
    SettingsService::mutate_settings(|settings| settings.file_nav_width = width.clamp(150, 500))
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

/// 新会话形态：true = 原生会话，false = 终端接力。只影响之后新建的会话。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_native_chat_sessions(enabled: bool) -> Result<(), String> {
    SettingsService::mutate_settings(|s| s.native_chat_sessions = enabled)
}

/// 保存 Agent 会话自动归档设置；开启时立即按新阈值执行一次，方便用户马上看到结果。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_agent_auto_archive(
    enabled: bool,
    days: u32,
) -> Result<crate::services::session_auto_archive_service::AutoArchiveResult, String> {
    let days = days.clamp(
        crate::services::session_auto_archive_service::MIN_DAYS,
        crate::services::session_auto_archive_service::MAX_DAYS,
    );
    SettingsService::mutate_settings(|s| {
        s.agent_auto_archive_enabled = enabled;
        s.agent_auto_archive_days = days;
    })?;
    crate::services::session_auto_archive_service::archive_stale(enabled, days)
}

/// 按当前设置立即执行一次自动归档（启动定时任务之外的手动入口）。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn run_agent_auto_archive(
) -> Result<crate::services::session_auto_archive_service::AutoArchiveResult, String> {
    crate::services::session_auto_archive_service::run_from_settings()
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_launch_at_login(enabled: bool) -> Result<(), String> {
    set_autostart_registry(enabled)?;
    SettingsService::mutate_settings(|s| s.launch_at_login = enabled)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn sync_launch_at_login() -> bool {
    let registry_enabled = read_autostart_registry();
    let _ = SettingsService::mutate_settings(|settings| settings.launch_at_login = registry_enabled);
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
    // 导出的数据源必须与写入一致；get_data_dir 在自定义目录不可用时会静默回退
    // 默认目录，导出「成功」却缺数据（复核 #11）。
    let data_dir = PathService::require_data_dir()?;

    let mut export = json!({
        "version": "1.0",
        "exportTime": chrono::Utc::now().to_rfc3339(),
    });

    // Collect subdirectory data
    for subdir in &["Profiles", "Workspaces", "ClientData"] {
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
    for filename in &["command_templates.json"] {
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

    // 命令历史的权威存储已迁 SQLite（app_documents 表，legacy-command-history-v1
    // 迁移是一次性的）：从这里导出，否则读旧 data 目录里多半已不存在的
    // command_history.json，导出恒为空（审查 H-6）。
    match crate::services::DatabaseService::read_command_history() {
        Ok(Some(content)) => {
            let value = serde_json::from_str::<Value>(&content)
                .map_err(|e| format!("命令历史数据损坏，无法导出：{}", e))?;
            export["command_history"] = value;
        }
        Ok(None) => {}
        // 数据库读取失败不能生成一份「缺命令历史但显示成功」的备份。
        Err(error) => return Err(format!("读取命令历史失败：{}", error)),
    }

    // 真实设置位置是 get_settings_path()（不跟随自定义 dataPath）：从 data 目录
    // 读要么导不出 settings、要么把历史遗留副本当真实设置导出（审查 N-4）。
    match read_json_file(&SettingsService::get_settings_path()) {
        Ok(Some(value)) => {
            export["settings"] = value;
        }
        Ok(None) => {}
        Err(e) => return Err(e),
    }

    let json_str =
        serde_json::to_string_pretty(&export).map_err(|e| format!("序列化JSON失败: {}", e))?;
    crate::services::atomic_file::atomic_write(std::path::Path::new(&file_path), json_str.as_bytes())
        .map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(())
}

fn write_json_files(dir: &PathBuf, map: &HashMap<String, Value>) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {}", e))?;
    for (name, value) in map {
        let path = dir.join(format!("{}.json", name));
        let content =
            serde_json::to_string_pretty(value).map_err(|e| format!("序列化JSON失败: {}", e))?;
        crate::services::atomic_file::atomic_write(&path, content.as_bytes())
            .map_err(|e| format!("写入文件失败: {}", e))?;
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
        "command_history",
        "command_templates",
        "settings",
    ];
    for key in data.as_object().unwrap().keys() {
        if !valid_keys.contains(&key.as_str()) {
            return Err(format!("导入文件包含未知数据类型: {}", key));
        }
    }

    // settings 最先校验：备份里的 settings 损坏时，必须在覆盖任何数据之前失败，
    // 否则用户看到「导入失败」但 Profiles/命令历史已被部分替换（审查 H-4）。
    let imported_settings = data
        .get("settings")
        .map(|value| serde_json::from_value::<crate::models::AppSettings>(value.clone()))
        .transpose()
        .map_err(|e| format!("备份中的 settings 结构无效：{}", e))?;

    // 目标数据目录必须与导入后真正生效的目录一致：导入会剥离 dataPath，
    // 因此带 settings 的备份一律恢复到默认数据目录；没有 settings 时保持当前目录。
    // 旧实现写当前自定义目录却剥离 dataPath，导入后应用改读默认目录，数据「消失」（复核 #3）。
    let data_dir = if imported_settings.is_some() {
        PathService::get_default_base_dir()
    } else {
        PathService::require_data_dir()?
    };
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
    for subdir in &["Profiles", "Workspaces", "ClientData"] {
        if let Some(obj) = data.get(subdir).and_then(|v| v.as_object()) {
            let mut map = HashMap::new();
            for (key, value) in obj {
                map.insert(key.clone(), value.clone());
            }
            write_json_files(&data_dir.join(subdir), &map)?;
        }
    }

    // Restore single-file data
    for filename in &["command_templates"] {
        if let Some(value) = data.get(filename) {
            let path = data_dir.join(format!("{}.json", filename));
            let content = serde_json::to_string_pretty(value)
                .map_err(|e| format!("序列化JSON失败: {}", e))?;
            crate::services::atomic_file::atomic_write(&path, content.as_bytes())
                .map_err(|e| format!("写入文件失败: {}", e))?;
        }
    }

    // 命令历史写回 SQLite（app_documents 表）：写 json 文件不会生效，
    // legacy 迁移是一次性的（审查 H-6）。
    if let Some(value) = data.get("command_history") {
        let content = serde_json::to_string(value)
            .map_err(|e| format!("序列化JSON失败: {}", e))?;
        crate::services::DatabaseService::save_command_history_at(&data_dir, &content)?;
    }

    // settings：剥离导出机携带的 dataPath（跨机/跨目录恢复才不会因严格模式拒绝），
    // 并走 SettingsService::save_settings 以持有全局写锁——导入耗时期间其他客户端
    // 保存设置不会用旧缓存把导入结果覆盖掉（复核 #9）。
    if let Some(mut settings) = imported_settings {
        settings.data_path = None;
        SettingsService::save_settings(&settings)?;
    }

    // 导入直写磁盘绕过了服务层，必须失效内存缓存：否则之后的任意 save_*
    // 会用旧缓存全量覆盖，导入内容静默回滚（审查 H-4）。
    SettingsService::invalidate_cache();
    crate::services::ProfileService::invalidate_cache();

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
    // 密码哈希在锁外计算（bcrypt 较慢），随后把整组字段在一次原子读改写中落盘，
    // 避免与「修改密码」等其它设置写入互相覆盖。
    let password_hash = if password.is_empty() {
        None
    } else {
        Some(bcrypt::hash(password, bcrypt::DEFAULT_COST).map_err(|e| format!("密码加密失败: {}", e))?)
    };
    SettingsService::mutate_settings(move |settings| {
        settings.web_api_enabled = enabled;
        settings.web_api_port = port;
        settings.web_api_username = username;
        if let Some(hash) = password_hash {
            settings.web_api_password_hash = hash;
        }
        settings.web_api_share_sessions = share_sessions;
    })
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
