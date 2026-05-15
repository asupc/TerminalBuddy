# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TerminalBuddy is a Tauri 2.x + React 18 terminal configuration management tool. It uses xterm.js for terminal emulation and stores configuration profiles as JSON files.

**Note:** The actual project files are in the `terminal-buddy/` subdirectory.

## Common Commands

```bash
cd terminal-buddy

# Development
npm run tauri dev    # Run full Tauri app in dev mode
npm run dev          # Frontend only (Vite dev server on port 1420)

# Build
npm run tauri build  # Production build
npm run build        # Frontend TypeScript build
```

## Architecture

### Backend (Rust/Tauri)

- `src-tauri/src/main.rs` - Application entry, registers Tauri commands
- `src-tauri/src/lib.rs` - Module declarations (commands, models, services)
- `src-tauri/src/commands/profile.rs` - Profile CRUD Tauri commands
- `src-tauri/src/services/profile_service.rs` - Profile persistence layer (JSON files in `TerminalBuddy/Profiles/`)
- `src-tauri/src/models/profile.rs` - Profile data structures

**Registered commands:** `get_all_profiles`, `get_profile`, `create_profile`, `update_profile`, `delete_profile`, `update_profile_last_used`

**Terminal commands (planned):** `start_terminal`, `write_to_terminal`, `resize_terminal`, `close_terminal`

### Frontend (React)

- `src/App.tsx` - Root component, manages profile loading and dialogs
- `src/stores/appStore.ts` - Zustand store for profiles and terminal sessions
- `src/services/tauri.ts` - Tauri invoke wrapper and event listeners
- `src/types/index.ts` - TypeScript interfaces (Profile, TerminalSession, PRESET_THEMES)
- `src/components/` - UI components

### State Flow

1. App loads profiles via `getAllProfiles()` from tauri service
2. Profiles stored in Zustand `appStore`
3. ConfigPanel displays profiles grouped by `group` field
4. TerminalPanel manages terminal instances via Tauri commands
5. Tauri events (`terminal_output_{id}`) stream terminal output to xterm.js

### Data Model

**Profile:** id, name, group, terminalType (`powershell`|`cmd`), startupPath, startupCommands, environmentVariables, colorTheme, windowSize, createdAt, lastUsedAt

**Storage:** `%APPDATA%/TerminalBuddy/Profiles/{id}.json` (one file per profile)

### Color Themes

Preset themes defined in `src/types/index.ts` (PRESET_THEMES array): dark-default, dark-green, dark-blue, dark-powershell, light, solarized-dark, solarized-light, vintage

## Key Constraints

- Profile terminal type is `powershell` or `cmd` (string, not enum)
- Profiles use camelCase JSON serialization between Rust and TypeScript
- Window size is optional (nullable in TypeScript, Option in Rust)
- Terminal service (ConPTY) is partially implemented - terminal commands defined but not fully wired