# 会话共享设置实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TerminalBuddy 的 Web API 添加会话共享控制功能，解决 Web 端和 PC 端同时操作同一终端导致的排版冲突问题。

**Architecture:** 在 TerminalInstance 中添加 owner 字段标记终端来源（PC/Web），通过 settings 中的 web_api_share_sessions 控制是否共享。不共享模式下，Web 端只能看到自己创建的终端，PC 端可以看到 Web 端终端但不能操作。

**Tech Stack:** Rust (Tauri 2.x), React 18, TypeScript, Zustand, xterm.js

**Design Doc:** docs/superpowers/web-api/会话共享设置-design.md — source of truth for business requirements; per-task acceptance criteria are extracted from this document

---

## File Structure

### 后端（Rust）

| 文件 | 职责 | 操作 |
|------|------|------|
| `src-tauri/src/models/mod.rs` | 添加 TerminalOwner 枚举导出 | Modify |
| `src-tauri/src/models/settings.rs` | 添加 web_api_share_sessions 字段 | Modify |
| `src-tauri/src/commands/terminal.rs` | 修改 TerminalInstance 添加 owner 字段 | Modify |
| `src-tauri/src/web/handlers/terminal_handler.rs` | 终端列表过滤和创建时设置 owner | Modify |
| `src-tauri/src/web/ws.rs` | WebSocket 连接和输入权限检查 | Modify |
| `src-tauri/src/commands/settings.rs` | 设置相关的 Tauri 命令 | Modify |

### 前端（TypeScript）

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/components/SettingsPage.tsx` | 添加共享会话窗口设置项 | Modify |
| `src/types/index.ts` | TerminalInfo 添加 owner 字段 | Modify |
| `src/services/tauri.ts` | 更新 API 调用 | Modify |
| `web/src/stores/appStore.ts` | 会话状态添加 owner 字段 | Modify |
| `web/src/components/ProfileList.tsx` | 显示终端来源标签 | Modify |
| `web/src/hooks/useTerminal.ts` | 处理 WebSocket 错误消息 | Modify |
| `web/src/api/terminals.ts` | 更新终端 API 类型 | Modify |

---

### Task 1: 后端数据模型 - TerminalOwner 枚举

**Skills:** _none_

**Files:**
- Modify: `src-tauri/src/models/mod.rs`
- Create: `src-tauri/src/models/terminal_owner.rs`

**Acceptance Criteria:**

- [ ] C1: TerminalOwner 枚举定义包含 Pc 和 Web 两个变体
- [ ] C2: 枚举支持 serde 序列化/反序列化，使用 camelCase 命名
- [ ] C3: 枚举支持 PartialEq 比较

- [ ] **Step 1: 创建 terminal_owner.rs 文件**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalOwner {
    Pc,
    Web,
}
```

- [ ] **Step 2: 在 mod.rs 中添加模块导出**

修改 `src-tauri/src/models/mod.rs`：
```rust
pub mod profile;
pub mod settings;
pub mod ssh_types;
pub mod terminal_owner;  // 新增
pub mod theme;
pub mod web_api;
pub mod workspace;
pub use profile::*;
pub use settings::*;
pub use ssh_types::*;
pub use terminal_owner::*;  // 新增
pub use theme::*;
pub use web_api::*;
pub use workspace::*;
```

- [ ] **Step 3: 验证编译**

Run: `cd terminal-buddy/src-tauri && cargo check`
Expected: 编译成功，无错误

- [ ] **Step 4: Commit**

```bash
git add terminal-buddy/src-tauri/src/models/terminal_owner.rs terminal-buddy/src-tauri/src/models/mod.rs
git commit -m "[model] 添加 TerminalOwner 枚举用于标识终端创建来源"
```

---

### Task 2: 后端数据模型 - AppSettings 添加设置项

**Skills:** _none_

**Files:**
- Modify: `src-tauri/src/models/settings.rs`

**Acceptance Criteria:**

- [ ] C1: AppSettings 结构体包含 web_api_share_sessions 字段
- [ ] C2: 字段类型为 bool，默认值为 false
- [ ] C3: 使用 #[serde(default)] 属性确保向后兼容

- [ ] **Step 1: 修改 settings.rs 添加字段**

修改 `src-tauri/src/models/settings.rs`：
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_close_behavior")]
    pub close_behavior: CloseBehavior,
    #[serde(default)]
    pub data_path: Option<String>,
    #[serde(default = "default_tab_sidebar_width")]
    pub tab_sidebar_width: u32,
    #[serde(default = "default_enable_tab_navigation")]
    pub enable_tab_navigation: bool,
    #[serde(default = "default_single_instance")]
    pub single_instance: bool,
    #[serde(default = "default_web_api_enabled")]
    pub web_api_enabled: bool,
    #[serde(default = "default_web_api_port")]
    pub web_api_port: u16,
    #[serde(default = "default_web_api_username")]
    pub web_api_username: String,
    #[serde(default = "default_web_api_password_hash")]
    pub web_api_password_hash: String,
    #[serde(default)]
    pub ssh_download_dir: Option<String>,
    #[serde(default = "default_server_monitor_interval")]
    pub server_monitor_interval: u32,
    #[serde(default)]  // 新增
    pub web_api_share_sessions: bool,  // 新增，默认 false
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Exit,
            data_path: None,
            tab_sidebar_width: 200,
            enable_tab_navigation: true,
            single_instance: true,
            web_api_enabled: false,
            web_api_port: 9600,
            web_api_username: "admin".to_string(),
            web_api_password_hash: String::new(),
            ssh_download_dir: None,
            server_monitor_interval: 3,
            web_api_share_sessions: false,  // 新增
        }
    }
}
```

- [ ] **Step 2: 验证编译**

Run: `cd terminal-buddy/src-tauri && cargo check`
Expected: 编译成功，无错误

- [ ] **Step 3: Commit**

```bash
git add terminal-buddy/src-tauri/src/models/settings.rs
git commit -m "[settings] 添加 web_api_share_sessions 设置项，默认 false"
```

---

### Task 3: 后端数据模型 - TerminalInstance 添加 owner 字段

**Skills:** _none_

**Files:**
- Modify: `src-tauri/src/commands/terminal.rs`

**Acceptance Criteria:**

- [ ] C1: TerminalInstance 结构体包含 owner 字段，类型为 TerminalOwner
- [ ] C2: create_terminal 方法接受 owner 参数
- [ ] C3: create_blank_terminal 方法接受 owner 参数
- [ ] C4: TerminalInfo 结构体包含 owner 字段

- [ ] **Step 1: 修改 TerminalInstance 结构体**

修改 `src-tauri/src/commands/terminal.rs`：
```rust
use crate::models::TerminalOwner;

pub struct TerminalInstance {
    pub id: String,
    pub profile_id: String,
    pub owner: TerminalOwner,  // 新增
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    pub writer: Option<Box<dyn Write + Send>>,
    pub output_buffer: Arc<Mutex<VecDeque<Arc<str>>>>,
    current_rows: u16,
    current_cols: u16,
}
```

- [ ] **Step 2: 修改 create_terminal 方法签名**

修改 `create_terminal` 方法，添加 owner 参数：
```rust
pub fn create_terminal(
    &self,
    profile_id: &str,
    extra_startup_params: Option<&str>,
    initial_rows: u16,
    initial_cols: u16,
    app: AppHandle,
    owner: TerminalOwner,  // 新增参数
) -> Result<String, String> {
    // ... 现有代码 ...
    
    let instance = TerminalInstance {
        id: terminal_id.clone(),
        profile_id: profile_id.to_string(),
        owner,  // 新增
        child,
        master,
        writer: Some(writer),
        output_buffer,
        current_rows: init_rows,
        current_cols: init_cols,
    };
    
    // ... 现有代码 ...
}
```

- [ ] **Step 3: 更新所有 create_terminal 调用点**

搜索所有调用 `create_terminal` 的地方，添加 `TerminalOwner::Pc` 参数（PC 端调用）。

Run: `cd terminal-buddy/src-tauri && grep -rn "create_terminal" --include="*.rs"`
Expected: 找到所有调用点，添加 owner 参数

- [ ] **Step 4: 修改 web_api.rs 中的 TerminalInfo**

修改 `src-tauri/src/models/web_api.rs`：
```rust
use crate::models::TerminalOwner;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub terminal_type: String,
    pub owner: TerminalOwner,  // 新增
}
```

- [ ] **Step 5: 更新 terminal_handler.rs 中的 TerminalInfo 构造**

修改 `src-tauri/src/web/handlers/terminal_handler.rs`，在构造 TerminalInfo 时添加 owner 字段。

- [ ] **Step 6: 验证编译**

Run: `cd terminal-buddy/src-tauri && cargo check`
Expected: 编译成功，无错误

- [ ] **Step 7: Commit**

```bash
git add terminal-buddy/src-tauri/src/commands/terminal.rs terminal-buddy/src-tauri/src/models/web_api.rs terminal-buddy/src-tauri/src/web/handlers/terminal_handler.rs
git commit -m "[terminal] 添加 owner 字段标识终端创建来源"
```

---

### Task 4: 后端 API - 终端列表过滤

**Skills:** _none_

**Files:**
- Modify: `src-tauri/src/web/handlers/terminal_handler.rs`

**Acceptance Criteria:**

- [ ] C1: GET /api/terminals 在共享模式下返回所有终端
- [ ] C2: GET /api/terminals 在不共享模式下只返回 owner=Web 的终端
- [ ] C3: POST /api/terminals 创建终端时设置 owner=Web
- [ ] C4: TerminalInfo 包含 owner 字段

- [ ] **Step 1: 修改 list 函数添加过滤逻辑**

修改 `src-tauri/src/web/handlers/terminal_handler.rs`：
```rust
use crate::models::TerminalOwner;
use crate::services::SettingsService;

pub async fn list(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<TerminalInfo>>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();
    
    // 获取设置
    let settings = SettingsService::get_settings().unwrap_or_default();
    
    // Collect IDs while holding lock, then release before reading profiles
    let instance_ids: Vec<(String, String, TerminalOwner)> = {
        let instances = ts.instances.lock().unwrap();
        instances.values()
            .filter(|inst| {
                // 共享模式：返回所有终端
                // 不共享模式：只返回 Web 端创建的终端
                settings.web_api_share_sessions || inst.owner == TerminalOwner::Web
            })
            .map(|inst| (inst.id.clone(), inst.profile_id.clone(), inst.owner.clone()))
            .collect()
    };
    
    let terminals: Vec<TerminalInfo> = instance_ids.into_iter().map(|(id, profile_id, owner)| {
        let profile = ProfileService::get_profile(&profile_id).ok();
        TerminalInfo {
            id,
            profile_id: profile_id.clone(),
            profile_name: profile.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
            terminal_type: profile.as_ref().map(|p| p.terminal_type.clone()).unwrap_or_default(),
            owner,
        }
    }).collect();
    
    Ok(Json(terminals))
}
```

- [ ] **Step 2: 修改 start 函数设置 owner**

修改 `src-tauri/src/web/handlers/terminal_handler.rs`：
```rust
pub async fn start(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<StartTerminalRequest>,
) -> Result<Json<TerminalInfo>, ApiError> {
    let ts = state.app_handle.state::<TerminalService>();

    // 获取设置
    let settings = SettingsService::get_settings().unwrap_or_default();

    // Reuse existing terminal for the same profile if already running
    {
        let instances = ts.instances.lock().unwrap();
        for inst in instances.values() {
            if inst.profile_id == req.profile_id {
                // 不共享模式下，只能复用 Web 端创建的终端
                if !settings.web_api_share_sessions && inst.owner != TerminalOwner::Web {
                    continue;
                }
                
                let profile = ProfileService::get_profile(&req.profile_id)
                    .map_err(|e| ApiError::Internal(e))?;
                let info = TerminalInfo {
                    id: inst.id.clone(),
                    profile_id: req.profile_id,
                    profile_name: profile.name,
                    terminal_type: profile.terminal_type,
                    owner: inst.owner.clone(),
                };
                let _ = state.app_handle.emit("terminal-created", info.clone());
                return Ok(Json(info));
            }
        }
    }

    let terminal_id = ts.create_terminal(
        &req.profile_id,
        None,
        0,
        0,
        state.app_handle.clone(),
        TerminalOwner::Web,  // Web 端创建的终端
    ).map_err(|e| ApiError::Internal(e))?;
    
    let profile = ProfileService::get_profile(&req.profile_id)
        .map_err(|e| ApiError::Internal(e))?;
    let info = TerminalInfo {
        id: terminal_id,
        profile_id: req.profile_id,
        profile_name: profile.name,
        terminal_type: profile.terminal_type,
        owner: TerminalOwner::Web,
    };
    let _ = state.app_handle.emit("terminal-created", info.clone());
    Ok(Json(info))
}
```

- [ ] **Step 3: 验证编译**

Run: `cd terminal-buddy/src-tauri && cargo check`
Expected: 编译成功，无错误

- [ ] **Step 4: Commit**

```bash
git add terminal-buddy/src-tauri/src/web/handlers/terminal_handler.rs
git commit -m "[web] 终端列表根据共享设置过滤，Web 端创建终端标记 owner=Web"
```

---

### Task 5: 后端 API - WebSocket 权限控制

**Skills:** _none_

**Files:**
- Modify: `src-tauri/src/web/ws.rs`

**Acceptance Criteria:**

- [ ] C1: 不共享模式下，Web 端不能连接 PC 端创建的终端
- [ ] C2: 不共享模式下，PC 端不能输入 Web 端创建的终端
- [ ] C3: 共享模式下，所有连接和操作都允许
- [ ] C4: 权限不足时返回错误消息

- [ ] **Step 1: 修改 ws_handler 添加权限检查**

修改 `src-tauri/src/web/ws.rs`：
```rust
use crate::models::TerminalOwner;
use crate::services::SettingsService;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(terminal_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let token = params.get("token").ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let _claims = verify_token(token, &state.jwt_secret)?;
    
    // 权限检查：不共享模式下，Web 端不能连接 PC 端的终端
    let settings = SettingsService::get_settings().unwrap_or_default();
    if !settings.web_api_share_sessions {
        let ts = state.app_handle.state::<TerminalService>();
        let instances = ts.instances.lock().unwrap();
        if let Some(terminal) = instances.get(&terminal_id) {
            if terminal.owner == TerminalOwner::Pc {
                return Err(axum::http::StatusCode::FORBIDDEN);
            }
        }
    }
    
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, terminal_id, state, true)))
}
```

- [ ] **Step 2: 修改 handle_socket 添加 is_web_client 参数**

```rust
async fn handle_socket(
    socket: WebSocket,
    terminal_id: String,
    state: AppState,
    is_web_client: bool,  // 新增参数
) {
    // ... 现有代码 ...
}
```

- [ ] **Step 3: 修改输入处理添加权限检查**

```rust
// Forward WebSocket input to PTY
let app = state.app_handle.clone();
let tid = terminal_id.clone();
let recv_task = tokio::spawn(async move {
    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(cmd) = serde_json::from_str::<WsClientMessage>(&text) {
                    match cmd {
                        WsClientMessage::Input { data } => {
                            // 权限检查
                            let settings = SettingsService::get_settings().unwrap_or_default();
                            if !settings.web_api_share_sessions && !is_web_client {
                                let ts = app.state::<TerminalService>();
                                let instances = ts.instances.lock().unwrap();
                                if let Some(terminal) = instances.get(&tid) {
                                    if terminal.owner == TerminalOwner::Web {
                                        // PC 端不能输入 Web 端的终端
                                        let error_msg = serde_json::to_string(
                                            &WsServerMessage::Error {
                                                message: "终端由 Web 端管理，PC 端只读".to_string()
                                            }
                                        ).unwrap_or_default();
                                        let _ = ws_sender.send(Message::Text(error_msg.into())).await;
                                        continue;
                                    }
                                }
                            }
                            
                            let ts = app.state::<TerminalService>();
                            let _ = ts.write_to_terminal(&tid, &data);
                        }
                        WsClientMessage::Resize { cols, rows } => {
                            // 权限检查
                            let settings = SettingsService::get_settings().unwrap_or_default();
                            if !settings.web_api_share_sessions && !is_web_client {
                                let ts = app.state::<TerminalService>();
                                let instances = ts.instances.lock().unwrap();
                                if let Some(terminal) = instances.get(&tid) {
                                    if terminal.owner == TerminalOwner::Web {
                                        // PC 端不能 resize Web 端的终端
                                        continue;
                                    }
                                }
                            }
                            
                            let ts = app.state::<TerminalService>();
                            let _ = ts.resize_terminal(&tid, rows, cols, false);
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
});
```

- [ ] **Step 4: 添加 WsServerMessage::Error 变体**

修改 `src-tauri/src/models/web_api.rs`：
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WsServerMessage {
    Output { data: String },
    Exited { code: i32 },
    Error { message: String },  // 新增
}
```

- [ ] **Step 5: 验证编译**

Run: `cd terminal-buddy/src-tauri && cargo check`
Expected: 编译成功，无错误

- [ ] **Step 6: Commit**

```bash
git add terminal-buddy/src-tauri/src/web/ws.rs terminal-buddy/src-tauri/src/models/web_api.rs
git commit -m "[web] WebSocket 连接和输入权限检查，支持会话隔离"
```

---

### Task 6: 后端 - PC 端 Tauri 命令权限控制

**Skills:** _none_

**Files:**
- Modify: `src-tauri/src/commands/terminal.rs`

**Acceptance Criteria:**

- [ ] C1: 不共享模式下，PC 端不能输入 Web 端创建的终端
- [ ] C2: 不共享模式下，PC 端不能 resize Web 端创建的终端
- [ ] C3: 权限不足时返回错误消息
- [ ] C4: 共享模式下所有操作都允许

- [ ] **Step 1: 修改 write_to_terminal 命令**

修改 `src-tauri/src/commands/terminal.rs`：
```rust
use crate::models::TerminalOwner;
use crate::services::SettingsService;

#[command]
pub fn write_to_terminal(
    state: State<'_, TerminalService>,
    id: String,
    data: String,
) -> Result<(), String> {
    // 权限检查
    let settings = SettingsService::get_settings().unwrap_or_default();
    if !settings.web_api_share_sessions {
        let instances = state.instances.lock().unwrap();
        if let Some(terminal) = instances.get(&id) {
            if terminal.owner == TerminalOwner::Web {
                return Err("终端由 Web 端管理，PC 端只读".to_string());
            }
        }
    }
    
    state.write_to_terminal(&id, &data)
}
```

- [ ] **Step 2: 修改 resize_terminal 命令**

```rust
#[command]
pub fn resize_terminal(
    state: State<'_, TerminalService>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    // 权限检查
    let settings = SettingsService::get_settings().unwrap_or_default();
    if !settings.web_api_share_sessions {
        let instances = state.instances.lock().unwrap();
        if let Some(terminal) = instances.get(&id) {
            if terminal.owner == TerminalOwner::Web {
                return Err("终端由 Web 端管理，PC 端只读".to_string());
            }
        }
    }
    
    state.resize_terminal(&id, rows, cols, true)
}
```

- [ ] **Step 3: 验证编译**

Run: `cd terminal-buddy/src-tauri && cargo check`
Expected: 编译成功，无错误

- [ ] **Step 4: Commit**

```bash
git add terminal-buddy/src-tauri/src/commands/terminal.rs
git commit -m "[terminal] PC 端命令添加权限检查，不共享模式下不能操作 Web 端终端"
```

---

### Task 7: 前端 PC - 设置页面添加共享选项

**Skills:** _none_

**Files:**
- Modify: `src/components/SettingsPage.tsx`

**Acceptance Criteria:**

- [ ] C1: 设置页面"Web 管理"部分显示"共享会话窗口"开关
- [ ] C2: 开关状态与 settings.webApiShareSessions 绑定
- [ ] C3: 提示文字说明开启/关闭的行为差异
- [ ] C4: 修改设置后保存到后端

- [ ] **Step 1: 查找 SettingsPage.tsx 中的 Web 管理部分**

Run: `grep -n "web" terminal-buddy/src/components/SettingsPage.tsx`
Expected: 找到 Web 管理相关的代码位置

- [ ] **Step 2: 添加共享会话窗口设置项**

在 Web 管理部分添加：
```tsx
<div className="setting-item">
    <label>共享会话窗口</label>
    <Switch
        checked={settings.webApiShareSessions ?? false}
        onChange={(checked) => updateSettings({ webApiShareSessions: checked })}
    />
    <span className="setting-hint">
        开启后 Web 端和 PC 端可以看到并操作所有终端；关闭后 Web 端只能看到自己创建的终端，PC 端可以看到 Web 端创建的终端但不能操作
    </span>
</div>
```

- [ ] **Step 3: 验证前端编译**

Run: `cd terminal-buddy && npm run build`
Expected: 编译成功，无错误

- [ ] **Step 4: Commit**

```bash
git add terminal-buddy/src/components/SettingsPage.tsx
git commit -m "[settings] 添加共享会话窗口设置项 UI"
```

---

### Task 8: 前端 PC - TerminalInstance 显示终端来源

**Skills:** _none_

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/tauri.ts`
- Modify: `src/components/TerminalPanel.tsx` 或相关组件

**Acceptance Criteria:**

- [ ] C1: TerminalInfo 类型包含 owner 字段
- [ ] C2: Web 端创建的终端显示"Web"标签
- [ ] C3: 不共享模式下，Web 端创建的终端输入框禁用
- [ ] C4: 共享模式下所有终端都可操作

- [ ] **Step 1: 更新 TerminalInfo 类型**

修改 `src/types/index.ts`：
```typescript
export interface TerminalInfo {
    id: string;
    profileId: string;
    profileName: string;
    terminalType: string;
    owner: 'pc' | 'web';  // 新增
}
```

- [ ] **Step 2: 更新 tauri.ts 中的类型**

确保 `src/services/tauri.ts` 中的 `listTerminals` 返回类型包含 owner 字段。

- [ ] **Step 3: 在终端标签上显示来源**

在显示终端的地方，根据 owner 字段显示标签：
```tsx
{terminal.owner === 'web' && (
    <span className="terminal-owner-badge">Web</span>
)}
```

- [ ] **Step 4: 不共享模式下禁用 Web 端终端输入**

在终端组件中，根据设置和 owner 决定是否禁用输入：
```tsx
const isReadOnly = !settings.webApiShareSessions && terminal.owner === 'web';

<TerminalInstance
    // ... 其他 props
    readOnly={isReadOnly}
/>
```

- [ ] **Step 5: 验证前端编译**

Run: `cd terminal-buddy && npm run build`
Expected: 编译成功，无错误

- [ ] **Step 6: Commit**

```bash
git add terminal-buddy/src/types/index.ts terminal-buddy/src/services/tauri.ts
git commit -m "[terminal] 显示终端来源标签，不共享模式下禁用 Web 端终端输入"
```

---

### Task 9: 前端 Web - 会话状态添加 owner 字段

**Skills:** _none_

**Files:**
- Modify: `web/src/stores/appStore.ts`
- Modify: `web/src/api/terminals.ts`

**Acceptance Criteria:**

- [ ] C1: WebTerminalSession 接口包含 owner 字段
- [ ] C2: 终端列表 API 返回包含 owner 字段
- [ ] C3: 创建终端时设置 owner='web'

- [ ] **Step 1: 更新 WebTerminalSession 类型**

修改 `web/src/stores/appStore.ts`：
```typescript
interface WebTerminalSession {
    id: string;
    profileId: string;
    profileName: string;
    terminalType: string;
    owner: 'pc' | 'web';  // 新增
    // ... 其他字段
}
```

- [ ] **Step 2: 更新终端 API 类型**

修改 `web/src/api/terminals.ts`：
```typescript
export interface TerminalInfo {
    id: string;
    profileId: string;
    profileName: string;
    terminalType: string;
    owner: 'pc' | 'web';  // 新增
}
```

- [ ] **Step 3: 更新 listTerminals 处理**

确保 `listTerminals` 返回的数据包含 owner 字段。

- [ ] **Step 4: 更新 startTerminal 处理**

确保 `startTerminal` 返回的数据包含 owner 字段，并设置为 'web'。

- [ ] **Step 5: 验证前端编译**

Run: `cd terminal-buddy/web && npm run build`
Expected: 编译成功，无错误

- [ ] **Step 6: Commit**

```bash
git add terminal-buddy/web/src/stores/appStore.ts terminal-buddy/web/src/api/terminals.ts
git commit -m "[web] 会话状态添加 owner 字段"
```

---

### Task 10: 前端 Web - ProfileList 显示终端来源

**Skills:** _none_

**Files:**
- Modify: `web/src/components/ProfileList.tsx`

**Acceptance Criteria:**

- [ ] C1: "运行中"区域显示终端来源标签
- [ ] C2: PC 端创建的终端显示"PC"标签（不共享模式下不显示）
- [ ] C3: Web 端创建的终端显示"Web"标签

- [ ] **Step 1: 修改 ProfileList.tsx**

在显示运行中终端的地方添加来源标签：
```tsx
{terminals.map(terminal => (
    <div key={terminal.id} className="terminal-item">
        <span className="terminal-name">{terminal.profileName}</span>
        <span className={`terminal-owner-badge ${terminal.owner}`}>
            {terminal.owner === 'pc' ? 'PC' : 'Web'}
        </span>
    </div>
))}
```

- [ ] **Step 2: 添加样式**

在 CSS 中添加 `.terminal-owner-badge` 样式。

- [ ] **Step 3: 验证前端编译**

Run: `cd terminal-buddy/web && npm run build`
Expected: 编译成功，无错误

- [ ] **Step 4: Commit**

```bash
git add terminal-buddy/web/src/components/ProfileList.tsx
git commit -m "[web] ProfileList 显示终端来源标签"
```

---

### Task 11: 前端 Web - WebSocket 错误处理

**Skills:** _none_

**Files:**
- Modify: `web/src/hooks/useTerminal.ts`

**Acceptance Criteria:**

- [ ] C1: WebSocket 接收 error 类型消息时显示提示
- [ ] C2: 错误消息友好，说明原因
- [ ] C3: 不影响其他消息的正常处理

- [ ] **Step 1: 修改 useTerminal.ts 处理错误消息**

修改 `web/src/hooks/useTerminal.ts`：
```typescript
const handleWsMessage = (event: MessageEvent) => {
    try {
        const msg = JSON.parse(event.data);
        
        switch (msg.type) {
            case 'output':
                // 处理输出
                break;
            case 'exited':
                // 处理退出
                break;
            case 'error':
                // 新增：处理错误消息
                showToast(msg.message, 'error');
                break;
            default:
                break;
        }
    } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
    }
};
```

- [ ] **Step 2: 验证前端编译**

Run: `cd terminal-buddy/web && npm run build`
Expected: 编译成功，无错误

- [ ] **Step 3: Commit**

```bash
git add terminal-buddy/web/src/hooks/useTerminal.ts
git commit -m "[web] WebSocket 添加错误消息处理"
```

---

### Task 12: 测试验证

**Skills:** _none_

**Files:** 无

**Acceptance Criteria:**

- [ ] C1: 共享模式开启时，Web 端和 PC 端可以互相看到和操作所有终端
- [ ] C2: 共享模式关闭时，Web 端看不到 PC 端创建的终端
- [ ] C3: 共享模式关闭时，PC 端可以看到 Web 端创建的终端但不能操作
- [ ] C4: 设置修改后热生效，不需要重启应用

- [ ] **Step 1: 测试共享模式开启**

1. 启动应用，开启 Web API
2. 在设置中开启"共享会话窗口"
3. 在 PC 端创建一个终端
4. 在 Web 端查看运行中终端，应该能看到 PC 端创建的终端
5. 在 Web 端尝试操作该终端，应该可以正常输入

- [ ] **Step 2: 测试共享模式关闭**

1. 在设置中关闭"共享会话窗口"
2. 在 PC 端创建一个终端
3. 在 Web 端查看运行中终端，应该看不到 PC 端创建的终端
4. 在 Web 端创建一个终端
5. 在 PC 端查看运行中终端，应该能看到 Web 端创建的终端
6. 在 PC 端尝试操作该终端，应该提示"终端由 Web 端管理，PC 端只读"

- [ ] **Step 3: 测试热生效**

1. 在共享模式下创建终端
2. 切换到不共享模式
3. 尝试操作之前创建的终端，应该根据新设置判断权限

- [ ] **Step 4: 测试错误处理**

1. 在不共享模式下，Web 端尝试连接 PC 端终端
2. 应该返回 HTTP 403 错误
3. 在不共享模式下，PC 端尝试输入 Web 端终端
4. 应该显示错误提示"终端由 Web 端管理，PC 端只读"

- [ ] **Step 5: Commit 测试结果**

```bash
git add .
git commit -m "[test] 完成会话共享设置功能测试"
```

---

## Implementation Order

建议按以下顺序实现：

1. **Task 1-3**: 后端数据模型（TerminalOwner、AppSettings、TerminalInstance）
2. **Task 4-6**: 后端 API 权限控制（终端列表过滤、WebSocket 权限、PC 端命令权限）
3. **Task 7-8**: PC 前端（设置页面、终端来源显示）
4. **Task 9-11**: Web 前端（会话状态、ProfileList、错误处理）
5. **Task 12**: 测试验证

每个 Task 完成后都应该进行编译验证和提交，确保代码的可追溯性。
