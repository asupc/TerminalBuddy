# ai_delivery_service 拆分实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 9975 行的 `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs` 按领域拆分为 `services/ai_delivery_service/` 目录下的 9 个模块文件，行为零变化、外部调用方零改动。

**Architecture:** 主文件变为 `mod.rs`（共享层：use/常量/锁/结构体），子模块各自持有 `impl AiDeliveryService { ... }` 块与自由函数。mod.rs 用 `use <子模块>::*;` 做门面重导出，所有子模块以 `use super::*;` 引入，形成与原单文件一致的扁平命名空间。被移动的私有项统一标 `pub(crate)`（`pub` 方法保持 `pub`），由编译器驱动补齐遗漏。**先脚手架后提取**：所有子模块骨架与门面声明一次性建立，使任何提取顺序下每步都能编译。

**Tech Stack:** Rust（Tauri 2.x），无新依赖。

**参考 spec:** `docs/superpowers/specs/2026-08-03-ai-delivery-service-split-design.md`

## Global Constraints

1. **纯移动**：不改任何业务逻辑、注释、方法签名、字符串字面量。只能：剪切/粘贴、加 `pub(crate)`、加 `use`、加模块声明、加模块头部 `//!` 注释。
2. **区块提取顺序（关键）**：区块按**原始行号降序**处理（先提取靠后的区块，再提取靠前的），删行不会使更靠前区块的行号失效。任务间也保持全局降序（任务划分已保证）。因先前任务删行，**每个任务开始必须先 Grep 定位区块当前行号**——以函数名为锚点：`^\s{4}(pub\s+)?(async\s+)?fn\s+<区块首函数名>`，区块尾行号为下一个锚点的行号 - 1（`mod xxx {` 用模块名作锚点）。
3. **可见性规则**：被移动的自由函数、私有结构体、私有常量 → `pub(crate)`；`pub fn` 方法保持 `pub`；私有 impl 方法 → `pub(crate)`。
4. **模块文件头部**：每个新文件以 `//! AI 交付服务 · <职责> 模块（自 ai_delivery_service.rs 拆分）` 开头，随后是 `use super::*;`。骨架阶段即写入。
5. **外部零改动**：不得修改 `services/mod.rs`、`lib.rs`、`commands/*` 或其他任何文件。
6. **提交规则**：每个任务以 `cargo check` 通过后提交。`git add` 只限 `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs` 与 `terminal-buddy/src-tauri/src/services/ai_delivery_service/` 两个路径，不得夹带工作区其他未提交改动。
7. **验证命令**（均在 `D:/gitee/terminal-buddy/terminal-buddy/src-tauri` 下执行）：`cargo check`；最终 `cargo test`。`unused_imports`/`dead_code` 警告允许存在（不阻断），但不得留错误。
8. **工作区现状**：`ai_delivery_service.rs` 有用户未提交的 WIP 改动，拆分时按当前磁盘内容为源，逐字保留。

---

## 区块总表（原始行号 → 目标文件）

> 行号基于含用户 WIP 的工作区版本（9975 行），与 git 基线（9703 行）不对应，实现以磁盘内容为源。

| # | 原行区间 | 内容 | 目标文件 |
|---|---|---|---|
| 1 | L9562-9944 | run_manager_planner、generate_quality_gate_with_runtime、normalize_path_for_external_process、run_command_with_timeout、manager_plan_schema（build_manager_prompt、validate_manager_workflow_plan、requires_workflow_review 已在执行时归入 helpers.rs 区块 2） | manager.rs |
| 2 | L9235-9561 | compact_output、strip_terminal_control_sequences、build_continuation_context、ensure_expected_artifacts、validate_artifact_paths、is_legacy_delivery_plan、upgrade_legacy_workflow_steps、ensure_readonly_execution_unchanged、ensure_task_branch_clean、run_shell_command、build_manager_prompt、validate_manager_workflow_plan、requires_workflow_review | helpers.rs |
| 3 | L9167-9234 | run_reviewer_agent | manager.rs |
| 4 | L9075-9110 | repair_workflow_review、wait_for_manager_plan（补录：原 L8839，虽落于区块 5 行号区间，实为规划域函数，随 Task 2 归入 manager.rs） | manager.rs |
| 5 | L8687-9074 | create_ai_terminal、read_terminal_exit_code、run_attempt_watchdog、terminal_exit_marker_path、attempt_terminal_running、reconcile_running_attempt、fail_attempt_from_watchdog、expected_artifacts_written、is_last_workflow_stage、record_watchdog_observation、wait_for_shell_ready、start_interactive_terminal_command、wait_for_terminal_exit | terminal.rs |
| 6 | L8465-8686 | mod terminal_command_tests（整体） | terminal.rs |
| 7 | L8248-8464 | mod cycle_detection_tests（整体） | tests.rs |
| 8 | L8009-8247 | powershell_literal、split_runtime_command、runtime_kind_matches、runtime_is_codex、wrap_terminal_command、build_interactive_terminal_command、preset_model_args_from_value、build_interactive_terminal_command_with_codex_output | terminal.rs |
| 9 | L7335-8008 | mod agent_decision_tests（整体） | tests.rs |
| 10 | L7233-7334 | struct TerminalControl、struct AgentDecisionFile、struct WorkflowReviewFile、prepare_terminal_control、read_agent_decision、read_workflow_review | terminal.rs |
| 11 | L7092-7232 | build_agent_prompt | manager.rs |
| 12 | L6982-7090 | safe_display_segment、dispatch_lock、attempt_start_lock、make_terminal_run_dir_name、terminal_run_dir_by_id、safe_path_segment、compact_path_id、safe_ref_segment、run_git | helpers.rs |
| 13 | L6593-6980 | validate_runtime、validate_agent_configuration、validate_task_input、validate_write_paths、write_paths_overlap、project_repository_path、ensure_clean_repository、repository_status、project_repository_statuses、ensure_project_repository_statuses_unchanged、audit_contract_scope、audit_allowed_write_paths、is_allowed_write_path、project_artifact_base_path、repository_worktree_base_path、ensure_worktree_directory_is_ignored、cleanup_delivery_integration_workspace、cleanup_delivery_task_worktrees | helpers.rs |
| 14 | L6317-6592 | normalize_quality_gate、scan_repository_quality_contexts、scan_quality_manifests、scan_quality_manifests_recursive、package_scripts、detect_repository_stacks、push_stack、build_quality_gate_prompt | quality.rs |
| 15 | L6303-6316 | git_root、current_branch | helpers.rs |
| 16 | L6248-6302 | discover_repositories | quality.rs |
| 17 | L6228-6247 | canonical_directory、normalize_optional_directory | helpers.rs |
| 18 | L6058-6227 | unavailable_runtime_probe、executable_exists_in_path、probe_local_runtime、available_runtime_probe、npm_global_command、npm_command_probe | helpers.rs |
| 19 | L5828-6057 | build_task_diff、cleanup_unallocated_task_worktree、collect_transitive_dependency_ids、materialize_dependency_artifacts、prepare_output_artifact_directory、copy_artifact_path | helpers.rs |
| 20 | L5466-5827 | list_ai_delivery_templates、create_ai_delivery_template、update_ai_delivery_template、delete_ai_delivery_template、expand_template、save_delivery_as_template、create_task_contract、allocate_task_worktree | entity.rs |
| 21 | L3542-5465 | dispatch_task_node、retry_task_node、dispatch_ready_tasks、dispatch_ready_and_start、start_attempt、cancel_attempt、cancel_task_node、mark_task_skipped、cancel_queued_attempts_of_task、cleanup_skipped_task_worktree、confirm_policy_violation_site、ensure_manual_completion_allowed、complete_attempt、interrupt_attempt、fail_queued_attempt、pause_attempt_for_decision、run_acceptance_validation、finish_attempt、return_review_dependencies_for_rework、select_agent、active_attempt_count_for_agent、active_attempts_index、persist_attempt、rebuild_active_attempt_index、active_attempts_snapshot、global_active_attempts、dispatch_priority、check_capacity、try_complete_workflow_delivery、prune_delivery_events、cleanup_attempt_run_dir、append_event、delivery_decision_bindings、register_delivery_decision_binding、resolve_delivery_decision_binding、extract_delivery_decision_id、delivery_push_client、push_delivery_notice | dispatch.rs |
| 22 | L3006-3541 | get_merge_records、merge_delivery_locally、cleanup_delivery_integration、validate_tasks_mergeable、rollback_merge_record | delivery.rs |
| 23 | L2605-3005 | get_review_gates、get_review_diff、add_review_line_comment、run_quality_gate、run_quality_gate_inner、resolve_review_gate、save_review_gate | quality.rs |
| 24 | L2533-2604 | recover_interrupted_attempts | dispatch.rs |
| 25 | L1248-2532 | delete_delivery、get_task_nodes、get_task_node、has_cycle、validate_task_fields、cleanup_pending_gates_and_decisions、create_task_node、update_task_node、delete_task_node、approve_delivery、pause_delivery、resume_delivery、cancel_delivery、refresh_ready_task_nodes、get_delivery_events、get_decision_requests、create_decision_request、answer_decision_request、get_all_attempts、read_attempt_output、list_delivery_artifacts、read_delivery_artifact、export_delivery_artifacts_zip、generate_delivery_report | delivery.rs |
| 26 | L1020-1247 | begin_delivery_planning、fail_delivery_planning、plan_delivery_with_manager | manager.rs |
| 27 | L891-1019 | get_all_task_contracts、get_all_deliveries、get_delivery、create_delivery、update_delivery | delivery.rs |
| 28 | L816-886 | replan_legacy_delivery、replan_delivery_accepting_current_state | manager.rs |
| 29 | L489-815 | get_all_runtimes、save_runtime、delete_runtime、get_all_agents、save_agent、delete_agent、get_all_startup_presets、get_startup_preset_by_name、save_startup_preset、delete_startup_preset、get_all_roles、save_role、delete_role、get_all_workflows、test_workflow_step、save_workflow、delete_workflow | entity.rs |
| 30 | L447-488 | detect_local_runtimes | helpers.rs |
| 31 | L341-446 | generate_quality_gate_commands | quality.rs |
| 32 | L262-340 | get_all_projects、get_project、create_project、refresh_project_repositories、update_project | entity.rs |
| 33 | L234-261 | root_dir、entity_dir、list、save、get、delete | entity.rs |
| 34 | L212-231 | const QUALITY_MANIFEST_NAMES | quality.rs |
| 35 | L202-210 | const WORKFLOW_REVIEW_SCHEMA | **mod.rs（留原位）** |
| 36 | L189-200 | const QUALITY_GATE_SCHEMA | quality.rs |
| 37 | L173-187 | struct RepositoryQualityContext、struct QualityManifest | quality.rs |

**留在 mod.rs（不动）**：L1-25（use）、L28-34（APP_HANDLE、CREATE_NO_WINDOW）、L36-70（目录/超时常量、EXECUTION_CONTEXT_*）、L72-87（resolve_execution_context）、L89-123（锁与 guard）、L119-135（same_runtime_command）、L137（struct AiDeliveryService）、L139-171（ManagerPlan、ManagerPlanTask、QualityGatePlan）、L202-210（WORKFLOW_REVIEW_SCHEMA）。

**任务内区块步骤均为降序**：T2(1-4) → T3(5-10) → T4(11-19) → T5(20-21) → T6(22-28) → T7(29-33) → T8(34-37)，全局严格降序，区块原始行号在各任务执行时用 Grep 复核。

---

### Task 1: 脚手架（目录 + 8 个子模块骨架 + 门面声明）

**Files:**
- Create: `terminal-buddy/src-tauri/src/services/ai_delivery_service/{manager,helpers,terminal,tests,quality,entity,dispatch,delivery}.rs`（8 个骨架）
- Modify: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs`（追加模块声明）

**Interfaces:**
- Consumes: 无
- Produces: 门面机制——主文件声明全部子模块并 `use <name>::*;`；每个子模块 `use super::*;`。后续所有任务的跨模块引用都依赖此机制解析。

- [ ] **Step 1: 创建目录与 8 个骨架文件**

```bash
mkdir -p terminal-buddy/src-tauri/src/services/ai_delivery_service
```

每个文件写入两行（名称与职责对应区块总表）：

```rust
//! AI 交付服务 · <职责> 模块（自 ai_delivery_service.rs 拆分）
use super::*;
```

职责：manager=规划域、helpers=通用工具、terminal=终端域、tests=跨域测试、quality=质量域、entity=实体 CRUD、dispatch=派发域、delivery=交付域。

- [ ] **Step 2: 主文件追加模块声明**
  在 `pub struct AiDeliveryService;`（原 L137）之后插入：

```rust
mod manager;
use manager::*;
mod helpers;
use helpers::*;
mod terminal;
use terminal::*;
mod tests;
use tests::*;
mod quality;
use quality::*;
mod entity;
use entity::*;
mod dispatch;
use dispatch::*;
mod delivery;
use delivery::*;
```

- [ ] **Step 3: 编译确认**

```bash
cd terminal-buddy/src-tauri && cargo check
```

预期：0 错误（空模块 + 门面声明不引入错误；允许警告）。

- [ ] **Step 4: 提交**

```bash
git add terminal-buddy/src-tauri/src/services/ai_delivery_service.rs terminal-buddy/src-tauri/src/services/ai_delivery_service/
git commit -m "[AI交付] 拆分 ai_delivery_service：脚手架（子模块骨架与门面）"
```

### Task 2: manager.rs 与 helpers.rs（区块 1-4，L9562-9075）

**Files:**
- Modify: `manager.rs`（区块 1、3、4）、`helpers.rs`（区块 2）
- Modify: 主文件（删除区块 1-4）

- [ ] **Step 1: Grep 复核区块当前行号**
  锚点：`fn run_manager_planner`、`fn compact_output`、`fn run_reviewer_agent`、`fn repair_workflow_review`（`-n` 取行号；区块 1 尾 = 文件尾，其余 = 下一锚点 - 1）。
- [ ] **Step 2: 提取区块 1 → manager.rs**
  Read 该区间，逐字复制到 manager.rs（骨架后）。全部 `fn` → `pub(crate) fn`（含 `manager_plan_schema`）。
- [ ] **Step 3: 提取区块 2 → helpers.rs**（同上，全部 `fn` → `pub(crate) fn`）
- [ ] **Step 4: 提取区块 3、4 → manager.rs**（同上）
- [ ] **Step 5: 删除主文件中区块 1-4 原文**（自区块 1 首行至区块 4 末行，逐字删除，保留相邻空行结构）
- [ ] **Step 6: `cargo check`**
  预期错误：manager.rs/helpers.rs 中引用的终端函数（`create_ai_terminal`、`prepare_terminal_control` 等）尚在主文件——经 `use super::*` 可见，无需处理。若编译器报某项未标 `pub(crate)`，按报错补齐。不得留错误。
- [ ] **Step 7: 提交**（message: `[AI交付] 拆分 ai_delivery_service：manager/helpers 模块（规划与执行工具）`）

### Task 3: terminal.rs 与 tests.rs（区块 5-10，L8687-7233）

**Files:**
- Modify: `terminal.rs`（区块 5、6、8、10）、`tests.rs`（区块 7、9）
- Modify: 主文件（删除区块 5-10）

- [ ] **Step 1: Grep 复核区块当前行号**
  锚点：`fn create_ai_terminal`、`mod terminal_command_tests`、`mod cycle_detection_tests`、`fn powershell_literal`、`mod agent_decision_tests`、`struct TerminalControl`。
- [ ] **Step 2: 提取区块 5 → terminal.rs**（`fn` → `pub(crate) fn`；保留内部 `crate::commands::notification::...`、`chrono::...` 全路径调用原样）
- [ ] **Step 3: 提取区块 6 → terminal.rs**（`mod terminal_command_tests { ... }` 整体原样复制，内部 use 保留）
- [ ] **Step 4: 提取区块 7 → tests.rs**（`mod cycle_detection_tests { ... }` 整体原样复制）
- [ ] **Step 5: 提取区块 8 → terminal.rs**（`fn` → `pub(crate) fn`）
- [ ] **Step 6: 提取区块 9 → tests.rs**（`mod agent_decision_tests { ... }` 整体原样复制）
- [ ] **Step 7: 提取区块 10 → terminal.rs**（`TerminalControl`/`AgentDecisionFile`/`WorkflowReviewFile` → `pub(crate) struct`；三个函数 → `pub(crate) fn`）
- [ ] **Step 8: 删除主文件中区块 5-10 原文**（注意区块 6/7/9 是 `mod ... { }` 整体块，删除时连同闭合大括号）
- [ ] **Step 9: `cargo check`**
  预期错误点：tests.rs 引用 `scan_quality_manifests`、`build_quality_gate_prompt`（quality.rs，Task 4 才提取，当前仍在主文件——经 `use super::*` 可见）；`allocate_task_worktree`（entity.rs，Task 5）同理。均无需处理。若报未标可见性，按报错补齐。
- [ ] **Step 10: 提交**（message: `[AI交付] 拆分 ai_delivery_service：terminal/tests 模块（终端与测试）`）

### Task 4: manager/helpers/quality（区块 11-19，L7092-5828）

**Files:**
- Modify: `manager.rs`（区块 11）、`helpers.rs`（区块 12、13、15、17、18、19）、`quality.rs`（区块 14、16）
- Modify: 主文件（删除区块 11-19）

- [ ] **Step 1: Grep 复核区块当前行号**
  锚点：`fn build_agent_prompt`、`fn safe_display_segment`、`fn validate_runtime`、`fn normalize_quality_gate`、`fn git_root`、`fn discover_repositories`、`fn canonical_directory`、`fn unavailable_runtime_probe`、`fn build_task_diff`。
- [ ] **Step 2: 提取区块 11 → manager.rs**（`fn` → `pub(crate) fn`）
- [ ] **Step 3: 提取区块 12 → helpers.rs**（含 `run_git` → `pub(crate) fn`）
- [ ] **Step 4: 提取区块 13 → helpers.rs**（校验/审计/git 仓库工具群 → `pub(crate) fn`）
- [ ] **Step 5: 提取区块 14 → quality.rs**（→ `pub(crate) fn`）
- [ ] **Step 6: 提取区块 15 → helpers.rs**（git_root、current_branch → `pub(crate) fn`）
- [ ] **Step 7: 提取区块 16 → quality.rs**（discover_repositories → `pub(crate) fn`）
- [ ] **Step 8: 提取区块 17 → helpers.rs**（→ `pub(crate) fn`）
- [ ] **Step 9: 提取区块 18 → helpers.rs**（运行时探测 → `pub(crate) fn`）
- [ ] **Step 10: 提取区块 19 → helpers.rs**（产物/契约工具 → `pub(crate) fn`）
- [ ] **Step 11: 删除主文件中区块 11-19 原文**
- [ ] **Step 12: `cargo check` 修复**
  预期：`discover_repositories`（quality.rs）调用 `git_root`（helpers.rs）——经门面链可见；`build_quality_gate_prompt` 引用 `RepositoryQualityContext`/`QualityManifest`——当前在主文件 L173-187，经 `use super::*` 可见。按报错补齐可见性。
- [ ] **Step 13: 提交**（message: `[AI交付] 拆分 ai_delivery_service：helpers/quality 模块（工具与质量上下文）`）

### Task 5: entity.rs 与 dispatch.rs（区块 20-21，L5466-3542）

**Files:**
- Modify: `entity.rs`（区块 20）、`dispatch.rs`（区块 21）
- Modify: 主文件（删除区块 20-21）

- [ ] **Step 1: Grep 复核区块当前行号**
  锚点：`fn list_ai_delivery_templates`、`fn dispatch_task_node`。
- [ ] **Step 2: 提取区块 20 → entity.rs**
  复制；`pub fn` 保持 pub，私有 `fn` → `pub(crate) fn`。整块为 `impl AiDeliveryService { ... }` 的一部分——在 entity.rs 中写成 `impl AiDeliveryService { ... }` 新块（方法移动时不带缩进层级问题，按原文缩进复制，保留 `    pub fn ...` 的 4 空格缩进，包裹进 `impl AiDeliveryService {`）。
- [ ] **Step 3: 提取区块 21 → dispatch.rs**
  同上；39 个方法中 `pub fn` 保持 pub（`dispatch_task_node`、`start_attempt`、`append_event`、`push_delivery_notice` 等），私有 `fn` → `pub(crate) fn`（`interrupt_attempt`、`fail_queued_attempt`、`finish_attempt`、`select_agent`、`active_attempts_index` 等）。
- [ ] **Step 4: 删除主文件中区块 20-21 原文**
- [ ] **Step 5: `cargo check` 修复**
  预期：`start_attempt`（dispatch.rs）调用 `build_agent_prompt`（manager.rs，经门面可见）、`attempt_start_lock`（mod.rs，经 `use super::*` 可见）；`append_event` 推送 `APP_HANDLE`（mod.rs）——均可解析。按报错补齐。
- [ ] **Step 6: 提交**（message: `[AI交付] 拆分 ai_delivery_service：entity/dispatch 模块（模板与派发）`）

### Task 6: delivery/quality/dispatch/manager（区块 22-28，L3541-816）

**Files:**
- Modify: `delivery.rs`（区块 22、25、27）、`quality.rs`（区块 23）、`dispatch.rs`（区块 24）、`manager.rs`（区块 26、28）
- Modify: 主文件（删除区块 22-28）

- [ ] **Step 1: Grep 复核区块当前行号**
  锚点：`fn get_merge_records`、`fn get_review_gates`、`fn recover_interrupted_attempts`、`fn delete_delivery`、`fn begin_delivery_planning`、`fn get_all_task_contracts`、`fn replan_legacy_delivery`。
- [ ] **Step 2: 提取区块 22 → delivery.rs**（`fn` → `pub(crate) fn`）
- [ ] **Step 3: 提取区块 23 → quality.rs**（`pub fn` 保持 pub，私有 → `pub(crate) fn`：`run_quality_gate_inner`、`save_review_gate`）
- [ ] **Step 4: 提取区块 24 → dispatch.rs**（`pub fn recover_interrupted_attempts` 保持 pub）
- [ ] **Step 5: 提取区块 25 → delivery.rs**（`pub fn` 保持 pub，私有 → `pub(crate) fn`：`validate_task_fields`、`cleanup_pending_gates_and_decisions`）
- [ ] **Step 6: 提取区块 26 → manager.rs**（`pub fn` 保持 pub，私有辅助 → `pub(crate) fn`）
- [ ] **Step 7: 提取区块 27 → delivery.rs**（`pub fn` 保持 pub）
- [ ] **Step 8: 提取区块 28 → manager.rs**（`pub fn` 保持 pub）
- [ ] **Step 9: 删除主文件中区块 22-28 原文**
- [ ] **Step 10: `cargo check` 修复**
  预期：`run_quality_gate_inner`（quality.rs）调用 `ensure_expected_artifacts`/`ensure_task_branch_clean`（helpers.rs）、`run_command_with_timeout`（manager.rs）、`acquire_quality_gate_lock`（mod.rs）——均可解析。按报错补齐。
- [ ] **Step 11: 提交**（message: `[AI交付] 拆分 ai_delivery_service：delivery/quality/manager 模块（交付与规划）`）

### Task 7: entity/helpers/quality（区块 29-33，L815-234）

**Files:**
- Modify: `entity.rs`（区块 29、32、33）、`helpers.rs`（区块 30）、`quality.rs`（区块 31）
- Modify: 主文件（删除区块 29-33）

- [ ] **Step 1: Grep 复核区块当前行号**
  锚点：`fn get_all_runtimes`、`fn detect_local_runtimes`、`fn generate_quality_gate_commands`、`fn get_all_projects`、`fn root_dir`。
- [ ] **Step 2: 提取区块 29 → entity.rs**（`pub fn` 保持 pub，私有 → `pub(crate) fn`；`test_workflow_step` 调用 `run_shell_command`（helpers.rs，经门面可见））
- [ ] **Step 3: 提取区块 30 → helpers.rs**
  `detect_local_runtimes` 是 impl 方法：在 helpers.rs 中包裹进 `impl AiDeliveryService { ... }` 块；`pub fn` 保持 pub（commands 层以 `AiDeliveryService::detect_local_runtimes` 调用）。
- [ ] **Step 4: 提取区块 31 → quality.rs**（`pub fn generate_quality_gate_commands` 保持 pub）
- [ ] **Step 5: 提取区块 32 → entity.rs**（`pub fn` 保持 pub）
- [ ] **Step 6: 提取区块 33 → entity.rs**
  `fn root_dir/entity_dir/list/save/get/delete` → `pub(crate) fn`（dispatch 的 `AiDeliveryService::get::<AiAttempt>`、watchdog、manager 的 `entity_dir` 均跨模块调用），包裹进 `impl AiDeliveryService { ... }` 块。
- [ ] **Step 7: 删除主文件中区块 29-33 原文**
- [ ] **Step 8: `cargo check` 修复**
  预期：主文件中 `impl AiDeliveryService` 块至此应已全部清空（仅剩 `impl AiDeliveryService { }` 空壳，若存在则删除该空壳）。
- [ ] **Step 9: 提交**（message: `[AI交付] 拆分 ai_delivery_service：entity/helpers/quality 模块（CRUD 与探测）`）

### Task 8: quality.rs 常量区（区块 34-37，L231-173）

**Files:**
- Modify: `quality.rs`（区块 34、36、37）
- Modify: 主文件（删除区块 34、36、37；区块 35 的 WORKFLOW_REVIEW_SCHEMA 留原位）

- [ ] **Step 1: Grep 复核区块当前行号**（锚点：`const QUALITY_MANIFEST_NAMES`、`const QUALITY_GATE_SCHEMA`、`struct RepositoryQualityContext`）
- [ ] **Step 2: 提取区块 37 → quality.rs**（`RepositoryQualityContext`/`QualityManifest` → `pub(crate) struct`；`serde` 派生属性原样保留）
- [ ] **Step 3: 提取区块 36 → quality.rs**（`QUALITY_GATE_SCHEMA` → `pub(crate) const`）
- [ ] **Step 4: 提取区块 34 → quality.rs**（`QUALITY_MANIFEST_NAMES` → `pub(crate) const`）
- [ ] **Step 5: 删除主文件中区块 34、36、37 原文**（区块 35 的 WORKFLOW_REVIEW_SCHEMA 不动）
- [ ] **Step 6: `cargo check` 修复**
  预期：`scan_quality_manifests`（quality.rs）引用 `QUALITY_MANIFEST_NAMES`——同模块 ✓；`read_workflow_review`（terminal.rs）引用 `WORKFLOW_REVIEW_SCHEMA`（mod.rs，经 `use super::*`）✓。按报错补齐。
- [ ] **Step 7: 提交**（message: `[AI交付] 拆分 ai_delivery_service：quality 模块（门禁常量）`）

### Task 9: mod.rs 收尾与重命名

**Files:**
- Rename: `terminal-buddy/src-tauri/src/services/ai_delivery_service.rs` → `terminal-buddy/src-tauri/src/services/ai_delivery_service/mod.rs`
- Modify: 新 `mod.rs`（整理头部、确认残留）

- [ ] **Step 1: 检查主文件剩余内容**
  Read 主文件，应只剩：L1-25 use、L28-34、L36-70 常量、L72-87 resolve_execution_context、L89-123 锁与 guard、L119-135 same_runtime_command、L137 struct、L139-171 ManagerPlan 等、L202-210 WORKFLOW_REVIEW_SCHEMA、以及 Task 1 追加的 `mod x; use x::*;` 声明。若有遗漏区块，按区块总表归位。
- [ ] **Step 2: 整理头部**
  文件顶部加 `//! AI 交付服务（服务入口，自 ai_delivery_service.rs 拆分）：常量/锁/结构体与模块汇总`。保留全部 `use` 原样（子模块经 `use super::*` 依赖它们；`unused_imports` 警告可保留，不阻断）。
- [ ] **Step 3: 重命名**

```bash
git mv terminal-buddy/src-tauri/src/services/ai_delivery_service.rs terminal-buddy/src-tauri/src/services/ai_delivery_service/mod.rs
```

- [ ] **Step 4: `cargo check`**
  模块路径 `crate::services::ai_delivery_service::APP_HANDLE`（lib.rs L290）必须仍解析成功。
- [ ] **Step 5: 提交**（message: `[AI交付] 拆分 ai_delivery_service：整合 mod.rs`）

### Task 10: 全量验证与最终提交

**Files:** 无新改动（验证用）

- [ ] **Step 1: `cargo check`** 预期 0 错误。
- [ ] **Step 2: `cargo test`**
  运行全部测试，预期 `agent_decision_tests`、`cycle_detection_tests`、`terminal_command_tests` 三模块全绿。若失败先排查是否拆分引入（对比失败信息），不得跳过。
- [ ] **Step 3: 审查 diff**
  `git diff HEAD --stat` 确认：`ai_delivery_service.rs` 删除、`ai_delivery_service/` 下 9 个文件新建，其余路径无改动。
- [ ] **Step 4: 抽查完整性**
  `grep -c "impl AiDeliveryService" services/ai_delivery_service/*.rs` 应 ≥ 6（实际 6 个：delivery/dispatch/entity/helpers/manager/quality 各 1，terminal/tests 为自由函数与测试模块）；区块总表 37 个区块全部归位（函数名抽样 grep）。
- [ ] **Step 5: 最终提交**（若 Task 9 后无新改动则跳过）：message: `[AI交付] ai_delivery_service 拆分完成（9975 行 → 9 模块）`

---

## 自审清单

1. **Spec 覆盖**：spec 的 9 文件布局 ↔ Task 1-9（脚手架覆盖全部 8 子模块，T2-T8 逐域填充，T9 mod.rs）；可见性/门面策略 ↔ Global Constraints 3-4；测试迁移 ↔ Task 3（terminal_command_tests→terminal.rs，agent_decision/cycle_detection→tests.rs）；验证 ↔ Task 10。✓
2. **占位符扫描**：全部步骤给出具体区块号、函数名锚点、命令，无 TBD/TODO。✓
3. **类型/名称一致性**：区块总表函数名来自对原文件的逐行 grep；任务内函数名与总表一致；`pub(crate)` 统一规则避免签名漂移。✓
4. **顺序正确性**：任务内与任务间均按原始行号严格降序（T2:1-4 → T3:5-10 → T4:11-19 → T5:20-21 → T6:22-28 → T7:29-33 → T8:34-37），且每个任务 Step 1 以 Grep 锚点复核当前行号，消除删行漂移。✓
5. **编译可行性**：门面机制（Task 1 一次性建立）保证任何提取顺序下，未提取项仍经 `use super::*` 可见——每步 `cargo check` 仅需按报错补齐 `pub(crate)`。✓
