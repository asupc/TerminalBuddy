# TerminalBuddy - 终端配置管理工具

## 1. 概述与目标

TerminalBuddy 是一款跨平台终端配置管理工具，允许用户通过图形界面定义终端配置（启动路径、执行命令、颜色主题等），实现一键快速启动指定终端会话。

**核心价值**：省去反复打开终端、cd 路径、手动输入启动命令的重复操作。

**技术选型**：Tauri 2.x + React 18 + xterm.js + ConPTY

---

## 2. 技术架构

```
┌─────────────────────────────────────────────────────────┐
│                    TerminalBuddy                         │
├─────────────────────────────────────────────────────────┤
│  Frontend (React 18)                                    │
│  ┌──────────────┬──────────────────────────────────┐   │
│  │  配置面板     │  终端面板 (xterm.js)              │   │
│  │  - 分组列表   │  - 多标签页                       │   │
│  │  - 配置编辑   │  - 命令输入/输出                  │   │
│  │  - 快速启动   │  - 复制粘贴支持                   │   │
│  └──────────────┴──────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│  Backend (Tauri 2.x / Rust)                            │
│  ┌──────────────┬──────────────────────────────────┐   │
│  │  配置服务     │  终端服务 (ConPTY)                 │   │
│  │  - JSON CRUD │  - 创建/销毁终端进程              │   │
│  │  - 文件读写   │  - 输入/输出流转发                │   │
│  └──────────────┴──────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│  Storage                                                │
│  %APPDATA%/TerminalBuddy/Profiles/*.json (Windows)     │
│  ~/.config/terminalbuddy/Profiles/*.json (Linux/macOS)│
└─────────────────────────────────────────────────────────┘
```

---

## 3. 界面布局

### 3.1 整体结构

```
┌─────────────────────────────────────────────────────────┐
│  标题栏: TerminalBuddy                          [─][□][×]│
├────────────┬────────────────────────────────────────────┤
│ 工具栏     │  [新建] [导入] [导出]            [设置]    │
├────────────┼────────────────────────────────────────────┤
│            │  终端面板                                  │
│ 配置面板    │  ┌────────────────────────────────────────┐ │
│ (250px)   │  │ [标签页1] [标签页2] [+]               │ │
│            │  ├────────────────────────────────────────┤ │
│ ▼ 日常工作  │  │ C:\Projects> npm run dev             │ │
│   ├─ 开发环境│  │ > Starting dev server...              │ │
│   └─ 运维    │  │                                      │ │
│ ▼ 实验      │  │                                      │ │
│   └─ 测试环境│  └────────────────────────────────────────┘ │
│            │                                            │
│ [快速启动]  │                                            │
└────────────┴────────────────────────────────────────────┘
```

### 3.2 工具栏

- **新建**: 创建新配置，弹出配置编辑对话框
- **导入**: 从文件选择器导入 .json 配置文件
- **导出**: 将选中配置导出为 .json 文件
- **设置**: 打开设置面板（全局快捷键、默认配置等）

### 3.3 配置面板

- 分组树形列表，支持折叠/展开
- 每项显示: 配置名称、终端类型图标（PS/CMD）、最后使用时间
- 右键菜单: 编辑、复制、删除、立即启动
- 底部快捷启动条: 最近使用的 3 个配置，点击直接启动

### 3.4 终端面板

- 多标签页: 每个打开的终端独占一个标签
- 标签页右键: 关闭、关闭其他、关闭所有
- 支持调整大小（终端内容区自适应）

---

## 4. 配置数据模型

### 4.1 JSON Schema

文件路径: `%APPDATA%/TerminalBuddy/Profiles/{id}.json`

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "开发环境",
  "group": "日常工作",
  "terminalType": "powershell",
  "startupPath": "D:\\Projects",
  "startupCommands": [
    "npm run dev"
  ],
  "environmentVariables": {
    "NODE_ENV": "development"
  },
  "colorTheme": "dark-green",
  "windowSize": {
    "width": 900,
    "height": 600
  },
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
| terminalType | enum | 是 | `powershell` 或 `cmd` |
| startupPath | string | 否 | 终端启动时的初始目录 |
| startupCommands | string[] | 否 | 启动后自动执行的命令列表，逐条执行 |
| environmentVariables | object | 否 | 额外的环境变量键值对 |
| colorTheme | string | 否 | 预设颜色主题 ID |
| windowSize | object | 否 | 终端窗口宽高 |
| createdAt | datetime | 是 | 创建时间（ISO 8601） |
| lastUsedAt | datetime | 否 | 最后使用时间 |

---

## 5. 预设颜色主题

| 主题ID | 名称 | 背景色 | 前景色 | 使用场景 |
|--------|------|--------|--------|----------|
| dark-default | 深色默认 | #1E1E1E | #CCCCCC | 通用 |
| dark-green | 黑客绿 | #0C0C0C | #00FF00 | 复古/黑客风 |
| dark-blue | 海洋蓝 | #0D1B2A | #E0E0E0 | 护眼 |
| dark-powershell | PS深色 | #012456 | #F1F1F1 | PowerShell 默认风格 |
| light | 浅色 | #FFFFFF | #333333 | 明亮环境 |
| solarized-dark | Solarized暗 | #002B36 | #839496 | 程序员护眼 |
| solarized-light | Solarized亮 | #FDF6E3 | #657B83 | 白天使用 |
| vintage | 复古绿屏 | #0A0A0A | #33FF33 | 怀旧风格 |

---

## 6. 模块设计

### 6.1 项目结构 (Tauri + React)

```
terminal-buddy/
├── src/                          # React 前端
│   ├── components/
│   │   ├── Toolbar.tsx          # 工具栏
│   │   ├── ConfigPanel.tsx      # 左侧配置面板
│   │   ├── TerminalPanel.tsx    # 右侧终端面板
│   │   ├── ConfigEditDialog.tsx # 配置编辑对话框
│   │   └── TerminalTab.tsx      # 终端标签页
│   ├── hooks/
│   │   ├── useProfiles.ts       # 配置管理 Hook
│   │   └── useTerminal.ts      # 终端管理 Hook
│   ├── services/
│   │   └── tauri.ts             # Tauri API 封装
│   ├── types/
│   │   └── index.ts            # TypeScript 类型定义
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── main.rs             # 入口
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── profile.rs      # 配置 CRUD 命令
│   │   │   └── terminal.rs     # 终端管理命令
│   │   └── services/
│   │       ├── mod.rs
│   │       ├── profile_service.rs
│   │       └── terminal_service.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── vite.config.ts
```

### 6.2 核心模块职责

| 模块 | 职责 | 技术 |
|------|------|------|
| profile_service | 配置的 JSON 文件 CRUD | Rust + serde_json |
| terminal_service | ConPTY 进程管理、输入输出流转发 | Rust + conpty |
| ConfigPanel | 配置列表展示、分组折叠、右键菜单 | React + zustand |
| TerminalPanel | 多标签页管理、xterm.js 实例管理 | React + xterm.js |
| ConfigEditDialog | 配置编辑表单、命令模板选择 | React + react-hook-form |

---

## 7. 数据流

### 7.1 启动终端流程

```
用户点击配置
    ↓
React: TerminalPanel.startProfile(profileId)
    ↓
Tauri Command: start_terminal(profile_id)
    ↓
Rust: profile_service.read_profile(id)
    ↓
Rust: terminal_service.create_conpty(profile)
    ↓
创建 powershell.exe / cmd.exe 进程，附加 ConPTY
    ↓
Rust: 开启 stdout/stderr 流转发线程
    ↓
Tauri Event: terminal_output -> xterm.js.write()
```

### 7.2 命令输入流程

```
用户在 xterm.js 输入命令
    ↓
xterm.js 捕获键盘事件
    ↓
xterm.js.write(input)
    ↓
Tauri Command: write_to_terminal(id, input)
    ↓
Rust: terminal_service.write(id, input)
    ↓
ConPTY -> 写入终端进程 stdin
```

---

## 8. MVP 实施范围

### 必须有（MVP）

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | 配置创建/编辑/删除 | JSON 文件存储 |
| P0 | 配置列表展示 | 支持分组折叠 |
| P0 | 单终端启动 | PowerShell / CMD |
| P0 | 终端基本交互 | 输入/输出/复制粘贴 |
| P0 | 多标签页管理 | 切换/关闭 |
| P1 | 预设颜色主题 | 8 种预设主题 |
| P1 | 命令模板 | 常用命令快捷插入 |
| P2 | 启动命令自动执行 | 需 ConPTY 输入重定向 |

### 后续迭代

| 功能 | 说明 |
|------|------|
| 实时自动补全 | 基于历史和模板 |
| 环境变量配置 | Key-Value 编辑 |
| 导入/导出配置 | JSON 文件 |
| 快捷键绑定 | 全局快捷键 |
| 自定义命令模板 | 用户自定义 |

---

## 9. 终端托管方案

### 9.1 ConPTY 集成

采用 `rusty_pseudo` 或直接调用 Windows API (`windows-rs`) 创建 ConPTY：

```rust
// 核心流程
1. OpenPseudoConsole() 创建 ConPTY
2. SpawnProcess() 在 ConPTY 中启动 powershell.exe / cmd.exe
3. ConPTY 输入/输出通过管道转发
```

### 9.2 跨平台支持

| 平台 | 终端方案 |
|------|---------|
| Windows | ConPTY |
| Linux | pty (nix crate) |
| macOS | pty (nix crate) |

---

## 10. 验收标准

- [ ] 可创建新配置，选择终端类型（PowerShell / CMD）
- [ ] 配置列表按分组折叠展示
- [ ] 点击配置后，右侧终端面板新增标签页并启动对应终端
- [ ] 可切换终端类型（powershell / cmd）
- [ ] 可为配置选择预设颜色主题
- [ ] 关闭标签页可终止对应终端进程
- [ ] 配置以独立 JSON 文件保存在 Profiles 目录
- [ ] 复制粘贴功能正常
- [ ] 终端输入输出正常
