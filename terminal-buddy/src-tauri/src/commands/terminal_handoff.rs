#![allow(non_snake_case)]

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Com::*;
use windows_core::*;
use crate::commands::TerminalService;
use crate::services::PathService;

// ── TERMINAL_STARTUP_INFO ────────────────────────────────────────────
// Must match the IDL layout exactly for COM marshalling.
#[repr(C)]
pub struct TerminalStartupInfo {
    pub psz_title: PWSTR,
    pub psz_icon_path: PWSTR,
    pub icon_index: i32,
    pub dw_x: u32,
    pub dw_y: u32,
    pub dw_x_size: u32,
    pub dw_y_size: u32,
    pub dw_x_count_chars: u32,
    pub dw_y_count_chars: u32,
    pub dw_fill_attribute: u32,
    pub dw_flags: u32,
    pub w_show_window: u16,
}

// ── ITerminalHandoff3 (IID: 6F23DA90-15C5-4203-9DB0-64E73F1B1B00) ───
#[interface("6F23DA90-15C5-4203-9DB0-64E73F1B1B00")]
pub unsafe trait ITerminalHandoff3: IUnknown {
    unsafe fn EstablishPtyHandoff(
        &self,
        r#in: *mut HANDLE,
        out: *mut HANDLE,
        signal: HANDLE,
        reference: HANDLE,
        server: HANDLE,
        client: HANDLE,
        startupinfo: *const TerminalStartupInfo,
    ) -> HRESULT;
}

// ── IDefaultTerminalMarker (IID: 746E6BC0-AB05-4E38-AB14-71E86763141F)
#[interface("746E6BC0-AB05-4E38-AB14-71E86763141F")]
pub unsafe trait IDefaultTerminalMarker: IUnknown {}

// ── TerminalBuddy CLSID ──────────────────────────────────────────────
// We reuse Windows Terminal's OpenConsole CLSID for DelegationConsole
// so we only implement ITerminalHandoff3 (the Terminal/UX side).
pub const CLSID_TERMINALBUDDY_TERMINAL: GUID =
    GUID::from_u128(0xA1B2C3D4_E5F6_7890_ABCD_EF1234567890);

/// Global app handle, set once during Tauri setup.
static APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);

pub fn set_app_handle(handle: AppHandle) {
    let mut g = APP_HANDLE.lock().unwrap();
    *g = Some(handle);
}

fn log_debug(msg: &str) {
    let log_path = PathService::get_debug_log_path();
    let ts = chrono::Utc::now().format("%H:%M:%S%.3f");
    let line = format!("[{}] {}\n", ts, msg);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

// ── COM Implementation ───────────────────────────────────────────────

#[implement(ITerminalHandoff3, IDefaultTerminalMarker)]
pub struct TerminalBuddyHandoff;

impl ITerminalHandoff3_Impl for TerminalBuddyHandoff_Impl {
    unsafe fn EstablishPtyHandoff(
        &self,
        pty_in: *mut HANDLE,
        pty_out: *mut HANDLE,
        signal: HANDLE,
        reference: HANDLE,
        server: HANDLE,
        client: HANDLE,
        startupinfo: *const TerminalStartupInfo,
    ) -> HRESULT {
        log_debug("[handoff] EstablishPtyHandoff called");

        // Create pipes for PTY I/O (ITerminalHandoff3: terminal creates pipes)
        let (our_read, their_write) = match create_pipe_pair() {
            Ok(h) => h,
            Err(e) => {
                log_debug(&format!("[handoff] create_pipe_pair failed: {:?}", e));
                return e.code();
            }
        };
        let (their_read, our_write) = match create_pipe_pair() {
            Ok(h) => h,
            Err(e) => {
                log_debug(&format!("[handoff] create_pipe_pair(2) failed: {:?}", e));
                return e.code();
            }
        };

        // Return the pipes to the caller (OpenConsole)
        *pty_in = their_read;
        *pty_out = their_write;

        // Extract startup info
        let title = if !startupinfo.is_null() && !(*startupinfo).psz_title.is_null() {
            wide_ptr_to_string((*startupinfo).psz_title)
        } else {
            String::new()
        };
        log_debug(&format!("[handoff] title={}", title));

        // Create the terminal instance directly in Rust via TerminalService
        let terminal_id = if let Ok(g) = APP_HANDLE.lock() {
            if let Some(app) = g.as_ref() {
                let svc = app.state::<TerminalService>();
                match svc.create_handoff_terminal(
                    our_read, our_write,
                    signal, reference, server, client,
                    app.clone(), &title,
                ) {
                    Ok(id) => {
                        log_debug(&format!("[handoff] terminal created, id={}", id));
                        Some(id)
                    }
                    Err(e) => {
                        log_debug(&format!("[handoff] create_handoff_terminal failed: {}", e));
                        None
                    }
                }
            } else {
                log_debug("[handoff] APP_HANDLE not set");
                None
            }
        } else {
            log_debug("[handoff] APP_HANDLE lock failed");
            None
        };

        // Notify the frontend with just the terminal ID
        if let Some(id) = terminal_id {
            if let Ok(g) = APP_HANDLE.lock() {
                if let Some(app) = g.as_ref() {
                    let payload = serde_json::json!({
                        "terminalId": id,
                        "title": title,
                    });
                    match app.emit("terminal_handoff", &payload) {
                        Ok(()) => log_debug("[handoff] emitted terminal_handoff event"),
                        Err(e) => log_debug(&format!("[handoff] emit failed: {:?}", e)),
                    }
                }
            }
        }

        HRESULT(0)
    }
}

impl IDefaultTerminalMarker_Impl for TerminalBuddyHandoff_Impl {
    // Marker interface — no methods
}

// ── Helpers ──────────────────────────────────────────────────────────

fn create_pipe_pair() -> std::result::Result<(HANDLE, HANDLE), Error> {
    use windows::Win32::System::Pipes::CreatePipe;
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    unsafe { CreatePipe(&mut read, &mut write, None, 0).map(|_| (read, write)) }
}

fn wide_ptr_to_string(ptr: PWSTR) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0usize;
        while *ptr.0.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(ptr.0, len);
        String::from_utf16_lossy(slice)
    }
}

// ── COM Server Registration ──────────────────────────────────────────

static COM_REGISTRATION: Mutex<Option<u32>> = Mutex::new(None);

/// Register the COM server so Windows can activate us as default terminal.
/// Must be called on the STA (UI) thread.
pub fn register_com_server() -> std::result::Result<(), String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| format!("CoInitializeEx failed: {:?}", e))?;

        let handoff: ITerminalHandoff3 = TerminalBuddyHandoff.into();
        let unknown: IUnknown = handoff
            .cast()
            .map_err(|e| format!("cast to IUnknown failed: {:?}", e))?;

        let cookie = CoRegisterClassObject(
            &CLSID_TERMINALBUDDY_TERMINAL,
            &unknown,
            CLSCTX_LOCAL_SERVER,
            REGCLS_MULTIPLEUSE,
        )
        .map_err(|e| format!("CoRegisterClassObject failed: {:?}", e))?;

        let mut reg = COM_REGISTRATION.lock().unwrap();
        *reg = Some(cookie);

        log_debug(&format!(
            "[handoff] COM server registered, CLSID={:?}, cookie={}",
            CLSID_TERMINALBUDDY_TERMINAL, cookie
        ));

        Ok(())
    }
}

/// Revoke the COM server registration. Call on shutdown.
pub fn unregister_com_server() -> std::result::Result<(), String> {
    let cookie = {
        let mut reg = COM_REGISTRATION.lock().unwrap();
        reg.take()
    };

    if let Some(cookie) = cookie {
        unsafe {
            CoRevokeClassObject(cookie)
                .map_err(|e| format!("CoRevokeClassObject failed: {:?}", e))?;
        }
        log_debug("[handoff] COM server unregistered");
    }

    Ok(())
}

// ── Registry Operations ──────────────────────────────────────────────

const REGISTRY_KEY: &str = r"Console\%%Startup";
const DELEGATION_CONSOLE: &str = "DelegationConsole";
const DELEGATION_TERMINAL: &str = "DelegationTerminal";

/// CLSID for Windows Terminal's OpenConsole (used as DelegationConsole)
const CLSID_WT_OPENCONSOLE: &str = "{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}";

/// Check if TerminalBuddy is currently set as the default terminal.
pub fn is_default_terminal() -> bool {
    read_delegation_terminal() == format!("{:?}", CLSID_TERMINALBUDDY_TERMINAL)
}

/// Set TerminalBuddy as the default terminal by writing to the registry.
pub fn set_as_default_terminal() -> std::result::Result<(), String> {
    use windows::Win32::System::Registry::*;
    use windows::core::HSTRING;

    let terminal_clsid = format!("{:?}", CLSID_TERMINALBUDDY_TERMINAL);

    // Step 1: Register our CLSID under HKCR so COM can find and launch us
    register_clsid_local_server()?;

    // Step 2: Write DelegationConsole/DelegationTerminal values
    unsafe {
        let key_path = HSTRING::from(REGISTRY_KEY);
        let mut hkey = Default::default();

        let opened = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            &key_path,
            None,
            KEY_SET_VALUE,
            &mut hkey,
        );

        let hkey = if opened.is_ok() {
            hkey
        } else {
            let mut disposition = REG_CREATE_KEY_DISPOSITION(0);
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                &key_path,
                None,
                None,
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut hkey,
                Some(&mut disposition),
            )
            .ok()
            .map_err(|e| format!("RegCreateKeyExW failed: {:?}", e))?;
            hkey
        };

        let console_value = HSTRING::from(CLSID_WT_OPENCONSOLE);
        let terminal_value = HSTRING::from(&terminal_clsid);

        set_reg_sz(&hkey, DELEGATION_CONSOLE, &console_value)?;
        set_reg_sz(&hkey, DELEGATION_TERMINAL, &terminal_value)?;

        let _ = RegCloseKey(hkey);

        log_debug(&format!(
            "[handoff] set as default terminal, DelegationConsole={}, DelegationTerminal={}",
            CLSID_WT_OPENCONSOLE, terminal_clsid
        ));
    }

    Ok(())
}

/// Register our COM CLSID with LocalServer32 pointing to our executable.
/// This allows Windows to auto-launch TerminalBuddy when it's not running.
fn register_clsid_local_server() -> std::result::Result<(), String> {
    use windows::Win32::System::Registry::*;
    use windows::core::HSTRING;

    let clsid_str = format!("{:?}", CLSID_TERMINALBUDDY_TERMINAL);
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Cannot get exe path: {}", e))?;
    let exe_path_str = exe_path.to_string_lossy().to_string();

    unsafe {
        // Create HKCU\Software\Classes\CLSID\{our-clsid}
        let key_path = HSTRING::from(format!("Software\\Classes\\CLSID\\{}", clsid_str));
        let mut hkey = Default::default();

        let mut disposition = REG_CREATE_KEY_DISPOSITION(0);
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            &key_path,
            None,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            Some(&mut disposition),
        )
        .ok()
        .map_err(|e| format!("RegCreateKeyExW(CLSID) failed: {:?}", e))?;

        // Set default value to a friendly name
        set_reg_sz(&hkey, "", &HSTRING::from("TerminalBuddy Terminal Handoff"))?;
        let _ = RegCloseKey(hkey);

        // Create LocalServer32 subkey
        let ls_key_path = HSTRING::from(format!("Software\\Classes\\CLSID\\{}\\LocalServer32", clsid_str));
        let mut ls_hkey = Default::default();
        let mut ls_disposition = REG_CREATE_KEY_DISPOSITION(0);
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            &ls_key_path,
            None,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut ls_hkey,
            Some(&mut ls_disposition),
        )
        .ok()
        .map_err(|e| format!("RegCreateKeyExW(LocalServer32) failed: {:?}", e))?;

        // Set default value to our exe path
        set_reg_sz(&ls_hkey, "", &HSTRING::from(&exe_path_str))?;
        let _ = RegCloseKey(ls_hkey);

        log_debug(&format!("[handoff] CLSID registered, LocalServer32={}", exe_path_str));
    }

    Ok(())
}

/// Remove our CLSID registration from HKCR.
fn unregister_clsid_local_server() -> std::result::Result<(), String> {
    use windows::Win32::System::Registry::*;
    use windows::core::HSTRING;

    let clsid_str = format!("{:?}", CLSID_TERMINALBUDDY_TERMINAL);

    unsafe {
        // Delete LocalServer32 subkey first
        let ls_key_path = HSTRING::from(format!("Software\\Classes\\CLSID\\{}\\LocalServer32", clsid_str));
        let _ = RegDeleteKeyW(HKEY_CURRENT_USER, &ls_key_path);

        // Delete CLSID key
        let key_path = HSTRING::from(format!("Software\\Classes\\CLSID\\{}", clsid_str));
        let _ = RegDeleteKeyW(HKEY_CURRENT_USER, &key_path);

        log_debug("[handoff] CLSID unregistered from HKCR");
    }

    Ok(())
}

/// Remove TerminalBuddy as the default terminal (reset to "Let Windows decide").
pub fn unset_as_default_terminal() -> std::result::Result<(), String> {
    use windows::Win32::System::Registry::*;
    use windows::core::HSTRING;

    let current = read_delegation_terminal();
    let terminal_clsid = format!("{:?}", CLSID_TERMINALBUDDY_TERMINAL);

    // Only reset if we are currently the default
    if current != terminal_clsid {
        return Ok(());
    }

    unsafe {
        let key_path = HSTRING::from(REGISTRY_KEY);
        let mut hkey = Default::default();

        let opened = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            &key_path,
            None,
            KEY_SET_VALUE,
            &mut hkey,
        );

        if opened.is_err() {
            return Ok(()); // Key doesn't exist, nothing to do
        }

        let default_value = HSTRING::from("{00000000-0000-0000-0000-000000000000}");

        set_reg_sz(&hkey, DELEGATION_CONSOLE, &default_value)?;
        set_reg_sz(&hkey, DELEGATION_TERMINAL, &default_value)?;

        let _ = RegCloseKey(hkey);

        // Clean up CLSID registration
        let _ = unregister_clsid_local_server();

        log_debug("[handoff] unset as default terminal (reset to default)");
    }

    Ok(())
}

/// Helper: write a REG_SZ value (UTF-16LE with null terminator).
unsafe fn set_reg_sz(
    hkey: &windows::Win32::System::Registry::HKEY,
    name: &str,
    value: &HSTRING,
) -> std::result::Result<(), String> {
    use windows::Win32::System::Registry::*;
    use windows::core::HSTRING;

    let wide: Vec<u16> = value.to_string().encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = std::slice::from_raw_parts(
        wide.as_ptr() as *const u8,
        wide.len() * 2,
    );

    RegSetValueExW(
        *hkey,
        &HSTRING::from(name),
        None,
        REG_SZ,
        Some(bytes),
    )
    .ok()
    .map_err(|e| format!("RegSetValueExW({}) failed: {:?}", name, e))
}

/// Read the current DelegationTerminal value from registry.
fn read_delegation_terminal() -> String {
    use windows::Win32::System::Registry::*;
    use windows::core::HSTRING;

    unsafe {
        let key_path = HSTRING::from(REGISTRY_KEY);
        let mut hkey = Default::default();

        let opened = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            &key_path,
            None,
            KEY_QUERY_VALUE,
            &mut hkey,
        );

        if opened.is_err() {
            return String::new();
        }

        let value_name = HSTRING::from(DELEGATION_TERMINAL);
        let mut buf = [0u16; 128];
        let mut buf_len = (buf.len() * 2) as u32;
        let mut reg_type = REG_VALUE_TYPE(0);

        let ok = RegQueryValueExW(
            hkey,
            &value_name,
            None,
            Some(&mut reg_type),
            Some(buf.as_mut_ptr() as *mut u8),
            Some(&mut buf_len),
        );

        let _ = RegCloseKey(hkey);

        if ok.is_err() || reg_type != REG_SZ {
            return String::new();
        }

        let chars = buf_len as usize / 2;
        let s = String::from_utf16_lossy(&buf[..chars]);
        s.trim_end_matches('\0').to_string()
    }
}

// ── Tauri Commands ───────────────────────────────────────────────────

#[tauri::command]
pub fn is_default_terminal_setting() -> bool {
    is_default_terminal()
}

#[tauri::command]
pub fn set_default_terminal(enabled: bool) -> std::result::Result<(), String> {
    if enabled {
        set_as_default_terminal()
    } else {
        unset_as_default_terminal()
    }
}
