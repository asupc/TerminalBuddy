# TerminalBuddy 体验完善功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TerminalBuddy 添加 7 个体验完善功能——环境变量 UI、多条启动命令、URL 可点击打开、配置搜索排序、终端内搜索、目录书签、自定义主题编辑器。

**Architecture:** 7 个功能相互独立，按优先级顺序实现。功能 1-3 和 7 为纯前端改动（后端已支持），功能 4-6 也是纯前端，功能 6（主题编辑器）需前后端同时改动。每个功能独立提交。

**Tech Stack:** React 18 + TypeScript, Zustand, xterm.js (+ SearchAddon, WebLinksAddon), Tauri 2.x (Rust)

---

## File Structure

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/components/ConfigEditDialog.tsx` | 添加环境变量编辑区、改造启动命令为多行列表 |
| 修改 | `src/components/ConfigEditDialog.css` | 环境变量折叠区、命令列表拖拽样式 |
| 修改 | `src/components/ConfigPanel.tsx` | 添加搜索框和排序下拉 |
| 修改 | `src/components/ConfigPanel.css` | 搜索栏和排序控件样式 |
| 修改 | `src/components/FileTree.tsx` | 添加书签栏 UI |
| 修改 | `src/components/FileTree.css` | 书签栏样式 |
| 修改 | `src/components/TerminalInstance.tsx` | 集成 SearchAddon、配置 WebLinksAddon Ctrl+click |
| 修改 | `src/components/TerminalInstance.css` | 搜索栏和 URL 悬停样式 |
| 修改 | `src/components/SettingsDialog.tsx` | 扩展为标签页，添加主题管理 |
| 修改 | `src/components/SettingsDialog.css` | 标签页和主题编辑器样式 |
| 修改 | `src/stores/appStore.ts` | 添加搜索/排序/书签/主题状态 |
| 修改 | `src/types/index.ts` | 扩展 ColorTheme 类型 |
| 修改 | `src/services/tauri.ts` | 添加 Theme CRUD invoke |
| 新建 | `src-tauri/src/models/theme.rs` | 主题数据模型 |
| 新建 | `src-tauri/src/services/theme_service.rs` | 主题持久化服务 |
| 新建 | `src-tauri/src/commands/theme.rs` | 主题 Tauri 命令 |
| 修改 | `src-tauri/src/lib.rs` | 注册主题命令 |

---

## Task 1: 环境变量 UI

**Skills:** _none_

**Files:**
- Modify: `src/components/ConfigEditDialog.tsx`
- Modify: `src/components/ConfigEditDialog.css`

- [ ] **Step 1: 在 ConfigEditDialog.tsx 中添加环境变量状态和类型定义**

在 `ConfigEditDialog` 组件内部，`FormData` 接口之后，添加环境变量状态。在组件函数体中，`usedCommands` state 之后添加：

```tsx
const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>(
  profile?.environmentVariables
    ? Object.entries(profile.environmentVariables).map(([key, value]) => ({ key, value }))
    : []
);
const [envExpanded, setEnvExpanded] = useState(false);
```

- [ ] **Step 2: 在 ConfigEditDialog.tsx 的 onSubmit 中合并环境变量到 profile 保存**

在 `onSubmit` 函数中，构造 profile 对象时添加 `environmentVariables` 字段。将两处 `updateProfile` 调用中添加：

```tsx
environmentVariables: envVars.reduce((acc, { key, value }) => {
  if (key.trim()) acc[key.trim()] = value;
  return acc;
}, {} as Record<string, string>),
```

对于编辑已有 profile 的调用（`if (profile)` 分支），替换为：

```tsx
await updateProfile({
  ...profile,
  name: data.name,
  group: data.group,
  terminalType: data.terminalType,
  startupPath: data.startupPath,
  colorTheme: data.colorTheme,
  tabColor: data.tabColor || null,
  startupCommands: commands,
  environmentVariables: envVars.reduce((acc, { key, value }) => {
    if (key.trim()) acc[key.trim()] = value;
    return acc;
  }, {} as Record<string, string>),
});
```

对于新建 profile 的调用（`else` 分支），替换为：

```tsx
const newProfile = await createProfile(data.name, data.group, data.terminalType);
await updateProfile({
  ...newProfile,
  startupPath: data.startupPath,
  colorTheme: data.colorTheme,
  tabColor: data.tabColor || null,
  startupCommands: commands,
  environmentVariables: envVars.reduce((acc, { key, value }) => {
    if (key.trim()) acc[key.trim()] = value;
    return acc;
  }, {} as Record<string, string>),
});
```

- [ ] **Step 3: 在 ConfigEditDialog.tsx 的表单中添加环境变量折叠区 JSX**

在"启动命令" `form-group`（`</div>` 结束标签后）和"起始路径" `form-group` 之间插入环境变量编辑区：

```tsx
<div className="form-group">
  <div
    className={`env-section-header ${envExpanded ? 'expanded' : ''}`}
    onClick={() => setEnvExpanded(!envExpanded)}
  >
    <span className="env-section-arrow">{envExpanded ? '▼' : '▶'}</span>
    <label style={{ marginBottom: 0, cursor: 'pointer' }}>环境变量</label>
    {envVars.length > 0 && <span className="env-count">{envVars.length} 项</span>}
  </div>
  {envExpanded && (
    <div className="env-section-body">
      {envVars.map((env, index) => (
        <div key={index} className="env-row">
          <input
            className="env-key"
            value={env.key}
            onChange={(e) => {
              const next = [...envVars];
              next[index] = { ...next[index], key: e.target.value };
              setEnvVars(next);
            }}
            placeholder="变量名"
          />
          <span className="env-eq">=</span>
          <input
            className="env-value"
            value={env.value}
            onChange={(e) => {
              const next = [...envVars];
              next[index] = { ...next[index], value: e.target.value };
              setEnvVars(next);
            }}
            placeholder="值"
          />
          <button
            type="button"
            className="env-remove-btn"
            onClick={() => setEnvVars(envVars.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="env-add-btn"
        onClick={() => setEnvVars([...envVars, { key: '', value: '' }])}
      >
        + 添加变量
      </button>
    </div>
  )}
</div>
```

- [ ] **Step 4: 在 ConfigEditDialog.css 中添加环境变量样式**

在文件末尾追加：

```css
/* Environment Variables Section */
.env-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  cursor: pointer;
  user-select: none;
}

.env-section-arrow {
  font-size: 10px;
  color: var(--text-secondary);
  transition: transform 0.15s;
}

.env-section-header.expanded .env-section-arrow {
  transform: rotate(0deg);
}

.env-count {
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: auto;
}

.env-section-body {
  padding: 4px 0;
}

.env-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.env-key {
  flex: 1;
  padding: 6px 10px !important;
  background: var(--bg-tertiary) !important;
  border: 1px solid var(--border) !important;
  border-radius: 4px !important;
  color: var(--text-primary) !important;
  font-size: 13px !important;
  font-family: monospace;
}

.env-value {
  flex: 1.5;
  padding: 6px 10px !important;
  background: var(--bg-tertiary) !important;
  border: 1px solid var(--border) !important;
  border-radius: 4px !important;
  color: var(--text-primary) !important;
  font-size: 13px !important;
}

.env-eq {
  color: var(--text-secondary);
  font-size: 14px;
}

.env-remove-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}

.env-remove-btn:hover {
  color: #f44747;
  background: rgba(244, 71, 71, 0.1);
}

.env-add-btn {
  width: 100%;
  padding: 6px;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 4px;
  color: var(--accent);
  cursor: pointer;
  font-size: 13px;
  transition: border-color 0.15s;
}

.env-add-btn:hover {
  border-color: var(--accent);
}
```

- [ ] **Step 5: 验证编译通过**

**Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 6: 提交**

**Skills:** _none_

```bash
cd terminal-buddy
git add src/components/ConfigEditDialog.tsx src/components/ConfigEditDialog.css
git commit -m "feat: add environment variables UI to profile editor"
```

---

## Task 2: 多条启动命令 UI

**Skills:** _none_

**Files:**
- Modify: `src/components/ConfigEditDialog.tsx`
- Modify: `src/components/ConfigEditDialog.css`

- [ ] **Step 1: 在 ConfigEditDialog.tsx 中将启动命令改为多行列表状态**

在组件函数体中，移除 `FormData` 接口中的 `startupCommand: string` 字段（保留其他字段）。在 `envExpanded` state 之后，添加启动命令列表状态：

```tsx
const [startupCommands, setStartupCommands] = useState<string[]>(
  profile?.startupCommands?.length ? profile?.startupCommands : ['']
);
const [dragIndex, setDragIndex] = useState<number | null>(null);
```

移除 `startupCommandValue`（`watch('startupCommand')`）和相关的 `handleCommandInputChange`、`handleKeyDown`、`selectSuggestion` 函数，因为每个命令行需要独立管理。

添加命令模板过滤函数（简化版，每行独立）：

```tsx
const [activeCmdIndex, setActiveCmdIndex] = useState<number | null>(null);
const [cmdSuggestions, setCmdSuggestions] = useState<{ name: string; command: string }[]>([]);
const [cmdSelectedIndex, setCmdSelectedIndex] = useState(-1);
const cmdSuggestionsRef = useRef<HTMLDivElement>(null);
```

移除原有的 `register('startupCommand')` 相关代码和 `suggestions`/`selectedIndex`/`showSuggestions` 状态。

- [ ] **Step 2: 添加命令列表操作函数**

在组件函数体中添加：

```tsx
const addCommand = () => {
  setStartupCommands([...startupCommands, '']);
  setActiveCmdIndex(startupCommands.length);
};

const removeCommand = (index: number) => {
  setStartupCommands(startupCommands.filter((_, i) => i !== index));
};

const updateCommand = (index: number, value: string) => {
  const next = [...startupCommands];
  next[index] = value;
  setStartupCommands(next);
};

const handleCmdInputChange = (index: number, value: string) => {
  updateCommand(index, value);
  if (value.trim() === '') {
    setCmdSuggestions([]);
    return;
  }
  const allCommands = COMMAND_TEMPLATES.flatMap(cat => cat.commands);
  const filtered = allCommands.filter(cmd =>
    cmd.command.toLowerCase().includes(value.toLowerCase())
  );
  setCmdSuggestions(filtered);
  setActiveCmdIndex(index);
  setCmdSelectedIndex(-1);
};

const selectCmdSuggestion = (cmd: { name: string; command: string }, index: number) => {
  updateCommand(index, cmd.command);
  setCmdSuggestions([]);
  setCmdSelectedIndex(-1);
};

const handleDragStart = (index: number) => {
  setDragIndex(index);
};

const handleDragOver = (e: React.DragEvent, index: number) => {
  e.preventDefault();
  if (dragIndex === null || dragIndex === index) return;
  const next = [...startupCommands];
  const [removed] = next.splice(dragIndex, 1);
  next.splice(index, 0, removed);
  setStartupCommands(next);
  setDragIndex(index);
};

const handleDragEnd = () => {
  setDragIndex(null);
};
```

- [ ] **Step 3: 修改 onSubmit 函数使用 startupCommands 列表**

替换 `onSubmit` 中的命令处理逻辑。将：

```tsx
const commands = data.startupCommand.trim() ? [data.startupCommand.trim()] : [];
```

替换为：

```tsx
const commands = startupCommands.filter(c => c.trim() !== '');
```

同时移除 `usedCommands` 相关的保存逻辑（因为多行模式下追踪历史较复杂，先简化处理）。

- [ ] **Step 4: 替换表单中的启动命令 JSX**

将现有的"启动命令" `form-group` 整块替换为：

```tsx
<div className="form-group">
  <label>启动命令</label>
  <div className="cmd-list">
    {startupCommands.map((cmd, index) => (
      <div
        key={index}
        className={`cmd-item ${dragIndex === index ? 'dragging' : ''}`}
        draggable
        onDragStart={() => handleDragStart(index)}
        onDragOver={(e) => handleDragOver(e, index)}
        onDragEnd={handleDragEnd}
      >
        <span className="cmd-drag-handle" title="拖拽排序">⠿</span>
        <span className="cmd-num">{index + 1}.</span>
        <div className="cmd-input-wrapper">
          <input
            value={cmd}
            onChange={(e) => handleCmdInputChange(index, e.target.value)}
            onFocus={() => setActiveCmdIndex(index)}
            onBlur={() => setTimeout(() => setCmdSuggestions([]), 200)}
            placeholder="输入命令..."
            style={{ fontFamily: 'monospace' }}
          />
          {activeCmdIndex === index && cmdSuggestions.length > 0 && (
            <div className="command-suggestions" ref={cmdSuggestionsRef}>
              {cmdSuggestions.map((s, si) => (
                <div
                  key={s.command}
                  className={`suggestion-item ${si === cmdSelectedIndex ? 'selected' : ''}`}
                  onMouseDown={() => selectCmdSuggestion(s, index)}
                >
                  <span className="suggestion-name">{s.name}</span>
                  <span className="suggestion-command">{s.command}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {startupCommands.length > 1 && (
          <button
            type="button"
            className="cmd-remove-btn"
            onClick={() => removeCommand(index)}
          >
            ×
          </button>
        )}
      </div>
    ))}
    <button type="button" className="cmd-add-btn" onClick={addCommand}>
      + 添加命令
    </button>
  </div>
</div>
```

- [ ] **Step 5: 在 ConfigEditDialog.css 中添加命令列表样式**

在文件末尾追加：

```css
/* Multi-command list */
.cmd-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cmd-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  transition: border-color 0.15s;
}

.cmd-item.dragging {
  opacity: 0.5;
  border-color: var(--accent);
}

.cmd-drag-handle {
  cursor: grab;
  color: var(--text-secondary);
  font-size: 14px;
  user-select: none;
  padding: 2px;
}

.cmd-drag-handle:active {
  cursor: grabbing;
}

.cmd-num {
  font-size: 12px;
  color: var(--accent);
  min-width: 18px;
}

.cmd-item .cmd-input-wrapper {
  flex: 1;
  position: relative;
}

.cmd-item .cmd-input-wrapper input {
  width: 100%;
  padding: 6px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 13px;
}

.cmd-item .cmd-input-wrapper input:focus {
  outline: none;
  border-color: var(--accent);
}

.cmd-remove-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}

.cmd-remove-btn:hover {
  color: #f44747;
  background: rgba(244, 71, 71, 0.1);
}

.cmd-add-btn {
  width: 100%;
  padding: 6px;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 4px;
  color: var(--accent);
  cursor: pointer;
  font-size: 13px;
  transition: border-color 0.15s;
}

.cmd-add-btn:hover {
  border-color: var(--accent);
}
```

- [ ] **Step 6: 清理不再使用的代码**

从 `ConfigEditDialog.tsx` 中移除：
- `STORAGE_KEY` 常量、`loadUsedCommands`、`saveUsedCommands` 函数
- `usedCommands` state
- 旧的 `suggestions`、`selectedIndex`、`showSuggestions` state
- 旧的 `inputRef`（改为命令列表中的内联引用）
- 旧的 `suggestionsRef`

- [ ] **Step 7: 验证编译通过**

**Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 8: 提交**

**Skills:** _none_

```bash
cd terminal-buddy
git add src/components/ConfigEditDialog.tsx src/components/ConfigEditDialog.css
git commit -m "feat: convert startup command to multi-line list with drag reorder"
```

---

## Task 3: URL 可点击打开（Ctrl+Click）

**Skills:** _none_

**Files:**
- Modify: `src/components/TerminalInstance.tsx`
- Modify: `src/components/TerminalInstance.css`

- [ ] **Step 1: 在 TerminalInstance.tsx 中配置 WebLinksAddon 的 Ctrl+Click 行为**

替换 `TerminalInstance.tsx` 中创建 `WebLinksAddon` 的行：

```tsx
terminal.loadAddon(new WebLinksAddon());
```

替换为：

```tsx
terminal.loadAddon(new WebLinksAddon({
  handler: (uri: string, event: MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      openPath(uri).catch((err) => console.error('Failed to open URL:', err));
    }
  },
}));
```

在文件顶部添加 `openPath` 的 import（检查是否已存在，如不存在则添加）：

```tsx
import { resizeTerminal, openPath } from '../services/tauri';
```

- [ ] **Step 2: 添加 Ctrl 键悬停光标样式**

在 `TerminalInstance.tsx` 的 useEffect 中，在 `xtermEl.addEventListener('contextmenu', handleContextMenu)` 之后添加 Ctrl 键悬停处理：

```tsx
// Ctrl+hover: show pointer cursor on links
let isCtrlDown = false;
const handleKeyDownGlobal = (e: KeyboardEvent) => {
  if (e.key === 'Control') {
    isCtrlDown = true;
    xtermEl.classList.add('ctrl-hover');
  }
};
const handleKeyUpGlobal = (e: KeyboardEvent) => {
  if (e.key === 'Control') {
    isCtrlDown = false;
    xtermEl.classList.remove('ctrl-hover');
  }
};
document.addEventListener('keydown', handleKeyDownGlobal);
document.addEventListener('keyup', handleKeyUpGlobal);
```

在 cleanup 函数中添加：

```tsx
document.removeEventListener('keydown', handleKeyDownGlobal);
document.removeEventListener('keyup', handleKeyUpGlobal);
```

- [ ] **Step 3: 在 TerminalInstance.css 中添加 Ctrl 悬停样式**

在文件末尾追加：

```css
/* URL Ctrl+click cursor */
.terminal-instance.ctrl-hover .xterm-viewport {
  cursor: default;
}

.terminal-instance.ctrl-hover .xterm-hyperlink {
  cursor: pointer !important;
  text-decoration: underline;
}
```

- [ ] **Step 4: 验证编译通过**

**Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 5: 提交**

**Skills:** _none_

```bash
cd terminal-buddy
git add src/components/TerminalInstance.tsx src/components/TerminalInstance.css
git commit -m "feat: open URLs in browser with Ctrl+click in terminal"
```

---

## Task 4: 配置文件搜索/排序

**Skills:** _none_

**Files:**
- Modify: `src/components/ConfigPanel.tsx`
- Modify: `src/components/ConfigPanel.css`
- Modify: `src/stores/appStore.ts`

- [ ] **Step 1: 在 appStore.ts 中添加搜索和排序状态**

在 `AppState` 接口的 `// UI State` 部分添加：

```tsx
// Config panel search & sort
configSearchQuery: string;
configSortBy: 'name-asc' | 'name-desc' | 'recent' | 'oldest' | 'created-new' | 'created-old';
setConfigSearchQuery: (query: string) => void;
setConfigSortBy: (sortBy: AppState['configSortBy']) => void;
```

在 `create<AppState>` 实现中添加：

```tsx
configSearchQuery: '',
configSortBy: 'name-asc',
setConfigSearchQuery: (query) => set({ configSearchQuery: query }),
setConfigSortBy: (sortBy) => set({ configSortBy: sortBy }),
```

- [ ] **Step 2: 在 ConfigPanel.tsx 中添加搜索和排序逻辑**

在 `ConfigPanel` 组件中，从 `useAppStore` 解构新增字段：

```tsx
const { profiles, selectedProfileId, selectProfile, removeProfile, setProfiles, configPanelVisible, configSearchQuery, configSortBy, setConfigSearchQuery, setConfigSortBy } = useAppStore();
```

添加排序下拉状态：

```tsx
const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
```

修改 `groupedProfiles` 的 `useMemo`，加入搜索过滤和排序：

```tsx
const groupedProfiles = useMemo(() => {
  const groups: Record<string, Profile[]> = {};
  let filtered = profiles;

  // Search filter
  if (configSearchQuery.trim()) {
    const query = configSearchQuery.toLowerCase();
    filtered = profiles.filter(p => p.name.toLowerCase().includes(query));
  }

  filtered.forEach((p) => {
    const group = p.group || '默认';
    if (!groups[group]) groups[group] = [];
    groups[group].push(p);
  });

  // Sort within each group
  Object.values(groups).forEach(groupProfiles => {
    groupProfiles.sort((a, b) => {
      switch (configSortBy) {
        case 'name-asc': return a.name.localeCompare(b.name, 'zh');
        case 'name-desc': return b.name.localeCompare(a.name, 'zh');
        case 'recent': return (b.lastUsedAt || '').localeCompare(a.lastUsedAt || '');
        case 'oldest': return (a.lastUsedAt || '').localeCompare(b.lastUsedAt || '');
        case 'created-new': return b.createdAt.localeCompare(a.createdAt);
        case 'created-old': return a.createdAt.localeCompare(b.createdAt);
        default: return 0;
      }
    });
  });

  return groups;
}, [profiles, configSearchQuery, configSortBy]);
```

- [ ] **Step 3: 在 ConfigPanel.tsx 的 JSX 中添加搜索栏**

在 `<div className="config-list">` 之前插入搜索栏：

```tsx
<div className="config-search-bar">
  <input
    type="text"
    className="config-search-input"
    placeholder="搜索配置..."
    value={configSearchQuery}
    onChange={(e) => setConfigSearchQuery(e.target.value)}
  />
  <div className="config-sort-wrapper">
    <button
      className="config-sort-btn"
      onClick={() => setSortDropdownOpen(!sortDropdownOpen)}
      title="排序"
    >
      ⇅
    </button>
    {sortDropdownOpen && (
      <div className="config-sort-dropdown">
        {([
          ['name-asc', '名称 A-Z'],
          ['name-desc', '名称 Z-A'],
          ['recent', '最近使用'],
          ['oldest', '最久未用'],
          ['created-new', '创建 新→旧'],
          ['created-old', '创建 旧→新'],
        ] as const).map(([key, label]) => (
          <div
            key={key}
            className={`config-sort-option ${configSortBy === key ? 'active' : ''}`}
            onClick={() => {
              setConfigSortBy(key);
              setSortDropdownOpen(false);
            }}
          >
            {label}
          </div>
        ))}
      </div>
    )}
  </div>
</div>
```

- [ ] **Step 4: 在 ConfigPanel.css 中添加搜索和排序样式**

在文件末尾追加：

```css
/* Config search & sort */
.config-search-bar {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.config-search-input {
  flex: 1;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.config-search-input:focus {
  border-color: var(--accent);
}

.config-sort-wrapper {
  position: relative;
}

.config-sort-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  transition: border-color 0.15s;
}

.config-sort-btn:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}

.config-sort-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px;
  min-width: 160px;
  z-index: 10;
  margin-top: 4px;
}

.config-sort-option {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  border-radius: 2px;
}

.config-sort-option:hover {
  background: var(--bg-tertiary);
}

.config-sort-option.active {
  color: var(--accent);
}
```

- [ ] **Step 5: 验证编译通过**

**Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 6: 提交**

**Skills:** _none_

```bash
cd terminal-buddy
git add src/components/ConfigPanel.tsx src/components/ConfigPanel.css src/stores/appStore.ts
git commit -m "feat: add search and sort to config panel"
```

---

## Task 5: 终端内搜索

**Skills:** _none_

**Files:**
- Modify: `src/components/TerminalInstance.tsx`
- Modify: `src/components/TerminalInstance.css`

- [ ] **Step 1: 安装 xterm-addon-search 依赖**

**Skills:** _none_

Run: `cd terminal-buddy && npm install @xterm/addon-search`

- [ ] **Step 2: 在 TerminalInstance.tsx 中集成 SearchAddon**

在文件顶部 import 区添加：

```tsx
import { SearchAddon } from '@xterm/addon-search';
```

在组件函数体中添加搜索状态：

```tsx
const [searchVisible, setSearchVisible] = useState(false);
const [searchText, setSearchText] = useState('');
const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
const searchAddonRef = useRef<SearchAddon | null>(null);
```

在 useEffect 中，创建 terminal 后、`terminal.open()` 之前添加：

```tsx
const searchAddon = new SearchAddon();
terminal.loadAddon(searchAddon);
searchAddonRef.current = searchAddon;
```

- [ ] **Step 3: 在 TerminalInstance.tsx 中添加 Ctrl+F 快捷键和搜索操作**

在 useEffect 的 `handleKeyDown` 捕获阶段监听器中，在 `Ctrl+V` 处理之后添加：

```tsx
// Ctrl+F: open terminal search
if (e.key === 'f' && e.ctrlKey && !e.shiftKey) {
  e.preventDefault();
  e.stopPropagation();
  setSearchVisible(true);
  return;
}
```

在组件函数体中添加搜索操作函数：

```tsx
const handleSearch = useCallback((direction: 'next' | 'prev' = 'next') => {
  const searchAddon = searchAddonRef.current;
  if (!searchAddon || !searchText) return;
  if (direction === 'next') {
    searchAddon.findNext(searchText, { caseSensitive: searchCaseSensitive, regex: false });
  } else {
    searchAddon.findPrevious(searchText, { caseSensitive: searchCaseSensitive, regex: false });
  }
}, [searchText, searchCaseSensitive]);

const handleCloseSearch = useCallback(() => {
  setSearchVisible(false);
  setSearchText('');
  searchAddonRef.current?.clearDecorations();
}, []);
```

- [ ] **Step 4: 在 TerminalInstance.tsx 的 JSX 中添加搜索栏**

在 `<div ref={terminalRef} className="terminal-instance">` 的开头，`{contextMenu.visible && ...}` 之前插入：

```tsx
{searchVisible && (
  <div className="terminal-search-bar">
    <input
      className="terminal-search-input"
      value={searchText}
      onChange={(e) => {
        setSearchText(e.target.value);
        if (e.target.value) {
          searchAddonRef.current?.findNext(e.target.value, {
            caseSensitive: searchCaseSensitive,
            regex: false,
          });
        } else {
          searchAddonRef.current?.clearDecorations();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          handleSearch(e.shiftKey ? 'prev' : 'next');
        } else if (e.key === 'Escape') {
          handleCloseSearch();
        }
      }}
      placeholder="搜索终端输出..."
      autoFocus
    />
    <button
      className={`terminal-search-case ${searchCaseSensitive ? 'active' : ''}`}
      onClick={() => setSearchCaseSensitive(!searchCaseSensitive)}
      title="区分大小写"
    >
      Aa
    </button>
    <button className="terminal-search-nav" onClick={() => handleSearch('prev')} title="上一个">▲</button>
    <button className="terminal-search-nav" onClick={() => handleSearch('next')} title="下一个">▼</button>
    <button className="terminal-search-close" onClick={handleCloseSearch} title="关闭 (Esc)">×</button>
  </div>
)}
```

- [ ] **Step 5: 在 TerminalInstance.css 中添加搜索栏样式**

在文件末尾追加：

```css
/* Terminal search bar */
.terminal-search-bar {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  background: var(--bg-secondary, #2d2d2d);
  border-bottom: 1px solid var(--border, #555);
  align-items: center;
}

.terminal-search-input {
  flex: 1;
  padding: 4px 8px;
  background: var(--bg-primary, #1e1e1e);
  border: 1px solid var(--border, #555);
  border-radius: 3px;
  color: var(--text-primary, #ccc);
  font-size: 13px;
  outline: none;
}

.terminal-search-input:focus {
  border-color: var(--accent, #0078d4);
}

.terminal-search-case {
  padding: 2px 6px;
  background: transparent;
  border: 1px solid var(--border, #555);
  border-radius: 3px;
  color: var(--text-secondary, #888);
  cursor: pointer;
  font-size: 12px;
}

.terminal-search-case.active {
  background: var(--bg-tertiary, #3d3d3d);
  color: var(--accent, #0078d4);
  border-color: var(--accent, #0078d4);
}

.terminal-search-nav {
  padding: 2px 6px;
  background: transparent;
  border: 1px solid var(--border, #555);
  border-radius: 3px;
  color: var(--text-secondary, #888);
  cursor: pointer;
  font-size: 11px;
}

.terminal-search-nav:hover {
  color: var(--text-primary, #ccc);
}

.terminal-search-close {
  background: none;
  border: none;
  color: var(--text-secondary, #888);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 4px;
}

.terminal-search-close:hover {
  color: var(--text-primary, #ccc);
}
```

- [ ] **Step 6: 验证编译通过**

**Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 7: 提交**

**Skills:** _none_

```bash
cd terminal-buddy
git add src/components/TerminalInstance.tsx src/components/TerminalInstance.css package.json package-lock.json
git commit -m "feat: add terminal search with Ctrl+F using SearchAddon"
```

---

## Task 6: 目录书签

**Skills:** _none_

**Files:**
- Modify: `src/components/FileTree.tsx`
- Modify: `src/components/FileTree.css`
- Modify: `src/stores/appStore.ts`

- [ ] **Step 1: 在 appStore.ts 中添加书签状态**

在 `AppState` 接口中添加：

```tsx
// Directory bookmarks
bookmarks: { name: string; path: string }[];
addBookmark: (name: string, path: string) => void;
removeBookmark: (path: string) => void;
renameBookmark: (path: string, newName: string) => void;
```

在 `create<AppState>` 实现中添加。书签从 localStorage 加载：

```tsx
bookmarks: (() => {
  try {
    const stored = localStorage.getItem('terminalbuddy_bookmarks');
    if (stored) return JSON.parse(stored);
  } catch {}
  return [
    { name: '主目录', path: 'C:\\Users\\' + (process.env.USERNAME || 'Admin') },
    { name: '桌面', path: 'C:\\Users\\' + (process.env.USERNAME || 'Admin') + '\\Desktop' },
    { name: '文档', path: 'C:\\Users\\' + (process.env.USERNAME || 'Admin') + '\\Documents' },
  ];
})(),
addBookmark: (name, path) => set((state) => {
  const next = [...state.bookmarks, { name, path }];
  localStorage.setItem('terminalbuddy_bookmarks', JSON.stringify(next));
  return { bookmarks: next };
}),
removeBookmark: (path) => set((state) => {
  const next = state.bookmarks.filter(b => b.path !== path);
  localStorage.setItem('terminalbuddy_bookmarks', JSON.stringify(next));
  return { bookmarks: next };
}),
renameBookmark: (path, newName) => set((state) => {
  const next = state.bookmarks.map(b => b.path === path ? { ...b, name: newName } : b);
  localStorage.setItem('terminalbuddy_bookmarks', JSON.stringify(next));
  return { bookmarks: next };
}),
```

- [ ] **Step 2: 在 FileTree.tsx 中添加书签栏 UI**

在 `FileTree` 组件中，从 store 解构 `bookmarks`、`addBookmark`、`removeBookmark`：

```tsx
const { currentDirectory, setCurrentDirectory, fileTreeVisible, bookmarks, addBookmark, removeBookmark } = useAppStore();
```

添加书签栏折叠状态：

```tsx
const [bookmarksExpanded, setBookmarksExpanded] = useState(true);
```

在 JSX 中，在 `<div className="file-tree-header">` 之前插入书签栏：

```tsx
{bookmarks.length > 0 && (
  <div className="bookmark-bar">
    <button
      className="bookmark-toggle"
      onClick={() => setBookmarksExpanded(!bookmarksExpanded)}
      title={bookmarksExpanded ? '收起书签' : '展开书签'}
    >
      {bookmarksExpanded ? '▼' : '▶'}
    </button>
    {bookmarksExpanded && bookmarks.map((bm) => (
      <div
        key={bm.path}
        className="bookmark-tag"
        onClick={() => setCurrentDirectory(bm.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (confirm(`删除书签"${bm.name}"？`)) {
            removeBookmark(bm.path);
          }
        }}
        title={bm.path}
      >
        <span className="bookmark-icon">📁</span>
        <span className="bookmark-name">{bm.name}</span>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 3: 在 FileTree.tsx 右键菜单中添加"添加到书签"选项**

在 `ctxMenu` 右键菜单 JSX 中，在 `{ctxMenu.isDir && (` 的 `cd 到当前目录` 选项之后添加：

```tsx
{ctxMenu.isDir && (
  <div className="context-menu-item" onClick={() => {
    const name = ctxMenu.path.split('\\').pop() || ctxMenu.path;
    addBookmark(name, ctxMenu.path);
    setCtxMenu(null);
  }}>
    添加到书签
  </div>
)}
```

- [ ] **Step 4: 在 FileTree.css 中添加书签栏样式**

在文件末尾追加：

```css
/* Bookmark bar */
.bookmark-bar {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  align-items: center;
  flex-wrap: nowrap;
}

.bookmark-bar::-webkit-scrollbar {
  height: 4px;
}

.bookmark-bar::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 2px;
}

.bookmark-toggle {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 10px;
  padding: 2px 4px;
  flex-shrink: 0;
}

.bookmark-toggle:hover {
  color: var(--text-primary);
}

.bookmark-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--bg-tertiary);
  border-radius: 10px;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  border: 1px solid transparent;
  transition: border-color 0.15s, background 0.15s;
}

.bookmark-tag:hover {
  border-color: var(--accent);
  background: rgba(0, 120, 212, 0.1);
}

.bookmark-icon {
  font-size: 10px;
}

.bookmark-name {
  color: var(--text-primary);
}
```

- [ ] **Step 5: 验证编译通过**

**Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 6: 提交**

**Skills:** _none_

```bash
cd terminal-buddy
git add src/components/FileTree.tsx src/components/FileTree.css src/stores/appStore.ts
git commit -m "feat: add directory bookmarks to file tree sidebar"
```

---

## Task 7: 自定义主题编辑器

**Skills:** _none_

此任务分为两部分：先完成 Rust 后端（模型、服务、命令），再完成前端（类型、服务、UI）。

### Part A: Rust 后端

**Files:**
- Create: `src-tauri/src/models/theme.rs`
- Create: `src-tauri/src/services/theme_service.rs`
- Create: `src-tauri/src/commands/theme.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 创建主题数据模型 `src-tauri/src/models/theme.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
}

impl CustomTheme {
    pub fn new(name: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            background: String::from("#1e1e1e"),
            foreground: String::from("#cccccc"),
            cursor: String::from("#ffffff"),
            black: String::from("#000000"),
            red: String::from("#cd3131"),
            green: String::from("#0dbc79"),
            yellow: String::from("#e5e510"),
            blue: String::from("#2472c8"),
            magenta: String::from("#bc3fbc"),
            cyan: String::from("#11a8cd"),
            white: String::from("#e5e5e5"),
        }
    }
}
```

- [ ] **Step 2: 在 `src-tauri/src/models/mod.rs` 中注册 theme 模块**

在 `mod.rs` 中添加：

```rust
pub mod theme;
```

- [ ] **Step 3: 创建主题服务 `src-tauri/src/services/theme_service.rs`**

```rust
use crate::models::CustomTheme;
use std::fs;
use std::path::PathBuf;

pub struct ThemeService;

impl ThemeService {
    fn get_themes_dir() -> PathBuf {
        let base = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("TerminalBuddy")
            .join("Themes");
        fs::create_dir_all(&base).ok();
        base
    }

    pub fn get_all_themes() -> Result<Vec<CustomTheme>, String> {
        let dir = Self::get_themes_dir();
        let mut themes = Vec::new();

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map_or(false, |e| e == "json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(theme) = serde_json::from_str::<CustomTheme>(&content) {
                            themes.push(theme);
                        }
                    }
                }
            }
        }

        Ok(themes)
    }

    pub fn create_theme(name: &str) -> Result<CustomTheme, String> {
        let theme = CustomTheme::new(name);
        let path = Self::get_themes_dir().join(format!("{}.json", theme.id));
        let content = serde_json::to_string_pretty(&theme)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        Ok(theme)
    }

    pub fn update_theme(theme: &CustomTheme) -> Result<(), String> {
        let path = Self::get_themes_dir().join(format!("{}.json", theme.id));
        let content = serde_json::to_string_pretty(theme)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))
    }

    pub fn delete_theme(id: &str) -> Result<(), String> {
        let path = Self::get_themes_dir().join(format!("{}.json", id));
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete theme: {}", e))
    }
}
```

- [ ] **Step 4: 在 `src-tauri/src/services/mod.rs` 中注册 theme_service 模块**

在 `mod.rs` 中添加：

```rust
pub mod theme_service;
```

- [ ] **Step 5: 创建主题命令 `src-tauri/src/commands/theme.rs`**

```rust
use crate::models::CustomTheme;
use crate::services::ThemeService;
use tauri::command;

#[command]
pub fn get_all_themes() -> Result<Vec<CustomTheme>, String> {
    ThemeService::get_all_themes()
}

#[command]
pub fn create_theme(name: String) -> Result<CustomTheme, String> {
    ThemeService::create_theme(&name)
}

#[command]
pub fn update_theme(theme: CustomTheme) -> Result<(), String> {
    ThemeService::update_theme(&theme)
}

#[command]
pub fn delete_theme(id: String) -> Result<(), String> {
    ThemeService::delete_theme(&id)
}
```

- [ ] **Step 6: 在 `src-tauri/src/commands/mod.rs` 中注册 theme 命令模块**

在 `mod.rs` 中添加：

```rust
pub mod theme;
```

- [ ] **Step 7: 在 `src-tauri/src/lib.rs` 中注册主题命令到 Tauri**

在 `use commands::` 行中添加主题命令导入：

```rust
use commands::{..., get_all_themes, create_theme, update_theme, delete_theme};
```

在 `invoke_handler` 宏中添加：

```rust
get_all_themes,
create_theme,
update_theme,
delete_theme,
```

- [ ] **Step 8: 验证 Rust 编译**

**Skills:** _none_

Run: `cd terminal-buddy/src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 9: 提交后端**

**Skills:** _none_

```bash
cd terminal-buddy
git add src-tauri/src/models/theme.rs src-tauri/src/services/theme_service.rs src-tauri/src/commands/theme.rs src-tauri/src/lib.rs
git commit -m "feat: add custom theme backend (model, service, commands)"
```

### Part B: 前端

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/tauri.ts`
- Modify: `src/stores/appStore.ts`
- Modify: `src/components/SettingsDialog.tsx`
- Modify: `src/components/SettingsDialog.css`

- [ ] **Step 10: 在 types/index.ts 中扩展 ColorTheme 类型**

将现有的 `ColorTheme` 接口替换为：

```tsx
export interface ColorTheme {
  id: string;
  name: string;
  background: string;
  foreground: string;
}

export interface CustomTheme extends ColorTheme {
  cursor: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
}
```

注意 `PRESET_THEMES` 类型仍为 `ColorTheme[]`，不需要改动。

- [ ] **Step 11: 在 services/tauri.ts 中添加 Theme CRUD invoke**

在文件末尾追加：

```tsx
// Theme Commands
export async function getAllThemes(): Promise<CustomTheme[]> {
  return invoke('get_all_themes');
}

export async function createTheme(name: string): Promise<CustomTheme> {
  return invoke('create_theme', { name });
}

export async function updateTheme(theme: CustomTheme): Promise<void> {
  return invoke('update_theme', { theme });
}

export async function deleteTheme(id: string): Promise<void> {
  return invoke('delete_theme', { id });
}
```

在文件顶部的 import 中添加 `CustomTheme`：

```tsx
import type { Profile, CustomTheme } from '../types';
```

- [ ] **Step 12: 在 appStore.ts 中添加自定义主题状态**

在 `AppState` 接口中添加：

```tsx
// Custom themes
customThemes: CustomTheme[];
setCustomThemes: (themes: CustomTheme[]) => void;
addCustomTheme: (theme: CustomTheme) => void;
updateCustomTheme: (theme: CustomTheme) => void;
removeCustomTheme: (id: string) => void;
```

在 `create<AppState>` 实现中添加：

```tsx
customThemes: [],
setCustomThemes: (themes) => set({ customThemes: themes }),
addCustomTheme: (theme) =>
  set((state) => ({ customThemes: [...state.customThemes, theme] })),
updateCustomTheme: (theme) =>
  set((state) => ({
    customThemes: state.customThemes.map((t) => (t.id === theme.id ? theme : t)),
  })),
removeCustomTheme: (id) =>
  set((state) => ({
    customThemes: state.customThemes.filter((t) => t.id !== id),
  })),
```

- [ ] **Step 13: 改造 SettingsDialog.tsx 为标签页布局 + 主题管理**

将 `SettingsDialog` 组件改造为双标签页：外观 + 主题管理。

完整替换 `SettingsDialog.tsx` 内容：

```tsx
import { FC, useState, useEffect, useRef, useCallback } from 'react';
import { getAllThemes, createTheme, updateTheme, deleteTheme } from '../services/tauri';
import { useAppStore } from '../stores/appStore';
import { PRESET_THEMES, type CustomTheme } from '../types';
import './SettingsDialog.css';

export type ThemeMode = 'dark' | 'light' | 'system';

interface SettingsDialogProps {
  onClose: () => void;
}

const THEME_STORAGE_KEY = 'terminalbuddy_theme';

export const getStoredTheme = (): ThemeMode => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return (stored as ThemeMode) || 'dark';
  } catch {
    return 'dark';
  }
};

export const applyTheme = (theme: ThemeMode) => {
  const root = document.documentElement;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }
};

type TabId = 'appearance' | 'themes';

export const SettingsDialog: FC<SettingsDialogProps> = ({ onClose }) => {
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const [activeTab, setActiveTab] = useState<TabId>('appearance');
  const [dialogOffset, setDialogOffset] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  // Theme editor state
  const { customThemes, setCustomThemes, addCustomTheme, updateCustomTheme, removeCustomTheme } = useAppStore();
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [editingTheme, setEditingTheme] = useState<CustomTheme | null>(null);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme('system');
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
  }, [theme]);

  // Load custom themes
  useEffect(() => {
    getAllThemes().then(setCustomThemes).catch(console.error);
  }, []);

  const handleDialogMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.dialog-content')) return;
    isDragging.current = true;
    dragStartPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleDialogMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const dx = e.clientX - dragStartPos.current.x;
      const dy = e.clientY - dragStartPos.current.y;
      setDialogOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      dragStartPos.current = { x: e.clientX, y: e.clientY };
    });
  }, []);

  const handleDialogMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handleCreateTheme = async () => {
    try {
      const newTheme = await createTheme('新主题');
      addCustomTheme(newTheme);
      setEditingTheme(newTheme);
      setSelectedThemeId(newTheme.id);
    } catch (err) {
      console.error('Failed to create theme:', err);
    }
  };

  const handleSaveTheme = async () => {
    if (!editingTheme) return;
    try {
      await updateTheme(editingTheme);
      updateCustomTheme(editingTheme);
      setEditingTheme(null);
    } catch (err) {
      console.error('Failed to save theme:', err);
    }
  };

  const handleDeleteTheme = async (id: string) => {
    if (!confirm('确定要删除此主题吗？正在使用此主题的配置将回退到默认主题。')) return;
    try {
      await deleteTheme(id);
      removeCustomTheme(id);
      if (selectedThemeId === id) setSelectedThemeId(null);
      if (editingTheme?.id === id) setEditingTheme(null);
    } catch (err) {
      console.error('Failed to delete theme:', err);
    }
  };

  const handleColorChange = (field: keyof CustomTheme, value: string) => {
    if (!editingTheme) return;
    setEditingTheme({ ...editingTheme, [field]: value });
  };

  const allThemes = [...PRESET_THEMES, ...customThemes];

  return (
    <div className="dialog-overlay">
      <div
        className="dialog settings-dialog"
        style={{ transform: `translate(${dialogOffset.x}px, ${dialogOffset.y}px)` }}
        onMouseDown={handleDialogMouseDown}
        onMouseMove={handleDialogMouseMove}
        onMouseUp={handleDialogMouseUp}
      >
        <div className="dialog-header dialog-drag-handle">
          <h3>设置</h3>
          <button className="dialog-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${activeTab === 'appearance' ? 'active' : ''}`}
            onClick={() => setActiveTab('appearance')}
          >
            外观
          </button>
          <button
            className={`settings-tab ${activeTab === 'themes' ? 'active' : ''}`}
            onClick={() => setActiveTab('themes')}
          >
            主题管理
          </button>
        </div>

        <div className="dialog-content">
          {activeTab === 'appearance' && (
            <div className="form-group">
              <label>主题</label>
              <div className="theme-options">
                {(['dark', 'light', 'system'] as ThemeMode[]).map((mode) => (
                  <label key={mode} className={`theme-option ${theme === mode ? 'active' : ''}`}>
                    <input
                      type="radio"
                      name="theme"
                      value={mode}
                      checked={theme === mode}
                      onChange={() => setTheme(mode)}
                    />
                    <span className="theme-label">
                      {mode === 'dark' ? '🌙 暗黑' : mode === 'light' ? '☀️ 浅色' : '💻 跟随系统'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'themes' && (
            <div className="theme-manager">
              <div className="theme-list">
                {allThemes.map((t) => {
                  const isCustom = 'cursor' in t;
                  const isEditing = editingTheme?.id === t.id;
                  return (
                    <div
                      key={t.id}
                      className={`theme-card ${selectedThemeId === t.id ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedThemeId(t.id);
                        if (isCustom && !editingTheme) setEditingTheme(t as CustomTheme);
                      }}
                    >
                      <div className="theme-swatch" style={{ background: t.background }} />
                      <span className="theme-card-name">{t.name}</span>
                      {isCustom ? (
                        <span className="theme-badge custom">自定义</span>
                      ) : (
                        <span className="theme-badge preset">预设</span>
                      )}
                      {isCustom && !isEditing && (
                        <button
                          className="theme-card-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteTheme(t.id);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
                <button className="theme-create-btn" onClick={handleCreateTheme}>
                  + 新建主题
                </button>
              </div>

              {editingTheme && (
                <div className="theme-editor">
                  <div className="theme-editor-header">
                    <input
                      className="theme-editor-name"
                      value={editingTheme.name}
                      onChange={(e) => handleColorChange('name', e.target.value)}
                    />
                    <div className="theme-editor-actions">
                      <button className="btn-primary" onClick={handleSaveTheme}>保存</button>
                      <button className="btn-secondary" onClick={() => setEditingTheme(null)}>取消</button>
                    </div>
                  </div>
                  <div className="color-slots">
                    {([
                      ['background', '背景'],
                      ['foreground', '前景'],
                      ['cursor', '光标'],
                      ['black', '黑色'],
                      ['red', '红色'],
                      ['green', '绿色'],
                      ['yellow', '黄色'],
                      ['blue', '蓝色'],
                      ['magenta', '品红'],
                      ['cyan', '青色'],
                      ['white', '白色'],
                    ] as [keyof CustomTheme, string][]).map(([field, label]) => (
                      <div key={field} className="color-slot">
                        <label>{label}</label>
                        <div className="color-input-wrap">
                          <input
                            type="color"
                            value={editingTheme[field] as string}
                            onChange={(e) => handleColorChange(field, e.target.value)}
                          />
                          <input
                            type="text"
                            value={editingTheme[field] as string}
                            onChange={(e) => handleColorChange(field, e.target.value)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="theme-preview" style={{ background: editingTheme.background, color: editingTheme.foreground }}>
                    <div>PS C:\Projects&gt; <span style={{ color: editingTheme.green }}>npm run dev</span></div>
                    <div style={{ color: editingTheme.cyan }}>  VITE v5.2.0  ready in 312 ms</div>
                    <div style={{ color: editingTheme.foreground }}>  ➜  Local:   http://localhost:1420/</div>
                    <div>PS C:\Projects&gt;<span style={{ background: editingTheme.cursor }}> </span></div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="dialog-footer dialog-footer-right">
          <button className="btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 14: 在 SettingsDialog.css 中添加主题编辑器样式**

在文件末尾追加：

```css
/* Settings tabs */
.settings-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
}

.settings-tab {
  flex: 1;
  padding: 10px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  transition: color 0.15s, border-color 0.15s;
}

.settings-tab:hover {
  color: var(--text-primary);
}

.settings-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* Theme manager */
.theme-manager {
  display: flex;
  gap: 16px;
  min-height: 300px;
}

.theme-list {
  min-width: 180px;
  max-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.theme-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
}

.theme-card:hover {
  background: var(--bg-tertiary);
}

.theme-card.active {
  background: var(--bg-tertiary);
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}

.theme-swatch {
  width: 24px;
  height: 16px;
  border-radius: 3px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.theme-card-name {
  flex: 1;
  font-size: 13px;
}

.theme-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
}

.theme-badge.preset {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.theme-badge.custom {
  background: rgba(0, 120, 212, 0.15);
  color: var(--accent);
}

.theme-card-delete {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
  border-radius: 3px;
}

.theme-card-delete:hover {
  color: #f44747;
  background: rgba(244, 71, 71, 0.1);
}

.theme-create-btn {
  padding: 8px;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 4px;
  color: var(--accent);
  cursor: pointer;
  font-size: 13px;
  transition: border-color 0.15s;
}

.theme-create-btn:hover {
  border-color: var(--accent);
}

/* Theme editor */
.theme-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.theme-editor-header {
  display: flex;
  gap: 8px;
  align-items: center;
}

.theme-editor-name {
  flex: 1;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
}

.theme-editor-name:focus {
  border-color: var(--accent);
}

.theme-editor-actions {
  display: flex;
  gap: 6px;
}

.color-slots {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}

.color-slot {
  display: flex;
  align-items: center;
  gap: 6px;
}

.color-slot label {
  min-width: 36px;
  font-size: 12px;
  color: var(--text-secondary);
}

.color-input-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
}

.color-input-wrap input[type="color"] {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: none;
  cursor: pointer;
  padding: 1px;
}

.color-input-wrap input[type="text"] {
  width: 72px;
  padding: 3px 6px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-primary);
  font-size: 12px;
  font-family: monospace;
  outline: none;
}

.color-input-wrap input[type="text"]:focus {
  border-color: var(--accent);
}

.theme-preview {
  padding: 12px;
  border-radius: 4px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  border: 1px solid var(--border);
}

/* Wider dialog for theme manager */
.settings-dialog {
  width: 640px;
}
```

- [ ] **Step 15: 验证前端编译通过**

**Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 16: 验证完整 Tauri 应用编译**

**Skills:** _none_

Run: `cd terminal-buddy && npm run build`
Expected: 构建成功

- [ ] **Step 17: 提交前端主题编辑器**

**Skills:** _none_

```bash
cd terminal-buddy
git add src/types/index.ts src/services/tauri.ts src/stores/appStore.ts src/components/SettingsDialog.tsx src/components/SettingsDialog.css
git commit -m "feat: add custom theme editor with visual preview"
```
