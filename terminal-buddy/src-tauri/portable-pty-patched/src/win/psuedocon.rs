use super::WinChild;
use crate::cmdbuilder::CommandBuilder;
use crate::win::procthreadattr::ProcThreadAttributeList;
use anyhow::{bail, ensure, Error};
use filedescriptor::{FileDescriptor, OwnedHandle};
use lazy_static::lazy_static;
use shared_library::shared_library;
use std::ffi::OsString;
use std::io::Error as IoError;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::sync::Mutex;
use std::{mem, ptr};
use winapi::shared::minwindef::DWORD;
use winapi::shared::winerror::{HRESULT, S_OK};
use winapi::um::handleapi::*;
use winapi::um::processthreadsapi::*;
use winapi::um::winbase::{
    CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};
use winapi::um::wincon::COORD;
use winapi::um::winnt::HANDLE;

pub type HPCON = HANDLE;

#[allow(dead_code)]
pub const PSUEDOCONSOLE_INHERIT_CURSOR: DWORD = 0x1;
#[allow(dead_code)]
pub const PSEUDOCONSOLE_RESIZE_QUIRK: DWORD = 0x2;
#[allow(dead_code)]
pub const PSEUDOCONSOLE_WIN32_INPUT_MODE: DWORD = 0x4;
/// 透传模式：conhost 不再自己应答终端查询（DA1 等），而是把查询原样转给终端。
/// 新版 Windows 11 才支持，创建失败时必须回退到 0。
#[allow(dead_code)]
pub const PSEUDOCONSOLE_PASSTHROUGH_MODE: DWORD = 0x8;

shared_library!(ConPtyFuncs,
    pub fn CreatePseudoConsole(
        size: COORD,
        hInput: HANDLE,
        hOutput: HANDLE,
        flags: DWORD,
        hpc: *mut HPCON
    ) -> HRESULT,
    pub fn ResizePseudoConsole(hpc: HPCON, size: COORD) -> HRESULT,
    pub fn ClosePseudoConsole(hpc: HPCON),
);

fn load_conpty() -> ConPtyFuncs {
    // If the kernel doesn't export these functions then their system is
    // too old and we cannot run.
    let kernel = ConPtyFuncs::open(Path::new("kernel32.dll")).expect(
        "this system does not support conpty.  Windows 10 October 2018 or newer is required",
    );

    // We prefer to use a sideloaded conpty.dll and openconsole.exe host deployed
    // alongside the application.  We check for this after checking for kernel
    // support so that we don't try to proceed and do something crazy.
    if let Ok(sideloaded) = ConPtyFuncs::open(Path::new("conpty.dll")) {
        sideloaded
    } else {
        kernel
    }
}

lazy_static! {
    static ref CONPTY: ConPtyFuncs = load_conpty();
}

pub struct PsuedoCon {
    con: HPCON,
}

unsafe impl Send for PsuedoCon {}
unsafe impl Sync for PsuedoCon {}

impl Drop for PsuedoCon {
    fn drop(&mut self) {
        unsafe { (CONPTY.ClosePseudoConsole)(self.con) };
    }
}

impl PsuedoCon {
    /// 把 ConPTY 的实际工作模式追加写入 %TEMP%/terminal-buddy-conpty-mode.log。
    /// 应用侧没有安装 log 日志器，`log::info!`/`log::warn!` 不会被任何 sink 收走，
    /// 排查透传是否生效只能靠这个文件。
    fn report_mode(line: &str) {
        use std::io::Write;
        let path = std::env::temp_dir().join("terminal-buddy-conpty-mode.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(file, "{}", line);
        }
    }

    pub fn new(size: COORD, input: FileDescriptor, output: FileDescriptor) -> Result<Self, Error> {
        // 优先使用 ConPTY 透传模式（dwFlags=0x8）：
        // 默认模式下 conhost 会自己截答 DA1（`ESC[c`）并不把查询转给终端，而终端侧的
        // OSC 4/10/11 颜色应答要走「前端 → IPC → PTY」回程（约 20ms）。结果 TUI（如 pi）
        // 先收到 DA1 就判定"终端不报颜色"，颜色应答晚到后已被丢弃——表现为 pi 的用户消息
        // 面板丢失背景色。透传模式下 DA1 交回终端，应答顺序变成「颜色 → DA1」，与
        // Windows Terminal 一致。
        //
        // 透传模式只有新版 conhost 支持（旧版直接返回失败），因此失败时回退到 0
        // （VS Code / node-pty 同款默认行为）。设置 TERMINAL_BUDDY_CONPTY_PASSTHROUGH=0
        // 可强制关闭，便于对照排查。
        let passthrough = std::env::var("TERMINAL_BUDDY_CONPTY_PASSTHROUGH")
            .map(|value| value.trim() != "0")
            .unwrap_or(true);

        let mut con: HPCON = INVALID_HANDLE_VALUE;
        // 透传模式不再依赖 inherit-cursor；默认模式同样保持不注入光标位置查询。
        let mut flags: DWORD = if passthrough {
            PSEUDOCONSOLE_PASSTHROUGH_MODE
        } else {
            0
        };
        let mut result = unsafe {
            (CONPTY.CreatePseudoConsole)(
                size,
                input.as_raw_handle() as _,
                output.as_raw_handle() as _,
                flags,
                &mut con,
            )
        };
        if passthrough && result != S_OK {
            log::warn!(
                "ConPTY passthrough mode rejected (HRESULT {}), falling back to dwFlags=0",
                result
            );
            Self::report_mode(&format!(
                "passthrough(dwFlags=0x{:X}) rejected, HRESULT=0x{:08X}, falling back",
                PSEUDOCONSOLE_PASSTHROUGH_MODE, result as u32
            ));
            con = INVALID_HANDLE_VALUE;
            flags = 0;
            result = unsafe {
                (CONPTY.CreatePseudoConsole)(
                    size,
                    input.as_raw_handle() as _,
                    output.as_raw_handle() as _,
                    flags,
                    &mut con,
                )
            };
        }
        ensure!(
            result == S_OK,
            "failed to create psuedo console: HRESULT {}",
            result
        );
        log::info!("ConPTY created with dwFlags={} (passthrough={})", flags, flags != 0);
        Self::report_mode(&format!(
            "created dwFlags=0x{:X} passthrough={}",
            flags,
            flags != 0
        ));
        Ok(Self { con })
    }

    pub fn resize(&self, size: COORD) -> Result<(), Error> {
        let result = unsafe { (CONPTY.ResizePseudoConsole)(self.con, size) };
        ensure!(
            result == S_OK,
            "failed to resize console to {}x{}: HRESULT: {}",
            size.X,
            size.Y,
            result
        );
        Ok(())
    }

    pub fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<WinChild> {
        let mut si: STARTUPINFOEXW = unsafe { mem::zeroed() };
        si.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
        // Explicitly set the stdio handles as invalid handles otherwise
        // we can end up with a weird state where the spawned process can
        // inherit the explicitly redirected output handles from its parent.
        // For example, when daemonizing wezterm-mux-server, the stdio handles
        // are redirected to a log file and the spawned process would end up
        // writing its output there instead of to the pty we just created.
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;

        let mut attrs = ProcThreadAttributeList::with_capacity(1)?;
        attrs.set_pty(self.con)?;
        si.lpAttributeList = attrs.as_mut_ptr();

        let mut pi: PROCESS_INFORMATION = unsafe { mem::zeroed() };

        let (mut exe, mut cmdline) = cmd.cmdline()?;
        let cmd_os = OsString::from_wide(&cmdline);

        let cwd = cmd.current_directory();

        let res = unsafe {
            CreateProcessW(
                exe.as_mut_slice().as_mut_ptr(),
                cmdline.as_mut_slice().as_mut_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                cmd.environment_block().as_mut_slice().as_mut_ptr() as *mut _,
                cwd.as_ref()
                    .map(|c| c.as_slice().as_ptr())
                    .unwrap_or(ptr::null()),
                &mut si.StartupInfo,
                &mut pi,
            )
        };
        if res == 0 {
            let err = IoError::last_os_error();
            let msg = format!(
                "CreateProcessW `{:?}` in cwd `{:?}` failed: {}",
                cmd_os,
                cwd.as_ref().map(|c| OsString::from_wide(c)),
                err
            );
            log::error!("{}", msg);
            bail!("{}", msg);
        }

        // Make sure we close out the thread handle so we don't leak it;
        // we do this simply by making it owned
        let _main_thread = unsafe { OwnedHandle::from_raw_handle(pi.hThread as _) };
        let proc = unsafe { OwnedHandle::from_raw_handle(pi.hProcess as _) };

        Ok(WinChild {
            proc: Mutex::new(proc),
        })
    }
}
