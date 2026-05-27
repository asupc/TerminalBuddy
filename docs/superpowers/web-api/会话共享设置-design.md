# 会话共享设置设计文档

## 概述

为 TerminalBuddy 的 Web API 添加会话共享控制功能，解决 Web 端和 PC 端同时操作同一终端导致的排版冲突问题。

## 需求背景

当前 Web 端和 PC 端完全共享同一套终端实例，双方都可以查看和操作所有终端。这导致以下问题：
- Web 端的终端排版可能被 PC 端的操作（输入、resize）打乱
- 无法实现 Web 端独立的终端管理场景
- 多客户端同时操作可能导致显示混乱

## 功能需求

### 新增设置项

在 `settings.json` 中添加：
```json
{
  "webApiShareSessions": false
}
```

- **字段名**：`web_api_share_sessions`
- **类型**：`bool`
- **默认值**：`false`（不共享）
- **说明**：控制 Web 端和 PC 端的终端会话是否共享

### 行为矩阵

| 设置值 | 终端创建者 | Web 端权限 | PC 端权限 |
|--------|------------|------------|------------|
| `true`（共享） | 任意 | 完整管理 | 完整管理 |
| `false`（不共享） | PC 端 | 不可见 | 完整管理 |
| `false`（不共享） | Web 端 | 完整管理 | 只读（只能查看输出） |

### 热生效

设置变更后立即生效，不需要重启应用。已建立的 WebSocket 连接继续有效，新的连接和操作根据新设置判断权限。

## 技术设计

### 1. 数据模型变更

#### 新增枚举：TerminalOwner

**文件**：`src-tauri/src/models/mod.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalOwner {
    Pc,
    Web,
}
```

#### 修改 TerminalInstance

**文件**：`src-tauri/src/commands/terminal.rs`

```rust
pub struct TerminalInstance {
    // ... 现有字段 ...
    pub owner: TerminalOwner,  // 新增
}
```

在创建终端时设置 owner：
- PC 端通过 Tauri 命令创建：`owner: TerminalOwner::Pc`
- Web 端通过 HTTP API 创建：`owner: TerminalOwner::Web`

### 2. 设置项变更

#### AppSettings 新增字段

**文件**：`src-tauri/src/models/settings.rs`

```rust
pub struct AppSettings {
    // ... 现有字段 ...
    #[serde(default)]
    pub web_api_share_sessions: bool,  // 默认 false
}
```

#### 前端设置页面

**文件**：`src/components/SettingsPage.tsx`

在"Web 管理"部分添加"共享会话窗口"开关：
- 开关状态与 `web_api_share_sessions` 绑定
- 提示文字：开启后 Web 端和 PC 端可以看到并操作所有终端；关闭后 Web 端只能看到自己创建的终端，PC 端可以看到 Web 端创建的终端但不能操作

### 3. API 层面变更

#### 终端列表过滤

**文件**：`src-tauri/src/web/handlers/terminal_handler.rs`

`GET /api/terminals`：
```rust
pub async fn list(
    State(ts): State<Arc<TerminalService>>,
    State(settings): State<Arc<Mutex<AppSettings>>>,
) -> Json<Vec<TerminalInfo>> {
    let settings = settings.lock().unwrap();
    let terminals = ts.list_terminals();
    
    if settings.web_api_share_sessions {
        // 共享模式：返回所有终端
        Json(terminals)
    } else {
        // 不共享模式：只返回 Web 端创建的终端
        let web_terminals: Vec<_> = terminals
            .into_iter()
            .filter(|t| t.owner == TerminalOwner::Web)
            .collect();
        Json(web_terminals)
    }
}
```

#### 终端创建

**文件**：`src-tauri/src/web/handlers/terminal_handler.rs`

`POST /api/terminals`：
```rust
pub async fn start(
    State(ts): State<Arc<TerminalService>>,
    Json(req): Json<StartTerminalRequest>,
) -> Json<TerminalInfo> {
    // ... 创建终端逻辑 ...
    instance.owner = TerminalOwner::Web;  // 标记为 Web 端创建
    // ...
}
```

#### WebSocket 连接权限

**文件**：`src-tauri/src/web/ws.rs`

WebSocket 连接时检查权限：
```rust
pub async fn handle_socket(
    socket: WebSocket,
    terminal_id: String,
    ts: Arc<TerminalService>,
    settings: Arc<Mutex<AppSettings>>,
    // ...
) {
    let settings = settings.lock().unwrap();
    let terminal = ts.get_terminal(&terminal_id);
    
    if !settings.web_api_share_sessions {
        if let Some(terminal) = terminal {
            if terminal.owner == TerminalOwner::Pc {
                // 不共享模式下，Web 端不能连接 PC 端的终端
                // 返回 HTTP 403 错误
                return;
            }
        }
    }
    // ... 继续处理 WebSocket 连接 ...
}
```

### 4. 权限控制变更

#### WebSocket 输入权限

**文件**：`src-tauri/src/web/ws.rs`

WebSocket 连接已经根据权限过滤（见上一节），所以到达输入权限检查的连接只有两类：
1. **Web 端连接 Web 端创建的终端**：允许输入
2. **PC 端连接 Web 端创建的终端**：拒绝输入

处理 WebSocket 消息时检查权限：
```rust
async fn handle_client_message(
    msg: WsClientMessage,
    terminal_id: &str,
    ts: &TerminalService,
    settings: &AppSettings,
    is_web_client: bool,  // 标识请求来源：true=Web 端，false=PC 端
) -> Result<(), String> {
    let terminal = ts.get_terminal(terminal_id)
        .ok_or("终端不存在")?;
    
    match msg {
        WsClientMessage::Input { data } => {
            // 不共享模式下，PC 端不能输入 Web 端的终端
            if !settings.web_api_share_sessions 
                && terminal.owner == TerminalOwner::Web
                && !is_web_client {
                return Err("终端由 Web 端管理，PC 端只读".to_string());
            }
            ts.write_to_terminal(terminal_id, &data)
                .map_err(|e| e.to_string())?;
        }
        WsClientMessage::Resize { cols, rows } => {
            // 同样的权限检查
            if !settings.web_api_share_sessions 
                && terminal.owner == TerminalOwner::Web
                && !is_web_client {
                return Err("终端由 Web 端管理，PC 端只读".to_string());
            }
            ts.resize_terminal(terminal_id, rows, cols, false)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
```

**请求来源标识**：
- Web 端通过 HTTP API 创建的 WebSocket 连接：`is_web_client = true`
- PC 端通过 Tauri 命令创建的 WebSocket 连接：`is_web_client = false`

#### PC 端 Tauri 命令权限

**文件**：`src-tauri/src/commands/terminal.rs`

在 PC 端的 Tauri 命令中添加权限检查：
```rust
#[tauri::command]
pub async fn write_to_terminal(
    state: State<'_, TerminalService>,
    settings: State<'_, AppSettings>,
    id: String,
    data: String,
) -> Result<(), String> {
    let terminal = state.get_terminal(&id)
        .ok_or("终端不存在")?;
    
    if !settings.web_api_share_sessions 
        && terminal.owner == TerminalOwner::Web {
        return Err("终端由 Web 端管理，PC 端只读".to_string());
    }
    
    state.write_to_terminal(&id, &data)
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

### 5. 前端变更

#### Web 前端

**文件**：`web/src/stores/appStore.ts`

在会话状态中添加 owner 字段：
```typescript
interface WebTerminalSession {
    // ... 现有字段 ...
    owner: 'pc' | 'web';  // 新增
}
```

**文件**：`web/src/components/ProfileList.tsx`

在"运行中"区域显示终端来源：
- PC 端创建的终端：显示"PC"标签（不共享模式下不显示）
- Web 端创建的终端：显示"Web"标签

**文件**：`web/src/hooks/useTerminal.ts`

处理 WebSocket 错误消息：
```typescript
const handleWsMessage = (event: MessageEvent) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'error') {
        // 显示错误提示
        showToast(msg.message);
    }
    // ...
};
```

#### PC 前端

**文件**：`src/components/TerminalInstance.tsx`

在终端标签上显示来源：
- Web 端创建的终端：显示"Web"标签
- 不共享模式下，Web 端创建的终端输入框禁用

**文件**：`src/components/SettingsPage.tsx`

在"Web 管理"部分添加设置项：
```tsx
<div className="setting-item">
    <label>共享会话窗口</label>
    <Switch
        checked={settings.webApiShareSessions}
        onChange={(checked) => updateSettings({ webApiShareSessions: checked })}
    />
    <span className="setting-hint">
        开启后 Web 端和 PC 端可以看到并操作所有终端；关闭后 Web 端只能看到自己创建的终端，PC 端可以看到 Web 端创建的终端但不能操作
    </span>
</div>
```

## 实现步骤

### 阶段一：后端基础（优先级：高）

1. 添加 `TerminalOwner` 枚举
2. 修改 `TerminalInstance` 添加 owner 字段
3. 修改 `AppSettings` 添加 `web_api_share_sessions` 字段
4. 实现终端列表过滤逻辑
5. 实现 WebSocket 连接权限检查
6. 实现 WebSocket 输入权限检查
7. 实现 PC 端 Tauri 命令权限检查

### 阶段二：前端适配（优先级：中）

1. Web 前端：添加 owner 字段到会话状态
2. Web 前端：在"运行中"区域显示终端来源
3. Web 前端：处理 WebSocket 错误消息
4. PC 前端：在终端标签上显示来源
5. PC 前端：添加设置项 UI
6. PC 前端：不共享模式下禁用 Web 端终端的输入框

### 阶段三：测试验证（优先级：中）

1. 测试共享模式：Web 端和 PC 端可以互相看到和操作所有终端
2. 测试不共享模式：Web 端看不到 PC 端的终端
3. 测试不共享模式：PC 端可以看到 Web 端的终端但不能操作
4. 测试热生效：修改设置后立即生效
5. 测试错误处理：权限不足时显示友好提示

## 风险与缓解

### 风险 1：已建立连接的权限变更

**问题**：设置变更后，已建立的 WebSocket 连接可能仍然有权限操作终端。

**缓解**：
- 已建立的连接继续有效（避免中断用户体验）
- 新的连接和操作根据新设置判断权限
- 用户可以通过关闭终端来清理旧连接

### 风险 2：PC 端误操作 Web 端终端

**问题**：PC 端可能不小心尝试操作 Web 端的终端，导致错误提示。

**缓解**：
- PC 前端在不共享模式下禁用 Web 端终端的输入框
- 显示清晰的标签区分终端来源
- 错误提示友好，说明原因

### 风险 3：设置项序列化兼容性

**问题**：旧版本的 settings.json 没有 `web_api_share_sessions` 字段。

**缓解**：
- 使用 `#[serde(default)]` 属性，旧版本配置文件反序列化时默认为 `false`
- 向后兼容，不影响现有用户

## 测试用例

### 功能测试

1. **共享模式开启**
   - Web 端可以看到 PC 端创建的终端
   - Web 端可以操作 PC 端创建的终端
   - PC 端可以看到 Web 端创建的终端
   - PC 端可以操作 Web 端创建的终端

2. **共享模式关闭**
   - Web 端看不到 PC 端创建的终端
   - Web 端可以创建和操作自己的终端
   - PC 端可以看到 Web 端创建的终端
   - PC 端不能操作 Web 端创建的终端（输入框禁用，API 返回错误）

3. **热生效**
   - 修改设置后，新的连接立即生效
   - 已建立的连接继续有效

4. **错误处理**
   - Web 端尝试连接 PC 端终端：返回 HTTP 403
   - PC 端尝试操作 Web 端终端：返回错误消息
   - 错误消息友好，说明原因

## 相关文件

### 后端（Rust）

- `src-tauri/src/models/mod.rs` - 添加 TerminalOwner 枚举
- `src-tauri/src/models/settings.rs` - 添加 web_api_share_sessions 字段
- `src-tauri/src/commands/terminal.rs` - 修改 TerminalInstance，添加权限检查
- `src-tauri/src/web/handlers/terminal_handler.rs` - 修改终端列表和创建逻辑
- `src-tauri/src/web/ws.rs` - 添加 WebSocket 连接和输入权限检查

### 前端（TypeScript）

- `src/components/SettingsPage.tsx` - 添加设置项 UI
- `src/components/TerminalInstance.tsx` - 显示终端来源，禁用输入框
- `web/src/stores/appStore.ts` - 添加 owner 字段
- `web/src/components/ProfileList.tsx` - 显示终端来源
- `web/src/hooks/useTerminal.ts` - 处理错误消息

## 总结

本设计通过在终端实例中添加 owner 字段，实现了 Web 端和 PC 端的会话隔离控制。核心改动包括：

1. **数据模型**：添加 TerminalOwner 枚举，修改 TerminalInstance
2. **设置项**：添加 web_api_share_sessions 布尔字段
3. **API 层面**：过滤终端列表，检查连接和操作权限
4. **前端**：显示终端来源，禁用无权限的操作，添加设置 UI

设计遵循最小改动原则，保持向后兼容，支持热生效，为用户提供灵活的会话共享控制。
