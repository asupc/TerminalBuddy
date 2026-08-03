# AI 交付迭代 1 实施计划（T1-T4：实时终端 / 超时告警 / DAG 可视化 / 任务编辑）

> 本文件由 `2026-08-02-ai-delivery-iterations-1-4.md` 拆分而来（2026-08-02），实施依据为 `docs/ai-delivery-implementation-plan.md`（2026-08-02 定稿，4 轮核实）。完整 4 迭代拆分为：迭代 1（本文件）/ 迭代 2 / 迭代 3 / 迭代 4。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P0 迭代 1：实时终端查看（T1）、超时可配置 + 提前告警（T2）、DAG 可视化（T3）、任务节点手动编辑（T4），共 15 个任务。T1/T2 并行先行，T3/T4 在其后启动。

**Architecture:** 变更落在三层架构（commands → services → models）的 `src-tauri/src/` 与 React 前端 `src/components/ai-delivery/`、Web SPA `web/src/`。先立基础设施：全局 `APP_HANDLE` 统一事件推送、monitor 线程 drain 独占消费落盘 live-output.log、watchdog 可配置超时，后续迭代复用。

**Tech Stack:** Rust (Tauri 2), React ^19.2.6, TypeScript, Zustand 5, @xterm/xterm 6.x, @xyflow/react ^12（需安装）, axum（Web API）。

## Global Constraints

- 项目实际文件在 `terminal-buddy/` 子目录；`cd terminal-buddy` 后执行所有命令。
- 所有 Rust↔TS 序列化使用 camelCase（serde `rename_all = "camelCase"`，30 个结构体已有 30 处）。
- 更新输入用双 Option（`Option<Option<T>>`）区分「未提供」与「设为空」。
- **任务状态全集（11 种，无 `completed`）**：planned / ready / queued / running / succeeded / failed / policyViolation / rework / cancelled / awaitingReview / needsInput。
- **attempt 状态**：queued / running / needsInput / cancelled / failed / **completed**（成功态）/ policyViolation（无 `succeeded`）。
- **delivery 状态**：drafting / planning / awaitingApproval / running / paused / cancelled / needsInput / completed / succeeded / failed（`failed` 无赋值点，仅删除门槛与前端过滤用）。`"merging"`/`"blocked"` 是 **merge 记录**状态，不是 delivery 状态。
- 事件类型必须在 `src/components/ai-delivery/workspace-utils.ts` 的 `eventTypeNames`（现有 46 项，168-215 行）注册中文名，否则事件列表显示原始英文串。
- T2 落地后：新事件由 `append_event` 统一 emit `ai-delivery-event`，**新增事件无需手动 emit**；禁止新增散布的 emit 调用点。
- 系统通知复用 `show_ai_delivery_notification`（`commands/notification.rs:91-116`，标题硬编码「AI 交付等待决策」）——复用前先完成 T2-4 的 title 参数化。
- 新 REST 路由必须在 `web/server.rs` 注册（AI 交付区块 49-96 行内追加），遗漏即 404。
- 前端事件通道仅 `ai-delivery-event`（`onAiDeliveryEvent`，tauri.ts:656）；`open-ai-attempt-terminal` 是 **window 级 CustomEvent**（非 Tauri 通道）。
- 编辑/删除类操作**复用** `create_task_node`（1176-1269）的既有约束校验，不另写一套；注意排除其 delivery 状态校验（1202-1207，仅 planning/drafting/awaitingApproval）避免自锁。
- 单元测试落位 `src-tauri/src/services/ai_delivery_service.rs` 内 `#[cfg(test)]` 模块（先例：`agent_decision_tests` 5110、`terminal_command_tests` 5991），验收以 `cargo test` 通过为准。
- 前端 UI 文案用中文（简体）。
- commit message 格式 `[模块] 变更描述`（如 `[AI交付] ...`）。
- 所有新增模型字段必须有 `#[serde(default)]`（或 `Option`）以兼容旧 JSON 文件；前端类型必须同步 `src/types/aiDelivery.ts`。

---

## File Structure

### 新增（前端 `src/components/ai-delivery/`）
- `TaskDagView.tsx` — DAG 视图容器（T3）
- `TaskNodeCard.tsx` — 自定义 ReactFlow 节点（T3）
- `TaskNodeEditor.tsx` — 任务节点编辑抽屉（T4）
- `AttemptLiveTerminalDialog.tsx` — 实时终端查看（T1）
- `TaskNodeFields.tsx` — 任务字段共用组件（T2/T4）
- `utils/taskGraphLayout.ts` — 拓扑分层布局算法 + localStorage 缓存（T3）
- `utils/taskNodeDiff.ts` — 审计事件 diff 渲染（T4）

### 修改（核心）
- `src-tauri/src/models/ai_delivery.rs`（520 行）— 超时字段、dirty、AiAttemptOutput、UpdateAiTaskNodeInput
- `src-tauri/src/services/ai_delivery_service.rs`（7460 行）— monitor 落盘 / watchdog / APP_HANDLE / 任务编辑
- `src-tauri/src/commands/ai_delivery.rs` — update/delete 命令
- `src-tauri/src/commands/terminal.rs` — `TerminalInstance.ai_delivery` 标记 + drain 豁免
- `src-tauri/src/commands/notification.rs` — 通知 title 参数化
- `src-tauri/src/lib.rs` — APP_HANDLE 注入 + 命令注册
- `src-tauri/src/web/handlers/ai_delivery_handler.rs` + `web/server.rs` — GET output 路由
- `src/services/tauri.ts`、`src/types/aiDelivery.ts` — 类型与封装
- `src/components/ai-delivery/DeliveryDetail.tsx`、`AiDeliveryWorkspace.tsx`、`TaskDeliveryDialogs.tsx`、`ConfigDialog.tsx`、`workspace-utils.ts`、`AiDeliveryWorkspace.css`
- `package.json` — 新增 `@xyflow/react@^12`

---

## 任务（建议执行顺序：T2-1 → T2-2 → T2-3 → T2-4 → T1-1 → T1-2 → T1-3 → T1-4 → T2-5 → T3-1 → T3-2 → T4-1 → T4-2 → T4-3 → T4-4）

### Task T2-1: 模型字段与常量（timeoutSeconds / defaultTimeoutSeconds）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/models/ai_delivery.rs`（AiTaskNode 323-356、AiAgent 110 起）
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs:49-52`（常量区）
- Modify: `terminal-buddy/src/types/aiDelivery.ts`（AiTaskNode 187-211、AiAgent）

**Interfaces:**
- Produces: `AiTaskNode.timeout_seconds: Option<u32>`、`AiAgent.default_timeout_seconds: Option<u32>`（serde camelCase → `timeoutSeconds`/`defaultTimeoutSeconds`）、常量 `DEFAULT_ATTEMPT_TIMEOUT_SECONDS: u32 = 60*60`、`TIMEOUT_WARNING_RATIO: f32 = 0.8`（供 T2-2 watchdog 使用）

- [ ] **Step 1: AiTaskNode 与 AiAgent 加字段**

在 `models/ai_delivery.rs` 的 `AiTaskNode` 结构（323 行起，`retry_count` 字段附近）与 `AiAgent` 结构（110 行起）末尾各加：

```rust
// AiTaskNode 内
#[serde(default)]
pub timeout_seconds: Option<u32>,  // None 时使用 Agent/AiAgent 默认值
```

```rust
// AiAgent 内
#[serde(default)]
pub default_timeout_seconds: Option<u32>,  // 兜底默认值
```

两个结构体已有 `#[serde(rename_all = "camelCase")]` 且其他字段均为非 Option——注意：**新增字段必须是 Option，且必须带字段级 `#[serde(default)]`**（实测两个结构体均无结构体级 `#[serde(default)]`，不加字段级标注会导致旧 JSON 反序列化失败）。

- [ ] **Step 2: 常量区新增两个常量**

`services/ai_delivery_service.rs` 49-52 行（现有 `ATTEMPT_MAX_DURATION` / `ATTEMPT_WATCHDOG_DELAY` / `ATTEMPT_WATCHDOG_INTERVAL`）下方追加：

```rust
pub const DEFAULT_ATTEMPT_TIMEOUT_SECONDS: u32 = 60 * 60;  // 与 ATTEMPT_MAX_DURATION 对齐
pub const TIMEOUT_WARNING_RATIO: f32 = 0.8;                 // 80% 时告警
```

- [ ] **Step 3: 前端类型同步**

`src/types/aiDelivery.ts` 的 `AiTaskNode`（187-211）与 `AiAgent`（**55 行起**，字段为 `startupPresetName` 等——注意前端类型在 55 行，后端 models 的 AiAgent 才是 110 行）各加：

```ts
// AiTaskNode 内
timeoutSeconds?: number | null;
```

```ts
// AiAgent 内
defaultTimeoutSeconds?: number | null;
```

- [ ] **Step 4: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5
```

预期：无错误。`npx tsc --noEmit` 预期：无错误。

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/models/ai_delivery.rs src-tauri/src/services/ai_delivery_service.rs src/types/aiDelivery.ts && git commit -m "[AI交付] 任务与 Agent 模型新增超时字段及常量"
```

---

### Task T2-2: watchdog 可配置超时 + approachingTimeout 事件

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`run_attempt_watchdog` 6257 起；`fail_attempt_from_watchdog` 6383；watchdog spawn 处 `start_attempt` 内 2639 起）

**Interfaces:**
- Consumes: T2-1 的 `timeout_seconds` / `default_timeout_seconds` / `DEFAULT_ATTEMPT_TIMEOUT_SECONDS` / `TIMEOUT_WARNING_RATIO`
- Produces: 新事件类型 `approachingTimeout`（一次性，80% 耗时告警）；watchdog 超时判定从固定 `ATTEMPT_MAX_DURATION` 改为任务级超时值

- [ ] **Step 1: 读取 watchdog 现状**

```bash
cd terminal-buddy && sed -n '6257,6330p' src-tauri/src/services/ai_delivery_service.rs
```

确认 `run_attempt_watchdog` 结构：spawn 后 `thread::sleep(ATTEMPT_WATCHDOG_DELAY)`（6264）、循环内 `started_at` 解析（6279-6280 附近）、超时判 `elapsed.num_seconds() > ATTEMPT_MAX_DURATION.as_secs() as i64`（6283）、超时消息（6288-6291，含 `ATTEMPT_MAX_DURATION.as_secs() / 60` 分钟文案，需随超时值同步改）、超时调 `fail_attempt_from_watchdog`（6283-6292 附近）、循环尾 `sleep(ATTEMPT_WATCHDOG_INTERVAL)`（6317）。**注意：watchdog 的 spawn 位置在 `start_attempt` 内 2771-2777（`start_attempt` 从 2494 起；2639-2766 是其内 monitor 线程），不在 2639。**

- [ ] **Step 2: watchdog 函数签名加 timeout 参数**

`run_attempt_watchdog` 是自由函数（非方法）。给签名追加参数：

```rust
fn run_attempt_watchdog(
    attempt_id: &str,       // 真实签名（6257-6263）：(attempt_id, delivery_id, task_node_id, app, terminal_service)
    delivery_id: &str,      // 顺序与既有签名保持一致，只追加 timeout_seconds
    task_node_id: &str,
    app: AppHandle,         // 既有参数，保持原样
    terminal_service: ...,  // 既有参数，保持原样
    timeout_seconds: u64,   // 新增：任务级超时（秒）
)
```

在函数体起始处（sleep 之前）计算告警点：

```rust
// 用秒数 i64 比较：循环内 elapsed 是 chrono::TimeDelta，不能与 std::time::Duration 直接比较
let warning_at_secs = (timeout_seconds as f64 * TIMEOUT_WARNING_RATIO as f64).round() as i64;
let mut warning_emitted = false;
```

- [ ] **Step 3: 循环内加入告警分支与超时值替换**

把循环内超时判定（6281）从 `ATTEMPT_MAX_DURATION.as_secs() as i64` 改为 `timeout_seconds as i64`；在判定之前插入告警逻辑：

```rust
if elapsed.num_seconds() >= warning_at_secs && !warning_emitted {
    let _ = AiDeliveryService::append_event(delivery_id, Some(task_node_id), Some(attempt_id),
                                            "approachingTimeout",
                                            &format!("已耗时 {}s，预计 {}s 后超时", elapsed.num_seconds(), timeout_seconds));
    warning_emitted = true;
}
```

注意：`run_attempt_watchdog` 返回 `()`，**禁止 `?`**（原稿的 `?` 无法编译）——`append_event` 返回值用 `let _ =` 丢弃，与 6283 附近既有 `let _ = fail_attempt_from_watchdog(...)` 写法一致。`run_attempt_watchdog` 是自由函数，调用 `append_event` 需通过 `AiDeliveryService::append_event(...)`（若该上下文无 Self 别名则全限定）。检查 6491 行附近现有 `attemptWatchdogCheck` 的写法保持一致（`AiDeliveryService::append_event` 或局部 use）。**超时判定（6283）与超时消息（6288-6291）中的 `ATTEMPT_MAX_DURATION` 一并替换为 `timeout_seconds`。**

- [ ] **Step 4: spawn 处快照超时值并传入**

`start_attempt` 内 watchdog `thread::spawn`（**2771-2777**）之前，显式加载超时值（一次快照，不放循环内）：

```rust
let timeout = AiDeliveryService::get_task_node(&attempt.task_node_id)
    .ok()
    .and_then(|task| task.timeout_seconds)
    .or_else(|| {
        AiDeliveryService::get::<AiAgent>(AGENTS_DIR, &attempt.agent_id, "Agent 超时默认").ok()
            .and_then(|agent| agent.default_timeout_seconds)
    })
    .unwrap_or(DEFAULT_ATTEMPT_TIMEOUT_SECONDS) as u64;  // u32 → u64 显式转换（签名要求 u64）
```

（`get_task_node`/`get`/`AGENTS_DIR` 的现有签名与路径以 service 内既有用法为准，参照 `retry_task_node` 2402 起的加载方式。）将 `timeout` 移入 spawn 闭包并传给 `run_attempt_watchdog` 新参数。

- [ ] **Step 5: 编译与单测**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

预期：无错误。无新增单测（线程逻辑手工验证）。

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/services/ai_delivery_service.rs && git commit -m "[AI交付] watchdog 超时可配置并按 80% 提前告警 approachingTimeout"
```

---

### Task T2-3: 全局 APP_HANDLE + append_event 统一 emit + 清理 12 处重复 emit

**Files:**
- Modify: `terminal-buddy/src-tauri/src/lib.rs`（setup 注入；现有 4 处局部 `app.handle()`：341/430/443/455）
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`append_event` 3401-3419 末尾统一 emit；删除 12 处调用点的重复 emit：1861/1877/2614/2893/2924/2965/3125/3140/3164/6417/6699/7264）

**Interfaces:**
- Produces: 全局 `static APP_HANDLE: OnceLock<AppHandle>`；`append_event` 末尾统一 `emit("ai-delivery-event", event)`；**副作用**：其余约 30 处只写不 emit 的 `append_event` 调用自动获得实时推送（dispatchDeferred 2481 / autoMerged 3170 / autoMergeFailed 3179 / attemptWatchdogCheck 6487 等）

- [ ] **Step 1: 注册全局 APP_HANDLE**

`services/ai_delivery_service.rs` 文件顶部（use 区之后、常量区之前）加：

```rust
use tauri::AppHandle;
use std::sync::OnceLock;

pub static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
```

（若文件已有 `use std::sync::OnceLock` 或 `use tauri::AppHandle` 则合并，不重复引入。）

- [ ] **Step 2: lib.rs setup 注入**

`lib.rs` setup 闭包起始处（现有 4 处 `app.handle()` 使用点之前）加：

```rust
let _ = ai_delivery_service::APP_HANDLE.set(app.handle().clone());
```

- [ ] **Step 3: append_event 统一 emit**

`append_event`（3401-3419）末尾 `Ok(event)` 之前插入：

```rust
if let Some(app) = APP_HANDLE.get() {
    let _ = app.emit("ai-delivery-event", &event);
}
```

确认 `emit` trait 已引入（`tauri::Emitter`；若编译报未找到，文件顶部补 `use tauri::Emitter;`）。

- [ ] **Step 4: 删除 12 处重复 emit**

逐一删除以下调用点中紧跟 `append_event(...)` 的 `emit("ai-delivery-event", ...)` 行：1861/1877/2614/2893/2924/2965/3125/3140/3164/6417/6699/7264。

```bash
cd terminal-buddy && grep -n 'emit("ai-delivery-event"' src-tauri/src/services/ai_delivery_service.rs
```

预期：执行后 **0 处**匹配（所有 emit 已收口到 append_event 内部）。注意 2614 处为 `if let Ok(event) = ...` 包装模式，删除内部 emit 后保留 if-let 结构（此时变量 event 未使用，可将 `if let Ok(event) =` 改为 `let _ =`；其余 11 处为直接 `append_event(...)` 后接 `let _ = emit(...)` 或 `emit(...)`，直接删行）。

- [ ] **Step 5: 验证编译**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

预期：无错误、无未使用变量警告（若有 `unused variable: event` 警告按 Step 4 说明处理）。

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/lib.rs src-tauri/src/services/ai_delivery_service.rs && git commit -m "[AI交付] append_event 统一实时推送事件，清理 12 处重复 emit"
```

---

### Task T2-4: 系统通知补齐（title 参数化 + 3 个关键节点）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/commands/notification.rs`（`show_ai_delivery_notification` 91-116）
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`fail_attempt_from_watchdog` 6383、`complete_attempt`、`merge_delivery_locally_locked_impl` 1999-2247）

**Interfaces:**
- Consumes: 现有 `show_ai_delivery_notification`（2 处调用：commands/ai_delivery.rs:263、service 2966）与 `ai-delivery-notification-activated` 跳转通道（notification.rs:111）
- Produces: `show_ai_delivery_notification(app, title: &str, delivery_id: &str, message: &str)` 新签名；超时终止/交付收尾/合并结果三类通知

- [ ] **Step 1: 函数加 title 参数**

读 `commands/notification.rs` 91-116 行。函数当前**按值**传参 `(app: AppHandle, delivery_id: String, question: String)`（**非引用**），标题硬编码「AI 交付等待决策」。在 `delivery_id` 前插入 `title` 参数（保持既有按值风格）：

```rust
pub fn show_ai_delivery_notification(app: AppHandle, title: &str, delivery_id: String, message: String)
```

内部用 `title` 替换硬编码标题，`message` 替换原 question 正文，保留 `ai-delivery-notification-activated` 激活跳转逻辑。

- [ ] **Step 2: 更新既有 2 处调用点**

- `commands/ai_delivery.rs:263-267`（决策创建）：既有调用已按值传 `.clone()`——仅在第二参位置插入标题字符串即可，形如 `show_ai_delivery_notification(app.handle().clone(), "AI 交付等待决策", delivery_id.clone(), question.clone())`（按既有参数名调整）。
- `ai_delivery_service.rs:2966`（attemptAwaitingDecision）：同式补 title 参数（该处为 service 内调用，确认其能拿到 AppHandle——从 `APP_HANDLE.get()`（T2-3 已建）取，或沿用现有传参方式）。

- [ ] **Step 3: 新增 3 类通知**

在 service 内新增调用（均经 `APP_HANDLE.get()` 取 app，拿不到时静默跳过）：

1. 超时通知加在 **watchdog 循环内 6283 超时判定分支**（调 `fail_attempt_from_watchdog` 之前）：`show_ai_delivery_notification(app, "AI 交付任务超时", delivery_id, format!("任务 {task_title} 超时终止"))`——task_title 用已有任务信息或 attempt id。注意 **`fail_attempt_from_watchdog`（6383 起）内部无法区分「超时」与「终端已结束」（6296-6302 也调它），不要把通知放进该函数**。
2. 交付整体收尾处（`complete_attempt` 置 succeeded/completed 处）：标题「AI 交付完成」，正文含 deliveryId 与任务标题。
3. `merge_delivery_locally_locked_impl`（1999-2247）合并成功（2228 置 completed 处）与冲突失败（2205-2224 回滚处）：标题「AI 交付合并成功」/「AI 交付合并冲突」，正文带 deliveryId。

注意：`show_ai_delivery_notification` 真实签名是按值传参 `(app: AppHandle, delivery_id: String, question: String)`（notification.rs:91-94），**非引用**；service 内调用从 `APP_HANDLE.get().cloned()` 取 app 后按值传入。

- [ ] **Step 4: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

预期：无错误。

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/commands/notification.rs src-tauri/src/commands/ai_delivery.rs src-tauri/src/services/ai_delivery_service.rs && git commit -m "[AI交付] 系统通知标题参数化并补齐超时/收尾/合并三类通知"
```

---

### Task T1-1: TerminalInstance.ai_delivery 标记 + drain_terminal_output 后端豁免

**Files:**
- Modify: `terminal-buddy/src-tauri/src/commands/terminal.rs`（`TerminalInstance` 116-130、`drain_terminal_output` 862-873、`#[command]` 包装 1206-1212）
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`create_ai_terminal` 6210-6246）

> **重要**：`create_ai_terminal` 定义在 `services/ai_delivery_service.rs:6210-6246`（调用点 3 处：2586 start_attempt 任务执行 / 6680 reviewer / 7244 manager），内部 6218 调 `TerminalService::create_blank_terminal`。`TerminalInstance` 与 `drain_terminal_output` 在 `commands/terminal.rs`。

**Interfaces:**
- Produces: `TerminalInstance.ai_delivery: bool` 字段（`create_ai_terminal` 创建时置位）；`drain_terminal_output` 对 ai_delivery 终端只返回当前缓冲不消费（行为等价 peek）。**约束**：monitor 线程（T1-2）成为 live-output.log 缓冲的事实唯一消费方；既有标签页路径（`TerminalInstance.tsx:1220` 无条件 drain）从此无害

- [ ] **Step 1: TerminalInstance 加字段**

`commands/terminal.rs` 116-130 行 `TerminalInstance` 结构加：

```rust
pub ai_delivery: bool,  // AI 交付终端标记：drain_terminal_output 对其只读不消费
```

检查 `create_blank_terminal` 内该结构体所有构造点，补 `ai_delivery: false`（或加 `#[serde(default)]`——该结构不序列化则直接补构造字段）。

- [ ] **Step 2: create_ai_terminal 置位**

**设计修正（评审确认）**：`create_ai_terminal`（6210-6246）调 `create_blank_terminal` 只拿到 `String`（terminal_id），函数返回 `Result<String, String>`，全程无 `TerminalInstance` 对象可改，且 `TerminalService` 公开方法（terminal.rs:430-967）无任何 setter——原稿「返回后置位」不可行，二选一：

- **方案 A（推荐）**：`TerminalService` 新增 `pub fn set_ai_delivery_flag(&self, id: &str) -> Result<(), String>`（参照既有公开 setter `update_terminal_display_name` terminal.rs:786 的 `get_mut`+改字段+`notify_sessions_changed` 先例；原稿称「无任何 setter」有误——只是无 ai_delivery 字段的 setter），`create_ai_terminal` 在拿到 terminal_id 后、返回前调用。
- 方案 B：`create_blank_terminal`（967）加参数 `ai_delivery: bool`（调用点仅 2 处：terminal.rs:1242 传 `false`、service:6218 传 `true`）。

- [ ] **Step 3: drain_terminal_output 只读分支**

`commands/terminal.rs` 862-873 行 `drain_terminal_output`：在 `buffer.drain()` 前检查标记：

```rust
pub fn drain_terminal_output(&self, id: &str) -> Result<String, String> {
    // 沿用 862-873 既有 scoped-block 模式：块内同时取出 buf_arc 与 ai_delivery 标志。
    // 原稿「drop(instances) 后再访问 inst.ai_delivery」会触发借用检查错误（inst 借自 guard，drop 后引用失效）。
    let (buf_arc, ai_delivery) = {
        let instances = self.instances.lock().unwrap_or_else(|e| e.into_inner());
        instances
            .get(id)
            .map(|inst| (inst.output_buffer.clone(), inst.ai_delivery))
            .ok_or_else(|| format!("终端不存在: {id}"))?
    };
    let mut buffer = buf_arc.lock().unwrap_or_else(|e| e.into_inner());
    if ai_delivery {
        // AI 交付终端：只返回当前缓冲、不消费（monitor 线程是唯一消费方，负责落盘）
        // TerminalOutputBuffer::collect() 已存在（拼接全部 chunk 不清空，peek_terminal_output:875 在用）
        return Ok(buffer.collect());
    }
    Ok(buffer.drain())
}
```

> 以 862-873 行真实代码为准：缓冲字段名是 `output_buffer`（`Arc<Mutex<TerminalOutputBuffer>>`，非 `buffer`），通过 `inst.output_buffer.clone()` 拷贝规避借用；`TerminalOutputBuffer` **已有非消费 `collect()`**（拼接全部 chunk 不清空，`peek_terminal_output` 875 在用）——ai_delivery 分支直接用它，**无需新增 peek**。保持非 ai_delivery 分支行为逐字节不变。

- [ ] **Step 4: 验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

预期：无错误。

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/commands/terminal.rs src-tauri/src/services/ai_delivery_service.rs && git commit -m "[AI交付] AI 终端标记使 drain 只读，monitor 独占消费输出缓冲"
```

---

### Task T1-2: monitor 线程 drain 增量落盘 live-output.log

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`start_attempt` 内匿名 monitor 线程 2639-2766）

**Interfaces:**
- Consumes: T1-1 的 ai_delivery 豁免（monitor 是唯一消费方）；现有 300ms 循环（2641-2650 peek 探测、2654-2657 transcript 兜底、2660-2684 review_repair）
- Produces: `run_dir/live-output.log` 追加写（每 300ms drain 增量）；运行结束时 transcript.log 为空 → 以 live-output.log **尾部 20k 字符**兜底；**写入侧截断**：文件 >5MB 时保留尾部一半再续写

- [ ] **Step 1: 读 monitor 线程现状**

```bash
cd terminal-buddy && sed -n '2639,2770p' src-tauri/src/services/ai_delivery_service.rs
```

确认：2646 `peek_terminal_output(&terminal_id).is_err()` 存活探测（返回值丢弃）；2652-2657 transcript 兜底；2643 exit_marker 退出检测；2660-2684 review_repair。

- [ ] **Step 2: 替换 peek 探测为 drain 消费**

内层循环中，存活探测调用改为：

```rust
// drain 独占消费：缓冲被消费后无 last_len 竞态、无内存增长
// 注意：monitor 线程闭包返回 ()，禁止 `?`——Err 表示终端已关闭，必须 break None
// （保留原 2646 `peek.is_err() → break None` 语义；若用 unwrap_or_default() 会吞错成空串且不 break → 终端关闭后死循环）
let output = match monitor_terminal_service.drain_terminal_output(&terminal_id) {
    Ok(output) => output,
    Err(_) => break None,
};
if !output.is_empty() {
    // 追加写（写入侧截断：>5MB 保留尾部一半）
    let log_path = run_dir.join("live-output.log");
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() > 5 * 1024 * 1024 {
            let content = fs::read_to_string(&log_path).unwrap_or_default();
            // 截断必须落在字符边界：多字节 UTF-8 中点 slice 会 panic 并杀死 monitor 线程（任务永久卡死）
            let boundary = content.ceil_char_boundary(content.len() - content.len() / 2);
            let _ = fs::write(&log_path, &content[boundary..]);
        }
    }
    if let Ok(mut f) = fs::OpenOptions::new().append(true).open(&log_path) {
        let _ = f.write_all(output.as_bytes());
    }
}
```

**`run_dir` 不在 monitor 闭包作用域内**（2635-2638 仅 clone 了 task_node_id/runtime/agent/working_directory）——闭包顶部需先解析一次：`let run_dir = control.transcript_path.parent().map(std::path::Path::to_path_buf).unwrap_or_default();`（transcript.log 与 live-output.log 同目录；或 `terminal_run_dir_by_id(&attempt_id).unwrap_or_default()`）。原稿「`unwrap_or_default()` 等价于原 is_err() 路径」有误：原 2646 是 Err 即 `break None`（跳出内层循环、exit_code=None、走 2688 收尾），`unwrap_or_default()` 会吞错成空串且不 break、导致终端关闭后死循环——已改为 `match { Ok(o)=>o, Err(_)=>break None }`。`ceil_char_boundary` 的调用形态与 `read_attempt_output`（1602）既有用法一致。

- [ ] **Step 3: transcript 兜底改为 live-output.log 尾部**

2652-2657 附近原有「结束时 peek 输出作 transcript 兜底」改为：transcript.log 为空（或大小 < 某阈值）时，读取 live-output.log **尾部 20k 字符**作兜底：

```rust
// 结束时：transcript.log 为空则以 live-output.log 尾部 20k 兜底
let transcript = fs::read_to_string(run_dir.join("transcript.log")).unwrap_or_default();
let tail = if transcript.trim().is_empty() {
    fs::read_to_string(run_dir.join("live-output.log"))
        .map(|s| s.chars().rev().take(20_000).collect::<String>().chars().rev().collect())
        .unwrap_or_default()
} else { transcript };
```

> 约束：兜底只取尾部 20k 字符（长任务下 MB 级文本不得进入 finish_attempt 的 stdout/summary/事件消息链）；attempt 结束时同 run_dir 内无并发写入。

- [ ] **Step 4: 验证编译**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

预期：无错误。

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/services/ai_delivery_service.rs && git commit -m "[AI交付] monitor 线程 drain 增量落盘 live-output.log 并截断保护"
```

---

### Task T1-3: AiAttemptOutput 扩展 + read_attempt_output 补尾部 + Web 路由

**Files:**
- Modify: `terminal-buddy/src-tauri/src/models/ai_delivery.rs`（`AiAttemptOutput` 431 起）
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`read_attempt_output` 1575 起）
- Modify: `terminal-buddy/src-tauri/src/web/handlers/ai_delivery_handler.rs`（暴露 GET output）
- Modify: `terminal-buddy/src-tauri/src/web/server.rs`（49-96 行 AI 交付区块内注册路由）

**Interfaces:**
- Consumes: T1-2 的 live-output.log
- Produces: `AiAttemptOutput.is_live: bool` + `live_output_tail: String`（尾部 ≤8000 字符，Web 轮询用）；REST `GET /api/ai-delivery/attempts/{id}/output`

- [ ] **Step 1: AiAttemptOutput 加字段**

`models/ai_delivery.rs` 431 行起 `AiAttemptOutput`（现有字段：attempt_id / transcript_tail / final_message / review / decision / prompt_excerpt / plan_json）追加：

```rust
pub is_live: bool,            // attempt.state == "running"
pub live_output_tail: String, // live-output.log 尾部（最多 8000 字符），Web 端轮询用
```

- [ ] **Step 2: read_attempt_output 末尾补逻辑**

`services/ai_delivery_service.rs` `read_attempt_output`（1575 起；BOM/非 UTF-8 容错 1581-1595；8000 截断 1597-1608）末尾、构造返回前：

```rust
// 运行目录已在函数前部解析好（既有变量 run_dir，兼容纯 UUID 与 label__UUID 命名），直接复用
let is_live = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?.state == "running";
// 注意：service 内无 truncate_tail 方法——1597-1608 的 8000 截断是内联闭包，此处内联同一段逻辑
// （或抽出 fn truncate_tail(content: &str, max: usize) -> String 供 read_attempt_output 与本处共用）
let live_output_tail = fs::read_to_string(run_dir.join("live-output.log"))
    .unwrap_or_default();
let live_output_tail = if live_output_tail.len() > 8000 {
    let cut = live_output_tail.len() - 8000;
    let safe_cut = live_output_tail.ceil_char_boundary(cut);
    format!("...{}", &live_output_tail[safe_cut..])
} else {
    live_output_tail
};
```

> 以 1575-1608 现有代码为准：`run_dir` 变量名、截断辅助函数均复用既有实现；`terminal_run_dir_by_id` 是**自由函数单参数** `terminal_run_dir_by_id(run_id: &str)`（4802-4819），本函数内已有解析好的 `run_dir` 直接复用。`attempt` 变量不存在（函数只有 attempt_id）——`is_live` 用 `Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, ...)` 取状态。不做文件 mtime 字段（PC 事件流天然增量，Web 全量轮询即可）。

- [ ] **Step 3: handler 暴露路由**

`web/handlers/ai_delivery_handler.rs` 新增：

```rust
pub async fn attempt_output(State(_state): State<AppState>, Path(attempt_id): Path<String>) -> Result<Json<AiAttemptOutput>, ApiError> {
    AiDeliveryService::read_attempt_output(&attempt_id).map(Json).map_err(ApiError::BadRequest)
}
```

- [ ] **Step 4: server.rs 注册**

`web/server.rs` AI 交付区块（49-96 行，12 条既有路由之后）追加：

```rust
.route("/api/ai-delivery/attempts/{attempt_id}/output", get(handlers::ai_delivery_handler::attempt_output))
```

确认 `get` 与模块路径引用与既有路由写法一致（参照既有 12 条路由的注册风格）。

- [ ] **Step 5: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

预期：无错误。

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/models/ai_delivery.rs src-tauri/src/services/ai_delivery_service.rs src-tauri/src/web/handlers/ai_delivery_handler.rs src-tauri/src/web/server.rs && git commit -m "[AI交付] AiAttemptOutput 增实时状态与尾部输出，暴露 GET 接口"
```

---

### Task T1-4: 前端实时终端弹窗 AttemptLiveTerminalDialog

**Files:**
- Create: `terminal-buddy/src/components/ai-delivery/AttemptLiveTerminalDialog.tsx`
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（attempt 卡片 671-679 附近）
- Modify: `terminal-buddy/src/types/aiDelivery.ts`（AiAttemptOutput 241 起，补 isLive/liveOutputTail）

**Interfaces:**
- Consumes: `readAiAttemptOutput(attemptId)`（tauri.ts:660）、`onTerminalOutput(terminalId, cb)`（tauri.ts:362）、attempt.startedAt
- Produces: `AttemptLiveTerminalDialog` 组件（props: `attempt: AiAttempt; onClose: () => void`）；DeliveryDetail 运行中 attempt 卡片新按钮「实时终端」（与既有「打开终端」按钮 671-679 并存，文案/图标区分）

- [ ] **Step 1: 类型同步**

`src/types/aiDelivery.ts` AiAttemptOutput（241-249）补：

```ts
export interface AiAttemptOutput {
  attemptId: string;
  transcriptTail: string;
  finalMessage?: string | null;
  review?: AiAttemptReview | null;
  decision?: AiAttemptDecision | null;
  promptExcerpt?: string | null;
  planJson?: string | null;
  isLive: boolean;
  liveOutputTail: string;
}
```

- [ ] **Step 2: 新建组件（完整实现）**

```tsx
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { readAiAttemptOutput, onTerminalOutput } from "../../services/tauri";
import type { AiAttempt } from "../../types/aiDelivery";

interface Props {
  attempt: AiAttempt;
  onClose: () => void;
}

export function AttemptLiveTerminalDialog({ attempt, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [finalMessage, setFinalMessage] = useState<string | null>(null);

  useEffect(() => {
    const term = new Terminal({ theme: { background: "#1e1e1e" } });
    terminalRef.current = term;
    term.open(containerRef.current!);

    // 1) 先注册事件监听，再读历史尾部 —— 无丢失窗口（历史与事件流间可能有毫秒级重复，接受不去重）
    let stopped = false;
    const unlistenPromise = onTerminalOutput(attempt.terminalId ?? "", (output) => {
      if (!stopped) term.write(output);
    });

    readAiAttemptOutput(attempt.id).then((output) => {
      if (!stopped) term.write(output.liveOutputTail);
    });

    // 2) attempt 结束后补拉一次，显示 final-message 收尾（4 秒轮询状态翻转或手动关闭）
    const poll = setInterval(() => {
      readAiAttemptOutput(attempt.id).then((output) => {
        if (!output.isLive) {
          setFinalMessage(output.finalMessage ?? null);
          clearInterval(poll);
        }
      }).catch(() => undefined);
    }, 4000);

    return () => {
      stopped = true;
      clearInterval(poll);
      unlistenPromise.then((unlisten) => unlisten());
      term.dispose();
    };
  }, [attempt.id, attempt.terminalId]);

  const elapsed = attempt.startedAt
    ? Math.max(0, Math.round((Date.now() - new Date(attempt.startedAt).getTime()) / 1000))
    : 0;

  return (
    <div className="ai-attempt-live-dialog" role="dialog" aria-label="实时终端">
      <div className="ai-attempt-live-meta">
        <span>状态: {attempt.state}</span>
        <span>已运行: {elapsed}s</span>
      </div>
      <div ref={containerRef} className="ai-attempt-live-terminal" />
      {finalMessage && <div className="ai-attempt-live-final">{finalMessage}</div>}
      <button className="btn-secondary" onClick={onClose}>关闭</button>
    </div>
  );
}
```

> 约束：**不要调用 `drainTerminalOutput`**（drain 会清空缓冲、破坏 monitor 落盘）；进度信号（`<step>...</step>` 正则从 live-output.log 提取）本任务只做展示位，可在 meta 区加 `const stepMatch = ...` 从 `liveOutputTail` 正则提取后渲染。

- [ ] **Step 3: DeliveryDetail 接入按钮与弹窗**

`DeliveryDetail.tsx` attempt 卡片（671-679 既有「打开终端」按钮旁）加：

```tsx
{attempt.state === "running" && (
  <button
    className="btn-secondary"
    title="实时查看终端输出"
    onClick={() => setLiveAttemptId(attempt.id)}
  >
    实时终端
  </button>
)}
```

组件内加状态 `const [liveAttemptId, setLiveAttemptId] = useState<string | null>(null);` 并在 JSX 末尾渲染弹窗（从 attempts 数据取对应 attempt 对象）：

```tsx
{liveAttemptId && attempts.find((a) => a.id === liveAttemptId) && (
  <AttemptLiveTerminalDialog attempt={attempts.find((a) => a.id === liveAttemptId)!} onClose={() => setLiveAttemptId(null)} />
)}
```

- [ ] **Step 4: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

预期：无错误。

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/AttemptLiveTerminalDialog.tsx src/components/ai-delivery/DeliveryDetail.tsx src/types/aiDelivery.ts && git commit -m "[AI交付] 运行中 attempt 实时终端弹窗（事件流零延迟）"
```

---

### Task T2-5: 前端超时配置 UI（TaskNodeFields 抽取 + 任务/Agent 对话框 + 事件卡片）

**Files:**
- Modify: `terminal-buddy/src/components/ai-delivery/TaskDeliveryDialogs.tsx`（TaskCreateDialog 126 起）
- Create: `terminal-buddy/src/components/ai-delivery/TaskNodeFields.tsx`（从 TaskCreateDialog 抽出共用字段）
- Modify: `terminal-buddy/src/components/ai-delivery/ConfigDialog.tsx`（Agent 配置区；`saveAgentConfig` 在 AiDeliveryWorkspace.tsx:1155-1157）
- Modify: `terminal-buddy/src/components/ai-delivery/AiDeliveryWorkspace.tsx`
- Modify: `terminal-buddy/src/components/ai-delivery/workspace-utils.ts`（eventTypeNames 注册）
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（事件列表 approachingTimeout 卡片）

**Interfaces:**
- Consumes: T2-1 类型（timeoutSeconds / defaultTimeoutSeconds）、`saveAiAgent({...agent, ...patch})`（AiDeliveryWorkspace.tsx:1157）、`getAiAgents`（取 defaultTimeoutSeconds）
- Produces: `TaskNodeFields` 共用组件（T4 TaskNodeEditor 复用）；创建任务对话框「超时时间（分钟）」输入；Agent 配置「默认超时（分钟）」输入；`approachingTimeout` 事件卡片（黄色 + 查看详情）

- [ ] **Step 1: 抽取 TaskNodeFields 共用组件**

新建 `TaskNodeFields.tsx`：把 `TaskCreateDialog`（TaskDeliveryDialogs.tsx 126-264）的字段区（任务标题/目标仓库/执行模式/执行目录/优先 Agent/角色/最大重试次数/任务说明/任务说明给 Agent/允许写入路径/前置任务/输入成果/预期成果/验收命令）原样搬入，props 类型与 TaskCreateDialogProps 中对应字段一致，并**新增**：

```tsx
<label>
  超时时间（分钟）
  <input type="number" min="5" max="480" placeholder="" value={manualTaskTimeoutMinutes}
    onChange={(e) => setManualTaskTimeoutMinutes(e.target.value)} />
  <span className="ai-field-hint">
    留空使用 Agent 默认（{defaultAgentTimeoutText}），设置范围 5-480
  </span>
</label>
```

其中 `defaultAgentTimeoutText` 由 props 传入（`agents` 列表取 `defaultTimeoutSeconds`，缺省显示「60 分钟」）。**不要硬编码**：`const defaultSeconds = agents.find((a) => a.defaultTimeoutSeconds)?.defaultTimeoutSeconds ?? 3600;` 转换为「X 分钟」。

`TaskCreateDialog` 改为渲染 `<TaskNodeFields {...} />`（保持对外 props 不变，内部替换实现）。

- [ ] **Step 2: 创建任务对话框接入超时字段**

`TaskCreateDialog` 调用侧（AiDeliveryWorkspace 持有 manualTask* state 处）新增 state：`manualTaskTimeoutMinutes`（string，默认 ""），提交时若非空解析为分钟 × 60 秒写入 `timeoutSeconds`（空则 `null`），传入 create task 命令参数。`tauri.ts` 与 `types/aiDelivery.ts` 同步 `timeoutSeconds?: number | null`。

- [ ] **Step 3: Agent 默认超时配置入口**

`ConfigDialog.tsx` Agent 配置区（「套用参数预设」下拉 697-720 附近）新增「默认超时（分钟）」数字输入，保存时经 `saveAgentConfig`（AiDeliveryWorkspace.tsx:1155 声明、1157 `await saveAiAgent({ ...agent, ...patch })`）落盘：

```tsx
<label>
  默认超时（分钟）
  <input type="number" min="5" max="480" value={agent.defaultTimeoutSeconds ? String(Math.round(agent.defaultTimeoutSeconds / 60)) : ""}
    onChange={(e) => {
      const v = e.target.value;
      saveAgentConfig(agent, { defaultTimeoutSeconds: v ? Number(v) * 60 : null });
    }} />
</label>
```

> `saveAgentConfig` 真实签名是 `(agent: AiAgent, patch: Partial<AiAgent>)`（AiDeliveryWorkspace.tsx:1155）——传 agent 原对象 + **字段级 patch**，不要传合并后的整对象（原稿单参写法 tsc 编译失败）。

- [ ] **Step 4: 事件列表 approachingTimeout 卡片**

`workspace-utils.ts` eventTypeNames 注册表（168-215）加：

```ts
approachingTimeout: "即将超时",
```

事件实际渲染在 `DeliveryDetail.tsx:749-765`（`filteredRecentDeliveryEvents.map` 内，`eventTypeName(event.eventType)` 与 `event.message` 旁）——`AiDeliveryWorkspace.tsx` 只做事件过滤（`filteredRecentDeliveryEvents` 910 行）并透传给 DeliveryDetail，不渲染。在该渲染处加分支（黄色提示 + 「查看详情」按钮——详情即打开该 attempt 的实时终端弹窗或滚动到对应任务卡片）：

```tsx
{event.eventType === "approachingTimeout" && (
  <span className="ai-event-warning">即将超时</span>
)}
```

- [ ] **Step 5: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

预期：无错误。

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/ && git commit -m "[AI交付] 前端超时配置：任务对话框/Agent 默认值/approachingTimeout 事件卡片"
```

---

### Task T3-1: DAG 依赖安装 + 布局算法 taskGraphLayout

**Files:**
- Modify: `terminal-buddy/package.json`（新增 @xyflow/react）
- Create: `terminal-buddy/src/components/ai-delivery/utils/taskGraphLayout.ts`

**Interfaces:**
- Consumes: `AiTaskNode[]`（types/aiDelivery.ts 187-211）
- Produces: `computeTaskGraphLayout(tasks: AiTaskNode[]): { nodes: ReactFlowNode[]; edges: ReactFlowEdge[] }`（含 localStorage 缓存 key `ai-delivery-graph-layout:v1:{deliveryId}`，layoutVersion = 节点 id 集合 + 依赖边集合短 hash）

- [ ] **Step 1: 安装依赖**

```bash
cd terminal-buddy && npm install @xyflow/react@^12
```

> 不要装旧版 `reactflow`。确认 package.json 出现 `"@xyflow/react": "^12..."`。

- [ ] **Step 2: 新建布局算法（完整实现）**

```ts
import type { Node, Edge } from "@xyflow/react";
import type { AiTaskNode } from "../../../types/aiDelivery";

interface LayoutCache {
  layoutVersion: string;
  nodes: Node[];
  edges: Edge[];
}

const CACHE_PREFIX = "ai-delivery-graph-layout:v1:";

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

function computeVersion(tasks: AiTaskNode[]): string {
  const nodeIds = tasks.map((t) => t.id).sort().join(",");
  const edgePairs = tasks
    .flatMap((t) => t.dependencyIds.map((d) => [d, t.id].sort().join("|")))
    .sort()
    .join(",");
  return simpleHash(`${nodeIds};;${edgePairs}`);
}

export function computeTaskGraphLayout(tasks: AiTaskNode[]) {
  const deliveryId = tasks[0]?.deliveryId ?? "unknown";
  const layoutVersion = computeVersion(tasks);
  const cacheKey = `${CACHE_PREFIX}${deliveryId}`;
  const cached = (() => {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as LayoutCache;
      return parsed.layoutVersion === layoutVersion ? parsed : null;
    } catch {
      return null;
    }
  })();

  if (cached) return { nodes: cached.nodes, edges: cached.edges };

  // 简化 Kahn 拓扑分层：每节点层 = max(父节点层) + 1
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const layer: Record<string, number> = {};
  const visiting = new Set<string>();  // 环防护：既有数据若含环（T4-1 只防新增环）避免无限递归栈溢出
  const computeLayer = (id: string): number => {
    if (layer[id] !== undefined) return layer[id];
    const task = byId.get(id);
    if (!task || task.dependencyIds.length === 0) return (layer[id] = 0);
    if (visiting.has(id)) return 0;  // 环：给兜底层号，避免栈溢出
    visiting.add(id);
    const parentMax = Math.max(...task.dependencyIds.map((d) => computeLayer(d)));
    visiting.delete(id);
    return (layer[id] = parentMax + 1);
  };
  tasks.forEach((t) => computeLayer(t.id));

  const byLayer: Record<number, AiTaskNode[]> = {};
  tasks.forEach((t) => (byLayer[layer[t.id]] ??= []).push(t));
  Object.values(byLayer).forEach((list) => list.sort((a, b) => a.title.localeCompare(b.title)));

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  Object.entries(byLayer).forEach(([layerNum, layerTasks]) => {
    layerTasks.forEach((task, index) => {
      nodes.push({
        id: task.id,
        position: { x: Number(layerNum) * 240, y: index * 120 },
        data: { task },
        type: "taskNode",
        draggable: false,
      });
      task.dependencyIds.forEach((depId) =>
        edges.push({ id: `${depId}->${task.id}`, source: depId, target: task.id } as Edge)
      );
    });
  });

  const result: LayoutCache = { layoutVersion, nodes, edges };
  try {
    localStorage.setItem(cacheKey, JSON.stringify(result));
  } catch {
    /* 缓存失败不影响渲染 */
  }
  return { nodes: result.nodes, edges: result.edges };
}
```

- [ ] **Step 3: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

预期：无错误。

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add package.json package-lock.json src/components/ai-delivery/utils/taskGraphLayout.ts && git commit -m "[AI交付] DAG 拓扑分层布局算法与 localStorage 缓存"
```

---

### Task T3-2: TaskNodeCard + TaskDagView + DeliveryDetail 视图切换

**Files:**
- Create: `terminal-buddy/src/components/ai-delivery/TaskNodeCard.tsx`
- Create: `terminal-buddy/src/components/ai-delivery/TaskDagView.tsx`
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（顶部 Tab 切换）
- Modify: `terminal-buddy/src/components/ai-delivery/AiDeliveryWorkspace.css`（状态色/紧凑模式样式）

**Interfaces:**
- Consumes: T3-1 的 `computeTaskGraphLayout`、AiTaskNode；节点点击 → 右侧详情抽屉（T4 编辑入口，本任务先以占位回调 `onNodeClick(taskId)` 暴露）
- Produces: `TaskDagView({ tasks, onNodeClick })` 组件；DeliveryDetail「列表视图 ↔ DAG 视图」Tab（默认列表；节点 >5 显示「建议切换 DAG 视图」徽章）；节点数 >50 自动紧凑模式（小圆点仅状态色）

- [ ] **Step 1: 新建 TaskNodeCard（完整实现）**

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { AiTaskNode } from "../../types/aiDelivery";

export const STATE_COLORS: Record<string, string> = {
  planned: "#94a3b8", ready: "#3b82f6", queued: "#60a5fa",
  running: "#eab308", succeeded: "#22c55e", failed: "#ef4444",
  policyViolation: "#dc2626", rework: "#f97316", cancelled: "#64748b",
  awaitingReview: "#06b6d4", needsInput: "#a855f7",
};

export function TaskNodeCard({ data, compact }: NodeProps & { compact?: boolean }) {
  const task = data.task as AiTaskNode;
  if (compact) {
    return (
      <div className="ai-dag-node ai-dag-node-compact" style={{ background: STATE_COLORS[task.state] ?? "#94a3b8" }}>
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }
  return (
    <div className={`ai-dag-node ${task.state === "running" ? "ai-dag-node-running" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="ai-dag-node-title">{task.title}</div>
      <div className="ai-dag-node-meta">
        <span className="ai-status-chip" style={{ background: STATE_COLORS[task.state] ?? "#94a3b8" }}>{task.state}</span>
        {task.roleId && <span className="ai-dag-node-role">角色 {task.roleId}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

- [ ] **Step 2: 新建 TaskDagView（完整实现）**

```tsx
import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { computeTaskGraphLayout } from "./utils/taskGraphLayout";
import { TaskNodeCard } from "./TaskNodeCard";
import type { AiTaskNode } from "../../types/aiDelivery";

interface Props {
  tasks: AiTaskNode[];
  onNodeClick: (taskId: string) => void;
}

export function TaskDagView({ tasks, onNodeClick }: Props) {
  const compact = tasks.length > 50;
  const { nodes, edges } = useMemo(() => computeTaskGraphLayout(tasks), [tasks]);

  // @xyflow/react v12 的 NodeTypes 类型较严；若 `(props: any)` 与类型定义冲突，改显式标注 NodeTypes（安装后以 tsc 结果为准）
  const nodeTypes = useMemo(() => ({ taskNode: (props: any) => <TaskNodeCard {...props} compact={compact} /> }), [compact]);

  return (
    <div className="ai-dag-view">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        onNodeClick={(_, node) => onNodeClick(String(node.id))}
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 3: DeliveryDetail 视图切换**

`DeliveryDetail.tsx` 顶部 Tab 区加：

```tsx
const [viewMode, setViewMode] = useState<"list" | "dag">("list");
// Tab 区：
<div className="ai-detail-tabs">
  <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")}>列表视图</button>
  <button className={viewMode === "dag" ? "active" : ""} onClick={() => setViewMode("dag")}>DAG 视图</button>
  {tasks.length > 5 && viewMode === "list" && (
    <span className="ai-dag-hint">任务较多，建议切换 DAG 视图</span>
  )}
</div>
// 内容区：
{viewMode === "dag" ? (
  <TaskDagView tasks={tasks} onNodeClick={(id) => setEditingTaskId(id)} />
) : (/* 既有列表渲染 */}
```

`setEditingTaskId` 状态与 T4 的 TaskNodeEditor 抽屉共用（本任务先声明、T4-4 接入编辑器，占位时点击暂无动作或 console.log）。

- [ ] **Step 4: CSS 样式**

`AiDeliveryWorkspace.css` 追加（复用 `data-theme` 语义、ai-status-chip 既有风格 1090-1098）：

```css
.ai-dag-view { height: 560px; border: 1px solid var(--border); border-radius: 8px; }
.ai-dag-node { padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); min-width: 160px; }
.ai-dag-node-running { animation: ai-dag-pulse 1.2s ease-in-out infinite; }
@keyframes ai-dag-pulse { 50% { box-shadow: 0 0 8px rgba(234, 179, 8, 0.6); } }
.ai-dag-node-compact { width: 14px; height: 14px; border-radius: 50%; }
.ai-dag-node-title { font-weight: 600; font-size: 13px; }
.ai-dag-node-meta { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
.ai-dag-hint { color: var(--accent); font-size: 12px; margin-left: 8px; }
```

- [ ] **Step 5: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

预期：无错误。

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/TaskNodeCard.tsx src/components/ai-delivery/TaskDagView.tsx src/components/ai-delivery/DeliveryDetail.tsx src/components/ai-delivery/AiDeliveryWorkspace.css && git commit -m "[AI交付] DAG 可视化视图与列表/DAG 切换"
```

---

### Task T4-1: 环依赖检测 helper + 单测 3 例 + create_task_node 接入

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（新增 helper；`create_task_node` 1176-1269 的 dependency 校验 1224-1229 后接入；`#[cfg(test)]` 模块）

**Interfaces:**
- Produces: `fn has_cycle(delivery_tasks: &[AiTaskNode]) -> bool`（或 `find_cycle(...)` 返回路径）——供 T4-2 `update_task_node` 复用；`cargo test` 3 例：自环 / 间接环 / 复杂环（V 形 + 分叉）

- [ ] **Step 1: 编写失败测试**

在 `#[cfg(test)]` 模块（`agent_decision_tests` 5110 附近或新模块）内加：

```rust
#[test]
fn cycle_detection_self_loop() {
    let tasks = vec![
        node("a", vec!["a".to_string()]),  // 自环
    ];
    assert!(AiDeliveryService::has_cycle(&tasks));
}

#[test]
fn cycle_detection_indirect_loop() {
    let tasks = vec![
        node("a", vec!["b".to_string()]),
        node("b", vec!["a".to_string()]),  // 间接环
    ];
    assert!(AiDeliveryService::has_cycle(&tasks));
}

#[test]
fn cycle_detection_complex() {
    // V 形分叉 + 汇合后的环：a->b, a->c, b->d, c->d, d->a
    let tasks = vec![
        node("a", vec!["b".to_string(), "c".to_string()]),
        node("b", vec!["d".to_string()]),
        node("c", vec!["d".to_string()]),
        node("d", vec!["a".to_string()]),
    ];
    assert!(AiDeliveryService::has_cycle(&tasks));
}
```

（`node(id, deps)` 测试辅助函数构造最小 AiTaskNode：id 与 dependency_ids 字段有值、其余 Default::default()——若 AiTaskNode 未实现 Default，用显式构造补全必填字段；acyclic 场景可加第四例 `assert!(!has_cycle(...))`。）

- [ ] **Step 2: 运行确认失败**

```bash
cd terminal-buddy && cargo test has_cycle 2>&1 | tail -15
```

预期：FAIL（`no function or associated item has_cycle`）。

- [ ] **Step 3: 实现 helper**

`impl AiDeliveryService` 内新增（DFS 三色标记）：

```rust
/// 环依赖检测（自环、间接环），供 create/update task_node 共用
pub fn has_cycle(delivery_tasks: &[AiTaskNode]) -> bool {
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut stack: std::collections::HashSet<String> = std::collections::HashSet::new();

    fn dfs(by_id: &std::collections::HashMap<String, &AiTaskNode>,
           id: &str, visited: &mut std::collections::HashSet<String>,
           stack: &mut std::collections::HashSet<String>) -> bool {
        if stack.contains(id) { return true; }
        if visited.contains(id) { return false; }
        visited.insert(id.to_string());
        stack.insert(id.to_string());
        if let Some(task) = by_id.get(id) {
            for dep in &task.dependency_ids {
                if dfs(by_id, dep, visited, stack) { return true; }
            }
        }
        stack.remove(id);
        false
    }

    let by_id: std::collections::HashMap<String, &AiTaskNode> =
        delivery_tasks.iter().map(|t| (t.id.clone(), t)).collect();
    for task in delivery_tasks {
        if dfs(&by_id, &task.id, &mut visited, &mut stack) {
            return true;
        }
    }
    false
}
```

- [ ] **Step 4: create_task_node 接入**

`create_task_node` 的 dependency_ids 成员校验（1224-1229）通过后、**在 `let task = AiTaskNode { ... }` 构造完成之后、`Self::save` 之前**追加（1224-1229 处任务对象尚未构造、`candidate` 不存在；成员列表变量名是 `existing_tasks`，见 1223 行）：

```rust
// 环依赖校验：先建 A 依赖 B、再建 B 依赖 A 可绕过成员校验直接成环
// 位置：task 构造后、save 前（1224-1229 处仅有 existing_tasks 成员校验循环，新任务对象尚未构造）
let mut all_tasks = existing_tasks.clone();  // 1224 行既有成员列表变量名（原稿误写为 1223 / 不存在的 candidate）
all_tasks.push(task.clone());  // task 为已构造的新节点（含新 dependency_ids）
if Self::has_cycle(&all_tasks) {
    return Err("依赖关系形成环，任务无法派发".to_string());
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd terminal-buddy && cargo test has_cycle 2>&1 | tail -15
```

预期：PASS（3 例全过）。

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/services/ai_delivery_service.rs && git commit -m "[AI交付] 环依赖检测 helper 及 3 例单测，create 路径接入"
```

---

### Task T4-2: update_task_node 服务层（状态约束 / 校验复用 / contract 标脏 / 未决清理 / 状态重算）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/models/ai_delivery.rs`（`AiTaskContract` 196 起加 `dirty`；新增 `UpdateAiTaskNodeInput`）
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（新增 `update_task_node`；`create_task_contract` 3481 行第三处 `.min(10)` 处理）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs`（新增 `update_ai_task_node` 命令）
- Modify: `terminal-buddy/src-tauri/src/lib.rs`（invoke_handler 注册，487-539 命令注册区）

**Interfaces:**
- Consumes: T4-1 `has_cycle`；`create_task_node` 校验约束（1176-1269）；`refresh_ready_task_nodes`（T4-3 扩展后支持 demote）
- Produces: `AiTaskContract.dirty: bool`（serde default false）；`UpdateAiTaskNodeInput`（全部字段见下）；命令 `update_ai_task_node(input: UpdateAiTaskNodeInput) -> Result<AiTaskNode, String>`；事件 `taskNodeEdited`（diff 字符串）

- [ ] **Step 1: 模型：dirty 字段 + UpdateAiTaskNodeInput**

`models/ai_delivery.rs`：

```rust
// AiTaskContract 内
#[serde(default)]
pub dirty: bool,  // 编辑执行相关字段后置位，重试派发时重新审计/重建
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAiTaskNodeInput {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub role_id: Option<Option<String>>,           // 双 Option = 区分「未提供」和「设为空」
    pub preferred_agent_id: Option<Option<String>>,
    pub task_prompt: Option<String>,
    pub execution_mode: Option<String>,
    pub execution_context: Option<String>,
    pub target_repository_id: Option<String>,
    pub allowed_write_paths: Option<Vec<String>>,
    pub dependency_ids: Option<Vec<String>>,
    pub expected_artifacts: Option<Vec<String>>,
    pub acceptance_commands: Option<Vec<String>>,
    pub timeout_seconds: Option<Option<u32>>,
    pub retry_count: Option<u32>,                  // 0 = 不限；允许 >10
}
```

> 注意：inputArtifacts / workflowStepId 前端不编辑，不在此暴露。检查 `AiTaskContract` 是否已有其他 `#[serde(default)]` 字段用法保持风格一致。

- [ ] **Step 2: 服务层 update_task_node（完整实现骨架）**

```rust
pub fn update_task_node(input: UpdateAiTaskNodeInput) -> Result<AiTaskNode, String> {
    let mut task = Self::get_task_node(&input.id)?;
    let delivery = Self::get_delivery(&task.delivery_id)?;

    // 1) 状态校验（task 状态，非 delivery 状态）
    let editable = match task.state.as_str() {
        "planned" => true,
        "failed" | "rework" | "cancelled" | "needsInput" | "policyViolation"
            => matches!(delivery.state.as_str(), "running" | "paused" | "needsInput"),
        _ => false,  // queued/running/succeeded/awaitingReview 拒绝
    };
    if !editable {
        return Err(format!("任务状态 {} 不可编辑（仅 planned 或失败/返工/取消/待输入/策略违规且交付运行中可编辑）", task.state));
    }

    let original = task.clone();

    // 2) 字段应用（Option 语义：None 不改，Some(Some(v)) 赋值，Some(None) 置空）
    if let Some(v) = input.title { task.title = v; }
    if let Some(v) = input.description { task.description = v; }
    if let Some(v) = input.role_id { task.role_id = v; }
    if let Some(v) = input.preferred_agent_id { task.preferred_agent_id = v; }
    if let Some(v) = input.task_prompt { task.task_prompt = v; }
    if let Some(v) = input.execution_mode { task.execution_mode = v; }
    if let Some(v) = input.execution_context { task.execution_context = v; }
    if let Some(v) = input.target_repository_id { task.target_repository_id = v; }
    if let Some(v) = input.allowed_write_paths { task.allowed_write_paths = v; }
    if let Some(v) = input.dependency_ids {
        task.dependency_ids = v;
        // 环依赖校验（本任务与同交付其余任务）
        let mut all = delivery.task_node_ids.iter()
            .filter(|id| *id != &task.id)
            .map(|id| Self::get_task_node(id).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        all.push(task.clone());
        if Self::has_cycle(&all) {
            return Err("依赖关系形成环，任务无法保存".to_string());
        }
    }
    if let Some(v) = input.expected_artifacts { task.expected_artifacts = v; }
    if let Some(v) = input.acceptance_commands { task.acceptance_commands = v; }
    if let Some(v) = input.timeout_seconds { task.timeout_seconds = v; }
    if let Some(v) = input.retry_count { task.retry_count = v; }

    // 3) 复用 create_task_node 的既有约束（排除其 delivery 状态校验）
    //    —— title/description 非空、executionMode 合法、write 需 taskWorktree、
    //       workflowStepId 需 expectedArtifacts、validate_artifact/write_paths、
    //       role_id/preferred_agent_id 至少一个、targetRepositoryId 存在且 write_enabled、
    //       role/agent 存在性、dependency 属本交付
    //    实现方式：抽出 create_task_node 内 1177-1229 的校验段为内部辅助
    //    `fn validate_task_fields(&task, &delivery) -> Result<(), String>`，
    //    create 与 update 共用（注意 create 内 1202-1207 delivery 状态校验留在 create 侧）。

    // 4) 执行相关字段变更 → 标脏 contract
    let exec_fields_changed = [
        input.execution_mode.is_some(), input.execution_context.is_some(),
        input.target_repository_id.is_some(), input.task_prompt.is_some(),
        input.allowed_write_paths.is_some(), input.expected_artifacts.is_some(),
        input.acceptance_commands.is_some(), input.timeout_seconds.is_some(),
    ].iter().any(|b| *b);
    if exec_fields_changed {
        if let Some(contract_id) = &task.contract_id {
            // get_contract 不存在：用 Self::get::<AiTaskContract>(CONTRACTS_DIR, id, label)（参照 retry_task_node:2410）
            if let Ok(mut contract) = Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "任务契约") {
                contract.dirty = true;
                Self::save(CONTRACTS_DIR, contract_id, &contract)?;
            }
        }
    }

    // 5) 未决 gate/decision 清理（needsInput 保留未决 decision request）
    Self::cleanup_pending_gates_and_decisions(&task.delivery_id, &task.id, task.state.as_str())?;

    // 6) 依赖变更 → 状态重算（refresh_ready_task_nodes 扩展后含 demote）
    if input.dependency_ids.is_some() {
        Self::refresh_ready_task_nodes(&task.delivery_id)?;
    }

    task.updated_at = chrono::Utc::now().to_rfc3339();
    Self::save(TASK_NODES_DIR, &task.id, &task)?;

    // 7) diff 审计事件
    let diff = build_task_diff(&original, &task);  // 见 utils/taskNodeDiff.ts 对应的后端字符串构造
    Self::append_event(&task.delivery_id, Some(&task.id), None, "taskNodeEdited", &diff)?;
    Ok(task)
}
```

> 参照实际代码调整：`get_delivery`/`get_task_node` 的实际签名、`TASK_NODES_DIR`/`CONTRACTS_DIR` 常量名、`cleanup_pending_gates_and_decisions`（内部按 `AiReviewGate.task_node_id`/`AiDecisionRequest.task_node_id` 引用删除**未决**记录，复用 delete 的清理逻辑；needsInput 时跳过 decision request 删除）。`get_contract` 不存在，用 `Self::get::<AiTaskContract>(CONTRACTS_DIR, id, label)`。
>
> **`build_task_diff` 需在 T4-2 内一并实现**（评审确认原稿无定义任务）：服务层私有函数，与 `update_task_node` 同处定义：
> ```rust
> /// 构造任务字段 diff 审计文本：只列变更字段，格式 `field: '旧值' → '新值'`
> fn build_task_diff(original: &AiTaskNode, updated: &AiTaskNode) -> String {
>     let mut parts = Vec::new();
>     if original.title != updated.title { parts.push(format!("title: '{}' → '{}'", original.title, updated.title)); }
>     if original.description != updated.description { parts.push(format!("description: '{}' → '{}'", original.description, updated.description)); }
>     if original.role_id != updated.role_id { parts.push(format!("roleId: '{:?}' → '{:?}'", original.role_id, updated.role_id)); }
>     if original.preferred_agent_id != updated.preferred_agent_id { parts.push(format!("preferredAgentId: '{:?}' → '{:?}'", original.preferred_agent_id, updated.preferred_agent_id)); }
>     if original.execution_mode != updated.execution_mode { parts.push(format!("executionMode: '{}' → '{}'", original.execution_mode, updated.execution_mode)); }
>     if original.execution_context != updated.execution_context { parts.push(format!("executionContext: '{:?}' → '{:?}'", original.execution_context, updated.execution_context)); }
>     if original.task_prompt != updated.task_prompt { parts.push("taskPrompt: 已变更".to_string()); }
>     if original.timeout_seconds != updated.timeout_seconds { parts.push(format!("timeoutSeconds: '{:?}' → '{:?}'", original.timeout_seconds, updated.timeout_seconds)); }
>     if original.retry_count != updated.retry_count { parts.push(format!("retryCount: '{}' → '{}'", original.retry_count, updated.retry_count)); }
>     if parts.is_empty() { "无字段变更".to_string() } else { parts.join("；") }
> }
> ```
> （集合类字段 allowed_write_paths / expected_artifacts / acceptance_commands / dependency_ids 变更时输出「`字段: 已变更（N 项）`」即可，避免超长消息。）

- [ ] **Step 3: 命令与注册**

`commands/ai_delivery.rs` 加（含 import）：

```rust
#[command]
pub fn update_ai_task_node(input: UpdateAiTaskNodeInput) -> Result<AiTaskNode, String> {
    AiDeliveryService::update_task_node(input)
}
```

`lib.rs` invoke_handler 注册区（487-539）加入 `update_ai_task_node`。

- [ ] **Step 4: create_task_contract 第三处 .min(10) 处理**

`create_task_contract`（3481）的 `.min(10)`：重试上限判定只用 `task.retry_count`，契约内该值无逻辑用途——删除钳制或保留并注明无害。**本任务删除之**（与 T4-3 的 retry 钳制去除保持一致）。

- [ ] **Step 5: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

预期：无错误。

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/models/ai_delivery.rs src-tauri/src/services/ai_delivery_service.rs src-tauri/src/commands/ai_delivery.rs src-tauri/src/lib.rs && git commit -m "[AI交付] 任务节点编辑 update_task_node（状态约束/标脏/未决清理/diff 事件）"
```

---

### Task T4-3: delete_task_node + refresh demote 扩展 + retry 白名单与钳制

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（新增 `delete_task_node`；扩展 `refresh_ready_task_nodes` 1415-1445；`retry_task_node` 2402 起：白名单 2404、钳制 2408、动态提额 2433-2434）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs`（`delete_ai_task_node` 命令）
- Modify: `terminal-buddy/src-tauri/src/lib.rs`（注册）

**Interfaces:**
- Consumes: T4-1 `has_cycle`；T4-2 的 `cleanup_pending_gates_and_decisions`（可复用）；`terminal_run_dir_by_id`（4802-4819）
- Produces: 命令 `delete_ai_task_node(task_node_id: String) -> Result<(), String>`；`refresh_ready_task_nodes` 支持 **demote**（ready 且依赖不全部 succeeded → planned）；`retry_task_node` 白名单扩为 `failed|rework|cancelled|policyViolation`、去 min(10) 钳制、提额基准改 `task.retry_count`；事件 `taskNodeDeleted`

- [ ] **Step 1: refresh_ready_task_nodes 加 demote**

`refresh_ready_task_nodes`（1415-1445，promote 逻辑依赖检查 `all(|d| succeeded.contains(d))` 1426-1430）在 promote 之外追加：

```rust
// demote：ready 且依赖不全部 succeeded（含依赖已删除 / failed / rework / cancelled / planned）→ 回退 planned
let succeeded: std::collections::HashSet<String> = tasks.iter()
    .filter(|n| n.state == "succeeded").map(|n| n.id.clone()).collect();
for mut node in tasks.clone() {
    if node.state == "ready"
        && !node.dependency_ids.is_empty()
        && !node.dependency_ids.iter().all(|d| succeeded.contains(d))
    {
        node.state = "planned".to_string();
        Self::save(TASK_NODES_DIR, &node.id, &node)?;
    }
}
```

（以 1415-1445 既有实现为准：demote 放同函数内、共享成功集计算。）

- [ ] **Step 2: retry_task_node 三处调整**

1. 白名单（2404）：`matches!(task.state.as_str(), "failed" | "rework" | "cancelled" | "policyViolation")`（新增 policyViolation）。
2. 钳制（2408）：`let effective_retry_limit = task.retry_count;`（删 `.min(10)`；后续判定直接用）。
3. 动态提额（2433-2434）：提额基准从 `effective_retry_limit` 改为 `task.retry_count`：

```rust
if attempted >= task.retry_count {
    task.retry_count = task.retry_count.max(attempted + 1);
}
```

（保留「0 = 不限」语义：若 retry_count == 0 则判定处应为不限制——以既有 `retry_count == 0` 处理为准，只去掉 10 的上限钳制。）

4. **create_task_node:1248 的 `.min(10)` 同样去除**——`.min(10)` 共 3 处：1248（create_task_node）/ 2408（retry_task_node）/ 3481（create_task_contract，T4-2 已删）。本任务补齐 1248，三处全部处理，与 T4-4 UI「允许超过 10」及 DoD 一致。

- [ ] **Step 3: delete_task_node（完整实现骨架）**

```rust
pub fn delete_task_node(task_node_id: &str) -> Result<(), String> {
    let task = Self::get_task_node(task_node_id)?;
    let mut delivery = Self::get_delivery(&task.delivery_id)?;

    // 状态约束：planned / failed / rework / cancelled / needsInput / policyViolation 可删；queued/running 拒绝
    if matches!(task.state.as_str(), "queued" | "running") {
        return Err(format!("任务状态 {} 不可删除", task.state));
    }

    // 级联清理：entity 文件用 Self::delete（242 行封装 DatabaseService::delete_ai_entity，既有代码统一用它）。
    //   注意：entity_dir 是 impl AiDeliveryService 内的关联函数（224 行），裸调用 entity_dir(...) 不加 Self::
    //   前缀会编译失败；run_dir 不是 entity，仍用 std::fs::remove_dir_all。
    // 1) contract
    if let Some(contract_id) = &task.contract_id {
        let _ = Self::delete(CONTRACTS_DIR, contract_id, "任务契约");
    }
    // 2) attempt 文件 + 运行目录（terminal_run_dir_by_id 兼容「纯 UUID」与「label__UUID」）
    for attempt_id in &task.attempt_ids {
        if let Ok(attempt) = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试") {
            if let Some(run_dir) = terminal_run_dir_by_id(&attempt.id) {  // 自由函数单参数（4802-4819）
                let _ = std::fs::remove_dir_all(run_dir);
            }
        }
        let _ = Self::delete(ATTEMPTS_DIR, attempt_id, "执行尝试");
    }
    // 3) review gate / decision request（按 task_node_id 引用）
    Self::cleanup_pending_gates_and_decisions(&task.delivery_id, &task.id, "deleted")?;  // 全部删除（非仅未决）
    // 4) delivery.task_node_ids 移除
    delivery.task_node_ids.retain(|id| id != task_node_id);
    Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
    // 5) 删除任务文件
    let _ = Self::delete(TASK_NODES_DIR, task_node_id, "任务节点");
    // 6) 引用它的 dependencyIds 自动移除 + 状态重算
    for other_id in delivery.task_node_ids.clone() {
        if let Ok(mut other) = Self::get_task_node(&other_id) {
            if other.dependency_ids.contains(&task.id) {
                other.dependency_ids.retain(|d| d != &task.id);
                Self::save(TASK_NODES_DIR, &other.id, &other)?;
            }
        }
    }
    Self::refresh_ready_task_nodes(&task.delivery_id)?;
    Self::append_event(&task.delivery_id, Some(&task.id), None, "taskNodeDeleted", &format!("任务 {} 已删除", task.title))?;
    Ok(())
}
```

> 参照实际代码：`cleanup_pending_gates_and_decisions` 若 T4-2 已实现为「仅未决」语义，则删除场景需全删——给该辅助加参数或删除场景单独写循环（遍历 REVIEW_GATES_DIR / DECISION_REQUESTS_DIR 按 task_node_id 过滤删除）。目录扫描方式参照 `terminal_run_dir_by_id`（4802-4819）的 read_dir 用法。辅助符号修正：`Self::get_attempt` → `Self::get::<AiAttempt>`；entity 文件删除用 `Self::delete(DIR, id, label)`（242 行封装，不要手写 `entity_dir(...).join(...)`+`remove_file`）；常量名是 `DECISIONS_DIR`（目录名 "DecisionRequests"，**非** `DECISION_REQUESTS_DIR`）；`terminal_run_dir_by_id` 是自由函数单参数。

- [ ] **Step 4: 命令与注册**

`commands/ai_delivery.rs` 加：

```rust
#[command]
pub fn delete_ai_task_node(task_node_id: String) -> Result<(), String> {
    AiDeliveryService::delete_task_node(&task_node_id)
}
```

`lib.rs` 注册 `delete_ai_task_node`。

- [ ] **Step 5: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

预期：无错误。

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/services/ai_delivery_service.rs src-tauri/src/commands/ai_delivery.rs src-tauri/src/lib.rs && git commit -m "[AI交付] 任务删除级联清理、依赖状态回退、重试白名单放行 policyViolation 并去上限钳制"
```

---

### Task T4-4: TaskNodeEditor 前端 + 接入点 + 事件卡片

**Files:**
- Create: `terminal-buddy/src/components/ai-delivery/TaskNodeEditor.tsx`（约 500 行）
- Create: `terminal-buddy/src/components/ai-delivery/utils/taskNodeDiff.ts`
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（DAG 点击/列表卡片菜单接入编辑）
- Modify: `terminal-buddy/src/components/ai-delivery/AiDeliveryWorkspace.tsx`（taskNodeEdited/Deleted 事件卡片）
- Modify: `terminal-buddy/src/components/ai-delivery/workspace-utils.ts`（事件类型注册）
- Modify: `terminal-buddy/src/services/tauri.ts`（`updateAiTaskNode` / `deleteAiTaskNode` 封装）

**Interfaces:**
- Consumes: T4-2 `update_ai_task_node` / T4-3 `delete_ai_task_node` 命令；T2-5 `TaskNodeFields` 共用组件；T3-2 DAG `onNodeClick`
- Produces: `TaskNodeEditor({ task, agents, roles, project, deliveryTasks, onClose, onSaved })` 抽屉组件；事件卡片 `taskNodeEdited`（显示 diff）/ `taskNodeDeleted`（灰底删除线）

- [ ] **Step 1: tauri.ts 封装 + 类型**

```ts
export const updateAiTaskNode = (input: UpdateAiTaskNodeInput) =>
  invoke<AiTaskNode>("update_ai_task_node", { input });
export const deleteAiTaskNode = (taskNodeId: string) =>
  invoke<void>("delete_ai_task_node", { taskNodeId });
```

`src/types/aiDelivery.ts` 加：

```ts
export interface UpdateAiTaskNodeInput {
  id: string;
  title?: string;
  description?: string;
  roleId?: string | null;
  preferredAgentId?: string | null;
  taskPrompt?: string;
  executionMode?: 'write' | 'readonly';
  executionContext?: 'workspaceRoot' | 'taskWorktree';
  targetRepositoryId?: string;
  allowedWritePaths?: string[];
  dependencyIds?: string[];
  expectedArtifacts?: string[];
  acceptanceCommands?: string[];
  timeoutSeconds?: number | null;
  retryCount?: number;
}
```

- [ ] **Step 2: taskNodeDiff.ts（diff 渲染）**

```ts
export function formatFieldDiff(field: string, before: string | null, after: string | null): string {
  const fmt = (v: string | null) => v === null ? "空" : `'${v}'`;
  return `${field}: ${fmt(before)} → ${fmt(after)}`;
}
```

（后端 `taskNodeEdited` 事件 message 即 `formatFieldDiff` 风格拼接的 diff 字符串；前端按 message 展示。）

- [ ] **Step 3: TaskNodeEditor（完整实现骨架）**

```tsx
import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { updateAiTaskNode, deleteAiTaskNode } from "../../services/tauri";
import { TaskNodeFields } from "./TaskNodeFields";
import type { AiTaskNode, AiAgent, AiRole, AiProject } from "../../types/aiDelivery";

interface Props {
  task: AiTaskNode;
  agents: AiAgent[];
  roles: AiRole[];
  project: AiProject;
  deliveryTasks: AiTaskNode[];
  onClose: () => void;
  onSaved: () => void;
}

export function TaskNodeEditor({ task, agents, roles, project, deliveryTasks, onClose, onSaved }: Props) {
  const [form, setForm] = useState({ ...task, dependencyIds: [...task.dependencyIds] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 环依赖即时检测（保存 disabled 条件）
  const hasCycle = (() => {
    const others = deliveryTasks.filter((t) => t.id !== task.id);
    const graph = new Map<string, string[]>(others.map((t) => [t.id, t.dependencyIds]));
    graph.set(task.id, form.dependencyIds);
    const visiting = new Set<string>();
    const dfs = (id: string): boolean => {
      if (visiting.has(id)) return true;
      visiting.add(id);
      for (const dep of graph.get(id) ?? []) if (dfs(dep)) return true;
      visiting.delete(id);
      return false;
    };
    for (const id of graph.keys()) if (dfs(id)) return true;
    return false;
  })();

  const save = async () => {
    setBusy(true);
    try {
      await updateAiTaskNode({
        id: task.id,
        title: form.title,
        description: form.description,
        roleId: form.roleId,
        preferredAgentId: form.preferredAgentId,
        taskPrompt: form.taskPrompt,
        executionMode: form.executionMode,
        executionContext: form.executionContext,
        targetRepositoryId: form.targetRepositoryId,
        allowedWritePaths: form.allowedWritePaths,
        dependencyIds: form.dependencyIds,
        expectedArtifacts: form.expectedArtifacts,
        acceptanceCommands: form.acceptanceCommands,
        timeoutSeconds: form.timeoutSeconds,
        retryCount: form.retryCount,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("删除该任务将级联清理其 contract、attempt 运行目录、审查记录与未决决策，且引用它的依赖关系将被移除。确定删除？")) return;
    await deleteAiTaskNode(task.id);
    onSaved();
    onClose();
  };

  return (
    <div className="ai-task-editor" role="dialog" aria-label="编辑任务节点">
      <h3>编辑任务 {task.title}</h3>
      {/* 左侧字段表单（复用 TaskNodeFields 分区结构，含超时/重试） */}
      <div className="ai-task-editor-grid">
        <div className="ai-task-editor-fields">
          <label>任务标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label>任务说明<textarea value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label>角色<select value={form.roleId ?? ""} onChange={(e) => setForm({ ...form, roleId: e.target.value || null })}>
            <option value="">不限定角色</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select></label>
          <label>优先 Agent<select value={form.preferredAgentId ?? ""} onChange={(e) => setForm({ ...form, preferredAgentId: e.target.value || null })}>
            <option value="">由调度器选择</option>
            {agents.filter((a) => a.enabled).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label>
          <label>执行模式<select value={form.executionMode} onChange={(e) => setForm({ ...form, executionMode: e.target.value as "write" | "readonly" })}>
            <option value="write">写入</option><option value="readonly">只读</option>
          </select></label>
          <label>执行目录<select value={form.executionContext ?? ""} onChange={(e) => setForm({ ...form, executionContext: e.target.value as "workspaceRoot" | "taskWorktree" })}>
            <option value="workspaceRoot">项目工作区根目录</option><option value="taskWorktree">任务 worktree</option>
          </select></label>
          <label>目标仓库<select value={form.targetRepositoryId} onChange={(e) => setForm({ ...form, targetRepositoryId: e.target.value })}>
            <option value="">选择允许写入的仓库</option>
            {project.repositories.filter((r) => r.writeEnabled).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select></label>
          <label>允许写入路径<textarea value={form.allowedWritePaths.join("\n")} onChange={(e) => setForm({ ...form, allowedWritePaths: e.target.value.split(/\n|,/) })} /></label>
          <fieldset className="ai-task-dependencies">
            <legend>前置任务（依赖循环时红框警告）</legend>
            <div className={hasCycle ? "ai-dependency-cycle" : ""}>
              {deliveryTasks.filter((t) => t.id !== task.id).map((t) => (
                <label key={t.id}><input type="checkbox" checked={form.dependencyIds.includes(t.id)}
                  onChange={(e) => setForm({ ...form, dependencyIds: e.target.checked ? [...form.dependencyIds, t.id] : form.dependencyIds.filter((id) => id !== t.id) })} />{t.title}</label>
              ))}
            </div>
            {hasCycle && <span className="ai-field-error">依赖关系形成环，无法保存</span>}
          </fieldset>
          <label>预期成果<textarea value={form.expectedArtifacts.join("\n")} onChange={(e) => setForm({ ...form, expectedArtifacts: e.target.value.split(/\n|,/) })} /></label>
          <label>验收命令<textarea value={form.acceptanceCommands.join("\n")} onChange={(e) => setForm({ ...form, acceptanceCommands: e.target.value.split(/\n/) })} /></label>
          <label>超时时间（分钟）
            <input type="number" min="5" max="480" value={form.timeoutSeconds ? String(Math.round(form.timeoutSeconds / 60)) : ""}
              onChange={(e) => setForm({ ...form, timeoutSeconds: e.target.value ? Number(e.target.value) * 60 : null })} /></label>
          <label>最大重试次数（0 = 不限，允许超过 10）
            <input type="number" min="0" max="50" value={form.retryCount} onChange={(e) => setForm({ ...form, retryCount: Number(e.target.value) })} /></label>
          <label>给 Agent 的任务说明
            <Editor height="180px" defaultLanguage="markdown" value={form.taskPrompt}
              onChange={(v) => setForm({ ...form, taskPrompt: v ?? "" })} /></label>
          {error && <div className="ai-field-error">{error}</div>}
          <div className="ai-task-editor-actions">
            <button className="btn-primary" disabled={busy || hasCycle || !form.title} onClick={save}>保存</button>
            <button className="btn-danger" disabled={busy} onClick={remove}>删除此任务</button>
            <button className="btn-secondary" onClick={onClose}>取消</button>
          </div>
        </div>
        <div className="ai-task-editor-preview">{/* 右侧实时预览（只读展示当前表单字段） */}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 接入点**

`DeliveryDetail.tsx`：
- DAG 节点点击（T3-2 的 `setEditingTaskId(id)`）与列表卡片操作菜单「编辑任务」项均打开抽屉：

```tsx
{editingTaskId && tasks.find((t) => t.id === editingTaskId) && (
  <TaskNodeEditor
    task={tasks.find((t) => t.id === editingTaskId)!}
    agents={agents} roles={roles} project={project} deliveryTasks={tasks}
    onClose={() => setEditingTaskId(null)} onSaved={onRefresh}
  />
)}
```

（`agents`/`roles`/`project`/`onRefresh` 从既有 props/上下文取——DeliveryDetail 已有这些数据则直接传，否则从 AiDeliveryWorkspace 经 props 传入。）

- [ ] **Step 5: 事件卡片 + 注册表**

`workspace-utils.ts` 加：

```ts
taskNodeEdited: "任务已编辑",
taskNodeDeleted: "任务已删除",
```

`DeliveryDetail.tsx` 事件渲染处（749-765，同 T2-5 Step 4 定位）加分支：

```tsx
{event.eventType === "taskNodeEdited" && <span className="ai-event-diff">{event.message}</span>}
{event.eventType === "taskNodeDeleted" && <span className="ai-event-deleted">{event.message}</span>}
```

CSS：`.ai-event-deleted { color: var(--muted); text-decoration: line-through; }`、`.ai-event-diff { font-family: monospace; font-size: 12px; }`、`.ai-dependency-cycle { border: 1px solid #ef4444; }`。

- [ ] **Step 6: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

预期：无错误。

- [ ] **Step 7: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/ src/services/tauri.ts src/types/aiDelivery.ts && git commit -m "[AI交付] 任务节点编辑抽屉与事件卡片（DAG/列表双入口）"
```

---

## 迭代 1 验证（DoD 源自规范 §3.7）

全部任务完成后执行：

- [ ] `cd terminal-buddy && cargo test` — 全通过（含环依赖检测 3 例 + 既有 agent_decision_tests/terminal_command_tests）
- [ ] `cd terminal-buddy && cargo check` — 无错误无警告
- [ ] `cd terminal-buddy && npx tsc --noEmit` — 无错误
- [ ] 用户能在 DeliveryDetail 看到 DAG 视图切换，10+ 节点时依赖关系一目了然
- [ ] 运行中的 attempt 可点按钮实时查看 xterm 日志（事件流，无轮询延迟）
- [ ] AI 终端从任意入口（标签页 / 实时弹窗）打开均不破坏 live-output.log 落盘（`drain_terminal_output` 后端豁免生效）
- [ ] 创建/编辑任务节点时可设置超时，留空时使用 Agent 默认，80% 时任务卡片显示橙色「即将超时」徽章
- [ ] `approachingTimeout` 事件实时到达（append_event 统一 emit，无 4 秒轮询延迟）
- [ ] Agent 配置区可设置默认超时，创建任务对话框的提示文案动态显示该默认值
- [ ] 编辑任务节点后事件列表出现 `taskNodeEdited` 带 diff
- [ ] 运行中的交付里，failed/rework/cancelled 任务可编辑（提高 retryCount 后重试成功，含 10 次用尽后提高到 11+ 的场景）
- [ ] 编辑状态约束边界：queued/running/succeeded/awaitingReview 拒绝编辑；needsInput 可编辑且其未决 decision request 保留；policyViolation 可编辑且重试白名单放行
- [ ] 删除任务节点后 contract、attempt 目录、review gate、decision request 均被清理，`delivery.taskNodeIds` 同步移除，引用它的 dependencyIds 自动移除
- [ ] 编辑/删除任务节点（含依赖增删）后，下游任务状态被扩展后的 `refresh_ready_task_nodes` 重算（promote/demote）
- [ ] 环依赖检测阻止保存（create 与 update 两路径均生效）
- [ ] 运行时长与超时起算点均基于 `startedAt`（前端展示与 watchdog 一致）
- [ ] 超时终止、交付收尾、合并冲突/成功有系统托盘通知，点击可跳转对应交付
- [ ] Web 端能看实时终端（轮询 liveOutputTail，验证 HTTP 路径通即可）

## 自审记录

- **规范覆盖**：§3 迭代 1 的 T1-T4 全部要点有对应任务（T1 拆 4 任务、T2 拆 5 任务、T3 拆 2 任务、T4 拆 4 任务）；§3.5 文件清单全覆盖（含「不用动」的 AttemptOutputDialog 未改动）；§3.7 DoD 全部条款列入验证。
- **无占位符**：所有代码步骤含完整代码块或精确行号锚点 + 读取指令；「参照既有实现」均为可执行的读代码指令（如 T1-1/T1-2/T4-2 的「以实际代码为准」标注）。
- **类型一致性**：`has_cycle`（T4-1 定义 → T4-2/T4-3 使用）、`dirty`（T4-2 定义 → 迭代 2 基线校验使用）、`cleanup_pending_gates_and_decisions`（T4-2 定义 → T4-3 使用并注明 deleted 全删语义）、`TaskNodeFields`（T2-5 定义 → T4-4 使用）、`computeTaskGraphLayout`（T3-1 定义 → T3-2 使用）；事件类型 `approachingTimeout`（T2-2 产生/T2-5 注册）、`taskNodeEdited`/`taskNodeDeleted`（T4-2/T4-3 产生/T4-4 注册）签名一致；`setEditingTaskId` 状态在 T3-2 声明、T4-4 使用。
- **已知偏差**：`update_task_node` 的校验复用（T4-2 Step 2 第 3 条）要求把 create_task_node 校验段抽为 `validate_task_fields`——实现时按实际代码结构抽出（排除 1202-1207 delivery 状态校验）。
- **评审修正（2026-08-02 四代理并行审核后修订）**：P1 修正 7 处——T1-1 置位补 `set_ai_delivery_flag` 方案（方案 A/B）、T2-2 watchdog 禁用 `?`/TimeDelta 秒数比较/spawn 行号 2771-2777、T1-2 monitor 禁用 `?`/字符边界截断、T1-3 变量修正与 `terminal_run_dir_by_id` 单参、T2-5 `saveAgentConfig` 双参、T4-1 环检测移到任务构造后；另补 `build_task_diff` 定义、`create_task_node:1248` 钳制去除、模型字段级 `#[serde(default)]` 标注、前端 AiAgent 55 行等行号修正。

---

*行号引用以 `docs/ai-delivery-implementation-plan.md` 核实的 HEAD `ea369ac` 代码为准；实现时如行号漂移，按函数名定位。*
