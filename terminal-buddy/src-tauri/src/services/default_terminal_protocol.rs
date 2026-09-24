//! 默认终端（Delegation/Handoff）协议层纯逻辑。
//!
//! 只放可单测的常量、编码与状态判定；注册表读写在 `default_terminal_service`，
//! COM 实现在 `handoff_server`。机制来源：microsoft/terminal spec `#492 - Default
//! Terminal` 与 `src/host/proxy/ITerminalHandoff.idl`（MIT）。

/// TerminalBuddy 的 handoff COM 类 CLSID（LocalServer32 注册 + `DelegationTerminal`）。
pub const CLSID_TERMINAL_BUDDY_HANDOFF: &str = "{8C6F2E4B-1D9A-4E7C-B530-A47E91D0C2F8}";
/// 借用 Windows Terminal 包的 OpenConsole 做 console 侧（`DelegationConsole`）。
pub const CLSID_WINDOWS_TERMINAL_CONSOLE: &str = "{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}";
/// Windows Terminal 的终端侧 CLSID（仅用于状态判定展示）。
pub const CLSID_WINDOWS_TERMINAL_TERMINAL: &str = "{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}";
/// Windows 控制台主机（强制 conhost）。
pub const CLSID_CONHOST: &str = "{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}";
/// 全零 GUID = 「让 Windows 决定」。
pub const CLSID_ZERO: &str = "{00000000-0000-0000-0000-000000000000}";

/// 委托注册表位置：`HKCU\Console\%%Startup`（键名含字面 `%%`，不可展开）。
pub const KEY_DELEGATION_STARTUP: &str = r"Console\%%Startup";
pub const VALUE_DELEGATION_CONSOLE: &str = "DelegationConsole";
pub const VALUE_DELEGATION_TERMINAL: &str = "DelegationTerminal";

/// `ITerminalHandoff3::EstablishPtyHandoff` 里的 resize 信号 ID（winconpty PTY_SIGNAL_RESIZE_WINDOW）。
const PTY_SIGNAL_RESIZE_WINDOW: u16 = 8;

/// resize 信号包：`[u16 8, u16 cols, u16 rows]` 本机字节序，共 6 字节。
/// 注意 cols/rows 顺序对应 COORD 的 X/Y，与 `TerminalBackend::resize(rows, cols)` 参数顺序相反。
pub fn encode_resize_signal(cols: u16, rows: u16) -> [u8; 6] {
    let mut packet = [0u8; 6];
    packet[0..2].copy_from_slice(&PTY_SIGNAL_RESIZE_WINDOW.to_ne_bytes());
    packet[2..4].copy_from_slice(&cols.to_ne_bytes());
    packet[4..6].copy_from_slice(&rows.to_ne_bytes());
    packet
}

/// `TERMINAL_STARTUP_INFO` 的解析产物（BSTR 已解码成 String）。
#[derive(Debug, Clone, PartialEq)]
pub struct TerminalStartupInfo {
    pub title: Option<String>,
    pub icon_path: Option<String>,
    pub icon_index: i32,
    pub x_count_chars: u32,
    pub y_count_chars: u32,
}

impl TerminalStartupInfo {
    /// handoff 会话初始尺寸：优先 `dwXCountChars`/`dwYCountChars`（X=cols、Y=rows），
    /// 单边为 0 或越界一律回退 24x80（前端挂载后还会按容器真实尺寸 resize）。
    pub fn resolve_size(&self) -> (u16, u16) {
        const MAX: u32 = u16::MAX as u32;
        if self.x_count_chars == 0
            || self.y_count_chars == 0
            || self.x_count_chars > MAX
            || self.y_count_chars > MAX
        {
            return (24, 80);
        }
        (self.y_count_chars as u16, self.x_count_chars as u16)
    }
}

/// 从 UTF-16 单元切片解码字符串（有损）。
pub fn decode_utf16_lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// 解码 BSTR（以 NUL 结尾的 UTF-16）。空指针返回 None；上限 4096 单元防御异常数据。
///
/// # Safety
/// `ptr` 必须为 null 或指向可读的 NUL 结尾 UTF-16 缓冲区。
pub unsafe fn decode_bstr_lossy(ptr: *const u16) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let mut len = 0usize;
    while len < 4096 && *ptr.add(len) != 0 {
        len += 1;
    }
    let units = std::slice::from_raw_parts(ptr, len);
    Some(decode_utf16_lossy(units))
}

/// 从进程映像路径取显示名：`C:\Windows\System32\cmd.exe` → `cmd.exe`。
pub fn display_name_from_image_path(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or_default()
        .to_string()
}

/// 从 shell 命令行里取被运行的脚本名：`cmd.exe /c "D:\a\Wms-api-bat.bat"` → `Wms-api-bat`。
///
/// 双击 .bat 时 handoff 的客户端进程就是 cmd.exe，只报映像名会得到「cmd.exe」这种
/// 无信息量的页签标题；命令行里带着真正的脚本路径。
///
/// 故意不按空格分词：Explorer 启动 .bat 用的是 `""D:\my dir\x.cmd" "` 这种双重引号形态，
/// 分词规则吃不准，而文件名一定夹在路径分隔符与扩展名之间，直接定位它最稳。
/// 取不到脚本时返回 None，由调用方回落到原有命名。
pub fn script_name_from_command_line(command_line: &str) -> Option<String> {
    const SCRIPT_EXTENSIONS: [&[u8]; 3] = [b"bat", b"cmd", b"ps1"];
    let bytes = command_line.as_bytes();
    let ends_token = |byte: Option<&u8>| matches!(byte, None | Some(b' ') | Some(b'\t') | Some(b'"'));

    for dot in bytes
        .iter()
        .enumerate()
        .filter(|(_, byte)| **byte == b'.')
        .map(|(index, _)| index)
    {
        let rest = &bytes[dot + 1..];
        let matched = SCRIPT_EXTENSIONS
            .iter()
            .any(|extension| rest.starts_with(extension) && ends_token(rest.get(extension.len())));
        if !matched {
            continue;
        }
        let start = bytes[..dot]
            .iter()
            .rposition(|&byte| matches!(byte, b'\\' | b'/' | b'"'))
            .map_or(0, |index| index + 1);
        let name = command_line.get(start..dot)?.trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

/// 默认终端当前状态（注册表读回后的纯判定）。
#[derive(Debug, Clone, PartialEq)]
pub enum DefaultTerminalState {
    /// 未配置或全零 = 「让 Windows 决定」。
    NotConfigured,
    /// 已是 TerminalBuddy。
    Ours,
    /// Windows 终端。
    WindowsTerminal,
    /// 强制 Windows 控制台主机。
    ConhostForced,
    /// 其他终端。
    Other { terminal_clsid: String },
}

impl DefaultTerminalState {
    /// 序列化给前端的状态码。
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConfigured => "notConfigured",
            Self::Ours => "ours",
            Self::WindowsTerminal => "windowsTerminal",
            Self::ConhostForced => "conhostForced",
            Self::Other { .. } => "other",
        }
    }

    /// 中文一句话状态描述。
    pub fn description(&self) -> String {
        match self {
            Self::NotConfigured => "未配置（让 Windows 决定）".to_string(),
            Self::Ours => "已设为 TerminalBuddy 默认终端".to_string(),
            Self::WindowsTerminal => "当前由 Windows 终端接管".to_string(),
            Self::ConhostForced => "已强制使用 Windows 控制台主机".to_string(),
            Self::Other { terminal_clsid } => format!("由其他终端接管（{}）", terminal_clsid),
        }
    }
}

/// 由 `DelegationTerminal` 值判定状态（大小写不敏感）。
pub fn derive_state(delegation_terminal: Option<&str>, ours: &str) -> DefaultTerminalState {
    let Some(value) = delegation_terminal.map(str::trim).filter(|v| !v.is_empty()) else {
        return DefaultTerminalState::NotConfigured;
    };
    if value.eq_ignore_ascii_case(ours) {
        DefaultTerminalState::Ours
    } else if value.eq_ignore_ascii_case(CLSID_ZERO) {
        DefaultTerminalState::NotConfigured
    } else if value.eq_ignore_ascii_case(CLSID_WINDOWS_TERMINAL_TERMINAL) {
        DefaultTerminalState::WindowsTerminal
    } else if value.eq_ignore_ascii_case(CLSID_CONHOST) {
        DefaultTerminalState::ConhostForced
    } else {
        DefaultTerminalState::Other {
            terminal_clsid: value.to_string(),
        }
    }
}

/// 开启接管时应写入的（DelegationConsole, DelegationTerminal）目标值。
pub fn enable_target_values() -> (&'static str, &'static str) {
    (
        CLSID_WINDOWS_TERMINAL_CONSOLE,
        CLSID_TERMINAL_BUDDY_HANDOFF,
    )
}

/// LocalServer32 注册值：`"exe 路径" -Embedding`（COM 激活时的标准参数）。
pub fn build_local_server_command(exe_path: &str) -> String {
    format!("\"{}\" -Embedding", exe_path)
}

/// 关闭接管时单个注册表值的恢复动作。
#[derive(Debug, Clone, PartialEq)]
pub enum ValueRestore {
    /// 备份值存在：写回。
    Write(String),
    /// 备份时不存在：删除。
    Delete,
}

/// 恢复计划：备份为 None → 删值（恢复「让 Windows 决定」）。
pub fn plan_value_restore(backup: Option<&str>) -> ValueRestore {
    match backup {
        Some(value) => ValueRestore::Write(value.to_string()),
        None => ValueRestore::Delete,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_resize_signal_layout() {
        assert_eq!(encode_resize_signal(80, 24), [8, 0, 80, 0, 24, 0]);
        assert_eq!(encode_resize_signal(500, 500), [8, 0, 244, 1, 244, 1]);
        assert_eq!(encode_resize_signal(1, 1), [8, 0, 1, 0, 1, 0]);
    }

    #[test]
    fn resolve_size_prefers_count_chars() {
        let info = TerminalStartupInfo {
            title: None,
            icon_path: None,
            icon_index: 0,
            x_count_chars: 120,
            y_count_chars: 40,
        };
        assert_eq!(info.resolve_size(), (40, 120));
    }

    #[test]
    fn resolve_size_fallback_on_zero_or_partial() {
        let zero = TerminalStartupInfo {
            title: None,
            icon_path: None,
            icon_index: 0,
            x_count_chars: 0,
            y_count_chars: 0,
        };
        assert_eq!(zero.resolve_size(), (24, 80));
        let partial = TerminalStartupInfo {
            x_count_chars: 0,
            y_count_chars: 30,
            ..zero
        };
        assert_eq!(partial.resolve_size(), (24, 80));
    }

    #[test]
    fn display_name_extraction() {
        assert_eq!(
            display_name_from_image_path(r"C:\Windows\System32\cmd.exe"),
            "cmd.exe"
        );
        assert_eq!(display_name_from_image_path("pwsh.exe"), "pwsh.exe");
        assert_eq!(display_name_from_image_path(""), "");
        assert_eq!(display_name_from_image_path(r"C:\dir\"), "");
    }

    #[test]
    fn derive_state_all_five() {
        let ours = CLSID_TERMINAL_BUDDY_HANDOFF;
        assert_eq!(
            derive_state(None, ours),
            DefaultTerminalState::NotConfigured
        );
        assert_eq!(
            derive_state(Some(CLSID_ZERO), ours),
            DefaultTerminalState::NotConfigured
        );
        assert_eq!(
            derive_state(Some(ours.to_lowercase().as_str()), ours),
            DefaultTerminalState::Ours
        );
        assert_eq!(
            derive_state(Some(CLSID_WINDOWS_TERMINAL_TERMINAL), ours),
            DefaultTerminalState::WindowsTerminal
        );
        assert_eq!(
            derive_state(Some(CLSID_CONHOST), ours),
            DefaultTerminalState::ConhostForced
        );
        assert_eq!(
            derive_state(Some("{11111111-2222-3333-4444-555555555555}"), ours),
            DefaultTerminalState::Other {
                terminal_clsid: "{11111111-2222-3333-4444-555555555555}".to_string()
            }
        );
    }

    #[test]
    fn decode_utf16_and_bstr() {
        assert_eq!(decode_utf16_lossy(&[0x4F60, 0x597D]), "你好");
        // 孤立代理项按有损替换，不 panic
        assert!(decode_utf16_lossy(&[0xD800, 0x0041]).contains('A'));
        unsafe {
            assert_eq!(decode_bstr_lossy(std::ptr::null()), None);
            let units = [0x63u16, 0x6D, 0x64, 0]; // "cmd"
            assert_eq!(decode_bstr_lossy(units.as_ptr()), Some("cmd".to_string()));
        }
    }

    #[test]
    fn local_server_command_quotes_path() {
        assert_eq!(
            build_local_server_command(r"C:\Program Files\TerminalBuddy\TerminalBuddy.exe"),
            "\"C:\\Program Files\\TerminalBuddy\\TerminalBuddy.exe\" -Embedding"
        );
    }

    #[test]
    fn enable_target_values_are_fixed() {
        let (console, terminal) = enable_target_values();
        assert_eq!(console, CLSID_WINDOWS_TERMINAL_CONSOLE);
        assert_eq!(terminal, CLSID_TERMINAL_BUDDY_HANDOFF);
    }

    #[test]
    fn restore_plan_both_branches() {
        assert_eq!(
            plan_value_restore(Some("{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}")),
            ValueRestore::Write("{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}".to_string())
        );
        assert_eq!(plan_value_restore(None), ValueRestore::Delete);
    }

    #[test]
    fn script_name_extracted_from_shell_command_line() {
        assert_eq!(
            script_name_from_command_line(r#"cmd.exe /c D:\gitee\TerminalBuddy\Wms-api-bat.bat"#).as_deref(),
            Some("Wms-api-bat")
        );
        // Explorer 启动 .bat 的经典双重引号形态，且路径含空格
        assert_eq!(
            script_name_from_command_line(r#""C:\Windows\system32\cmd.exe" /c ""D:\my dir\build and run.cmd" ""#).as_deref(),
            Some("build and run")
        );
        assert_eq!(
            script_name_from_command_line(r#"powershell.exe -NoProfile -File D:\a\deploy.ps1"#).as_deref(),
            Some("deploy")
        );
        // 纯交互 shell 与未知扩展名都不该改名
        assert_eq!(script_name_from_command_line(r#"cmd.exe /K"#), None);
        assert_eq!(script_name_from_command_line(r#"cmd.exe /c echo hi.txt"#), None);
        assert_eq!(script_name_from_command_line(""), None);
    }
}
