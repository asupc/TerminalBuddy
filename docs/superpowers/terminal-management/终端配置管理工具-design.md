# TerminalBuddy - 终端配置管理工具

## 1. 概述与目标

TerminalBuddy 是一款 Windows 桌面终端管理工具，允许用户通过图形界面定义终端配置（启动路径、执行命令、颜色主题、SSH/Docker/K8s 连接等），实现一键快速启动指定终端会话。支持多标签分组、自定义主题编辑、命令补全、终端搜索、工作区管理等高级功能。

**核心价值**：省去反复打开终端、cd 路径、手动输入启动命令的重复操作；统一管理本地和远程终端环境。

**技术选型**：Tauri 2.x + React 18 + xterm.js + ConPTY

---

## 2. 技术架构

```
┌──────────────────────────────────────────────────────────────┐
│                    TerminalBuddy                              │
├──────────────────────────────────────────────────────────────┤
│  Frontend (React 18 + Zustand)                               │
│  ┌──────────────┬────────────────────────────────────────┐  │
│  │  配置/文件面板 │  终端面板 (xterm.js)                    │  │
│  │  - 配置列表   │  - 多标签页（分组）                     │  │
│  │  - 文件树     │  - 搜索 (Ctrl+F)                       │  │
│  │  - 书签栏     │  - 命令自动补全                          │  │
│  │  - 排序/搜索  │  - Ctrl+Click URL 打开                  │  │
│  └──────────────┴────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│  Backend (Tauri 2.x / Rust)                                 │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┐  │
│  │ Profile  │ Terminal │ Theme    │ History  │ Workspace│  │
│  │ Service  │ Service  │ Service  │ Service  │ Service  │  │
│  │ JSON CRUD│ ConPTY   │ JSON CRUD│ JSON CRUD│ JSON CRUD│  │
│  └──────────┴──────────┴──────────┴──────────┴──────────┘  │
├──────────────────────────────────────────────────────────────┤
│  Storage: %APPDATA%/TerminalBuddy/                           │
│  ├── Profiles/*.json    配置文件                              │
│  ├── Themes/*.json      自定义主题                            │
│  ├── Workspaces/*.json  工作区                                │
│  ├── command_history.json   命令历史                          │
│  ├── command_templates.json  命令模板                         │
│  └── settings.json      全局设置                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. 界面布局

### 3.1 整体结构

```
┌──────────────────────────────────────────────────────────────┐
│  标题栏: TerminalBuddy                        [─][□][×]     │
├────────────┬─────────────────────────────────────────────────┤
│            │  终端面板                                       │
│ 标签侧栏    │  ┌──────────────────────────────────────────┐  │
│ (可调宽度)  │  │ [搜索栏] Ctrl+F 触发                     │  │
│            │  ├──────────────────────────────────────────┤  │
│ 🔍 搜索    │  │                                          │  │
│ ▼ 日常工作  │  │ C:\Projects> npm run dev                 │  │
│   ● 开发环境│  │ > Starting dev server...                 │  │
│   ● 运维    │  │                                          │  │
│ ▼ 实验      │  │  [自动补全弹窗]                           │  │
│   ● 测试环境│  │                                          │  │
│            │  └──────────────────────────────────────────┘  │
│ [+ 添加连接]│                                                │
└────────────┴─────────────────────────────────────────────────┘
```

### 3.2 标签侧栏（TabSidebar）

- 可调整宽度（150-400px），宽度持久化
- 按配置分组（group 字段）展示，组可折叠/展开
- 顶部搜索框按名称过滤
- 右键菜单：添加连接（PowerShell/CMD/分组内配置）、关闭所有标签
- 中键点击关闭标签
- 彩色圆点标识标签颜色
- 可切换为水平标签栏模式（设置中关闭"标签导航"）

### 3.3 终端面板

- 多标签页：每个打开的终端独占一个标签，同一时间只显示活跃终端
- 标签页右键：关闭、关闭其他、关闭所有
- Ctrl+F 搜索终端输出内容
- Ctrl+Click 打开 URL
- 命令自动补全弹窗

### 3.4 设置页面（SettingsPage）

6 个设置分区：

| 分区 | 功能 |
|------|------|
| 通用 | 启动恢复标签、面板自动展开、关闭行为、标签导航、右键粘贴、单实例、主题模式(深/浅/跟随系统)、数据存储路径、数据导入导出 |
| 配置 | 搜索、分组、CRUD、复制、导入导出 |
| 命令 | 搜索、分类标签、自定义命令、覆盖描述、隐藏预设 |
| 主题 | 8 预设 + 自定义主题 CRUD，11 色编辑器 + 实时预览 |
| 历史 | 搜索、编辑命令/备注、删除、清空 |
| 排除 | 文件树排除模式（默认 node_modules、.git） |

---

## 4. 配置数据模型

### 4.1 JSON Schema

文件路径: `%APPDATA%/TerminalBuddy/Profiles/{name}.json`

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "开发环境",
  "group": "日常工作",
  "terminalType": "powershell",
  "startupPath": "D:\\Projects",
  "startupCommands": ["npm run dev"],
  "environmentVariables": { "NODE_ENV": "development" },
  "colorTheme": "dark-green",
  "tabColor": "#4FC3F7",
  "windowSize": { "width": 900, "height": 600 },
  "sshHost": null,
  "sshPort": 22,
  "sshUser": null,
  "sshAuthType": "key",
  "sshKeyPath": null,
  "dockerContainerId": null,
  "dockerContainerName": null,
  "k8sNamespace": null,
  "k8sPodName": null,
  "k8sContainerName": null,
  "createdAt": "2026-05-13T10:00:00Z",
  "lastUsedAt": "2026-05-13T14:30:00Z"
}
```

### 4.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | GUID | 是 | 全局唯一标识符 |
| name | string | 是 | 配置显示名称 |
| group | string | 否 | 分组名称，默认为"默认" |
| terminalType | enum | 是 | `powershell` / `cmd` / `ssh` / `docker` / `k8s` |
| startupPath | string | 否 | 终端启动时的初始目录 |
| startupCommands | string[] | 否 | 启动后自动执行的命令列表，逐条执行 |
| environmentVariables | object | 否 | 额外的环境变量键值对 |
| colorTheme | string | 否 | 颜色主题 ID |
| tabColor | string | 否 | 标签颜色（16 进制色值或 null） |
| windowSize | object | 否 | 终端窗口宽高（已定义但前端未使用） |
| sshHost / sshPort / sshUser | string/number | 否 | SSH 连接参数 |
| sshAuthType | string | 否 | `password` / `key` |
| sshKeyPath | string | 否 | SSH 密钥路径 |
| dockerContainerId / dockerContainerName | string | 否 | Docker 容器标识 |
| k8sNamespace / k8sPodName / k8sContainerName | string | 否 | K8s 资源标识 |
| createdAt | datetime | 是 | 创建时间（ISO 8601） |
| lastUsedAt | datetime | 否 | 最后使用时间 |

---

## 5. 主题系统

### 5.1 预设主题

| 主题ID | 名称 | 背景色 | 前景色 |
|--------|------|--------|--------|
| dark-default | 深色默认 | #1E1E1E | #CCCCCC |
| dark-green | 黑客绿 | #0C0C0C | #00FF00 |
| dark-blue | 海洋蓝 | #0D1B2A | #E0E0E0 |
| dark-powershell | PS深色 | #012456 | #F1F1F1 |
| light | 浅色 | #FFFFFF | #333333 |
| solarized-dark | Solarized暗 | #002B36 | #839496 |
| solarized-light | Solarized亮 | #FDF6E3 | #657B83 |
| vintage | 复古绿屏 | #0A0A0A | #33FF33 |

### 5.2 自定义主题

支持创建自定义主题，包含 11 个颜色槽：背景、前景、光标、ANSI 黑/红/绿/黄/蓝/品红/青/白。主题存储在 `%APPDATA%/TerminalBuddy/Themes/{name}.json`，支持实时预览编辑。

---

## 6. 后端命令清单

共 37 个 Tauri 命令，分 10 个模块：

| 模块 | 命令数 | 命令列表 |
|------|--------|----------|
| 配置 (Profile) | 8 | get_all_profiles, get_profile, create_profile, update_profile, delete_profile, update_profile_last_used, export_all_profiles, import_all_profiles |
| 终端 (Terminal) | 6 | start_terminal, write_to_terminal, resize_terminal, close_terminal, start_blank_terminal, drain_terminal_output |
| 文件系统 (FS) | 5 | list_directory, open_path, open_in_explorer, delete_path, rename_path |
| 主题 (Theme) | 4 | get_all_themes, create_theme, update_theme, delete_theme |
| 剪贴板 (Clipboard) | 1 | read_clipboard_file_paths |
| 设置 (Settings) | 7 | get_app_settings, save_close_behavior, get_data_path, set_data_path, save_tab_sidebar_width, save_enable_tab_navigation, save_single_instance |
| 工作区 (Workspace) | 5 | get_all_workspaces, get_workspace, create_workspace, update_workspace, delete_workspace |
| 历史 (History) | 7 | get_command_history, add_command_to_history, delete_command_from_history, update_command_in_history, update_command_note, clear_command_history, import_command_history |
| 模板 (Template) | 3 | get_command_templates, save_command_templates, init_command_templates |
| 数据 I/O | 2 | export_all_data, import_all_data |
| 窗口 (Window) | 4 | window_minimize, window_toggle_maximize, window_close, window_exit_app |

---

## 7. 项目结构

```
terminal-buddy/
├── src/                              # React 前端
│   ├── components/
│   │   ├── App.tsx                   # 根组件
│   │   ├── ConfigPanel.tsx           # 左侧配置面板
│   │   ├── ConfigEditDialog.tsx      # 配置编辑对话框
│   │   ├── FileTree.tsx              # 文件浏览器
│   │   ├── SettingsPage.tsx          # 设置页面（6 分区）
│   │   ├── TabSidebar.tsx            # 标签侧栏
│   │   ├── TerminalPanel.tsx         # 终端面板容器
│   │   ├── TerminalInstance.tsx      # xterm.js 终端实例
│   │   ├── TerminalTab.tsx           # 标签组件
│   │   ├── TerminalTabBar.tsx        # 水平标签栏
│   │   ├── TitleBar.tsx              # 自定义标题栏
│   │   └── Toolbar.tsx               # 工具栏
│   ├── hooks/
│   │   └── useResizablePanel.ts      # 可调面板 Hook
│   ├── services/
│   │   └── tauri.ts                  # Tauri API 封装（37+ 命令）
│   ├── stores/
│   │   └── appStore.ts              # Zustand 状态管理
│   ├── data/
│   │   └── commandTemplates.ts       # 命令模板数据
│   ├── types/
│   │   └── index.ts                  # TypeScript 类型定义
│   ├── utils/
│   │   └── settings.ts              # 前端设置 + 主题模式
│   └── main.tsx
├── src-tauri/                         # Rust 后端
│   ├── src/
│   │   ├── lib.rs                    # 入口 + 命令注册 + 系统托盘
│   │   ├── commands/
│   │   │   ├── mod.rs                # 命令模块汇总
│   │   │   ├── profile.rs            # 配置 CRUD
│   │   │   ├── terminal.rs           # 终端管理 + TerminalService
│   │   │   ├── settings.rs           # 设置命令
│   │   │   ├── workspace.rs          # 工作区命令
│   │   │   ├── window.rs             # 窗口控制
│   │   │   └── ...                   # history, template, theme, fs, clipboard
│   │   ├── services/
│   │   │   ├── profile_service.rs    # 配置 JSON CRUD
│   │   │   ├── theme_service.rs      # 主题 JSON CRUD
│   │   │   ├── workspace_service.rs  # 工作区 JSON CRUD
│   │   │   ├── history_service.rs    # 命令历史（最大 100 条）
│   │   │   ├── template_service.rs   # 命令模板
│   │   │   ├── settings_service.rs   # 全局设置
│   │   │   └── path_service.rs       # 数据目录解析
│   │   └── models/
│   │       ├── profile.rs            # Profile + WindowSize
│   │       ├── settings.rs           # AppSettings + CloseBehavior
│   │       ├── theme.rs              # CustomTheme（11 色）
│   │       └── workspace.rs          # Workspace + Group + Terminal
│   └── portable-pty-patched/         # 本地 ConPTY 补丁
├── package.json
└── vite.config.ts
```

---

## 8. 数据流

### 8.1 启动终端流程

```
用户点击配置
    ↓
React: startTerminal(profileId)
    ↓
Tauri Command: start_terminal(profile_id)
    ↓
Rust: profile_service.read_profile(id)
    ↓
Rust: TerminalService.create_conpty(profile)
    ↓
创建 cmd.exe 进程，注入 PowerShell/SSH/Docker/K8s 命令
    ↓
Rust: 开启 stdout/stderr 流转发线程
    ↓
Tauri Event: terminal_output_{id} → xterm.js.write()
```

### 8.2 命令输入流程

```
用户在 xterm.js 输入命令
    ↓
xterm.js onData 回调
    ↓
Tauri Command: write_to_terminal(id, input)
    ↓
Rust: TerminalService.write(id, input)
    ↓
ConPTY → 写入终端进程 stdin
```

### 8.3 命令补全流程

```
用户在终端输入文本
    ↓
解析当前行内容，提取命令前缀
    ↓
匹配 commandTemplates（按命令前缀或描述模糊匹配）
    ↓
显示最多 8 条建议的补全弹窗
    ↓
↑/↓ 选择，Tab/Enter 确认，Esc 关闭
```

---

## 9. 终端特性

| 特性 | 快捷键/触发方式 | 说明 |
|------|----------------|------|
| 搜索 | Ctrl+F | SearchAddon，支持大小写切换，上/下跳转 |
| URL 打开 | Ctrl+Click | WebLinksAddon 检测 URL，默认浏览器打开 |
| 右键粘贴 | 右键（需开启设置） | 无选中文本时直接粘贴剪贴板内容 |
| 命令补全 | 输入时自动触发 | 匹配模板和历史，弹窗选择 |
| Ctrl+C 复制 | Ctrl+C | 有选中文本时复制到剪贴板 |
| Ctrl+V 粘贴 | Ctrl+V | 智能粘贴：文件路径自动加引号 |
| Ctrl+Shift+Enter | Ctrl+Shift+Enter | 发送换行而不提交 |
| 目录检测 | 自动 | 解析 PS/CMD 提示符，跟踪当前目录 |
| 历史记录 | Enter 提交时 | 自动记录执行的命令 |
| IME 稳定 | 自动 | 防止 TUI 快速输出时输入法窗口跳转 |

---

## 10. 全局设置

| 设置项 | 存储位置 | 默认值 | 说明 |
|--------|----------|--------|------|
| 启动恢复标签 | localStorage | true | 重启后恢复上次打开的标签 |
| 面板自动展开 | localStorage | true | 启动时自动展开配置/文件面板 |
| 关闭行为 | settings.json | exit | exit=直接退出，tray=最小化到托盘 |
| 标签导航 | settings.json | true | true=侧栏模式，false=水平标签栏 |
| 右键粘贴 | localStorage | false | 右键无选中文本时粘贴 |
| 单实例 | settings.json | true | 只允许运行一个实例 |
| 主题模式 | localStorage | dark | dark/light/system |
| 数据存储路径 | settings.json | %APPDATA%/TerminalBuddy | 可自定义，支持迁移 |
| 标签侧栏宽度 | settings.json | 250 | 150-400px 范围 |

---

## 11. 系统行为

### 11.1 系统托盘

- 关闭行为为"托盘"时，关闭窗口最小化到系统托盘
- 托盘菜单："打开窗口"、"退出"
- 双击托盘图标恢复窗口
- 单实例模式下，重复启动激活已有窗口

### 11.2 会话持久化

- 标签状态保存到 localStorage，重启后自动恢复
- 命令历史持久化到 `command_history.json`（最多 100 条）
- 命令模板持久化到 `command_templates.json`
- 目录书签保存到 localStorage

### 11.3 数据导入导出

- 支持全量数据导出（所有配置、主题、工作区、历史、模板、设置）
- 支持全量数据导入
- 支持数据目录迁移（自定义路径 + 自动复制）

---

## 12. 已实现功能清单

- [x] 配置创建/编辑/删除/复制
- [x] 配置列表按分组折叠展示 + 搜索/排序
- [x] 多终端类型支持（PowerShell / CMD / SSH / Docker / K8s 配置）
- [x] 多标签页管理（侧栏模式 + 水平标签栏模式）
- [x] 标签按配置分组显示
- [x] 预设颜色主题（8 种）
- [x] 自定义主题编辑器（11 色 + 实时预览）
- [x] 命令模板（分类、自定义、覆盖、隐藏预设）
- [x] 命令历史（搜索、备注、编辑、导入）
- [x] 启动命令自动执行
- [x] 环境变量配置
- [x] 终端内搜索（Ctrl+F）
- [x] URL 可点击打开（Ctrl+Click）
- [x] 右键粘贴（可配置）
- [x] 命令自动补全
- [x] 智能粘贴（文件路径自动加引号）
- [x] 文件树 + 目录书签
- [x] 文件树排除模式
- [x] 配置导入/导出
- [x] 全量数据导入/导出
- [x] 关闭到托盘
- [x] 单实例模式
- [x] 标签恢复（重启后）
- [x] 自定义标题栏
- [x] 深色/浅色/跟随系统主题模式
- [x] 工作区数据模型和后端 CRUD
- [x] IME 输入法稳定性

## 13. 未实现功能

- [ ] 分屏/分格布局（SplitPane）
- [ ] 工作区 UI（选择器、保存/恢复工作区界面）
- [ ] 广播/批量执行
- [ ] SSH 直接连接（ssh2 crate，当前仅通过 PTY 注入 ssh 命令）
- [ ] Docker 容器列表拉取（docker ps）
- [ ] K8s Pod 列表拉取（kubectl get pods）
- [ ] Profile windowSize 字段实际应用
