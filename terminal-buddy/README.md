# TerminalBuddy

<div align="center">

**基于 Tauri 2 + React 19 + Rust 的现代化 Windows 桌面终端模拟器**

[![Version](https://img.shields.io/badge/version-1.4.0-blue)](terminal-buddy/package.json)
[![Rust](https://img.shields.io/badge/Rust-edition%202021-orange)](terminal-buddy/src-tauri/Cargo.toml)
[![React](https://img.shields.io/badge/React-19-blue)](terminal-buddy/package.json)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

---

## ✨ 功能概览

<table>
<tr>
<td width="50%">

### 🔧 多终端支持
- PowerShell、CMD、SSH、Docker、K8s、MSTSC 远程桌面
- 自定义启动路径、启动命令、环境变量
- 颜色标签 + 层级分组（多级级联选择器）

### 🗂️ 标签页与分屏
- 垂直侧边栏 / 水平标签栏双模式，F2 快速重命名
- 标签分组、拖拽排序、呼吸灯效果
- 终端面板分割 + 工作区保存与恢复
- VSCode Activity Bar 风格侧边栏（文件树 / 配置 / Git 面板）

### 🌐 远程访问
- SSH 远程文件管理器（面包屑导航、上传/下载/chmod/删除）
- 服务器实时监控（CPU、内存、磁盘、网络、运行时间）
- 嵌入式 Web API（axum + WebSocket），移动端友好
- JWT + bcrypt 认证，PC/Web 会话隔离

### 🤖 Claude Code 集成
- 终端内决策交互（直接在 xterm 中确认/拒绝文件操作）
- 桌面 Toast 通知（决策通知与完成通知独立拆分）
- 决议通道枚举模型（原生通知 / 终端 / 两者）
- 任务状态实时追踪（busy/idle/error）

</td>
<td width="50%">

### 🔔 机器人通知
- 飞书、钉钉多平台消息推送，可与终端事件绑定
- 飞书 WebSocket 长连接（低延迟消息推送）
- 扫码授权流程（二维码 + 设备码 OAuth，凭证自动保存）
- 任务完成检测（spinner 帧识别 + 提示符追踪 + 忙碌证据校验）

### 📝 开发辅助
- 智能命令补全（模板 + 历史模糊匹配）
- 100+ 命令模板库（网络、进程、文件、系统、Git、Docker 等 10 个分类）
- Monaco Editor（语法高亮、查找替换、格式化）
- 命令历史全文搜索 + 结构化备注 + 导入/导出

### 🎨 界面设计
- lucide-react 图标系统（2000+ 图标统一风格）
- 设计系统令牌化色板，亮/暗双主题无缝切换
- 8 款内置主题 + 自定义 16 色 ANSI 调色板
- 无障碍标注（aria-label + focus 态）

### ⚙️ 设置体验
- 8 大设置分区，自动保存（即时持久化）
- 右键粘贴、拖拽文件路径到终端
- Ctrl+F 终端内搜索 + Web 链接检测

### 🚀 系统特性
- 系统托盘（最小化到托盘）+ 单实例模式
- 无边框自定义标题栏
- 启动性能优化（异步 PTY 创建 + 并发标签恢复）
- MSTSC 凭据安全存储（Win32 CredWriteW API）

</td>
</tr>
</table>

---

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| **桌面框架** | Tauri 2.x |
| **后端** | Rust (edition 2021) + portable-pty (ConPTY) |
| **桌面前端** | React 19 + TypeScript + Zustand 5 + xterm.js 6 |
| **Web API** | axum 0.8 + tower-http + JWT + bcrypt |
| **Web 前端** | React 19 + Zustand 5 + xterm.js + axios |
| **编辑器** | Monaco Editor |
| **图标** | lucide-react |
| **构建工具** | Vite 8 + NSIS 安装包 |

---

## 📋 系统要求

| 项目 | 最低配置 | 推荐配置 |
|---|---|---|
| 操作系统 | Windows 10 (1903+) | Windows 11 |
| 架构 | x86-64 | x86-64 / ARM64 |
| 内存 | 4 GB | 8 GB+ |
| 磁盘 | 200 MB | 500 MB+ |
| 分辨率 | 1280×720 | 1920×1080 |

---

## 📦 安装

从 [Releases](https://gitee.com/updateme/terminal-buddy/releases) 页面下载最新版本：

- `TerminalBuddy_1.4.0_x64-setup.exe` — NSIS 安装包（推荐）
- `TerminalBuddy_1.4.0_x64.zip` — 便携版压缩包

---

## 🧑‍💻 开发

### 环境准备

- [Node.js](https://nodejs.org/) v18+
- [Rust](https://www.rust-lang.org/tools/install) stable
- [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)

### 常用命令

```bash
cd terminal-buddy

# 安装依赖
npm install

# 全栈开发模式（Tauri + 前端）
npm run tauri dev

# 仅前端开发（Vite 开发服务器，端口 1420）
npm run dev

# TypeScript 类型检查
npx tsc --noEmit

# Rust 编译检查
cd src-tauri && cargo check

# 生产构建
npm run tauri build
```

---

## 🏗️ 项目结构

```
terminal-buddy/
├── src/                          # Desktop frontend (React/TypeScript)
│   ├── App.tsx  # Root component
│   ├── components/
│   │   ├── TitleBar.tsx  # Custom frameless title bar
│   │   ├── ConfigNav.tsx  # Profile list panel with hierarchical groups
│   │   ├── ConfigEditDialog.tsx  # Profile create/edit modal with GroupCascader
│   │   ├── GroupCascader.tsx  # Multi-level group cascade selector
│   │   ├── FileNav.tsx  # Local file browser (bookmarks, inline rename) + embedded Git bar
│   │   ├── GitNavBar.tsx  # Git operations toolbar (status, branch, pull, commit, push)
│   │   ├── GitHistoryPage.tsx  # Commit history page with SVG graph
│   │   ├── GitHistoryDiffPreview.tsx  # Historical file diff preview
│   │   ├── HistoryGraphSvg.tsx  # SVG commit-graph renderer
│   │   ├── RemoteFileTree.tsx  # SSH remote file browser with upload/download/chmod
│   │   ├── ServerMonitor.tsx  # Real-time SSH server monitoring panel
│   │   ├── ChmodDialog.tsx  # Remote file permission editor
│   │   ├── ExtraParamsDialog.tsx  # SSH parameter presets
│   │   ├── TransferPanel.tsx  # Remote file transfer queue/progress
│   │   ├── TerminalInstance.tsx  # xterm.js terminal with addons
│   │   ├── TerminalPanel.tsx  # Terminal routing, split layout, hosts GitHistoryPage
│   │   ├── TerminalTab.tsx  # Individual tab component
│   │   ├── TabNav.tsx  # Vertical tab navigation
│   │   ├── TerminalTabBar.tsx  # Horizontal tab bar
│   │   ├── TreeView.tsx  # Reusable tree view component
│   │   ├── SettingsPage.tsx  # Settings overlay (IntersectionObserver side-nav)
│   │   ├── TextEditor.tsx  # Monaco Editor text editor
│   │   ├── AiUsagePanel.tsx  # AI usage hover panel (5 providers)
│   │   ├── WebManageDialog.tsx  # Web remote-management dialog (start/stop, QR code)
│   │   ├── AboutDialog.tsx  # About / version dialog
│   │   └── Toast.tsx  # Global toast notifications
│   ├── stores/appStore.ts  # Zustand state management
│   ├── services/tauri.ts  # Typed Tauri invoke wrappers
│   ├── services/aiUsage.ts  # AI API usage fetching (5 providers)
│   ├── data/commandTemplates.ts  # Template definitions & history
│   ├── data/terminalSuggestions.ts  # VS Code-style prompt suggestions
│   ├── utils/  # Utility modules
│   │   ├── settings.ts  # Frontend settings (localStorage)
│   │   ├── contextMenu.ts  # Edge-aware context-menu positioning
│   │   ├── terminalTheme.ts  # Terminal theme helpers
│   │   ├── terminalResizeEvent.ts  # Terminal resize events
│   │   ├── openTerminalInDir.ts  # Open terminal in directory
│   │   ├── fileExtensions.ts  # File extension mapping
│   │   ├── groupHierarchy.ts  # Group hierarchy utilities
│   │   ├── groupTree.ts  # Group tree building
│   │   ├── tabColor.ts  # Tab color utilities
│   │   ├── formatDuration.ts  # Duration formatting
│   │   ├── migration.ts  # Data migration helpers
│   │   └── bootLog.ts  # Boot logging
│   └── types/index.ts  # TypeScript types & presets
├── src-tauri/                    # Backend (Rust/Tauri)
│   └── src/
│       ├── lib.rs  # App setup, tray, single instance, Web API
│       ├── commands/  # Tauri command handlers
│       │   ├── terminal.rs  # PTY management (TerminalService)
│       │   ├── profile.rs  # Profile CRUD + export/import
│       │   ├── settings.rs  # App settings, data path, Web API settings
│       │   ├── git.rs  # Git GUI backend (status, branch, pull, push, commit, history, diff)
│       │   ├── window.rs  # Window controls (minimize/maximize/close)
│       │   ├── remote_file.rs  # SSH remote file operations
│       │   ├── server_monitor.rs  # SSH server stats monitoring
│       │   ├── client_data.rs  # Client-side data persistence
│       │   ├── ai_usage.rs  # AI API usage (Qianfan, Deepseek, Minimax, Ark)
│       │   ├── clipboard.rs  # Clipboard operations
│       │   ├── fs.rs  # Local filesystem operations
│       │   ├── templates.rs  # Command templates management
│       │   ├── web.rs  # Web API server control
│       │   └── workspace.rs  # Workspace CRUD
│       ├── services/  # Business logic
│       │   ├── profile_service.rs  # Profile JSON I/O
│       │   ├── settings_service.rs  # Settings JSON I/O
│       │   ├── template_service.rs  # Template JSON I/O
│       │   ├── workspace_service.rs  # Workspace JSON I/O
│       │   ├── web_service.rs  # Terminal output pub/sub for WebSocket
│       │   ├── path_service.rs  # Data directory resolution & migration
│       │   ├── ssh_session_service.rs  # SSH session management
│       │   ├── client_data_service.rs  # Client data persistence
│       │   └── crypto_service.rs  # Encryption helpers
│       ├── models/  # Data structures (Profile, AppSettings, etc.)
│       ├── web/  # Web API module (axum)
│       │   ├── server.rs  # Axum router & SPA serving
│       │   ├── auth.rs  # JWT authentication
│       │   ├── ws.rs  # WebSocket terminal I/O
│       │   ├── error.rs  # Error types
│       │   └── handlers/  # REST handlers (auth, profiles, terminals)
│       └── portable-pty-patched/  # Local patch for portable-pty
└── web/  # Web frontend (separate React SPA)
    └── src/
        ├── screens/  # Login, Nav, Terminal
        ├── components/  # Xterm (mobile-friendly), InputBar
        ├── api.ts  # Auth + REST client
        ├── hooks/useMetaWs.ts  # Meta channel (profile/terminal lists, session events)
        └── hooks/useTerminalWs.ts  # Per-terminal WebSocket I/O
```

### 架构分层

```
┌──────────────────────────────────┐
│  React 前端 (Zustand 状态管理)     │  ← 桌面 UI + Web UI
├──────────────────────────────────┤
│  Tauri 命令桥 (IPC)                │  ← JSON 序列化，camelCase
├──────────────────────────────────┤
│  Rust 服务层                      │  ← 业务逻辑、JSON 持久化
├──────────────────────────────────┤
│  PTY / SSH / axum / Win32 API    │  ← 底层能力
└──────────────────────────────────┘
```

### 数据存储

所有用户数据以 JSON 文件存储在 `%APPDATA%/TerminalBuddy/`：

```
%APPDATA%/TerminalBuddy/
├── Profiles/                  # Terminal profiles
├── Workspaces/                # Saved workspaces
├── command_history.json       # Command history with notes
├── command_templates.json     # Command templates
└── settings.json              # App settings
```

---

| Section | Description |
|---------|-------------|
| General | Restore tabs, close behavior, launch window mode, launch at login, tab navigation, theme mode, list selection style, data path, import/export |
| Profiles | Create, edit, delete, copy, group profiles |
| Commands | 10 categories of templates, custom commands, show/hide, edit descriptions |
| History | Search, edit commands and notes, clear |
| Exclusions | File tree exclusion patterns (exact name, `*.ext`, `**/*.ext`) |
| AI Usage | Zhipu GLM API key, Baidu Qianfan cookie, DeepSeek API key, Minimax API key, Volcano Ark (火山方舟) cookie |
| Web Management | Enable/disable Web API, port, credentials, server control, session sharing |

| 分区 | 内容 |
|---|---|
| **通用** | 恢复标签页、关闭行为、启动窗口模式、开机启动、标签导航、主题模式、数据路径、导入/导出 |
| **配置** | 终端配置文件创建、编辑、复制、删除、分组管理 |
| **命令** | 10 个分类的命令模板、自定义命令、显示/隐藏、编辑描述 |
| **主题** | 8 款内置主题 + 自定义 16 色 ANSI 编辑器，实时预览 |
| **历史** | 搜索历史命令、编辑命令和备注、清空 |
| **排除** | 文件树排除规则（精确名称、`*.ext` 通配符、`**/*.ext` 递归） |
| **AI 用量** | 智谱 GLM / 百度千帆 / DeepSeek / Minimax / 火山方舟 API 用量监控 |
| **Web 管理** | Web API 开关、端口、认证凭据、服务器控制、会话共享 |

---

## 🔐 安全

- Web 远程访问与桌面终端**会话隔离**（`webApiShareSessions` 可配置）
- JWT Token + bcrypt 密码哈希认证
- 凭据通过 Win32 `CredWriteW` API 存储，不暴露在进程命令行中

---

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE) 开源。

---

## 📝 版本历史

### v1.4.0 (2026-08-03) — 当前版本

**🛠️ 组件与 UI**
- `open_in_explorer` 路径不存在时逐级向上查找已存在目录
- `components` 重组为按域子目录结构

**🔧 资源与稳定性**
- 锁机制重构为 RAII 守卫，资源清理与超时多路加固
- 事件文件按条数与体积滚动清理 + 事件列表查看全部/搜索/分页统一组件
- Watchdog 超时可配置并按 80% 提前告警 `approachingTimeout`
- 错误分类本地化、banner 重试、轮询失败可见

### v1.3.0 (2026-07-20)

**🎯 启动参数预设体系（ExtraParamsPreset）**
- 后端新增启动参数预设 REST 接口，终端实例挂载 `tag` 字段
- 桌面端支持预设命令模糊匹配过滤、Dialog 受控离场动画
- 桌面/Web 双向对齐：`terminal-created` 事件补齐 `extraParamTag/Color`，预设支持 tag 颜色并在 tab 上展示

**🌐 Web 端能力补齐**
- Nav 复用 PC `TreeView` 类名重构，新增会话右键菜单，Terminal 主题色随 profile 切换
- Nav 重构为"会话 / 连接"双 tab，新增 profile 属性面板与会话分组折叠/关闭入口
- 命令历史 REST 接口打通，与 PC 端 `ClientData` 共享；接入终端主题色类型
- 自定义 Host 改为内联输入；InputBar 快捷键面板重排，方向键靠前
- 修复网页端启动乱码问题

**🔤 分屏终端字号可配置**
- `AppSettings` 新增分屏终端三档字号字段（off / 2x1 / 2x2）
- 行为页新增终端字号配置入口
- 分屏/单屏字号改读设置并响应 `app-settings-changed` 事件
- 字号空输入回退到行默认值（对齐 spec §6）

**⚡ 终端性能与稳定性**
- 新增启动中占位会话，避免 PTY 创建过程页签跳变
- WebGL 渲染器延迟挂载，减少新建页签掉帧
- 批量关闭终端减少状态更新次数，关闭卡顿修复
- 终端偶现乱码修复

**🤖 机器人与 Hook 体系**
- 新增微信 ClawBot 机器人支持
- Hook 全部迁移为 HTTP 模式，简化集成链路

**🛠️ 文件模块与 UI**
- 文件模块支持多项目，重构文件管理交互
- 统一弹框组件，优化手机端访问体验
- 配置编辑对话框字段顺序优化，`GroupCascader` 支持失焦提交
- 修复切换黑白主题输入框背景不适配、分屏切换显示异常、web 管理手机端布局等多项 UI 问题

> 📄 完整更新说明：[RELEASE_NOTES_v1.3.0.md](./RELEASE_NOTES_v1.3.0.md)

### v1.2.0 (2026-07-15)

- 设计系统全局刷新：令牌化色板 + lucide 图标组件化 + 无障碍标注
- Claude Hook 终端内决策交互，桌面 Toast 通知体系
- 多平台机器人通知（飞书/钉钉），飞书长连接 WebSocket，扫码授权流程
- VSCode Activity Bar 风格侧边栏，设置页重构与自动保存
- Git 信息缓存复用 + 历史记录树形展示
- MSTSC 凭据安全升级（Win32 `CredWriteW` API）
- 启动性能优化（异步 PTY + 并发标签恢复）

> 📄 完整更新说明：[RELEASE_NOTES_v1.2.0.md](./RELEASE_NOTES_v1.2.0.md)

---

## 🙏 致谢

- [Tauri](https://tauri.app/) — 桌面应用框架
- [xterm.js](https://xtermjs.org/) — 终端渲染引擎
- [React](https://react.dev/) — UI 框架
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — 代码编辑器
- [portable-pty](https://github.com/wez/portable-pty) — PTY 管理
- [lucide](https://lucide.dev/) — 图标库
