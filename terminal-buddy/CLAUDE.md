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
# Or from repo root: dev.bat (Windows shortcut for tauri dev)

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

**Command modules** (`commands/`): profile, terminal, settings, templates, fs, clipboard, window, ai_usage, web, remote_file, server_monitor, client_data. All re-exported via `mod.rs`. Registered in `lib.rs` `invoke_handler![]` — registry kept in lockstep with frontend invokes via `scripts/check-invoke-coverage.py`. Workspace commands (`commands/workspace.rs`) exist in the backend but are **not registered** (no desktop UI consumes them; the service layer and `Workspaces/*.json` storage remain).

**Service modules** (`services/`): Each service manages a JSON file or subsystem:
- `profile_service` — CRUD for `Profiles/*.json`
- `template_service` — `command_templates.json`, auto-initializes from defaults if missing
- `settings_service` — `settings.json` (close_behavior, data_path, tab_sidebar_width, enable_tab_navigation, single_instance, web_api settings, ssh_download_dir, server_monitor_interval)
- `workspace_service` — CRUD for `Workspaces/*.json`
- `path_service` — Centralizes data directory resolution (default: `%APPDATA%/TerminalBuddy`), validates custom paths, provides `copy_dir_recursive` for migration/export
- `web_service` — Pub/sub state for broadcasting terminal output to WebSocket clients
- `ssh_session_service` — Direct SSH session management
- `client_data_service` — Client-side data persistence
- `TerminalService` (in `commands/terminal.rs`) — Managed state holding `HashMap<String, TerminalInstance>`. Each instance has an `owner` field (`TerminalOwner::Pc` or `TerminalOwner::Web`) tracking its origin. Uses `cmd.exe` as base PTY, injects PowerShell/SSH/Docker/K8s/MSTSC commands. Output forwarded via Tauri events `terminal_output_{id}`. Every read/write method takes a `TerminalActor` and calls `TerminalService::authorize()`, which delegates to the single permission matrix in `models/terminal_access.rs` (no hard-coded owner comparisons anywhere else). Terminal creation is transactional (`NewTerminalSpec` + `spawn_terminal`, rollback via the `TerminalCreation` RAII guard); teardown has one entry point (`teardown_terminal` with a `TerminalCloseReason`) that emits `terminal-closed` exactly once.

**Web module** (`web/`): Embedded axum HTTP server for remote terminal access:
- `server.rs` — Axum router: REST API + WebSocket + embedded SPA serving. Hand-rolled accept loop (not `axum::serve`) so hyper gets a `TokioTimer` and idle connections time out via `header_read_timeout`; `TimeoutLayer` (30s per request), `DefaultBodyLimit` (2MB), CORS closed in release (same-origin SPA), vite origins only in debug. Login brute-force protection: `rate_limit.rs` does per-IP failure counting with exponential ban backoff, plus a global bcrypt concurrency semaphore (429 + `Retry-After`).
- `auth.rs` — JWT generation/verification with bcrypt password hashing
- `rate_limit.rs` — `LoginThrottle` (per-IP failure window + ban rounds) and `acquire_password_verify_slot`, unit-tested with injectable clock
- `ws.rs` — WebSocket handler for terminal I/O (JSON protocol: Input/Resize/Output/Exited/Error). Authorizes **before** `on_upgrade` (404 unknown / 403 unauthorized), so an attacker who guesses a terminal ID still cannot subscribe or peek history. Re-checks authorization per message and every 5s, closing connections that lose permission after the share switch is turned off.
- `error.rs` — Error types (`ApiError::TooManyRequests` sets `Retry-After`)
- `handlers/` — REST handlers: `auth_handler.rs`, `profile_handler.rs`, `terminal_handler.rs`, plus bot/claude-hook handlers

**Models** (`models/`): `Profile` (with SSH/Docker/K8s/MSTSC fields), `AppSettings` (close_behavior, data_path, web_api settings including `web_api_share_sessions`, ssh_download_dir, server_monitor_interval), `Workspace` (groups, terminals), `TerminalOwner` (Pc/Web enum), `terminal_access` (`TerminalActor` × `TerminalAction` × `TerminalOwner` permission matrix, `TerminalAccessError`, Chinese denial messages — the single source of truth, unit-tested), `ssh_types` (SSH session types), `web_api.rs` (LoginRequest, WsClientMessage, WsServerMessage with Error variant, TerminalInfo with owner field, etc.).

**App setup** (`lib.rs`): System tray with "打开窗口"/"退出", close-to-tray behavior, single instance (tauri-plugin-single-instance), window close interception, Web API server startup.

### Frontend (React/TypeScript) — `src/`

**State management**: Zustand store (`stores/appStore.ts`) holds profiles, sessions, tab groups, bookmarks, exclusion patterns, drag state. Persists tabs/bookmarks to `localStorage`.

**Backend bridge**: `services/tauri.ts` — typed `invoke()` wrappers for backend commands, plus `onTerminalOutput` event listener.

**Data layer**: `data/commandTemplates.ts` — 10 categories of command templates, overrides (localStorage), custom commands, history cache (`HistoryEntry[]`), autocomplete suggestions. Templates are persisted to backend via `initPersistedTemplates()`.

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

**Profile:** id, name, group, terminalType (`powershell`|`cmd`|`ssh`|`docker`|`k8s`|`mstsc`), startupPath, startupCommands, environmentVariables, colorTheme, tabColor, windowSize, plus SSH/Docker/K8s/MSTSC fields.

**HistoryEntry:** command, note (structured, backward-compatible with old string array).

**AppSettings (backend):** closeBehavior (Exit/Tray), dataPath (optional custom), tabSidebarWidth, enableTabNavigation, singleInstance, webApiEnabled, webApiPort, webApiUsername, webApiPasswordHash, sshDownloadDir, serverMonitorInterval, webApiShareSessions (default false — controls terminal session isolation between Web and PC).

**AppSettings (frontend, localStorage):** restoreTabsOnStartup, configPanelAutoExpand, fileTreeAutoExpand, closeBehavior, enableTabNavigation, singleInstance, rightClickPaste, zhipuApiKey, qianfanCookie, webApiEnabled, webApiPort, webApiUsername, webApiShareSessions.

**Storage layout:** `%APPDATA%/TerminalBuddy/` — `Profiles/`, `Workspaces/`, `command_history.json`, `command_templates.json`, `settings.json`.

## Key Constraints

- All Rust↔TypeScript serialization uses `camelCase` (serde `rename_all = "camelCase"`)
- Profile terminalType is a string, not an enum (`'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'mstsc'`)
- Terminal base PTY is always `cmd.exe`, with shell-specific commands injected via PTY writer
- `portable-pty` uses a local patch at `src-tauri/portable-pty-patched/`
- Window size and many profile fields are optional (nullable/Option)
- Frontend uses Chinese (Simplified) for all UI text
- Theme system: CSS custom properties toggled via `data-theme` attribute on `<html>`
- Web API uses JWT for auth, bcrypt for password hashing, WebSocket for terminal I/O
- Web clients may shrink the PTY (`allow_shrink=true`) so narrow phone screens don't overflow TUIs; the desktop view re-flows and is restored via `terminal-web-takeover-ended`
- Session isolation (matrix lives in `models/terminal_access.rs`, enforced by `TerminalService::authorize`):
  - `webApiShareSessions=false` (default): Web sees/operates only Web-created terminals — PC terminals are absent from the list *and* rejected at the WS handshake (403); PC can read-only view Web terminals but cannot input/resize/rename/close them
  - `webApiShareSessions=true`: both sides can view/input/resize/rename each other's terminals
  - Regardless of the switch, Web can never close a PC terminal ("take over" ≠ "close")
  - Turning the switch off mid-session drops in-flight Web connections to PC terminals within ~5s
- Custom frameless window (`decorations: false` in tauri.conf.json), TitleBar.tsx provides window controls
- `tauri-plugin-dialog` for native file/folder dialogs
- **Tests:** no frontend tests; the Rust lib has 100+ `#[cfg(test)]` unit tests across ~10 files (`models/terminal_access.rs`, `models/profile_validation.rs`, `commands/git_parse.rs`, `commands/git.rs`, `commands/fs.rs`, `services/atomic_file.rs`, `services/path_service.rs`, `services/claude_hook_service.rs`, `services/web_service.rs`, `services/crypto_service.rs`, `web/rate_limit.rs`, …) runnable via `cd src-tauri && cargo test --lib`. Keep pure validation/permission/parameter-building logic in testable Rust modules.
- **Command registry hygiene:** frontend `invoke()` calls must stay a subset of the `invoke_handler![]` registrations. Verify with `python scripts/check-invoke-coverage.py` from `terminal-buddy/`; registered commands without a desktop caller need a written reason (AI usage commands are invoked from `services/aiUsage.ts`, web-layer service methods are used by `web/` handlers).
