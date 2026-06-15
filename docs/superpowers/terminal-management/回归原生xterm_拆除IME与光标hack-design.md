# 回归原生 xterm：拆除 IME 与光标 hack

## 背景

`TerminalInstance.tsx` 在过去多轮"修复 claude code 这种 TUI 在 TerminalBuddy 里光标抖动 + 中文 IME 候选词框漂移"的尝试中，叠加了 4 层 hack。2026-06-13 的复盘已确认这些 hack 互相打架、收益递减、且**不存在于 VSCode 的 `xtermTerminal.ts` 实现中**。本设计撤销这 4 层 hack，回到接近 VSCode 风格的"裸 xterm.write"基线，作为后续修复的起点。

> "有问题再修复" — 用户在头脑风暴阶段明确：先看干净 baseline，发现具体问题后再针对性补，不再叠 hack。

## 目标 & 非目标

**目标**

- 删除 `TerminalInstance.tsx` 中所有为对抗"TUI 光标 + IME 候选词框"而引入的代码（4 层 hack + 派生的 resize 节流 + 死字段）
- 让 `handleOutput` 形态收敛为 VSCode 风格：单次 `xterm.write(output)`，无攒批、无强制刷帧、无 composition 缓冲
- 保留与 hack 无关、解决真问题的代码（启动期 `outputBuffer`、alt-buffer resize 跳过）

**非目标**

- 不再在拆除中**新增**任何"修复 IME 漂移"的代码——拆完就是拆完，看 baseline
- 不修改 `portable-pty` / Rust 后端 / `web/` 目录下的任何代码
- 不动 `TerminalPanel`、`TerminalTab` 等周边组件
- 不重写 resize 整体策略；只去掉跟那 4 层 hack 配套的"等 parse 完再 fit"分支
- 不推翻 [[vscode-fork-decision]]：本次只是"在接受 vscode-fork 大方向的前提下，把 TB 这套终端代码先收拾干净"
## 拆除清单（按代码段编号）

所有改动集中在 `terminal-buddy/src/components/TerminalInstance.tsx`。行号基于 commit `1429435` 当前状态。

### ① composition 期间 buffer PTY 输出（冻屏）

**位置**：`:91, :143-149, :288-301, :841`

**当前行为**：composition 期间不写 xterm，把 PTY 输出塞进 `compositionBuffer`，`compositionend` 时一次性 flush。目的是让候选词框"看起来不动"。

**拆除动作**：

- 删除 `compositionBuffer` 数组
- `handleOutput` 中删除 `if (isComposingRef.current) { compositionBuffer.push(output); return; }`
- 删除 `compositionend` 监听里的 flush 分支
- 删除清理钩子里的 `compositionBuffer.length = 0`

### ② monkey-patch `compositionHelper.updateCompositionElements`

**位置**：`:267-316`

**当前行为**：把 xterm 私有 `_compositionHelper.updateCompositionElements` 替换成"composition 期间直接 return"，冻结 textarea 位置。注释自称"modeled after VSCode"——实际 VSCode 没有此代码。

**拆除动作**：

- 整段 `try { const core = (terminal as any)._core; ... } catch {}`（含 compositionstart/compositionend 监听）一并删除
- 不再触碰 `_core._compositionHelper` 任何私有 API

### ③ `inputBoxPos` 锚定候选词框到输入框

**位置**：`:95, :275-285, :512-518`

**当前行为**：分两处工作。
- ② 段内（`:275-285`）的 compositionstart 监听里，把 textarea 拉到 `inputBoxPos`
- 普通输入路径（`:512-518`）里，从 `ta2.style.left/top` 实时抓位置写入 `inputBoxPos`

意图：让候选词框"贴在用户的输入框"，而不是 compositionstart 那一刻 xterm 光标所在的位置（往往是 spinner）。

**拆除动作**：

- 删除 `inputBoxPos` 局部变量
- compositionstart 那一处的引用随 ② 整段删除而消失
- **`:512-518` 的抓取逻辑独立存在，需单独删除**（不会被 ② 的拆除带走）

### ④ `_renderService.refresh()` 强制同步刷帧

**位置**：`:126-137`，`xterm.write` 的回调

**当前行为**：每次 write 完成后直接调 `core?._renderService?.refresh?.(0, rows-1)` 全屏强制刷新，绕过 xterm 自己的 rAF 调度，对抗"1-frame 光标漂移"。VSCode 不这么做；记忆里也写过"光标漂移的根因不是它"。

**拆除动作**：

- 删除 write 回调，回到 `xterm.write(output)` 不带回调的形态（与 ⑤ 合并完成）
- 不再访问 `_renderService` / `_bufferService` / `_core` 任何私有 API

### ⑤ `pendingChunks` + `queueMicrotask` 攒批

**位置**：`:88-89, :116-138, :150-159`

**当前行为**：`handleOutput` 把 output 推到 `pendingChunks`，下一个 microtask 合并后再调 `xterm.write`。

**拆除动作**：

- 删除 `pendingChunks`、`pendingMicrotask`、`flushPendingChunks`
- `handleOutput` 中直接 `xtermRef.current.write(output)`（保留 `outputBuffer` 分支用于 xterm 未就绪时）

### ⑥ resize 节流里"等 write/parse 完成"分支

**位置**：`:337-352`

**当前行为**：`doFit` 里两段延后逻辑：
- `writeAge < 100` → setTimeout 100-writeAge 后重试
- `latestWriteDataRef !== latestParseDataRef` → setTimeout 16ms 重试

注释自称"learned from VS Code"——实际是为配合 ④ 的 write 回调而引入的伪 VSCode 风格节流。

**拆除动作**：

- `doFit` 里删除上述两段，`if (inAltBufferRef.current) return;` 之后**直接** `fitAddon.fit() + resizeTerminal(...)`
- `inAltBufferRef` 检查保留（解决真问题，与 hack 无关）

### 死字段清理

随上述拆除产生的孤儿字段，一并删除：

| 字段 | 原位置 | 仅由谁使用 |
|---|---|---|
| `isComposingRef` | `:75` | ① / ② |
| `compositionBuffer` | `:91` | ① |
| `inputBoxPos` | `:95` | ③ |
| `latestWriteDataRef` | `:71` | ④ / ⑥ |
| `latestParseDataRef` | `:72` | ④ / ⑥ |
| `lastWriteTimeRef` | `:73` | ④ / ⑥ |

注释里"learned from VS Code's terminalInstance.ts/_writeProcessData/_flushXtermData/terminalResizeDebouncer"等夸大引用一并删除——这些注释会误导后续读代码的人。
## 保留清单（明确不动）

以下代码与本次拆除**无关**、解决的是真问题，按"surgical changes，不动相邻代码"原则保留：

| 代码 | 位置 | 为什么留 |
|---|---|---|
| `outputBuffer` 启动期缓冲 | `:87, :161-162, :318-321` | 解决 `initTerminal` async 期间 PTY 已开始喷数据的真实时序窗口；VSCode 因初始化路径不同不需要，但 TB 需要 |
| `inAltBufferRef` + alt-buffer resize 跳过 | `:67, :332` | xterm.js 通用最佳实践，TUI 在 alt buffer 时禁止 resize 是 vim/claude code 都依赖的行为 |
| ResizeObserver 大缓冲 debounce | `:380-440` 一带 | 跟 IME / 光标 hack 无关，是处理浏览器 resize 抖动的独立机制 |
| 输入历史 / autocomplete / 工作状态判定 | `:164-179`、`:545-` | 与终端渲染基线无关 |
| Working state debounce (`workingDebounce` / `workingFallback`) | `:165-179` | 业务功能（标签呼吸灯）专用，不在终端渲染路径里 |

## 拆除后的代码形态（预期）

### `handleOutput`

```ts
const handleOutput = (output: string) => {
  if (disposed || !output) return;
  if (xtermRef.current) {
    xtermRef.current.write(output);
  } else {
    outputBuffer.push(output);
  }

  // working state debounce 保留原样
  if (workingDebounce) clearTimeout(workingDebounce);
  if (workingFallback) clearTimeout(workingFallback);
  workingDebounce = setTimeout(() => { /* 原逻辑 */ }, 300);
  workingFallback = setTimeout(() => { /* 原逻辑 */ }, 1500);
};
```

`pendingChunks` / `queueMicrotask` / `flushPendingChunks` / write 回调全部消失。

### `doFit`

```ts
const doFit = () => {
  if (disposed || !xtermRef.current || !fitAddonRef.current) return;
  if (inAltBufferRef.current) return;

  const prevCols = terminal.cols;
  const prevRows = terminal.rows;
  fitAddonRef.current.fit();
  if (terminal.cols !== prevCols || terminal.rows !== prevRows) {
    if (!lastPtyDimensionsRef.current ||
        lastPtyDimensionsRef.current.cols !== terminal.cols ||
        lastPtyDimensionsRef.current.rows !== terminal.rows) {
      lastPtyDimensionsRef.current = { cols: terminal.cols, rows: terminal.rows };
      resizeTerminal(terminalId, terminal.rows, terminal.cols).catch(() => {});
    }
  }
  lastDimensionsRef.current = { cols: terminal.cols, rows: terminal.rows };
};
```

"等 write 完"和"等 parse 完"两段延后整段消失；alt-buffer 跳过保留。

### IME 相关

整段 `_compositionHelper` monkey-patch / compositionstart / compositionend 监听消失。xterm 自己的 IME 处理保持默认行为。

## 预期 baseline 行为（已与用户确认）

拆除后跑 claude code / vim / htop 这类 TUI，预期表现：

| 维度 | 拆除前（现状） | 拆除后（baseline） |
|---|---|---|
| spinner / 进度条流畅度 | composition 期间冻屏，结束时突刷 | **流畅**，与 PTY 实时同步 |
| 中文 IME 候选词框位置 | 固定在输入框（compositionstart 时锚定） | **跟随 xterm cursor**，TUI 重绘移动光标时**会漂到 spinner / 状态栏处** |
| 方块光标 1-frame 漂移 | 用 `_renderService.refresh` 强制对齐 | xterm 默认 rAF 调度；与 VSCode 行为一致 |
| resize 期间瞬时光标跳动 | "等 parse 完再 fit"延后 | 直接 fit；TUI 程序自己重绘修复 |

**已知代价**：候选词框漂移会回归为可见症状。这是有意接受的——用户在头脑风暴中明确选项 A："先看 baseline，有问题再修复"。

## 验证步骤（实施时按此跑）

1. `cd terminal-buddy && npx tsc --noEmit` —— 无 unused-var / 无类型错误
2. `cd terminal-buddy/src-tauri && cargo check` —— 不应有 Rust 改动，仅作 sanity check
3. `npm run tauri dev` 启动后，依次手测：
   - **PowerShell tab**：普通命令行 + 中文输入候选词框是否正常出现在光标下
   - **claude code**：观察 spinner 是否流畅；中文输入是否能完成（候选词框漂移可见，但**输入功能本身不能坏**）
   - **vim**：`:set number` / `i` 进入插入模式 / 中文输入 / `<Esc>:wq` —— 候选词框允许漂，但能正常落字
   - **resize**：拖窗口边缘 → 横向变化 → 终端不应崩屏，TUI 程序应能重绘
   - **alt-buffer 进出**：vim 退出后能否正确 fit
4. 截图或录屏对比 baseline 与现状的 spinner 流畅度差异（用于决定下一轮是否补什么）

## 回滚策略

- 整体拆除集中在**单一文件**、**单次 commit**：`terminal-buddy/src/components/TerminalInstance.tsx`
- commit message 形如 `[terminal] 回归原生 xterm：拆除 IME 与光标 hack`
- 若 baseline 不可接受（例如候选词框漂移影响到完全无法输入），直接 `git revert <hash>` 即可一键回到现状
- 不与其他 feature 改动混入同一个 commit

## 后续（不在本设计范围内）

baseline 跑出来后，根据实际症状再决定下一步：

- 候选词框漂移如果**只在 claude code 出现**、其他场景正常 → 可能是 ink TUI 特有问题，需要单独研究
- 候选词框漂移**所有 TUI 都出现** → 可能是 xterm 6.0 + windowsPty 的默认行为问题，需要研究 xterm 版本差异
- 任何新增修复方案都必须通过新一轮头脑风暴 + design，不再在本文件追加
- 长远方向仍是 [[vscode-fork-decision]]：以 open-vscode 为基底；本次拆除让 TB 这套代码至少干净到"能干净退场"的状态

## 相关记忆

- [[terminal-subsystem-pain]] —— 2026-06-13 痛点复盘，本设计直接落地其结论"别再叠 hack"
- [[vscode-fork-decision]] —— 2026-06-11 长期方向，本次拆除不与其冲突，是它的前置清理

