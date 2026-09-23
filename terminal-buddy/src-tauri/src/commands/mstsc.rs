//! mstsc 远程桌面子系统：进程跟踪 + Windows 凭据管理器写入 + 启动。
//! 与 PTY 终端生命周期无耦合，仅由 profile 配置驱动。

use crate::services::ProfileService;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::command;

// 跟踪已启动的 mstsc 进程 PID，key = profile_id
static MSTSC_PROCESSES: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

fn mstsc_processes() -> &'static Mutex<HashMap<String, u32>> {
    MSTSC_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 检查进程是否仍在运行
fn is_process_running(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION};

    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_QUERY_INFORMATION, false, pid) {
            let mut exit_code: u32 = 0;
            let running =
                windows::Win32::System::Threading::GetExitCodeProcess(handle, &mut exit_code)
                    .is_ok()
                    && exit_code == 259; // STILL_ACTIVE
            let _ = CloseHandle(handle);
            running
        } else {
            false
        }
    }
}

/// 将指定 PID 的窗口提到前台
fn bring_window_to_front(pid: u32) -> bool {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
    };

    struct EnumCtx {
        target_pid: u32,
        found_hwnd: Option<HWND>,
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut EnumCtx) };
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == ctx.target_pid && unsafe { IsWindowVisible(hwnd) }.as_bool() {
            ctx.found_hwnd = Some(hwnd);
            return windows::core::BOOL(0); // stop enumeration
        }
        windows::core::BOOL(1) // continue
    }

    let mut ctx = EnumCtx {
        target_pid: pid,
        found_hwnd: None,
    };
    unsafe {
        let _ = EnumWindows(Some(enum_callback), LPARAM(&mut ctx as *mut _ as isize));
        if let Some(hwnd) = ctx.found_hwnd {
            let _ = SetForegroundWindow(hwnd);
            return true;
        }
    }
    false
}

/// 直接写入 Windows 凭据管理器，避免每次连接都启动并等待 cmdkey.exe。
fn store_mstsc_credential(host: &str, user: &str, password: &str) -> windows::core::Result<()> {
    use windows::core::PWSTR;
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let mut target: Vec<u16> = format!("TERMSRV/{}", host)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut username: Vec<u16> = user.encode_utf16().chain(Some(0)).collect();
    let mut password: Vec<u16> = password.encode_utf16().collect();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR::from_raw(target.as_mut_ptr()),
        CredentialBlobSize: (password.len() * size_of::<u16>()) as u32,
        CredentialBlob: password.as_mut_ptr().cast::<u8>(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR::from_raw(username.as_mut_ptr()),
        ..Default::default()
    };

    unsafe { CredWriteW(&credential, 0) }
}

#[command]
pub fn start_mstsc(profile_id: String) -> Result<(), String> {
    let profile =
        ProfileService::get_profile(&profile_id).map_err(|e| format!("配置不存在: {}", e))?;

    let host = profile
        .mstsc_host
        .as_ref()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "请先配置远程主机地址".to_string())?;

    // 检查是否已有该 Profile 的 mstsc 进程在运行
    {
        let mut processes = mstsc_processes().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&pid) = processes.get(&profile_id) {
            if is_process_running(pid) {
                bring_window_to_front(pid);
                return Ok(());
            } else {
                processes.remove(&profile_id);
            }
        }
    }

    let port = profile.mstsc_port.unwrap_or(3389);
    let user = profile.mstsc_user.as_deref().unwrap_or("");
    let password = profile.mstsc_password.as_deref().unwrap_or("");
    let resolution = profile.mstsc_resolution.as_deref().unwrap_or("");

    // 存储凭据到 Windows 凭据管理器
    if !user.is_empty() {
        if let Err(error) = store_mstsc_credential(host, user, password) {
            eprintln!("[mstsc] 写入 Windows 凭据管理器失败: {}", error);
        }
    }

    // 构建 mstsc.exe 参数
    let addr = if port == 3389 {
        host.clone()
    } else {
        format!("{}:{}", host, port)
    };

    let mut args = vec![format!("/v:{}", addr)];

    if !resolution.is_empty() {
        if let Some((w, h)) = resolution.split_once('x') {
            args.push(format!("/w:{}", w));
            args.push(format!("/h:{}", h));
        }
    } else {
        args.push("/f".to_string());
    }

    let child = std::process::Command::new("mstsc.exe")
        .args(&args)
        .spawn()
        .map_err(|e| format!("启动远程桌面失败: {}", e))?;

    let pid = child.id();

    // 记录进程 PID
    {
        let mut processes = mstsc_processes().lock().unwrap_or_else(|e| e.into_inner());
        processes.insert(profile_id.clone(), pid);
    }

    Ok(())
}
