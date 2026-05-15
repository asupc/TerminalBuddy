# 工作区管理 - 实施计划（阶段 1：标签分组 + 数据模型基础）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现终端标签分组功能，建立工作区数据模型，扩展终端类型支持 SSH/Docker/K8s。

**Architecture:** 后端 Rust 新增 Workspace 数据模型和 WorkspaceService（JSON 文件持久化，同 ProfileService 模式）。前端扩展 TerminalType 联合类型，改造 TerminalPanel 标签栏为分组折叠模式，扩展 Zustand store 管理分组状态。Profile 模型扩展 SSH/Docker/K8s 连接字段。

**Tech Stack:** Tauri 2 (Rust), React 18, TypeScript, Zustand, xterm.js

---

## File Structure

### 后端（新建/修改）

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-tauri/src/models/workspace.rs` | 新建 | Workspace, WorkspaceGroup, WorkspaceTerminal, LayoutConfig, SplitNode 数据结构 |
| `src-tauri/src/models/mod.rs` | 修改 | 添加 `pub mod workspace;` |
| `src-tauri/src/services/workspace_service.rs` | 新建 | Workspace CRUD，JSON 文件持久化 |
| `src-tauri/src/services/mod.rs` | 修改 | 添加 `pub mod workspace_service;` |
| `src-tauri/src/commands/workspace.rs` | 新建 | Tauri 命令：get_all_workspaces, get_workspace, create_workspace, update_workspace, delete_workspace |
| `src-tauri/src/commands/mod.rs` | 修改 | 添加 `pub mod workspace;` 和 re-export |
| `src-tauri/src/models/profile.rs` | 修改 | 扩展 Profile 添加 SSH/Docker/K8s 连接字段 |
| `src-tauri/src/lib.rs` | 修改 | 注册 workspace commands |

### 前端（新建/修改）

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/types/index.ts` | 修改 | 扩展 TerminalType，新增 Workspace 相关类型 |
| `src/services/tauri.ts` | 修改 | 新增 workspace 相关 invoke 函数 |
| `src/stores/appStore.ts` | 修改 | 新增 groups 状态、workspace 关联状态、分组操作 |
| `src/components/TerminalPanel.tsx` | 修改 | 改造标签栏为分组模式 |
| `src/components/TerminalTab.tsx` | 修改 | 添加 groupId 属性，分组内拖拽 |
| `src/components/TabGroup.tsx` | 新建 | 分组标签栏组件（组头 + 折叠/展开） |
| `src/components/TerminalPanel.css` | 修改 | 分组样式 |
| `src/components/ConfigEditDialog.tsx` | 修改 | 根据 terminalType 动态显示 SSH/Docker/K8s 字段 |
| `src/App.tsx` | 修改 | 分组相关操作传递 |

---

## Task 1: 后端 Workspace 数据模型

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src-tauri/src/models/workspace.rs`
- Modify: `terminal-buddy/src-tauri/src/models/mod.rs`

- [ ] **Step 1: 创建 workspace.rs 数据模型**

```rust
// terminal-buddy/src-tauri/src/models/workspace.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub groups: Vec<WorkspaceGroup>,
    pub created_at: String,
    pub last_used_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGroup {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub terminals: Vec<WorkspaceTerminal>,
    pub layout: LayoutConfig,
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTerminal {
    pub profile_id: Option<String>,
    pub terminal_type: String,
    // Local terminal
    pub startup_path: Option<String>,
    pub startup_commands: Option<Vec<String>>,
    pub environment_variables: Option<std::collections::HashMap<String, String>>,
    // SSH
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub ssh_auth_type: Option<String>,
    pub ssh_key_path: Option<String>,
    // Docker
    pub docker_container_id: Option<String>,
    pub docker_container_name: Option<String>,
    // K8s
    pub k8s_namespace: Option<String>,
    pub k8s_pod_name: Option<String>,
    pub k8s_container_name: Option<String>,
    // General
    pub color_theme: Option<String>,
    pub tab_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LayoutConfig {
    Tabs,
    Split(SplitNode),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitNode {
    pub direction: String,
    pub ratio: f64,
    pub first: SplitChild,
    pub second: SplitChild,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SplitChild {
    Node(Box<SplitNode>),
    Terminal(String),
}
```

- [ ] **Step 2: 在 models/mod.rs 注册模块**

在 `terminal-buddy/src-tauri/src/models/mod.rs` 添加：

```rust
pub mod workspace;
```

在已有内容 `pub mod profile;` 等之后添加一行即可。

- [ ] **Step 3: 验证编译**

```bash
cd terminal-buddy/src-tauri && cargo check
```

Expected: 编译通过，无错误。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/models/workspace.rs src-tauri/src/models/mod.rs
git commit -m "feat: 添加 Workspace 数据模型（Rust 后端）"
```

---

## Task 2: 后端 WorkspaceService

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src-tauri/src/services/workspace_service.rs`
- Modify: `terminal-buddy/src-tauri/src/services/mod.rs`

- [ ] **Step 1: 创建 workspace_service.rs**

```rust
// terminal-buddy/src-tauri/src/services/workspace_service.rs
use crate::models::workspace::Workspace;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
}

pub struct WorkspaceService;

impl WorkspaceService {
    fn get_workspaces_dir() -> PathBuf {
        let base = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("TerminalBuddy")
            .join("Workspaces");
        fs::create_dir_all(&base).ok();
        base
    }

    pub fn get_all_workspaces() -> Result<Vec<Workspace>, String> {
        let dir = Self::get_workspaces_dir();
        let mut workspaces = Vec::new();

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map_or(false, |e| e == "json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(workspace) = serde_json::from_str::<Workspace>(&content) {
                            workspaces.push(workspace);
                        }
                    }
                }
            }
        }

        workspaces.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
        Ok(workspaces)
    }

    pub fn get_workspace(id: &str) -> Result<Workspace, String> {
        let workspaces = Self::get_all_workspaces()?;
        workspaces.into_iter()
            .find(|w| w.id == id)
            .ok_or_else(|| format!("Workspace not found: {}", id))
    }

    pub fn create_workspace(name: &str) -> Result<Workspace, String> {
        let workspace = Workspace {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            icon: None,
            groups: Vec::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            last_used_at: chrono::Utc::now().to_rfc3339(),
        };

        let path = Self::get_workspaces_dir().join(format!("{}.json", sanitize_filename(&workspace.name)));
        let content = serde_json::to_string_pretty(&workspace)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        Ok(workspace)
    }

    pub fn update_workspace(workspace: &Workspace) -> Result<(), String> {
        // Handle name change: delete old file
        if let Ok(old) = Self::get_workspace(&workspace.id) {
            if old.name != workspace.name {
                let old_path = Self::get_workspaces_dir().join(format!("{}.json", sanitize_filename(&old.name)));
                fs::remove_file(&old_path).ok();
            }
        }

        let path = Self::get_workspaces_dir().join(format!("{}.json", sanitize_filename(&workspace.name)));
        let content = serde_json::to_string_pretty(workspace)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))
    }

    pub fn delete_workspace(id: &str) -> Result<(), String> {
        let workspace = Self::get_workspace(id)?;
        let path = Self::get_workspaces_dir().join(format!("{}.json", sanitize_filename(&workspace.name)));
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete workspace: {}", e))
    }
}
```

- [ ] **Step 2: 在 services/mod.rs 注册模块**

在 `terminal-buddy/src-tauri/src/services/mod.rs` 添加：

```rust
pub mod workspace_service;
```

- [ ] **Step 3: 验证编译**

```bash
cd terminal-buddy/src-tauri && cargo check
```

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/services/workspace_service.rs src-tauri/src/services/mod.rs
git commit -m "feat: 添加 WorkspaceService 工作区持久化服务"
```

---

## Task 3: 后端 Workspace Tauri 命令 + 扩展 Profile 模型

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src-tauri/src/commands/workspace.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/mod.rs`
- Modify: `terminal-buddy/src-tauri/src/models/profile.rs`
- Modify: `terminal-buddy/src-tauri/src/lib.rs`

- [ ] **Step 1: 创建 workspace 命令文件**

```rust
// terminal-buddy/src-tauri/src/commands/workspace.rs
use tauri::{command, State};
use crate::models::workspace::Workspace;
use crate::services::WorkspaceService;

#[command]
pub fn get_all_workspaces() -> Result<Vec<Workspace>, String> {
    WorkspaceService::get_all_workspaces()
}

#[command]
pub fn get_workspace(id: String) -> Result<Workspace, String> {
    WorkspaceService::get_workspace(&id)
}

#[command]
pub fn create_workspace(name: String) -> Result<Workspace, String> {
    WorkspaceService::create_workspace(&name)
}

#[command]
pub fn update_workspace(workspace: Workspace) -> Result<(), String> {
    WorkspaceService::update_workspace(&workspace)
}

#[command]
pub fn delete_workspace(id: String) -> Result<(), String> {
    WorkspaceService::delete_workspace(&id)
}
```

- [ ] **Step 2: 在 commands/mod.rs 注册**

在 `terminal-buddy/src-tauri/src/commands/mod.rs` 添加：

```rust
pub mod workspace;
pub use workspace::*;
```

- [ ] **Step 3: 扩展 Profile 模型添加 SSH/Docker/K8s 字段**

在 `terminal-buddy/src-tauri/src/models/profile.rs` 的 `Profile` struct 中，在 `pub window_size: Option<WindowSize>,` 之后添加：

```rust
    // SSH fields
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub ssh_auth_type: Option<String>,
    pub ssh_key_path: Option<String>,
    // Docker fields
    pub docker_container_id: Option<String>,
    pub docker_container_name: Option<String>,
    // K8s fields
    pub k8s_namespace: Option<String>,
    pub k8s_pod_name: Option<String>,
    pub k8s_container_name: Option<String>,
```

同步更新 `ProfileService::create_profile` 中的初始化，添加默认值：

```rust
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_auth_type: None,
            ssh_key_path: None,
            docker_container_id: None,
            docker_container_name: None,
            k8s_namespace: None,
            k8s_pod_name: None,
            k8s_container_name: None,
```

- [ ] **Step 4: 在 lib.rs 注册 workspace 命令**

在 `terminal-buddy/src-tauri/src/lib.rs` 的 `use commands::{...}` 行中添加 workspace 命令导入：

```rust
use commands::{..., get_all_workspaces, get_workspace, create_workspace, update_workspace, delete_workspace};
```

在 `invoke_handler` 的 `generate_handler![]` 宏中添加：

```rust
            get_all_workspaces,
            get_workspace,
            create_workspace,
            update_workspace,
            delete_workspace,
```

- [ ] **Step 5: 验证编译**

```bash
cd terminal-buddy/src-tauri && cargo check
```

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/commands/workspace.rs src-tauri/src/commands/mod.rs src-tauri/src/models/profile.rs src-tauri/src/services/profile_service.rs src-tauri/src/lib.rs
git commit -m "feat: 添加 Workspace 命令和扩展 Profile SSH/Docker/K8s 字段"
```

---

## Task 4: 前端类型扩展 + Workspace 类型定义

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/types/index.ts`
- Modify: `terminal-buddy/src/services/tauri.ts`

- [ ] **Step 1: 扩展前端类型定义**

在 `terminal-buddy/src/types/index.ts` 中修改：

将 `TerminalType` 扩展：
```typescript
export type TerminalType = 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s';
```

扩展 `Profile` 接口，在 `windowSize` 之后添加：
```typescript
  // SSH
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'key';
  sshKeyPath?: string;
  // Docker
  dockerContainerId?: string;
  dockerContainerName?: string;
  // K8s
  k8sNamespace?: string;
  k8sPodName?: string;
  k8sContainerName?: string;
```

在文件末尾添加 Workspace 相关类型：
```typescript
export interface Workspace {
  id: string;
  name: string;
  icon?: string;
  groups: WorkspaceGroup[];
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  color?: string;
  terminals: WorkspaceTerminal[];
  layout: LayoutConfig;
  collapsed: boolean;
}

export interface WorkspaceTerminal {
  profileId?: string;
  terminalType: TerminalType;
  startupPath?: string;
  startupCommands?: string[];
  environmentVariables?: Record<string, string>;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'key';
  sshKeyPath?: string;
  dockerContainerId?: string;
  dockerContainerName?: string;
  k8sNamespace?: string;
  k8sPodName?: string;
  k8sContainerName?: string;
  colorTheme?: string;
  tabColor?: string;
}

export interface LayoutConfig {
  type: 'tabs' | 'split';
  splits?: SplitNode;
}

export interface SplitNode {
  direction: 'horizontal' | 'vertical';
  ratio: number;
  first: SplitNode | string;
  second: SplitNode | string;
}

export interface TabGroup {
  id: string;
  name: string;
  color?: string;
  collapsed: boolean;
}
```

- [ ] **Step 2: 在 tauri.ts 添加 workspace 命令**

在 `terminal-buddy/src/services/tauri.ts` 中 `// Settings Commands` 之前添加：

```typescript
import type { Profile, CustomTheme, Workspace } from '../types';

// Workspace Commands
export async function getAllWorkspaces(): Promise<Workspace[]> {
  return invoke('get_all_workspaces');
}

export async function getWorkspace(id: string): Promise<Workspace> {
  return invoke('get_workspace', { id });
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return invoke('create_workspace', { name });
}

export async function updateWorkspace(workspace: Workspace): Promise<void> {
  return invoke('update_workspace', { workspace });
}

export async function deleteWorkspace(id: string): Promise<void> {
  return invoke('delete_workspace', { id });
}
```

同时更新 `createProfile` 的 `terminalType` 参数类型：
```typescript
export async function createProfile(
  name: string,
  group: string,
  terminalType: 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s'
): Promise<Profile> {
```

更新 `startBlankTerminal` 的参数类型：
```typescript
export async function startBlankTerminal(terminalType: 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s'): Promise<string> {
```

- [ ] **Step 3: 验证前端编译**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
git add src/types/index.ts src/services/tauri.ts
git commit -m "feat: 前端扩展 TerminalType 和 Workspace 类型定义"
```

---

## Task 5: 扩展 Zustand Store 分组状态

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/stores/appStore.ts`

- [ ] **Step 1: 在 AppState 接口添加分组和工作区状态**

在 `terminal-buddy/src/stores/appStore.ts` 的 `AppState` 接口中，`// Terminal Sessions` 之前添加：

```typescript
  // Tab Groups
  groups: TabGroup[];
  addGroup: (name: string, color?: string) => void;
  removeGroup: (id: string) => void;
  renameGroup: (id: string, name: string) => void;
  setGroupColor: (id: string, color: string) => void;
  toggleGroupCollapse: (id: string) => void;
  moveSessionToGroup: (sessionId: string, groupId: string) => void;

  // Workspace
  currentWorkspaceId: string | null;
  workspaceModified: boolean;
  setCurrentWorkspace: (id: string | null) => void;
  setWorkspaceModified: (modified: boolean) => void;
```

在 import 中添加 `TabGroup`：
```typescript
import type { Profile, TerminalSession, CustomTheme, TabGroup } from '../types';
```

- [ ] **Step 2: 扩展 TerminalSession 添加 groupId**

在 `terminal-buddy/src/types/index.ts` 的 `TerminalSession` 接口中添加 `groupId`：

```typescript
export interface TerminalSession {
  id: string;
  profileId: string;
  profileName: string;
  terminalType: TerminalType;
  colorTheme: { background: string; foreground: string };
  tabColor: string | null;
  groupId: string;
}
```

- [ ] **Step 3: 实现 store 中的分组操作**

在 `useAppStore` 的 `create` 回调中，`// Terminal Sessions` 之前添加实现：

```typescript
  // Tab Groups
  groups: [{ id: 'default', name: '默认', collapsed: false }],
  addGroup: (name, color) => set((state) => ({
    groups: [...state.groups, { id: crypto.randomUUID(), name, color, collapsed: false }],
  })),
  removeGroup: (id) => set((state) => {
    if (id === 'default') return state;
    const defaultGroupId = 'default';
    return {
      groups: state.groups.filter((g) => g.id !== id),
      sessions: state.sessions.map((s) =>
        s.groupId === id ? { ...s, groupId: defaultGroupId } : s
      ),
    };
  }),
  renameGroup: (id, name) => set((state) => ({
    groups: state.groups.map((g) => g.id === id ? { ...g, name } : g),
  })),
  setGroupColor: (id, color) => set((state) => ({
    groups: state.groups.map((g) => g.id === id ? { ...g, color } : g),
  })),
  toggleGroupCollapse: (id) => set((state) => ({
    groups: state.groups.map((g) => g.id === id ? { ...g, collapsed: !g.collapsed } : g),
  })),
  moveSessionToGroup: (sessionId, groupId) => set((state) => ({
    sessions: state.sessions.map((s) =>
      s.id === sessionId ? { ...s, groupId } : s
    ),
  })),

  // Workspace
  currentWorkspaceId: null,
  workspaceModified: false,
  setCurrentWorkspace: (id) => set({ currentWorkspaceId: id, workspaceModified: false }),
  setWorkspaceModified: (modified) => set({ workspaceModified: modified }),
```

- [ ] **Step 4: 更新 addSession 确保有 groupId**

修改 `addSession` 确保新 session 默认归入 'default' 组。在 `addSession` 实现中，如果 session 没有 groupId，设置默认值：

```typescript
  addSession: (session) =>
    set((state) => {
      const s = { ...session, groupId: session.groupId || 'default' };
      const sessions = [...state.sessions, s];
      saveTabsToStorage(sessions, s.id);
      return { sessions, activeSessionId: s.id };
    }),
```

- [ ] **Step 5: 更新 SavedTab 接口和 saveTabsToStorage**

更新 `SavedTab` 接口添加 `groupId`：
```typescript
interface SavedTab {
  profileId: string;
  profileName: string;
  terminalType: string;
  colorTheme: { background: string; foreground: string };
  tabColor: string | null;
  groupId: string;
}
```

更新 `saveTabsToStorage` 中的映射添加 `groupId`：
```typescript
    const tabs: SavedTab[] = sessions.map(s => ({
      profileId: s.profileId,
      profileName: s.profileName,
      terminalType: s.terminalType,
      colorTheme: s.colorTheme,
      tabColor: s.tabColor,
      groupId: s.groupId,
    }));
```

- [ ] **Step 6: 验证编译**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 7: 提交**

```bash
git add src/types/index.ts src/stores/appStore.ts
git commit -m "feat: 扩展 Zustand store 添加分组和工作区状态管理"
```

---

## Task 6: 创建 TabGroup 组件

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/components/TabGroup.tsx`
- Create: `terminal-buddy/src/components/TabGroup.css`

- [ ] **Step 1: 创建 TabGroup 组件**

```tsx
// terminal-buddy/src/components/TabGroup.tsx
import { FC, useState, useRef } from 'react';
import type { TabGroup as TabGroupType } from '../types';
import './TabGroup.css';

interface TabGroupProps {
  group: TabGroupType;
  onToggleCollapse: () => void;
  onRename: (name: string) => void;
  onContextMenu: (e: React.MouseEvent, groupId: string) => void;
}

export const TabGroupHeader: FC<TabGroupProps> = ({
  group,
  onToggleCollapse,
  onRename,
  onContextMenu,
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDoubleClick = () => {
    if (group.id === 'default') return;
    setRenameValue(group.name);
    setIsRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const finishRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== group.name) {
      onRename(trimmed);
    }
    setIsRenaming(false);
  };

  return (
    <div
      className="tab-group-header"
      onClick={onToggleCollapse}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => onContextMenu(e, group.id)}
    >
      <span className={`tab-group-collapse ${group.collapsed ? 'collapsed' : ''}`}>
        ▼
      </span>
      {group.color && (
        <span className="tab-group-color" style={{ backgroundColor: group.color }} />
      )}
      {isRenaming ? (
        <input
          ref={inputRef}
          className="tab-group-rename-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={finishRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finishRename();
            else if (e.key === 'Escape') setIsRenaming(false);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="tab-group-name">{group.name}</span>
      )}
    </div>
  );
};
```

- [ ] **Step 2: 创建 TabGroup.css**

```css
/* terminal-buddy/src/components/TabGroup.css */
.tab-group-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  user-select: none;
  height: 100%;
  border-right: 1px solid var(--border);
}

.tab-group-header:hover {
  background: var(--bg-tertiary);
}

.tab-group-collapse {
  font-size: 8px;
  transition: transform 0.2s;
}

.tab-group-collapse.collapsed {
  transform: rotate(-90deg);
}

.tab-group-color {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tab-group-name {
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-group-rename-input {
  width: 80px;
  padding: 1px 4px;
  border: 1px solid var(--accent-blue);
  border-radius: 2px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 11px;
  outline: none;
}

.tab-group-tabs {
  display: flex;
  overflow: hidden;
  transition: max-width 0.3s ease;
}

.tab-group-tabs.collapsed {
  max-width: 0 !important;
  overflow: hidden;
}

.tab-group-container {
  display: flex;
  align-items: stretch;
  border-right: 1px solid var(--border);
}

.tab-group-container:last-of-type {
  border-right: none;
}
```

- [ ] **Step 3: 提交**

```bash
git add src/components/TabGroup.tsx src/components/TabGroup.css
git commit -m "feat: 创建 TabGroup 分组标签栏组件"
```

---

## Task 7: 改造 TerminalPanel 为分组模式

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/TerminalPanel.tsx`
- Modify: `terminal-buddy/src/components/TerminalPanel.css`
- Modify: `terminal-buddy/src/components/TerminalTab.tsx`

- [ ] **Step 1: 改造 TerminalPanel 标签栏**

替换 `terminal-buddy/src/components/TerminalPanel.tsx` 的标签栏部分。在导入中添加：

```typescript
import { TabGroupHeader } from './TabGroup';
import type { TabGroup } from '../types';
```

在组件中添加分组上下文菜单状态和处理函数：

```typescript
  const { sessions, activeSessionId, removeSession, setActiveSession, renameSession, updateSession,
          groups, toggleGroupCollapse, renameGroup, moveSessionToGroup } = useAppStore();

  const [groupContextMenu, setGroupContextMenu] = useState<{ x: number; y: number; groupId: string } | null>(null);
  const [moveMenuSessionId, setMoveMenuSessionId] = useState<string | null>(null);

  const handleGroupContextMenu = (e: React.MouseEvent, groupId: string) => {
    e.preventDefault();
    setGroupContextMenu({ x: e.clientX, y: e.clientY, groupId });
  };

  const handleMoveToGroup = (sessionId: string, groupId: string) => {
    moveSessionToGroup(sessionId, groupId);
    setMoveMenuSessionId(null);
  };
```

替换标签栏渲染（`<div className="terminal-tabs">` 部分）为分组模式：

```tsx
      {sessions.length > 0 && (
        <div className="terminal-tabs">
          {groups.map((group) => {
            const groupSessions = sessions.filter((s) => s.groupId === group.id);
            if (groupSessions.length === 0 && group.id !== 'default') return null;
            return (
              <div key={group.id} className="tab-group-container">
                <TabGroupHeader
                  group={group}
                  onToggleCollapse={() => toggleGroupCollapse(group.id)}
                  onRename={(name) => renameGroup(group.id, name)}
                  onContextMenu={handleGroupContextMenu}
                />
                <div className={`tab-group-tabs ${group.collapsed ? 'collapsed' : ''}`}>
                  {groupSessions.map((session) => (
                    <TerminalTab
                      key={session.id}
                      id={session.id}
                      name={session.profileName}
                      color={session.tabColor || ''}
                      isActive={activeSessionId === session.id}
                      onClick={() => setActiveSession(session.id)}
                      onClose={() => handleCloseTerminal(session.id)}
                      onCloseOthers={() => handleCloseOthers(session.id)}
                      onCloseLeft={() => handleCloseLeft(session.id)}
                      onCloseRight={() => handleCloseRight(session.id)}
                      onCloseAll={handleCloseAll}
                      onRename={(name) => renameSession(session.id, name)}
                      onChangeColor={(color) => updateSession(session.id, { tabColor: color || null })}
                      onMoveToGroup={(groupId) => handleMoveToGroup(session.id, groupId)}
                      groups={groups}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <div className="tab-add" title="新建终端">+</div>
        </div>
      )}
```

- [ ] **Step 2: 扩展 TerminalTab 添加"移动到组"功能**

在 `terminal-buddy/src/components/TerminalTab.tsx` 的 props 接口中添加：

```typescript
  onMoveToGroup: (groupId: string) => void;
  groups: { id: string; name: string }[];
```

在右键菜单中，`<div className="context-menu-separator" />` 之前（在"更改颜色"和"关闭"之间）添加"移动到组"菜单项：

```tsx
            <div className="context-menu-separator" />
            <div className="context-menu-item has-submenu">
              <span>移动到组</span>
              <span className="color-menu-arrow">▶</span>
              <div className="context-submenu">
                {groups.map((g) => (
                  <div
                    key={g.id}
                    className="context-menu-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowContextMenu(false);
                      onMoveToGroup(g.id);
                    }}
                  >
                    {g.name}
                  </div>
                ))}
              </div>
            </div>
```

- [ ] **Step 3: 添加分组上下文菜单和子菜单样式**

在 `TerminalPanel.css` 中添加分组上下文菜单样式：

```css
.group-context-menu {
  position: fixed;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 160px;
  z-index: 250;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  padding: 4px 0;
}

.group-context-menu .context-menu-item {
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-primary);
}

.group-context-menu .context-menu-item:hover {
  background: var(--bg-hover);
}

.context-submenu {
  display: none;
  position: absolute;
  left: 100%;
  top: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 140px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  padding: 4px 0;
}

.context-menu-item.has-submenu {
  position: relative;
}

.context-menu-item.has-submenu:hover .context-submenu {
  display: block;
}
```

- [ ] **Step 4: 验证编译**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 5: 提交**

```bash
git add src/components/TerminalPanel.tsx src/components/TerminalPanel.css src/components/TerminalTab.tsx
git commit -m "feat: 改造 TerminalPanel 为分组标签模式"
```

---

## Task 8: 扩展 ConfigEditDialog 支持新终端类型

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/ConfigEditDialog.tsx`

- [ ] **Step 1: 在 ConfigEditDialog 中添加 SSH/Docker/K8s 配置区域**

在 `ConfigEditDialog.tsx` 的终端类型选择器中，扩展选项：

将现有的 `powershell` 和 `cmd` 单选改为 5 种类型：

```tsx
<div className="form-group">
  <label>终端类型</label>
  <select
    value={watchedTerminalType}
    onChange={(e) => setValue('terminalType', e.target.value as any)}
  >
    <option value="powershell">PowerShell</option>
    <option value="cmd">CMD</option>
    <option value="ssh">SSH</option>
    <option value="docker">Docker</option>
    <option value="k8s">Kubernetes</option>
  </select>
</div>
```

在终端类型选择器之后，根据类型动态显示配置字段：

```tsx
{watchedTerminalType === 'ssh' && (
  <>
    <div className="form-group">
      <label>主机地址</label>
      <input {...register('sshHost')} placeholder="192.168.1.100" />
    </div>
    <div className="form-group">
      <label>端口</label>
      <input type="number" {...register('sshPort')} defaultValue={22} />
    </div>
    <div className="form-group">
      <label>用户名</label>
      <input {...register('sshUser')} placeholder="root" />
    </div>
    <div className="form-group">
      <label>认证方式</label>
      <select {...register('sshAuthType')}>
        <option value="key">密钥认证</option>
        <option value="password">密码认证</option>
      </select>
    </div>
    {watchedSshAuthType === 'key' && (
      <div className="form-group">
        <label>密钥路径</label>
        <input {...register('sshKeyPath')} placeholder="~/.ssh/id_ed25519" />
      </div>
    )}
  </>
)}

{watchedTerminalType === 'docker' && (
  <>
    <div className="form-group">
      <label>容器名称 / ID</label>
      <input {...register('dockerContainerName')} placeholder="my-container" />
    </div>
  </>
)}

{watchedTerminalType === 'k8s' && (
  <>
    <div className="form-group">
      <label>Namespace</label>
      <input {...register('k8sNamespace')} placeholder="default" />
    </div>
    <div className="form-group">
      <label>Pod 名称</label>
      <input {...register('k8sPodName')} />
    </div>
    <div className="form-group">
      <label>Container 名称</label>
      <input {...register('k8sContainerName')} />
    </div>
  </>
)}
```

注意：需要用 `useWatch` 获取 `sshAuthType` 值来条件渲染密钥路径字段：

```typescript
const watchedSshAuthType = useWatch({ control, name: 'sshAuthType' });
```

当 `terminalType` 为 `ssh`、`docker` 或 `k8s` 时，隐藏"启动目录"和"环境变量"等本地终端专属字段（用条件渲染包裹）。

- [ ] **Step 2: 更新 form defaultValues**

确保 `useForm` 的 `defaultValues` 包含新字段：

```typescript
const form = useForm({
  defaultValues: {
    // ...existing...
    sshHost: profile?.sshHost || '',
    sshPort: profile?.sshPort || 22,
    sshUser: profile?.sshUser || '',
    sshAuthType: profile?.sshAuthType || 'key',
    sshKeyPath: profile?.sshKeyPath || '',
    dockerContainerId: profile?.dockerContainerId || '',
    dockerContainerName: profile?.dockerContainerName || '',
    k8sNamespace: profile?.k8sNamespace || '',
    k8sPodName: profile?.k8sPodName || '',
    k8sContainerName: profile?.k8sContainerName || '',
  },
});
```

- [ ] **Step 3: 验证编译**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
git add src/components/ConfigEditDialog.tsx
git commit -m "feat: ConfigEditDialog 支持SSH/Docker/K8s终端类型配置"
```

---

## Task 9: 更新 App.tsx 适配分组

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/App.tsx`

- [ ] **Step 1: 更新 handleStartTerminal 和 handleStartBlankTerminal**

在 `addSession` 调用中添加 `groupId: 'default'`：

```typescript
      addSession({
        id: terminalId,
        profileId: profile.id,
        profileName: profile.name,
        terminalType: profile.terminalType,
        colorTheme: { background: theme.background, foreground: theme.foreground },
        tabColor: profile.tabColor || null,
        groupId: 'default',
      });
```

同样更新 `handleStartBlankTerminal`：
```typescript
      addSession({
        id: terminalId,
        profileId: '',
        profileName: name,
        terminalType,
        colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
        tabColor: null,
        groupId: 'default',
      });
```

更新 `handleCopyProfile` 中 `terminalType` 类型断言：
```typescript
        terminalType as 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s'
```

- [ ] **Step 2: 更新 restoreTabs**

在 `restoreTabs` 函数中，`addSession` 调用添加 `groupId`：

```typescript
        addSession({
          id: terminalId,
          profileId: tab.profileId,
          profileName: tab.profileName,
          terminalType: tab.terminalType as any,
          colorTheme: tab.colorTheme,
          tabColor: tab.tabColor,
          groupId: tab.groupId || 'default',
        });
```

- [ ] **Step 3: 验证编译**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
git add src/App.tsx
git commit -m "feat: App.tsx 适配分组 TerminalSession"
```

---

## Task 10: 端到端验证

**Skills:** _none_

- [ ] **Step 1: 完整编译验证**

```bash
cd terminal-buddy/src-tauri && cargo check
```

```bash
cd terminal-buddy && npx tsc --noEmit
```

两个都应通过。

- [ ] **Step 2: 启动开发服务器手动验证**

```bash
cd terminal-buddy && npm run tauri dev
```

验证项：
1. 应用正常启动，界面正常显示
2. 可以创建/编辑/删除配置文件
3. 可以启动 PowerShell 和 CMD 终端
4. 标签栏显示"默认"分组
5. 可以新建分组、重命名、折叠/展开
6. 可以右键标签移动到不同组
7. 配置编辑对话框显示终端类型下拉（PowerShell/CMD/SSH/Docker/K8s）
8. 选择 SSH 类型时显示 SSH 配置字段

- [ ] **Step 3: 最终提交**

如果验证中发现问题，修复后提交。

---

## Self-Review Checklist

1. **Spec coverage:**
   - 数据模型（Workspace/WorkspaceGroup/WorkspaceTerminal/LayoutConfig/SplitNode）→ Task 1, Task 4
   - Profile 扩展 SSH/Docker/K8s 字段 → Task 3, Task 4
   - WorkspaceService 持久化 → Task 2
   - Workspace Tauri 命令 → Task 3
   - 标签分组 UI → Task 5, 6, 7
   - ConfigEditDialog 新终端类型 → Task 8
   - App.tsx 适配 → Task 9

2. **Placeholder scan:** 无 TBD/TODO。

3. **Type consistency:**
   - `TerminalSession.groupId` 在 types, store, App.tsx 中一致
   - `TerminalType` 在 types, tauri.ts, store 中一致
   - `TabGroup` 类型定义与使用一致
   - Rust `Profile` 字段与 TypeScript `Profile` 字段对应

4. **Step-level skill assignments:** 所有步骤均为 `_none_`（此项目无特定 domain skills）。

5. **Scope:** 本计划覆盖阶段 1（标签分组 + 数据模型基础）。阶段 2-6 后续追加。
