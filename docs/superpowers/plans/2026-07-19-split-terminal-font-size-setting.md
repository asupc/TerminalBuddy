# 分屏终端字号设置实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `TerminalInstance` 顶部硬编码的 `SPLIT_FONT_SIZE` 替换为用户在「设置 → 行为 → 终端字号」里可配的三档数值（off / 2x1 / 2x2），默认值 14/12/11 保持无视觉回归。

**Architecture:** 在 `AppSettings` 新增三个数字字段；`BehaviorSettings` 末尾追加一个 section，三个 number 输入框复用 `updateSetting` 走 `saveAppSettings` + `app-settings-changed`；`TerminalInstance` 把硬编码映射换成 `getAppSettings()` 实时读取并加监听，依赖数组里追加三个数值让尺寸能即时同步。

**Tech Stack:** React 18, TypeScript, Zustand（仅读 store 已有 shape）, xterm.js（仅 `term.options.fontSize` 写入），localStorage via `clientData`（沿用 `saveAppSettings`）

## Global Constraints

- 所有用户可见文本用中文；代码标识符保持英文。
- 默认值严格保持 14 / 12 / 11，禁止改动以避免视觉回归。
- 取值范围 `[8, 32]` px，写入 + 读取两层 clamp 兜底。
- 项目内无自动化测试（`CLAUDE.md` 明示）。以 `npx tsc --noEmit` 作为任务间自动化门禁；最终手动验证走 spec §8 清单。
- 不动 Tauri 后端命令、不改 `Profile`、不引入新依赖。
- 不破坏「分屏/单屏切换不重新挂载 xterm」的现有 invariant。

---

### Task 1: AppSettings 新增三档字段

**Files:**
- Modify: `terminal-buddy/src/utils/settings.ts`（接口定义 + `DEFAULT_SETTINGS`）

**Interfaces:**
- Produces: `AppSettings` 增加 `terminalFontSizeOff: number` / `terminalFontSize2x1: number` / `terminalFontSize2x2: number`
- Consumes: 无（纯数据模型）

- [ ] **Step 1: 记录基线类型检查状态**

```bash
cd terminal-buddy && npx tsc --noEmit
```

预期：仅 0 个错误（与改动前一致）。若已经有错误，记录并先排查，不归本任务负责。

- [ ] **Step 2: 在 `AppSettings` 接口末尾追加字段**

打开 `terminal-buddy/src/utils/settings.ts`，定位到接口最后一行（`listSelectionBorderWidth: number;` 之后），在闭合花括号 `}` 之前添加：

```ts
  terminalFontSizeOff: number;
  terminalFontSize2x1: number;
  terminalFontSize2x2: number;
```

- [ ] **Step 3: 在 `DEFAULT_SETTINGS` 同步默认值**

在同一文件 `DEFAULT_SETTINGS` 对象里，紧接 `listSelectionBorderWidth: 0,` 之后追加：

```ts
  terminalFontSizeOff: 14,
  terminalFontSize2x1: 12,
  terminalFontSize2x2: 11,
```

- [ ] **Step 4: 类型检查并确认无新错误**

```bash
cd terminal-buddy && npx tsc --noEmit
```

预期：与 Step 1 一致的 0 错误。三个新字段均为 `number`，无消费者会因此类型失败。

- [ ] **Step 5: 提交**

```bash
git add terminal-buddy/src/utils/settings.ts
git commit -m "[设置] AppSettings 新增分屏终端三档字号字段"
```

---

### Task 2: BehaviorSettings 新增「终端字号」section

**Files:**
- Modify: `terminal-buddy/src/components/settings/BehaviorSettings.tsx`（在「列表选中样式」section 之后追加新 section）

**Interfaces:**
- Consumes: `AppSettings.terminalFontSizeOff / 2x1 / 2x2`（来自 Task 1）
- Produces: 三个 number 输入框，三层 clamp（HTML 原生 min/max + onChange sanitize 双保险）

- [ ] **Step 1: 定位插入位置**

读 `terminal-buddy/src/components/settings/BehaviorSettings.tsx`，找到「列表选中样式」section 的结尾：包含 `<p className="settings-desc">连接导航与文件导航中，被选中列表条目的配色（上方为实时预览）</p>` 的那个 `settings-section` 闭合 `</div>`。

- [ ] **Step 2: 复制粘贴新 section**

在该 `</div>` 之后、`</div>`（顶层 settings-general 闭合）之前粘贴：

```tsx
      <div className="settings-section">
        <label className="settings-label">终端字号</label>
        <div className="settings-grid-2col">
          {(
            [
              { key: 'terminalFontSizeOff', label: '单屏', defaultValue: 14 },
              { key: 'terminalFontSize2x1', label: '一分二（2×1）', defaultValue: 12 },
              { key: 'terminalFontSize2x2', label: '四分屏（2×2）', defaultValue: 11 },
            ] as const
          ).map((row) => {
            const value = settings[row.key];
            return (
              <div key={row.key} className="settings-number-row">
                <span className="settings-number-label">{row.label}</span>
                <input
                  type="number"
                  min={8}
                  max={32}
                  step={1}
                  value={value}
                  onChange={(e) => {
                    const raw = Number(e.target.value);
                    const next = Number.isFinite(raw)
                      ? Math.max(8, Math.min(32, Math.round(raw)))
                      : row.defaultValue;
                    updateSetting(row.key, next);
                  }}
                />
                <span className="settings-number-unit">px</span>
              </div>
            );
          })}
        </div>
        <p className="settings-desc">
          单屏 / 一分二 / 四分屏三种模式下使用的 xterm 字号；可保留默认 14 / 12 / 11，无视觉变化
        </p>
      </div>
```

- [ ] **Step 3: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

预期：0 个新增错误。若 `settings-grid-2col` / `settings-number-row` / `settings-number-label` / `settings-number-unit` 尚未在 CSS 中存在，会仅是 unused class warning（不影响功能）；后续 Step 4 即可补 CSS。

- [ ] **Step 4: 补 CSS（按需）**

读 `terminal-buddy/src/components/SettingsPage.css`，搜索是否存在 `.settings-grid-2col`、`.settings-number-row`、`.settings-number-label`、`.settings-number-unit` 类：

```bash
grep -E "settings-grid-2col|settings-number-row|settings-number-label|settings-number-unit" terminal-buddy/src/components/SettingsPage.css
```

若四个均不存在，在该文件末尾追加：

```css
.settings-grid-2col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.settings-number-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-number-label {
  flex: 0 0 110px;
  color: var(--text-secondary, #aaa);
}

.settings-number-row input[type='number'] {
  width: 64px;
  padding: 2px 6px;
}

.settings-number-unit {
  color: var(--text-secondary, #aaa);
  font-size: 12px;
}
```

> 颜色 token 若已有 `--text-secondary` 则按项目内的现有变量写；没有就保留 fallback。**不要为了色彩一致性自行扩展主题**。

- [ ] **Step 5: 提交**

```bash
git add terminal-buddy/src/components/settings/BehaviorSettings.tsx terminal-buddy/src/components/SettingsPage.css
git commit -m "[设置] 行为页新增终端字号 (off/2x1/2x2) 配置"
```

---

### Task 3: TerminalInstance 消费新设置并实时同步

**Files:**
- Modify: `terminal-buddy/src/components/TerminalInstance.tsx`（顶部位移硬编码、新增 clampFontSize、监听 `app-settings-changed`、更新 splitMode effect 与 inline ghost）

**Interfaces:**
- Consumes: `AppSettings.terminalFontSizeOff / 2x1 / 2x2`（来自 Task 1）
- Produces: `term.options.fontSize` 在以下场景下被同步刷新：
  - xterm 初始化（`initTerminal`）
  - `splitMode` 切换
  - `app-settings-changed` 事件触发（用户在设置面板改了字号）

- [ ] **Step 1: 替换顶部硬编码**

在 `terminal-buddy/src/components/TerminalInstance.tsx` 顶部（约 24-38 行），把：

```ts
// 终端基础字号。分屏模式下按比例缩小:2x1 → 0.9、2x2 → 0.8、单屏 → 1.0。
const BASE_FONT_SIZE = 14;
const FLOATING_MENU_MARGIN = 8;
const RIGHT_CLICK_PASTE_DEDUPE_MS = 750;
const RIGHT_CLICK_NATIVE_PASTE_SUPPRESS_MS = 1200;
// 分屏按格子缩小字号；直接定义目标字号而非浮点缩放系数，避免 14×0.9=12.6→13
// 这种非主流字号（等宽字形度量/ClearType 与 14px 差异大，视觉上像换了字体）。
const SPLIT_FONT_SIZE: Record<'off' | '2x1' | '2x2', number> = {
  off: BASE_FONT_SIZE,
  '2x1': 12,
  '2x2': 11,
};
```

替换为：

```ts
const FLOATING_MENU_MARGIN = 8;
const RIGHT_CLICK_PASTE_DEDUPE_MS = 750;
const RIGHT_CLICK_NATIVE_PASTE_SUPPRESS_MS = 1200;
const CODEX_INPUT_BACKGROUND_LIGHT = '48;2;244;244;244';
const CODEX_INPUT_BACKGROUND_DARK = '48;2;57;57;57';
const CODEX_INPUT_BACKGROUND_FALLBACK_DARK = '48;2;41;41;41';

const SPLIT_FONT_SIZE_FALLBACK: Record<'off' | '2x1' | '2x2', number> = {
  off: 14,
  '2x1': 12,
  '2x2': 11,
};

function clampFontSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(8, Math.min(32, Math.round(value)));
}

function resolveSplitFontSize(
  splitMode: 'off' | '2x1' | '2x2',
  settings: { terminalFontSizeOff: number; terminalFontSize2x1: number; terminalFontSize2x2: number },
): number {
  const fallback = SPLIT_FONT_SIZE_FALLBACK[splitMode];
  if (splitMode === 'off') return clampFontSize(settings.terminalFontSizeOff, fallback);
  if (splitMode === '2x1') return clampFontSize(settings.terminalFontSize2x1, fallback);
  return clampFontSize(settings.terminalFontSize2x2, fallback);
}
```

⚠️ 注意：原代码段顶部还包含三个 `CODEX_INPUT_BACKGROUND_*` 常量；**只删除 `BASE_FONT_SIZE` 与 `SPLIT_FONT_SIZE` 那两条**，CODEX 常量保留。核对最终顶部块：

```ts
const FLOATING_MENU_MARGIN = 8;
const RIGHT_CLICK_PASTE_DEDUPE_MS = 750;
const RIGHT_CLICK_NATIVE_PASTE_SUPPRESS_MS = 1200;
const CODEX_INPUT_BACKGROUND_LIGHT = '48;2;244;244;244';
const CODEX_INPUT_BACKGROUND_DARK = '48;2;57;57;57';
const CODEX_INPUT_BACKGROUND_FALLBACK_DARK = '48;2;41;41;41';

const SPLIT_FONT_SIZE_FALLBACK: Record<'off' | '2x1' | '2x2', number> = {
  off: 14,
  '2x1': 12,
  '2x2': 11,
};

function clampFontSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(8, Math.min(32, Math.round(value)));
}

function resolveSplitFontSize(
  splitMode: 'off' | '2x1' | '2x2',
  settings: { terminalFontSizeOff: number; terminalFontSize2x1: number; terminalFontSize2x2: number },
): number {
  const fallback = SPLIT_FONT_SIZE_FALLBACK[splitMode];
  if (splitMode === 'off') return clampFontSize(settings.terminalFontSizeOff, fallback);
  if (splitMode === '2x1') return clampFontSize(settings.terminalFontSize2x1, fallback);
  return clampFontSize(settings.terminalFontSize2x2, fallback);
}
```

- [ ] **Step 2: 修改 `initTerminal` 内的初始 `fontSize`**

在 `TerminalInstance.tsx` 里定位到这段（约 928-948 行）：

```ts
const terminal = new Terminal({
  cursorBlink: false,
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  cursorWidth: 1,
  fontSize: SPLIT_FONT_SIZE[splitModeRef.current],
  ...
});
```

把 `fontSize: SPLIT_FONT_SIZE[splitModeRef.current],` 改为：

```ts
fontSize: resolveSplitFontSize(splitModeRef.current, getAppSettings()),
```

并在文件里 `clampFontSize` 之后的所有位置，如果已经引用过 `getAppSettings`（已有 `import { getAppSettings } from '../utils/settings';`），无需添加新 import。

- [ ] **Step 3: 新增 `fontSizeSettings` 本地 state + `app-settings-changed` 监听**

在 `TerminalInstance` 组件函数顶部、其它 `useState`/`useRef` 声明附近，新增：

```ts
  const [fontSizeSettings, setFontSizeSettings] = useState(() => {
    const s = getAppSettings();
    return {
      terminalFontSizeOff: s.terminalFontSizeOff,
      terminalFontSize2x1: s.terminalFontSize2x1,
      terminalFontSize2x2: s.terminalFontSize2x2,
    };
  });
```

并在 main useEffect（依赖 `[terminalId]`，即 init 容器）**之外**新增一个独立 effect，挂在 main useEffect 同一组件层：

```ts
  useEffect(() => {
    const sync = () => {
      const s = getAppSettings();
      setFontSizeSettings({
        terminalFontSizeOff: s.terminalFontSizeOff,
        terminalFontSize2x1: s.terminalFontSize2x1,
        terminalFontSize2x2: s.terminalFontSize2x2,
      });
    };
    window.addEventListener('app-settings-changed', sync);
    return () => window.removeEventListener('app-settings-changed', sync);
  }, []);
```

依赖为空数组 → 组件 mount 时挂一次，unmount 时解绑。

- [ ] **Step 4: 修改 splitMode 字号同步 useEffect**

定位到约 1886-1896 行：

```ts
  // 分屏模式下缩小终端字号(2x1→12px)，退出分屏恢复原值。
  // 这里只改字号,不立即 fit；TerminalPanel 会在布局稳定后派发带版本号的
  // TERMINAL_RESIZE_EVENT，避免快速连点时把 2x1/2x2/off 的中间尺寸同步给 PTY。
  useEffect(() => {
    if (!visible) return;
    const term = xtermRef.current;
    if (!term) return;
    const newSize = SPLIT_FONT_SIZE[splitMode];
    if (term.options.fontSize === newSize) return;
    term.options.fontSize = newSize;
  }, [splitMode, visible]);
```

替换为：

```ts
  // 分屏/单屏字号跟随设置：splitMode 切换或用户在设置面板改值都会重新评估。
  // 这里只改字号,不立即 fit；TerminalPanel 会在布局稳定后派发带版本号的
  // TERMINAL_RESIZE_EVENT，避免快速连点时把 2x1/2x2/off 的中间尺寸同步给 PTY。
  useEffect(() => {
    if (!visible) return;
    const term = xtermRef.current;
    if (!term) return;
    const newSize = resolveSplitFontSize(splitMode, fontSizeSettings);
    if (term.options.fontSize === newSize) return;
    term.options.fontSize = newSize;
  }, [
    splitMode,
    visible,
    fontSizeSettings.terminalFontSizeOff,
    fontSizeSettings.terminalFontSize2x1,
    fontSizeSettings.terminalFontSize2x2,
  ]);
```

- [ ] **Step 5: 更新内联 ghost 字号读取**

定位到约 2129-2133 行：

```tsx
        <div
          className="autocomplete-inline-ghost"
          style={{
            left: autocomplete.inlineX,
            top: autocomplete.inlineY,
            height: autocomplete.inlineHeight,
            lineHeight: `${autocomplete.inlineHeight}px`,
            fontSize: `${SPLIT_FONT_SIZE[splitMode]}px`,
          }}
```

把 `fontSize: `${SPLIT_FONT_SIZE[splitMode]}px`,` 改为：

```tsx
            fontSize: `${resolveSplitFontSize(splitMode, getAppSettings())}px`,
```

- [ ] **Step 6: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

预期：0 新增错误。若仍有 `SPLIT_FONT_SIZE` 残留引用（只在 main useEffect 内或 inline ghost 处），tsc 会把它当未定义报错——回到 Step 3 / Step 5 复查。

- [ ] **Step 7: 提交**

```bash
git add terminal-buddy/src/components/TerminalInstance.tsx
git commit -m "[终端] 分屏/单屏字号改读设置,响应 app-settings-changed"
```

---

### Task 4: 手动验证 + 基线回归

**Files:**
- Read-only: 上述三个文件 + 运行 `npm run dev` 或 `npm run tauri dev`

**Goal:** 跑一遍 spec §8 清单，确认无回归、新功能符合预期。

- [ ] **Step 1: 启动开发态**

```bash
cd terminal-buddy && npm run dev
```

或需要 Tauri 窗口：

```bash
cd terminal-buddy && npm run tauri dev
```

任选其一。等待 Tauri 窗口或 Vite (1420) 起来。

- [ ] **Step 2: 验证默认值无回归**

新开一个终端，进入 2x1 → 2x2 → off。目视：三档字号看起来还是 14 / 12 / 11（与改动前一致）。若发现 11/12/14 偏差，逐个排查默认值或 clamp 逻辑。

- [ ] **Step 3: 验证设置面板可改**

打开「设置 → 行为」滑到底，看到「终端字号」section。把 2x1 改为 13，关掉面板。当前 2x1 终端字号应即时变成 13，其他模式不变。

- [ ] **Step 4: 验证越界夹紧**

把 2x1 改成 999 → 输入框 max 阻止；强行粘贴 / 改值 → onChange sanitize 仍夹到 32。
把 2x1 改成 0 → 夹到 8。
清空（空串）→ 回退到默认值（2x1 的默认 12）。

- [ ] **Step 5: 验证 localStorage 落盘与重启保留**

切换几次字号，关闭并重启程序。打开设置 → 行为 → 终端字号，应保留最后的状态。

- [ ] **Step 6: 验证「设置面板开着时改值即时生效」**

保持设置面板打开，改一个值（不关），切到终端里——正在运行的终端字号应即时跟随。可多档来回切换、增减。

- [ ] **Step 7: 验证 PTY 不被影响**

进 2x1，运行 `dir` 或 `ls`（取决于 OS），输出字符仍能完整保留；切回 off，输出不丢。

- [ ] **Step 8: 验证 TerminalPanel 无回归**

打开 4-5 个终端，做以下操作各 1 次：
- 拖入分屏格；
- 拖动交换两个分屏格；
- 关闭其中一个分屏格（X 按钮）；
- 退出分屏；

每步不应有错位、字号错乱、`pane-header` 漂移。

- [ ] **Step 9: 最终提交（如有临时 fix）**

若 1-8 步中发现 bug 并修了：

```bash
git add -A
git commit -m "[终端] 修正分屏字号迁移后回归 (manual verify)"
```

若无修复，跳过本步。

---

## 范围之外（明确不做）

- 不做 Profile 字段扩展、不做 Tauri IPC 改动、不增加后端命令。
- 不做 DPI 自适应、不做 slider 控件、不做预设。
- 不改 `BehaviorSettings` 现有 section 的布局、不动 `listSelectionStyle` / `breathingLight` / Claude 通知等无关项。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| `getAppSettings()` 在 effect 中读到陈旧值 | `saveAppSettings` 已经写入内存并派发事件，clampFontSize 兜底非数字场景 |
| 修改后某个旧组件仍引到 `SPLIT_FONT_SIZE` 已被改名 | Step 6 类型检查会发现，tsc 不通过就不能提交 |
| 切 splitMode 时字号闪烁 | xterm 改 fontSize 是同步赋值的瞬时重排，不引入额外 layout 抖动；现有 `TERMINAL_RESIZE_EVENT` 仍负责 fit |
| 用户清掉 localStorage 后回落默认值 | `{ ...DEFAULT_SETTINGS, ..._cachedSettings }` 已合并；新字段走同样的 fallback 路径 |
| 新增 CSS 类名冲突 | Step 4 已 grep 确认；不存在才追加 |
