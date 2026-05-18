# TerminalBuddy

A modern desktop terminal emulator for Windows, built with Tauri 2 + React 18 + Rust.

[中文文档](#中文说明)

## Features

- **Multi-terminal Support** — PowerShell, CMD, SSH, Docker, Kubernetes
- **Profile Management** — Create and organize terminal profiles with custom startup paths, commands, and environment variables
- **Tabbed Interface** — Grouped tabs with color labels, drag-and-drop reordering, and split pane layouts
- **Theme System** — 8 built-in themes + custom ANSI color theme editor
- **Autocomplete** — Smart command suggestions from templates and history
- **Command History** — Searchable history with notes support
- **Command Templates** — Predefined and custom command templates with fuzzy matching
- **Workspace Management** — Save and restore terminal layouts as workspaces
- **System Tray** — Close to tray, single instance mode
- **Data Portability** — All data stored as JSON files, with import/export support

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Zustand, xterm.js |
| Backend | Rust, Tauri 2, portable-pty (ConPTY) |
| Build | Vite, NSIS installer |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
cd terminal-buddy

# Install dependencies
npm install

# Run in dev mode (Rust + frontend)
npm run tauri dev

# Frontend only (Vite dev server on port 1420)
npm run dev
```

### Build

```bash
cd terminal-buddy

# Production build (outputs NSIS installer)
npm run tauri build

# Frontend build only
npm run build
```

## Architecture

```
terminal-buddy/
├── src/                          # Frontend (React/TypeScript)
│   ├── App.tsx                   # Root component
│   ├── components/               # UI components
│   │   ├── TerminalInstance.tsx   # xterm.js terminal with addons
│   │   ├── TerminalPanel.tsx     # Terminal routing & split layout
│   │   ├── SettingsPage.tsx      # Settings overlay (6 sections)
│   │   ├── ConfigEditDialog.tsx  # Profile create/edit modal
│   │   ├── TabSidebar.tsx        # Grouped session list
│   │   └── ...
│   ├── stores/appStore.ts        # Zustand state management
│   ├── services/tauri.ts         # Tauri invoke wrappers
│   ├── data/commandTemplates.ts  # Template definitions & history
│   └── types/index.ts            # TypeScript types & presets
├── src-tauri/                    # Backend (Rust/Tauri)
│   └── src/
│       ├── lib.rs                # App setup, tray, commands registration
│       ├── commands/             # Tauri command handlers
│       │   ├── terminal.rs       # PTY management (TerminalService)
│       │   ├── profile.rs        # Profile CRUD
│       │   ├── history.rs        # Command history
│       │   ├── theme.rs          # Theme CRUD
│       │   └── ...
│       ├── services/             # Business logic (JSON file I/O)
│       └── models/               # Data structures (Profile, Theme, etc.)
└── portable-pty-patched/         # Local patch for portable-pty
```

### Data Storage

All user data is stored as JSON files under `%APPDATA%/TerminalBuddy/`:

```
%APPDATA%/TerminalBuddy/
├── Profiles/                  # Terminal profiles
├── Themes/                    # Custom themes
├── Workspaces/                # Saved workspaces
├── command_history.json       # Command history with notes
├── command_templates.json     # Command templates
└── settings.json              # App settings
```

## Screenshots

> Add screenshots here

## License

[MIT](LICENSE)

---

# 中文说明

一个基于 Tauri 2 + React 18 + Rust 构建的现代化 Windows 桌面终端模拟器。

## 功能特性

- **多终端类型** — 支持 PowerShell、CMD、SSH、Docker、Kubernetes
- **配置文件管理** — 创建和组织终端配置，支持自定义启动路径、命令和环境变量
- **标签页界面** — 分组标签页、颜色标签、拖拽排序、分屏布局
- **主题系统** — 8 款内置主题 + 自定义 ANSI 颜色主题编辑器
- **智能补全** — 基于模板和历史记录的命令自动补全
- **命令历史** — 可搜索的命令历史，支持添加备注
- **命令模板** — 预定义和自定义命令模板，支持模糊匹配
- **工作区管理** — 保存和恢复终端布局
- **系统托盘** — 关闭到托盘、单实例模式
- **数据可移植** — 所有数据以 JSON 文件存储，支持导入/导出

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18、TypeScript、Zustand、xterm.js |
| 后端 | Rust、Tauri 2、portable-pty (ConPTY) |
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

## 项目结构

```
terminal-buddy/
├── src/                          # 前端（React/TypeScript）
│   ├── App.tsx                   # 根组件
│   ├── components/               # UI 组件
│   │   ├── TerminalInstance.tsx   # xterm.js 终端（含插件）
│   │   ├── TerminalPanel.tsx     # 终端路由与分屏布局
│   │   ├── SettingsPage.tsx      # 设置面板（6 个分区）
│   │   ├── ConfigEditDialog.tsx  # 配置文件创建/编辑弹窗
│   │   ├── TabSidebar.tsx        # 分组会话列表
│   │   └── ...
│   ├── stores/appStore.ts        # Zustand 状态管理
│   ├── services/tauri.ts         # Tauri invoke 封装
│   ├── data/commandTemplates.ts  # 模板定义与历史记录
│   └── types/index.ts            # TypeScript 类型与预设
├── src-tauri/                    # 后端（Rust/Tauri）
│   └── src/
│       ├── lib.rs                # 应用初始化、托盘、命令注册
│       ├── commands/             # Tauri 命令处理
│       │   ├── terminal.rs       # PTY 管理（TerminalService）
│       │   ├── profile.rs        # 配置文件 CRUD
│       │   ├── history.rs        # 命令历史
│       │   ├── theme.rs          # 主题 CRUD
│       │   └── ...
│       ├── services/             # 业务逻辑（JSON 文件读写）
│       └── models/               # 数据结构（Profile、Theme 等）
└── portable-pty-patched/         # portable-pty 本地补丁
```

### 数据存储

所有用户数据以 JSON 文件存储在 `%APPDATA%/TerminalBuddy/` 目录下：

```
%APPDATA%/TerminalBuddy/
├── Profiles/                  # 终端配置文件
├── Themes/                    # 自定义主题
├── Workspaces/                # 保存的工作区
├── command_history.json       # 命令历史（含备注）
├── command_templates.json     # 命令模板
└── settings.json              # 应用设置
```

## 截图

> 在此添加截图

## 开源协议

[MIT](LICENSE)
