# TerminalBuddy 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Tauri + React + xterm.js 的跨平台终端配置管理工具

**Architecture:** 前端使用 React 18 + xterm.js 构建终端 UI，后端使用 Tauri 2.x (Rust) 处理配置文件 CRUD 和 ConPTY 终端进程管理，通过 Tauri Command/Event 实现双向通信。

**Tech Stack:** Tauri 2.x, React 18, xterm.js, zustand, react-hook-form, Rust (conpty, serde_json, tokio)

---

## 任务分解总览

| 阶段 | 任务 | 说明 |
|------|------|------|
| 1. 脚手架 | Task 1-3 | 项目初始化、依赖配置 |
| 2. 后端 | Task 4-6 | profile_service, terminal_service, 命令注册 |
| 3. 前端组件 | Task 7-10 | 主布局、ConfigPanel、TerminalPanel、ConfigEditDialog |
| 4. 功能集成 | Task 11-13 | 配置-终端联动、多标签页、颜色主题 |
| 5. 完善 | Task 14-16 | 命令模板、快速启动、导入导出 |

---

## Task 1: 初始化 Tauri + React 项目

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/`

**Steps:**

- [ ] **Step 1: 创建 Tauri + React 项目**

```bash
cd D:/gitee/TerminalManagement/TerminalBuddy
npm create tauri-app@latest terminal-buddy -- --template react-ts --manager npm
cd terminal-buddy
```

- [ ] **Step 2: 安装前端依赖**

```bash
cd terminal-buddy
npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links zustand react-hook-form
```

- [ ] **Step 3: 安装 Rust 依赖**

编辑 `src-tauri/Cargo.toml`，添加：

```toml
[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1", features = ["full"] }
uuid = { version = "1.0", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
dirs = "5.0"
portable-pty = "0.8"  # 跨平台 PTY 支持
```

- [ ] **Step 4: 配置 Tauri**

编辑 `src-tauri/tauri.conf.json`：

```json
{
  "productName": "TerminalBuddy",
  "identifier": "com.terminalbuddy.app",
  "build": {
    "devtools": true
  }
}
```

- [ ] **Step 5: 验证项目启动**

```bash
npm run tauri dev
```

---

## Task 2: 实现配置数据模型和类型定义

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/types/index.ts`
- Create: `terminal-buddy/src-tauri/src/models/mod.rs`
- Create: `terminal-buddy/src-tauri/src/models/profile.rs`

**Steps:**

- [ ] **Step 1: 定义 TypeScript 类型**

Create `terminal-buddy/src/types/index.ts`:

```typescript
export type TerminalType = 'powershell' | 'cmd';

export interface Profile {
  id: string;
  name: string;
  group: string;
  terminalType: TerminalType;
  startupPath: string;
  startupCommands: string[];
  environmentVariables: Record<string, string>;
  colorTheme: string;
  windowSize: { width: number; height: number };
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ColorTheme {
  id: string;
  name: string;
  background: string;
  foreground: string;
}

export const PRESET_THEMES: ColorTheme[] = [
  { id: 'dark-default', name: '深色默认', background: '#1E1E1E', foreground: '#CCCCCC' },
  { id: 'dark-green', name: '黑客绿', background: '#0C0C0C', foreground: '#00FF00' },
  { id: 'dark-blue', name: '海洋蓝', background: '#0D1B2A', foreground: '#E0E0E0' },
  { id: 'dark-powershell', name: 'PS深色', background: '#012456', foreground: '#F1F1F1' },
  { id: 'light', name: '浅色', background: '#FFFFFF', foreground: '#333333' },
  { id: 'solarized-dark', name: 'Solarized暗', background: '#002B36', foreground: '#839496' },
  { id: 'solarized-light', name: 'Solarized亮', background: '#FDF6E3', foreground: '#657B83' },
  { id: 'vintage', name: '复古绿屏', background: '#0A0A0A', foreground: '#33FF33' },
];

export interface TerminalSession {
  id: string;
  profileId: string;
  profileName: string;
  terminalType: TerminalType;
}
```

- [ ] **Step 2: 定义 Rust 数据结构**

Create `terminal-buddy/src-tauri/src/models/profile.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub group: String,
    pub terminal_type: String,  // "powershell" | "cmd"
    pub startup_path: String,
    pub startup_commands: Vec<String>,
    pub environment_variables: std::collections::HashMap<String, String>,
    pub color_theme: String,
    pub window_size: Option<WindowSize>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}
```

- [ ] **Step 3: 创建 models 模块**

Create `terminal-buddy/src-tauri/src/models/mod.rs`:

```rust
pub mod profile;
pub use profile::*;
```

---

## Task 3: 实现 profile_service (配置 CRUD)

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src-tauri/src/services/profile_service.rs`
- Create: `terminal-buddy/src-tauri/src/services/mod.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/mod.rs`

**Steps:**

- [ ] **Step 1: 创建 profile_service.rs**

Create `terminal-buddy/src-tauri/src/services/profile_service.rs`:

```rust
use crate::models::Profile;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

pub struct ProfileService;

impl ProfileService {
    fn get_profiles_dir() -> PathBuf {
        let base = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("TerminalBuddy")
            .join("Profiles");
        fs::create_dir_all(&base).ok();
        base
    }

    pub fn get_all_profiles() -> Result<Vec<Profile>, String> {
        let dir = Self::get_profiles_dir();
        let mut profiles = Vec::new();

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map_or(false, |e| e == "json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(profile) = serde_json::from_str::<Profile>(&content) {
                            profiles.push(profile);
                        }
                    }
                }
            }
        }

        Ok(profiles)
    }

    pub fn get_profile(id: &str) -> Result<Profile, String> {
        let path = Self::get_profiles_dir().join(format!("{}.json", id));
        let content = fs::read_to_string(&path)
            .map_err(|_| format!("Profile not found: {}", id))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse profile: {}", e))
    }

    pub fn create_profile(name: &str, group: &str, terminal_type: &str) -> Result<Profile, String> {
        let profile = Profile {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            group: group.to_string(),
            terminal_type: terminal_type.to_string(),
            startup_path: String::new(),
            startup_commands: Vec::new(),
            environment_variables: std::collections::HashMap::new(),
            color_theme: "dark-default".to_string(),
            window_size: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            last_used_at: None,
        };

        let path = Self::get_profiles_dir().join(format!("{}.json", profile.id));
        let content = serde_json::to_string_pretty(&profile)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        Ok(profile)
    }

    pub fn update_profile(profile: &Profile) -> Result<(), String> {
        let path = Self::get_profiles_dir().join(format!("{}.json", profile.id));
        let content = serde_json::to_string_pretty(profile)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))
    }

    pub fn delete_profile(id: &str) -> Result<(), String> {
        let path = Self::get_profiles_dir().join(format!("{}.json", id));
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete profile: {}", e))
    }

    pub fn update_last_used(id: &str) -> Result<(), String> {
        let mut profile = Self::get_profile(id)?;
        profile.last_used_at = Some(chrono::Utc::now().to_rfc3339());
        Self::update_profile(&profile)
    }
}
```

- [ ] **Step 2: 创建 services/mod.rs**

Create `terminal-buddy/src-tauri/src/services/mod.rs`:

```rust
pub mod profile_service;
pub use profile_service::*;
```

---

## Task 4: 实现 Tauri Commands (配置管理)

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src-tauri/src/commands/profile.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/mod.rs`
- Modify: `terminal-buddy/src-tauri/src/main.rs`

**Steps:**

- [ ] **Step 1: 创建 profile 命令**

Create `terminal-buddy/src-tauri/src/commands/profile.rs`:

```rust
use crate::models::Profile;
use crate::services::ProfileService;
use tauri::command;

#[command]
pub fn get_all_profiles() -> Result<Vec<Profile>, String> {
    ProfileService::get_all_profiles()
}

#[command]
pub fn get_profile(id: String) -> Result<Profile, String> {
    ProfileService::get_profile(&id)
}

#[command]
pub fn create_profile(name: String, group: String, terminal_type: String) -> Result<Profile, String> {
    ProfileService::create_profile(&name, &group, &terminal_type)
}

#[command]
pub fn update_profile(profile: Profile) -> Result<(), String> {
    ProfileService::update_profile(&profile)
}

#[command]
pub fn delete_profile(id: String) -> Result<(), String> {
    ProfileService::delete_profile(&id)
}

#[command]
pub fn update_profile_last_used(id: String) -> Result<(), String> {
    ProfileService::update_last_used(&id)
}
```

- [ ] **Step 2: 更新 commands/mod.rs**

```rust
pub mod profile;
pub use profile::*;
```

- [ ] **Step 3: 注册命令到 main.rs**

```rust
// src-tauri/src/main.rs 添加
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_all_profiles,
            commands::get_profile,
            commands::create_profile,
            commands::update_profile,
            commands::delete_profile,
            commands::update_profile_last_used,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

## Task 5: 实现 terminal_service (ConPTY 管理)

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src-tauri/src/services/terminal_service.rs`
- Modify: `terminal-buddy/src-tauri/src/services/mod.rs`

**Steps:**

- [ ] **Step 1: 创建 terminal_service.rs**

Create `terminal-buddy/src-tauri/src/services/terminal_service.rs`:

```rust
use crate::models::Profile;
use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtyPair, Child};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex}};
use std::thread;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

pub struct TerminalInstance {
    pub id: String,
    pub child: Box<dyn Child + Send + Sync>,
    pub writer: Box<dyn Write + Send>,
}

pub struct TerminalService {
    instances: Arc<Mutex<HashMap<String, TerminalInstance>>>,
}

impl TerminalService {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_terminal(&self, profile: &Profile, app: AppHandle) -> Result<String, String> {
        let terminal_id = Uuid::new_v4().to_string();
        let pty_system = native_pty_system();

        let pty_pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| format!("Failed to open PTY: {}", e))?;

        let mut cmd = CommandBuilder::new(
            if profile.terminal_type == "powershell" {
                "powershell.exe"
            } else {
                "cmd.exe"
            }
        );

        if !profile.startup_path.is_empty() {
            cmd.cwd(&profile.startup_path);
        }

        cmd.envs(&profile.environment_variables);

        let child = pty_pair.slave.spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn terminal: {}", e))?;

        let mut reader = pty_pair.master.try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;

        let writer = pty_pair.master.take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        let instance = TerminalInstance {
            id: terminal_id.clone(),
            child,
            writer,
        };

        self.instances.lock().unwrap().insert(terminal_id.clone(), instance);

        // Start output forwarding thread
        let instances = self.instances.clone();
        let tid = terminal_id.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                if let Ok(mut instances_lock) = instances.lock() {
                    if let Some(instance) = instances_lock.get_mut(&tid) {
                        let mut reader = pty_pair.master.try_clone_reader().unwrap();
                        loop {
                            match reader.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    let output = String::from_utf8_lossy(&buf[..n]).to_string();
                                    app.emit(&format!("terminal_output_{}", tid), output).ok();
                                }
                                Err(_) => break,
                            }
                        }
                    }
                }
                thread::sleep(std::time::Duration::from_millis(50));
            }
        });

        Ok(terminal_id)
    }

    pub fn write_to_terminal(&self, id: &str, data: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap();
        if let Some(instance) = instances.get_mut(id) {
            instance.writer.write_all(data.as_bytes())
                .map_err(|e| format!("Write failed: {}", e))?;
            instance.writer.flush()
                .map_err(|e| format!("Flush failed: {}", e))?;
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn resize_terminal(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let instances = self.instances.lock().unwrap();
        // Pty resize implementation depends on portable-pty API
        Ok(())
    }

    pub fn close_terminal(&self, id: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap();
        if let Some(mut instance) = instances.remove(id) {
            instance.child.kill().ok();
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }
}

impl Default for TerminalService {
    fn default() -> Self {
        Self::new()
    }
}
```

---

## Task 6: 实现 Tauri Commands (终端管理)

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src-tauri/src/commands/terminal.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/mod.rs`
- Modify: `terminal-buddy/src-tauri/src/main.rs`

**Steps:**

- [ ] **Step 1: 创建 terminal 命令**

Create `terminal-buddy/src-tauri/src/commands/terminal.rs`:

```rust
use crate::commands::profile::get_profile;
use crate::services::terminal_service::TerminalService;
use tauri::{command, AppHandle, State};

#[command]
pub fn start_terminal(
    profile_id: String,
    app: AppHandle,
    terminal_service: State<TerminalService>,
) -> Result<String, String> {
    let profile = get_profile(profile_id)?;
    terminal_service.create_terminal(&profile, app)
}

#[command]
pub fn write_to_terminal(
    id: String,
    data: String,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.write_to_terminal(&id, &data)
}

#[command]
pub fn resize_terminal(
    id: String,
    rows: u16,
    cols: u16,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.resize_terminal(&id, rows, cols)
}

#[command]
pub fn close_terminal(
    id: String,
    terminal_service: State<TerminalService>,
) -> Result<(), String> {
    terminal_service.close_terminal(&id)
}
```

- [ ] **Step 2: 更新 commands/mod.rs**

```rust
pub mod profile;
pub mod terminal;
pub use profile::*;
pub use terminal::*;
```

- [ ] **Step 3: 更新 main.rs 注册终端命令**

```rust
use crate::services::terminal_service::TerminalService;

fn main() {
    tauri::Builder::default()
        .manage(TerminalService::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_all_profiles,
            commands::get_profile,
            commands::create_profile,
            commands::update_profile,
            commands::delete_profile,
            commands::update_profile_last_used,
            commands::start_terminal,
            commands::write_to_terminal,
            commands::resize_terminal,
            commands::close_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

## Task 7: 前端基础 - 创建 Tauri API 封装

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/services/tauri.ts`

**Steps:**

- [ ] **Step 1: 创建 tauri 服务封装**

Create `terminal-buddy/src/services/tauri.ts`:

```typescript
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type { Profile } from '../types';

// Profile Commands
export async function getAllProfiles(): Promise<Profile[]> {
  return invoke('get_all_profiles');
}

export async function getProfile(id: string): Promise<Profile> {
  return invoke('get_profile', { id });
}

export async function createProfile(
  name: string,
  group: string,
  terminalType: 'powershell' | 'cmd'
): Promise<Profile> {
  return invoke('create_profile', { name, group, terminalType });
}

export async function updateProfile(profile: Profile): Promise<void> {
  return invoke('update_profile', { profile });
}

export async function deleteProfile(id: string): Promise<void> {
  return invoke('delete_profile', { id });
}

export async function updateProfileLastUsed(id: string): Promise<void> {
  return invoke('update_profile_last_used', { id });
}

// Terminal Commands
export async function startTerminal(profileId: string): Promise<string> {
  return invoke('start_terminal', { profileId });
}

export async function writeToTerminal(id: string, data: string): Promise<void> {
  return invoke('write_to_terminal', { id, data });
}

export async function resizeTerminal(
  id: string,
  rows: number,
  cols: number
): Promise<void> {
  return invoke('resize_terminal', { id, rows, cols });
}

export async function closeTerminal(id: string): Promise<void> {
  return invoke('close_terminal', { id });
}

// Events
export async function onTerminalOutput(
  terminalId: string,
  callback: (output: string) => void
): Promise<UnlistenFn> {
  return listen(`terminal_output_${terminalId}`, (event) => {
    callback(event.payload as string);
  });
}
```

---

## Task 8: 创建 Zustand Store

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/stores/appStore.ts`

**Steps:**

- [ ] **Step 1: 创建全局状态管理**

Create `terminal-buddy/src/stores/appStore.ts`:

```typescript
import { create } from 'zustand';
import type { Profile, TerminalSession } from '../types';

interface AppState {
  // Profiles
  profiles: Profile[];
  selectedProfileId: string | null;
  setProfiles: (profiles: Profile[]) => void;
  addProfile: (profile: Profile) => void;
  updateProfile: (profile: Profile) => void;
  removeProfile: (id: string) => void;
  selectProfile: (id: string | null) => void;

  // Terminal Sessions
  sessions: TerminalSession[];
  activeSessionId: string | null;
  addSession: (session: TerminalSession) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Profiles
  profiles: [],
  selectedProfileId: null,
  setProfiles: (profiles) => set({ profiles }),
  addProfile: (profile) =>
    set((state) => ({ profiles: [...state.profiles, profile] })),
  updateProfile: (profile) =>
    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === profile.id ? profile : p)),
    })),
  removeProfile: (id) =>
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
    })),
  selectProfile: (id) => set({ selectedProfileId: id }),

  // Terminal Sessions
  sessions: [],
  activeSessionId: null,
  addSession: (session) =>
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId:
        state.activeSessionId === id
          ? state.sessions[0]?.id ?? null
          : state.activeSessionId,
    })),
  setActiveSession: (id) => set({ activeSessionId: id }),
}));
```

---

## Task 9: 实现主布局和 Toolbar 组件

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/components/Toolbar.tsx`
- Modify: `terminal-buddy/src/App.tsx`
- Create: `terminal-buddy/src/styles/global.css`

**Steps:**

- [ ] **Step 1: 创建全局样式**

Create `terminal-buddy/src/styles/global.css`:

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --bg-tertiary: #2d2d2d;
  --text-primary: #cccccc;
  --text-secondary: #858585;
  --accent: #0078d4;
  --border: #3c3c3c;
}

html, body, #root {
  height: 100%;
  width: 100%;
  overflow: hidden;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.app-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.toolbar-btn {
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
}

.toolbar-btn:hover {
  background: var(--accent);
}

.toolbar-spacer {
  flex: 1;
}

.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}
```

- [ ] **Step 2: 创建 Toolbar 组件**

Create `terminal-buddy/src/components/Toolbar.tsx`:

```tsx
import React from 'react';
import './Toolbar.css';

interface ToolbarProps {
  onNew: () => void;
  onImport: () => void;
  onExport: () => void;
  onSettings: () => void;
  hasSelection: boolean;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  onNew,
  onImport,
  onExport,
  onSettings,
  hasSelection,
}) => {
  return (
    <div className="toolbar">
      <button className="toolbar-btn" onClick={onNew}>
        新建
      </button>
      <button className="toolbar-btn" onClick={onImport}>
        导入
      </button>
      <button className="toolbar-btn" onClick={onExport} disabled={!hasSelection}>
        导出
      </button>
      <div className="toolbar-spacer" />
      <button className="toolbar-btn" onClick={onSettings}>
        设置
      </button>
    </div>
  );
};
```

Create `terminal-buddy/src/components/Toolbar.css`:

```css
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.toolbar-btn {
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
}

.toolbar-btn:hover:not(:disabled) {
  background: var(--accent);
}

.toolbar-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toolbar-spacer {
  flex: 1;
}
```

- [ ] **Step 3: 更新 App.tsaml**

Modify `terminal-buddy/src/App.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { ConfigPanel } from './components/ConfigPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { ConfigEditDialog } from './components/ConfigEditDialog';
import { useAppStore } from './stores/appStore';
import { getAllProfiles } from './services/tauri';
import type { Profile } from './types';
import './styles/global.css';

function App() {
  const { profiles, setProfiles, selectedProfileId } = useAppStore();
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    try {
      const data = await getAllProfiles();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to load profiles:', err);
    }
  };

  const handleNew = () => {
    setEditingProfile(null);
    setShowEditDialog(true);
  };

  const handleImport = () => {
    // TODO: Implement file import
  };

  const handleExport = () => {
    // TODO: Implement file export
  };

  const handleSettings = () => {
    // TODO: Implement settings dialog
  };

  return (
    <div className="app-container">
      <Toolbar
        onNew={handleNew}
        onImport={handleImport}
        onExport={handleExport}
        onSettings={handleSettings}
        hasSelection={selectedProfileId !== null}
      />
      <div className="main-content">
        <ConfigPanel />
        <TerminalPanel />
      </div>
      {showEditDialog && (
        <ConfigEditDialog
          profile={editingProfile}
          onClose={() => setShowEditDialog(false)}
          onSave={() => {
            setShowEditDialog(false);
            loadProfiles();
          }}
        />
      )}
    </div>
  );
}

export default App;
```

---

## Task 10: 实现 ConfigPanel 组件

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/components/ConfigPanel.tsx`
- Create: `terminal-buddy/src/components/ConfigPanel.css`

**Steps:**

- [ ] **Step 1: 创建 ConfigPanel 组件**

Create `terminal-buddy/src/components/ConfigPanel.tsx`:

```tsx
import React, { useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { Profile } from '../types';
import './ConfigPanel.css';

interface ConfigPanelProps {
  onStartTerminal: (profile: Profile) => void;
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({ onStartTerminal }) => {
  const { profiles, selectedProfileId, selectProfile, removeProfile } = useAppStore();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(['默认'])
  );
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    profileId: string;
  } | null>(null);

  const groupedProfiles = useMemo(() => {
    const groups: Record<string, Profile[]> = {};
    profiles.forEach((p) => {
      const group = p.group || '默认';
      if (!groups[group]) groups[group] = [];
      groups[group].push(p);
    });
    return groups;
  }, [profiles]);

  const toggleGroup = (group: string) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(group)) {
      newExpanded.delete(group);
    } else {
      newExpanded.add(group);
    }
    setExpandedGroups(newExpanded);
  };

  const handleContextMenu = (e: React.MouseEvent, profileId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, profileId });
  };

  const closeContextMenu = () => setContextMenu(null);

  const recentProfiles = profiles
    .filter((p) => p.lastUsedAt)
    .sort(
      (a, b) =>
        new Date(b.lastUsedAt!).getTime() - new Date(a.lastUsedAt!).getTime()
    )
    .slice(0, 3);

  return (
    <div className="config-panel" onClick={closeContextMenu}>
      <div className="config-list">
        {Object.entries(groupedProfiles).map(([group, groupProfiles]) => (
          <div key={group} className="config-group">
            <div
              className="group-header"
              onClick={() => toggleGroup(group)}
            >
              <span className="group-icon">
                {expandedGroups.has(group) ? '▼' : '▶'}
              </span>
              <span className="group-name">{group}</span>
              <span className="group-count">{groupProfiles.length}</span>
            </div>
            {expandedGroups.has(group) && (
              <div className="group-items">
                {groupProfiles.map((profile) => (
                  <div
                    key={profile.id}
                    className={`config-item ${
                      selectedProfileId === profile.id ? 'selected' : ''
                    }`}
                    onClick={() => selectProfile(profile.id)}
                    onDoubleClick={() => onStartTerminal(profile)}
                    onContextMenu={(e) => handleContextMenu(e, profile.id)}
                  >
                    <span className="config-icon">
                      {profile.terminalType === 'powershell' ? 'PS' : 'CMD'}
                    </span>
                    <span className="config-name">{profile.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {profiles.length === 0 && (
          <div className="empty-state">暂无配置，点击新建</div>
        )}
      </div>

      {recentProfiles.length > 0 && (
        <div className="quick-launch">
          <div className="quick-launch-title">快速启动</div>
          {recentProfiles.map((profile) => (
            <div
              key={profile.id}
              className="quick-launch-item"
              onClick={() => onStartTerminal(profile)}
            >
              {profile.name}
            </div>
          ))}
        </div>
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              onStartTerminal(
                profiles.find((p) => p.id === contextMenu.profileId)!
              );
              closeContextMenu();
            }}
          >
            启动
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              // TODO: Edit profile
              closeContextMenu();
            }}
          >
            编辑
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              // TODO: Copy profile
              closeContextMenu();
            }}
          >
            复制
          </div>
          <div
            className="context-menu-item danger"
            onClick={() => {
              removeProfile(contextMenu.profileId);
              closeContextMenu();
            }}
          >
            删除
          </div>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: 创建 ConfigPanel 样式**

Create `terminal-buddy/src/components/ConfigPanel.css`:

```css
.config-panel {
  width: 250px;
  min-width: 200px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.config-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.config-group {
  margin-bottom: 4px;
}

.group-header {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 4px;
}

.group-header:hover {
  background: var(--bg-tertiary);
}

.group-icon {
  font-size: 10px;
  margin-right: 6px;
  color: var(--text-secondary);
}

.group-name {
  flex: 1;
  font-weight: 500;
}

.group-count {
  font-size: 12px;
  color: var(--text-secondary);
}

.group-items {
  padding-left: 16px;
}

.config-item {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 4px;
  margin: 2px 0;
}

.config-item:hover {
  background: var(--bg-tertiary);
}

.config-item.selected {
  background: var(--accent);
}

.config-icon {
  font-size: 10px;
  font-weight: bold;
  padding: 2px 4px;
  background: var(--bg-primary);
  border-radius: 2px;
  margin-right: 8px;
}

.config-name {
  font-size: 13px;
}

.empty-state {
  text-align: center;
  padding: 20px;
  color: var(--text-secondary);
  font-size: 13px;
}

.quick-launch {
  border-top: 1px solid var(--border);
  padding: 8px;
}

.quick-launch-title {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  text-transform: uppercase;
}

.quick-launch-item {
  padding: 6px 8px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
}

.quick-launch-item:hover {
  background: var(--bg-tertiary);
}

.context-menu {
  position: fixed;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px;
  min-width: 120px;
  z-index: 1000;
}

.context-menu-item {
  padding: 6px 12px;
  cursor: pointer;
  border-radius: 2px;
  font-size: 13px;
}

.context-menu-item:hover {
  background: var(--bg-tertiary);
}

.context-menu-item.danger {
  color: #f44747;
}
```

---

## Task 11: 实现 TerminalPanel 和 xterm.js 集成

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/components/TerminalPanel.tsx`
- Create: `terminal-buddy/src/components/TerminalPanel.css`
- Create: `terminal-buddy/src/components/TerminalTab.tsx`
- Create: `terminal-buddy/src/components/TerminalInstance.tsx`

**Steps:**

- [ ] **Step 1: 创建 TerminalTab 组件**

Create `terminal-buddy/src/components/TerminalTab.tsx`:

```tsx
import React from 'react';
import './TerminalTab.css';

interface TerminalTabProps {
  id: string;
  name: string;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
}

export const TerminalTab: React.FC<TerminalTabProps> = ({
  name,
  isActive,
  onClick,
  onClose,
}) => {
  return (
    <div
      className={`terminal-tab ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <span className="tab-name">{name}</span>
      <span className="tab-close" onClick={(e) => { e.stopPropagation(); onClose(); }}>
        ×
      </span>
    </div>
  );
};
```

Create `terminal-buddy/src/components/TerminalTab.css`:

```css
.terminal-tab {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-right: 1px solid var(--border);
  cursor: pointer;
  min-width: 100px;
  max-width: 200px;
}

.terminal-tab:hover {
  background: var(--bg-primary);
}

.terminal-tab.active {
  background: var(--bg-primary);
  border-bottom: 2px solid var(--accent);
}

.tab-name {
  flex: 1;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close {
  margin-left: 8px;
  font-size: 14px;
  color: var(--text-secondary);
}

.tab-close:hover {
  color: var(--text-primary);
}
```

- [ ] **Step 2: 创建 TerminalInstance 组件（xterm.js 封装）**

Create `terminal-buddy/src/components/TerminalInstance.tsx`:

```tsx
import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './TerminalInstance.css';

interface TerminalInstanceProps {
  terminalId: string;
  onOutput: (data: string) => void;
  onResize?: (rows: number, cols: number) => void;
}

export const TerminalInstance: React.FC<TerminalInstanceProps> = ({
  terminalId,
  onOutput,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new (await import('@xterm/addon-web-links')).WebLinksAddon());

    terminal.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.onData((data) => {
      onOutput(data);
    });

    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      terminal.dispose();
    };
  }, [terminalId]);

  // Expose write method via ref or callback
  useEffect(() => {
    (window as any)[`xterm_write_${terminalId}`] = (data: string) => {
      xtermRef.current?.write(data);
    };
    return () => {
      delete (window as any)[`xterm_write_${terminalId}`];
    };
  }, [terminalId]);

  return <div ref={terminalRef} className="terminal-instance" />;
};
```

Create `terminal-buddy/src/components/TerminalInstance.css`:

```css
.terminal-instance {
  width: 100%;
  height: 100%;
  padding: 4px;
}

.terminal-instance .xterm {
  height: 100%;
}

.terminal-instance .xterm-viewport {
  overflow-y: auto !important;
}
```

- [ ] **Step 3: 创建 TerminalPanel 组件**

Create `terminal-buddy/src/components/TerminalPanel.tsx`:

```tsx
import React, { useEffect } from 'react';
import { TerminalTab } from './TerminalTab';
import { TerminalInstance } from './TerminalInstance';
import { useAppStore } from '../stores/appStore';
import { startTerminal, writeToTerminal, closeTerminal, onTerminalOutput, updateProfileLastUsed } from '../services/tauri';
import type { Profile } from '../types';
import './TerminalPanel.css';

export const TerminalPanel: React.FC = () => {
  const { sessions, activeSessionId, addSession, removeSession, setActiveSession, profiles } = useAppStore();

  const handleStartTerminal = async (profile: Profile) => {
    try {
      const terminalId = await startTerminal(profile.id);

      // Update last used
      await updateProfileLastUsed(profile.id);

      // Add session
      addSession({
        id: terminalId,
        profileId: profile.id,
        profileName: profile.name,
        terminalType: profile.terminalType,
      });

      // Listen for output
      await onTerminalOutput(terminalId, (output) => {
        const writeFn = (window as any)[`xterm_write_${terminalId}`];
        if (writeFn) writeFn(output);
      });
    } catch (err) {
      console.error('Failed to start terminal:', err);
    }
  };

  const handleCloseTerminal = async (sessionId: string) => {
    try {
      await closeTerminal(sessionId);
      removeSession(sessionId);
    } catch (err) {
      console.error('Failed to close terminal:', err);
    }
  };

  const handleWrite = async (sessionId: string, data: string) => {
    try {
      await writeToTerminal(sessionId, data);
    } catch (err) {
      console.error('Failed to write to terminal:', err);
    }
  };

  return (
    <div className="terminal-panel">
      {sessions.length > 0 && (
        <div className="terminal-tabs">
          {sessions.map((session) => (
            <TerminalTab
              key={session.id}
              id={session.id}
              name={session.profileName}
              isActive={activeSessionId === session.id}
              onClick={() => setActiveSession(session.id)}
              onClose={() => handleCloseTerminal(session.id)}
            />
          ))}
        </div>
      )}

      <div className="terminal-content">
        {sessions.length === 0 ? (
          <div className="terminal-empty">
            <div className="empty-icon">⌨</div>
            <div className="empty-text">点击左侧配置启动终端</div>
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`terminal-tab-content ${
                activeSessionId === session.id ? 'active' : ''
              }`}
            >
              <TerminalInstance
                terminalId={session.id}
                onOutput={(data) => handleWrite(session.id, data)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
};
```

Create `terminal-buddy/src/components/TerminalPanel.css`:

```css
.terminal-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  overflow: hidden;
}

.terminal-tabs {
  display: flex;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}

.terminal-content {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.terminal-tab-content {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: none;
}

.terminal-tab-content.active {
  display: block;
}

.terminal-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-text {
  font-size: 14px;
}
```

---

## Task 12: 实现 ConfigEditDialog 组件

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/components/ConfigEditDialog.tsx`
- Create: `terminal-buddy/src/components/ConfigEditDialog.css`

**Steps:**

- [ ] **Step 1: 创建 ConfigEditDialog 组件**

Create `terminal-buddy/src/components/ConfigEditDialog.tsx`:

```tsx
import React, { useForm } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { createProfile, updateProfile, deleteProfile } from '../services/tauri';
import { PRESET_THEMES, type Profile } from '../types';
import './ConfigEditDialog.css';

interface ConfigEditDialogProps {
  profile: Profile | null;
  onClose: () => void;
  onSave: () => void;
}

interface FormData {
  name: string;
  group: string;
  terminalType: 'powershell' | 'cmd';
  startupPath: string;
  colorTheme: string;
}

export const ConfigEditDialog: React.FC<ConfigEditDialogProps> = ({
  profile,
  onClose,
  onSave,
}) => {
  const { register, handleSubmit, control, formState: { errors } } = useForm<FormData>({
    defaultValues: {
      name: profile?.name || '',
      group: profile?.group || '默认',
      terminalType: (profile?.terminalType as any) || 'powershell',
      startupPath: profile?.startupPath || '',
      colorTheme: profile?.colorTheme || 'dark-default',
    },
  });

  const onSubmit = async (data: FormData) => {
    try {
      if (profile) {
        await updateProfile({
          ...profile,
          ...data,
        });
      } else {
        await createProfile(data.name, data.group, data.terminalType);
      }
      onSave();
    } catch (err) {
      console.error('Failed to save profile:', err);
    }
  };

  const handleDelete = async () => {
    if (profile && confirm('确定要删除此配置吗？')) {
      try {
        await deleteProfile(profile.id);
        onSave();
      } catch (err) {
        console.error('Failed to delete profile:', err);
      }
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{profile ? '编辑配置' : '新建配置'}</h3>
          <button className="dialog-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="dialog-content">
          <div className="form-group">
            <label>名称</label>
            <input
              {...register('name', { required: '请输入配置名称' })}
              placeholder="配置名称"
            />
            {errors.name && <span className="error">{errors.name.message}</span>}
          </div>

          <div className="form-group">
            <label>分组</label>
            <input {...register('group')} placeholder="默认" />
          </div>

          <div className="form-group">
            <label>终端类型</label>
            <div className="radio-group">
              <label>
                <input type="radio" value="powershell" {...register('terminalType')} />
                PowerShell
              </label>
              <label>
                <input type="radio" value="cmd" {...register('terminalType')} />
                CMD
              </label>
            </div>
          </div>

          <div className="form-group">
            <label>起始路径</label>
            <input {...register('startupPath')} placeholder="C:\Projects" />
          </div>

          <div className="form-group">
            <label>颜色主题</label>
            <select {...register('colorTheme')}>
              {PRESET_THEMES.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name}
                </option>
              ))}
            </select>
          </div>

          <div className="dialog-footer">
            {profile && (
              <button type="button" className="btn-danger" onClick={handleDelete}>
                删除
              </button>
            )}
            <div className="spacer" />
            <button type="button" className="btn-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn-primary">
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
```

Create `terminal-buddy/src/components/ConfigEditDialog.css`:

```css
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--bg-secondary);
  border-radius: 8px;
  width: 480px;
  max-width: 90%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 16px;
}

.dialog-close {
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--text-secondary);
}

.dialog-close:hover {
  color: var(--text-primary);
}

.dialog-content {
  padding: 20px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--accent);
}

.form-group .error {
  color: #f44747;
  font-size: 12px;
  margin-top: 4px;
}

.radio-group {
  display: flex;
  gap: 16px;
}

.radio-group label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.dialog-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.dialog-footer .spacer {
  flex: 1;
}

.btn-primary {
  padding: 8px 16px;
  background: var(--accent);
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 13px;
}

.btn-secondary {
  padding: 8px 16px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
}

.btn-danger {
  padding: 8px 16px;
  background: transparent;
  border: 1px solid #f44747;
  border-radius: 4px;
  color: #f44747;
  cursor: pointer;
  font-size: 13px;
}
```

---

## Task 13: 集成配置-终端联动

**Skills:** _none_

**Steps:**

- [ ] **Step 1: 更新 App.tsx 连接 ConfigPanel 和 TerminalPanel**

Modify `terminal-buddy/src/App.tsx` to pass `onStartTerminal`:

```tsx
// In App.tsx, update ConfigPanel usage:
<ConfigPanel onStartTerminal={handleStartTerminal} />

// And add this handler:
const handleStartTerminal = async (profile: Profile) => {
  // TerminalPanel will handle the actual start via its internal logic
  // or we can use a shared state/event system
};
```

**Note:** 由于 ConfigPanel 和 TerminalPanel 在不同组件层级，需要通过 Zustand store 中转终端启动事件。

```tsx
// In TerminalPanel, expose a start handler via window or store
// Add to useAppStore:
startTerminalFromProfile: (profileId: string) => void,

// In TerminalPanel useEffect, watch for profile changes:
// This integration step will be handled when implementing the full flow
```

- [ ] **Step 2: 确保终端颜色主题应用**

```tsx
// In TerminalInstance.tsx, use profile's colorTheme:
const theme = PRESET_THEMES.find(t => t.id === profile.colorTheme) || PRESET_THEMES[0];

const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Consolas, "Courier New", monospace',
  theme: {
    background: theme.background,
    foreground: theme.foreground,
  },
});
```

---

## Task 14: 命令模板功能

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/data/commandTemplates.ts`
- Modify: `terminal-buddy/src/components/ConfigEditDialog.tsx`

**Steps:**

- [ ] **Step 1: 定义命令模板数据**

Create `terminal-buddy/src/data/commandTemplates.ts`:

```typescript
export interface CommandTemplate {
  category: string;
  commands: { name: string; command: string }[];
}

export const COMMAND_TEMPLATES: CommandTemplate[] = [
  {
    category: 'Node.js',
    commands: [
      { name: 'npm install', command: 'npm install' },
      { name: 'npm run dev', command: 'npm run dev' },
      { name: 'npm run build', command: 'npm run build' },
      { name: 'yarn install', command: 'yarn install' },
      { name: 'pnpm install', command: 'pnpm install' },
    ],
  },
  {
    category: 'Git',
    commands: [
      { name: 'git status', command: 'git status' },
      { name: 'git pull', command: 'git pull' },
      { name: 'git push', command: 'git push' },
      { name: 'git checkout -b', command: 'git checkout -b ' },
      { name: 'git merge', command: 'git merge ' },
    ],
  },
  {
    category: 'Docker',
    commands: [
      { name: 'docker ps', command: 'docker ps' },
      { name: 'docker images', command: 'docker images' },
      { name: 'docker-compose up', command: 'docker-compose up' },
      { name: 'docker exec -it', command: 'docker exec -it ' },
    ],
  },
  {
    category: 'Kubernetes',
    commands: [
      { name: 'kubectl get pods', command: 'kubectl get pods' },
      { name: 'kubectl apply -f', command: 'kubectl apply -f ' },
      { name: 'kubectl logs', command: 'kubectl logs ' },
      { name: 'kubectl describe', command: 'kubectl describe ' },
    ],
  },
  {
    category: 'Python',
    commands: [
      { name: 'python -m venv', command: 'python -m venv' },
      { name: 'pip install', command: 'pip install ' },
      { name: 'python main.py', command: 'python main.py' },
      { name: 'conda activate', command: 'conda activate ' },
    ],
  },
  {
    category: 'dotnet',
    commands: [
      { name: 'dotnet build', command: 'dotnet build' },
      { name: 'dotnet run', command: 'dotnet run' },
      { name: 'dotnet test', command: 'dotnet test' },
      { name: 'dotnet publish', command: 'dotnet publish' },
    ],
  },
  {
    category: '系统管理',
    commands: [
      { name: 'netstat -ano', command: 'netstat -ano' },
      { name: 'tasklist', command: 'tasklist' },
      { name: 'sc query', command: 'sc query' },
      { name: 'netsh advfirewall', command: 'netsh advfirewall' },
    ],
  },
  {
    category: '文件操作',
    commands: [
      { name: 'dir /s', command: 'dir /s' },
      { name: 'cd /d', command: 'cd /d' },
      { name: 'mkdir', command: 'mkdir ' },
      { name: 'robocopy', command: 'robocopy ' },
    ],
  },
];
```

- [ ] **Step 2: 在 ConfigEditDialog 中添加命令模板面板**

Add to `terminal-buddy/src/components/ConfigEditDialog.tsx`:

```tsx
import { COMMAND_TEMPLATES } from '../data/commandTemplates';

// Inside the dialog, add a collapsible "命令模板" section
// On click, insert selected command into startupCommands
```

---

## Task 15: 导入/导出配置

**Skills:** _none_

**Steps:**

- [ ] **Step 1: 实现导入功能**

```typescript
// In tauri.ts, add:
export async function importProfile(filePath: string): Promise<Profile> {
  // Read file and save to profiles directory
}

export async function exportProfile(id: string, filePath: string): Promise<void> {
  // Read profile and write to selected location
}
```

- [ ] **Step 2: 使用 Tauri 文件对话框**

```typescript
import { open, save } from '@tauri-apps/plugin-dialog';

// Import
const selected = await open({
  filters: [{ name: 'JSON', extensions: ['json'] }]
});

// Export
const path = await save({
  filters: [{ name: 'JSON', extensions: ['json'] }],
  defaultPath: `${profile.name}.json`
});
```

---

## Task 16: 验证和测试

**Skills:** _none_

**Steps:**

- [ ] **Step 1: 运行开发服务器验证**

```bash
npm run tauri dev
```

- [ ] **Step 2: 验证功能清单**

- [ ] 可创建新配置，选择终端类型（PowerShell / CMD）
- [ ] 配置列表按分组折叠展示
- [ ] 点击配置后，右侧终端面板新增标签页并启动对应终端
- [ ] 可切换终端类型（powershell / cmd）
- [ ] 可为配置选择预设颜色主题
- [ ] 关闭标签页可终止对应终端进程
- [ ] 配置以独立 JSON 文件保存在 Profiles 目录
- [ ] 复制粘贴功能正常
- [ ] 终端输入输出正常

- [ ] **Step 3: 构建发布版本**

```bash
npm run tauri build
```

---

## 实施顺序

1. **Task 1** - 初始化项目
2. **Task 2** - 数据模型
3. **Task 3** - profile_service
4. **Task 4** - Tauri profile commands
5. **Task 5** - terminal_service
6. **Task 6** - Tauri terminal commands
7. **Task 7** - 前端 API 封装
8. **Task 8** - Zustand store
9. **Task 9** - 主布局和 Toolbar
10. **Task 10** - ConfigPanel
11. **Task 11** - TerminalPanel + xterm.js
12. **Task 12** - ConfigEditDialog
13. **Task 13** - 集成联动
14. **Task 14** - 命令模板
15. **Task 15** - 导入导出
16. **Task 16** - 验证测试

---

**Plan complete.** Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
