# TerminalBuddy

<div align="center">

**基于 Tauri 2 + React 19 + Rust 的现代化 Windows 桌面终端模拟器**

[![Version](https://img.shields.io/badge/version-1.2.0-blue)](terminal-buddy/package.json)
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

- `TerminalBuddy_1.2.0_x64-setup.exe` — NSIS 安装包（推荐）
- `TerminalBuddy_1.2.0_x64.zip` — 便携版压缩包

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
TerminalBuddy/
├── CHANGELOG.md              # 更新日志
├── LICENSE                   # MIT 许可证
├── README.md                 # 本文件
└── terminal-buddy/           # 主项目
    ├── package.json          # 前端依赖与版本号
    ├── src/                  # React 前端源码
    │   ├── App.tsx           # 根组件
    │   ├── components/       # UI 组件（30+ 组件）
    │   │   ├── TitleBar.tsx          # 无边框标题栏
    │   │   ├── ConfigNav.tsx         # 配置列表面板 + 级联分组
    │   │   ├── ConfigEditDialog.tsx  # 终端配置编辑对话框
    │   │   ├── FileNav.tsx           # 本地文件浏览器
    │   │   ├── GitNavBar.tsx         # Git 操作工具栏
    │   │   ├── GitHistoryPage.tsx    # Git 提交历史页
    │   │   ├── RemoteFileTree.tsx    # SSH 远程文件管理
    │   │   ├── ServerMonitor.tsx     # 服务器监控面板
    │   │   ├── TerminalInstance.tsx  # xterm.js 终端实例
    │   │   ├── TerminalPanel.tsx     # 终端面板路由 + 分屏
    │   │   ├── TabNav.tsx            # 垂直标签导航
    │   │   ├── TabGroup.tsx          # 标签分组
    │   │   ├── SettingsPage.tsx      # 设置页（8 个分区）
    │   │   ├── TextEditor.tsx        # Monaco Editor 编辑器
    │   │   ├── AiUsagePanel.tsx      # AI 用量看板
    │   │   └── Toast.tsx             # 全局 Toast 通知
    │   ├── stores/           # Zustand 状态管理
    │   ├── services/         # Tauri 命令调用封装（79 个命令）
    │   ├── data/             # 命令模板、历史记录、建议词
    │   ├── types/            # TypeScript 类型定义与预设
    │   └── utils/            # 工具函数
    ├── src-tauri/            # Rust 后端
    │   └── src/
    │       ├── lib.rs        # 应用入口（托盘、单实例、Web API）
    │       ├── commands/     # Tauri 命令处理器（14 个模块，79 个命令）
    │       ├── services/     # 业务逻辑层（JSON 读写、SSH、路径管理）
    │       ├── models/       # 数据模型（Profile、Settings、Workspace 等）
    │       └── web/          # 内嵌 Web API（axum + WebSocket + JWT）
    └── web/                  # Web 远程访问前端（独立 React SPA）
        └── src/
            ├── screens/      # 登录页、主布局、终端页
            ├── components/   # 终端组件、移动端输入栏
            ├── api/          # REST + WebSocket 客户端
            └── hooks/        # useTerminal、useMeta 等 hooks
```

### 架构分层

```
┌──────────────────────────────────┐
│  React 前端 (Zustand 状态管理)     │  ← 桌面 UI + Web UI
├──────────────────────────────────┤
│  Tauri 命令桥 (IPC, 79 个命令)     │  ← JSON 序列化，camelCase
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
├── Profiles/              # 终端配置文件
├── Themes/                # 自定义主题
├── Workspaces/            # 工作区布局
├── command_history.json   # 命令历史（含结构化备注）
├── command_templates.json # 命令模板
└── settings.json          # 应用设置
```

---

## ⚙️ 设置分区

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

## 🙏 致谢

- [Tauri](https://tauri.app/) — 桌面应用框架
- [xterm.js](https://xtermjs.org/) — 终端渲染引擎
- [React](https://react.dev/) — UI 框架
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — 代码编辑器
- [portable-pty](https://github.com/wez/portable-pty) — PTY 管理
- [lucide](https://lucide.dev/) — 图标库
