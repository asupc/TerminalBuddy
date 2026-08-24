# TerminalBuddy 快捷键系统设计

日期:2026-08-20
状态:已批准

## 背景与目标

TerminalBuddy 目前仅有补全面板快捷键(未提交)与硬编码的 F11(隐藏面板)/F2(重命名)。本次引入统一的快捷键系统:

1. 全局快捷键「呼出程序窗口」:应用在托盘/后台时也能唤起(引入 tauri-plugin-global-shortcut)
2. 一组应用内快捷键动作:配置导航开关、文件导航开关、打开设置、新建终端、关闭当前标签
3. 所有快捷键(含已有补全面板快捷键)统一为可自定义设置,在行为设置页录制修改

## 动作注册表

| 动作 ID | 名称 | 默认键 | 实现 |
|---|---|---|---|
| `showWindow` | 呼出程序窗口 | `Ctrl+Alt+T` | **全局**:global-shortcut 插件注册,回调 `getCurrentWindow().show() + unminimize() + setFocus()` |
| `toggleConfigNav` | 配置导航开关 | `Ctrl+Shift+C` | `useAppStore.getState().toggleConfigPanel()` |
| `toggleFileNav` | 文件导航开关 | `Ctrl+Shift+E` | `useAppStore.getState().toggleFileTree()` |
| `openSettings` | 打开设置 | `Ctrl+,` | `useAppStore.getState().openSettingsDialog()` |
| `newTerminal` | 新建终端 | `Ctrl+Shift+N` | 经 hotkeys.ts 的**模块级执行器注册表**执行,App 挂载时注册为 `handleStartBlankTerminal('powershell')` |
| `closeTab` | 关闭当前标签 | `Ctrl+W` | `closeTerminal(activeSessionId)`(invoke `close_terminal`),与 TabNav/TerminalTabBar 关闭逻辑一致 |
| `autocomplete` | 命令补全面板 | `Alt+/` | 现有终端内 capture 逻辑(TerminalInstance 本地处理,不经分发器) |

`autocomplete` 特殊:由 TerminalInstance 的 `handleKeyDown` 本地拦截(面板 toggle),不进入 window 分发器,避免与终端输入冲突。

## 存储

- `AppSettings`(frontend,client_data/localStorage)新增:
  ```ts
  hotkeys: Partial<Record<HotkeyActionId, string>>;
  ```
- 删除上一轮加入的 `autocompleteHotkey` 字段(未提交,无迁移负担),补全快捷键改从 `hotkeys.autocomplete` 读取。
- 默认值集中在 `src/services/hotkeys.ts` 的 `DEFAULT_HOTKEYS`;读取走 `getHotkey(action)`:`hotkeys[action] ?? DEFAULT_HOTKEYS[action]`,空字符串视为禁用该动作。
- 复用 `utils/settings.ts` 现有 `formatHotkey` / `matchesHotkey` / `normalizeHotkeyKey` 助手。

## 分发机制

### 应用内快捷键

- 新文件 `src/services/hotkeys.ts`:
  - `HotkeyActionId` 类型、`HOTKEY_ACTIONS` 元数据表(id、名称、默认键)
  - **执行器注册表**:模块级 `actionExecutors: Partial<Record<HotkeyActionId, () => void>>` + `registerHotkeyAction(id, fn)`。store 可直接执行的简单动作(导航开关、打开设置)在 hotkeys.ts 内联实现;依赖组件上下文的动作(`newTerminal` → App 的 `handleStartBlankTerminal`)由 App 挂载时注册
  - `initAppHotkeys()`:App 挂载后注册 window + document keydown 监听(F11 的现有监听保持不变、不回归;新分发器用独立的 `_tbHotkeyHandled` 去重标记)。命中动作 → 执行 + `preventDefault`
  - 录制中屏蔽:分发前检查 `document.activeElement?.closest('.hotkey-recorder.recording')`,命中则跳过
- 分发器每次 keydown 实时读 `getAppSettings()`(有缓存,开销可忽略),设置变更立即生效,无需刷新监听

### 终端内按键放行

- `TerminalInstance.attachCustomKeyEventHandler` 目前只放行 F11/F2,泛化为:读设置中的应用快捷键集合(不含 `autocomplete`,它由本地 handleKeyDown 拦截),命中的键返回 false 放行(xterm 不消费),事件冒泡到 window 分发器
- 注意:TerminalInstance 的 capture-phase `handleKeyDown` 中,补全面板(Alt+/)判断在前,不受影响

### 全局快捷键(呼出程序)

- Rust:`Cargo.toml` 加 `tauri-plugin-global-shortcut = "2"`;`lib.rs` `.plugin(tauri_plugin_global_shortcut::Builder::new().build())`;`capabilities/default.json` 加 `"global-shortcut:default"`
- 前端:`package.json` 加 `@tauri-apps/plugin-global-shortcut`
- `initAppHotkeys()` 中:`register('showWindow', handler)`;handler 中 `show() + unminimize() + setFocus()`(capabilities 已含这三个 window 权限,无需新 Rust 命令)
- 设置变更:`app-settings-changed` 监听中,若 `hotkeys.showWindow` 变化 → `unregister('showWindow')` + 重新 `register`;空字符串 → 仅 unregister
- 注册失败(键位被其他程序占用):`console.error` + `showToast('全局快捷键注册失败,可能被其他程序占用', 'error')`
- 窗口隐藏时 WebView 仍在运行(托盘模式仅 hide 不销毁),事件可正常收到;应用完全退出后无需快捷键

## Rust 侧改动(最小)

无新命令、无新状态。仅插件接入:

1. `Cargo.toml`:`tauri-plugin-global-shortcut = "2"`
2. `lib.rs`:插件 Builder 注册
3. `capabilities/default.json`:permissions 数组加 `"global-shortcut:default"`

## 设置 UI(行为设置页「快捷键」分区)

- 从 BehaviorSettings 现有录制实现提取 `HotkeyRecorder` 组件(显示当前键 + 点击录制 + Esc 取消 + window 捕获拦截 Esc 的逻辑一并移入)
- 「快捷键」分区:遍历 `HOTKEY_ACTIONS`,每行:动作名 + HotkeyRecorder + 说明文案(showWindow 标注"全局,后台也可用")
- 重复提示:保存新键时检查是否与其他动作重复,重复则在对应行显示提示"与「X」重复"(不阻止保存)
- 应用内快捷键不支持裸修饰键/无修饰键组合(沿用 formatHotkey 约束);全局快捷键同理(global-shortcut 要求有修饰键)

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/services/hotkeys.ts` | 新建:动作表、默认键、分发器、全局注册 |
| `src/utils/settings.ts` | `hotkeys` 字段替换 `autocompleteHotkey` |
| `src/App.tsx` | 挂载 `initAppHotkeys()`;newTerminal 动作接入 |
| `src/components/terminal/TerminalInstance.tsx` | attachCustomKeyEventHandler 泛化放行;补全从 `hotkeys.autocomplete` 读取 |
| `src/components/settings/BehaviorSettings.tsx` | 提取 HotkeyRecorder + 快捷键分区列表 |
| `src/components/settings/HotkeyRecorder.tsx`(新) | 录制组件 |
| `src-tauri/Cargo.toml` / `lib.rs` / `capabilities/default.json` | 插件接入 |
| `package.json` | `@tauri-apps/plugin-global-shortcut` |

## 验证

- `npx tsc --noEmit`、`cargo check`
- `npm run tauri dev` 手动:
  1. 默认键逐个生效(配置/文件导航开关、Ctrl+, 设置、Ctrl+Shift+N 新建、Ctrl+W 关标签、Alt+/ 补全)
  2. Ctrl+Alt+T:窗口最小化/隐藏到托盘后按之,窗口恢复并聚焦
  3. 设置页录制修改(如 Ctrl+W → Ctrl+Shift+X)后立即生效
  4. 录制与其他动作重复时出现提示
  5. 录制期间按 Ctrl+W 不会真正关闭标签(屏蔽生效)
  6. 全局快捷键改为被占用组合(如 Ctrl+C 会被注册器拒绝或冲突)时 toast 提示

## 边界与决策

- 动作间快捷键重复:仅提示不阻止(沿用"不检测冲突、录了生效"决策,但动作间重复给出可见提示)
- F11/F2 维持硬编码,不纳入本系统(避免回归)
- 全局快捷键未设置(空串)时不注册;应用启动到前端初始化完成的 1-2 秒内全局快捷键不可用(可接受)
- 焦点在 input/textarea(非终端)时的应用快捷键不做额外过滤——除录制中屏蔽外,全局分发;设置弹窗输入框中按 Ctrl+, 会再开设置,属可接受行为
