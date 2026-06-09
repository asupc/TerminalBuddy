# TerminalBuddy

一个基于 Tauri 2 + React 18 + Rust 构建的现代化 Windows 桌面终端模拟器。

[English](README_EN.md)

## 功能特性

- **多终端类型** — PowerShell、CMD、SSH、Docker、Kubernetes、文本编辑器、远程桌面 (MSTSC)
- **配置文件管理** — 创建和组织终端配置，支持自定义启动路径、命令和环境变量
- **标签页界面** — 分组标签页、颜色标签、拖拽排序、分屏布局
- **主题系统** — 8 款内置主题 + 自定义 ANSI 颜色主题编辑器
- **智能补全** — 基于模板和历史记录的命令自动补全
- **命令模板** — 预定义和自定义命令模板，支持模糊匹配
- **工作区管理** — 保存和恢复终端布局
- **原生 SSH/SFTP** — 内置 SSH 客户端，支持密码和密钥认证，SFTP 文件浏览器支持完整文件操作
- **远程文件管理** — 浏览、上传、下载、编辑、重命名、修改权限，支持拖拽操作
- **服务器监控** — SSH 会话实时监控 CPU、内存、磁盘、网络
- **文本编辑器** — Monaco Editor（VS Code 同款引擎），语法高亮、自动保存草稿、远程文件编辑
- **远程桌面** — MSTSC 集成，凭据管理和分辨率控制
- **Web 管理服务器** — 内置 Axum Web 服务器，JWT 认证，支持浏览器/手机远程访问终端
- **AI 用量追踪** — 监控 DeepSeek、智谱 GLM、百度千帆、MiniMax 的 API 使用量
- **智能粘贴** — 自动检测剪贴板中的文件路径、图片和多行文本
- **系统托盘** — 关闭到托盘、单实例模式、开机自启
- **数据可移植** — 所有数据以 JSON 文件存储，支持导入/导出

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18、TypeScript、Zustand、xterm.js (WebGL)、Monaco Editor |
| 后端 | Rust、Tauri 2、portable-pty (ConPTY)、ssh2、Axum |
| Web 服务器 | Axum、JWT (jsonwebtoken)、bcrypt、WebSocket |
| 构建 | Vite、NSIS 安装包 |

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/)（v18+）
- [Rust](https://www.rust-lang.org/tools/install)（stable 版本）
- [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)

### 开发

```bash
cd terminal-buddy

# 安装依赖
npm install

# 开发模式运行（Rust + 前端）
npm run tauri dev

# 仅前端开发（Vite 开发服务器，端口 1420）
npm run dev
```

### 构建

```bash
cd terminal-buddy

# 生产构建（输出 NSIS 安装包）
npm run tauri build

# 仅构建前端
npm run build
```

## 配置效率指南

配置文件让你**一键启动**常用的工作环境，告别重复操作。

### 项目开发终端

```json
{
  "name": "前端开发",
  "group": "项目A",
  "terminalType": "powershell",
  "startupPath": "D:\\projects\\my-app",
  "startupCommands": ["npm run dev"]
}
```

点击配置 → 自动进入目录 → 自动启动开发服务器

### 多 Node.js 版本切换

不同项目需要不同 Node 版本？为每个项目配置专用终端：

```json
{
  "name": "旧项目 (Node 16)",
  "group": "项目A",
  "terminalType": "powershell",
  "startupPath": "D:\\old-project",
  "startupCommands": ["nvm use 16.20.2", "npm run dev"]
}
```

```json
{
  "name": "新项目 (Node 18)",
  "group": "项目B",
  "terminalType": "powershell",
  "startupPath": "D:\\new-project",
  "startupCommands": ["nvm use 18.19.0", "npm run dev"]
}
```

支持 nvm-windows、nvs、fnm 等版本管理器。

### 批量操作

一键拉取所有项目代码：

```json
{
  "name": "批量 Git Pull",
  "group": "运维",
  "terminalType": "powershell",
  "startupCommands": [
    "cd D:\\project-a && git pull",
    "cd D:\\project-b && git pull",
    "cd D:\\project-c && git pull"
  ]
}
```

### SSH 快速连接

```json
{
  "name": "测试服务器",
  "group": "服务器/测试",
  "terminalType": "ssh",
  "sshHost": "192.168.1.100",
  "sshUser": "admin",
  "sshAuthType": "password",
  "sshPassword": "your-password"
}
```

### 远程桌面

```json
{
  "name": "开发机",
  "group": "远程桌面",
  "terminalType": "mstsc",
  "mstscHost": "192.168.77.24",
  "mstscUser": "administrator",
  "mstscPassword": "your-password",
  "mstscResolution": "1920x1080"
}
```

### 全栈开发（前后端同时启动）

```json
{
  "name": "后端",
  "group": "全栈项目",
  "terminalType": "powershell",
  "startupPath": "D:\\project\\backend",
  "startupCommands": ["npm run start:dev"]
}
```

```json
{
  "name": "前端",
  "group": "全栈项目",
  "terminalType": "powershell",
  "startupPath": "D:\\project\\frontend",
  "startupCommands": ["npm run dev"]
}
```

打开两个配置，前后端同时开发。

### 分组管理建议

```
📁 项目A
  ├── 前端开发
  └── 后端开发
📁 服务器
  ├── 测试环境
  └── 生产环境
📁 远程桌面
  └── 开发机
```

使用 `/` 创建层级：`"group": "服务器/测试环境"`

> 更多配置示例请参考 [配置效率指南](terminal-buddy/docs/profile-guide.md)

---

## 项目结构

```
terminal-buddy/
├── src/                          # 前端（React/TypeScript）
│   ├── App.tsx                   # 根组件
│   ├── components/               # UI 组件
│   │   ├── TerminalInstance.tsx   # xterm.js 终端（WebGL 渲染器）
│   │   ├── TerminalPanel.tsx     # 终端路由与分屏布局
│   │   ├── TabSidebar.tsx        # 分组会话列表（支持搜索）
│   │   ├── TextEditor.tsx        # Monaco Editor（VS Code 同款引擎）
│   │   ├── RemoteFileTree.tsx    # SFTP 文件浏览器
│   │   ├── ServerMonitor.tsx     # 实时服务器指标监控
│   │   ├── AiUsagePanel.tsx      # AI 用量追踪面板
│   │   ├── FileTree.tsx          # 本地文件树（支持书签）
│   │   ├── TransferPanel.tsx     # 文件传输进度
│   │   ├── SettingsPage.tsx      # 设置面板
│   │   ├── ConfigEditDialog.tsx  # 配置文件创建/编辑弹窗
│   │   ├── TitleBar.tsx          # 自定义窗口标题栏
│   │   └── ...
│   ├── stores/appStore.ts        # Zustand 状态管理
│   ├── services/tauri.ts         # Tauri invoke 封装
│   ├── data/commandTemplates.ts  # 模板定义
│   └── types/index.ts            # TypeScript 类型与预设
├── src-tauri/                    # 后端（Rust/Tauri）
│   └── src/
│       ├── lib.rs                # 应用初始化、托盘、命令注册
│       ├── commands/             # Tauri 命令处理
│       │   ├── terminal.rs       # PTY 与 MSTSC 管理
│       │   ├── profile.rs        # 配置文件 CRUD
│       │   ├── remote_file.rs    # SFTP 操作
│       │   ├── server_monitor.rs # 服务器指标采集
│       │   ├── ai_usage.rs       # AI 用量 API 集成
│       │   ├── settings.rs       # 设置与数据导入导出
│       │   ├── clipboard.rs      # 剪贴板文件/图片读取
│       │   └── ...
│       ├── services/             # 业务逻辑
│       ├── models/               # 数据结构
│       └── web/                  # 内置 Web 服务器
│           ├── server.rs         # Axum 路由与 CORS
│           ├── auth.rs           # JWT 认证
│           ├── ws.rs             # WebSocket 终端 I/O
│           └── handlers/         # REST API 处理器
├── web/                          # Web 管理前端（独立 React 应用）
│   ├── src/
│   │   ├── App.tsx               # Web 应用根组件
│   │   ├── components/           # Web UI 组件
│   │   │   ├── LoginPage.tsx     # JWT 登录页
│   │   │   ├── MainLayout.tsx    # 响应式布局
│   │   │   ├── Sidebar.tsx       # 配置文件侧边栏
│   │   │   ├── TerminalView.tsx  # xterm.js 终端
│   │   │   └── MobileInputBar.tsx # 移动端特殊按键栏
│   │   ├── api/                  # REST 与 WebSocket 客户端
│   │   └── stores/               # Web 状态管理
│   └── package.json
└── portable-pty-patched/         # portable-pty 本地补丁
```

### 数据存储

所有用户数据以 JSON 文件存储在 `%APPDATA%/TerminalBuddy/` 目录下：

```
%APPDATA%/TerminalBuddy/
├── Profiles/                  # 终端配置文件（SSH/Docker/K8S/MSTSC 凭据）
├── Themes/                    # 自定义 ANSI 颜色主题
├── Workspaces/                # 保存的工作区布局
├── ClientData/                # 前端状态（标签页、书签、草稿、设置缓存）
├── command_templates.json     # 命令模板
└── settings.json              # 应用设置
```

## Web 管理服务器

TerminalBuddy 内置 Web 服务器（默认端口 9600），支持从浏览器和手机远程访问。

### 设置

1. 打开设置 > Web 管理
2. 启用 Web 服务器，设置端口和凭据
3. 在任意浏览器访问 `http://<你的IP>:9600`

### API 接口

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | JWT 登录 |
| GET | `/api/profiles` | 获取配置列表 |
| POST | `/api/profiles` | 创建配置 |
| PUT | `/api/profiles/{id}` | 更新配置 |
| DELETE | `/api/profiles/{id}` | 删除配置 |
| GET | `/api/terminals` | 获取活跃终端列表 |
| POST | `/api/terminals` | 启动终端 |
| DELETE | `/api/terminals/{id}` | 关闭终端 |
| WS | `/ws/terminal/{id}?token=<jwt>` | 终端 WebSocket |

### WebSocket 协议

```json
// 客户端 → 服务器
{ "type": "input", "data": "ls -la\n" }
{ "type": "resize", "cols": 120, "rows": 40 }

// 服务器 → 客户端
{ "type": "output", "data": "..." }
{ "type": "exited", "code": 0 }
{ "type": "error", "message": "..." }
```

### 安全机制

- JWT 认证，24 小时令牌有效期
- bcrypt 密码哈希
- 全局 WebSocket 连接上限：50
- 单终端 WebSocket 连接上限：5
- 会话所有权模型（PC 终端 vs Web 终端）

## SSH 与远程文件管理

### SSH 连接

支持密码、密钥和 SSH Agent 认证。密码使用 Windows DPAPI 加密存储。

### SFTP 文件浏览器

- 面包屑导航与右键菜单
- 上传/下载文件和目录，带进度追踪
- 行内重命名、新建、删除、修改权限
- 远程剪贴板（跨目录复制/剪切/粘贴）
- "用本地编辑器编辑" — 在 Monaco Editor 中打开远程文件，保存时自动上传
- "用系统程序打开" — 下载到临时目录后用系统默认程序打开

### 服务器监控

SSH 会话实时监控，支持可配置刷新间隔（1 秒/3 秒/5 秒/10 秒）：

- CPU 使用率（基于 `/proc/stat` 差值计算）
- 内存（总计、已用、可用、交换分区）
- 各挂载点磁盘使用率
- 网络速度（每秒收发字节数）
- 运行时间

## 截图

> 在此添加截图

## 开源协议

[MIT](LICENSE)
