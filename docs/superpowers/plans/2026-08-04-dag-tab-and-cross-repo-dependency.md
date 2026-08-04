# DAG 独立 Tab 与跨仓库依赖改进 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AI 交付看板的 DAG 提升为任务 tab 栏的首个 tab（含默认视图）、为其注入虚拟「开始」「结束」节点，并强化 manager 规划 prompt 的跨服务依赖判断准则，使 AI 正确建立跨仓库依赖。

**Architecture:** 前端三处改动 + 后端一处 prompt 文案强化。① tab 化：`DeliveryTabId` 增加 `"dag"`，`DeliveryDetail` 在 tab 栏首位渲染 DAG tab 并按 `activeTaskTab === "dag"` 路由到 `TaskDagView`，移除原 `viewMode` 切换；`AiDeliveryWorkspace` 把 `activeTaskTab` 初始值与三处重置改为 `"dag"`。② 虚拟节点：`computeTaskGraphLayout` 在真实节点/边生成后，由任务集派生两个 `type: "markerNode"` 的虚拟节点（id `__start__`/`__end__`）及对应边，缓存指纹仍只哈希真实任务。③ markerNode 渲染：`TaskDagView` 注册 `markerNode` 类型，并对 `__` 前缀节点跳过拖拽位置持久化与点击编辑。④ prompt：`build_manager_prompt` 约束 #2 从"表示前置关系"升级为可操作的判断准则（含正向/反向规则与判断口诀），约束 #6 不变。

**Tech Stack:** TypeScript + React 18 + `@xyflow/react`（前端）；Rust + Tauri（后端，`cargo test`）。

## Global Constraints

- 所有命令默认在 `terminal-buddy/` 子目录（项目根）执行；`git add` 的文件路径相对该目录。仓库根位于其上一级（`D:\gitee\terminal-buddy`），含 `docs/`。
- **不改** manager 输出 JSON Schema（`manager.rs:246-276` `manager_plan_schema`）。
- **不改** 依赖校验规则（`helpers.rs:392-467` `validate_manager_workflow_plan`）。Task 1 只改 prompt 文案，不动校验逻辑。
- **不做** DAG 拖拽连线的手动依赖编辑（spec 已排除方向 C）。
- **不改** 任务数据模型 `AiTaskNode`。
- 虚拟「开始」「结束」节点为纯展示：不代表真实任务，不参与依赖校验、派发、成果交接；id 以 `__` 前缀标记。
- DAG tab 显示全部任务（含已完成/已忽略），节点按 `task.state` 着色（复用 `TaskNodeCard` 现有 `STATE_COLORS`，本计划不改着色）。
- 前端无测试框架（项目既定事实，CLAUDE.md 已记录）：前端任务的验证 = `npx tsc --noEmit` 类型检查 + `npm run tauri dev` 手动验证（spec 第 4 部分定义）。不为本特性引入新测试框架（YAGNI）。
- 后端验证 = `cargo test`（`ai_delivery_service` 现有 `#[cfg(test)]` 模块，`tests.rs`）。
- 每个任务结束独立 commit；commit message 用中文，沿用仓库 `[AI交付] ...` 前缀。
- Rust↔TypeScript 序列化沿用 `camelCase`（本计划不涉及跨端序列化改动）。

## File Structure

**修改的文件（7 个），无新建文件：**

| 文件 | 职责 | 本计划改动 |
|---|---|---|
| `src-tauri/src/services/ai_delivery_service/helpers.rs` | manager 规划 prompt 构造 | `build_manager_prompt` 约束 #2 升级（Task 1） |
| `src-tauri/src/services/ai_delivery_service/tests.rs` | 后端单元测试 | `cycle_detection_tests` 模块新增 prompt 断言测试（Task 1） |
| `src/components/ai-delivery/workspace-utils.ts` | tab 类型与看板列定义（单一数据源） | `DeliveryTabId` 增加 `"dag"`（Task 2） |
| `src/components/ai-delivery/DeliveryDetail.tsx` | tab 栏与内容区路由 | DAG tab 按钮（首位）、移除 `viewMode`、渲染分支改 `activeTaskTab === "dag"`（Task 2） |
| `src/components/ai-delivery/AiDeliveryWorkspace.tsx` | `activeTaskTab` 状态持有与重置 | 初始值与三处重置改为 `"dag"`（Task 2） |
| `src/components/ai-delivery/utils/taskGraphLayout.ts` | 纯函数拓扑布局（含虚拟节点派生） | `computeTaskGraphLayout` 注入虚拟开始/结束节点（Task 3） |
| `src/components/ai-delivery/TaskDagView.tsx` | DAG 画布渲染与节点交互 | 注册 `markerNode`、隔离虚拟节点交互（Task 4） |

**分解依据：** Task 1（后端）与前端三个任务互相独立可单独提交。前端内部：Task 2（tab 化）依赖既有 `TaskDagView`；Task 4（markerNode 渲染）依赖 Task 3 产出的 `type: "markerNode"` 节点。建议按 Task 1 → 2 → 3 → 4 顺序执行。

---

## Task 1: 强化 manager 规划 prompt 的跨服务依赖判断准则

**根因（来自 spec 现状分析）：** `build_manager_prompt`（`helpers.rs:382`）约束 #2 仅写"跨服务改动用 dependencyIndexes 表示前置关系"，未给出"何时该建依赖"的判断准则，导致 AI 漏建跨仓库依赖。校验规则与前端渲染均无问题。

**Files:**
- Modify: `src-tauri/src/services/ai_delivery_service/helpers.rs`（`build_manager_prompt`，约束 #2，约 L382）
- Modify: `src-tauri/src/services/ai_delivery_service/tests.rs`（`cycle_detection_tests` 模块内新增测试）

**Interfaces:**
- Consumes: `AiDelivery`、`AiProject`、`AiRole`（既有类型）；`setup_git_project() -> (PathBuf, AiProject, AiDelivery, AiAgent)`（`tests.rs` 的 `cycle_detection_tests` 模块内既有 helper，L898）
- Produces: `build_manager_prompt(delivery, project, roles) -> String` 的输出包含跨服务依赖判断准则；**签名不变**，调用方 `manager.rs:790` 无需改动

**可见性说明（实现者必读）：** `mod.rs:146` 有 `use helpers::*;`，故 `build_manager_prompt` 在 `ai_delivery_service` 模块根可直接调用；`tests.rs` 顶部 `use super::*;` 与各测试模块的 `use super::*;` 因此能直接调用 `build_manager_prompt(...)`，无需 `helpers::` 前缀。`PathService`、`fs` 同理可见（`mod.rs` 已 `use`）。

- [ ] **Step 1: 写失败测试**

在 `tests.rs` 的 `cycle_detection_tests` 模块内，紧随 `make_readonly_analysis_task` 辅助函数（约 L1003-1028）之后插入：

```rust
    /// 约束 #2 升级后，manager prompt 必须给出可操作的跨服务依赖判断准则，
    /// 否则 AI 会漏建跨仓库依赖（根因见 docs/superpowers/specs/2026-08-04-dag-tab-and-cross-repo-dependency-design.md）。
    #[test]
    fn manager_prompt_includes_cross_service_dependency_guidance() {
        let (root, project, delivery, _agent) = setup_git_project();
        let prompt = build_manager_prompt(&delivery, &project, &[]);

        assert!(
            prompt.contains("跨服务依赖判断"),
            "manager prompt 缺少跨服务依赖判断小节: {prompt}"
        );
        assert!(
            prompt.contains("B 离开 A 能否独立正确完成"),
            "manager prompt 缺少判断口诀: {prompt}"
        );
        assert!(
            prompt.contains("不得建立依赖"),
            "manager prompt 缺少反向约束（无契约不得建依赖）: {prompt}"
        );

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test manager_prompt_includes_cross_service_dependency_guidance`
Expected: FAIL — 断言失败，错误信息含 `manager prompt 缺少跨服务依赖判断小节`（因当前约束 #2 不含该短语）。

- [ ] **Step 3: 升级约束 #2（最小改动使测试通过）**

在 `helpers.rs` 的 `build_manager_prompt` 函数（L381 起的 `format!` 字符串字面量）中，定位约束 #2 的原文本：

```
2. 跨服务改动必须拆成多个节点，用 dependencyIndexes 表示前置关系。
```

整段替换为（注意：这是 Rust 字符串字面量内的文本，换行用 `\n` 表示，缩进空格保留）：

```
2. 跨服务依赖判断（必须遵守）：\n   - 若任务 B 的正确改动需要任务 A 先完成，则 B 的 dependencyIndexes 必须包含 A，且 A 在 tasks 中排在 B 之前（dependencyIndexes 只能引用更早的任务）。\n   - 出现以下任一情况即视为存在依赖，必须建立：\n     a) A 改动了 B 依赖的契约：API 接口/参数/返回值、数据模型、DB schema/迁移、共享类型定义、对外配置项；\n     b) A 属于基础/底层服务（如基础数据、用户、字典、权限等），B 属于依赖它的上层业务服务（如仓储 wms、订单、库存）；\n     c) 同一编排步骤内按服务拆分的并行任务，若存在 a/b 所述契约依赖，也要建立依赖，而非默认并行；必要时把被依赖的服务拆到更早的编排步骤。\n   - 反之，若两个跨服务任务无任何契约或数据依赖，不得建立依赖（避免不必要串行）。\n   - 判断口诀：B 离开 A 能否独立正确完成——不能则必须依赖。
```

**不要改动其它约束（#1、#3–#8），尤其保留约束 #6（步骤间强制依赖）原样。** 替换后该 `format!` 字面量仍是一个合法 Rust 字符串（`\n` 为转义换行）。

> 该措辞同时覆盖"有用 workflow"与"无 workflow"：无 workflow 时 c 项"编排步骤"自动不适用，a/b 仍生效（spec 假设）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test manager_prompt_includes_cross_service_dependency_guidance`
Expected: PASS。

- [ ] **Step 5: 运行全部现有测试，确保 prompt 改动未破坏校验/解析**

Run: `cd src-tauri && cargo test`
Expected: 全部 PASS（spec 第 4 部分：确保 prompt 字符串改动不破坏校验/解析）。若 `agent_decision_tests` 等模块有失败，说明 Step 3 误改了其它约束——回查仅替换了 #2。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/services/ai_delivery_service/helpers.rs src-tauri/src/services/ai_delivery_service/tests.rs
git commit -m "[AI交付] 强化 manager 规划 prompt 的跨服务依赖判断准则"
```

---

## Task 2: 将 DAG 提升为任务 tab 栏的首个 tab

**目标：** 移除 `viewMode` 切换，DAG 成为 `ai-task-tabs` 内首个 tab（排在 7 个状态 tab 之前）并设为默认视图。

**Files:**
- Modify: `src/components/ai-delivery/workspace-utils.ts:51`（`DeliveryTabId`）
- Modify: `src/components/ai-delivery/DeliveryDetail.tsx`（L150 删 `viewMode`；L705-706 插入 DAG tab；L762-770 切换 div + 渲染分支）
- Modify: `src/components/ai-delivery/AiDeliveryWorkspace.tsx`（L136 初始值；L865/869/903 重置）

**Interfaces:**
- Consumes: `DeliveryTabId`（`workspace-utils`）、`TaskDagView` 组件（既有，`DeliveryDetail.tsx:19` 已 import）、`activeTaskTab`/`setActiveTaskTab`/`tasks`（`DeliveryDetail` 从 `AiDeliveryWorkspace` 经 props 解构）
- Produces: `DeliveryTabId` 联合类型含 `"dag"`；`activeTaskTab` 默认 `"dag"`；DAG tab 在 tab 栏首位，`activeTaskTab === "dag"` 时渲染 `<TaskDagView tasks={tasks} .../>`

**类型一致性要点：** `AiDeliveryWorkspace.tsx:243-248` 的 `visibleTasks` 在 `activeTaskTab === "dag"` 时返回 `[]`（`dag` 不在 `boardColumns`），这是预期——DAG 分支用全部 `tasks`（`DeliveryDetail` 的 `tasks` prop），不依赖 `visibleTasks`（spec 明确）。**不要改 `visibleTasks`。**

- [ ] **Step 1: `workspace-utils.ts` 为 `DeliveryTabId` 增加 `"dag"`**

`workspace-utils.ts:51`，原行：

```ts
export type DeliveryTabId = (typeof boardColumns)[number]["id"] | "attempts" | "events" | "artifacts" | "report";
```

改为（`"dag"` 置于联合首位，仅示意其为首个 tab，顺序对联合类型无运行时影响）：

```ts
export type DeliveryTabId = "dag" | (typeof boardColumns)[number]["id"] | "attempts" | "events" | "artifacts" | "report";
```

- [ ] **Step 2: `AiDeliveryWorkspace.tsx` 把 `activeTaskTab` 初始值改为 `"dag"`**

`AiDeliveryWorkspace.tsx:136`，原行：

```ts
 const [activeTaskTab, setActiveTaskTab] = useState<DeliveryTabId>("planned");
```

改为：

```ts
 const [activeTaskTab, setActiveTaskTab] = useState<DeliveryTabId>("dag");
```

- [ ] **Step 3: `AiDeliveryWorkspace.tsx` 把三处重置改为 `"dag"`**

共三处 `setActiveTaskTab("planned")`，逐改为 `setActiveTaskTab("dag")`：
- `selectProject`（L865）
- `selectDelivery`（L869）
- `replanLegacyDelivery`（L903）

例（L864-866）改后：

```ts
  const selectProject = async (id: string) => {
    setActiveTaskTab("dag");
    await refresh(id, "");
  };
```

L868-871、L902-904 同理（仅把 `"planned"` 换成 `"dag"`，其余不动）。

- [ ] **Step 4: `DeliveryDetail.tsx` 删除 `viewMode` state**

`DeliveryDetail.tsx:150`，删除整行：

```ts
  const [viewMode, setViewMode] = useState<"list" | "dag">("list");
```

（`useState` import 保留——L149 等其它 state 仍在用。`viewMode`/`setViewMode` 全仓仅 L150/763/764/765/769 共 5 处引用，Step 6 会清理 763-769。）

- [ ] **Step 5: `DeliveryDetail.tsx` 在 tab 栏首位插入 DAG tab 按钮**

`DeliveryDetail.tsx:705-706`，原行：

```tsx
                    <div className="ai-task-tabs" role="tablist" aria-label="任务状态">
                      {boardColumns.map((column) => {
```

改为（在 `boardColumns.map` 之前插入 DAG tab 按钮）：

```tsx
                    <div className="ai-task-tabs" role="tablist" aria-label="任务状态">
                      <button
                        type="button"
                        role="tab"
                        className={activeTaskTab === "dag" ? "active" : ""}
                        aria-selected={activeTaskTab === "dag"}
                        onClick={() => setActiveTaskTab("dag")}
                      >
                        <span>DAG</span>
                        <small>{tasks.length}</small>
                      </button>
                      {boardColumns.map((column) => {
```

- [ ] **Step 6: `DeliveryDetail.tsx` 移除视图切换 div，渲染分支改用 `activeTaskTab`**

`DeliveryDetail.tsx:762-771`，原代码：

```tsx
                    <div className="ai-detail-tabs">
                      <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")}>列表视图</button>
                      <button className={viewMode === "dag" ? "active" : ""} onClick={() => setViewMode("dag")}>DAG 视图</button>
                      {tasks.length > 5 && viewMode === "list" && (
                        <span className="ai-dag-hint">任务较多，建议切换 DAG 视图</span>
                      )}
                    </div>
                    {viewMode === "dag" ? (
                      <TaskDagView tasks={tasks} onNodeClick={(id) => setEditingTaskId(id)} />
                    ) : (
                      <>
```

改为（删除整个 `ai-detail-tabs` div；三元条件从 `viewMode === "dag"` 改为 `activeTaskTab === "dag"`，`TaskDagView` 调用与 `<>` 分支保持不变）：

```tsx
                    {activeTaskTab === "dag" ? (
                      <TaskDagView tasks={tasks} onNodeClick={(id) => setEditingTaskId(id)} />
                    ) : (
                      <>
```

> `<>...</>` 分支（各状态列表 + attempts/events/artifacts/report 面板）原样保留，仅外层判定条件变更。

- [ ] **Step 7: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。重点确认：`DeliveryTabId` 含 `"dag"` 后所有 `setActiveTaskTab("dag")` 合法；`viewMode`/`setViewMode` 已无残留引用（若有遗漏，tsc 会报 `Cannot find name 'viewMode'`）。

- [ ] **Step 8: 手动验证**

Run: `npm run tauri dev`，打开一个含任务的交付，确认：
1. 任务区 tab 栏**第一个**是「DAG」，计数 = 任务总数；
2. 进入交付默认显示 DAG 视图（全部任务节点，按状态着色）；
3. 点击各状态 tab（待规划/执行中等）仍正常显示对应列表，批量操作栏正常；
4. 切换交付、重新规划（旧任务图重跑）后默认落回 DAG tab；
5. 原"列表视图/DAG 视图"切换条与"任务较多建议切换"提示已消失。

- [ ] **Step 9: 提交**

```bash
git add src/components/ai-delivery/workspace-utils.ts src/components/ai-delivery/DeliveryDetail.tsx src/components/ai-delivery/AiDeliveryWorkspace.tsx
git commit -m "[AI交付] DAG 作为任务 tab 栏首个 tab，移除独立视图切换"
```

---

## Task 3: 为 DAG 布局注入虚拟「开始」「结束」节点

**目标：** `computeTaskGraphLayout` 在真实节点/边之外，派生两个纯展示的 `markerNode` 虚拟节点及连线，让依赖全貌直观。缓存指纹（`computeVersion`）不含虚拟节点——虚拟节点由真实任务集确定性派生，真实任务不变时虚拟节点也不变，缓存照常命中。

**Files:**
- Modify: `src/components/ai-delivery/utils/taskGraphLayout.ts`（`computeTaskGraphLayout`，在 L82 `byLayer.forEach` 闭合之后、L84 `const result` 之前注入）

**Interfaces:**
- Consumes: `AiTaskNode[].id` / `dependencyIds`（既有）；`byLayer`（函数内既有局部变量，L64）
- Produces: 返回的 `nodes` 含 `id: "__start__"` 与 `id: "__end__"`（均 `type: "markerNode"`、`data: { label }`、`draggable: false`）；`edges` 含 `__start__→task`（对每个 `dependencyIds` 为空的任务）与 `task→__end__`（对每个未被任何任务依赖的叶子任务）。`computeVersion`（L20-27）**不改**。

**派生规则（spec 设计 2）：**
- `START`（`__start__`）：对 `dependencyIds` 为空的任务加边 `START → task`；位置 `x = -240`，`y` = 这些任务 `y` 的均值。
- `END`（`__end__`）：对"未被任何任务的 `dependencyIds` 引用"的任务加边 `task → END`；位置 `x = (maxLayer + 1) * 240`，`y` = 这些末端任务 `y` 的均值。
- `tasks` 为空时不注入虚拟节点（空 DAG 无意义）。

- [ ] **Step 1: 注入虚拟节点（纯函数逻辑）**

`taskGraphLayout.ts`，定位 L68-82 的真实节点/边生成循环，其结尾是：

```ts
  Object.entries(byLayer).forEach(([layerNum, layerTasks]) => {
    layerTasks.forEach((task, index) => {
      nodes.push({
        id: task.id,
        position: { x: Number(layerNum) * 240, y: index * 120 },
        data: { task },
        type: "taskNode",
      });
      task.dependencyIds.forEach((depId) =>
        edges.push({ id: `${depId}->${task.id}`, source: depId, target: task.id } as Edge)
      );
    });
  });
```

在这段 `});` 之后、`const result: LayoutCache = { layoutVersion, nodes, edges };`（L84）之前，插入：

```ts
  // 虚拟「开始」「结束」节点：纯展示，不代表真实任务，不参与依赖校验/派发/成果交接。
  // id 以 __ 前缀标记，TaskDagView 据此跳过拖拽持久化与点击编辑（Task 4）。
  if (tasks.length > 0) {
    const positionById = new Map(nodes.map((node) => [node.id, node.position]));
    const referencedIds = new Set(tasks.flatMap((task) => task.dependencyIds));
    const startTargets = tasks.filter((task) => task.dependencyIds.length === 0);
    const endSources = tasks.filter((task) => !referencedIds.has(task.id));
    const meanY = (ids: string[]): number =>
      ids.length === 0
        ? 0
        : ids.reduce((sum, id) => sum + (positionById.get(id)?.y ?? 0), 0) / ids.length;
    const maxLayerNum = Object.keys(byLayer)
      .map(Number)
      .reduce((max, value) => Math.max(max, value), -1);

    if (startTargets.length > 0) {
      nodes.push({
        id: "__start__",
        type: "markerNode",
        position: { x: -240, y: meanY(startTargets.map((task) => task.id)) },
        data: { label: "开始" },
        draggable: false,
      });
      startTargets.forEach((task) =>
        edges.push({ id: `__start__->${task.id}`, source: "__start__", target: task.id } as Edge),
      );
    }
    if (endSources.length > 0) {
      nodes.push({
        id: "__end__",
        type: "markerNode",
        position: { x: (maxLayerNum + 1) * 240, y: meanY(endSources.map((task) => task.id)) },
        data: { label: "结束" },
        draggable: false,
      });
      endSources.forEach((task) =>
        edges.push({ id: `${task.id}->__end__`, source: task.id, target: "__end__" } as Edge),
      );
    }
  }
```

> 边 id 形如 `__start__-><taskId>` / `<taskId>->__end__`，与真实边 id `<depId>-><taskId>` 不冲突（真实任务 id 不含 `__`）。`result`（L84）随后用更新后的 `nodes`/`edges` 落缓存——含虚拟节点，但指纹 `layoutVersion` 仅来自真实任务（`computeVersion` 未改），真实任务不变时缓存命中且虚拟节点一致。

- [ ] **Step 2: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 手动验证**

Run: `npm run tauri dev`，打开含任务的交付（DAG tab），确认：
1. 画布出现「开始」「结束」两个额外节点（本任务后 xyflow 尚未注册 `markerNode` 类型，会以**默认节点**呈现——能看到节点方块与连线即可，正式标签样式在 Task 4 注册 `markerNode` 后生效）；
2. 「开始」连到所有无依赖任务；「结束」接到所有末端（叶子）任务；
3. 增删任务或改依赖后重新生成任务图，开始/结束连线随之正确增减；
4. 切换其它 tab 再切回 DAG，开始/结束仍在（缓存命中后仍含虚拟节点）。

- [ ] **Step 4: 提交**

```bash
git add src/components/ai-delivery/utils/taskGraphLayout.ts
git commit -m "[AI交付] DAG 布局注入虚拟开始/结束节点"
```

---

## Task 4: 渲染 markerNode 并隔离虚拟节点交互

**目标：** `TaskDagView` 注册 `markerNode` 类型以渲染「开始」「结束」标签；对 `__` 前缀的虚拟节点跳过拖拽位置持久化与点击编辑，使其保持纯展示。

**依赖：** Task 3 已让 `computeTaskGraphLayout` 产出 `type: "markerNode"` 的 `__start__`/`__end__` 节点。

**Files:**
- Modify: `src/components/ai-delivery/TaskDagView.tsx`（import `NodeProps`；新增 `MarkerNode` 组件；`nodeTypes` 注册 `markerNode`；`applySavedPositions`/`onNodeDragStop`/`onNodeClick` 跳过 `__` 前缀）

**Interfaces:**
- Consumes: `layout.nodes` 中 `type: "markerNode"`、`data: { label: string }` 的节点（Task 3 产出）
- Produces: `markerNode` 渲染为带「开始」/「结束」文字的胶囊标签（内联样式，自包含、不依赖 CSS 文件）；虚拟节点（id 以 `__` 开头）不套用、不写入拖拽位置缓存，点击不触发 `onNodeClick`

- [ ] **Step 1: import `NodeProps`**

`TaskDagView.tsx:2-12`，原 import：

```ts
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
```

改为（增加 `type NodeProps`，保持字母序）：

```ts
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
```

- [ ] **Step 2: 新增 `MarkerNode` 组件**

在 `TaskDagView.tsx` 的 import 区之后、`interface Props {`（L18）之前插入：

```tsx
/** 虚拟「开始」「结束」节点：纯展示，无 Handle、不可连线/拖拽（draggable 在布局层已置 false）。 */
function MarkerNode({ data }: NodeProps) {
  const label = (data as { label?: unknown })?.label;
  return (
    <div
      className="ai-dag-marker"
      style={{
        padding: "6px 14px",
        borderRadius: 999,
        background: "#1e293b",
        color: "#e2e8f0",
        fontSize: 13,
        fontWeight: 600,
        border: "1px dashed #64748b",
        whiteSpace: "nowrap",
      }}
    >
      {typeof label === "string" ? label : ""}
    </div>
  );
}
```

> 采用内联样式使本任务自包含，无需定位/修改 CSS 文件；`className="ai-dag-marker"` 预留给后续主题化（本计划不强制）。

- [ ] **Step 3: `applySavedPositions` 跳过虚拟节点**

`TaskDagView.tsx:37-45`，原函数：

```ts
function applySavedPositions(nodes: Node[], saved: SavedPositions): Node[] {
  const entries = Object.entries(saved);
  if (entries.length === 0) return nodes;
  const savedById = new Map(entries);
  return nodes.map((node) => {
    const position = savedById.get(node.id);
    return position ? { ...node, position } : node;
  });
}
```

改为（虚拟节点不套用历史拖拽位置，始终用布局算出的中位坐标）：

```ts
function applySavedPositions(nodes: Node[], saved: SavedPositions): Node[] {
  const entries = Object.entries(saved);
  if (entries.length === 0) return nodes;
  const savedById = new Map(entries);
  return nodes.map((node) => {
    if (node.id.startsWith("__")) return node;
    const position = savedById.get(node.id);
    return position ? { ...node, position } : node;
  });
}
```

- [ ] **Step 4: `nodeTypes` 注册 `markerNode`**

`TaskDagView.tsx:96-99`，原：

```ts
  const nodeTypes = useMemo<NodeTypes>(
    () => ({ taskNode: (props: any) => <TaskNodeCard {...props} compact={compact} /> }),
    [compact],
  );
```

改为：

```ts
  const nodeTypes = useMemo<NodeTypes>(
    () => ({
      taskNode: (props: any) => <TaskNodeCard {...props} compact={compact} />,
      markerNode: MarkerNode,
    }),
    [compact],
  );
```

- [ ] **Step 5: `onNodeDragStop` 不持久化虚拟节点**

`TaskDagView.tsx:83-94`，原：

```ts
  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      try {
        const saved = loadSavedPositions(deliveryId);
        saved[node.id] = node.position;
        localStorage.setItem(POSITIONS_PREFIX + deliveryId, JSON.stringify(saved));
      } catch {
        /* 持久化失败不影响拖拽 */
      }
    },
    [deliveryId],
  );
```

改为（在 `try` 前加虚拟节点守卫；虚拟节点 `draggable: false` 本就拖不动，此处为防御性兜底）：

```ts
  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (node.id.startsWith("__")) return; // 虚拟节点不持久化
      try {
        const saved = loadSavedPositions(deliveryId);
        saved[node.id] = node.position;
        localStorage.setItem(POSITIONS_PREFIX + deliveryId, JSON.stringify(saved));
      } catch {
        /* 持久化失败不影响拖拽 */
      }
    },
    [deliveryId],
  );
```

- [ ] **Step 6: `onNodeClick` 虚拟节点不触发编辑**

`TaskDagView.tsx:112`，原：

```tsx
        onNodeClick={(_, node) => onNodeClick(String(node.id))}
```

改为：

```tsx
        onNodeClick={(_, node) => {
          if (String(node.id).startsWith("__")) return; // 虚拟节点不打开编辑
          onNodeClick(String(node.id));
        }}
```

- [ ] **Step 7: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 8: 手动验证**

Run: `npm run tauri dev`，打开含任务的交付（DAG tab），确认：
1. 「开始」「结束」显示为带文字的胶囊标签（不再是 Task 3 中间态的默认方块）；
2. 拖拽一个真实任务到新位置 → 刷新/切 tab 再回，真实任务位置保持；「开始」「结束」位置**不**被记忆（始终回到中位）；
3. 点击真实任务 → 打开任务编辑弹窗；点击「开始」/「结束」→ 不打开弹窗；
4. 「开始」「结束」无法被拖动（`draggable: false`）。

- [ ] **Step 9: 提交**

```bash
git add src/components/ai-delivery/TaskDagView.tsx
git commit -m "[AI交付] DAG 渲染虚拟开始/结束节点并隔离其交互"
```

---

## 收尾整体验证（全部任务完成后）

- [ ] **后端回归**：`cd src-tauri && cargo test` — 全绿。
- [ ] **前端类型**：`npx tsc --noEmit` — 无错误。
- [ ] **端到端手动**（spec 第 4 部分）：`npm run tauri dev`，对一个含 **wms + basedata** 跨仓库任务的交付执行"生成任务图"，确认：
  1. DAG 为任务 tab 栏首个 tab；
  2. 出现「开始」「结束」虚拟节点，连线正确；
  3. wms ↔ basedata 间出现应有的跨仓库依赖连线（验证 Task 1 prompt 强化生效——若仍漏建，属 AI 规划质量问题，可在 DAG tab 人工核对后通过任务编辑补依赖，非本计划代码缺陷）。

## 风险与缓解（来自 spec）

- **过度依赖**：prompt 改动可能让 AI 建立不必要串行。缓解：约束 #2 含"无契约则不得建立依赖"反向规则；生成后在 DAG tab 人工核对。
- **交互习惯**：移除 `viewMode` 切换后老用户需适应。缓解：DAG tab 等效旧 DAG 视图，列表视图仍在各状态 tab。
- **虚拟节点布局**：任务很多时开始/结束 `y` 取均值可能与首尾任务不齐。缓解：均值在视觉可接受范围；本计划不做进一步自动连线优化（YAGNI）。
