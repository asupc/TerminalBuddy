# AI 交付迭代 4 实施计划（P3：归档 / 调度 / 体验 / 小项打包）

> 本文件由 `2026-08-02-ai-delivery-iterations-1-4.md` 拆分而来（2026-08-02），实施依据为 `docs/ai-delivery-implementation-plan.md`（2026-08-02 定稿，4 轮核实）。完整 4 迭代拆分为：迭代 1（T1-T4）/ 迭代 2（P1）/ 迭代 3（P2）/ 迭代 4（本文件）。
> **前置依赖**：迭代 1 的 T2-2（attemptTimedOut 并入）、T2-3（APP_HANDLE）；迭代 3 的 Diff-1（Monaco 用法）等。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P3 迭代 4：产物归档与对比、资源感知调度、N12 attempt 运行时长展示、N13 错误本地化+banner 重试、N14-N21 小项打包、交付收尾报告（可选/待评估），共 6 个任务。

**Architecture:** 变更集中在 `src-tauri/src/`（services/commands/models/web）与 React 前端 `src/components/ai-delivery/`。N12/N13 为纯前端小改，归档/调度为独立后端能力，N14-N21 为清理性打包。

**Tech Stack:** Rust (Tauri 2), React ^19.2.6, TypeScript, @monaco-editor/react ^4.7.0（已就绪）, zip crate（需确认/新增）。

## Global Constraints

- 项目实际文件在 `terminal-buddy/` 子目录；`cd terminal-buddy` 后执行所有命令。
- 所有 Rust↔TS 序列化使用 camelCase（serde `rename_all = "camelCase"`，30 个结构体已有 30 处）。
- **任务状态全集（12 种）**：planned / ready / queued / running / succeeded / failed / policyViolation / rework / cancelled / awaitingReview / needsInput / skipped（迭代 2 引入）。
- **attempt 状态**：queued / running / needsInput / cancelled / failed / **completed**（成功态）/ policyViolation / interrupted（迭代 3 N6-2 引入）。无 `succeeded`。
- **delivery 状态**：drafting / planning / awaitingApproval / running / paused / cancelled / needsInput / completed / succeeded / failed / mergeFailed（迭代 3 引入）。
- 事件类型必须在 `src/components/ai-delivery/workspace-utils.ts` 的 `eventTypeNames` 注册中文名（现有 46 项，168-215 行 + 各迭代新增）。
- 事件由 `append_event` 统一 emit `ai-delivery-event`（迭代 1 T2-3 已收口）；**新增事件无需手动 emit**。
- 新 REST 路由必须在 `web/server.rs` 注册（AI 交付区块 49-96 行内追加），遗漏即 404。
- 单元测试落位 `src-tauri/src/services/ai_delivery_service.rs` 内 `#[cfg(test)]` 模块（先例：`agent_decision_tests` 5110、`terminal_command_tests` 5991），验收以 `cargo test` 通过为准。
- 前端 UI 文案用中文（简体）；commit message 格式 `[模块] 变更描述`。
- 所有新增模型字段必须有 `#[serde(default)]`（或 `Option`）以兼容旧 JSON 文件；前端类型必须同步 `src/types/aiDelivery.ts`。

---

## File Structure

### 修改（后端 `src-tauri/src/`）
- `services/ai_delivery_service.rs` — 归档命令/全局并发/check_capacity 索引/N16-N20
- `commands/ai_delivery.rs` + `lib.rs` — 命令注册/N17 恢复块
- `web/handlers/ai_delivery_handler.rs` — N17 handler 5 处
- `models/ai_delivery.rs` — N19/N20
- `path_service.rs` — 复用（不改）

### 修改（前端 `src/`）
- `src/components/ai-delivery/DeliveryDetail.tsx` — N12 时长/产物 Tab
- `src/components/ai-delivery/AiDeliveryWorkspace.tsx` — N13 错误处理
- `src/components/ai-delivery/AiDeliveryNav.tsx` — N21 版本号
- `src/services/tauri.ts`、`src/types/aiDelivery.ts` — 封装与类型
- 新建 `ArtifactView.tsx`、`utils/aiError.ts`

---

## 任务（建议顺序：N12 → N13 → 归档 → 调度 → N14-N21 打包 → 收尾）

### Task N12-1: attempt 运行时长展示

**Files:**
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（attempt 卡片 641-642，现只显示 startedAt）

**Interfaces:**
- Consumes: `AiAttempt.finishedAt`（models:372，闲置字段，类型已有）
- Produces: attempt 卡片显示运行时长（finishedAt - startedAt）与完成时间

- [ ] **Step 1: 卡片时长渲染**

`DeliveryDetail.tsx` attempt 卡片时间区（641-642）改为：

```tsx
const duration = (attempt: AiAttempt) => {   // 评审修正：参数名统一为 attempt（原稿 a/attempt 混用）
  if (!attempt.startedAt) return "—";
  const end = attempt.finishedAt ? new Date(attempt.finishedAt).getTime() : Date.now();
  const start = new Date(attempt.startedAt).getTime();
  const secs = Math.max(0, Math.round((end - start) / 1000));
  return secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
};
// 渲染：
<span className="ai-attempt-duration">运行 {duration(attempt)}</span>
{attempt.finishedAt && <span className="ai-attempt-finished">完成于 {new Date(attempt.finishedAt).toLocaleString("zh-CN")}</span>}
```

（运行中卡片显示至今时长，与迭代 1 T1-4 的实时弹窗口径一致——均基于 startedAt。）

- [ ] **Step 2: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/DeliveryDetail.tsx && git commit -m "[AI交付] attempt 卡片显示运行时长与完成时间"
```

---

### Task N13-1: 错误本地化 + banner 重试 + 轮询失败可见

**Files:**
- Modify: `terminal-buddy/src/components/ai-delivery/AiDeliveryWorkspace.tsx`（369 纯 `setError(String(reason))`；326/381/418/565 的 `reason instanceof Error` 模式；386 轮询 `.catch(() => undefined)` 静默）

**Interfaces:**
- Produces: `classifyAiError(err): { category, message, hint }`（网络/后端拒绝/超时/未知分类 + 「如何修复」文案）；错误 banner 带重试按钮；轮询失败显示弱提示不静默

- [ ] **Step 1: 错误分类工具**

新建 `src/components/ai-delivery/utils/aiError.ts`：

```ts
export interface ClassifiedError { category: string; message: string; hint: string; }

export function classifyAiError(err: unknown): ClassifiedError {
  const raw = err instanceof Error ? err.message : String(err);
  if (/network|fetch|failed to fetch|ECONN|disconnected/i.test(raw)) {
    return { category: "网络", message: raw, hint: "检查网络连接后重试" };
  }
  if (/timeout|超时/i.test(raw)) {
    return { category: "超时", message: raw, hint: "任务仍在运行或已超时，可查看事件列表确认" };
  }
  if (/not found|不存在|no such/i.test(raw)) {
    return { category: "资源缺失", message: raw, hint: "目标已删除或路径失效，请刷新后重试" };
  }
  return { category: "后端错误", message: raw, hint: "查看事件列表定位原因" };
}
```

- [ ] **Step 2: banner 组件**

`AiDeliveryWorkspace.tsx` 错误区（369）替换为：

```tsx
{error && (
  <div className="ai-error-banner">
    <strong>{classified.category}</strong>
    <span>{classified.message}</span>
    <span className="ai-error-hint">{classified.hint}</span>
    <button className="btn-secondary" onClick={retryLastAction}>重试</button>
    <button className="btn-secondary" onClick={() => setError("")}>关闭</button>
  </div>
)}
```

`retryLastAction` 保存最近一次失败的操作闭包（记录在 ref），点击重新执行。326/381/418/565 四处错误处理统一改走 `classifyAiError`。**评审修正：`error` 是 `useState("")` 的 string 态（AiDeliveryWorkspace.tsx:180）——关闭按钮必须 `setError("")` 而非 `setError(null)`（后者 tsc 编译失败）。**

- [ ] **Step 3: 轮询失败可见**

386 行 `.catch(() => undefined)` 改为弱提示：

```tsx
.catch(() => {
  setPollWarning((w) => (w ?? 0) + 1);  // 累计计数
});
// 渲染：{pollWarning > 0 && <span className="ai-poll-warning">轮询失败 {pollWarning} 次，界面可能非最新</span>}
```

（不打日志轰炸，仅横幅提示。）

- [ ] **Step 4: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/ && git commit -m "[AI交付] 错误分类本地化、banner 重试、轮询失败可见"
```

---

### Task 归档-1: 产物归档与对比

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（产物列表/读取/ZIP 命令）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs` + `lib.rs`
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（「产物」Tab）
- Create: `terminal-buddy/src/components/ai-delivery/ArtifactView.tsx`

**Interfaces:**
- Consumes: `path_service.rs` 的 `copy_dir_recursive`（82-95，模块级自由函数）；delivery 运行目录（plan.json / transcript.log / review.json 等）
- Produces: 命令 `list_delivery_artifacts(delivery_id) -> Vec<{path, size, modified_at}>`、`read_delivery_artifact(delivery_id, path) -> String`、`export_delivery_artifacts_zip(delivery_id, target_path) -> Result<String, String>`；「产物」Tab 浏览 + 跨交付 plan.json 并排对比（Monaco Diff）+ ZIP 下载

- [ ] **Step 1: 后端 3 命令**

`list_delivery_artifacts`：扫描交付目录下 plan.json/transcript.log/review.json 等已知产物文件（**两级结构：plan.json 在 manager run_dir（:5047）、transcript.log 在 attempt run_dir（:4916）、review.json（:2848）——需 `get_all_attempts(Some(delivery_id))` 枚举 + `terminal_run_dir_by_id`（4802）扫描**），返回元数据。`read_delivery_artifact`：**按路径读全文**（BOM/非 UTF-8 容错**复用 `read_attempt_output` 1580-1592 的容错模式，但不直接调用它**——其 transcript_tail 只取尾部 8000 字符）。`export_delivery_artifacts_zip`：用 `zip` crate（检查 Cargo.toml 是否已有；**评审确认无此依赖，需新增 `zip = "2"`**）打包交付目录 + 各 attempt run_dir 到 `target_path`。**评审修正：项目是 Tauri 2，无 `tauri::api::dialog::FileDialogBuilder`（Tauri 1 API）**——命令只收 target_path 字符串，前端用 `tauri-plugin-dialog` 的 save()（已有依赖）取路径后传入。

- [ ] **Step 2: 前端产物 Tab**

`DeliveryDetail.tsx` 加「产物」Tab：文件列表（点击预览 `readDeliveryArtifact`）+「对比此交付」按钮（选择另一交付 → 两个 plan.json 进 Monaco `DiffEditor` 并排）+「打包下载」按钮（调 `exportDeliveryArtifactsZip` 后打开路径）。

- [ ] **Step 3: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ src/components/ai-delivery/ src/services/tauri.ts src/types/aiDelivery.ts && git commit -m "[AI交付] 产物归档浏览/跨交付对比/ZIP 打包导出"
```

---

### Task 调度-1: 资源感知调度（全局并发上限 + 优先级队列）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`check_capacity` 3299-3354 现有项目级/Agent 级并发）

**Interfaces:**
- Consumes: `check_capacity`（全量读 attempt）；`select_agent`（3229 起）
- Produces: 全局并发上限常量 `GLOBAL_MAX_ATTEMPTS: usize`（默认 4，可配置）；派发前检查全局活跃 attempt 数；高优先级任务（workflow 首步/needsInput 已答）先派发；CPU/内存高负载时延迟派发

- [ ] **Step 1: 全局并发计数**

```rust
pub const GLOBAL_MAX_ATTEMPTS: usize = 4;  // 跨项目全局并发上限（后续可做设置项）

// 派发入口（dispatch_task_node / start_attempt 前）：
fn global_active_attempts() -> Result<usize, String> {
    // 复用 check_capacity 的活跃 attempt 过滤表达式（390/706/1125/1363/1649/3293/3307 的过滤）
    // 评审修正：统一三态 queued/starting/running（"starting" 全库从未赋值，仅防御性过滤——与既有 7 处过滤一致防语义漂移）
    let active = Self::get_all_attempts()?.iter()
        .filter(|a| matches!(a.state.as_str(), "queued" | "starting" | "running"))
        .count();
    Ok(active)
}
if Self::global_active_attempts()? >= GLOBAL_MAX_ATTEMPTS {
    return Err("全局并发已达上限，稍后重试".to_string());
}
```

- [ ] **Step 2: 优先级队列**

`check_capacity` 的调度循环改为优先派发高优先级（`execution_context == "taskWorktree"` 且是 workflow 首步、或 needsInput 已答任务）；低优先级（readonly/workspaceRoot）在有等待任务时延后。实现方式：调度选择时按优先级排序候选 ready 任务。

- [ ] **Step 3: 高负载延迟**

可选实现（`sysinfo` crate 未在依赖中则用简化策略——不新增依赖）：检查 `get_all_attempts` 中 running 数已达全局上限即视为高负载延迟派发（与 Step 1 重叠）；若引入 CPU 检测需新增依赖则标记 TODO 并在 PR 说明。**本任务以 Step 1+2 为主**，CPU/内存检测作为配置项预留（设置结构加 `global_max_attempts`，前端 AiUsageSettings 或设置页可选展示）。

- [ ] **Step 4: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ && git commit -m "[AI交付] 全局并发上限与优先级派发"
```

---

### Task N14-N21-1: 小项打包

> N14（attemptTimedOut 生效）已并入迭代 1 T2-2 的 watchdog 改造——**跳过**。本任务含 N15/N16/N17/N18/N19/N20/N21。

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（N16/N17/N18/N19/N20）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs`（N17/N19）
- Modify: `terminal-buddy/src-tauri/src/web/handlers/ai_delivery_handler.rs`（N17：handler 5 处 dispatch+start）
- Modify: `terminal-buddy/src-tauri/src/lib.rs`（N17：setup 恢复块 388-423）
- Modify: `terminal-buddy/src-tauri/src/models/ai_delivery.rs`（N19/N20）
- Modify: `terminal-buddy/src/components/ai-delivery/AiDeliveryNav.tsx`（N21）

**Interfaces:**
- Consumes: 迭代 1 的 T2-2/T2-3 基础设施
- Produces: N15 无死事件通道；N16 cancel_delivery 逐 attempt 事件；N17 统一 dispatch+start helper（8 处调用点）+ Web 静默失败修复；N18 check_capacity 内存索引；N19 死字段清理；N20 注释修正；N21 导航栏 Runtime 版本号

- [ ] **Step 1: N15 删除死事件通道**

`commands/ai_delivery.rs:262/279` 的 `emit("ai-delivery-decision", ...)`（前端无人监听，全库 11 处 listen 均非此通道）——直接删除这两处 emit，保留 append_event 主流程。

```bash
cd terminal-buddy && grep -rn "ai-delivery-decision" src-tauri/src/ src/
```

预期：删除后仅剩注释或零匹配。

- [ ] **Step 2: N16 cancel_delivery 逐 attempt 事件**

`cancel_delivery`（1362-1374 逐 attempt 循环）在每次 attempt 置 cancelled（1369）后补：

```rust
let _ = Self::append_event(&delivery_id, Some(&task_node_id), Some(&attempt_id), "attemptCancelled", "交付取消，任务已终止");
```

（循环内取 task_node_id：从 attempt.task_node_id 取。**评审修正：用 `let _ =` 吞事件错误——`?` 传播会使事件写盘失败时中断取消主流程。**）

- [ ] **Step 3: N17 统一 dispatch+start helper（评审修正：批量签名）**

**评审修正**：8 处调用点**全部**是「`dispatch_ready_tasks(delivery_id)`（批量，service:2469，内部循环 dispatch_task_node 并写 dispatchDeferred 事件）+ 逐 attempt 循环 start_attempt」——原稿单任务签名 `dispatch_and_start(delivery_id, task_node_id)` 无法替换任何一处。改为**批量签名**：

```rust
/// 统一派发 + 启动：dispatch_ready_tasks 后逐 attempt start_attempt，聚合错误
pub fn dispatch_ready_and_start(delivery_id: &str) -> Result<usize, String> { /* 返回启动的 attempt 数 */ }
```

实际调用点清单（**grep 实测 12 处**，非 8 处）：

```bash
cd terminal-buddy && grep -n "dispatch_task_node\|start_attempt\|dispatch_ready_tasks" src-tauri/src/commands/ai_delivery.rs src-tauri/src/web/handlers/ai_delivery_handler.rs src-tauri/src/lib.rs
```

- `commands/ai_delivery.rs`：2 组配对（resume 221-222 / answer 282-283，`let _ = start_attempt(...)` 丢弃结果）→ 改为调用 helper 并处理 Err（返回给前端，不再静默）；**3 个独立命令包装保留不替换**（`dispatch_ai_task_node` 303、`dispatch_ai_ready_tasks` 308、`start_ai_attempt` 322——原稿漏列 308）。
- `ai_delivery_handler.rs` 5 组配对（89-90/114-115/195-196/250-253/286-289）：3 处 `unwrap_or_default()` 吞错（approve 89 / answer_decision 114 / complete_attempt 195）→ 改为 `map_err(ApiError::BadRequest)?` 风格；retry 250 / dispatch 286 保持。
- `lib.rs`：378/379 是 `TERMINAL_BUDDY_TEST_DISPATCH_TASK_ID` debug 测试块（**保留不改**）；恢复块是 393（`dispatch_ready_tasks`）+ 402（`start_attempt`）一组配对（原稿只列 402、漏 393）→ 调 helper，保留既有 `boot_log` 日志。

> 调用点配对口径：`dispatch_ready_tasks` 返回 `Vec<attempt>`，紧跟逐 attempt `start_attempt`。commands 221-222/282-283、handler 5 组、lib.rs 393+402 均为此配对形态；303/308/322 是单功能独立命令包装，不在替换范围（共 12 个单元）。

- [ ] **Step 4: N18 check_capacity 内存索引**

`check_capacity`（3299-3354 每次 O(N) 文件读）→ 在 service 内加 `ACTIVE_ATTEMPTS: Mutex<HashSet<String>>` 内存索引：**语义定为「活跃集合」——attempt 置 queued/running/starting 时 insert，置任何非活跃态时 remove**。**评审修正：remove 集合必须含 `needsInput`**（等待决策非活跃非终态，漏掉会长期滞留索引 → check_capacity/global_active_attempts 误计为活跃 → 配额占满派发阻塞）。attempt 状态赋值点实测 **16 处**（772/956/1074/1369/1663/1841/1847/2598/2801/2878/2909/**2946（置 needsInput）**/3042/5571/5629/**6398（watchdog `fail_attempt_from_watchdog` 置 failed）**），以此作维护清单；`check_capacity` 与 `global_active_attempts`（调度-1 的辅助）改读索引（启动时重建索引一次）。

- [ ] **Step 5: N19 死字段清理**

- `AiProject.profile_id`：**结构体 `AiProject` 定义在 models/ai_delivery.rs:49-66，要删的 `profile_id` 字段在 :55**（原稿把 70-83/:74 误标为 AiProject——那其实是 `CreateAiProjectInput`，且 :55 正是要删的目标字段而非「其他内容」）。业务无读取逻辑（仅 service 274 复制、测试 5358 字面量）——删除字段 + 删除 service 274 的复制 + 测试字面量同步；`CreateAiProjectInput.profile_id`（**定义 models:70-83、字段 :74、service 测试构造点 5494**）**保留**（输入字段）。
- `AiDelivery.task_node_ids`（models:283-284）：使用点均在 service 内——**保留**（内部使用方较多，清理收益低风险高；改为在代码注释注明「内部字段，勿外部依赖」即可）。**本步骤只删 profile_id。**
- `AiAgent.startup_preset_name`：当前 HEAD ea369ac 全库无读取点（仅赋值：lib.rs:364 构造、测试 None），实为死字段；**迭代 3 预设-1 落地后**补 start_attempt 按 preset 展开 prompt/modelArgs 的读取逻辑则变非死——按迭代顺序执行到本迭代时它已启用，不动；若跳过迭代 3 则一并清理。

- [ ] **Step 6: N20 注释修正**

`models/ai_delivery.rs` 445-447 注释「prompt 前 500 字符摘要」→ 实现（service:1631-1632）读全文。**修正注释**（改为「prompt.txt — 完整内容」），不真截断（避免破坏现有消费方）。

- [ ] **Step 7: N21 导航栏 Runtime 版本号**

`AiDeliveryNav.tsx` 底部（或顶部）加：

```tsx
{currentRuntime && <span className="ai-nav-version">Runtime {currentRuntime.version ?? "未知"}</span>}
```

（**评审修正：AiDeliveryNav props 实际有 5 个（`runtimes: AiRuntimeProbe[]`、`isDetecting`、`error`、`onDetect`、`onOpenConfiguration`），无 currentRuntime 变量**——推导方式：`const currentRuntime = runtimes.find((r) => r.available && r.version);`（或按组件既有选中逻辑取）；`AiRuntimeProbe.version` 是 `Option<String>` / `string | null`（models:92 / types:420），渲染需 `?? "未知"` 兜底，否则 null 显示为空。）

- [ ] **Step 8: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit && cargo test 2>&1 | tail -5
```

预期：全通过（含既有 agent_decision_tests/terminal_command_tests）。

- [ ] **Step 9: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ src/components/ai-delivery/AiDeliveryNav.tsx && git commit -m "[AI交付] 打包小项：死通道/逐 attempt 事件/统一 helper/容量索引/死字段/注释/版本号"
```

---

### Task 收尾-1: 交付收尾报告与资产导出（可选/待评估）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（报告生成命令）
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（报告 Tab + Markdown 导出）

**Interfaces:**
- Consumes: 全量既有模型数据（attempts/summary/merge 记录）
- Produces: 命令 `generate_delivery_report(delivery_id) -> String`（Markdown：成功率/重试/返工链、实际耗时、合并分支与 commit、遗留问题）；前端报告 Tab + 「导出 Markdown」下载；**无头命令行模式 `--ai-delivery <项目> <需求> [--approve] [--notify]`**（评估项：实现前与用户确认收益，本任务只做报告生成）

- [ ] **Step 1: 报告生成**

service 加 `generate_delivery_report`：从 delivery + attempts + events + merge 记录聚合 Markdown 字符串（章节：概览/任务结果表/重试与返工链/耗时统计/合并信息/事件摘要/遗留问题=未完成任务清单）。

- [ ] **Step 2: 前端报告 Tab + 导出**

`DeliveryDetail.tsx` 加「报告」Tab 渲染 Markdown（复用既有 markdown 渲染，若项目无则简单 pre 展示）+「导出 .md」按钮（`navigator.clipboard` 或 Tauri 保存对话框——参照既有导出实现）。

- [ ] **Step 3: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ src/components/ai-delivery/ src/services/tauri.ts && git commit -m "[AI交付] 交付收尾报告生成与 Markdown 导出"
```

---

## 迭代 4 验证（DoD 源自规范 §6 各节验收标准）

全部任务完成后执行：

- [ ] `cd terminal-buddy && cargo test` — 全通过（含既有测试模块）
- [ ] `cd terminal-buddy && cargo check` — 无错误无警告
- [ ] `cd terminal-buddy && npx tsc --noEmit` — 无错误
- [ ] N12：attempt 卡片可见运行时长与完成时间
- [ ] N13：错误显示分类与操作提示；banner 可触发重试；轮询失败不再静默
- [ ] 归档：产物可浏览、可跨交付对比、可打包下载
- [ ] 调度：全局并发上限生效；高优先级任务先派发；高负载时派发延迟
- [ ] N14：超时任务触发 attemptTimedOut 事件，前端染色生效（迭代 1 T2-2 验证）
- [ ] N15：无死事件通道（ai-delivery-decision 零匹配）
- [ ] N16：取消交付产生逐 attempt 的 attemptCancelled 事件
- [ ] N17：单点 helper；Web 端派发错误不再静默吞掉
- [ ] N18：多交付并发时派发不再 O(N) 读盘
- [ ] N19：无未消费字段（除随迭代 3 预设-1 落地的字段外）
- [ ] N20：注释与实现一致
- [ ] N21：导航栏显示 Runtime 版本
- [ ] 收尾（如实现）：报告可生成与导出；无头模式未评估前不实现

## 自审记录

- **规范覆盖**：§6.1/§6.2/§6.4/§6.5/§6.6 全部有对应任务；N14 已并入迭代 1 T2-2（注明跳过不重复）；§6.7 待评估项与无头模式（§6.3）标注为评估项不纳入主流程。
- **无占位符**：所有代码步骤含完整代码块或精确行号锚点 + 读取指令；「参照既有实现」均为可执行的读代码指令（N17 的 grep 定位、归档-1 的 zip 依赖确认均注明先读代码）。
- **类型一致性**：`global_active_attempts`（调度-1 定义 → N14-N21-1 Step 4 复用）；`ACTIVE_ATTEMPTS` 索引（N14-N21-1 定义 → 调度-1 的辅助改读索引）；`dispatch_and_start` helper（N14-N21-1 Step 3 定义 → 8 处调用点替换清单一致）；`attemptInterrupted`（迭代 3 N6-2 引入 → N18 终态移除集合包含）；事件类型 `attemptCancelled`/`attemptTimedOut`（eventTypeNames 已有 194/195，无需重复注册）。
- **已知偏差**：调度-1 的 CPU/内存检测如需新增依赖则按 Step 3 说明处理（不新增依赖，以并发上限为高负载判据）；收尾-1 无头模式明确为评估项。
- **评审修正（2026-08-02 四代理并行审核后修订）**：P1 修正 3 处——N17 改为批量签名 `dispatch_ready_and_start(delivery_id) -> Result<usize, String>`（grep 实测 12 处调用点，明确保留 303/322/378/379 四处）、N13 `setError("")`（error 是 string 态，`setError(null)` 编译失败）、N18 索引 remove 集合含 needsInput（15 处赋值点作维护清单）；P2 修正：调度-1 过滤统一三态（含 starting）、N21 currentRuntime 推导方式、归档-1 去掉 Tauri 1 `tauri::api::dialog`（改前端 plugin-dialog save()）+ 产物两级结构说明 + zip 依赖确认、N19 行号澄清（models:74/5494）、N16 `let _` 吞事件错误；P3：N12 变量名统一为 attempt、归档-1 按路径读全文（复用容错模式不调 read_attempt_output）。

---

*行号引用以 `docs/ai-delivery-implementation-plan.md` 核实的 HEAD `ea369ac` 代码为准；实现时如行号漂移，按函数名定位。*
