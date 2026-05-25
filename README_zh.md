# TerminalBuddy

一个基于 Tauri 2 + React 18 + Rust 构建的现代化 Windows 桌面终端模拟器。

[English](README.md)

## 功能特性

- **多终端类型** — 支持 PowerShell、CMD、SSH、Docker、Kubernetes
- **配置文件管理** — 创建和组织终端配置，支持自定义启动路径、命令、环境变量、配置专属颜色和层级分组
- **标签页界面** — 垂直侧边栏或水平标签栏，分组标签页、颜色标签、拖拽排序、递归分组折叠
- **文件树浏览器** — 内置文件浏览器，支持书签、排除规则、拖拽文件到终端、内联重命名
- **主题系统** — 8 款内置主题 + 自定义 16 色 ANSI 主题编辑器，支持深色/浅色/跟随系统
- **智能补全** — 基于模板和历史记录的命令自动补全，支持模糊匹配
- **命令历史** — 可搜索的命令历史，支持添加备注、导入/导出
- **命令模板** — 10 个分类的预定义模板（网络、进程、文件、系统、Git、Docker、Python、Node、.NET、PowerShell），支持自定义命令
- **终端搜索** — Ctrl+F 搜索终端输出内容
- **剪贴板集成** — 从资源管理器直接粘贴文件路径（Ctrl+V），右键粘贴
- **输入法支持** — CJK 输入法组合时的位置锁定
- **Web 链接** — Ctrl+点击在浏览器中打开 URL
- **工作区管理** — 保存和恢复终端布局
- **系统托盘** — 关闭到托盘、单实例模式
- **AI 用量监控** — 查看智谱 GLM、百度千帆和 Deepseek 的 API 用量
- **Web 远程访问** — 内置 HTTP/WebSocket 服务器，支持浏览器远程终端访问，JWT 认证，移动端友好输入栏
- **文本编辑器** — 集成 Monaco Editor，双击文件树中的文本文件打开编辑器标签页，语法高亮、查找替换、格式化文档
- **数据可移植** — 所有数据以 JSON 文件存储，支持完整导入/导出

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面前端 | React 18、TypeScript、Zustand 5、xterm.js 5.5、Monaco Editor |
| 后端 | Rust (edition 2021)、Tauri 2、portable-pty (ConPTY) |
| Web API | axum 0.8、tower-http、JWT (jsonwebtoken)、bcrypt |
| Web 前端 | React 18、Zustand 5、xterm.js、axios |
| 构建 | Vite 5、NSIS 安装包 |

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
├── src/                          # 桌面前端（React/TypeScript）
│   ├── App.tsx                   # 根组件
│   ├── components/
│   │   ├── TitleBar.tsx          # 自定义无边框标题栏
│   │   ├── ConfigPanel.tsx       # 配置文件列表面板（支持层级分组）
│   │   ├── ConfigEditDialog.tsx  # 配置文件创建/编辑弹窗
│   │   ├── GroupCascader.tsx     # 多级分组级联选择器
│   │   ├── FileTree.tsx          # 文件浏览器（含书签、内联重命名）
│   │   ├── TerminalInstance.tsx  # xterm.js 终端（含插件）
│   │   ├── TerminalPanel.tsx     # 终端路由与分屏布局
│   │   ├── TabSidebar.tsx        # 垂直标签导航
│   │   ├── TerminalTabBar.tsx    # 水平标签栏
│   │   ├── SettingsPage.tsx      # 设置面板（8 个分区）
│   │   ├── TextEditor.tsx        # Monaco Editor 文本编辑器
│   │   ├── AiUsagePanel.tsx      # AI 用量悬浮面板
│   │   └── ...
│   ├── stores/appStore.ts        # Zustand 状态管理
│   ├── services/tauri.ts         # Tauri invoke 封装
│   ├── services/aiUsage.ts       # AI API 用量获取
│   ├── data/commandTemplates.ts  # 模板定义与历史记录
│   ├── utils/settings.ts         # 前端设置（localStorage）
│   └── types/index.ts            # TypeScript 类型与预设
├── src-tauri/                    # 后端（Rust/Tauri）
│   └── src/
│       ├── lib.rs                # 应用初始化、托盘、单实例、Web API
│       ├── commands/             # Tauri 命令处理
│       │   ├── terminal.rs       # PTY 管理（TerminalService）
│       │   ├── profile.rs        # 配置文件 CRUD + 导入/导出
│       │   ├── history.rs        # 命令历史
│       │   ├── settings.rs       # 应用设置、数据路径、Web API 设置
│       │   ├── window.rs         # 窗口控制（最小化/最大化/关闭）
│       │   ├── ai_usage.rs       # 百度千帆 API 用量
│       │   └── ...
│       ├── services/             # 业务逻辑（JSON 文件读写）
│       │   └── web_service.rs    # 终端输出发布/订阅（WebSocket）
│       ├── models/               # 数据结构
│       ├── web/                  # Web API 模块（axum）
│       │   ├── server.rs         # Axum 路由与 SPA 服务
│       │   ├── auth.rs           # JWT 认证
│       │   ├── ws.rs             # WebSocket 终端 I/O
│       │   └── handlers/         # REST 处理器（认证、配置、终端）
│       └── portable-pty-patched/ # portable-pty 本地补丁
└── web/                          # Web 前端（独立 React SPA）
    └── src/
        ├── components/           # 登录页、主布局、终端视图、移动端输入栏
        ├── api/                  # 认证、配置、终端 API 客户端
        └── hooks/useTerminal.ts  # WebSocket 终端 Hook
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

### 设置分区

| 分区 | 说明 |
|------|------|
| 通用 | 恢复标签页、关闭行为、标签导航、主题模式、数据路径、导入/导出 |
| 连接管理 | 创建、编辑、删除、复制、分组配置文件 |
| 命令模板 | 10 个分类模板、自定义命令、显示/隐藏、编辑描述 |
| 主题管理 | 8 款预设 + 自定义 16 色编辑器，实时预览 |
| 命令历史 | 搜索、编辑命令和备注、清空 |
| 文件排除 | 文件树排除规则（精确名称、`*.ext`、`**/*.ext`） |
| AI 用量 | 智谱 GLM API Key、百度千帆 Cookie、Deepseek API Key |
| Web 远程管理 | 启用/禁用 Web API、端口、凭据、服务器控制 |

## 开源协议

[MIT](LICENSE)
