# 移动端终端特殊键功能栏

## 背景

TerminalBuddy 的 Web 终端在移动端浏览器上缺少特殊键支持。用户无法发送 Tab（补全）、Ctrl+C（中断）、Esc（取消）、方向键（历史浏览）等按键，导致无法在手机上正常使用 Claude Code 等交互式 CLI 工具。

## 目标

在 MobileInputBar 下方增加固定功能键栏，让用户可以通过触屏点击发送特殊键。

## 改动范围

仅修改 `terminal-buddy/web/src/components/MobileInputBar.tsx`，不涉及其他文件。

## UI 布局

MobileInputBar 改为两行布局：

```
┌─────────────────────────────────┐
│ [输入命令...              ] [↑] │  ← 原有输入行
├─────────────────────────────────┤
│ [↑] [↓] [Tab] [Ctrl] [Esc] [⏎] │  ← 新增功能键行
└─────────────────────────────────┘
```

- 外层容器：`flexDirection: 'column'`，固定在终端底部
- 功能键行高度 36px，背景 `#16162e`，上边框 `1px solid #2a2a4a`
- 按钮平分宽度（`flex: 1`），高度 30px，圆角 4px
- 默认态：背景 `#1e1e3a`，文字 `#b0b0b0`
- 按下态：`opacity: 0.7`（100ms 过渡）
- Ctrl 锁定态：背景 `#6a6ad5`，文字 `#fff`

## 按键交互逻辑

### 按键行为

| 按钮 | 行为 | 说明 |
|------|------|------|
| ↑ | 浏览器端切换历史 | 复用现有 `historyIdx` 逻辑，不发送到终端 |
| ↓ | 浏览器端切换历史 | 复用现有 `historyIdx` 逻辑，不发送到终端 |
| Tab | 发送 `\t`（0x09） | Tab 字符 |
| Ctrl | 切换锁定态（不发送） | 锁定后高亮，等待组合键 |
| Esc | 发送 `\x1b`（0x1B） | Escape 字符 |
| ⏎ | 发送当前输入 + `\r` | 有内容则发送并清空；为空则发送纯回车 |

### Ctrl 锁定模式

1. 用户点 Ctrl → 按钮高亮，进入等待态
2. 用户点其他键 → 发送 Ctrl+组合键，自动取消锁定
3. 用户点 Ctrl 自身 → 取消锁定态
4. 5 秒无操作 → 自动取消锁定态
5. 锁定态下 ↑↓ 仍在浏览器端处理历史切换

### Ctrl 组合键映射

Ctrl + 某键时，发送该键的小写字母 ASCII 值减去 0x40：

```ts
const ctrlCode = String.fromCharCode(key.toUpperCase().charCodeAt(0) - 0x40);
```

常见映射：

| Ctrl + | 发送字节 | 效果 |
|--------|---------|------|
| C | `\x03` | 中断进程 |
| D | `\x04` | EOF |
| Z | `\x1a` | 挂起 |
| L | `\x0c` | 清屏 |

## 新增状态与逻辑

### 状态

- `ctrlActive: boolean` — Ctrl 锁定态
- `ctrlTimerRef` — 5 秒超时定时器（`useRef<NodeJS.Timeout>`）

### 核心函数

- `sendKey(char: string)` — 调用 `onSend(char)` 发送字符到终端
- `handleKeyBtn(key: string)` — 功能键按钮统一处理入口：
  - `↑` / `↓`：调用现有的历史切换逻辑
  - `Ctrl`：切换 `ctrlActive` 状态，管理超时定时器
  - 其他键 + `ctrlActive`：计算 Ctrl 组合码并发送，取消锁定
  - 其他键 + 非 `ctrlActive`：直接发送原始字符

## 不需要改动的文件

- `useTerminal.ts` — WebSocket 协议已支持发送任意字符
- `TerminalView.tsx` — 已有 `handleMobileSend` 处理 MobileInputBar 的输出
- 其他组件完全不受影响

## 样式

全部使用内联 style（与现有 MobileInputBar 风格一致），无需新增 CSS 文件。
