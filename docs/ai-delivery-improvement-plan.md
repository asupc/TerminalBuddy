# AI 交付改进 — 实施依据

> 本文档是 AI 交付功能后续迭代的实施依据：每项包含现状与代码位置（证据）、实施要点、涉及文件、验收标准与估算。
> 迭代 1（T1-T4）的实施细节已另立文档 [ai-delivery-iteration-1-plan.md](./ai-delivery-iteration-1-plan.md)，本文档仅保留其条目与状态，不重复细节。
> **代码位置基准**：所有行号/引用基于 2026-08-02 工作区状态（工作区含未提交改动，见 [2.4](#24-工作区基线注意)）。实施前先提交或回退该 diff。
> 制定日期：2026-08-02

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
- 前端：React ^19.2.6 + TypeScript + Zustand 5 + @xterm/xterm 6.x (beta)
- Web 端：独立 React SPA（`web/src/`），嵌入 Rust 二进制，WebSocket 通信
- 存储：`%APPDATA%/TerminalBuddy/AiDelivery/` 下按实体分目录的 JSON 文件

### 1.4 状态全集（已核实）

- **任务状态**：planned / ready / queued / running / succeeded / failed / policyViolation / rework / cancelled / awaitingReview / needsInput。**无 `completed`**（成功态为 `succeeded`）；`policyViolation` 由 `finish_attempt` 在 `audit_contract_scope`（2993）越界写入时置位（3073-3074），当前无恢复路径
- **交付状态机**：drafting / planning / awaitingApproval / running / paused / cancelled / needsInput / completed / succeeded / failed。`delivery.state = "failed"` 目前无赋值点，仅作前端过滤值保留

---

## 2. 迭代规划总览

### 2.1 总表

| 优先级 | 迭代 | 模块 | 功能 | 估算 | 状态 |
|--------|------|------|------|------|------|
| P0 | 1 | 可观测性 | 实时日志/终端查看（T1） | 0.5d | 已规划 → iteration-1-plan §2 |
| P0 | 1 | 任务图 | DAG 可视化（T3） | 2d | 已规划 → §4 |
| P0 | 1 | 可靠性 | 超时可配置+提前告警（T2） | 0.5d | 已规划 → §3 |
| P1 | 1 | 任务图 | 任务节点手动编辑（T4） | 1.5d | 已规划 → §5 |
| P1 | 2 | 协作 | N1 交付事件推送微信/飞书 | 0.5d | 待规划 |
| P1 | 2 | Web UI | N2 Web 端操作补齐 | 1.5d | 待规划 |
| P1 | 2 | 可观测性 | N3 质量门禁命令结果可视化 | 0.5d | 待规划 |
| P1 | 2 | 可靠性 | N4 policyViolation 一键恢复 | 0.5d | 待规划 |
| P1 | 2 | 可观测性 | N5 合并记录详情面板 | 0.5d | 待规划 |
| P1 | 2 | 效率 | 批量操作 | 1d | 待规划 |
| P1 | 2 | 效率 | 交付模板 | 1.5d | 待规划 |
| P1 | 2 | 可靠性 | 失败聚合+标记忽略/带参重试 | 1d | 待规划 |
| P2 | 3 | 可观测性 | 交付统计面板 | 2d | 待规划 |
| P2 | 3 | 审查 | 增量 Diff 审查 | 2d | 待规划 |
| P2 | 3 | 配置 | Agent 启动预设管理 | 1d | 待规划 |
| P2 | 3 | 配置 | 工作流步骤预览和测试 | 1d | 待规划 |
| P2 | 3 | Web API | 缺失 REST 路由补全（编辑/删除/添加任务等） | 1.5d | 待规划 |
| P2 | 3 | 可靠性 | N6 needsInput 重启恢复 | 0.5d | 待规划 |
| P2 | 3 | 可靠性 | N7 合并失败交付终态 | 0.5d | 待规划 |
| P2 | 3 | 可观测性 | N8 已答决策历史视图 | 0.5d | 待规划 |
| P2 | 3 | 可观测性 | N9 事件/列表查看全部+搜索+分页 | 1d | 待规划 |
| P2 | 3 | 可靠性 | N10 事件文件滚动清理 | 0.5d | 待规划 |
| P2 | 3 | 可靠性 | N11 规划中断「以当前状态重跑」 | 1d | 待规划 |
| P3 | 4 | 可观测性 | 产物归档与对比 | 1d | 待规划 |
| P3 | 4 | 可靠性 | 资源感知调度（全局并发上限/优先级队列） | 2d | 待规划 |
| P3 | 4 | 可观测性 | N12 attempt 运行时长展示 | 0.5d | 待规划 |
| P3 | 4 | 体验 | N13 错误本地化+banner 重试 | 1d | 待规划 |
| P3 | 4 | 重构 | N14-N21 小项打包 | 1d | 待规划 |
| 待评估 | - | 可靠性 | 交付暂停与恢复增强（优雅暂停） | - | 待评估 |

**总估算**：约 28 个工作日（不含测试和联调），分 4-5 个迭代。

### 2.2 迭代 1（已规划）

T1-T4 实施细节见 `ai-delivery-iteration-1-plan.md`（T1 实时终端 §2、T2 超时 §3、T3 DAG §4、T4 节点编辑 §5），本表不再重复。

### 2.3 项间依赖

| 依赖 | 说明 |
|------|------|
| N4 ↔ 失败聚合/标记忽略 | 同源：`skipped` 标记与级联复用 |
| N5 → 合并冲突续接 | N5（详情面板）是迭代 1 计划 §9.2「合并冲突续接」的前置 |
| N7 ↔ 合并冲突续接 | 互补：N7 解决状态机（mergeFailed 终态），§9.2 解决入口（冲突已解决后继续合并） |
| N14 → T2 | N14 并入迭代 1 T2 一并实现（watchdog 超时改 emit attemptTimedOut） |
| N2 ↔ REST 补全 | 互补：N2 补齐已有 12 路由的 Web UI（零后端），REST 补全补齐缺失路由（PUT/DELETE/POST 任务等） |
| N19 → 启动预设 | `AiAgent.startup_preset_name` 死字段随 5.1 预设管理落地 |

### 2.4 工作区基线注意

已核实（迭代 1 计划 v7）：`retry_task_node` 的 min(10) 钳制（2408）与「编辑任务提高上限再重试」文案（2428-2431）是**未提交工作区改动**（`git log -S effective_retry_limit` 无结果，HEAD 仅 1248/3481 两处 `.min(10)`）；工作区另有首行 BOM、空白重排与锁 guard 重构未提交（`git diff -w` 后真实变更仅 49+/47-）。**实施前先提交或回退该 diff**，避免在漂移状态上叠加改动。

---

## 3. 实施项详情

格式说明：**现状**（证据/代码位置）→ **实施要点** → **涉及文件** → **验收标准**。

### 3.1 迭代 1（已规划，见 2.2）

| 编号 | 功能 | 状态 |
|------|------|------|
| T1 | 实时终端查看（事件流 + live 输出落盘） | 已规划，见 iteration-1-plan §2 |
| T2 | 超时可配置 + 提前告警 | 已规划，见 §3 |
| T3 | DAG 可视化 | 已规划，见 §4 |
| T4 | 任务节点手动编辑 | 已规划，见 §5 |

---

### 3.2 迭代 2（P1）

#### N1 交付事件推送微信/飞书

**现状**：出站通道与数据俱在，缺约 100 行接线。微信：`bot_weixin_service.rs:296` `send_weixin_text_with_id`、`:345` `send_weixin_reply`、引用回复解析 380-412；飞书 webhook：`web/handlers/bot_handler.rs:66`。AI 交付对外通知仅 Windows Toast（`commands/notification.rs:91`，仅 2 处调用 `commands/ai_delivery.rs:263`、`ai_delivery_service.rs:2966`）。

**实施要点**：
1. 事件挂接：决策请求创建/已答、任务失败、合并完成、交付成功 → 推送配置的聊天（与 T2 通知补齐的挂接点同源）
2. 聊天内直接回复决策：复用引用回复解析（380-412），引用回复内容作为 answer 调用 `answer_decision`
3. 推送目标配置（微信 id / 飞书 webhook）持久化到设置

**涉及文件**：`ai_delivery_service.rs`、`bot_weixin_service.rs`（复用）、`web/handlers/bot_handler.rs`（复用）、设置存储与配置 UI

**验收标准**：
- 决策请求/任务失败/合并完成/交付成功均到达配置的聊天
- 聊天内引用回复可回答决策并驱动决策状态更新

#### N2 Web 端操作补齐

**现状**：后端 12 条 REST 路由已全部注册实现（`web/server.rs:49-96`：create/plan/dispatch/complete/merge/cleanup-integration/retry 均有 handler）；`web/api.ts:93-98` 仅封装 5 个（projects/deliveries/snapshot/approve/answer）；Web 页面文案自述「仅观察、批准任务图和回答决策」。含决策**自由文本回答**缺口：后端接受任意 answer 字符串，Web 只有选项按钮（桌面端有 textarea）。

**实施要点**：
1. `web/src/api.ts` 补封装 7 个接口：create/plan/dispatch/complete/merge/cleanup-integration/retry
2. `web/src/screens/AiDelivery.tsx`（及所属组件）补对应操作入口：创建交付、重新规划、派发、手动完成、合并、清理集成、重试
3. 决策回答补自由文本 textarea
4. **零后端工作量**

**涉及文件**：`web/src/api.ts`、`web/src/screens/AiDelivery.tsx`、`web/src/` 相关组件

**验收标准**：
- Web 端可完成创建交付 → 重新规划 → 派发 → 手动完成 → 合并 → 清理集成 → 重试全流程
- 决策支持自由文本回答

#### N3 质量门禁命令结果可视化

**现状**：`AiReviewGate.commandResults`（models:393-404，含每命令 exitCode/output）随快照下发但零渲染，UI 只有一行 `gate.comments`（`DeliveryDetail.tsx:513-517`）——哪条门禁命令失败、输出是什么不可见。

**实施要点**：
1. 逐命令展示：通过/失败状态、退出码、输出
2. 失败命令可复制重跑
3. 纯前端

**涉及文件**：`src/components/ai-delivery/DeliveryDetail.tsx`、`src/types/aiDelivery.ts`

**验收标准**：
- 审查环节可看到每条门禁命令的退出码与输出
- 失败命令可复制

#### N4 policyViolation 一键恢复

**现状**：`finish_attempt` 3042-3047/3073-3074 置态（`audit_contract_scope` 2993 越界写入触发）；`retry_task_node` 白名单（2404）不含 → 任务永久卡死。迭代 1 T4 已放行「编辑+重试」作为绕路（重试白名单扩为 failed|rework|cancelled|policyViolation 属 T4 范围，先核查 T4 是否已合入）。

**实施要点**：
1. 新增「确认现场，继续验收」命令：标记现场可接受、重跑验收
2. 新增「标记忽略(skipped)」：与失败聚合/标记忽略项共用同一实现（3.2 末项）

**涉及文件**：`ai_delivery_service.rs`（新命令 + skipped 状态处理）、`commands/ai_delivery.rs`、任务卡片 UI

**验收标准**：
- policyViolation 任务可一键确认现场并重跑验收
- policyViolation 任务可标记 skipped，不阻塞后续合并

#### N5 合并记录详情面板

**现状**：`AiMergeRecord.repositories[]`（models:499-520，含 branchName/preMergeHead/mergedHead/error）UI 只显示一行 state（`DeliveryDetail.tsx:363-366`）——冲突时看不到哪个仓库失败、卡在什么分支。

**实施要点**：
1. 逐仓库展示：branchName / preMergeHead / mergedHead
2. 失败仓库高亮 error
3. 纯前端

**涉及文件**：`src/components/ai-delivery/DeliveryDetail.tsx`、`src/types/aiDelivery.ts`

**验收标准**：
- 合并冲突时可看到每个仓库的分支、合并前后 commit 与失败原因

#### 批量操作

**现状**：任务节点每次只能操作一个，20+ 任务逐个操作繁琐。

**实施要点**：
1. 复选框多选（Shift 连选），批量派发/重试/取消
2. 按阶段派发：基于 workflowStepId 筛选（如「只派发第一阶段」）
3. 一键重试所有 failed/rework 任务
4. 操作结果汇总（成功/失败计数）

**涉及文件**：`src/components/ai-delivery/AiDeliveryWorkspace.tsx`、`workspace-utils.ts`、`src/services/tauri.ts`

**验收标准**：
- 多选后可批量派发/重试/取消；结果汇总展示成功与失败计数

#### 交付模板

**现状**：每次交付从零选择工作流、填写需求；重复场景多（新增 CRUD 接口、前端页面改版、数据库迁移）。

**实施要点**：
1. 新增 `AiDeliveryTemplate` 模型：`{name, description, workflowId, qualityGate, roleMappings, commonPrompt}`
2. 参数化占位符：`{featureName}`、`{moduleName}`，创建时替换
3. 从已完成交付「保存为模板」，自动提取配置
4. 创建对话框模板选择 + 管理入口（重命名、删除）

**涉及文件**：`models/ai_delivery.rs`、`ai_delivery_service.rs`、`commands/ai_delivery.rs`、`src/components/ai-delivery/TaskDeliveryDialogs.tsx`、`src/types/aiDelivery.ts`、`src/services/tauri.ts`

**验收标准**：
- 可从已完成交付保存模板；创建时选模板自动填充字段；占位符替换生效

#### 失败聚合 + 标记忽略 / 带参重试

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

### 3.3 迭代 3（P2）

#### 交付统计面板

**现状**：只有列表，缺少统计视角。

**实施要点**（统计项）：
1. 交付成功率（按 state 统计 succeeded 占比）
2. 任务成功率（首次 vs 重试后）
3. 平均执行时长（按 Agent/角色/仓库维度）
4. 最常见失败原因（attempt.summary 文本聚类）
5. Agent 调用统计（调用次数、总耗时、成功率）

**实现位置**：`AiDeliveryApp` 新增「统计」标签页，或 `AiUsagePanel` 基础上扩展。

**验收标准**：五个统计项均有数据展示

#### 增量 Diff 审查

**现状**：审批者只能看评审文本，看不到代码变更。

**实施要点**：
1. 嵌入 Monaco Diff Editor（项目已集成）展示 `git diff baseCommit...HEAD`
2. 审批者在 diff 行上添加评论，关联 reviewGate 存储

**验收标准**：审批时可查看代码变更；行评论随 reviewGate 持久化

#### Agent 启动预设管理

**现状**：`AiAgent.startupPresetName` 字段存在，前端无管理入口（N19 的「死字段落地」即本项）。

**实施要点**：
1. 预设 CRUD：`{name, promptPrefix, modelArgs, contextStrategy}`
2. Agent 配置与预设关联，派发时应用

**涉及文件**：`models/ai_delivery.rs`、`commands/ai_delivery.rs`、`src/components/ai-delivery/ConfigDialog.tsx`、`src/types/aiDelivery.ts`

**验收标准**：预设可创建/编辑/删除；Agent 可选预设；派发时应用预设内容

#### 工作流步骤预览和测试

**实施要点**：
1. 工作流预览（展示预期任务拓扑）
2. 拖拽排序
3. 单步骤模拟测试

**验收标准**：配置工作流时可预览任务拓扑；可排序；可单步模拟

#### 缺失 REST 路由补全

**现状**：12 条 REST 路由已全部注册（见 N2）；本项补齐**缺失**的后端路由（区别于 N2 的纯前端补齐）。

**实施要点**：
1. `PUT /api/deliveries/:id`（编辑交付需求）
2. `PUT /api/deliveries/:id/tasks/:taskId`、`DELETE /api/deliveries/:id/tasks/:taskId`、`POST /api/deliveries/:id/tasks`（任务编辑/删除/手动添加——服务层命令已由 T4 提供，只差 REST 包装）
3. 在 `web/server.rs` 注册（AI 交付区块 49-96 行内追加）

**验收标准**：REST 覆盖创建/规划/派发/编辑/删除/完成/合并/重试全流程；Web 冒烟通过

#### N6 needsInput 重启恢复

**现状**：`recover_interrupted_attempts`（1646-1690）过滤只含 queued/starting/running；重启后 needsInput attempt 带死 terminal_id 变僵尸记录。

**实施要点**：
1. 重启时对 needsInput attempt 标记中断并清理死终端引用
2. 回答决策时自动归档旧 attempt

**验收标准**：重启后 needsInput 任务不再僵尸；可正常恢复

#### N7 合并失败交付终态

**现状**：merge 失败（2224）不落交付状态；auto 路径先置 succeeded（3367）失败不回滚；前端「失败/合并中/已阻塞」筛选（`workspace-utils.ts:81-123`）注册但永不命中。

**实施要点**：
1. 合并失败置可辨识终态（如 `mergeFailed`）
2. 前端筛选生效
3. 与 N5、迭代 1 §9.2「合并冲突续接」联动

**验收标准**：合并失败交付显示可辨识终态；前端「失败/已阻塞」筛选命中

#### N8 已答决策历史视图

**现状**：`AiDecisionRequest.answer`（models:466）从不展示，只渲染 pending 决策（`AiDeliveryWorkspace.tsx:846-848`）。

**实施要点**：新增决策历史列表：问题/选项/回答/时间

**验收标准**：已答决策在 UI 可见，含答案与时间

#### N9 事件/列表「查看全部+搜索+分页」

**现状**：事件 slice(-20)（`AiDeliveryWorkspace.tsx:897`）、attempt 事件 slice(-160)（`DeliveryDetail.tsx:634`）、内存上限 slice(-500)（:395）——长交付早期事件不可达，标题数字与可见条数不一致。

**实施要点**：统一查看全部 + 搜索 + 分页 + 虚拟滚动

**验收标准**：早期事件可访问；标题数字与可见条数一致

#### N10 事件文件滚动清理

**现状**：`append_event` 每次一文件、无数量/体积上限（3417）；`get_delivery_events` 每次全量读（1447）；watchdog 巡检事件（6491）长任务累积。

**实施要点**：
1. 按交付保留最近 N 条事件 + 体积上限
2. attempt 运行目录随清理删除

**验收标准**：数据目录不再无限增长；清理后事件列表仍完整可用

#### N11 规划中断「以当前状态重跑」

**现状**：4513-4516 仓库被改动阻断规划，`fail_delivery_planning` 直接回草稿，只能手动清理后重来。

**实施要点**：新增「对比基线 → 采纳当前状态 → 重新规划」入口

**验收标准**：仓库被改动时无需手动清理，可采纳当前状态继续规划

---

### 3.4 迭代 4+（P3）

#### 产物归档与对比

**实施要点**：
1. 交付详情「产物」Tab 列出 plan.json / transcript.log / review.json 等
2. 跨交付 plan.json 并排对比（Monaco Diff Editor）
3. ZIP 打包下载全部产物

**验收标准**：产物可浏览、可跨交付对比、可打包下载

#### 资源感知调度

**现状**：项目级与 Agent 级并发控制已存在（`check_capacity`，3299）。

**实施要点**：
1. 全局并发上限（跨项目总并发数限制）
2. 资源感知调度（CPU/内存高负载时延迟派发）
3. 任务优先级队列（高/中/低）

**验收标准**：全局并发上限生效；高负载时派发延迟

#### N12 attempt 运行时长展示

**现状**：`AiAttempt.finishedAt`（models:372）闲置，卡片只显示 startedAt（`DeliveryDetail.tsx:641`）。

**实施要点**：卡片显示运行时长与完成时间

**验收标准**：attempt 卡片可见运行时长与完成时间

#### N13 错误本地化 + banner 重试

**现状**：`String(reason)` 原始透传遍布（`AiDeliveryWorkspace.tsx:326/418` 等）；4 秒轮询失败静默吞掉（:386）。

**实施要点**：
1. 错误分类与可操作提示（「如何修复」文案）
2. 错误 banner 重试按钮
3. 轮询失败不再静默

**验收标准**：错误显示分类与操作提示；banner 可触发重试

#### N14-N21 小项打包

| # | 项 | 现状/证据 | 实施 |
|---|----|-----------|------|
| N14 | attemptTimedOut 事件生效 | `workspace-utils.ts:195` 已注册、后端从不 emit（超时走 attemptFailed，6281-6290） | **并入迭代 1 T2**：watchdog 超时改 emit attemptTimedOut，前端染色即生效 |
| N15 | ai-delivery-decision 死事件通道 | `commands/ai_delivery.rs:262/279` emit、前端无人监听（tauri.ts 只 listen ai-delivery-event） | 删除该通道，或补前端监听 |
| N16 | cancel_delivery 事件一致性 | 1362-1374 只写状态、不产生 attemptCancelled，事件流只有一条 deliveryCancelled | 补逐 attempt 事件 |
| N17 | 统一 dispatch+start helper | 7 处复制（`commands/ai_delivery.rs:221-227,282-288`、web handler:89-95,114-117,195-197,250-260,285-300、`lib.rs:393-413`、`finish_attempt` 3129-3142），错误处理不一致（unwrap_or_default 吞错） | 提取统一 helper；顺带修 Web 端静默失败 |
| N18 | check_capacity 索引 | 3299-3352 每次派发对全部 attempt 做 O(N) 文件读（含每 attempt 读 delivery/contract） | 内存活跃 attempt 计数/索引 |
| N19 | 死字段清理/落地 | `AiProject.profile_id`（全库无读取）；`AiDelivery.task_node_ids`（无读取方）；`AiAgent.startup_preset_name`（随 5.1 预设管理落地） | 清理前两者；后者随启动预设管理落地 |
| N20 | 注释与实现不一致修复 | models:445-447 声称 prompt「前 500 字符摘要」，实现（service:1631-1632）读取全文 | 修注释或真截断 |
| N21 | Runtime 版本号展示 | `AiRuntimeProbe.version`（models:91）导航栏不显示 | 导航栏展示版本号 |

**验收标准（打包项）**：
- N14：超时任务触发 attemptTimedOut 事件，前端染色生效
- N15：无死事件通道（删除或补监听）
- N16：取消交付产生逐 attempt 的 attemptCancelled 事件
- N17：单点 helper，Web 端派发错误不再静默吞掉
- N18：多交付并发时派发不再 O(N) 读盘
- N19：无未消费字段（除随 5.1 落地的字段外）
- N20：注释与实现一致
- N21：导航栏显示 Runtime 版本

#### 交付暂停与恢复增强（待评估）

**现状**：pause/resume 已存在，暂停时强制终止。

**实施要点**：优雅等待任务到检查点，保留 worktree 状态。

**估算**：待评估，实施前先确认收益与复杂度。

---

## 4. 涉及文件索引

### 4.1 后端（Rust）

| 文件 | 说明 |
|------|------|
| `src-tauri/src/models/ai_delivery.rs` | AI 交付所有数据模型定义 |
| `src-tauri/src/services/ai_delivery_service.rs` | 核心业务逻辑（~7500 行，含 `#[cfg(test)]` 测试模块） |
| `src-tauri/src/commands/ai_delivery.rs` | Tauri 命令注册 |
| `src-tauri/src/commands/ai_usage.rs` | AI 用量查询命令 |
| `src-tauri/src/web/handlers/ai_delivery_handler.rs` | Web API 处理器 |
| `src-tauri/src/web/server.rs` | axum 路由注册（AI 交付 REST 区块 49-96 行） |
| `src-tauri/src/services/bot_weixin_service.rs` | 微信推送通道（N1 复用） |
| `src-tauri/src/web/handlers/bot_handler.rs` | 飞书 webhook（N1 复用） |
| `src-tauri/src/commands/notification.rs` | 系统托盘通知（T2 复用，标题硬编码注意） |
| `src-tauri/src/commands/terminal.rs` | TerminalInstance / drain_terminal_output（T1 涉及） |

### 4.2 前端（React/TypeScript，`src/`）

| 文件 | 说明 |
|------|------|
| `src/components/ai-delivery/AiDeliveryApp.tsx` | AI 交付独立窗口根组件 |
| `src/components/ai-delivery/AiDeliveryNav.tsx` | 左侧导航栏 |
| `src/components/ai-delivery/AiDeliveryWorkspace.tsx` | 主工作区（任务列表/事件列表/轮询） |
| `src/components/ai-delivery/DeliveryDetail.tsx` | 交付详情 |
| `src/components/ai-delivery/TaskDeliveryDialogs.tsx` | 创建/编辑对话框 |
| `src/components/ai-delivery/ConfigDialog.tsx` | Agent 配置对话框 |
| `src/components/ai-delivery/workspace-utils.ts` | 事件类型/状态中文名注册、筛选 |
| `src/types/aiDelivery.ts` | TypeScript 类型定义 |
| `src/services/tauri.ts` | Tauri 命令封装与事件监听 |
| `src/components/settings/AiUsageSettings.tsx` | AI 用量配置 |
| `src/components/settings/AiUsagePanel.tsx` | AI 用量面板 |

### 4.3 Web 端（`web/src/`）

| 文件 | 说明 |
|------|------|
| `web/src/api.ts` | REST 客户端封装（仅 5 个，N2 补全） |
| `web/src/screens/AiDelivery.tsx` | Web 端交付主界面（5 秒轮询 snapshot） |

---

## 5. 跨项通用规范

1. **事件类型注册**：所有新事件类型必须在 `workspace-utils.ts` 的 `eventTypeNames` 注册中文名，否则事件列表显示原始英文串
2. **事件 emit**：T2 引入全局 `APP_HANDLE: OnceLock<AppHandle>` 后由 `append_event` 统一 emit `ai-delivery-event`；新增事件无需手动 emit（T2 将清理现有 12 处重复 emit）
3. **系统通知**：`show_ai_delivery_notification`（notification.rs:91-116）标题硬编码「AI 交付等待决策」且无 title 参数——复用前先加 title 参数或按场景定制正文
4. **Web 路由注册**：新 REST 路由必须在 `web/server.rs` 注册（AI 交付区块 49-96 行内追加），遗漏即 404
5. **前端事件通道**：`tauri.ts` 仅 listen `ai-delivery-event` 一个通道；引入新通道需显式补监听（或直接删除，见 N15）
6. **模型约定**：serde camelCase；更新输入用双 Option（`Option<Option<T>>`）区分「未提供」与「设为空」
7. **校验复用**：编辑/删除类操作复用 `create_task_node` 的既有约束校验（含环依赖检测 helper），不另写一套
8. **任务状态全集**：planned / ready / queued / running / succeeded / failed / policyViolation / rework / cancelled / awaitingReview / needsInput（无 `completed`）
9. **测试设施**：单元测试落位 `ai_delivery_service.rs` 内 `#[cfg(test)]` 模块（已有先例：`agent_decision_tests` 5111 行、`terminal_command_tests` 5992 行），验收以 `cargo test` 通过为准
