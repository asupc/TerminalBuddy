# TerminalBuddy

A modern desktop terminal emulator for Windows, built with Tauri 2 + React 18 + Rust.

[中文文档](README_zh.md)
## Features

- **Multi-terminal Support** — PowerShell, CMD, SSH, Docker, Kubernetes, Remote Desktop (MSTSC)
- **Profile Management** — Create and organize terminal profiles with custom startup paths, commands, environment variables, profile-specific colors, and hierarchical grouping
- **Tabbed Interface** — Vertical sidebar or horizontal tab bar, grouped tabs with color labels, breathing light effects, drag-and-drop reordering, recursive group collapse
- **File Tree Browser** — Built-in local file explorer with bookmarks, exclusion patterns (e.g. `node_modules`, `.git`), and drag-and-drop to terminal
- **Remote File Manager** — SSH remote file browsing with breadcrumb navigation, context menu (upload, download, rename, copy, move, chmod, delete), transfer progress indicator
- **Server Monitor** — Real-time SSH server monitoring: CPU, memory, swap, disk usage, network speed, uptime, configurable refresh interval
- **Theme System** — 8 preset themes + custom 16-color ANSI theme editor, dark/light/system mode
- **Autocomplete** — Smart command suggestions from templates and history with fuzzy matching
- **Command History** — Searchable history with notes support, import/export
- **Command Templates** — 10 categories of predefined templates (Network, Process, File, System, Git, Docker, Python, Node, .NET, PowerShell) plus custom commands
- **Git Integration** — Built-in Git GUI in the file panel: repository status, branch list/checkout, pull, commit (all or selected paths), push with preview & options, SVG commit history graph, and per-file diff viewer
- **Search in Terminal** — Ctrl+F to search terminal output
- **Clipboard Integration** — Paste file paths directly from Explorer (Ctrl+V), right-click paste
- **IME Support** — Position lock for CJK input method composition
- **Web Links** — Ctrl+click to open URLs in browser
- **Workspace Management** — Save and restore terminal layouts as workspaces
- **Window & Tray** — Windowed/maximized launch mode, launch at login, close to tray, single instance mode
- **AI Usage Monitoring** — Track API usage for Zhipu GLM, Baidu Qianfan, DeepSeek, Minimax, and Volcano Ark (火山方舟)
- **Web Remote Access** — Built-in HTTP/WebSocket server for browser-based remote terminal access with JWT authentication, mobile-friendly input bar
- **Text Editor** — Monaco Editor integration, double-click files in File Tree to open editor tabs, syntax highlighting, find/replace, format document
- **Data Portability** — All data stored as JSON files, with full import/export support

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Frontend | React 18, TypeScript, Zustand 5, xterm.js 5.5, Monaco Editor |
| Backend | Rust (edition 2021), Tauri 2, portable-pty (ConPTY) |
| Web API | axum 0.8, tower-http, JWT (jsonwebtoken), bcrypt |
| Web Frontend | React 18, Zustand 5, xterm.js, axios |
| Build | Vite 5, NSIS installer |

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
│   ├── services/tauri.ts  # Tauri invoke wrappers (108 commands)
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
│       ├── lib.rs  # App setup, tray, single instance, Web API (108 commands)
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
│       │   ├── theme.rs  # Custom theme CRUD
│       │   ├── web.rs  # Web API server control
│       │   └── workspace.rs  # Workspace CRUD
│       ├── services/  # Business logic
│       │   ├── profile_service.rs  # Profile JSON I/O
│       │   ├── settings_service.rs  # Settings JSON I/O
│       │   ├── template_service.rs  # Template JSON I/O
│       │   ├── theme_service.rs  # Theme JSON I/O
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

### Settings Sections

| Section | Description |
|---------|-------------|
| General | Restore tabs, close behavior, launch window mode, launch at login, tab navigation, theme mode, list selection style, data path, import/export |
| Profiles | Create, edit, delete, copy, group profiles |
| Commands | 10 categories of templates, custom commands, show/hide, edit descriptions |
| Themes | 8 presets + custom 16-color editor with live preview |
| History | Search, edit commands and notes, clear |
| Exclusions | File tree exclusion patterns (exact name, `*.ext`, `**/*.ext`) |
| AI Usage | Zhipu GLM API key, Baidu Qianfan cookie, DeepSeek API key, Minimax API key, Volcano Ark (火山方舟) cookie |
| Web Management | Enable/disable Web API, port, credentials, server control, session sharing |

## License

[MIT](LICENSE)
