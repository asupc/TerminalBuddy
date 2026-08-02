use crate::models::web_api::TerminalInfo;
use crate::models::TerminalLoadingMode;
use crate::models::TerminalOwner;
use crate::services::ssh_session_service::SshSessionService;
use crate::services::ClaudeHookService;
use crate::services::PathService;
use crate::services::ProfileService;
use crate::services::SettingsService;
use crate::services::VsCodeTerminalProcess;
use crate::services::WebServiceState;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{command, AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast;
use uuid::Uuid;

const TERMINAL_DATA_IDLE_BUFFER_INTERVAL: Duration = Duration::from_millis(25);
const TERMINAL_DATA_MAX_BUFFER_INTERVAL: Duration = Duration::from_millis(50);
const VSCODE_TERMINAL_DATA_BUFFER_INTERVAL: Duration = Duration::from_millis(5);
const TERMINAL_DATA_CHANNEL_CAPACITY: usize = 32;
const TERMINAL_OUTPUT_BUFFER_MAX_CHUNKS: usize = 1000;
const TERMINAL_OUTPUT_BUFFER_MAX_BYTES: usize = 2 * 1024 * 1024;

struct TerminalOutputBuffer {
    chunks: VecDeque<Arc<str>>,
    bytes: usize,
}

impl TerminalOutputBuffer {
    fn new() -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
        }
    }

    fn push(&mut self, output: Arc<str>) {
        self.bytes += output.len();
        self.chunks.push_back(output);
        while self.chunks.len() > TERMINAL_OUTPUT_BUFFER_MAX_CHUNKS
            || self.bytes > TERMINAL_OUTPUT_BUFFER_MAX_BYTES
        {
            let Some(removed) = self.chunks.pop_front() else {
                break;
            };
            self.bytes -= removed.len();
        }
    }

    fn collect(&self) -> String {
        let mut output = String::with_capacity(self.bytes);
        for chunk in &self.chunks {
            output.push_str(chunk);
        }
        output
    }

    fn drain(&mut self) -> String {
        let output = self.collect();
        self.chunks.clear();
        self.bytes = 0;
        output
    }
}

/// 转义 shell 特殊字符，防止命令注入
fn shell_escape(s: &str) -> String {
    if s.contains(|c: char| {
        c == ' '
            || c == '"'
            || c == '\''
            || c == '&'
            || c == '|'
            || c == '>'
            || c == '<'
            || c == '^'
    }) {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

/// 定位 PowerShell 7.x 的 pwsh.exe：先查标准安装路径，再在 PATH 中查找
fn resolve_pwsh_exe() -> Result<String, String> {
    let default = r"C:\Program Files\PowerShell\7\pwsh.exe";
    if std::path::Path::new(default).is_file() {
        return Ok(default.to_string());
    }
    // PATH 查找：把 PATH 按 ';' 拆分，逐个目录检查 pwsh.exe / pwsh
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for name in &["pwsh.exe", "pwsh.cmd", "pwsh"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    if let Some(s) = candidate.to_str() {
                        return Ok(s.to_string());
                    }
                }
            }
        }
    }
    Err("未找到 PowerShell 7.x 可执行文件（pwsh.exe）。请从 https://aka.ms/install-powershell 安装 PowerShell 7，或将其所在目录加入 PATH".to_string())
}

pub struct TerminalInstance {
    pub id: String,
    pub profile_id: String,
    pub display_name: String,
    pub group_override: Option<String>,
    pub owner: TerminalOwner,
    pub extra_param_tag: Option<String>,
    pub extra_param_tag_color: Option<String>,
    /// AI 交付终端标记：drain_terminal_output 对其只返回缓冲不消费（monitor 线程独占消费落盘）。
    pub ai_delivery: bool,
    backend: TerminalBackend,
    output_buffer: Arc<Mutex<TerminalOutputBuffer>>,
    current_rows: u16,
    current_cols: u16,
    /// PTY 读取线程检测到 EOF 后置位；用于从 sessions 列表中剔除已退出的终端。
    pub exited: AtomicBool,
}

enum TerminalBackend {
    Default {
        child: Box<dyn Child + Send + Sync>,
        master: Box<dyn MasterPty + Send>,
        writer: Option<Box<dyn Write + Send>>,
    },
    VsCode(VsCodeTerminalProcess),
}

impl TerminalBackend {
    fn write_input(&mut self, data: &[u8]) -> Result<(), String> {
        match self {
            Self::Default { writer, .. } => {
                let writer = writer
                    .as_mut()
                    .ok_or_else(|| "Terminal writer not available".to_string())?;
                writer
                    .write_all(data)
                    .and_then(|_| writer.flush())
                    .map_err(|error| format!("Write failed: {}", error))
            }
            Self::VsCode(process) => process.write_input(data),
        }
    }

    fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        match self {
            Self::Default { master, .. } => master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| format!("Resize failed: {}", error)),
            Self::VsCode(process) => process.resize(rows, cols),
        }
    }

    fn close(&mut self) {
        match self {
            Self::Default { child, writer, .. } => {
                *writer = None;
                child.kill().ok();
                let _ = child.wait();
            }
            Self::VsCode(process) => {
                process.kill().ok();
                let _ = process.wait();
            }
        }
    }

    fn process_id(&self) -> Option<u32> {
        match self {
            Self::Default { child, .. } => child.process_id(),
            Self::VsCode(process) => process.process_id(),
        }
    }

    fn is_running(&mut self) -> bool {
        match self {
            Self::Default { child, .. } => matches!(child.try_wait(), Ok(None)),
            Self::VsCode(process) => process.is_running(),
        }
    }

    fn acknowledge_output(&mut self, char_count: u32) -> Result<(), String> {
        match self {
            Self::Default { .. } => Ok(()),
            Self::VsCode(process) => process.acknowledge_output(char_count),
        }
    }

    fn loading_mode(&self) -> &'static str {
        match self {
            Self::Default { .. } => "default",
            Self::VsCode(_) => "vsCode",
        }
    }
}

#[derive(Clone, Copy)]
enum TerminalOutputBufferMode {
    Default,
    VsCode,
}

#[derive(Clone)]
pub struct TerminalService {
    pub instances: Arc<Mutex<HashMap<String, TerminalInstance>>>,
    /// 会话变更广播：create/close/PTY 退出时发送 ()，meta WS 据此推送最新列表。
    pub session_change_tx: broadcast::Sender<()>,
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

fn spawn_terminal_backend(
    app: &AppHandle,
    mode: &TerminalLoadingMode,
    rows: u16,
    cols: u16,
    startup_path: Option<&str>,
    env_vars: &[(String, String)],
) -> Result<
    (
        TerminalBackend,
        Box<dyn Read + Send>,
        TerminalOutputBufferMode,
    ),
    String,
> {
    if *mode == TerminalLoadingMode::VsCode {
        let (process, reader) =
            VsCodeTerminalProcess::spawn(app, rows, cols, startup_path, env_vars)?;
        return Ok((
            TerminalBackend::VsCode(process),
            reader,
            TerminalOutputBufferMode::VsCode,
        ));
    }

    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("openpty FAILED: {}", error))?;
    let mut command = CommandBuilder::new("cmd.exe");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if let Some(path) = startup_path {
        command.cwd(path);
    }
    for (key, value) in env_vars {
        command.env(key, value);
    }
    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("spawn_command FAILED: {}", error))?;
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|error| format!("take_writer FAILED: {}", error))?;
    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("try_clone_reader FAILED: {}", error))?;

    Ok((
        TerminalBackend::Default {
            child,
            master: pty_pair.master,
            writer: Some(writer),
        },
        reader,
        TerminalOutputBufferMode::Default,
    ))
}

/// Shared output forwarding logic for both create_terminal and create_blank_terminal
fn spawn_output_forwarder(
    reader: Box<dyn Read + Send>,
    terminal_id: String,
    app: AppHandle,
    output_buffer: Arc<Mutex<TerminalOutputBuffer>>,
    buffer_mode: TerminalOutputBufferMode,
) {
    thread::spawn(move || {
        let (data_tx, data_rx) = mpsc::sync_channel::<Vec<u8>>(TERMINAL_DATA_CHANNEL_CAPACITY);
        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if data_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut utf8_pending = Vec::new();
        while let Ok(first_chunk) = data_rx.recv() {
            let batch_started = Instant::now();
            let (mut idle_deadline, max_deadline, reset_idle) = match buffer_mode {
                TerminalOutputBufferMode::Default => (
                    batch_started + TERMINAL_DATA_IDLE_BUFFER_INTERVAL,
                    batch_started + TERMINAL_DATA_MAX_BUFFER_INTERVAL,
                    true,
                ),
                TerminalOutputBufferMode::VsCode => (
                    batch_started + VSCODE_TERMINAL_DATA_BUFFER_INTERVAL,
                    batch_started + VSCODE_TERMINAL_DATA_BUFFER_INTERVAL,
                    false,
                ),
            };
            let mut batch = std::mem::take(&mut utf8_pending);
            batch.extend_from_slice(&first_chunk);
            let mut disconnected = false;

            loop {
                let deadline = idle_deadline.min(max_deadline);
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                match data_rx.recv_timeout(remaining) {
                    Ok(chunk) => {
                        batch.extend_from_slice(&chunk);
                        if reset_idle {
                            idle_deadline = Instant::now() + TERMINAL_DATA_IDLE_BUFFER_INTERVAL;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }

            let output: Arc<str> = match std::str::from_utf8(&batch) {
                Ok(s) => Arc::from(s),
                Err(error) if error.error_len().is_none() => {
                    let valid_up_to = error.valid_up_to();
                    utf8_pending.extend_from_slice(&batch[valid_up_to..]);
                    Arc::from(
                        std::str::from_utf8(&batch[..valid_up_to])
                            .expect("valid_up_to must end on a UTF-8 boundary"),
                    )
                }
                Err(_) => Arc::from(String::from_utf8_lossy(&batch).to_string()),
            };
            if !output.is_empty() {
                {
                    let mut buffer = output_buffer.lock().unwrap_or_else(|e| e.into_inner());
                    buffer.push(output.clone());
                }
                let _ = app.emit(&format!("terminal_output_{}", terminal_id), output.clone());
                let web_state = app.state::<crate::services::WebServiceState>();
                web_state.broadcast(&terminal_id, &output);
            }

            if disconnected {
                break;
            }
        }
        // PTY exited (SSH disconnect, `exit` command, child crash, etc.).
        // 1. Notify desktop frontend (removeSession is idempotent → safe on intentional close).
        let _ = app.emit("terminal-closed", &terminal_id);
        // 2. Mark the instance exited so it drops out of the mobile sessions list.
        {
            let ts = app.state::<TerminalService>();
            if let Some(inst) = ts
                .instances
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_mut(&terminal_id)
            {
                inst.exited.store(true, Ordering::SeqCst);
            }
            // 3. Drop all output subscribers for this terminal → their recv() returns None →
            //    the WS handler sends Exited to the mobile client.
            app.state::<WebServiceState>().close_all(&terminal_id);
            // 4. Push a sessions update so the mobile nav screen removes the dead entry.
            ts.notify_sessions_changed();
        }
        ClaudeHookService::unregister_terminal(&terminal_id);
    });
}

impl Default for TerminalService {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalService {
    pub fn new() -> Self {
        let (session_change_tx, _) = broadcast::channel::<()>(16);
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
            session_change_tx,
        }
    }

    /// 通知 meta WS 订阅者：会话列表已变化，需重新推送。无订阅者时静默 no-op。
    pub fn notify_sessions_changed(&self) {
        let _ = self.session_change_tx.send(());
    }

    /// 构建当前存活终端的列表（供 REST `GET /api/terminals`、Tauri 命令、meta WS 共用）。
    /// 过滤掉 PTY 已退出的实例，并用 ProfileService 补全 profile 元数据。
    pub fn list_terminals_info(&self) -> Vec<TerminalInfo> {
        let entries: Vec<(
            String,
            String,
            String,
            String,
            TerminalOwner,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = {
            let instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances
                .values()
                .filter(|inst| !inst.exited.load(Ordering::SeqCst))
                .map(|inst| {
                    (
                        inst.id.clone(),
                        inst.profile_id.clone(),
                        inst.display_name.clone(),
                        inst.backend.loading_mode().to_string(),
                        inst.owner.clone(),
                        inst.group_override.clone(),
                        inst.extra_param_tag.clone(),
                        inst.extra_param_tag_color.clone(),
                    )
                })
                .collect()
        };
        entries
            .into_iter()
            .map(
                |(
                    id,
                    profile_id,
                    display_name,
                    loading_mode,
                    owner,
                    group_override,
                    extra_param_tag,
                    extra_param_tag_color,
                )| {
                    let profile = ProfileService::get_profile(&profile_id).ok();
                    TerminalInfo {
                        id,
                        group: group_override.unwrap_or_else(|| {
                            profile
                                .as_ref()
                                .map(|p| p.group.clone())
                                .unwrap_or_default()
                        }),
                        profile_name: display_name,
                        terminal_type: profile
                            .as_ref()
                            .map(|p| p.terminal_type.clone())
                            .unwrap_or_default(),
                        loading_mode,
                        profile_id,
                        owner,
                        extra_param_tag,
                        extra_param_tag_color,
                    }
                },
            )
            .collect()
    }

    pub fn create_terminal(
        &self,
        profile_id: &str,
        display_name: Option<&str>,
        extra_startup_params: Option<&str>,
        initial_rows: u16,
        initial_cols: u16,
        startup_path_override: Option<&str>,
        extra_param_tag: Option<&str>,
        extra_param_tag_color: Option<&str>,
        app: AppHandle,
        owner: TerminalOwner,
    ) -> Result<String, String> {
        let terminal_id = Uuid::new_v4().to_string();
        log_debug(&format!(
            "[create] start, id={}, profile_id={}",
            terminal_id, profile_id
        ));

        // Load profile settings
        let profile = ProfileService::get_profile(profile_id).ok();
        let display_name = display_name
            .filter(|name| !name.trim().is_empty())
            .map(str::to_string)
            .or_else(|| profile.as_ref().map(|p| p.name.clone()))
            .unwrap_or_default();
        let terminal_type = profile
            .as_ref()
            .map_or("powershell", |p| p.terminal_type.as_str());
        let profile_startup_path = profile.as_ref().and_then(|p| {
            if p.startup_path.is_empty() {
                None
            } else {
                Some(p.startup_path.clone())
            }
        });
        let startup_path_override = startup_path_override
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .filter(|path| std::path::Path::new(path).is_dir())
            .map(str::to_string);
        let startup_path = startup_path_override.or(profile_startup_path);
        let startup_commands: Vec<String> = profile
            .as_ref()
            .map(|p| p.startup_commands.clone())
            .unwrap_or_default();
        let startup_commands: Vec<String> = if let Some(extra) = extra_startup_params {
            if !extra.is_empty() {
                startup_commands
                    .into_iter()
                    .map(|cmd| format!("{} {}", cmd, extra))
                    .collect()
            } else {
                startup_commands
            }
        } else {
            startup_commands
        };
        let mut env_vars: Vec<(String, String)> = profile
            .as_ref()
            .map(|p| {
                p.environment_variables
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        if !env_vars
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("CLAUDE_CONFIG_DIR"))
        {
            if let Some(config_dir) = SettingsService::get_settings().claude_hook_config_dir {
                env_vars.push(("CLAUDE_CONFIG_DIR".to_string(), config_dir));
            }
        }
        let hook_token = ClaudeHookService::register_terminal(&terminal_id);
        env_vars.push((
            "TERMINAL_BUDDY_TERMINAL_ID".to_string(),
            terminal_id.clone(),
        ));
        env_vars.push(("TERMINAL_BUDDY_HOOK_TOKEN".to_string(), hook_token));
        env_vars.push((
            "TERMINAL_BUDDY_HOOK_PORT".to_string(),
            ClaudeHookService::server_port().to_string(),
        ));

        log_debug(&format!(
            "[create] type={}, path={:?}, commands={}, envs={}",
            terminal_type,
            startup_path,
            startup_commands.len(),
            env_vars.len()
        ));
        crate::boot_log(format!(
            "[create_terminal] start type={} profile={}",
            terminal_type, profile_id
        ));

        let init_rows = if initial_rows > 0 { initial_rows } else { 24 };
        let init_cols = if initial_cols > 0 { initial_cols } else { 80 };
        let loading_mode = SettingsService::get_settings().terminal_loading_mode;
        let (backend, backend_reader, output_buffer_mode) = spawn_terminal_backend(
            &app,
            &loading_mode,
            init_rows,
            init_cols,
            startup_path.as_deref(),
            &env_vars,
        )
        .map_err(|error| {
            ClaudeHookService::unregister_terminal(&terminal_id);
            log_debug(&format!("[create] backend FAILED: {}", error));
            error
        })?;
        crate::boot_log(format!("[terminal] backend ready mode={:?}", loading_mode));

        let output_buffer = Arc::new(Mutex::new(TerminalOutputBuffer::new()));

        let instance = TerminalInstance {
            id: terminal_id.clone(),
            profile_id: profile_id.to_string(),
            display_name,
            group_override: None,
            owner,
            extra_param_tag: extra_param_tag.map(str::to_string),
            extra_param_tag_color: extra_param_tag_color.map(str::to_string),
            ai_delivery: false,
            backend,
            output_buffer: output_buffer.clone(),
            current_rows: init_rows,
            current_cols: init_cols,
            exited: AtomicBool::new(false),
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
            "pwsh" => {
                let pwsh = resolve_pwsh_exe()?;
                let mut cmds = vec![pwsh];
                cmds.extend(startup_commands);
                cmds
            }
            "ssh" => {
                let p = profile.as_ref();
                let host = p.and_then(|p| p.ssh_host.clone()).unwrap_or_default();
                let port = p.and_then(|p| p.ssh_port).unwrap_or(22);
                let user = p.and_then(|p| p.ssh_user.clone()).unwrap_or_default();
                let auth_type = p
                    .and_then(|p| p.ssh_auth_type.clone())
                    .unwrap_or_else(|| "key".to_string());
                let key_path = p.and_then(|p| p.ssh_key_path.clone()).unwrap_or_default();
                let ssh_cmd = if auth_type == "key" && !key_path.is_empty() {
                    format!(
                        "ssh -i {} -p {} {}@{}",
                        shell_escape(&key_path),
                        port,
                        shell_escape(&user),
                        shell_escape(&host)
                    )
                } else {
                    format!(
                        "ssh -p {} {}@{}",
                        port,
                        shell_escape(&user),
                        shell_escape(&host)
                    )
                };
                vec![ssh_cmd]
            }
            "docker" => {
                let container = profile
                    .as_ref()
                    .and_then(|p| p.docker_container_name.clone())
                    .or_else(|| profile.as_ref().and_then(|p| p.docker_container_id.clone()))
                    .unwrap_or_default();
                vec![format!(
                    "docker exec -it {} cmd.exe",
                    shell_escape(&container)
                )]
            }
            "k8s" => {
                let ns = profile
                    .as_ref()
                    .and_then(|p| p.k8s_namespace.clone())
                    .unwrap_or_default();
                let pod = profile
                    .as_ref()
                    .and_then(|p| p.k8s_pod_name.clone())
                    .unwrap_or_default();
                let container = profile
                    .as_ref()
                    .and_then(|p| p.k8s_container_name.clone())
                    .unwrap_or_default();
                let mut cmd = format!(
                    "kubectl exec -it -n {} {}",
                    shell_escape(&ns),
                    shell_escape(&pod)
                );
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
                log_debug(&format!(
                    "[init-cmds] sending {} commands for {}",
                    commands.len(),
                    tid
                ));

                let mut instances_lock = instances.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(instance) = instances_lock.get_mut(&tid) {
                    for cmd_str in &commands {
                        let command = format!("{}\r", cmd_str);
                        if let Err(error) = instance.backend.write_input(command.as_bytes()) {
                            log_debug(&format!("[init-cmds] failed: {}", error));
                            break;
                        }
                        log_debug(&format!("[init-cmds] sent: {}", cmd_str));
                    }
                }
            });
        }

        // Output forwarding thread
        spawn_output_forwarder(
            backend_reader,
            terminal_id.clone(),
            app,
            output_buffer,
            output_buffer_mode,
        );

        log_debug(&format!("[create] DONE, id={}", terminal_id));
        crate::boot_log("[create_terminal] DONE");
        self.notify_sessions_changed();
        Ok(terminal_id)
    }

    pub fn write_to_terminal(&self, id: &str, data: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(instance) = instances.get_mut(id) {
            instance.backend.write_input(data.as_bytes())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    /// 将终端标记为 AI 交付终端：drain_terminal_output 对其只读不消费（monitor 线程独占消费）。
    pub fn set_ai_delivery_flag(&self, id: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
        let instance = instances
            .get_mut(id)
            .ok_or("Terminal not found".to_string())?;
        instance.ai_delivery = true;
        Ok(())
    }

    pub fn update_terminal_display_name(&self, id: &str, display_name: &str) -> Result<(), String> {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err("终端名称不能为空".to_string());
        }

        let changed = {
            let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            let instance = instances
                .get_mut(id)
                .ok_or("Terminal not found".to_string())?;
            if instance.display_name == display_name {
                false
            } else {
                instance.display_name = display_name.to_string();
                true
            }
        };
        if changed {
            self.notify_sessions_changed();
        }
        Ok(())
    }

    pub fn resize_terminal(
        &self,
        id: &str,
        rows: u16,
        cols: u16,
        allow_shrink: bool,
    ) -> Result<(), String> {
        // 与 web/ws.rs 的 Resize 处理对齐：clamp 到 1..=500，避免 0 或异常尺寸
        // 传入 ConPTY 触发底层异常（前端在布局过渡帧可能短暂算出 0）。
        let rows = rows.clamp(1, 500);
        let cols = cols.clamp(1, 500);
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
                instance.backend.resize(new_rows, new_cols)?;
                instance.current_rows = new_rows;
                instance.current_cols = new_cols;
                log_debug(&format!(
                    "[resize] id={} rows={} cols={} allow_shrink={}",
                    id, new_rows, new_cols, allow_shrink
                ));
            }
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn acknowledge_terminal_output(&self, id: &str, char_count: u32) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
        let instance = instances
            .get_mut(id)
            .ok_or("Terminal not found".to_string())?;
        instance.backend.acknowledge_output(char_count)
    }

    pub fn terminal_loading_mode(&self, id: &str) -> Result<&'static str, String> {
        let instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
        let instance = instances.get(id).ok_or("Terminal not found".to_string())?;
        Ok(instance.backend.loading_mode())
    }

    pub fn drain_terminal_output(&self, id: &str) -> Result<String, String> {
        // Get buffer reference while holding instances lock briefly
        let (buf_arc, ai_delivery) = {
            let instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances
                .get(id)
                .map(|inst| (inst.output_buffer.clone(), inst.ai_delivery))
                .ok_or("Terminal not found".to_string())?
        };
        let mut buffer = buf_arc.lock().unwrap_or_else(|e| e.into_inner());
        if ai_delivery {
            // AI 交付终端：只返回当前缓冲、不消费（monitor 线程是唯一消费方，负责落盘 live-output.log）
            return Ok(buffer.collect());
        }
        Ok(buffer.drain())
    }

    pub fn peek_terminal_output(&self, id: &str) -> Result<String, String> {
        let buf_arc = {
            let instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances
                .get(id)
                .map(|inst| inst.output_buffer.clone())
                .ok_or("Terminal not found".to_string())?
        };
        let buffer = buf_arc.lock().unwrap_or_else(|e| e.into_inner());
        Ok(buffer.collect())
    }

    /// 检查终端后端进程是否仍在运行。仅能读取输出并不代表 PTY 进程仍然存活。
    pub fn is_terminal_running(&self, id: &str) -> bool {
        let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
        let Some(instance) = instances.get_mut(id) else {
            return false;
        };
        if instance.exited.load(Ordering::SeqCst) {
            return false;
        }
        let running = instance.backend.is_running();
        if !running {
            instance.exited.store(true, Ordering::SeqCst);
        }
        running
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
        let instance = {
            let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances
                .remove(id)
                .ok_or("Terminal not found".to_string())?
        };
        self.schedule_terminal_cleanup(id, instance);
        Ok(())
    }

    pub fn close_terminal_with_check(
        &self,
        id: &str,
        required_owner: Option<TerminalOwner>,
    ) -> Result<(), String> {
        let instance = {
            let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            let instance = instances.get(id).ok_or("Terminal not found".to_string())?;
            if let Some(expected) = required_owner {
                if instance.owner != expected {
                    return Err("无权限关闭此终端".to_string());
                }
            }
            instances
                .remove(id)
                .ok_or("Terminal not found".to_string())?
        };
        self.schedule_terminal_cleanup(id, instance);
        Ok(())
    }

    fn schedule_terminal_cleanup(&self, id: &str, mut instance: TerminalInstance) {
        ClaudeHookService::unregister_terminal(id);
        self.notify_sessions_changed();
        log_debug(&format!("[close] detached, id={}", id));

        let terminal_id = id.to_string();
        let _cleanup_task = tauri::async_runtime::spawn_blocking(move || {
            let started = Instant::now();
            instance.backend.close();
            log_debug(&format!(
                "[close] cleanup DONE, id={}, elapsed_ms={}",
                terminal_id,
                started.elapsed().as_millis(),
            ));
        });
    }

    pub fn create_blank_terminal(
        &self,
        terminal_type: &str,
        display_name: Option<&str>,
        group_override: Option<&str>,
        initial_rows: u16,
        initial_cols: u16,
        startup_path: Option<&str>,
        app: AppHandle,
        owner: TerminalOwner,
    ) -> Result<String, String> {
        let terminal_id = Uuid::new_v4().to_string();
        log_debug(&format!(
            "[create-blank] start, id={}, type={}",
            terminal_id, terminal_type
        ));
        crate::boot_log(format!(
            "[create_blank_terminal] start type={}",
            terminal_type
        ));
        let startup_path = startup_path
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .filter(|path| std::path::Path::new(path).is_dir())
            .map(str::to_string);

        // Blank terminals only support cmd and powershell;
        // ssh/docker/k8s require connection parameters from a profile
        let effective_type = match terminal_type {
            "cmd" => "cmd",
            "powershell" => "powershell",
            "pwsh" => "pwsh",
            _ => "powershell", // fallback for ssh/docker/k8s without profile
        };
        let display_name = display_name
            .filter(|name| !name.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| match effective_type {
                "cmd" => "CMD".to_string(),
                "pwsh" => "PowerShell 7".to_string(),
                _ => "PowerShell".to_string(),
            });
        let init_rows = if initial_rows > 0 { initial_rows } else { 24 };
        let init_cols = if initial_cols > 0 { initial_cols } else { 80 };
        let loading_mode = SettingsService::get_settings().terminal_loading_mode;
        let hook_token = ClaudeHookService::register_terminal(&terminal_id);
        let mut env_vars = vec![
            (
                "TERMINAL_BUDDY_TERMINAL_ID".to_string(),
                terminal_id.clone(),
            ),
            ("TERMINAL_BUDDY_HOOK_TOKEN".to_string(), hook_token),
            (
                "TERMINAL_BUDDY_HOOK_PORT".to_string(),
                ClaudeHookService::server_port().to_string(),
            ),
        ];
        if let Some(config_dir) = SettingsService::get_settings().claude_hook_config_dir {
            env_vars.push(("CLAUDE_CONFIG_DIR".to_string(), config_dir));
        }
        let (backend, backend_reader, output_buffer_mode) = spawn_terminal_backend(
            &app,
            &loading_mode,
            init_rows,
            init_cols,
            startup_path.as_deref(),
            &env_vars,
        )
        .map_err(|error| {
            ClaudeHookService::unregister_terminal(&terminal_id);
            log_debug(&format!("[create-blank] backend FAILED: {}", error));
            error
        })?;
        crate::boot_log(format!("[terminal] backend ready mode={:?}", loading_mode));

        let output_buffer = Arc::new(Mutex::new(TerminalOutputBuffer::new()));

        let instance = TerminalInstance {
            id: terminal_id.clone(),
            profile_id: String::new(),
            display_name,
            group_override: group_override
                .map(str::trim)
                .filter(|group| !group.is_empty())
                .map(str::to_string),
            owner,
            ai_delivery: false,
            backend,
            output_buffer: output_buffer.clone(),
            current_rows: init_rows,
            current_cols: init_cols,
            exited: AtomicBool::new(false),
            extra_param_tag: None,
            extra_param_tag_color: None,
        };

        {
            let mut instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
            instances.insert(terminal_id.clone(), instance);
        }

        // For "cmd" type: cmd.exe is already the base shell, no need to start another one
        // For "powershell" type: need to start powershell.exe
        // For "pwsh" type: need to start pwsh.exe (PowerShell 7.x)
        let shell_cmd = match effective_type {
            "cmd" => String::new(),
            "pwsh" => resolve_pwsh_exe()?,
            _ => "powershell.exe".to_string(),
        };
        let tid = terminal_id.clone();
        let instances = self.instances.clone();

        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_millis(300));
            log_debug(&format!("[init-blank] sending shell command for {}", tid));

            let mut instances_lock = instances.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(instance) = instances_lock.get_mut(&tid) {
                if !shell_cmd.is_empty() {
                    let command = format!("{}\r", shell_cmd);
                    if let Err(error) = instance.backend.write_input(command.as_bytes()) {
                        log_debug(&format!("[init-blank] failed: {}", error));
                    }
                }
            }
        });

        // Output forwarding thread
        spawn_output_forwarder(
            backend_reader,
            terminal_id.clone(),
            app,
            output_buffer,
            output_buffer_mode,
        );

        log_debug(&format!("[create-blank] DONE, id={}", terminal_id));
        crate::boot_log("[create_blank_terminal] DONE");
        self.notify_sessions_changed();
        Ok(terminal_id)
    }
}

#[command]
pub async fn start_terminal(
    profile_id: String,
    display_name: Option<String>,
    extra_startup_params: Option<String>,
    initial_rows: u16,
    initial_cols: u16,
    startup_path: Option<String>,
    extra_param_tag: Option<String>,
    extra_param_tag_color: Option<String>,
    app: AppHandle,
    terminal_service: State<'_, TerminalService>,
) -> Result<String, String> {
    let terminal_service = terminal_service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        terminal_service.create_terminal(
            &profile_id,
            display_name.as_deref(),
            extra_startup_params.as_deref(),
            initial_rows,
            initial_cols,
            startup_path.as_deref(),
            extra_param_tag.as_deref(),
            extra_param_tag_color.as_deref(),
            app,
            TerminalOwner::Pc,
        )
    })
    .await
    .map_err(|error| format!("终端后台启动失败：{}", error))?
}

#[command]
pub fn update_terminal_display_name(
    id: String,
    display_name: String,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.update_terminal_display_name(&id, &display_name)
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
    web_service_state: State<WebServiceState>,
) -> Result<(), String> {
    terminal_service.check_pc_permission(&id)?;
    if web_service_state.get_subscriber_count(&id) > 0 {
        return Ok(());
    }
    // Without an active Web takeover, the desktop remains the primary viewer.
    terminal_service.resize_terminal(&id, rows, cols, true)
}

#[command]
pub fn acknowledge_terminal_output(
    id: String,
    char_count: u32,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.acknowledge_terminal_output(&id, char_count)
}

#[command]
pub fn get_terminal_loading_mode(
    id: String,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    terminal_service
        .terminal_loading_mode(&id)
        .map(str::to_string)
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

/// 列出当前所有存活终端（含 profile 元数据）。供桌面端将来同步展示，亦被 web 层复用。
#[command]
pub fn list_terminals(
    terminal_service: State<TerminalService>,
) -> Result<Vec<TerminalInfo>, String> {
    Ok(terminal_service.list_terminals_info())
}

#[command]
pub async fn start_blank_terminal(
    terminal_type: String,
    display_name: Option<String>,
    initial_rows: u16,
    initial_cols: u16,
    startup_path: Option<String>,
    app: AppHandle,
    terminal_service: State<'_, TerminalService>,
) -> Result<String, String> {
    let terminal_service = terminal_service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        terminal_service.create_blank_terminal(
            &terminal_type,
            display_name.as_deref(),
            None,
            initial_rows,
            initial_cols,
            startup_path.as_deref(),
            app,
            TerminalOwner::Pc,
        )
    })
    .await
    .map_err(|error| format!("终端后台启动失败：{}", error))?
}

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
pub fn start_mstsc(profile_id: String, _app: AppHandle) -> Result<(), String> {
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

/// Claude Code 会话文件结构 (位于 ~/.claude/sessions/<pid>.json)
#[derive(Deserialize)]
struct ClaudeSessionFile {
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: String,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

/// 获取终端进程的 PID
#[command]
pub fn get_terminal_process_id(
    terminal_id: String,
    service: State<'_, TerminalService>,
) -> Result<Option<u32>, String> {
    let instances = service.instances.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(instance) = instances.get(&terminal_id) {
        Ok(instance.backend.process_id())
    } else {
        Ok(None)
    }
}

/// 一次性获取所有进程的父子关系，返回 (pid, parent_pid, name)
/// 使用 Windows API CreateToolhelp32Snapshot（几十毫秒），远快于 PowerShell/WMIC
fn get_all_processes() -> Vec<(u32, u32, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut result = Vec::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return result,
        };
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                let ppid = entry.th32ParentProcessID;
                let name_end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_end]).to_lowercase();
                result.push((pid, ppid, name));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    result
}

/// 在进程树中查找 Claude Code 进程（基于预加载的进程列表）
/// 只匹配进程名包含 "claude" 的进程，排除 node（避免 IDE/codegraph 误报）
fn find_claude_pids_in_tree(
    parent_pid: u32,
    all_processes: &[(u32, u32, String)],
    visited: &mut HashSet<u32>,
) -> Vec<u32> {
    let mut result = Vec::new();
    if visited.contains(&parent_pid) {
        return result;
    }
    visited.insert(parent_pid);

    for &(pid, ppid, ref name) in all_processes {
        if ppid == parent_pid {
            if name.contains("claude") {
                // 检查这个进程是否有对应的 session 文件
                let home = dirs::home_dir().unwrap_or_default();
                let session_file = home
                    .join(".claude")
                    .join("sessions")
                    .join(format!("{}.json", pid));
                if session_file.exists() {
                    result.push(pid);
                }
            }
            // 递归查找子进程（即使当前进程不是 claude，子进程也可能是）
            result.extend(find_claude_pids_in_tree(pid, all_processes, visited));
        }
    }

    result
}

/// 通过终端进程树查找 Claude Code 会话 ID
/// 不限制 status，返回 updatedAt 最大的会话（最近活跃的）
#[command]
pub fn get_claude_session_for_terminal(
    terminal_id: String,
    service: State<'_, TerminalService>,
) -> Result<Option<String>, String> {
    // 获取终端进程的 PID
    let terminal_pid = {
        let instances = service.instances.lock().unwrap_or_else(|e| e.into_inner());
        instances
            .get(&terminal_id)
            .and_then(|instance| instance.backend.process_id())
    };

    let Some(pid) = terminal_pid else {
        return Ok(None);
    };

    // 一次性获取所有进程
    let all_processes = get_all_processes();

    // 在进程树中查找 Claude Code 进程
    let mut visited = HashSet::new();
    let claude_pids = find_claude_pids_in_tree(pid, &all_processes, &mut visited);

    // 读取找到的 Claude Code 进程的 session 文件
    let home = dirs::home_dir().ok_or("无法获取用户主目录")?;
    let sessions_dir = home.join(".claude").join("sessions");

    // 返回 updatedAt 最大的会话（最近活跃的），不限制 status
    let mut best: Option<(String, u64)> = None;

    for claude_pid in claude_pids {
        let session_file = sessions_dir.join(format!("{}.json", claude_pid));
        if let Ok(content) = fs::read_to_string(&session_file) {
            if let Ok(session) = serde_json::from_str::<ClaudeSessionFile>(&content) {
                match &best {
                    Some((_, ts)) if session.updated_at <= *ts => {}
                    _ => best = Some((session.session_id.clone(), session.updated_at)),
                }
            }
        }
    }

    Ok(best.map(|(id, _)| id))
}

/// 批量获取多个终端的 Claude Code 会话 ID
/// 只调用一次 CreateToolhelp32Snapshot，对所有终端在内存中查找，避免 N 次进程快照
#[command]
pub fn get_claude_sessions_for_terminals(
    terminal_ids: Vec<String>,
    service: State<'_, TerminalService>,
) -> Result<HashMap<String, String>, String> {
    // 1. 一次性获取所有终端的 PID
    let terminal_pids: Vec<(String, u32)> = {
        let instances = service.instances.lock().unwrap_or_else(|e| e.into_inner());
        terminal_ids
            .iter()
            .filter_map(|id| {
                instances
                    .get(id)
                    .and_then(|instance| instance.backend.process_id())
                    .map(|pid| (id.clone(), pid))
            })
            .collect()
    };

    if terminal_pids.is_empty() {
        return Ok(HashMap::new());
    }

    // 2. 一次性获取所有进程（Windows API，几十毫秒）
    let all_processes = get_all_processes();

    // 3. 对每个终端在进程树中查找 Claude session
    let home = dirs::home_dir().ok_or("无法获取用户主目录")?;
    let sessions_dir = home.join(".claude").join("sessions");

    let mut result = HashMap::new();

    for (terminal_id, pid) in &terminal_pids {
        let mut visited = HashSet::new();
        let claude_pids = find_claude_pids_in_tree(*pid, &all_processes, &mut visited);

        let mut best: Option<(String, u64)> = None;
        for claude_pid in claude_pids {
            let session_file = sessions_dir.join(format!("{}.json", claude_pid));
            if let Ok(content) = fs::read_to_string(&session_file) {
                if let Ok(session) = serde_json::from_str::<ClaudeSessionFile>(&content) {
                    match &best {
                        Some((_, ts)) if session.updated_at <= *ts => {}
                        _ => best = Some((session.session_id.clone(), session.updated_at)),
                    }
                }
            }
        }

        if let Some((id, _)) = best {
            result.insert(terminal_id.clone(), id);
        }
    }

    Ok(result)
}

/// 扫描 ~/.claude/sessions/*.json，返回指定 cwd 下最近活跃的 Claude Code 会话 ID
/// 注意：当同一目录有多个终端时，此函数可能返回错误的结果，建议使用 get_claude_session_for_terminal
#[command]
pub fn get_claude_session_for_cwd(cwd: String) -> Result<Option<String>, String> {
    let home = dirs::home_dir().ok_or("无法获取用户主目录")?;
    let sessions_dir = home.join(".claude").join("sessions");

    if !sessions_dir.exists() {
        return Ok(None);
    }

    let cwd_normalized = cwd.replace('/', "\\").to_lowercase();
    let mut best: Option<(String, u64)> = None;

    let entries =
        fs::read_dir(&sessions_dir).map_err(|e| format!("读取 Claude sessions 目录失败: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(true, |ext| ext != "json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<ClaudeSessionFile>(&content) else {
            continue;
        };

        // 只考虑 cwd 匹配的会话（不限制 status，返回最近活跃的）
        let session_cwd = session.cwd.replace('/', "\\").to_lowercase();
        if session_cwd != cwd_normalized {
            continue;
        }

        match &best {
            Some((_, ts)) if session.updated_at <= *ts => {}
            _ => best = Some((session.session_id.clone(), session.updated_at)),
        }
    }

    Ok(best.map(|(id, _)| id))
}
