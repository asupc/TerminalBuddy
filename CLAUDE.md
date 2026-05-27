# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TerminalBuddy is a Tauri 2.x + React 18 desktop terminal emulator for Windows. It uses `portable-pty` (ConPTY) for PTY management, `xterm.js` for rendering, and persists all data as JSON files in the user data directory. It also includes an embedded Web API (axum) for remote terminal access via browser.

**Note:** The actual project files are in the `terminal-buddy/` subdirectory.

## Common Commands

```bash
cd terminal-buddy

# Development
npm run tauri dev    # Run full Tauri app in dev mode (Rust + frontend)
npm run dev          # Frontend only (Vite dev server on port 1420)

# Build
npm run tauri build  # Production build (outputs NSIS installer)
npm run build        # Frontend TypeScript build only

# Type check
npx tsc --noEmit     # TypeScript type check without emitting

# Rust check
cd src-tauri && cargo check  # Rust compilation check
```

## Architecture

### Backend (Rust/Tauri) — `src-tauri/src/`

Three-layer architecture: **commands** (thin Tauri wrappers) → **services** (business logic) → **models** (data structures), plus a **web** module for the HTTP/WebSocket API.

**Command modules** (`commands/`): profile, terminal, history, settings, theme, workspace, templates, fs, clipboard, window, ai_usage, web. All re-exported via `mod.rs`. Registered in `lib.rs` `invoke_handler![]` (62 commands).

**Service modules** (`services/`): Each service manages a JSON file or subsystem:
- `profile_service` — CRUD for `Profiles/*.json`
- `history_service` — `command_history.json` with `HistoryEntry { command, note }` (backward-compatible with old `Vec<String>` format)
- `template_service` — `command_templates.json`, auto-initializes from defaults if missing
- `theme_service` — CRUD for `Themes/*.json`
- `settings_service` — `settings.json` (close_behavior, data_path, tab_sidebar_width, enable_tab_navigation, single_instance, web_api settings)
- `workspace_service` — CRUD for `Workspaces/*.json`
- `path_service` — Centralizes data directory resolution (default: `%APPDATA%/TerminalBuddy`), validates custom paths, provides `copy_dir_recursive` for migration/export
- `web_service` — Pub/sub state for broadcasting terminal output to WebSocket clients
- `TerminalService` (in `commands/terminal.rs`) — Managed state holding `HashMap<String, TerminalInstance>`. Each instance has an `owner` field (`TerminalOwner::Pc` or `TerminalOwner::Web`) tracking its origin. Uses `cmd.exe` as base PTY, injects PowerShell/SSH/Docker/K8s commands. Output forwarded via Tauri events `terminal_output_{id}`. Permission checks via `check_pc_permission()` enforce session isolation when `web_api_share_sessions` is false.

**Web module** (`web/`): Embedded axum HTTP server for remote terminal access:
- `server.rs` — Axum router: REST API + WebSocket + embedded SPA serving
- `auth.rs` — JWT generation/verification with bcrypt password hashing
- `ws.rs` — WebSocket handler for terminal I/O (JSON protocol: Input/Resize/Output/Exited/Error). Enforces session isolation: non-shared mode blocks Web clients from PC terminals.
- `handlers/` — REST handlers: `auth_handler.rs`, `profile_handler.rs`, `terminal_handler.rs`

**Models** (`models/`): `Profile` (with SSH/Docker/K8s fields), `AppSettings` (close_behavior, data_path, web_api settings including `web_api_share_sessions`), `CustomTheme` (16-color ANSI palette), `Workspace` (groups, terminals), `TerminalOwner` (Pc/Web enum), `web_api.rs` (LoginRequest, WsClientMessage, WsServerMessage with Error variant, TerminalInfo with owner field, etc.).

**App setup** (`lib.rs`): System tray with "打开窗口"/"退出", close-to-tray behavior, single instance (tauri-plugin-single-instance), window close interception, Web API server startup.

### Frontend (React/TypeScript) — `src/`

**State management**: Zustand store (`stores/appStore.ts`) holds profiles, sessions, tab groups, custom themes, bookmarks, exclusion patterns, drag state. Persists tabs/bookmarks to `localStorage`.

**Backend bridge**: `services/tauri.ts` — typed `invoke()` wrappers for all 62 commands, plus `onTerminalOutput` event listener.

**Data layer**: `data/commandTemplates.ts` — 10 categories of command templates, overrides (localStorage), custom commands, history cache (`HistoryEntry[]`), autocomplete suggestions. Templates are persisted to backend via `initPersistedTemplates()`.

**Key components**:
- `App.tsx` — Root: profile loading, terminal lifecycle, file tree, tab restoration, close confirmation
- `TitleBar.tsx` — Custom frameless title bar: nav buttons, Web API toggle, AI usage hover panel, window controls
- `ConfigPanel.tsx` — Left panel: profile list grouped by group field, search, sort, context menus, rename groups
- `ConfigEditDialog.tsx` — Profile create/edit modal with terminal type-specific fields, SSH/Docker/K8s fields, fuzzy command matching
- `FileTree.tsx` — File browser: tree view, bookmarks, path editing, exclusion patterns, drag-and-drop to terminal
- `TerminalPanel.tsx` — Routes to SettingsPage or renders terminal instances with split layout support
- `TerminalInstance.tsx` — xterm.js instance with fit/weblinks/clipboard/search/unicode addons, IME position lock, prompt detection, autocomplete popup, paste file path support, drag-drop
- `TabSidebar.tsx` — Vertical tab navigation panel (resizable, grouped, context menus)
- `TerminalTabBar.tsx` — Horizontal tab bar (shown when Tab Navigation is disabled)
- `SettingsPage.tsx` — Full settings overlay with 8 sections (general, profiles, commands, themes, history, exclusions, AI usage, web management)
- `AiUsagePanel.tsx` — Hover panel showing AI usage bars for Zhipu GLM and Baidu Qianfan

**Types** (`types/index.ts`): `Profile`, `TerminalSession`, `CustomTheme`, `TabGroup`, `SplitNode`, `Workspace`, plus `PRESET_THEMES` (8 themes) and `TAB_COLORS` (25 colors).

### Web Frontend — `web/`

Separate React SPA in `web/src/` for browser-based remote terminal access:
- `LoginPage.tsx`, `MainLayout.tsx`, `Sidebar.tsx`, `ProfileList.tsx`, `ProfileDialog.tsx`
- `TabBar.tsx`, `TerminalView.tsx`, `MobileInputBar.tsx` (mobile-friendly input)
- API client in `api/` (auth, profiles, terminals)
- `hooks/useTerminal.ts` — WebSocket-based terminal I/O hook

Embedded in the Rust binary via `include_dir!` in release mode; served from `web/dist/` in dev mode.

### State Flow

1. App init: `initPersistedTemplates()` → `loadProfiles()` → optionally restore tabs
2. Profiles loaded into Zustand, displayed in `ConfigPanel` (grouped by `group` field)
3. Starting a terminal: `startTerminal(profileId)` → Rust creates PTY → returns terminal ID → frontend creates session
4. Output: PTY reader thread → Tauri event `terminal_output_{id}` → xterm.js write
5. Input: xterm.js `onData` → `writeToTerminal(id, data)` → PTY writer
6. Autocomplete: current input line parsed from xterm buffer → matched against `getAllSuggestions()` (templates + history with notes)
7. Web API: axum server → REST for profiles → WebSocket for terminal I/O → JWT auth

### Data Model

**Profile:** id, name, group, terminalType (`powershell`|`cmd`|`ssh`|`docker`|`k8s`), startupPath, startupCommands, environmentVariables, colorTheme, tabColor, windowSize, plus SSH/Docker/K8s fields.

**HistoryEntry:** command, note (structured, backward-compatible with old string array).

**AppSettings (backend):** closeBehavior (Exit/Tray), dataPath (optional custom), tabSidebarWidth, enableTabNavigation, singleInstance, webApiEnabled, webApiPort, webApiUsername, webApiPasswordHash, sshDownloadDir, serverMonitorInterval, webApiShareSessions (default false — controls terminal session isolation between Web and PC).

**AppSettings (frontend, localStorage):** restoreTabsOnStartup, configPanelAutoExpand, fileTreeAutoExpand, closeBehavior, enableTabNavigation, singleInstance, rightClickPaste, zhipuApiKey, qianfanCookie, webApiEnabled, webApiPort, webApiUsername, webApiShareSessions.

**Storage layout:** `%APPDATA%/TerminalBuddy/` — `Profiles/`, `Themes/`, `Workspaces/`, `command_history.json`, `command_templates.json`, `settings.json`.

## Key Constraints

- All Rust↔TypeScript serialization uses `camelCase` (serde `rename_all = "camelCase"`)
- Profile terminalType is a string, not an enum (`'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s'`)
- Terminal base PTY is always `cmd.exe`, with shell-specific commands injected via PTY writer
- `portable-pty` uses a local patch at `src-tauri/portable-pty-patched/`
- Window size and many profile fields are optional (nullable/Option)
- Frontend uses Chinese (Simplified) for all UI text
- Theme system: CSS custom properties toggled via `data-theme` attribute on `<html>`
- Web API uses JWT for auth, bcrypt for password hashing, WebSocket for terminal I/O
- Web clients can only grow the PTY size (never shrink) to protect the desktop viewer
- Session isolation: when `webApiShareSessions` is false (default), Web clients can only see/operate Web-created terminals; PC clients can see Web-created terminals but cannot write/resize/close them
- Custom frameless window (`decorations: false` in tauri.conf.json), TitleBar.tsx provides window controls
- No automated tests exist in the project
