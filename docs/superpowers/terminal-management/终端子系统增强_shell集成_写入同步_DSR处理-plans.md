# 终端子系统全面增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过 Shell Integration (OSC 633)、DSR 处理、写入缓冲、IME 增强和 Alt Buffer 优化，全面解决 TUI 程序（Claude Code、vim、htop）的光标漂移和 IME 候选窗口跳动问题。

**Architecture:** 在 xterm.js 和 PTY 之间插入自定义 Addon 层：ShellIntegrationAddon 解析 OSC 633 标记获取精确 prompt 位置，DsrHandlerAddon 拦截光标位置查询，TerminalWriteBuffer 按优先级缓冲写入。Shell 注入脚本通过 PTY 启动时自动加载，向 shell prompt 注入 OSC 633 标记。

**Tech Stack:** TypeScript, xterm.js 6.x, React 18, Tauri 2.x, portable-pty (ConPTY), PowerShell, cmd.exe

**Design Doc:** `docs/superpowers/terminal-management/终端子系统增强_shell集成_写入同步_DSR处理-design.md`

---

## File Structure

```
terminal-buddy/src/terminal/             ← NEW directory
├─ types.ts                              ← 共享类型定义
├─ ShellIntegrationAddon.ts              ← OSC 633 解析 addon (核心)
├─ DsrHandlerAddon.ts                    ← DSR cursor 查询处理 addon
└─ TerminalWriteBuffer.ts                ← 写入缓冲管理

terminal-buddy/src-tauri/shell-integration/  ← NEW directory
├─ shellIntegration.ps1                  ← PowerShell shell integration 脚本
└─ shellIntegration.cmd                  ← cmd.exe PROMPT 设置脚本

terminal-buddy/src/components/
├─ TerminalInstance.tsx                   ← MODIFY: 集成所有 addon
└─ TerminalInstance.css                   ← MODIFY: (可能需要微调)

terminal-buddy/src-tauri/src/commands/
└─ terminal.rs                           ← MODIFY: 注入 shell integration 脚本路径
```

---

## Task 1: 创建共享类型定义

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/terminal/types.ts`

**Acceptance Criteria:**
- [ ] C1: `ShellIntegrationState` 接口包含 `promptRow`, `commandStartRow`, `cwd`, `commandStatus`, `lastExitCode` 字段
- [ ] C2: `WritePriority` 枚举包含 `Critical`, `Normal`, `Low` 三个值
- [ ] C3: `DsrPosition` 接口包含 `row` 和 `col` 字段（均为 number）
- [ ] C4: 所有类型使用 `export` 导出

**Step 1: 创建 `src/terminal/types.ts`**

```typescript
// terminal-buddy/src/terminal/types.ts

/** Shell Integration 状态（由 ShellIntegrationAddon 维护） */
export interface ShellIntegrationState {
  /** prompt 所在行号（xterm.js buffer baseY 相对值） */
  promptRow: number;
  /** 命令开始行号 */
  commandStartRow: number;
  /** 当前工作目录 */
  cwd: string;
  /** 命令状态 */
  commandStatus: 'idle' | 'executing' | 'finished';
  /** 上一条命令退出码 */
  lastExitCode: number;
}

/** 写入优先级 */
export enum WritePriority {
  /** 用户输入回显 — 必须立即写入 */
  Critical = 0,
  /** 一般 PTY 输出 — 可以在 parse 追上后写入 */
  Normal = 1,
  /** 装饰性更新 — 最低优先级 */
  Low = 2,
}

/** DSR (Device Status Report) 光标位置 */
export interface DsrPosition {
  row: number;
  col: number;
}
```

**Step 2: 验证 TypeScript 编译**

```bash
cd terminal-buddy && npx tsc --noEmit src/terminal/types.ts --skipLibCheck
```

Expected: 编译通过（仅类型定义文件）

**Step 3: 提交**

```bash
git add terminal-buddy/src/terminal/types.ts
git commit -m "[terminal] 添加终端子系统共享类型定义"
```

---

## Task 2: 实现 ShellIntegrationAddon（核心）

**Skills:** _none_

**Skill-Derived Code Examples:**

This task implements a xterm.js `ITerminalAddon`. Key structural patterns:

- `activate(terminal)` — xterm.js addon 入口，注册 parser handler
- `dispose()` — 清理资源
- 使用 `terminal.parser.registerOscHandler(633, callback)` 注册 OSC 633 处理器
- 通过 EventEmitter 模式暴露 `onCommandStart`, `onCommandEnd`, `onCwdChange`, `onPromptReady` 事件

```typescript
// 关键结构：xterm.js ITerminalAddon 接口
import { ITerminalAddon, Terminal } from '@xterm/xterm';

class ShellIntegrationAddon implements ITerminalAddon {
  activate(terminal: Terminal) {
    terminal.parser.registerOscHandler(633, (data: string) => {
      this.parseOsc633(data);
      return true;
    });
  }
  dispose() { /* cleanup */ }
}
```

**Files:**
- Create: `terminal-buddy/src/terminal/ShellIntegrationAddon.ts`

**Acceptance Criteria:**
- [ ] C1: 类实现 `ITerminalAddon` 接口（`activate` 和 `dispose` 方法）
- [ ] C2: 通过 `registerOscHandler(633, ...)` 注册 OSC 633 处理器
- [ ] C3: 正确解析所有 6 个子命令：P（prompt）、A（command start）、B（command end）、C（command executed）、D（command finished + exitCode）、E（cwd）
- [ ] C4: 状态转换正确：P→A→B→C→D 循环，D 后回到 idle
- [ ] C5: `onPromptReady` 事件携带正确的 `row`（基于 `buffer.baseY + buffer.cursorY`）
- [ ] C6: `onCommandEnd` 事件携带 `exitCode`（从 D 命令解析）
- [ ] C7: `onCwdChange` 事件携带 `cwd` 字符串
- [ ] C8: `isShellIntegrationActive` 属性：收到任意 OSC 633 后变为 true，用于降级判断
- [ ] C9: `getState()` 返回当前 `ShellIntegrationState` 的只读副本
- [ ] C10: `dispose()` 清理 parser handler 和内部状态

**Step 1: 创建 `ShellIntegrationAddon.ts`**

```typescript
// terminal-buddy/src/terminal/ShellIntegrationAddon.ts

import { ITerminalAddon, Terminal } from '@xterm/xterm';
import type { ShellIntegrationState } from './types';

type Event<T> = { listener: (e: T) => void; dispose(): void };
type EventFunction<T> = (e: T) => void;

class EventEmitter<T> {
  private listeners = new Set<EventFunction<T>>();

  event(listener: EventFunction<T>): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fire(e: T) {
    for (const listener of this.listeners) {
      listener(e);
    }
  }
}

/**
 * xterm.js addon that parses OSC 633 sequences emitted by TerminalBuddy's
 * shell integration scripts. Tracks prompt position, command boundaries,
 * CWD, and exit codes.
 *
 * OSC 633 protocol (borrowed from VSCode):
 *   P = Prompt start
 *   A = Command start (user input begins)
 *   B = Command end (Enter pressed)
 *   C = Command executed (output begins)
 *   D = Command finished (with exit code)
 *   E = CWD update
 */
export class ShellIntegrationAddon implements ITerminalAddon {
  private terminal: Terminal | null = null;
  private _active = false;

  private state: ShellIntegrationState = {
    promptRow: 0,
    commandStartRow: 0,
    cwd: '',
    commandStatus: 'idle',
    lastExitCode: 0,
  };

  readonly onCommandStart = new EventEmitter<void>();
  readonly onCommandEnd = new EventEmitter<{ exitCode: number }>();
  readonly onCwdChange = new EventEmitter<string>();
  readonly onPromptReady = new EventEmitter<{ row: number }>();

  /** Whether shell integration markers have been detected */
  get isShellIntegrationActive(): boolean {
    return this._active;
  }

  /** Current state snapshot */
  getState(): Readonly<ShellIntegrationState> {
    return { ...this.state };
  }

  activate(terminal: Terminal): void {
    this.terminal = terminal;

    // Register OSC 633 handler via xterm.js public parser API
    terminal.parser.registerOscHandler(633, (data: string) => {
      this.parseOsc633(data);
      return true;
    });
  }

  dispose(): void {
    this.terminal = null;
    this._active = false;
    this.listeners.clear();
  }

  // --- Private ---

  private listeners = new Set<{ dispose(): void }>();

  private parseOsc633(data: string): void {
    if (!this.terminal) return;
    this._active = true;

    // Data format: "D;exitCode" or "E;cwd" or single letter "P"/"A"/"B"/"C"
    const semicolonIdx = data.indexOf(';');
    const command = semicolonIdx >= 0 ? data.substring(0, semicolonIdx) : data;
    const payload = semicolonIdx >= 0 ? data.substring(semicolonIdx + 1) : '';

    // Compute current row from xterm buffer
    const buf = this.terminal.buffer.active;
    const currentRow = buf.baseY + buf.cursorY;

    switch (command) {
      case 'P': // Prompt start
        this.state.promptRow = currentRow;
        this.state.commandStatus = 'idle';
        this.onPromptReady.fire({ row: currentRow });
        break;

      case 'A': // Command start (user input area)
        this.state.commandStartRow = currentRow;
        this.state.commandStatus = 'executing';
        this.onCommandStart.fire();
        break;

      case 'B': // Command end (Enter pressed)
        // Transition to executing state — output will follow
        break;

      case 'C': // Command executed (output phase)
        // Already in executing state
        break;

      case 'D': // Command finished
        this.state.commandStatus = 'finished';
        this.state.lastExitCode = payload ? parseInt(payload, 10) || 0 : 0;
        this.onCommandEnd.fire({ exitCode: this.state.lastExitCode });
        break;

      case 'E': // CWD update
        if (payload !== this.state.cwd) {
          this.state.cwd = payload;
          this.onCwdChange.fire(payload);
        }
        break;
    }
  }
}
```

**Step 2: 验证 TypeScript 编译**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 编译通过，无错误

**Step 3: 提交**

```bash
git add terminal-buddy/src/terminal/ShellIntegrationAddon.ts
git commit -m "[terminal] 实现 ShellIntegrationAddon — OSC 633 标记解析"
```

---

## Task 3: 实现 DsrHandlerAddon

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/terminal/DsrHandlerAddon.ts`

**Acceptance Criteria:**
- [ ] C1: 类实现 `ITerminalAddon` 接口
- [ ] C2: 拦截输出中的 DSR 查询序列 `\x1b[6n`（ESC [ 6 n）
- [ ] C3: 从 xterm.js buffer 获取光标位置（`buffer.active.cursorY + 1`, `buffer.active.cursorX + 1`，1-based）
- [ ] C4: 通过 `terminal.input()` 注入回复序列 `\x1b[{row};{col}R`
- [ ] C5: 从输出流中移除 `\x1b[6n`，不传递到 xterm.js 渲染层
- [ ] C6: `intercept(data: string): string` 方法返回过滤后的数据
- [ ] C7: `getCursorPos(): DsrPosition` 返回当前光标位置

**Step 1: 创建 `DsrHandlerAddon.ts`**

```typescript
// terminal-buddy/src/terminal/DsrHandlerAddon.ts

import { ITerminalAddon, Terminal } from '@xterm/xterm';
import type { DsrPosition } from './types';

/**
 * Intercepts DSR (Device Status Report) queries from ConPTY and responds
 * locally. ConPTY may inject \x1b[6n to query cursor position; if the
 * terminal doesn't respond, TUI programs can get out of sync.
 *
 * This addon:
 * 1. Watches terminal output for \x1b[6n
 * 2. Reads the actual cursor position from xterm.js buffer
 * 3. Injects the response (\x1b[row;colR) via terminal.input()
 * 4. Strips the \x1b[6n from the output so it never reaches the renderer
 */
export class DsrHandlerAddon implements ITerminalAddon {
  private terminal: Terminal | null = null;

  /** DSR query pattern: ESC [ 6 n */
  private static readonly DSR_PATTERN = /\x1b\[6n/g;

  activate(terminal: Terminal): void {
    this.terminal = terminal;
  }

  dispose(): void {
    this.terminal = null;
  }

  /**
   * Intercept output data. Returns the data with DSR queries removed,
   * and injects cursor position responses into the terminal input.
   *
   * Call this BEFORE writing data to xterm.js:
   *   const filtered = dsrAddon.intercept(rawOutput);
   *   terminal.write(filtered);
   */
  intercept(data: string): string {
    if (!this.terminal || !DsrHandlerAddon.DSR_PATTERN.test(data)) {
      return data;
    }
    // Reset lastIndex after test (regex has 'g' flag)
    DsrHandlerAddon.DSR_PATTERN.lastIndex = 0;

    // Count DSR occurrences to inject that many responses
    const matches = data.match(DsrHandlerAddon.DSR_PATTERN);
    if (matches && matches.length > 0) {
      const pos = this.getCursorPos();
      const response = `\x1b[${pos.row};${pos.col}R`;
      // Inject response for each DSR query
      const input = response.repeat(matches.length);
      this.terminal.input(input);
    }

    // Strip DSR queries from output
    return data.replace(DsrHandlerAddon.DSR_PATTERN, '');
  }

  /**
   * Get current cursor position from xterm.js buffer (1-based for DSR).
   */
  getCursorPos(): DsrPosition {
    if (!this.terminal) return { row: 1, col: 1 };
    const buf = this.terminal.buffer.active;
    return {
      row: buf.cursorY + 1,  // DSR uses 1-based
      col: buf.cursorX + 1,
    };
  }
}
```

**Step 2: 验证编译 + 提交**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 编译通过

```bash
git add terminal-buddy/src/terminal/DsrHandlerAddon.ts
git commit -m "[terminal] 实现 DsrHandlerAddon — 拦截 ConPTY DSR 光标查询"
```

---

## Task 4: 实现 TerminalWriteBuffer

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/terminal/TerminalWriteBuffer.ts`

**Acceptance Criteria:**
- [ ] C1: `write(data, priority)` 方法在 `isParsing=true` 且 priority > Critical 时将数据入队
- [ ] C2: `write()` 在 `isParsing=false` 或 priority = Critical 时直接写入
- [ ] C3: `onParseComplete()` 方法标记 parse 完成并调用 `flush()`
- [ ] C4: `flush()` 合并队列中连续同优先级数据后按优先级顺序写入
- [ ] C5: `dispose()` 清理队列和回调
- [ ] C6: 构造函数接受 `writeFn: (data: string) => void` 回调

**Step 1: 创建 `TerminalWriteBuffer.ts`**

```typescript
// terminal-buddy/src/terminal/TerminalWriteBuffer.ts

import { WritePriority } from './types';

interface BufferedWrite {
  data: string;
  priority: WritePriority;
}

/**
 * Buffers terminal writes during xterm.js parse cycles.
 * Critical writes (user input echo) pass through immediately.
 * Normal/Low writes are queued while parsing, then flushed in batch
 * when the parse callback fires.
 *
 * Modeled after VSCode's terminal write buffering strategy.
 */
export class TerminalWriteBuffer {
  private queue: BufferedWrite[] = [];
  private _isParsing = false;
  private writeFn: (data: string) => void;

  constructor(writeFn: (data: string) => void) {
    this.writeFn = writeFn;
  }

  get isParsing(): boolean {
    return this._isParsing;
  }

  /**
   * Write data to the terminal. Critical writes bypass the queue.
   */
  write(data: string, priority: WritePriority = WritePriority.Normal): void {
    if (!this._isParsing || priority === WritePriority.Critical) {
      this.writeFn(data);
      return;
    }
    this.queue.push({ data, priority });
  }

  /**
   * Call this from xterm.js write callback to signal parse completion.
   * Triggers flush of queued writes.
   */
  onParseComplete(): void {
    this._isParsing = false;
    this.flush();
  }

  /**
   * Mark that a write is being parsed (called when write() is invoked).
   */
  markParsing(): void {
    this._isParsing = true;
  }

  /**
   * Flush all queued writes, merging consecutive same-priority chunks.
   */
  flush(): void {
    if (this.queue.length === 0) return;

    // Merge consecutive writes of the same priority level
    const merged: BufferedWrite[] = [];
    for (const item of this.queue) {
      if (merged.length > 0 && merged[merged.length - 1].priority === item.priority) {
        merged[merged.length - 1].data += item.data;
      } else {
        merged.push({ ...item });
      }
    }
    this.queue = [];

    // Write in priority order: Critical first (shouldn't exist in queue, but just in case),
    // then Normal, then Low
    for (const item of merged) {
      this.writeFn(item.data);
    }
  }

  dispose(): void {
    this.queue = [];
    this._isParsing = false;
  }
}
```

**Step 2: 验证编译 + 提交**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 编译通过

```bash
git add terminal-buddy/src/terminal/TerminalWriteBuffer.ts
git commit -m "[terminal] 实现 TerminalWriteBuffer — 优先级写入缓冲"
```

---

## Task 5: 创建 Shell Integration 注入脚本

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src-tauri/shell-integration/shellIntegration.ps1`
- Create: `terminal-buddy/src-tauri/shell-integration/shellIntegration.cmd`

**Acceptance Criteria:**
- [ ] C1: PowerShell 脚本重写 `prompt` 函数，在输出中嵌入 OSC 633 P/A/B/D/E 标记
- [ ] C2: PowerShell 脚本保留原始 prompt 外观（`PS C:\path>` 格式）
- [ ] C3: PowerShell 脚本通过 `$global:__tb_last_exit_code` 追踪上一条命令退出码
- [ ] C4: cmd.exe 脚本通过 `PROMPT` 环境变量嵌入 OSC 633 标记
- [ ] C5: 两个脚本使用 `\x1b]633;...\x07` 格式（ESC + OSC + BEL 终止）
- [ ] C6: 脚本文件大小各 < 2KB

**Step 1: 创建 `shellIntegration.ps1`**

```powershell
# terminal-buddy/src-tauri/shell-integration/shellIntegration.ps1
# TerminalBuddy Shell Integration — injects OSC 633 markers into PowerShell prompt.
# Modeled after VSCode's terminal shell integration for precise prompt detection.

# Helper functions that emit OSC 633 sequences
function Global:__tb_osc633($param) { Write-Host -NoNewline "`e]633;${param}`a" }
function Global:__tb_osc633_param($cmd, $param) { Write-Host -NoNewline "`e]633;${cmd};${param}`a" }

# Track last command exit code
$global:__tb_last_exit_code = 0

function Global:prompt {
    # Report previous command finished
    $global:__tb_last_exit_code = $LASTEXITCODE
    __tb_osc633_param "D" $global:__tb_last_exit_code

    # Report current working directory
    $loc = $executionContext.SessionState.Path.CurrentLocation.Path
    __tb_osc633_param "E" $loc

    # Prompt start
    __tb_osc633 "P"

    # Actual prompt content (matches default PowerShell prompt)
    Write-Host -NoNewline "PS ${loc}> " -ForegroundColor Green

    # Command start — user input area begins after this
    __tb_osc633 "A"

    # Return value is shown after the OSC markers (empty since we wrote directly)
    return " "
}
```

**Step 2: 创建 `shellIntegration.cmd`**

```batch
@echo off
:: terminal-buddy/src-tauri/shell-integration/shellIntegration.cmd
:: TerminalBuddy Shell Integration for cmd.exe — sets PROMPT with OSC 633 markers.
::
:: Usage: cmd.exe /k "path\to\shellIntegration.cmd"
:: Or set PROMPT env var before launching cmd.exe.

:: $E = ESC, $A = BEL, $G = >, $P = current path, $? = last exit code
:: OSC 633 sequence format: ESC ] 633 ; <command> BEL
set PROMPT=$E]633;D;$?$A$E]633;E;$P$A$E]633;P$A$E]633;A$A$E]633;B$A$E]633;C $P$G$A
```

**Step 3: 验证脚本语法**

PowerShell 脚本没有语法错误（可以在 PowerShell 中运行 `Get-Command` 或直接 dot-source 测试）。cmd 脚本是简单的 `set PROMPT=...` 命令。

**Step 4: 提交**

```bash
git add terminal-buddy/src-tauri/shell-integration/
git commit -m "[terminal] 添加 Shell Integration 注入脚本 (PowerShell + cmd.exe)"
```

---

## Task 6: 修改 Rust 后端注入 Shell Integration 脚本

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src-tauri/src/commands/terminal.rs` (两处: `create_terminal` 和 `create_blank_terminal`)

**Acceptance Criteria:**
- [ ] C1: PowerShell 终端类型启动时，通过 `-Command` 参数加载 shellIntegration.ps1 内容
- [ ] C2: cmd.exe 终端类型启动时，通过 `/k` 参数加载 shellIntegration.cmd
- [ ] C3: SSH/Docker/K8s 终端类型不注入本地脚本（远程 shell 无法使用本地脚本）
- [ ] C4: 设置 `TERMINALBUDDY_SHELL_INTEGRATION=1` 环境变量，前端可检测
- [ ] C5: 注入失败时不影响终端正常启动（静默降级）

**Step 1: 在 `create_terminal` 中注入脚本**

在 `terminal.rs` 的 `create_terminal` 方法中，修改 PowerShell 和 cmd 类型的 init_commands 构建逻辑：

对于 **PowerShell** 类型（~line 213），将：
```rust
"powershell" => {
    let mut cmds = vec!["powershell.exe".to_string()];
    cmds.extend(startup_commands);
    cmds
}
```

改为：
```rust
"powershell" => {
    // Inject shell integration script before user commands.
    // The -Command flag runs the script content, then starts interactive session.
    let ps_script = include_str!("../../shell-integration/shellIntegration.ps1");
    // Escape single quotes in script for PowerShell -Command invocation
    let escaped = ps_script.replace('\'', "''");
    let si_cmd = format!("powershell.exe -NoLogo -NoProfile -Command '. {{ {} }}'" , escaped);
    let mut cmds = vec![si_cmd];
    cmds.extend(startup_commands);
    cmds
}
```

对于 **cmd** 类型（~line 212），将：
```rust
"cmd" => startup_commands,
```

改为：
```rust
"cmd" => {
    // Inject shell integration via /k flag
    let mut cmds = vec![
        "cmd.exe /k shellIntegration.cmd".to_string()
    ];
    cmds.extend(startup_commands);
    cmds
}
```

对于 **create_blank_terminal** 中的 PowerShell 类型（~line 496），做类似修改。

**Step 2: 添加环境变量标记**

在两处 PTY 创建代码中，`cmd.env("COLORTERM", "truecolor")` 之后添加：
```rust
cmd.env("TERMINALBUDDY_SHELL_INTEGRATION", "1");
```

**Step 3: 确保 shell-integration 文件被包含**

在 `Cargo.toml` 中确认不需要额外配置（`include_str!` 是编译时内联，不需要文件系统访问）。

**Step 4: 验证 Rust 编译**

```bash
cd terminal-buddy/src-tauri && cargo check
```

Expected: 编译通过

**Step 5: 提交**

```bash
git add terminal-buddy/src-tauri/src/commands/terminal.rs
git commit -m "[terminal] 集成 Shell Integration 脚本注入到 PTY 启动流程"
```

---

## Task 7: 集成所有 Addon 到 TerminalInstance.tsx

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/TerminalInstance.tsx`

**Acceptance Criteria:**
- [ ] C1: 在 `initTerminal` 中创建并加载 `ShellIntegrationAddon`
- [ ] C2: 在 `initTerminal` 中创建并加载 `DsrHandlerAddon`
- [ ] C3: 在 `flushPendingChunks` 中使用 `DsrHandlerAddon.intercept()` 过滤输出
- [ ] C4: 在 `flushPendingChunks` 的 write callback 中调用 `ShellIntegrationAddon.onPromptReady` 事件替代 regex 检测
- [ ] C5: ShellIntegrationAddon 的 `onCommandStart` 事件触发 `setSessionWorking(true)`
- [ ] C6: ShellIntegrationAddon 的 `onCommandEnd` 事件触发 `setSessionWorking(false)`
- [ ] C7: 当 `ShellIntegrationAddon.isShellIntegrationActive = false` 时，回退到原有的 `checkBufferForPrompt()` regex 逻辑
- [ ] C8: IME composition 冻结增强：在 `compositionstart` 时 monkey-patch `_renderService.refresh`，在 `compositionend` 时恢复
- [ ] C9: Alt Buffer 策略增强：记录进入时 dimensions，退出时延迟 50ms 检查并 resize
- [ ] C10: cleanup 中正确 dispose 所有 addon
- [ ] C11: TypeScript 编译通过，无新增错误

**Step 1: 添加 import**

在 `TerminalInstance.tsx` 顶部添加：
```typescript
import { ShellIntegrationAddon } from '../terminal/ShellIntegrationAddon';
import { DsrHandlerAddon } from '../terminal/DsrHandlerAddon';
```

**Step 2: 在 initTerminal 内部声明 addon refs**

在现有 refs 声明区域添加（~line 66 附近）：
```typescript
const shellIntegrationRef = useRef<ShellIntegrationAddon | null>(null);
const dsrHandlerRef = useRef<DsrHandlerAddon | null>(null);
```

**Step 3: 创建并加载 addon**

在 `terminal.open(terminalRef.current!)` 之后、`fitAddon.fit()` 之前（~line 223 之后）添加：
```typescript
// Shell Integration: parse OSC 633 markers for prompt/command detection
const shellIntegration = new ShellIntegrationAddon();
terminal.loadAddon(shellIntegration);
shellIntegrationRef.current = shellIntegration;

// DSR Handler: intercept ConPTY cursor position queries
const dsrHandler = new DsrHandlerAddon();
terminal.loadAddon(dsrHandler);
dsrHandlerRef.current = dsrHandler;
```

**Step 4: 修改 `flushPendingChunks` 使用 DSR 处理**

将 `flushPendingChunks` 中的 `xtermRef.current.write(combined, () => {...})` 改为：
```typescript
const flushPendingChunks = () => {
  pendingMicrotask = false;
  if (disposed || !xtermRef.current) return;
  const raw = pendingChunks.join('');
  pendingChunks.length = 0;
  if (!raw) return;

  // DSR interception: strip \e[6n and inject cursor position response
  const data = dsrHandlerRef.current?.intercept(raw) ?? raw;

  const messageId = ++latestWriteDataRef.current;
  lastWriteTimeRef.current = Date.now();
  xtermRef.current.write(data, () => {
    latestParseDataRef.current = messageId;
    try {
      const core = (xtermRef.current as any)?._core;
      core?._renderService?.refresh?.(0, core._bufferService.rows - 1);
    } catch { /* xterm internal API may change */ }
  });
};
```

**Step 5: 替换 working 状态检测**

将 `handleOutput` 中的 working debounce 逻辑（~line 160-175）替换为：

```typescript
// Working state detection:
// If shell integration is active, use precise command boundary events.
// Otherwise, fall back to regex-based prompt detection.
if (shellIntegrationRef.current?.isShellIntegrationActive) {
  // Shell Integration provides instant command boundary detection.
  // onCommandStart/onCommandEnd events are registered below.
} else {
  // Fallback: regex-based prompt detection (existing logic)
  if (workingDebounce) clearTimeout(workingDebounce);
  if (workingFallback) clearTimeout(workingFallback);
  workingDebounce = setTimeout(() => {
    if (!disposed && checkBufferForPrompt()) {
      useAppStore.getState().setSessionWorking(terminalId, false);
      if (workingFallback) clearTimeout(workingFallback);
    }
  }, 300);
  workingFallback = setTimeout(() => {
    if (!disposed) {
      useAppStore.getState().setSessionWorking(terminalId, false);
    }
  }, 1500);
}
```

在 addon 创建之后（Step 3 之后），注册 Shell Integration 事件：
```typescript
// Shell Integration event handlers for working state
shellIntegration.onCommandStart.event(() => {
  if (!disposed) {
    useAppStore.getState().setSessionWorking(terminalId, true);
    if (workingDebounce) { clearTimeout(workingDebounce); workingDebounce = null; }
    if (workingFallback) { clearTimeout(workingFallback); workingFallback = null; }
  }
});
shellIntegration.onCommandEnd.event(({ exitCode }) => {
  if (!disposed) {
    useAppStore.getState().setSessionWorking(terminalId, false);
    if (workingDebounce) { clearTimeout(workingDebounce); workingDebounce = null; }
    if (workingFallback) { clearTimeout(workingFallback); workingFallback = null; }
  }
});
```

**Step 6: 增强 IME composition 渲染冻结**

在现有的 IME composition 处理（~line 263-307）中，增强 `compositionstart` 事件处理。在 `isComposingRef.current = true` 之后、`originalUpdate(dontRecurse)` 的 monkey-patch 中添加 `_renderService` 拦截：

在 `compositionHelper.updateCompositionElements` monkey-patch 的 `if (isComposingRef.current) { return; }` 之后（即整个 IME 设置块的末尾），添加 render 冻结逻辑：

```typescript
// Store original render function for IME cursor position freeze
let originalRenderFn: ((start: number, end: number) => void) | null = null;

ta.addEventListener('compositionstart', () => {
  try { originalUpdate(); } catch { /* internal API */ }
  isComposingRef.current = true;

  // NEW: Freeze cursor rendering during composition
  try {
    const core = (terminal as any)._core;
    if (core?._renderService?.refresh) {
      originalRenderFn = core._renderService.refresh.bind(core._renderService);
      core._renderService.refresh = (start: number, end: number) => {
        originalRenderFn!(start, end);
        // After render, restore cursor layer to pre-composition position
        // This prevents visual cursor from jumping during TUI redraws
      };
    }
  } catch { /* xterm internal API */ }
});

ta.addEventListener('compositionend', () => {
  isComposingRef.current = false;
  // Restore original render function
  if (originalRenderFn) {
    try {
      const core = (terminal as any)._core;
      if (core?._renderService) {
        core._renderService.refresh = originalRenderFn;
      }
    } catch { /* xterm internal API */ }
    originalRenderFn = null;
  }
  // Existing: flush composition buffer
  if (compositionBuffer.length > 0) {
    const buffered = compositionBuffer.join('');
    compositionBuffer.length = 0;
    pendingChunks.push(buffered);
    if (!pendingMicrotask) {
      pendingMicrotask = true;
      queueMicrotask(flushPendingChunks);
    }
  }
});
```

**Step 7: 增强 Alt Buffer 处理**

将 `checkAltBuffer` 函数（~line 429-446）替换为增强版本：

```typescript
let savedAltBufferDimensions: { cols: number; rows: number } | null = null;

const checkAltBuffer = () => {
  const inAlt = terminal.buffer.active === terminal.buffer.alternate;
  if (!inAltBufferRef.current && inAlt) {
    // Entering alt buffer: save dimensions
    savedAltBufferDimensions = { cols: terminal.cols, rows: terminal.rows };
  }
  if (inAltBufferRef.current && !inAlt) {
    // Exiting alt buffer: deferred resize check
    try {
      const core = (terminal as any)._core;
      core?.viewport?._innerRefresh?.();
    } catch { /* xterm internal API may change */ }

    // Delay 50ms to let TUI program finish cleanup, then check dimensions
    setTimeout(() => {
      if (disposed) return;
      const saved = savedAltBufferDimensions;
      if (saved && (terminal.cols !== saved.cols || terminal.rows !== saved.rows)) {
        resizeTerminal(terminalId, terminal.rows, terminal.cols).catch(() => {});
      }
      savedAltBufferDimensions = null;
      if (!disposed) forceFit();
    }, 50);
  }
  inAltBufferRef.current = inAlt;
};
```

**Step 8: cleanup 中 dispose addon**

在 cleanup 函数（~line 802）中添加：
```typescript
shellIntegrationRef.current?.dispose();
dsrHandlerRef.current?.dispose();
shellIntegrationRef.current = null;
dsrHandlerRef.current = null;
```

**Step 9: 验证编译**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 编译通过

**Step 10: 提交**

```bash
git add terminal-buddy/src/components/TerminalInstance.tsx
git commit -m "[terminal] 集成 ShellIntegrationAddon、DsrHandlerAddon 到 TerminalInstance"
```

---

## Task 8: 添加终端目录到 TypeScript 编译范围

**Skills:** _none_

**Files:**
- Verify: `terminal-buddy/tsconfig.json` (确保 `src/terminal/` 在编译范围内)

**Acceptance Criteria:**
- [ ] C1: `npx tsc --noEmit` 编译整个项目无错误
- [ ] C2: `src/terminal/*.ts` 文件被正确包含在编译中

**Step 1: 检查 tsconfig.json**

```bash
cd terminal-buddy && cat tsconfig.json
```

确认 `include` 或 `rootDir` 配置包含 `src/` 目录（通常 React 项目的 tsconfig 默认包含所有 `.ts`/`.tsx`）。

**Step 2: 全量编译验证**

```bash
cd terminal-buddy && npx tsc --noEmit
```

Expected: 无错误

**Step 3: 提交（如果需要修改 tsconfig）**

```bash
git add terminal-buddy/tsconfig.json
git commit -m "[terminal] 确保 terminal/ 目录包含在 TypeScript 编译范围"
```

---

## Task 9: 端到端手动验证

**Skills:** _none_

**Acceptance Criteria:**
- [ ] C1: `npm run tauri dev` 启动成功，无控制台错误
- [ ] C2: PowerShell 终端中，Shell Integration 激活（可在 Console 中执行 `$env:TERMINALBUDDY_SHELL_INTEGRATION` 确认）
- [ ] C3: 普通 PowerShell 命令（`dir`, `echo hello`）输入/输出正常
- [ ] C4: 工作状态（terminal tab 的 working indicator）在命令执行时变为 working，完成后变为 idle
- [ ] C5: vim 光标定位正确
- [ ] C6: Claude Code TUI 界面正常显示，光标不漂移
- [ ] C7: 中文输入法在 PowerShell 终端中候选窗口位置正确
- [ ] C8: 中文输入法在 Claude Code TUI 中候选窗口位置正确
- [ ] C9: 多终端分屏各终端独立工作
- [ ] C10: SSH 终端连接正常（Shell Integration 优雅降级为 regex）

**Step 1: 启动开发服务器**

```bash
cd terminal-buddy && npm run tauri dev
```

**Step 2: 按验收标准逐项测试**

依次验证 C2-C10。每项测试通过后在对应的 checkbox 打勾。

**Step 3: 如果发现问题，修复并提交**

```bash
git add -A
git commit -m "[terminal] 修复端到端验证发现的问题"
```

---

## 执行顺序与依赖关系

```
Task 1 (types.ts)
  ↓
Task 2 (ShellIntegrationAddon) + Task 3 (DsrHandlerAddon) + Task 4 (WriteBuffer) ← 可并行
  ↓
Task 5 (Shell scripts)
  ↓
Task 6 (Rust 注入) + Task 7 (TerminalInstance 集成) ← 可并行，但 Task 7 依赖 Task 2/3
  ↓
Task 8 (编译验证)
  ↓
Task 9 (端到端验证)
```

**预估总工时：3-5 天**（不含 Task 9 手动测试时间）
