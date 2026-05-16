# 标签分组优化 / 设置页面修复 / 命令补全改进 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 13 项需求，涵盖标签分组管理增强、设置页面修复、命令补全改进、数据持久化和 UI 重组。

**Architecture:** 前端 React/TypeScript 组件修改为主，少量 Rust 后端修改。所有改动在现有架构内完成，不引入新的依赖或重大结构变更。

**Tech Stack:** React 18, TypeScript, Zustand, Tauri 2.x (Rust), xterm.js, CSS

---

## File Change Map

### 前端文件
| 文件 | 操作 | 职责 |
|------|------|------|
| `src/components/TabSidebar.tsx` | 修改 | 分组关闭功能、样式调整、右键菜单 |
| `src/components/TabSidebar.css` | 修改 | 分组名称样式、折叠图标大小 |
| `src/components/TerminalTab.tsx` | 修改 | 删除关闭其他/左/右菜单项 |
| `src/components/SettingsPage.tsx` | 修改 | 修复滚动BUG、添加导入/导出、添加配置管理 |
| `src/components/SettingsPage.css` | 修改 | 修复导航滚动、关闭按钮固定、添加配置管理样式 |
| `src/components/Toolbar.tsx` | 修改 | 移除添加配置按钮、移除新建按钮、移除导入导出按钮 |
| `src/data/commandTemplates.ts` | 修改 | 备注字段、去重逻辑、模板持久化 |
| `src/services/tauri.ts` | 修改 | 添加新后端命令的调用 |
| `src/stores/appStore.ts` | 修改 | 添加分组批量关闭方法 |
| `src/App.tsx` | 修改 | 传递新 props、移除旧按钮逻辑 |

### 后端文件
| 文件 | 操作 | 职责 |
|------|------|------|
| `src-tauri/src/commands/history.rs` | 修改 | 历史记录备注字段支持 |
| `src-tauri/src/services/history_service.rs` | 修改 | 备注数据模型、持久化 |
| `src-tauri/src/commands/settings.rs` | 修改 | 导入/导出全部数据 |
| `src-tauri/src/services/path_service.rs` | 修改 | 命令模板持久化路径 |
| `src-tauri/src/models/settings.rs` | 无需修改 | — |
| `src-tauri/src/lib.rs` | 修改 | 注册新命令、退出确认逻辑 |

---

## Task 1: 修复设置页面滚动 BUG（需求 5）

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/SettingsPage.css`

- [ ] **Step 1: 修复 CSS — 设置导航固定、关闭按钮固定、内容区可滚动**

修改 `SettingsPage.css`，解决三个问题：

1. `settings-nav` 需要固定在左侧，不随内容滚动 → 添加 `position: sticky; top: 0;` 或在 flex 布局中不滚动
2. `settings-body` 的内容区需要独立滚动 → 确保 `settings-content` 有 `overflow-y: auto` 且占据正确高度
3. `settings-close-btn` 需要固定在 `settings-body` 右上角 → 当前已是 `position: absolute`，需确保 `settings-body` 有 `overflow: hidden`

当前 CSS 问题分析：
- `settings-body` 是 `flex-direction: column`，包含 `settings-close-btn`、`settings-content`、`settings-footer`
- `settings-content` 已有 `overflow-y: auto`，但 `settings-body` 没有限制高度，导致整个 body 一起被父容器滚动
- `settings-nav` 没有 `overflow-y: auto` 或 `position: sticky`，当内容很长时导航不跟随视口

修复方案：

```css
/* SettingsPage.css 关键修改 */

.settings-page {
  display: flex;
  height: 100%;
  background: var(--bg-secondary);
  overflow: hidden; /* 防止整个页面滚动 */
}

.settings-nav {
  width: 180px;
  min-width: 180px;
  border-right: 1px solid var(--border);
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--bg-secondary);
  overflow-y: auto; /* 导航自身可以滚动 */
  /* 不需要 sticky，因为 nav 已经是独立的 flex 列 */
}

.settings-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
  overflow: hidden; /* 关键：防止 body 自身溢出 */
}

.settings-close-btn {
  position: absolute;
  top: 8px;
  right: 12px;
  z-index: 10;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 18px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background 0.15s, color 0.15s;
  line-height: 1;
}

.settings-content {
  flex: 1;
  overflow-y: auto; /* 这是唯一需要滚动的区域 */
  padding: 20px 24px;
  padding-right: 48px; /* 给关闭按钮留空间 */
}

.settings-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 24px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
  flex-shrink: 0; /* 防止 footer 被压缩 */
}
```

- [ ] **Step 2: 验证设置页面滚动行为**

在 `npm run dev` 中打开设置页面，验证：
1. 左侧导航不随内容滚动
2. 内容区域可以独立滚动
3. 关闭按钮固定在右上角
4. 底部按钮始终可见

---

## Task 2: TabSidebar 分组样式和关闭分组功能（需求 1, 2, 3）

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/TabSidebar.tsx`
- Modify: `terminal-buddy/src/components/TabSidebar.css`

### 2.1 分组名称样式修复（需求 3）

- [ ] **Step 1: 修改 CSS — 左对齐、移除全大写、提高对比度、放大折叠图标**

修改 `TabSidebar.css`：

```css
/* 修改 tab-sidebar-group-name */
.tab-sidebar-group-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary); /* 从 --text-secondary 改为 --text-primary 提高对比度 */
  /* 移除 text-transform: uppercase; */
  /* 移除 letter-spacing: 0.5px; */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1; /* 左对齐，让 count 靠右 */
  text-align: left;
}

/* 修改 tab-sidebar-group-arrow */
.tab-sidebar-group-arrow {
  font-size: 12px; /* 从 10px 增大到 12px */
  color: var(--text-primary); /* 提高对比度 */
  transition: transform 0.15s;
  flex-shrink: 0;
  margin-right: 6px; /* 给箭头和名称之间加点间距 */
}

/* 修改 group-header 的布局为左对齐 */
.tab-sidebar-group-header {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  cursor: pointer;
  user-select: none;
  gap: 0; /* 用子元素的 margin 控制间距 */
}
```

### 2.2 关闭整个分组功能（需求 1, 2）

- [ ] **Step 2: 在 TabSidebar 分组头部添加关闭按钮**

修改 `TabSidebar.tsx`，在分组头部右侧添加关闭按钮：

```tsx
// 在 tab-sidebar-group-header 内部，count 后面添加关闭按钮
{group.sessions.length > 0 && (
  <button
    className="tab-sidebar-group-close"
    onClick={(e) => {
      e.stopPropagation();
      handleCloseGroup(group);
    }}
    title="关闭分组内所有终端"
  >
    ×
  </button>
)}
```

- [ ] **Step 3: 添加关闭分组确认和执行逻辑**

在 `TabSidebar.tsx` 中添加 `handleCloseGroup` 函数：

```tsx
const handleCloseGroup = async (group: { name: string; sessions: typeof sessions }) => {
  if (!confirm(`确定要关闭分组「${group.name}」中的所有 ${group.sessions.length} 个终端吗？`)) {
    return;
  }
  for (const session of group.sessions) {
    try { await closeTerminalCmd(session.id); } catch (err) { console.error(err); }
    removeSession(session.id);
    if (session.groupId) {
      useAppStore.getState().removeSplitTerminal(session.groupId, session.id);
    }
  }
};
```

- [ ] **Step 4: 添加关闭按钮样式**

```css
.tab-sidebar-group-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  padding: 0 2px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.1s;
  flex-shrink: 0;
  line-height: 1;
}

.tab-sidebar-group-header:hover .tab-sidebar-group-close {
  opacity: 1;
}

.tab-sidebar-group-close:hover {
  color: #f44747;
  background: rgba(244, 71, 71, 0.1);
}
```

- [ ] **Step 5: 验证**

检查分组名称左对齐、非全大写、高对比度、折叠图标放大、关闭分组功能及确认提示。

---

## Task 3: 删除 Tab 右键菜单中的关闭其他/左/右（需求 9）

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/TerminalTab.tsx`

- [ ] **Step 1: 移除 TerminalTabProps 中 onCloseOthers, onCloseLeft, onCloseRight**

从 `TerminalTabProps` 接口和组件解构中移除 `onCloseOthers`、`onCloseLeft`、`onCloseRight`。

- [ ] **Step 2: 移除右键菜单中对应的三个菜单项**

删除以下菜单项代码：
```tsx
// 删除这三个 div
<div className="context-menu-item" onClick={() => { ... onCloseOthers(); }}>关闭其他</div>
<div className="context-menu-item" onClick={() => { ... onCloseLeft(); }}>关闭左侧</div>
<div className="context-menu-item" onClick={() => { ... onCloseRight(); }}>关闭右侧</div>
```

保留"关闭"和"关闭全部"菜单项。

- [ ] **Step 3: 更新 TerminalPanel 中传递给 TerminalTab 的 props**

在 `TerminalPanel.tsx` 中找到创建 `TerminalTab` 的地方，移除 `onCloseOthers`、`onCloseLeft`、`onCloseRight` 的传递。

**注意：** 需要确认 TerminalTab 在哪些文件中被使用。根据代码分析，TerminalTab 目前可能只在 TerminalPanel 或其他地方使用。搜索所有 `onCloseOthers` 引用并清理。

- [ ] **Step 4: 验证**

右键标签，确认只显示"关闭"和"关闭全部"，不再显示"关闭其他"、"关闭左侧"、"关闭右侧"。

---

## Task 4: 历史命令备注功能（需求 6）

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/history_service.rs` — 改为结构化数据
- Modify: `terminal-buddy/src-tauri/src/commands/history.rs` — 添加备注相关命令
- Modify: `terminal-buddy/src-tauri/src/lib.rs` — 注册新命令
- Modify: `terminal-buddy/src/services/tauri.ts` — 添加前端调用
- Modify: `terminal-buddy/src/data/commandTemplates.ts` — 备注类型定义和逻辑
- Modify: `terminal-buddy/src/components/SettingsPage.tsx` — 历史命令备注编辑

### 4.1 后端 — 历史记录结构化

- [ ] **Step 1: 修改历史记录数据模型**

在 `history_service.rs` 中，将 `Vec<String>` 改为结构化数据：

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub command: String,
    #[serde(default)]
    pub note: String,
}

impl HistoryEntry {
    pub fn new(command: &str) -> Self {
        Self { command: command.trim().to_string(), note: String::new() }
    }
}
```

修改 `HistoryService` 中所有方法，使用 `HistoryEntry` 替代 `String`：

```rust
pub fn get_history() -> Vec<HistoryEntry> {
    let path = Self::get_history_path();
    match fs::read_to_string(&path) {
        Ok(content) => {
            // 兼容旧格式：尝试先解析为 Vec<HistoryEntry>，失败则从 Vec<String> 迁移
            if let Ok(entries) = serde_json::from_str::<Vec<HistoryEntry>>(&content) {
                return entries;
            }
            if let Ok(strings) = serde_json::from_str::<Vec<String>>(&content) {
                let entries: Vec<HistoryEntry> = strings.into_iter()
                    .map(|s| HistoryEntry::new(&s))
                    .collect();
                let _ = Self::save_history(&entries);
                return entries;
            }
            Vec::new()
        }
        Err(_) => Vec::new(),
    }
}

fn save_history(history: &[HistoryEntry]) -> Result<(), String> {
    let path = Self::get_history_path();
    let content = serde_json::to_string_pretty(history)
        .map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&path, content)
        .map_err(|e| format!("写入失败: {}", e))
}

pub fn add_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() { return Ok(()); }
    let mut history = Self::get_history();
    history.retain(|c| c.command != trimmed);
    history.insert(0, HistoryEntry::new(trimmed));
    history.truncate(MAX_HISTORY);
    Self::save_history(&history)
}

pub fn delete_command(command: &str) -> Result<(), String> {
    let mut history = Self::get_history();
    let before = history.len();
    history.retain(|c| c.command != command);
    if history.len() == before {
        return Err("命令未找到".to_string());
    }
    Self::save_history(&history)
}

pub fn update_command(old_command: &str, new_command: &str) -> Result<(), String> {
    let trimmed = new_command.trim();
    if trimmed.is_empty() { return Err("新命令不能为空".to_string()); }
    let mut history = Self::get_history();
    if let Some(pos) = history.iter().position(|c| c.command == old_command) {
        history[pos].command = trimmed.to_string();
        Self::save_history(&history)
    } else {
        Err("命令未找到".to_string())
    }
}

pub fn update_command_note(command: &str, note: &str) -> Result<(), String> {
    let mut history = Self::get_history();
    if let Some(pos) = history.iter().position(|c| c.command == command) {
        history[pos].note = note.to_string();
        Self::save_history(&history)
    } else {
        Err("命令未找到".to_string())
    }
}

pub fn clear_history() -> Result<(), String> {
    Self::save_history(&[])
}

pub fn import_commands(commands: Vec<String>) -> Result<(), String> {
    let mut history = Self::get_history();
    let existing: Vec<String> = history.iter().map(|e| e.command.clone()).collect();
    for cmd in commands {
        let trimmed = cmd.trim().to_string();
        if !trimmed.is_empty() && !existing.contains(&trimmed) {
            history.push(HistoryEntry::new(&trimmed));
        }
    }
    history.truncate(MAX_HISTORY);
    Self::save_history(&history)
}
```

- [ ] **Step 2: 添加备注命令**

在 `commands/history.rs` 添加：

```rust
#[command]
pub fn update_command_note(command: String, note: String) -> Result<(), String> {
    HistoryService::update_command_note(&command, &note)
}
```

更新 `get_command_history` 返回类型：

```rust
use crate::services::{HistoryService, HistoryEntry};

#[command]
pub fn get_command_history() -> Vec<HistoryEntry> {
    HistoryService::get_history()
}
```

- [ ] **Step 3: 注册新命令**

在 `lib.rs` 的 `invoke_handler` 中添加 `update_command_note`，以及在 `use commands::` 行添加导入。

### 4.2 前端 — 备注类型和 UI

- [ ] **Step 4: 更新前端类型和服务**

在 `data/commandTemplates.ts` 中修改：

```typescript
export interface HistoryEntry {
  command: string;
  note: string;
}

// 修改 historyCache 类型
let historyCache: HistoryEntry[] | null = null;

export function getCommandHistory(): HistoryEntry[] {
  return historyCache ?? [];
}

export async function loadCommandHistory(): Promise<HistoryEntry[]> {
  try {
    historyCache = await tauriService.getCommandHistory();
  } catch {
    historyCache = [];
  }
  return historyCache;
}

export async function addCommandToHistory(command: string): Promise<void> {
  const trimmed = command.trim();
  if (!trimmed) return;
  try {
    await tauriService.addCommandToHistory(trimmed);
    historyCache = await tauriService.getCommandHistory();
  } catch {
    if (historyCache) {
      historyCache = historyCache.filter(c => c.command !== trimmed);
      historyCache.unshift({ command: trimmed, note: '' });
    }
  }
}

export async function updateCommandNote(command: string, note: string): Promise<void> {
  await tauriService.updateCommandNote(command, note);
  historyCache = await tauriService.getCommandHistory();
}

// 更新 deleteCommandFromHistory, updateCommandInHistory 类似地使用 .command
export async function deleteCommandFromHistory(command: string): Promise<void> {
  await tauriService.deleteCommandFromHistory(command);
  historyCache = await tauriService.getCommandHistory();
}

export async function updateCommandInHistory(oldCommand: string, newCommand: string): Promise<void> {
  await tauriService.updateCommandInHistory(oldCommand, newCommand);
  historyCache = await tauriService.getCommandHistory();
}
```

更新 `getAllSuggestions` 使用备注：

```typescript
export function getAllSuggestions(): SuggestionItem[] {
  const history = getCommandHistory(); // HistoryEntry[]
  const tplMap = new Map<string, SuggestionItem>();

  for (const cat of getEffectiveTemplates()) {
    for (const c of cat.commands) {
      const key = c.command.trim();
      if (!tplMap.has(key)) {
        tplMap.set(key, { command: key, desc: c.desc });
      }
    }
  }

  const result: SuggestionItem[] = [];
  const seen = new Set<string>();

  for (const entry of history) {
    const tpl = tplMap.get(entry.command);
    // 如果历史有备注，优先使用备注作为描述
    const desc = entry.note || tpl?.desc || '历史命令';
    result.push({ command: entry.command, desc });
    seen.add(entry.command);
  }

  for (const [, item] of tplMap) {
    if (!seen.has(item.command)) {
      result.push(item);
    }
  }

  return result;
}
```

- [ ] **Step 5: 更新 tauri.ts**

```typescript
// History Commands — 更新返回类型
export interface HistoryEntryFE {
  command: string;
  note: string;
}

export async function getCommandHistory(): Promise<HistoryEntryFE[]> {
  return invoke('get_command_history');
}

export async function updateCommandNote(command: string, note: string): Promise<void> {
  return invoke('update_command_note', { command, note });
}
```

- [ ] **Step 6: 更新 SettingsPage 历史命令备注编辑 UI**

在 SettingsPage.tsx 的历史命令部分，为每个命令项添加备注编辑功能。修改历史命令渲染：

```tsx
// historyList 改为 HistoryEntry[] 类型
const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);
// ...
loadCommandHistory().then(() => setHistoryList(getCommandHistory())).catch(() => {});

// 渲染时显示备注并提供编辑
{historyList
  .filter(entry => !historySearch || entry.command.toLowerCase().includes(historySearch.toLowerCase()) || entry.note.toLowerCase().includes(historySearch.toLowerCase()))
  .map((entry, idx) => (
    <div key={idx} className="cmd-cat-item">
      <code className="cmd-cat-cmd">{entry.command}</code>
      {editingHistoryIdx === idx ? (
        <input className="cmd-edit-input" ... />
      ) : (
        <span className="cmd-cat-desc">
          {entry.note || (历史命令在模板中有匹配 ? 模板描述 : '')}
        </span>
      )}
      <div className="cmd-cat-actions">
        <button title="编辑备注" onClick={() => { setEditingNoteIdx(idx); setEditNoteValue(entry.note); }}>📝</button>
        <button title="编辑命令" onClick={() => { setEditingHistoryIdx(idx); setEditHistoryValue(entry.command); }}>✎</button>
        <button title="删除" onClick={...}>×</button>
      </div>
    </div>
))}
```

需要添加 `editingNoteIdx`、`editNoteValue` 状态。

- [ ] **Step 7: 验证**

在设置页面的命令历史中添加/编辑备注，在终端命令补全中确认备注显示。

---

## Task 5: 命令补全改进（需求 4, 8）

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/ConfigEditDialog.tsx` — 模糊匹配和去重
- Modify: `terminal-buddy/src/data/commandTemplates.ts` — getAllSuggestions 改进

### 5.1 新建配置启动命令模糊匹配改进（需求 4）

- [ ] **Step 1: 修改 ConfigEditDialog 的命令匹配逻辑**

当前 `handleCmdInputChange` 在 `ConfigEditDialog.tsx:84-103` 使用 `includes` 匹配。修改为模糊匹配，并且：
1. 历史命令如果没有备注信息就不显示（因为模板命令已有描述）
2. 避免重复显示命令

```typescript
const handleCmdInputChange = (index: number, value: string) => {
  updateCommand(index, value);
  if (value.trim() === '') {
    setCmdSuggestions([]);
    return;
  }
  const query = value.toLowerCase();
  const queryChars = [...query];

  // 模糊匹配函数
  const fuzzyMatch = (text: string): boolean => {
    const lower = text.toLowerCase();
    // 先尝试 includes（子串匹配优先）
    if (lower.includes(query)) return true;
    // 再尝试字符序列匹配
    let idx = 0;
    for (const ch of lower) {
      if (ch === queryChars[idx]) idx++;
      if (idx === queryChars.length) return true;
    }
    return false;
  };

  // 获取模板命令（带描述）
  const allCommands = COMMAND_TEMPLATES.flatMap(cat => cat.commands);
  const builtIn = allCommands.filter(cmd =>
    fuzzyMatch(cmd.command) || fuzzyMatch(cmd.desc)
  );

  // 历史命令：只显示有备注的，且不在模板中已出现的
  const history = getCommandHistory()
    .filter(entry => {
      // 如果该命令在模板中已有匹配，不重复显示
      if (builtIn.some(c => c.command === entry.command)) return false;
      // 如果没有备注，不显示
      if (!entry.note) return false;
      return fuzzyMatch(entry.command) || fuzzyMatch(entry.note);
    })
    .map(entry => ({ name: entry.command, command: entry.command }));

  setCmdSuggestions([...builtIn, ...uniqueHistory]);
  setActiveCmdIndex(index);
  setCmdSelectedIndex(-1);
};
```

### 5.2 命令补全使用备注索引（需求 8）

- [ ] **Step 2: 更新 getAllSuggestions 确保备注参与匹配**

`getAllSuggestions` 已在 Task 4 中更新，备注已作为 `desc` 字段参与。终端中的自动补全逻辑（`TerminalInstance.tsx`）使用 `getAllSuggestions()` 返回的 `SuggestionItem[]`，其中 `desc` 已包含备注。

验证 `TerminalInstance.tsx` 中补全匹配逻辑是否也搜索 `desc` 字段。查找 `suggestions.filter` 或类似代码，确保匹配逻辑同时搜索 `command` 和 `desc`。

- [ ] **Step 3: 验证**

1. 在设置中为历史命令添加备注
2. 在终端中输入部分命令或备注文字，确认补全能匹配
3. 在新建配置的启动命令中测试模糊匹配和去重

---

## Task 6: 命令模板数据持久化（需求 7）

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/path_service.rs` — 添加模板路径方法
- 新增: `terminal-buddy/src-tauri/src/commands/templates.rs` — 模板后端命令
- 新增: `terminal-buddy/src-tauri/src/services/template_service.rs` — 模板服务
- Modify: `terminal-buddy/src-tauri/src/lib.rs` — 注册命令
- Modify: `terminal-buddy/src-tauri/src/commands/mod.rs` — 添加模块
- Modify: `terminal-buddy/src-tauri/src/services/mod.rs` — 添加模块
- Modify: `terminal-buddy/src/services/tauri.ts` — 前端调用
- Modify: `terminal-buddy/src/data/commandTemplates.ts` — 加载持久化数据

- [ ] **Step 1: 添加后端模板服务**

在 `services/template_service.rs`：

```rust
use crate::services::PathService;
use std::fs;
use std::path::PathBuf;

pub struct TemplateService;

impl TemplateService {
    fn get_template_path() -> PathBuf {
        let dir = PathService::get_data_dir();
        fs::create_dir_all(&dir).ok();
        dir.join("command_templates.json")
    }

    pub fn get_templates() -> String {
        let path = Self::get_template_path();
        match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => String::from("[]"),
        }
    }

    pub fn save_templates(content: &str) -> Result<(), String> {
        // 验证 JSON 有效性
        let _: serde_json::Value = serde_json::from_str(content)
            .map_err(|e| format!("无效的JSON: {}", e))?;
        let path = Self::get_template_path();
        fs::write(&path, content)
            .map_err(|e| format!("写入失败: {}", e))
    }

    pub fn init_templates_if_missing(default_content: &str) -> Result<bool, String> {
        let path = Self::get_template_path();
        if !path.exists() {
            fs::write(&path, default_content)
                .map_err(|e| format!("初始化失败: {}", e))?;
            return Ok(true); // 返回 true 表示新初始化
        }
        Ok(false)
    }
}
```

- [ ] **Step 2: 添加模板命令**

在 `commands/templates.rs`：

```rust
use crate::services::TemplateService;

#[tauri::command]
pub fn get_command_templates() -> String {
    TemplateService::get_templates()
}

#[tauri::command]
pub fn save_command_templates(content: String) -> Result<(), String> {
    TemplateService::save_templates(&content)
}

#[tauri::command]
pub fn init_command_templates(default_content: String) -> Result<bool, String> {
    TemplateService::init_templates_if_missing(&default_content)
}
```

- [ ] **Step 3: 注册模块和命令**

在 `commands/mod.rs` 添加 `pub mod templates;` 和 `pub use templates::*;`
在 `services/mod.rs` 添加 `pub mod template_service;` 和 `pub use template_service::*;`
在 `lib.rs` 的 `use commands::` 行添加导入，在 `invoke_handler` 中注册。

- [ ] **Step 4: 前端集成**

在 `tauri.ts` 添加：

```typescript
export async function getCommandTemplates(): Promise<string> {
  return invoke('get_command_templates');
}

export async function saveCommandTemplates(content: string): Promise<void> {
  return invoke('save_command_templates', { content });
}

export async function initCommandTemplates(defaultContent: string): Promise<boolean> {
  return invoke('init_command_templates', { defaultContent });
}
```

在 `commandTemplates.ts` 中：

```typescript
// 添加初始化逻辑
export async function initPersistedTemplates(): Promise<void> {
  const defaultContent = JSON.stringify(COMMAND_TEMPLATES, null, 2);
  const isNew = await tauriService.initCommandTemplates(defaultContent);
  if (!isNew) {
    // 已有持久化数据，加载覆盖默认
    try {
      const content = await tauriService.getCommandTemplates();
      const persisted: CommandTemplate[] = JSON.parse(content);
      if (persisted.length > 0) {
        // 用持久化数据替换默认 COMMAND_TEMPLATES
        COMMAND_TEMPLATES.length = 0;
        persisted.forEach(t => COMMAND_TEMPLATES.push(t));
      }
    } catch {}
  }
}
```

在 `App.tsx` 初始化流程中调用 `initPersistedTemplates()`。

- [ ] **Step 5: 设置页面中添加保存逻辑**

当用户在设置页面修改命令模板（编辑描述、隐藏/显示、添加自定义）时，需要同步保存到后端持久化。在 `SettingsPage.tsx` 中，当 `saveCmdOverrides` 或 `saveCustomCommands` 被调用时，同时调用后端保存。

实际上当前的 override 和 custom 是分开的（localStorage）。模板主体也持久化后，需要确保 override + custom + 持久化模板三者的协调。简化方案：只持久化模板主体，override 和 custom 继续用 localStorage（因为它们是增量的）。

- [ ] **Step 6: 验证**

1. 首次启动，确认 `%APPDATA%/TerminalBuddy/command_templates.json` 被创建
2. 修改后重启，确认模板数据保持
3. 手动删除模板文件后重启，确认重新初始化

---

## Task 7: 退出确认（需求 10）

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src-tauri/src/lib.rs` — 退出确认逻辑

- [ ] **Step 1: 修改窗口关闭事件处理**

当前 `lib.rs` 的 `on_window_event` 只处理 `CloseBehavior::Tray` 的情况。需要增加：当 `CloseBehavior::Exit` 且有终端打开时，弹出确认。

但 Rust 后端无法直接获知前端有多少终端打开（终端会话状态在前端 Zustand 中）。解决方案：前端在关闭窗口前拦截确认。

在 Tauri 2.x 中，可以在前端使用 `window.onclose` 或者在 Rust 端通过事件与前端通信。

最简单的方案：在 Rust 端始终阻止关闭，通过 Tauri event 通知前端，前端决定是否真正关闭。

修改 `lib.rs`：

```rust
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let settings = SettingsService::get_settings();
        if settings.close_behavior == CloseBehavior::Tray {
            api.prevent_close();
            window.hide().ok();
        }
        // Exit 模式下不做额外拦截 — 前端处理确认
    }
})
```

在前端添加关闭前确认逻辑。在 `App.tsx` 中：

```typescript
import { getCurrentWindow } from '@tauri-apps/api/window';

useEffect(() => {
  const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
    const { sessions } = useAppStore.getState();
    if (sessions.length > 0) {
      const confirmed = confirm(`当前有 ${sessions.length} 个终端正在运行，确定要退出吗？`);
      if (!confirmed) {
        event.preventDefault();
      }
    }
  });
  return () => { unlisten.then(fn => fn()); };
}, []);
```

**注意：** 这个确认应该只在 `closeBehavior === 'exit'` 时触发。当设置为 tray 时，窗口隐藏不需要确认。检查 `getAppSettings().closeBehavior` 的值。

```typescript
useEffect(() => {
  const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
    const settings = getAppSettings();
    if (settings.closeBehavior === 'tray') return; // tray 模式由 Rust 端处理

    const { sessions } = useAppStore.getState();
    if (sessions.length > 0) {
      const confirmed = confirm(`当前有 ${sessions.length} 个终端正在运行，确定要退出吗？`);
      if (!confirmed) {
        event.preventDefault();
      }
    }
  });
  return () => { unlisten.then(fn => fn()); };
}, []);
```

- [ ] **Step 2: 验证**

1. 打开终端后关闭窗口，确认弹出确认对话框
2. 没有终端时关闭窗口，直接退出
3. 设置为 tray 模式后关闭窗口，直接隐藏

---

## Task 8: 导入/导出移至设置页面 + 包含全部数据（需求 11）

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/SettingsPage.tsx` — 添加导入/导出 UI
- Modify: `terminal-buddy/src/components/SettingsPage.css` — 样式
- Modify: `terminal-buddy/src-tauri/src/commands/settings.rs` — 全量导出/导入命令
- Modify: `terminal-buddy/src-tauri/src/services/path_service.rs` — 添加辅助方法
- Modify: `terminal-buddy/src-tauri/src/lib.rs` — 注册新命令
- Modify: `terminal-buddy/src/services/tauri.ts` — 前端调用
- Modify: `terminal-buddy/src/App.tsx` — 移除导入/导出 handler
- Modify: `terminal-buddy/src/components/Toolbar.tsx` — 移除导入/导出按钮

### 8.1 后端 — 全量导入/导出

- [ ] **Step 1: 添加全量导出命令**

在 `commands/settings.rs` 添加：

```rust
use std::fs;
use std::path::Path;

#[tauri::command]
pub fn export_all_data(export_path: String) -> Result<(), String> {
    let data_dir = PathService::get_data_dir();
    let export_dir = Path::new(&export_path);

    fs::create_dir_all(export_dir)
        .map_err(|e| format!("创建导出目录失败: {}", e))?;

    // 递归复制整个数据目录
    copy_dir_recursive(&data_dir, export_dir)?;

    Ok(())
}

#[tauri::command]
pub fn import_all_data(import_path: String) -> Result<(), String> {
    let import_dir = Path::new(&import_path);
    let data_dir = PathService::get_data_dir();

    if !import_dir.exists() || !import_dir.is_dir() {
        return Err("导入路径不存在或不是目录".to_string());
    }

    // 复制导入目录中的所有内容到数据目录
    for entry in fs::read_dir(import_dir).map_err(|e| format!("读取导入目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let src_path = entry.path();
        let dst_path = data_dir.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("复制文件失败: {}", e))?;
        }
    }

    Ok(())
}
```

在 `lib.rs` 注册这两个命令。

### 8.2 前端

- [ ] **Step 2: 添加前端调用**

在 `tauri.ts`：

```typescript
export async function exportAllData(exportPath: string): Promise<void> {
  return invoke('export_all_data', { exportPath });
}

export async function importAllData(importPath: string): Promise<void> {
  return invoke('import_all_data', { importPath });
}
```

- [ ] **Step 3: 在设置页面添加导入/导出区域**

在 SettingsPage.tsx 的通用设置区域（或新增一个"数据管理"区域），添加导入/导出按钮：

```tsx
<div className="settings-section">
  <label className="settings-label">数据导入/导出</label>
  <div className="data-management-row">
    <button className="btn-secondary" onClick={handleExportAllData}>
      导出全部数据
    </button>
    <button className="btn-secondary" onClick={handleImportAllData}>
      导入全部数据
    </button>
  </div>
  <p className="settings-desc">导出包含配置、主题、历史记录、命令模板等所有数据</p>
</div>
```

- [ ] **Step 4: 从 Toolbar 移除导入/导出按钮**

修改 `Toolbar.tsx`，移除 `onImport`、`onExport` props 和对应的按钮 JSX。

修改 `App.tsx`，移除 `handleImport`、`handleExport` 函数和传递给 Toolbar 的 props。

- [ ] **Step 5: 验证**

1. 设置页面中点击导出，选择目录后确认文件被导出
2. 导入测试
3. 工具栏中不再显示导入/导出按钮

---

## Task 9: 移除添加配置按钮，在设置中添加配置管理（需求 12）

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/Toolbar.tsx` — 移除添加配置按钮
- Modify: `terminal-buddy/src/components/SettingsPage.tsx` — 添加配置管理区域
- Modify: `terminal-buddy/src/components/SettingsPage.css` — 配置管理样式
- Modify: `terminal-buddy/src/App.tsx` — 移除相关 handler

- [ ] **Step 1: 在设置页面添加"配置管理"区域**

在 `SECTIONS` 数组中添加新分类：

```typescript
const SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'profiles', label: '配置管理' },  // 新增
  { id: 'commands', label: '命令模板' },
  { id: 'themes', label: '主题管理' },
  { id: 'history', label: '命令历史' },
  { id: 'exclusions', label: '文件排除' },
] as const;
```

在设置内容区域添加配置管理 section，包含：
- 搜索框
- 配置列表（按分组显示，每个配置有编辑/删除/启动按钮）
- 新建配置按钮（点击打开 ConfigEditDialog）

```tsx
{/* Profiles Section */}
<section id="profiles" ref={(el) => { sectionRefs.current['profiles'] = el; }} className="settings-section-block">
  <h3 className="settings-section-title">配置管理</h3>
  <div className="commands-panel">
    <div className="commands-toolbar">
      <input className="commands-search" type="text" placeholder="搜索配置..." value={profileSearch} onChange={(e) => setProfileSearch(e.target.value)} />
      <button className="cmd-add-btn" onClick={() => setShowProfileDialog(true)}>+ 新建配置</button>
    </div>
    <div className="commands-list" style={{ maxHeight: 400 }}>
      {filteredProfiles.map(profile => (
        <div key={profile.id} className="cmd-cat-item">
          <span className="cmd-cat-cmd" style={{ color: profile.tabColor || undefined }}>{profile.name}</span>
          <span className="cmd-cat-desc">{profile.group || '默认'} · {profile.terminalType}</span>
          <div className="cmd-cat-actions">
            <button className="cmd-action-btn" title="编辑" onClick={() => { setEditingProfile(profile); setShowProfileDialog(true); }}>✎</button>
            <button className="cmd-action-btn danger" title="删除" onClick={async () => {
              if (!confirm(`确定删除配置「${profile.name}」？`)) return;
              await deleteProfile(profile.id);
              loadProfiles();
            }}>×</button>
          </div>
        </div>
      ))}
    </div>
  </div>
</section>
```

需要添加状态：`profileSearch`、`showProfileDialog`、`editingProfile`。
需要在设置页面组件中引入 `ConfigEditDialog`。

- [ ] **Step 2: 从 Toolbar 移除添加配置按钮**

修改 `Toolbar.tsx`，移除 `onNew` prop 和"添加配置"按钮。

修改 `App.tsx`，移除 `handleNew` 函数和传递给 Toolbar 的 `onNew` prop。

- [ ] **Step 3: 验证**

1. 设置页面中可以看到配置管理区域
2. 可以新建、编辑、删除配置
3. 工具栏中不再显示"添加配置"按钮

---

## Task 10: 移除新建按钮，功能移至标签导航右键菜单（需求 13）

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/Toolbar.tsx` — 移除新建按钮
- Modify: `terminal-buddy/src/components/TabSidebar.tsx` — 添加右键菜单
- Modify: `terminal-buddy/src/components/TabSidebar.css` — 右键菜单样式
- Modify: `terminal-buddy/src/App.tsx` — 移除相关 handler

- [ ] **Step 1: 在 TabSidebar 添加右键菜单**

在 `TabSidebar.tsx` 中添加右键菜单逻辑。当用户在标签导航区域（非标签项上）右键时，显示菜单：

```tsx
const [showContextMenu, setShowContextMenu] = useState(false);
const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });

// 在 tab-sidebar-content 的 onContextMenu 中
const handleContentContextMenu = (e: React.MouseEvent) => {
  // 只在空白区域触发
  if ((e.target as HTMLElement).closest('.tab-sidebar-item')) return;
  e.preventDefault();
  setShowContextMenu(true);
  setContextMenuPos({ x: e.clientX, y: e.clientY });
};
```

右键菜单项：
1. **添加终端** — 展开子菜单，按配置分组显示所有配置，点击启动对应终端
   - 子菜单顶部有 PowerShell、CMD 快捷选项
   - 然后按分组名称列出所有配置
2. **关闭所有标签** — 需要确认后关闭所有终端

```tsx
{showContextMenu && (
  <>
    <div className="context-menu-overlay" onClick={() => setShowContextMenu(false)} />
    <div className="context-menu" style={{ left: contextMenuPos.x, top: contextMenuPos.y }}>
      <div className="context-menu-item has-submenu">
        <span>添加终端</span>
        <span className="color-menu-arrow">▶</span>
        <div className="context-submenu">
          <div className="context-menu-item" onClick={() => { onStartBlankTerminal('powershell'); setShowContextMenu(false); }}>
            PowerShell
          </div>
          <div className="context-menu-item" onClick={() => { onStartBlankTerminal('cmd'); setShowContextMenu(false); }}>
            CMD
          </div>
          {groupedProfiles.map(group => (
            <div key={group.name}>
              <div className="context-menu-separator" />
              <div className="context-menu-item" style={{ fontWeight: 600, pointerEvents: 'none' }}>{group.name}</div>
              {group.profiles.map(profile => (
                <div key={profile.id} className="context-menu-item" onClick={() => { onStartTerminal(profile); setShowContextMenu(false); }}>
                  {profile.name}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="context-menu-separator" />
      <div className="context-menu-item danger" onClick={handleCloseAllTabs}>
        关闭所有标签
      </div>
    </div>
  </>
)}
```

需要给 `TabSidebar` 添加新的 props：`onStartTerminal`、`onStartBlankTerminal`。

- [ ] **Step 2: 添加关闭所有标签逻辑**

```tsx
const handleCloseAllTabs = async () => {
  if (sessions.length === 0) return;
  if (!confirm(`确定关闭所有 ${sessions.length} 个标签吗？`)) return;
  for (const session of sessions) {
    try { await closeTerminalCmd(session.id); } catch (err) { console.error(err); }
    if (session.groupId) {
      useAppStore.getState().removeSplitTerminal(session.groupId, session.id);
    }
  }
  // 清空所有 sessions
  useAppStore.getState().setSessions([]); // 需要添加此方法到 store
  setShowContextMenu(false);
};
```

- [ ] **Step 3: 更新 appStore 添加 setSessions 方法**

在 `appStore.ts` 的 `AppState` 接口和实现中添加：

```typescript
setSessions: (sessions: TerminalSession[]) => void;
// ...
setSessions: (sessions) => set({ sessions, activeSessionId: sessions[0]?.id ?? null }),
```

- [ ] **Step 4: 传递 props 给 TabSidebar**

在 `App.tsx` 中，给 `TabSidebar` 组件传递 `onStartTerminal` 和 `onStartBlankTerminal`：

```tsx
<TabSidebar
  profiles={profiles}
  onStartTerminal={handleStartTerminal}
  onStartBlankTerminal={handleStartBlankTerminal}
/>
```

- [ ] **Step 5: 从 Toolbar 移除新建按钮**

修改 `Toolbar.tsx`，移除 `onNewPowershell`、`onNewCmd`、`onStartTerminal` props 和"新建"下拉菜单。

修改 `App.tsx`，移除传递给 Toolbar 的这些 props。

Toolbar 最终只保留"设置"按钮。

- [ ] **Step 6: 添加右键菜单样式复用**

TabSidebar 的右键菜单可以复用 TerminalTab 的 `.context-menu` 等样式（已在全局 CSS 中定义）。如果需要额外样式，在 `TabSidebar.css` 中添加。

- [ ] **Step 7: 验证**

1. 工具栏中不再显示"新建"按钮
2. 在标签导航空白区域右键，显示"添加终端"和"关闭所有标签"
3. "添加终端"子菜单按分组显示配置
4. "关闭所有标签"需要确认

---

## Execution Order

建议按以下顺序执行，因为存在依赖关系：

1. **Task 1** (设置页面滚动 BUG) — 独立修复，影响后续设置页面开发
2. **Task 4** (历史命令备注) — 后端数据模型变更，后续任务依赖
3. **Task 6** (命令模板持久化) — 后端变更，独立
4. **Task 5** (命令补全改进) — 依赖 Task 4 的备注数据
5. **Task 2** (分组样式和关闭) — 前端独立
6. **Task 3** (删除关闭其他/左/右) — 前端独立
7. **Task 7** (退出确认) — 前端独立
8. **Task 8** (导入/导出移至设置) — 依赖 Task 1 的设置页面修复
9. **Task 9** (配置管理移至设置) — 依赖 Task 1
10. **Task 10** (新建按钮移至右键) — 依赖 Task 2 的 TabSidebar 改动
