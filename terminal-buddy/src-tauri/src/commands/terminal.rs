use tauri::{command, AppHandle, State, Emitter, Manager};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::{Read, Write};
use uuid::Uuid;
use portable_pty::{native_pty_system, CommandBuilder, PtySize, Child, MasterPty};
use std::thread;
use std::fs;
use std::path::PathBuf;
use crate::models::TerminalOwner;
use crate::services::ProfileService;
use crate::services::PathService;
use crate::services::SettingsService;
use crate::services::ssh_session_service::SshSessionService;

/// 转义 shell 特殊字符，防止命令注入
fn shell_escape(s: &str) -> String {
    if s.contains(|c: char| c == ' ' || c == '"' || c == '\'' || c == '&' || c == '|' || c == '>' || c == '<' || c == '^') {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

pub struct TerminalInstance {
    pub id: String,
    pub profile_id: String,
    pub owner: TerminalOwner,
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    pub writer: Option<Box<dyn Write + Send>>,
    pub output_buffer: Arc<Mutex<VecDeque<Arc<str>>>>,
    current_rows: u16,
    current_cols: u16,
}

pub struct TerminalService {
    pub instances: Arc<Mutex<HashMap<String, TerminalInstance>>>,
}

use std::sync::OnceLock;
static DEBUG_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

fn log_debug(msg: &str) {
    let log_path = DEBUG_LOG_PATH.get_or_init(|| PathService::get_debug_log_path());
    let ts = chrono::Utc::now().format("%H:%M:%S%.3f");
    let line = format!("[{}] {}\n", ts, msg);
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .and_then(|mut f| f.write_all(line.as_bytes()));
}

/// Shared output forwarding logic for both create_terminal and create_blank_terminal
fn spawn_output_forwarder(
    reader: Box<dyn Read + Send>,
    terminal_id: String,
    app: AppHandle,
    output_buffer: Arc<Mutex<VecDeque<Arc<str>>>>,
) {
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Try fast path: valid UTF-8, avoid Cow allocation
                    let output: Arc<str> = match std::str::from_utf8(&buf[..n]) {
                        Ok(s) => Arc::from(s),
                        Err(_) => Arc::from(String::from_utf8_lossy(&buf[..n]).to_string()),
                    };
                    if !output.is_empty() {
                        {
                            let mut buffer = output_buffer.lock().unwrap_or_else(|e| e.into_inner());
                            buffer.push_back(output.clone());
                            if buffer.len() > 1000 {
                                buffer.drain(0..500);
                            }
                        }
                        let _ = app.emit(&format!("terminal_output_{}", terminal_id), output.clone());
                        let web_state = app.state::<crate::services::WebServiceState>();
                        web_state.broadcast(&terminal_id, &output);
                    }
                }
                Err(_) => break,
            }
        }
    });
}

impl Default for TerminalService {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalService {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_terminal(&self, profile_id: &str, extra_startup_params: Option<&str>, initial_rows: u16, initial_cols: u16, app: AppHandle, owner: TerminalOwner) -> Result<String, String> {
        let terminal_id = Uuid::new_v4().to_string();
        log_debug(&format!("[create] start, id={}, profile_id={}", terminal_id, profile_id));

        // Load profile settings
        let profile = ProfileService::get_profile(profile_id).ok();
        let terminal_type = profile.as_ref().map_or("powershell", |p| p.terminal_type.as_str());
        let startup_path = profile.as_ref().and_then(|p| {
            if p.startup_path.is_empty() { None } else { Some(p.startup_path.clone()) }
        });
        let startup_commands: Vec<String> = profile.as_ref()
            .map(|p| p.startup_commands.clone())
            .unwrap_or_default();
        let startup_commands: Vec<String> = if let Some(extra) = extra_startup_params {
            if !extra.is_empty() {
                startup_commands.into_iter()
                    .map(|cmd| format!("{} {}", cmd, extra))
                    .collect()
            } else {
                startup_commands
            }
        } else {
            startup_commands
        };
        let env_vars: Vec<(String, String)> = profile.as_ref()
            .map(|p| p.environment_variables.iter().map(|(k,v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();

        log_debug(&format!("[create] type={}, path={:?}, commands={}, envs={}",
            terminal_type, startup_path, startup_commands.len(), env_vars.len()));

        let pty_system = native_pty_system();

        let init_rows = if initial_rows > 0 { initial_rows } else { 24 };
        let init_cols = if initial_cols > 0 { initial_cols } else { 80 };

        let pty_pair = pty_system.openpty(PtySize {
            rows: init_rows,
            cols: init_cols,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| {
            let msg = format!("openpty FAILED: {}", e);
            log_debug(&msg);
            msg
        })?;

        // Use cmd.exe to avoid 0xc0000142 with direct powershell.exe in ConPTY
        let mut cmd = CommandBuilder::new("cmd.exe");

        // TERM tells child processes they're connected to a real terminal emulator
        // (xterm.js). Without this, ConPTY cursor tracking and the frontend can get
        // out of sync, causing the visual cursor to appear in the wrong position.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        if let Some(ref path) = startup_path {
            cmd.cwd(path);
        }
        for (k, v) in &env_vars {
            cmd.env(k, v);
        }

        let child = pty_pair.slave.spawn_command(cmd).map_err(|e| {
            let msg = format!("spawn_command FAILED: {}", e);
            log_debug(&msg);
            msg
        })?;

        let writer = pty_pair.master.take_writer().map_err(|e| {
            let msg = format!("take_writer FAILED: {}", e);
            log_debug(&msg);
            msg
        })?;

        let master_reader = pty_pair.master.try_clone_reader().map_err(|e| {
            let msg = format!("try_clone_reader FAILED: {}", e);
            log_debug(&msg);
            msg
        })?;

        let output_buffer: Arc<Mutex<VecDeque<Arc<str>>>> = Arc::new(Mutex::new(VecDeque::new()));

        let instance = TerminalInstance {
            id: terminal_id.clone(),
            profile_id: profile_id.to_string(),
            owner,
            child,
            master: pty_pair.master,
            writer: Some(writer),
            output_buffer: output_buffer.clone(),
            current_rows: init_rows,
            current_cols: init_cols,
        };

        {
            let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances.insert(terminal_id.clone(), instance);
        }

        // Build init commands based on terminal type
        let init_commands = match terminal_type {
            "cmd" => startup_commands,
            "powershell" => {
                let mut cmds = vec!["powershell.exe".to_string()];
                cmds.extend(startup_commands);
                cmds
            }
            "ssh" => {
                let p = profile.as_ref();
                let host = p.and_then(|p| p.ssh_host.clone()).unwrap_or_default();
                let port = p.and_then(|p| p.ssh_port).unwrap_or(22);
                let user = p.and_then(|p| p.ssh_user.clone()).unwrap_or_default();
                let auth_type = p.and_then(|p| p.ssh_auth_type.clone()).unwrap_or_else(|| "key".to_string());
                let key_path = p.and_then(|p| p.ssh_key_path.clone()).unwrap_or_default();
                let ssh_cmd = if auth_type == "key" && !key_path.is_empty() {
                    format!("ssh -i {} -p {} {}@{}",
                        shell_escape(&key_path), port,
                        shell_escape(&user), shell_escape(&host))
                } else {
                    format!("ssh -p {} {}@{}",
                        port, shell_escape(&user), shell_escape(&host))
                };
                vec![ssh_cmd]
            }
            "docker" => {
                let container = profile.as_ref()
                    .and_then(|p| p.docker_container_name.clone())
                    .or_else(|| profile.as_ref().and_then(|p| p.docker_container_id.clone()))
                    .unwrap_or_default();
                vec![format!("docker exec -it {} cmd.exe", shell_escape(&container))]
            }
            "k8s" => {
                let ns = profile.as_ref().and_then(|p| p.k8s_namespace.clone()).unwrap_or_default();
                let pod = profile.as_ref().and_then(|p| p.k8s_pod_name.clone()).unwrap_or_default();
                let container = profile.as_ref().and_then(|p| p.k8s_container_name.clone()).unwrap_or_default();
                let mut cmd = format!("kubectl exec -it -n {} {}", shell_escape(&ns), shell_escape(&pod));
                if !container.is_empty() {
                    cmd = format!("{} -c {} -- cmd.exe", cmd, shell_escape(&container));
                } else {
                    cmd = format!("{} -- cmd.exe", cmd);
                }
                vec![cmd]
            }
            _ => {
                let mut cmds = vec!["powershell.exe".to_string()];
                cmds.extend(startup_commands);
                cmds
            }
        };

        if !init_commands.is_empty() {
            let tid = terminal_id.clone();
            let commands = init_commands;
            let instances = self.instances.clone();

            thread::spawn(move || {
                // Wait for cmd.exe to initialize
                thread::sleep(std::time::Duration::from_millis(300));
                log_debug(&format!("[init-cmds] sending {} commands for {}", commands.len(), tid));

                let mut instances_lock = instances.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(instance) = instances_lock.get_mut(&tid) {
                    if let Some(ref mut writer) = instance.writer {
                        for cmd_str in &commands {
                            let _ = writer.write_all(cmd_str.as_bytes());
                            let _ = writer.write_all(b"\r");
                            let _ = writer.flush();
                            log_debug(&format!("[init-cmds] sent: {}", cmd_str));
                        }
                    }
                }
            });
        }

        // Output forwarding thread
        spawn_output_forwarder(master_reader, terminal_id.clone(), app, output_buffer);

        log_debug(&format!("[create] DONE, id={}", terminal_id));
        Ok(terminal_id)
    }

    pub fn write_to_terminal(&self, id: &str, data: &str) -> Result<(), String> {
        let bytes = data.as_bytes();
        let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(instance) = instances.get_mut(id) {
            if let Some(ref mut writer) = instance.writer {
                if bytes.len() <= 256 {
                    writer.write_all(bytes)
                        .map_err(|e| format!("Write failed: {}", e))?;
                    writer.flush()
                        .map_err(|e| format!("Flush failed: {}", e))?;
                } else {
                    for (i, chunk) in bytes.chunks(256).enumerate() {
                        if i > 0 {
                            std::thread::sleep(std::time::Duration::from_millis(2));
                        }
                        writer.write_all(chunk)
                            .map_err(|e| format!("Write failed: {}", e))?;
                        writer.flush()
                            .map_err(|e| format!("Flush failed: {}", e))?;
                    }
                }
                Ok(())
            } else {
                Err("Terminal writer not available".to_string())
            }
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn resize_terminal(&self, id: &str, rows: u16, cols: u16, allow_shrink: bool) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(instance) = instances.get_mut(id) {
            let (new_rows, new_cols) = if allow_shrink {
                (rows, cols)
            } else {
                // Only grow — prevents a small web/mobile client from shrinking
                // the PTY and affecting the desktop viewer.
                (
                    std::cmp::max(instance.current_rows, rows),
                    std::cmp::max(instance.current_cols, cols),
                )
            };
            if new_rows != instance.current_rows || new_cols != instance.current_cols {
                instance.master.resize(PtySize {
                    rows: new_rows,
                    cols: new_cols,
                    pixel_width: 0,
                    pixel_height: 0,
                }).map_err(|e| format!("Resize failed: {}", e))?;
                instance.current_rows = new_rows;
                instance.current_cols = new_cols;
                log_debug(&format!("[resize] id={} rows={} cols={} allow_shrink={}", id, new_rows, new_cols, allow_shrink));
            }
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn drain_terminal_output(&self, id: &str) -> Result<String, String> {
        // Get buffer reference while holding instances lock briefly
        let buf_arc = {
            let instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances.get(id)
                .map(|inst| inst.output_buffer.clone())
                .ok_or("Terminal not found".to_string())?
        };
        let mut buffer = buf_arc.lock().unwrap_or_else(|e| e.into_inner());
        let result: String = buffer.iter().map(|s| s.as_ref()).collect();
        buffer.clear();
        Ok(result)
    }

    pub fn peek_terminal_output(&self, id: &str) -> Result<String, String> {
        let buf_arc = {
            let instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances.get(id)
                .map(|inst| inst.output_buffer.clone())
                .ok_or("Terminal not found".to_string())?
        };
        let buffer = buf_arc.lock().unwrap_or_else(|e| e.into_inner());
        Ok(buffer.iter().map(|s| s.as_ref()).collect())
    }

    /// 检查 PC 端是否有权限操作指定终端
    /// 在不共享模式下，PC 端不能操作 Web 端创建的终端
    pub fn check_pc_permission(&self, id: &str) -> Result<(), String> {
        let settings = SettingsService::get_settings();
        if !settings.web_api_share_sessions {
            let instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(terminal) = instances.get(id) {
                if terminal.owner == TerminalOwner::Web {
                    return Err("终端由 Web 端管理，PC 端只读".to_string());
                }
            }
        }
        Ok(())
    }

    pub fn close_terminal(&self, id: &str) -> Result<(), String> {
        let mut instance = {
            let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances.remove(id).ok_or("Terminal not found".to_string())?
        };
        instance.writer = None;
        instance.child.kill().ok();
        let _ = instance.child.wait();
        Ok(())
    }

    pub fn close_terminal_with_check(&self, id: &str, required_owner: Option<TerminalOwner>) -> Result<(), String> {
        {
            let instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(instance) = instances.get(id) {
                if let Some(expected) = required_owner {
                    if instance.owner != expected {
                        return Err("无权限关闭此终端".to_string());
                    }
                }
            } else {
                return Err("Terminal not found".to_string());
            }
        }
        let mut instance = {
            let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances.remove(id).ok_or("Terminal not found".to_string())?
        };
        instance.writer = None;
        instance.child.kill().ok();
        let _ = instance.child.wait();
        Ok(())
    }

    pub fn create_blank_terminal(&self, terminal_type: &str, initial_rows: u16, initial_cols: u16, app: AppHandle, owner: TerminalOwner) -> Result<String, String> {
        let terminal_id = Uuid::new_v4().to_string();
        log_debug(&format!("[create-blank] start, id={}, type={}", terminal_id, terminal_type));

        // Blank terminals only support cmd and powershell;
        // ssh/docker/k8s require connection parameters from a profile
        let effective_type = match terminal_type {
            "cmd" => "cmd",
            "powershell" => "powershell",
            _ => "powershell", // fallback for ssh/docker/k8s without profile
        };
        let pty_system = native_pty_system();

        let init_rows = if initial_rows > 0 { initial_rows } else { 24 };
        let init_cols = if initial_cols > 0 { initial_cols } else { 80 };

        let pty_pair = pty_system.openpty(PtySize {
            rows: init_rows,
            cols: init_cols,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| {
            let msg = format!("openpty FAILED: {}", e);
            log_debug(&msg);
            msg
        })?;

        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pty_pair.slave.spawn_command(cmd).map_err(|e| {
            let msg = format!("spawn_command FAILED: {}", e);
            log_debug(&msg);
            msg
        })?;

        let writer = pty_pair.master.take_writer().map_err(|e| {
            let msg = format!("take_writer FAILED: {}", e);
            log_debug(&msg);
            msg
        })?;

        let master_reader = pty_pair.master.try_clone_reader().map_err(|e| {
            let msg = format!("try_clone_reader FAILED: {}", e);
            log_debug(&msg);
            msg
        })?;

        let output_buffer: Arc<Mutex<VecDeque<Arc<str>>>> = Arc::new(Mutex::new(VecDeque::new()));

        let instance = TerminalInstance {
            id: terminal_id.clone(),
            profile_id: String::new(),
            owner,
            child,
            master: pty_pair.master,
            writer: Some(writer),
            output_buffer: output_buffer.clone(),
            current_rows: init_rows,
            current_cols: init_cols,
        };

        {
            let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances.insert(terminal_id.clone(), instance);
        }

        // For "cmd" type: cmd.exe is already the base shell, no need to start another one
        // For "powershell" type: need to start powershell.exe
        let shell_cmd = if effective_type == "cmd" {
            String::new()
        } else {
            "powershell.exe".to_string()
        };
        let tid = terminal_id.clone();
        let instances = self.instances.clone();

        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_millis(300));
            log_debug(&format!("[init-blank] sending shell command for {}", tid));

            let mut instances_lock = instances.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(instance) = instances_lock.get_mut(&tid) {
                if let Some(ref mut writer) = instance.writer {
                    if !shell_cmd.is_empty() {
                        let _ = writer.write_all(shell_cmd.as_bytes());
                        let _ = writer.write_all(b"\r");
                        let _ = writer.flush();
                    }
                }
            }
        });

        // Output forwarding thread
        spawn_output_forwarder(master_reader, terminal_id.clone(), app, output_buffer);

        log_debug(&format!("[create-blank] DONE, id={}", terminal_id));
        Ok(terminal_id)
    }
}

#[command]
pub fn start_terminal(
    profile_id: String,
    extra_startup_params: Option<String>,
    initial_rows: u16,
    initial_cols: u16,
    app: AppHandle,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    terminal_service.create_terminal(&profile_id, extra_startup_params.as_deref(), initial_rows, initial_cols, app, TerminalOwner::Pc)
}

#[command]
pub fn write_to_terminal(
    id: String,
    data: String,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.check_pc_permission(&id)?;
    terminal_service.write_to_terminal(&id, &data)
}

#[command]
pub fn resize_terminal(
    id: String,
    rows: u16,
    cols: u16,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.check_pc_permission(&id)?;
    // Desktop (Tauri invoke) always allows shrink — it's the primary viewer
    terminal_service.resize_terminal(&id, rows, cols, true)
}

#[command]
pub fn close_terminal(
    id: String,
    terminal_service: State<TerminalService>,
    ssh_service: State<SshSessionService>,
) -> Result<(), String> {
    terminal_service.check_pc_permission(&id)?;
    ssh_service.close_session(&id);
    terminal_service.close_terminal(&id)
}

#[command]
pub fn drain_terminal_output(
    id: String,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    terminal_service.drain_terminal_output(&id)
}

#[command]
pub fn peek_terminal_output(
    id: String,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    terminal_service.peek_terminal_output(&id)
}

#[command]
pub fn start_blank_terminal(
    terminal_type: String,
    initial_rows: u16,
    initial_cols: u16,
    app: AppHandle,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    terminal_service.create_blank_terminal(&terminal_type, initial_rows, initial_cols, app, TerminalOwner::Pc)
}

// 跟踪已启动的 mstsc 进程 PID，key = profile_id
static MSTSC_PROCESSES: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

fn mstsc_processes() -> &'static Mutex<HashMap<String, u32>> {
    MSTSC_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 检查进程是否仍在运行
fn is_process_running(pid: u32) -> bool {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION};
    use windows::Win32::Foundation::CloseHandle;

    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_QUERY_INFORMATION, false, pid) {
            let mut exit_code: u32 = 0;
            let running = windows::Win32::System::Threading::GetExitCodeProcess(handle, &mut exit_code).is_ok()
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
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
    };
    use windows::Win32::Foundation::{HWND, LPARAM};

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

    let mut ctx = EnumCtx { target_pid: pid, found_hwnd: None };
    unsafe {
        let _ = EnumWindows(Some(enum_callback), LPARAM(&mut ctx as *mut _ as isize));
        if let Some(hwnd) = ctx.found_hwnd {
            let _ = SetForegroundWindow(hwnd);
            return true;
        }
    }
    false
}

#[command]
pub fn start_mstsc(profile_id: String, _app: AppHandle) -> Result<(), String> {
    let profile = ProfileService::get_profile(&profile_id)
        .map_err(|e| format!("配置不存在: {}", e))?;

    let host = profile.mstsc_host.as_ref()
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
        let cred_target = format!("TERMSRV/{}", host);
        match std::process::Command::new("cmdkey.exe")
            .args(["/generic:".to_string() + &cred_target, "/user:".to_string() + user, "/pass:".to_string() + password])
            .output()
        {
            Ok(output) if !output.status.success() => {
                eprintln!("[mstsc] cmdkey.exe 存储凭据失败: {}", String::from_utf8_lossy(&output.stderr));
            }
            Err(e) => {
                eprintln!("[mstsc] cmdkey.exe 执行失败: {}", e);
            }
            _ => {}
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
