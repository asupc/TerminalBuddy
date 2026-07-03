# 分屏模式功能优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化分屏模式：F11 全屏循环、点击标签放入分屏、分屏满时自动替换、标签导航状态独立

**Architecture:** 在 Zustand store 中新增 `windowMode` 状态和 `previousPanelState` 用于全屏模式管理；修改 `splitSlots` 数据结构为带时间戳的对象数组，支持"替换最旧"逻辑；移除分屏对标签导航状态的强制修改

**Tech Stack:** React 18, Zustand, Tauri 2.x (`@tauri-apps/api/window`), CSS

## Global Constraints

- 所有 Rust↔TypeScript 序列化使用 `camelCase`
- 前端 UI 文本使用中文
- 不重新挂载终端实例（现有 no-remount 设计必须保持）
- `splitSlots` 是运行时状态，不持久化

---

### Task 1: 修改 splitSlots 数据结构

**Files:**
- Modify: `terminal-buddy/src/stores/appStore.ts:270-276` (类型定义)
- Modify: `terminal-buddy/src/stores/appStore.ts:706-752` (split 相关实现)

**Interfaces:**
- Produces: `SplitSlot { sessionId: string | null; enteredAt: number }` 类型
- Produces: `splitSlots: SplitSlot[]` 替代原来的 `(string | null)[]`

- [ ] **Step 1: 定义 SplitSlot 类型并修改 splitSlots 类型声明**

在 `appStore.ts` 顶部（约第 270 行附近）修改类型定义：

```typescript
// 修改前
splitSlots: (string | null)[];

// 修改后
splitSlots: { sessionId: string | null; enteredAt: number }[];
```

- [ ] **Step 2: 修改 cycleSplitMode 中的 slots 初始化逻辑**

在 `cycleSplitMode` 函数中（约第 708-733 行），将 slots 构建逻辑改为新结构：

```typescript
// 修改前
let slots: (string | null)[];
if (terms.length <= N) {
  slots = terms.slice(0, N).map(s => s.id);
  while (slots.length < N) slots.push(null);
} else {
  slots = new Array(N).fill(null);
}

// 修改后
let slots: { sessionId: string | null; enteredAt: number }[];
const now = Date.now();
if (terms.length <= N) {
  slots = terms.slice(0, N).map(s => ({ sessionId: s.id, enteredAt: now }));
  while (slots.length < N) slots.push({ sessionId: null, enteredAt: 0 });
} else {
  slots = new Array(N).fill(null).map(() => ({ sessionId: null, enteredAt: 0 }));
}
```

同样修改 2x1 → 2x2 的扩展逻辑：

```typescript
// 修改前
return { splitMode: '2x2' as const, splitSlots: [...state.splitSlots, null, null] };

// 修改后
return { splitMode: '2x2' as const, splitSlots: [...state.splitSlots, { sessionId: null, enteredAt: 0 }, { sessionId: null, enteredAt: 0 }] };
```

- [ ] **Step 3: 修改 closeSplitPane**

```typescript
// 修改前
closeSplitPane: (slotIndex) => {
  const sid = get().splitSlots[slotIndex];
  if (sid) get().removeSession(sid);
},

// 修改后
closeSplitPane: (slotIndex) => {
  const slot = get().splitSlots[slotIndex];
  if (slot?.sessionId) get().removeSession(slot.sessionId);
},
```

- [ ] **Step 4: 修改 swapSplitSlots**

```typescript
// 修改前
swapSplitSlots: (i, j) => set((state) => {
  const slots = [...state.splitSlots];
  if (i < 0 || j < 0 || i >= slots.length || j >= slots.length) return state;
  [slots[i], slots[j]] = [slots[j], slots[i]];
  return { splitSlots: slots };
}),

// 修改后（保持不变，对象引用交换即可）
swapSplitSlots: (i, j) => set((state) => {
  const slots = [...state.splitSlots];
  if (i < 0 || j < 0 || i >= slots.length || j >= slots.length) return state;
  [slots[i], slots[j]] = [slots[j], slots[i]];
  return { splitSlots: slots };
}),
```

- [ ] **Step 5: 修改 placeSessionInSplitSlot 支持替换最旧**

```typescript
// 修改前
placeSessionInSplitSlot: (sessionId) => set((state) => {
  if (state.splitMode === 'off') return state;
  const idx = state.splitSlots.indexOf(null);
  if (idx === -1) return state;
  const splitSlots = [...state.splitSlots];
  splitSlots[idx] = sessionId;
  return { splitSlots, activeSessionId: sessionId };
}),

// 修改后
placeSessionInSplitSlot: (sessionId) => set((state) => {
  if (state.splitMode === 'off') return state;
  const slots = state.splitSlots;

  // 1. 找空位
  const emptyIdx = slots.findIndex(s => s.sessionId === null);
  if (emptyIdx !== -1) {
    const splitSlots = [...slots];
    splitSlots[emptyIdx] = { sessionId, enteredAt: Date.now() };
    return { splitSlots, activeSessionId: sessionId };
  }

  // 2. 无空位，替换最旧的
  let oldestIdx = 0;
  let oldestTime = slots[0].enteredAt;
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].enteredAt < oldestTime) {
      oldestTime = slots[i].enteredAt;
      oldestIdx = i;
    }
  }
  const splitSlots = [...slots];
  splitSlots[oldestIdx] = { sessionId, enteredAt: Date.now() };
  return { splitSlots, activeSessionId: sessionId };
}),
```

- [ ] **Step 6: 提交**

```bash
git add terminal-buddy/src/stores/appStore.ts
git commit -m "refactor: 修改 splitSlots 数据结构为带时间戳的对象数组"
```

---

### Task 2: 适配 splitSlots 新结构（TerminalPanel）

**Files:**
- Modify: `terminal-buddy/src/components/TerminalPanel.tsx:46-54` (resize effect)
- Modify: `terminal-buddy/src/components/TerminalPanel.tsx:162-198` (split 渲染逻辑)

**Interfaces:**
- Consumes: `splitSlots: { sessionId: string | null; enteredAt: number }[]`

- [ ] **Step 1: 修改 resize effect 中的 splitSlots 访问**

```typescript
// 修改前
const ids = splitMode === 'off'
  ? sessions
      .filter(s => s.sessionType !== 'editor' && s.owner !== 'web')
      .map(s => s.id)
  : splitSlots.filter((s): s is string => s !== null);

// 修改后
const ids = splitMode === 'off'
  ? sessions
      .filter(s => s.sessionType !== 'editor' && s.owner !== 'web')
      .map(s => s.id)
  : splitSlots.filter((s): s is { sessionId: string; enteredAt: number } => s.sessionId !== null).map(s => s.sessionId);
```

- [ ] **Step 2: 修改 split 渲染逻辑中的 slots 遍历**

```typescript
// 修改前
{splitSlots.map((sid, i) => {
  const session = sid ? sessions.find(s => s.id === sid) : undefined;
  if (!sid || !session) {
    return (
      <div key={`blank-${i}`} className="split-cell split-blank" style={gridStyleFor(splitMode, i)}>
        点击左侧连接打开终端
      </div>
    );
  }
  return renderPane(session, { slot: i, active: activeSessionId === sid, hidden: false });
})}

// 修改后
{splitSlots.map((slot, i) => {
  const session = slot.sessionId ? sessions.find(s => s.id === slot.sessionId) : undefined;
  if (!slot.sessionId || !session) {
    return (
      <div key={`blank-${i}`} className="split-cell split-blank" style={gridStyleFor(splitMode, i)}>
        点击左侧连接打开终端
      </div>
    );
  }
  return renderPane(session, { slot: i, active: activeSessionId === slot.sessionId, hidden: false });
})}
```

- [ ] **Step 3: 修改非 slot 会话的过滤逻辑**

```typescript
// 修改前
{sessions.filter(s => !splitSlots.includes(s.id)).map(session =>
  renderPane(session, { active: false, hidden: true })
)}

// 修改后
{sessions.filter(s => !splitSlots.some(slot => slot.sessionId === s.id)).map(session =>
  renderPane(session, { active: false, hidden: true })
)}
```

- [ ] **Step 4: 提交**

```bash
git add terminal-buddy/src/components/TerminalPanel.tsx
git commit -m "refactor: 适配 splitSlots 新结构"
```

---

### Task 3: 移除分屏对标签导航的强制修改

**Files:**
- Modify: `terminal-buddy/src/stores/appStore.ts` (cycleSplitMode 函数)
- Modify: `terminal-buddy/src/components/TerminalPanel.tsx:162` (TabBar 显示条件)

**Interfaces:**
- 无新增，移除副作用

- [ ] **Step 1: 检查 cycleSplitMode 中是否有修改 enableTabNavigation 的代码**

搜索 `cycleSplitMode` 函数体，确认是否存在对 `enableTabNavigation` 或 `saveEnableTabNavigation` 的调用。如果有，移除它们。

- [ ] **Step 2: 确认 TerminalPanel 中 TabBar 显示条件正确**

当前条件（第 162 行）：
```typescript
{!settings.enableTabNavigation && sessions.length > 0 && splitMode === 'off' && (
  <TerminalTabBar />
)}
```

需要修改为：分屏模式下也显示顶部 TabBar（当标签导航关闭时）：

```typescript
{!settings.enableTabNavigation && sessions.length > 0 && (
  <TerminalTabBar />
)}
```

- [ ] **Step 3: 提交**

```bash
git add terminal-buddy/src/stores/appStore.ts terminal-buddy/src/components/TerminalPanel.tsx
git commit -m "fix: 移除分屏模式对标签导航状态的强制修改"
```

---

### Task 4: TabSidebar 和 TerminalTabBar 分屏模式点击放入分屏

**Files:**
- Modify: `terminal-buddy/src/components/TabSidebar.tsx:504` (终端点击处理)
- Modify: `terminal-buddy/src/components/TerminalTabBar.tsx:88` (标签点击处理)

**Interfaces:**
- Consumes: `splitMode`, `splitSlots`, `placeSessionInSplitSlot` from appStore

- [ ] **Step 1: 修改 TabSidebar 中终端点击逻辑**

在 TabSidebar 的终端列表项点击处理中（约第 504 行），添加分屏模式判断：

```typescript
// 修改前
onClick={() => setActiveSession(child.id)}

// 修改后
onClick={() => {
  const store = useAppStore.getState();
  if (store.splitMode !== 'off') {
    // 分屏模式：如果终端不在分屏中，放入分屏
    if (!store.splitSlots.some(slot => slot.sessionId === child.id)) {
      store.placeSessionInSplitSlot(child.id);
    } else {
      store.setActiveSession(child.id);
    }
  } else {
    store.setActiveSession(child.id);
  }
}}
```

- [ ] **Step 2: 修改 TerminalTabBar 中标签点击逻辑**

在 TerminalTabBar 的标签点击处理中（约第 88 行），添加分屏模式判断：

```typescript
// 修改前
onClick={() => setActiveSession(session.id)}

// 修改后
onClick={() => {
  const store = useAppStore.getState();
  if (store.splitMode !== 'off') {
    // 分屏模式：如果终端不在分屏中，放入分屏
    if (!store.splitSlots.some(slot => slot.sessionId === session.id)) {
      store.placeSessionInSplitSlot(session.id);
    } else {
      store.setActiveSession(session.id);
    }
  } else {
    store.setActiveSession(session.id);
  }
}}
```

- [ ] **Step 3: 提交**

```bash
git add terminal-buddy/src/components/TabSidebar.tsx terminal-buddy/src/components/TerminalTabBar.tsx
git commit -m "feat: 分屏模式下点击标签自动放入分屏"
```

---

### Task 5: 分屏满时启动新终端自动替换最旧

**Files:**
- Modify: `terminal-buddy/src/App.tsx:337-342` (handleStartTerminal 分屏检测)

**Interfaces:**
- Consumes: `splitMode`, `splitSlots`, `placeSessionInSplitSlot` from appStore

- [ ] **Step 1: 修改 handleStartTerminal 中的分屏满检测逻辑**

当前逻辑（第 337-342 行）在分屏满时直接阻止启动并提示。需要改为自动替换最旧：

```typescript
// 修改前
const store = useAppStore.getState();
if (store.splitMode !== 'off' && !store.splitSlots.includes(null)) {
  store.showToast('分屏模式已满，请先关闭某个分屏或退出分屏', 'info');
  return;
}

// 修改后
const store = useAppStore.getState();
if (store.splitMode !== 'off' && store.splitSlots.every(s => s.sessionId !== null)) {
  // 分屏已满，找到最旧的 slot 并移出（不关闭会话）
  let oldestIdx = 0;
  let oldestTime = store.splitSlots[0].enteredAt;
  for (let i = 1; i < store.splitSlots.length; i++) {
    if (store.splitSlots[i].enteredAt < oldestTime) {
      oldestTime = store.splitSlots[i].enteredAt;
      oldestIdx = i;
    }
  }
  // 清空最旧的 slot（会话保留在 sessions 列表中）
  const newSlots = [...store.splitSlots];
  newSlots[oldestIdx] = { sessionId: null, enteredAt: 0 };
  useAppStore.setState({ splitSlots: newSlots });
}
```

- [ ] **Step 2: 提交**

```bash
git add terminal-buddy/src/App.tsx
git commit -m "feat: 分屏满时启动新终端自动替换最旧的分屏会话"
```

---

### Task 6: 新增 windowMode 状态和 cycleWindowMode action

**Files:**
- Modify: `terminal-buddy/src/stores/appStore.ts:270-276` (类型定义)
- Modify: `terminal-buddy/src/stores/appStore.ts:700+` (实现)

**Interfaces:**
- Produces: `windowMode: 'normal' | 'panels-hidden' | 'fullscreen'`
- Produces: `previousPanelState: { configPanelVisible: boolean; fileTreeVisible: boolean; enableTabNavigation: boolean } | null`
- Produces: `cycleWindowMode: () => void`

- [ ] **Step 1: 在 AppState 接口中新增 windowMode 相关状态和 action**

在 `appStore.ts` 的 AppState 接口中（约第 270 行附近）添加：

```typescript
// Window mode (F11 cycle)
windowMode: 'normal' | 'panels-hidden' | 'fullscreen';
previousPanelState: { configPanelVisible: boolean; fileTreeVisible: boolean; enableTabNavigation: boolean } | null;
cycleWindowMode: () => void;
```

- [ ] **Step 2: 实现 cycleWindowMode action**

在 store 实现中（约第 700 行附近）添加：

```typescript
windowMode: 'normal',
previousPanelState: null,
cycleWindowMode: () => set((state) => {
  const cur = state.windowMode;

  if (cur === 'normal') {
    // normal → panels-hidden: 保存当前面板状态
    const settings = getAppSettings();
    return {
      windowMode: 'panels-hidden' as const,
      previousPanelState: {
        configPanelVisible: state.configPanelVisible,
        fileTreeVisible: state.fileTreeVisible,
        enableTabNavigation: settings.enableTabNavigation,
      },
    };
  }

  if (cur === 'panels-hidden') {
    // panels-hidden → fullscreen
    return { windowMode: 'fullscreen' as const };
  }

  // fullscreen → normal: 恢复之前的面板状态
  const prev = state.previousPanelState;
  if (prev) {
    const settings = getAppSettings();
    saveAppSettings({ ...settings, enableTabNavigation: prev.enableTabNavigation });
    saveEnableTabNavigation(prev.enableTabNavigation).catch(() => {});
    window.dispatchEvent(new CustomEvent('tab-navigation-changed'));
  }
  return {
    windowMode: 'normal' as const,
    previousPanelState: null,
    configPanelVisible: prev?.configPanelVisible ?? state.configPanelVisible,
    fileTreeVisible: prev?.fileTreeVisible ?? state.fileTreeVisible,
  };
}),
```

- [ ] **Step 3: 提交**

```bash
git add terminal-buddy/src/stores/appStore.ts
git commit -m "feat: 新增 windowMode 状态和 cycleWindowMode action"
```

---

### Task 7: 实现 F11 键监听和全屏切换

**Files:**
- Modify: `terminal-buddy/src/App.tsx` (新增 F11 监听和 fullscreen 切换)

**Interfaces:**
- Consumes: `windowMode`, `cycleWindowMode` from appStore
- Uses: `getCurrentWindow().setFullscreen()` from Tauri API

- [ ] **Step 1: 在 App.tsx 中添加 F11 键监听和 fullscreen 效果**

在 App 组件中添加：

```typescript
const windowMode = useAppStore(s => s.windowMode);
const cycleWindowMode = useAppStore(s => s.cycleWindowMode);

// F11 键监听
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'F11') {
      e.preventDefault();
      cycleWindowMode();
    }
  };
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [cycleWindowMode]);

// fullscreen 模式切换
useEffect(() => {
  const win = getCurrentWindow();
  if (windowMode === 'fullscreen') {
    win.setFullscreen(true);
  } else {
    win.setFullscreen(false);
  }
}, [windowMode]);
```

- [ ] **Step 2: 提交**

```bash
git add terminal-buddy/src/App.tsx
git commit -m "feat: 实现 F11 键监听和全屏切换"
```

---

### Task 8: 实现 panels-hidden CSS 控制和 TitleBar 隐藏

**Files:**
- Modify: `terminal-buddy/src/styles/global.css` (新增 .panels-hidden 规则)
- Modify: `terminal-buddy/src\App.tsx` (添加 panels-hidden 类)
- Modify: `terminal-buddy\src\components\TitleBar.tsx` (fullscreen 时隐藏)

**Interfaces:**
- Consumes: `windowMode` from appStore

- [ ] **Step 1: 在 global.css 中添加 panels-hidden 样式规则**

```css
/* Panels hidden mode (F11) */
.panels-hidden .config-panel,
.panels-hidden .file-tree,
.panels-hidden .remote-file-tree,
.panels-hidden .tab-sidebar {
  display: none !important;
}
```

- [ ] **Step 2: 在 App.tsx 的根容器上添加 panels-hidden 类**

修改 App 组件的返回 JSX，给 `.app-container` 添加条件类：

```tsx
<div className={`app-container${windowMode === 'panels-hidden' ? ' panels-hidden' : ''}`}>
```

- [ ] **Step 3: 在 TitleBar 中根据 windowMode 控制显示**

```tsx
// 在 TitleBar 组件中
const windowMode = useAppStore(s => s.windowMode);

// 在渲染时
if (windowMode === 'fullscreen') return null;
```

- [ ] **Step 4: 提交**

```bash
git add terminal-buddy/src/styles/global.css terminal-buddy/src/App.tsx terminal-buddy/src/components/TitleBar.tsx
git commit -m "feat: 实现 panels-hidden 模式 CSS 控制和 TitleBar 隐藏"
```

---

### Task 9: 验证和修复

**Files:**
- 检查所有修改过的文件

- [ ] **Step 1: TypeScript 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

修复所有类型错误。

- [ ] **Step 2: 运行开发模式测试**

```bash
cd terminal-buddy && npm run tauri dev
```

手动测试以下场景：
1. F11 循环：normal → panels-hidden → fullscreen → normal
2. 分屏模式下点击标签放入分屏
3. 分屏满时启动新终端自动替换
4. 标签导航状态在分屏切换时保持不变

- [ ] **Step 3: 修复发现的问题**

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "fix: 修复分屏模式优化中的问题"
```
