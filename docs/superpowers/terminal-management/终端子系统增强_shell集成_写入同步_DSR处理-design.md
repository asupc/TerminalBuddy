# 终端子系统全面增强：Shell 集成 / 写入同步 / DSR 处理

## 背景与问题

TerminalBuddy 的终端基于 xterm.js + portable-pty (ConPTY)。虽然已有多种借鉴 VSCode 的 workaround（IME 冻结、write callback、resize debounce、alt buffer 追踪），但 TUI 程序（Claude Code、vim、htop）体验仍有明显差距：

1. **光标漂移**：TUI 程序快速刷新内容时，光标位置与实际不同步
2. **IME 候选窗口跳动**：中文输入时，TUI 程序重绘导致候选窗口位置漂移
3. **Prompt 检测不可靠**：regex 匹配 prompt 在 TUI 场景下失效
4. **ConPTY DSR 查询隐患**：未处理的 cursor position 查询可能导致状态不同步

### 为什么不是"移植 VSCode 终端代码"

VSCode 的终端代码（`src/vs/workbench/contrib/terminal/`）与 DI/Service 层深度耦合，无法独立提取。正确做法是**提取其设计模式并重新实现**，而非移植代码本身。

## 架构设计

```
┌─────────────────────────────────────────────────────┐
│  TerminalInstance.tsx (协调层)                       │
│  使用各 Addon 的状态来优化渲染行为                    │
├─────────────────────────────────────────────────────┤
│  xterm.js + 自定义 Addons                            │
│  ├─ ShellIntegrationAddon  ← 解析 OSC 633 标记     │
│  ├─ DsrHandlerAddon        ← 拦截 cursor 查询       │
│  └─ 现有 addons (Fit, WebGL, Search, Unicode11)     │
├─────────────────────────────────────────────────────┤
│  Shell Integration Scripts (注入到 shell)             │
│  ├─ shellIntegration.ps1   ← PowerShell             │
│  ├─ shellIntegration.cmd   ← cmd.exe                │
│  └─ shellIntegration.sh    ← bash/zsh               │
├─────────────────────────────────────────────────────┤
│  portable-pty (ConPTY PASSTHROUGH)                   │
└─────────────────────────────────────────────────────┘
```

## 组件 1：Shell Integration（P0，3-5 天）

### 目标

让终端通过 OSC 633 标记序列与 shell 通信，精确获取 prompt 位置、command 边界和 CWD。取代脆弱的 regex 匹配。

### OSC 633 协议

VSCode 使用的 OSC（Operating System Command）标记：

| 序列 | 含义 | 用途 |
|------|------|------|
| `ESC ] 633 ; P ST` | Prompt 开始 | 精确定位 prompt 行 |
| `ESC ] 633 ; A ST` | Command 开始 | 标记用户输入区域起点 |
| `ESC ] 633 ; B ST` | Command 结束 | 用户按下回车，输入结束 |
| `ESC ] 633 ; C ST` | Command 输出开始 | 区分 prompt 和输出 |
| `ESC ] 633 ; D ; exitCode ST` | Command 结束 | 命令完成，携带退出码 |
| `ESC ] 633 ; E ; cwd ST` | CWD 更新 | 跟踪当前工作目录 |

其中 `ST` 可以是 `BEL`（`\x07`）或 `ESC \`（`\x1b\\`）。

### Shell 注入脚本

#### PowerShell (`shellIntegration.ps1`)

在 PTY 启动 PowerShell 时通过 `-Command` 参数预加载：

```powershell
# 保存为 shellIntegration.ps1，通过 dot-sourcing 加载
function Global:__tb_prompt_start() { Write-Host -NoNewline "`e]633;P`a" }
function Global:__tb_command_start() { Write-Host -NoNewline "`e]633;A`a" }
function Global:__tb_command_end() { Write-Host -NoNewline "`e]633;B`a" }
function Global:__tb_command_executed() { Write-Host -NoNewline "`e]633;C`a" }
function Global:__tb_command_finished($exitCode) { 
    Write-Host -NoNewline "`e]633;D;$exitCode`a" 
}
function Global:__tb_update_cwd() {
    $loc = $executionContext.SessionState.Path.CurrentLocation.Path
    Write-Host -NoNewline "`e]633;E;$loc`a"
}

# 重写 prompt 函数
function Global:prompt {
    __tb_command_finished $global:__tb_last_exit_code
    __tb_update_cwd
    __tb_prompt_start
    # 原始 prompt 内容
    $loc = $executionContext.SessionState.Path.CurrentLocation.Path
    Write-Host -NoNewline "PS $loc> "
    __tb_command_end
    $global:__tb_last_exitCode = $LASTEXITCODE
    return " "
}
```

注入方式：PTY 启动命令改为：
```
cmd.exe /c "chcp 65001 >nul && powershell -NoLogo -NoProfile -Command ". ./shellIntegration.ps1""
```

或更优雅地：通过 PowerShell 的 `$PROFILE` 或 `$env:USERPROFILE\Documents\PowerShell\Microsoft.PowerShell_profile.ps1` 自动加载。

#### cmd.exe (`shellIntegration.cmd`)

cmd.exe 通过 `PROMPT` 环境变量实现：

```batch
@echo off
:: shellIntegration.cmd - 设置 OSC 633 标记的 PROMPT
set PROMPT=$E]633;P$a$E]633;A$a$E]633;B$a$E]633;C $P$G$E]633;D;$?$E]633;E;$P$a
```

通过 `cmd.exe /k shellIntegration.cmd` 启动。

### ShellIntegrationAddon

```typescript
// src/terminal/ShellIntegrationAddon.ts

interface ShellIntegrationState {
  promptRow: number;        // prompt 所在行号（xterm buffer 行号）
  commandStartRow: number;  // 命令开始行
  cwd: string;              // 当前工作目录
  commandStatus: 'idle' | 'executing' | 'finished';
  lastExitCode: number;
}

class ShellIntegrationAddon implements ITerminalAddon {
  private state: ShellIntegrationState;
  
  // 检测 OSC 633 序列（在 xterm.js 的 output 路径上）
  // 使用 xterm.js 的 Parser API 或正则匹配
  
  // 事件
  onCommandStart: Event<void>;
  onCommandEnd: Event<{ exitCode: number }>;
  onCwdChange: Event<string>;
  onPromptReady: Event<{ row: number }>;
}
```

**实现要点**：
- 使用 xterm.js 的 `Terminal.parser.registerOscHandler(633, ...)` 注册 OSC 633 处理器
- 在 handler 中解析子命令（P/A/B/C/D/E），更新内部状态
- 通过事件通知 `TerminalInstance` 进行相应的 UI 更新

### 与 TerminalInstance 集成

```typescript
// 替换现有的 checkBufferForPrompt() regex 逻辑
// ShellIntegrationAddon.onPromptReady 事件直接提供精确的 prompt 行号

// 替换现有的 working 状态检测:
// 之前的: setTimeout(300ms) + regex 检查
// 之后的: onCommandStart → 立即标记 working
//         onCommandEnd → 立即标记 idle (带 exitCode)
```

### 展望：未来可基于此实现

- 命令高亮（标记命令输出区域）
- 命令快速跳转（VSCode 的 command navigation）
- 命令退出码可视化装饰
- 智能命令历史（知道哪些命令产生了什么输出）

## 组件 2：DSR 处理（P1，0.5 天）

### 问题

ConPTY 可能向输出流注入 DSR（Device Status Report）查询序列 `\e[6n]`，要求终端回复当前光标位置。如果 xterm.js 不知道如何处理这个查询，TUI 程序可能收到错误的或缺失的回复，导致光标位置不同步。

### 方案

```typescript
// src/terminal/DsrHandlerAddon.ts

// 在 PTY → xterm.js 的写入路径上:
// 1. 拦截输出中的 \e[6n 序列
// 2. 从 xterm.js buffer 获取当前 cursor 位置 (row, col)
// 3. 生成回复序列 \e[{row};{col}R
// 4. 将回复注入到 xterm.js 的 input 端 (模拟 PTY 收到的回复)
// 5. 从输出中移除 \e[6n，防止到达渲染层
```

**实现要点**：
- 在 `Terminal.write()` 的数据路径上进行拦截
- 使用 xterm.js 的 `buffer.active.cursorY` 和 `buffer.active.cursorX` 获取位置
- 回复通过 `terminal.input()` 注入（xterm.js 的输入 API）
- 需要处理行号偏移（DSR 使用 1-based，xterm.js buffer 使用 0-based）

## 组件 3：写入同步增强（P2，1-2 天）

### 问题

当 TUI 程序快速输出大量数据时（如 Claude Code 的 spinner + 内容更新），write callback 追踪可以判断"是否在解析中"，但没有进一步的优先级控制。

### 方案：TerminalWriteBuffer

借鉴 VSCode 的写入缓冲策略：

```typescript
// src/terminal/TerminalWriteBuffer.ts

enum WritePriority {
  Critical = 0,  // 用户输入回显
  Normal = 1,    // 一般 PTY 输出
  Low = 2,       // 装饰性更新
}

interface BufferedWrite {
  data: string;
  priority: WritePriority;
  timestamp: number;
}

class TerminalWriteBuffer {
  private queue: BufferedWrite[] = [];
  private isParsing = false;
  
  write(data: string, priority: WritePriority = WritePriority.Normal) {
    if (this.isParsing && priority > WritePriority.Critical) {
      this.queue.push({ data, priority, timestamp: Date.now() });
      return;
    }
    this.doWrite(data, priority);
  }
  
  // 当 write callback 确认 parse 追上后调用
  flush() {
    if (this.queue.length === 0) return;
    
    // 合并连续的同优先级写入，减少渲染次数
    const merged = this.mergeByPriority(this.queue);
    this.queue = [];
    
    for (const write of merged) {
      this.doWrite(write.data, write.priority);
    }
  }
}
```

### 与 TerminalInstance 集成

```typescript
// 在 handleOutput 中:
const writeBuffer = new WriteBuffer(terminal);

// PTY output → writeBuffer.write(data, Normal)
// Terminal input echo → writeBuffer.write(data, Critical)

// Write callback → writeBuffer.onParseComplete → writeBuffer.flush()
```

## 组件 4：IME 增强（P3，1 天）

### 问题

当前的 IME 冻结方案在大多数场景下有效，但在极端情况下（TUI 程序重绘频率 > 60fps），xterm.js 的 canvas 渲染仍可能更新 cursor 位置，导致 IME 候选窗口与光标视觉位置不一致。

### 方案

```typescript
// 增强 compositionstart 处理:

ta.addEventListener('compositionstart', () => {
  // 1. 记录 cursor 像素位置 (已有: originalUpdate 一次性定位)
  isComposingRef.current = true;
  
  // 2. 新增: 在 xterm.js 的渲染回调中抑制 cursor 绘制
  //    通过 monkey-patch _renderService.refresh
  const core = (terminal as any)._core;
  const originalRender = core?._renderService?.refresh?.bind(core._renderService);
  if (originalRender) {
    core._renderService.refresh = (start: number, end: number) => {
      if (isComposingRef.current) {
        // 只更新内容，不更新 cursor 位置
        // xterm.js 的 refresh(start, end) 会重绘指定行范围
        // 我们需要让它跳过 cursor layer 的更新
        originalRender(start, end);
        // 渲染后将 cursor layer 恢复到 compositionstart 时的位置
        return;
      }
      originalRender(start, end);
    };
  }
});

// compositionend 时恢复原始 render
ta.addEventListener('compositionend', () => {
  isComposingRef.current = false;
  // 恢复原始 render 函数
  if (originalRender) {
    core._renderService.refresh = originalRender;
  }
  // flush buffered output (已有逻辑)
});
```

**注意**：此实现依赖 xterm.js 内部 API（`_renderService`），需要在升级 xterm.js 时验证兼容性。

## 组件 5：Alt Buffer 智能处理（P4，0.5 天）

### 当前行为

进入 alt buffer → 完全禁止 resize → 退出时一次性 resize。

### 改进

```typescript
// Alt Buffer 策略增强:

const altBufferStrategy = {
  onEnter() {
    // 记录进入时的 dimensions
    savedDimensions = { cols: terminal.cols, rows: terminal.rows };
    inAltBufferRef.current = true;
  },
  
  onExit() {
    inAltBufferRef.current = false;
    // 延迟 50ms 后检查是否需要 resize
    // (让 TUI 程序完成退出清理)
    setTimeout(() => {
      if (terminal.cols !== savedDimensions.cols || 
          terminal.rows !== savedDimensions.rows) {
        resizeTerminal(terminalId, terminal.rows, terminal.cols);
      }
      forceViewportRefresh();
    }, 50);
  },
  
  // 新增: 区分 resize 来源
  shouldResize(isUserInitiated: boolean) {
    if (!inAltBufferRef.current) return true;
    // 用户手动改变 font size 时仍然允许 resize
    return isUserInitiated;
  }
};
```

## 文件结构

```
terminal-buddy/src/
├─ terminal/
│  ├─ ShellIntegrationAddon.ts     # OSC 633 解析 addon
│  ├─ DsrHandlerAddon.ts           # DSR 处理 addon  
│  ├─ TerminalWriteBuffer.ts       # 写入缓冲管理
│  └─ types.ts                     # 共享类型定义
├─ components/
│  └─ TerminalInstance.tsx          # 集成各 addon
└─ ...

terminal-buddy/src-tauri/
├─ shell-integration/              # Shell 注入脚本
│  ├─ shellIntegration.ps1         # PowerShell
│  ├─ shellIntegration.cmd         # cmd.exe
│  └─ shellIntegration.sh          # bash/zsh
```

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Shell 脚本注入影响启动速度 | 低 | 脚本极小（<1KB），注入通过环境变量完成，无额外 IO |
| OSC 633 标记增加输出数据量 | 低 | 每个标记 <10 字节，相比 PTY 输出可忽略 |
| xterm.js 内部 API 不稳定 | 中 | IME 增强依赖 `_renderService`，需在 xterm.js 升级时验证。Addon 和 DSR 处理使用公开 API，风险低 |
| cmd.exe 的 PROMPT 变量限制 | 低 | cmd.exe 的 PROMPT 变量支持 ANSI 转义，但功能有限。PowerShell 支持更完整的标记 |
| Shell Integration 脚本未加载 | 中 | 需要优雅降级：Addon 在未检测到 OSC 633 时回退到 regex 检测（保持现有行为） |

## 验收标准

1. **Shell Integration**：
   - PowerShell: prompt 位置精确检测（零误判）
   - cmd.exe: prompt 位置精确检测
   - bash/zsh: prompt 位置精确检测
   - 未加载脚本时：优雅降级到 regex 检测

2. **TUI 程序测试**：
   - Claude Code: 光标定位正确，无漂移
   - vim: 光标定位正确
   - htop: 界面刷新无闪烁

3. **IME 测试**：
   - PowerShell + 中文输入: 候选窗口不跳动
   - Claude Code TUI 中 + 中文输入: 候选窗口不跳动

4. **回归测试**：
   - 普通 shell 命令: 输入/输出正常
   - SSH 终端: 远程 shell 也能正确检测 prompt
   - 多终端分屏: 各终端独立工作
