# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TerminalBuddy is a Tauri 2.x + React 18 desktop terminal emulator for Windows. It uses `portable-pty` (ConPTY) for PTY management, `xterm.js` for rendering, and persists all data as JSON files in the user data directory.

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

Three-layer architecture: **commands** (thin Tauri wrappers) → **services** (business logic) → **models** (data structures).

**Command modules** (`commands/`): profile, terminal, history, settings, theme, workspace, templates, fs, clipboard. All re-exported via `mod.rs`. Registered in `lib.rs` `invoke_handler![]` (~45 commands).

**Service modules** (`services/`): Each service manages a JSON file or subsystem:
- `profile_service` — CRUD for `Profiles/*.json`
- `history_service` — `command_history.json` with `HistoryEntry { command, note }` (backward-compatible with old `Vec<String>` format)
- `template_service` — `command_templates.json`, auto-initializes from defaults if missing
- `theme_service` — CRUD for `Themes/*.json`
- `settings_service` — `settings.json` (close_behavior, data_path, tab_sidebar_width)
- `workspace_service` — CRUD for `Workspaces/*.json`
- `path_service` — Centralizes data directory resolution (default: `%APPDATA%/TerminalBuddy`), validates custom paths, provides `copy_dir_recursive` for migration/export
- `TerminalService` (in `commands/terminal.rs`) — Managed state holding `HashMap<String, TerminalInstance>`. Uses `cmd.exe` as base PTY, injects PowerShell/SSH/Docker/K8s commands. Output forwarded via Tauri events `terminal_output_{id}`.

**Models** (`models/`): `Profile` (with SSH/Docker/K8s fields), `AppSettings` (`CloseBehavior` enum: Exit/Tray), `CustomTheme` (full ANSI palette), `Workspace` (groups, terminals, split layouts).

**App setup** (`lib.rs`): System tray with "打开窗口"/"退出", close-to-tray behavior, window close interception.

### Frontend (React/TypeScript) — `src/`

**State management**: Zustand store (`stores/appStore.ts`) holds profiles, sessions, tab groups, split layouts, custom themes, bookmarks, exclusion patterns. Persists tabs/bookmarks to `localStorage`.

**Backend bridge**: `services/tauri.ts` — typed `invoke()` wrappers for all 45+ commands, plus `onTerminalOutput` event listener.

**Data layer**: `data/commandTemplates.ts` — command template definitions, overrides (localStorage), custom commands, history cache (`HistoryEntry[]`), autocomplete suggestions. Templates are persisted to backend via `initPersistedTemplates()`.

**Key components**:
- `App.tsx` — Root: profile loading, terminal lifecycle, floating toolbar, tab restoration, close confirmation
- `TerminalPanel.tsx` — Routes to SettingsPage or renders terminal instances with split layout support
- `TerminalInstance.tsx` — xterm.js instance with fit/weblinks/clipboard/search/unicode addons, prompt detection, autocomplete popup, paste file path support
- `TabSidebar.tsx` — Grouped session list with search, collapse, right-click context menu (add terminal, close all)
- `SettingsPage.tsx` — Full settings overlay with 6 sections (general, profiles, commands, themes, history, exclusions)
- `ConfigEditDialog.tsx` — Profile create/edit modal with terminal type-specific fields and fuzzy command matching
- `SplitPane.tsx` — Recursive split layout renderer (horizontal/vertical)

**Types** (`types/index.ts`): `Profile`, `TerminalSession`, `CustomTheme`, `TabGroup`, `SplitNode`, `Workspace`, plus `PRESET_THEMES` (8 themes) and `TAB_COLORS` (25 colors).

### State Flow

1. App init: `initPersistedTemplates()` → `loadProfiles()` → optionally restore tabs
2. Profiles loaded into Zustand, displayed in `ConfigPanel` (grouped by `group` field)
3. Starting a terminal: `startTerminal(profileId)` → Rust creates PTY → returns terminal ID → frontend creates session
4. Output: PTY reader thread → Tauri event `terminal_output_{id}` → xterm.js write
5. Input: xterm.js `onData` → `writeToTerminal(id, data)` → PTY writer
6. Autocomplete: current input line parsed from xterm buffer → matched against `getAllSuggestions()` (templates + history with notes)

### Data Model

**Profile:** id, name, group, terminalType (`powershell`|`cmd`|`ssh`|`docker`|`k8s`), startupPath, startupCommands, environmentVariables, colorTheme, tabColor, windowSize, plus SSH/Docker/K8s fields.

**HistoryEntry:** command, note (structured, backward-compatible with old string array).

**AppSettings:** closeBehavior (Exit/Tray), dataPath (optional custom), tabSidebarWidth.

**Storage layout:** `%APPDATA%/TerminalBuddy/` — `Profiles/`, `Themes/`, `Workspaces/`, `command_history.json`, `command_templates.json`, `settings.json`.

## Key Constraints

- All Rust↔TypeScript serialization uses `camelCase` (serde `rename_all = "camelCase"`)
- Profile terminalType is a string, not an enum (`'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s'`)
- Terminal base PTY is always `cmd.exe`, with shell-specific commands injected via PTY writer
- `portable-pty` uses a local patch at `src-tauri/portable-pty-patched/`
- Window size and many profile fields are optional (nullable/Option)
- Frontend uses Chinese (Simplified) for all UI text
- Theme system: CSS custom properties toggled via `data-theme` attribute on `<html>`
- No automated tests exist in the project
