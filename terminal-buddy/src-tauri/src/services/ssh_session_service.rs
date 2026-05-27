use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use ssh2::Session;
use tauri::{AppHandle, Emitter};

use crate::models::profile::Profile;
use crate::models::ssh_types::{RemoteFileEntry, TransferProgress};

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
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(terminal_id) {
            return Ok(());
        }
        drop(sessions);

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
            _ => {
                if session.userauth_agent(user).is_err() {
                    return Err("Agent authentication failed. Password auth not supported — use key-based authentication.".to_string());
                }
            }
        }

        if !session.authenticated() {
            return Err("SSH authentication failed".to_string());
        }

        let sftp = session.sftp()
            .map_err(|e| format!("SFTP subsystem failed: {}", e))?;

        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(terminal_id.to_string(), Arc::new(Mutex::new(SshSession { session, sftp })));
        Ok(())
    }

    fn with_session<F, R>(&self, terminal_id: &str, f: F) -> Result<R, String>
    where
        F: FnOnce(&Mutex<SshSession>) -> Result<R, String>,
    {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let arc = sessions.get(terminal_id).cloned().ok_or("SSH session not found")?;
        drop(sessions);
        f(&arc)
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

            let mut buf = [0u8; 32768];
            let mut transferred: u64 = 0;
            loop {
                let n = local_file.read(&mut buf)
                    .map_err(|e| format!("Read error: {}", e))?;
                if n == 0 { break; }
                remote_file.write(&buf[..n])
                    .map_err(|e| format!("Write error: {}", e))?;
                transferred += n as u64;
                let _ = app.emit("remote_transfer_progress", TransferProgress {
                    terminal_id: terminal_id.to_string(),
                    transferred,
                    total,
                    percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                    direction: "upload".to_string(),
                });
            }
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

            let mut buf = [0u8; 32768];
            let mut transferred: u64 = 0;
            loop {
                let n = remote_file.read(&mut buf)
                    .map_err(|e| format!("Read error: {}", e))?;
                if n == 0 { break; }
                std::io::Write::write_all(&mut local_file, &buf[..n])
                    .map_err(|e| format!("Write error: {}", e))?;
                transferred += n as u64;
                // Emit while holding per-session lock (outer map lock already released)
                let _ = app.emit("remote_transfer_progress", TransferProgress {
                    terminal_id: terminal_id.to_string(),
                    transferred,
                    total,
                    percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                    direction: "download".to_string(),
                });
            }
            Ok(())
        })
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

    pub fn close_session(&self, terminal_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(terminal_id);
        }
    }
}
