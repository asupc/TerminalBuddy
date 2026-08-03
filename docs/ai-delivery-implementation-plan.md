# AI 交付改进 — 最终实施依据（合并版）

> **来源**：本文档由 `ai-delivery-improvement-plan.md`（改进规划）与 `ai-delivery-iteration-1-plan.md`（迭代 1 实施计划）合并而成，作为 AI 交付功能后续迭代的**唯一实施依据**。原两份文档与合并脚本 `docs/_write_plan.py` 已在工作区删除（git 历史保留原貌），本文档为事实修订后的最终版。
>
> **核实基准**：2026-08-02，HEAD `ea369ac` + 工作区。已对两份文档的全部行号引用与断言做 4 路全量代码核实（backend service×2 / models / frontend / commands+web），修正点统一见 [§9 核实修正清单](#9-核实修正清单合并时发现)。合并后又做**二次复核**（4 路并行核查代理 + 关键点逐行抽查），新增修正见 [§9 修正清单 26-38 条](#9-核实修正清单合并时发现)。本文档定稿前另做**三次复核**（2026-08-02，4 路并行核查代理 + 差异点人工逐行复核），新增修正见 [§9 修正清单 39-43 条](#9-核实修正清单合并时发现)。定稿后另做**四次复核**（2026-08-02，6 路并行核查代理 + 关键发现人工逐行复核），新增修正见 [§9 修正清单 44-51 条](#9-核实修正清单合并时发现)。
>
> **合并修订**（v-merge）：
> - 迭代 1（T1-T4）实施细节由独立文档**内联**进本档 §3，原「已规划 → 见 xx」跳转全部闭合
> - 原两份文档的修订历史（iteration-1-plan v1-v7）压缩为本档§3 中的注记，不再逐版罗列
> - iteration-1-plan §9 扫描发现的后续候选（依赖基线校验、合并冲突续接等）合并进 §2.1 总表与 §6.3
> - 涉及文件索引、通用规范两份并轨去重

---

## 1. 实施上下文

### 1.1 核心架构

| 层级 | 内容 |
|------|------|
| 实体模型 | AiProject → AiDelivery → AiTaskNode (DAG) → AiTaskContract → AiAttempt |
| 配置层 | AiAgentRuntime → AiAgent → AiRole → AiWorkflow |
| 质量保障 | AiQualityGate → AiReviewGate → AiDecisionRequest |
| 交付闭环 | AiMergeRecord → cleanup_integration |
| AI 用量 | 智谱GLM / 百度千帆 / DeepSeek / MiniMax / 火山方舟 |

### 1.2 工作流

发现本地Runtime → 配置Agent/角色/编排 → 创建项目(自动发现Git仓库) → 创建交付需求 → 管理Agent生成任务图 → 人工审批 → 自动分配worktree → 并发执行 → 质量门禁审核 → 人工决策介入 → 本地合并到目标分支

### 1.3 技术栈与存储

- 后端：Rust (Tauri 2) + portable-pty (ConPTY) + axum (Web API) + ssh2 + JWT
- 前端：React ^19.2.6 + TypeScript + Zustand 5（^5.0.14）+ @xterm/xterm 6.x (beta)；**Monaco 已集成**（`@monaco-editor/react` ^4.7.0，迭代 3 Diff 审查/迭代 4 产物对比的依赖已就绪）
- Web 端：独立 React SPA（`web/src/`），嵌入 Rust 二进制，WebSocket 通信
- 存储：`%APPDATA%/TerminalBuddy/AiDelivery/` 下按实体分目录的 JSON 文件

### 1.4 状态全集（已核实）

- **任务状态**（`AiTaskNode.state`，11 种）：planned / ready / queued / running / succeeded / failed / policyViolation / rework / cancelled / awaitingReview / needsInput。**无 `completed`**（成功态为 `succeeded`）；`policyViolation` 由 `finish_attempt` 经 `audit_contract_scope`（调用点 2993，定义 4520-4553）越界写入时置位（**attempt** 置位 3042-3043、**task** 置位 3073-3074，两实体同源同步置位），**当前无恢复路径**（`retry_task_node` 白名单 2404 不含）
- **交付状态机**（`AiDelivery.state`，10 种）：drafting / planning / awaitingApproval / running / paused / cancelled / needsInput / completed / succeeded / failed。`delivery.state = "failed"` **无赋值点**（仅 1101-1104 行 `delete_delivery` 的 `matches!` 删除门槛中作为终态值保留，前端过滤值）；`"merging"` / `"blocked"` 是 **merge 记录**的状态而非交付状态（merge 状态分两级：`AiMergeRecord.state` 赋值 4 种 merging / blocked / rolledBack / completed，记录级**无 `failed`**；仓库子记录 `AiMergeRepositoryRecord.state` 赋值 5 种 pending / merged / failed / rolledBack / rollbackFailed——原「全集」混级且漏 `pending`/`merged`，见 §9 第 44 条）
- **attempt 状态**（二次复核修正）：queued（创建时）/ running / needsInput / cancelled / failed / **completed**（成功态）/ **policyViolation**。**无 `succeeded`**——成功态是 `completed`（`finish_attempt` 3044-3045，及 1074/1841/5571/5629），全库无 `attempt.state = "succeeded"` 赋值（`succeeded` 是任务状态）；`starting` 无赋值点，仅出现在「活跃 attempt」过滤表达式中（390/706/1125/1363/1649/3293/3307，兼容值）
- **reviewGate 状态**：awaitingReviewer / approved / rework / **failed**（质量门禁命令失败时置位，service 1774，见 §9 第 45 条）；**decisionRequest 状态**：pending（`pending` 不属于任务状态；merge 两级状态见上）
- **contract 状态**：allocated 等（`allocated` 不属于任务状态）

---

## 2. 迭代规划总览

### 2.1 总表

| 优先级 | 迭代 | 模块 | 功能 | 估算 | 状态 |
|--------|------|------|------|------|------|
| P0 | 1 | 可观测性 | 实时日志/终端查看（T1） | 0.5d | §3.1 |
| P0 | 1 | 可靠性 | 超时可配置+提前告警（T2） | 0.5d | §3.2 |
| P0 | 1 | 任务图 | DAG 可视化（T3） | 2d | §3.3 |
| P1 | 1 | 任务图 | 任务节点手动编辑（T4） | 1.5d | §3.4 |
| P1 | 2 | 协作 | N1 交付事件推送微信/飞书 | 0.5d | §4.1 |
| P1 | 2 | Web UI | N2 Web 端操作补齐 | 1.5d | §4.2 |
| P1 | 2 | 可观测性 | N3 质量门禁命令结果可视化 | 0.5d | §4.3 |
| P1 | 2 | 可靠性 | N4 policyViolation 一键恢复 | 0.5d | §4.4 |
| P1 | 2 | 可观测性 | N5 合并记录详情面板 | 0.5d | §4.5 |
| P1 | 2 | 效率 | 批量操作 | 1d | §4.6 |
| P1 | 2 | 效率 | 交付模板 | 1.5d | §4.7 |
| P1 | 2 | 可靠性 | 失败聚合+标记忽略/带参重试 | 1d | §4.8 |
| P1 | 2 | 可靠性 | 依赖基线版本校验 | 1d | §6.3（原 iteration-1 §9.2，优先） |
| P1 | 2 | 可靠性 | 合并冲突续接 | 1d | §6.3（原 §9.2，与 N5/N7 联动） |
| P1 | 2 | 可靠性 | 候选 Agent 无容量自动补派 | 0.5d | §6.3（原 §9.2） |
| P2 | 3 | 可观测性 | 交付统计面板 | 2d | §5.1 |
| P2 | 3 | 审查 | 增量 Diff 审查 | 2d | §5.2 |
| P2 | 3 | 配置 | Agent 启动预设管理 | 1d | §5.3 |
| P2 | 3 | 配置 | 工作流步骤预览和测试 | 1d | §5.4 |
| P2 | 3 | Web API | 缺失 REST 路由补全（编辑/删除/添加任务等） | 1.5d | §5.5 |
| P2 | 3 | 可靠性 | N6 needsInput 重启恢复 | 0.5d | §5.6 |
| P2 | 3 | 可靠性 | N7 合并失败交付终态 | 0.5d | §5.7 |
| P2 | 3 | 可观测性 | N8 已答决策历史视图 | 0.5d | §5.8 |
| P2 | 3 | 可观测性 | N9 事件/列表查看全部+搜索+分页 | 1d | §5.9 |
| P2 | 3 | 可靠性 | N10 事件文件滚动清理 | 0.5d | §5.10 |
| P2 | 3 | 可靠性 | N11 规划中断「以当前状态重跑」 | 1d | §5.11 |
| P2 | 3 | 可观测性 | 完整 transcript 回放 | 1d | §6.3（原 §9.3） |
| P3 | 4 | 可观测性 | 产物归档与对比 | 1d | §6.1 |
| P3 | 4 | 可靠性 | 资源感知调度（全局并发上限/优先级队列） | 2d | §6.2 |
| P3 | 4 | 可观测性 | N12 attempt 运行时长展示 | 0.5d | §6.4 |
| P3 | 4 | 体验 | N13 错误本地化+banner 重试 | 1d | §6.5 |
| P3 | 4 | 重构 | N14-N21 小项打包 | 1d | §6.6 |
| P3 | 4 | 可观测性 | 交付收尾报告 / 资产导出 / 无头命令行模式 | 各 0.5-1d | §6.3（原 §9.3） |
| 待评估 | - | 可靠性 | 交付暂停与恢复增强（优雅暂停） | - | §6.7 |

**总估算**：约 32 个工作日（不含测试和联调），分 4-5 个迭代。

### 2.2 迭代 1（T1-T4）任务划分

| 编号 | 名称 | 串并行 |
|------|------|--------|
| T1 | 实时终端查看（事件流 + live 输出落盘） | T1/T2 并行 |
| T2 | 超时可配置 + 提前告警（含系统通知补齐） | T1/T2 并行 |
| T3 | DAG 可视化 | T3/T4 并行，**须在 T1/T2 完成后启动**（T3 依赖 T1 的事件/落盘机制与 T2 的事件推送） |
| T4 | 任务节点手动编辑 | T3/T4 并行（编辑器与 T3 共享 DAG 抽屉入口） |

### 2.3 项间依赖

| 依赖 | 说明 |
|------|------|
| N4 ↔ 失败聚合/标记忽略 | 同源：`skipped` 标记与级联复用 |
| N5 → 合并冲突续接 | N5（详情面板）是合并冲突续接（§6.3）的前置 |
| N7 ↔ 合并冲突续接 | 互补：N7 解决状态机（mergeFailed 终态），冲突续接解决入口（冲突已解决后继续合并） |
| N14 → T2 | N14 并入迭代 1 T2 一并实现（watchdog 超时改 emit attemptTimedOut） |
| N2 ↔ REST 补全 | 互补：N2 补齐已有 12 路由的 Web UI（零后端），REST 补全补齐缺失路由（PUT/DELETE/POST 任务等，§5.5） |
| N19 → 启动预设 | `AiAgent.startup_preset_name` 非死字段（前端 ConfigDialog 预设套用已可写入非 None，见 §5.3），后端无读取逻辑，随 §5.3 补「派发时应用」落地 |
| T4 ↔ 依赖基线版本校验 | T4 的编辑能力使 DAG 变更更易触发下游基于过期基线执行（§6.3 优先项） |

### 2.4 工作区基线注意（已核实更新）

原文档 v7 标记「`retry_task_node` 的 min(10) 钳制（2408）与『编辑任务提高上限再重试』文案（2428-2431）是**未提交工作区改动**」——**该改动已在 9c74dd3 提交**（锁机制重构为 RAII 守卫即为其中一部分）。当前工作区改动均为文档侧：`docs/_write_plan.py`、`docs/ai-delivery-improvement-plan.md`、`docs/ai-delivery-iteration-1-plan.md` 三份文件已删除（合并完成后清理，git 历史保留），无代码漂移，可直接在 HEAD `ea369ac` 之上实施。

---

## 3. 迭代 1：实施详情（T1-T4）

> 目标：解锁多任务场景下的核心调试与编排体验。最近三个 commit（6dc1d8e / 3f4cbf6 / 188d531）已完成 watchdog 资源清理与并发锁，本迭代在其上扩展。

### 3.1 T1 实时终端查看

#### 3.1.1 关键事实：为什么不能轮询 transcript.log

Agent 调用命令是 `... | Out-File -LiteralPath transcript.log -Encoding UTF8`（`ai_delivery_service.rs:5944/5971`，两处均带 `-Encoding UTF8`）。`Out-File` 为缓冲写入，`claude --print` 等一次性输出模式在**进程退出前文件基本为空**。轮询 transcript.log 看不到实时输出。

**实时数据源有两个，二选一/叠加：**

1. **PC 端主方案（零延迟）**：订阅 `terminal_output_{terminalId}` Tauri 事件（`attempt.terminal_id` 已存在，`tauri.ts:362-368` 已有 `onTerminalOutput` 封装，事件通道零后端改动）
2. **后端实时落盘（Web 端复用 + PC 端兜底）**：monitor 线程改为每 300ms `drain` 消费缓冲并**追加写** `live-output.log`。Web 端轮询该文件即可，无需事件通道

#### 3.1.2 后端最小变更

**monitor 线程**（`start_attempt` 内 2639 行起的匿名 `thread::spawn`，范围 2639-2766；**`monitor_attempt_execution` 函数名不存在**——300ms peek 循环 2641-2650（其中 2646 的 `peek_terminal_output` 仅作存活探测 `is_err()`、返回值丢弃）、transcript 兜底 2654-2657、exit_marker 退出检测 2643、review_repair 修复逻辑 2660-2684——drain 改动落在内层循环，**勿破坏退出检测与 repair 分支**，2646 探测调用改 drain 后保留 `is_err()` 语义）追加写 live 输出。**数据源唯一化：monitor 是缓冲的唯一消费方，用 `drain` 独占消费**（不能用 `peek` + 长度增量——PC 端任何一次 `drain_terminal_output` 都会清空缓冲，使长度增量逻辑永久失效）：

```rust
// 每 300ms 一次：drain 增量 → 追加 live-output.log（缓冲被消费，无 last_len 竞态，无内存增长）
let output = terminal_service.drain_terminal_output(&terminal_id)?;
if !output.is_empty() {
    fs::OpenOptions::new().append(true).open(run_dir.join("live-output.log"))?
        .write_all(output.as_bytes())?;
}
```

> 注意：monitor 线程原有「结束时用 peek 输出作 transcript 兜底」（2654-2657 行）在改为 drain 后拿到的是空缓冲，**需同步改为：transcript.log 为空时以 live-output.log 尾部兜底**（同一 run_dir 内，attempt 结束时无并发写入；**兜底读取截断为尾部 20k 字符**——原「全文兜底」在长任务下会把 MB 级文本带进 finish_attempt 的 stdout/summary/事件消息链）。
> 已知约束：`TerminalOutputBuffer` 上限 1000 chunk / 2MB（terminal.rs:31-32），超限丢最旧 chunk——live-output.log 为唯一全量来源，长任务事件流会有截断属正常。

**「monitor 独占消费」的后端强约束**：PC 端既有 `TerminalInstance` 初始化会无条件 `drainTerminalOutput`（`src/components/terminal/TerminalInstance.tsx:1220`——通用终端标签组件，AI 终端与其他终端共用同一初始化路径），且 AI 终端本就通过 `terminal-created` 事件（`create_ai_terminal` 定义 6210-6246，emit 在 6228；**调用点共 3 处**：2586（`start_attempt` 内任务执行）、6680（reviewer 启动）、7244（manager 启动），均经 `create_ai_terminal` 包装，其内部 6218 再调 `TerminalService::create_blank_terminal`）进入标签栏——用户点开标签即触发 drain，monitor 两次 300ms drain 之间的输出会被抢走，live-output.log 静默缺块。仅靠「新弹窗不 drain」的前端纪律不闭环，改为后端豁免：

- `TerminalInstance` 结构（terminal.rs:116-130，字段含 `owner` 121 行，**无 ai_delivery 标记**）新增 `ai_delivery: bool` 标记（`create_ai_terminal` 创建时置位）
- `drain_terminal_output`（terminal.rs:862-873，现为 `buffer.drain()` 无条件清空；另有 `#[command]` 包装 1206-1212）对 `ai_delivery` 终端**只返回当前缓冲、不消费**（行为等价 peek），其余终端行为不变

由此既有标签页路径的 drain 调用天然无害，monitor 线程成为事实唯一消费方；新增 `AttemptLiveTerminalDialog` 仍按 3.1.3 纪律不调 drain，双保险。

`models/ai_delivery.rs` 在 `AiAttemptOutput`（当前字段：attempt_id / transcript_tail（注释称≤8000 字符）/ final_message / review / decision / prompt_excerpt / plan_json）增字段：

```rust
pub struct AiAttemptOutput {
    // 已有字段...
    pub is_live: bool,            // attempt.state == "running"
    pub live_output_tail: String, // live-output.log 尾部（最多 8000 字符），Web 端轮询用
}
```

`read_attempt_output`（1575 行；BOM/非 UTF-8 容错 1581-1595；8000 字符截断 1597-1608；运行目录兼容注释 1577-1578）末尾补：读 attempt JSON 判断 state；读 live-output.log 尾部。**不做文件 mtime 字段**——PC 端事件流天然增量，Web 端轮询全量渲染即可。

**已核实：`AiAttempt.started_at` 无需新增 `actual_started_at` 字段**。`started_at` 虽在建 attempt（queued）时打点（2378 行，位于 `dispatch_task_node`（2297-2400）的 AiAttempt 构造块 2369-2384 内），但 `start_attempt` 在创建终端成功后、置 running 时**重新打点**（2599 行；manager/reviewer attempt 直接以 running 创建（914/1812 行），不 spawn watchdog、不受影响），故运行中任务 attempt 的 started_at 就是实际开始时刻，排队时间并未混入，watchdog（6280 行）从它起算超时准确。原计划中的 `actual_started_at` 字段、前端时长口径、watchdog 起算点改动均为**无收益改动，已整体移除**。

#### 3.1.3 PC 端实时查看

新建 `src/components/ai-delivery/AttemptLiveTerminalDialog.tsx`：

1. **打开弹窗**：**先注册 `listen(terminal_output_{terminalId}, cb)`，再** `readAiAttemptOutput` 取 `liveOutputTail` 作为历史一次性写入 xterm——**不要 `drainTerminalOutput`**。监听注册早于读历史：**无丢失窗口**；历史与事件流之间**可能有毫秒级重复**（listener 注册后、tail 读取前这一小段被 monitor drain 进日志的块，其事件（reader 线程推缓冲时已 emit，terminal.rs:388-392）与 tail 会各显示一次）。窗口极小、不产生缺失，明确不做去重
2. `listen(terminal_output_{terminalId}, cb)` 增量写入 xterm（**非轮询**，事件流零延迟）
3. 关闭弹窗 / attempt 离开 running 时 `unlisten()`
4. attempt 结束后（4 秒轮询里状态翻转或按钮消失时）补拉一次 `readAiAttemptOutput`，显示 final-message 收尾
5. 元信息区：attempt.state、运行时长（基于 `startedAt`，即 `start_attempt` 置 running 时打点，不含排队时间）、进度信号（正则从 **live-output.log** 提取 `<step>...</step>`——运行中 transcript.log 为空，不能从 transcript 提取）

修改 `DeliveryDetail.tsx`：
- attempt 卡片新增**「查看实时终端」**按钮（`attempt.state === 'running'` 时显示，判断直接来自已有 attempts 数据，无需 is_live）；注意运行中 attempt 卡片**已有「打开终端」按钮**（`DeliveryDetail.tsx:671-679`，`onClick` 676 调 prop `openAttemptTerminal`，实际派发 `open-ai-attempt-terminal` 在父组件——该事件是 **window 级 CustomEvent**：`AiDeliveryWorkspace.tsx:920-924` 派发、`App.tsx:317-318` 监听定位/聚焦终端，非 Tauri 事件通道）——新按钮定位是弹窗实时查看，两者入口并存，文案与图标需区分（建议「实时终端」vs 既有「打开终端」）
- 已完成 attempt 仍走现有 `AttemptOutputDialog`（静态成果查看：只读 Monaco 分页展示 finalMessage/review/decision/planJson/promptExcerpt/transcriptTail，数据源 `readAiAttemptOutput`，AiDeliveryWorkspace.tsx:931 调用）

#### 3.1.4 Web API 兼容

- `web/handlers/ai_delivery_handler.rs` 暴露 `GET /api/attempts/:id/output`（复用 `read_attempt_output`）
- **必须同步在 `web/server.rs` 注册路由**（AI 交付 REST 区块 49-96 行内追加，路由链整体 33-119 行；遗漏即 404）
- Web 端每 5 秒轮询该接口（与现有 `web/src/screens/AiDelivery.tsx:32` 的 snapshot 轮询节奏一致），渲染 `liveOutputTail`（Web 端没有事件通道，接受轮询延迟）
- **隔离策略**：AI 交付数据本就通过 deliveries/snapshot 等 REST 接口对 Web 端可见，不随 `web_api_share_sessions` 的终端级隔离走；本接口与之一致，复用既有 JWT 鉴权即可。注意：终端级会话隔离逻辑不在 `web/ws.rs`，而在 `commands/terminal.rs:905-916` 的 `check_pc_permission`（非共享时 Web 端对 PC 终端只读），本接口不涉及终端写操作，无需套用

### 3.2 T2 超时可配置 + 提前告警

#### 3.2.1 数据模型

`models/ai_delivery.rs`（两字段现均**不存在**，需新增；`AiTaskNode` 现有字段全集见 models 323-356：id / delivery_id / title / description / role_id / workflow_step_id / preferred_agent_id / task_prompt / execution_mode / execution_context / target_repository_id / allowed_write_paths / dependency_ids / input_artifacts / expected_artifacts / acceptance_commands / retry_count / state / assigned_agent_id / contract_id / attempt_ids / created_at / updated_at——**无 timeout_seconds**）：

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

常量定义在 `services/ai_delivery_service.rs`。**注意（已核实）**：watchdog 现有时间参数并非函数内散落字面量，而是集中常量（49-52 行）：`ATTEMPT_MAX_DURATION`(60min) / `ATTEMPT_WATCHDOG_DELAY`(30s) / `ATTEMPT_WATCHDOG_INTERVAL`(60s)。新增：

```rust
pub const DEFAULT_ATTEMPT_TIMEOUT_SECONDS: u32 = 60 * 60;  // 与 ATTEMPT_MAX_DURATION 对齐
pub const TIMEOUT_WARNING_RATIO: f32 = 0.8;                 // 80% 时告警
```

#### 3.2.2 后端逻辑

修改 `run_attempt_watchdog`（6257 行；起算点 `attempt.started_at` 6279-6280；超时调 `fail_attempt_from_watchdog` 6281-6292；`attemptWatchdogCheck` 事件 6491）。**`AiAttempt` 只有 `task_node_id` / `agent_id` 等扁平标量字段，没有嵌套对象**，超时需要显式加载（在 spawn 时快照一次，不放在循环内）：

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

**事件推送**：`append_event`（3401-3419）目前只写文件、无 AppHandle，`emit("ai-delivery-event")` 分散在 **12 处调用点**（1861/1877/2614/2893/2924/2965/3125/3140/3164/6417/6699/7264，已逐一核实：均为「emit `append_event` 返回值」模式，其中 2614 为 `if let Ok(event)` 包装）。本次统一收口，需三步：
1. **引入全局 AppHandle**：`static APP_HANDLE: OnceLock<AppHandle>`，在 `lib.rs` setup 中注入（全库当前无任何全局 AppHandle 模式，这是新增基础设施；lib.rs 现有 4 处局部 `app.handle()` 使用：341/430/443/455 行）；`append_event` 末尾从全局读取并 `emit("ai-delivery-event", event)`
2. **删除上述 12 处调用点各自的 emit**（删除安全，见上）
3. **额外收益（已核实）**：全库 `append_event` 共 40+ 次调用，仅上述 12 处伴随 emit，**其余约 30 处只写文件不 emit**（如 2481 dispatchDeferred、3170 autoMerged、3179 autoMergeFailed、6487 attemptWatchdogCheck，完整规模见 §9 第 47 条）——收口后这些事件自动获得实时推送，无需单独改动

`approachingTimeout` 由此自动实时送达。前端已有 4 秒轮询兜底（`AiDeliveryWorkspace.tsx:385-389`），双保险。注意 watchdog 现有检查点已**写文件** `attemptWatchdogCheck` 事件（`record_watchdog_observation` 6465-6495，事件字面量在 6491，目前只写文件无实时推送），收口后自动获得推送；与一次性 `approachingTimeout` 告警并存于事件列表（一个周期心跳、一个一次性告警）。

**告警文案**：watchdog 节奏为 spawn 后先 `sleep(30s)` 再进入循环（6264），之后每 60 秒检查一次——检查点序列约 30s/90s/150s…（**首个检查点距运行开始约 30 秒**，非 90 秒），「预计 X 秒后超时」按检查点取整描述（实际偏差 ±60 秒）。

**系统通知补齐**：目前 `show_ai_delivery_notification` 只有 2 处调用（决策创建 `commands/ai_delivery.rs:263-267`、`attemptAwaitingDecision` `ai_delivery_service.rs:2966`，已核实全库恰 2 处）。本次补齐关键节点的系统托盘通知，复用现有函数与「点击通知跳转交付」（`notification.rs:111` 已有 `ai-delivery-notification-activated`）：
- `fail_attempt_from_watchdog`（超时 / 终端结束 / 自动完成失败）
- `complete_attempt` 交付整体收尾（completed / succeeded）
- `merge_delivery_locally` 合并成功或冲突失败
- 通知正文带 deliveryId 与任务标题。**注意**：`show_ai_delivery_notification` 标题硬编码「AI 交付等待决策」（notification.rs:91-116，参数仅 app/delivery_id/question，无 title 参数，正文即 question）——直接复用到超时/完成/合并场景会显示误导性标题，需为该函数**加 title 参数**或按场景定制正文

#### 3.2.3 前端 UI

`TaskDeliveryDialogs.tsx` 的 `TaskCreateDialog`（126 行起；已有「最大重试次数」retryCount 输入，**无超时输入**）与 `TaskNodeEditor`（T4 新建）增字段：
- 「超时时间（分钟）」输入框，默认留空（= 使用 Agent 默认）
- 提示文案**动态显示**当前 Agent 默认值（从 `getAiAgents` 列表取 `defaultTimeoutSeconds`，缺省时显示「60 分钟」），不要硬编码：「留空使用 Agent 默认（X 分钟），设置范围 5-480」

**Agent 默认值配置入口**：`ConfigDialog.tsx` 的 Agent 配置区新增「默认超时（分钟）」输入（`saveAgentConfig` 的 patch 增加 `defaultTimeoutSeconds`；`AiDeliveryWorkspace.tsx:1155-1157` 已支持整对象覆盖式 patch——`saveAgentConfig` 包装函数声明在 1155，核心调用 `await saveAiAgent({ ...agent, ...patch })` 在 1157，后端无字段级差分）。**没有这个入口，AiAgent 字段就永远为空，T2 的「Agent 默认」落空**。

`AiDeliveryEvent` 列表（DeliveryDetail 事件 tab）新增事件类型 `approachingTimeout`：黄色提示带「查看详情」按钮。

#### 3.2.4 命令

**不需要新增** `get_ai_default_timeout_seconds`：Agent 列表加载后自带 `defaultTimeoutSeconds`，前端直接取；全局兜底常量前端也可先写 3600 仅作显示占位。避免多一个命令 + 一个容易误导的「全局 vs Agent」概念。

### 3.3 T3 DAG 可视化（与 T4 并行）

#### 3.3.1 依赖安装

```bash
cd terminal-buddy
npm install @xyflow/react@^12  # reactflow v12 是当前主线，兼容 React 18/19（项目当前为 React ^19.2.6）
```

> **不要装旧版 `reactflow`**，已被 `@xyflow/react` 取代。当前 package.json 无任何 reactflow 系依赖。

#### 3.3.2 数据准备层

新建 `src/components/ai-delivery/utils/taskGraphLayout.ts`：
- 输入：`AiTaskNode[]`
- 输出：`{ nodes: Node[], edges: Edge[] }`
- 布局算法：**简化 Kahn 拓扑分层**（不需要 dagre），同层垂直顺序按 title 字母序
  - 计算每节点的 max(父节点层) + 1
  - 横向 240px 间距，纵向 120px 间距
- **布局缓存存 localStorage**（key `ai-delivery-graph-layout:v1:{deliveryId}`）——**不塞进 `AiDelivery` 模型**（`update_delivery`（841-870）实为 `UpdateAiDeliveryInput` 定向 patch，但 `AiDelivery` 是快照载荷与读写共用模型，塞布局字段仍会污染模型与所有消费方）；也不落数据目录文件（Tauri 前端读写数据目录需新增后端命令 + 文件清理规则，为纯展示态缓存不值当）
- **缓存失效**：缓存内记录 `layoutVersion` = **节点 id 集合 + 依赖边集合（按 id 对排序后拼接）的短 hash**（仅「节点 id」在 T4 编辑 dependencyIds 后拓扑分层应变化但版本不变，会复用陈旧布局），节点增删**与依赖增删**均触发重算
- **节点默认禁拖拽**（`nodeDraggable={false}`）：布局完全由算法 + 缓存决定，避免用户拖拽位置与缓存/重算互相冲掉；若后续需要手动布局再扩展持久化方案

#### 3.3.3 DAG 组件

新建 `src/components/ai-delivery/TaskDagView.tsx`：
- 用 `<ReactFlow>` + `<Background>` + `<Controls>` + `<MiniMap>`
- 自定义节点 `TaskNodeCard.tsx`：显示 title / state / 角色徽标 / 进度点
- 状态色（现有前端仅单一 accent 色 `ai-status-chip`（AiDeliveryWorkspace.css:1090-1098），本表为 DAG 视图**新引入**的按状态配色）：
  ```ts
  // 任务实际状态全集（11 种）——无 "completed"（成功态为 "succeeded"）
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

#### 3.3.4 切换入口

`DeliveryDetail.tsx`：
- 顶部 Tab 切换 `列表视图` ↔ `DAG 视图`
- 默认仍是列表（兼容性），DAG 节点数 > 5 时提示「建议切换 DAG 视图」徽章

#### 3.3.5 性能预算

- 节点数 ≤ 50：直接渲染
- 节点数 > 50：自动启用紧凑模式（节点卡片收起为小圆点仅显示状态色，详情按需点击展开；MiniMap 维持常态）
- 用 `useMemo` 缓存 layout 计算结果

### 3.4 T4 任务节点手动编辑（与 T3 并行）

#### 3.4.1 后端命令

`commands/ai_delivery.rs` 新增（当前均不存在，已核实）：

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

`models/ai_delivery.rs` 新增（当前不存在，已核实）：

```rust
pub struct UpdateAiTaskNodeInput {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub role_id: Option<Option<String>>,           // 双 Option = 区分 "未提供" 和 "设为空"
    pub preferred_agent_id: Option<Option<String>>,
    pub task_prompt: Option<String>,
    pub execution_mode: Option<String>,            // 与前端编辑器字段一一对应
    pub execution_context: Option<String>,
    pub target_repository_id: Option<String>,
    pub allowed_write_paths: Option<Vec<String>>,
    pub dependency_ids: Option<Vec<String>>,
    pub expected_artifacts: Option<Vec<String>>,
    pub acceptance_commands: Option<Vec<String>>,
    pub timeout_seconds: Option<Option<u32>>,       // 同上
    pub retry_count: Option<u32>,                    // 0 = 不限；允许 >10（见 3.4.2 第 10 条）
}
```

> 字段表与 3.4.3 编辑器字段分区必须一一对应（inputArtifacts / workflowStepId 前端不编辑，不在此处暴露，避免输入字段与 UI 再次不一致）。

#### 3.4.2 服务层逻辑

**编辑状态约束**——`update_task_node`：

1. 加载 task_node 与所属 delivery
2. 状态校验（**task 状态**，不是 delivery 状态）：
   - task.state ∈ {planned} → 任意字段可编辑
   - task.state ∈ {failed, rework, cancelled, needsInput, policyViolation} 且 delivery.state ∈ {running, paused, needsInput} → 可编辑（**这是 retry 场景的核心诉求**：`retry_task_node`（2402 行）的错误提示明确引导用户「编辑任务提高上限再重试」（2428-2431），禁止运行中编辑 = 现有提示是死路；needsInput 任务尚未实际执行，等待决策输入期间编辑安全，且第 6 条的未决 gate/decision 清理正是为其服务；**policyViolation**：`finish_attempt` 3042-3049/3073-3084 由 `audit_contract_scope`（调用点 2993）越界写入触发，与 failed 同等对待——当前该状态无任何恢复路径（`retry_task_node` 白名单 2404 不含，任务永久卡死），放行编辑并同步放行重试（第 10 条）正是补死路）
   - task.state ∈ {queued, running, succeeded, awaitingReview} → 拒绝（queued/running 执行中；succeeded 已完成，编辑会造成状态倒挂；awaitingReview 质量门禁审查中，改执行参数会使审查基于旧 contract）
   - 说明：delivery 状态机是 drafting/planning/awaitingApproval/running/paused/cancelled/needsInput/completed/succeeded/failed，**不存在 "planned" 状态**（planned 是 task 的状态；`delivery.state = "failed"` 无赋值点，仅作过滤值保留）
3. **校验复用 `create_task_node`（1176-1269）的既有约束**，不要另写一套。**注意必须排除其中的 delivery 状态校验（1202-1207，仅允许 planning/drafting/awaitingApproval）**——否则 running 交付中的编辑会被自己复用的校验拒绝，本任务的核心场景直接失效；编辑场景的交付状态约束统一由第 2 条负责：
   - title/description 非空（1177-1179）
   - executionMode ∈ {write, readonly}、write 任务必须 taskWorktree 上下文（1180-1187）
   - workflowStepId 非空时必须有 expectedArtifacts（1188-1195）
   - validate_artifact_paths / validate_write_paths
   - **role_id 与 preferred_agent_id 至少一个存在（1198-1200）**——编辑器允许清空单个，但两者全空则任务不可派发（`select_agent` 3244 行直接报错），必须拒绝
   - targetRepositoryId 属于 delivery.project_id 对应项目的 repositories（模型无嵌套 project 对象，经 `get_project` 解析）且 write_enabled（1208-1216）
   - role_id / preferred_agent_id 存在性（1218-1223）
   - dependency_ids 都属于当前交付（1224-1229）
4. **环依赖校验**：DFS 检测新 dependency_ids 是否形成环（自环、间接环）。**检测逻辑提取为独立 helper，`create_task_node`（1224-1229 后）同样接入**——现有 create 只校验成员关系，先建 A 依赖 B、再建 B 依赖 A 即可绕过 create 直接成环，交付永久卡在 planned；DoD「环依赖检测阻止保存」须覆盖两路径
5. **已有 contract 的任务编辑执行相关字段**（executionMode / executionContext / targetRepositoryId / taskPrompt / allowedWritePaths / expectedArtifacts / acceptanceCommands / timeoutSeconds——列表与 3.4.3 编辑器「执行参数/目标仓库/产物验收/运行时」分区一一对应，**只改 title/description/roleId/依赖关系等不标脏**）：标脏 contract（新增 `AiTaskContract.dirty: bool` 字段，serde default false）→ 重试派发时重新审计 / 重建 contract，保证旧 worktree 的审计结果不被错误复用
6. **未决 gate/decision 清理**：编辑后删除该任务下**未决**的 review gate 与 decision request（`AiReviewGate.task_node_id` / `AiDecisionRequest.task_node_id` 引用，复用 delete 的清理逻辑；已完成的历史文件保留留痕），避免重试时旧审核/旧决策残留。**例外**：task.state == needsInput 时**保留**其未决 decision request——该请求是任务恢复（answer_decision）的入口，删除后任务将永久卡在 needsInput；needsInput 任务编辑仅清理未决 review gate
7. **依赖变更后状态重算**：dependencyIds 被修改时重算受影响任务状态。**现有 `refresh_ready_task_nodes`（1415-1445，依赖检查 `all(|d| succeeded.contains(d))` 1426-1430）只有单向 promote（planned + 依赖全 succeeded → ready），没有回退逻辑，原计划「调用 refresh 即可回退」不成立**。需扩展该函数支持：
   - promote 保持现状（planned → ready）
   - **新增 demote**：state == ready 且依赖不全部 succeeded（含依赖已删除 / 依赖状态为 failed/rework/cancelled/planned）→ 回退 planned
   删除/编辑依赖后调用扩展后的函数，与 DAG 视图/列表视图保持一致
8. 写入 JSON 文件
9. `append_event("taskNodeEdited", ...)` 记录变更前后差异（diff 字符串）
10. **retry_count 语义**：create 侧保留 `.min(10)`（1248 行）；update 侧允许 0-50（0 = 不限）；**同步调整 `retry_task_node`（2408 行）去掉 `effective_retry_limit = task.retry_count.min(10)` 钳制**、直接使用 `task.retry_count`——否则「编辑提高上限再重试」在 10 次用尽后无效（10→20 时 effective 仍为 10，依旧拒绝），T4 核心场景变成只有设 0 才能解锁；重试耗尽的 worktree 清理（2412-2427）已存在，放开钳制无资源泄漏风险。**相关事实（已核实）**：该钳制与「编辑提高上限」文案**已在 HEAD（9c74dd3 提交）**，不再是未提交改动；`retry_task_node` 另有动态提额逻辑（2433-2434：重试记录多于当前设置时自动 `task.retry_count = effective_retry_limit.max(attempted+1)` 提高上限）——去掉钳制后此逻辑需一并审视（提额基准应从 `effective_retry_limit` 改为 `task.retry_count`）；**`create_task_contract` 3481 行存在第三处 `.min(10)`**——重试上限判定只用 `task.retry_count`、契约内该值无逻辑用途，可一并去掉或保留并注明无害；**`retry_task_node` 状态白名单（2404 行）同步扩为 `failed|rework|cancelled|policyViolation`**——`build_continuation_context`（函数 6765，状态过滤 6777-6780）已将其 attempt 视为失败态参与续接，语义一致

`AiDeliveryService::delete_task_node`：

1. 状态约束同上（planned / failed / rework / cancelled 可删；queued/running 拒绝）
2. 级联清理**完整清单**（不只是 contract + attempt）：
   - contract 文件（如有）
   - attempt 文件 + 其运行目录（`terminal_run_dir_by_id`，兼容「纯 UUID」与「label__UUID」两种目录命名：`make_terminal_run_dir_name`（4786-4799，标签截断 50 字符）与 `terminal_run_dir_by_id`（4802-4819，目录扫描兼容，4818 行 `base.join(id_seg)` 兜底））
   - **review gate 文件**（`AiReviewGate.task_node_id` 引用，`REVIEW_GATES_DIR`）
   - **decision request 文件**（`AiDecisionRequest.task_node_id` 引用）
   - `delivery.task_node_ids` 数组中移除该 id
3. 若其他 task_node 的 dependencyIds 引用了它，自动移除（不是直接报冲突），并调用**扩展后的** `refresh_ready_task_nodes`（含 demote 回退）重算受影响任务状态
4. `append_event("taskNodeDeleted", ...)`

#### 3.4.3 前端编辑器

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

#### 3.4.4 接入点

- DAG 视图节点点击 → 右侧抽屉 → 编辑（**T3 与 T4 的交汇点**）
- 列表视图卡片操作菜单增 `编辑任务` 项
- T2 的 `TaskCreateDialog` 抽出共用的 `TaskNodeFields` 组件，避免 `TaskCreateDialog` 和 `TaskNodeEditor` 重复实现

#### 3.4.5 审计事件展示

`AiDeliveryEvent` 列表新增两种事件卡片：
- `taskNodeEdited`：显示 diff（"title: 'A' → 'B'"）
- `taskNodeDeleted`：灰底带删除线

### 3.5 迭代 1：完整文件改动清单

#### 3.5.1 新增

| 文件 | 用途 |
|------|------|
| `src/components/ai-delivery/TaskDagView.tsx` | DAG 视图容器 |
| `src/components/ai-delivery/TaskNodeCard.tsx` | 自定义 ReactFlow 节点 |
| `src/components/ai-delivery/TaskNodeEditor.tsx` | 任务节点编辑抽屉 |
| `src/components/ai-delivery/AttemptLiveTerminalDialog.tsx` | 实时终端查看 |
| `src/components/ai-delivery/utils/taskGraphLayout.ts` | 拓扑分层布局算法 + 缓存 |
| `src/components/ai-delivery/utils/taskNodeDiff.ts` | 审计事件 diff 渲染 |

#### 3.5.2 修改

| 文件 | 改动 |
|------|------|
| `src-tauri/src/models/ai_delivery.rs` | `AiTaskNode.timeoutSeconds`、`AiAgent.defaultTimeoutSeconds`、`AiTaskContract.dirty`、`AiAttemptOutput.isLive/liveOutputTail`、`UpdateAiTaskNodeInput` |
| `src-tauri/src/commands/ai_delivery.rs` | 新增 `update_ai_task_node`、`delete_ai_task_node`（**不新增** `get_ai_default_timeout_seconds`） |
| `src-tauri/src/services/ai_delivery_service.rs` | monitor 线程 `drain` 增量追加写 live-output.log（结束时 transcript 为空改以 live-output.log **尾部 20k 字符**兜底）；watchdog 接入 timeout（spawn 时快照 task/agent 超时值，起算点维持 `started_at`）+ approachingTimeout 事件；全局 `APP_HANDLE: OnceLock<AppHandle>` 注入 + `append_event` 统一 emit + 清理 12 处重复 emit；关键节点系统通知；**扩展 `refresh_ready_task_nodes` 支持 ready→planned 回退（demote）**；**`create_task_node` 与 `update_task_node` 共用环依赖检测 helper**；**`retry_task_node` 去掉 min(10) 钳制（含 2433-2434 动态提额基准同步调整）+ 状态白名单放行 policyViolation**；新增 `update_task_node`、`delete_task_node`（含依赖变更后状态重算）；`#[cfg(test)]` 环依赖检测单测 3 例（自环/间接环/复杂环） |
| `src-tauri/src/commands/terminal.rs` | `TerminalInstance` 新增 `ai_delivery` 标记（`create_ai_terminal` 置位，注意 3 个调用点）；`drain_terminal_output` 对 ai_delivery 终端只读（返回缓冲、不消费），其余行为不变——既有标签页路径的 drain 不再破坏 live-output.log |
| `src-tauri/src/web/handlers/ai_delivery_handler.rs` | 仅暴露 GET live output（**本轮不做 task_node 的 PUT/DELETE Web API**，PC 端优先，后续迭代补齐） |
| **`src-tauri/src/web/server.rs`** | **注册 GET output 新路由（AI 交付 REST 区块 49-96 行内追加，遗漏即 404）** |
| `src/services/tauri.ts` | 新增 TS 命令封装 |
| `src/types/aiDelivery.ts` | 类型同步 |
| `src/components/ai-delivery/DeliveryDetail.tsx` | 接入 DAG 视图切换 + 编辑入口 + 实时终端按钮 |
| `src/components/ai-delivery/TaskDeliveryDialogs.tsx` | 抽出 `TaskNodeFields` 共用组件 |
| `src/components/ai-delivery/ConfigDialog.tsx` | Agent 配置区新增 `defaultTimeoutSeconds` 输入 |
| `src/components/ai-delivery/AiDeliveryWorkspace.tsx` | 事件列表渲染 taskNodeEdited/Deleted |
| **`src/components/ai-delivery/workspace-utils.ts`** | `eventTypeNames` 注册 `approachingTimeout` / `taskNodeEdited` / `taskNodeDeleted` 中文名（不注册则事件列表显示原始英文串；现有注册表 168-215 行共 **46** 项，`attemptTimedOut` 已注册（195）但后端从不产生——见 §6.6 N14） |
| `package.json` | 新增 `@xyflow/react` |

#### 3.5.3 不用动

- `AttemptOutputDialog`（静态成果查看，继续保留）
- watchdog 整体结构（只调整超时计算、告警节点与加载逻辑；时间常量在 service 49-52 行）
- `read_attempt_output` 主体逻辑（只在末尾补 is_live / live_output_tail）

### 3.6 迭代 1：关键风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| DAG 节点 > 50 时性能 | 中 | 强制缩略图模式 + 折叠分组 |
| `dependencyIds` 环检测算法 bug | 中（破坏整个交付） | 写 3 个单元测试：自环、间接环、复杂环（V 形 + 分叉），落位 `ai_delivery_service.rs` 内 `#[cfg(test)]` 模块（**已有先例**：`agent_decision_tests` 5110-5111、`terminal_command_tests` 5991-5992 两个测试模块，测试设施可在 tauri 环境下独立编译运行），DoD 以 `cargo test` 通过为准 |
| 编辑后 contract 与 attempt 状态不一致 | 高 | 运行中（queued/running）任务禁止编辑；failed/rework 编辑执行相关字段后标脏 contract，重试时重新审计/重建；**同步清理该任务未决的 review gate / decision request**；diff 事件留痕 |
| 运行中编辑被禁 → 「编辑提高重试上限」提示失效 | 高 | 3.4.2 状态约束已放行 failed/rework/cancelled 编辑，本风险消除；DoD 增加对应验收项 |
| 实时输出落盘 IO | 低 | monitor `drain` 独占消费 + 增量追加（每次 300ms 一个输出块），PC 端主走事件流，文件仅兜底；**前端 drain 竞态由后端豁免消除（`drain_terminal_output` 对 AI 终端只读）**；历史与事件流交接无丢失（有毫秒级重复，已接受） |
| 依赖增删后下游状态陈旧 | 中 | update/delete 后统一调用**扩展后的 `refresh_ready_task_nodes`**（含 demote 回退）重算；DoD 加对应验收项 |
| live-output.log 无限增长 | 低 | **写入侧截断：文件超过 5MB 时保留尾部一半再续写**（读取侧维持 8000 字符尾部；原「复用 8000 截断」是读取端行为，不解决写入增长）；attempt 清理时随目录删除 |
| xterm.js 与现有 CSS 主题不一致 | 低 | 复用 `data-theme` 属性，已在 terminal 组件用过 |
| 新 Web 路由未注册 → 404 | 低 | server.rs 列入改动清单并在 DoD 加 Web 冒烟项 |

### 3.7 迭代 1：完成定义（DoD）

- [ ] 用户能在 DeliveryDetail 看到 DAG 视图切换，10+ 节点时依赖关系一目了然
- [ ] 运行中的 attempt 可点按钮实时查看 xterm 日志（事件流，无轮询延迟）
- [ ] **AI 终端从任意入口（标签页 / 实时弹窗）打开均不破坏 live-output.log 落盘**（`drain_terminal_output` 后端豁免生效）
- [ ] 创建/编辑任务节点时可设置超时，留空时使用 Agent 默认，**80%** 时任务卡片显示橙色「即将超时」徽章（与 `TIMEOUT_WARNING_RATIO` 一致）
- [ ] `approachingTimeout` 事件实时到达（append_event 统一 emit，无 4 秒轮询延迟）
- [ ] Agent 配置区可设置默认超时，创建任务对话框的提示文案动态显示该默认值
- [ ] 编辑任务节点后事件列表出现 `taskNodeEdited` 带 diff
- [ ] **运行中的交付里，failed/rework/cancelled 任务可编辑（提高 retryCount 后重试成功，含 10 次用尽后提高到 11+ 的场景）** —— 修复「编辑提高上限」提示死路（依赖 `retry_task_node` 去掉 min(10) 钳制，3.4.2 第 10 条）
- [ ] 编辑状态约束边界：queued/running/succeeded/awaitingReview 拒绝编辑；needsInput 可编辑且其未决 decision request 保留（删除会导致任务永久卡死，仅清理未决 review gate）；**policyViolation 可编辑（同 failed）且重试白名单放行，不留死路状态**
- [ ] 删除任务节点后 contract、attempt 目录、review gate、decision request 均被清理，`delivery.taskNodeIds` 同步移除，引用它的 dependencyIds 自动移除
- [ ] **编辑/删除任务节点（含依赖增删）后，下游任务状态被扩展后的 `refresh_ready_task_nodes` 重算**（依赖满足 promote 到 ready / 依赖失效（含依赖被删）demote 回退 planned，列表与 DAG 视图一致）
- [ ] 环依赖检测阻止保存（create 与 update 两路径均生效）
- [ ] 运行时长与超时起算点均基于 `startedAt`（`start_attempt` 置 running 时重打点，排队时间不计入，前端展示与 watchdog 一致）
- [ ] 超时终止、交付收尾、合并冲突/成功有系统托盘通知，点击可跳转对应交付
- [ ] `cargo test` 通过（环依赖检测 3 例）、`cargo check` 通过、`tsc --noEmit` 通过
- [ ] Web 端能看实时终端（轮询 liveOutputTail，验证 HTTP 路径通即可）

---

## 4. 迭代 2（P1）

> 格式说明：**现状**（证据/代码位置）→ **实施要点** → **涉及文件** → **验收标准**。

### 4.1 N1 交付事件推送微信/飞书

**现状**：出站通道与数据俱在，缺约 100 行接线。微信：`bot_weixin_service.rs:296` `send_weixin_text_with_id`、`:345` `send_weixin_reply`（内部调 296）、引用回复解析 371-412（`extract_weixin_reply_to`：371-378 `marker_from_text` 解析 WEIXIN_REPLY_MARKER，394-409 回退探测 message_id/client_id/msg_id 指针）；飞书 webhook：`web/handlers/bot_handler.rs:66` `feishu_events`（含 challenge 校验、card.action.trigger 与 im.message.receive_v1 分支）。AI 交付对外通知仅 Windows Toast（`commands/notification.rs:91`，仅 2 处调用 `commands/ai_delivery.rs:263`、`ai_delivery_service.rs:2966`）。

**实施要点**：
1. 事件挂接：决策请求创建/已答、任务失败、合并完成、交付成功 → 推送配置的聊天（与 T2 通知补齐的挂接点同源）
2. 聊天内直接回复决策：复用引用回复解析（371-412），引用回复内容作为 answer 调用 `answer_decision`
3. 推送目标配置（微信 id / 飞书 webhook）持久化到设置

**涉及文件**：`ai_delivery_service.rs`、`bot_weixin_service.rs`（复用）、`web/handlers/bot_handler.rs`（复用）、设置存储与配置 UI

**验收标准**：
- 决策请求/任务失败/合并完成/交付成功均到达配置的聊天
- 聊天内引用回复可回答决策并驱动决策状态更新

### 4.2 N2 Web 端操作补齐

**现状**：后端 12 条 REST 路由已全部注册实现（`web/server.rs:49-96`，明细见 §5.5）；`web/api.ts:93-97` 仅封装 5 个（`getAiDeliveryProjects` / `getAiDeliveries` / `getAiDeliverySnapshot` / `approveAiDelivery` / `answerAiDecision`）；Web 页面文案自述「仅观察、批准任务图和回答决策」（`AiDelivery.tsx:38`）。含决策**自由文本回答**缺口：后端接受任意 answer 字符串，Web 只有选项按钮（`AiDelivery.tsx:40` 仅 `decision.options.map(button)`，无 textarea；桌面端有 textarea，`DeliveryDetail.tsx:412-421`）。

**实施要点**：
1. `web/src/api.ts` 补封装 7 个接口：create/plan/dispatch/complete/merge/cleanup-integration/retry
2. `web/src/screens/AiDelivery.tsx`（及所属组件）补对应操作入口：创建交付、重新规划、派发、手动完成、合并、清理集成、重试
3. 决策回答补自由文本 textarea
4. **零后端工作量**

**涉及文件**：`web/src/api.ts`、`web/src/screens/AiDelivery.tsx`、`web/src/` 相关组件

**验收标准**：
- Web 端可完成创建交付 → 重新规划 → 派发 → 手动完成 → 合并 → 清理集成 → 重试全流程
- 决策支持自由文本回答

### 4.3 N3 质量门禁命令结果可视化

**现状**：`AiReviewGate.command_results`（models:393；`AiCommandResult` 结构 398-404，含 command/exit_code/output）随快照下发但零渲染，UI 只有一行 `gate.comments`（`DeliveryDetail.tsx:515`）——哪条门禁命令失败、输出是什么不可见。

**实施要点**：
1. 逐命令展示：通过/失败状态、退出码、输出
2. 失败命令可复制重跑
3. 纯前端

**涉及文件**：`src/components/ai-delivery/DeliveryDetail.tsx`、`src/types/aiDelivery.ts`

**验收标准**：
- 审查环节可看到每条门禁命令的退出码与输出
- 失败命令可复制

### 4.4 N4 policyViolation 一键恢复

**现状**：`finish_attempt` 3042-3049/3073-3084 置态（`audit_contract_scope` 调用点 2993、定义 4520-4553 越界写入触发）；`retry_task_node` 白名单（2404）不含 → 任务永久卡死。迭代 1 T4 已放行「编辑+重试」作为绕路（重试白名单扩为 failed|rework|cancelled|policyViolation 属 T4 范围）。

**实施要点**：
1. 新增「确认现场，继续验收」命令：标记现场可接受、重跑验收
2. 新增「标记忽略(skipped)」：与失败聚合/标记忽略项共用同一实现（§4.8）

**涉及文件**：`ai_delivery_service.rs`（新命令 + skipped 状态处理）、`commands/ai_delivery.rs`、任务卡片 UI

**验收标准**：
- policyViolation 任务可一键确认现场并重跑验收
- policyViolation 任务可标记 skipped，不阻塞后续合并

### 4.5 N5 合并记录详情面板

**现状**：`AiMergeRepositoryRecord` 499-508（branch_name 501 / pre_merge_head 502 / merged_head 504 / error 507）与 `AiMergeRecord.repositories`（实际在 517 行）UI 只显示一行 state（`DeliveryDetail.tsx:364-365`）——冲突时看不到哪个仓库失败、卡在什么分支。

**实施要点**：
1. 逐仓库展示：branchName / preMergeHead / mergedHead
2. 失败仓库高亮 error
3. 纯前端

**涉及文件**：`src/components/ai-delivery/DeliveryDetail.tsx`、`src/types/aiDelivery.ts`

**验收标准**：
- 合并冲突时可看到每个仓库的分支、合并前后 commit 与失败原因

### 4.6 批量操作

**现状**：重试/取消/审核均为逐任务操作（派发为整批 `dispatchAiReadyTasks`，`tauri.ts:664-665`），20+ 任务的失败重试/取消逐个操作繁琐。

**实施要点**：
1. 复选框多选（Shift 连选），批量派发/重试/取消
2. 按阶段派发：基于 workflowStepId 筛选（如「只派发第一阶段」）
3. 一键重试所有 failed/rework 任务
4. 操作结果汇总（成功/失败计数）

**涉及文件**：`src/components/ai-delivery/AiDeliveryWorkspace.tsx`、`workspace-utils.ts`、`src/services/tauri.ts`

**验收标准**：
- 多选后可批量派发/重试/取消；结果汇总展示成功与失败计数

### 4.7 交付模板

**现状**：每次交付从零选择工作流、填写需求；重复场景多（新增 CRUD 接口、前端页面改版、数据库迁移）。

**实施要点**：
1. 新增 `AiDeliveryTemplate` 模型：`{name, description, workflowId, qualityGate, roleMappings, commonPrompt}`
2. 参数化占位符：`{featureName}`、`{moduleName}`，创建时替换
3. 从已完成交付「保存为模板」，自动提取配置
4. 创建对话框模板选择 + 管理入口（重命名、删除）

**涉及文件**：`models/ai_delivery.rs`、`ai_delivery_service.rs`、`commands/ai_delivery.rs`、`src/components/ai-delivery/TaskDeliveryDialogs.tsx`、`src/types/aiDelivery.ts`、`src/services/tauri.ts`

**验收标准**：
- 可从已完成交付保存模板；创建时选模板自动填充字段；占位符替换生效

### 4.8 失败聚合 + 标记忽略 / 带参重试

**现状**：重试只是重置 state 再派发，无法调整参数；同类错误重复报警。

**实施要点**：
1. 带参数重试：重试时允许修改 taskPrompt / preferredAgentId / retryCount（字段能力已由 T4 的 `update_task_node` 提供，此处为重试对话框入口）
2. 自动重试达到上限后**暂停交付并通知**，不直接标记失败
3. 失败聚合：如「3/12 失败，根因: npm registry 不可达」（attempt.summary 文本聚类）
4. 手动标记忽略(skipped)，不阻塞后续合并（与 N4 共用实现）

**涉及文件**：`ai_delivery_service.rs`、`commands/ai_delivery.rs`、前端交付列表与详情

**验收标准**：
- 自动重试触顶后交付暂停并通知
- 失败聚合信息在 UI 可见；skipped 任务不阻塞合并

---

## 5. 迭代 3（P2）

### 5.1 交付统计面板

**现状**：只有列表，缺少统计视角。

**实施要点**（统计项）：
1. 交付成功率（按 state 统计 succeeded 占比）
2. 任务成功率（首次 vs 重试后）
3. 平均执行时长（按 Agent/角色/仓库维度）
4. 最常见失败原因（attempt.summary 文本聚类）
5. Agent 调用统计（调用次数、总耗时、成功率）

**实现位置**：`AiDeliveryApp` 新增「统计」标签页，或 `AiUsagePanel` 基础上扩展。

**验收标准**：五个统计项均有数据展示

### 5.2 增量 Diff 审查

**现状**：审批者只能看评审文本，看不到代码变更。Monaco 已集成（`@monaco-editor/react` ^4.7.0），依赖就绪。

**实施要点**：
1. 嵌入 Monaco Diff Editor 展示 `git diff baseCommit...HEAD`
2. 审批者在 diff 行上添加评论，关联 reviewGate 存储

**验收标准**：审批时可查看代码变更；行评论随 reviewGate 持久化

### 5.3 Agent 启动预设管理

**现状**：`AiAgent.startup_preset_name` 字段存在（models:117-118）但**后端全库无任何读取逻辑**（仅 4 处出现：lib.rs:364 创建时硬编码 `Some("AI 交付自动批准")`、service 7313 质量门禁生成器构造与测试模块 5484/6013 共 3 处 `None` 赋值）。**「死字段」不成立**：前端 `ConfigDialog`「套用参数预设」下拉（ConfigDialog.tsx:697-720）选中预设即经 `saveAgentConfig` → `saveAiAgent` 整对象落盘写入非 `None` 值（`save_agent` service 524-543 无字段剥离）；预设实体存客户端数据 `extra_param_presets`（appStore:1071-1081 写入、`AiDeliveryWorkspace.tsx:266` 经 `readClientData` 读取）。缺的环节是**派发时应用预设内容**与 AI 交付侧的预设管理形态（§6.6 N19 的「落地」即本项）。

**实施要点**：
1. 预设 CRUD：`{name, promptPrefix, modelArgs, contextStrategy}`
2. Agent 配置与预设关联，派发时应用

**涉及文件**：`models/ai_delivery.rs`、`commands/ai_delivery.rs`、`src/components/ai-delivery/ConfigDialog.tsx`、`src/types/aiDelivery.ts`

**验收标准**：预设可创建/编辑/删除；Agent 可选预设；派发时应用预设内容

### 5.4 工作流步骤预览和测试

**实施要点**：
1. 工作流预览（展示预期任务拓扑）
2. 拖拽排序
3. 单步骤模拟测试

**验收标准**：配置工作流时可预览任务拓扑；可排序；可单步模拟

### 5.5 缺失 REST 路由补全

**现状**：12 条 REST 路由已全部注册（`web/server.rs:49-96`，明细如下）；本项补齐**缺失**的后端路由（区别于 N2 的纯前端补齐）。

现有 12 条路由（method + path）：

| # | 路由 | handler |
|---|------|---------|
| 1 | GET `/api/ai-delivery/projects` | projects |
| 2 | GET `/api/ai-delivery/projects/{project_id}/deliveries` | deliveries |
| 3 | GET `/api/ai-delivery/deliveries/{id}` | snapshot |
| 4 | POST `/api/ai-delivery/deliveries/{id}/approve` | approve |
| 5 | POST `/api/ai-delivery/decisions/{id}/answer` | answer_decision |
| 6 | POST `/api/ai-delivery/deliveries` | create_delivery |
| 7 | POST `/api/ai-delivery/deliveries/{id}/plan` | plan |
| 8 | POST `/api/ai-delivery/deliveries/{id}/dispatch` | dispatch |
| 9 | POST `/api/ai-delivery/deliveries/{id}/complete` | complete_attempt |
| 10 | POST `/api/ai-delivery/deliveries/{id}/merge` | merge |
| 11 | POST `/api/ai-delivery/deliveries/{id}/cleanup-integration` | cleanup_integration |
| 12 | POST `/api/ai-delivery/deliveries/{id}/retry` | retry_task |

**实施要点**：
1. `PUT /api/deliveries/:id`（编辑交付需求）
2. `PUT /api/deliveries/:id/tasks/:taskId`、`DELETE /api/deliveries/:id/tasks/:taskId`、`POST /api/deliveries/:id/tasks`（任务编辑/删除/手动添加——服务层命令已由 T4 提供，只差 REST 包装）
3. 在 `web/server.rs` 注册（AI 交付区块 49-96 行内追加）

**验收标准**：REST 覆盖创建/规划/派发/编辑/删除/完成/合并/重试全流程；Web 冒烟通过

### 5.6 N6 needsInput 重启恢复

**现状**：`recover_interrupted_attempts`（1646-1690，过滤只含 queued/starting/running 在 1649）重启后 needsInput attempt 带死 terminal_id 变僵尸记录。**另注意**：该函数含特殊分支（1655-1662）：manager attempt（task_node_id 为空）且交付在 planning/awaitingApproval 时走 `fail_delivery_planning` 回草稿，而非普通取消。

**实施要点**：
1. 重启时对 needsInput attempt 标记中断并清理死终端引用
2. 回答决策时自动归档旧 attempt

**验收标准**：重启后 needsInput 任务不再僵尸；可正常恢复

### 5.7 N7 合并失败交付终态

**现状**：merge 失败（`merge_delivery_locally_locked_impl` 2224 行 return Err）不落交付状态；auto 路径 `try_complete_workflow_delivery`（3358-3399）先置 succeeded（3367）失败不回滚，仅 append `autoMergeFailed`（3389-3396；`finish_attempt` 内同模式：3153 置 `delivery.state = "succeeded"`、3179-3185 append `autoMergeFailed`，另 3170 为成功侧 `autoMerged`）；前端「失败/合并中/已阻塞」筛选（`workspace-utils.ts:81-123`）注册但永不命中（"merging"/"blocked" 是 merge 记录状态，非 delivery 状态）。另注：`merge_delivery_locally` 是三层结构（1965 薄封装 → `merge_delivery_locally_locked` 1987 失败清理集成工作区 → `merge_delivery_locally_locked_impl` 1999-2247，含合并前 `validated_commit` HEAD 校验 2151-2163 与失败回滚 2205-2224）。

**实施要点**：
1. 合并失败置可辨识终态（如 `mergeFailed`）
2. 前端筛选生效
3. 与 N5、§6.3 合并冲突续接联动

**验收标准**：合并失败交付显示可辨识终态；前端「失败/已阻塞」筛选命中

### 5.8 N8 已答决策历史视图

**现状**：`AiDecisionRequest.answer`（models:466）从不展示，只渲染 pending 决策（`AiDeliveryWorkspace.tsx:846`，`decisionRequests.filter(r => r.state === "pending")`，answered 状态请求无任何渲染）。

**实施要点**：新增决策历史列表：问题/选项/回答/时间

**验收标准**：已答决策在 UI 可见，含答案与时间

### 5.9 N9 事件/列表「查看全部+搜索+分页」

**现状**：事件 slice(-20)（`AiDeliveryWorkspace.tsx:897`）、attempt 事件 slice(-160)（`DeliveryDetail.tsx:634`）、内存上限 slice(-500)（:395）——长交付早期事件不可达，标题数字与可见条数不一致。

**实施要点**：统一查看全部 + 搜索 + 分页 + 虚拟滚动

**验收标准**：早期事件可访问；标题数字与可见条数一致

### 5.10 N10 事件文件滚动清理

**现状**：`append_event` 每次一文件、无数量/体积上限（3417）；`get_delivery_events` 每次全量读（1447-1454）；watchdog 巡检事件（6491）长任务累积。

**实施要点**：
1. 按交付保留最近 N 条事件 + 体积上限
2. attempt 运行目录随清理删除

**验收标准**：数据目录不再无限增长；清理后事件列表仍完整可用

### 5.11 N11 规划中断「以当前状态重跑」

**现状**：`ensure_project_repository_statuses_unchanged`（4499-4518）仓库被改动阻断规划（错误文案 4513-4516），经 `plan_delivery_with_manager`（979 起，1013 为其内部仓库状态校验调用）→ Err 分支 1091-1094 → `fail_delivery_planning`（定义 938）直接回草稿（948 行置 drafting），只能手动清理后重来。

**实施要点**：新增「对比基线 → 采纳当前状态 → 重新规划」入口

**验收标准**：仓库被改动时无需手动清理，可采纳当前状态继续规划

---

## 6. 迭代 4+（P3）

### 6.1 产物归档与对比

**实施要点**：
1. 交付详情「产物」Tab 列出 plan.json / transcript.log / review.json 等
2. 跨交付 plan.json 并排对比（Monaco Diff Editor，依赖已就绪）
3. ZIP 打包下载全部产物

**验收标准**：产物可浏览、可跨交付对比、可打包下载

### 6.2 资源感知调度

**现状**：项目级与 Agent 级并发控制已存在（`check_capacity`，3299-3354：`get_all_attempts` 全量读 + 每 attempt 读 delivery/contract）。

**实施要点**：
1. 全局并发上限（跨项目总并发数限制）
2. 资源感知调度（CPU/内存高负载时延迟派发）
3. 任务优先级队列（高/中/低）

**验收标准**：全局并发上限生效；高负载时派发延迟

### 6.3 后续候选（原 iteration-1-plan §9 扫描发现，纳入本档）

> 来源：2026-08-02 对 `ai_delivery_service.rs`（7460 行）与前端工作区的全面扫描。已并入迭代 1 的项：attempt 时长口径（v3 核实后撤回：`started_at` 置 running 时重打点，无需 `actual_started_at`）、系统通知全覆盖（→ T2）。

| 候选 | 痛点与证据 | 排期 |
|------|-----------|------|
| 依赖基线版本校验 | 质量门禁失败把依赖置 rework（3200-3213 行，`return_review_dependencies_for_rework` 3195-3227，仅限 succeeded 依赖 3205-3207），下游已 succeeded 任务不失效，重派发只查分支存在（`allocate_task_worktree` 3495 起，其依赖分支检查块 3544-3551 仅检查 branch_name 存在性）不校验提交版本 → 下游基于过期基线执行。**与 T4 编辑能力强相关（改 DAG 更易触发）** | 迭代 2，优先 |
| 合并冲突续接 | 冲突 → 仓库子记录 `state = "failed"`（2206 行，`AiMergeRepositoryRecord` 层；记录级 `AiMergeRecord.state` 无 `failed` 赋值，见 §1.4/§9 第 44 条），无「冲突已解决，继续合并」入口，只能整体重来。与 N5（详情面板）、N7（mergeFailed 终态）联动 | 迭代 2 |
| 候选 Agent 无容量自动补派 | `select_agent` 无容量直接报错（3271-3286 行；函数起始 3229；无容量报错 3244），任务停 ready 需手动再点；`dispatchDeferred` 事件已存在但无自动重试 | 迭代 2 |
| 失败任务下游级联处理 | 依赖须全 succeeded 才 ready（1426-1430），依赖失败后下游永久 planned、交付无法收尾；补「标记忽略(skipped) + 级联跳过 + 局部失败收尾判定」（与 N4/§4.8 共用实现） | 迭代 2 |
| 交付收尾报告 | 完成后自动生成：成功率/重试/返工链、实际耗时、合并分支与 commit、遗留问题；数据全在现有模型，前端报告 tab + 导出 Markdown | 迭代 2 |
| 完整 transcript 回放 | 执行完成后只有 8000 字符 tail（1597-1608 截断）；补全量查看 + 搜索 + 虚拟滚动 | 迭代 2 |
| 交付资产导出/备份 | 全 JSON 散文件，一键导出项目+交付+产物为 ZIP（可导入）；`path_service.rs` 已有 `copy_dir_recursive`（82-95，**模块级自由函数**非方法） | 迭代 3 |
| 无头/命令行交付模式 | `--ai-delivery <项目> <需求> [--approve] [--notify]` 全流程，配合通知实现 CI 式用法 | 迭代 3 评估 |

### 6.4 N12 attempt 运行时长展示

**现状**：`AiAttempt.finishedAt`（models:372）闲置，卡片只显示 startedAt（`DeliveryDetail.tsx:641-642`；类型与模型均有 finishedAt 字段，UI 未渲染，无时长计算）。

**实施要点**：卡片显示运行时长与完成时间

**验收标准**：attempt 卡片可见运行时长与完成时间

### 6.5 N13 错误本地化 + banner 重试

**现状**：错误信息直接透传遍布（`AiDeliveryWorkspace.tsx:369` 为纯 `setError(String(reason))`；326/381/418/565 为 `reason instanceof Error ? reason.message : String(reason)`，先取 `Error.message` 再回退字符串——均未做分类与可操作提示）；4 秒轮询失败静默吞掉（:386，`.catch(() => undefined)`）。

**实施要点**：
1. 错误分类与可操作提示（「如何修复」文案）
2. 错误 banner 重试按钮
3. 轮询失败不再静默

**验收标准**：错误显示分类与操作提示；banner 可触发重试

### 6.6 N14-N21 小项打包

| # | 项 | 现状/证据 | 实施 |
|---|----|-----------|------|
| N14 | attemptTimedOut 事件生效 | `workspace-utils.ts:195` 已注册中文名「任务超时」、后端从不 emit（超时走 attemptFailed，6281-6292 → 6410-6417） | **并入迭代 1 T2**：watchdog 超时改 emit attemptTimedOut，前端染色即生效 |
| N15 | ai-delivery-decision 死事件通道 | `commands/ai_delivery.rs:262/279` emit、前端无人监听（tauri.ts 的 **AI 交付相关**监听仅 ai-delivery-event 一个通道，`onAiDeliveryEvent` 657 行——全库 `listen` 共 11 处（terminal_output_{id}/claude-notification-activated/git_push_output 等），均非 ai-delivery-decision；全 src 无 ai-delivery-decision 字样，见 §9 第 49 条） | 删除该通道，或补前端监听 |
| N16 | cancel_delivery 事件一致性 | 1362-1374 逐 attempt 循环**不产生** attemptCancelled 事件，事件流只有一条 deliveryCancelled（1405-1411）。**修正**：函数实际还改写 attempt（1369）/task（1379）/contract（1390）/decision request（1398）文件置 cancelled，但确实无逐 attempt 事件 | 补逐 attempt 事件 |
| N17 | 统一 dispatch+start helper | **共 8 处**（原文档 7 处）：`commands/ai_delivery.rs` 2 处（resume 221-227 / answer 282-288）、`ai_delivery_handler.rs` 5 处（89-95 / 114-116 / 195-197 / 250-260 / 285-300）、`lib.rs` setup 恢复块 1 处（388-423，dispatch 在 393、start_attempt 在 402-406，非命令注册区；另有 343-387 `#[cfg(debug_assertions)]` debug-only 测试派发块）。**错误处理两种风格**：吞错共 5 处——handler approve/answer/complete 3 处 `unwrap_or_default()`（89/114/195）+ commands resume/answer 2 处 `let _ = start_attempt(...)` 丢弃结果（221-227/282-288，见 §9 第 48 条）；handler retry/dispatch 与 lib.rs 用 `map_err(ApiError::BadRequest)?` / `match` + `eprintln`/`boot_log` 记日志 | 提取统一 helper；顺带修 Web 端静默失败（approve/answer/complete 3 处） |
| N18 | check_capacity 索引 | 3299-3354 每次派发对全部 attempt 做 O(N) 文件读（含每 attempt 读 delivery/contract） | 内存活跃 attempt 计数/索引 |
| N19 | 死字段清理/落地 | `AiProject.profile_id`（55 行，业务写入仅 service 274 复制、业务代码无读取逻辑；另有测试 `replans_legacy_delivery_without_overwriting_history`（函数 5349 起，`#[test]` 5348）内 AiProject 字面量 `profile_id: None`（5358 行），5494 为 `CreateAiProjectInput` 输入字段非本结构体）；`AiDelivery.task_node_ids`（283-284，使用点均在 service 内，无外部读取方）；`AiAgent.startup_preset_name`（117-118，**非死字段**——前端 ConfigDialog 预设套用已可写入非 None，见 §5.3；缺派发时应用，随 §5.3 落地） | 清理前两者；后者随启动预设管理落地 |
| N20 | 注释与实现不一致修复 | models:445-447 注释声称 prompt「前 500 字符摘要」，实现（service:1631-1632）读取全文（`// prompt.txt — 完整内容` + 无截断） | 修注释或真截断 |
| N21 | Runtime 版本号展示 | `AiRuntimeProbe.version`（models:92，91 行为 serde 属性）导航栏不显示 | 导航栏展示版本号 |

**验收标准（打包项）**：
- N14：超时任务触发 attemptTimedOut 事件，前端染色生效
- N15：无死事件通道（删除或补监听）
- N16：取消交付产生逐 attempt 的 attemptCancelled 事件
- N17：单点 helper，Web 端派发错误不再静默吞掉
- N18：多交付并发时派发不再 O(N) 读盘
- N19：无未消费字段（除随 §5.3 落地的字段外）
- N20：注释与实现一致
- N21：导航栏显示 Runtime 版本

### 6.7 交付暂停与恢复增强（待评估）

**现状**：pause/resume 已存在，暂停时强制终止。

**实施要点**：优雅等待任务到检查点，保留 worktree 状态。

**估算**：待评估，实施前先确认收益与复杂度。

---

## 7. 涉及文件索引

### 7.1 后端（Rust，`src-tauri/src/`）

| 文件 | 说明 |
|------|------|
| `models/ai_delivery.rs` | AI 交付所有数据模型定义（520 行） |
| `services/ai_delivery_service.rs` | 核心业务逻辑（**7460 行**，含 `#[cfg(test)]` 测试模块：`agent_decision_tests` 5110-5111、`terminal_command_tests` 5991-5992） |
| `commands/ai_delivery.rs` | Tauri 命令注册（invoke_handler 中共 53 个 ai_delivery 命令，lib.rs 487-539 行注册区） |
| `commands/ai_usage.rs` | AI 用量查询命令 |
| `commands/terminal.rs` | TerminalInstance（116-130，含 owner）/ drain_terminal_output（862-873）/ reader 线程 emit（388-392）/ check_pc_permission（905-916，Web 会话隔离） |
| `commands/notification.rs` | 系统托盘通知（91-116，标题硬编码；T2 需加 title 参数） |
| `web/handlers/ai_delivery_handler.rs` | Web API 处理器（5 处 dispatch+start 复制，N17） |
| `web/server.rs` | axum 路由注册（AI 交付 REST 区块 49-96 行，12 条路由，明细见 §5.5；注意区块外中文注释为历史编码乱码——UTF-8 中文被按 GBK 解码成乱码字符后固化落盘，AI 交付区块内无注释，不影响编译与路由） |
| `web/handlers/bot_handler.rs` | 飞书 webhook（feishu_events 66 行） |
| `services/bot_weixin_service.rs` | 微信推送通道（296/345/371-412，N1 复用） |
| `services/path_service.rs` | copy_dir_recursive（82-95，模块级自由函数） |

### 7.2 前端（React/TypeScript，`src/`）

| 文件 | 说明 |
|------|------|
| `components/ai-delivery/AiDeliveryApp.tsx` | AI 交付独立窗口根组件 |
| `components/ai-delivery/AiDeliveryNav.tsx` | 左侧导航栏 |
| `components/ai-delivery/AiDeliveryWorkspace.tsx` | 主工作区（任务列表/事件列表/轮询/决策渲染/批量派发入口） |
| `components/ai-delivery/DeliveryDetail.tsx` | 交付详情（事件 tab/attempt 卡片/merge 行/gate 行/决策 textarea 412-421） |
| `components/ai-delivery/TaskDeliveryDialogs.tsx` | 4 个对话框：TaskContractDialog(20)/TaskCreateDialog(126，有 retryCount 无 timeout)/DeliveryCreateDialog(283)/DeliveryEditDialog(399) |
| `components/ai-delivery/ConfigDialog.tsx` | Agent 配置对话框 |
| `components/ai-delivery/AttemptOutputDialog.tsx` | 静态成果查看（只读 Monaco） |
| `components/ai-delivery/AiDeliveryFloatingButton.tsx` | 悬浮按钮（补充，原文档未列） |
| `components/ai-delivery/ProjectDialogs.tsx` | 项目对话框（补充，原文档未列） |
| `components/ai-delivery/workspace-utils.ts` | 事件类型/状态中文名注册（168-215，**46** 项）、筛选注册（81-123）、failedEventTypeSet（217-219） |
| `components/ai-delivery/AiDeliveryWorkspace.css` | ai-status-chip 等样式（1090-1098） |
| `components/terminal/TerminalInstance.tsx` | 通用终端标签组件（1220 无条件 drain——T1 后端豁免针对此路径） |
| `types/aiDelivery.ts` | TypeScript 类型定义（AiDelivery 172-185/AiTaskNode 187-211/AiAttempt 213-228/AiAttemptOutput 241/AiReviewGate 257/AiDecisionRequest 274/AiDeliveryEvent 295-303/AiMergeRecord 314；state 均为裸 string 非联合类型） |
| `services/tauri.ts` | Tauri 命令封装与事件监听（onTerminalOutput 362-368/onAiDeliveryEvent 657/readAiAttemptOutput 660-661） |
| `components/settings/AiUsageSettings.tsx` | AI 用量配置 |
| `components/settings/AiUsagePanel.tsx` | AI 用量面板 |

### 7.3 Web 端（`web/src/`）

| 文件 | 说明 |
|------|------|
| `api.ts` | REST 客户端封装（93-97 行仅 5 个，N2 补全） |
| `screens/AiDelivery.tsx` | Web 端交付主界面（32 行 5 秒轮询 snapshot；38 行观察定位文案；40 行决策仅选项按钮） |

> 另有引用入口（无 AI 交付业务逻辑）：`web/src/screens/Nav.tsx:458` 导航链接、`web/src/App.tsx:8/51` 路由注册（见 §9 第 50 条）。

---

## 8. 跨项通用规范

1. **事件类型注册**：所有新事件类型必须在 `workspace-utils.ts` 的 `eventTypeNames` 注册中文名，否则事件列表显示原始英文串
2. **事件 emit**：T2 引入全局 `APP_HANDLE: OnceLock<AppHandle>` 后由 `append_event` 统一 emit `ai-delivery-event`；新增事件无需手动 emit（T2 将清理现有 12 处重复 emit，并顺带使其余约 30 处只写不 emit 的 append_event 获得实时推送，见 §9 第 47 条）
3. **系统通知**：`show_ai_delivery_notification`（notification.rs:91-116）标题硬编码「AI 交付等待决策」且无 title 参数——复用前先加 title 参数或按场景定制正文（T2 一并处理）
4. **Web 路由注册**：新 REST 路由必须在 `web/server.rs` 注册（AI 交付区块 49-96 行内追加），遗漏即 404
5. **前端事件通道**：`tauri.ts` 仅 listen `ai-delivery-event` 一个通道；引入新通道需显式补监听（或直接删除，见 N15）；`open-ai-attempt-terminal` 是 window 级 CustomEvent（非 Tauri 通道）
6. **模型约定**：serde camelCase（30 个结构体 30 处 `rename_all`，已核无遗漏）；更新输入用双 Option（`Option<Option<T>>`）区分「未提供」与「设为空」
7. **校验复用**：编辑/删除类操作复用 `create_task_node` 的既有约束校验（含环依赖检测 helper），不另写一套；注意排除其 delivery 状态校验（1202-1207）避免自锁
8. **任务状态全集**：planned / ready / queued / running / succeeded / failed / policyViolation / rework / cancelled / awaitingReview / needsInput（无 `completed`）
9. **测试设施**：单元测试落位 `ai_delivery_service.rs` 内 `#[cfg(test)]` 模块（已有先例：`agent_decision_tests` 5110、`terminal_command_tests` 5991），验收以 `cargo test` 通过为准

---

## 9. 核实修正清单（合并时发现）

> 对两份原文档的 4 路全量核实（backend service×2 / models / frontend / commands+web，共 90+ 条断言）结论：**整体可信度极高，约 85% 断言行号精确命中**。以下为需要修正或补充的点（本文档正文已按修正后表述写入）。**二次复核（2026-08-02，4 路并行核查代理 + 关键点逐行抽查）**在表格 26-38 条追加了复核新发现（正文已同步修正），核查对象为合并后本文档自身的全部行号断言。**三次复核（2026-08-02，4 路并行核查代理 + 差异点人工复核）**在表格 39-43 条追加（正文已同步修正）。**四次复核（2026-08-02，6 路并行核查代理 + 关键发现人工逐行复核）**在表格 44-51 条追加（正文已同步修正；并顺带修正了第 9/16/18/23/28/37/40/42 条中经复核确认不成立或已过时的表述）。

| # | 修正点 | 原文档表述 | 修正后事实 |
|---|--------|-----------|-----------|
| 1 | 工作区基线 | v7：min(10) 钳制与文案是**未提交改动** | **已提交**（9c74dd3）；工作区改动均为文档侧：docs/_write_plan.py 与两份原计划文档已删除（合并后清理，git 历史保留），无代码漂移，可直接实施 |
| 2 | service 行数 | ~7500 | 实际 **7460 行** |
| 3 | audit_contract_scope | 2993 | 2993 是**调用点**（finish_attempt 内），函数定义在 **4520-4553** |
| 4 | select_agent 无容量报错 | 3247 | **3244**（3247 现为 role_id 缺失报错）；3229 函数起始与 3271-3286 容量报错不变 |
| 5 | build_continuation_context | 6779 | 函数起始 **6765**，6779 是内部状态过滤行（6777-6780） |
| 6 | watchdog 时间参数 | 函数内硬编码 | **集中常量** service 49-52 行（ATTEMPT_MAX_DURATION 60min / DELAY 30s / INTERVAL 60s）——T2 改动点是常量 |
| 7 | retry_task_node 动态提额 | 未提及 | 2433-2434 已自动提高 retry_count（max(attempted+1)）——T4 去钳制后提额基准需同步改为 task.retry_count |
| 8 | cancel_delivery（N16） | 「只写状态」 | 实际改写 attempt/task/contract/decision request 文件置 cancelled；「不产生逐 attempt 事件」成立 |
| 9 | dispatch+start 复制（N17） | 7 处 | **8 处**（commands 2 + handler 5 + lib.rs setup 1）；错误处理两风格：吞错 5 处 vs `map_err?`/match+log 3 处（handler retry/dispatch 与 lib.rs 不吞错）——「`unwrap_or_default` 吞错 5 处」表述经四次复核修正：`unwrap_or_default()` 仅 handler 3 处，commands 2 处为 `let _ = start_attempt(...)` 丢弃（见第 48 条） |
| 10 | Web 会话隔离位置 | ws.rs | 实际在 **commands/terminal.rs 905-916** `check_pc_permission`（ws.rs 仅连接限制/心跳/接管） |
| 11 | create_ai_terminal 调用点 | 6210 定义处 | 定义 6210-6246（emit 6228），**调用点 3 处**：2586/6680/7244 |
| 12 | 前端组件清单 | 7 个 | 另有 `AiDeliveryFloatingButton.tsx`、`ProjectDialogs.tsx`（9 个） |
| 13 | TaskCreateDialog | 未涉及 | 已有 retryCount 输入（225-228，min=0/max=10），无 timeout——T2 只补 timeout 字段 |
| 14 | open-ai-attempt-terminal | Tauri 事件 | **window 级 CustomEvent**（AiDeliveryWorkspace.tsx 920-922 派发，App.tsx 317-318 监听） |
| 15 | eventTypeNames | — | 现有 **46** 项（169-214），`attemptTimedOut` 已注册（195）但后端不产生（N14 前端侧已就绪） |
| 16 | 事件 emit 之外的 append_event | — | **约 30 处**只写不 emit（全库 40+ 次 `append_event` 调用仅 12 处伴随 emit；2481 dispatchDeferred / 3170 autoMerged / 3179 autoMergeFailed / 6487 attemptWatchdogCheck 为其中代表）——T2 收口后自动获得推送（额外收益，规模见第 47 条） |
| 17 | TerminalOutputBuffer | — | 上限 1000 chunk / 2MB（terminal.rs:31-32），超限丢最旧——长任务事件流会截断，live-output.log 是唯一全量来源 |
| 18 | 状态全集微调 | — | AiReviewGate.state = awaitingReviewer/approved/rework/**failed**（质量门禁命令失败时置位，service 1774，见第 45 条）；`pending` 属于 decisionRequest/mergeRepositoryRecord，均非任务状态（「AiAttempt.state 含 `starting`」经二次复核修正为：`starting` 无赋值点，仅活跃过滤中的兼容值，见第 26 条） |
| 19 | recover_interrupted_attempts 特殊分支 | 未提及 | 1655-1662：manager attempt 且交付 planning/awaitingApproval 时走 fail_delivery_planning 回草稿 |
| 20 | merge_delivery_locally 结构 | 未提及 | 三层：1965 薄封装 → 1987 locked（失败清理集成工作区）→ 1999-2247 impl（validated_commit 校验 2151-2163、失败回滚 2205-2224） |
| 21 | finish_attempt 两套自动完成逻辑 | 未提及 | 3146-3191（finish_attempt 内）+ try_complete_workflow_delivery 3358-3399（恢复暂停/审核通过场景），模式几乎重复 |
| 22 | copy_dir_recursive | 按方法引用 | path_service.rs 82-95，**模块级自由函数**非 PathService 方法 |
| 23 | 事件类型全集 | — | 后端共 **45 种**事件类型字面量（40 种 `append_event` 直接字面量 + 5 种经表达式/变量传入，全部在 service 内）；`approachingTimeout`/`taskNodeEdited`/`taskNodeDeleted` 全库不出现（均需新增）；`attemptTimedOut` **后端**不出现但前端已注册（workspace-utils.ts:195，唯一前端独有项，前端 46 项 = 后端 45 + 1，与第 15 条自洽） |
| 24 | server.rs 中文注释 | — | 乱码已**固化落盘**（UTF-8 中文被按 GBK 解码成乱码字符后保存，字节即乱码的合法 UTF-8 编码，方向与「GBK 字节按 UTF-8 解码显示」相反）；位置在 AI 交付区块**外**（34/37/46/48/97/102/107/116/134-135 行；另有 196 行注释与 201/206 行 eprintln 字符串同类乱码），区块内无注释；不影响编译与路由 |
| 25 | read_attempt_output 容错 | 未提及 | 1581-1595 BOM/非 UTF-8 容错已存在 |
| 26 | attempt 状态全集 | — | 成功态是 **`completed`**（finish_attempt 3044-3045 等），非 `succeeded`（`succeeded` 是任务状态）；另有 `policyViolation`（3042-3043）；`starting` 无赋值点（仅活跃过滤 390/706/1125/1363/1649/3293/3307 中的兼容值）——正文 §1.4 已改 |
| 27 | lib.rs app.handle() 使用点 | 仅 341/430 | 实为 **4 处**：341/430/443/455（443 为 sync_bot_long_connections、455 为 claude_hook_server::run）——正文 §3.2.2 已改 |
| 28 | 「打开终端」按钮位置 | DeliveryDetail 676-683 | 按钮实际 **671-679**（onClick 676 调 prop `openAttemptTerminal`，675 为 title 属性）；CustomEvent 派发在父组件 AiDeliveryWorkspace **920-924**（非按钮自身）——正文 §3.1.3 已改 |
| 29 | saveAiAgent 整对象合并 | Workspace 1155 | `saveAgentConfig` 声明在 1155，核心调用 `saveAiAgent({ ...agent, ...patch })` 在 **1157**——正文 §3.2.3 已改 |
| 30 | N13 错误透传形态 | String(reason) 遍布 5 处 | 仅 369 为纯 `setError(String(reason))`；326/381/418/565 为 `reason instanceof Error ? reason.message : String(reason)`（先取 Error.message 再回退）——正文 §6.5 已改 |
| 31 | watchdog 首个检查点 | 约 90 秒 | 实际 **约 30 秒**（6264 sleep 30 后即首次检查，检查点序列 30s/90s/150s…）——正文 §3.2.2 已改 |
| 32 | dispatch_task_node 范围 | 2369-2384 | 函数实际 **2297-2400**（2369-2384 为 AiAttempt 构造块，started_at 打点 2378 不变）——正文 §3.1.2 已改 |
| 33 | plan_delivery_with_manager 起始 | 1013 | 函数实际起始 **979**（1013 为 ensure_project_repository_statuses_unchanged 调用）——正文 §5.11 已改 |
| 34 | create_ai_terminal 调用点语义 | 2586 planning 相关 | 2586 为 **start_attempt 内任务执行**（6680 reviewer / 7244 manager）；三处均经 create_ai_terminal 包装（6218 再调 TerminalService::create_blank_terminal）——正文 §3.1.2 已改 |
| 35 | allocate_task_worktree 范围 | 3544-3551 | 函数起始 **3495**，3544-3551 为依赖分支检查子块（仅查 branch_name 存在性的结论不变）——正文 §6.3 已改 |
| 36 | N17 lib.rs 恢复块 | 393-412 | 实际 **388-423**（dispatch 在 393、start_attempt 在 402-406）；debug 派发块受 343 行 `#[cfg(debug_assertions)]` 保护——正文 §6.6 已改 |
| 37 | startup_preset_name 写入 | 唯一非测试写入 lib.rs:364 | 另有 service 7313（质量门禁生成器构造）`None` 赋值；「唯一非 `None` 写入」成立——正文 §5.3 已改。**四次复核修正**：「唯一非 `None` 写入」**不成立**——前端 ConfigDialog「套用参数预设」（ConfigDialog.tsx:697-720）可写非 None（saveAiAgent 整对象落盘）；后端非 None 直写仅 lib.rs:364；`None` 赋值共 3 处（7313 + 测试模块 5484/6013）；后端全库无读取逻辑——正文 §5.3/§2.3/§6.6 N19 已改（见第 46 条） |
| 38 | 模型 state 字段注释 | — | 模型层所有 state 字段均为无注释裸 `String`（AiDelivery 282 / AiTaskNode 347 / AiAttempt 369 等），取值全集只能从 service 层字符串字面量推断——§1.4 标注来源已注明 |
| 39 | policyViolation 置位实体 | §1.4：置位（3042-3043 / 3073-3074）未区分实体 | **3042-3043 置 `attempt.state`、3073-3074 置 `task.state`**（同源 `audit_contract_scope` 越界检测，两实体同步置位，原表述语义正确但实体归属含混）——§1.4 已改 |
| 40 | finish_attempt 内 autoMerge 位置 | §5.7：「同模式 3153/3179-3185」 | 3153 实为 `delivery.state = "succeeded"`（与 `try_complete_workflow_delivery` 的 3367 平行）；`autoMergeFailed` append 两处：finish_attempt 内 3179-3185 与 `try_complete_workflow_delivery` 内 3389-3396（`autoMerged` 同有两处：3170 与 3380）；「仅 3179-3185 一处」仅就 finish_attempt 内成立——§5.7 已改 |
| 41 | terminal_run_dir_by_id 范围 | §3.4.2：4802-4816 | 实为 **4802-4819**（4817 收 read_dir、4818 `base.join(id_seg)` 兜底、4819 函数收尾）——§3.4.2 已改 |
| 42 | AiProject.profile_id 写入点 | N19：写入仅 service 274 复制 | 另有测试 `replans_legacy_delivery_without_overwriting_history`（函数 5349 起，`#[test]` 5348）内 AiProject 字面量 `profile_id: None`（**5358 行**）；5494 为 `CreateAiProjectInput` 输入结构体字段（非本结构体）；「业务代码无读取」成立——§6.6 已改 |
| 43 | server.rs 乱码位置补全 | 第 24 条列 34/37/46/48/97/102/107/116/134-135 | 另有 **196 行注释**与 **201/206 行 eprintln 字符串**为同类乱码（同为 AI 交付区块外；48 行为 AI 交付区块引导注释头，49-96 路由区内无注释）——第 24 条已改 |
| 44 | §1.4 merge 状态「全集」 | 混层且遗漏：merging/blocked/failed/completed/rolledBack/rollbackFailed | 分两级：`AiMergeRecord.state` 赋值 4 种（merging 2125 / blocked 2210 / rolledBack 2212 / completed 2228，记录级**无 failed**）；仓库子记录 `AiMergeRepositoryRecord.state` 赋值 5 种（pending 2172 / merged 2200 / failed 2206 / rolledBack 2286 / rollbackFailed 2288）——`failed`/`rollbackFailed` 属仓库子记录层；§6.3「merge record failed（2206）」同为仓库子记录层——正文 §1.4/§6.3 已改 |
| 45 | §1.4 reviewGate 状态 | awaitingReviewer / approved / rework | 另有 **failed**：质量门禁命令失败时置位（`run_quality_gate_inner` 1769-1779，字面量 1774）——正文 §1.4/第 18 条已改 |
| 46 | §5.3/N19/§9-37 startup_preset_name | 「唯一非 None 写入是 lib.rs:364」 | **不成立**：前端 ConfigDialog「套用参数预设」下拉（ConfigDialog.tsx:697-720）经 `saveAgentConfig` → `saveAiAgent` 整对象落盘可写非 None（`save_agent` 524-543 无字段剥离）；后端 4 处出现（lib.rs:364 唯一非 None 直写 + 7313/5484/6013 三处 None）且**无任何读取逻辑**；预设实体存客户端数据 `extra_param_presets`（appStore:1071-1081 写入、AiDeliveryWorkspace.tsx:266 经 `readClientData` 读取）——「死字段」不成立，「缺派发时应用」成立——正文 §5.3/§2.3/§6.6 N19 已改 |
| 47 | §3.2.2/§8/§9-16 只写不 emit 规模 | 4+ 处（2481/3170/3179/6487 举例） | 全库 `append_event` 40+ 次调用中**仅 12 处伴随 emit、其余约 30 处只写不 emit**——「4+」为下限表述，正文已改；另：两套自动完成段差异（finish_attempt 3164 deliverySucceeded 伴随 emit vs try_complete 3370-3389 全只写不 emit，T2 收口前恢复暂停/审核通过路径无实时推送，与第 21 条同义补充） |
| 48 | §6.6 N17 吞错机制 | `unwrap_or_default()` 吞错（commands 2 处 + handler 3 处） | `unwrap_or_default()` 仅 handler 3 处（approve 89 / answer_decision 114 / complete_attempt 195）；commands 2 处（resume 221-227 / answer 282-288）为 `let _ = start_attempt(...)` 丢弃结果——「吞错共 5 处」计数成立、机制表述修正——正文 §6.6 N17/第 9 条已改 |
| 49 | §6.6 N15 通道表述 | tauri.ts 仅 listen ai-delivery-event 一个通道 | 全库 `listen` 共 11 处（terminal_output_{id}/claude-notification-activated/git_push_output 等）；「**AI 交付相关**通道仅此一个、无 ai-delivery-decision 监听」成立——正文已限定语境 |
| 50 | §4.6 现状 / §7.3 文件清单 | 「任务节点每次只能操作一个」；web/src 仅 2 文件涉及 AI 交付 | 派发为整批（`dispatchAiReadyTasks` tauri.ts:664-665），逐任务操作的是重试/取消/审核；web/src 另有 `screens/Nav.tsx:458` 导航链接与 `App.tsx:8/51` 路由注册两处引用（无业务逻辑）——正文 §4.6/§7.3 已改 |
| 51 | 行号微调 | — | ① §3.1.3/第 28 条「onClick 675」实为 **676**（675 为 title 属性）；② §6.6 N19/第 42 条「测试模块 5358」：`profile_id: None` 字面量确在 5358，测试函数起点 5349（`#[test]` 5348）——正文已改 |

---

## 10. 生产就绪审计与修复（2026-08-03）

> 依据：对 AI 交付全链路（需求拆解 → 任务编排 → 执行/重试 → 合并 → worktree 清理 → 异常恢复）的逐模块代码审计（基于 service 拆分后的 9 个模块 + commands/models/web/前端接线，2026-08-03 HEAD `6a218d1`）。全部修复已通过 `cargo check` / `cargo test`（89 例）/ `tsc --noEmit`（详见 10.4 第二轮修复）。

### 10.1 修复的问题

| # | 严重度 | 问题 | 修复 |
|---|--------|------|------|
| R1 | **P0** | `start_attempt` 全局并发检查在批量派发（≥4 个就绪任务）或系统繁忙时返回「并发已达上限」，`fail_queued_attempt` 把任务**永久置 failed**（实际是暂时性容量问题） | `fail_queued_attempt` 区分暂时性错误（容量已满 / 交付已暂停）与结构错误：暂时性错误回退任务到 ready/planned、attempt 置 cancelled 留痕、发 `dispatchDeferred` 事件，等待自动/手动补派；新增 `GLOBAL_CAPACITY_ERROR` 常量 |
| R2 | **P0** | Reviewer attempt 终态用 `Self::save` 直写绕过 `persist_attempt` → 活跃索引永久残留 running 副本 → 全局/Agent/仓库并发配额随审核次数累积泄漏，最终**派发永久失败** | 两处终态改 `persist_attempt`（Ok 与 Err 路径） |
| R3 | **P0** | `finish_attempt` 终态删除 attempt 运行目录 → 「查看成果」（`read_attempt_output`）、产物列表/归档/导出、重试续接上下文（final-message.txt）**全部失效** | 终态保留运行目录（删除只发生在交付/任务/项目删除时）；同步移除 `cancel_attempt`/`cancel_task_node` 的目录删除 |
| R4 | **P1** | `mark_task_skipped` 级联跳过只处理 planned/ready 下游，**queued 下游卡死**（attempt 被取消但任务保持 queued，交付无法收尾合并） | 级联白名单纳入 queued（`cancel_queued_attempts_of_task` 已确保竞态安全） |
| R5 | **P1** | `confirm_policy_violation_site` 对 readonly+workflow review 任务传 `workflow_review_path=None` → 重跑验收永远失败 | 按 `requires_workflow_review` 从运行目录传入 review.json 路径 |
| R6 | **P1** | `update_task_node` 修改**目标仓库/执行模式/执行上下文**后契约仍指向旧仓库 worktree → Agent 在旧目录执行、审计按旧基线、合并时分支不在新目标仓库（必失败） | 新增 `discard_task_contract`：环境字段实际变更时清理旧 worktree/分支并删除契约、清空 `contract_id`，重试派发走全新契约路径；执行参数变更仍标脏复用 |
| R7 | **P1** | `resume_ai_delivery`：服务层 resume 可能已自动合并完成并把交付置 `completed`，命令层随后无条件 `dispatch_ready_and_start` → 误导性报错「仅运行中的交付可以派发任务」 | 命令层派发前检查 delivery 状态 |
| R8 | **P2** | `cancel_task_node` 只取消 running attempt，queued attempt 残留 → 之后手动 `start_ai_attempt` 会启动已取消的任务（状态覆盖「复活」） | 补充 `cancel_queued_attempts_of_task` |
| R9 | **P2** | `cleanup_delivery_task_worktrees` 在目标仓库已从项目移除时直接 continue → worktree 目录永久残留 | 退化为直接删目录（契约文件保留供历史查看） |
| R10 | **P2** | `run_manager_planner` 启动命令失败时终端未关闭（标签页/PTY 泄漏） | Err 路径补 `close_terminal` |
| R11 | **P2** | policyViolation 时 `attempt.summary` 取空 stderr → 无违规原因留痕 | summary 优先携带违规原因文本 |
| R12 | 清理 | `retry_task_node` 的动态提额语句在触顶分支后恒等不生效（钳制时代残留死代码） | 删除；触顶后用户编辑提高上限的路径不变 |

### 10.2 新增回归测试（tests.rs，全部通过）

- `capacity_blocked_start_reverts_task_to_ready`：容量错误回退 ready + attempt cancelled；结构错误仍置 failed
- `skipping_queued_downstream_cascades_and_cancels_attempt`：queued 下游级联跳过 + attempt 取消 + worktree 回收 + 合并放行
- `editing_execution_environment_rebuilds_contract`：环境字段变更丢弃旧契约/worktree，重试走全新契约路径

### 10.3 审计确认无异常的关键路径

- 规划域：manager 30min 超时、仓库状态变更阻断、失败回草稿、`active_manager_plans` 并发保护、应用中断恢复（`get_all_deliveries` / `recover_interrupted_attempts`）
- 执行域：watchdog 超时/80% 告警/attemptTimedOut、决策暂停与回答恢复、reviewer 60min 超时、`reconcile_running_attempt` 成果优先判定
- 合并域：三层结构 + `validated_commit` TOCTOU 防护、失败回滚（`rollback_merge_record`）、`mergeFailed` 终态、冲突续接（blocked 状态）、合并成功后 worktree/分支/集成工作区清理
- 跳过/收尾：skipped 不阻塞合并、`validate_tasks_mergeable` 门禁校验、`try_complete_workflow_delivery` 重启补收尾
- 事件/通知：`append_event` 统一 emit、事件滚动清理（1000 条 / 5MB）、微信/飞书推送、系统托盘通知
- 接线：Web REST 17 路由全部注册、前端状态/事件名注册齐全（skipped / mergeFailed / interrupted / approachingTimeout / taskNodeEdited / taskNodeDeleted）
### 10.4 第二轮修复：执行/质量/合并域深度审计（2026-08-03 下午）

> 依据：对拆分后 9 模块的逐行复核 + 2 个独立审计视角（执行/质量/合并/接线），新增 8 个回归测试全部通过。
> 验证：`cargo test` 89/89 通过（含真实 git 仓库操作）、`cargo check` 0 错误、`tsc --noEmit` 通过。

| # | 严重度 | 问题 | 修复 |
|---|--------|------|------|
| F1 | **P0** | 合并冲突续接 `continue_merge_after_conflict` 只重跑 `failed` 仓库子记录——首次合并失败时 `rollback_merge_record` 会把已合并仓库 reset 回合并前 HEAD，续接不重跑 `rolledBack` 仓库 → 改动永久丢失而交付仍宣告完成 | 新增 `merge_continuation_needed(state)`（`failed`/`rolledBack`），续接循环对两类仓库都重跑 |
| F2 | **P1** | `discard_task_contract` 清理旧 worktree/分支并删除契约，但交接目录（`handoff/`）残留 | 同步删除任务交接目录 |
| F3 | **P1** | `delete_task_node` 删除契约时未回收 worktree/分支（目标仓库已从项目移除时 worktree 永久残留） | 删除前走 `cleanup_unallocated_task_worktree`，仓库缺失时退化为 `remove_dir_all` |
| F4 | **P1** | 重试触顶清理 worktree 后 `contract_id` 未清空、契约文件未删 → 用户提高上限再重试时命中「执行目录不可用」永久卡死 | 触顶分支 `contract_id.take()` + 删除契约文件 + 保存任务 + 交付置 paused |
| F5 | **P2** | `delete_delivery` 白名单不含 `mergeFailed` 终态 → 合并失败交付无法删除 | 白名单纳入 `mergeFailed` |
| F6 | **P2** | `recover_interrupted_attempts` 单条 attempt 的 delivery/task 文件缺失时 `?` 中断整个恢复循环 | 缺失时 `continue` 跳过（并修正恢复语义：任务仅 `queued/running` 置 cancelled） |
| F7 | **P2** | `dispatch_ready_tasks` 内 `?` 传播使单次派发错误中断整批派发 | 单任务派发错误降级记录，继续后续任务 |
| F8 | **P2** | 全局容量错误文案与 `fail_queued_attempt` 判断条件漂移 → 容量错误被误判为结构性失败而置任务 failed | 引用 `GLOBAL_CAPACITY_ERROR` 常量而非硬编码 |
| F9 | **P2** | `interrupt_attempt` 死代码（无人调用，且中断语义错误） | 删除 |
| F10 | **P2** | 事件清理只遍历当前交付 → 已删除交付的事件目录残留 | 遍历所有交付执行 `prune_delivery_events` |
| Q1 | **P1** | 质量门禁重复触发时旧 gate 记录残留（任务已 succeeded 但旧 gate 未决） | `run_quality_gate_inner` 清理非 approved 的旧 gate |
| Q2 | **P1** | Reviewer/门禁终端启动失败或 Reviewer 判定不通过时终端未关闭（标签页/PTY 泄漏） | `run_reviewer_agent` 与 `resolve_review_gate` 错误路径补 `close_terminal` |
| Q3 | **P1** | `resolve_review_gate` 未要求任务处于 `awaitingReview` → 取消交付后残留 gate 可把已取消任务「复活」为 succeeded | 前置校验 `task.state == "awaitingReview"` |
| Q4 | **P2** | 只读任务（readonly 无 worktree）误执行 `ensure_task_branch_clean` → 校验必失败 | 仅 write 任务运行分支干净校验 |
| Q5 | **P2** | 门禁命令执行失败时 gate 状态未落 `failed` 且无留痕 | `run_shell_command` Err → `failed` gate + `AiCommandResult{exit_code:-1}` + 事件推送 |

**接线修复**（commands/web/前端）：

- `resume_ai_delivery` / `answer_decision_request` / `complete_attempt` 的派发失败从 `?` 传播改为降级 `append_event("dispatchFailed")` + 日志（派发失败不应使业务命令整体报错）
- `continue_merge` REST 路由新增（`POST /api/ai-delivery/deliveries/{id}/continue-merge` → `continue_merge_after_conflict`）
- `detect_ai_runtimes` 探测错误记录日志而非中断
- 前端 `reviewGateByTask` 按 `taskNodeId` 保留最新 gate（旧 map 覆盖逻辑丢失最新状态）
- `try_complete_workflow_delivery` 纳入应用重启自动收尾（崩溃于「任务完成→自动合并」窗口的交付重启后补收尾）

**测试环境修复（关键）**：

- `cargo test` 二进制加载失败 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`：tauri 窗口/菜单系统静态导入 comctl32 v6 的 `TaskDialogIndirect`，无 manifest 的 test 二进制加载 comctl32 v5 → 入口点缺失。根因：rustc 编译单元划分随机性——`dispatch_task_node`（测试可达）与 `start_attempt`（引 tauri 窗口链）偶尔落入同一 rcgu.o → 对象级拉入。**修复**：`.cargo/config.toml` 对 `x86_64-pc-windows-msvc` 增加 `link-arg=/DELAYLOAD:comctl32.dll` + `delayimp.lib`（comctl32 延迟绑定，加载不再解析；测试不执行该链，生产有 tauri 自带 v6 manifest 无影响）。备选方案 `cargo:rustc-link-arg-lib` 对 lib unit-test 变体不生效（cargo 限制），已排除。
- rustc 增量/多 codegen-units 下偶发 `drop_glue` 链接失败（LNK2001，单元划分敏感）：清理 `target/debug/incremental` 全量重编即可恢复；与本轮代码无关。
- 8 个新回归测试（含真实 git worktree/merge 操作）：`merge_continuation_needed_covers`、`merge_continuation_retries_failed_and_rolled_back_repositories`（F1）、`retry_cap_exhaustion_clears_contract_for_retry`（F4）、`discard_task_contract_removes_handoff_directory`（F2）、`deleting_merge_failed_delivery_allowed`（F5）、`deleting_task_node_reclaims_worktree`（F3）、`recover_interrupted_attempts_skips_missing_task_files`（F6）、`resolving_gate_requires_awaiting_review_task`（Q3）
