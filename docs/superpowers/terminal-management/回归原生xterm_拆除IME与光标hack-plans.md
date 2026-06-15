# 回归原生 xterm 拆除 IME 与光标 hack 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `TerminalInstance.tsx` 中所有为对抗"TUI 光标 + IME 候选词框漂移"而引入的 hack（4 层渲染干预 + 配套 resize 节流 + 死字段）整体撤除，回到接近 VSCode `xtermTerminal.ts` 的"裸 xterm.write"基线。

**Architecture:** 单文件改动 (`terminal-buddy/src/components/TerminalInstance.tsx`)，三次拆除提交 + 一次手测。Task 1 拆 IME 三件套（compositionBuffer / monkey-patch / inputBoxPos），Task 2 拆渲染攒批和 resize 节流（refresh / pendingChunks / writeAge & parse 延后），Task 3 整体跑 tsc 与手测确认 baseline。每个 Task 独立 commit、独立 revert。

**Tech Stack:** React 18 + TypeScript + xterm.js v6 + portable-pty (ConPTY) + Tauri 2.x。无新增依赖。

**Design Doc:** `docs/superpowers/terminal-management/回归原生xterm_拆除IME与光标hack-design.md`

**Project context:**
- 项目无自动化测试（CLAUDE.md 明文："No automated tests exist in the project"）
- 改动在 xterm 渲染路径，手测价值远高于单元测试
- 验收方式：`npx tsc --noEmit` 通过 + 手测 PowerShell / claude code / vim / resize / alt-buffer

---

## File Structure

**修改文件**（唯一）：
- `terminal-buddy/src/components/TerminalInstance.tsx`

**不动**：
- `terminal-buddy/src-tauri/**`（Rust 后端）
- `terminal-buddy/web/**`（Web SPA）
- `terminal-buddy/src/components/TerminalPanel.tsx` / `TerminalTab.tsx` 等周边组件

**保留代码（明确不动，verify-only）**：

| 代码 | 当前位置 | 不动原因 |
|---|---|---|
| `outputBuffer` 启动期缓冲 | `:87, :161-162, :318-321` | 解决 initTerminal async 期间的真实时序窗口，与 hack 无关 |
| `inAltBufferRef` + alt-buffer resize 跳过 | `:67, :332` | TUI 通用最佳实践 |
| ResizeObserver debounce / 大缓冲 immediate | `:380-440` 一带 | 处理浏览器 resize 抖动，独立机制 |
| autocomplete / working state debounce | `:164-179`, `:545-` | 业务功能，与渲染基线无关 |

---

## Task 1: 拆除 IME 三件套（① composition 冻屏 / ② monkey-patch / ③ inputBoxPos 锚定）

**Skills:** _none_ — 纯代码删除，无 skill 指导需求；TerminalBuddy 项目无对应 skill 库。

**Files:**
- Modify: `terminal-buddy/src/components/TerminalInstance.tsx`

**Acceptance Criteria:**

- [ ] C1: `npx tsc --noEmit` 通过，无 unused-var、无 reference-not-found 错误
- [ ] C2: 文件中已不存在 `isComposingRef`、`compositionBuffer`、`inputBoxPos` 三个标识符（grep 验证）
- [ ] C3: 文件中已不存在 `_compositionHelper`、`updateCompositionElements`、`compositionstart`、`compositionend` 字符串（grep 验证）
- [ ] C4: 文件中已不存在 `_compositionView` 字符串（grep 验证）
- [ ] C5: `npm run tauri dev` 启动后能打开 PowerShell tab，能输入英文，**中文 IME 可输入**（候选词框可能跟随光标移动，这是接受的；功能本身不能坏）

---

- [ ] **Step 1.1: 删除 `isComposingRef` 声明**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx`，删除以下两行（位于 `:74-75` 一带）：

```ts
  // IME composition state — buffered output during composition prevents cursor drift
  const isComposingRef = useRef(false);
```

- [ ] **Step 1.2: 删除 `handleOutput` 中的 composition 分支**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx` 中 `handleOutput` 函数（`:140-180` 一带），删除以下整段（包含三行注释 + if 块共 7 行）：

```ts
        // During IME composition: buffer output to prevent screen updates
        // from moving the cursor and causing the IME candidate window to jump.
        // Flush happens on compositionend.
        if (isComposingRef.current) {
          compositionBuffer.push(output);
          return;
        }
```

删除后该位置直接进入 `pendingChunks.push(output)`（`pendingChunks` 在 Task 2 才删，此步保留）。

- [ ] **Step 1.3: 删除 `compositionBuffer` 与 `inputBoxPos` 局部变量声明**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx` 中 useEffect 顶部局部变量区（`:87-95` 一带），删除：

```ts
    // Output queued during IME composition — flushed when composition ends
    const compositionBuffer: string[] = [];
    // IME candidate-window anchor: the textarea position captured during ordinary
    // (non-IME) typing, i.e. the input box. Used to pin the candidate window there on
    // compositionstart instead of wherever the cursor happens to be (often the spinner).
    let inputBoxPos = { left: '', top: '' };
```

保留 `outputBuffer` / `pendingChunks` / `pendingMicrotask` 等其他局部变量。

- [ ] **Step 1.4: 删除 monkey-patch `_compositionHelper` 整段**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx`（`:248-316` 一带），删除从注释 `// --- IME candidate window stabilization ---` 到 `// xterm.js internal API may change between versions` 的整段 `try { ... } catch { ... }`，包括：

- 注释块（17 行）
- `try { const core = (terminal as any)._core; const compositionHelper = core?._compositionHelper; ... }` 整体
- 内部的 `compositionstart` / `compositionend` 监听器
- 内部对 `compositionHelper.updateCompositionElements` 的赋值替换
- 末尾的 `catch { /* xterm.js internal API may change between versions */ }`

删除后，前一行是 `lastPtyDimensionsRef.current = { cols: terminal.cols, rows: terminal.rows };`，后一行是 `// Flush buffered output that arrived before xterm was ready`。

- [ ] **Step 1.5: 删除 `terminal.onData` 回调里的 inputBoxPos 抓取逻辑**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx`（`:511-520` 一带），删除 `terminal.onData((data) => {` 内部前段的 9 行：

```ts
        // Capture the input-box anchor during ordinary typing (the cursor is then in
        // the input box). Used to pin the IME candidate window on compositionstart.
        if (!isComposingRef.current && !data.startsWith('\x1b')) {
          const ta2 = (terminal as any).textarea as HTMLTextAreaElement | undefined;
          if (ta2 && ta2.style.left) {
            inputBoxPos.left = ta2.style.left;
            inputBoxPos.top = ta2.style.top;
          }
        }
```

`terminal.onData((data) => {` 外壳保留，下一行 `// Track command history on Enter` 紧接 `(data) => {`。

- [ ] **Step 1.6: 删除清理钩子里的 `isComposingRef.current = false` 与 `compositionBuffer.length = 0`**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx`（`:840-841` 一带），删除两行：

```ts
      isComposingRef.current = false;
      compositionBuffer.length = 0;
```

保留前后的 `latestWriteDataRef.current = 0`、`cleanupFns.forEach(...)` 等（这些 ref 在 Task 2 一并清理）。

- [ ] **Step 1.7: 编译验证**
  **Skills:** _none_

```bash
cd terminal-buddy && npx tsc --noEmit
```

期望：无错误。如果出现 `Cannot find name 'isComposingRef'` / `'compositionBuffer'` / `'inputBoxPos'`，说明有遗漏引用，回到对应 Step 检查。

- [ ] **Step 1.8: grep 验证拆除完整性**
  **Skills:** _none_

```bash
cd terminal-buddy && grep -nE "isComposingRef|compositionBuffer|inputBoxPos|_compositionHelper|updateCompositionElements|_compositionView|compositionstart|compositionend" src/components/TerminalInstance.tsx
```

期望：**无任何输出**。有任一命中即说明遗漏，回看 Step 1.1–1.6。

- [ ] **Step 1.9: Commit**
  **Skills:** _none_

```bash
cd D:/gitee/TerminalBuddy
git add terminal-buddy/src/components/TerminalInstance.tsx
git commit -m "[terminal] 拆除 IME composition 冻屏与 textarea monkey-patch"
```

注意：**只 add 这一个文件**，工作区当前还有 `M terminal-buddy/src-tauri/src/commands/fs.rs` 和 `?? AGENTS.md` 是无关改动，不要混入。

---

## Task 2: 拆除渲染攒批与 resize 节流（④ refresh / ⑤ pendingChunks / ⑥ writeAge & parse 延后）

**Skills:** _none_ — 纯代码删除与简化，无 skill 指导需求。

**Files:**
- Modify: `terminal-buddy/src/components/TerminalInstance.tsx`

**Acceptance Criteria:**

- [ ] C1: `npx tsc --noEmit` 通过，无 unused-var
- [ ] C2: 文件中已不存在 `latestWriteDataRef`、`latestParseDataRef`、`lastWriteTimeRef`、`pendingChunks`、`pendingMicrotask`、`flushPendingChunks` 共 6 个标识符（grep 验证）
- [ ] C3: 文件中已不存在 `_renderService`、`_bufferService`、`_core?._renderService` 字符串（grep 验证）
- [ ] C4: `handleOutput` 只剩 `xtermRef.current.write(output)` 一种写法（外加 `outputBuffer.push` 兜底分支与原 working state debounce）
- [ ] C5: `doFit` 中除 `if (inAltBufferRef.current) return;` 外，无任何"延后再 doFit"的 setTimeout
- [ ] C6: `npm run tauri dev` 启动后，`resize 拖窗口` 与 `vim 进出 alt-buffer` 均不崩屏

---

- [ ] **Step 2.1: 删除三个 write/parse 追踪 ref 声明**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx`（`:69-73` 一带），删除：

```ts
  // Output tracking refs (learned from VS Code's terminalInstance.ts)
  // These track write/parse state to ensure cursor position stays in sync
  const latestWriteDataRef = useRef(0);
  const latestParseDataRef = useRef(0);
  const lastWriteTimeRef = useRef(0);
```

保留前面的 `inAltBufferRef`、后面的 `setTermBg` useEffect。

- [ ] **Step 2.2: 简化 `handleOutput` 为裸 `xterm.write`**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx` 中 `handleOutput` 函数（Task 1 完成后大约位于 `:130-170` 一带），把整段：

```ts
      if (xtermRef.current) {
        pendingChunks.push(output);
        // Use microtask (queueMicrotask) instead of requestAnimationFrame.
        // Microtasks run before the browser's paint cycle, so the write + xterm render
        // completes in the same frame as the data arrival. rAF can introduce a 1-frame
        // delay because the callback might fire after the browser has already committed
        // the current frame's paint.
        if (!pendingMicrotask) {
          pendingMicrotask = true;
          queueMicrotask(flushPendingChunks);
        }
      } else {
        outputBuffer.push(output);
      }
```

替换为：

```ts
      if (xtermRef.current) {
        xtermRef.current.write(output);
      } else {
        outputBuffer.push(output);
      }
```

`handleOutput` 后续的 `workingDebounce` / `workingFallback` 部分保持原样。

- [ ] **Step 2.3: 删除 `pendingChunks` / `pendingMicrotask` 局部变量与 `flushPendingChunks` 函数**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx`，删除三处：

(1) useEffect 顶部局部变量区（Task 1 删完 `compositionBuffer`/`inputBoxPos` 后大约位于 `:80` 一带）：

```ts
    const pendingChunks: string[] = [];
    let pendingMicrotask: boolean = false;
```

(2) `flushPendingChunks` 整个函数定义（原 `:116-138`，Task 1 完成后行号会前移）：

```ts
    const flushPendingChunks = () => {
      pendingMicrotask = false;
      if (disposed || !xtermRef.current) return;
      const combined = pendingChunks.join('');
      pendingChunks.length = 0;
      if (!combined) return;
      // Use write callback to track parse state (learned from VS Code's _writeProcessData)
      // This ensures cursor position stays in sync when TUI programs update the screen
      const messageId = ++latestWriteDataRef.current;
      lastWriteTimeRef.current = Date.now();
      xtermRef.current.write(combined, () => {
        latestParseDataRef.current = messageId;
        // Force an immediate render after write completes, instead of waiting for
        // xterm.js's internal requestAnimationFrame. This ensures the cursor position
        // and screen content are rendered in the same frame as the data write,
        // preventing the 1-frame cursor drift that TUI programs (claude code, vim)
        // cause when they update the screen rapidly.
        try {
          const core = (xtermRef.current as any)?._core;
          core?._renderService?.refresh?.(0, core._bufferService.rows - 1);
        } catch { /* xterm internal API may change */ }
      });
    };
```

注意：`outputBuffer` 启动期 flush（位于 `// Flush buffered output that arrived before xterm was ready` 注释下方）保留不动——它是设计的保留项。

- [ ] **Step 2.4: 删除 `doFit` 中的 writeAge 延后与 parse-not-caught-up 延后**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx` 中 `doFit` 函数（原 `:325-367`，Task 1 完成后行号会前移），删除中间两段共 16 行：

```ts
        // Defer resize briefly after a write batch to let the renderer catch up.
        // This prevents cursor drift when TUI apps update the screen rapidly
        // (e.g., spinners, progress bars updating via escape sequences).
        const writeAge = Date.now() - lastWriteTimeRef.current;
        if (lastWriteTimeRef.current > 0 && writeAge < 100) {
          setTimeout(() => { if (!disposed) doFit(); }, 100 - writeAge);
          return;
        }

        // Check if terminal is still parsing data (learned from VS Code's _flushXtermData)
        // If data is being parsed, delay resize to avoid cursor position issues
        // This prevents the cursor from jumping when TUI programs update the screen
        if (latestWriteDataRef.current !== latestParseDataRef.current) {
          // Data is being parsed, schedule a retry after a short delay
          setTimeout(() => {
            if (!disposed) doFit();
          }, 16); // ~1 frame at 60fps
          return;
        }
```

删除后 `doFit` 函数变成（前段 `if (inAltBufferRef.current) return;` 直接接 `const prevCols = terminal.cols`）：

```ts
      const doFit = () => {
        if (disposed || !xtermRef.current || !fitAddonRef.current) return;

        // Don't resize while TUI is active in alternate buffer.
        // TUI programs (claude code, vim, htop) manage their own screen layout
        // and expect stable terminal dimensions.  Resize is triggered when
        // exiting the alt buffer via checkAltBuffer().
        if (inAltBufferRef.current) return;

        const prevCols = terminal.cols;
        const prevRows = terminal.rows;
        fitAddonRef.current.fit();
        // Sync new dimensions with PTY backend, avoiding redundant calls
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

并把 `doFit` 上方的注释 `// --- Resize handling (learned from VS Code's terminalResizeDebouncer) ---` 改为 `// --- Resize handling ---`（删掉夸大引用）。

- [ ] **Step 2.5: 删除清理钩子里的 ref 重置**
  **Skills:** _none_

修改 `terminal-buddy/src/components/TerminalInstance.tsx` 清理钩子（Task 1 删完 isComposing / compositionBuffer 后位于原 `:836-839` 一带），删除：

```ts
      // Reset output tracking refs
      latestWriteDataRef.current = 0;
      latestParseDataRef.current = 0;
      lastWriteTimeRef.current = 0;
```

保留 `cleanupFns.forEach(fn => fn())` 等其他清理。

- [ ] **Step 2.6: 编译验证**
  **Skills:** _none_

```bash
cd terminal-buddy && npx tsc --noEmit
```

期望：无错误。常见遗漏：`flushPendingChunks` 没删干净、`pendingChunks` 在某处仍被引用——如果有，按报错位置补删。

- [ ] **Step 2.7: grep 验证拆除完整性**
  **Skills:** _none_

```bash
cd terminal-buddy && grep -nE "latestWriteDataRef|latestParseDataRef|lastWriteTimeRef|pendingChunks|pendingMicrotask|flushPendingChunks|_renderService|_bufferService" src/components/TerminalInstance.tsx
```

期望：**无任何输出**。

补充检查（确认 `_core` 私有 API 都拆干净了）：

```bash
cd terminal-buddy && grep -nE "\(.+ as any\)\._core|terminal as any\)\._core|xtermRef\.current as any\)\._core" src/components/TerminalInstance.tsx
```

期望：**无任何输出**。

- [ ] **Step 2.8: Commit**
  **Skills:** _none_

```bash
cd D:/gitee/TerminalBuddy
git add terminal-buddy/src/components/TerminalInstance.tsx
git commit -m "[terminal] 拆除渲染强制刷帧与 resize 节流，回归裸 xterm.write"
```

---

## Task 3: 整体回归手测

**Skills:** _none_ — 手测脚本，无 skill 指导需求。

**Files:** 不修改任何文件。

**Acceptance Criteria:**

- [ ] C1: PowerShell tab 中英文输入正常，**候选词框**在普通输入下能正常出现（位置可以跟随 xterm cursor，不要求像旧 hack 那样固定在输入框）
- [ ] C2: claude code 跑起来后，**spinner / 进度条流畅**（不再有 composition 期间的卡顿突刷）；中文 IME 仍可输入完整一句话（候选词框漂移可见，但不应导致无法输入）
- [ ] C3: vim 中能用 `i` 进插入模式、输入中英文、`<Esc>:wq` 退出；进出 alt-buffer 后窗口尺寸正常 fit
- [ ] C4: 拖窗口横向 resize 时，终端不崩屏；TUI 程序（vim/claude code）能随之重绘
- [ ] C5: 切 tab 时尺寸自动重 fit，无残影
- [ ] C6: `cargo check` 通过（仅做 Rust sanity check，不应有 Rust 改动）

---

- [ ] **Step 3.1: TS 全量编译**
  **Skills:** _none_

```bash
cd D:/gitee/TerminalBuddy/terminal-buddy && npx tsc --noEmit
```

期望：无错误。

- [ ] **Step 3.2: Rust sanity check**
  **Skills:** _none_

```bash
cd D:/gitee/TerminalBuddy/terminal-buddy/src-tauri && cargo check
```

期望：无错误。Rust 后端不应被本次改动影响。

- [ ] **Step 3.3: 启动 dev 模式**
  **Skills:** _none_

```bash
cd D:/gitee/TerminalBuddy/terminal-buddy && npm run tauri dev
```

期望：窗口正常打开，无控制台报错。如果 console 有 `Cannot read property '_core'` / `_compositionHelper is not a function` 之类的私有 API 异常，说明拆除有遗漏。

- [ ] **Step 3.4: PowerShell 基础手测（验证 C1）**
  **Skills:** _none_

操作脚本：
1. 新建 PowerShell tab
2. 输入英文：`Get-Process | Select-Object -First 5` → Enter，应正常输出
3. 切到中文输入法，输入"你好世界"，按空格选词→Enter，应能成功落字成命令
4. 触发候选词框：连续输入"你好"，候选词框应出现在屏幕上（位置在 xterm cursor 附近即可，不要求精确）

通过 → 勾掉 C1。

- [ ] **Step 3.5: claude code 流畅度对比（验证 C2）**
  **Skills:** _none_

操作脚本：
1. 新建 tab，运行 `claude` 启动 claude code
2. 等到 `✶ Bootstrapping…` / `✢ Ionizing…` 这种 spinner 出现
3. **观察 spinner 是否流畅**——拆除前会在用户切到中文输入法、未提交时屏幕冻屏；拆除后应保持每帧刷新
4. 切到中文输入法，输入一句中文比如"帮我看看当前目录有什么文件"，按 Enter → 验证消息能正常发出
5. 候选词框可见漂移到 spinner 处是允许的（design doc 已确认接受）

通过 → 勾掉 C2。

- [ ] **Step 3.6: vim alt-buffer 验证（验证 C3）**
  **Skills:** _none_

操作脚本：
1. 新建 tab，运行 `vim test.txt`
2. 屏幕进入 alt-buffer（满屏 `~`）
3. 按 `i` 进入插入模式
4. 输入英文 `hello`、回车、再输入中文（IME 选词→Enter）
5. `<Esc>:wq` 保存退出
6. 退出后回到 PowerShell prompt，**窗口尺寸应自动 re-fit**（不应留下小尺寸的残影）

通过 → 勾掉 C3。

- [ ] **Step 3.7: resize 验证（验证 C4 + C5）**
  **Skills:** _none_

操作脚本：
1. 在 vim 或 claude code 运行中，**横向拖窗口边缘**多次（缩小→放大→缩小）
2. TUI 程序应能跟随重绘，不出现错位、不崩屏
3. 退出 TUI，在 PowerShell 中也拖一遍 → cols/rows 应正确同步到 PTY（可用 `mode con` 验证）
4. 多 tab 间切换 → 每个 tab 显示尺寸应正确

通过 → 勾掉 C4 + C5。

- [ ] **Step 3.8: 决定下一步**
  **Skills:** _none_

按手测结果分类：

- **全部 C1–C5 通过** → 拆除完成，本计划结束。可以告知用户 baseline 跑出来什么样，根据漂移程度再讨论是否需要新一轮修复（按 design doc 后续章节）
- **C2 失败：claude code 中文完全无法输入** → 不可接受。立刻 `git revert HEAD~2..HEAD` 回滚 Task 1+2 两次提交，重新评估
- **C3/C4/C5 失败：vim/resize 崩屏** → 检查是否误删了 `inAltBufferRef` 检查或 ResizeObserver debounce；按 grep 验证补回
- **候选词框漂移可见但其他都正常** → 这是 design doc 已接受的代价，**算通过**，不要回退

---

## Self-Review

按 writing-plans skill 的 9 项 checklist 自查：

**1. Spec coverage:**
- ① composition 冻屏 → Task 1 Step 1.2 + 1.3 + 1.6
- ② monkey-patch → Task 1 Step 1.4
- ③ inputBoxPos → Task 1 Step 1.3 + 1.5
- ④ refresh 强制刷帧 → Task 2 Step 1.3 (flushPendingChunks 删除时一并去掉)
- ⑤ pendingChunks 攒批 → Task 2 Step 2.2 + 2.3
- ⑥ resize 节流 → Task 2 Step 2.4
- 死字段 → Task 1 Step 1.1 / 1.3 / 1.6 + Task 2 Step 2.1 / 2.5
- 保留项（outputBuffer / inAltBufferRef / ResizeObserver / autocomplete） → 在 File Structure 段明示，验收脚本（Step 2.4 / 3.6 / 3.7）覆盖
- 验证步骤 → Task 3 全部覆盖
- 回滚策略 → Task 3 Step 3.8 写明
- 全部覆盖 ✅

**2. Placeholder scan:** 无 TBD / TODO / "implement later" / "similar to Task N" 等。每个 step 都给了完整待删/待写代码或完整命令。✅

**3. Type consistency:** 整个 plan 不引入新 type / 新方法签名，只删除现有标识符。`isComposingRef` / `compositionBuffer` / `inputBoxPos` / `latestWriteDataRef` / `latestParseDataRef` / `lastWriteTimeRef` / `pendingChunks` / `pendingMicrotask` / `flushPendingChunks` 共 9 个名字，在 Task 1 / Task 2 中拼写完全一致。✅

**4. Skill-derived example accuracy:** 所有 Task 都是 `Skills: _none_`（项目无对应 skill 库且操作为纯删除），无需 skill-derived example。✅

**5. Step-level skill assignments:** 全 plan 所有 step 标记 `_none_`。判断依据：每个 step 都是"删除指定行/grep 验证/git commit/编译/手测"——按 writing-plans 硬性规则表，这些类型必须 `_none_`。无 step 在创建业务代码。✅

**6. cshtml/HTML template specificity:** 不涉及 cshtml/HTML 模板。✅

**7. cshtml skill 分配检查:** 同上，N/A。✅

**8. `@model object` 扫描:** 不涉及。✅

**9. Acceptance criteria completeness:** 每个 Task 都有 ≥5 条可独立验证的 criteria，全部用观察行为表述（"无 unused-var" / "grep 无输出" / "spinner 流畅" / "中文能输入"），不依赖跨 task 的实现细节。✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/terminal-management/回归原生xterm_拆除IME与光标hack-plans.md`.

Two execution options:

**1. Subagent-Driven (推荐)** — 每个 Task 派一个新的 subagent 实施，task 间我做 review，迭代快

**2. Inline Execution** — 在当前 session 用 executing-plans skill 批量执行，带 checkpoint 让你 review

哪种？



