# DAG 独立 Tab 与跨仓库依赖规划改进设计

日期：2026-08-04
关联模块：`terminal-buddy/src/components/ai-delivery/`、`terminal-buddy/src-tauri/src/services/ai_delivery_service/`

## 背景

AI 交付看板的 DAG 视图存在三个问题：

1. **DAG 不是独立 tab**：当前是 `viewMode: "list"|"dag"` 切换（`DeliveryDetail.tsx:762-770`），且切到 DAG 会隐藏"运行记录/事件/产物/报告"等所有面板。
2. **DAG 缺开始/结束节点**：只有任务节点，依赖全貌不直观。
3. **跨仓库依赖缺失**：wms 与 basedata 等跨仓库任务之间没有任何依赖连线，但业务上应存在依赖。

## 目标

1. DAG 成为任务 tab 栏的**第一个 tab**（排在"待规划"等状态 tab 之前），显示全部任务，节点按状态着色。
2. DAG 增加虚拟「开始」「结束」节点。
3. 改进 AI 规划 prompt，让 manager agent 在规划阶段正确识别并建立跨仓库依赖（用户已选方向 A）。

## 非目标

- 不改 manager 输出的 JSON Schema（`manager.rs:246-276`）。
- 不改依赖校验规则（`helpers.rs:392-467`）。
- 不做 DAG 拖拽连线的手动依赖编辑（方向 C，已排除）。
- 不改任务数据模型 `AiTaskNode`。

## 现状分析

### DAG 渲染
- `TaskDagView.tsx` 用 `@xyflow/react`，节点 `type="taskNode"`，边由 `dependencyIds` 生成。
- `utils/taskGraphLayout.ts` 做拓扑分层布局（Kahn 变体），忠实渲染 `dependencyIds`，**无渲染 bug**。
- 节点拖拽位置持久化到 `localStorage`（`ai-dag-drag-positions:v1:`）。
- `TaskNodeCard.tsx` 已用 `STATE_COLORS`（5-10 行）按 `task.state` 着色，DAG 显示全部任务时天然带状态色。

### Tab 结构
- `boardColumns`（`workspace-utils.ts:42-50`）：待规划 / 待决策 / 待执行 / 执行中 / 验收中 / 已完成 / 异常。
- `DeliveryTabId`（`workspace-utils.ts:51`）= boardColumns id ∪ {attempts, events, artifacts, report}。
- `activeTaskTab` 初始值 `"planned"`（`AiDeliveryWorkspace.tsx:136`），`selectProject`(865)/`selectDelivery`(869)/`replan`(903) 均重置为 `"planned"`。
- `viewMode` 切换在 tab 栏下方独立 div（`DeliveryDetail.tsx:762-768`）。
- `visibleTasks`（`AiDeliveryWorkspace.tsx:243-248`）：当 `activeTaskTab` 不属于 boardColumns 时返回空数组——DAG tab 不依赖它（DAG 直接用全部 `tasks`）。

### 依赖生成与校验
- 依赖由 manager agent 规划时输出 `dependencyIndexes`（`manager.rs:266` schema），后端转为 `dependencyIds`（`manager.rs:815-849`）。
- 校验 `validate_manager_workflow_plan`（`helpers.rs:392-467`）：无 workflow 时**完全不校验**依赖；有 workflow 时强制"步骤 N 依赖步骤 N-1 全部任务"，但**不阻止额外依赖**。
- **根因**：`build_manager_prompt`（`helpers.rs:382`）约束 #2 仅写"跨服务改动用 dependencyIndexes 表示前置关系"，未给出"何时该建依赖"的判断准则，导致 AI 漏建跨仓库依赖。校验规则与前端渲染均无问题。

## 设计

### 1. DAG 改为首个 tab

**`workspace-utils.ts`**
- `DeliveryTabId`（51 行）联合类型增加 `"dag"`。

**`DeliveryDetail.tsx`**
- tab 栏（705 行起，`boardColumns.map` 之前）渲染 DAG tab 按钮：`role="tab"`、`activeTaskTab === "dag"` 时 `active`，计数显示 `tasks.length`。
- 移除 `viewMode` 状态（150 行）与 `ai-detail-tabs` 切换 div（762-768 行）。
- 渲染分支：`activeTaskTab === "dag"` 时渲染 `<TaskDagView tasks={tasks} onNodeClick={(id) => setEditingTaskId(id)} />`（沿用现有 770 行调用）；其余 tab 逻辑不变。

**`AiDeliveryWorkspace.tsx`**
- `activeTaskTab` 初始值改 `"dag"`（136 行）。
- `selectProject`(865)、`selectDelivery`(869)、`replan`(903) 中的 `setActiveTaskTab("planned")` 改为 `setActiveTaskTab("dag")`，使进入交付/重新规划后默认落到全局 DAG 视图。

### 2. 开始 / 结束节点（虚拟）

**`utils/taskGraphLayout.ts` — `computeTaskGraphLayout`**
在生成任务 nodes/edges 后注入两个虚拟节点：

- `START`（id `"__start__"`，type `"markerNode"`）：对所有 `dependencyIds` 为空的任务，加边 `START → task`。
- `END`（id `"__end__"`，type `"markerNode"`）：对"未被任何任务的 dependencyIds 引用"的任务，加边 `task → END`。
- 布局：`START` 置于最左（`x = -240`，y 取 layer-0 任务的中位），`END` 置于最右（`x = (maxLayer+1)*240`，y 取末端任务的中位）。

**缓存与指纹**
- `computeVersion`（20-27 行）只哈希真实任务 id 与边，不含虚拟节点（虚拟节点由任务集派生，避免无谓缓存失效）。

**`TaskDagView.tsx`**
- `nodeTypes` 增加 `markerNode`（渲染「开始」「结束」标签，无 Handle 交互或仅占位）。
- `applySavedPositions` 跳过虚拟节点 id，`onNodeDragStop` 不持久化虚拟节点。
- `onNodeClick` 对虚拟节点不触发编辑（按 id 前缀 `__` 判定忽略）。
- `tasksKey` 指纹（56-62 行）不变（仍基于真实任务）。

### 3. 强化规划 prompt（方向 A 核心）

**`helpers.rs` — `build_manager_prompt`（382 行）**
将现有约束 #2 从"表示前置关系"升级为可操作的判断准则（最终措辞以代码为准）：

```
2. 跨服务依赖判断（必须遵守）：
   - 若任务 B 的正确改动需要任务 A 先完成，则 B 的 dependencyIndexes 必须包含 A，
     且 A 在 tasks 中排在 B 之前（dependencyIndexes 只能引用更早的任务）。
   - 出现以下任一情况即视为存在依赖，必须建立：
     a) A 改动了 B 依赖的契约：API 接口/参数/返回值、数据模型、DB schema/迁移、
        共享类型定义、对外配置项；
     b) A 属于基础/底层服务（如基础数据、用户、字典、权限等），B 属于依赖它的
        上层业务服务（如仓储 wms、订单、库存）；
     c) 同一编排步骤内按服务拆分的并行任务，若存在 a/b 所述契约依赖，也要建立依赖，
        而非默认并行；必要时把被依赖的服务拆到更早的编排步骤。
   - 反之，若两个跨服务任务无任何契约或数据依赖，不得建立依赖（避免不必要串行）。
   - 判断口诀：B 离开 A 能否独立正确完成——不能则必须依赖。
```

约束 #6（步骤间强制依赖）保留不变。

> 该措辞同时覆盖"有用 workflow"与"无 workflow"：无 workflow 时 c 项"编排步骤"自动不适用，a/b 仍生效。因此不依赖用户是否使用编排方案。

### 4. 验证

- **后端**：`cd src-tauri && cargo test`（ai_delivery_service 现有测试，确保 prompt 字符串改动不破坏校验/解析）。
- **前端**：`npx tsc --noEmit`（`DeliveryTabId` 类型改动牵连 tab 渲染与 `activeTaskTab` 初始值）。
- **手动**：`npm run tauri dev`，对含 wms+basedata 的交付重新"生成任务图"，确认：① DAG 为首个 tab；② 出现开始/结束节点；③ wms↔basedata 间出现应有的依赖连线。

## 假设

- 虚拟开始/结束节点为纯展示，不代表真实任务，不参与依赖校验、派发、成果交接。
- DAG tab 显示全部任务（含已完成/已忽略），节点按 `task.state` 着色（复用 `TaskNodeCard` 现有 `STATE_COLORS`）。
- 用户交付是否使用 workflow 不影响方案正确性（第 3 部分两种情况均覆盖）。

## 风险与缓解

- **过度依赖**：prompt 改动可能让 AI 建立不必要串行。缓解：明确"无契约则不建依赖"的反向约束；生成后人工在 DAG tab 核对。
- **交互习惯**：移除 `viewMode` 切换后，老用户需适应。缓解：DAG tab 等效旧 DAG 视图，列表视图仍在各状态 tab。
- **虚拟节点布局**：任务很多时开始/结束节点 y 坐标取中位可能与首尾任务不齐。缓解：取对应层任务 y 的均值，视觉上可接受；必要时后续再做自动连线优化。
