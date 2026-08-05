use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};

use ssh2::Session;

use crate::models::profile::Profile;
use crate::models::ssh_types::RemoteFileEntry;

pub(crate) fn connect_ssh(profile: &Profile) -> Result<(Session, ssh2::Sftp), String> {
    let host = profile.ssh_host.as_ref().ok_or("SSH host not set")?;
    let port = profile.ssh_port.unwrap_or(22);
    let user = profile.ssh_user.as_ref().ok_or("SSH user not set")?;

    let tcp = std::net::TcpStream::connect(format!("{}:{}", host, port))
        .map_err(|e| format!("TCP connection failed: {}", e))?;

    let mut session = Session::new().map_err(|e| format!("Session creation failed: {}", e))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    match profile.ssh_auth_type.as_deref() {
        Some("key") => {
            let key_path = profile
                .ssh_key_path
                .as_ref()
                .ok_or("SSH key path not set")?;
            session
                .userauth_pubkey_file(user, None, Path::new(key_path), None)
                .map_err(|e| format!("Key auth failed: {}", e))?;
        }
        Some("password") => {
            let password = profile
                .ssh_password
                .as_deref()
                .ok_or("SSH password not set")?;
            session
                .userauth_password(user, password)
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

    let sftp = session
        .sftp()
        .map_err(|e| format!("SFTP subsystem failed: {}", e))?;

    Ok((session, sftp))
}

struct SshSession {
    session: Session,
    sftp: ssh2::Sftp,
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
        sessions.insert(
            terminal_id.to_string(),
            Arc::new(Mutex::new(SshSession { session, sftp })),
        );
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
        sessions
            .get(terminal_id)
            .cloned()
            .ok_or("SSH session not found".to_string())
    }

    pub fn list_dir(&self, terminal_id: &str, path: &str) -> Result<Vec<RemoteFileEntry>, String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;

            let entries = session
                .sftp
                .readdir(Path::new(path))
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
                b.is_dir
                    .cmp(&a.is_dir)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });

            Ok(result)
        })
    }

    pub fn mkdir(&self, terminal_id: &str, path: &str) -> Result<(), String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;
            session
                .sftp
                .mkdir(Path::new(path), 0o755)
                .map_err(|e| format!("mkdir failed: {}", e))
        })
    }

    pub fn remove(&self, terminal_id: &str, path: &str, is_dir: bool) -> Result<(), String> {
        if is_dir {
            self.exec(
                terminal_id,
                &format!("rm -rf '{}'", path.replace('\'', "'\\''")),
            )?;
        } else {
            self.with_session(terminal_id, |session_mutex| {
                let session = session_mutex.lock().map_err(|e| e.to_string())?;
                session
                    .sftp
                    .unlink(Path::new(path))
                    .map_err(|e| format!("unlink failed: {}", e))
            })?;
        }
        Ok(())
    }

    pub fn rename(&self, terminal_id: &str, from: &str, to: &str) -> Result<(), String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;
            session
                .sftp
                .rename(Path::new(from), Path::new(to), None)
                .map_err(|e| format!("rename failed: {}", e))
        })
    }

    pub fn chmod(&self, terminal_id: &str, path: &str, mode: i32) -> Result<(), String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;
            let mut stat = session
                .sftp
                .stat(Path::new(path))
                .map_err(|e| format!("stat failed: {}", e))?;
            stat.perm = Some(mode as u32);
            session
                .sftp
                .setstat(Path::new(path), stat)
                .map_err(|e| format!("chmod failed: {}", e))
        })
    }

    pub fn exec(&self, terminal_id: &str, cmd: &str) -> Result<String, String> {
        self.with_session(terminal_id, |session_mutex| {
            let session = session_mutex.lock().map_err(|e| e.to_string())?;

            let mut channel = session
                .session
                .channel_session()
                .map_err(|e| format!("Channel creation failed: {}", e))?;
            channel
                .exec(cmd)
                .map_err(|e| format!("exec failed: {}", e))?;

            let mut output = String::new();
            channel
                .read_to_string(&mut output)
                .map_err(|e| format!("Read output failed: {}", e))?;

            channel
                .wait_close()
                .map_err(|e| format!("Close failed: {}", e))?;

            Ok(output)
        })
    }

    pub fn get_home_dir(&self, terminal_id: &str) -> Result<String, String> {
        let output = self.exec(terminal_id, "echo ~")?;
        Ok(output.trim().to_string())
    }

    pub fn close_session(&self, terminal_id: &str) {
        let session = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(terminal_id));
        if let Some(session) = session {
            let _cleanup_task = tauri::async_runtime::spawn_blocking(move || drop(session));
        }
    }
}
