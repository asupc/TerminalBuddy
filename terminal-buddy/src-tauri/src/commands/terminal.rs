use crate::models::web_api::TerminalInfo;
use crate::models::Profile;
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
use std::collections::HashMap;
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
    /// 启动时使用的额外参数（快照，供 Web 端「以此配置新建终端」复用）
    pub extra_startup_params: Option<String>,
    /// 额外参数模式：append / independent
    pub extra_startup_mode: Option<String>,
    backend: TerminalBackend,
    output_buffer: Arc<Mutex<TerminalOutputBuffer>>,
    current_rows: u16,
    current_cols: u16,
    /// PTY 读取线程检测到 EOF 后置位；用于从 sessions 列表中剔除已退出的终端。
    pub exited: AtomicBool,
}

impl TerminalInstance {
    /// 后端进程 PID（供 Claude 会话发现等跨模块使用）
    pub(crate) fn process_id(&self) -> Option<u32> {
        self.backend.process_id()
    }
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
            if let Some(inst) = ts.lock_instances().get_mut(&terminal_id)
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

/// 统一获取 instances 锁：毒锁时取回内部值，避免 panic 扩散。
fn lock_instances_map(
    instances: &Mutex<HashMap<String, TerminalInstance>>,
) -> std::sync::MutexGuard<'_, HashMap<String, TerminalInstance>> {
    instances.lock().unwrap_or_else(|e| e.into_inner())
}

/// 终端尺寸默认值：0/空值回退 24x80。
fn resolve_terminal_size(rows: u16, cols: u16) -> (u16, u16) {
    let rows = if rows > 0 { rows } else { 24 };
    let cols = if cols > 0 { cols } else { 80 };
    (rows, cols)
}

/// 组装终端环境变量：profile 变量 + CLAUDE_CONFIG_DIR（未设置时）+ TERMINAL_BUDDY_* 三个标志位。
fn build_terminal_env(terminal_id: &str, extra_env: Option<&[(String, String)]>) -> Vec<(String, String)> {
    let mut env_vars = extra_env.map(|vars| vars.to_vec()).unwrap_or_default();
    if !env_vars
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("CLAUDE_CONFIG_DIR"))
    {
        if let Some(config_dir) = SettingsService::get_settings().claude_hook_config_dir {
            env_vars.push(("CLAUDE_CONFIG_DIR".to_string(), config_dir));
        }
    }
    let hook_token = ClaudeHookService::register_terminal(terminal_id);
    env_vars.push((
        "TERMINAL_BUDDY_TERMINAL_ID".to_string(),
        terminal_id.to_string(),
    ));
    env_vars.push(("TERMINAL_BUDDY_HOOK_TOKEN".to_string(), hook_token));
    env_vars.push((
        "TERMINAL_BUDDY_HOOK_PORT".to_string(),
        ClaudeHookService::server_port().to_string(),
    ));
    env_vars
}

/// spawn 后端，失败时反注册 hook 并记录日志。
fn spawn_backend_with_cleanup(
    app: &AppHandle,
    loading_mode: &TerminalLoadingMode,
    init_rows: u16,
    init_cols: u16,
    startup_path: Option<&str>,
    env_vars: &[(String, String)],
    terminal_id: &str,
    log_prefix: &str,
) -> Result<
    (
        TerminalBackend,
        Box<dyn Read + Send>,
        TerminalOutputBufferMode,
    ),
    String,
> {
    let backend = spawn_terminal_backend(
        app,
        loading_mode,
        init_rows,
        init_cols,
        startup_path,
        env_vars,
    )
    .map_err(|error| {
        ClaudeHookService::unregister_terminal(terminal_id);
        log_debug(&format!("[{}] backend FAILED: {}", log_prefix, error));
        error
    })?;
    crate::boot_log(format!("[terminal] backend ready mode={:?}", loading_mode));
    Ok(backend)
}

/// 延迟 300ms 向终端写入初始化命令（等待 cmd.exe 初始化完成，保留原有时序）。
fn schedule_delayed_input(
    instances: Arc<Mutex<HashMap<String, TerminalInstance>>>,
    terminal_id: String,
    commands: Vec<String>,
    log_prefix: &str,
) {
    if commands.is_empty() {
        return;
    }
    let log_prefix = log_prefix.to_string();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        log_debug(&format!(
            "[{}] sending {} commands for {}",
            log_prefix,
            commands.len(),
            terminal_id
        ));

        let mut instances = lock_instances_map(&instances);
        if let Some(instance) = instances.get_mut(&terminal_id) {
            for command in &commands {
                let command = format!("{}\r", command);
                if let Err(error) = instance.backend.write_input(command.as_bytes()) {
                    log_debug(&format!("[{}] failed: {}", log_prefix, error));
                    break;
                }
                log_debug(&format!("[{}] sent: {}", log_prefix, command));
            }
        }
    });
}

/// 启动输出转发线程并完成创建收尾（日志 + 会话变更通知）。
fn finalize_terminal_creation(
    service: &TerminalService,
    backend_reader: Box<dyn Read + Send>,
    terminal_id: &str,
    app: AppHandle,
    output_buffer: Arc<Mutex<TerminalOutputBuffer>>,
    output_buffer_mode: TerminalOutputBufferMode,
    debug_prefix: &str,
    boot_prefix: &str,
) {
    spawn_output_forwarder(
        backend_reader,
        terminal_id.to_string(),
        app,
        output_buffer,
        output_buffer_mode,
    );
    log_debug(&format!("[{}] DONE, id={}", debug_prefix, terminal_id));
    crate::boot_log(format!("[{}] DONE", boot_prefix));
    service.notify_sessions_changed();
}

/// 按终端类型构造启动命令；ssh/docker/k8s 需要 profile 连接参数。
fn build_init_commands(
    terminal_type: &str,
    startup_commands: Vec<String>,
    profile: Option<&Profile>,
) -> Result<Vec<String>, String> {
    match terminal_type {
        "cmd" => Ok(startup_commands),
        "powershell" => {
            let mut cmds = vec!["powershell.exe".to_string()];
            cmds.extend(startup_commands);
            Ok(cmds)
        }
        "pwsh" => {
            let pwsh = resolve_pwsh_exe()?;
            let mut cmds = vec![pwsh];
            cmds.extend(startup_commands);
            Ok(cmds)
        }
        "ssh" => {
            let host = profile.and_then(|p| p.ssh_host.clone()).unwrap_or_default();
            let port = profile.and_then(|p| p.ssh_port).unwrap_or(22);
            let user = profile.and_then(|p| p.ssh_user.clone()).unwrap_or_default();
            let auth_type = profile
                .and_then(|p| p.ssh_auth_type.clone())
                .unwrap_or_else(|| "key".to_string());
            let key_path = profile
                .and_then(|p| p.ssh_key_path.clone())
                .unwrap_or_default();
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
            Ok(vec![ssh_cmd])
        }
        "docker" => {
            let container = profile
                .and_then(|p| p.docker_container_name.clone())
                .or_else(|| profile.and_then(|p| p.docker_container_id.clone()))
                .unwrap_or_default();
            Ok(vec![format!(
                "docker exec -it {} cmd.exe",
                shell_escape(&container)
            )])
        }
        "k8s" => {
            let ns = profile
                .and_then(|p| p.k8s_namespace.clone())
                .unwrap_or_default();
            let pod = profile
                .and_then(|p| p.k8s_pod_name.clone())
                .unwrap_or_default();
            let container = profile
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
            Ok(vec![cmd])
        }
        _ => {
            let mut cmds = vec!["powershell.exe".to_string()];
            cmds.extend(startup_commands);
            Ok(cmds)
        }
    }
}

fn apply_extra_startup_params(
    startup_commands: Vec<String>,
    extra_startup_params: Option<&str>,
    extra_startup_mode: Option<&str>,
) -> Vec<String> {
    let Some(extra) = extra_startup_params.filter(|extra| !extra.is_empty()) else {
        return startup_commands;
    };

    if extra_startup_mode == Some("independent") {
        vec![extra.to_string()]
    } else {
        startup_commands
            .into_iter()
            .map(|cmd| format!("{} {}", cmd, extra))
            .collect()
    }
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

    pub(crate) fn lock_instances(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, TerminalInstance>> {
        lock_instances_map(&self.instances)
    }

    fn insert_instance(&self, instance: TerminalInstance) {
        let mut instances = self.lock_instances();
        instances.insert(instance.id.clone(), instance);
    }

    fn output_buffer_arc(&self, id: &str) -> Result<Arc<Mutex<TerminalOutputBuffer>>, String> {
        let instances = self.lock_instances();
        instances
            .get(id)
            .map(|inst| inst.output_buffer.clone())
            .ok_or("Terminal not found".to_string())
    }

    /// 构建当前存活终端的列表（供 REST `GET /api/terminals`、Tauri 命令、meta WS 共用）。
    /// 过滤掉 PTY 已退出的实例，并用 ProfileService 补全 profile 元数据。
    pub fn list_terminals_info(&self) -> Vec<TerminalInfo> {
        struct InstanceSnapshot {
            id: String,
            profile_id: String,
            display_name: String,
            loading_mode: String,
            owner: TerminalOwner,
            group_override: Option<String>,
            extra_param_tag: Option<String>,
            extra_param_tag_color: Option<String>,
            extra_startup_params: Option<String>,
            extra_startup_mode: Option<String>,
        }
        let entries: Vec<InstanceSnapshot> = {
            let instances = self.lock_instances();
            instances
                .values()
                .filter(|inst| !inst.exited.load(Ordering::SeqCst))
                .map(|inst| InstanceSnapshot {
                    id: inst.id.clone(),
                    profile_id: inst.profile_id.clone(),
                    display_name: inst.display_name.clone(),
                    loading_mode: inst.backend.loading_mode().to_string(),
                    owner: inst.owner.clone(),
                    group_override: inst.group_override.clone(),
                    extra_param_tag: inst.extra_param_tag.clone(),
                    extra_param_tag_color: inst.extra_param_tag_color.clone(),
                    extra_startup_params: inst.extra_startup_params.clone(),
                    extra_startup_mode: inst.extra_startup_mode.clone(),
                })
                .collect()
        };
        entries
            .into_iter()
            .map(
                |InstanceSnapshot {
                     id,
                     profile_id,
                     display_name,
                     loading_mode,
                     owner,
                     group_override,
                     extra_param_tag,
                     extra_param_tag_color,
                     extra_startup_params,
                     extra_startup_mode,
                 }| {
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
                        extra_startup_params,
                        extra_startup_mode,
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
        extra_startup_mode: Option<&str>,
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
        let startup_commands =
            apply_extra_startup_params(startup_commands, extra_startup_params, extra_startup_mode);
        let profile_env: Vec<(String, String)> = profile
            .as_ref()
            .map(|p| {
                p.environment_variables
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let env_vars = build_terminal_env(&terminal_id, Some(&profile_env));

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

        let (init_rows, init_cols) = resolve_terminal_size(initial_rows, initial_cols);
        let loading_mode = SettingsService::get_settings().terminal_loading_mode;
        let (backend, backend_reader, output_buffer_mode) = spawn_backend_with_cleanup(
            &app,
            &loading_mode,
            init_rows,
            init_cols,
            startup_path.as_deref(),
            &env_vars,
            &terminal_id,
            "create",
        )?;

        let output_buffer = Arc::new(Mutex::new(TerminalOutputBuffer::new()));

        let instance = TerminalInstance {
            id: terminal_id.clone(),
            profile_id: profile_id.to_string(),
            display_name,
            group_override: None,
            owner,
            extra_param_tag: extra_param_tag.map(str::to_string),
            extra_param_tag_color: extra_param_tag_color.map(str::to_string),
            extra_startup_params: extra_startup_params.map(str::to_string),
            extra_startup_mode: extra_startup_mode.map(str::to_string),
            backend,
            output_buffer: output_buffer.clone(),
            current_rows: init_rows,
            current_cols: init_cols,
            exited: AtomicBool::new(false),
        };
        self.insert_instance(instance);

        // Build init commands based on terminal type
        let init_commands = build_init_commands(terminal_type, startup_commands, profile.as_ref())?;
        schedule_delayed_input(
            self.instances.clone(),
            terminal_id.clone(),
            init_commands,
            "init-cmds",
        );

        // Output forwarding thread
        finalize_terminal_creation(
            self,
            backend_reader,
            &terminal_id,
            app,
            output_buffer,
            output_buffer_mode,
            "create",
            "create_terminal",
        );

        Ok(terminal_id)
    }

    pub fn write_to_terminal(&self, id: &str, data: &str) -> Result<(), String> {
        let mut instances = self.lock_instances();
        if let Some(instance) = instances.get_mut(id) {
            instance.backend.write_input(data.as_bytes())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn update_terminal_display_name(&self, id: &str, display_name: &str) -> Result<(), String> {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err("终端名称不能为空".to_string());
        }

        let changed = {
            let mut instances = self.lock_instances();
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
        let mut instances = self.lock_instances();
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
        let mut instances = self.lock_instances();
        let instance = instances
            .get_mut(id)
            .ok_or("Terminal not found".to_string())?;
        instance.backend.acknowledge_output(char_count)
    }

    pub fn terminal_loading_mode(&self, id: &str) -> Result<&'static str, String> {
        let instances = self.lock_instances();
        let instance = instances.get(id).ok_or("Terminal not found".to_string())?;
        Ok(instance.backend.loading_mode())
    }

    pub fn drain_terminal_output(&self, id: &str) -> Result<String, String> {
        let buf_arc = self.output_buffer_arc(id)?;
        let mut buffer = buf_arc.lock().unwrap_or_else(|e| e.into_inner());
        // 统一消费：drain 清空缓冲并返回全部内容；消费后下一轮只拿到新输出，避免重复累积。
        Ok(buffer.drain())
    }

    pub fn peek_terminal_output(&self, id: &str) -> Result<String, String> {
        let buf_arc = self.output_buffer_arc(id)?;
        let buffer = buf_arc.lock().unwrap_or_else(|e| e.into_inner());
        Ok(buffer.collect())
    }

    /// 检查 PC 端是否有权限操作指定终端
    /// 在不共享模式下，PC 端不能操作 Web 端创建的终端
    pub fn check_pc_permission(&self, id: &str) -> Result<(), String> {
        let settings = SettingsService::get_settings();
        if !settings.web_api_share_sessions {
            let instances = self.lock_instances();
            if let Some(terminal) = instances.get(id) {
                if terminal.owner == TerminalOwner::Web {
                    return Err("终端由 Web 端管理，PC 端只读".to_string());
                }
            }
        }
        Ok(())
    }

    pub fn close_terminal(&self, id: &str) -> Result<(), String> {
        self.close_terminal_with_check(id, None)
    }

    pub fn close_terminal_with_check(
        &self,
        id: &str,
        required_owner: Option<TerminalOwner>,
    ) -> Result<(), String> {
        let instance = {
            let mut instances = self.lock_instances();
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
        let (init_rows, init_cols) = resolve_terminal_size(initial_rows, initial_cols);
        let loading_mode = SettingsService::get_settings().terminal_loading_mode;
        let env_vars = build_terminal_env(&terminal_id, None);
        let (backend, backend_reader, output_buffer_mode) = spawn_backend_with_cleanup(
            &app,
            &loading_mode,
            init_rows,
            init_cols,
            startup_path.as_deref(),
            &env_vars,
            &terminal_id,
            "create-blank",
        )?;

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
            backend,
            output_buffer: output_buffer.clone(),
            current_rows: init_rows,
            current_cols: init_cols,
            exited: AtomicBool::new(false),
            extra_param_tag: None,
            extra_param_tag_color: None,
            extra_startup_params: None,
            extra_startup_mode: None,
        };
        self.insert_instance(instance);

        // For "cmd" type: cmd.exe is already the base shell, no need to start another one
        // For "powershell" type: need to start powershell.exe
        // For "pwsh" type: need to start pwsh.exe (PowerShell 7.x)
        let shell_cmd = match effective_type {
            "cmd" => String::new(),
            "pwsh" => resolve_pwsh_exe()?,
            _ => "powershell.exe".to_string(),
        };
        let init_commands = if shell_cmd.is_empty() {
            Vec::new()
        } else {
            vec![shell_cmd]
        };
        schedule_delayed_input(
            self.instances.clone(),
            terminal_id.clone(),
            init_commands,
            "init-blank",
        );

        // Output forwarding thread
        finalize_terminal_creation(
            self,
            backend_reader,
            &terminal_id,
            app,
            output_buffer,
            output_buffer_mode,
            "create-blank",
            "create_blank_terminal",
        );

        Ok(terminal_id)
    }
}

#[command]
pub async fn start_terminal(
    profile_id: String,
    display_name: Option<String>,
    extra_startup_params: Option<String>,
    extra_startup_mode: Option<String>,
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
            extra_startup_mode.as_deref(),
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

