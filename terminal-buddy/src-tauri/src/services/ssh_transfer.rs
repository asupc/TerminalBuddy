//! SFTP 文件传输：异步下载/上传。
//!
//! 每次传输使用独立 SSH+SFTP 连接（不占用会话池锁），
//! 由 `spawn_transfer` 统一包裹后台线程与错误事件发射。

use std::io::{Read, Write};
use std::path::Path;
use std::time::Instant;

use tauri::{AppHandle, Emitter};

use crate::models::profile::Profile;
use crate::models::ssh_types::{TransferError, TransferProgress};

use super::ssh_session_service::{connect_ssh, SshSessionService};

/// 后台线程执行传输：出错时统一发射 `remote_transfer_error`。
fn spawn_transfer<F>(transfer_id: String, app: AppHandle, transfer: F)
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    std::thread::spawn(move || {
        if let Err(error) = transfer() {
            let _ = app.emit(
                "remote_transfer_error",
                TransferError {
                    transfer_id,
                    error,
                },
            );
        }
    });
}

/// 发射传输进度事件（percent 计算统一收敛于此）。
fn emit_transfer_progress(
    app: &AppHandle,
    transfer_id: &str,
    terminal_id: &str,
    transferred: u64,
    total: u64,
    direction: &str,
) {
    let percent = if total > 0 {
        transferred as f64 / total as f64 * 100.0
    } else {
        100.0
    };
    let _ = app.emit(
        "remote_transfer_progress",
        TransferProgress {
            transfer_id: transfer_id.to_string(),
            terminal_id: terminal_id.to_string(),
            transferred,
            total,
            percent,
            direction: direction.to_string(),
        },
    );
}

impl SshSessionService {
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

        spawn_transfer(transfer_id.clone(), app.clone(), move || {
            // Create a dedicated SSH+SFTP connection — no shared mutex
            let (_session, sftp) = connect_ssh(&profile)?;

            let stat = sftp
                .stat(Path::new(&remote_path))
                .map_err(|e| format!("stat failed: {}", e))?;
            let total = stat.size.unwrap_or(0);

            let mut remote_file = sftp
                .open(Path::new(&remote_path))
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
                if let Err(e) = local_file.write_all(&buf[..n]) {
                    return Err(format!("Write error: {}", e));
                }
                transferred += n as u64;
                if last_emit.elapsed().as_millis() >= 200 {
                    last_emit = Instant::now();
                    emit_transfer_progress(
                        &app,
                        &transfer_id,
                        &terminal_id,
                        transferred,
                        total,
                        "download",
                    );
                }
            }
            emit_transfer_progress(
                &app,
                &transfer_id,
                &terminal_id,
                transferred,
                total,
                "download",
            );
            Ok(())
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

        spawn_transfer(transfer_id.clone(), app.clone(), move || {
            let (_session, sftp) = connect_ssh(&profile)?;

            // Collect all files recursively: (remote_path, relative_path, size)
            let mut files: Vec<(String, String, u64)> = Vec::new();
            let mut dirs: Vec<String> = Vec::new();
            let mut stack: Vec<String> = vec![remote_path.clone()];

            while let Some(dir) = stack.pop() {
                let entries = sftp
                    .readdir(Path::new(&dir))
                    .map_err(|e| format!("readdir {} failed: {}", dir, e))?;
                for (pathbuf, stat) in entries {
                    let p = pathbuf.to_string_lossy().to_string();
                    let name = pathbuf
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let relative = if &dir == &remote_path {
                        name.clone()
                    } else {
                        format!(
                            "{}/{}",
                            &dir[remote_path.len()..].trim_start_matches('/'),
                            name
                        )
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
                let mut remote_file = sftp
                    .open(Path::new(remote_file_path))
                    .map_err(|e| format!("Failed to open {}: {}", remote_file_path, e))?;
                let mut local_file = std::fs::File::create(&local_file_path)
                    .map_err(|e| format!("Failed to create {}: {}", local_file_path, e))?;

                let mut buf = [0u8; 131072];
                loop {
                    let n = match remote_file.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(e) => {
                            return Err(format!("Read error {}: {}", remote_file_path, e))
                        }
                    };
                    if let Err(e) = local_file.write_all(&buf[..n]) {
                        return Err(format!("Write error {}: {}", local_file_path, e));
                    }
                    transferred += n as u64;
                    if last_emit.elapsed().as_millis() >= 200 {
                        last_emit = Instant::now();
                        emit_transfer_progress(
                            &app,
                            &transfer_id,
                            &terminal_id,
                            transferred,
                            total,
                            "download",
                        );
                    }
                }
            }

            emit_transfer_progress(
                &app,
                &transfer_id,
                &terminal_id,
                transferred,
                total,
                "download",
            );
            Ok(())
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

        spawn_transfer(transfer_id.clone(), app.clone(), move || {
            // Create a dedicated SSH+SFTP connection — no shared mutex
            let (_session, sftp) = connect_ssh(&profile)?;

            let mut local_file = std::fs::File::open(&local_path)
                .map_err(|e| format!("Failed to open local file: {}", e))?;
            let metadata = local_file.metadata().map_err(|e| e.to_string())?;
            let total = metadata.len();

            let mut remote_file = sftp
                .open_mode(
                    Path::new(&remote_path),
                    ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::TRUNCATE,
                    0o644,
                    ssh2::OpenType::File,
                )
                .map_err(|e| format!("Failed to open remote file: {}", e))?;

            let mut buf = [0u8; 131072];
            let mut transferred: u64 = 0;
            let mut last_emit = Instant::now();
            loop {
                let n = match local_file.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) => return Err(format!("Read error: {}", e)),
                };
                remote_file
                    .write(&buf[..n])
                    .map_err(|e| format!("Write error: {}", e))?;
                transferred += n as u64;
                if last_emit.elapsed().as_millis() >= 200 {
                    last_emit = Instant::now();
                    emit_transfer_progress(
                        &app,
                        &transfer_id,
                        &terminal_id,
                        transferred,
                        total,
                        "upload",
                    );
                }
            }
            emit_transfer_progress(
                &app,
                &transfer_id,
                &terminal_id,
                transferred,
                total,
                "upload",
            );
            Ok(())
        });

        Ok(())
    }
}
