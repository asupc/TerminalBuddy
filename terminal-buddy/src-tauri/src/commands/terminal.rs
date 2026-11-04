use crate::models::web_api::{TerminalInfo, TerminalReplayFrame};
use crate::models::Profile;
use crate::models::TerminalCreator;
use crate::models::TerminalLoadingMode;
use crate::models::TerminalOwner;
use crate::models::{
    filled_field, quote_cmd_argument, reject_control_chars, validate_docker_container,
    validate_k8s_name, validate_ssh_host, validate_ssh_key_path, validate_ssh_user,
};
use crate::models::{
    is_terminal_action_allowed, TerminalAccessError, TerminalAction, TerminalActor,
};
use crate::services::ssh_session_service::SshSessionService;
use crate::services::ClaudeHookService;
#[cfg(feature = "desktop")]
use crate::services::HandoffPty;
use crate::services::PathService;
use crate::services::ProfileService;
use crate::services::SettingsService;
#[cfg(feature = "desktop")]
use crate::services::VsCodeTerminalProcess;
use crate::services::WebServiceState;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use crate::runtime::{AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast;
use uuid::Uuid;

const TERMINAL_DATA_IDLE_BUFFER_INTERVAL: Duration = Duration::from_millis(25);
const TERMINAL_DATA_MAX_BUFFER_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(feature = "desktop")]
const VSCODE_TERMINAL_DATA_BUFFER_INTERVAL: Duration = Duration::from_millis(5);
const TERMINAL_DATA_CHANNEL_CAPACITY: usize = 32;
const TERMINAL_OUTPUT_BUFFER_MAX_CHUNKS: usize = 1000;
const TERMINAL_OUTPUT_BUFFER_MAX_BYTES: usize = 2 * 1024 * 1024;

pub fn default_terminal_type() -> &'static str {
    if cfg!(windows) { "powershell" } else { "bash" }
}

fn base_shell() -> String {
    if cfg!(windows) { "cmd.exe".to_string() } else {
        std::env::var("TERMINAL_BUDDY_SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

fn default_shell_command() -> &'static str {
    if cfg!(windows) { "powershell.exe" } else { "bash" }
}

fn local_shell_command(shell: &str) -> String {
    if cfg!(windows) { shell.to_string() } else { format!("exec {}", shell) }
}

fn target_shell() -> &'static str {
    if cfg!(windows) { "cmd.exe" } else { "sh" }
}

struct TerminalOutputChunk {
    data: Arc<str>,
    rows: u16,
    cols: u16,
}

struct TerminalOutputBuffer {
    chunks: VecDeque<TerminalOutputChunk>,
    rows: u16,
    cols: u16,
    bytes: usize,
    desktop_attached: bool,
}

impl TerminalOutputBuffer {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            chunks: VecDeque::new(),
            rows,
            cols,
            bytes: 0,
            desktop_attached: false,
        }
    }

    /// Store recent output for late Web clients and report whether the desktop
    /// listener has completed its initial snapshot handshake.
    fn push(&mut self, output: Arc<str>) -> bool {
        self.bytes += output.len();
        self.chunks.push_back(TerminalOutputChunk {
            data: output,
            rows: self.rows,
            cols: self.cols,
        });
        while self.chunks.len() > TERMINAL_OUTPUT_BUFFER_MAX_CHUNKS
            || self.bytes > TERMINAL_OUTPUT_BUFFER_MAX_BYTES
        {
            let Some(removed) = self.chunks.pop_front() else {
                break;
            };
            self.bytes -= removed.data.len();
        }
        self.desktop_attached
    }

    fn collect(&self) -> String {
        let mut output = String::with_capacity(self.bytes);
        for chunk in &self.chunks {
            output.push_str(&chunk.data);
        }
        output
    }

    /// 相邻输出尺寸相同时合并，连接时才复制字符串，PTY 热路径仍复用 Arc。
    fn replay_frames(&self) -> Vec<TerminalReplayFrame> {
        let mut frames: Vec<TerminalReplayFrame> = Vec::new();
        for chunk in &self.chunks {
            if let Some(last) = frames.last_mut() {
                if last.rows == chunk.rows && last.cols == chunk.cols {
                    last.data.push_str(&chunk.data);
                    continue;
                }
            }
            frames.push(TerminalReplayFrame {
                data: chunk.data.to_string(),
                rows: chunk.rows,
                cols: chunk.cols,
            });
        }
        frames
    }

    /// Atomically split startup output from subsequent live events. Output
    /// pushed before this call is returned in the snapshot and is not emitted
    /// to the desktop; later output is emitted through the registered listener.
    ///
    /// 非破坏式：环形缓冲不清空，Web 客户端重连仍能取到完整滚动历史。
    /// 边界仍然严格——`desktop_attached` 在同一把锁内翻转，快照里的分片
    /// 不会再作为 live event 发一遍。
    fn snapshot_and_attach(&mut self) -> String {
        self.desktop_attached = true;
        self.collect()
    }
}

/// 定位 PowerShell 7.x 的 pwsh.exe：先查标准安装路径，再在 PATH 中查找
fn resolve_pwsh_exe() -> Result<String, String> {
    #[cfg(not(windows))]
    {
        Ok("pwsh".to_string())
    }
    #[cfg(windows)]
    {
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
}

pub struct TerminalInstance {
    pub id: String,
    pub profile_id: String,
    pub display_name: String,
    pub group_override: Option<String>,
    pub owner: TerminalOwner,
    /// 创建端设备（PC 桌面与电脑浏览器都记 Desktop），用于来源标识与接管提示。
    pub creator: TerminalCreator,
    /// 实例真实终端类型（空白终端为 effective_type，配置终端为 profile 类型）。
    /// TerminalInfo 的 terminalType 必须从这里广播：只看 profile 会让空白终端
    /// 变成空串，Web 端「以此配置新建终端」的本地 Shell 判定随之失效。
    pub terminal_type: String,
    takeover: crate::models::TerminalTakeover,
    pub extra_param_tag: Option<String>,
    pub extra_param_tag_color: Option<String>,
    /// 启动时使用的额外参数（快照，供 Web 端「以此配置新建终端」复用）
    pub extra_startup_params: Option<String>,
    /// 额外参数模式：append / independent
    pub extra_startup_mode: Option<String>,
    /// 会话当前目录的权威值：创建时取启动目录，之后由前端检测 cd 后上报。
    /// 广播给所有端，让每个客户端的文件导航/会话历史跟随同一份目录。
    current_directory: Option<String>,
    backend: TerminalBackend,
    output_buffer: Arc<Mutex<TerminalOutputBuffer>>,
    current_rows: u16,
    current_cols: u16,
}

impl TerminalInstance {
    fn resize_viewport(
        &mut self,
        size: crate::models::TerminalSize,
        notification: Option<(crate::models::TerminalViewport, &AppHandle)>,
    ) -> Result<(), String> {
        // 与回放快照、输出入队使用同一把锁，先通知网格，再转发该网格的输出。
        let mut buffer = self.output_buffer.lock().unwrap_or_else(|e| e.into_inner());
        if size.rows != self.current_rows || size.cols != self.current_cols {
            self.backend.resize(size.rows, size.cols)?;
            buffer.rows = size.rows;
            buffer.cols = size.cols;
            self.current_rows = size.rows;
            self.current_cols = size.cols;
        }
        if let Some((viewport, app)) = notification {
            app.state::<WebServiceState>().broadcast_viewport(&self.id, viewport);
            if viewport.takeover {
                let _ = app.emit("terminal-web-resize", serde_json::json!({
                    "terminalId": self.id, "rows": size.rows, "cols": size.cols,
                }));
            } else {
                let _ = app.emit("terminal-web-takeover-ended", &self.id);
            }
        }
        Ok(())
    }

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
    #[cfg(feature = "desktop")]
    VsCode(VsCodeTerminalProcess),
    /// 默认终端 handoff：管道/句柄由 COM 移交（`EstablishPtyHandoff`），无自有 spawn。
    #[cfg(feature = "desktop")]
    Handoff(HandoffPty),
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
            #[cfg(feature = "desktop")]
            Self::VsCode(process) => process.write_input(data),
            #[cfg(feature = "desktop")]
            Self::Handoff(process) => process.write_input(data),
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
            #[cfg(feature = "desktop")]
            Self::VsCode(process) => process.resize(rows, cols),
            #[cfg(feature = "desktop")]
            Self::Handoff(process) => process.resize(rows, cols),
        }
    }

    /// 关闭后端并返回观测到的退出码：进程已退出时直接取自然退出码
    /// （供日志定性：0x40010004=系统终止，0x1=taskkill，0x0=正常退出），
    /// 仍在运行才发 kill，此时返回的是被终止的退出码。
    fn close(&mut self) -> Option<u32> {
        match self {
            Self::Default { child, writer, .. } => {
                *writer = None;
                if let Ok(Some(status)) = child.try_wait() {
                    return Some(status.exit_code());
                }
                child.kill().ok();
                child.wait().ok().map(|status| status.exit_code())
            }
            #[cfg(feature = "desktop")]
            Self::VsCode(process) => process.close(),
            #[cfg(feature = "desktop")]
            Self::Handoff(process) => process.close(),
        }
    }

    /// 只发终止信号、不 wait。供应用退出等不能被阻塞的路径使用。
    fn kill_without_wait(&mut self) {
        match self {
            Self::Default { child, writer, .. } => {
                *writer = None;
                child.kill().ok();
            }
            #[cfg(feature = "desktop")]
            Self::VsCode(process) => {
                process.kill().ok();
            }
            #[cfg(feature = "desktop")]
            Self::Handoff(process) => process.kill_without_wait(),
        }
    }

    fn process_id(&self) -> Option<u32> {
        match self {
            Self::Default { child, .. } => child.process_id(),
            #[cfg(feature = "desktop")]
            Self::VsCode(process) => process.process_id(),
            #[cfg(feature = "desktop")]
            Self::Handoff(process) => process.process_id(),
        }
    }

    fn acknowledge_output(&mut self, _char_count: u32) -> Result<(), String> {
        match self {
            Self::Default { .. } => Ok(()),
            #[cfg(feature = "desktop")]
            Self::VsCode(process) => process.acknowledge_output(_char_count),
            #[cfg(feature = "desktop")]
            Self::Handoff(process) => process.acknowledge_output(),
        }
    }

    fn loading_mode(&self) -> &'static str {
        match self {
            Self::Default { .. } => "default",
            #[cfg(feature = "desktop")]
            Self::VsCode(_) => "vsCode",
            #[cfg(feature = "desktop")]
            Self::Handoff(_) => "default",
        }
    }
}

#[derive(Clone, Copy)]
enum TerminalOutputBufferMode {
    Default,
    #[cfg(feature = "desktop")]
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

pub(crate) fn log_debug(msg: &str) {
    // 写路径走 require：自定义数据目录不可用时不落日志（不退回默认目录），
    // 但路径解析失败只应发生一次——OnceLock 不缓存 Err，下次调用会重试。
    let log_path = DEBUG_LOG_PATH.get_or_init(|| {
        PathService::get_debug_log_path().unwrap_or_else(|_| std::env::temp_dir().join("terminal-buddy-debug-fallback.log"))
    });
    // 本地时区 + 完整日期：UTC 且无日期的旧格式会把不同天的同刻记录混在一起。
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{}] {}\n", ts, msg);
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .and_then(|mut f| f.write_all(line.as_bytes()));
}

/// 退出码按 Windows 惯例记 16 进制，便于和 NTSTATUS/taskkill 语义对照。
fn format_exit_code(code: Option<u32>) -> String {
    match code {
        Some(code) => format!("{:#x}", code),
        None => "unknown".to_string(),
    }
}

fn spawn_terminal_backend(
    _app: &AppHandle,
    _mode: &TerminalLoadingMode,
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
    if let Some(path) = startup_path {
        if !std::path::Path::new(path).is_dir() {
            return Err(format!(
                "终端启动目录不存在或不可访问：{}。请在连接配置中修正启动路径。",
                path
            ));
        }
    }
    #[cfg(feature = "desktop")]
    if *_mode == TerminalLoadingMode::VsCode {
        let (process, reader) =
            VsCodeTerminalProcess::spawn(_app, rows, cols, startup_path, env_vars)?;
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
    let mut command = CommandBuilder::new(base_shell());
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
                #[cfg(feature = "desktop")]
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
                let desktop_attached = {
                    let mut buffer = output_buffer.lock().unwrap_or_else(|e| e.into_inner());
                    let attached = buffer.push(output.clone());
                    // 与 Web 初始订阅共用缓冲锁，历史快照和实时流不会重叠。
                    let web_state = app.state::<crate::services::WebServiceState>();
                    web_state.broadcast(&terminal_id, &output);
                    attached
                };
                if desktop_attached {
                    let _ = app.emit(&format!("terminal_output_{}", terminal_id), output.clone());
                }
            }

            if disconnected {
                break;
            }
        }
        // PTY exited (SSH disconnect, `exit` command, child crash, etc.).
        // 走统一 teardown：移除实例、关闭 SSH session / Web subscribers / hook token，
        // 并只发一次 terminal-closed 与 session change。若用户已显式关闭，这里返回
        // false，不重复发事件。
        teardown_terminal(&app, &terminal_id, TerminalCloseReason::NaturalExit);
    });
}

/// 统一获取 instances 锁：毒锁时取回内部值，避免 panic 扩散。
fn lock_instances_map(
    instances: &Mutex<HashMap<String, TerminalInstance>>,
) -> std::sync::MutexGuard<'_, HashMap<String, TerminalInstance>> {
    instances.lock().unwrap_or_else(|e| e.into_inner())
}

/// 终端进入 teardown 的原因。仅用于日志与语义区分，不影响清理动作本身。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalCloseReason {
    /// 桌面端主动关闭标签页。
    DesktopClose,
    /// Web 端 `DELETE /api/terminals/{id}`。
    WebClose,
    /// PTY EOF：`exit`、SSH 断线、child crash。
    NaturalExit,
    /// 创建事务失败回滚。
    StartupRollback,
    /// 应用退出。
    AppShutdown,
}

impl TerminalCloseReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::DesktopClose => "desktop-close",
            Self::WebClose => "web-close",
            Self::NaturalExit => "natural-exit",
            Self::StartupRollback => "startup-rollback",
            Self::AppShutdown => "app-shutdown",
        }
    }
}

/// teardown 与创建回滚共用的资源释放原语（不含事件发送）。
/// 必须在 instances 锁外调用：`backend.close()` 会阻塞在 kill/wait 上。
fn release_terminal_resources(
    app: &AppHandle,
    terminal_id: &str,
    backend: Option<TerminalBackend>,
    reason: TerminalCloseReason,
) {
    // hook token + pending decision + 待确认通知卡片，本身幂等。
    ClaudeHookService::unregister_terminal(terminal_id);
    let task_log_dir = crate::services::terminal_task_service::forget_terminal(terminal_id);
    // 终端 Agent 会话接力：真正 teardown 才结束（发 terminal_closed、清镜像/租约/阶段）。
    // phase=ended 不走这里——PTY 仍活着，只读镜像保留。
    crate::services::terminal_agent_relay::on_terminal_closed(terminal_id);
    // 模型终端的临时 --settings 文件与映射条目，幂等（无映射时为 no-op）。
    crate::services::llm_provider_service::cleanup_temp_settings_for_terminal(terminal_id);
    // SSH 终端才有 session，其余为 no-op。
    app.state::<SshSessionService>().close_session(terminal_id);
    // 丢弃 Web 订阅者 → 各 WS 的 recv() 返回 None → 向手机端发送 Exited。
    app.state::<WebServiceState>().close_all(terminal_id);
    let Some(mut backend) = backend else {
        if let Some(dir) = task_log_dir { let _ = fs::remove_dir_all(dir); }
        return;
    };
    let terminal_id = terminal_id.to_string();
    let _cleanup_task = crate::runtime::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let exit_code = backend.close();
        if let Some(dir) = task_log_dir { let _ = fs::remove_dir_all(dir); }
        log_debug(&format!(
            "[teardown] backend closed, id={}, reason={}, exit_code={}, elapsed_ms={}",
            terminal_id,
            reason.as_str(),
            format_exit_code(exit_code),
            started.elapsed().as_millis(),
        ));
    });
}

/// 终端生命周期的唯一出口：显式关闭、Web 关闭、PTY EOF 全部走这里。
///
/// 语义：先从 `instances` 原子移除，只有拿到实例的那一次调用才拥有资源所有权并
/// 发送事件；重复调用返回 `false` 且不做任何事，因此 `terminal-closed` /
/// session change 对每个终端恰好发送一次。
///
/// 可以从 PTY 输出线程调用：阻塞的 kill/wait 被丢到阻塞线程池，本函数不 join
/// 任何线程，不存在自死锁。
pub fn teardown_terminal(app: &AppHandle, terminal_id: &str, reason: TerminalCloseReason) -> bool {
    let service = app.state::<TerminalService>();
    let instance = lock_instances_map(&service.instances).remove(terminal_id);
    let Some(instance) = instance else {
        // 已被其他路径接管（幂等收尾），不重复发事件。
        return false;
    };
    log_debug(&format!(
        "[teardown] start, id={}, reason={}",
        terminal_id,
        reason.as_str()
    ));
    release_terminal_resources(app, terminal_id, Some(instance.backend), reason);
    // 桌面端 removeSession 幂等，但这里也只会收到一次。
    let _ = app.emit("terminal-closed", terminal_id);
    service.notify_sessions_changed();
    // 广播给 App 通知通道：手机端「最近会话」据此实时移除已关闭的 Agent 会话。
    crate::services::AppNotificationService::publish_terminals_changed(
        terminal_id,
        instance.display_name.clone(),
        false,
    );
    true
}

/// 创建事务的回滚守卫：`commit()` 之前 drop 就回滚全部已获取资源。
struct TerminalCreation {
    terminal_id: String,
    /// 仅用于失败日志定位，不含凭据。
    terminal_type: String,
    instances: Arc<Mutex<HashMap<String, TerminalInstance>>>,
    app: AppHandle,
    stage: &'static str,
    hook_registered: bool,
    backend: Option<TerminalBackend>,
    reader: Option<Box<dyn Read + Send>>,
    inserted: bool,
    committed: bool,
}

impl TerminalCreation {
    fn new(
        terminal_id: &str,
        terminal_type: &str,
        instances: Arc<Mutex<HashMap<String, TerminalInstance>>>,
        app: AppHandle,
    ) -> Self {
        Self {
            terminal_id: terminal_id.to_string(),
            terminal_type: terminal_type.to_string(),
            instances,
            app,
            stage: "prepare",
            hook_registered: false,
            backend: None,
            reader: None,
            inserted: false,
            committed: false,
        }
    }

    /// 失败日志统一带上 id / type / 阶段；不得写入 env、token 或凭据。
    fn fail(&self, error: &str) -> String {
        log_debug(&format!(
            "[create] FAILED, id={}, type={}, stage={}, error={}",
            self.terminal_id, self.terminal_type, self.stage, error
        ));
        error.to_string()
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for TerminalCreation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        log_debug(&format!(
            "[teardown] start, id={}, reason={}, stage={}",
            self.terminal_id,
            TerminalCloseReason::StartupRollback.as_str(),
            self.stage
        ));
        // 丢弃 reader（释放 PTY 读端），并取回 backend 的唯一所有权。
        self.reader = None;
        let mut backend = self.backend.take();
        if self.inserted {
            if let Some(instance) = lock_instances_map(&self.instances).remove(&self.terminal_id) {
                backend = Some(instance.backend);
            }
        }
        if !self.hook_registered {
            // hook token 还没注册时不要调用 unregister，避免误清同 id 的其他状态。
            // 但引用展开已登记的临时 --settings 文件必须清理（spawn 失败泄漏）。
            crate::services::llm_provider_service::cleanup_temp_settings_for_terminal(&self.terminal_id);
            if let Some(mut backend) = backend {
                let _ = crate::runtime::async_runtime::spawn_blocking(move || backend.close());
            }
            return;
        }
        release_terminal_resources(
            &self.app,
            &self.terminal_id,
            backend,
            TerminalCloseReason::StartupRollback,
        );
        // 回滚路径不发 terminal-closed / session change：创建成功事件从未发出。
    }
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
    // 把 npm 全局前缀（claude/codex 等 CLI 安装位置）放进终端 PATH：桌面端进程不一定继承安装后的 PATH。
    let mut extra_paths: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        extra_paths.push(home.join(".local/bin"));
    }
    if let Ok(prefix) = std::env::var("NPM_CONFIG_PREFIX") {
        extra_paths.push(PathBuf::from(&prefix).join("bin"));
        extra_paths.push(PathBuf::from(prefix));
    }
    #[cfg(windows)]
    if let Ok(appdata) = std::env::var("APPDATA") {
        extra_paths.push(PathBuf::from(appdata).join("npm"));
    }
    let path_index = env_vars.iter().position(|(name, _)| name.eq_ignore_ascii_case("PATH"));
    let current_path = path_index
        .map(|index| std::ffi::OsString::from(&env_vars[index].1))
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
    let mut parts: Vec<PathBuf> = extra_paths.into_iter().filter(|path| path.is_dir()).collect();
    parts.extend(std::env::split_paths(&current_path));
    if let Ok(path) = std::env::join_paths(parts) {
        let value = path.to_string_lossy().into_owned();
        match path_index {
            Some(index) => env_vars[index].1 = value,
            None => env_vars.push(("PATH".to_string(), value)),
        }
    }
    env_vars
}

/// 一次终端创建事务的全部输入。
///
/// 所有可能失败的解析（`build_init_commands`、`resolve_pwsh_exe` 等）都必须在
/// 构造本结构之前完成，事务内部只剩 spawn backend 与 insert instance 两个
/// 需要回滚的步骤。
struct NewTerminalSpec {
    terminal_id: String,
    profile_id: String,
    display_name: String,
    group_override: Option<String>,
    owner: TerminalOwner,
    creator: TerminalCreator,
    extra_param_tag: Option<String>,
    extra_param_tag_color: Option<String>,
    extra_startup_params: Option<String>,
    extra_startup_mode: Option<String>,
    /// 仅用于失败日志定位，不含凭据。
    terminal_type: String,
    startup_path: Option<String>,
    profile_env: Vec<(String, String)>,
    /// 已解析完成的启动命令，事务内不再有失败点。
    init_commands: Vec<String>,
    init_rows: u16,
    init_cols: u16,
    log_prefix: &'static str,
    boot_prefix: &'static str,
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
    // 广播给 App 通知通道：手机端「开始对话」创建的服务端终端能立刻出现在最近会话列表。
    let display_name = lock_instances_map(&service.instances)
        .get(terminal_id)
        .map(|instance| instance.display_name.clone())
        .unwrap_or_else(|| "服务端终端".to_string());
    crate::services::AppNotificationService::publish_terminals_changed(terminal_id, display_name, true);
}

/// 按终端类型构造启动命令；ssh/docker/k8s 需要 profile 连接参数。
///
/// 这里是命令进入 PTY 前的最后一道关口，不能只依赖保存时的字段校验：
/// `Profiles/*.json` 可能由旧版本写入、被用户手工编辑，或经 `import_all_data`
/// 直接落盘。因此连接字段在此重新走一遍字段级校验 + `quote_cmd_argument`，
/// 最终所有命令行再统一过一次控制字符检查（同时覆盖 `startup_commands` 和
/// `apply_extra_startup_params` 追加的文本）。
fn build_init_commands(
    terminal_type: &str,
    startup_commands: Vec<String>,
    profile: Option<&Profile>,
) -> Result<Vec<String>, String> {
    let commands: Vec<String> = match terminal_type {
        "cmd" if cfg!(windows) => startup_commands,
        "bash" | "sh" | "zsh" => { let mut commands = vec![local_shell_command(terminal_type)]; commands.extend(startup_commands); commands },
        "powershell" => {
            let mut cmds = vec![local_shell_command(default_shell_command())];
            cmds.extend(startup_commands);
            cmds
        }
        "pwsh" => {
            let pwsh = resolve_pwsh_exe()?;
            let mut cmds = vec![local_shell_command(&pwsh)];
            cmds.extend(startup_commands);
            cmds
        }
        "ssh" => {
            let profile =
                profile.ok_or("SSH 连接缺少配置信息，无法启动。请重新选择连接后重试。")?;
            let host = filled_field(&profile.ssh_host)
                .ok_or("SSH 连接未填写主机地址，请在连接配置中补全「主机」后重试。")?;
            validate_ssh_host(host)?;
            let port = profile.ssh_port.unwrap_or(22);
            let auth_type = profile.ssh_auth_type.as_deref().unwrap_or("key");
            let mut cmd = "ssh".to_string();
            if auth_type == "key" {
                if let Some(key_path) = filled_field(&profile.ssh_key_path) {
                    validate_ssh_key_path(key_path)?;
                    cmd.push_str(&format!(
                        " -i {}",
                        quote_cmd_argument("SSH 私钥路径", key_path)?
                    ));
                }
            }
            cmd.push_str(&format!(" -p {}", port));
            // 用户名留空时只写主机：写成 `@host` 会被 ssh 当成「空用户名」而不是「用默认用户」。
            match filled_field(&profile.ssh_user) {
                Some(user) => {
                    validate_ssh_user(user)?;
                    cmd.push_str(&format!(
                        " {}@{}",
                        quote_cmd_argument("SSH 用户名", user)?,
                        quote_cmd_argument("SSH 主机", host)?
                    ));
                }
                None => cmd.push_str(&format!(" {}", quote_cmd_argument("SSH 主机", host)?)),
            }
            vec![cmd]
        }
        "docker" => {
            let container = profile
                .and_then(|p| {
                    filled_field(&p.docker_container_name)
                        .or_else(|| filled_field(&p.docker_container_id))
                })
                .ok_or("Docker 连接未填写容器名或容器 ID，请在连接配置中补全后重试。")?;
            validate_docker_container(container)?;
            vec![format!(
                "docker exec -it {} {}",
                quote_cmd_argument("Docker 容器", container)?, target_shell()
            )]
        }
        "k8s" => {
            let profile = profile
                .ok_or("Kubernetes 连接缺少配置信息，无法启动。请重新选择连接后重试。")?;
            let pod = filled_field(&profile.k8s_pod_name)
                .ok_or("Kubernetes 连接未填写 Pod 名称，请在连接配置中补全后重试。")?;
            validate_k8s_name("Kubernetes Pod", pod)?;
            let mut cmd = "kubectl exec -it".to_string();
            // 命名空间留空时必须整段省略 `-n`，否则 `-n` 会把后面的 pod 名当成自己的值，
            // kubectl 就拿不到 pod 参数了。省略后 kubectl 使用当前 context 的命名空间。
            if let Some(ns) = filled_field(&profile.k8s_namespace) {
                validate_k8s_name("Kubernetes 命名空间", ns)?;
                cmd.push_str(&format!(
                    " -n {}",
                    quote_cmd_argument("Kubernetes 命名空间", ns)?
                ));
            }
            cmd.push_str(&format!(" {}", quote_cmd_argument("Kubernetes Pod", pod)?));
            if let Some(container) = filled_field(&profile.k8s_container_name) {
                validate_k8s_name("Kubernetes 容器", container)?;
                cmd.push_str(&format!(
                    " -c {}",
                    quote_cmd_argument("Kubernetes 容器", container)?
                ));
            }
            cmd.push_str(&format!(" -- {}", target_shell()));
            vec![cmd]
        }
        _ => {
            let mut cmds = vec![local_shell_command(default_shell_command())];
            cmds.extend(startup_commands);
            cmds
        }
    };
    for command in &commands {
        reject_control_chars("启动命令", command)?;
    }
    Ok(commands)
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
            .ok_or_else(|| TerminalAccessError::NotFound.to_string())
    }

    /// 判定某一侧能否对指定终端执行指定操作。REST / WebSocket / Tauri command 一律
    /// 走这里，不允许各自硬编码 owner 比较（权限矩阵见 `models::terminal_access`）。
    pub fn authorize(
        &self,
        id: &str,
        actor: TerminalActor,
        action: TerminalAction,
    ) -> Result<(), TerminalAccessError> {
        let owner = {
            let instances = self.lock_instances();
            instances
                .get(id)
                .map(|instance| instance.owner.clone())
                .ok_or(TerminalAccessError::NotFound)?
        };
        // 每次都读一遍设置：共享开关在运行中被改动后，下一次操作立即生效。
        if is_terminal_action_allowed(
            actor,
            &owner,
            action,
            SettingsService::share_sessions_enabled(),
        ) {
            Ok(())
        } else {
            Err(TerminalAccessError::Denied { actor, action })
        }
    }

    /// 读取终端归属。仅供已经通过 `authorize` 的调用方判断「是否算接管 PC 终端」，
    /// 不要用它自己拼权限判断。
    pub fn terminal_owner(&self, id: &str) -> Option<TerminalOwner> {
        self.lock_instances()
            .get(id)
            .map(|instance| instance.owner.clone())
    }

    /// 更新会话当前目录（前端检测到 cd 后上报）并广播给所有端。
    /// 目录未变化时不广播，避免各端相互上报形成事件风暴。
    pub fn set_session_directory(
        &self,
        app: &AppHandle,
        id: &str,
        directory: &str,
        actor: TerminalActor,
    ) -> Result<(), String> {
        self.authorize(id, actor, TerminalAction::View)
            .map_err(|e| e.to_string())?;
        let directory = directory.trim();
        if directory.is_empty() {
            return Ok(());
        }
        {
            let mut instances = self.lock_instances();
            let Some(instance) = instances.get_mut(id) else {
                return Err("终端已不存在".to_string());
            };
            if instance.current_directory.as_deref() == Some(directory) {
                return Ok(());
            }
            instance.current_directory = Some(directory.to_string());
        }
        // 桌面 Tauri 事件与 /ws/events 广播一次发出；events 通道按 terminalId
        // 复查 View 权限，非共享模式下 Web 端自然收不到 PC 终端的目录变化。
        let _ = app.emit(
            "session-directory-changed",
            serde_json::json!({ "terminalId": id, "directory": directory }),
        );
        crate::services::terminal_task_service::update_cwd(id, directory);
        Ok(())
    }

    /// 构建当前存活终端的列表（供 REST `GET /api/terminals`、Tauri 命令、meta WS 共用）。
    /// 用 ProfileService 补全 profile 元数据。不做权限过滤，调用方按需使用
    /// `list_terminals_info_for`。
    pub fn list_terminals_info(&self) -> Vec<TerminalInfo> {
        struct InstanceSnapshot {
            id: String,
            profile_id: String,
            display_name: String,
            loading_mode: String,
            owner: TerminalOwner,
            creator: TerminalCreator,
            terminal_type: String,
            group_override: Option<String>,
            extra_param_tag: Option<String>,
            extra_param_tag_color: Option<String>,
            extra_startup_params: Option<String>,
            extra_startup_mode: Option<String>,
            current_directory: Option<String>,
        }
        let entries: Vec<InstanceSnapshot> = {
            let instances = self.lock_instances();
            instances
                .values()
                .map(|inst| InstanceSnapshot {
                    id: inst.id.clone(),
                    profile_id: inst.profile_id.clone(),
                    display_name: inst.display_name.clone(),
                    loading_mode: inst.backend.loading_mode().to_string(),
                    owner: inst.owner.clone(),
                    creator: inst.creator,
                    terminal_type: inst.terminal_type.clone(),
                    group_override: inst.group_override.clone(),
                    extra_param_tag: inst.extra_param_tag.clone(),
                    extra_param_tag_color: inst.extra_param_tag_color.clone(),
                    extra_startup_params: inst.extra_startup_params.clone(),
                    extra_startup_mode: inst.extra_startup_mode.clone(),
                    current_directory: inst.current_directory.clone(),
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
                     creator,
                     terminal_type,
                     group_override,
                     extra_param_tag,
                     extra_param_tag_color,
                     extra_startup_params,
                     extra_startup_mode,
                     current_directory,
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
                        // 空白终端没有 profile，类型只能取实例；实例缺值时回退
                        // profile 类型，避免旧行为把空白终端广播成空串。
                        terminal_type: if terminal_type.is_empty() {
                            profile
                                .as_ref()
                                .map(|p| p.terminal_type.clone())
                                .unwrap_or_default()
                        } else {
                            terminal_type
                        },
                        loading_mode,
                        profile_id,
                        owner,
                        creator,
                        extra_param_tag,
                        extra_param_tag_color,
                        extra_startup_params,
                        extra_startup_mode,
                        directory: current_directory,
                    }
                },
            )
            .collect()
    }

    /// 按发起方过滤后的终端列表：非共享模式下 Web 端拿不到 PC-owned terminal，
    /// 直接用已知 id 连 WS 也会被 `authorize` 拦下，两处规则同源。
    pub fn list_terminals_info_for(&self, actor: TerminalActor) -> Vec<TerminalInfo> {
        let share_sessions = SettingsService::share_sessions_enabled();
        self.list_terminals_info()
            .into_iter()
            .filter(|info| {
                is_terminal_action_allowed(actor, &info.owner, TerminalAction::View, share_sessions)
            })
            .collect()
    }

    /// 终端创建的唯一事务入口。
    ///
    /// 任一步失败都由 `TerminalCreation` 守卫回滚：关闭已 spawn 的后端、丢弃
    /// reader、从实例表移除、注销 Claude hook token，并且不发送任何创建成功
    /// 事件。只有全部步骤成功后的 `commit()` 才提交。
    fn spawn_terminal(&self, spec: NewTerminalSpec, app: AppHandle) -> Result<String, String> {
        let NewTerminalSpec {
            terminal_id,
            profile_id,
            display_name,
            group_override,
            owner,
            creator,
            extra_param_tag,
            extra_param_tag_color,
            extra_startup_params,
            extra_startup_mode,
            terminal_type,
            startup_path,
            profile_env,
            init_commands,
            init_rows,
            init_cols,
            log_prefix,
            boot_prefix,
        } = spec;
        let mut creation = TerminalCreation::new(
            &terminal_id,
            &terminal_type,
            self.instances.clone(),
            app.clone(),
        );

        // 注册 hook token 之后就必须由守卫负责注销。
        creation.stage = "register-hook";
        let env_vars = build_terminal_env(&terminal_id, Some(&profile_env));
        creation.hook_registered = true;

        let init_commands = crate::services::terminal_task_service::prepare_launch(
            &terminal_id, &terminal_type, startup_path.as_deref(), &env_vars, init_commands,
        );

        creation.stage = "spawn-backend";
        let loading_mode = SettingsService::get_settings().terminal_loading_mode;
        log_debug(&format!(
            "[{}] spawning, id={}, type={}, path={:?}, commands={}, envs={}",
            log_prefix,
            terminal_id,
            terminal_type,
            startup_path,
            init_commands.len(),
            env_vars.len()
        ));
        let (backend, backend_reader, output_buffer_mode) = spawn_terminal_backend(
            &app,
            &loading_mode,
            init_rows,
            init_cols,
            startup_path.as_deref(),
            &env_vars,
        )
        .map_err(|error| creation.fail(&error))?;
        crate::boot_log(format!("[terminal] backend ready mode={:?}", loading_mode));
        creation.backend = Some(backend);
        creation.reader = Some(backend_reader);

        creation.stage = "insert-instance";
        let output_buffer = Arc::new(Mutex::new(TerminalOutputBuffer::new(init_rows, init_cols)));
        let backend = creation.backend.take().expect("backend 刚刚存入守卫");
        self.insert_instance(TerminalInstance {
            id: terminal_id.clone(),
            profile_id,
            display_name,
            group_override,
            owner,
            creator,
            terminal_type,
            extra_param_tag,
            extra_param_tag_color,
            extra_startup_params,
            extra_startup_mode,
            current_directory: startup_path.clone(),
            backend,
            output_buffer: output_buffer.clone(),
            current_rows: init_rows,
            current_cols: init_cols,
            takeover: Default::default(),
        });
        creation.inserted = true;
        creation.stage = "init-commands";
        schedule_delayed_input(
            self.instances.clone(),
            terminal_id.clone(),
            init_commands,
            log_prefix,
        );

        creation.stage = "start-forwarder";
        let backend_reader = creation.reader.take().expect("reader 刚刚存入守卫");
        finalize_terminal_creation(
            self,
            backend_reader,
            &terminal_id,
            app,
            output_buffer,
            output_buffer_mode,
            log_prefix,
            boot_prefix,
        );
        creation.commit();
        Ok(terminal_id)
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
        creator: TerminalCreator,
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
            .map_or(default_terminal_type(), |p| p.terminal_type.as_str());
        let terminal_type = if !cfg!(windows) && matches!(terminal_type, "powershell" | "cmd") { "bash" } else { terminal_type };
        let profile_startup_path = profile.as_ref().and_then(ProfileService::effective_startup_path);
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
        // 引用展开（apply 后 / build 前）：`__TB_CLAUDE_REF__` 开头的命令在这里
        // 生成一次性临时 --settings 文件并替换为新路径。不含引用的命令原样返回。
        // 展开失败即拒绝启动，并清理本 terminal_id 已登记的临时文件。
        let startup_commands = match crate::services::llm_provider_service::expand_claude_refs_in_commands(
            startup_commands,
            &terminal_id,
        ) {
            Ok(commands) => commands,
            Err(error) => {
                crate::services::llm_provider_service::cleanup_temp_settings_for_terminal(&terminal_id);
                log_debug(&format!(
                    "[create] FAILED, id={}, type={}, stage=expand-claude-ref, error={}",
                    terminal_id, terminal_type, error
                ));
                return Err(error);
            }
        };
        let profile_env: Vec<(String, String)> = profile
            .as_ref()
            .map(|p| {
                p.environment_variables
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        crate::boot_log(format!(
            "[create_terminal] start type={} profile={}",
            terminal_type, profile_id
        ));
        let (init_rows, init_cols) = resolve_terminal_size(initial_rows, initial_cols);
        // 先把可能失败的启动命令构造做完，再进入创建事务：失败时不存在已 spawn
        // 的 PTY 或已插入的实例需要回滚。
        let init_commands = build_init_commands(terminal_type, startup_commands, profile.as_ref())
            .map_err(|error| {
                log_debug(&format!(
                    "[create] FAILED, id={}, type={}, stage=build-init-commands, error={}",
                    terminal_id, terminal_type, error
                ));
                error
            })?;

        self.spawn_terminal(
            NewTerminalSpec {
                terminal_id,
                profile_id: profile_id.to_string(),
                display_name,
                group_override: None,
                owner,
                creator,
                extra_param_tag: extra_param_tag.map(str::to_string),
                extra_param_tag_color: extra_param_tag_color.map(str::to_string),
                extra_startup_params: extra_startup_params.map(str::to_string),
                extra_startup_mode: extra_startup_mode.map(str::to_string),
                terminal_type: terminal_type.to_string(),
                startup_path,
                profile_env,
                init_commands,
                init_rows,
                init_cols,
                log_prefix: "create",
                boot_prefix: "create_terminal",
            },
            app,
        )
    }

    pub fn write_to_terminal(
        &self,
        id: &str,
        data: &str,
        actor: TerminalActor,
    ) -> Result<(), String> {
        self.authorize(id, actor, TerminalAction::Input)
            .map_err(|error| error.to_string())?;
        let mut instances = self.lock_instances();
        instances
            .get_mut(id)
            .ok_or_else(|| TerminalAccessError::NotFound.to_string())?
            .backend
            .write_input(data.as_bytes())?;
        drop(instances);
        Ok(())
    }

    pub fn update_terminal_display_name(
        &self,
        id: &str,
        display_name: &str,
        actor: TerminalActor,
    ) -> Result<(), String> {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err("终端名称不能为空".to_string());
        }
        self.authorize(id, actor, TerminalAction::RenameMetadata)
            .map_err(|error| error.to_string())?;

        let changed = {
            let mut instances = self.lock_instances();
            let instance = instances
                .get_mut(id)
                .ok_or_else(|| TerminalAccessError::NotFound.to_string())?;
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
        actor: TerminalActor,
    ) -> Result<(), String> {
        self.authorize(id, actor, TerminalAction::Resize)
            .map_err(|error| error.to_string())?;
        // 与 web/ws.rs 的 Resize 处理对齐：clamp 到 1..=500，避免 0 或异常尺寸
        // 传入 ConPTY 触发底层异常（前端在布局过渡帧可能短暂算出 0）。
        let rows = rows.clamp(1, 500);
        let cols = cols.clamp(1, 500);
        let mut instances = self.lock_instances();
        let instance = instances
            .get_mut(id)
            .ok_or_else(|| TerminalAccessError::NotFound.to_string())?;
        let requested = crate::models::TerminalSize::new(rows, cols);
        if instance.takeover.desktop_resize(requested).is_none() {
            return Ok(());
        }
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
        instance.resize_viewport(crate::models::TerminalSize::new(new_rows, new_cols), None)
    }

    /// 手机连接在首次 resize 时取得尺寸控制权；电脑连接只登记恢复尺寸。
    pub fn resize_web_terminal(
        &self, app: &AppHandle, id: &str, connection: &str,
        rows: u16, cols: u16, mobile: bool,
    ) -> Result<(), String> {
        if !mobile {
            return self.resize_terminal(id, rows, cols, true, TerminalActor::Web);
        }
        self.authorize(id, TerminalActor::Web, TerminalAction::Resize)
            .map_err(|error| error.to_string())?;
        let mut instances = self.lock_instances();
        let instance = instances.get_mut(id).ok_or_else(|| TerminalAccessError::NotFound.to_string())?;
        let size = crate::models::TerminalSize::new(rows, cols);
        let current = crate::models::TerminalSize::new(instance.current_rows, instance.current_cols);
        let mut takeover = instance.takeover.clone();
        takeover.mobile_resize(connection, size, current);
        instance.resize_viewport(size, Some((crate::models::TerminalViewport { size, takeover: true }, app)))?;
        instance.takeover = takeover;
        Ok(())
    }

    /// 与普通输出订阅数量无关：电脑仍在查看时，最后一个手机离开也必须恢复。
    pub fn release_web_takeover(&self, app: &AppHandle, id: &str, connection: &str) {
        let mut instances = self.lock_instances();
        let Some(instance) = instances.get_mut(id) else { return; };
        let Some(viewport) = instance.takeover.release(connection) else { return; };
        if let Err(error) = instance.resize_viewport(viewport.size, Some((viewport, app))) {
            eprintln!("[terminal] Failed to restore viewport for {}: {}", id, error);
        }
    }

    /// 渲染流控回执。属于只读查看链路，因此按 `View` 授权：
    /// 非共享模式下桌面端仍可只读观察 Web 终端，不能因为拿不到回执而卡住渲染。
    pub fn acknowledge_terminal_output(
        &self,
        id: &str,
        char_count: u32,
        actor: TerminalActor,
    ) -> Result<(), String> {
        self.authorize(id, actor, TerminalAction::View)
            .map_err(|error| error.to_string())?;
        let mut instances = self.lock_instances();
        instances
            .get_mut(id)
            .ok_or_else(|| TerminalAccessError::NotFound.to_string())?
            .backend
            .acknowledge_output(char_count)
    }

    pub fn terminal_loading_mode(
        &self,
        id: &str,
        actor: TerminalActor,
    ) -> Result<&'static str, String> {
        self.authorize(id, actor, TerminalAction::View)
            .map_err(|error| error.to_string())?;
        let instances = self.lock_instances();
        let instance = instances
            .get(id)
            .ok_or_else(|| TerminalAccessError::NotFound.to_string())?;
        Ok(instance.backend.loading_mode())
    }

    pub fn drain_terminal_output(&self, id: &str, actor: TerminalActor) -> Result<String, String> {
        self.authorize(id, actor, TerminalAction::View)
            .map_err(|error| error.to_string())?;
        let buf_arc = self.output_buffer_arc(id)?;
        let mut buffer = buf_arc.lock().unwrap_or_else(|e| e.into_inner());
        // This command is the desktop attachment handshake: the lock makes the
        // returned startup snapshot and all later live events mutually exclusive.
        Ok(buffer.snapshot_and_attach())
    }

    pub fn peek_terminal_output(&self, id: &str, actor: TerminalActor) -> Result<String, String> {
        self.authorize(id, actor, TerminalAction::View)
            .map_err(|error| error.to_string())?;
        let buf_arc = self.output_buffer_arc(id)?;
        let buffer = buf_arc.lock().unwrap_or_else(|e| e.into_inner());
        Ok(buffer.collect())
    }

    pub fn subscribe_web_output(
        &self, id: &str, web: &WebServiceState, limit: usize,
    ) -> Result<Option<(String, tokio::sync::mpsc::UnboundedReceiver<crate::services::web_service::WebTerminalEvent>, Vec<TerminalReplayFrame>, crate::models::TerminalViewport)>, TerminalAccessError> {
        self.authorize(id, TerminalActor::Web, TerminalAction::View)?;
        let instances = self.lock_instances();
        let instance = instances.get(id).ok_or(TerminalAccessError::NotFound)?;
        let buffer = instance.output_buffer.lock().unwrap_or_else(|e| e.into_inner());
        let viewport = instance.takeover.viewport(crate::models::TerminalSize::new(instance.current_rows, instance.current_cols));
        Ok(web.subscribe_within_limit(id, limit).map(|(subscription, receiver)| (subscription, receiver, buffer.replay_frames(), viewport)))
    }

    /// 关闭终端的唯一入口（含授权）。成功后由 `teardown_terminal` 释放资源，
    /// 并对每个终端恰好发送一次 `terminal-closed` 与 session change。
    ///
    /// `NotFound` 的呈现由调用方决定：桌面端视为幂等成功，REST 映射为 404。
    pub fn close_terminal(
        &self,
        app: &AppHandle,
        id: &str,
        actor: TerminalActor,
        reason: TerminalCloseReason,
    ) -> Result<(), TerminalAccessError> {
        self.authorize(id, actor, TerminalAction::Close)?;
        // teardown 幂等：并发的自然退出可能已经先收尾，那同样算关闭成功。
        teardown_terminal(app, id, reason);
        Ok(())
    }

    /// 应用退出：原子取走全部实例，随后在锁外只发终止信号而不 wait，
    /// 保证退出流程不会被 `child.wait()` 阻塞。
    ///
    /// 窗口即将销毁，因此不发送 `terminal-closed` / session change。
    pub fn shutdown_all_terminals(&self, app: &AppHandle) {
        let instances: Vec<TerminalInstance> = {
            let mut map = self.lock_instances();
            map.drain().map(|(_, instance)| instance).collect()
        };
        if instances.is_empty() {
            return;
        }
        log_debug(&format!(
            "[teardown] start, count={}, reason={}",
            instances.len(),
            TerminalCloseReason::AppShutdown.as_str()
        ));
        let web_state = app.state::<WebServiceState>();
        let ssh_service = app.state::<SshSessionService>();
        for mut instance in instances {
            ClaudeHookService::unregister_terminal(&instance.id);
            crate::services::llm_provider_service::cleanup_temp_settings_for_terminal(&instance.id);
            ssh_service.close_session(&instance.id);
            web_state.close_all(&instance.id);
            instance.backend.kill_without_wait();
        }
    }

    pub fn create_blank_terminal(
        &self,
        terminal_type: &str,
        display_name: Option<&str>,
        group_override: Option<&str>,
        initial_rows: u16,
        initial_cols: u16,
        startup_path: Option<&str>,
        // 排在 shell 启动命令之后、同一批次写入的额外命令（如 `claude --resume`）。
        initial_command: Option<&str>,
        extra_param_tag: Option<&str>,
        extra_param_tag_color: Option<&str>,
        app: AppHandle,
        owner: TerminalOwner,
        creator: TerminalCreator,
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
            "bash" => "bash",
            "sh" => "sh",
            "zsh" => "zsh",
            "cmd" if cfg!(windows) => "cmd",
            "powershell" => "powershell",
            "pwsh" => "pwsh",
            _ => default_terminal_type(),
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
        // For "cmd" type: cmd.exe is already the base shell, no command needed.
        // For "powershell" type: start powershell.exe (Windows PowerShell 5.x).
        // For "pwsh" type: need to start pwsh.exe (PowerShell 7.x) — 定位可能失败，
        // 因此必须在进入创建事务之前完成，避免回滚已 spawn 的 PTY。
        let mut init_commands = match effective_type {
            "cmd" => Vec::new(),
            "bash" | "sh" | "zsh" => vec![local_shell_command(effective_type)],
            "pwsh" => vec![resolve_pwsh_exe().map_err(|error| {
                log_debug(&format!(
                    "[create-blank] FAILED, id={}, type={}, stage=resolve-pwsh, error={}",
                    terminal_id, effective_type, error
                ));
                error
            })?],
            _ => vec![local_shell_command(default_shell_command())],
        };
        // 额外命令与 shell 启动命令走同一批次延迟写入：单独 writeToTerminal 会抢在
        // powershell.exe 之前落到 cmd 基座上，等 TUI 接管后残余文本就打进输入框了。
        if let Some(command) = initial_command
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            // 引用展开先于校验：展开后的最终命令再过 reject，防注入。
            let command = match crate::services::llm_provider_service::expand_leading_claude_ref(
                command,
                &terminal_id,
            ) {
                Ok(expanded) => expanded,
                Err(error) => {
                    crate::services::llm_provider_service::cleanup_temp_settings_for_terminal(&terminal_id);
                    log_debug(&format!(
                        "[create-blank] FAILED, id={}, type={}, stage=expand-claude-ref, error={}",
                        terminal_id, effective_type, error
                    ));
                    return Err(error);
                }
            };
            reject_control_chars("启动命令", &command)?;
            init_commands.push(command);
        }

        self.spawn_terminal(
            NewTerminalSpec {
                terminal_id,
                profile_id: String::new(),
                display_name,
                group_override: group_override
                    .map(str::trim)
                    .filter(|group| !group.is_empty())
                    .map(str::to_string),
                owner,
                creator,
                extra_param_tag: extra_param_tag.map(str::to_string),
                extra_param_tag_color: extra_param_tag_color.map(str::to_string),
                // 保留原始启动命令，摘要生成前及刷新页面后也能识别工具和模型。
                extra_startup_params: initial_command
                    .map(str::trim)
                    .filter(|command| !command.is_empty())
                    .map(str::to_string),
                extra_startup_mode: initial_command
                    .filter(|command| !command.trim().is_empty())
                    .map(|_| "independent".to_string()),
                terminal_type: effective_type.to_string(),
                startup_path,
                profile_env: Vec::new(),
                init_commands,
                init_rows,
                init_cols,
                log_prefix: "create-blank",
                boot_prefix: "create_blank_terminal",
            },
            app,
        )
    }

    /// 默认终端 handoff 会话的唯一创建入口（`EstablishPtyHandoff` 回调进）。
    ///
    /// 后端管道/句柄已就绪，无 profile、无 init_commands、不注册 Claude hook
    /// （客户端不是我们 spawn 的）。创建路径只剩 insert + 起转发，无 spawn 失败点，
    /// 不再走 `TerminalCreation` 守卫。
    #[cfg(feature = "desktop")]
    pub fn create_handoff_terminal(
        &self,
        handoff: HandoffPty,
        reader: Box<dyn Read + Send>,
        display_name: &str,
        init_rows: u16,
        init_cols: u16,
        app: AppHandle,
    ) -> Result<String, String> {
        let terminal_id = Uuid::new_v4().to_string();
        log_debug(&format!(
            "[create-handoff] start, id={}, name={}, size={}x{}",
            terminal_id, display_name, init_cols, init_rows
        ));
        let output_buffer = Arc::new(Mutex::new(TerminalOutputBuffer::new(init_rows, init_cols)));
        crate::services::terminal_task_service::prepare_launch(
            &terminal_id, default_terminal_type(), None, &[], Vec::new(),
        );
        self.insert_instance(TerminalInstance {
            id: terminal_id.clone(),
            profile_id: String::new(),
            display_name: display_name.to_string(),
            group_override: None,
            owner: TerminalOwner::Pc,
            creator: TerminalCreator::Desktop,
            // handoff 的基座是 cmd.exe，与下方 terminal-created 事件的 "cmd" 一致
            terminal_type: "cmd".to_string(),
            extra_param_tag: None,
            extra_param_tag_color: None,
            extra_startup_params: None,
            extra_startup_mode: None,
            // handoff 会话接管的是外部已运行的终端，无从得知其目录，等前端 cd 检测后上报。
            current_directory: None,
            backend: TerminalBackend::Handoff(handoff),
            output_buffer: output_buffer.clone(),
            current_rows: init_rows,
            current_cols: init_cols,
            takeover: Default::default(),
        });
        finalize_terminal_creation(
            self,
            reader,
            &terminal_id,
            app.clone(),
            output_buffer,
            TerminalOutputBufferMode::Default,
            "create-handoff",
            "create_handoff_terminal",
        );
        // 唤起主窗口：双击 bat 等场景下窗口可能最小化、藏在托盘或被压在后台，
        // handoff 是用户刚发起的本地动作，必须把窗口带到前台，否则 bat 会在
        // 看不见的会话里跑（冷启动路径由 page load 后的 reveal_main_window 兜底）。
        crate::show_main_window(&app);
        // 通知前端建 tab 并激活（activate=true：handoff 是用户刚发起的本地动作，
        // 与 Web 端建终端「不抢焦点」的行为区分开）。
        let _ = app.emit(
            "terminal-created",
            serde_json::json!({
                "id": terminal_id,
                "profileId": "",
                "profileName": display_name,
                "terminalType": "cmd",
                "owner": "pc",
                "activate": true,
            }),
        );
        Ok(terminal_id)
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
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
    crate::runtime::async_runtime::spawn_blocking(move || {
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
            TerminalCreator::Desktop,
        )
    })
    .await
    .map_err(|error| format!("终端后台启动失败：{}", error))?
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn update_terminal_display_name(
    id: String,
    display_name: String,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.update_terminal_display_name(&id, &display_name, TerminalActor::Pc)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn write_to_terminal(
    id: String,
    data: String,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.write_to_terminal(&id, &data, TerminalActor::Pc)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn resize_terminal(
    id: String,
    rows: u16,
    cols: u16,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    // 是否接管由手机连接控制，普通网页查看不能阻止桌面调整尺寸。
    terminal_service.resize_terminal(&id, rows, cols, true, TerminalActor::Pc)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn acknowledge_terminal_output(
    id: String,
    char_count: u32,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.acknowledge_terminal_output(&id, char_count, TerminalActor::Pc)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_terminal_loading_mode(
    id: String,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    terminal_service
        .terminal_loading_mode(&id, TerminalActor::Pc)
        .map(str::to_string)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn close_terminal(
    id: String,
    app: AppHandle,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    match terminal_service.close_terminal(
        &app,
        &id,
        TerminalActor::Pc,
        TerminalCloseReason::DesktopClose,
    ) {
        // 关闭幂等：终端可能刚好自然退出，桌面端不需要看到错误。
        Ok(()) | Err(TerminalAccessError::NotFound) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn report_session_directory(
    id: String,
    directory: String,
    app: AppHandle,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.set_session_directory(&app, &id, &directory, TerminalActor::Pc)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn drain_terminal_output(
    id: String,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    terminal_service.drain_terminal_output(&id, TerminalActor::Pc)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn peek_terminal_output(
    id: String,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    terminal_service.peek_terminal_output(&id, TerminalActor::Pc)
}

/// 列出桌面端可见的存活终端（含 profile 元数据）。非共享模式下也能只读看到
/// Web 端创建的终端，写操作由 `authorize` 单独拦截。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn list_terminals(
    terminal_service: State<TerminalService>,
) -> Result<Vec<TerminalInfo>, String> {
    Ok(terminal_service.list_terminals_info_for(TerminalActor::Pc))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn start_blank_terminal(
    terminal_type: String,
    display_name: Option<String>,
    initial_rows: u16,
    initial_cols: u16,
    startup_path: Option<String>,
    initial_command: Option<String>,
    extra_param_tag: Option<String>,
    extra_param_tag_color: Option<String>,
    // 项目启动的空白终端需要把项目名写入后端分组，容器重启恢复后
    // 手机端 `GET /terminals` 才能继续按项目分组展示。
    group_override: Option<String>,
    app: AppHandle,
    terminal_service: State<'_, TerminalService>,
) -> Result<String, String> {
    let terminal_service = terminal_service.inner().clone();
    crate::runtime::async_runtime::spawn_blocking(move || {
        terminal_service.create_blank_terminal(
            &terminal_type,
            display_name.as_deref(),
            group_override.as_deref(),
            initial_rows,
            initial_cols,
            startup_path.as_deref(),
            initial_command.as_deref(),
            extra_param_tag.as_deref(),
            extra_param_tag_color.as_deref(),
            app,
            TerminalOwner::Pc,
            TerminalCreator::Desktop,
        )
    })
    .await
    .map_err(|error| format!("终端后台启动失败：{}", error))?
}


#[cfg(test)]
mod replay_tests {
    use super::*;

    #[test]
    fn history_preserves_grid_changes_and_coalesces_adjacent_output() {
        let mut buffer = TerminalOutputBuffer::new(30, 120);
        buffer.push(Arc::from("wide "));
        buffer.push(Arc::from("screen"));
        buffer.rows = 35;
        buffer.cols = 45;
        buffer.push(Arc::from("phone"));
        buffer.rows = 30;
        buffer.cols = 120;
        buffer.push(Arc::from("desktop again"));
        let frames = buffer.replay_frames();
        assert_eq!(frames.len(), 3);
        assert_eq!((&*frames[0].data, frames[0].rows, frames[0].cols), ("wide screen", 30, 120));
        assert_eq!((&*frames[1].data, frames[1].rows, frames[1].cols), ("phone", 35, 45));
        assert_eq!((&*frames[2].data, frames[2].rows, frames[2].cols), ("desktop again", 30, 120));
        // 旧协议和桌面端依旧得到原始输出，快照不受后续追加影响。
        assert_eq!(buffer.snapshot_and_attach(), "wide screenphonedesktop again");
        buffer.push(Arc::from("new output"));
        assert_eq!(frames[2].data, "desktop again");
    }

    #[test]
    fn bounded_history_retains_dimensions_of_remaining_chunks() {
        let mut buffer = TerminalOutputBuffer::new(30, 120);
        buffer.push(Arc::from("old wide screen"));
        buffer.rows = 35;
        buffer.cols = 45;
        for _ in 0..TERMINAL_OUTPUT_BUFFER_MAX_CHUNKS {
            buffer.push(Arc::from("x"));
        }
        let frames = buffer.replay_frames();
        assert_eq!(frames.len(), 1);
        assert_eq!((frames[0].rows, frames[0].cols), (35, 45));
        assert_eq!(frames[0].data.len(), TERMINAL_OUTPUT_BUFFER_MAX_CHUNKS);
        assert_eq!(buffer.bytes, TERMINAL_OUTPUT_BUFFER_MAX_CHUNKS);
    }
}
