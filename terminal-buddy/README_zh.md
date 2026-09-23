# TerminalBuddy

一个基于 Tauri 2 + React 18 + Rust 构建的现代化 Windows 桌面终端模拟器。

[English](README.md)

## 用户文档

- [完整使用与配置指南](docs/完整使用与配置指南.md)
- [使用技巧速查](docs/使用技巧.md)
- [机器人通知接入指南](docs/机器人通知接入指南.md)

## 功能特性

- **多终端类型** — 支持 PowerShell、CMD、SSH、Docker、Kubernetes、远程桌面（MSTSC）
- **配置文件管理** — 创建和组织终端配置，支持自定义启动路径、命令、环境变量、配置专属颜色和层级分组
- **标签页界面** — 垂直侧边栏或水平标签栏，分组标签页、颜色标签、呼吸灯效果、拖拽排序、递归分组折叠
- **文件树浏览器** — 内置本地文件浏览器，支持书签、排除规则、拖拽文件到终端、内联重命名
- **远程文件管理器** — SSH 远程文件浏览，面包屑导航，右键菜单（上传、下载、重命名、复制、移动、修改权限、删除），传输进度显示
- **服务器监控** — 实时 SSH 服务器监控：CPU、内存、交换分区、磁盘使用、网络速度、运行时间，可配置刷新间隔
- **主题系统** — 8 款内置主题 + 自定义 16 色 ANSI 主题编辑器，支持深色/浅色/跟随系统
- **智能补全** — 基于模板和历史记录的命令自动补全，支持模糊匹配
- **命令历史** — 可搜索的命令历史，支持添加备注、导入/导出
- **命令模板** — 10 个分类的预定义模板（网络、进程、文件、系统、Git、Docker、Python、Node、.NET、PowerShell），支持自定义命令
- **Git 集成** — 文件面板内置 Git 图形界面：仓库状态、分支列表/切换、拉取、提交（全部或选定文件）、推送（含预览与选项）、SVG 提交历史图、单文件差异查看
- **终端搜索** — Ctrl+F 搜索终端输出内容
- **剪贴板集成** — 从资源管理器直接粘贴文件路径（Ctrl+V），右键粘贴
- **输入法支持** — CJK 输入法组合时的位置锁定
- **Web 链接** — Ctrl+点击在浏览器中打开 URL
- **工作区管理** — 保存和恢复终端布局
- **窗口与托盘** — 窗口/最大化启动模式、开机自启、关闭到托盘、单实例模式
- **AI 用量监控** — 查看智谱 GLM、百度千帆、DeepSeek、Minimax 和火山方舟的 API 用量
- **Web 远程访问** — 内置 HTTP/WebSocket 服务器，支持浏览器远程终端访问，JWT 认证，移动端友好输入栏
- **Claude Code 机器人通知** — 支持飞书、企业微信、DingTalk 及 QQ/通用桥接，发送终端截图并通过引用回复完成远程决策（[接入指南](docs/机器人通知接入指南.md)）
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
│   ├── App.tsx  # 根组件
│   ├── components/
│   │   ├── TitleBar.tsx  # 自定义无边框标题栏
│   │   ├── ConfigNav.tsx  # 配置文件列表面板（支持层级分组）
│   │   ├── ConfigEditDialog.tsx  # 配置文件创建/编辑弹窗
│   │   ├── GroupCascader.tsx  # 多级分组级联选择器
│   │   ├── FileNav.tsx  # 本地文件浏览器（书签、内联重命名）+ 内嵌 Git 工具栏
│   │   ├── GitNavBar.tsx  # Git 操作工具栏（状态、分支、拉取、提交、推送）
│   │   ├── GitHistoryPage.tsx  # 提交历史页（SVG 图）
│   │   ├── GitHistoryDiffPreview.tsx  # 历史文件差异预览
│   │   ├── HistoryGraphSvg.tsx  # SVG 提交图渲染器
│   │   ├── RemoteFileTree.tsx  # SSH 远程文件浏览器（上传/下载/权限管理）
│   │   ├── ServerMonitor.tsx  # SSH 实时服务器监控面板
│   │   ├── ChmodDialog.tsx  # 远程文件权限编辑器
│   │   ├── ExtraParamsDialog.tsx  # SSH 参数预设
│   │   ├── TransferPanel.tsx  # 远程文件传输队列/进度
│   │   ├── TerminalInstance.tsx  # xterm.js 终端（含插件）
│   │   ├── TerminalPanel.tsx  # 终端路由、分屏布局，承载 GitHistoryPage
│   │   ├── TerminalTab.tsx  # 单个标签页组件
│   │   ├── TabNav.tsx  # 垂直标签导航
│   │   ├── TerminalTabBar.tsx  # 水平标签栏
│   │   ├── TreeView.tsx  # 通用树形视图组件
│   │   ├── SettingsPage.tsx  # 设置面板（IntersectionObserver 侧边导航）
│   │   ├── TextEditor.tsx  # Monaco Editor 文本编辑器
│   │   ├── AiUsagePanel.tsx  # AI 用量悬浮面板（5 个提供商）
│   │   ├── WebManageDialog.tsx  # Web 远程管理弹窗（启停、二维码）
│   │   ├── AboutDialog.tsx  # 关于/版本弹窗
│   │   └── Toast.tsx  # 全局通知
│   ├── stores/appStore.ts  # Zustand 状态管理
│   ├── services/tauri.ts  # Tauri invoke 封装
│   ├── services/aiUsage.ts  # AI API 用量获取（5 个提供商）
│   ├── data/commandTemplates.ts  # 模板定义与历史记录
│   ├── data/terminalSuggestions.ts  # VS Code 风格提示词
│   ├── utils/  # 工具模块
│   │   ├── settings.ts  # 前端设置（localStorage）
│   │   ├── contextMenu.ts  # 边缘感知的右键菜单定位
│   │   ├── terminalTheme.ts  # 终端主题辅助
│   │   ├── terminalResizeEvent.ts  # 终端缩放事件
│   │   ├── openTerminalInDir.ts  # 在目录中打开终端
│   │   ├── fileExtensions.ts  # 文件扩展名映射
│   │   ├── groupHierarchy.ts  # 分组层级工具
│   │   ├── groupTree.ts  # 分组树构建
│   │   ├── tabColor.ts  # 标签颜色工具
│   │   ├── formatDuration.ts  # 时长格式化
│   │   ├── migration.ts  # 数据迁移辅助
│   │   └── bootLog.ts  # 启动日志
│   └── types/index.ts  # TypeScript 类型与预设
├── src-tauri/                    # 后端（Rust/Tauri）
│   └── src/
│       ├── lib.rs  # 应用初始化、托盘、单实例、Web API
│       ├── commands/  # Tauri 命令处理
│       │   ├── terminal.rs  # PTY 管理（TerminalService）
│       │   ├── profile.rs  # 配置文件 CRUD + 导入/导出
│       │   ├── settings.rs  # 应用设置、数据路径、Web API 设置
│       │   ├── git.rs  # Git 图形界面后端（状态、分支、拉取、推送、提交、历史、差异）
│       │   ├── window.rs  # 窗口控制（最小化/最大化/关闭）
│       │   ├── remote_file.rs  # SSH 远程文件操作
│       │   ├── server_monitor.rs  # SSH 服务器状态监控
│       │   ├── client_data.rs  # 客户端数据持久化
│       │   ├── ai_usage.rs  # AI API 用量（千帆、Deepseek、Minimax、火山方舟）
│       │   ├── clipboard.rs  # 剪贴板操作
│       │   ├── fs.rs  # 本地文件系统操作
│       │   ├── templates.rs  # 命令模板管理
│       │   ├── web.rs  # Web API 服务器控制
│       │   └── workspace.rs  # 工作区 CRUD
│       ├── services/  # 业务逻辑
│       │   ├── profile_service.rs  # 配置文件 JSON 读写
│       │   ├── settings_service.rs  # 设置 JSON 读写
│       │   ├── template_service.rs  # 模板 JSON 读写
│       │   ├── workspace_service.rs  # 工作区 JSON 读写
│       │   ├── web_service.rs  # 终端输出发布/订阅（WebSocket）
│       │   ├── path_service.rs  # 数据目录解析与迁移
│       │   ├── ssh_session_service.rs  # SSH 会话管理
│       │   ├── client_data_service.rs  # 客户端数据持久化
│       │   └── crypto_service.rs  # 加密辅助
│       ├── models/  # 数据结构（Profile、AppSettings 等）
│       ├── web/  # Web API 模块（axum）
│       │   ├── server.rs  # Axum 路由与 SPA 服务
│       │   ├── auth.rs  # JWT 认证
│       │   ├── ws.rs  # WebSocket 终端 I/O
│       │   ├── error.rs  # 错误类型
│       │   └── handlers/  # REST 处理器（认证、配置、终端）
│       └── portable-pty-patched/  # portable-pty 本地补丁
└── web/  # Web 前端（独立 React SPA）
    └── src/
        ├── screens/  # 登录、导航、终端
        ├── components/  # Xterm（移动端友好）、InputBar
        ├── api.ts  # 认证 + REST 客户端
        ├── hooks/useMetaWs.ts  # 元通道（配置/终端列表、会话事件）
        └── hooks/useTerminalWs.ts  # 单终端 WebSocket I/O
```

### 数据存储

所有用户数据以 JSON 文件存储在 `%APPDATA%/TerminalBuddy/` 目录下：

```
%APPDATA%/TerminalBuddy/
├── Profiles/                  # 终端配置文件
├── Workspaces/                # 保存的工作区
├── command_history.json       # 命令历史（含备注）
├── command_templates.json     # 命令模板
└── settings.json              # 应用设置
```

### 设置分区

| 分区 | 说明 |
|------|------|
| 通用 | 恢复标签页、关闭行为、启动窗口模式、开机自启、标签导航、主题模式、列表选中样式、数据路径、导入/导出 |
| 连接管理 | 创建、编辑、删除、复制、分组配置文件 |
| 命令模板 | 10 个分类模板、自定义命令、显示/隐藏、编辑描述 |
| 命令历史 | 搜索、编辑命令和备注、清空 |
| 文件排除 | 文件树排除规则（精确名称、`*.ext`、`**/*.ext`） |
| AI 用量 | 智谱 GLM API Key、百度千帆 Cookie、DeepSeek API Key、Minimax API Key、火山方舟 Cookie |
| Web 远程管理 | 启用/禁用 Web API、端口、凭据、服务器控制、会话共享 |

## 开源协议

[MIT](LICENSE)
