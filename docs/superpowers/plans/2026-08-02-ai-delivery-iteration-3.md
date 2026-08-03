# AI 交付迭代 3 实施计划（P2：统计 / 审查 / 配置 / Web API / 可靠性）

> 本文件由 `2026-08-02-ai-delivery-iterations-1-4.md` 拆分而来（2026-08-02），实施依据为 `docs/ai-delivery-implementation-plan.md`（2026-08-02 定稿，4 轮核实）。完整 4 迭代拆分为：迭代 1（T1-T4，已完成规划）/ 迭代 2（P1，已完成规划）/ 迭代 3（本文件）/ 迭代 4。
> **前置依赖**：迭代 1 的 T2-2（approachingTimeout）、**T2-3（append_event 统一 emit——本迭代 Global Constraints 第 23 行的「新增事件无需手动 emit」依赖它，N6-2/N11-1 的事件实时推送亦依赖；T2-3 未落地时新事件只能靠前端 4 秒轮询）**、T4-2/T4-3（任务编辑/删除命令）；迭代 2 的 N5-1（合并详情面板）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P2 迭代 3：交付统计面板、增量 Diff 审查、Agent 启动预设管理、工作流步骤预览和测试、缺失 REST 路由补全、N6 needsInput 重启恢复、N7 合并失败交付终态、N8 已答决策历史、N9 事件查看全部+搜索+分页、N10 事件文件滚动清理、N11 规划中断「以当前状态重跑」，共 11 个任务。

**Architecture:** 变更集中在 `src-tauri/src/`（services/commands/models/web）与 React 前端 `src/components/ai-delivery/`。可观测性基础（N9/N10）先行，N7 与迭代 2 的 N5/冲突续接联动。

**Tech Stack:** Rust (Tauri 2), React ^19.2.6, TypeScript, @monaco-editor/react ^4.7.0（已就绪）, axum（Web API）。

## Global Constraints

- 项目实际文件在 `terminal-buddy/` 子目录；`cd terminal-buddy` 后执行所有命令。
- 所有 Rust↔TS 序列化使用 camelCase（serde `rename_all = "camelCase"`，30 个结构体已有 30 处）。
- 更新输入用双 Option（`Option<Option<T>>`）区分「未提供」与「设为空」。
- **任务状态全集**：planned / ready / queued / running / succeeded / failed / policyViolation / rework / cancelled / awaitingReview / needsInput（迭代 2 已引入第 12 种 `skipped`）。
- **attempt 状态**：queued / running / needsInput / cancelled / failed / **completed**（成功态）/ policyViolation（无 `succeeded`）。
- **delivery 状态**：drafting / planning / awaitingApproval / running / paused / cancelled / needsInput / completed / succeeded / failed。**N7-2 将引入 `mergeFailed`**（合并失败终态），需同步前端命名与筛选（**注意：前端 deliveryStateNames 已有 12 项，含 blocked/merging 两项后端从不设置的残留——「第 11 种」计数不成立，仅新增注册与筛选项即可**）。`"merging"`/`"blocked"` 是 **merge 记录**状态，不是 delivery 状态。
- 事件类型必须在 `src/components/ai-delivery/workspace-utils.ts` 的 `eventTypeNames`（现有 46 项，168-215 行）注册中文名，否则事件列表显示原始英文串。
- 事件由 `append_event` 统一 emit `ai-delivery-event`（迭代 1 T2-3 已收口）；**新增事件无需手动 emit**。
- 新 REST 路由必须在 `web/server.rs` 注册（AI 交付区块 49-96 行内追加），遗漏即 404。
- 单元测试落位 `src-tauri/src/services/ai_delivery_service.rs` 内 `#[cfg(test)]` 模块（先例：`agent_decision_tests` 5110、`terminal_command_tests` 5991），验收以 `cargo test` 通过为准。
- 前端 UI 文案用中文（简体）；commit message 格式 `[模块] 变更描述`。
- 所有新增模型字段必须有 `#[serde(default)]`（或 `Option`）以兼容旧 JSON 文件；前端类型必须同步 `src/types/aiDelivery.ts`。
- 前端事件通道仅 `ai-delivery-event`；`open-ai-attempt-terminal` 是 **window 级 CustomEvent**（非 Tauri 通道）。

---

## File Structure

### 修改（后端 `src-tauri/src/`）
- `services/ai_delivery_service.rs`（7460 行）— N7-2/N6-2/REST 后端/REST-1/工作流预览/N10
- `commands/ai_delivery.rs` + `lib.rs` — 新命令注册
- `web/handlers/ai_delivery_handler.rs` + `web/server.rs` — REST 路由补全
- `models/ai_delivery.rs` — 预设模型/行评论字段

### 修改（前端 `src/`）
- `src/components/ai-delivery/DeliveryDetail.tsx` — Diff 审查/产物入口
- `src/components/ai-delivery/AiDeliveryWorkspace.tsx` — 决策历史/事件分页
- `src/components/ai-delivery/ConfigDialog.tsx` — 预设管理/工作流预览
- `src/components/ai-delivery/AiDeliveryApp.tsx` — 统计标签页
- `src/services/tauri.ts`、`src/types/aiDelivery.ts` — 封装与类型
- `src/components/ai-delivery/workspace-utils.ts` — mergeFailed/事件注册
- 新建 `EventListView.tsx`、`ReviewDiffView.tsx`、`DeliveryStatsPanel.tsx`

---

## 任务（建议顺序：N9 → N10 → N7 → N6 → N8 → 统计 → Diff → 预设 → REST → 工作流预览 → N11）

### Task N9-1: 事件/列表「查看全部 + 搜索 + 分页」

**Files:**
- Modify: `terminal-buddy/src/components/ai-delivery/AiDeliveryWorkspace.tsx`（事件 slice(-20) 897 行、内存上限 slice(-500) 395 行）
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（attempt 事件 slice(-160) 634 行）

**Interfaces:**
- Consumes: 既有事件数据（get_delivery_events 全量读）
- Produces: 统一事件列表组件：查看全部（分页 100 条/页）、关键字搜索（eventType/message 过滤）

- [ ] **Step 1: 通用事件列表组件**

新建 `src/components/ai-delivery/EventListView.tsx`：

```tsx
import { useMemo, useState } from "react";
import type { AiDeliveryEvent } from "../../types/aiDelivery";
import { eventTypeName, isFailedEventType } from "./workspace-utils";

interface Props {
  events: AiDeliveryEvent[];
  pageSize?: number;
}

export function EventListView({ events, pageSize = 100 }: Props) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) =>
      e.eventType.toLowerCase().includes(q) ||
      (e.message ?? "").toLowerCase().includes(q)
    );
  }, [events, query]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageEvents = filtered.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="ai-event-list-view">
      <div className="ai-event-list-toolbar">
        <input type="search" placeholder="搜索事件..." value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
        <span>共 {filtered.length} 条</span>
      </div>
      <ul>
        {pageEvents.map((event) => (
          <li key={event.id} className={isFailedEventType(event.eventType) ? "ai-event-failed" : ""}>
            <span className="ai-event-type">{eventTypeName(event.eventType)}</span>
            <span className="ai-event-msg">{event.message}</span>
            <span className="ai-event-time">{formatEventTime(event.occurredAt)}</span>
          </li>
        ))}
      </ul>
      <div className="ai-event-list-pager">
        <button className="btn-secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>上一页</button>
        <span>{page + 1}/{pages}</span>
        <button className="btn-secondary" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>下一页</button>
      </div>
    </div>
  );
}
```

（`formatEventTime` 从 workspace-utils.ts 导入；既有事件渲染样式复用。）

- [ ] **Step 2: 三处替换（评审修正）**

- `AiDeliveryWorkspace.tsx` 897 行 `slice(-20)` → 该处改为「查看全部」按钮打开 `<EventListView />` 弹窗（标题数字显示总数，不再截断）。**评审修正：弹窗打开时直接 `invoke` 全量事件（tauri.ts:654 `getAiDeliveryEvents` 已有封装），不要用 state 中的增量数据**——增量路径 `[...current, event].slice(-500)`（395 行）在 >500 条后截断，用 state 则「查看全部」也拿不到早期事件，且标题数字会跳变。
- 395 行 `slice(-500)` 内存上限保留（数据源本身的上限），但展示层不再截断。
- `DeliveryDetail.tsx` 634 行 `slice(-160)` → 同样接 EventListView（attempt 过滤后传入）。
- **排序修正：`get_delivery_events`（1447-1454）按 occurred_at 升序返回**（非倒序）——既有 897 行靠 `slice(-20).reverse()` 倒序展示；EventListView 需对输入 reverse 以匹配既有 UX。

- [ ] **Step 3: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/ && git commit -m "[AI交付] 事件列表查看全部/搜索/分页统一组件"
```

---

### Task N10-1: 事件文件滚动清理

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`append_event` 3417、`get_delivery_events` 1447-1454）

**Interfaces:**
- Consumes: `append_event` 每次一文件无上限（3417）；watchdog 巡检事件（6491）长任务累积
- Produces: 每交付保留最近 N 条事件 + 体积上限（默认 1000 条 / 5MB，常量可调）；attempt 运行目录随清理删除

- [ ] **Step 1: 清理常量与逻辑**

`ai_delivery_service.rs` 常量区加：

```rust
pub const MAX_EVENTS_PER_DELIVERY: usize = 1000;      // 每交付保留事件条数上限
pub const MAX_EVENTS_DIR_SIZE: u64 = 5 * 1024 * 1024; // 每交付事件目录体积上限（字节）
```

`append_event` 保存后调用清理（同步简单，每次保存后 prune）：

```rust
fn prune_delivery_events(delivery_id: &str) {
    // 1) 扫描 EVENTS_DIR 下该交付的事件文件（文件名含 delivery_id 前缀或按内容过滤，以既有 get_delivery_events 1447-1454 的读取方式为准）
    // 2) 按 occurred_at 排序，保留最新 MAX_EVENTS_PER_DELIVERY 条，其余删除
    // 3) 若目录总体积 > MAX_EVENTS_DIR_SIZE，继续删最旧直到达标
}
```

- [ ] **Step 2: 接入 append_event（评审修正）**

`append_event`（**3401-3412**，非 3417）在 `Self::save(...)` 后调用 `Self::prune_delivery_events(delivery_id)`。注意性能：每事件 prune 一次 O(N) 扫描，事件量大时可降频（**append_event 现无计数器，需静态原子计数（`static AtomicUsize`）实现「每 50 条 prune 一次」**；prune 本身是全量扫描 EVENTS_DIR，O(N) 可接受）。**评审修正——attempt 运行目录清理与事件 prune 解耦**：事件 prune 只删事件文件；attempt 运行目录改为**按 attempt 终态（cancelled/failed/completed）单独清理**（复用迭代 1 T4-3 的 `terminal_run_dir_by_id` 方式）——否则 attempt 记录仍在、卡片仍展示，用户点「查看成果」时 `read_attempt_output`（1595）读目录失败。

- [ ] **Step 3: get_delivery_events 保持全量**

`get_delivery_events`（1447-1454）**不改**——数据侧已 prune，读取仍全量返回现存文件（N9 前端分页展示）。**注意既有实现按 occurred_at 升序**（N9-1 已同步前端 reverse）。

- [ ] **Step 4: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/services/ai_delivery_service.rs && git commit -m "[AI交付] 事件文件按条数与体积滚动清理"
```

---

### Task N7-2: 合并失败交付终态（mergeFailed）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`merge_delivery_locally_locked_impl` 2224 return Err 处；`try_complete_workflow_delivery` 3358-3399 / `finish_attempt`（2974 起）内自动合并段 ~3146-3191 的 autoMergeFailed 分支 3179-3185/3389-3396）
- Modify: `terminal-buddy/src/components/ai-delivery/workspace-utils.ts`（筛选 81-123）

**Interfaces:**
- Consumes: merge 失败路径（2205-2224）；`delivery.state = "failed"` 无赋值点（仅删除门槛与前端过滤值）；迭代 2 冲突续接-1（blocked 续接入口）
- Produces: `delivery.state = "mergeFailed"`（新 delivery 状态值）在合并失败时置位；前端「失败/合并中/已阻塞」筛选命中

- [ ] **Step 1: 后端置态（评审修正：收口到统一失败出口）**

`merge_delivery_locally_locked_impl`（1999-2247）内有 **10+ 个失败出口**（质量门禁 ~2004-2005 `tasks.is_empty() || any(!=succeeded)`、独立审核未通过 ~2013、缺任务契约 ~2021、集成目标仓库不存在 ~2034、任务分支不在目标分支 ~2139、任务分支不存在 ~2149、TOCTOU 变化 ~2157「任务分支在验收后发生了变化」、回滚段 2224 return Err 等）。原稿只覆盖 2224 + 两个 auto 分支（3179-3185、3389-3396），其余出口漏置则状态卡在 running/awaitingApproval。**收口到 `merge_delivery_locally_locked`（1987-1994）的 `result.is_err()` 统一失败出口置态**（该处已做失败清理，一次覆盖手动/自动/REST 全部入口及上述全部出口；注意其参数是 `&AiDelivery` 无 delivery_id——置态代码用 `&delivery.id`）：

```rust
let mut delivery = Self::get_delivery(&delivery.id)?;
delivery.state = "mergeFailed".to_string();
Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
```

**注意**：`delivery.state` 字符串全集新增 `mergeFailed`；前端 `deliveryStateNames` 与筛选逻辑同步注册（见 Step 2）。

- [ ] **Step 2: 前端筛选与命名（评审修正）**

`workspace-utils.ts`：
- stateNames 注册：`mergeFailed: "合并失败"`（**注意：deliveryStateNames（workspace-utils.ts:81-94）已含 blocked/merging 两项后端从不设置的既有残留**，注册时无需处理它们）。
- **评审修正（原稿对筛选区现状的描述与代码矛盾）**：实际筛选谓词是**纯 `delivery.state` 字符串匹配** `matches: (state) => state === child.id`（workspace-utils.ts:132/135，位于 `deliveryStateFilterById` 的 IIFE 128-138 内），**不是**基于 merge 记录状态的谓词。**正确做法：`deliveryStateFilterGroups`（workspace-utils.ts:104-123）加独立筛选项 `{id: "mergeFailed", title: "合并失败"}` + `deliveryStateNames` 注册即可，无需改谓词实现**。既有「失败/合并中/已阻塞」筛选项保留不动。

- [ ] **Step 3: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/services/ai_delivery_service.rs src/components/ai-delivery/workspace-utils.ts && git commit -m "[AI交付] 合并失败置 mergeFailed 终态并修正前端筛选"
```

---

### Task N6-2: needsInput 重启恢复

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`recover_interrupted_attempts` 1646-1690）

**Interfaces:**
- Consumes: 重启恢复过滤（1649 仅 queued/starting/running）；needsInput attempt 带死 terminal_id；manager attempt 特殊分支（1655-1662，planning/awaitingApproval 时走 `fail_delivery_planning` 回草稿）
- Produces: 重启时 needsInput attempt 标记中断并清理死终端引用；回答决策时自动归档旧 attempt

- [ ] **Step 1: 读恢复函数**

```bash
cd terminal-buddy && sed -n '1646,1695p' src-tauri/src/services/ai_delivery_service.rs
```

确认过滤（1649）与 manager attempt 特殊分支（1655-1662）。

- [ ] **Step 2: needsInput 处理（评审修正）**

过滤条件（1649）扩展：`state ∈ {queued, starting, running, needsInput}`。对 needsInput attempt：

```rust
if attempt.state == "needsInput" {
    // 清理死终端引用（重启后 terminal_id 无效），标记中断供前端展示
    attempt.terminal_id = None;
    attempt.state = "interrupted".to_string();   // 新 attempt 状态值（评审选定此方案，弃「复用 failed」备选）
    Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
    Self::append_event(&delivery_id, Some(&task_node_id), Some(&attempt.id),
                       "attemptInterrupted", "等待决策时应用重启，attempt 已中断")?;
}
```

**评审修正（前端同步，选定 interrupted 后必须做）**：`attemptStateNames`（workspace-utils.ts ~146-153）加 `interrupted: "已中断"`；`isFailedAttemptState`（failed/cancelled/policyViolation）不含它；`filteredAttempts`（910-916）若不处理会把 interrupted 归入「成功」组显示（按状态列映射调整）。

> 注意：任务 state 保持 needsInput 不变。**恢复路径已确认（评审）**：实际恢复函数是 `answer_decision_request`（1523，非 answer_decision），按 **task.state** 判断（1564-1570，needsInput → ready），不涉及 attempt 状态——本改造不影响其恢复；新 attempt 由 ready 派发路径产生。

- [ ] **Step 3: 回答决策归档旧 attempt**

`answer_decision_request`（1523）内：回答时若该任务存在 needsInput/interrupted 旧 attempt，自动归档（置 cancelled 并写 `attemptCancelled` 事件），再走正常派发。

- [ ] **Step 4: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/services/ai_delivery_service.rs && git commit -m "[AI交付] needsInput 重启恢复与旧 attempt 归档"
```

---

### Task N8-2: 已答决策历史视图

**Files:**
- Modify: `terminal-buddy/src/components/ai-delivery/AiDeliveryWorkspace.tsx`（846 行 `filter(r => r.state === "pending")` 旁）

**Interfaces:**
- Consumes: `AiDecisionRequest.answer`（models:466，从不展示）
- Produces: 决策历史列表（问题/选项/回答/时间），只渲染 answered 请求

- [ ] **Step 1: 历史列表**

`AiDeliveryWorkspace.tsx` 决策区（846 行 pending 过滤旁）加：

```tsx
const answeredRequests = decisionRequests.filter((r) => r.state === "answered");
// 渲染：
<div className="ai-decision-history">
  <h4>已答决策历史</h4>
  {answeredRequests.length === 0 && <span className="ai-muted">暂无已答决策</span>}
  {answeredRequests.map((r) => (
    <div key={r.id} className="ai-decision-history-item">
      <div className="ai-decision-question">{r.question}</div>
      <div className="ai-decision-options">{r.options.map((o) => o.label).join(" / ")}</div>
      <div className="ai-decision-answer">回答：{r.answer ?? "（无）"}</div>
      <div className="ai-decision-time">{formatEventTime(r.updatedAt)}</div>
    </div>
  ))}
</div>
```

- [ ] **Step 2: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/AiDeliveryWorkspace.tsx && git commit -m "[AI交付] 已答决策历史视图"
```

---

### Task 统计-1: 交付统计面板

**Files:**
- Create: `terminal-buddy/src/components/ai-delivery/DeliveryStatsPanel.tsx`
- Modify: `terminal-buddy/src/components/ai-delivery/AiDeliveryApp.tsx`（「统计」标签页）或 `AiUsagePanel.tsx` 扩展

**Interfaces:**
- Consumes: deliveries snapshot 列表（含 attempts/summary/agents 维度数据）
- Produces: 五统计项：交付成功率（succeeded 占比）、任务成功率（首次 vs 重试后）、平均执行时长（按 Agent/角色/仓库）、最常见失败原因（summary 聚类）、Agent 调用统计（次数/耗时/成功率）

- [ ] **Step 1: 统计面板（纯前端计算）**

```tsx
import { useMemo } from "react";
import type { AiDelivery } from "../../types/aiDelivery";

interface Props { deliveries: AiDelivery[]; attempts: AiAttempt[]; }  // 评审修正：attempts 从快照传入（AiDelivery 无 attempts 维度）

export function DeliveryStatsPanel({ deliveries }: Props) {
  const stats = useMemo(() => {
    const succeeded = deliveries.filter((d) => d.state === "succeeded" || d.state === "completed").length;
    const successRate = deliveries.length ? (succeeded / deliveries.length * 100).toFixed(1) : "—";
    // 评审修正：AiDelivery 模型无 attempts 维度；attempt 数据来自快照 DeliverySnapshot（handler 14-30 行）的 attempts 数组
    //（AiAttempt 含 startedAt/finishedAt/state/summary/agentId）。统计基于 props.attempts 计算：
    // 任务成功率：按 deliveryId+taskNodeId 分组 attempts——组内第 1 个 attempt 成功 = 首次成功，否则重试后成功
    // 平均执行时长：按 agentId 分组 attempt，finishedAt - startedAt 平均
    // 失败原因聚类：attempt.summary 首行/前 40 字符计数 Top5
    // Agent 调用：按 agentId 统计次数/总耗时/成功率
    return { successRate, /* ... */ };
  }, [deliveries, attempts]);

  return (
    <div className="ai-stats-grid">
      <div className="ai-stat-card"><span>交付成功率</span><strong>{stats.successRate}</strong></div>
      {/* 其余四项同构 */}
    </div>
  );
}
```

- [ ] **Step 2: 接入标签页**

**评审修正**：`AiDeliveryApp.tsx` 无顶部导航（134 行是 `AiDeliveryNav` 侧栏 + `AiDeliveryWorkspace` 主区）——在 `AiDeliveryWorkspace` 内加「统计」视图切换（或主区顶部 tab），渲染 `<DeliveryStatsPanel deliveries={allDeliveries} attempts={allAttempts} />`。数据源：现有 deliveries 列表 + 快照中的 attempts（前端已有全量状态）。

- [ ] **Step 3: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/ && git commit -m "[AI交付] 交付统计面板（成功率/时长/失败聚类/Agent 调用）"
```

---

### Task Diff-1: 增量 Diff 审查（Monaco Diff Editor + 行评论）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（git diff 读取命令）
- Modify: `terminal-buddy/src-tauri/src/models/ai_delivery.rs`（`AiReviewGate.line_comments`）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs` + `lib.rs`（`get_review_diff` / `add_review_line_comment` 命令）
- Create: `terminal-buddy/src/components/ai-delivery/ReviewDiffView.tsx`
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（审批区）

**Interfaces:**
- Consumes: Monaco 已集成（`@monaco-editor/react` ^4.7.0）；reviewGate（AiReviewGate 257-267）
- Produces: `ReviewDiffView` 组件（Monaco Diff Editor 展示 `git diff baseCommit...HEAD`）；行评论数组随 reviewGate 持久化

- [ ] **Step 1: 后端 git diff 命令（评审修正：命令放 commands 层）**

**评审修正**：`#[command]` 不应直接标注在 service 层函数上（既有命令全部是 commands/ai_delivery.rs 薄包装模式）——service 加纯函数，commands 层包装并注册（lib.rs:486 注册区）：

```rust
// service 层（无 #[command]）
pub fn get_review_diff(delivery_id: &str, task_node_id: &str) -> Result<serde_json::Value, String> {
    // 从 delivery/contract 取 base_commit 与 worktree 分支
    // 执行 git diff base...HEAD --stat + --name-only（参照既有 git 命令执行方式）
    // 返回 { base_commit, head_commit, files: [{path, status, additions, deletions}], diffs: [{path, original, modified}] }
}
```

（git 命令执行复用 service 内既有 `Command::new("git")` 模式。**AiReviewGate 真实位置 383-393，非 257-267**（该区间是 UpdateAiDeliveryInput）。）

- [ ] **Step 2: ReviewDiffView 组件**

```tsx
import { useState } from "react";
import { DiffEditor } from "@monaco-editor/react";

interface DiffFile {
  path: string;
  original: string;
  modified: string;
}

interface Props {
  files: DiffFile[];
  comments: Record<string, string[]>;  // lineNo -> comments（随 reviewGate 存储）
  onComment: (path: string, line: number, text: string) => void;
}

export function ReviewDiffView({ files, comments, onComment }: Props) {
  const [active, setActive] = useState(0);
  const file = files[active];
  return (
    <div className="ai-review-diff">
      <div className="ai-review-file-tabs">
        {files.map((f, i) => (
          <button key={f.path} className={i === active ? "active" : ""} onClick={() => setActive(i)}>{f.path}</button>
        ))}
      </div>
      {file && (
        <DiffEditor
          language="plaintext"
          original={file.original}
          modified={file.modified}
          height="400px"
        />
      )}
      {/* 行评论 UI：左侧行号点击添加评论，保存到 reviewGate.lineComments */}
    </div>
  );
}
```

> **数据形态**：后端返回 `original`（`git show base:path`）/`modified`（HEAD 版本）两侧文本，Monaco Diff 直接渲染。

- [ ] **Step 3: 行评论持久化**

`AiReviewGate` 加字段：

```rust
#[serde(default)]
pub line_comments: Vec<serde_json::Value>,  // [{path, line, text, created_at}]，随 reviewGate 保存
```

命令 `add_review_line_comment(gate_id, path, line, text)` 与前端 `onComment` 接线；审批者提交 review 时一并保存（复用既有 review 提交路径）。

- [ ] **Step 4: 接入审批区**

`DeliveryDetail.tsx` 审批区（gate 行 515 附近）加「查看代码变更」按钮 → 打开 `ReviewDiffView`（调 `getReviewDiff(deliveryId, taskNodeId)`，失败显示错误不崩溃）。

- [ ] **Step 5: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ src/components/ai-delivery/ src/services/tauri.ts src/types/aiDelivery.ts && git commit -m "[AI交付] 增量 Diff 审查（Monaco Diff + 行评论持久化）"
```

---

### Task 预设-1: Agent 启动预设管理（CRUD + 派发时应用）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/models/ai_delivery.rs`（`AiStartupPreset` 模型）
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（预设 CRUD + 派发时应用）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs` + `lib.rs`
- Modify: `terminal-buddy/src/components/ai-delivery/ConfigDialog.tsx`（预设管理 UI，697-720 附近）

**Interfaces:**
- Consumes: `AiAgent.startup_preset_name`（models:117-118，前端 ConfigDialog 已可写非 None）；客户端数据 `extra_param_presets`（appStore:1071-1081、AiDeliveryWorkspace.tsx:266 读取）
- Produces: `AiStartupPreset { id, name, prompt_prefix, model_args, context_strategy, updated_at }`；命令 CRUD ×4；**派发时应用**：`start_attempt` 创建 Agent 命令时按 `startup_preset_name` 展开 prompt_prefix/modelArgs/contextStrategy

- [ ] **Step 1: 模型 + CRUD**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStartupPreset {
    pub id: String,
    pub name: String,
    pub prompt_prefix: String,
    pub model_args: Option<serde_json::Value>,   // {temperature, maxTokens, ...}
    pub context_strategy: Option<String>,
    pub updated_at: String,
}
```

service 加 4 个 CRUD 函数（目录 `STARTUP_PRESETS_DIR`，参照既有 CRUD 模式）；命令 `list_ai_startup_presets` / `create_ai_startup_preset` / `update_ai_startup_preset` / `delete_ai_startup_preset` 注册。

- [ ] **Step 2: 派发时应用**

`start_attempt`（创建 Agent 命令处，参照 2639 起 monitor 之前、claude 命令构造处）：按 `agent.startup_preset_name` 查预设，把 `prompt_prefix` 拼入 prompt、`model_args` 注入命令参数、`context_strategy` 影响上下文构造（按实际命令构造代码插入——读 start_attempt 中 Agent 命令字符串拼接处确定插入点）。

```rust
if let Some(preset_name) = &agent.startup_preset_name {
    if let Ok(preset) = Self::get_startup_preset_by_name(preset_name) {
        // prompt 前缀注入 + model_args 合并（以既有命令构造代码为准做最小插入）
    }
}
```

> 客户端数据的 `extra_param_presets`（前端既有，**文件是 `appStore.ts` 非 tsx**，1071-1081）与本后端存储的关系：**本项落后端**（AI 交付侧管理形态），前端 ConfigDialog 预设下拉改为同时支持后端预设（名称一致时优先后端）。**评审修正：前后端预设模型字段不同（前端 `ExtraParamPreset` id/name/params，定义在 `src/types/index.ts:159`（appStore.ts 仅导入，:123 附近是 `initExtraParamPresets` 函数非类型）；后端 `AiStartupPreset` promptPrefix/modelArgs/contextStrategy）——需定义互转规则**（如 params 透传到 modelArgs、promptPrefix 由 params 中对应键映射），旧客户端数据预设保留兼容。派发插入点已确认可行：`start_attempt`（2494）中 agent 已取（2530）、`build_agent_prompt`（2540）后、`prepare_terminal_control`（2545）前。

- [ ] **Step 3: 前端管理 UI**

`ConfigDialog.tsx` 697-720「套用参数预设」下拉扩展：新增「管理预设…」入口（CRUD 对话框：name/promptPrefix/modelArgs/contextStrategy 四字段）。

- [ ] **Step 4: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ src/components/ai-delivery/ConfigDialog.tsx src/services/tauri.ts src/types/aiDelivery.ts && git commit -m "[AI交付] Agent 启动预设后端管理与派发时应用"
```

---

### Task REST-1: 缺失 REST 路由补全（任务编辑/删除/添加 + 交付编辑）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/web/handlers/ai_delivery_handler.rs`
- Modify: `terminal-buddy/src-tauri/src/web/server.rs`（49-96 行区块内追加）

**Interfaces:**
- Consumes: 迭代 1 T4-2 `update_task_node` / T4-3 `delete_task_node`；`create_task_node`（既有）；`update_delivery`（既有，841-870）
- Produces: 4 条新路由：`PUT /api/ai-delivery/deliveries/{id}`（编辑交付）、`PUT /api/ai-delivery/deliveries/{id}/tasks/{task_id}`、`DELETE /api/ai-delivery/deliveries/{id}/tasks/{task_id}`、`POST /api/ai-delivery/deliveries/{id}/tasks`

- [ ] **Step 1: handler 补 4 个函数**

`web/handlers/ai_delivery_handler.rs`（参照既有 handler 风格，如 create_delivery/plan 的实现）：

```rust
// 评审修正：① update_delivery 真实签名是 update_delivery(input)（service:841，无 &id 参数，id 在输入结构里——原稿调用编译失败）；
// ② 四个 handler 必须带 `_claims: ClaimsFromRequest`（认证全在 extractor 层 web/auth.rs:54-71，server.rs 无 middleware——缺则新路由绕过 JWT 认证）
pub async fn update_delivery(State(_state): State<AppState>, _claims: ClaimsFromRequest, Path(id): Path<String>, Json(mut input): Json<UpdateAiDeliveryInput>) -> Result<Json<AiDelivery>, ApiError> {
    input.id = id;
    AiDeliveryService::update_delivery(input).map(Json).map_err(ApiError::BadRequest)
}
pub async fn create_task(State(_state): State<AppState>, _claims: ClaimsFromRequest, Path(id): Path<String>, Json(mut input): Json<CreateAiTaskNodeInput>) -> Result<Json<AiTaskNode>, ApiError> {
    input.delivery_id = id;
    AiDeliveryService::create_task_node(input).map(Json).map_err(ApiError::BadRequest)
}
pub async fn update_task(State(_state): State<AppState>, _claims: ClaimsFromRequest, Path((_id, task_id)): Path<(String, String)>, Json(mut input): Json<UpdateAiTaskNodeInput>) -> Result<Json<AiTaskNode>, ApiError> {
    input.id = task_id;
    AiDeliveryService::update_task_node(input).map(Json).map_err(ApiError::BadRequest)
}
pub async fn delete_task(State(_state): State<AppState>, _claims: ClaimsFromRequest, Path((_id, task_id)): Path<(String, String)>) -> Result<Json<()>, ApiError> {
    AiDeliveryService::delete_task_node(&task_id).map(Json).map_err(ApiError::BadRequest)
}
```

（`UpdateAiDeliveryInput`（models:257）/`CreateAiTaskNodeInput`（models:291）真实存在 ✓，导入路径与既有 handler 一致；`ClaimsFromRequest` 从 web/auth.rs 导入，参数名/顺序与既有 handler（ai_delivery_handler.rs:37-39）保持一致。）

- [ ] **Step 2: server.rs 注册（评审修正：补 put 导入）**

AI 交付区块（49-96）追加：

```rust
.route("/api/ai-delivery/deliveries/{id}", put(handlers::ai_delivery_handler::update_delivery))
.route("/api/ai-delivery/deliveries/{id}/tasks", post(handlers::ai_delivery_handler::create_task))
.route("/api/ai-delivery/deliveries/{id}/tasks/{task_id}", put(handlers::ai_delivery_handler::update_task))
.route("/api/ai-delivery/deliveries/{id}/tasks/{task_id}", delete(handlers::ai_delivery_handler::delete_task))
```

（**评审修正：server.rs 第 2 行现有 `use axum::routing::{delete, get, post};` 缺 `put`——需补入导入**；`delete` 已导入 ✓。）

- [ ] **Step 3: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/web/ && git commit -m "[AI交付] REST 路由补全：交付编辑与任务增删改"
```

---

### Task 工作流预览-1: 工作流步骤预览和测试

**Files:**
- Modify: `terminal-buddy/src/components/ai-delivery/ConfigDialog.tsx`（工作流配置区）
- Modify: `terminal-buddy/src/services/tauri.ts`（`testWorkflowStep` 命令封装）

**Interfaces:**
- Consumes: `AiWorkflow` 模型（steps/roles/qualityGate 配置）；迭代 1 T3-2 `TaskDagView` 组件
- Produces: 配置时可预览预期任务拓扑（复用 TaskDagView 渲染 workflow steps 的模拟任务）；拖拽排序（steps 顺序）；单步模拟测试（用占位任务跑一次 prompt 生成，验证输出）

- [ ] **Step 1: 拓扑预览**

`ConfigDialog.tsx` 工作流配置区加「预览拓扑」按钮 → 把 workflow.steps 映射为模拟 `AiTaskNode[]`（每个 step 一个节点，依赖 = 前一 step），复用 `TaskDagView` 渲染（只读模式）。**评审修正：`AiWorkflow`（162-170）只有 id/name/description/steps/created/updated，无 roles/qualityGate 字段**（roles 是全局表、step 有 role_id（146）；qualityGate 在 AiProject 上）——预览不依赖缺失字段。

- [ ] **Step 2: 拖拽排序**

steps 列表支持 HTML5 拖拽排序（`draggable` + `onDragOver`/`onDrop` 重排），保存时按新顺序写 workflow。

- [ ] **Step 3: 单步模拟测试**

每 step 行加「模拟测试」按钮：用 `{featureName}` 占位替换后的 prompt + 当前默认 Agent 走一次 `claude --print`（复用 start_attempt 的命令构造逻辑，**只调用不落盘**）。**评审修正：lib.rs 343-387 不是命令，是 `TERMINAL_BUDDY_TEST_DISPATCH_TASK_ID` 环境变量启动钩子（343-385）——不可复用**；且 `start_attempt` 有 `delivery.state != "running"` 门槛（2515）会挡模拟测试——后端命令 `test_ai_workflow_step` 需**独立构造 prompt 与调用**（只取 start_attempt 中命令构造段的逻辑，不落盘、不建 attempt）：

```ts
export const testWorkflowStep = (workflowStepId: string, featureName: string) =>
  invoke<string>("test_ai_workflow_step", { workflowStepId, featureName });
```

后端命令：构造 prompt → 调 Agent（`--print`）→ 返回输出前 2000 字符。**标记为实验性**：命令失败仅前端展示错误，不影响既有功能。

- [ ] **Step 4: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/ConfigDialog.tsx src/services/tauri.ts && git commit -m "[AI交付] 工作流拓扑预览/拖拽排序/单步模拟测试"
```

---

### Task N11-1: 规划中断「以当前状态重跑」

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`plan_delivery_with_manager` 979 起、`fail_delivery_planning` 938、`ensure_project_repository_statuses_unchanged` 4499-4518）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs` + `lib.rs`
- Modify: `terminal-buddy/src/components/ai-delivery/`（重跑入口）

**Interfaces:**
- Consumes: 仓库被改动阻断规划（4499-4518，错误文案 4513-4516）→ `fail_delivery_planning`（948 置 drafting）
- Produces: 命令 `replan_delivery_accepting_current_state(delivery_id) -> Result<(), String>`：对比基线 → 采纳当前状态（更新基线快照）→ 从当前状态重新规划（复用既有 plan 路径）

- [ ] **Step 1: 服务层命令**

```rust
/// 仓库被改动时：采纳当前状态为基线，直接重新规划（无需手动清理）
pub fn replan_delivery_accepting_current_state(delivery_id: &str) -> Result<(), String> {
    let delivery = Self::get_delivery(delivery_id)?;
    // 评审修正：基线是内存动态快照非持久化——无「更新基线」步骤（见下方说明）
    // 1) 校验 delivery.state 必须 ∈ {drafting, planning, needsInput}（已回草稿或规划中）
    // 2) 复用 plan 路径重新规划（按 commands 层模式：begin_delivery_planning + spawn_blocking，
    //    参照 plan_ai_delivery_with_manager 与 replan_legacy_delivery（695-739）先例；service 层无 AppHandle 无法直调）
    Self::append_event(delivery_id, None, None, "deliveryReplanned",
                       "已采纳当前仓库状态并重新规划")?;
    // 触发规划
    Ok(())
}
```

> **评审确认（事实答案）**：基线是**内存动态快照，非持久化**——`ensure_project_repository_statuses_unchanged`（4499-4518）的 baseline 是 `plan_delivery_with_manager` 规划前捕获（1002 行 `project_repository_statuses`，4484 行读 HEAD+status），1013 对比后 `?` 传播，commands 层 `plan_ai_delivery_with_manager`（ai_delivery.rs:161 附近）Err 分支已调 `fail_delivery_planning` 置回 drafting（948）。**「更新基线快照」步骤无对象**——本命令简化为：校验 delivery.state ∈ {drafting, planning, needsInput} + 复用 plan 路径（用户重新点「生成任务图」即可重跑）。**service 签名缺 AppHandle/TerminalService，无法直接复用 `plan_delivery_with_manager`（979）**——按 commands 层模式实现（`begin_delivery_planning` + spawn_blocking，参照 `plan_ai_delivery_with_manager` 与既有 `replan_legacy_delivery`（695-739）先例）。实质价值是带「采纳当前状态」确认语义的重跑入口。

- [ ] **Step 2: 命令注册 + 前端入口**

规划失败（事件 managerPlanFailed / 错误提示）时交付卡片显示「对比基线 → 采纳当前状态 → 重新规划」按钮 → 调 `replanDeliveryAcceptingCurrentState`。

- [ ] **Step 3: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ src/components/ai-delivery/ src/services/tauri.ts && git commit -m "[AI交付] 规划中断以当前状态重跑入口"
```

---

## 迭代 3 验证（DoD 源自规范 §5 各节验收标准）

全部任务完成后执行：

- [ ] `cd terminal-buddy && cargo test` — 全通过（含迭代 1 环依赖 3 例 + 既有测试模块）
- [ ] `cd terminal-buddy && cargo check` — 无错误无警告
- [ ] `cd terminal-buddy && npx tsc --noEmit` — 无错误
- [ ] N9：早期事件可访问（查看全部）；标题数字与可见条数一致；搜索/分页可用
- [ ] N10：数据目录不再无限增长；清理后事件列表仍完整可用
- [ ] N7：合并失败交付显示可辨识终态（mergeFailed）；前端「失败/已阻塞」筛选命中
- [ ] N6：重启后 needsInput 任务不再僵尸；回答决策后自动归档旧 attempt 并可正常恢复
- [ ] N8：已答决策在 UI 可见，含答案与时间
- [ ] 统计：五个统计项均有数据展示（成功率/任务成功率/时长/失败聚类/Agent 调用）
- [ ] Diff：审批时可查看代码变更；行评论随 reviewGate 持久化
- [ ] 预设：预设可创建/编辑/删除；Agent 可选预设；派发时应用预设内容
- [ ] REST：REST 覆盖创建/规划/派发/编辑/删除/完成/合并/重试全流程；Web 冒烟通过
- [ ] 工作流预览：配置工作流时可预览任务拓扑；可排序；可单步模拟
- [ ] N11：仓库被改动时无需手动清理，可采纳当前状态继续规划

## 自审记录

- **规范覆盖**：§5.1-5.11 全部有对应任务（统计/Diff/预设/工作流预览/REST/N6/N7/N8/N9/N10/N11）；验收标准全部列入验证清单。
- **无占位符**：所有代码步骤含完整代码块或精确行号锚点 + 读取指令；「参照既有实现」均为可执行的读代码指令（N11-1 基线存储结构、Diff-1 数据形态、预设-1 命令拼接点均注明先读代码确认）。
- **类型一致性**：`mergeFailed` 状态（N7-2 引入 → workspace-utils stateNames/筛选同步；与迭代 2 冲突续接-1 的 blocked 入口互补）；`attemptInterrupted`（N6-2 使用，eventTypeNames 已有 196）；`deliveryReplanned`（N11-1 使用，eventTypeNames 已有 214）；`TaskDagView`（迭代 1 T3-2 定义 → 工作流预览-1 复用）；`update_task_node`/`delete_task_node`（迭代 1 T4-2/T4-3 定义 → REST-1 包装）；`line_comments`（Diff-1 定义 → 命令/前端同步）；`test_ai_workflow_step` 命令（工作流预览-1 定义 → tauri.ts 封装）。
- **已知偏差**：N6-2 的 attempt 中断标记用 `interrupted` 或复用 failed 二选一（实现时按 answer_decision 恢复路径确认）；N11-1 若基线非持久化快照则简化为直接复用 plan 路径。
- **评审修正（2026-08-02 四代理并行审核后修订）**：P1 修正 6 处——REST-1 `update_delivery` 签名（`input.id = id` 后传整体）与 4 handler 补 `_claims: ClaimsFromRequest`（**防 JWT 认证绕过，安全项**）、N7-2 失败出口收口到 `merge_delivery_locally_locked` 统一 `result.is_err()` 出口 + 前端只加 mergeFailed 筛选项（实际谓词是纯 state 匹配）、N9-1 弹窗直接 invoke 全量事件 + 升序 reverse、迭代 1 **T2-3 补入前置依赖**；P2 修正：N6-2 选定 interrupted 并补前端 attemptStateNames 同步（函数名修正为 `answer_decision_request`）、N10-1 运行目录清理与事件 prune 解耦（按 attempt 终态）、N11-1 基线为内存快照 → 简化 + 按 commands 层模式、Diff-1 `#[command]` 移 commands 层（AiReviewGate 行号修正 383-393）、server.rs 补 put 导入、工作流预览-1（AiWorkflow 无 roles/qualityGate、lib.rs 343-387 是环境变量钩子、start_attempt 门槛）、统计-1 从快照 attempts 计算 + AiDeliveryApp 无顶部导航、预设-1 前后端模型互转规则（appStore.ts 文件名）。

---

*行号引用以 `docs/ai-delivery-implementation-plan.md` 核实的 HEAD `ea369ac` 代码为准；实现时如行号漂移，按函数名定位。*
