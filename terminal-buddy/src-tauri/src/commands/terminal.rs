use tauri::{command, AppHandle, State, Emitter};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use std::io::{Read, Write};
use uuid::Uuid;
use portable_pty::{native_pty_system, CommandBuilder, PtySize, Child, MasterPty};
use std::thread;
use std::fs;
use crate::services::ProfileService;

pub struct TerminalInstance {
    pub id: String,
    pub child: Box<dyn Child + Send + Sync>,
    pub writer: Option<Box<dyn Write + Send>>,
    pub master: Box<dyn MasterPty + Send>,
}

pub struct TerminalService {
    instances: Arc<Mutex<HashMap<String, TerminalInstance>>>,
}

fn log_debug(msg: &str) {
    let log_path = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("TerminalBuddy")
        .join("debug.log");
    let _ = fs::create_dir_all(log_path.parent().unwrap());
    let ts = chrono::Utc::now().format("%H:%M:%S%.3f");
    let line = format!("[{}] {}\n", ts, msg);
    let _ = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .and_then(|mut f| f.write_all(line.as_bytes()));
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

    pub fn create_terminal(&self, profile_id: &str, app: AppHandle) -> Result<String, String> {
        let terminal_id = Uuid::new_v4().to_string();
        log_debug(&format!("[create] start, id={}, profile_id={}", terminal_id, profile_id));

        // Load profile settings
        let profile = ProfileService::get_profile(profile_id).ok();
        let is_cmd = profile.as_ref().map_or(false, |p| p.terminal_type == "cmd");
        let startup_path = profile.as_ref().and_then(|p| {
            if p.startup_path.is_empty() { None } else { Some(p.startup_path.clone()) }
        });
        let startup_commands: Vec<String> = profile.as_ref()
            .map(|p| p.startup_commands.clone())
            .unwrap_or_default();
        let env_vars: Vec<(String, String)> = profile.as_ref()
            .map(|p| p.environment_variables.iter().map(|(k,v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();

        log_debug(&format!("[create] is_cmd={}, path={:?}, commands={}, envs={}",
            is_cmd, startup_path, startup_commands.len(), env_vars.len()));

        let pty_system = native_pty_system();

        let pty_pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
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

        let instance = TerminalInstance {
            id: terminal_id.clone(),
            child,
            writer: Some(writer),
            master: pty_pair.master,
        };

        {
            let mut instances = self.instances.lock().unwrap();
            instances.insert(terminal_id.clone(), instance);
        }

        // Build the sequence of commands to send after shell starts
        // For PowerShell profiles: first launch powershell, then send startup commands
        // For CMD profiles: send startup commands directly
        let init_commands = if !is_cmd {
            let mut cmds = vec!["powershell.exe".to_string()];
            cmds.extend(startup_commands);
            cmds
        } else {
            startup_commands
        };

        if !init_commands.is_empty() {
            let tid = terminal_id.clone();
            let commands = init_commands;
            let instances = self.instances.clone();

            thread::spawn(move || {
                // Wait for cmd.exe to initialize
                thread::sleep(std::time::Duration::from_millis(300));
                log_debug(&format!("[init-cmds] sending {} commands for {}", commands.len(), tid));

                let mut instances_lock = instances.lock().unwrap();
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
        let tid = terminal_id.clone();
        let app_clone = app.clone();

        thread::spawn(move || {
            let mut reader = master_reader;
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let output = String::from_utf8_lossy(&buf[..n]).to_string();
                        if !output.is_empty() {
                            let _ = app_clone.emit(&format!("terminal_output_{}", tid), output);
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        log_debug(&format!("[create] DONE, id={}", terminal_id));
        Ok(terminal_id)
    }

    pub fn write_to_terminal(&self, id: &str, data: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap();
        if let Some(instance) = instances.get_mut(id) {
            if let Some(ref mut writer) = instance.writer {
                writer.write_all(data.as_bytes())
                    .map_err(|e| format!("Write failed: {}", e))?;
                writer.flush()
                    .map_err(|e| format!("Flush failed: {}", e))?;
                Ok(())
            } else {
                Err("Terminal writer not available".to_string())
            }
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn resize_terminal(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap();
        if let Some(instance) = instances.get_mut(id) {
            instance.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            }).map_err(|e| format!("Resize failed: {}", e))?;
            log_debug(&format!("[resize] id={} rows={} cols={}", id, rows, cols));
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn close_terminal(&self, id: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap();
        if let Some(mut instance) = instances.remove(id) {
            instance.writer = None;
            instance.child.kill().ok();
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn create_blank_terminal(&self, terminal_type: &str, app: AppHandle) -> Result<String, String> {
        let terminal_id = Uuid::new_v4().to_string();
        log_debug(&format!("[create-blank] start, id={}, type={}", terminal_id, terminal_type));

        let is_cmd = terminal_type == "cmd";
        let pty_system = native_pty_system();

        let pty_pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
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

        let instance = TerminalInstance {
            id: terminal_id.clone(),
            child,
            writer: Some(writer),
            master: pty_pair.master,
        };

        {
            let mut instances = self.instances.lock().unwrap();
            instances.insert(terminal_id.clone(), instance);
        }

        // Launch the actual shell
        let shell_cmd = if is_cmd { "cmd.exe".to_string() } else { "powershell.exe".to_string() };
        let tid = terminal_id.clone();
        let instances = self.instances.clone();

        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_millis(300));
            log_debug(&format!("[init-blank] sending shell command for {}", tid));

            let mut instances_lock = instances.lock().unwrap();
            if let Some(instance) = instances_lock.get_mut(&tid) {
                if let Some(ref mut writer) = instance.writer {
                    let _ = writer.write_all(shell_cmd.as_bytes());
                    let _ = writer.write_all(b"\r");
                    let _ = writer.flush();
                }
            }
        });

        // Output forwarding thread
        let tid = terminal_id.clone();
        let app_clone = app.clone();

        thread::spawn(move || {
            let mut reader = master_reader;
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let output = String::from_utf8_lossy(&buf[..n]).to_string();
                        if !output.is_empty() {
                            let _ = app_clone.emit(&format!("terminal_output_{}", tid), output);
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        log_debug(&format!("[create-blank] DONE, id={}", terminal_id));
        Ok(terminal_id)
    }
}

#[command]
pub fn start_terminal(
    profile_id: String,
    app: AppHandle,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    terminal_service.create_terminal(&profile_id, app)
}

#[command]
pub fn write_to_terminal(
    id: String,
    data: String,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.write_to_terminal(&id, &data)
}

#[command]
pub fn resize_terminal(
    id: String,
    rows: u16,
    cols: u16,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.resize_terminal(&id, rows, cols)
}

#[command]
pub fn close_terminal(
    id: String,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.close_terminal(&id)
}

#[command]
pub fn start_blank_terminal(
    terminal_type: String,
    app: AppHandle,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    terminal_service.create_blank_terminal(&terminal_type, app)
}