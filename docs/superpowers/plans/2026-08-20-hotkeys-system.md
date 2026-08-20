# 快捷键系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入统一快捷键系统:全局快捷键「呼出程序窗口」+ 一组应用内快捷键动作 + 全部快捷键可自定义录制。

**Architecture:** 前端 `src/services/hotkeys.ts` 作为唯一快捷键核心(动作表、默认键、执行器注册表、window/document keydown 分发器、全局快捷键注册);动作中简单者内联执行、依赖组件上下文者(App 的 newTerminal)由 App 挂载时注册;终端内通过 xterm `attachCustomKeyEventHandler` 放行应用快捷键冒泡到分发器;Rust 侧仅接入 tauri-plugin-global-shortcut,无新命令。

**Tech Stack:** React 18 + TypeScript、Zustand、xterm.js、Tauri 2(tauri-plugin-global-shortcut)。

**Spec:** `docs/superpowers/specs/2026-08-20-hotkeys-system-design.md`(已批准;本计划据此展开,冲突时以 spec 为准)

## Global Constraints

- F11/F2 维持硬编码,不纳入本系统;F11 现有 `_tbF11Handled` 去重监听保持不变、不回归。
- `autocomplete` 动作由 TerminalInstance 的 capture-phase `handleKeyDown` 本地拦截,不进入 window 分发器;补全面板判断在 `attachCustomKeyEventHandler` 放行逻辑之前,不受影响。
- 新分发器用独立的 `_tbHotkeyHandled` 去重标记(与 `_tbF11Handled` 互不干扰)。
- 录制中屏蔽:分发前检查 `document.activeElement?.closest('.hotkey-recorder.recording')`,命中则跳过。
- 空字符串视为禁用该动作;`getHotkey(action)` = `settings.hotkeys?.[action] ?? DEFAULT_HOTKEYS[action]`。
- 动作间快捷键重复仅提示不阻止保存,文案「与「X」重复」。
- 应用内快捷键与全局快捷键均要求修饰键组合(沿用 `formatHotkey` 约束:裸修饰键或无修饰键返回 null 不保存)。
- 全局快捷键注册失败:console.error + `showToast('全局快捷键注册失败,可能被其他程序占用', 'error')`。
- 默认键(逐字):showWindow=`Ctrl+Alt+T`、toggleConfigNav=`Ctrl+Shift+C`、toggleFileNav=`Ctrl+Shift+E`、openSettings=`Ctrl+,`、newTerminal=`Ctrl+Shift+N`、closeTab=`Ctrl+W`、autocomplete=`Alt+/`。
- 前端 UI 与代码注释用中文;Rust↔TS 序列化 camelCase(本计划不新增 Rust 序列化字段)。
- 不改动 `web/` 前端、不改动 Rust `AppSettings`。
- 无前端测试框架;验证 = `npx tsc --noEmit`(terminal-buddy 目录)、`cargo check`(terminal-buddy/src-tauri 目录),最后按 spec「验证」清单手动验证。
- Commit message 格式:`[快捷键] 变更描述`。
- 工作目录:仓库根 `D:\gitee\TerminalBuddy`,前端代码在 `terminal-buddy/` 子目录。

---

### Task 1: Rust 插件与前端依赖接入

**Files:**
- Modify: `terminal-buddy/src-tauri/Cargo.toml`(dependencies 中 `tauri-plugin-dialog = "2"` 行后加 `tauri-plugin-global-shortcut = "2"`)
- Modify: `terminal-buddy/src-tauri/src/lib.rs`(第 312-320 行 Builder 插件注册处,`tauri_plugin_dialog::init()` 后加一行)
- Modify: `terminal-buddy/src-tauri/capabilities/default.json`(permissions 数组末尾加 `"global-shortcut:default"`)
- Modify: `terminal-buddy/package.json`(dependencies 中 `"@tauri-apps/plugin-dialog": "^2.0.0"` 行后加 `"@tauri-apps/plugin-global-shortcut": "^2.0.0"`)

**Interfaces:**
- Produces: Rust 侧全局快捷键插件可用;前端可 `import { register, unregister } from '@tauri-apps/plugin-global-shortcut'`(Task 2 消费)。

- [ ] **Step 1: Cargo.toml 加依赖**

在 `[dependencies]` 中 `tauri-plugin-dialog = "2"` 之后插入:

```toml
tauri-plugin-global-shortcut = "2"
```

- [ ] **Step 2: lib.rs 注册插件**

在 `let mut builder = tauri::Builder::default()` 的插件链中,`tauri_plugin_dialog::init()` 之后插入:

```rust
.plugin(tauri_plugin_global_shortcut::Builder::new().build())
```

注意该文件第 320 行附近有 `builder = builder.plugin(tauri_plugin_single_instance::init(...))` 的条件式注册,不要动它,新插件注册在 `tauri_plugin_dialog::init()` 直接链式处。

- [ ] **Step 3: capabilities/default.json 加权限**

在 `"permissions"` 数组末尾(`"core:window:allow-set-position"` 之后)加:

```json
"global-shortcut:default"
```

- [ ] **Step 4: package.json 加前端依赖**

在 `"dependencies"` 中 `"@tauri-apps/plugin-dialog": "^2.0.0"` 之后加:

```json
"@tauri-apps/plugin-global-shortcut": "^2.0.0"
```

- [ ] **Step 5: 安装依赖并验证**

```bash
cd terminal-buddy && npm install
npx tsc --noEmit
cd src-tauri && cargo check
```

Expected:`npm install` 成功安装 plugin-global-shortcut;`tsc --noEmit` 无错误(前端未改动,应与基线一致);`cargo check` 编译通过(首次会下载编译新 crate,耗时较长属正常)。

- [ ] **Step 6: Commit**

```bash
git add terminal-buddy/src-tauri/Cargo.toml terminal-buddy/src-tauri/src/lib.rs terminal-buddy/src-tauri/capabilities/default.json terminal-buddy/package.json terminal-buddy/package-lock.json
git commit -m "[快捷键] 接入 tauri-plugin-global-shortcut(Rust 插件与前端依赖)"
```

---

### Task 2: 快捷键存储与核心服务

**Files:**
- Modify: `terminal-buddy/src/utils/settings.ts`(AppSettings 字段替换 + 旧值迁移)
- Create: `terminal-buddy/src/services/hotkeys.ts`(核心服务,完整实现见下)
- Modify: `terminal-buddy/src/components/terminal/TerminalInstance.tsx`(补全快捷键读取点,约第 919-921 行)
- Modify: `terminal-buddy/src/components/settings/BehaviorSettings.tsx`(约第 240 行,录制保存的存储键替换)

**Interfaces:**
- Consumes: Task 1 的 `@tauri-apps/plugin-global-shortcut` npm 包。
- Produces(Task 3/4/5 消费):
  - `export type HotkeyActionId = 'showWindow' | 'toggleConfigNav' | 'toggleFileNav' | 'openSettings' | 'newTerminal' | 'closeTab' | 'autocomplete'`
  - `export interface HotkeyActionMeta { id: HotkeyActionId; name: string; desc: string; defaultHotkey: string }`
  - `export const HOTKEY_ACTIONS: HotkeyActionMeta[]`(顺序 = spec 动作表顺序)
  - `export const DEFAULT_HOTKEYS: Record<HotkeyActionId, string>`(从 HOTKEY_ACTIONS 派生)
  - `export const getHotkey = (action: HotkeyActionId): string`
  - `export const registerHotkeyAction = (id: HotkeyActionId, fn: () => void): void`
  - `export const initAppHotkeys = (): (() => void)`(App 挂载调用,返回清理函数)
  - `export const isAppHotkeyEvent = (e: KeyboardEvent): boolean`(终端放行判断,Task 4 消费)
  - `AppSettings.hotkeys: Partial<Record<HotkeyActionId, string>>`(Task 5 消费)

- [ ] **Step 1: settings.ts 字段替换**

文件顶部加 type-only import(避免运行时循环依赖):

```ts
import type { HotkeyActionId } from '../services/hotkeys';
```

`AppSettings` interface 中删除 `autocompleteHotkey: string;` 行,在原位置加:

```ts
hotkeys: Partial<Record<HotkeyActionId, string>>;
```

`DEFAULT_SETTINGS` 中删除 `autocompleteHotkey: 'Alt+/',` 行,在原位置加:

```ts
hotkeys: {},
```

`initAppHotkeys` 无关,`initAppSettings` 中在 `delete parsed.terminalBackgroundOpacityBySkin;` 之后加旧值迁移(上一轮未发布字段的防御性迁移,已录制的补全键不丢失):

```ts
// 迁移上一轮未发布的 autocompleteHotkey 到统一 hotkeys 映射
const legacyHotkey = (parsed as Partial<AppSettings> & { autocompleteHotkey?: string }).autocompleteHotkey;
if (legacyHotkey !== undefined && parsed.hotkeys === undefined) {
  parsed.hotkeys = { autocomplete: legacyHotkey };
}
delete (parsed as Partial<AppSettings> & { autocompleteHotkey?: string }).autocompleteHotkey;
```

`formatHotkey` / `matchesHotkey` / `normalizeHotkeyKey` 保持不动。

- [ ] **Step 2: 新建 src/services/hotkeys.ts**

完整内容(参考实现,与现有代码风格一致地写;注释中文):

```ts
import { getCurrentWindow } from '@tauri-apps/api/window';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { useAppStore } from '../stores/appStore';
import { getAppSettings, matchesHotkey } from '../utils/settings';
import { closeTerminal } from './tauri';

export type HotkeyActionId =
  | 'showWindow' | 'toggleConfigNav' | 'toggleFileNav'
  | 'openSettings' | 'newTerminal' | 'closeTab' | 'autocomplete';

export interface HotkeyActionMeta {
  id: HotkeyActionId;
  name: string;
  desc: string;
  defaultHotkey: string;
}

export const HOTKEY_ACTIONS: HotkeyActionMeta[] = [
  { id: 'showWindow', name: '呼出程序窗口', desc: '全局快捷键，应用在托盘或后台时按下可唤出窗口', defaultHotkey: 'Ctrl+Alt+T' },
  { id: 'toggleConfigNav', name: '配置导航开关', desc: '显示或隐藏左侧配置（连接）面板', defaultHotkey: 'Ctrl+Shift+C' },
  { id: 'toggleFileNav', name: '文件导航开关', desc: '显示或隐藏左侧文件面板', defaultHotkey: 'Ctrl+Shift+E' },
  { id: 'openSettings', name: '打开设置', desc: '打开设置弹窗', defaultHotkey: 'Ctrl+,' },
  { id: 'newTerminal', name: '新建终端', desc: '新建一个 PowerShell 终端', defaultHotkey: 'Ctrl+Shift+N' },
  { id: 'closeTab', name: '关闭当前标签', desc: '关闭当前激活的终端标签', defaultHotkey: 'Ctrl+W' },
  { id: 'autocomplete', name: '命令补全面板', desc: '在终端中唤起或关闭命令补全面板', defaultHotkey: 'Alt+/' },
];

export const DEFAULT_HOTKEYS: Record<HotkeyActionId, string> = Object.fromEntries(
  HOTKEY_ACTIONS.map(a => [a.id, a.defaultHotkey]),
) as Record<HotkeyActionId, string>;

// 读取动作当前生效的快捷键：设置值优先，未设置回落默认；空字符串视为禁用
export const getHotkey = (action: HotkeyActionId): string => {
  const stored = getAppSettings().hotkeys?.[action];
  return stored !== undefined ? stored : DEFAULT_HOTKEYS[action];
};

// 执行器注册表：store 可直接执行的简单动作在下方内联注册；
// 依赖组件上下文的动作（如 newTerminal）由 App 挂载时通过 registerHotkeyAction 注册
const actionExecutors: Partial<Record<HotkeyActionId, () => void>> = {};

export const registerHotkeyAction = (id: HotkeyActionId, fn: () => void): void => {
  actionExecutors[id] = fn;
};

// 内联执行器（store 动作,无需组件上下文）
registerHotkeyAction('toggleConfigNav', () => useAppStore.getState().toggleConfigPanel());
registerHotkeyAction('toggleFileNav', () => useAppStore.getState().toggleFileTree());
registerHotkeyAction('openSettings', () => useAppStore.getState().openSettingsDialog());
// 关闭当前标签：与 TabNav / TerminalTabBar 单标签关闭逻辑一致
registerHotkeyAction('closeTab', () => {
  const store = useAppStore.getState();
  const sessionId = store.activeSessionId;
  if (!sessionId) return;
  store.removeSession(sessionId);
  void closeTerminal(sessionId).catch(err => console.error(err));
});

// 判断按键事件是否命中任一应用内快捷键（不含 autocomplete 本地拦截与 showWindow 全局动作）
export const isAppHotkeyEvent = (e: KeyboardEvent): boolean => {
  if (e.type !== 'keydown') return false;
  for (const action of HOTKEY_ACTIONS) {
    if (action.id === 'autocomplete' || action.id === 'showWindow') continue;
    const hotkey = getHotkey(action.id);
    if (hotkey && matchesHotkey(e, hotkey)) return true;
  }
  return false;
};

// 当前已注册到系统的全局快捷键（空串 = 未注册）
let _registeredShowWindow: string | null = null;

// App 挂载后调用：注册 window/document keydown 分发 + 全局快捷键（呼出窗口）。
// 返回清理函数。F11 现有监听保持独立、不受影响；本分发器用独立的 _tbHotkeyHandled 去重。
export const initAppHotkeys = (): (() => void) => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e as any)._tbHotkeyHandled) return;
    // 录制中屏蔽：焦点在录制按钮上时不分发
    const target = document.activeElement as HTMLElement | null;
    if (target?.closest?.('.hotkey-recorder.recording')) return;
    for (const action of HOTKEY_ACTIONS) {
      if (action.id === 'autocomplete' || action.id === 'showWindow') continue;
      const hotkey = getHotkey(action.id);
      if (hotkey && matchesHotkey(e, hotkey)) {
        (e as any)._tbHotkeyHandled = true;
        e.preventDefault();
        actionExecutors[action.id]?.();
        return;
      }
    }
  };
  window.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keydown', handleKeyDown);

  // 全局快捷键：设置变更时卸载旧键、注册新键；空字符串仅卸载
  const syncGlobalHotkey = () => {
    const hotkey = getHotkey('showWindow');
    if (hotkey === _registeredShowWindow) return;
    const previous = _registeredShowWindow;
    _registeredShowWindow = hotkey;
    if (previous) void unregister(previous).catch(() => {});
    if (!hotkey) return;
    register(hotkey, () => {
      const win = getCurrentWindow();
      void win.show();
      void win.unminimize();
      void win.setFocus();
    }).catch(err => {
      console.error('全局快捷键注册失败:', err);
      useAppStore.getState().showToast('全局快捷键注册失败,可能被其他程序占用', 'error');
    });
  };
  syncGlobalHotkey();
  window.addEventListener('app-settings-changed', syncGlobalHotkey);

  return () => {
    window.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('app-settings-changed', syncGlobalHotkey);
    if (_registeredShowWindow) {
      void unregister(_registeredShowWindow).catch(() => {});
      _registeredShowWindow = null;
    }
  };
};
```

注意:`services/tauri.ts` 是本项目 `services/tauri/` 目录的 re-export 入口,`closeTerminal` 从 `'./tauri'` 导入(与 `TerminalTabBar.tsx` 的 `import { closeTerminal as closeTerminalCmd, ... } from '../../services/tauri'` 一致)。如发现 `services/tauri` 的实际导入路径不同(可能是 `./tauri/index` 等),以项目现有文件为准,保持与 TerminalTabBar 相同的导入来源。

- [ ] **Step 3: TerminalInstance 补全快捷键读取点替换**

`terminal-buddy/src/components/terminal/TerminalInstance.tsx` 中,import 区加:

```ts
import { getHotkey } from '../../services/hotkeys';
```

`handleKeyDown` 内(约第 919-921 行):

```ts
const autocompleteHotkey = getAppSettings().autocompleteHotkey;
```

替换为:

```ts
const autocompleteHotkey = getHotkey('autocomplete');
```

其余逻辑不动。

- [ ] **Step 4: BehaviorSettings 录制保存的存储键替换**

`terminal-buddy/src/components/settings/BehaviorSettings.tsx` 约第 240 行:

```ts
updateSetting('autocompleteHotkey', formatted);
```

替换为:

```ts
updateSetting('hotkeys', { ...(settings.hotkeys ?? {}), autocomplete: formatted });
```

其余不动(该录制 UI 在 Task 5 整体重构)。

- [ ] **Step 5: 验证**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无错误。特别注意 `services/tauri` 导入路径若与项目实际不符,tsc 会报错,按项目实际路径修正。

- [ ] **Step 6: Commit**

```bash
git add terminal-buddy/src/utils/settings.ts terminal-buddy/src/services/hotkeys.ts terminal-buddy/src/components/terminal/TerminalInstance.tsx terminal-buddy/src/components/settings/BehaviorSettings.tsx
git commit -m "[快捷键] 统一快捷键存储(hotkeys 映射)与核心分发服务"
```

---

### Task 3: App 挂载分发器与 newTerminal 执行器

**Files:**
- Modify: `terminal-buddy/src/App.tsx`(import + 新增 useEffect)

**Interfaces:**
- Consumes: Task 2 的 `initAppHotkeys()`、`registerHotkeyAction`;现有 `handleStartBlankTerminal`(App.tsx 第 458 行,`(terminalType: 'powershell' | 'pwsh' | 'cmd') => Promise<void>`)。
- Produces: 应用内快捷键(导航开关/打开设置/关闭标签)与全局快捷键在 App 启动后生效。

- [ ] **Step 1: 加 import**

`App.tsx` import 区加:

```ts
import { initAppHotkeys, registerHotkeyAction } from './services/hotkeys';
```

- [ ] **Step 2: 新增 useEffect**

放在 `handleStartBlankTerminal` 定义(约第 482 行)之后、`handleStartTextEditor` 之前:

```ts
// 统一快捷键系统:注册应用内分发与全局快捷键;newTerminal 依赖 App 上下文,在此注册执行器
useEffect(() => {
  registerHotkeyAction('newTerminal', () => { void handleStartBlankTerminal('powershell'); });
  return initAppHotkeys();
}, [handleStartBlankTerminal]);
```

注意:先注册执行器再 init(执行器注册表分发时才读取,顺序不敏感,但保持此顺序语义清晰)。`initAppHotkeys` 返回清理函数,直接作为 effect cleanup 返回。

- [ ] **Step 3: 验证**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add terminal-buddy/src/App.tsx
git commit -m "[快捷键] App 挂载快捷键分发并接入新建终端动作"
```

---

### Task 4: 终端内应用快捷键放行

**Files:**
- Modify: `terminal-buddy/src/components/terminal/TerminalInstance.tsx`(约第 449-454 行 `attachCustomKeyEventHandler`)

**Interfaces:**
- Consumes: Task 2 的 `isAppHotkeyEvent`。

- [ ] **Step 1: import**

`TerminalInstance.tsx` import 区(Task 2 已加 `getHotkey` 处附近)加:

```ts
import { getHotkey, isAppHotkeyEvent } from '../../services/hotkeys';
```

(若 Task 2 已写为 `import { getHotkey } from '../../services/hotkeys';`,则改为上面的合并导入。)

- [ ] **Step 2: 泛化放行逻辑**

现有(约第 449-454 行):

```ts
terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
  // F11: 全屏切换；F2: 重命名（TabNav / ConfigNav / TerminalTabBar）
  // 返回 false 让这些键冒泡到 document，不被 xterm 消费
  if (e.type === 'keydown' && (e.key === 'F11' || e.key === 'F2')) return false;
  return true;
});
```

改为(保留 F11/F2 逻辑与注释不变,追加放行):

```ts
terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
  // F11: 全屏切换；F2: 重命名（TabNav / ConfigNav / TerminalTabBar）
  // 返回 false 让这些键冒泡到 document，不被 xterm 消费
  if (e.type === 'keydown' && (e.key === 'F11' || e.key === 'F2')) return false;
  // 应用内快捷键（导航开关/设置/新建/关闭标签）放行到 window 分发器,不被 xterm 消费;
  // autocomplete 不在此列,由 capture 阶段 handleKeyDown 本地拦截
  if (isAppHotkeyEvent(e)) return false;
  return true;
});
```

- [ ] **Step 3: 验证**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add terminal-buddy/src/components/terminal/TerminalInstance.tsx
git commit -m "[快捷键] 终端放行应用快捷键到全局分发器"
```

---

### Task 5: 设置页「快捷键」分区与 HotkeyRecorder 提取

**Files:**
- Create: `terminal-buddy/src/components/settings/HotkeyRecorder.tsx`(从 BehaviorSettings 现有录制实现提取)
- Modify: `terminal-buddy/src/components/settings/BehaviorSettings.tsx`(删除旧「补全面板快捷键」section,新增「快捷键」分区列表)
- Modify: `terminal-buddy/src/components/settings/SettingsPage.css`(新增分区行样式)

**Interfaces:**
- Consumes: Task 2 的 `HOTKEY_ACTIONS`、`getHotkey`、`HotkeyActionId`;`AppSettings.hotkeys`;`formatHotkey`(settings.ts 已有)。
- Produces:
  - `export const HotkeyRecorder: FC<{ value: string; onRecord: (hotkey: string) => void }>`

- [ ] **Step 1: 新建 HotkeyRecorder.tsx**

完整内容(从 BehaviorSettings 现有录制实现提取,含 window 捕获拦截 Esc 的逻辑一并移入):

```tsx
import { FC, useEffect, useState } from 'react';
import { formatHotkey } from '../../utils/settings';

interface HotkeyRecorderProps {
  value: string;
  onRecord: (hotkey: string) => void;
}

// 快捷键录制按钮:点击进入录制,按组合键保存,Esc 取消
export const HotkeyRecorder: FC<HotkeyRecorderProps> = ({ value, onRecord }) => {
  const [recording, setRecording] = useState(false);

  // 录制期间在 window 捕获阶段拦截 Esc 取消录制；设置弹窗（Dialog）在 document
  // 捕获阶段监听 Esc 关闭整个弹窗，必须先于它阻止传播
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setRecording(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  return (
    <button
      className={`btn-secondary hotkey-recorder ${recording ? 'recording' : ''}`}
      type="button"
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();
        // Esc 取消录制由 window 捕获阶段监听统一处理（见上）
        const formatted = formatHotkey(e.nativeEvent);
        if (formatted) {
          onRecord(formatted);
          setRecording(false);
        }
      }}
    >
      {recording ? '请按下新快捷键…' : (value || '未设置')}
    </button>
  );
};
```

- [ ] **Step 2: BehaviorSettings 删除旧录制 section**

删除「补全面板快捷键」整个 `settings-section`(约第 226-248 行,从 `<div className="settings-section">` 到对应 `</div>`,含 recordingHotkey state 与 window Esc 拦截 useEffect,即第 14-28 行)。`formatHotkey` 的 import 一并移除(第 4 行改为):

```ts
import { type AppSettings, type BreathingLightColorMode } from '../../utils/settings';
```

`useState`/`useEffect` 若不再被其余代码使用,import 行同步收紧(第 1 行)。

- [ ] **Step 3: BehaviorSettings 新增「快捷键」分区**

import 区加:

```ts
import { getHotkey, HOTKEY_ACTIONS, type HotkeyActionId } from '../../services/hotkeys';
import { HotkeyRecorder } from './HotkeyRecorder';
```

在「右键粘贴」section(约第 213-225 行)之后插入「快捷键」分区(放在行为相关设置中间偏上,紧随右击粘贴之后):

```tsx
<div className="settings-section">
  <label className="settings-label">快捷键</label>
  {HOTKEY_ACTIONS.map((action) => {
    const current = getHotkey(action.id);
    // 与其他动作当前生效键重复时提示,不阻止保存
    const duplicate = HOTKEY_ACTIONS.find(
      other => other.id !== action.id && current !== '' && getHotkey(other.id) === current,
    );
    return (
      <div key={action.id} className="hotkey-row">
        <span className="hotkey-row-name">{action.name}</span>
        <HotkeyRecorder
          value={current}
          onRecord={(hotkey) => {
            const next: Record<HotkeyActionId, string> = { ...(settings.hotkeys ?? {}), [action.id]: hotkey };
            updateSetting('hotkeys', next);
          }}
        />
        {duplicate && <span className="hotkey-duplicate">与「{duplicate.name}」重复</span>}
        <p className="settings-desc hotkey-desc">
          {action.desc}{action.id === 'showWindow' ? '（全局，后台也可用）' : ''}
        </p>
      </div>
    );
  })}
</div>
```

- [ ] **Step 4: SettingsPage.css 加分区行样式**

`terminal-buddy/src/components/settings/SettingsPage.css` 末尾追加:

```css
/* 快捷键分区:动作名 + 录制按钮 + 说明/重复提示 */
.hotkey-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.hotkey-row-name {
  min-width: 96px;
  font-size: 13px;
  color: var(--text-primary);
}

.hotkey-desc {
  flex-basis: 100%;
  margin: 2px 0 0;
}

.hotkey-duplicate {
  font-size: 12px;
  color: var(--danger, #f48771);
}
```

- [ ] **Step 5: 验证**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无错误;确认 `BehaviorSettings.tsx` 中无残留 `autocompleteHotkey` 引用(可用 grep 自查:`grep -rn "autocompleteHotkey" terminal-buddy/src` 应只命中 hotkeys.ts 迁移注释或零命中——本计划 Task 2 已删除全部引用,此步只做复核)。

- [ ] **Step 6: Commit**

```bash
git add terminal-buddy/src/components/settings/HotkeyRecorder.tsx terminal-buddy/src/components/settings/BehaviorSettings.tsx terminal-buddy/src/components/settings/SettingsPage.css
git commit -m "[快捷键] 设置页快捷键分区与录制组件"
```

---

## 完成后的手动验证(收尾阶段,按 spec「验证」清单)

`npm run tauri dev` 后逐项确认:
1. 默认键逐个生效(配置/文件导航开关、Ctrl+, 设置、Ctrl+Shift+N 新建、Ctrl+W 关标签、Alt+/ 补全)
2. Ctrl+Alt+T:窗口最小化/隐藏到托盘后按之,窗口恢复并聚焦
3. 设置页录制修改(如 Ctrl+W → Ctrl+Shift+X)后立即生效
4. 录制与其他动作重复时出现提示
5. 录制期间按 Ctrl+W 不会真正关闭标签(屏蔽生效)
6. 全局快捷键改为被占用组合时 toast 提示
