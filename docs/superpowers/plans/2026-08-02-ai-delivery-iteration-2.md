# AI 交付迭代 2 实施计划（P1：协作 / Web UI / 可观测性 / 可靠性）

> 本文件由 `2026-08-02-ai-delivery-iterations-1-4.md` 拆分而来（2026-08-02），实施依据为 `docs/ai-delivery-implementation-plan.md`（2026-08-02 定稿，4 轮核实）。完整 4 迭代拆分为：迭代 1（T1-T4，已完成规划）/ 迭代 2（本文件）/ 迭代 3 / 迭代 4。
> **前置依赖**：迭代 1 的 T2-3（全局 `APP_HANDLE` 统一 emit）、T4-3（重试白名单放行 policyViolation）——**顺序执行前置**（T2-3 收口后本迭代 Global Constraints 的「新增事件无需手动 emit」才成立）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P1 迭代 2：N1 交付事件推送微信/飞书、N2 Web 端操作补齐、N3 质量门禁结果可视化、N4 policyViolation 一键恢复、N5 合并记录详情面板、批量操作、交付模板、失败聚合+标记忽略/带参重试、依赖基线版本校验、合并冲突续接、候选 Agent 无容量自动补派，共 11 个任务。

**Architecture:** 变更集中在 `src-tauri/src/`（services/commands/models）、React 前端 `src/components/ai-delivery/`、Web SPA `web/src/`。多数任务为独立小功能，可并行；N4 依赖 T4-3 白名单放行；N5 是「合并冲突续接」的前置。

**Tech Stack:** Rust (Tauri 2), React ^19.2.6, TypeScript, Zustand 5, axum（Web API）。

## Global Constraints

- 项目实际文件在 `terminal-buddy/` 子目录；`cd terminal-buddy` 后执行所有命令。
- 所有 Rust↔TS 序列化使用 camelCase（serde `rename_all = "camelCase"`，30 个结构体已有 30 处）。
- 更新输入用双 Option（`Option<Option<T>>`）区分「未提供」与「设为空」。
- **任务状态全集（11 种，无 `completed`）**：planned / ready / queued / running / succeeded / failed / policyViolation / rework / cancelled / awaitingReview / needsInput。**N8-1 将引入第 12 种 `skipped`**（标记忽略），需同步 workspace-utils/STATE_COLORS/收尾判定。
- **attempt 状态**：queued / running / needsInput / cancelled / failed / **completed**（成功态）/ policyViolation（无 `succeeded`）。
- **delivery 状态**：drafting / planning / awaitingApproval / running / paused / cancelled / needsInput / completed / succeeded / failed。`"merging"`/`"blocked"` 是 **merge 记录**状态，不是 delivery 状态。
- **merge 状态分两级**：`AiMergeRecord.state` 赋值 4 种（merging 2125 / blocked 2210 / rolledBack 2212 / completed 2228，记录级**无 failed**）；仓库子记录 `AiMergeRepositoryRecord.state` 赋值 5 种（pending 2172 / merged 2200 / failed 2206 / rolledBack 2286 / rollbackFailed 2288）。
- 事件类型必须在 `src/components/ai-delivery/workspace-utils.ts` 的 `eventTypeNames`（现有 46 项，168-215 行）注册中文名，否则事件列表显示原始英文串。
- 事件由 `append_event` 统一 emit `ai-delivery-event`（迭代 1 T2-3 已收口）；**新增事件无需手动 emit**。
- 系统通知复用 `show_ai_delivery_notification`（迭代 1 T2-4 已加 title 参数）。
- 新 REST 路由必须在 `web/server.rs` 注册（AI 交付区块 49-96 行内追加），遗漏即 404。
- 编辑/删除类操作**复用** `create_task_node`（1176-1269）的既有约束校验，不另写一套；注意排除其 delivery 状态校验（1202-1207）避免自锁。
- 单元测试落位 `src-tauri/src/services/ai_delivery_service.rs` 内 `#[cfg(test)]` 模块（先例：`agent_decision_tests` 5110、`terminal_command_tests` 5991），验收以 `cargo test` 通过为准。
- 前端 UI 文案用中文（简体）；commit message 格式 `[模块] 变更描述`。
- 所有新增模型字段必须有 `#[serde(default)]`（或 `Option`）以兼容旧 JSON 文件；前端类型必须同步 `src/types/aiDelivery.ts`。

---

## File Structure

### 修改（后端 `src-tauri/src/`）
- `services/ai_delivery_service.rs`（7460 行）— N1/N4/N7-模板/N8-聚合/基线/冲突续接/补派
- `commands/ai_delivery.rs` + `lib.rs` — 新命令注册
- `services/bot_weixin_service.rs`、`web/handlers/bot_handler.rs` — N1 推送复用
- `models/settings.rs` + 前端 `src/utils/settings.ts` — N1 推送配置存储
- `models/ai_delivery.rs` — N7 模板模型、基线字段

### 修改（前端 `src/`）
- `src/components/ai-delivery/AiDeliveryWorkspace.tsx` — N6 批量操作/N8 聚合/skipped 卡片
- `src/components/ai-delivery/DeliveryDetail.tsx` — N3 门禁结果/N5 合并详情/N8 带参重试
- `src/components/ai-delivery/TaskDeliveryDialogs.tsx` — N7 模板选择
- `src/services/tauri.ts`、`src/types/aiDelivery.ts` — 封装与类型
- `src/components/ai-delivery/workspace-utils.ts` — skipped/taskSkipped 注册

### 修改（Web `web/src/`）
- `web/src/api.ts`、`web/src/screens/AiDelivery.tsx` — N2

---

## 任务（各 N 项相互独立可并行；建议顺序：N1 → N2 → N3 → N5 → N6 → N7 → N8 → N4 → 基线 → 冲突续接 → 补派）

### Task N1-1: 交付事件推送微信/飞书 + 聊天回复决策

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（事件挂接：决策请求创建/已答、任务失败、合并完成、交付成功）
- Modify: `terminal-buddy/src-tauri/src/services/bot_weixin_service.rs`（复用 `send_weixin_text_with_id` 296、`extract_weixin_reply_to` 371-412）
- Modify: `terminal-buddy/src-tauri/src/web/handlers/bot_handler.rs`（复用 `feishu_events` 66 起）
- Modify: `terminal-buddy/src-tauri/src/models/settings.rs`（推送目标配置存储）+ 前端设置 UI

**Interfaces:**
- Consumes: 迭代 1 的 `APP_HANDLE`/统一 emit 模式；`answer_decision_request`（既有命令）；微信引用回复解析（371-412：`marker_from_text` 解析 WEIXIN_REPLY_MARKER，394-409 回退探测 message_id/client_id/msg_id 指针）
- Produces: 设置项（如 `AiDeliverySettings { weixin_uid, feishu_webhook }` 或并入现有 settings.json 结构）；事件挂接点：决策请求创建/已答、任务失败（attemptFailed）、合并完成（mergedLocally/autoMerged）、交付成功（deliverySucceeded）

- [ ] **Step 1: 推送配置存储**

`models/settings.rs` 的 `AppSettings` 加两个 Option 字段（camelCase + serde default）：

```rust
#[serde(default)]
pub ai_delivery_weixin_uid: Option<String>,     // 微信接收 uid
#[serde(default)]
pub ai_delivery_feishu_webhook: Option<String>, // 飞书 webhook URL
```

前端 `src/utils/settings.ts` 的 AppSettings/DEFAULT_SETTINGS 同步（`aiDeliveryWeixinUid` / `aiDeliveryFeishuWebhook`，默认 null）。设置 UI 加在「AI 交付」相关设置区（可放 `AiUsageSettings.tsx` 或新建小节），仅文本输入。

> **评审修正**：`ai_delivery_weixin_uid` 仅存 uid 不够——微信发送实际需要完整 `BotChannelConfig`（app_id/secret/target_id，见 `bot_weixin_service.rs:296` 的 `send_weixin_text_with_id` 参数形态）。建议改为**复用既有 Bot 通道配置**（bots 配置表中标记该通道启用 AI 交付推送）而非新设 uid 字段；若坚持字段方案，需在 Step 2 明确从既有通道配置构造发送参数的关系。

- [ ] **Step 2: service 内推送辅助函数**

`ai_delivery_service.rs` 加：

```rust
fn push_delivery_notice(delivery_id: &str, event_type: &str, message: &str) {
    // 从 settings.json 读推送配置（Self::get::<AppSettings>(...)，参照既有读取方式）
    // weixin_uid 非空 → bot_weixin_service::send_weixin_text_with_id(uid, text)
    // feishu_webhook 非空 → POST 飞书 webhook（机器人 text 消息 JSON：{"msg_type":"text","content":{"text": ...}}）
    // 两者均静默失败（推送是尽力而为，不阻断交付流程）
}
```

> **评审修正**：`send_weixin_text_with_id`（bot_weixin_service.rs:296-343）是 **`pub async fn`**，参数形态 `(client, channel, target_id, text, message_id)`——本辅助函数所在挂接点（finish_attempt 2974 等）全部是**同步函数**，需用 `tauri::async_runtime::spawn`（或 `block_on`）包异步调用，不能直接 await。HTTP 客户端复用既有全局单例先例 `HTTP_CLIENT`（commands/ai_usage.rs:8）。飞书 webhook 发送同理（Cargo.toml:29 reqwest 0.12 已有）。

- [ ] **Step 3: 四个挂接点**

在 service 内四处追加 `Self::push_delivery_notice(...)`（位置参照迭代 1 T2-4 通知挂接点同源）：
1. 决策请求创建（服务层 `create_decision_request` 内；命令层为 `create_ai_decision_request`）→ 文本含问题与选项摘要。
2. 决策已答（`answer_decision_request` 内）→ 文本含回答。
3. 任务失败（`finish_attempt` 失败分支，3044-3045 置 completed 前/失败时）→ 文本含任务标题与 summary 摘要。
4. 合并完成（`merge_delivery_locally_locked_impl` 2228 置 completed 处）与交付成功（deliverySucceeded 事件处，3164/3370）→ 文本含合并结果。

- [ ] **Step 4: 聊天回复决策**

微信：在收到微信消息并 `extract_weixin_reply_to` 识别出是引用回复后，若被引用消息是 AI 交付推送（含决策问题），把回复文本作为 answer 调 `answer_decision_request`。飞书：`im.message.receive_v1` 分支里识别引用回复（飞书引用回复含 parent_id），回复文本作 answer。

> **评审修正**：`extract_weixin_reply_to`（380-412）**只返回被引用消息的 message_id，不返回被引用文本**——「从文本提取 `决策 #<id>`」拿不到决策 id。二选一：① 扩展该函数（或调用点）同时返回被引用消息文本；② 维护 `message_id → decision_id` 映射（推送时登记）。微信分发入口在 `bot_long_connection_service.rs:306-307`；注意既有 `process_bot_reply`（commands/bot.rs:1231-1270）已处理 claude_hook 卡片决策——AI 交付决策是另一系统，需新增接线并与之共存（推送消息文本末尾附 `决策ID: <id>` 作为兜底标识）。飞书侧：`im.message.receive_v1` 分支（bot_handler.rs:66 起）识别 parent_id 引用。

- [ ] **Step 5: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

预期：无错误。

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ && git commit -m "[AI交付] 交付事件推送微信/飞书及聊天引用回复回答决策"
```

---

### Task N2-1: Web 端操作补齐（7 个接口 + 操作入口 + 决策自由文本）

**Files:**
- Modify: `terminal-buddy/web/src/api.ts`（93-97 行现仅 5 个封装）
- Modify: `terminal-buddy/web/src/screens/AiDelivery.tsx`（38 行观察定位文案、40 行决策仅选项按钮）

**Interfaces:**
- Consumes: 既有 12 条 REST 路由（web/server.rs 49-96：create/plan/dispatch/complete/merge/cleanup-integration/retry 均已注册）
- Produces: `web/src/api.ts` 新增 7 个封装：`createAiDelivery` / `planAiDelivery` / `dispatchAiDelivery` / `completeAiDeliveryAttempt` / `mergeAiDelivery` / `cleanupIntegration` / `retryAiDeliveryTask`；Web 决策区 textarea 自由文本

- [ ] **Step 1: api.ts 补封装**

读 `web/src/api.ts` 93-97 行既有 5 个封装写法（**实际无 `post` 辅助函数，只有 `req<T>` + `api` 对象，23-98 行**——代码块以既有封装真实调用形态为准），按同风格加：

```ts
// req<T> 是本文件 23 行的私有函数；api 对象（77-98）只有具名方法、无通用 post。
// 沿用既有 approveAiDelivery/answerAiDecision 的「req + method:'POST' + body」写法（写 api.post 会编译失败）。
// 返回类型按各 handler 实际响应调整（delivery 类操作多为 AiDeliveryItem）。
export const createAiDelivery = (input: unknown) =>
  req<AiDeliveryItem>("/ai-delivery/deliveries", { method: "POST", body: JSON.stringify(input) });
export const planAiDelivery = (deliveryId: string) =>
  req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/plan`, { method: "POST" });
export const dispatchAiDelivery = (deliveryId: string) =>
  req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/dispatch`, { method: "POST" });
export const completeAiDeliveryAttempt = (deliveryId: string) =>
  req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/complete`, { method: "POST" });
export const mergeAiDelivery = (deliveryId: string) =>
  req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/merge`, { method: "POST" });
export const cleanupIntegration = (deliveryId: string) =>
  req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/cleanup-integration`, { method: "POST" });
export const retryAiDeliveryTask = (deliveryId: string, taskNodeId: string) =>
  req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/retry`, { method: "POST", body: JSON.stringify({ taskNodeId }) });
```

**评审修正（后端联动）**：既有 retry handler（ai_delivery_handler.rs:234-267）**无 body extractor**——请求体 `{taskNodeId}` 会被忽略，语义是「重试该交付全部 failed/rework 任务」。为实现逐任务重试，本任务需在后端 retry handler 加可选 `taskNodeId` 参数（`Option<Json<...>>` 或 query 参数，为空时保持整批语义）；**Web 端类型 `AiDeliveryItem`（api.ts:5）无 `taskNodeIds` 字段，Step 2 的 `selectedDelivery.taskNodeIds.map(...)` 需补字段**（从快照接口下发）。12 条路由形状与计划一致 ✓（server.rs:49-96）。

- [ ] **Step 2: AiDelivery.tsx 操作入口**

`web/src/screens/AiDelivery.tsx` 补操作按钮组（放在交付列表/详情适当位置）：

```tsx
{/* 操作区：创建交付 → 重新规划 → 派发 → 手动完成 → 合并 → 清理集成 → 重试 */}
{selectedDelivery && (
  <div className="ai-web-actions">
    <button onClick={() => createAiDelivery({/* 需求输入，按创建对话框既有字段 */})}>创建交付</button>
    <button onClick={() => planAiDelivery(selectedDelivery.id)}>重新规划</button>
    <button onClick={() => dispatchAiDelivery(selectedDelivery.id)}>派发</button>
    <button onClick={() => completeAiDeliveryAttempt(selectedDelivery.id)}>手动完成</button>
    <button onClick={() => mergeAiDelivery(selectedDelivery.id)}>合并</button>
    <button onClick={() => cleanupIntegration(selectedDelivery.id)}>清理集成</button>
    {selectedDelivery.taskNodeIds.map((id) => (
      <button key={id} onClick={() => retryAiDeliveryTask(selectedDelivery.id, id)}>重试</button>
    ))}
  </div>
)}
```

（32 行是**全局 5 秒轮询** snapshot（非「失败后」），操作后自动刷新状态；操作反馈用简单 alert 或内联错误文本，不静默。重试按钮建议仅对 failed/rework/policyViolation 任务显示。）

- [ ] **Step 3: 决策自由文本**

40 行 `decision.options.map(button)` 旁加 textarea + 提交按钮：

```tsx
<textarea value={answerText} onChange={(e) => setAnswerText(e.target.value)} placeholder="自由输入回答（不限于选项）" />
<button onClick={() => answerAiDecision(decision.id, answerText)}>提交回答</button>
```

（`answerAiDecision` 既有封装；后端接受任意 answer 字符串，无需改动。）

- [ ] **Step 4: Web 构建验证**

```bash
cd terminal-buddy/web && npx tsc --noEmit 2>&1 | tail -10
```

预期：无错误。

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add web/src/api.ts web/src/screens/AiDelivery.tsx && git commit -m "[AI交付] Web 端操作补齐：7 接口封装、操作入口、决策自由文本"
```

---

### Task N3-1: 质量门禁命令结果可视化

**Files:**
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（gate 行 515 附近，现仅一行 `gate.comments`）
- Modify: `terminal-buddy/src/components/ai-delivery/AiDeliveryWorkspace.css`

**Interfaces:**
- Consumes: `AiReviewGate.commandResults: AiCommandResult[]`（types/aiDelivery.ts 251-267，已随快照下发）
- Produces: 无后端改动；逐命令展示通过/失败、退出码、输出；失败命令可复制

- [ ] **Step 1: 渲染 commandResults**

`DeliveryDetail.tsx` gate 渲染处（515 行 `gate.comments` 旁）加：

```tsx
{gate.commandResults.length > 0 && (
  <div className="ai-gate-commands">
    {gate.commandResults.map((result, index) => (
      <div key={index} className={`ai-gate-command ${result.exitCode === 0 ? "ai-gate-command-pass" : "ai-gate-command-fail"}`}>
        <span className="ai-gate-command-status">{result.exitCode === 0 ? "✓ 通过" : "✗ 失败"}</span>
        <code className="ai-gate-command-cmd">{result.command}</code>
        <span className="ai-gate-command-code">退出码 {result.exitCode}</span>
        {result.output && <pre className="ai-gate-command-output">{result.output}</pre>}
        {result.exitCode !== 0 && (
          <button className="btn-secondary" onClick={() => navigator.clipboard.writeText(result.command)}>
            复制命令
          </button>
        )}
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 2: CSS**

```css
.ai-gate-commands { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.ai-gate-command { padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; }
.ai-gate-command-pass { border-left: 3px solid #22c55e; }
.ai-gate-command-fail { border-left: 3px solid #ef4444; }
.ai-gate-command-output { font-size: 12px; white-space: pre-wrap; max-height: 160px; overflow: auto; margin: 4px 0 0; }
```

- [ ] **Step 3: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/DeliveryDetail.tsx src/components/ai-delivery/AiDeliveryWorkspace.css && git commit -m "[AI交付] 质量门禁命令结果逐条可视化（退出码/输出/复制）"
```

---

### Task N5-1: 合并记录详情面板

**Files:**
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（merge 行 364-365 附近，现只显示一行 state）
- Modify: `terminal-buddy/src/types/aiDelivery.ts`（如缺 AiMergeRepositoryRecord 类型则补）

**Interfaces:**
- Consumes: `AiMergeRecord.repositories: AiMergeRepositoryRecord[]`（models 499-508：branch_name 501 / pre_merge_head 502 / merged_head 504 / error 507）
- Produces: 纯前端；逐仓库展示 branchName / preMergeHead / mergedHead，失败仓库高亮 error。**本任务是「合并冲突续接」（冲突续接-1）的前置**——续接按钮挂在本面板内

- [ ] **Step 1: 类型确认与补齐**

读 `src/types/aiDelivery.ts` 中 AiMergeRecord 定义（314 行附近），确认 repositories 数组内联类型含 `branchName/preMergeHead/mergedHead/error/state`；缺则补：

```ts
export interface AiMergeRepositoryRecord {
  repositoryId: string;
  branchName: string;
  preMergeHead?: string | null;
  mergedHead?: string | null;
  error?: string | null;
  state: string;
}
```

- [ ] **Step 2: 渲染逐仓库详情**

`DeliveryDetail.tsx` merge 行（364-365）扩展：

```tsx
{mergeRecord.repositories.map((repo) => (
  <div key={repo.repositoryId} className={`ai-merge-repo ${repo.state === "failed" ? "ai-merge-repo-failed" : ""}`}>
    <span className="ai-merge-repo-state">{repo.state}</span>
    <code>{repo.branchName}</code>
    <span className="ai-merge-repo-hash">前 {repo.preMergeHead?.slice(0, 8)}</span>
    {repo.mergedHead && <span className="ai-merge-repo-hash">后 {repo.mergedHead.slice(0, 8)}</span>}
    {repo.error && <pre className="ai-merge-repo-error">{repo.error}</pre>}
  </div>
))}
```

CSS：`.ai-merge-repo-failed { border-left: 3px solid #ef4444; }`。

- [ ] **Step 3: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/DeliveryDetail.tsx src/types/aiDelivery.ts && git commit -m "[AI交付] 合并记录逐仓库详情面板（分支/前后 commit/失败原因）"
```

---

### Task N6-1: 批量操作（多选 + 批量派发/重试/取消 + 汇总）

**Files:**
- Modify: `terminal-buddy/src/components/ai-delivery/AiDeliveryWorkspace.tsx`
- Modify: `terminal-buddy/src/services/tauri.ts`（`dispatchAiReadyTasks` 664-665 已有整批派发）

**Interfaces:**
- Consumes: `dispatchAiReadyTasks(deliveryId)`（整批）、`retryAiTaskNode`（逐任务，tauri.ts:666）；**评审修正：`cancelTaskNode` 不存在**（既有仅 `cancelAiAttempt` tauri.ts:669 按 attempt、`cancelAiDelivery` 按 delivery）——批量取消需本任务新增后端命令 `cancel_ai_task_node`（commands/ai_delivery.rs + lib.rs invoke_handler 注册 + tauri.ts 封装），语义：queued/ready/planned 状态任务置 cancelled + 级联终止其 attempt
- Produces: 任务多选（复选框 + Shift 连选）、按 workflowStepId 阶段筛选派发、一键重试所有 failed/rework、结果汇总（成功/失败计数）

- [ ] **Step 1: 多选 state**

`AiDeliveryWorkspace.tsx` 加：

```tsx
const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
const toggleTask = (id: string, shift: boolean, list: AiTaskNode[]) => {
  if (shift && lastSelectedRef.current) {
    // Shift 连选：lastSelected 与 id 之间（按列表顺序）全部选中
    const start = list.findIndex((t) => t.id === lastSelectedRef.current);
    const end = list.findIndex((t) => t.id === id);
    const range = list.slice(Math.min(start, end), Math.max(start, end) + 1).map((t) => t.id);
    setSelectedTaskIds((cur) => { const next = new Set(cur); range.forEach((r) => next.add(r)); return next; });
  } else {
    setSelectedTaskIds((cur) => { const next = new Set(cur); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }
  lastSelectedRef.current = id;
};
```

任务行前加 `<input type="checkbox" checked={selectedTaskIds.has(task.id)} onChange={(e) => toggleTask(task.id, e.shiftKey, tasks)} />`。

- [ ] **Step 2: 批量操作按钮组**

```tsx
const batch = (ops: PromiseSettledResult<unknown>[]) => {
  const ok = ops.filter((o) => o.status === "fulfilled").length;
  setBatchResult(`成功 ${ok}，失败 ${ops.length - ok}`);
};
// 批量派发：selectedTaskIds 中 state === 'ready' 的整批派发（复用 dispatchAiReadyTasks）
// 批量重试：selectedTaskIds 中 state ∈ {failed, rework, policyViolation} 逐任务 retryAiTaskNode
// 批量取消：selectedTaskIds 中 state ∈ {queued, ready, planned} 逐任务 cancelAiTaskNode（本任务新增命令）
// 一键重试所有失败：先筛选全部 failed/rework 任务再走批量重试
// 按阶段派发：基于 workflowStepId 筛选（如「只派发第一阶段」= workflowStepId === 第一个 step）
```

按钮组 UI：

```tsx
<div className="ai-batch-bar">
  <span>已选 {selectedTaskIds.size} 项</span>
  <button className="btn-secondary" onClick={batchDispatch}>批量派发</button>
  <button className="btn-secondary" onClick={batchRetry}>批量重试</button>
  <button className="btn-secondary" onClick={batchCancel}>批量取消</button>
  <button className="btn-secondary" onClick={retryAllFailed}>重试所有失败</button>
  <select value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)}>
    <option value="">全部阶段</option>
    {workflowSteps.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
  </select>
  <button className="btn-secondary" onClick={dispatchPhase}>派发所选阶段</button>
  {batchResult && <span>{batchResult}</span>}
</div>
```

（`retryAiTaskNode`（tauri.ts:666）/`cancelAiTaskNode`（本任务新增）/`dispatchAiReadyTasks`（tauri.ts:664-665）以 tauri.ts 现有封装为准；`workflowSteps` 变量在 AiDeliveryWorkspace 不存在——从 `delivery.workflowSteps`（types/aiDelivery.ts:180 有该字段）取。）

- [ ] **Step 3: 类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src/components/ai-delivery/AiDeliveryWorkspace.tsx && git commit -m "[AI交付] 任务批量操作：多选/按阶段派发/重试所有失败/结果汇总"
```

---

### Task N7-1: 交付模板（模型 + CRUD 命令 + 前端）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/models/ai_delivery.rs`（新增 `AiDeliveryTemplate`）
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（模板 CRUD + 占位符替换 + 「保存为模板」）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs` + `lib.rs`（4 个命令）
- Modify: `terminal-buddy/src/components/ai-delivery/TaskDeliveryDialogs.tsx`（DeliveryCreateDialog 283 起选模板）
- Modify: `terminal-buddy/src/types/aiDelivery.ts`、`src/services/tauri.ts`

**Interfaces:**
- Produces: `AiDeliveryTemplate { id, name, description, workflow_id, quality_gate, role_mappings, common_prompt, created_at, updated_at }`；命令 `create_ai_delivery_template` / `update_ai_delivery_template` / `delete_ai_delivery_template` / `list_ai_delivery_templates`；占位符 `{featureName}` / `{moduleName}` 创建时替换

- [ ] **Step 1: 模型**

`models/ai_delivery.rs` 加（camelCase + serde default，与既有模型风格一致）：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDeliveryTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub workflow_id: String,
    pub quality_gate: Option<String>,
    pub role_mappings: Vec<serde_json::Value>,  // 角色映射（结构按需定义；可从 AiRole 列表导出：roleId → 职责/允许写入路径）
    pub common_prompt: String,
    pub created_at: String,
    pub updated_at: String,
}
```

- [ ] **Step 2: 服务层**

`ai_delivery_service.rs` 加 4 个函数（参照既有 CRUD 模式，如 profile/workspace 服务的 save/get/delete + **新增常量 `TEMPLATES_DIR`——常量表（30-44）目前无此目录，需先新增**）：

```rust
pub fn create_ai_delivery_template(input: CreateAiDeliveryTemplateInput) -> Result<AiDeliveryTemplate, String>
pub fn update_ai_delivery_template(input: UpdateAiDeliveryTemplateInput) -> Result<AiDeliveryTemplate, String>
pub fn delete_ai_delivery_template(id: &str) -> Result<(), String>
pub fn list_ai_delivery_templates() -> Result<Vec<AiDeliveryTemplate>, String>
// 占位符替换（创建交付时调用）：
pub fn expand_template(template: &AiDeliveryTemplate, feature: &str, module: &str) -> (String, String) {
    // 返回 (requirement, common_prompt)——替换 {featureName}/{moduleName}
    let requirement = template.description
        .replace("{featureName}", feature).replace("{moduleName}", module);
    let prompt = template.common_prompt
        .replace("{featureName}", feature).replace("{moduleName}", module);
    (requirement, prompt)
}
// 「保存为模板」：从已完成交付提取 workflowId/qualityGate/roleMappings/commonPrompt（快照数据取）
pub fn save_delivery_as_template(delivery_id: &str, name: &str) -> Result<AiDeliveryTemplate, String>
```

- [ ] **Step 3: 命令与注册**

4 个命令（`commands/ai_delivery.rs` + lib.rs invoke_handler）。输入结构 `CreateAiDeliveryTemplateInput`/`UpdateAiDeliveryTemplateInput` 与前端字段一一对应（name/description/workflowId/qualityGate/roleMappings/commonPrompt）。

- [ ] **Step 4: 前端**

- `tauri.ts`：`listAiDeliveryTemplates` / `createAiDeliveryTemplate` / `updateAiDeliveryTemplate` / `deleteAiDeliveryTemplate` / `saveDeliveryAsTemplate` 封装。
- `DeliveryCreateDialog`（TaskDeliveryDialogs.tsx 283 起）加模板下拉：选中模板 → 自动填充 description（含占位符，创建对话框加「功能名称」「模块名称」两个输入用于替换）。
- 创建完成后交付详情「保存为模板」按钮（含命名输入）。
- 模板管理入口（重命名/删除）：放在 ConfigDialog 或 AiDeliveryApp 侧边栏新增「模板」项。

- [ ] **Step 5: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 6: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ src/components/ai-delivery/ src/services/tauri.ts src/types/aiDelivery.ts && git commit -m "[AI交付] 交付模板：模型/CRUD/占位符替换/保存为模板/创建选择"
```

---

### Task N8-1: 失败聚合 + 标记忽略（skipped）+ 带参重试

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（skipped 状态处理 + 触顶暂停 + 聚合辅助）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs`（`mark_task_skipped` 命令）
- Modify: `terminal-buddy/src/components/ai-delivery/`（重试对话框 + 聚合展示 + skipped 卡片）

**Interfaces:**
- Consumes: 迭代 1 T4-2 `update_task_node`（字段能力：taskPrompt/preferredAgentId/retryCount 修改）；`retry_task_node`
- Produces: 命令 `mark_task_skipped(task_node_id) -> Result<(), String>`；`retry_task_node` 调用前经 `update_task_node` 调整参数（前端组合）；自动重试触顶 → 暂停交付 + 通知；失败聚合：attempt.summary 文本聚类。**引入任务状态第 12 种 `skipped`**：workspace-utils stateNames + T3-2 的 STATE_COLORS + 收尾判定同步

- [ ] **Step 1: skipped 语义**

`mark_task_skipped`：加载 task，状态 ∈ {failed, policyViolation, rework, needsInput} 时置 `state = "skipped"`（新状态值——**注意**：任务状态全集 11 种不含 skipped，本项引入第 12 种，需同步更新 workspace-utils.ts 的 stateNames 注册与 STATE_COLORS、`refresh_ready_task_nodes` 的 succeeded 判定**不把 skipped 视为成功依赖**、合并/收尾判定跳过 skipped）。**评审修正——后端收尾判定 3 处需显式排除 skipped**：`merge_delivery_locally_locked_impl:2004` 前置校验（`tasks.iter().any(|t| t.state != "succeeded")` → Err）、自动路径 3153 与 `try_complete_workflow_delivery:3360`（全 succeeded 才置 deliverySucceeded）——三处判定改为「succeeded ∪ skipped 视为可收尾」，否则 DoD「skipped 不阻塞合并」无法满足。级联：被 skipped 任务依赖的下游任务**不自动跳过**（保持 planned，可手动处理——聚合展示里提示）。

```rust
pub fn mark_task_skipped(task_node_id: &str) -> Result<(), String> {
    let mut task = Self::get_task_node(task_node_id)?;
    if !matches!(task.state.as_str(), "failed" | "policyViolation" | "rework" | "needsInput") {
        return Err(format!("任务状态 {} 不可标记忽略", task.state));
    }
    task.state = "skipped".to_string();
    task.updated_at = chrono::Utc::now().to_rfc3339();
    Self::save(TASK_NODES_DIR, &task.id, &task)?;
    Self::append_event(&task.delivery_id, Some(&task.id), None, "taskSkipped",
                       &format!("任务 {} 已标记忽略（不阻塞后续合并）", task.title))?;
    Ok(())
}
```

- [ ] **Step 2: 自动重试触顶暂停（评审修正）**

**评审修正**：改造 `retry_task_node`（2402 起）**既有用尽分支（2411-2431，现为 return Err）**，而非另插一段：保留既有 `retry_count == 0` 不限守卫（2407-2409），当重试次数用尽且 `retry_count != 0` 时，不再只 append 事件——把 delivery 置 `state = "paused"` 并推送（APP_HANDLE 统一 emit 已有）：

```rust
if attempted >= task.retry_count && task.retry_count != 0 {  // 必须显式排除 0（0 = 不限；缺则恒真，首次重试即暂停交付）
    // 触顶：暂停交付并通知，不直接标记失败（改造既有 2411-2431 用尽分支）
    let mut delivery = Self::get_delivery(&task.delivery_id)?;
    delivery.state = "paused".to_string();
    Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
    Self::append_event(&delivery.id, Some(&task.id), None, "deliveryPaused",
                       &format!("任务 {} 重试触顶，交付已暂停", task.title))?;
    return Err(format!("重试次数用尽，交付已暂停"));
}
```

（注意与既有「自动提额」（2433-2434）的关系：提额逻辑仍生效，本分支在提额后仍超限时触发。**迭代 1 T4-3 已去 min(10) 钳制、提额基准改 `task.retry_count`**——实现时以改造后的既有分支为基准，做最小改动。）

- [ ] **Step 3: 失败聚合**

service 加（或前端从 snapshot 计算——**推荐前端计算**，零后端）：

```ts
// AiDeliveryWorkspace.tsx 内：
const aggregateFailures = (attempts: AiAttempt[]) => {
  const failed = attempts.filter((a) => a.state === "failed" && a.summary);
  const buckets = new Map<string, number>();
  failed.forEach((a) => {
    const key = summarize(a.summary ?? ""); // 取首行或首 40 字符聚类
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  });
  return [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
};
```

UI：交付详情加「失败聚合」区（如「3/12 失败，根因: npm registry 不可达」）。

- [ ] **Step 4: 带参重试对话框**

任务卡片「带参重试」打开对话框（复用迭代 1 T4-4 TaskNodeEditor 的字段子集：taskPrompt / preferredAgentId / retryCount）：先 `updateAiTaskNode({ id, taskPrompt, preferredAgentId, retryCount })` 再 `retryTaskNode(id)`。

- [ ] **Step 5: 前端注册与样式**

`workspace-utils.ts`：`taskSkipped: "已标记忽略"`；**任务状态注册（评审修正：原稿写的 `failedEventTypeSet` 是事件类型集合，任务状态从不进该集合，无操作）**：`taskStateNames`（67-79）加 `skipped: "已忽略"`、`taskColumn`（52-60）/`boardColumns`（42-50）归入相应列。`STATE_COLORS`（迭代 1 T3-2）加 `skipped: "#94a3b8"`（同 planned 灰）。任务卡片 skipped 态灰底删除线样式。

- [ ] **Step 6: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 7: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ src/components/ai-delivery/ src/services/tauri.ts src/types/aiDelivery.ts && git commit -m "[AI交付] 失败聚合/标记忽略/带参重试/重试触顶暂停交付"
```

---

### Task N4-1: policyViolation 一键恢复（确认现场 + 重跑验收）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（新命令）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs` + `lib.rs`
- Modify: `terminal-buddy/src/components/ai-delivery/`（任务卡片 UI）

**Interfaces:**
- Consumes: 迭代 1 T4-3 已放行 policyViolation 重试白名单；N8-1 `mark_task_skipped`（「标记忽略」入口复用）
- Produces: 命令 `confirm_policy_violation_site(task_node_id) -> Result<(), String>`：标记现场可接受 → 重跑验收（复用 `finish_attempt` 的验收执行路径或直接调既有验收辅助）

- [ ] **Step 1: 服务层命令**

```rust
/// 确认 policyViolation 现场可接受：将任务与最近 attempt 从 policyViolation 复位，重跑验收命令
pub fn confirm_policy_violation_site(task_node_id: &str) -> Result<(), String> {
    let mut task = Self::get_task_node(task_node_id)?;
    if task.state != "policyViolation" {
        return Err(format!("任务状态 {} 不是 policyViolation", task.state));
    }
    // 找到最近 attempt（attempt_ids 最后一个）
    let attempt_id = task.attempt_ids.last().ok_or("无 attempt 可复核")?;
    let mut attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?;  // get_attempt 不存在
    attempt.state = "running".to_string();   // 重跑验收（与 finish_attempt 验收执行路径一致）
    Self::save(ATTEMPTS_DIR, attempt_id, &attempt)?;
    task.state = "awaitingReview".to_string();
    task.updated_at = chrono::Utc::now().to_rfc3339();
    Self::save(TASK_NODES_DIR, &task.id, &task)?;
    Self::append_event(&task.delivery_id, Some(&task.id), Some(attempt_id),
                       "policyViolationAccepted", &format!("任务 {} 现场已确认，重跑验收", task.title))?;
    // 触发验收执行：复用 finish_attempt 中「运行验收命令 → 结果 → 置 completed/failed」的既有代码路径
    // （具体复用方式以既有 finish_attempt 结构为准：若验收是独立函数则直接调用，否则同步执行验收命令并置态）
    Ok(())
}
```

> **评审修正（关键设计缺口）**：`finish_attempt:2993` 先调 `audit_contract_scope`（4520-4553：禁止仓库状态 + `audit_allowed_write_paths` 4552 用 git diff base_commit **静态检测越权文件**）；violation 时验收块（2998-3001，需 `policy_violation.is_none()`）**不执行**，3042-3043 直接置 attempt=policyViolation。**「确认现场」不改现场文件 → 重跑必然再次违规 → 死循环，验收命令永远不跑**。必须给 `finish_attempt` 加「跳过审计」参数（如 `skip_audit: bool`），本命令经其重跑验收路径时跳过 `audit_contract_scope`。另：验收执行是**内联闭包**（3016-3031）非独立函数——按既有模式复制最小段或先抽函数。实施前读 `finish_attempt` 的验收段（2993 附近）确认结构；执行后按既有规则置 completed/failed/awaitingReview 并 append 对应事件。

- [ ] **Step 2: 命令与注册 + 前端**

任务卡片 policyViolation 态显示两个按钮：「确认现场，继续验收」（调 `confirmPolicyViolationSite`）与「标记忽略」（调 N8-1 的 `markTaskSkipped`）。tauri.ts 加 `confirmPolicyViolationSite` 封装。`workspace-utils.ts` eventTypeNames 注册：`policyViolationAccepted: "现场已确认"`。

- [ ] **Step 3: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ src/components/ai-delivery/ src/services/tauri.ts && git commit -m "[AI交付] policyViolation 一键确认现场重跑验收"
```

---

### Task 基线-1: 依赖基线版本校验

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`return_review_dependencies_for_rework` 3195-3227、`allocate_task_worktree` 3495 起依赖分支检查块 3544-3551）
- Modify: `terminal-buddy/src-tauri/src/models/ai_delivery.rs`（`AiTaskContract` 基线字段）

**Interfaces:**
- Consumes: 既有「质量门禁失败把依赖置 rework」（3200-3213，仅限 succeeded 依赖 3205-3207）；`allocate_task_worktree` 3544-3551（仅查 branch_name 存在性）；迭代 1 T4-2 的 contract `dirty` 机制
- Produces: 重派发时校验依赖分支 commit 是否过期基线（比对依赖 attempt 完成时的 commit 与分支当前 HEAD）；过期 → 拒派发并提示重跑上游

- [ ] **Step 1: 记录基线 commit（评审修正：复用既有字段，不新增）**

**评审修正**：`AiTaskContract` 已有 `repository_status_baselines`（models:209，`AiRepositoryStatusBaseline` 236-241 含 head_commit）语义重叠；且验收时依赖分支 commit 已有 `validated_commit`（3066-3069 记录）可直接复用——**无需在 `allocate_task_worktree` 重新记录新字段**。本任务改为：派发校验时读依赖 attempt 的 `validated_commit`（或既有基线快照）与分支当前 HEAD 比对（校验逻辑落在 3528-3555 段：依赖状态检查在 3529-3536、branch_name 存在性在 3544-3551）。

- [ ] **Step 2: 派发时校验**

`dispatch_task_node`（2297-2400）在 `allocate_task_worktree` 调用后、创建 attempt 前：对每个依赖，比较「基线 commit」与当前分支 HEAD：

```rust
if let Some(baseline) = contract_dependency_baselines.get(dep_id) {
    let current = read_branch_head(&repo_path, &branch)?;  // git rev-parse 复用既有 git 调用方式
    if current != *baseline {
        return Err(format!("依赖 {} 的基线 commit 已过期（{} → {}），请重跑上游任务", dep_id, baseline, current));
    }
}
```

（git 命令执行方式参照 service 内既有 git 调用，如合并/验证相关代码。）

- [ ] **Step 3: rework 时下游失效**

`return_review_dependencies_for_rework`（3195-3227）只把 succeeded 依赖置 rework——**保持现状**（上游重跑后下游仍以旧基线执行的问题由 Step 2 的派发校验拦截）。无需改动该函数；把「下游已 succeeded 任务不失效」改为：其 contract.dirty = true（复用迭代 1 T4-2 的 dirty 机制），重试派发时重新审计。

- [ ] **Step 4: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

- [ ] **Step 5: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/models/ai_delivery.rs src-tauri/src/services/ai_delivery_service.rs && git commit -m "[AI交付] 依赖基线 commit 记录与派发校验，防下游基于过期基线执行"
```

---

### Task 冲突续接-1: 合并冲突续接入口

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`merge_delivery_locally_locked_impl` 1999-2247 冲突失败回滚 2205-2224；新增续接命令）
- Modify: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs` + `lib.rs`
- Modify: `terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`（N5-1 面板内「冲突已解决，继续合并」按钮）

**Interfaces:**
- Consumes: N5-1 详情面板（用户看到哪个仓库冲突、卡在什么分支）；merge 记录两级状态（`AiMergeRecord.state`：merging 2125 / blocked 2210 / rolledBack 2212 / completed 2228；仓库子记录：pending 2172 / merged 2200 / failed 2206 / rolledBack 2286 / rollbackFailed 2288）
- Produces: 命令 `continue_merge_after_conflict(delivery_id) -> Result<(), String>`：冲突已解决后，对失败仓库重跑合并，成功则继续收尾。**与迭代 3 的 N7-2（mergeFailed 终态）联动**

- [ ] **Step 1: 续接命令**

```rust
/// 冲突已解决后继续合并：只重跑 state == "failed" 的仓库子记录，成功则走既有收尾
pub fn continue_merge_after_conflict(delivery_id: &str) -> Result<(), String> {
    let mut merge_record = /* 加载该交付最近的 merge 记录 */;
    if merge_record.state != "blocked" {
        return Err(format!("merge 记录状态 {} 不可续接（仅 blocked）", merge_record.state));
    }
    let mut all_ok = true;
    for repo in &mut merge_record.repositories {
        if repo.state == "failed" {
            // 复用 merge_delivery_locally_locked_impl 中单仓库合并段（按仓库的合并/提交/回滚既有逻辑）
            match Self::merge_single_repository(&repo.repository_id) {
                Ok(head) => { repo.state = "merged".to_string(); repo.merged_head = Some(head); }
                Err(e) => { repo.error = Some(e.to_string()); all_ok = false; }
            }
        }
    }
    Self::save(MERGE_RECORDS_DIR, &merge_record.id, &merge_record)?;
    if all_ok {
        merge_record.state = "completed".to_string();
        Self::save(MERGE_RECORDS_DIR, &merge_record.id, &merge_record)?;
        Self::append_event(delivery_id, None, None, "mergedLocally", "冲突已解决，合并完成")?;
        // 评审修正：补成功收尾（对照成功路径 2228-2246；缺则交付卡在 running/needsInput、worktree 残留）
        Self::complete_delivery_contracts(&delivery_id)?;    // 2231
        let mut delivery = Self::get_delivery(delivery_id)?; // 2233-2235
        delivery.state = "completed".to_string();
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
        // 清理集成分支 / 任务 worktree（2244-2245，按既有清理逻辑复用）
    } else {
        Self::append_event(delivery_id, None, None, "mergeFailed", "仍有仓库合并失败")?;
    }
    Ok(())
}
```

> 实施前读 `merge_delivery_locally_locked_impl`（1999-2247）确认单仓库合并段的实际代码形态（validated_commit 校验 2151-2163、失败回滚 2205-2224、`MERGE_RECORDS_DIR` 常量（42）与 merge 记录加载方式（`get_merge_records` 1954）），把合并逻辑抽成可单仓库复用的内部函数 `merge_single_repository`（或按既有结构最小复制），本命令与 `merge_delivery_locally_locked_impl` 共用。**评审修正**：`merge_single_repository` 内必须保留 `validated_commit` TOCTOU 校验（2151-2163）与 `ensure_clean_repository`/current_branch 检查（2137-2144）；**merge 冲突时 source 仓库处于 MERGE_HEAD 中间态**——续接前需确认冲突已在 source 仓库解决（git status 无冲突标记）、仓库处于可合并状态，否则以失败返回并保持 blocked。

- [ ] **Step 2: 命令注册 + 前端**

`DeliveryDetail.tsx` N5-1 面板内、存在 failed 仓库且 mergeRecord.state === "blocked" 时显示：

```tsx
<button className="btn-primary" onClick={continueMerge}>冲突已解决，继续合并</button>
```

tauri.ts 加 `continueMergeAfterConflict(deliveryId)` 封装。

- [ ] **Step 3: 编译与类型检查**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -5 && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/ src/components/ai-delivery/DeliveryDetail.tsx src/services/tauri.ts && git commit -m "[AI交付] 合并冲突解决后继续合并入口"
```

---

### Task 补派-1: 候选 Agent 无容量自动补派

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（`select_agent` 3229 起、`dispatchDeferred` 事件处理 2481 附近）

**Interfaces:**
- Consumes: `select_agent` 无容量报错（3271-3286、报错 3244）；`dispatchDeferred` 事件（2481）已存在
- Produces: 无容量时自动选其他 Agent 补派（跳过无容量 Agent）；全无容量时重试派发（延迟 N 秒再试一次，最多 M 次），而非直接失败

- [ ] **Step 1: 读 select_agent 现状**

```bash
cd terminal-buddy && sed -n '3229,3300p' src-tauri/src/services/ai_delivery_service.rs
```

- [ ] **Step 2: 补派逻辑（评审修正：不改返回类型）**

**评审修正**：`select_agent` 真实签名是 `Result<AiAgent, String>`（3229-3234，**无 Option 包装**）——原稿 `return Ok(None)` 无法编译，且调用点 `dispatch_task_node:2335` 的 `?` 与 `agent.id`（2374）需连锁改造。**改为不改返回类型**：候选 Agent 逐个 `check_capacity`（3299-3354）跳过无容量者后仍全部无容量时，返回**可识别的专用错误**并保证不误报其他错误：

```rust
// 全部候选无容量：返回专用错误（不是 Ok(None)），派发方据此保持任务 ready 等待既有兜底
Self::append_event(&delivery_id, None, None, "dispatchDeferred", "全部候选 Agent 无容量，稍后重试")?;
return Err("全部候选 Agent 无容量".to_string());
```

**重试机制依赖既有兜底（评审确认已足够，不新增调度器）**：`dispatch_ready_tasks`（2481-2487）已有「派发失败 → append dispatchDeferred」模式；dispatch 失败时任务状态保持 ready（2389 才改状态）；桌面端 4 秒轮询（AiDeliveryWorkspace.tsx:385）自动重派。**无容量报错实际位置：3244 是指定 Agent 分支，候选全无容量在 3286——两处分支都需处理。**

派发方（`dispatch_task_node` 或调度循环）收到 None：把任务保持/置回 ready，并注册一次性延迟重派（利用既有 4 秒前端轮询的兜底 + 后端 sleep 重试——具体机制按既有 dispatchDeferred 的处理现状扩展，避免新增复杂调度器）。

- [ ] **Step 3: 编译验证**

```bash
cd terminal-buddy && cargo check 2>&1 | tail -10
```

- [ ] **Step 4: 提交**

```bash
cd terminal-buddy && git add src-tauri/src/services/ai_delivery_service.rs && git commit -m "[AI交付] 候选 Agent 无容量自动补派与延迟重试"
```

---

## 迭代 2 验证（DoD 源自规范 §4 各节验收标准）

全部任务完成后执行：

- [ ] `cd terminal-buddy && cargo test` — 全通过（含迭代 1 环依赖 3 例 + 既有测试模块）
- [ ] `cd terminal-buddy && cargo check` — 无错误无警告
- [ ] `cd terminal-buddy && npx tsc --noEmit` — 无错误
- [ ] N1：决策请求/任务失败/合并完成/交付成功均到达配置的聊天（微信/飞书）；聊天内引用回复可回答决策并驱动决策状态更新
- [ ] N2：Web 端可完成创建交付 → 重新规划 → 派发 → 手动完成 → 合并 → 清理集成 → 重试全流程；决策支持自由文本回答
- [ ] N3：审查环节可看到每条门禁命令的退出码与输出；失败命令可复制
- [ ] N4：policyViolation 任务可一键确认现场并重跑验收；可标记 skipped，不阻塞后续合并
- [ ] N5：合并冲突时可看到每个仓库的分支、合并前后 commit 与失败原因
- [ ] N6：多选后可批量派发/重试/取消；结果汇总展示成功与失败计数
- [ ] N7：可从已完成交付保存模板；创建时选模板自动填充字段；占位符替换生效
- [ ] N8：自动重试触顶后交付暂停并通知；失败聚合信息在 UI 可见；skipped 任务不阻塞合并
- [ ] 基线：依赖基线 commit 过期时拒派发并提示重跑上游
- [ ] 冲突续接：merge 记录 blocked 时「冲突已解决，继续合并」可完成续接；仍有失败仓库时保持 blocked
- [ ] 补派：候选 Agent 全无容量时任务回 ready 并自动重派，不报错卡死

## 自审记录

- **规范覆盖**：§4.1-4.8 + §6.3 前三项（基线/冲突续接/补派）全部有对应任务；验收标准全部列入验证清单。
- **无占位符**：所有代码步骤含完整代码块或精确行号锚点 + 读取指令；「参照既有实现」均为可执行的读代码指令（N1-1 微信签名、N4-1 验收段、冲突续接-1 单仓库合并段均注明先读代码确认）。
- **类型一致性**：`skipped` 状态（N8-1 引入第 12 种任务状态 → workspace-utils/STATE_COLORS/收尾判定同步）；`markTaskSkipped`（N8-1 定义 → N4-1 复用）；`policyViolationAccepted` 事件（N4-1 产生 → 注册点列出）；`mergeFailed` 事件（冲突续接-1 使用，eventTypeNames 已有 209）；`contract.dirty`（迭代 1 T4-2 定义 → 基线-1 复用）；`confirmPolicyViolationSite`/`continueMergeAfterConflict` 前端封装（tauri.ts 封装点列出）；N5-1 面板是冲突续接-1 的前置（入口挂载点一致）。
- **已知偏差**：N1-1 的微信/飞书接线依赖既有 bot 消息链路的真实形态，实施时以 `bot_weixin_service.rs:371-412` 与 `bot_handler.rs:66` 的既有分支为准；补派-1 的「延迟重派机制」按既有 dispatchDeferred 现状扩展，避免引入新调度器。
- **评审修正（2026-08-02 四代理并行审核后修订）**：P1 修正 8 处——补派-1 改为不改返回类型（专用错误 + 依赖既有兜底）、N8-1 补 `retry_count != 0` 守卫并改造既有用尽分支（2411-2431）、skipped 收尾判定 3 处（2004/3153/3360）显式排除、N6-1 新增 `cancel_ai_task_node` 命令、N2-1 retry 逐任务化（后端 handler 加可选参数）+ AiDeliveryItem 补 taskNodeIds、N4-1 `get_attempt` → `Self::get::<AiAttempt>` 且补 finish_attempt「跳过审计」参数（防确认现场死循环）、冲突续接-1 补成功收尾（2231/2233-2235/2244-2245）与 TOCTOU/MERGE_HEAD 处理；P2 修正：微信推送 async 上下文 spawn、推送配置复用 BotChannelConfig、基线-1 复用 validated_commit 与既有 repository_status_baselines、N8-1 前端注册改 taskStateNames/taskColumn/boardColumns。

---

*行号引用以 `docs/ai-delivery-implementation-plan.md` 核实的 HEAD `ea369ac` 代码为准；实现时如行号漂移，按函数名定位。*
