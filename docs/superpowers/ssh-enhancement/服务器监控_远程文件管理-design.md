# SSH Enhancement: 服务器监控与远程文件管理

## 概述

为 SSH 终端连接新增两大功能模块：**服务器运行状态监控**和**远程文件管理**。引入 `ssh2-rs` Rust SSH 库，建立独立于 PTY 的 SSH 连接，提供 SFTP 文件操作和远程命令执行能力。

### 核心决策

| 决策项 | 方案 | 理由 |
|--------|------|------|
| SSH 库选择 | `ssh2-rs` | Rust 生态最成熟的 SSH 库，原生 SFTP 支持 |
| 连接策略 | 与终端 PTY 并行的独立连接 | 终端零改动，风险低，两个连接对服务器开销可忽略 |
| 连接时机 | 按需建立 | 用户首次访问远程文件或监控时才建立，节省资源 |
| 文件树切换 | SSH 标签页时替换本地文件树 | 交互直观，不增加 UI 复杂度 |
| 文件编辑 | 复用现有 `isTextFile()` + `TextEditor` | 已有 200+ 扩展名定义和 Monaco 编辑器 |

---

## 架构设计

```
┌─────────────────────────────────────────────────────────┐
│  前端 (React)                                           │
│  ┌───────────────┐  ┌───────────────┐  ┌─────────────┐ │
│  │ RemoteFileTree │  │ ServerMonitor │  │ TerminalInst │ │
│  │ (替换本地文件树)│  │ (终端底部折叠) │  │ (xterm.js)  │ │
│  └───────┬───────┘  └───────┬───────┘  └──────┬──────┘ │
│          │                  │                  │        │
├──────────┼──────────────────┼──────────────────┼────────┤
│          │   Tauri IPC      │                  │        │
│  ┌───────┴────────────┐     │   ┌──────────────┴──────┐ │
│  │ remote_file cmds    │     │   │ terminal_service    │ │
│  │ server_monitor cmds │     │   │ (ConPTY + 系统ssh)  │ │
│  └───────┬────────────┘     │   │ (现有不动)           │ │
│          │                  │   └─────────────────────┘ │
│  ┌───────┴──────────────────┴──┐                        │
│  │ ssh_session_service         │                        │
│  │ (ssh2-rs SFTP + remote exec)│                        │
│  └─────────────────────────────┘                        │
│                     Rust Backend                        │
└─────────────────────────────────────────────────────────┘
```

---

## 模块一：SSH Session Service

### 文件位置

`src-tauri/src/services/ssh_session_service.rs`（新增）

### 数据结构

```rust
pub struct SshSessionService {
    // key: terminal_id（复用现有终端 ID，终端关闭时自动清理连接）
    sessions: Mutex<HashMap<String, SshSession>>,
}

struct SshSession {
    session: ssh2::Session,       // SSH 连接
    sftp: ssh2::Sftp,             // SFTP 子系统
    host: String,
    port: u16,
    user: String,
}
```

### 连接生命周期

1. SSH 终端启动后，前端首次请求远程文件或监控数据时，`ssh_session_service` 自动建立 `ssh2-rs` 连接
2. 使用 Profile 中的认证信息（host/port/user/auth_type/key_path）——和终端共享同一套配置
3. 终端关闭时，通过 `terminal_closed` 事件清理对应的 SSH 连接
4. 连接断开时自动重试一次，失败则报错给前端

### SFTP 操作封装

```rust
impl SshSessionService {
    // 获取或创建连接
    async fn get_session(&self, terminal_id: &str, profile: &Profile) -> Result<&SshSession>;

    // 目录操作
    async fn list_dir(&self, terminal_id: &str, path: &str) -> Result<Vec<RemoteFileEntry>>;
    async fn mkdir(&self, terminal_id: &str, path: &str) -> Result<()>;

    // 文件操作
    async fn remove(&self, terminal_id: &str, path: &str) -> Result<()>;
    async fn rename(&self, terminal_id: &str, from: &str, to: &str) -> Result<()>;
    async fn chmod(&self, terminal_id: &str, path: &str, mode: u32) -> Result<()>;

    // 传输
    async fn upload(&self, terminal_id: &str, local: &str, remote: &str,
                     on_progress: impl Fn(u64, u64)) -> Result<()>;
    async fn download(&self, terminal_id: &str, remote: &str, local: &str,
                       on_progress: impl Fn(u64, u64)) -> Result<()>;

    // 远程命令执行（供监控和 mv/cp 用）
    async fn exec(&self, terminal_id: &str, cmd: &str) -> Result<String>;
}
```

### RemoteFileEntry

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,            // 完整路径
    pub is_dir: bool,
    pub size: u64,
    pub permissions: u32,        // Unix 权限位 (如 0o755)
    pub modified: i64,           // 修改时间戳
    pub owner: String,           // 文件所有者
    pub group: String,           // 文件所属组
}
```

### 依赖

`Cargo.toml` 新增：`ssh2 = "0.9"`

---

## 模块二：Server Monitoring

### 数据结构

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerStats {
    pub uptime: String,           // "15d 3h 42m"
    pub cpu_usage: f64,           // 百分比 0-100
    pub memory: MemoryStats,
    pub disk: Vec<DiskStats>,
    pub network: NetworkStats,
    pub timestamp: i64,           // 采集时间戳
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total: u64,               // 字节
    pub used: u64,
    pub available: u64,
    pub usage_percent: f64,
    pub swap_total: u64,
    pub swap_used: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    pub mount: String,            // "/"
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub usage_percent: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStats {
    pub rx_bytes: u64,            // 总接收
    pub tx_bytes: u64,            // 总发送
    pub rx_speed: f64,            // 接收速率 bytes/s（与上次采集的差值）
    pub tx_speed: f64,            // 发送速率 bytes/s
}
```

### 采集方式

通过 `ssh_session_service.exec()` 执行一条组合命令，单次 SSH 往返获取全部数据：

```bash
echo "===STATS===" && uptime -p && echo "===MEM===" && free -b && echo "===CPU===" && head -1 /proc/stat && echo "===DISK===" && df -B1 && echo "===NET===" && cat /proc/net/dev
```

Rust 端解析输出，组装成 `ServerStats`。网络速率通过缓存上一次的 `rx_bytes/tx_bytes` 和时间差计算。

### Tauri 命令

```rust
#[tauri::command]
async fn get_server_stats(app: AppHandle, terminal_id: String) -> Result<ServerStats, String>
```

---

## 模块三：Remote File Commands

### Tauri IPC 命令

```rust
// 目录浏览
#[tauri::command]
async fn remote_list_dir(terminal_id: String, path: String) -> Result<Vec<RemoteFileEntry>, String>

// 创建
#[tauri::command]
async fn remote_create_dir(terminal_id: String, path: String) -> Result<(), String>

#[tauri::command]
async fn remote_create_file(terminal_id: String, path: String) -> Result<(), String>

// 删除（文件和目录）
#[tauri::command]
async fn remote_remove(terminal_id: String, path: String, is_dir: bool) -> Result<(), String>

// 重命名
#[tauri::command]
async fn remote_rename(terminal_id: String, from: String, to: String) -> Result<(), String>

// 移动/复制
#[tauri::command]
async fn remote_move(terminal_id: String, from: String, to: String) -> Result<(), String>

#[tauri::command]
async fn remote_copy(terminal_id: String, from: String, to: String) -> Result<(), String>

// 权限
#[tauri::command]
async fn remote_chmod(terminal_id: String, path: String, mode: u32) -> Result<(), String>

// 上传（带进度）
#[tauri::command]
async fn remote_upload(terminal_id: String, local_path: String, remote_path: String,
                        window: Window) -> Result<(), String>

// 下载（带进度）
#[tauri::command]
async fn remote_download(terminal_id: String, remote_path: String, local_path: String,
                          window: Window) -> Result<(), String>
```

### 进度通知

上传/下载通过 Tauri 事件推送进度：

```rust
// 事件名: "remote_transfer_progress"
#[derive(Serialize)]
struct TransferProgress {
    terminal_id: String,
    transferred: u64,
    total: u64,
    percent: f64,
    direction: String,  // "upload" | "download"
}
```

### 移动/复制/递归删除实现

SFTP 协议不支持跨目录 move/copy，通过远程命令实现：

```rust
// 移动: exec("mv 'from' 'to'")
// 复制: exec("cp -r 'from' 'to'")
// 递归删除: exec("rm -rf 'path'")
// 路径参数做 shell 转义防注入
```

---

## 模块四：RemoteFileTree（前端）

### 与现有 FileTree 的关系

不是新建独立组件，而是在现有 `FileTree.tsx` 中根据当前标签页类型切换数据源：

- 当前标签页是本地终端 → 显示本地文件树（现有逻辑不变）
- 当前标签页是 SSH 终端 → 显示远程文件树（新逻辑）

### 面包屑导航

顶部显示当前路径，每级目录可点击跳转：

```
[ / ] > [ home ] > [ deploy ] > [ uploads ]
```

### 右键菜单

| 操作 | 目标 | 备注 |
|------|------|------|
| 打开（在终端中 cd） | 文件/文件夹 | 向终端写入 `cd path` |
| 下载 | 文件 | 下载到配置的本地目录 |
| 用本地编辑器打开 | 文本文件 | 复用 `isTextFile()` 判断，下载到临时目录 → 打开编辑器 → 保存时自动上传 |
| 重命名 | 文件/文件夹 | 行内编辑 |
| 复制 | 文件/文件夹 | 粘贴到目标路径 |
| 移动到... | 文件/文件夹 | 弹窗选择目标路径 |
| 修改权限 | 文件/文件夹 | 弹窗 chmod 对话框 |
| 删除 | 文件/文件夹 | 确认对话框 |
| 新建文件 | 空白区域 | 行内输入文件名 |
| 新建文件夹 | 空白区域 | 行内输入文件夹名 |
| 上传文件 | 空白/文件夹 | 打开本地文件选择器 |
| 上传文件夹 | 空白/文件夹 | 打开本地文件夹选择器 |
| 刷新 | 空白/文件夹 | 重新加载当前目录 |

### 拖拽上传

从本地资源管理器拖文件到远程文件树区域 → 上传到当前显示的目录或目标文件夹。

### 文件类型判断

复用 `src/utils/fileExtensions.ts` 中的 `isTextFile()` 函数判断是否显示"用本地编辑器打开"菜单项，`getMonacoLanguage()` 提供语法高亮映射。

---

## 模块五：ServerMonitor（前端）

### 位置

嵌入终端容器底部，位于 xterm.js 区域下方。

### 状态切换

**折叠状态（一行）**：

```
▶ CPU 23% | Mem 30% | Disk 30% | ↑1.2M ↓3.4M
```

**展开状态（3行）**：

```
▼ 服务器监控                          刷新间隔: 3s
Uptime: 15d 3h  |  CPU: 23.5%  |  Mem: 1.2G/4G
Disk: / 15G/50G (30%)  |  Net: ↑1.2 MB/s ↓3.4 MB/s
```

### 交互逻辑

- 点击折叠/展开箭头或摘要行切换状态
- 展开时启动定时器，折叠时停止
- 非 SSH 标签页时整个面板隐藏
- 终端关闭时面板消失，定时器清理
- 刷新间隔在展开状态旁显示下拉选择，可快速调整（1s / 3s / 5s / 10s / 关闭自动刷新）

### 错误处理

- 连接失败时面板显示"连接断开"，红色提示
- 单次采集失败不影响定时器，保持上一次数据
- 3 次连续失败后显示错误状态

---

## 模块六：文件传输与编辑

### 上传流程

```
用户操作                          系统行为
─────────                        ──────────
拖拽文件到远程文件树    →    检测目标目录 → 调用 remote_upload → 进度条 → 刷新目录
右键 → 上传文件         →    打开系统文件选择器 → 选择文件 → 上传 → 刷新目录
右键 → 上传文件夹       →    打开系统文件夹选择器 → 递归上传 → 刷新目录
```

**上传进度**：传输过程中在文件树底部显示进度条：

```
正在上传: config.yaml  [████████░░] 80% (12.3M/15.4M)
```

### 下载流程

```
右键 → 下载    →    下载到配置的本地目录 → 完成后 toast 通知
```

- 默认下载目录：系统"下载"文件夹（`%USERPROFILE%\Downloads`）
- 可在设置中自定义下载目录
- 下载完成显示 toast 通知，可点击"打开文件夹"定位

### 文本文件编辑流程

```
1. 右键 → "用本地编辑器打开"
2. 系统下载文件到临时目录: %TEMP%/TerminalBuddy/ssh_edit/{terminal_id}/{filename}
3. 用项目已集成的 TextEditor (Monaco) 打开该文件
4. 用户编辑...
5. 用户在编辑器中保存 (Ctrl+S)
6. 系统自动将修改后的文件上传回服务器（覆盖原路径）
7. 显示 toast: "已保存到远程服务器: /path/to/file"
```

- 编辑器关闭时清理临时文件
- 上传失败时提示用户，保留本地修改文件不删除
- 文件类型判断复用 `src/utils/fileExtensions.ts` 的 `isTextFile()`

---

## 设置项

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| SSH 下载目录 | `%USERPROFILE%\Downloads` | 远程文件下载保存位置 |
| 服务器监控刷新间隔 | 3 秒 | 可选 1/3/5/10 秒或关闭自动刷新 |

设置项在 `SettingsPage.tsx` 的 SSH 相关分区中新增。

---

## 新增依赖

### Rust

```toml
# Cargo.toml
ssh2 = "0.9"
```

### 前端

无新增依赖。复用现有 `@xterm/xterm`、`@monaco-editor/react` 组件。

---

## 新增文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src-tauri/src/services/ssh_session_service.rs` | Rust | SSH 连接管理、SFTP 操作、远程命令执行 |
| `src-tauri/src/commands/remote_file.rs` | Rust | 远程文件操作 Tauri 命令层 |
| `src-tauri/src/commands/server_monitor.rs` | Rust | 服务器监控 Tauri 命令层 |

## 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src-tauri/Cargo.toml` | 新增 `ssh2` 依赖 |
| `src-tauri/src/commands/mod.rs` | 注册新命令模块 |
| `src-tauri/src/lib.rs` | invoke_handler 注册新命令，managed state 注册 |
| `src/components/FileTree.tsx` | SSH 标签页时切换为远程文件树逻辑 |
| `src/components/TerminalPanel.tsx` | 嵌入 ServerMonitor 组件 |
| `src/services/tauri.ts` | 新增 invoke 包装函数 |
| `src/stores/appStore.ts` | 新增远程文件状态、监控数据状态 |
| `src/components/SettingsPage.tsx` | 新增 SSH 下载目录和监控刷新间隔设置 |
