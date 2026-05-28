# 移动端终端特殊键功能栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MobileInputBar 组件中增加一行功能键按钮，使移动端用户可以通过触屏发送 Tab、Ctrl+C、Esc、方向键等特殊按键。

**Architecture:** 单文件修改。在现有 MobileInputBar 组件内新增 `ctrlActive` 状态和 `ctrlTimerRef` 定时器，新增 `handleKeyBtn` 统一处理功能键点击事件，在 JSX 中增加第二行功能键按钮 UI。

**Tech Stack:** React 18, TypeScript, inline styles (与现有 MobileInputBar 一致)

**Design Doc:** `docs/superpowers/terminal-management/移动端终端特殊键-design.md` — 业务需求来源；每个 task 的验收标准从该文档提取

---

### Task 1: 添加 Ctrl 锁定状态与功能键处理逻辑

**Skills:** _none_ — 单文件纯逻辑修改，无需领域 skill

**Files:**
- Modify: `terminal-buddy/web/src/components/MobileInputBar.tsx:24-48`

**Acceptance Criteria:**

- [ ] C1: 组件新增 `ctrlActive` state（boolean，默认 false）和 `ctrlTimerRef`（useRef）
- [ ] C2: `handleKeyBtn('Ctrl')` 首次调用时 `ctrlActive` 变为 true 并启动 5 秒定时器；再次调用时取消
- [ ] C3: `ctrlActive` 为 true 时点击非 Ctrl/↑/↓ 按钮，发送 Ctrl+组合码（如 C → `\x03`），然后 `ctrlActive` 恢复 false
- [ ] C4: 5 秒超时后 `ctrlActive` 自动恢复 false

- [ ] **Step 1: 在组件中新增状态和 Ctrl 处理逻辑**

在 `MobileInputBar` 组件函数体开头（`useState` 区域）新增两个声明：

```ts
const [ctrlActive, setCtrlActive] = useState(false);
const ctrlTimerRef = useRef<NodeJS.Timeout | null>(null);
```

在 `handleSubmit` 之后、`handleKeyDown` 之前新增 `handleKeyBtn` 函数：

```ts
const clearCtrlTimer = useCallback(() => {
  if (ctrlTimerRef.current) {
    clearTimeout(ctrlTimerRef.current);
    ctrlTimerRef.current = null;
  }
}, []);

const handleKeyBtn = useCallback((key: string) => {
  // ↑↓ — 历史切换（浏览器端）
  if (key === 'ArrowUp') {
    const history = historyRef.current;
    if (history.length === 0) return;
    if (historyIdx === -1) {
      draftRef.current = value;
    }
    const next = Math.min(historyIdx + 1, history.length - 1);
    setHistoryIdx(next);
    setValue(history[next]);
    return;
  }
  if (key === 'ArrowDown') {
    if (historyIdx === -1) return;
    const prev = historyIdx - 1;
    if (prev === -1) {
      setHistoryIdx(-1);
      setValue(draftRef.current);
    } else {
      setHistoryIdx(prev);
      setValue(historyRef.current[prev]);
    }
    return;
  }

  // Ctrl — 切换锁定态
  if (key === 'Ctrl') {
    clearCtrlTimer();
    if (ctrlActive) {
      setCtrlActive(false);
      return;
    }
    setCtrlActive(true);
    ctrlTimerRef.current = setTimeout(() => {
      setCtrlActive(false);
      ctrlTimerRef.current = null;
    }, 5000);
    return;
  }

  // Enter
  if (key === 'Enter') {
    if (ctrlActive) {
      onSend('\r');
      setCtrlActive(false);
      clearCtrlTimer();
      return;
    }
    handleSubmit();
    return;
  }

  // Ctrl + 其他键
  if (ctrlActive) {
    const code = key.toUpperCase().charCodeAt(0) - 64; // A=65, Ctrl+A=0x01
    onSend(String.fromCharCode(code));
    setCtrlActive(false);
    clearCtrlTimer();
    return;
  }

  // 普通键直接发送
  const keyMap: Record<string, string> = {
    Tab: '\t',
    Esc: '\x1b',
  };
  onSend(keyMap[key] ?? key);
}, [ctrlActive, historyIdx, value, onSend, handleSubmit, clearCtrlTimer]);
```

- [ ] **Step 2: 清理定时器**

在组件中新增 `useEffect`，在组件卸载时清理 Ctrl 定时器。放在 `handleKeyDown` 的 `useCallback` 之后：

```ts
React.useEffect(() => {
  return () => clearCtrlTimer();
}, [clearCtrlTimer]);
```

- [ ] **Step 3: Commit**

```bash
git add terminal-buddy/web/src/components/MobileInputBar.tsx
git commit -m "[web] MobileInputBar: 添加功能键处理逻辑与 Ctrl 锁定态"
```

---

### Task 2: 添加功能键行 UI

**Skills:** _none_ — 单文件纯 UI 修改

**Files:**
- Modify: `terminal-buddy/web/src/components/MobileInputBar.tsx:85-116`（JSX return 部分）

**Acceptance Criteria:**

- [ ] C1: 外层 `<div>` 改为 `flexDirection: 'column'`，包含输入行和功能键行
- [ ] C2: 功能键行显示 6 个按钮：↑ ↓ Tab Ctrl Esc ⏎，平分宽度
- [ ] C3: `ctrlActive` 为 true 时，Ctrl 按钮背景变为 `#6a6ad5`、文字变为 `#fff`
- [ ] C4: 每个按钮点击时触发 `handleKeyBtn(key)` 对应的按键

- [ ] **Step 1: 修改 JSX return 部分**

将整个 `return` 语句替换为：

```tsx
if (!visible) return null;

const keyButtons = [
  { key: 'ArrowUp', label: '↑' },
  { key: 'ArrowDown', label: '↓' },
  { key: 'Tab', label: 'Tab' },
  { key: 'Ctrl', label: 'Ctrl' },
  { key: 'Esc', label: 'Esc' },
  { key: 'Enter', label: '⏎' },
];

return (
  <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '6px 8px', background: '#16162e',
      borderTop: '1px solid #2a2a4a',
    }}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入命令..."
        style={{
          flex: 1, background: '#12122a', border: '1px solid #2a2a4a',
          borderRadius: 6, color: '#e0e0e0', padding: '8px 10px',
          fontSize: 14, outline: 'none',
        }}
      />
      <button
        onClick={handleSubmit}
        style={{
          width: 36, height: 36, borderRadius: 6, border: 'none',
          background: '#6a6ad5', color: '#fff', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        ↑
      </button>
    </div>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '4px 8px 6px', background: '#16162e',
    }}>
      {keyButtons.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => handleKeyBtn(key)}
          style={{
            flex: 1, height: 30, borderRadius: 4,
            border: '1px solid #2a2a4a',
            background: ctrlActive && key === 'Ctrl' ? '#6a6ad5' : '#1e1e3a',
            color: ctrlActive && key === 'Ctrl' ? '#fff' : '#b0b0b0',
            fontSize: 13, fontWeight: 500,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', transition: 'opacity 0.1s',
            WebkitTapHighlightColor: 'transparent', userSelect: 'none',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  </div>
);
```

- [ ] **Step 2: Commit**

```bash
git add terminal-buddy/web/src/components/MobileInputBar.tsx
git commit -m "[web] MobileInputBar: 添加功能键行 UI 按钮"
```

---

### Task 3: 手动验证

**Skills:** _none_ — 纯验证操作

**Acceptance Criteria:**

- [ ] C1: `npx tsc --noEmit` 通过（无类型错误）
- [ ] C2: 移动端视口下功能键行可见，6 个按钮平分宽度
- [ ] C3: 点击 Tab 按钮发送 `\t`，终端中 Tab 补全正常工作
- [ ] C4: 点击 Ctrl 按钮后高亮，再点击 Esc 发送 `\x1b`（Ctrl+Esc）
- [ ] C5: Ctrl 锁定 5 秒后自动取消

- [ ] **Step 1: TypeScript 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无错误输出

- [ ] **Step 2: 在浏览器中手动验证**

启动开发服务器后在移动端视口（Chrome DevTools 设备模式，iPhone 12）下验证：

1. 功能键行显示在输入框下方，6 个按钮平分宽度
2. 点击 `↑` `↓` 可切换历史命令（输入框内容变化）
3. 点击 `Tab` — 终端收到 Tab 字符
4. 点击 `Ctrl` — 按钮高亮为紫色；5 秒后自动取消
5. Ctrl 高亮状态下点击 `Esc` — 终端收到 Ctrl+Esc；高亮取消
6. Ctrl 高亮状态下点击 Ctrl 自身 — 高亮取消
7. 点击 `⏎` — 发送输入框内容并清空

- [ ] **Step 3: Commit（如验证中发现修复）**

```bash
git add terminal-buddy/web/src/components/MobileInputBar.tsx
git commit -m "[web] MobileInputBar: 修复验证中发现的问题"
```

---

### Task 4: 修复 handleMobileSend 对特殊键追加 `\r` 的问题

**Skills:** _none_ — 单文件一行修复

**Files:**
- Modify: `terminal-buddy/web/src/components/TerminalView.tsx:197-199`

**Acceptance Criteria:**

- [ ] C1: 点击 Tab 按钮，终端收到 `\t`（不含多余 `\r`），TUI 补全不会触发命令执行
- [ ] C2: 点击 Ctrl+C 按钮，终端收到 `\x03`（不含多余 `\r`），仅中断进程
- [ ] C3: 点击 Esc 按钮，终端收到 `\x1b`（不含多余 `\r`）
- [ ] C4: `npx tsc --noEmit` 通过

**问题根因:**

`TerminalView.tsx` 中 `handleMobileSend` 在添加特殊键功能**之前**编写，当时 MobileInputBar 只发送文本命令，追加 `\r` 是正确的。现在所有通过 `onSend` 发出的特殊键都会被错误地追加 `\r`：

| 按钮 | MobileInputBar 发送 | 实际到达终端（错误） |
|------|-------------------|-------------------|
| Tab | `\t` | `\t\r` |
| Ctrl+C | `\x03` | `\x03\r` |
| Ctrl+L | `\x0c` | `\x0c\r` |
| Esc | `\x1b` | `\x1b\r` |
| Ctrl+Enter | `\r` | `\r\r` |

**原因分析：** `MobileInputBar.handleSubmit` 通过 `onSend(text)` 发送纯文本；`handleKeyBtn('Enter')` 调用 `handleSubmit()` 也走同一路径；`handleKeyBtn('Ctrl')` + Enter 则通过 `onSend('\r')` 自行发送 `\r`。因此 `handleMobileSend` 不应追加 `\r`。

- [ ] **Step 1: 移除 handleMobileSend 中的 `\r` 追加**

将 `TerminalView.tsx:197-199`：

```ts
const handleMobileSend = useCallback((text: string) => {
    sendInput(text + '\r');
}, [sendInput]);
```

改为：

```ts
const handleMobileSend = useCallback((text: string) => {
    sendInput(text);
}, [sendInput]);
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add terminal-buddy/web/src/components/TerminalView.tsx
git commit -m "[web] TerminalView: 修复 handleMobileSend 对特殊键追加多余 \\r 的问题"
```
