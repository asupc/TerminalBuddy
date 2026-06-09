# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TerminalBuddy is a Tauri 2.x + React 18 desktop terminal emulator for Windows. It uses `portable-pty` (ConPTY) for PTY management, `xterm.js` for rendering, and persists all data as JSON files in the user data directory. It also includes a built-in web API server for remote access and AI usage tracking for multiple providers.

**Note:** The actual project files are in the `terminal-buddy/` subdirectory.

## Common Commands

```bash
cd terminal-buddy

# Development
npm run tauri dev    # Run full Tauri app in dev mode (Rust + frontend)
npm run dev          # Frontend only (Vite dev server on port 1420)

# Build
npm run tauri build  # Production build (outputs NSIS installer)
npm run build        # Frontend TypeScript build (tsc && vite build)

# Type check
npx tsc --noEmit     # TypeScript type check without emitting

# Rust check
cd src-tauri && cargo check  # Rust compilation check
```

## Architecture

### Backend (Rust/Tauri) — `src-tauri/src/`

Three-layer architecture: **commands** (thin Tauri wrappers) → **services** (business logic) → **models** (data structures).

**Command modules** (`commands/`): profile, terminal, settings, theme, workspace, templates, fs, clipboard, window, ai_usage, client_data, remote_file, server_monitor, web. All re-exported via `mod.rs`. Registered in `lib.rs` `invoke_handler![]` (~70 commands).

**Service modules** (`services/`): Each service manages a JSON file or subsystem:
- `profile_service` — CRUD for `Profiles/*.json`
- `template_service` — `command_templates.json`, auto-initializes from defaults if missing
- `theme_service` — CRUD for `Themes/*.json`
- `settings_service` — `settings.json` (close_behavior, data_path, tab_sidebar_width, single_instance, launch_at_login, web API settings)
- `workspace_service` — CRUD for `Workspaces/*.json`
- `path_service` — Centralizes data directory resolution (default: `%APPDATA%/TerminalBuddy`), validates custom paths, provides `copy_dir_recursive` for migration/export
- `ssh_session_service` — Manages SSH connections (uses `ssh2` crate)
- `crypto_service` — Encryption/hashing utilities
- `client_data_service` — Generic key-value store for frontend persistent state
- `web_service` — Web API server state management
- `TerminalService` (in `commands/terminal.rs`) — Managed state holding `HashMap<String, TerminalInstance>`. Uses `cmd.exe` as base PTY, injects PowerShell/SSH/Docker/K8s commands. Output forwarded via Tauri events `terminal_output_{id}`.

**Models** (`models/`): `Profile` (with SSH/Docker/K8s/MSTSC fields), `AppSettings` (`CloseBehavior` enum: Exit/Tray), `CustomTheme` (full ANSI palette), `Workspace` (groups, terminals, split layouts), `SshTypes`, `TerminalOwner`, `WebApi`.

**Web module** (`web/`): Built-in HTTP/WebSocket API server using `axum` + `tower`:
- `server.rs` — Axum server setup with CORS, static file serving
- `auth.rs` — JWT authentication with bcrypt password hashing
- `ws.rs` — WebSocket handler for real-time terminal streaming
- `handlers/` — Route handlers for API endpoints
- `error.rs` — Error types

**App setup** (`lib.rs`): System tray with "打开窗口"/"退出", close-to-tray behavior, window close interception, single-instance plugin, launch-at-login sync, conditional web API server startup.

### Frontend (React/TypeScript) — `src/`

**State management**: Zustand store (`stores/appStore.ts`) holds profiles, sessions, tab groups, split layouts, custom themes, bookmarks, exclusion patterns, remote file entries, server stats, transfer items. Persists tabs via `clientData` backend storage (not localStorage).

**Backend bridge**: `services/tauri.ts` — typed `invoke()` wrappers for all 70+ commands, plus `onTerminalOutput` event listener.

**Data layer**: `data/commandTemplates.ts` — command template definitions, overrides (clientData), custom commands, autocomplete suggestions. Templates are persisted to backend via `initPersistedTemplates()`.

**Key components**:
- `App.tsx` — Root: profile loading, terminal lifecycle, floating toolbar, tab restoration, close confirmation
- `TerminalPanel.tsx` — Routes to SettingsPage or renders terminal instances with split layout support
- `TerminalInstance.tsx` — xterm.js instance with fit/weblinks/clipboard/search/unicode addons, prompt detection, autocomplete popup, paste file path support
- `TabSidebar.tsx` — Grouped session list with search, collapse, right-click context menu (add terminal, close all)
- `SettingsPage.tsx` — Full settings overlay with multiple sections
- `ConfigEditDialog.tsx` — Profile create/edit modal with terminal type-specific fields and fuzzy command matching
- `SplitPane.tsx` — Recursive split layout renderer (horizontal/vertical)
- `FileTree.tsx` — Remote/local file browser with tree view
- `TitleBar.tsx` — Custom titlebar (window uses `decorations: false`)

**Types** (`types/index.ts`): `Profile`, `TerminalSession`, `CustomTheme`, `TabGroup`, `SplitNode`, `Workspace`, `ExtraParamPreset`, `RemoteFileEntry`, `ServerStats`, `TransferItem`, plus `PRESET_THEMES` (8 themes) and `TAB_COLORS` (25 colors).

### State Flow

1. App init: load settings → `loadProfiles()` → optionally restore tabs from `clientData`
2. Profiles loaded into Zustand, displayed in `ConfigPanel` (grouped by `group` field)
3. Starting a terminal: `startTerminal(profileId)` → Rust creates PTY → returns terminal ID → frontend creates session
4. Output: PTY reader thread → Tauri event `terminal_output_{id}` → xterm.js write
5. Input: xterm.js `onData` → `writeToTerminal(id, data)` → PTY writer
6. Autocomplete: current input line parsed from xterm buffer → matched against suggestions (templates)

### Data Model

**Profile:** id, name, group, terminalType (`powershell`|`cmd`|`ssh`|`docker`|`k8s`|`editor`|`mstsc`), startupPath, startupCommands, environmentVariables, colorTheme, tabColor, windowSize, plus SSH/Docker/K8s/MSTSC fields.

**AppSettings:** closeBehavior (Exit/Tray), dataPath (optional custom), tabSidebarWidth, singleInstance, launchAtLogin, web API settings (enabled, port, password hash, share sessions), serverMonitorInterval, sshDownloadDir.

**Storage layout:** `%APPDATA%/TerminalBuddy/` — `Profiles/`, `Themes/`, `Workspaces/`, `command_templates.json`, `settings.json`, plus `clientData/` for frontend state.

## Key Constraints

- All Rust↔TypeScript serialization uses `camelCase` (serde `rename_all = "camelCase"`)
- Profile terminalType is a string, not an enum (`'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor' | 'mstsc'`)
- Terminal base PTY is always `cmd.exe`, with shell-specific commands injected via PTY writer
- `portable-pty` uses a local patch at `src-tauri/portable-pty-patched/`
- Window size and many profile fields are optional (nullable/Option)
- Frontend uses Chinese (Simplified) for all UI text
- Theme system: CSS custom properties toggled via `data-theme` attribute on `<html>`
- Window uses custom titlebar (`decorations: false` in tauri.conf.json)
- Web API server uses JWT auth with bcrypt-hashed passwords
- No automated tests exist in the project
