# Web管理_远程终端 设计文档

## 概述

为 TerminalBuddy 添加 Web API 服务和 Web 前端，允许用户通过浏览器远程管理连接配置和操作终端。采用全功能集成方案：在现有 Tauri 进程中嵌入 axum HTTP 服务器，Web 前端构建后嵌入 Rust 二进制。Web 端和桌面端共享终端实例。

## 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| Web 框架 | axum | tokio 生态原生，与项目已有 tokio runtime 无缝集成 |
| 认证方式 | JWT Token | 无状态，适合 REST API + WebSocket 鉴权 |
| 密码存储 | bcrypt | 行业标准哈希，不存明文 |
| Web 前端 | React + xterm.js | 复用桌面端技术栈和组件逻辑 |
| 前端构建 | Vite | 与桌面端一致 |
| 静态资源嵌入 | include_dir! | 零配置部署 |
| WebSocket | tokio-tungstenite | axum 生态原生 WS 支持 |

## 后端设计

### 服务器生命周期

- axum 服务器在 Tauri `setup` 阶段启动，运行在 tokio runtime 上
- 监听 `0.0.0.0:9600`（默认），端口可在设置中修改
- 仅当 `web_api_enabled` 为 true 时启动
- Tauri 应用退出时优雅关闭
- 设置变更时动态停止/重启服务器

### API 路由

```
POST /api/auth/login          # 用户名+密码 → JWT token
GET  /api/auth/status         # 检查 Web API 是否启用（无需认证）

GET  /api/profiles            # 列出所有连接配置
POST /api/profiles            # 创建连接配置
PUT  /api/profiles/:id        # 更新连接配置
DELETE /api/profiles/:id      # 删除连接配置

POST /api/terminals           # 启动终端（根据 profileId）
GET  /api/terminals           # 列出活跃终端
DELETE /api/terminals/:id     # 关闭终端

WS   /ws/terminal/:id         # 终端 I/O WebSocket
```

所有 `/api/*` 路由（除 `/api/auth/*`）需要 JWT 认证，请求头携带 `Authorization: Bearer <token>`。

### WebSocket 协议

WebSocket 连接通过 URL 参数鉴权：`/ws/terminal/:id?token=<jwt>`

**客户端 → 服务端：**

```json
{ "type": "input", "data": "ls\r\n" }
{ "type": "resize", "cols": 80, "rows": 24 }
```

**服务端 → 客户端：**

```json
{ "type": "output", "data": "..." }
{ "type": "exited", "code": 0 }
```

### 终端输出桥接

当前流程：PTY reader thread → Tauri event `terminal_output_{id}` → xterm.js

改为：PTY reader thread → **OutputBroadcaster** → (Tauri event / WebSocket subscribers)

```rust
struct OutputBroadcaster {
    subscribers: HashMap<String, Vec<tokio::sync::mpsc::Sender<String>>>,
}
```

- PTY 输出同时推送给 Tauri 事件和所有 WebSocket 订阅者
- 新 WebSocket 连接时，先通过 `drain_terminal_output` 发送历史输出，再订阅实时输出
- WebSocket 断开时，自动取消订阅

### 新增 Rust 依赖

```toml
axum = "0.8"
tower = "0.5"
tower-http = { version = "0.6", features = ["cors", "fs"] }
tokio-tungstenite = "0.26"
jsonwebtoken = "9"
bcrypt = "0.17"
include_dir = "0.7"
```

### 新增文件结构

```
src-tauri/src/
├── web/
│   ├── mod.rs              # Web 模块入口
│   ├── server.rs           # axum 服务器启动/关闭/路由
│   ├── auth.rs             # JWT 生成/验证/中间件
│   ├── handlers/
│   │   ├── mod.rs
│   │   ├── auth.rs         # 登录/状态处理器
│   │   ├── profiles.rs     # 连接配置 CRUD 处理器
│   │   └── terminals.rs    # 终端管理处理器
│   ├── ws.rs               # WebSocket 终端 I/O 处理
│   └── error.rs            # Web API 统一错误响应
```

## 认证设计

### 设置模型扩展

在 `AppSettings` 中新增字段：

```rust
web_api_enabled: bool          // 默认 false
web_api_port: u16              // 默认 9600
web_api_username: String       // 默认 "admin"
web_api_password_hash: String  // bcrypt 哈希
```

### JWT 配置

- JWT 签名密钥在服务器启动时随机生成（重启后旧 token 失效）
- Token 有效期 24 小时
- Payload 包含：`sub`（用户名）、`exp`（过期时间）、`iat`（签发时间）

### 认证流程

1. Web 用户访问登录页，输入用户名密码
2. 后端验证密码（bcrypt），返回 JWT token
3. 后续 REST API 请求携带 `Authorization: Bearer <token>`
4. WebSocket 连接通过 URL 参数 `?token=<jwt>` 鉴权
5. JWT 过期返回 401，前端跳转登录页

### 安全措施

- 密码存储使用 bcrypt 哈希，不存明文
- JWT 签名密钥每次启动随机生成
- 首次开启 Web API 时强制设置密码
- 绑定 `0.0.0.0` 供局域网访问，不做公网暴露
- CORS 配置仅允许同源请求

## Web 前端设计

### 项目结构

Web 前端作为独立项目放在 `terminal-buddy/web/`：

```
web/
├── package.json
├── vite.config.ts
├── index.html
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── api/
│   │   ├── client.ts         # axios 实例 + JWT 拦截器
│   │   ├── auth.ts           # 登录/状态 API
│   │   ├── profiles.ts       # 连接配置 API
│   │   └── terminals.ts      # 终端 API
│   ├── hooks/
│   │   └── useTerminal.ts    # WebSocket 终端连接 hook
│   ├── components/
│   │   ├── LoginPage.tsx      # 登录页
│   │   ├── MainLayout.tsx     # 主布局（响应式）
│   │   ├── TerminalView.tsx   # xterm.js 终端实例
│   │   ├── ProfileList.tsx    # 连接配置列表
│   │   ├── ProfileDialog.tsx  # 新增/编辑连接对话框
│   │   ├── TabBar.tsx         # 标签栏
│   │   └── Sidebar.tsx        # 侧边栏（桌面端常驻/移动端抽屉）
│   ├── stores/
│   │   └── appStore.ts       # Web 端状态（zustand）
│   └── styles/
│       └── index.css
```

### 页面设计

#### 登录页

简洁的居中登录表单：
- 用户名输入框
- 密码输入框
- 登录按钮
- 错误提示区域

#### 主界面（登录后）

**桌面端布局**（≥768px）：

```
┌──────────┬─────────────────────────┐
│ 侧边栏   │  标签栏                  │
│ 连接列表  │ ┌───────────────────────┐│
│          │ │                       ││
│ ▸ PowerShell │   终端内容           ││
│ ▸ SSH-1  │ │   (xterm.js)         ││
│ ▸ Docker │ │                       ││
│          │ │                       ││
│ [+新建]  │ └───────────────────────┘│
└──────────┴─────────────────────────┘
```

**移动端布局**（<768px）：

```
┌─────────────────────┐
│ ☰ 连接  [标签1][标签2]│
├─────────────────────┤
│                     │
│   终端内容           │
│   (xterm.js)        │
│                     │
└─────────────────────┘
```

- 侧边栏变为抽屉式，点击☰图标展开
- 标签栏水平滚动，超出时显示滚动指示器
- 终端区域自动占满剩余空间

### 响应式断点

| 断点 | 宽度 | 布局变化 |
|------|------|---------|
| 移动端 | <768px | 侧边栏抽屉式，单标签可见 |
| 桌面端 | ≥768px | 侧边栏常驻，标签页并排 |

### 终端交互

- xterm.js 渲染终端输出
- 用户输入通过 WebSocket 发送
- 窗口大小变化时发送 resize 消息
- 复用桌面端的 CustomTheme 配色方案（通过 API 获取主题设置）
- 移动端：支持外接键盘输入，虚拟键盘通过专用输入框发送命令

### 状态管理

```typescript
interface WebAppState {
  token: string | null;
  profiles: Profile[];
  sessions: WebTerminalSession[];
  activeSessionId: string | null;
  sidebarOpen: boolean;  // 移动端抽屉状态
}
```

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| JWT 过期 | API 返回 401，前端跳转登录页 |
| WebSocket 断开 | 前端自动重连（指数退避，最多 5 次） |
| 终端已退出 | WebSocket 发送 exited 消息，前端显示"终端已退出" |
| 服务器未启动 | 前端显示"无法连接服务器"提示 |
| 密码错误 | 登录页显示错误提示 |
| 端口被占用 | 后端日志提示，设置页显示错误状态 |

## 桌面端设置界面

在设置页新增"Web 管理"分区：

- **开关**：启用/禁用 Web API
- **端口输入框**（启用时可见，默认 9600）
- **用户名输入框**（启用时可见，默认 admin）
- **密码输入框**（启用时可见，修改密码）
- **状态提示**：服务运行中 / 服务已停止，显示访问地址（如 `http://192.168.1.100:9600`）

## 构建集成

- Web 前端构建：`cd web && npm run build`
- 构建产物 `web/dist/` 通过 Rust `include_dir!` 宏嵌入二进制
- axum 通过 `ServeDir` 服务静态文件
- SPA 路由：未匹配路径回退到 `index.html`
- **开发模式**：前端开发时使用 Vite dev server（`cd web && npm run dev`），axum 仅提供 API/WS 服务，前端通过 `vite.config.ts` 中的 proxy 代理 API 请求到 axum，支持热更新

## 范围排除

以下功能明确不在本次实现范围内：

- 文件导航
- 命令补全
- 命令历史
- 主题切换
- 工作区管理
- 多用户支持
- SSL/TLS（后续可加反向代理）
