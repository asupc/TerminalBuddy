# AGENTS.md

## Project layout

- **Root is a wrapper.** All source lives in `terminal-buddy/`. Desktop frontend: `terminal-buddy/src/`, Rust backend: `terminal-buddy/src-tauri/`, Web frontend: `terminal-buddy/web/`.
- Desktop frontend: React 18, TypeScript, Zustand 5, xterm.js 5.5, Monaco Editor.
- Web frontend: Separate React SPA (`web/`), embedded into the Rust binary at build time via `include_dir!`.
- Rust backend: Tauri 2, axum (Web API), portable-pty (ConPTY), ssh2, bcrypt, JWT.

## Commands

All commands run from `terminal-buddy/` unless noted.

```bash
npm install                  # install desktop frontend deps
cd web && npm install        # install web frontend deps (separate node_modules)

npm run dev                  # Vite dev server only (port 1420, no Rust)
npm run tauri dev            # full Tauri dev (runs Vite + Rust together)
npm run build                # TypeScript check + Vite build
npm run tauri build          # production build (NSIS installer); runs web build automatically via beforeBuildCommand

npx tsc --noEmit             # TypeScript type check (desktop)
cd web && npx tsc --noEmit   # TypeScript type check (web)

cd src-tauri && cargo check  # Rust compilation check
```

Shortcut from repo root: `dev.bat` builds web frontend then launches `tauri dev`.
`build-fast.bat` builds exe only (no installer); `build.bat` builds full NSIS installer.

## Verification order

1. `npx tsc --noEmit` in `terminal-buddy/`
2. `npx tsc --noEmit` in `terminal-buddy/web/`
3. `cargo check` in `terminal-buddy/src-tauri/`

No lint, formatter, or test suites exist. TypeScript strict mode enforces `noUnusedLocals` and `noUnusedParameters` — unused bindings will fail `tsc`.

## Rust specifics

- Edition 2021; lib crate name is `terminal_buddy_lib` (cdylib + rlib).
- `sccache` is configured via `src-tauri/.cargo/config.toml`.
- Dev profile uses `opt-level = 1` + incremental; release uses LTO thin + strip.
- `portable-pty` is **locally patched** at `src-tauri/portable-pty-patched/` — never update it from crates.io without verifying the patch.
- All Tauri commands are registered in `lib.rs` `invoke_handler![]` (currently ~79 commands). When adding a command: define in `commands/`, re-export via `commands/mod.rs`, add to `invoke_handler![]`.
- Rust↔TypeScript serialization uses `camelCase` everywhere (`serde(rename_all = "camelCase")`).

## Frontend specifics

- All UI text is in Chinese (Simplified).
- State: Zustand store in `stores/appStore.ts`. Tauri bridge: `services/tauri.ts` (typed `invoke()` wrappers).
- xterm.js 5.5 with WebGL renderer, fit/search/clipboard/web-links/unicode addons.
- Window is frameless (`decorations: false`); `TitleBar.tsx` provides custom controls.
- Web API dev server proxies `/api` → `http://localhost:9600` and `/ws` → `ws://localhost:9600`.

## Data model

All user data is JSON files under `%APPDATA%/TerminalBuddy/`: `Profiles/*.json`, `Themes/*.json`, `Workspaces/*.json`, `settings.json`, `command_templates.json`, `command_history.json`. No database.

## Web API

Embedded axum server for remote terminal access. JWT auth, bcrypt passwords. WebSocket protocol for terminal I/O. Session isolation between PC and Web clients controlled by `webApiShareSessions` setting.
