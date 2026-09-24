//! 默认终端 handoff 的 COM 服务端。
//!
//! 注册 `CLSID_TERMINAL_BUDDY_HANDOFF`（LocalServer32，`REGCLS_MULTIPLEUSE`），
//! 实现 `ITerminalHandoff3` + `IDefaultTerminalMarker`。OpenConsole 激活后调
//! `EstablishPtyHandoff`：由本端创建 in/out 管道（v3 语义），把 console 端句柄经
//! `[out]` 交回，自己保留 in 写端 / out 读端驱动会话。
//!
//! 句柄所有权（见 microsoft/terminal `CTerminalHandoff.h` 注释，MIT）：COM 会在
//! 调用返回后释放 `[in]` 句柄与我们交回的 `[out]` 句柄副本，需要长期持有的
//! signal/reference/server/client 必须先 `DuplicateHandle`。
//!
//! vtable 手写（不用 windows `#[implement]` 宏）：`[out] HANDLE*` + 内嵌 BSTR 的
//! 结构体参数要求 ABI 与 IDL 逐字节一致，手写最可控。

use super::default_terminal_protocol as proto;
use crate::commands::TerminalService;
use std::ffi::c_void;
use std::fs::File;
use std::io::Write;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

// ── Win32 原始声明（ole32 / kernel32）────────────────────────────────────────

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(pv_reserved: *mut c_void, dw_co_init: u32) -> i32;
    fn CoRegisterClassObject(
        rclsid: *const Guid,
        lpunk: *mut c_void,
        dw_cls_context: u32,
        flags: u32,
        lpdw_register: *mut u32,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn CreatePipe(
        h_read_pipe: *mut RawHandle,
        h_write_pipe: *mut RawHandle,
        lp_pipe_attributes: *mut c_void,
        n_size: u32,
    ) -> i32;
    fn CloseHandle(h_object: RawHandle) -> i32;
    fn OpenProcess(dw_desired_access: u32, b_inherit_handle: i32, dw_process_id: u32) -> RawHandle;
    fn ReadProcessMemory(
        h_process: RawHandle,
        lp_base_address: *const c_void,
        lp_buffer: *mut c_void,
        n_size: usize,
        lp_number_of_bytes_read: *mut usize,
    ) -> i32;
    fn DuplicateHandle(
        h_source_process: RawHandle,
        h_source: RawHandle,
        h_target_process: RawHandle,
        lp_target: *mut RawHandle,
        dw_desired_access: u32,
        b_inherit_handle: i32,
        dw_options: u32,
    ) -> i32;
    fn GetCurrentProcess() -> RawHandle;
    fn GetProcessId(handle: RawHandle) -> u32;
    fn GetExitCodeProcess(handle: RawHandle, lp_exit_code: *mut u32) -> i32;
    fn QueryFullProcessImageNameW(
        handle: RawHandle,
        dw_flags: u32,
        lp_exe_name: *mut u16,
        lpdw_size: *mut u32,
    ) -> i32;
    fn WaitForSingleObject(handle: RawHandle, dw_milliseconds: u32) -> u32;
    fn TerminateProcess(handle: RawHandle, exit_code: u32) -> i32;
}

const COINIT_MULTITHREADED: u32 = 0;

#[link(name = "ntdll")]
extern "system" {
    fn NtQueryInformationProcess(
        process_handle: RawHandle,
        information_class: u32,
        information: *mut c_void,
        information_length: u32,
        return_length: *mut u32,
    ) -> i32;
}

/// `PROCESS_INFORMATION_CLASS.ProcessBasicInformation`
const PROCESS_BASIC_INFORMATION_CLASS: u32 = 0;
const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
const PROCESS_VM_READ: u32 = 0x0010;
/// x64 布局：PEB.ProcessParameters 与 RTL_USER_PROCESS_PARAMETERS.CommandLine 的偏移。
/// 偏移不符时读出来的是无意义字节，长度校验会先失败并回落到原有命名，不会误改标题。
const PEB_PROCESS_PARAMETERS_OFFSET: usize = 0x20;
const PROCESS_PARAMETERS_COMMAND_LINE_OFFSET: usize = 0x70;
const MAX_COMMAND_LINE_BYTES: usize = 0x2_0000;
const CLSCTX_LOCAL_SERVER: u32 = 0x4;
const REGCLS_MULTIPLEUSE: u32 = 0x1;
const DUPLICATE_SAME_ACCESS: u32 = 0x2;
const WAIT_TIMEOUT: u32 = 0x102;

const S_OK: i32 = 0;
const E_FAIL: i32 = 0x80004005u32 as i32;
const E_NOINTERFACE: i32 = 0x80004002u32 as i32;
const E_POINTER: i32 = 0x80004003u32 as i32;
const CLASS_E_NOAGGREGATION: i32 = 0x80040111u32 as i32;

// ── GUID / ABI 结构 ─────────────────────────────────────────────────────────

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

/// `{8C6F2E4B-1D9A-4E7C-B530-A47E91D0C2F8}`（与 protocol 层字符串常量一致）。
const CLSID_HANDOFF: Guid = Guid {
    data1: 0x8C6F2E4B,
    data2: 0x1D9A,
    data3: 0x4E7C,
    data4: [0xB5, 0x30, 0xA4, 0x7E, 0x91, 0xD0, 0xC2, 0xF8],
};
const IID_IUNKNOWN: Guid = Guid {
    data1: 0,
    data2: 0,
    data3: 0,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};
const IID_ICLASSFACTORY: Guid = Guid {
    data1: 1,
    data2: 0,
    data3: 0,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};
/// `ITerminalHandoff3` `{6F23DA90-15C5-4203-9DB0-64E73F1B1B00}`。
const IID_TERMINALHANDOFF3: Guid = Guid {
    data1: 0x6F23DA90,
    data2: 0x15C5,
    data3: 0x4203,
    data4: [0x9D, 0xB0, 0x64, 0xE7, 0x3F, 0x1B, 0x1B, 0x00],
};
/// `IDefaultTerminalMarker` `{746E6BC0-AB05-4E38-AB14-71E86763141F}`（空 marker）。
const IID_DEFAULTTERMINALMARKER: Guid = Guid {
    data1: 0x746E6BC0,
    data2: 0xAB05,
    data3: 0x4E38,
    data4: [0xAB, 0x14, 0x71, 0xE8, 0x67, 0x63, 0x14, 0x1F],
};

/// `TERMINAL_STARTUP_INFO`（IDL 布局：BSTR 头指针字段在前，WORD 尾部带对齐填充）。
#[repr(C)]
struct TerminalStartupInfoRaw {
    psz_title: *mut u16,
    psz_icon_path: *mut u16,
    icon_index: i32,
    dw_x: u32,
    dw_y: u32,
    dw_x_size: u32,
    dw_y_size: u32,
    dw_x_count_chars: u32,
    dw_y_count_chars: u32,
    dw_fill_attribute: u32,
    dw_flags: u32,
    w_show_window: u16,
}

#[repr(C)]
struct IUnknownVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
}

type EstablishPtyHandoffFn = unsafe extern "system" fn(
    *mut c_void,
    *mut RawHandle,
    *mut RawHandle,
    RawHandle,
    RawHandle,
    RawHandle,
    RawHandle,
    *const TerminalStartupInfoRaw,
) -> i32;

#[repr(C)]
struct HandoffVtbl {
    unknown: IUnknownVtbl,
    establish_pty_handoff: EstablishPtyHandoffFn,
}

#[repr(C)]
struct ClassFactoryVtbl {
    unknown: IUnknownVtbl,
    create_instance: unsafe extern "system" fn(
        *mut c_void,
        *mut c_void,
        *const Guid,
        *mut *mut c_void,
    ) -> i32,
    lock_server: unsafe extern "system" fn(*mut c_void, i32) -> i32,
}

/// 两种 COM 对象共用的引用计数前缀（{ vtbl, refcount } 布局一致）。
#[repr(C)]
struct ComObject {
    vtbl: *const c_void,
    refcount: AtomicU32,
}

// ── 全局状态 ────────────────────────────────────────────────────────────────

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static COM_REGISTERED: AtomicBool = AtomicBool::new(false);

/// setup 时注入 AppHandle（`EstablishPtyHandoff` 建会话要用）。
pub fn set_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

/// 本进程 COM 类对象是否已注册成功（供设置页状态展示）。
pub fn is_com_registered() -> bool {
    COM_REGISTERED.load(Ordering::SeqCst)
}

/// COM 激活冷启动的标志参数（LocalServer32 约定）。
pub fn is_embedding_launch() -> bool {
    std::env::args().any(|arg| arg.eq_ignore_ascii_case("-Embedding"))
}

/// 启动 COM 类注册线程（幂等）。独立 MTA 线程注册后挂起：入站 COM 调用由
/// COM RPC 线程池派发，无需消息泵。注册 ≠ 生效——是否被委派由注册表值决定。
pub fn bootstrap_com_server() -> Result<(), String> {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    thread::Builder::new()
        .name("com-handoff-server".to_string())
        .spawn(move || unsafe {
            let hr = CoInitializeEx(std::ptr::null_mut(), COINIT_MULTITHREADED);
            if hr < 0 {
                let _ = tx.send(Err(format!("CoInitializeEx 失败: {:#010X}", hr as u32)));
                return;
            }
            let factory = Box::into_raw(Box::new(ComObject {
                vtbl: &CLASS_FACTORY_VTBL as *const ClassFactoryVtbl as *const c_void,
                refcount: AtomicU32::new(1),
            }));
            let mut cookie = 0u32;
            let hr = CoRegisterClassObject(
                &CLSID_HANDOFF,
                factory as *mut c_void,
                CLSCTX_LOCAL_SERVER,
                REGCLS_MULTIPLEUSE,
                &mut cookie,
            );
            if hr < 0 {
                let _ = tx.send(Err(format!(
                    "CoRegisterClassObject 失败: {:#010X}",
                    hr as u32
                )));
                return;
            }
            COM_REGISTERED.store(true, Ordering::SeqCst);
            crate::commands::terminal::log_debug(&format!(
                "[handoff] COM 类对象已注册, cookie={}",
                cookie
            ));
            let _ = tx.send(Ok(()));
            // 挂起直到进程退出；Revoke 交给进程清理，省掉退出钩子。
            loop {
                thread::park();
            }
        })
        .map_err(|e| format!("启动 COM 线程失败: {}", e))?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "COM 注册超时".to_string())?
}

// ── COM 方法实现 ────────────────────────────────────────────────────────────

unsafe extern "system" fn object_add_ref(this: *mut c_void) -> u32 {
    let object = &*(this as *const ComObject);
    object.refcount.fetch_add(1, Ordering::SeqCst) + 1
}

unsafe extern "system" fn object_release(this: *mut c_void) -> u32 {
    let object = &*(this as *const ComObject);
    let remaining = object.refcount.fetch_sub(1, Ordering::SeqCst) - 1;
    if remaining == 0 {
        drop(Box::from_raw(this as *mut ComObject));
    }
    remaining
}

unsafe extern "system" fn handoff_query_interface(
    this: *mut c_void,
    riid: *const Guid,
    ppv: *mut *mut c_void,
) -> i32 {
    if ppv.is_null() || riid.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();
    let iid = &*riid;
    // 同一对象同时暴露 v3 handoff 与空 marker（marker 无额外方法，vtable 前缀兼容）。
    if *iid == IID_IUNKNOWN || *iid == IID_TERMINALHANDOFF3 || *iid == IID_DEFAULTTERMINALMARKER {
        *ppv = this;
        object_add_ref(this);
        return S_OK;
    }
    E_NOINTERFACE
}

unsafe extern "system" fn class_factory_query_interface(
    this: *mut c_void,
    riid: *const Guid,
    ppv: *mut *mut c_void,
) -> i32 {
    if ppv.is_null() || riid.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();
    let iid = &*riid;
    if *iid == IID_IUNKNOWN || *iid == IID_ICLASSFACTORY {
        *ppv = this;
        object_add_ref(this);
        return S_OK;
    }
    E_NOINTERFACE
}

unsafe extern "system" fn class_factory_create_instance(
    _this: *mut c_void,
    punk_outer: *mut c_void,
    riid: *const Guid,
    ppv: *mut *mut c_void,
) -> i32 {
    if ppv.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();
    if !punk_outer.is_null() {
        return CLASS_E_NOAGGREGATION;
    }
    let object = Box::into_raw(Box::new(ComObject {
        vtbl: &HANDOFF_VTBL as *const HandoffVtbl as *const c_void,
        refcount: AtomicU32::new(1),
    }));
    let hr = handoff_query_interface(object as *mut c_void, riid, ppv);
    if hr != S_OK {
        drop(Box::from_raw(object as *mut ComObject));
    }
    hr
}

unsafe extern "system" fn class_factory_lock_server(_this: *mut c_void, _lock: i32) -> i32 {
    S_OK
}

static CLASS_FACTORY_VTBL: ClassFactoryVtbl = ClassFactoryVtbl {
    unknown: IUnknownVtbl {
        query_interface: class_factory_query_interface,
        add_ref: object_add_ref,
        release: object_release,
    },
    create_instance: class_factory_create_instance,
    lock_server: class_factory_lock_server,
};

static HANDOFF_VTBL: HandoffVtbl = HandoffVtbl {
    unknown: IUnknownVtbl {
        query_interface: handoff_query_interface,
        add_ref: object_add_ref,
        release: object_release,
    },
    establish_pty_handoff,
};

/// 未指定所有权的原始句柄收集器：Drop 时统一 CloseHandle，成功移交后 `into_inner` 摘走。
struct RawGuard(Option<RawHandle>);

impl RawGuard {
    fn new(handle: RawHandle) -> Self {
        Self(Some(handle))
    }

    fn into_inner(mut self) -> RawHandle {
        self.0.take().unwrap_or(std::ptr::null_mut())
    }
}

impl Drop for RawGuard {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            if !handle.is_null() {
                unsafe {
                    CloseHandle(handle);
                }
            }
        }
    }
}

unsafe fn create_pipe_pair() -> Result<(RawHandle, RawHandle), String> {
    let mut read: RawHandle = std::ptr::null_mut();
    let mut write: RawHandle = std::ptr::null_mut();
    if CreatePipe(&mut read, &mut write, std::ptr::null_mut(), 0) == 0 {
        return Err(format!(
            "CreatePipe 失败: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok((read, write))
}

/// 会话长期持有的句柄副本（COM 会在调用返回后释放传入的原句柄）。
unsafe fn duplicate_handle(source: RawHandle) -> Result<RawHandle, String> {
    let mut target: RawHandle = std::ptr::null_mut();
    if DuplicateHandle(
        GetCurrentProcess(),
        source,
        GetCurrentProcess(),
        &mut target,
        0,
        0,
        DUPLICATE_SAME_ACCESS,
    ) == 0
    {
        return Err(format!(
            "DuplicateHandle 失败: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(target)
}

fn query_image_name(handle: RawHandle) -> Option<String> {
    let mut buf = [0u16; 32768];
    let mut size = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size) };
    if ok == 0 || size == 0 {
        return None;
    }
    Some(proto::decode_utf16_lossy(&buf[..size as usize]))
}

/// `PROCESS_BASIC_INFORMATION`（x64）：`ExitStatus` 后补 4 字节对齐，共 48 字节。
#[repr(C)]
struct ProcessBasicInformation {
    exit_status: i32,
    _padding: u32,
    peb_base_address: *mut c_void,
    affinity_mask: usize,
    base_priority: usize,
    unique_process_id: usize,
    parent_process_id: usize,
}

unsafe fn read_process_bytes(handle: RawHandle, address: usize, len: usize) -> Option<Vec<u8>> {
    let mut buffer = vec![0u8; len];
    let mut read = 0usize;
    let ok = ReadProcessMemory(
        handle,
        address as *const c_void,
        buffer.as_mut_ptr() as *mut c_void,
        len,
        &mut read,
    );
    (ok != 0 && read == len).then_some(buffer)
}

unsafe fn read_process_usize(handle: RawHandle, address: usize) -> Option<usize> {
    let bytes = read_process_bytes(handle, address, std::mem::size_of::<usize>())?;
    Some(bytes.iter().enumerate().fold(0usize, |acc, (index, byte)| {
        acc | (*byte as usize) << (index * 8)
    }))
}

/// 取客户端进程的命令行，只为给页签换一个有意义的名字。
///
/// 双击 .bat 时 handoff 的客户端进程是 cmd.exe，只报映像名会得到「cmd.exe」这种
/// 无信息量标题，而命令行里带着脚本路径。任何一步失败都当作读不到，回落原有命名。
fn query_command_line(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let command_line = unsafe { command_line_from_handle(handle) };
    unsafe { CloseHandle(handle) };
    command_line
}

unsafe fn command_line_from_handle(handle: RawHandle) -> Option<String> {
    let mut info = ProcessBasicInformation {
        exit_status: 0,
        _padding: 0,
        peb_base_address: std::ptr::null_mut(),
        affinity_mask: 0,
        base_priority: 0,
        unique_process_id: 0,
        parent_process_id: 0,
    };
    let mut returned = 0u32;
    let status = NtQueryInformationProcess(
        handle,
        PROCESS_BASIC_INFORMATION_CLASS,
        &mut info as *mut _ as *mut c_void,
        std::mem::size_of::<ProcessBasicInformation>() as u32,
        &mut returned,
    );
    if status != 0 || info.peb_base_address.is_null() {
        return None;
    }
    let parameters = read_process_usize(
        handle,
        info.peb_base_address as usize + PEB_PROCESS_PARAMETERS_OFFSET,
    )?;
    // UNICODE_STRING：Length(u16) @0、MaximumLength(u16) @2、Buffer(指针) @8
    let mut header = [0u8; 8];
    let raw = read_process_bytes(handle, parameters + PROCESS_PARAMETERS_COMMAND_LINE_OFFSET, 8)?;
    header[..8].copy_from_slice(&raw);
    let length = u16::from_le_bytes([header[0], header[1]]) as usize;
    let max_length = u16::from_le_bytes([header[2], header[3]]) as usize;
    if length == 0 || length > max_length || length > MAX_COMMAND_LINE_BYTES {
        return None;
    }
    let buffer = read_process_usize(
        handle,
        parameters + PROCESS_PARAMETERS_COMMAND_LINE_OFFSET + 8,
    )?;
    if buffer == 0 {
        return None;
    }
    let units = read_process_bytes(handle, buffer, length)?
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<u16>>();
    Some(proto::decode_utf16_lossy(&units))
}

unsafe extern "system" fn establish_pty_handoff(
    _this: *mut c_void,
    pin: *mut RawHandle,
    pout: *mut RawHandle,
    signal: RawHandle,
    reference: RawHandle,
    server: RawHandle,
    client: RawHandle,
    startup_info: *const TerminalStartupInfoRaw,
) -> i32 {
    if pin.is_null() || pout.is_null() || startup_info.is_null() {
        return E_POINTER;
    }
    *pin = std::ptr::null_mut();
    *pout = std::ptr::null_mut();
    match do_establish_pty_handoff(pin, pout, signal, reference, server, client, startup_info) {
        Ok(id) => {
            crate::commands::terminal::log_debug(&format!(
                "[handoff] EstablishPtyHandoff 成功, id={}",
                id
            ));
            S_OK
        }
        Err(error) => {
            crate::commands::terminal::log_debug(&format!(
                "[handoff] EstablishPtyHandoff 失败: {}",
                error
            ));
            E_FAIL
        }
    }
}

unsafe fn do_establish_pty_handoff(
    pin: *mut RawHandle,
    pout: *mut RawHandle,
    signal: RawHandle,
    reference: RawHandle,
    server: RawHandle,
    client: RawHandle,
    startup_info: *const TerminalStartupInfoRaw,
) -> Result<String, String> {
    // 1. 两条匿名管道（v3：终端自建，可自定 buffer/overlapped）。
    //    input：console 读端经 *in 交回，我方留写端（写用户输入）。
    //    output：console 写端经 *out 交回，我方留读端（读应用输出）。
    let (console_in, our_in) = create_pipe_pair()?;
    let our_in = RawGuard::new(our_in);
    let console_in = RawGuard::new(console_in);
    let (our_out, console_out) = create_pipe_pair()?;
    let our_out = RawGuard::new(our_out);
    let console_out = RawGuard::new(console_out);
    // console 端句柄先交出：COM 负责封送并在返回后释放本地副本；
    // 之后失败只需让 RawGuard 收我方端，OpenConsole 侧由 RETURN_IF_FAILED 清理。
    *pin = console_in.into_inner();
    *pout = console_out.into_inner();

    // 2. [in] 句柄各自 DuplicateHandle 一份供会话持有。
    let signal = duplicate_handle(signal)?;
    let signal = RawGuard::new(signal);
    let reference = duplicate_handle(reference)?;
    let reference = RawGuard::new(reference);
    let server = duplicate_handle(server)?;
    let server = RawGuard::new(server);
    let client = duplicate_handle(client)?;
    let client = RawGuard::new(client);

    // 3. 解析启动信息与显示名。
    let raw = &*startup_info;
    let title = proto::decode_bstr_lossy(raw.psz_title);
    let icon_path = proto::decode_bstr_lossy(raw.psz_icon_path);
    let startup = proto::TerminalStartupInfo {
        title: title.clone(),
        icon_path,
        icon_index: raw.icon_index,
        x_count_chars: raw.dw_x_count_chars,
        y_count_chars: raw.dw_y_count_chars,
    };
    let (rows, cols) = startup.resolve_size();
    let client_raw = client.0.ok_or_else(|| "client 句柄缺失".to_string())?;
    let client_pid = GetProcessId(client_raw);
    let script_name = query_command_line(client_pid)
        .as_deref()
        .and_then(proto::script_name_from_command_line);
    let image_name = query_image_name(client_raw)
        .map(|path| proto::display_name_from_image_path(&path))
        .filter(|name| !name.is_empty());
    let display_name = script_name
        .or(image_name)
        .or(title)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "命令提示符".to_string());

    // 4. 组装 handoff 后端并建会话（阻塞 OpenConsole 激活线程，保持轻量）。
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "AppHandle 未就绪".to_string())?
        .clone();
    let writer = File::from_raw_handle(our_in.into_inner());
    let reader = File::from_raw_handle(our_out.into_inner());
    let signal = File::from_raw_handle(signal.into_inner());
    let handoff = HandoffPty::new(
        writer,
        signal,
        OwnedHandle::from_raw_handle(reference.into_inner()),
        OwnedHandle::from_raw_handle(server.into_inner()),
        OwnedHandle::from_raw_handle(client.into_inner()),
        client_pid,
    );
    let service = app.state::<TerminalService>();
    service.create_handoff_terminal(handoff, Box::new(reader), &display_name, rows, cols, app.clone())
}

// ── HandoffPty：handoff 会话后端（供 TerminalBackend::Handoff 委托）──────────

/// handoff 会话的后端状态与生命周期。无自有 spawn 的 child：`client` 是客户端
/// 进程句柄（只观测 + 关闭会话时终止，对应 Default 的 `child.kill()`）。
pub struct HandoffPty {
    writer: Option<File>,
    signal: Option<File>,
    reference: Option<OwnedHandle>,
    server: Option<OwnedHandle>,
    client: Option<OwnedHandle>,
    client_pid: u32,
}

impl HandoffPty {
    pub fn new(
        writer: File,
        signal: File,
        reference: OwnedHandle,
        server: OwnedHandle,
        client: OwnedHandle,
        client_pid: u32,
    ) -> Self {
        Self {
            writer: Some(writer),
            signal: Some(signal),
            reference: Some(reference),
            server: Some(server),
            client: Some(client),
            client_pid,
        }
    }

    pub fn write_input(&mut self, data: &[u8]) -> Result<(), String> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| "Terminal writer not available".to_string())?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Write failed: {}", error))
    }

    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        // 注意 cols/rows 顺序：信号包内是 [id, X=cols, Y=rows]。
        let packet = proto::encode_resize_signal(cols, rows);
        let signal = self
            .signal
            .as_mut()
            .ok_or_else(|| "Resize failed: 信号管道已关闭".to_string())?;
        signal
            .write_all(&packet)
            .map_err(|error| format!("Resize failed: {}", error))?;
        signal.flush().ok();
        Ok(())
    }

    /// 关闭后端并返回观测到的退出码：先停输入/信号，终止仍在运行的客户端
    /// （对齐 Default 的 kill 语义，关 tab 即拆会话），再释放保活引用句柄。
    pub fn close(&mut self) -> Option<u32> {
        self.writer = None;
        self.signal = None;
        let exit_code = self.client.take().map(|client| {
            let raw = client.as_raw_handle() as RawHandle;
            unsafe {
                if WaitForSingleObject(raw, 0) == WAIT_TIMEOUT {
                    let _ = TerminateProcess(raw, 1);
                }
                WaitForSingleObject(raw, 500);
                let mut code = 0u32;
                if GetExitCodeProcess(raw, &mut code) != 0 {
                    Some(code)
                } else {
                    None
                }
            }
        });
        // 保活引用最后关：关掉即允许 conhost 退出。
        self.reference = None;
        self.server = None;
        exit_code.flatten()
    }

    /// 只发终止、不 wait。供应用退出等不能被阻塞的路径使用。
    pub fn kill_without_wait(&mut self) {
        self.writer = None;
        self.signal = None;
        if let Some(client) = self.client.take() {
            unsafe {
                let _ = TerminateProcess(client.as_raw_handle() as RawHandle, 1);
            }
        }
        self.reference = None;
        self.server = None;
    }

    pub fn process_id(&self) -> Option<u32> {
        Some(self.client_pid)
    }

    pub fn acknowledge_output(&self) -> Result<(), String> {
        Ok(())
    }
}
