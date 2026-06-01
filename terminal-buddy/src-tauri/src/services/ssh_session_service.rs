use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ssh2::Session;
use tauri::{AppHandle, Emitter};

use crate::models::profile::Profile;
use crate::models::ssh_types::{RemoteFileEntry, TransferProgress, TransferError};

fn connect_ssh(profile: &Profile) -> Result<(Session, ssh2::Sftp), String> {
    let host = profile.ssh_host.as_ref().ok_or("SSH host not set")?;
    let port = profile.ssh_port.unwrap_or(22);
    let user = profile.ssh_user.as_ref().ok_or("SSH user not set")?;

    let tcp = std::net::TcpStream::connect(format!("{}:{}", host, port))
        .map_err(|e| format!("TCP connection failed: {}", e))?;

    let mut session = Session::new()
        .map_err(|e| format!("Session creation failed: {}", e))?;
    session.set_tcp_stream(tcp);
    session.handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    match profile.ssh_auth_type.as_deref() {
        Some("key") => {
            let key_path = profile.ssh_key_path.as_ref()
                .ok_or("SSH key path not set")?;
            session.userauth_pubkey_file(user, None, Path::new(key_path), None)
                .map_err(|e| format!("Key auth failed: {}", e))?;
        }
        Some("password") => {
            let password = profile.ssh_password.as_deref()
                .ok_or("SSH password not set")?;
            session.userauth_password(user, password)
                .map_err(|e| format!("Password auth failed: {}", e))?;
        }
        _ => {
            if session.userauth_agent(user).is_err() {
                return Err("Agent authentication failed".to_string());
            }
        }
    }

    if !session.authenticated() {
        return Err("SSH authentication failed".to_string());
    }

    let sftp = session.sftp()
        .map_err(|e| format!("SFTP subsystem failed: {}", e))?;

    Ok((session, sftp))
}

pub struct SshSession {
    pub session: Session,
    pub sftp: ssh2::Sftp,
}

pub struct SshSessionService {
    sessions: Mutex<HashMap<String, Arc<Mutex<SshSession>>>>,
}

impl SshSessionService {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn get_or_create_session(
        &self,
        terminal_id: &str,
        profile: &Profile,
    ) -> Result<(), String> {
        // Check if session already exists (fast path, no network I/O)
        {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if sessions.contains_key(terminal_id) {
                return Ok(());
            }
        }

        // Not found — create new connection outside the lock.
        let (session, sftp) = connect_ssh(profile)?;

        // Double-check: another thread might have created it while we were connecting
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(terminal_id) {
            drop(sftp);
            drop(session);
            return Ok(());
        }
        sessions.insert(terminal_id.to_string(), Arc::new(Mutex::new(SshSession { session, sftp })));
        Ok(())
    }

    fn with_session<F, R>(&self, terminal_id: &str, f: F) -> Result<R, String>
    where
        F: FnOnce(&Mutex<SshSession>) -> Result<R, String>,
    {
        let arc = self.get_session_arc(terminal_id)?;
        f(&arc)
    }

    fn get_session_arc(&self, terminal_id: &str) -> Result<Arc<Mutex<SshSession>>, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(terminal_id).cloned().ok_or("SSH session not found".to_string())
    }

    pub fn list_dir(&self, terminal_id: &str, path: &str) -> Result<Vec<RemoteFileEntry>, String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;

            let entries = session.sftp.readdir(Path::new(path))
                .map_err(|e| format!("readdir failed: {}", e))?;

            let mut result: Vec<RemoteFileEntry> = entries
                .iter()
                .map(|(path_buf, stat)| {
                    let name = path_buf
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    RemoteFileEntry {
                        name,
                        path: path_buf.to_string_lossy().to_string(),
                        is_dir: stat.is_dir(),
                        size: stat.size.unwrap_or(0),
                        permissions: stat.perm.unwrap_or(0),
                        modified: stat.mtime.unwrap_or(0) as i64,
                        owner: stat.uid.map(|u| u.to_string()).unwrap_or_default(),
                        group: stat.gid.map(|g| g.to_string()).unwrap_or_default(),
                    }
                })
                .collect();

            result.sort_by(|a, b| {
                b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });

            Ok(result)
        })
    }

    pub fn mkdir(&self, terminal_id: &str, path: &str) -> Result<(), String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;
            session.sftp.mkdir(Path::new(path), 0o755)
                .map_err(|e| format!("mkdir failed: {}", e))
        })
    }

    pub fn remove(&self, terminal_id: &str, path: &str, is_dir: bool) -> Result<(), String> {
        if is_dir {
            self.exec(terminal_id, &format!("rm -rf '{}'", path.replace('\'', "'\\''")))?;
        } else {
            self.with_session(terminal_id, |session_mutex| {
                let session = session_mutex.lock().map_err(|e| e.to_string())?;
                session.sftp.unlink(Path::new(path))
                    .map_err(|e| format!("unlink failed: {}", e))
            })?;
        }
        Ok(())
    }

    pub fn rename(&self, terminal_id: &str, from: &str, to: &str) -> Result<(), String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;
            session.sftp.rename(Path::new(from), Path::new(to), None)
                .map_err(|e| format!("rename failed: {}", e))
        })
    }

    pub fn chmod(&self, terminal_id: &str, path: &str, mode: i32) -> Result<(), String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;
            let mut stat = session.sftp.stat(Path::new(path))
                .map_err(|e| format!("stat failed: {}", e))?;
            stat.perm = Some(mode as u32);
            session.sftp.setstat(Path::new(path), stat)
                .map_err(|e| format!("chmod failed: {}", e))
        })
    }

    pub fn upload(
        &self,
        terminal_id: &str,
        local_path: &str,
        remote_path: &str,
        app: &AppHandle,
    ) -> Result<(), String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;

            let mut local_file = std::fs::File::open(local_path)
                .map_err(|e| format!("Failed to open local file: {}", e))?;
            let metadata = local_file.metadata()
                .map_err(|e| e.to_string())?;
            let total = metadata.len();

            let mut remote_file = session.sftp.open_mode(
                Path::new(remote_path),
                ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::TRUNCATE,
                0o644,
                ssh2::OpenType::File,
            ).map_err(|e| format!("Failed to open remote file: {}", e))?;

            let mut buf = [0u8; 131072];
            let mut transferred: u64 = 0;
            let mut last_emit = Instant::now();
            loop {
                let n = local_file.read(&mut buf)
                    .map_err(|e| format!("Read error: {}", e))?;
                if n == 0 { break; }
                remote_file.write(&buf[..n])
                    .map_err(|e| format!("Write error: {}", e))?;
                transferred += n as u64;
                let now = Instant::now();
                if now.duration_since(last_emit).as_millis() >= 200 {
                    last_emit = now;
                    let _ = app.emit("remote_transfer_progress", TransferProgress {
                        transfer_id: String::new(),
                        terminal_id: terminal_id.to_string(),
                        transferred,
                        total,
                        percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                        direction: "upload".to_string(),
                    });
                }
            }
            let _ = app.emit("remote_transfer_progress", TransferProgress {
                transfer_id: String::new(),
                terminal_id: terminal_id.to_string(),
                transferred,
                total,
                percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                direction: "upload".to_string(),
            });
            Ok(())
        })
    }

    pub fn download(
        &self,
        terminal_id: &str,
        remote_path: &str,
        local_path: &str,
        app: &AppHandle,
    ) -> Result<(), String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;

            let stat = session.sftp.stat(Path::new(remote_path))
                .map_err(|e| format!("stat failed: {}", e))?;
            let total = stat.size.unwrap_or(0);

            let mut remote_file = session.sftp.open(Path::new(remote_path))
                .map_err(|e| format!("Failed to open remote file: {}", e))?;

            let mut local_file = std::fs::File::create(local_path)
                .map_err(|e| format!("Failed to create local file: {}", e))?;

            let mut buf = [0u8; 131072];
            let mut transferred: u64 = 0;
            let mut last_emit = Instant::now();
            loop {
                let n = remote_file.read(&mut buf)
                    .map_err(|e| format!("Read error: {}", e))?;
                if n == 0 { break; }
                std::io::Write::write_all(&mut local_file, &buf[..n])
                    .map_err(|e| format!("Write error: {}", e))?;
                transferred += n as u64;
                let now = Instant::now();
                if now.duration_since(last_emit).as_millis() >= 200 {
                    last_emit = now;
                    let _ = app.emit("remote_transfer_progress", TransferProgress {
                        transfer_id: String::new(),
                        terminal_id: terminal_id.to_string(),
                        transferred,
                        total,
                        percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                        direction: "download".to_string(),
                    });
                }
            }
            let _ = app.emit("remote_transfer_progress", TransferProgress {
                transfer_id: String::new(),
                terminal_id: terminal_id.to_string(),
                transferred,
                total,
                percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                direction: "download".to_string(),
            });
            Ok(())
        })
    }

    pub fn download_async(
        &self,
        transfer_id: &str,
        terminal_id: &str,
        remote_path: &str,
        local_path: &str,
        profile: Profile,
        app: AppHandle,
    ) -> Result<(), String> {
        let transfer_id = transfer_id.to_string();
        let terminal_id = terminal_id.to_string();
        let remote_path = remote_path.to_string();
        let local_path = local_path.to_string();

        std::thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                // Create a dedicated SSH+SFTP connection — no shared mutex
                let (_session, sftp) = connect_ssh(&profile)?;

                let stat = sftp.stat(Path::new(&remote_path))
                    .map_err(|e| format!("stat failed: {}", e))?;
                let total = stat.size.unwrap_or(0);

                let mut remote_file = sftp.open(Path::new(&remote_path))
                    .map_err(|e| format!("Failed to open remote file: {}", e))?;

                let mut local_file = std::fs::File::create(&local_path)
                    .map_err(|e| format!("Failed to create local file: {}", e))?;

                let mut buf = [0u8; 131072];
                let mut transferred: u64 = 0;
                let mut last_emit = Instant::now();
                loop {
                    let n = match remote_file.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(e) => return Err(format!("Read error: {}", e)),
                    };
                    if let Err(e) = std::io::Write::write_all(&mut local_file, &buf[..n]) {
                        return Err(format!("Write error: {}", e));
                    }
                    transferred += n as u64;
                    let now = Instant::now();
                    if now.duration_since(last_emit).as_millis() >= 200 {
                        last_emit = now;
                        let _ = app.emit("remote_transfer_progress", TransferProgress {
                            transfer_id: transfer_id.clone(),
                            terminal_id: terminal_id.clone(),
                            transferred,
                            total,
                            percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                            direction: "download".to_string(),
                        });
                    }
                }
                let _ = app.emit("remote_transfer_progress", TransferProgress {
                    transfer_id: transfer_id.clone(),
                    terminal_id: terminal_id.clone(),
                    transferred,
                    total,
                    percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                    direction: "download".to_string(),
                });
                Ok(())
            })();

            if let Err(error) = result {
                let _ = app.emit("remote_transfer_error", TransferError {
                    transfer_id: transfer_id.clone(),
                    error: error.clone(),
                });
            }
        });

        Ok(())
    }

    pub fn download_dir_async(
        &self,
        transfer_id: &str,
        terminal_id: &str,
        remote_path: &str,
        local_path: &str,
        profile: Profile,
        app: AppHandle,
    ) -> Result<(), String> {
        let transfer_id = transfer_id.to_string();
        let terminal_id = terminal_id.to_string();
        let remote_path = remote_path.to_string();
        let local_path = local_path.to_string();

        std::thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                let (_session, sftp) = connect_ssh(&profile)?;

                // Collect all files recursively: (remote_path, relative_path, size)
                let mut files: Vec<(String, String, u64)> = Vec::new();
                let mut dirs: Vec<String> = Vec::new();
                let mut stack: Vec<String> = vec![remote_path.clone()];

                while let Some(dir) = stack.pop() {
                    let entries = sftp.readdir(Path::new(&dir))
                        .map_err(|e| format!("readdir {} failed: {}", dir, e))?;
                    for (pathbuf, stat) in entries {
                        let p = pathbuf.to_string_lossy().to_string();
                        let name = pathbuf.file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        if name == "." || name == ".." { continue; }
                        let relative = if &dir == &remote_path {
                            name.clone()
                        } else {
                            format!("{}/{}", &dir[remote_path.len()..].trim_start_matches('/'), name)
                        };
                        if stat.is_dir() {
                            stack.push(p);
                            dirs.push(relative);
                        } else {
                            let size = stat.size.unwrap_or(0);
                            files.push((p, relative, size));
                        }
                    }
                }

                let total: u64 = files.iter().map(|(_, _, s)| *s).sum();

                // Create local directories
                std::fs::create_dir_all(&local_path)
                    .map_err(|e| format!("Failed to create local dir: {}", e))?;
                for dir in &dirs {
                    let local_dir = format!("{}/{}", local_path, dir);
                    std::fs::create_dir_all(&local_dir)
                        .map_err(|e| format!("Failed to create dir {}: {}", local_dir, e))?;
                }

                // Download files
                let mut transferred: u64 = 0;
                let mut last_emit = Instant::now();

                for (remote_file_path, relative, _file_size) in &files {
                    let local_file_path = format!("{}/{}", local_path, relative);
                    // Ensure parent dir exists
                    if let Some(parent) = Path::new(&local_file_path).parent() {
                        std::fs::create_dir_all(parent)
                            .map_err(|e| format!("Failed to create dir: {}", e))?;
                    }
                    let mut remote_file = sftp.open(Path::new(remote_file_path))
                        .map_err(|e| format!("Failed to open {}: {}", remote_file_path, e))?;
                    let mut local_file = std::fs::File::create(&local_file_path)
                        .map_err(|e| format!("Failed to create {}: {}", local_file_path, e))?;

                    let mut buf = [0u8; 131072];
                    loop {
                        let n = match remote_file.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(e) => return Err(format!("Read error {}: {}", remote_file_path, e)),
                        };
                        if let Err(e) = std::io::Write::write_all(&mut local_file, &buf[..n]) {
                            return Err(format!("Write error {}: {}", local_file_path, e));
                        }
                        transferred += n as u64;
                        let now = Instant::now();
                        if now.duration_since(last_emit).as_millis() >= 200 {
                            last_emit = now;
                            let _ = app.emit("remote_transfer_progress", TransferProgress {
                                transfer_id: transfer_id.clone(),
                                terminal_id: terminal_id.clone(),
                                transferred,
                                total,
                                percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                                direction: "download".to_string(),
                            });
                        }
                    }
                }

                let _ = app.emit("remote_transfer_progress", TransferProgress {
                    transfer_id: transfer_id.clone(),
                    terminal_id: terminal_id.clone(),
                    transferred,
                    total,
                    percent: 100.0,
                    direction: "download".to_string(),
                });
                Ok(())
            })();

            if let Err(error) = result {
                let _ = app.emit("remote_transfer_error", TransferError {
                    transfer_id: transfer_id.clone(),
                    error: error.clone(),
                });
            }
        });

        Ok(())
    }

    pub fn upload_async(
        &self,
        transfer_id: &str,
        terminal_id: &str,
        local_path: &str,
        remote_path: &str,
        profile: Profile,
        app: AppHandle,
    ) -> Result<(), String> {
        let transfer_id = transfer_id.to_string();
        let terminal_id = terminal_id.to_string();
        let local_path = local_path.to_string();
        let remote_path = remote_path.to_string();

        std::thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                // Create a dedicated SSH+SFTP connection — no shared mutex
                let (_session, sftp) = connect_ssh(&profile)?;

                let mut local_file = std::fs::File::open(&local_path)
                    .map_err(|e| format!("Failed to open local file: {}", e))?;
                let metadata = local_file.metadata()
                    .map_err(|e| e.to_string())?;
                let total = metadata.len();

                let mut remote_file = sftp.open_mode(
                    Path::new(&remote_path),
                    ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::TRUNCATE,
                    0o644,
                    ssh2::OpenType::File,
                ).map_err(|e| format!("Failed to open remote file: {}", e))?;

                let mut buf = [0u8; 131072];
                let mut transferred: u64 = 0;
                let mut last_emit = Instant::now();
                loop {
                    let n = match local_file.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(e) => return Err(format!("Read error: {}", e)),
                    };
                    remote_file.write(&buf[..n])
                        .map_err(|e| format!("Write error: {}", e))?;
                    transferred += n as u64;
                    let now = Instant::now();
                    if now.duration_since(last_emit).as_millis() >= 200 {
                        last_emit = now;
                        let _ = app.emit("remote_transfer_progress", TransferProgress {
                            transfer_id: transfer_id.clone(),
                            terminal_id: terminal_id.clone(),
                            transferred,
                            total,
                            percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                            direction: "upload".to_string(),
                        });
                    }
                }
                let _ = app.emit("remote_transfer_progress", TransferProgress {
                    transfer_id: transfer_id.clone(),
                    terminal_id: terminal_id.clone(),
                    transferred,
                    total,
                    percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                    direction: "upload".to_string(),
                });
                Ok(())
            })();

            if let Err(error) = result {
                let _ = app.emit("remote_transfer_error", TransferError {
                    transfer_id: transfer_id.clone(),
                    error: error.clone(),
                });
            }
        });

        Ok(())
    }

    pub fn exec(&self, terminal_id: &str, cmd: &str) -> Result<String, String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;

            let mut channel = session.session.channel_session()
                .map_err(|e| format!("Channel creation failed: {}", e))?;
            channel.exec(cmd)
                .map_err(|e| format!("exec failed: {}", e))?;

            let mut output = String::new();
            channel.read_to_string(&mut output)
                .map_err(|e| format!("Read output failed: {}", e))?;

            channel.wait_close()
                .map_err(|e| format!("Close failed: {}", e))?;

            Ok(output)
        })
    }

    pub fn get_home_dir(&self, terminal_id: &str) -> Result<String, String> {
        let output = self.exec(terminal_id, "echo ~")?;
        Ok(output.trim().to_string())
    }

    pub fn close_session(&self, terminal_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(terminal_id);
        }
    }
}
