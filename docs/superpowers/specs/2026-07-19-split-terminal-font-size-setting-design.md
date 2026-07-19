# 分屏终端字号设置

- 日期：2026-07-19
- 范围：`terminal-buddy/src/` 前端设置模型 + 行为设置页 + 终端实例消费者
- 关联：分屏布局模式（`off` / `2x1` / `2x2`）字号硬编码的解耦

## 1. 背景与目标

`TerminalInstance.tsx` 顶部硬编码：

```ts
const SPLIT_FONT_SIZE: Record<'off' | '2x1' | '2x2', number> = {
  off: 14,
  '2x1': 12,
  '2x2': 11,
};
```

三档字号随分屏模式固定，用户无法按需调整。常见诉求：

- 屏幕小或高 DPI 时 12px 仍偏大，希望 2x1 用 10px。
- 2x2 时 11px 信息密度仍不够，希望 9px。
- 14px 在 4K 屏偏小，希望单屏用 16px。

目标是让用户在「行为设置」里直接调三档字号，无回归地替换硬编码。

## 2. 数据模型

### 2.1 `AppSettings` 新增字段

`utils/settings.ts` 在 `AppSettings` 接口末尾追加：

```ts
terminalFontSizeOff: number;   // 默认 14
terminalFontSize2x1: number;   // 默认 12
terminalFontSize2x2: number;   // 默认 11
```

并在 `DEFAULT_SETTINGS` 同步三行。`getAppSettings()` 已用 `{ ...DEFAULT_SETTINGS, ..._cachedSettings }` 合并，旧数据缺字段时自动回退默认值，不需要迁移代码。

### 2.2 取值范围与校验

写入路径：
- 控件层 `<input type="number" min={8} max={32} step={1}>` 提供浏览器原生夹紧。
- `updateSetting` 在拿到 `raw` 后再执行 `Math.max(8, Math.min(32, Number(raw) || 默认值))` 作为安全网，覆盖非数字、空串、负数等情况。

读取路径：
- `TerminalInstance` 从 `getAppSettings()` 读出后再 clamp 到 `[8, 32]`，抵御 localStorage 被外部修改。

## 3. 设置 UI

### 3.1 位置

`components/settings/BehaviorSettings.tsx`，紧跟在「列表选中样式」section 之后追加新的 `<div className="settings-section">`，标题「终端字号」。这样所有行为类开关集中在同一个 section 群组，不需要新建独立文件。

### 3.2 控件

三行结构，每行：

```
<label>单屏字号</label>
<input type="number" min={8} max={32} step={1}
  value={settings.terminalFontSizeOff}
  onChange={(e) => updateSetting('terminalFontSizeOff', sanitize(...))}
/>
<span>px</span>
```

三个 label：
- 单屏字号 → `terminalFontSizeOff`
- 一分二（2×1）字号 → `terminalFontSize2x1`
- 四分屏（2×2）字号 → `terminalFontSize2x2`

底部 `p.settings-desc` 一句提示：「切换分屏模式时按上表取值；可保留默认 14 / 12 / 11 无视觉变化」。

`updateSetting` 由 `SettingsPage` 现有的合并 + `saveAppSettings` 流程驱动，写盘同时派发 `app-settings-changed`，终端实例自己订阅即可，不改父组件。

## 4. 运行时消费

### 4.1 `TerminalInstance.tsx` 改动

去掉顶部 `const SPLIT_FONT_SIZE: Record<...>`，把对应读取改为：

```ts
function clampFontSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(8, Math.min(32, Math.round(value)));
}

const settings = getAppSettings();
const splitFontSize = {
  off: clampFontSize(settings.terminalFontSizeOff, 14),
  '2x1': clampFontSize(settings.terminalFontSize2x1, 12),
  '2x2': clampFontSize(settings.terminalFontSize2x2, 11),
}[splitMode];
```

新增本地 state `fontSizes`，由 `app-settings-changed` 事件驱动刷新：

```ts
useEffect(() => {
  const refresh = () => setFontSizes(getAppSettings());
  refresh();
  window.addEventListener('app-settings-changed', refresh);
  return () => window.removeEventListener('app-settings-changed', refresh);
}, [terminalId]);
```

原「切 splitMode 时改字号」的 `useEffect`（`TerminalInstance.tsx:1889-1896`）依赖数组里追加三个值，使改字号后下一帧同步：

```ts
useEffect(() => {
  if (!visible) return;
  const term = xtermRef.current;
  if (!term) return;
  const sizes = getAppSettings();
  const newSize = clampFontSize(
    { off: sizes.terminalFontSizeOff, '2x1': sizes.terminalFontSize2x1, '2x2': sizes.terminalFontSize2x2 }[splitMode],
    splitMode === 'off' ? 14 : splitMode === '2x1' ? 12 : 11,
  );
  if (term.options.fontSize === newSize) return;
  term.options.fontSize = newSize;
}, [splitMode, visible, fontSizes.terminalFontSizeOff, fontSizes.terminalFontSize2x1, fontSizes.terminalFontSize2x2]);
```

xterm 切字号后自动重排当前显示，无需手动 `fit()`；下一次 `TERMINAL_RESIZE_EVENT` 派发时仍会再 fit 一次以刷新 PTY 尺寸。

内联补全小提示字号（`TerminalInstance.tsx:2129-2133`）同步改为查找同一张表，保证在分屏里 ghost 提示跟终端主字号一致。

### 4.2 `TerminalPanel.tsx` 不需要改动

它已经在 `app-settings-changed` 上把 `settings` state 重读一次（`TerminalPanel.tsx:97-111`），本次新增的字段对它不可见，不影响。

## 5. 数据流

```
用户在 BehaviorSettings 把 2x1 字号改为 13
    └─ updateSetting('terminalFontSize2x1', 13)
        └─ SettingsPage 合并 settings -> saveAppSettings()
            ├─ writeClientData('settings', JSON.stringify(settings))   // 落盘
            └─ window.dispatchEvent('app-settings-changed')
                ├─ TerminalPanel 自身重读 settings（无变化，无需重渲染）
                └─ 每个 TerminalInstance 的 useEffect 触发
                    ├─ setFontSizes(getAppSettings())                  // state 更新
                    └─ 依赖 [splitMode, visible, fontSizes.*] 的 effect 重跑
                        └─ term.options.fontSize = 13                   // xterm 自动重绘
                            └─ 下一次 TERMINAL_RESIZE_EVENT 再 fit 一次
```

面板开着的时候改值，因为走的是同一条 `saveAppSettings` + 事件路径，终端也能即时跟随，无需先关面板。

## 6. 边界与错误处理

| 情况 | 表现 | 处理 |
|---|---|---|
| 旧版本 localStorage 缺字段 | 三档回落到默认值 | `{ ...DEFAULT, ..._cached }` 已合并 |
| 用户输入 `0` / `100` / 空串 | 控件层被浏览器夹紧，写入层 clamp 兜底 | `Math.max(8, Math.min(32, Number(raw) \|\| 默认值))` |
| localStorage 写入失败 | 设置改不了，但终端不会崩 | `writeClientData` 已经在 try/catch；本次不动它 |
| 事件触发后 xterm 已被 dispose | `xtermRef.current === null` | useEffect 已 `if (!term) return` 防御 |
| 改字号与切 splitMode 同时发生 | 两次 effect 都跑，最终取最后一个 commit 的尺寸 | 不构成问题，fontSize 是幂等赋值 |

## 7. 兼容性 / 回归

- 默认值 14 / 12 / 11 与现状完全一致，**未改动任何一行现有行为**——用户即便不打开新设置项也察觉不到变化。
- 字段全部在客户端（localStorage via `clientData`），不增减 Tauri 命令、不动后端。
- 不动 `Profile` 数据结构、不动 `Profile` 的 `windowSize` / `colorTheme` 等既有字段。
- 不引入新依赖。

## 8. 手动验证清单

仓库没有自动化测试，按以下顺序人工跑一遍：

1. 干净安装（清掉 localStorage）→ 默认 14 / 12 / 11，开分屏目视对比无回归。
2. 打开「设置 → 行为 → 终端字号」，把 2x1 改为 13，关掉面板：当前 2x1 终端立即变化，其他不动。
3. 把 2x1 改 999 / 0 / -5：UI 不允许越界，写入兜底夹到 32。
4. 单屏 off 改 18：单屏生效；进入 2x1 仍然用 2x1 的设置；不进分屏。
5. 关闭并重开程序：设置保留（`writeClientData` 已经会写盘）。
6. 在 2x2 里启动一个新终端，先在设置里改 2x2 -> 10，新终端继承新尺寸（新建时 `SPLIT_FONT_SIZE` 已经按最新设置取值）。
7. 切分屏模式 off → 2x1 → 2x2 → off：每一步字号都跟随切换后的设置。
8. 终端编辑器侧（`<TextEditor>`）与本设置无关，确认不被波及。

## 9. 范围之外（明确不做）

- 不引入「按 DPI 自动换算」或「按窗口宽度自适应」。
- 不做「等宽字体选择」「行距」「字符间距」这类额外排版偏好。
- 不提供导入/导出设置文件、不提供配置同步（沿用现有 `clientData` 机制）。
- 不改 xterm.js 之外的任何渲染相关代码，不动 `WebglAddon`、`FitAddon` 装配逻辑。
- 不改 Tauri 后端命令、不需要 IPC 新字段。
