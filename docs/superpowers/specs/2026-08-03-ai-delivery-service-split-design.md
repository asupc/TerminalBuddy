# 设计：拆分 ai_delivery_service.rs 为多个文件

日期：2026-08-03
状态：已批准（用户确认按领域细拆）

## 背景与目标

`terminal-buddy/src-tauri/src/services/ai_delivery_service.rs` 已膨胀至 9975 行，包含：
- 单个巨型 `impl AiDeliveryService`（L233-5827，约 120 个方法：实体 CRUD、派发/attempt 生命周期、质量门禁、合并、报告、模板等）
- 约 1400 行自由函数（任务 diff、运行时探测、仓库扫描、校验、git、worktree）
- 终端控制结构与 3 个测试模块

目标：按领域拆分为 9 个文件，**纯移动、零行为变化**，外部调用方零改动。

## 模块布局

`services/ai_delivery_service.rs` → `services/ai_delivery_service/` 目录（模块路径保持不变）：

### `mod.rs` — 共享层（~450 行）

- 全部顶层 `use`（std / models / tauri / uuid / chrono，供子模块 `use super::*`）
- 目录名常量、超时常量、`MAX_EVENTS_*`、`DEFAULT_ATTEMPT_TIMEOUT_SECONDS`、`TIMEOUT_WARNING_RATIO`、`GLOBAL_MAX_ATTEMPTS`
- 锁与 guard（integration / quality_gate / manager_plan / runtime_save）
- `pub static APP_HANDLE`
- `pub struct AiDeliveryService`（结构体定义）
- `ManagerPlan` / `ManagerPlanTask` / `QualityGatePlan` 私有结构
- `EXECUTION_CONTEXT_*` 常量、`resolve_execution_context`、`same_runtime_command`
- 子模块声明（`mod entity; mod delivery; ...`）

### `entity.rs` — 实体 CRUD（~1100 行）

- 基础 CRUD：`root_dir`、`entity_dir`、`list`、`save`、`get`、`delete`（L234-261，标 `pub(crate)`——dispatch/terminal 跨模块使用）
- 项目：`get_all_projects`、`get_project`、`create_project`、`refresh_project_repositories`、`update_project`（L262-340）
- 运行时/Agent/预设/角色/工作流 CRUD（L489-815、L887-890）
- 模板与契约：`list/create/update/delete_ai_delivery_template`、`expand_template`、`save_delivery_as_template`、`create_task_contract`、`allocate_task_worktree`（L5466-5827）

### `delivery.rs` — 交付域（~1900 行）

- 契约/交付/任务节点/事件/决策/attempt 记录/产物/报告：L891-2604 整段（含 `read_attempt_output`）
- 合并：`get_merge_records`、`merge_delivery_locally`、`cleanup_delivery_integration`、`validate_tasks_mergeable`、`rollback_merge_record`（L3006-3541）

### `dispatch.rs` — 派发与 attempt 生命周期（~2000 行）

- `recover_interrupted_attempts`（L2533-2604）
- 派发/attempt 全生命周期：`dispatch_task_node`、`retry_task_node`、`dispatch_ready_tasks`、`dispatch_ready_and_start`、`start_attempt`、`cancel_attempt`、`cancel_task_node`、`mark_task_skipped`、`complete_attempt`、`finish_attempt`、`run_acceptance_validation`、`select_agent`、容量/并发控制、`append_event`、决策绑定、`push_delivery_notice` 等（L3542-5465）

### `terminal.rs` — 终端域（~1900 行）

- `TerminalControl` / `AgentDecisionFile` / `WorkflowReviewFile` 结构、`prepare_terminal_control`、`read_agent_decision`、`read_workflow_review`（L7233-7334）
- 命令构建：`powershell_literal`、`split_runtime_command`、`wrap_terminal_command`、`build_interactive_terminal_command(_with_codex_output)` 等（L8009-8247）
- 终端生命周期：`create_ai_terminal`、`run_attempt_watchdog`、`reconcile_running_attempt`、`fail_attempt_from_watchdog`、`wait_for_shell_ready`、`start_interactive_terminal_command`、`wait_for_terminal_exit`、`expected_artifacts_written`、`record_watchdog_observation`（L8687-9074、L9111-9166）
- 内嵌 `mod terminal_command_tests`（L8465-8686）

### `manager.rs` — 规划域（~1400 行）

- `replan_legacy_delivery`、`replan_delivery_accepting_current_state`（L816-886）
- `begin_delivery_planning`、`fail_delivery_planning`、`plan_delivery_with_manager`（L1020-1247）
- `repair_workflow_review`（L9075-9110）、`run_reviewer_agent`（L9167-9234）
- 规划自由函数：`build_manager_prompt`、`validate_manager_workflow_plan`、`requires_workflow_review`、`run_manager_planner`、`manager_plan_schema`、`generate_quality_gate_with_runtime`、`normalize_path_for_external_process`、`run_command_with_timeout`（L9562-9944）
- `build_agent_prompt`（L7092-7232）

### `quality.rs` — 质量域（~1100 行）

- `generate_quality_gate_commands`（L341-446）
- 审核 gate：`get_review_gates`、`get_review_diff`、`add_review_line_comment`、`run_quality_gate`、`run_quality_gate_inner`、`resolve_review_gate`、`save_review_gate`（L2605-3005）
- 质量上下文：`discover_repositories`（L6248-6302）、`normalize_quality_gate`、`scan_repository_quality_contexts`、`scan_quality_manifests(_recursive)`、`package_scripts`、`detect_repository_stacks`、`push_stack`、`build_quality_gate_prompt`（L6317-6592）
- `RepositoryQualityContext` / `QualityManifest` 结构、`QUALITY_GATE_SCHEMA`、`QUALITY_MANIFEST_NAMES`（从原 L173-232 移入）

### `helpers.rs` — 通用工具（~1800 行）

- 运行时探测：`detect_local_runtimes`（impl，L447-488）、`unavailable_runtime_probe`、`executable_exists_in_path`、`probe_local_runtime`、`available_runtime_probe`、`npm_global_command`、`npm_command_probe`（L6058-6247）
- 产物/契约：`build_task_diff`、`cleanup_unallocated_task_worktree`、`collect_transitive_dependency_ids`、`materialize_dependency_artifacts`、`prepare_output_artifact_directory`、`copy_artifact_path`（L5828-6057）
- git/仓库：`git_root`、`current_branch`（L6303-6316）、`project_repository_path`、`ensure_clean_repository`、`repository_status`、`project_repository_statuses`、`ensure_project_repository_statuses_unchanged`、worktree 相关（L6674-7062）
- 校验/审计：`validate_runtime`、`validate_agent_configuration`、`validate_task_input`、`validate_write_paths`、`write_paths_overlap`、`audit_contract_scope`、`audit_allowed_write_paths`、`is_allowed_write_path`、`validate_artifact_paths`（L6593-6840、L9433-9450）
- 路径/文本：`canonical_directory`、`normalize_optional_directory`（L6228-6247）、`safe_display_segment`、`make_terminal_run_dir_name`、`terminal_run_dir_by_id`、`safe_path_segment`、`compact_path_id`、`safe_ref_segment`、`run_git`（L6982-7090）
- 执行工具：`compact_output`、`strip_terminal_control_sequences`、`build_continuation_context`、`ensure_expected_artifacts`、`is_legacy_delivery_plan`、`upgrade_legacy_workflow_steps`、`ensure_readonly_execution_unchanged`、`ensure_task_branch_clean`、`run_shell_command`（L9235-9561）
- `dispatch_lock`、`attempt_start_lock`（L6999-7009）

### `tests.rs` — 跨域测试（~1000 行）

- `agent_decision_tests`（L7335-8008）
- `cycle_detection_tests`（L8248-8464）

## 可见性与导入策略

- **外部零改动**：模块名 `ai_delivery_service` 保持（变目录），`lib.rs` 的 `APP_HANDLE` 路径、`services/mod.rs` 的 `pub use ai_delivery_service::*;`、commands/ai_delivery.rs 的所有调用均不修改。
- **共享层**：mod.rs 的常量/锁/结构体保持原可见性即可——Rust 子模块天然可访问父模块私有项，无需改可见性。
- **跨模块调用**：被其他子模块调用的私有 impl 方法/自由函数改为 `pub(crate)`（编译器驱动补齐）；每个子模块顶部 `use super::*;` 引入共享层，跨模块自由函数用显式 `use super::<mod>::<fn>;` 引入。
- **impl 块分散**：多个文件各自 `impl AiDeliveryService { ... }`，方法互调不受模块位置限制。
- **纯移动**：不改任何业务逻辑、注释、方法签名、字符串。

## 测试迁移

- `terminal_command_tests` → `terminal.rs` 内嵌子模块（测纯命令构建函数，保持模块内私有可见性）。
- `agent_decision_tests`、`cycle_detection_tests` → `tests.rs`（跨域访问，被测项标 `pub(crate)`）。

## 验证

1. `cd terminal-buddy/src-tauri && cargo check` 通过。
2. `cargo test` 通过：`agent_decision_tests`、`cycle_detection_tests`、`terminal_command_tests` 全绿。
3. `git diff --stat`：旧单文件删除，新目录建立，其他文件无改动。

## 不在范围内

- 不修改任何业务逻辑或方法签名。
- 不改变外部 API（命令层、lib.rs、前端）。
- 不做行内重构（如提取重复代码、改名）。
- 不改动 `.claude/settings.local.json` 等无关工作区文件。
