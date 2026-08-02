# AI 交付 — 迭代 1 实施计划

> 关联文档：[ai-delivery-improvement-plan.md](./ai-delivery-improvement-plan.md)
> 制定日期：2026-08-02（v2 修订：修正 T1 实时方案、T4 编辑状态机、Web 路由注册等疏漏）
> v3 修订（评审后）：T1 数据源统一为 live-output.log（drain 独占消费，消除与事件流的竞态）、进度信号改从 live-output.log 提取；**核实 `started_at` 在置 running 时重打点（2599 行），排队时间并不混入，`actual_started_at` 字段整体移除**；append_event 统一 emit 补齐 AppHandle 方案；T4 补依赖状态重算、修正校验复用冲突、标脏字段与编辑器对齐、编辑时未决 gate/decision 清理；Web 端 PUT/DELETE task_node 移出本轮
> v4 修订（评审后）：T1 落盘的「monitor 独占消费」补后端强约束——`drain_terminal_output` 对 AI 交付终端改为只读（返回缓冲但不消费），既有终端标签页路径（TerminalInstance 无条件 drain）不再破坏 live-output.log；T4 依赖回退明确为**扩展 `refresh_ready_task_nodes`**（现有实现只有单向 promote，无 demote）；「提高 retryCount 重试」修正 `retry_task_node` 的 min(10) 钳制与对应 DoD；环依赖检测补齐 create 路径；DAG 布局缓存改存 localStorage（免新增后端命令）且失效键纳入依赖边；transcript 兜底与 live-output.log 增长补截断方案；Web 新接口隔离策略写明
> v5 修订（全量代码核查后）：**`monitor_attempt_execution` 函数名不存在**，监控逻辑实为 `start_attempt` 内 2639 行起的匿名 `thread::spawn`（300ms peek 循环 2641-2650、transcript 兜底 2651-2657 均属实）；环检测单测「需确认测试设施」已核实为**已有先例**——`ai_delivery_service.rs` 已含 `#[cfg(test)]` 模块 `agent_decision_tests`（5111 行）、`terminal_command_tests`（5992 行）；`create_ai_terminal` 定义于 6210 行（6228 仅为 terminal-created emit 行）；Web 路由注册区段修正为 49-96 行（AI 交付 REST 区块起于 49 行）；`AiAttempt` 措辞修正为「扁平标量字段、无嵌套对象」；Web 端轮询间隔对齐现有 5s（`AiDelivery.tsx:32`）；2.3 补充与既有「打开终端」按钮的入口关系
> v6 修订（按代码核对后）：`select_agent` 行号修正——容量报错在 3271-3286（3229 是函数起始行）；`TerminalInstance.tsx` 实际路径 `src/components/terminal/`（通用终端标签组件，非 AI 专属）；Web SPA 轮询文件实为 `web/src/screens/AiDelivery.tsx`；项目实际 React ^19.2.6 而非 18；任务状态集修正——无 `completed`（成功态为 `succeeded`，另有 `awaitingReview`/`needsInput`），4.3 色表与 5.2 编辑约束同步补全（拒绝 succeeded/awaitingReview、放行 needsInput 且保留其未决 decision request）；`delivery.project.repositories` 改经 `get_project` 解析的措辞；通知函数标题硬编码「AI 交付等待决策」，复用时需加标题参数；monitor 线程实含 exit_marker 退出检测与 review_repair 逻辑；watchdog 已有 `attemptWatchdogCheck` 事件（6491）将并存
> v7 修订（全量代码核查后）：**`retry_task_node` 的 min(10) 钳制（2408）与「编辑任务提高上限再重试」文案（2428-2431）是未提交工作区改动**（`git log -S effective_retry_limit` 无结果，HEAD 仅 1248/3481 两处 `.min(10)`；工作区另有首行 BOM、空白重排与锁 guard 重构未提交）——计划行号与「钳制存在」断言均按当前工作区核验，实施前建议先提交/回退该 diff；**任务状态集补 `policyViolation`**（`finish_attempt` 3073-3074 由 `audit_contract_scope`（2993）越界写入触发，当前无恢复路径）——4.3 色表、5.2 编辑约束、retry 白名单（2404）与 DoD 同步放行；4.2 修正「update_ai_delivery 整对象回传」表述（实为 `UpdateAiDeliveryInput` 定向 patch，841-870）；4.3 色表改述为 DAG 新引入设计（现有前端仅单一 accent 色 `ai-status-chip`，AiDeliveryWorkspace.css:1090）；5.2 第 10 条补 `create_task_contract` 3481 第三处 `.min(10)`（契约字段无逻辑用途）；测试模块行号修正 5111/5992
> 目标：解锁多任务场景下的核心调试与编排体验

---

## 0. 现状调研摘要

| 计划项 | 现状 | 实施起点 |
|--------|------|----------|
| 实时终端 | `read_ai_attempt_output` 已注册；`AttemptOutputDialog` 只能**看静态成果文件**；`attempt.terminal_id` 已有；**transcript.log 由 Agent CLI 一次性落盘，运行中为空，文件轮询不可行**；`terminal_output_{id}` 事件流已就绪 | 事件流增量渲染 + 后端实时落盘 live 输出 |
| 超时配置 | watchdog 已实现（`run_attempt_watchdog`，6257 行）但硬编码 60 分钟；`AiTaskNode` 无 timeout 字段 | 模型加字段 + 软告警事件 + UI 入口 |
| DAG 可视化 | 完全没有；package.json 无 reactflow 依赖 | 全新模块 |
| 任务节点编辑 | 后端无 update/delete 命令；前端无 Editor 组件；`retry_task_node` 错误提示已引导用户「编辑任务提高上限」（该钳制与文案为**未提交工作区改动**，v7 核实） | 全新模块 |

最近三个 commit（6dc1d8e / 3f4cbf6 / 188d531）已完成 watchdog 资源清理与并发锁，本迭代在其上扩展。

---

## 1. 子任务清单

| 编号 | 名称 | 串并行 |
|------|------|--------|
| T1 | 实时终端查看（事件流 + live 输出落盘） | T1/T2 并行 |
| T2 | 超时可配置 + 提前告警（含系统通知补齐） | T1/T2 并行 |
| T3 | DAG 可视化 | T3/T4 并行 |
| T4 | 任务节点手动编辑 | T3/T4 并行 |

> T1/T2 并行；T3/T4 并行，且**须在 T1/T2 完成后启动**（T3 依赖 T1 的事件/落盘机制与 T2 的事件推送，T4 编辑器与 T3 共享入口）。
> 扫描发现的其他改进/新增候选见 [第 9 章](#9-后续迭代候选扫描发现不纳入本迭代)。

---

## 2. 子任务 T1：实时终端查看

### 2.1 关键事实：为什么不能轮询 transcript.log

Agent 调用命令是 `... | Out-File -LiteralPath transcript.log -Encoding UTF8`（`ai_delivery_service.rs:5944/5971`）。`Out-File` 为缓冲写入，`claude --print` 等一次性输出模式在**进程退出前文件基本为空**。轮询 transcript.log 看不到实时输出。

**实时数据源有两个，二选一/叠加：**

1. **PC 端主方案（零延迟）**：订阅 `terminal_output_{terminalId}` Tauri 事件（`attempt.terminal_id` 已存在，`tauri.ts:362` 已有 `onTerminalOutput` 封装，事件通道零后端改动）。
2. **后端实时落盘（Web 端复用 + PC 端兜底）**：monitor 线程（约 2640 行，现每 300ms `peek_terminal_output` 判断终端存活）改为每 300ms `drain` 消费缓冲并**追加写** `live-output.log`（详见 2.2）。Web 端轮询该文件即可，无需事件通道。

### 2.2 后端最小变更

`monitor 线程`（`start_attempt` 内 2639 行起的匿名 `thread::spawn`；核查确认 `monitor_attempt_execution` 函数名不存在，300ms peek 循环 2641-2650 行与 transcript 兜底 2651-2657 行行为均属实；线程实际范围 2639-2766 行，除上述循环外还含 exit_marker 退出检测与 review_repair 修复逻辑——drain 改动落在 2641-2649 内层循环，**勿破坏退出检测与 repair 分支**）追加写 live 输出。**数据源唯一化：monitor 是缓冲的唯一消费方，用 `drain` 独占消费**（不能用 `peek` + 长度增量——PC 端任何一次 `drain_terminal_output` 都会清空缓冲，使长度增量逻辑永久失效，live-output.log 停更；v4 起「唯一消费方」由下方新增的后端豁免保证）：

```rust
// 每 300ms 一次：drain 增量 → 追加 live-output.log（缓冲被消费，无 last_len 竞态，无内存增长）
let output = terminal_service.drain_terminal_output(&terminal_id)?;
if !output.is_empty() {
    fs::OpenOptions::new().append(true).open(run_dir.join("live-output.log"))?
        .write_all(output.as_bytes())?;
}
```

> 注意：monitor 线程原有「结束时用 peek 输出作 transcript 兜底」（2651-2657 行）在改为 drain 后拿到的是空缓冲，**需同步改为：transcript.log 为空时以 live-output.log 尾部兜底**（同一 run_dir 内，attempt 结束时无并发写入；**兜底读取截断为尾部 20k 字符**——v4 明确，原文案「全文兜底」在长任务下会把 MB 级文本带进 finish_attempt 的 stdout/summary/事件消息链）。

**「monitor 独占消费」的后端强约束（v4 新增）**：PC 端既有 `TerminalInstance` 初始化会无条件 `drainTerminalOutput`（`src/components/terminal/TerminalInstance.tsx:1220`——通用终端标签组件，AI 终端与其他终端共用同一初始化路径），且 AI 终端本就通过 `terminal-created`（`create_ai_terminal` 定义于 6210 行，emit 在 6228 行）进入标签栏——用户点开标签即触发 drain，monitor 两次 300ms drain 之间的输出会被抢走，live-output.log 静默缺块。仅靠「新弹窗不 drain」的前端纪律不闭环。v4 改为后端豁免：

- `TerminalInstance` 结构新增 `ai_delivery: bool` 标记（`create_ai_terminal` 创建时置位）
- `drain_terminal_output`（`terminal.rs:862`）对 `ai_delivery` 终端**只返回当前缓冲、不消费**（行为等价 peek），其余终端行为不变

由此既有标签页路径的 drain 调用天然无害（拿到的正是剩余缓冲快照，历史回放照常），monitor 线程成为事实唯一消费方；新增 `AttemptLiveTerminalDialog` 仍按 2.3 纪律不调 drain，双保险。

`models/ai_delivery.rs` 在 `AiAttemptOutput` 增字段：

```rust
pub struct AiAttemptOutput {
    // 已有字段...
    pub is_live: bool,            // attempt.state == "running"
    pub live_output_tail: String, // live-output.log 尾部（最多 8000 字符），Web 端轮询用
}
```

`read_attempt_output`（1575 行）末尾补：读 attempt JSON 判断 state；读 live-output.log 尾部。**不做文件 mtime 字段**——PC 端事件流天然增量，Web 端轮询全量渲染即可。

**已核实（v3）：`AiAttempt.started_at` 无需新增 `actual_started_at` 字段**。`started_at` 虽然在建 attempt（queued）时打点（2378 行），但 `start_attempt` 在创建终端成功后、置 running 时**重新打点**（2599 行；全库另有 manager/reviewer attempt 直接以 running 创建（914/1812 行），不 spawn watchdog、不受影响），故运行中任务 attempt 的 started_at 就是实际开始时刻，排队时间并未混入，watchdog（6280 行）从它起算超时准确。原计划中的 `actual_started_at` 字段、前端时长口径、watchdog 起算点改动均为**无收益改动，已整体移除**。

### 2.3 PC 端实时查看

新建 `src/components/ai-delivery/AttemptLiveTerminalDialog.tsx`：

1. **打开弹窗**：**先注册 `listen(terminal_output_{terminalId}, cb)`，再** `readAiAttemptOutput` 取 `liveOutputTail` 作为历史一次性写入 xterm——**不要 `drainTerminalOutput`**（缓冲由 monitor 线程独占消费；2.2 的后端豁免是兜底防线，前端仍不主动 drain）。监听注册早于读历史：**无丢失窗口**；历史与事件流之间**可能有毫秒级重复**（v4 修正原「无重复」断言）——listener 注册后、tail 读取前这一小段被 monitor drain 进日志的块，其事件（reader 线程在推缓冲的同时已 emit，`terminal.rs:390`）与 tail 会各显示一次。窗口极小、不产生缺失，明确不做去重
2. `listen(terminal_output_{terminalId}, cb)` 增量写入 xterm（**非轮询**，事件流零延迟）
3. 关闭弹窗 / attempt 离开 running 时 `unlisten()`
4. attempt 结束后（4 秒轮询里状态翻转或按钮消失时）补拉一次 `readAiAttemptOutput`，显示 final-message 收尾
5. 元信息区：attempt.state、运行时长（基于 `startedAt`，即 `start_attempt` 置 running 时打点，不含排队时间）、进度信号（正则从 **live-output.log** 提取 `<step>...</step>`——运行中 transcript.log 为空，不能从 transcript 提取）

修改 `DeliveryDetail.tsx`：
- attempt 卡片新增**「查看实时终端」**按钮（`attempt.state === 'running'` 时显示，判断直接来自已有 attempts 数据，无需 is_live）；注意运行中 attempt 卡片**已有「打开终端」按钮**（`DeliveryDetail.tsx:671-679`，派发 `open-ai-attempt-terminal` 跳转全局终端标签栏）——新按钮定位是弹窗实时查看，两者入口并存，文案与图标需区分（建议「实时终端」vs 既有「打开终端」）
- 已完成 attempt 仍走现有 `AttemptOutputDialog`

### 2.4 Web API 兼容

- `web/handlers/ai_delivery_handler.rs` 暴露 `GET /api/attempts/:id/output`（复用 `read_attempt_output`）
- **必须同步在 `web/server.rs` 注册路由**（AI 交付 REST 区块 49-96 行内追加，路由链整体 33-119 行；遗漏即 404）
- Web 端每 5 秒轮询该接口（与现有 `web/src/screens/AiDelivery.tsx:32` 的 snapshot 轮询节奏一致），渲染 `liveOutputTail`（Web 端没有事件通道，接受轮询延迟）
- **隔离策略（v4 明确）**：AI 交付数据本就通过 deliveries/snapshot 等 REST 接口对 Web 端可见，不随 `web_api_share_sessions` 的终端级隔离走；本接口与之一致，复用既有 JWT 鉴权即可，不再额外套用 ws.rs 的共享会话隔离

---

## 3. 子任务 T2：超时可配置 + 提前告警

### 3.1 数据模型

`models/ai_delivery.rs`：

```rust
pub struct AiTaskNode {
    // 已有字段...
    pub timeout_seconds: Option<u32>,  // None 时使用 Agent/AiAgent 默认值
}

pub struct AiAgent {
    // 已有字段...
    pub default_timeout_seconds: Option<u32>,  // 兜底默认值
}
```

常量定义在 `services/ai_delivery_service.rs`：

```rust
pub const DEFAULT_ATTEMPT_TIMEOUT_SECONDS: u32 = 60 * 60;  // 当前 60min 硬编码值
pub const TIMEOUT_WARNING_RATIO: f32 = 0.8;                 // 80% 时告警
```

### 3.2 后端逻辑

修改 `run_attempt_watchdog`（6257 行）。**注意 `AiAttempt` 只有 `task_node_id` / `agent_id` 等扁平标量字段（另有 contract_id、runtime_id、terminal_id 等），没有嵌套对象**，超时需要显式加载（在 spawn 时快照一次，不放在循环内）：

```rust
// watchdog spawn 时快照超时值（attempt running 期间 T4 禁止编辑任务，快照与运行态天然一致；
// failed/rework 编辑发生在 attempt 结束后、watchdog 已退出，同样不冲突）
let timeout = Self::get_task_node(&attempt.task_node_id)
    .ok()
    .and_then(|task| task.timeout_seconds)
    .or_else(|| {
        Self::get::<AiAgent>(AGENTS_DIR, &attempt.agent_id, "Agent 超时默认").ok()
            .and_then(|agent| agent.default_timeout_seconds)
    })
    .unwrap_or(DEFAULT_ATTEMPT_TIMEOUT_SECONDS);
let warning_at = Duration::from_secs_f32(timeout as f32 * TIMEOUT_WARNING_RATIO);
let mut warning_emitted = false;

loop {
    sleep(interval).await;
    // 起算点：attempt.started_at（start_attempt 置 running 时重打点，即实际开始时刻，排队时间不计入）
    let Ok(started) = chrono::DateTime::parse_from_rfc3339(&attempt.started_at) else { break };
    let elapsed = chrono::Utc::now().signed_duration_since(started.with_timezone(&chrono::Utc));
    if elapsed >= warning_at && !warning_emitted {
        append_event(&delivery_id, Some(&task_node_id), Some(&attempt.id),
                     "approachingTimeout",
                     &format!("已耗时 {}s，预计 {}s 后超时", elapsed.num_seconds(), timeout))?;
        warning_emitted = true;
    }
    if elapsed.num_seconds() > timeout as i64 {
        fail_attempt_from_watchdog(...);
        break;
    }
}
```

**事件推送**：`append_event`（3401 行）目前只写文件、无 AppHandle，`emit("ai-delivery-event")` 分散在 **12 处调用点**（1861/1877/2614/2893/2924/2965/3125/3140/3164/6417/6699/7264 行）。本次统一收口，需两步：
1. **引入全局 AppHandle**：`static APP_HANDLE: OnceLock<AppHandle>`，在 `lib.rs` setup 中注入（全库当前无任何全局 AppHandle 模式，这是新增基础设施）；`append_event` 末尾从全局读取并 `emit("ai-delivery-event", event)`
2. **删除上述 12 处调用点各自的 emit**（已逐一核实，各点均为直接 emit `append_event` 的返回值，删除安全；其中 6417/6699/7264 为 watch/通知路径，同样直接 emit 返回值）

`approachingTimeout` 由此自动实时送达。前端已有 4 秒轮询兜底（`AiDeliveryWorkspace.tsx:385`），双保险。注意 watchdog 现有检查点已发 `attemptWatchdogCheck` 事件（6491 行，v6 核实），两者将并存于事件列表（一个周期心跳、一个一次性告警）。

**告警文案**：watchdog 节奏为 spawn 后 30 秒 + 每 60 秒检查一次（6264/6317 行），「预计 X 秒后超时」按检查点取整描述（实际偏差 ±60 秒，且首个检查点距运行开始约 90 秒）。

**系统通知补齐（扫描发现）**：目前 `show_ai_delivery_notification` 只有 2 处调用（决策创建 `commands/ai_delivery.rs:263`、`attemptAwaitingDecision` `ai_delivery_service.rs:2966`）。本次补齐关键节点的系统托盘通知，复用现有 `show_ai_delivery_notification` 与「点击通知跳转交付」（`notification.rs:111` 已有 `ai-delivery-notification-activated`）：
- `fail_attempt_from_watchdog`（超时 / 终端结束 / 自动完成失败）
- `complete_attempt` 交付整体收尾（completed / succeeded）
- `merge_delivery_locally` 合并成功或冲突失败
- 通知正文带 deliveryId 与任务标题，便于点击直达。**注意（v6 核实）**：`show_ai_delivery_notification` 标题硬编码「AI 交付等待决策」（notification.rs 91-116，无 title 参数，正文即 question 参数）——直接复用到超时/完成/合并场景会显示误导性标题，需为该函数加 title 参数或按场景定制正文

### 3.3 前端 UI

`TaskDeliveryDialogs.tsx` 的 `TaskCreateDialog` / `TaskNodeEditor`（T4 新建）增字段：
- 「超时时间（分钟）」输入框，默认留空（= 使用 Agent 默认）
- 提示文案**动态显示**当前 Agent 默认值（从 `getAiAgents` 列表取 `defaultTimeoutSeconds`，缺省时显示「60 分钟」），不要硬编码：「留空使用 Agent 默认（X 分钟），设置范围 5-480」

**Agent 默认值配置入口**：`ConfigDialog.tsx` 的 Agent 配置区新增「默认超时（分钟）」输入（`saveAgentConfig` 的 patch 增加 `defaultTimeoutSeconds`，`AiDeliveryWorkspace.tsx:1155` 已支持任意字段透传）。**没有这个入口，AiAgent 字段就永远为空，T2 的"Agent 默认"落空**。

`AiDeliveryEvent` 列表（DeliveryDetail 事件 tab）新增事件类型 `approachingTimeout`：黄色提示带「查看详情」按钮。

### 3.4 命令

**不需要新增** `get_ai_default_timeout_seconds`：Agent 列表加载后自带 `defaultTimeoutSeconds`，前端直接取；全局兜底常量前端也可先写 3600 仅作显示占位。避免多一个命令 + 一个容易误导的「全局 vs Agent」概念。

---

## 4. 子任务 T3：DAG 可视化（与 T4 并行）

### 4.1 依赖安装

```bash
cd terminal-buddy
npm install @xyflow/react@^12  # reactflow v12 是当前主线，兼容 React 18/19（项目当前为 React ^19.2.6，v6 核实）
```

> **不要装旧版 `reactflow`**，已被 `@xyflow/react` 取代。

### 4.2 数据准备层

新建 `src/components/ai-delivery/utils/taskGraphLayout.ts`：
- 输入：`AiTaskNode[]`
- 输出：`{ nodes: Node[], edges: Edge[] }`
- 布局算法：**简化 Kahn 拓扑分层**（不需要 dagre），同层垂直顺序按 title 字母序
  - 计算每节点的 max(父节点层) + 1
  - 横向 240px 间距，纵向 120px 间距
- **布局缓存存 localStorage**（key `ai-delivery-graph-layout:v1:{deliveryId}`，v4 修改）——**不塞进 `AiDelivery` 模型**（v7 修正原「整对象回传」表述：`update_delivery`（841-870 行）实为 `UpdateAiDeliveryInput` 定向 patch，真正的整对象回传是 `update_ai_project`/`save_ai_agent` 一类——无论哪种，`AiDelivery` 是快照载荷与读写共用模型，塞布局字段仍会污染模型与所有消费方）；也不落数据目录文件（Tauri 前端读写数据目录需新增后端命令 + 文件清理规则，为纯展示态缓存不值当，6.1/6.2 因此不必新增命令）
- **缓存失效**：缓存内记录 `layoutVersion` = **节点 id 集合 + 依赖边集合（按 id 对排序后拼接）的短 hash**（v4 修正：原「仅节点 id」在 T4 编辑 dependencyIds 后拓扑分层应变化但版本不变，会复用陈旧布局），节点增删**与依赖增删**均触发重算
- **节点默认禁拖拽**（`nodeDraggable={false}`）：布局完全由算法 + 缓存决定，避免用户拖拽位置与缓存/重算互相冲掉；若后续需要手动布局再扩展持久化方案

### 4.3 DAG 组件

新建 `src/components/ai-delivery/TaskDagView.tsx`：
- 用 `<ReactFlow>` + `<Background>` + `<Controls>` + `<MiniMap>`
- 自定义节点 `TaskNodeCard.tsx`：显示 title / state / 角色徽标 / 进度点
- 状态色（v7 改述：现有前端仅单一 accent 色 `ai-status-chip`（AiDeliveryWorkspace.css:1090-1098），本表为 DAG 视图**新引入**的按状态配色，非沿用既有样式）：
  ```ts
  // v7 核实：任务实际状态全集——无 "completed"（成功态为 "succeeded"），另有 awaitingReview/needsInput/policyViolation
  const STATE_COLORS = {
    planned:        '#94a3b8',  // slate-400
    ready:          '#3b82f6',  // blue-500
    queued:         '#60a5fa',  // blue-400
    running:        '#eab308',  // yellow-500 + 脉冲动画
    succeeded:      '#22c55e',  // green-500
    failed:         '#ef4444',  // red-500
    policyViolation: '#dc2626', // red-600（越界写入/策略违规）
    rework:         '#f97316',  // orange-500
    cancelled:      '#64748b',  // slate-500
    awaitingReview: '#06b6d4',  // cyan-500（质量门禁审查中）
    needsInput:     '#a855f7',  // purple-500（等待决策输入）
  };
  ```
- 分组折叠：节点可右键 → 「折叠同 workflowStep」 / 「折叠同仓库」
- 节点点击 → 弹出右侧详情抽屉（**这是 T4 编辑器的入口**）
- 数据刷新复用 Workspace 层现有 4 秒轮询（`refreshLiveDelivery`），不需要独立刷新

### 4.4 切换入口

`DeliveryDetail.tsx`：
- 顶部 Tab 切换 `列表视图` ↔ `DAG 视图`
- 默认仍是列表（兼容性），DAG 节点数 > 5 时提示「建议切换 DAG 视图」徽章

### 4.5 性能预算

- 节点数 ≤ 50：直接渲染
- 节点数 > 50：自动启用紧凑模式（节点卡片收起为小圆点仅显示状态色，详情按需点击展开；MiniMap 维持常态）
- 用 `useMemo` 缓存 layout 计算结果

---

## 5. 子任务 T4：任务节点手动编辑（与 T3 并行）

### 5.1 后端命令

`commands/ai_delivery.rs` 新增：

```rust
#[command]
pub fn update_ai_task_node(input: UpdateAiTaskNodeInput) -> Result<AiTaskNode, String> {
    AiDeliveryService::update_task_node(input)
}

#[command]
pub fn delete_ai_task_node(task_node_id: String) -> Result<(), String> {
    AiDeliveryService::delete_task_node(&task_node_id)
}
```

`models/ai_delivery.rs` 新增：

```rust
pub struct UpdateAiTaskNodeInput {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub role_id: Option<Option<String>>,           // 双 Option = 区分 "未提供" 和 "设为空"
    pub preferred_agent_id: Option<Option<String>>,
    pub task_prompt: Option<String>,
    pub execution_mode: Option<String>,            // 与前端编辑器字段一一对应（v3 补齐）
    pub execution_context: Option<String>,
    pub target_repository_id: Option<String>,
    pub allowed_write_paths: Option<Vec<String>>,
    pub dependency_ids: Option<Vec<String>>,
    pub expected_artifacts: Option<Vec<String>>,
    pub acceptance_commands: Option<Vec<String>>,
    pub timeout_seconds: Option<Option<u32>>,       // 同上
    pub retry_count: Option<u32>,                    // 0 = 不限；允许 >10（见 5.2 第 10 条与 retry_task_node 钳制调整）
}
```

> 字段表与 5.3 编辑器字段分区必须一一对应（inputArtifacts / workflowStepId 前端不编辑，不在此处暴露，避免输入字段与 UI 再次不一致）。

### 5.2 服务层逻辑

**编辑状态约束（修正版）**——`update_task_node`：

1. 加载 task_node 与所属 delivery
2. 状态校验（**task 状态**，不是 delivery 状态）：
   - task.state ∈ {planned} → 任意字段可编辑
   - task.state ∈ {failed, rework, cancelled, needsInput, policyViolation} 且 delivery.state ∈ {running, paused, needsInput} → 可编辑（**这是 retry 场景的核心诉求**：`retry_task_node`（2402 行）的错误提示明确引导用户「编辑任务提高上限再重试」，禁止运行中编辑 = 现有提示是死路；needsInput 任务尚未实际执行，等待决策输入期间编辑安全，且第 6 条的未决 gate/decision 清理正是为其服务；**policyViolation（v7 补全）**：`finish_attempt` 3073-3074 由 `audit_contract_scope`（2993）越界写入触发，与 failed 同等对待——当前该状态无任何恢复路径（`retry_task_node` 2404 白名单不含，任务永久卡死），放行编辑并同步放行重试（第 10 条）正是补死路）
   - task.state ∈ {queued, running, succeeded, awaitingReview} → 拒绝（queued/running 执行中；succeeded 已完成，编辑会造成状态倒挂；awaitingReview 质量门禁审查中，改执行参数会使审查基于旧 contract）
   - 说明：delivery 状态机是 drafting/planning/awaitingApproval/running/paused/cancelled/needsInput/completed/succeeded/failed，**不存在 "planned" 状态**（planned 是 task 的状态；`delivery.state = "failed"` 目前代码无赋值点，仅作过滤值保留，v6 核实）
3. **校验复用 `create_task_node`（1176-1229 行）的既有约束**，不要另写一套。**注意必须排除其中的 delivery 状态校验（1202-1207 行，仅允许 planning/drafting/awaitingApproval）**——否则 running 交付中的编辑会被自己复用的校验拒绝，本任务的核心场景直接失效；编辑场景的交付状态约束统一由第 2 条负责：
   - title/description 非空（1177-1179，v4 补齐，原清单遗漏）
   - executionMode ∈ {write, readonly}、write 任务必须 taskWorktree 上下文（1180-1187）
   - workflowStepId 非空时必须有 expectedArtifacts（1188-1195）
   - validate_artifact_paths / validate_write_paths
   - **role_id 与 preferred_agent_id 至少一个存在（1198-1200，v4 补齐）**——编辑器允许清空单个，但两者全空则任务不可派发（`select_agent` 3247 行直接报错），必须拒绝
   - targetRepositoryId 属于 delivery.project_id 对应项目的 repositories（模型无嵌套 project 对象，经 `get_project` 解析，v6 核实）且 write_enabled（1208-1216）
   - role_id / preferred_agent_id 存在性（1218-1223）
   - dependency_ids 都属于当前交付（1224-1229）
4. **环依赖校验**：DFS 检测新 dependency_ids 是否形成环（自环、间接环）。**检测逻辑提取为独立 helper，`create_task_node`（1224-1229 行后）同样接入**（v4 明确——现有 create 只校验成员关系，先建 A 依赖 B、再建 B 依赖 A 即可绕过 create 直接成环，交付永久卡在 planned；DoD「环依赖检测阻止保存」须覆盖两路径）
5. **已有 contract 的任务编辑执行相关字段**（executionMode / executionContext / targetRepositoryId / taskPrompt / allowedWritePaths / expectedArtifacts / acceptanceCommands / timeoutSeconds——列表与 5.3 编辑器「执行参数/目标仓库/产物验收/运行时」分区一一对应，**只改 title/description/roleId/依赖关系等不标脏**）：标脏 contract（新增 `AiTaskContract.dirty: bool` 字段，serde default false）→ 重试派发时重新审计 / 重建 contract，保证旧 worktree 的审计结果不被错误复用
6. **未决 gate/decision 清理**：编辑后删除该任务下**未决**的 review gate 与 decision request（`AiReviewGate.task_node_id` / `AiDecisionRequest.task_node_id` 引用，复用 delete 的清理逻辑；已完成的历史文件保留留痕），避免重试时旧审核/旧决策残留。**例外（v6 核实）**：task.state == needsInput 时**保留**其未决 decision request——该请求是任务恢复（answer_decision）的入口，删除后任务将永久卡在 needsInput；needsInput 任务编辑仅清理未决 review gate
7. **依赖变更后状态重算**：dependencyIds 被修改时重算受影响任务状态。**v4 修正：现有 `refresh_ready_task_nodes`（1415-1445 行）只有单向 promote（planned + 依赖全 succeeded → ready），没有回退逻辑，原计划「调用 refresh 即可回退」不成立**。需扩展该函数支持：
   - promote 保持现状（planned → ready）
   - **新增 demote**：state == ready 且依赖不全部 succeeded（含依赖已删除 / 依赖状态为 failed/rework/cancelled/planned）→ 回退 planned
   删除/编辑依赖后调用扩展后的函数，与 DAG 视图/列表视图保持一致（DoD 对应验收项依赖此扩展，6.2 改动清单已同步）
8. 写入 JSON 文件
9. `append_event("taskNodeEdited", ...)` 记录变更前后差异（diff 字符串）
10. **retry_count 语义（v4 明确）**：create 侧保留 `.min(10)`（1248 行），update 侧允许 0-50（0 = 不限）；**同步调整 `retry_task_node`（2408 行）去掉 `effective_retry_limit = task.retry_count.min(10)` 钳制**、直接使用 `task.retry_count`——否则「编辑提高上限再重试」在 10 次用尽后无效（10→20 时 effective 仍为 10，依旧拒绝），T4 核心场景变成只有设 0 才能解锁；重试耗尽的 worktree 清理（2412-2427 行）已存在，放开钳制无资源泄漏风险。**v7 核实**：该钳制与「编辑提高上限」文案（2428-2431）为**未提交工作区改动**（`git log -S effective_retry_limit` 无结果，HEAD 仅 1248/3481 两处 `.min(10)`），实施前建议先提交/回退工作区 diff（含首行 BOM、空白重排与锁 guard 重构）；**`create_task_contract` 3481 行存在第三处 `.min(10)`**——重试上限判定只用 `task.retry_count`、契约内该值无逻辑用途，可一并去掉或保留并注明无害；**`retry_task_node` 状态白名单（2404 行）同步扩为 `failed|rework|cancelled|policyViolation`**——`build_continuation_context`（6779 行）已将其 attempt 视为失败态参与续接，语义一致

`AiDeliveryService::delete_task_node`：

1. 状态约束同上（planned / failed / rework / cancelled 可删；queued/running 拒绝）
2. 级联清理**完整清单**（不只是 contract + attempt）：
   - contract 文件（如有）
   - attempt 文件 + 其运行目录（`terminal_run_dir_by_id`，兼容「纯 UUID」与「label__UUID」两种目录命名，同 `read_attempt_output` 1577-1578 行的处理）
   - **review gate 文件**（`AiReviewGate.task_node_id` 引用，`REVIEW_GATES_DIR`）
   - **decision request 文件**（`AiDecisionRequest.task_node_id` 引用）
   - `delivery.task_node_ids` 数组中移除该 id
3. 若其他 task_node 的 dependencyIds 引用了它，自动移除（不是直接报冲突），并调用**扩展后的** `refresh_ready_task_nodes`（v4：含 demote 回退）重算受影响任务状态（依赖被删后：满足条件的任务 promote 进入 ready，已 ready 的下游因依赖失效 demote 回退 planned）
4. `append_event("taskNodeDeleted", ...)`

### 5.3 前端编辑器

新建 `src/components/ai-delivery/TaskNodeEditor.tsx`（约 500 行）：

布局：左侧字段表单（与 `TaskCreateDialog` 一致），右侧实时预览。

字段分区：
- **基础**：title、description、roleId、preferredAgentId
- **执行参数**：taskPrompt（Monaco 编辑器，markdown）、executionMode、executionContext
- **目标仓库与权限**：targetRepositoryId（Select）、allowedWritePaths（多行 + 通配符提示）
- **依赖关系**：dependencyIds（多选 combobox，依赖循环时红框警告）
- **产物与验收**：expectedArtifacts、acceptanceCommands
- **运行时**：timeoutSeconds（数字输入，留空=默认）、retryCount

底部：
- 「保存」按钮（disabled 当 dependencyIds 形成环或必填字段缺失）
- 「删除此任务」次级按钮（带确认弹窗，弹窗内说明级联清理范围）

### 5.4 接入点

- DAG 视图节点点击 → 右侧抽屉 → 编辑（**T3 与 T4 的交汇点**）
- 列表视图卡片操作菜单增 `编辑任务` 项
- T2 的 `TaskCreateDialog` 抽出共用的 `TaskNodeFields` 组件，避免 `TaskCreateDialog` 和 `TaskNodeEditor` 重复实现

### 5.5 审计事件展示

`AiDeliveryEvent` 列表新增两种事件卡片：
- `taskNodeEdited`：显示 diff（"title: 'A' → 'B'"）
- `taskNodeDeleted`：灰底带删除线

---

## 6. 完整文件改动清单

### 6.1 新增

| 文件 | 用途 |
|------|------|
| `src/components/ai-delivery/TaskDagView.tsx` | DAG 视图容器 |
| `src/components/ai-delivery/TaskNodeCard.tsx` | 自定义 ReactFlow 节点 |
| `src/components/ai-delivery/TaskNodeEditor.tsx` | 任务节点编辑抽屉 |
| `src/components/ai-delivery/AttemptLiveTerminalDialog.tsx` | 实时终端查看 |
| `src/components/ai-delivery/utils/taskGraphLayout.ts` | 拓扑分层布局算法 + 缓存 |
| `src/components/ai-delivery/utils/taskNodeDiff.ts` | 审计事件 diff 渲染 |

### 6.2 修改

| 文件 | 改动 |
|------|------|
| `src-tauri/src/models/ai_delivery.rs` | `AiTaskNode.timeoutSeconds`、`AiAgent.defaultTimeoutSeconds`、`AiTaskContract.dirty`、`AiAttemptOutput.isLive/liveOutputTail`、`UpdateAiTaskNodeInput` |
| `src-tauri/src/commands/ai_delivery.rs` | 新增 `update_ai_task_node`、`delete_ai_task_node`（**不新增** `get_ai_default_timeout_seconds`） |
| `src-tauri/src/services/ai_delivery_service.rs` | monitor 线程 `drain` 增量追加写 live-output.log（结束时 transcript 为空改以 live-output.log **尾部 20k 字符**兜底）；watchdog 接入 timeout（spawn 时快照 task/agent 超时值，起算点维持 `started_at`）+ approachingTimeout 事件；全局 `APP_HANDLE: OnceLock<AppHandle>` 注入 + `append_event` 统一 emit + 清理 12 处重复 emit；关键节点系统通知；**扩展 `refresh_ready_task_nodes` 支持 ready→planned 回退（demote）**；**`create_task_node` 与 `update_task_node` 共用环依赖检测 helper**；**`retry_task_node` 去掉 min(10) 钳制 + 状态白名单放行 policyViolation**；新增 `update_task_node`、`delete_task_node`（含依赖变更后状态重算）；`#[cfg(test)]` 环依赖检测单测 3 例（自环/间接环/复杂环） |
| `src-tauri/src/commands/terminal.rs` | `TerminalInstance` 新增 `ai_delivery` 标记（`create_ai_terminal` 置位）；`drain_terminal_output` 对 ai_delivery 终端只读（返回缓冲、不消费），其余行为不变——既有标签页路径的 drain 不再破坏 live-output.log |
| `src-tauri/src/web/handlers/ai_delivery_handler.rs` | 仅暴露 GET live output（**本轮不做 task_node 的 PUT/DELETE Web API**，PC 端优先，后续迭代补齐） |
| **`src-tauri/src/web/server.rs`** | **注册 GET output 新路由（AI 交付 REST 区块 49-96 行内追加，遗漏即 404）** |
| `src/services/tauri.ts` | 新增 TS 命令封装 |
| `src/types/aiDelivery.ts` | 类型同步 |
| `src/components/ai-delivery/DeliveryDetail.tsx` | 接入 DAG 视图切换 + 编辑入口 + 实时终端按钮 |
| `src/components/ai-delivery/TaskDeliveryDialogs.tsx` | 抽出 `TaskNodeFields` 共用组件 |
| `src/components/ai-delivery/ConfigDialog.tsx` | Agent 配置区新增 `defaultTimeoutSeconds` 输入 |
| `src/components/ai-delivery/AiDeliveryWorkspace.tsx` | 事件列表渲染 taskNodeEdited/Deleted |
| **`src/components/ai-delivery/workspace-utils.ts`** | `eventTypeNames` 注册 `approachingTimeout` / `taskNodeEdited` / `taskNodeDeleted` 中文名（不注册则事件列表显示原始英文串） |
| `package.json` | 新增 `@xyflow/react` |

### 6.3 不用动

- `AttemptOutputDialog`（静态成果查看，继续保留）
- watchdog 整体结构（只调整超时计算、告警节点与加载逻辑）
- `read_attempt_output` 主体逻辑（只在末尾补 is_live / live_output_tail）

---

## 7. 关键风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| DAG 节点 > 50 时性能 | 中 | 强制缩略图模式 + 折叠分组 |
| `dependencyIds` 环检测算法 bug | 中（破坏整个交付） | 写 3 个单元测试：自环、间接环、复杂环（V 形 + 分叉），落位 `ai_delivery_service.rs` 内 `#[cfg(test)]` 模块，DoD 以 `cargo test` 通过为准（**已有先例**：该文件已含 `agent_decision_tests`（5111 行）、`terminal_command_tests`（5992 行）两个测试模块，测试设施可在 tauri 环境下独立编译运行） |
| 编辑后 contract 与 attempt 状态不一致 | 高 | 运行中（queued/running）任务禁止编辑；failed/rework 编辑执行相关字段后标脏 contract，重试时重新审计/重建；**同步清理该任务未决的 review gate / decision request**；diff 事件留痕 |
| 运行中编辑被禁 → 「编辑提高重试上限」提示失效 | 高 | 5.2 状态约束已放行 failed/rework/cancelled 编辑，本风险消除；DoD 增加对应验收项 |
| 实时输出落盘 IO | 低 | monitor `drain` 独占消费 + 增量追加（每次 300ms 一个输出块），PC 端主走事件流，文件仅兜底；**前端 drain 竞态由后端豁免消除（`drain_terminal_output` 对 AI 终端只读）**；历史与事件流交接无丢失（有毫秒级重复，已接受） |
| 依赖增删后下游状态陈旧 | 中 | update/delete 后统一调用**扩展后的 `refresh_ready_task_nodes`**（含 demote 回退）重算；DoD 加对应验收项 |
| live-output.log 无限增长 | 低 | **写入侧截断：文件超过 5MB 时保留尾部一半再续写**（读取侧维持 8000 字符尾部；原「复用 8000 截断」是读取端行为，不解决写入增长，v4 修正）；attempt 清理时随目录删除 |
| xterm.js 与现有 CSS 主题不一致 | 低 | 复用 `data-theme` 属性，已在 terminal 组件用过 |
| 新 Web 路由未注册 → 404 | 低 | server.rs 列入改动清单并在 DoD 加 Web 冒烟项 |
| 工作区未提交改动漂移（v7 新增） | 中 | 计划行号与「retry 钳制存在」断言基于未提交工作区（含首行 BOM、空白重排与锁 guard 重构，`git diff -w` 后真实变更仅 49+/47-）；实施前先提交或回退该 diff，避免在漂移状态上叠加改动 |

---

## 8. 完成定义（DoD）

- [ ] 用户能在 DeliveryDetail 看到 DAG 视图切换，10+ 节点时依赖关系一目了然
- [ ] 运行中的 attempt 可点按钮实时查看 xterm 日志（事件流，无轮询延迟）
- [ ] **AI 终端从任意入口（标签页 / 实时弹窗）打开均不破坏 live-output.log 落盘**（`drain_terminal_output` 后端豁免生效）
- [ ] 创建/编辑任务节点时可设置超时，留空时使用 Agent 默认，**80%** 时任务卡片显示橙色「即将超时」徽章（与 `TIMEOUT_WARNING_RATIO` 一致）
- [ ] `approachingTimeout` 事件实时到达（append_event 统一 emit，无 4 秒轮询延迟）
- [ ] Agent 配置区可设置默认超时，创建任务对话框的提示文案动态显示该默认值
- [ ] 编辑任务节点后事件列表出现 `taskNodeEdited` 带 diff
- [ ] **运行中的交付里，failed/rework/cancelled 任务可编辑（提高 retryCount 后重试成功，含 10 次用尽后提高到 11+ 的场景）** —— 修复「编辑提高上限」提示死路（依赖 `retry_task_node` 去掉 min(10) 钳制，5.2 第 10 条）
- [ ] 编辑状态约束边界（v6 新增）：queued/running/succeeded/awaitingReview 拒绝编辑；needsInput 可编辑且其未决 decision request 保留（删除会导致任务永久卡死，仅清理未决 review gate）；**policyViolation 可编辑（同 failed）且重试白名单放行，不留死路状态（v7 新增）**
- [ ] 删除任务节点后 contract、attempt 目录、review gate、decision request 均被清理，`delivery.taskNodeIds` 同步移除，引用它的 dependencyIds 自动移除
- [ ] **编辑/删除任务节点（含依赖增删）后，下游任务状态被扩展后的 `refresh_ready_task_nodes` 重算**（依赖满足 promote 到 ready / 依赖失效（含依赖被删）demote 回退 planned，列表与 DAG 视图一致）
- [ ] 环依赖检测阻止保存（create 与 update 两路径均生效）
- [ ] 运行时长与超时起算点均基于 `startedAt`（`start_attempt` 置 running 时重打点，排队时间不计入，前端展示与 watchdog 一致）
- [ ] 超时终止、交付收尾、合并冲突/成功有系统托盘通知，点击可跳转对应交付
- [ ] `cargo test` 通过（环依赖检测 3 例）、`cargo check` 通过、`tsc --noEmit` 通过
- [ ] Web 端能看实时终端（轮询 liveOutputTail，验证 HTTP 路径通即可）

---

## 9. 后续迭代候选（扫描发现，不纳入本迭代）

> 来源：2026-08-02 对 `ai_delivery_service.rs`（~7500 行）与前端工作区的全面扫描，除已并入本迭代的项外，其余均为迭代 2+ 候选。每条含证据位置与建议排期。

### 9.1 已并入本迭代

| 候选 | 并入位置 | 说明 |
|------|----------|------|
| attempt 时长口径 | ~~T1 + T2~~（已移除） | **v3 核实后撤回**：`started_at` 虽在 queued 打点（2378 行），但 `start_attempt` 置 running 时重打点（2599 行），排队时间并不混入，无需新增 `actual_started_at` |
| 系统通知全覆盖 | T2 | `show_ai_delivery_notification` 仅 2 处调用（`commands/ai_delivery.rs:263`、`ai_delivery_service.rs:2966`），失败/超时/完成/合并均无通知 |

### 9.2 改进候选

| 候选 | 痛点与证据 | 排期 |
|------|-----------|------|
| 依赖基线版本校验 | 质量门禁失败把依赖置 rework（3200-3213 行），下游已 succeeded 任务不失效，重派发只查分支存在（3544 行）不校验提交版本 → 下游基于过期基线执行。**与 T4 编辑能力强相关（改 DAG 更易触发）** | 迭代 2，优先 |
| 合并冲突续接 | 冲突 → merge record failed（2206 行），无「冲突已解决，继续合并」入口，只能整体重来 | 迭代 2 |
| 候选 Agent 无容量自动补派 | `select_agent` 无容量直接报错（3271-3286 行；3229 为函数起始行，v6 修正），任务停 ready 需手动再点；`dispatchDeferred` 事件已存在但无自动重试 | 迭代 2 |

### 9.3 新增候选

| 候选 | 说明 | 排期 |
|------|------|------|
| 失败任务下游级联处理 | 依赖须全 succeeded 才 ready（1429 行），依赖失败后下游永久 planned、交付无法收尾；补「标记忽略(skipped) + 级联跳过 + 局部失败收尾判定」 | 迭代 2 |
| 交付收尾报告 | 完成后自动生成：成功率/重试/返工链、实际耗时、合并分支与 commit、遗留问题；数据全在现有模型，前端报告 tab + 导出 Markdown | 迭代 2 |
| 完整 transcript 回放 | 执行完成后只有 8000 字符 tail（1575 行截断）；补全量查看 + 搜索 + 虚拟滚动 | 迭代 2 |
| 交付资产导出/备份 | 全 JSON 散文件，一键导出项目+交付+产物为 ZIP（可导入）；`path_service` 已有 `copy_dir_recursive` | 迭代 3 |
| 无头/命令行交付模式 | `--ai-delivery <项目> <需求> [--approve] [--notify]` 全流程，配合通知实现 CI 式用法 | 迭代 3 评估 |

### 9.4 已在 improvement-plan 规划（本清单不重复）

批量操作、交付模板、失败聚合、统计面板、增量 Diff 审查、Agent 启动预设、工作流预览、Web CRUD 补全、产物归档对比、资源感知调度（见 `ai-delivery-improvement-plan.md` 第 7 节优先级表）。
