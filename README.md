# TerminalBuddy

A modern desktop terminal emulator for Windows, built with Tauri 2 + React 18 + Rust.

[中文文档](README_zh.md)
## Features

- **Multi-terminal Support** — PowerShell, CMD, SSH, Docker, Kubernetes
- **Profile Management** — Create and organize terminal profiles with custom startup paths, commands, environment variables, profile-specific colors, and hierarchical grouping
- **Tabbed Interface** — Vertical sidebar or horizontal tab bar, grouped tabs with color labels, drag-and-drop reordering, recursive group collapse
- **File Tree Browser** — Built-in file explorer with bookmarks, exclusion patterns (e.g. `node_modules`, `.git`), and drag-and-drop to terminal
- **Theme System** — 8 preset themes + custom 16-color ANSI theme editor, dark/light/system mode
- **Autocomplete** — Smart command suggestions from templates and history with fuzzy matching
- **Command History** — Searchable history with notes support, import/export
- **Command Templates** — 10 categories of predefined templates (Network, Process, File, System, Git, Docker, Python, Node, .NET, PowerShell) plus custom commands
- **Search in Terminal** — Ctrl+F to search terminal output
- **Clipboard Integration** — Paste file paths directly from Explorer (Ctrl+V), right-click paste
- **IME Support** — Position lock for CJK input method composition
- **Web Links** — Ctrl+click to open URLs in browser
- **Workspace Management** — Save and restore terminal layouts as workspaces
- **System Tray** — Close to tray, single instance mode
- **AI Usage Monitoring** — Track API usage for Zhipu GLM, Baidu Qianfan, and Deepseek
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
│   ├── App.tsx                   # Root component
│   ├── components/
│   │   ├── TitleBar.tsx          # Custom frameless title bar
│   │   ├── ConfigPanel.tsx       # Profile list panel with hierarchical groups
│   │   ├── ConfigEditDialog.tsx  # Profile create/edit modal with GroupCascader
│   │   ├── GroupCascader.tsx     # Multi-level group cascade selector
│   │   ├── FileTree.tsx          # File browser with bookmarks, inline rename
│   │   ├── TerminalInstance.tsx  # xterm.js terminal with addons
│   │   ├── TerminalPanel.tsx     # Terminal routing & split layout
│   │   ├── TabSidebar.tsx        # Vertical tab navigation
│   │   ├── TerminalTabBar.tsx    # Horizontal tab bar
│   │   ├── SettingsPage.tsx      # Settings overlay (8 sections)
│   │   ├── TextEditor.tsx        # Monaco Editor text editor
│   │   ├── AiUsagePanel.tsx      # AI usage hover panel
│   │   └── ...
│   ├── stores/appStore.ts        # Zustand state management
│   ├── services/tauri.ts         # Tauri invoke wrappers
│   ├── services/aiUsage.ts       # AI API usage fetching
│   ├── data/commandTemplates.ts  # Template definitions & history
│   ├── utils/settings.ts         # Frontend settings (localStorage)
│   └── types/index.ts            # TypeScript types & presets
├── src-tauri/                    # Backend (Rust/Tauri)
│   └── src/
│       ├── lib.rs                # App setup, tray, single instance, Web API
│       ├── commands/             # Tauri command handlers
│       │   ├── terminal.rs       # PTY management (TerminalService)
│       │   ├── profile.rs        # Profile CRUD + export/import
│       │   ├── history.rs        # Command history
│       │   ├── settings.rs       # App settings, data path, Web API settings
│       │   ├── window.rs         # Window controls (minimize/maximize/close)
│       │   ├── ai_usage.rs       # Baidu Qianfan API usage
│       │   └── ...
│       ├── services/             # Business logic (JSON file I/O)
│       │   └── web_service.rs    # Terminal output pub/sub for WebSocket
│       ├── models/               # Data structures
│       ├── web/                  # Web API module (axum)
│       │   ├── server.rs         # Axum router & SPA serving
│       │   ├── auth.rs           # JWT authentication
│       │   ├── ws.rs             # WebSocket terminal I/O
│       │   └── handlers/         # REST handlers (auth, profiles, terminals)
│       └── portable-pty-patched/ # Local patch for portable-pty
└── web/                          # Web frontend (separate React SPA)
    └── src/
        ├── components/           # LoginPage, MainLayout, TerminalView, MobileInputBar
        ├── api/                  # Auth, profiles, terminals API clients
        └── hooks/useTerminal.ts  # WebSocket terminal hook
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
| General | Restore tabs, close behavior, tab navigation, theme mode, data path, import/export |
| Profiles | Create, edit, delete, copy, group profiles |
| Commands | 10 categories of templates, custom commands, show/hide, edit descriptions |
| Themes | 8 presets + custom 16-color editor with live preview |
| History | Search, edit commands and notes, clear |
| Exclusions | File tree exclusion patterns (exact name, `*.ext`, `**/*.ext`) |
| AI Usage | Zhipu GLM API key, Baidu Qianfan cookie, Deepseek API key |
| Web Management | Enable/disable Web API, port, credentials, server control |

## License

[MIT](LICENSE)
