# TerminalBuddy

A modern desktop terminal emulator for Windows, built with Tauri 2 + React 18 + Rust.

[中文文档](README_CN.md)

## Features

- **Multi-terminal Support** — PowerShell, CMD, SSH, Docker, Kubernetes, Text Editor, Remote Desktop (MSTSC)
- **Profile Management** — Create and organize terminal profiles with custom startup paths, commands, and environment variables
- **Tabbed Interface** — Grouped tabs with color labels, drag-and-drop reordering, and split pane layouts
- **Theme System** — 8 built-in themes + custom ANSI color theme editor
- **Autocomplete** — Smart command suggestions from templates and history
- **Command Templates** — Predefined and custom command templates with fuzzy matching
- **Workspace Management** — Save and restore terminal layouts as workspaces
- **Native SSH/SFTP** — Built-in SSH client with password and key-based authentication, SFTP file browser with full file operations
- **Remote File Manager** — Browse, upload, download, edit, rename, chmod remote files with drag-and-drop support
- **Server Monitor** — Real-time CPU, memory, disk, network monitoring for SSH sessions
- **Text Editor** — Monaco Editor (VS Code engine) with syntax highlighting, auto-save drafts, and remote file editing
- **Remote Desktop** — MSTSC integration with credential management and resolution control
- **Web Management Server** — Embedded Axum web server with JWT auth for remote/mobile terminal access via browser
- **AI Usage Tracking** — Monitor API usage for DeepSeek, Zhipu GLM, Baidu Qianfan, and MiniMax
- **Smart Paste** — Detects file paths, images, and multiline text from clipboard for intelligent terminal paste
- **System Tray** — Close to tray, single instance mode, launch at login
- **Data Portability** — All data stored as JSON files, with import/export support

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Zustand, xterm.js (WebGL), Monaco Editor |
| Backend | Rust, Tauri 2, portable-pty (ConPTY), ssh2, Axum |
| Web Server | Axum, JWT (jsonwebtoken), bcrypt, WebSocket |
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
│   │   ├── TerminalInstance.tsx   # xterm.js terminal with WebGL renderer
│   │   ├── TerminalPanel.tsx     # Terminal routing & split layout
│   │   ├── TabSidebar.tsx        # Grouped session list with search
│   │   ├── TextEditor.tsx        # Monaco Editor (VS Code engine)
│   │   ├── RemoteFileTree.tsx    # SFTP file browser
│   │   ├── ServerMonitor.tsx     # Real-time server metrics
│   │   ├── AiUsagePanel.tsx      # AI provider usage tracking
│   │   ├── FileTree.tsx          # Local file tree with bookmarks
│   │   ├── TransferPanel.tsx     # File transfer progress
│   │   ├── SettingsPage.tsx      # Settings overlay
│   │   ├── ConfigEditDialog.tsx  # Profile create/edit modal
│   │   ├── TitleBar.tsx          # Custom window titlebar
│   │   └── ...
│   ├── stores/appStore.ts        # Zustand state management
│   ├── services/tauri.ts         # Tauri invoke wrappers
│   ├── data/commandTemplates.ts  # Template definitions
│   └── types/index.ts            # TypeScript types & presets
├── src-tauri/                    # Backend (Rust/Tauri)
│   └── src/
│       ├── lib.rs                # App setup, tray, commands registration
│       ├── commands/             # Tauri command handlers
│       │   ├── terminal.rs       # PTY & MSTSC management
│       │   ├── profile.rs        # Profile CRUD
│       │   ├── remote_file.rs    # SFTP operations
│       │   ├── server_monitor.rs # Server metrics collection
│       │   ├── ai_usage.rs       # AI usage API integration
│       │   ├── settings.rs       # Settings & data import/export
│       │   ├── clipboard.rs      # Clipboard file/image reading
│       │   └── ...
│       ├── services/             # Business logic
│       ├── models/               # Data structures
│       └── web/                  # Embedded web server
│           ├── server.rs         # Axum router & CORS
│           ├── auth.rs           # JWT authentication
│           ├── ws.rs             # WebSocket terminal I/O
│           └── handlers/         # REST API handlers
├── web/                          # Web management frontend (separate React app)
│   ├── src/
│   │   ├── App.tsx               # Web app root
│   │   ├── components/           # Web UI components
│   │   │   ├── LoginPage.tsx     # JWT login
│   │   │   ├── MainLayout.tsx    # Responsive layout
│   │   │   ├── Sidebar.tsx       # Profile sidebar
│   │   │   ├── TerminalView.tsx  # xterm.js terminal
│   │   │   └── MobileInputBar.tsx # Mobile special keys
│   │   ├── api/                  # REST & WebSocket clients
│   │   └── stores/               # Web state management
│   └── package.json
└── portable-pty-patched/         # Local patch for portable-pty
```

### Data Storage

All user data is stored as JSON files under `%APPDATA%/TerminalBuddy/`:

```
%APPDATA%/TerminalBuddy/
├── Profiles/                  # Terminal profiles (SSH/Docker/K8S/MSTSC credentials)
├── Themes/                    # Custom ANSI color themes
├── Workspaces/                # Saved workspace layouts
├── ClientData/                # Frontend state (tabs, bookmarks, drafts, settings cache)
├── command_templates.json     # Command templates
└── settings.json              # App settings
```

## Web Management Server

TerminalBuddy includes a built-in web server (default port 9600) for remote access from browsers and mobile devices.

### Setup

1. Open Settings > Web Management
2. Enable the web server, set port and credentials
3. Access `http://<your-ip>:9600` from any browser

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | JWT login |
| GET | `/api/profiles` | List profiles |
| POST | `/api/profiles` | Create profile |
| PUT | `/api/profiles/{id}` | Update profile |
| DELETE | `/api/profiles/{id}` | Delete profile |
| GET | `/api/terminals` | List active terminals |
| POST | `/api/terminals` | Start terminal |
| DELETE | `/api/terminals/{id}` | Close terminal |
| WS | `/ws/terminal/{id}?token=<jwt>` | Terminal WebSocket |

### WebSocket Protocol

```json
// Client → Server
{ "type": "input", "data": "ls -la\n" }
{ "type": "resize", "cols": 120, "rows": 40 }

// Server → Client
{ "type": "output", "data": "..." }
{ "type": "exited", "code": 0 }
{ "type": "error", "message": "..." }
```

### Security

- JWT authentication with 24-hour token expiry
- bcrypt password hashing
- Global WebSocket limit: 50 connections
- Per-terminal WebSocket limit: 5 connections
- Session ownership model (PC vs Web terminals)

## SSH & Remote File Management

### SSH Connection

Supports password, key-based, and SSH agent authentication. Passwords are encrypted with Windows DPAPI before saving to disk.

### SFTP File Browser

- Breadcrumb navigation with context menu
- Upload/download files and directories with progress tracking
- Inline rename, create, delete, chmod
- Remote clipboard (copy/cut/paste across directories)
- "Edit with local editor" — opens remote file in Monaco Editor, auto-uploads on save
- "Open in system" — downloads to temp and opens with default OS application

### Server Monitor

Real-time monitoring for SSH sessions with configurable refresh interval (1s/3s/5s/10s):

- CPU usage (from `/proc/stat` differential)
- Memory (total, used, available, swap)
- Disk usage per mount
- Network speed (rx/tx bytes per second)
- Uptime

## Screenshots

> Add screenshots here

## License

[MIT](LICENSE)
