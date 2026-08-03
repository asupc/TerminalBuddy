# AI 交付：UI/派发问题修复计划

> 状态：已核实，待评审与执行
> 日期：2026-08-03
> 涉及模块：AI 交付前端（`src/components/ai-delivery/`）与后端（`src-tauri/src/services/ai_delivery_service/`）

---

## 1. 问题核实汇总

| # | 用户描述 | 根因 | 关键代码位置 |
|---|---|---|---|
| 1 | AI 交付任务派发到 hermes 异常 | hermes Runtime 命令拼接边界情况：`--oneshot $tbPrompt` 与 `2>&1 \| Out-File` 在 hermes chat 子命令下的兼容、preset model_args 注入顺序、转义未完整覆盖 | `src-tauri/src/services/ai_delivery_service/terminal.rs:196-341` |
| 2 | 任务列表视图编辑 icon 意外换行 | `.ai-task-inspect` 用 `position: absolute; top:8px; right:8px`，两个图标叠加在同一绝对位置，多任务状态下换行 | `DeliveryDetail.tsx:1011-1028`、`AiDeliveryWorkspace.css:1683, 1265-1267` |
| 3 | DAG 视图节点位置不可调整 | `TaskDagView` 显式 `nodesDraggable={false}` | `TaskDagView.tsx:24-31` |
| 4 | DAG 抽屉无标题信息，操作按钮需固定在 footer | 抽屉标题仅 `"编辑任务 {title}"`，缺少状态/角色/执行模式等关键上下文；操作按钮嵌在 `ai-task-editor-fields` 末尾，未固定 | `TaskNodeEditor.tsx:85-137` |
| 5 | AI 交付 Agent 页面混乱 | `ai-agent-config-row` 6 列网格定义，但实际渲染了 7 项（name/max concurrency/CLI/runtimeArgs/preset(含嵌套「管理预设」按钮)/timeout + delete），导致 preset 列拥挤、行高不一致 | `ConfigDialog.tsx:782-944`、`AiDeliveryWorkspace.css:776-803` |
| 6 | 任务编排拓扑预览节点不可调 + 重叠 + 模拟测试按钮无效果 | (a) `TaskDagView` 同样 `nodesDraggable={false}` 且 dagre 自动布局在小窗口下重叠；(b) `test_workflow_step` 硬编码仅匹配 `kind == "claude"`（其他 Runtime 一律返回 `"未找到可用的 claude 运行时"`），且 `--print` 需 stdin 在非交互模式下不可用 | `ConfigDialog.tsx:1058-1070`、`TaskDagView.tsx`、`services/ai_delivery_service/entity.rs:680-732` |
| 7 | Agent 启动预设弹窗输入框样式未统一 | `ai-preset-form` 用 inline `flex-direction: column`，与 `ai-task-create-body` 等其他页面的 grid 标签风格不一致；textarea 缺少统一最小高度与焦点样式 | `ConfigDialog.tsx:996-1055`、`AiDeliveryWorkspace.css:2351-2354` |
| 8 | AI 交付配置弹窗宽度加宽 | `.ai-config-dialog` 当前 `width: min(1180px, calc(100vw - 48px))`，在 1920+ 显示器下仍有大量横向空间未利用 | `AiDeliveryWorkspace.css:434-436` |

---

## 2. 修复方案

### 2.1 [#1] Hermes 派发命令修复

**目标**：保证 hermes 在 `--oneshot` 与 `chat --query` 两种模式下都能正确接收 prompt、注入启动预设 model_args、捕获 transcript。

**实现位置**：`src-tauri/src/services/ai_delivery_service/terminal.rs`

**改动要点**：

1. **拆分命令构造**：将 hermes 单独抽出一段命令构造，与 codex/claude/opencode 同级，先按 Runtime 子命令（`chat` vs 一次性）选择注入策略，再统一拼接：
   ```rust
   if is_hermes {
       if command_parts.iter().any(|arg| arg == "chat") {
           // chat 子命令走 --quiet --query 注入完整 prompt
           invocation.push_str(" '--quiet' '--query' $tbPrompt");
       } else {
           // 一次性模式：--oneshot 接收 prompt（hermes 在 Windows .cmd 下若直接传多行参数会被截断，
           // 用 prompt.txt 文件路径 + stdin 重定向避免）
           invocation.push_str(" '--oneshot'");
           // 通过 stdin 喂入，避免引号转义崩溃
           invocation.push_str(" (Get-Content -LiteralPath ");
           invocation.push_str(&powershell_literal(control.prompt_path.to_string_lossy().as_ref()));
           invocation.push_str(" -Raw -Encoding UTF8)");
       }
   }
   ```

2. **预设 model_args 位置**：将 `preset_model_args` 注入从「`for argument in &agent.runtime_args` 之后」改为「在 hermes 特殊子命令之前」，避免破坏子命令语义。

3. **stderr 捕获**：在 hermes 路径下保留现有 `2>&1 | Out-File ... transcript.log`，但追加 stdout/stderr 分流：`2>&1 1>&3 | Out-File ... -Encoding UTF8 ; 3>&1 1>&2`（仅在确认 hermes chat 不需要单独保留 stderr 时采用；先按当前写法）。

4. **回归测试**：在 `terminal_command_tests` 中追加两条 hermes 用例：
   - `hermes`（无子命令）+ preset `{"temperature": 0.2}` → 断言 prompt 走 stdin 且 `--temperature=0.2` 在 `--oneshot` 之前
   - `hermes.cmd`（绝对路径）+ runtime_args → 断言 file_stem 匹配 `hermes` 且命令仍包含 `--oneshot`

### 2.2 [#2] 任务列表编辑/契约图标改为行内

**目标**：移除 absolute 定位，改用网格列容器承载两个图标按钮，避免换行与遮挡。

**实现位置**：`terminal-buddy/src/components/ai-delivery/DeliveryDetail.tsx`、`AiDeliveryWorkspace.css`

**改动要点**：

1. 在 `DeliveryDetail.tsx:1011-1028` 处，将两个 `<button className="ai-task-inspect">` 包裹到一个 `<div className="ai-task-actions-row">` 中，调整现有 `.ai-task-list article` 的 `grid-template-columns` 留出图标列：
   ```tsx
   <div className="ai-task-actions-row">
     <button className="ai-task-inspect" title="查看任务契约" ...><FileText size={14}/></button>
     <button className="ai-task-inspect" title="编辑任务" ...><Pencil size={14}/></button>
   </div>
   ```

2. CSS：
   - 删除 `.ai-task-inspect { position: absolute; ... }` 规则
   - `.ai-task-inspect` 改为 28x28 行内图标按钮样式（与 `.ai-icon-button` 类似）
   - `.ai-task-actions-row` 用 `display: flex; gap: 4px; align-self: center`
   - `.ai-task-list article` 的 `grid-template-columns` 增加右侧图标列（`auto auto minmax(0, 1fr) auto auto`）

### 2.3 [#3] + [#6a] DAG 视图/拓扑预览节点可拖拽

**目标**：放开 `nodesDraggable` 并启用节点位置持久化（仅前端 session，刷新后由 `computeTaskGraphLayout` 重新计算）。

**实现位置**：`TaskDagView.tsx`

**改动要点**：

```tsx
<ReactFlow
  nodes={nodes}
  edges={edges}
  nodeTypes={nodeTypes}
  fitView
  nodesDraggable
  nodesConnectable={false}
  elementsSelectable
  onNodesChange={onNodesChange}      // 新增
  onNodeClick={(_, node) => onNodeClick(String(node.id))}
>
  <Background />
  <Controls showInteractive={false} />
  <MiniMap pannable zoomable />
</ReactFlow>
```

- `onNodesChange` 用 ReactFlow 默认的 `applyNodeChanges` 把变更合并进内部 state，避免「拖完又弹回原位」。
- 拓扑预览同样放开（预览的 `previewTasks` 是临时节点，无需持久化）。
- 若 `tasks.length > 50`（compact 模式），自动布局即可，拖拽可禁用避免性能问题。

### 2.4 [#4] DAG 抽屉标题 + 操作按钮固定在 footer

**目标**：抽屉标题区显示任务关键摘要，操作按钮区 sticky 在底部。

**实现位置**：`TaskNodeEditor.tsx` + `AiDeliveryWorkspace.css`

**改动要点**：

1. **头部摘要**：将现有 `<h3>编辑任务 {task.title}</h3>` 替换为结构化头部：
   ```tsx
   <header className="ai-task-editor-header">
     <div>
       <small>{statusChip(task.state)} · {executionModeLabel} · {roleLabel}</small>
       <h3>{task.title}</h3>
       <p>{task.description || "（无说明）"}</p>
     </div>
     <button onClick={onClose} className="ai-icon-button" aria-label="关闭">×</button>
   </header>
   ```

2. **Footer 操作按钮**：复用现有 `Dialog` 组件的 `footer` 槽位（`TaskNodeEditor` 当前未用 Dialog，需替换为 Dialog 包装）。保持 `保存` / `删除此任务` / `取消` 三按钮。

3. **CSS**：
   - `.ai-task-editor` 改为 flex column，`max-height: 100vh`
   - `.ai-task-editor-grid` 区域 `flex: 1; overflow: auto`
   - `.ai-task-editor-header` 与 `.ai-task-editor-actions` 用 `flex: 0 0 auto`，底部边框区分

### 2.5 [#5] Agent 配置页面布局整理

**目标**：让 6+1 个字段行高一致、对齐整齐。

**实现位置**：`ConfigDialog.tsx` 第 763-944 行 + `AiDeliveryWorkspace.css:776-803`

**改动要点**：

1. **重构 ConfigDialog.tsx**：
   - 把 `<label>` 拆为「字段容器（label.col）+ 控件（label.control）」两层，标签文本统一 10px 灰色，控制项占满。
   - 「管理预设…」按钮从 preset `<select>` 内部抽出，放到字段名旁的 inline 链接，与 select 并排。
   - 删除按钮列从网格中抽出，单独作为行末 `align-self: center`。

2. **CSS 调整**：
   - 网格改为：`grid-template-columns: minmax(135px, 0.85fr) repeat(5, minmax(130px, 1fr)) 32px`（7 列）
   - 每个 `<label>`：`display: grid; grid-template-rows: auto auto; gap: 4px; align-items: end`
   - 「管理预设」按钮与 select 同一行的 grid 子项：`grid-column: span 2`（select 占据主要宽度，按钮 32px 行末）
   - input/select 最小高度统一 32px，textarea 最小 56px

### 2.6 [#6b] 模拟测试支持多 Runtime

**目标**：`test_workflow_step` 按步骤关联的 Agent → Runtime 调用，而非硬编码 claude。

**实现位置**：`src-tauri/src/services/ai_delivery_service/entity.rs:680-732`

**改动要点**：

1. 入口签名不变 `test_workflow_step(workflow_step_id, feature_name)`，但内部增加「步骤 → Agent」解析：
   - 若 step 关联了 role_id：通过 role 的 `candidate_agent_ids` / `locked_agent_id` 找到第一个 enabled agent
   - 若 step 没角色：取第一个 enabled agent
   - 用 agent 的 `runtime_id` 查 Runtime，构造 `split_runtime_command`
2. Runtime 命令拼接按 `runtime.kind` 分支：
   - claude / pi / mimo → `--print <prompt>`
   - codex → `exec --skip-git-repo-check --print <prompt>`
   - opencode → `run --print <prompt>`
   - kimi → `--prompt <prompt>`
   - hermes → `--oneshot <prompt>`（无 chat 子命令时）
3. 提取公共逻辑到 `run_runtime_one_shot(runtime, prompt) -> Result<String, String>`，60s 超时，复用 `run_command_with_timeout`。
4. 错误信息明确："未找到可用的 Runtime（请先在 Runtime 管理中启用至少一个）"。

### 2.7 [#7] 启动预设弹窗样式统一

**目标**：与 `ai-task-create-body` 等其他 dialog 保持一致的 grid label 风格。

**实现位置**：`ConfigDialog.tsx:996-1055` + `AiDeliveryWorkspace.css:2351-2354`

**改动要点**：

1. 把 `ai-preset-form` 改为：
   ```css
   .ai-preset-form { display: grid; gap: 12px; }
   .ai-preset-form label {
     display: grid; gap: 6px;
     color: var(--text-secondary); font-size: 11px; font-weight: 600;
   }
   .ai-preset-form input, .ai-preset-form textarea {
     box-sizing: border-box; width: 100%; min-height: 32px;
     border: 1px solid var(--border); border-radius: var(--radius-sm);
     background: var(--bg-tertiary); color: var(--text-primary);
     padding: 6px 9px; font: inherit; outline: none;
   }
   .ai-preset-form textarea { min-height: 68px; resize: vertical; font-family: var(--font-mono); font-size: 11px; }
   .ai-preset-form input:focus, .ai-preset-form textarea:focus { border-color: var(--accent); }
   ```

2. 删除 `.ai-preset-form textarea { font-family: var(--font-mono); }` 之外的重复样式。

### 2.8 [#8] AI 交付配置弹窗宽度加宽

**目标**：在 1280px 以上屏幕下更宽，保留小屏幕兼容。

**实现位置**：`AiDeliveryWorkspace.css:434-436`

**改动**：

```css
.ai-config-dialog {
  width: min(1480px, calc(100vw - 32px));
}
```

同时复核 `.ai-config-dialog-body` 的 `height: min(660px, calc(100vh - 156px))` —— 若加宽到 1480，建议同步调整为 `min(720px, calc(100vh - 120px))`。

---

## 3. 受影响文件清单

| 文件 | 涉及修复点 |
|---|---|
| `src-tauri/src/services/ai_delivery_service/terminal.rs` | [#1] hermes 命令拼接 |
| `src-tauri/src/services/ai_delivery_service/entity.rs` | [#6b] test_workflow_step 多 Runtime |
| `src/components/ai-delivery/TaskDagView.tsx` | [#3] [#6a] 节点可拖拽 |
| `src/components/ai-delivery/TaskNodeEditor.tsx` | [#4] 抽屉头部 + footer |
| `src/components/ai-delivery/DeliveryDetail.tsx` | [#2] 编辑/契约图标行内 |
| `src/components/ai-delivery/ConfigDialog.tsx` | [#5] [#7] [#8] Agent 行 + 预设弹窗样式 |
| `src/components/ai-delivery/AiDeliveryWorkspace.css` | [#2] [#4] [#5] [#7] [#8] 样式调整 |
| `src/components/ai-delivery/utils/taskGraphLayout.ts` | （可选）若 [#6a] 需要重排算法 |

---

## 4. 验收标准

1. **hermes 派发**：在 `claude`、`codex`、`opencode`、`hermes` 各跑一次最小任务（任意 prompt），观察 terminal transcript.log 正常生成且 `$tbExit` 写入。
2. **任务列表图标**：在任务卡片 hover/选中时，编辑与契约图标均行内显示，不发生换行，不遮挡标题。
3. **DAG 拖拽**：进入 DAG 视图后任意拖动一个节点，松开后位置保持；切换任务重渲染后恢复默认（无持久化要求）。
4. **抽屉**：DAG 节点点击后右侧抽屉显示任务标题 + 状态 + 角色 + 执行模式；操作按钮固定底部，滚动表单区不影响按钮可见性。
5. **Agent 配置页**：所有 agent 行高度统一 ≤ 64px；「管理预设」按钮与 select 同行对齐；列边界清晰。
6. **模拟测试**：在存在至少一个启用 Runtime（任意 kind）的情况下，模拟测试返回非空文本或明确错误（不是「未找到 claude」）；返回结果显示在步骤下方 `<pre>` 内。
7. **预设弹窗**：与「新增任务」「新增 Runtime」弹窗风格一致（边框、圆角、焦点高亮、字号、间距）。
8. **配置弹窗宽度**：≥ 1280px 显示器下，弹窗宽度变化；< 1280px 仍自适应不超过视口。

---

## 5. 风险与回滚

- **hermes 命令修复**（[#1]）：涉及 Windows shell 转义与 --oneshot/--query 行为差异，可能误改其它 Runtime。建议仅在 entity.rs / terminal.rs 测试通过后，再做一次手动 smoke test（启动 hermes 执行空 prompt）。
- **test_workflow_step 重构**（[#6b]）：依赖 Agent → Runtime 链路，新增多分支。若步骤无 Agent，应清晰报错而非 panic。
- **CSS 改动**（[#2] [#5] [#7] [#8]）：纯样式调整，git 局部 commit 可快速回退。
- **TaskNodeEditor 重构**（[#4]）：改为 Dialog 包装后，关闭回调与 onClose 顺序需保留；onAfterSaved 调用链不变。

---

## 6. 实施顺序建议

1. 先做 [#6b] test_workflow_step（影响小、可独立验证）。
2. 后端 [#1] hermes 命令修复 + 单元测试。
3. 前端纯样式修复 [#7] [#8]。
4. 前端布局修复 [#5] Agent 行 → [#2] 任务列表图标。
5. 前端功能修复 [#3] [#6a] DAG 拖拽 → [#4] 抽屉 header/footer。
6. 整体回归：所有已存在 `cargo test`（terminal_command_tests / agent_decision_tests） + 前端 `npx tsc --noEmit`。