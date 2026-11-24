//! 默认终端注册表读写与开关服务。
//!
//! 全部写 HKCU（无需管理员）：`HKCU\Console\%%Startup` 的委托值 + 我们的
//! LocalServer32 COM 类注册。开关关闭时按备份恢复旧值。

#[cfg(windows)]
use super::default_terminal_protocol as proto;
#[cfg(windows)]
use crate::models::settings::DefaultTerminalBackup;
#[cfg(windows)]
use crate::services::SettingsService;
use serde::Serialize;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 默认终端状态（`get_default_terminal_status` 的返回结构）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultTerminalStatus {
    /// 当前 `DelegationTerminal` 是否指向 TerminalBuddy（以注册表为准）。
    pub enabled: bool,
    /// 状态码：notConfigured | ours | windowsTerminal | conhostForced | other
    pub state: String,
    /// 中文一句话状态描述。
    pub description: String,
    /// 本进程 COM 类对象是否已注册成功。
    pub com_registered: bool,
    /// LocalServer32 是否已注册（进程未启动时 COM 据此拉起）。
    pub local_server_registered: bool,
}

/// 读取 `HKCU\<path>` 下的 REG_SZ 值；不存在返回 Ok(None)。
#[cfg(windows)]
fn read_sz(path: &str, name: &str) -> Result<Option<String>, String> {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::*;

    let key_wide = to_wide(path);
    let name_wide = to_wide(name);
    unsafe {
        let mut hkey = HKEY::default();
        let result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            windows::core::PCWSTR(key_wide.as_ptr()),
            Some(0),
            KEY_QUERY_VALUE,
            &mut hkey,
        );
        if result != ERROR_SUCCESS {
            // 键不存在视为「无值」。
            return Ok(None);
        }
        let mut kind = REG_VALUE_TYPE(0);
        let mut size = 0u32;
        let query = RegQueryValueExW(
            hkey,
            windows::core::PCWSTR(name_wide.as_ptr()),
            None,
            Some(&mut kind),
            None,
            Some(&mut size),
        );
        if query != ERROR_SUCCESS {
            let _ = RegCloseKey(hkey);
            return Ok(None);
        }
        let mut buf = vec![0u8; size.max(2) as usize];
        let query = RegQueryValueExW(
            hkey,
            windows::core::PCWSTR(name_wide.as_ptr()),
            None,
            Some(&mut kind),
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        );
        let _ = RegCloseKey(hkey);
        if query != ERROR_SUCCESS {
            return Ok(None);
        }
        // REG_SZ 按 UTF-16 解码，去掉尾部 NUL。
        let units: Vec<u16> = buf
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|u| *u != 0)
            .collect();
        Ok(Some(proto::decode_utf16_lossy(&units)))
    }
}

/// 写入 `HKCU\<path>` 下的 REG_SZ 值（键不存在则创建）。
#[cfg(windows)]
fn write_sz(path: &str, name: &str, value: &str) -> Result<(), String> {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::*;

    let key_wide = to_wide(path);
    let name_wide = to_wide(name);
    unsafe {
        let mut hkey = HKEY::default();
        let result = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            windows::core::PCWSTR(key_wide.as_ptr()),
            Some(0),
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        );
        if result != ERROR_SUCCESS {
            return Err(format!("创建注册表键失败: {}", result.to_hresult().0));
        }
        let wide = to_wide(value);
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
            return Err(format!("写入注册表值失败: {}", result.to_hresult().0));
        }
    }
    Ok(())
}

/// 删除 `HKCU\<path>` 下的值；不存在视为成功。
#[cfg(windows)]
fn delete_sz(path: &str, name: &str) -> Result<(), String> {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::*;

    let key_wide = to_wide(path);
    let name_wide = to_wide(name);
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
            return Ok(());
        }
        let result = RegDeleteValueW(hkey, windows::core::PCWSTR(name_wide.as_ptr()));
        let _ = RegCloseKey(hkey);
        // 文件未找到 = 已删除/不存在，视为成功。
        if result != ERROR_SUCCESS && result != windows::Win32::Foundation::ERROR_FILE_NOT_FOUND {
            return Err(format!("删除注册表值失败: {}", result.to_hresult().0));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn read_delegation_values() -> Result<(Option<String>, Option<String>), String> {
    let console = read_sz(proto::KEY_DELEGATION_STARTUP, proto::VALUE_DELEGATION_CONSOLE)?;
    let terminal = read_sz(proto::KEY_DELEGATION_STARTUP, proto::VALUE_DELEGATION_TERMINAL)?;
    Ok((console, terminal))
}

#[cfg(windows)]
fn write_delegation_value(name: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => write_sz(proto::KEY_DELEGATION_STARTUP, name, value),
        None => delete_sz(proto::KEY_DELEGATION_STARTUP, name),
    }
}

/// 注册 LocalServer32（幂等覆盖写，升级换路径后自动纠正）。
#[cfg(windows)]
pub fn ensure_local_server_registered() -> Result<(), String> {
    let exe_path =
        std::env::current_exe().map_err(|e| format!("获取程序路径失败: {}", e))?;
    let command = proto::build_local_server_command(&exe_path.to_string_lossy());
    let path = format!(
        r"Software\Classes\CLSID\{}\LocalServer32",
        proto::CLSID_TERMINAL_BUDDY_HANDOFF
    );
    write_sz(&path, "", &command)?;
    // 默认值给个友好名，便于在注册表里辨认。
    let clsid_path = format!(
        r"Software\Classes\CLSID\{}",
        proto::CLSID_TERMINAL_BUDDY_HANDOFF
    );
    write_sz(&clsid_path, "", "TerminalBuddy Default Terminal Handoff")
}

#[cfg(windows)]
pub fn is_local_server_registered() -> bool {
    let path = format!(
        r"Software\Classes\CLSID\{}\LocalServer32",
        proto::CLSID_TERMINAL_BUDDY_HANDOFF
    );
    matches!(read_sz(&path, ""), Ok(Some(value)) if !value.is_empty())
}

/// 读取当前状态（以注册表为权威来源）。
#[cfg(windows)]
pub fn get_status(com_registered: bool) -> DefaultTerminalStatus {
    let state = match read_delegation_values() {
        Ok((_, terminal)) => proto::derive_state(terminal.as_deref(), proto::CLSID_TERMINAL_BUDDY_HANDOFF),
        Err(_) => proto::DefaultTerminalState::NotConfigured,
    };
    DefaultTerminalStatus {
        enabled: state == proto::DefaultTerminalState::Ours,
        state: state.code().to_string(),
        description: state.description(),
        com_registered,
        local_server_registered: is_local_server_registered(),
    }
}

/// 开关接管。开启：备份旧值（仅备份为空时）→ 注册 LocalServer32 → 写委托值；
/// 关闭：按备份恢复（None → 删值）。
#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> Result<DefaultTerminalStatus, String> {
    if enabled {
        // 幂等：backup 只在为空时记录，保证开→关→开→关回到最初值。
        if SettingsService::get_settings()
            .default_terminal_backup
            .is_none()
        {
            let (console, terminal) = read_delegation_values()?;
            let backup = DefaultTerminalBackup {
                delegation_console: console,
                delegation_terminal: terminal,
            };
            SettingsService::mutate_settings(|s| {
                s.default_terminal_backup = Some(backup);
            })?;
        }
        ensure_local_server_registered()?;
        let (console, terminal) = proto::enable_target_values();
        write_delegation_value(proto::VALUE_DELEGATION_CONSOLE, Some(console))?;
        write_delegation_value(proto::VALUE_DELEGATION_TERMINAL, Some(terminal))?;
        SettingsService::mutate_settings(|s| s.default_terminal_enabled = true)?;
    } else {
        let backup = SettingsService::get_settings().default_terminal_backup;
        let (console, terminal) = match &backup {
            Some(backup) => {
                use proto::ValueRestore;
                let console = match proto::plan_value_restore(backup.delegation_console.as_deref())
                {
                    ValueRestore::Write(value) => Some(value),
                    ValueRestore::Delete => None,
                };
                let terminal = match proto::plan_value_restore(backup.delegation_terminal.as_deref())
                {
                    ValueRestore::Write(value) => Some(value),
                    ValueRestore::Delete => None,
                };
                (console, terminal)
            }
            // 无备份（外部已写过我们的值）：直接删除，恢复「让 Windows 决定」。
            None => (None, None),
        };
        write_delegation_value(proto::VALUE_DELEGATION_CONSOLE, console.as_deref())?;
        write_delegation_value(proto::VALUE_DELEGATION_TERMINAL, terminal.as_deref())?;
        // 备份保留不删：重复关→开→关仍回到最初值。
        SettingsService::mutate_settings(|s| s.default_terminal_enabled = false)?;
    }
    Ok(get_status(super::handoff_server::is_com_registered()))
}

// ── 非 Windows 占位实现 ──────────────────────────────────────────────────────
// 默认终端接管依赖 Windows 注册表与 COM 类注册，其他平台保持同名接口，
// 保证调用方与 Tauri 命令注册在编译期一致。

#[cfg(not(windows))]
pub fn ensure_local_server_registered() -> Result<(), String> {
    Err("默认终端接管仅支持 Windows 桌面端".to_string())
}

#[cfg(not(windows))]
pub fn is_local_server_registered() -> bool {
    false
}

#[cfg(not(windows))]
pub fn get_status(com_registered: bool) -> DefaultTerminalStatus {
    DefaultTerminalStatus {
        enabled: false,
        state: "notConfigured".to_string(),
        description: "当前平台不支持默认终端接管".to_string(),
        com_registered,
        local_server_registered: false,
    }
}

#[cfg(not(windows))]
pub fn set_enabled(_enabled: bool) -> Result<DefaultTerminalStatus, String> {
    Err("默认终端接管仅支持 Windows 桌面端".to_string())
}
