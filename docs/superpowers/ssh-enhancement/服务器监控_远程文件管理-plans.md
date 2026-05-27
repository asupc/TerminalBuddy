# SSH Enhancement: 服务器监控与远程文件管理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SSH 终端新增服务器运行状态监控面板和远程文件管理功能，通过 `ssh2-rs` 建立独立于 PTY 的 SSH 连接提供 SFTP 和远程命令执行能力。

**Architecture:** SSH Session Service 作为 managed state 注册到 Tauri，维护 per-terminal 的 `ssh2::Session` 连接。远程文件操作和服务器监控各一组 Tauri command，通过 service 层调用 SFTP/exec。前端在现有 FileTree 中根据标签页类型切换数据源，监控面板嵌入终端容器底部。

**Tech Stack:** Rust (`ssh2-rs`, `tokio`, `serde`), React 18, Zustand, Monaco Editor (existing)

**Design Doc:** `docs/superpowers/ssh-enhancement/服务器监控_远程文件管理-design.md` — source of truth for business requirements; per-task acceptance criteria are extracted from this document

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `src-tauri/src/models/ssh_types.rs` | SSH 相关数据结构：RemoteFileEntry, ServerStats, MemoryStats, DiskStats, NetworkStats, TransferProgress |
| `src-tauri/src/services/ssh_session_service.rs` | SSH 连接管理（get_or_create, list_dir, mkdir, remove, rename, chmod, upload, download, exec） |
| `src-tauri/src/commands/remote_file.rs` | 远程文件 Tauri 命令层（12 个 command：含 connect_ssh_session, get_ssh_temp_directory, ensure_dir） |
| `src-tauri/src/commands/server_monitor.rs` | 服务器监控 Tauri 命令层（get_server_stats） |
| `src/components/ServerMonitor.tsx` | 终端底部可折叠监控面板组件 |
| `src/components/RemoteFileTree.tsx` | 远程文件树组件（在 FileTree 中条件渲染） |
| `src/components/ChmodDialog.tsx` | 权限修改对话框组件 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src-tauri/Cargo.toml` | 新增 `ssh2 = "0.9"` 依赖 |
| `src-tauri/src/models/mod.rs` | 添加 `pub mod ssh_types;` |
| `src-tauri/src/services/mod.rs` | 添加 `pub mod ssh_session_service;` |
| `src-tauri/src/commands/mod.rs` | 添加 `pub mod remote_file;` 和 `pub mod server_monitor;` |
| `src-tauri/src/lib.rs` | 注册 SshSessionService + MonitorCache managed state，注册 14 个新 command |
| `src/services/tauri.ts` | 新增 14 个 invoke 包装函数 + 1 个事件监听函数 |
| `src/stores/appStore.ts` | 新增 remoteFiles, serverStats, remoteClipboard 状态 |
| `src/components/FileTree.tsx` | SSH 标签页时渲染 RemoteFileTree 替代本地文件树 |
| `src/components/TerminalInstance.tsx` | 底部嵌入 ServerMonitor 组件 |
| `src/components/SettingsPage.tsx` | 新增 SSH 下载目录和监控刷新间隔设置项 |

---

## Task 1: SSH 数据结构与依赖

**Skills:** _none_

**Files:**
- Create: `src-tauri/src/models/ssh_types.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/Cargo.toml`

**Acceptance Criteria:**
- [ ] C1: `ssh2` 依赖已添加到 Cargo.toml，`cargo check` 编译通过
- [ ] C2: `RemoteFileEntry`, `ServerStats`, `MemoryStats`, `DiskStats`, `NetworkStats`, `TransferProgress` 结构体均可序列化为 camelCase JSON

- [ ] **Step 1: 添加 ssh2 依赖**

修改 `src-tauri/Cargo.toml`，在 `[dependencies]` 中添加：

```toml
ssh2 = "0.9"
```

- [ ] **Step 2: 创建 ssh_types.rs 数据结构**

创建 `src-tauri/src/models/ssh_types.rs`：

```rust
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: u32,
    pub modified: i64,
    pub owner: String,
    pub group: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerStats {
    pub uptime: String,
    pub cpu_usage: f64,
    pub memory: MemoryStats,
    pub disk: Vec<DiskStats>,
    pub network: NetworkStats,
    pub timestamp: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub usage_percent: f64,
    pub swap_total: u64,
    pub swap_used: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    pub mount: String,
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub usage_percent: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStats {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_speed: f64,
    pub tx_speed: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub terminal_id: String,
    pub transferred: u64,
    pub total: u64,
    pub percent: f64,
    pub direction: String,
}
```

- [ ] **Step 3: 注册模块**

修改 `src-tauri/src/models/mod.rs`，添加：

```rust
pub mod ssh_types;
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check
```

Expected: 编译通过（可能有 warning，无 error）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/models/ssh_types.rs src-tauri/src/models/mod.rs
git commit -m "[ssh] 添加 ssh2 依赖和 SSH 数据结构定义"
```

---

## Task 2: SSH Session Service

**Skills:** _none_

**Files:**
- Create: `src-tauri/src/services/ssh_session_service.rs`
- Modify: `src-tauri/src/services/mod.rs`

**Acceptance Criteria:**
- [ ] C1: SshSessionService 作为 Tauri managed state 注册，可在 command 中通过 State<SshSessionService> 注入
- [ ] C2: get_or_create_session 使用 Profile 的 SSH 认证信息（host/port/user/auth_type/key_path）建立连接
- [ ] C3: list_dir 返回 RemoteFileEntry 列表，包含文件名、大小、权限、修改时间、owner/group
- [ ] C4: upload/download 通过 Tauri 事件 `remote_transfer_progress` 推送 TransferProgress
- [ ] C5: 终端关闭时对应的 SSH 连接被清理

- [ ] **Step 1: 创建 ssh_session_service.rs**

创建 `src-tauri/src/services/ssh_session_service.rs`：

```rust
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use ssh2::Session;
use tauri::{AppHandle, Emitter};
use crate::models::profile::Profile;
use crate::models::ssh_types::{RemoteFileEntry, TransferProgress};

pub struct SshSession {
    pub session: Session,
    pub sftp: ssh2::Sftp,
}

pub struct SshSessionService {
    sessions: Mutex<HashMap<String, SshSession>>,
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
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(terminal_id) {
            return Ok(());
        }

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
                // Password auth - prompt in terminal, so use agent or none
                // For now, try agent auth first, then keyboard-interactive
                if session.auth_agent(user).is_err() {
                    return Err("Password auth requires interactive input. Use key-based authentication.".to_string());
                }
            }
        }

        if !session.authenticated() {
            return Err("SSH authentication failed".to_string());
        }

        let sftp = session.sftp()
            .map_err(|e| format!("SFTP subsystem failed: {}", e))?;

        sessions.insert(terminal_id.to_string(), SshSession { session, sftp });
        Ok(())
    }

    pub fn list_dir(&self, terminal_id: &str, path: &str) -> Result<Vec<RemoteFileEntry>, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(terminal_id).ok_or("SSH session not found")?;

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
    }

    pub fn mkdir(&self, terminal_id: &str, path: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(terminal_id).ok_or("SSH session not found")?;
        session.sftp.mkdir(Path::new(path), 0o755)
            .map_err(|e| format!("mkdir failed: {}", e))
    }

    pub fn remove(&self, terminal_id: &str, path: &str, is_dir: bool) -> Result<(), String> {
        if is_dir {
            self.exec(terminal_id, &format!("rm -rf '{}'", path.replace('\'', "'\\''")))?;
        } else {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions.get(terminal_id).ok_or("SSH session not found")?;
            session.sftp.unlink(Path::new(path))
                .map_err(|e| format!("unlink failed: {}", e))?;
        }
        Ok(())
    }

    pub fn rename(&self, terminal_id: &str, from: &str, to: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(terminal_id).ok_or("SSH session not found")?;
        session.sftp.rename(Path::new(from), Path::new(to), None)
            .map_err(|e| format!("rename failed: {}", e))
    }

    pub fn chmod(&self, terminal_id: &str, path: &str, mode: i32) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(terminal_id).ok_or("SSH session not found")?;
        let mut stat = session.sftp.stat(Path::new(path))
            .map_err(|e| format!("stat failed: {}", e))?;
        stat.perm = Some(mode as u32);
        session.sftp.setstat(Path::new(path), stat)
            .map_err(|e| format!("chmod failed: {}", e))
    }

    pub fn upload(
        &self,
        terminal_id: &str,
        local_path: &str,
        remote_path: &str,
        app: &AppHandle,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(terminal_id).ok_or("SSH session not found")?;

        let mut local_file = std::fs::File::open(local_path)
            .map_err(|e| format!("Failed to open local file: {}", e))?;
        let metadata = local_file.metadata()
            .map_err(|e| e.to_string())?;
        let total = metadata.len();

        let mut remote_file = session.sftp.open_mode(
            Path::new(remote_path),
            ssh2::consts::SSH_FXF_WRITE | ssh2::consts::SSH_FXF_CREAT | ssh2::consts::SSH_FXF_TRUNC,
            0o644,
            ssh2::types::OpenType::File,
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
    }

    pub fn download(
        &self,
        terminal_id: &str,
        remote_path: &str,
        local_path: &str,
        app: &AppHandle,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(terminal_id).ok_or("SSH session not found")?;

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
            let _ = app.emit("remote_transfer_progress", TransferProgress {
                terminal_id: terminal_id.to_string(),
                transferred,
                total,
                percent: if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 100.0 },
                direction: "download".to_string(),
            });
        }
        Ok(())
    }

    pub fn exec(&self, terminal_id: &str, cmd: &str) -> Result<String, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(terminal_id).ok_or("SSH session not found")?;

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
    }

    pub fn close_session(&self, terminal_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(terminal_id);
        }
    }
}
```

- [ ] **Step 2: 注册 service 模块**

修改 `src-tauri/src/services/mod.rs`，添加：

```rust
pub mod ssh_session_service;
```

- [ ] **Step 3: 编译验证**

```bash
cd src-tauri && cargo check
```

Expected: 编译通过

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/services/ssh_session_service.rs src-tauri/src/services/mod.rs
git commit -m "[ssh] 添加 SSH Session Service：连接管理、SFTP 操作、远程命令执行"
```

---

## Task 3: Remote File Commands

**Skills:** _none_

**Files:**
- Create: `src-tauri/src/commands/remote_file.rs`
- Modify: `src-tauri/src/commands/mod.rs`

**Acceptance Criteria:**
- [ ] C1: 12 个 remote_file command 均可被前端 invoke 调用（含 connect_ssh_session, get_ssh_temp_directory, ensure_dir）
- [ ] C2: remote_upload 和 remote_download 通过 `remote_transfer_progress` 事件推送进度
- [ ] C3: remote_move 和 remote_copy 通过远程命令（mv/cp）实现
- [ ] C4: 路径参数做 shell 转义防注入

- [ ] **Step 1: 创建 remote_file.rs**

创建 `src-tauri/src/commands/remote_file.rs`：

```rust
use tauri::{AppHandle, State};
use crate::models::ssh_types::RemoteFileEntry;
use crate::services::ssh_session_service::SshSessionService;
use crate::services::profile_service::ProfileService;

#[tauri::command]
pub async fn connect_ssh_session(
    terminal_id: String,
    profile_id: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    let profile = ProfileService::get_profile(&profile_id)
        .map_err(|e| format!("Failed to load profile: {}", e))?;
    ssh_service.get_or_create_session(&terminal_id, &profile)
}

#[tauri::command]
pub async fn remote_list_dir(
    terminal_id: String,
    path: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<Vec<RemoteFileEntry>, String> {
    ssh_service.list_dir(&terminal_id, &path)
}

#[tauri::command]
pub async fn remote_create_dir(
    terminal_id: String,
    path: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.mkdir(&terminal_id, &path)
}

#[tauri::command]
pub async fn remote_create_file(
    terminal_id: String,
    path: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.exec(&terminal_id, &format!("touch '{}'", path.replace('\'', "'\\''")))?;
    Ok(())
}

#[tauri::command]
pub async fn remote_remove(
    terminal_id: String,
    path: String,
    is_dir: bool,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.remove(&terminal_id, &path, is_dir)
}

#[tauri::command]
pub async fn remote_rename(
    terminal_id: String,
    from: String,
    to: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.rename(&terminal_id, &from, &to)
}

#[tauri::command]
pub async fn remote_move(
    terminal_id: String,
    from: String,
    to: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    let from_escaped = from.replace('\'', "'\\''");
    let to_escaped = to.replace('\'', "'\\''");
    ssh_service.exec(&terminal_id, &format!("mv '{}' '{}'", from_escaped, to_escaped))?;
    Ok(())
}

#[tauri::command]
pub async fn remote_copy(
    terminal_id: String,
    from: String,
    to: String,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    let from_escaped = from.replace('\'', "'\\''");
    let to_escaped = to.replace('\'', "'\\''");
    ssh_service.exec(&terminal_id, &format!("cp -r '{}' '{}'", from_escaped, to_escaped))?;
    Ok(())
}

#[tauri::command]
pub async fn remote_chmod(
    terminal_id: String,
    path: String,
    mode: i32,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.chmod(&terminal_id, &path, mode)
}

#[tauri::command]
pub async fn remote_upload(
    terminal_id: String,
    local_path: String,
    remote_path: String,
    app: AppHandle,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.upload(&terminal_id, &local_path, &remote_path, &app)
}

#[tauri::command]
pub async fn remote_download(
    terminal_id: String,
    remote_path: String,
    local_path: String,
    app: AppHandle,
    ssh_service: State<'_, SshSessionService>,
) -> Result<(), String> {
    ssh_service.download(&terminal_id, &remote_path, &local_path, &app)
}

#[tauri::command]
pub fn get_ssh_temp_directory() -> Result<String, String> {
    Ok(std::env::temp_dir()
        .join("TerminalBuddy")
        .join("ssh_edit")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub fn ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {}", e))
}
```

- [ ] **Step 2: 注册命令模块**

修改 `src-tauri/src/commands/mod.rs`，添加：

```rust
pub mod remote_file;
```

以及在 `pub use` 部分添加：

```rust
pub use remote_file::*;
```

- [ ] **Step 3: 注册到 lib.rs**

修改 `src-tauri/src/lib.rs`：

1. 在 `use commands::` 行中添加新命令名（按字母顺序插入）：
   - `connect_ssh_session`, `ensure_dir`, `get_ssh_temp_directory`, `remote_chmod`, `remote_copy`, `remote_create_dir`, `remote_create_file`, `remote_download`, `remote_list_dir`, `remote_move`, `remote_remove`, `remote_rename`, `remote_upload`

2. 在 `invoke_handler![]` 中添加这 13 个命令名

3. 在 `builder` 链中添加 managed state：
   ```rust
   .manage(SshSessionService::new())
   ```

4. 添加 use 引入：
   ```rust
   use services::ssh_session_service::SshSessionService;
   ```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check
```

Expected: 编译通过

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/remote_file.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "[ssh] 添加远程文件操作 Tauri 命令：12 个 SFTP + 工具命令"
```

---

## Task 4: Server Monitor Commands

**Skills:** _none_

**Files:**
- Create: `src-tauri/src/commands/server_monitor.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Acceptance Criteria:**
- [ ] C1: get_server_stats 通过 SSH 执行组合命令获取 uptime/cpu/memory/disk/network 数据
- [ ] C2: 返回的 ServerStats 结构体中各字段正确解析
- [ ] C3: 网络速率通过缓存上一次采集数据和时间差计算

- [ ] **Step 1: 创建 server_monitor.rs**

创建 `src-tauri/src/commands/server_monitor.rs`：

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;
use chrono::Utc;
use crate::models::ssh_types::{ServerStats, MemoryStats, DiskStats, NetworkStats};
use crate::services::ssh_session_service::SshSessionService;

pub struct NetworkCache {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub timestamp: i64,
}

pub struct MonitorCache {
    pub network: Mutex<HashMap<String, NetworkCache>>,
}

impl MonitorCache {
    pub fn new() -> Self {
        Self {
            network: Mutex::new(HashMap::new()),
        }
    }
}

#[tauri::command]
pub async fn get_server_stats(
    terminal_id: String,
    ssh_service: State<'_, SshSessionService>,
    monitor_cache: State<'_, MonitorCache>,
) -> Result<ServerStats, String> {
    let cmd = "echo '===UPTIME===' && uptime -p 2>/dev/null || uptime && echo '===MEM===' && free -b && echo '===CPU===' && head -1 /proc/stat && echo '===DISK===' && df -B1 && echo '===NET===' && cat /proc/net/dev";
    let output = ssh_service.exec(&terminal_id, cmd)?;
    parse_server_stats(&output, &terminal_id, &monitor_cache)
}

fn parse_server_stats(
    output: &str,
    terminal_id: &str,
    monitor_cache: &MonitorCache,
) -> Result<ServerStats, String> {
    let mut sections: HashMap<String, String> = HashMap::new();
    let mut current_key = String::new();
    let mut current_lines: Vec<String> = Vec::new();

    for line in output.lines() {
        if line.starts_with("===") && line.ends_with("===") {
            if !current_key.is_empty() {
                sections.insert(current_key.clone(), current_lines.join("\n"));
            }
            current_key = match line {
                "===UPTIME===" => "uptime",
                "===MEM===" => "mem",
                "===CPU===" => "cpu",
                "===DISK===" => "disk",
                "===NET===" => "net",
                _ => "",
            }.to_string();
            current_lines.clear();
        } else {
            current_lines.push(line.to_string());
        }
    }
    if !current_key.is_empty() {
        sections.insert(current_key, current_lines.join("\n"));
    }

    let uptime = parse_uptime(sections.get("uptime").map(|s| s.as_str()).unwrap_or(""));
    let memory = parse_memory(sections.get("mem").map(|s| s.as_str()).unwrap_or(""));
    let cpu_usage = parse_cpu(sections.get("cpu").map(|s| s.as_str()).unwrap_or(""));
    let disk = parse_disk(sections.get("disk").map(|s| s.as_str()).unwrap_or(""));
    let network = parse_network(sections.get("net").map(|s| s.as_str()).unwrap_or(""), terminal_id, monitor_cache);

    Ok(ServerStats {
        uptime,
        cpu_usage,
        memory,
        disk,
        network,
        timestamp: Utc::now().timestamp(),
    })
}

fn parse_uptime(output: &str) -> String {
    // "up 15 days, 3:42" or "up 3:42"
    output.trim().strip_prefix("up ").unwrap_or(output.trim()).to_string()
}

fn parse_memory(output: &str) -> MemoryStats {
    // Parse "free -b" output
    let mut total = 0u64;
    let mut used = 0u64;
    let mut available = 0u64;
    let mut swap_total = 0u64;
    let mut swap_used = 0u64;

    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            match parts[0] {
                "Mem:" => {
                    total = parts[1].parse().unwrap_or(0);
                    used = parts[2].parse().unwrap_or(0);
                    available = parts.get(6).and_then(|s| s.parse().ok()).unwrap_or(0);
                }
                "Swap:" => {
                    swap_total = parts[1].parse().unwrap_or(0);
                    swap_used = parts[2].parse().unwrap_or(0);
                }
                _ => {}
            }
        }
    }

    MemoryStats {
        total,
        used,
        available,
        usage_percent: if total > 0 { used as f64 / total as f64 * 100.0 } else { 0.0 },
        swap_total,
        swap_used,
    }
}

fn parse_cpu(output: &str) -> f64 {
    // Parse /proc/stat first line: cpu  user nice system idle ...
    if let Some(line) = output.lines().next() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 {
            let values: Vec<u64> = parts[1..].iter()
                .filter_map(|s| s.parse().ok())
                .collect();
            if values.len() >= 4 {
                let idle = values[3];
                let total: u64 = values.iter().sum();
                if total > 0 {
                    return (1.0 - idle as f64 / total as f64) * 100.0;
                }
            }
        }
    }
    0.0
}

fn parse_disk(output: &str) -> Vec<DiskStats> {
    let mut disks = Vec::new();
    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 6 && parts[0].starts_with('/') {
            let total: u64 = parts[1].parse().unwrap_or(0);
            let used: u64 = parts[2].parse().unwrap_or(0);
            let available: u64 = parts[3].parse().unwrap_or(0);
            disks.push(DiskStats {
                mount: parts[5].to_string(),
                total,
                used,
                available,
                usage_percent: if total > 0 { used as f64 / total as f64 * 100.0 } else { 0.0 },
            });
        }
    }
    disks
}

fn parse_network(output: &str, terminal_id: &str, cache: &MonitorCache) -> NetworkStats {
    let mut rx_bytes = 0u64;
    let mut tx_bytes = 0u64;

    for line in output.lines().skip(2) {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() >= 2 {
            let iface = parts[0].trim();
            if iface == "lo" { continue; }
            let values: Vec<u64> = parts[1].split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            if values.len() >= 10 {
                rx_bytes += values[0];
                tx_bytes += values[8];
            }
        }
    }

    let now = Utc::now().timestamp();
    let (rx_speed, tx_speed) = {
        let mut cache_map = cache.network.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prev) = cache_map.get(terminal_id) {
            let dt = (now - prev.timestamp) as f64;
            if dt > 0.0 {
                let rx = (rx_bytes.saturating_sub(prev.rx_bytes)) as f64 / dt;
                let tx = (tx_bytes.saturating_sub(prev.tx_bytes)) as f64 / dt;
                cache_map.insert(terminal_id.to_string(), NetworkCache {
                    rx_bytes, tx_bytes, timestamp: now,
                });
                (rx, tx)
            } else {
                (0.0, 0.0)
            }
        } else {
            cache_map.insert(terminal_id.to_string(), NetworkCache {
                rx_bytes, tx_bytes, timestamp: now,
            });
            (0.0, 0.0)
        }
    };

    NetworkStats { rx_bytes, tx_bytes, rx_speed, tx_speed }
}
```

- [ ] **Step 2: 注册命令模块和 managed state**

修改 `src-tauri/src/commands/mod.rs`，添加：

```rust
pub mod server_monitor;
```

以及在 `pub use` 部分添加：

```rust
pub use server_monitor::*;
```

修改 `src-tauri/src/lib.rs`：

1. 在 `use commands::` 中添加 `get_server_stats`
2. 在 `invoke_handler![]` 中添加 `get_server_stats`
3. 添加 managed state：
   ```rust
   .manage(MonitorCache::new())
   ```
4. 添加 use 引入：
   ```rust
   use commands::server_monitor::MonitorCache;
   ```

- [ ] **Step 3: 编译验证**

```bash
cd src-tauri && cargo check
```

Expected: 编译通过

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/commands/server_monitor.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "[ssh] 添加服务器监控命令：CPU/内存/磁盘/网络数据采集"
```

---

## Task 5: 前端 Invoke 包装与 Store 状态

**Skills:** _none_

**Files:**
- Modify: `src/services/tauri.ts`
- Modify: `src/stores/appStore.ts`

**Acceptance Criteria:**
- [ ] C1: tauri.ts 中新增 14 个 invoke 包装函数（connect_ssh_session, ensure_dir, get_ssh_temp_directory, get_server_stats, remote_list_dir, remote_create_dir, remote_create_file, remote_remove, remote_rename, remote_move, remote_copy, remote_chmod, remote_upload, remote_download）
- [ ] C2: 新增 onTransferProgress 事件监听函数
- [ ] C3: appStore 中新增 remoteFiles, remoteCurrentPath, serverStats, remoteClipboard 状态字段

- [ ] **Step 1: 添加 tauri.ts invoke 包装**

修改 `src/services/tauri.ts`，在文件末尾添加新的分组：

```typescript
// ============ SSH Remote File Commands ============
import type { RemoteFileEntry, ServerStats } from '../types';

export async function connectSshSession(terminalId: string, profileId: string): Promise<void> {
  return invoke('connect_ssh_session', { terminalId, profileId });
}

export async function getSshTempDirectory(): Promise<string> {
  return invoke('get_ssh_temp_directory');
}

export async function ensureDir(path: string): Promise<void> {
  return invoke('ensure_dir', { path });
}

export async function remoteListDir(terminalId: string, path: string): Promise<RemoteFileEntry[]> {
  return invoke('remote_list_dir', { terminalId, path });
}

export async function remoteCreateDir(terminalId: string, path: string): Promise<void> {
  return invoke('remote_create_dir', { terminalId, path });
}

export async function remoteCreateFile(terminalId: string, path: string): Promise<void> {
  return invoke('remote_create_file', { terminalId, path });
}

export async function remoteRemove(terminalId: string, path: string, isDir: boolean): Promise<void> {
  return invoke('remote_remove', { terminalId, path, isDir });
}

export async function remoteRename(terminalId: string, from: string, to: string): Promise<void> {
  return invoke('remote_rename', { terminalId, from, to });
}

export async function remoteMove(terminalId: string, from: string, to: string): Promise<void> {
  return invoke('remote_move', { terminalId, from, to });
}

export async function remoteCopy(terminalId: string, from: string, to: string): Promise<void> {
  return invoke('remote_copy', { terminalId, from, to });
}

export async function remoteChmod(terminalId: string, path: string, mode: number): Promise<void> {
  return invoke('remote_chmod', { terminalId, path, mode });
}

export async function remoteUpload(terminalId: string, localPath: string, remotePath: string): Promise<void> {
  return invoke('remote_upload', { terminalId, localPath, remotePath });
}

export async function remoteDownload(terminalId: string, remotePath: string, localPath: string): Promise<void> {
  return invoke('remote_download', { terminalId, remotePath, localPath });
}

export async function getServerStats(terminalId: string): Promise<ServerStats> {
  return invoke('get_server_stats', { terminalId });
}

export async function onTransferProgress(
  callback: (progress: { terminalId: string; transferred: number; total: number; percent: number; direction: string }) => void
): Promise<UnlistenFn> {
  return listen('remote_transfer_progress', (event) => {
    callback(event.payload as any);
  });
}
```

- [ ] **Step 2: 添加 RemoteFileEntry 和 ServerStats 类型**

修改 `src/types/index.ts`，添加：

```typescript
export interface RemoteFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  permissions: number;
  modified: number;
  owner: string;
  group: string;
}

export interface ServerStats {
  uptime: string;
  cpuUsage: number;
  memory: MemoryStats;
  disk: DiskStats[];
  network: NetworkStats;
  timestamp: number;
}

export interface MemoryStats {
  total: number;
  used: number;
  available: number;
  usagePercent: number;
  swapTotal: number;
  swapUsed: number;
}

export interface DiskStats {
  mount: string;
  total: number;
  used: number;
  available: number;
  usagePercent: number;
}

export interface NetworkStats {
  rxBytes: number;
  txBytes: number;
  rxSpeed: number;
  txSpeed: number;
}
```

- [ ] **Step 3: 扩展 appStore**

修改 `src/stores/appStore.ts`，在 `AppState` interface 中添加：

```typescript
// Remote file state
remoteFiles: RemoteFileEntry[];
remoteCurrentPath: string;
remoteLoading: boolean;
setRemoteFiles: (files: RemoteFileEntry[]) => void;
setRemoteCurrentPath: (path: string) => void;
setRemoteLoading: (loading: boolean) => void;

// Remote clipboard
remoteClipboard: { items: string[]; operation: 'copy' | 'move' } | null;
setRemoteClipboard: (clipboard: { items: string[]; operation: 'copy' | 'move' } | null) => void;

// Server stats
serverStats: ServerStats | null;
setServerStats: (stats: ServerStats | null) => void;
```

在 `create` 函数的初始状态中添加：

```typescript
remoteFiles: [],
remoteCurrentPath: '/',
remoteLoading: false,
remoteClipboard: null,
serverStats: null,
```

以及对应的 setter 实现：

```typescript
setRemoteFiles: (files) => set({ remoteFiles: files }),
setRemoteCurrentPath: (path) => set({ remoteCurrentPath: path }),
setRemoteLoading: (loading) => set({ remoteLoading: loading }),
setRemoteClipboard: (clipboard) => set({ remoteClipboard: clipboard }),
setServerStats: (stats) => set({ serverStats: stats }),
```

- [ ] **Step 4: TypeScript 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 5: 提交**

```bash
git add src/services/tauri.ts src/stores/appStore.ts src/types/index.ts
git commit -m "[ssh] 添加前端 invoke 包装函数和 Zustand 状态"
```

---

## Task 6: ServerMonitor 组件

**Skills:** _none_

**Files:**
- Create: `src/components/ServerMonitor.tsx`
- Modify: `src/components/TerminalInstance.tsx`

**Acceptance Criteria:**
- [ ] C1: SSH 标签页的终端容器底部显示可折叠监控面板
- [ ] C2: 折叠状态显示一行摘要（CPU% | Mem% | Disk% | Net）
- [ ] C3: 展开状态显示 3 行详细信息（Uptime, CPU, Mem, Swap, Disk, Net）
- [ ] C4: 展开时自动定时刷新，折叠时停止
- [ ] C5: 刷新间隔可选择（1s/3s/5s/10s/关闭）
- [ ] C6: 非 SSH 标签页时面板不显示
- [ ] C7: 连接失败显示红色错误提示

- [ ] **Step 1: 创建 ServerMonitor 组件**

创建 `src/components/ServerMonitor.tsx`：

```tsx
import { FC, useEffect, useRef, useState, useCallback } from 'react';
import { getServerStats } from '../services/tauri';
import type { ServerStats } from '../types';

interface ServerMonitorProps {
  terminalId: string;
  isSsh: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}

export const ServerMonitor: FC<ServerMonitorProps> = ({ terminalId, isSsh }) => {
  const [expanded, setExpanded] = useState(false);
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval_] = useState(3);
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);
  const timerRef = useRef<number | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const data = await getServerStats(terminalId);
      setStats(data);
      setError(null);
      setConsecutiveErrors(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConsecutiveErrors(prev => prev + 1);
      if (consecutiveErrors >= 2) {
        setError('连接断开');
      }
    }
  }, [terminalId, consecutiveErrors]);

  useEffect(() => {
    if (!isSsh || !expanded || interval <= 0) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    fetchStats();
    timerRef.current = window.setInterval(fetchStats, interval * 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isSsh, expanded, interval, fetchStats]);

  if (!isSsh) return null;

  const summary = stats
    ? `CPU ${stats.cpuUsage.toFixed(0)}% | Mem ${stats.memory.usagePercent.toFixed(0)}% | ${stats.disk[0] ? `Disk ${stats.disk[0].usagePercent.toFixed(0)}%` : ''} | ↑${formatSpeed(stats.network.txSpeed)} ↓${formatSpeed(stats.network.rxSpeed)}`
    : error || '加载中...';

  return (
    <div style={{
      borderTop: '1px solid var(--border-color, #3c3c3c)',
      background: 'var(--panel-bg, #252526)',
      fontSize: '12px',
      userSelect: 'none',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '4px 12px',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>
          <span style={{ marginRight: 6 }}>{expanded ? '▼' : '▶'}</span>
          <span style={{ color: error ? '#f44747' : '#4ec9b0', marginRight: 4 }}>●</span>
          {!expanded && <span>{summary}</span>}
        </span>
        {expanded && (
          <span style={{ color: '#808080', fontSize: '11px' }}>
            刷新间隔:
            <select
              value={interval}
              onChange={e => setInterval_(Number(e.target.value))}
              style={{
                background: '#3c3c3c',
                color: '#cccccc',
                border: '1px solid #555',
                borderRadius: 3,
                padding: '1px 4px',
                fontSize: '11px',
                marginLeft: 4,
              }}
            >
              <option value={1}>1s</option>
              <option value={3}>3s</option>
              <option value={5}>5s</option>
              <option value={10}>10s</option>
              <option value={0}>关闭</option>
            </select>
          </span>
        )}
      </div>
      {expanded && stats && (
        <div style={{ padding: '4px 12px 8px' }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '2px 0' }}>
            <span><span style={{ color: '#808080' }}>Uptime:</span> {stats.uptime}</span>
            <span>
              <span style={{ color: '#808080' }}>CPU:</span> {stats.cpuUsage.toFixed(1)}%
            </span>
            <span>
              <span style={{ color: '#808080' }}>Mem:</span> {formatBytes(stats.memory.used)}/{formatBytes(stats.memory.total)} ({stats.memory.usagePercent.toFixed(0)}%)
            </span>
            <span>
              <span style={{ color: '#808080' }}>Swap:</span> {formatBytes(stats.memory.swapUsed)}/{formatBytes(stats.memory.swapTotal)}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '2px 0' }}>
            {stats.disk.slice(0, 2).map(d => (
              <span key={d.mount}>
                <span style={{ color: '#808080' }}>Disk {d.mount}:</span> {formatBytes(d.used)}/{formatBytes(d.total)} ({d.usagePercent.toFixed(0)}%)
              </span>
            ))}
            <span><span style={{ color: '#808080' }}>Net ↑:</span> {formatSpeed(stats.network.txSpeed)}</span>
            <span><span style={{ color: '#808080' }}>Net ↓:</span> {formatSpeed(stats.network.rxSpeed)}</span>
          </div>
        </div>
      )}
      {expanded && error && (
        <div style={{ padding: '4px 12px 8px', color: '#f44747' }}>
          {error}
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: 在 TerminalInstance 中嵌入 ServerMonitor**

修改 `src/components/TerminalInstance.tsx`：

1. 在文件顶部 import 区域添加：
   ```typescript
   import { ServerMonitor } from './ServerMonitor';
   ```

2. 在组件的 return 语句中，在 xterm 容器 div 之后、外层 div 结束之前，添加：
   ```tsx
   <ServerMonitor terminalId={terminalId} isSsh={profile?.terminalType === 'ssh'} />
   ```

- [ ] **Step 3: TypeScript 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add src/components/ServerMonitor.tsx src/components/TerminalInstance.tsx
git commit -m "[ssh] 添加服务器监控面板组件，嵌入终端容器底部"
```

---

## Task 7: RemoteFileTree 组件

**Skills:** _none_

**Files:**
- Create: `src/components/RemoteFileTree.tsx`
- Create: `src/components/ChmodDialog.tsx`
- Modify: `src/components/FileTree.tsx`

**Acceptance Criteria:**
- [ ] C1: SSH 标签页激活时，左侧文件树区域显示远程文件树
- [ ] C2: 顶部显示面包屑导航，可点击跳转
- [ ] C3: 文件列表显示文件名、大小、权限（Unix 格式）、修改时间
- [ ] C4: 右键菜单包含：打开(cd)、下载、编辑、重命名、复制、移动、权限、删除、新建文件/文件夹、上传、刷新
- [ ] C5: 文本文件（isTextFile）右键菜单显示"用本地编辑器打开"
- [ ] C6: 双击文件夹进入该目录
- [ ] C7: 非 SSH 标签页时显示原有本地文件树

- [ ] **Step 1: 创建 ChmodDialog 组件**

创建 `src/components/ChmodDialog.tsx`：

```tsx
import { FC, useState, useMemo } from 'react';

interface ChmodDialogProps {
  path: string;
  currentMode: number;
  onConfirm: (mode: number) => void;
  onClose: () => void;
}

const PERM_BITS = [
  { label: '读取 (r)', bit: 4 },
  { label: '写入 (w)', bit: 2 },
  { label: '执行 (x)', bit: 1 },
];

const GROUPS = ['Owner', 'Group', 'Other'];

function modeToPerms(mode: number): boolean[] {
  const perms: boolean[] = [];
  for (let g = 2; g >= 0; g--) {
    for (let b = 2; b >= 0; b--) {
      perms.push((mode & (PERM_BITS[b].bit << (g * 3))) !== 0);
    }
  }
  return perms;
}

function permsToMode(perms: boolean[]): number {
  let mode = 0;
  for (let g = 0; g < 3; g++) {
    for (let b = 0; b < 3; b++) {
      if (perms[g * 3 + b]) {
        mode |= PERM_BITS[b].bit << ((2 - g) * 3);
      }
    }
  }
  return mode;
}

function formatPermission(mode: number): string {
  const chars = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  return '-' +
    chars[(mode >> 6) & 7] +
    chars[(mode >> 3) & 7] +
    chars[mode & 7];
}

export const ChmodDialog: FC<ChmodDialogProps> = ({ path, currentMode, onConfirm, onClose }) => {
  const [perms, setPerms] = useState<boolean[]>(modeToPerms(currentMode));
  const mode = useMemo(() => permsToMode(perms), [perms]);
  const fileName = path.split('/').pop() || path;

  const toggle = (index: number) => {
    setPerms(prev => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', display: 'flex',
      justifyContent: 'center', alignItems: 'center', zIndex: 200,
    }} onClick={onClose}>
      <div style={{
        background: '#2d2d2d', border: '1px solid #555', borderRadius: 8,
        padding: 20, minWidth: 320,
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ color: '#cccccc', fontSize: 14, marginBottom: 12 }}>
          修改权限 - {fileName}
        </h3>

        <div style={{
          display: 'grid', gridTemplateColumns: '70px repeat(3, 1fr)',
          gap: '4px 8px', marginBottom: 16, fontSize: 12,
        }}>
          <div />
          {GROUPS.map(g => (
            <div key={g} style={{ color: '#808080', textAlign: 'center', fontWeight: 600 }}>{g}</div>
          ))}
          {PERM_BITS.map((p, pi) => (
            <React.Fragment key={pi}>
              <div>{p.label}</div>
              {[0, 1, 2].map(g => (
                <label key={g} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={perms[g * 3 + pi]}
                    onChange={() => toggle(g * 3 + pi)}
                    style={{ accentColor: '#569cd6' }}
                  />
                  {perms[g * 3 + pi] ? ['r', 'w', 'x'][pi] : '-'}
                </label>
              ))}
            </React.Fragment>
          ))}
        </div>

        <div style={{
          textAlign: 'center', fontFamily: 'monospace', fontSize: 16,
          color: '#4ec9b0', marginBottom: 12, letterSpacing: 2,
        }}>
          {formatPermission(mode)} ({mode.toString(8).padStart(3, '0')})
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{
            padding: '5px 16px', borderRadius: 4, border: '1px solid #555',
            background: '#3c3c3c', color: '#cccccc', cursor: 'pointer', fontSize: 12,
          }}>取消</button>
          <button onClick={() => onConfirm(mode)} style={{
            padding: '5px 16px', borderRadius: 4, border: '1px solid #1177bb',
            background: '#0e639c', color: '#ffffff', cursor: 'pointer', fontSize: 12,
          }}>确定</button>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: 创建 RemoteFileTree 组件**

创建 `src/components/RemoteFileTree.tsx`：

```tsx
import { FC, useEffect, useState, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import {
  remoteListDir, remoteCreateDir, remoteCreateFile, remoteRemove,
  remoteRename, remoteMove, remoteCopy, remoteChmod, remoteUpload,
  remoteDownload, writeToTerminal,
} from '../services/tauri';
import { isTextFile } from '../utils/fileExtensions';
import { ChmodDialog } from './ChmodDialog';
import type { RemoteFileEntry } from '../types';

interface RemoteFileTreeProps {
  terminalId: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}

function formatPermission(mode: number): string {
  const chars = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  const type = (mode & 0o170000) === 0o040000 ? 'd' : '-';
  return type +
    chars[(mode >> 6) & 7] +
    chars[(mode >> 3) & 7] +
    chars[mode & 7];
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '';
  const d = new Date(timestamp * 1000);
  return d.toLocaleDateString('zh-CN');
}

export const RemoteFileTree: FC<RemoteFileTreeProps> = ({ terminalId }) => {
  const [files, setFiles] = useState<RemoteFileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('/');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; type: 'file' | 'dir' | 'blank'; file?: RemoteFileEntry;
  } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null);
  const [createValue, setCreateValue] = useState('');
  const [chmodFile, setChmodFile] = useState<RemoteFileEntry | null>(null);
  const [transferProgress, setTransferProgress] = useState<{
    name: string; percent: number; direction: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const entries = await remoteListDir(terminalId, path);
      setFiles(entries);
      setCurrentPath(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [terminalId]);

  useEffect(() => {
    loadDir('/');
  }, [loadDir]);

  const breadcrumbParts = currentPath.split('/').filter(Boolean);

  const navigateTo = (path: string) => {
    loadDir(path);
  };

  const handleContextMenu = (e: React.MouseEvent, type: 'file' | 'dir' | 'blank', file?: RemoteFileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type, file });
  };

  const handleDoubleClick = (file: RemoteFileEntry) => {
    if (file.isDir) {
      loadDir(file.path);
    }
  };

  const handleOpenInTerminal = (file?: RemoteFileEntry) => {
    const path = file?.isDir ? file.path : (file?.path.substring(0, file.path.lastIndexOf('/')) || '/');
    writeToTerminal(terminalId, `cd '${path}'\r`);
    setContextMenu(null);
  };

  const handleDownload = async (file: RemoteFileEntry) => {
    setContextMenu(null);
    try {
      const downloadsDir = await invoke<string>('get_downloads_directory');
      const localPath = `${downloadsDir}\\${file.name}`;
      await remoteDownload(terminalId, file.path, localPath);
    } catch (err) {
      console.error('Download failed:', err);
    }
  };

  const handleDelete = async (file: RemoteFileEntry) => {
    setContextMenu(null);
    if (!confirm(`确定删除 "${file.name}"？`)) return;
    try {
      await remoteRemove(terminalId, file.path, file.isDir);
      loadDir(currentPath);
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleRename = async () => {
    if (!renaming || !renameValue.trim()) return;
    const file = files.find(f => f.path === renaming);
    if (!file) return;
    const parentDir = file.path.substring(0, file.path.lastIndexOf('/'));
    const newPath = `${parentDir}/${renameValue.trim()}`;
    try {
      await remoteRename(terminalId, file.path, newPath);
      loadDir(currentPath);
    } catch (err) {
      console.error('Rename failed:', err);
    }
    setRenaming(null);
    setContextMenu(null);
  };

  const handleCreate = async () => {
    if (!creating || !createValue.trim()) return;
    const newPath = currentPath === '/' ? `/${createValue.trim()}` : `${currentPath}/${createValue.trim()}`;
    try {
      if (creating === 'dir') {
        await remoteCreateDir(terminalId, newPath);
      } else {
        await remoteCreateFile(terminalId, newPath);
      }
      loadDir(currentPath);
    } catch (err) {
      console.error('Create failed:', err);
    }
    setCreating(null);
    setContextMenu(null);
  };

  const handleChmod = async (mode: number) => {
    if (!chmodFile) return;
    try {
      await remoteChmod(terminalId, chmodFile.path, mode);
      loadDir(currentPath);
    } catch (err) {
      console.error('Chmod failed:', err);
    }
    setChmodFile(null);
    setContextMenu(null);
  };

  const handleUpload = () => {
    setContextMenu(null);
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const remotePath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
      try {
        setTransferProgress({ name: file.name, percent: 0, direction: 'upload' });
        // Use Tauri dialog to get actual path, or use webkitRelativePath
        await remoteUpload(terminalId, (file as any).path || file.name, remotePath);
      } catch (err) {
        console.error('Upload failed:', err);
      }
    }
    setTransferProgress(null);
    loadDir(currentPath);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCopy = (file: RemoteFileEntry) => {
    useAppStore.getState().setRemoteClipboard({ items: [file.path], operation: 'copy' });
    setContextMenu(null);
  };

  const handleMove = (file: RemoteFileEntry) => {
    useAppStore.getState().setRemoteClipboard({ items: [file.path], operation: 'move' });
    setContextMenu(null);
  };

  const handlePaste = async () => {
    const clipboard = useAppStore.getState().remoteClipboard;
    if (!clipboard) return;
    setContextMenu(null);
    for (const item of clipboard.items) {
      const fileName = item.split('/').pop() || 'file';
      const destPath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;
      try {
        if (clipboard.operation === 'copy') {
          await remoteCopy(terminalId, item, destPath);
        } else {
          await remoteMove(terminalId, item, destPath);
        }
      } catch (err) {
        console.error('Paste failed:', err);
      }
    }
    useAppStore.getState().setRemoteClipboard(null);
    loadDir(currentPath);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Breadcrumb */}
      <div style={{
        padding: '6px 12px', fontSize: 12, color: '#808080',
        borderBottom: '1px solid var(--border-color, #3c3c3c)',
        display: 'flex', gap: 4, flexWrap: 'wrap',
      }}>
        <span onClick={() => navigateTo('/')} style={{ cursor: 'pointer', color: '#569cd6' }}>/</span>
        {breadcrumbParts.map((part, i) => {
          const path = '/' + breadcrumbParts.slice(0, i + 1).join('/');
          return (
            <span key={i}>
              <span style={{ color: '#555' }}> &gt; </span>
              <span onClick={() => navigateTo(path)} style={{ cursor: 'pointer', color: '#569cd6' }}>{part}</span>
            </span>
          );
        })}
      </div>

      {/* File list */}
      <div
        style={{ flex: 1, overflow: 'auto' }}
        onContextMenu={e => handleContextMenu(e, 'blank')}
      >
        {loading && <div style={{ padding: 12, color: '#808080', textAlign: 'center' }}>加载中...</div>}
        {error && <div style={{ padding: 12, color: '#f44747', textAlign: 'center' }}>{error}</div>}
        {!loading && !error && files.map(file => (
          <div
            key={file.path}
            style={{
              padding: '4px 12px 4px 16px',
              display: 'flex', alignItems: 'center', gap: 6,
              cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
            }}
            onClick={() => handleDoubleClick(file)}
            onContextMenu={e => handleContextMenu(e, file.isDir ? 'dir' : 'file', file)}
            onDoubleClick={() => handleDoubleClick(file)}
            onMouseEnter={e => (e.currentTarget.style.background = '#2a2d2e')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ width: 16, textAlign: 'center', flexShrink: 0 }}>
              {file.isDir ? '📁' : '📄'}
            </span>
            {renaming === file.path ? (
              <input
                autoFocus
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onBlur={handleRename}
                onKeyDown={e => e.key === 'Enter' && handleRename()}
                style={{
                  flex: 1, background: '#3c3c3c', color: '#cccccc',
                  border: '1px solid #569cd6', borderRadius: 2, padding: '1px 4px', fontSize: 12,
                }}
              />
            ) : (
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</span>
            )}
            <span style={{ color: '#808080', fontSize: 11, minWidth: 50, textAlign: 'right' }}>
              {file.isDir ? '' : formatSize(file.size)}
            </span>
            <span style={{ color: '#608b4e', fontSize: 11, minWidth: 70 }}>
              {formatPermission(file.permissions)}
            </span>
          </div>
        ))}

        {/* Creating new file/folder */}
        {creating && (
          <div style={{ padding: '4px 12px 4px 16px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ width: 16, textAlign: 'center' }}>{creating === 'dir' ? '📁' : '📄'}</span>
            <input
              autoFocus
              value={createValue}
              onChange={e => setCreateValue(e.target.value)}
              onBlur={() => { setCreating(null); }}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') setCreating(null);
              }}
              placeholder={creating === 'dir' ? '新文件夹名' : '新文件名'}
              style={{
                flex: 1, background: '#3c3c3c', color: '#cccccc',
                border: '1px solid #569cd6', borderRadius: 2, padding: '1px 4px', fontSize: 12,
              }}
            />
          </div>
        )}
      </div>

      {/* Transfer progress */}
      {transferProgress && (
        <div style={{
          padding: '6px 12px', background: '#1e1e1e',
          borderTop: '1px solid var(--border-color, #3c3c3c)', fontSize: 11,
        }}>
          <span>正在{transferProgress.direction === 'upload' ? '上传' : '下载'}: {transferProgress.name}</span>
          <span style={{ float: 'right' }}>{Math.round(transferProgress.percent)}%</span>
          <div style={{ width: '100%', height: 4, background: '#3c3c3c', borderRadius: 2, marginTop: 4 }}>
            <div style={{ height: '100%', background: '#569cd6', borderRadius: 2, width: `${transferProgress.percent}%` }} />
          </div>
        </div>
      )}

      {/* Hidden file input for upload */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

      {/* Context menu */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed', left: contextMenu.x, top: contextMenu.y,
            background: '#3c3c3c', border: '1px solid #555', borderRadius: 4,
            padding: '4px 0', minWidth: 200, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            zIndex: 100, fontSize: 12,
          }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.type !== 'blank' && (
            <div className="menu-item" onClick={() => handleOpenInTerminal(contextMenu.file)} style={{ padding: '5px 24px', cursor: 'pointer' }}>
              打开（在终端中 cd）
            </div>
          )}
          {contextMenu.file && isTextFile(contextMenu.file.name) && (
            <div className="menu-item" onClick={() => { setContextMenu(null); /* TODO: edit flow */ }} style={{ padding: '5px 24px', cursor: 'pointer' }}>
              用本地编辑器打开
            </div>
          )}
          {contextMenu.file && !contextMenu.file.isDir && (
            <div className="menu-item" onClick={() => handleDownload(contextMenu.file!)} style={{ padding: '5px 24px', cursor: 'pointer' }}>
              下载
            </div>
          )}
          <div style={{ height: 1, background: '#555', margin: '4px 0' }} />
          {contextMenu.type !== 'blank' && contextMenu.file && (
            <>
              <div onClick={() => { setRenaming(contextMenu.file!.path); setRenameValue(contextMenu.file!.name); setContextMenu(null); }} style={{ padding: '5px 24px', cursor: 'pointer' }}>重命名</div>
              <div onClick={() => handleCopy(contextMenu.file!)} style={{ padding: '5px 24px', cursor: 'pointer' }}>复制</div>
              <div onClick={() => handleMove(contextMenu.file!)} style={{ padding: '5px 24px', cursor: 'pointer' }}>移动到...</div>
              <div onClick={() => { setChmodFile(contextMenu.file!); setContextMenu(null); }} style={{ padding: '5px 24px', cursor: 'pointer' }}>修改权限</div>
            </>
          )}
          <div style={{ height: 1, background: '#555', margin: '4px 0' }} />
          <div onClick={() => { setCreating('file'); setCreateValue(''); setContextMenu(null); }} style={{ padding: '5px 24px', cursor: 'pointer' }}>新建文件</div>
          <div onClick={() => { setCreating('dir'); setCreateValue(''); setContextMenu(null); }} style={{ padding: '5px 24px', cursor: 'pointer' }}>新建文件夹</div>
          {contextMenu.type === 'blank' && (
            <>
              <div onClick={handleUpload} style={{ padding: '5px 24px', cursor: 'pointer' }}>上传文件</div>
            </>
          )}
          <div style={{ height: 1, background: '#555', margin: '4px 0' }} />
          {contextMenu.type !== 'blank' && contextMenu.file && (
            <div onClick={() => handleDelete(contextMenu.file!)} style={{ padding: '5px 24px', cursor: 'pointer', color: '#f44747' }}>删除</div>
          )}
          <div onClick={() => { loadDir(currentPath); setContextMenu(null); }} style={{ padding: '5px 24px', cursor: 'pointer' }}>刷新</div>
        </div>
      )}

      {/* Chmod dialog */}
      {chmodFile && (
        <ChmodDialog
          path={chmodFile.path}
          currentMode={chmodFile.permissions & 0o777}
          onConfirm={handleChmod}
          onClose={() => setChmodFile(null)}
        />
      )}
    </div>
  );
};
```

- [ ] **Step 3: 修改 FileTree 切换逻辑**

修改 `src/components/FileTree.tsx`：

1. 在文件顶部 import 区域添加：
   ```typescript
   import { RemoteFileTree } from './RemoteFileTree';
   ```

2. 在组件的 props 或内部获取当前活跃标签页的 terminalType
3. 在 return 语句中，根据当前标签页类型条件渲染：
   ```tsx
   // 在现有的文件树渲染之前添加条件判断
   const activeSession = useAppStore(s => s.sessions.find(s => s.id === s.activeTerminalId));
   const isSsh = activeSession?.profile?.terminalType === 'ssh';

   // 在 return 中
   if (isSsh && activeSession) {
     return <RemoteFileTree terminalId={activeSession.id} />;
   }
   // ... 原有的本地文件树渲染
   ```

- [ ] **Step 4: TypeScript 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 5: 提交**

```bash
git add src/components/RemoteFileTree.tsx src/components/ChmodDialog.tsx src/components/FileTree.tsx
git commit -m "[ssh] 添加远程文件树组件：目录浏览、右键菜单、面包屑导航"
```

---

## Task 8: 文件编辑集成

**Skills:** _none_

**Files:**
- Modify: `src/components/RemoteFileTree.tsx`

**Acceptance Criteria:**
- [ ] C1: 右键菜单"用本地编辑器打开"下载文件到临时目录并打开编辑器
- [ ] C2: 编辑器保存时自动上传回服务器
- [ ] C3: 上传成功显示 toast 通知
- [ ] C4: 上传失败保留本地文件不删除

- [ ] **Step 1: 添加编辑流程到 RemoteFileTree**

修改 `src/components/RemoteFileTree.tsx`：

1. 添加新的 import：
   ```typescript
   import { useAppStore } from '../stores/appStore';
   ```

2. 添加编辑处理函数：
   ```typescript
   const handleEdit = async (file: RemoteFileEntry) => {
     setContextMenu(null);
     try {
       // 1. Download to temp directory
       const baseTempDir = await getSshTempDirectory();
       const tempDir = `${baseTempDir}/${terminalId}`;
       await ensureDir(tempDir);
       const localPath = `${tempDir}/${file.name}`;
       await remoteDownload(terminalId, file.path, localPath);

       // 2. Open in editor (create a new editor session)
       useAppStore.getState().addSession({
         id: `editor-${Date.now()}`,
         profileId: '',
         name: file.name,
         type: 'editor',
         filePath: localPath,
         sshRemotePath: file.path,
         sshTerminalId: terminalId,
       });
     } catch (err) {
       console.error('Edit failed:', err);
     }
   };
   ```

3. 在右键菜单中将"用本地编辑器打开"的 onClick 替换为调用 `handleEdit`

- [ ] **Step 2: 添加保存后自动上传逻辑**

修改 `src/components/TextEditor.tsx`：

在现有的保存逻辑（writeFileContent）之后，添加 SSH 文件同步：

```typescript
// After writeFileContent succeeds:
if (session?.sshRemotePath && session?.sshTerminalId) {
  try {
    await remoteUpload(session.sshTerminalId, filePath, session.sshRemotePath);
    // Show toast
  } catch (err) {
    console.error('Auto-upload to server failed:', err);
    // Don't delete temp file on failure
  }
}
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add src/components/RemoteFileTree.tsx src/components/TextEditor.tsx
git commit -m "[ssh] 集成远程文件编辑：下载到临时目录、编辑器打开、保存自动上传"
```

---

## Task 9: 设置项集成

**Skills:** _none_

**Files:**
- Modify: `src/components/SettingsPage.tsx`
- Modify: `src-tauri/src/commands/settings.rs` (或新建辅助命令)

**Acceptance Criteria:**
- [ ] C1: 设置页面新增"SSH"分区，包含下载目录和监控刷新间隔设置
- [ ] C2: 下载目录默认为系统下载文件夹，可自定义
- [ ] C3: 监控刷新间隔可选 1/3/5/10 秒或关闭

- [ ] **Step 1: 添加设置字段**

修改 `src-tauri/src/models/settings.rs`（或对应的 settings 模型），在 `AppSettings` 中添加：

```rust
pub ssh_download_dir: Option<String>,
pub server_monitor_interval: Option<u32>,  // seconds, 0 = disabled
```

- [ ] **Step 2: 添加 get_downloads_directory 命令**

修改 `src-tauri/src/commands/settings.rs`，添加：

```rust
#[tauri::command]
pub fn get_downloads_directory() -> Result<String, String> {
    dirs::download_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Failed to get downloads directory".to_string())
}
```

注册到 lib.rs 的 invoke_handler 中。

- [ ] **Step 3: 修改 SettingsPage 添加 SSH 设置区**

修改 `src/components/SettingsPage.tsx`：

1. 在 SECTIONS 数组中添加 `{ id: 'ssh', label: 'SSH 设置' }`
2. 添加对应的设置区域渲染：
   - 下载目录：文本输入框 + "浏览"按钮（使用 `@tauri-apps/plugin-dialog` 的 `open({ directory: true })`）
   - 监控刷新间隔：下拉选择（1s/3s/5s/10s/关闭）

- [ ] **Step 4: TypeScript 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 5: 提交**

```bash
git add src/components/SettingsPage.tsx src-tauri/src/commands/settings.rs src-tauri/src/models/settings.rs src-tauri/src/lib.rs
git commit -m "[ssh] 添加 SSH 设置项：下载目录和监控刷新间隔"
```

---

## Task 10: 集成测试与端到端验证

**Skills:** _none_

**Files:** 无新增，纯验证

**Acceptance Criteria:**
- [ ] C1: Rust 后端 `cargo check` 编译通过
- [ ] C2: 前端 `npx tsc --noEmit` 类型检查通过
- [ ] C3: `npm run dev` 启动开发服务器无报错
- [ ] C4: 创建 SSH Profile 并启动终端，终端正常连接
- [ ] C5: SSH 终端激活时，左侧文件树切换为远程文件树
- [ ] C6: 远程文件树显示目录内容，双击可进入子目录
- [ ] C7: 右键菜单可用（创建/删除/重命名等操作）
- [ ] C8: 终端底部监控面板可折叠/展开，显示服务器数据
- [ ] C9: 文本文件右键"用本地编辑器打开"可正常编辑并保存回服务器

- [ ] **Step 1: 后端编译检查**

```bash
cd src-tauri && cargo check
```

Expected: 编译通过

- [ ] **Step 2: 前端类型检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 3: 启动开发服务器**

```bash
npm run tauri dev
```

Expected: 应用正常启动，无控制台报错

- [ ] **Step 4: 功能验证**

手动测试以下流程：
1. 创建一个新的 SSH Profile（填入有效的 SSH 主机信息）
2. 启动该 SSH 终端
3. 验证左侧文件树切换为远程文件树
4. 浏览远程目录，验证文件列表显示正确
5. 右键创建新文件夹，验证创建成功
6. 右键删除文件，验证删除成功
7. 展开底部监控面板，验证数据正常显示
8. 右键文本文件 → "用本地编辑器打开"，修改内容并保存
9. 验证文件已上传回服务器

- [ ] **Step 5: 提交最终修复（如有）**

```bash
git add -A
git commit -m "[ssh] 修复集成测试中发现的问题"
```
