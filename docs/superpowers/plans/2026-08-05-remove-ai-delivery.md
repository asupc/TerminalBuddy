# 删除 AI 交付功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 TerminalBuddy 代码库中完整移除「AI 交付」（ai delivery / ai_delivery）功能，包括 Rust 后端模块、前端组件、Web SPA、配置项与文档，同时保留机器人通知、Claude Code Hook、AI 用量等独立功能。

**Architecture:** 纯删除任务，无新增行为。分三层推进：先清理 Rust 引用中枢（lib.rs / server.rs / window.rs）保持编译通过，再整目录删除 AI 交付模块并同步剥离 bot 交叉点（bot 代码引用了 AiDeliveryService，必须同任务删除），随后清理 database_service、前端与文档。每个任务以编译/类型检查/测试作为门禁并独立提交。TDD 不适用于删除任务，任务门禁 = `cargo check`（零错误零警告）+ `cargo test`（bot 测试仍通过）+ `npx tsc --noEmit`（零错误）+ `grep` 残留扫描。

**Tech Stack:** Rust (Tauri 2.x / axum / rusqlite / serde)、React 18 + TypeScript (Zustand / xterm.js)、SQLite、PowerShell 脚本。

**关键路径说明（先读）**
- 仓库根 = `D:\gitee\terminal-buddy`（git 仓库根，含 `README.md`、`docs/`、`version.json`、`CLAUDE.md`、`ai-delivery-orchestrator-demo.html`）
- 项目代码在子目录 `terminal-buddy/`（含 `src-tauri/`、`src/`、`web/`、`scripts/`、`docs/fix-plans/`）
- 所有路径从仓库根写起；`cd terminal-buddy` 后执行编译类命令

## Global Constraints

（以下规则全部来自设计规格 `docs/superpowers/specs/2026-08-05-remove-ai-delivery-design.md`，每个任务隐式包含本节）

- **保留**：机器人（bot）通知功能（bot_binding_service / bot_long_connection_service / bot_settings_service / bot_scan / bot_weixin_service / commands/bot.rs / models/bot.rs / web/handlers/bot_handler.rs / bot_decision_bindings 表 / weixin_runtime_states 表 / Cargo.toml 的 `lark-channel` 依赖）
- **保留**：Claude Code Hook 体系（claude_hook_service、hooks 命令、HookSettings）、AI 用量功能（ai_usage.rs、AiUsagePanel、zhipuApiKey/qianfanCookie）
- **不删**：已安装用户旧库中的 `ai_entities` 等旧表数据（运行时数据，由用户自行决定）
- **不改**：`commands/terminal.rs`、`commands/git.rs` 等共享服务的业务行为（仅允许清理其中指向已删除功能的注释文字）
- **不动**：`.codegraph/`、`.terminalbuddy-worktrees/`、`.superpowers/`（运行时/会话数据目录）
- **不手改** `src-tauri/gen/`：tauri-build 在构建/编译时自动再生（如 `gen/schemas/capabilities.json` 随能力文件编辑同步更新）。再生成的同步变更可随提交保留——本仓库跟踪该文件（Task 4 审查裁定，2026-08-05；规格「八、不做的事」未涉及 gen/，此为计划文字修正）
- 删除后全局 grep `ai_delivery`、`AiDelivery`、`ai-delivery`、`AI 交付` 应仅剩白名单：本设计规格文档、本实施计划文档、`.superpowers/sdd/**` 会话数据、`src-tauri/gen/**` 生成文件；另 `src/components/ai-delivery/**` 与 `web/src/screens/AiDelivery.tsx` 在 Task 5-7 删除前属预期残留（Task 9 复核）
- 编译门禁：`cargo check` 零错误、零警告；`npx tsc --noEmit` 零错误
- 提交信息遵循项目惯例 `[模块] 变更描述`（中文）

---

### Task 1: 清理 Rust 引用中枢（lib.rs / server.rs / window.rs）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/lib.rs`
- Modify: `terminal-buddy/src-tauri/src/web/server.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/window.rs`

**Interfaces:**
- Consumes: 无（本任务是清理的起点）
- Produces: 本任务后 `AiDeliveryService` 不再被 lib.rs 引用，但服务模块仍存在（bot 文件仍在用）；`open_ai_delivery_window` 命令不再注册。Task 2 依赖本任务：只有 lib.rs 不再引用 AI 交付后，才能删除服务模块与 bot 交叉点而不破坏编译。

- [ ] **Step 1: 清理 `lib.rs` 的 import 与窗口/事件分支**

打开 `terminal-buddy/src-tauri/src/lib.rs`，删除以下内容（当前行号，按内容定位）：

1. **`use commands::{...}` 块内**：第 38 行 `window_exit_app, window_minimize, window_toggle_maximize, open_ai_delivery_window, write_client_data,` → 改为 `window_exit_app, window_minimize, window_toggle_maximize, write_client_data,`（仅删 `open_ai_delivery_window,`）
2. **第 41-47 行整个 `use commands::{...}` 块**（`allocate_ai_task_worktree, create_ai_project, create_ai_task_contract, delete_ai_agent, delete_ai_project, delete_ai_role, delete_ai_runtime, delete_ai_workflow, detect_ai_runtimes, generate_ai_quality_gate_commands, get_ai_agents, get_ai_projects, get_ai_roles, get_ai_runtimes, get_ai_task_contracts, get_ai_workflows, refresh_ai_project_repositories, save_ai_agent, save_ai_role, save_ai_runtime, save_ai_workflow, update_ai_project`）
3. **第 48-65 行整个 `use commands::{...}` 块**（全部 `*_ai_*` 命令：answer_ai_decision_request … replan_ai_delivery_accepting_current_state）
4. **第 76-79 行**：注释 `// AiAgent 仅用于 debug 构建下的测试派发入口...` 与 `#[cfg(debug_assertions)] use models::ai_delivery::AiAgent;`
5. **第 81 行**：`use services::{AiDeliveryService, SettingsService, SshSessionService, WebServiceState};` → `use services::{SettingsService, SshSessionService, WebServiceState};`
6. **`on_page_load`（第 278-280 行）**：删除 `"ai-delivery" => { boot_log("ai-delivery page load finished (hidden, shown on demand)"); }` 分支，保留 `"main" =>` 与 `_ => {}`
7. **`setup` 中（第 287-288 行）**：删除注释 `// 注入全局 AppHandle：append_event 统一实时推送 ai-delivery-event` 与 `let _ = services::ai_delivery_service::APP_HANDLE.set(app.handle().clone());`
8. **`setup` 中（第 339-452 行）**：删除整块 AI 交付启动恢复逻辑，包括：
   - `match AiDeliveryService::recover_interrupted_attempts() {...}`（339-346）
   - `match AiDeliveryService::rebuild_active_attempt_index() {...}`（349-352）
   - `tauri::async_runtime::spawn_blocking` 的 `auto_init_runtimes` 块（357-365）
   - `let app_handle = app.handle().clone(); let terminal_service = ...`（368-369，仅被以下两个 AI 块使用）
   - `#[cfg(debug_assertions)]` 的 `TERMINAL_BUDDY_TEST_DISPATCH_TASK_ID` 派发块（370-415）
   - `tauri::async_runtime::spawn_blocking` 的「运行中交付补派 + 自动完成」块（416-452）
   - **保留**：第 454 行起的 `sync_launch_at_login`、Web API/机器人 HTTP 服务、bot 长连接、Claude hook 服务全部逻辑
9. **`on_window_event`（第 507-511 行）**：删除 `else if window.label() == "ai-delivery" { api.prevent_close(); let _ = window.hide(); }` 分支（保留 main 窗口 close-to-tray 分支）

- [ ] **Step 2: 清理 `lib.rs` 的 invoke_handler**

在 `invoke_handler(tauri::generate_handler![...])` 中删除以下条目（第 516-586 行整段 AI 命令注册，以及第 695 行）：

- 第 516-586 行：`get_ai_projects` 到 `cleanup_ai_delivery_integration` 之间的全部约 70 个 `*_ai_*` 命令（含 get_ai_projects / create_ai_project / refresh_ai_project_repositories / update_ai_project / generate_ai_quality_gate_commands / delete_ai_project / detect_ai_runtimes / get_ai_runtimes / save_ai_runtime / delete_ai_runtime / get_ai_agents / save_ai_agent / delete_ai_agent / get_ai_roles / save_ai_role / delete_ai_role / get_ai_workflows / save_ai_workflow / delete_ai_workflow / get_ai_task_contracts / create_ai_task_contract / allocate_ai_task_worktree / get_ai_deliveries / create_ai_delivery / update_ai_delivery / plan_ai_delivery_with_manager / replan_legacy_ai_delivery / replan_ai_delivery_accepting_current_state / delete_ai_delivery / get_ai_task_nodes / create_ai_task_node / update_ai_task_node / delete_ai_task_node / approve_ai_delivery / pause_ai_delivery / resume_ai_delivery / cancel_ai_delivery / refresh_ai_ready_task_nodes / get_ai_delivery_events / get_ai_decision_requests / create_ai_decision_request / answer_ai_decision_request / get_ai_attempts / read_ai_attempt_output / list_ai_delivery_artifacts / read_ai_delivery_artifact / export_ai_delivery_artifacts_zip / generate_ai_delivery_report / dispatch_ai_task_node / dispatch_ai_ready_tasks / retry_ai_task_node / start_ai_attempt / cancel_ai_attempt / cancel_ai_task_node / mark_ai_task_skipped / confirm_ai_policy_violation_site / complete_ai_attempt / get_ai_review_gates / run_ai_quality_gate / resolve_ai_review_gate / get_ai_review_diff / add_ai_review_line_comment / list_ai_startup_presets / create_ai_startup_preset / update_ai_startup_preset / delete_ai_startup_preset / test_ai_workflow_step / get_ai_merge_records / merge_ai_delivery_locally / continue_ai_merge_after_conflict / cleanup_ai_delivery_integration）
- 第 695 行：`open_ai_delivery_window,`
- **保留**：`get_all_profiles`（587 行起）及之后的所有非 AI 命令，包括全部 bot / claude_hook / ai_usage（fetch_qianfan_usage 等）命令

- [ ] **Step 3: 清理 `web/server.rs` 路由**

打开 `terminal-buddy/src-tauri/src/web/server.rs`，删除第 48-120 行——从注释 `// AI 交付：远程仅观察...`（第 48 行）开始、包含全部 19 条 `/api/ai-delivery/**` 路由（`.route("/api/ai-delivery/projects", ...)` 到 `.route("/api/ai-delivery/deliveries/{task_id}", delete(...))`），即 `handlers::ai_delivery_handler::` 的全部引用。
**保留**：第 38-45 行 bot 路由（`/api/bot/feishu/events`、`/api/bot/inbound/{channel_id}`）、第 47 行 profiles 路由、第 121 行起的 `extra-param-presets` 等其余全部路由。
（`build_router` 链式调用删除中间段后，前后 `.route(...)` 自然衔接，无需额外改动。）

- [ ] **Step 4: 清理 `commands/window.rs`**

打开 `terminal-buddy/src-tauri/src/commands/window.rs`，删除第 61-75 行整个函数 `open_ai_delivery_window`（含上方 doc 注释 `/// 创建或聚焦 AI 交付独立窗口...`）。
**保留**：`window_minimize`、`window_toggle_maximize`、`window_close`、`window_exit_app` 等其余函数。

- [ ] **Step 5: 编译与测试验证**

```bash
cd terminal-buddy/src-tauri && cargo check
```

Expected: 零错误、零警告。（此时 ai_delivery 模块文件仍存在，未被引用的 `pub mod` 不会产生警告；`AiDeliveryService` 仍被 bot 文件使用，正常编译。）

```bash
cargo test
```

Expected: 全部通过（含 ai_delivery_service 的测试——本任务未删该模块，测试仍会运行且必须通过）。

- [ ] **Step 6: 提交**

```bash
git add terminal-buddy/src-tauri/src/lib.rs terminal-buddy/src-tauri/src/web/server.rs terminal-buddy/src-tauri/src/commands/window.rs
git commit -m "[移除AI交付] 清理 lib.rs 引用中枢：AI 命令注册/setup 恢复逻辑/窗口分支/Web 路由"
```

---

### Task 2: 删除 AI 交付 Rust 模块并剥离 bot 交叉点

**Files:**
- Delete: `terminal-buddy/src-tauri/src/services/ai_delivery_service/`（整目录 9 文件：mod/delivery/dispatch/entity/helpers/manager/quality/terminal/tests）
- Delete: `terminal-buddy/src-tauri/src/commands/ai_delivery.rs`
- Delete: `terminal-buddy/src-tauri/src/models/ai_delivery.rs`
- Delete: `terminal-buddy/src-tauri/src/web/handlers/ai_delivery_handler.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/mod.rs`、`services/mod.rs`、`models/mod.rs`、`web/handlers/mod.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/notification.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/bot.rs`
- Modify: `terminal-buddy/src-tauri/src/web/handlers/bot_handler.rs`
- Modify: `terminal-buddy/src-tauri/src/services/bot_long_connection_service.rs`
- Modify: `terminal-buddy/src-tauri/src/models/bot.rs`
- Modify: `terminal-buddy/src-tauri/src/services/bot_settings_service.rs`

**Interfaces:**
- Consumes: Task 1 已使 lib.rs 不再引用 AI 交付（否则本任务删除模块后 lib.rs 编译失败）
- Produces: `AiDeliveryService` 类型与 `Ai*` 模型类型全部消失；bot 文件不再依赖 AI 交付；`show_ai_delivery_notification`、`send_feishu_text` 被删除。
- **顺序耦合修正**：`models/ai_delivery.rs` 定义了 `AiAgent` / `AiAgentRuntime`，`database_service.rs` 直接 import 并在 `deduplicate_ai_runtimes` 等函数中使用。本任务删除 `models/ai_delivery.rs` 后 `database_service.rs` 无法编译，因此 **Task 3 的 database_service 编辑（Step 1-4）与 terminal.rs 注释（Step 5）改由本任务作为第二个 commit 执行**（内容与 Task 3 完全相同，提交信息 `[移除AI交付] database_service 删除 ai_entities 建表/迁移/去重/CRUD`）。Task 3 随之并入本任务，不再单独派遣。

- [ ] **Step 1: 删除 4 个 AI 交付模块文件**

```bash
git rm -r terminal-buddy/src-tauri/src/services/ai_delivery_service
git rm terminal-buddy/src-tauri/src/commands/ai_delivery.rs
git rm terminal-buddy/src-tauri/src/models/ai_delivery.rs
git rm terminal-buddy/src-tauri/src/web/handlers/ai_delivery_handler.rs
```

- [ ] **Step 2: 删除 mod.rs 声明**

- `commands/mod.rs`：删第 1 行 `pub mod ai_delivery;` 与第 20 行 `pub use ai_delivery::*;`
- `services/mod.rs`：删第 1 行 `pub mod ai_delivery_service;` 与第 21 行 `pub use ai_delivery_service::*;`
- `models/mod.rs`：删第 1 行 `pub mod ai_delivery;` 与第 10 行 `pub use ai_delivery::*;`
- `web/handlers/mod.rs`：删第 1 行 `pub mod ai_delivery_handler;`

- [ ] **Step 3: 删除 `notification.rs` 中的 AI 交付通知函数**

`terminal-buddy/src-tauri/src/commands/notification.rs` 第 91-117 行：删除 `pub fn show_ai_delivery_notification(...)` 整个函数（含 doc 注释与函数体，`.add_button("打开交付", "open-ai-delivery")` 所在函数）。
**保留**：`show_claude_code_notification` 及文件底部 `#[cfg(test)]` 测试模块（测试只覆盖 `notification_content`，不受影响）。

- [ ] **Step 4: 删除 `bot.rs` 中仅被 AI 交付使用的死代码**

`terminal-buddy/src-tauri/src/commands/bot.rs` 第 368-379 行：删除 doc 注释 `/// 向飞书通道发送纯文本消息，返回外部 message_id（供 AI 交付引用回复映射）。` 与 `pub(crate) async fn send_feishu_text(...)` 整个函数（唯一调用方是已删除的 `ai_delivery_service/dispatch.rs`；不删会产生 `function is never used` 警告）。
**保留**：`send_feishu_reply`（仍被 bot_handler 使用）及文件其余内容。

- [ ] **Step 5: 剥离 `bot_handler.rs` 的 AI 交付分支**

`terminal-buddy/src-tauri/src/web/handlers/bot_handler.rs`：
1. 第 13 行：`use crate::services::{AiDeliveryService, BotSettingsService};` → `use crate::services::BotSettingsService;`
2. 第 268-283 行：删除整块——注释 `// AI 交付决策：引用回复命中 AI 交付推送映射时优先回答（与 claude_hook 卡片决策绑定共存）`、`if let Some(reply_to) = inbound.reply_to_message_id.as_deref() { ... }` 块（含 `AiDeliveryService::resolve_delivery_decision_binding` / `answer_decision_request` 调用与 `send_feishu_reply` 回执）。
   删除后第 284 行 `let terminal_service = state.app_handle.state::<TerminalService>();` 直接衔接 `process_bot_reply` 调用，结构不变。

- [ ] **Step 6: 剥离 `bot_long_connection_service.rs` 的 AI 交付分支**

`terminal-buddy/src-tauri/src/services/bot_long_connection_service.rs`：
1. 第 9 行：`AiDeliveryService, BotSettingsService,` → 仅保留 `BotSettingsService,`
2. 第 323-342 行：删除整块——注释 `// AI 交付决策：引用回复命中 AI 交付推送映射时优先回答（与 claude_hook 卡片决策绑定共存）` 与 `if let Some(reply_to) = inbound.reply_to_message_id.as_deref() { ... }` 块。删除后第 343 行 `let terminal_service = app.state::<TerminalService>();` 直接衔接 `process_bot_reply` 调用。

- [ ] **Step 7: 删除 `models/bot.rs` 的 `ai_delivery_enabled` 字段**

`terminal-buddy/src-tauri/src/models/bot.rs` 第 39-43 行，在 `BotChannelConfig` 结构体中删除：
```rust
    /// 该通道是否同时用于 AI 交付事件推送（微信/飞书）。
    #[serde(default)]
    pub ai_delivery_enabled: bool,
```
（保留 `has_callback_token` 字段与其上方所有字段。）

- [ ] **Step 8: 删除 `bot_settings_service.rs` 的字段读写**

`terminal-buddy/src-tauri/src/services/bot_settings_service.rs` 删除 4 处 `ai_delivery_enabled`（当前行号）：
- 第 26 行：`ai_delivery_enabled: bool,`（BotChannelRuntime 结构体字段）
- 第 102 行：`ai_delivery_enabled: channel.ai_delivery_enabled,`
- 第 134 行：`ai_delivery_enabled: channel.ai_delivery_enabled,`
- 第 195 行：`ai_delivery_enabled: channel.ai_delivery_enabled,`

- [ ] **Step 9: 编译与测试验证**

```bash
cd terminal-buddy/src-tauri && cargo check
```

Expected: 零错误、零警告（若有 unused import / unused function 警告出现，按警告位置清理）。

```bash
cargo test
```

Expected: 全部通过；重点确认 `bot_binding_service` 的测试（`direct_reply_selects_latest_pending_binding` 等）仍通过——这是「bot 保留」的验证。

- [ ] **Step 10: 提交**

```bash
git add -A terminal-buddy/src-tauri/src
git commit -m "[移除AI交付] 删除服务/命令/模型/Web handler 模块，剥离 bot 交叉点与死代码"
```

---

### Task 3: database_service 清理（ai_entities 表与全部方法）

> **已并入 Task 2 执行**（编译耦合：`models/ai_delivery.rs` 的 `AiAgent`/`AiAgentRuntime` 被 `database_service.rs` 直接 import，删除模型文件必然破坏其编译，故 Task 2 作为第二个 commit 执行本任务全部步骤）。本节内容由 Task 2 实现者按原文执行，不再单独派遣；Task 2 的审查范围覆盖本节。

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/database_service.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/terminal.rs`（仅注释）

**Interfaces:**
- Consumes: Task 2 后无任何代码再调用 ai_entities 相关方法
- Produces: `DatabaseService` 仅剩 bot 决策绑定、微信状态、命令历史相关方法。后续任务不依赖本任务。

- [ ] **Step 1: 删除 `database_service.rs` 的常量与 import**

打开 `terminal-buddy/src-tauri/src/services/database_service.rs`：
1. 第 1 行：`use crate::models::{AiAgent, AiAgentRuntime, DecisionBinding};` → `use crate::models::DecisionBinding;`
2. 删除第 4 行 `use serde::de::DeserializeOwned;`、第 5 行 `use serde::Serialize;`、第 7 行 `use std::collections::HashMap;`（这三个 import 仅被 AI 交付相关代码使用）。**保留第 8 行 `use serde_json::Value;`**——`legacy-command-history-v1`（~L174）与 `legacy-weixin-runtime-v1`（~L229）迁移仍使用 `serde_json::from_str::<Value>`。`params` / `Transaction` / `fs` / `Duration` / `OptionalExtension` 均保留（其余方法仍用）。删除后若 `cargo check` 报其余 unused import，一并删除
3. 第 11-25 行：删除整个 `AI_ENTITY_DIRECTORIES` 常量（Projects / Runtimes / Agents / Roles / Workflows / TaskContracts / Deliveries / TaskNodes / DecisionRequests / Events / Attempts / ReviewGates / MergeRecords）
4. 第 27-38 行：删除整个 `runtime_deduplication_key` 函数

- [ ] **Step 2: 删除 `ai_entities` 建表 SQL**

`open()` 的 `execute_batch` 字符串中删除第 58-63 行：
```sql
CREATE TABLE IF NOT EXISTS ai_entities (
   kind TEXT NOT NULL,
   id TEXT NOT NULL,
   content TEXT NOT NULL,
   PRIMARY KEY (kind, id)
);
```
**保留**：`schema_migrations`、`app_documents`、`bot_decision_bindings`（含两个索引）、`weixin_runtime_states` 建表。

- [ ] **Step 3: 删除两条 AI 交付迁移**

`run_migrations()` 中删除：
1. 第 114-150 行 `legacy-ai-entities-v1` 迁移块（含 `PathService::get_data_dir().join("AiDelivery")` 目录扫描与 `AI_ENTITY_DIRECTORIES` 遍历）
2. 第 152-161 行 `ai-runtime-deduplication-v1` 迁移块（含 `Self::deduplicate_ai_runtimes(&transaction)?;` 调用）

**保留**：`legacy-command-history-v1`（163-187）、`legacy-bot-bindings-v1`（189-203）、`legacy-weixin-runtime-v1`（205-244）三个迁移。

- [ ] **Step 4: 删除 `deduplicate_ai_runtimes` 与 ai_entity CRUD 方法**

1. 第 248-345 行：删除整个 `fn deduplicate_ai_runtimes(transaction: &Transaction<'_>) -> Result<(), String> {...}`
2. 第 347-432 行：删除 5 个方法——`list_ai_entities`、`get_ai_entity`、`save_ai_entity`、`delete_ai_entity`、`delete_ai_entities`

**保留**：`read_command_history` / `save_command_history` / `read_document` / `save_document`（434-464）、`replace_bindings`（466-504）、`list_decision_bindings`（506-520）、`save_decision_bindings`（522-531）、`read_weixin_state` / `save_weixin_state`（533-555）。

- [ ] **Step 5: 清理 `terminal.rs` 中的 AI 交付注释**

`terminal-buddy/src-tauri/src/commands/terminal.rs` 第 872-873 行，将注释
```rust
// 统一消费：drain 清空缓冲并返回全部内容。AI 交付终端的 monitor 线程靠此取增量
// 落盘 live-output.log——消费后下一轮只拿到新输出，避免全量重复累积。
```
改为（仅文字，不改任何行为）：
```rust
// 统一消费：drain 清空缓冲并返回全部内容；消费后下一轮只拿到新输出，避免重复累积。
```

- [ ] **Step 6: 编译与测试验证**

```bash
cd terminal-buddy/src-tauri && cargo check
```
Expected: 零错误、零警告（重点检查 serde/DeserializeOwned/Serialize/HashMap/Value import 是否还有使用者，按警告清理）。

```bash
cargo test
```
Expected: 全部通过（bot 测试仍通过）。

- [ ] **Step 7: 提交**

```bash
git add terminal-buddy/src-tauri/src/services/database_service.rs terminal-buddy/src-tauri/src/commands/terminal.rs
git commit -m "[移除AI交付] database_service 删除 ai_entities 建表/迁移/去重/CRUD"
```

---

### Task 4: 删除配置、脚本、演示页与相关文档

**Files:**
- Modify: `terminal-buddy/src-tauri/tauri.conf.json`
- Modify: `terminal-buddy/src-tauri/capabilities/default.json`
- Delete: `terminal-buddy/scripts/verify-ai-delivery-drive.ps1`、`terminal-buddy/scripts/verify-ai-delivery-plan.ps1`、`terminal-buddy/scripts/verify-ai-delivery-launch.ps1`
- Delete: `ai-delivery-orchestrator-demo.html`（仓库根）
- Delete: `RELEASE_NOTES_v1.4.0.md`（仓库根，整篇为 AI 交付发布说明）
- Delete: `docs/ai-delivery-implementation-plan.md`
- Delete: `terminal-buddy/docs/fix-plans/2026-08-03-ai-delivery-ui-dispatch-fixes.md`
- Delete: `docs/superpowers/plans/2026-08-02-ai-delivery-iteration-1.md`、`-iteration-2.md`、`-iteration-3.md`、`-iteration-4.md`
- Delete: `docs/superpowers/plans/2026-08-03-ai-delivery-service-split.md`
- Delete: `docs/superpowers/plans/2026-08-04-dag-tab-and-cross-repo-dependency.md`
- Delete: `docs/superpowers/specs/2026-08-03-ai-delivery-service-split-design.md`
- Delete: `docs/superpowers/specs/2026-08-04-dag-tab-and-cross-repo-dependency-design.md`
- Delete: `docs/superpowers/specs/2026-07-25-terminalbuddy-ai-delivery-orchestrator-design.md`

**Interfaces:**
- Consumes: 无
- Produces: 独立窗口配置消失（运行时不再创建 `ai-delivery` 窗口）。Task 5 删除前端对该窗口的挂载分支后，前后端保持一致。注意：本任务与 Task 5 之间若运行应用，前端 `main.tsx` 的 label 分支与 `openAiDeliveryWindow` 调用仅产生运行时提示，不影响编译。

- [ ] **Step 1: 删除 `tauri.conf.json` 的 ai-delivery 窗口配置**

`terminal-buddy/src-tauri/tauri.conf.json` `app.windows` 数组中删除第 27-39 行整个对象：
```json
{
  "label": "ai-delivery",
  "title": "AI 交付",
  "width": 1200,
  "height": 800,
  "minWidth": 900,
  "minHeight": 520,
  "center": true,
  "resizable": true,
  "visible": false,
  "backgroundColor": "#1e1e1e",
  "decorations": false
}
```
**保留**：`main` 窗口对象。注意删除 `{` 前对象之间的逗号（windows 数组只剩 main 一个元素，去掉 main 对象后面的逗号）。

- [ ] **Step 2: 删除 `capabilities/default.json` 的窗口授权**

`terminal-buddy/src-tauri/capabilities/default.json` 第 5 行：`"windows": ["main", "ai-delivery"],` → `"windows": ["main"],`

- [ ] **Step 3: 删除脚本、演示页、发布说明与文档文件**

```bash
git rm terminal-buddy/scripts/verify-ai-delivery-drive.ps1 terminal-buddy/scripts/verify-ai-delivery-plan.ps1 terminal-buddy/scripts/verify-ai-delivery-launch.ps1
git rm ai-delivery-orchestrator-demo.html
git rm RELEASE_NOTES_v1.4.0.md
git rm docs/ai-delivery-implementation-plan.md
git rm terminal-buddy/docs/fix-plans/2026-08-03-ai-delivery-ui-dispatch-fixes.md
git rm docs/superpowers/plans/2026-08-02-ai-delivery-iteration-1.md docs/superpowers/plans/2026-08-02-ai-delivery-iteration-2.md docs/superpowers/plans/2026-08-02-ai-delivery-iteration-3.md docs/superpowers/plans/2026-08-02-ai-delivery-iteration-4.md
git rm docs/superpowers/plans/2026-08-03-ai-delivery-service-split.md
git rm docs/superpowers/plans/2026-08-04-dag-tab-and-cross-repo-dependency.md
git rm docs/superpowers/specs/2026-08-03-ai-delivery-service-split-design.md
git rm docs/superpowers/specs/2026-08-04-dag-tab-and-cross-repo-dependency-design.md
git rm docs/superpowers/specs/2026-07-25-terminalbuddy-ai-delivery-orchestrator-design.md
```
如果 `terminal-buddy/docs/fix-plans/` 目录已空，用 `rmdir terminal-buddy/docs/fix-plans` 删除空目录（git 不跟踪空目录，无需 git 命令）。
**保留**：本设计规格 `docs/superpowers/specs/2026-08-05-remove-ai-delivery-design.md` 与其他所有规格/计划（如 2026-07-21-terminalbuddy-agent-orchestrator-design.md 是 Agent 编排设计，不涉及 AI 交付，务必保留）。

- [ ] **Step 4: 验证配置与残留**

```bash
cd terminal-buddy/src-tauri && cargo check
```
Expected: 零错误（`tauri::generate_context!` 编译期读取 tauri.conf.json，JSON 若损坏会在此报错；窗口减少不影响编译）。

```bash
python -c "import json; json.load(open('src-tauri/capabilities/default.json', encoding='utf-8')); json.load(open('src-tauri/tauri.conf.json', encoding='utf-8'))"
```
Expected: 无输出（两个 JSON 均合法）。若无 python，用 `node -e "JSON.parse(require('fs').readFileSync(...))"` 代替。

```bash
git ls-files | grep -iE "ai-delivery|ai_delivery"
```
Expected: 仅剩 `.superpowers/sdd/**` 会话数据与 `src-tauri/gen/**` 生成文件（若有其他追踪文件含该命名，逐个确认是否为误留）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "[移除AI交付] 删除独立窗口配置/授权、验证脚本、演示页与相关文档"
```

---

### Task 5: 桌面前端清理（挂载分支、通知监听、悬浮按钮、终端过滤）

**Files:**
- Modify: `terminal-buddy/src/main.tsx`
- Modify: `terminal-buddy/src/App.tsx`
- Modify: `terminal-buddy/src/components/terminal/TerminalTabBar.tsx`

**Interfaces:**
- Consumes: Task 4 已删除 ai-delivery 窗口配置
- Produces: 桌面前端不再引用 `AiDeliveryApp` / `AiDeliveryFloatingButton` / `openAiDeliveryWindow` / `ai-delivery-notification-activated` / `open-ai-attempt-terminal` / `'AI 交付'` 过滤。注意：`src/services/tauri.ts` 中的 `openAiDeliveryWindow` 等函数仍在（Task 6 删除），本任务删除它们的调用方即可，`npx tsc` 对未被引用的导出不报错。

- [ ] **Step 1: 清理 `main.tsx`**

打开 `terminal-buddy/src/main.tsx`：
1. 删除第 3 行 `import { getCurrentWindow } from '@tauri-apps/api/window';`
2. 删除第 5 行 `import { AiDeliveryApp } from "./components/ai-delivery/AiDeliveryApp";`
3. 删除第 11-13 行注释与分支，改为直接渲染主应用：
```tsx
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```
（即删掉 `// 根据当前窗口 label 决定渲染主应用还是 AI 交付独立窗口`、`const currentLabel = getCurrentWindow().label;`、`const RootComponent = ...;` 三行，并把 `<RootComponent />` 改为 `<App />`。React / ReactDOM import 保留。）

- [ ] **Step 2: 清理 `App.tsx` — import 与监听器**

打开 `terminal-buddy/src/App.tsx`：
1. 删除第 10 行 `import { AiDeliveryFloatingButton } from "./components/ai-delivery/AiDeliveryFloatingButton";`
2. 第 19 行 tauri import 列表中删除 `openAiDeliveryWindow,`（保留其余全部函数与 `type UpdateInfo`）
3. 删除第 302-319 行整个 useEffect（监听 `open-ai-attempt-terminal` 窗口事件，用于 AI 交付弹窗聚焦终端）。**保留**：第 296-300 行 `tab-navigation-changed` 监听与第 302 行下方 `app-settings-changed` 监听（紧邻，注意区分）
4. 删除第 321-331 行整个 useEffect（注释 `// 收到 AI 交付通知时，存储目标 ID 并打开独立窗口` 的 `ai-delivery-notification-activated` 监听）

- [ ] **Step 3: 清理 `App.tsx` — terminal-created 过滤与悬浮按钮**

1. 第 336 行解构中删除 `extraParamTag, extraParamTagColor,`（`const { id, profileId, profileName, terminalType, owner, groupId, groupName, extraParamTag, extraParamTagColor } = event.payload;` → 去掉这两个变量）。注意 `noUnusedLocals: true`，删除过滤后必须同时从解构中移除这两个变量，否则 tsc 报错。第 335 行类型注解里的 `extraParamTag?: string; extraParamTagColor?: string` 可保留（类型成员不触发未使用检查）
2. 删除第 337-339 行注释与过滤行：
```tsx
      // AI 交付派发的终端不进入主窗口终端选项卡：其输出面向 Agent/平台，
      // 对普通用户无意义，需查看时在 AI 交付页的实时终端/运行记录中查看。
      if (extraParamTag === 'AI 交付') return;
```
3. 删除第 752-754 行：
```tsx
  const handleToggleAiDelivery = useCallback(() => {
    void openAiDeliveryWindow();
  }, []);
```
4. 删除第 808-811 行 JSX：
```tsx
      <AiDeliveryFloatingButton
        active={false}
        onToggle={handleToggleAiDelivery}
      />
```
（若删除后 `useCallback` import 不再被使用，检查 App.tsx 其他位置——`useCallback` 在别处大概率仍在使用，保持 import 不动，由 tsc 验证。）

- [ ] **Step 4: 清理 `TerminalTabBar.tsx`**

`terminal-buddy/src/components/terminal/TerminalTabBar.tsx` 第 30-32 行，删除注释与过滤，替换为：
```tsx
  const visibleSessions = sessions;
```
（文件其余代码全部引用 `visibleSessions`，保持变量名不变，仅去掉过滤逻辑与注释。）

- [ ] **Step 5: 类型检查验证**

```bash
cd terminal-buddy && npx tsc --noEmit
```
Expected: 零错误。（若出现其他与本次改动无关的既有错误，记录并先处理与本任务相关的；若报 `openAiDeliveryWindow is declared but its value is never read` 之类——exported 函数不会触发该错误，不应出现。）

- [ ] **Step 6: 提交**

```bash
git add terminal-buddy/src/main.tsx terminal-buddy/src/App.tsx terminal-buddy/src/components/terminal/TerminalTabBar.tsx
git commit -m "[移除AI交付] 桌面前端移除窗口挂载分支/通知监听/悬浮按钮/终端过滤"
```

---

### Task 6: tauri.ts 与设置清理、bot 推送开关 UI 剥离

**Files:**
- Modify: `terminal-buddy/src/services/tauri.ts`
- Modify: `terminal-buddy/src/utils/settings.ts`
- Delete: `terminal-buddy/src/types/aiDelivery.ts`
- Delete: `terminal-buddy/src/components/ai-delivery/`（整目录 26 个已跟踪文件）
- Modify: `terminal-buddy/src/components/settings/BotChannelDialog.tsx`
- Modify: `terminal-buddy/src/components/settings/BotNotificationSettings.tsx`

**Interfaces:**
- Consumes: Task 5 后 `tauri.ts` 的 AI 交付函数无调用方；`settings.ts` 的 AI 交付字段无读取方
- Produces: `tauri.ts` 仅剩共享接口；`BotChannelConfig` 去掉 `aiDeliveryEnabled`；`src/types/aiDelivery.ts` 消失；`components/ai-delivery/` 目录消失。Task 7 不依赖本任务（web 是独立项目）。
- **缺陷修正**：`components/ai-delivery/` 目录删除原未分配给任何任务（Task 5 只删引用点、本任务 Interfaces 曾误称已删）；该目录组件 import 本任务删除的导出，不删则 `npx tsc --noEmit` 必失败。已并入本任务执行（实现中裁定，2026-08-05）。

- [ ] **Step 1: 删除 `tauri.ts` 的类型 import 与 bot 字段**

打开 `terminal-buddy/src/services/tauri.ts`：
1. 删除第 4-5 行两行 import：
```ts
import type { AiAgent, AiAgentRuntime, AiAttempt, AiDecisionRequest, AiDelivery, AiDeliveryEvent, AiMergeRecord, AiProject, AiQualityGate, AiReviewDiffResult, AiReviewGate, AiRole, AiRuntimeProbe, AiStartupPreset, AiTaskContract, AiTaskNode, AiWorkflow, CreateAiDecisionRequestInput, CreateAiDeliveryInput, CreateAiProjectInput, CreateAiTaskNodeInput, CreateTaskContractInput, UpdateAiDeliveryInput, UpdateAiTaskNodeInput } from '../types/aiDelivery';
import type { AiArtifactMeta, AiAttemptOutput } from '../types/aiDelivery';
```
2. 第 107 行 `BotChannelConfig` 接口中删除 `aiDeliveryEnabled: boolean;`（保留 `hasSecret` / `hasCallbackToken`）

- [ ] **Step 2: 删除 `tauri.ts` 的 AI 交付 invoke 封装（大块）**

删除从 `export const getAiProjects = () => invoke<AiProject[]>('get_ai_projects');`（第 594 行）到 `answerAiDecisionRequest` 函数结尾（约第 726 行）的**整块连续函数**（含全部 `getAi*` / `createAi*` / `updateAi*` / `deleteAi*` / `saveAi*` / `approveAiDelivery` / `pauseAiDelivery` / `resumeAiDelivery` / `cancelAiDelivery` / `dispatchAiTaskNode` / `dispatchAiReadyTasks` / `retryAiTaskNode` / `startAiAttempt` / `cancelAiAttempt` / `cancelAiTaskNode` / `markAiTaskSkipped` / `confirmPolicyViolationSite` / `completeAiAttempt` / `runAiQualityGate` / `resolveAiReviewGate` / `listAiStartupPresets` / `createAiStartupPreset` / `updateAiStartupPreset` / `deleteAiStartupPreset` / `testWorkflowStep` / `replanDeliveryAcceptingCurrentState` / `mergeAiDeliveryLocally` / `continueMergeAfterConflict` / `cleanupAiDeliveryIntegration` / `onAiDeliveryEvent` / `getAiDecisionRequests` / `createAiDecisionRequest` / `answerAiDecisionRequest`）。

定位方法：块前是 `gitGetHistoryFileDiff`（约 574-593 行），块后是下一个非 AI 函数（约 727 行起）。删除前用 `grep -n "export const Ai\|export const getAi\|export const createAi\|export const deleteAi\|export const updateAi\|export const saveAi\|export const approveAi\|export const pauseAi\|export const resumeAi\|export const cancelAi\|export const dispatchAi\|export const retryAi\|export const startAi\|export const completeAi\|export const runAi\|export const resolveAi\|export const listAi\|export const testWorkflowStep\|export const replanDelivery\|export const mergeAi\|export const continueMerge\|export const cleanupAi\|export const onAiDeliveryEvent\|export const answerAi" terminal-buddy/src/services/tauri.ts` 确认整块边界，块内应全部是 `invoke<...>('..._ai_...'...)` 调用。

- [ ] **Step 3: 删除 `tauri.ts` 的 `openAiDeliveryWindow`**

第 883-886 行：删除 doc 注释 `/** 打开或聚焦 AI 交付独立窗口。窗口关闭后后台任务继续运行。 */` 与：
```ts
export async function openAiDeliveryWindow(): Promise<void> {
  return invoke('open_ai_delivery_window');
}
```
（上方 `windowExitApp` 与下方 `exportAllData` 之间的注释块 `// Full Data Import/Export` 保留。）

- [ ] **Step 4: 删除 `settings.ts` 的 AI 交付设置项**

打开 `terminal-buddy/src/utils/settings.ts`：
1. 删除第 10 行附近 `export interface AiDeliveryFloatingButtonPosition {...}` 整个接口
2. 第 57-58 行：
```ts
  aiDeliveryFloatingButtonPosition: AiDeliveryFloatingButtonPosition | null;
  aiDeliveryStateFilters: string[] | null;
```
3. 第 103-104 行：
```ts
  aiDeliveryFloatingButtonPosition: null,
  aiDeliveryStateFilters: null,
```

- [ ] **Step 5: 删除 `types/aiDelivery.ts`**

```bash
git rm terminal-buddy/src/types/aiDelivery.ts
```
（Task 5 已删除其唯一组件消费者 `components/ai-delivery/`，本步骤删除了 `tauri.ts` 的 import，此时无任何引用。）

- [ ] **Step 6: 剥离 bot 设置 UI 的 AI 交付推送开关**

1. `terminal-buddy/src/components/settings/BotChannelDialog.tsx` 第 43 行：`createDefaultChannel` 中删除 `aiDeliveryEnabled: false,`（保留 `hasCallbackToken: false,`）
2. `terminal-buddy/src/components/settings/BotNotificationSettings.tsx`：
   - 第 38 行 `normalizeSettings` 中删除 `aiDeliveryEnabled: !!channel.aiDeliveryEnabled,`
   - 第 357-365 行删除整个条件渲染块：
```tsx
                {(channel.platform === 'weixin' || channel.platform === 'feishu') && (
                  <label className="bot-channel-toggle" title="AI 交付事件推送（决策请求/任务失败/合并完成/交付成功）">
                    <input
                      type="checkbox"
                      checked={!!channel.aiDeliveryEnabled}
                      onChange={event => updateChannel(channel.id, 'aiDeliveryEnabled', event.target.checked)}
                    />
                  </label>
                )}
```
   - **保留**：第 354-356 行 `channel.enabled` 启用开关与其余全部 bot 配置 UI

- [ ] **Step 7: 类型检查验证**

```bash
cd terminal-buddy && npx tsc --noEmit
```
Expected: 零错误。若 `updateChannel` 的字段类型联合（`keyof BotChannelConfig` 之类）报错或出现未使用变量警告，检查是否为第 6 步删除 UI 后的残留引用并清理。

- [ ] **Step 8: 提交**

```bash
git add terminal-buddy/src/services/tauri.ts terminal-buddy/src/utils/settings.ts terminal-buddy/src/types/aiDelivery.ts terminal-buddy/src/components/settings/BotChannelDialog.tsx terminal-buddy/src/components/settings/BotNotificationSettings.tsx
git commit -m "[移除AI交付] 前端删除 ai invoke 封装与设置项，剥离 bot 推送开关 UI"
```

---

### Task 7: Web SPA 清理

**Files:**
- Delete: `terminal-buddy/web/src/screens/AiDelivery.tsx`
- Modify: `terminal-buddy/web/src/api.ts`
- Modify: `terminal-buddy/web/src/App.tsx`
- Modify: `terminal-buddy/web/src/screens/Nav.tsx`

**Interfaces:**
- Consumes: 无（web 是独立 SPA，后端路由已由 Task 1 删除）
- Produces: web 端不再有任何 `AiDelivery` 引用，`npm run build`（`tsc && vite build`）通过。

- [ ] **Step 1: 删除 `api.ts` 的 AI 交付接口与封装**

打开 `terminal-buddy/web/src/api.ts`：
1. 删除第 4-9 行全部 6 个 AI 交付接口：`AiDeliveryProject`、`AiDeliveryItem`、`AiDeliveryCreateInput`、`AiDeliveryTask`、`AiDecision`、`AiDeliverySnapshot`（接口名含 `AiDelivery` 或 `AiDecision` 的都在第 4-9 行连续定义；`AiDeliverySnapshot` 引用了 `AiDecision` 类型，必须同删）。删除前用 `grep -n "^export interface Ai\|^export interface AiDecision" terminal-buddy/web/src/api.ts` 确认边界，块内应正好是这 6 个接口且无其他接口混入。
2. 删除第 94-114 行 `api` 对象中的全部 AI 交付方法：`getAiDeliveryProjects`、`getAiDeliveries`、`getAiDeliverySnapshot`、`approveAiDelivery`、`answerAiDecision`、`createAiDelivery`、`planAiDelivery`、`dispatchAiDelivery`、`completeAiDeliveryAttempt`、`mergeAiDelivery`、`continueAiDeliveryMerge`、`cleanupAiDeliveryIntegration`、`retryAiDeliveryTask`（含 `req<...>('/ai-delivery/...')` 调用，逐行删除，注意方法间的逗号衔接）

- [ ] **Step 2: 清理 `App.tsx` 路由**

`terminal-buddy/web/src/App.tsx`：
1. 删除第 8 行 `import AiDelivery from './screens/AiDelivery';`
2. 删除第 51 行 `if (window.location.pathname === '/ai-delivery') return <AiDelivery />;`
（第 50 行 `if (!token) return <Login />;` 保留。）

- [ ] **Step 3: 清理 `Nav.tsx` 导航链接**

`terminal-buddy/web/src/screens/Nav.tsx` 第 458 行：删除
```tsx
        <a className="nav-ai-link" href="/ai-delivery">AI 交付</a>
```

- [ ] **Step 4: 删除 `screens/AiDelivery.tsx`**

```bash
git rm terminal-buddy/web/src/screens/AiDelivery.tsx
```

- [ ] **Step 5: 构建验证**

```bash
cd terminal-buddy/web && npm run build
```
Expected: `tsc` 与 `vite build` 均成功（`tsc` 零错误）。

- [ ] **Step 6: 提交**

```bash
git add terminal-buddy/web
git commit -m "[移除AI交付] Web SPA 删除 AiDelivery 页面/接口封装/路由/导航"
```

---

### Task 8: 文档修改（README / version.json / CLAUDE.md）

**Files:**
- Modify: `README.md`（仓库根）
- Modify: `README_zh.md`（仓库根）
- Modify: `version.json`（仓库根）
- Modify: `CLAUDE.md`（仓库根）
- Verify only: `docs/bot-notification-setup.md`、`docs/机器人通知接入指南.md`

**Interfaces:**
- Consumes: 无
- Produces: 所有面向用户的文档不再提及 AI 交付；机器人通知描述完整保留。

- [ ] **Step 1: 清理 `README.md`**

打开仓库根 `README.md`，删除以下 AI 交付内容（按内容定位，不依赖行号）：
1. 功能列表段落：`### 🚀 AI 交付编排（v1.4.0 重磅新功能）` 小节整段（约第 45-54 行，含 `- **独立 AI 交付窗口**：...` 到 `- **跨端协作**：...`）。**保留**：紧邻的 `### 🔔 机器人通知` 小节（第 59 行起）及其后全部内容
2. 目录结构树中 4 行（约第 228 / 244 / 246 / 252 行）：
   - `│       │   ├── ai_delivery.rs  # AI delivery orchestration (DAG, dispatch, merge, stats)`
   - `│       │   ├── ai_delivery_service/  # AI delivery orchestration (mod / entity / dispatch / delivery / quality / manager / terminal / helpers / tests)`
   - `│       ├── models/  # Data structures (Profile, AppSettings, ai_delivery, etc.)` → 改为 `│       ├── models/  # Data structures (Profile, AppSettings, etc.)`
   - `│       │   └── handlers/  # REST handlers (auth, profiles, terminals, ai_delivery)` → 改为 `│       │   └── handlers/  # REST handlers (auth, profiles, terminals)`
3. 数据目录树中 2 行（约第 288-289 行）：
   - `└── ai_delivery/               # AI delivery orchestration (v1.4.0+)`
   - `    ├── ai_delivery.db         # SQLite database (deliveries / tasks / attempts / events)`
   （若这两行是某目录树块的最后子项，注意删除后父目录树的收尾符号衔接）
4. changelog 区（约第 336-337、349-350、359 行）：
   - `**🎯 AI 交付编排子系统（重磅新功能）**` 标题行与其下 `- 独立 `ai-delivery` 窗口，关闭后调度、监控、合并任务在后台继续运行` 等 AI 交付条目（该大节中的 AI 条目逐条删除，保留非 AI 条目如 `- `open_in_explorer` 路径不存在时逐级向上查找已存在目录...`、`- `components` 重组为按域子目录结构`）
   - `- AI 交付窗口独立为配置窗口方案（解决创建死锁导致主线程阻塞、终端/设置功能卡住）`
   - `- 修复 AI 交付工作区缺失 CSS 导入及 `DeliveryDetail` 的 `deliveries` prop 映射错误`
   - `- `ai_delivery_service` 拆分为子模块（delivery / quality / manager / terminal / entity / dispatch / helpers / tests）`

- [ ] **Step 2: 清理 `README_zh.md`**

打开仓库根 `README_zh.md`，执行与 Step 1 对应的中文版清理：
1. 功能列表（约第 31 行被省略的长行）中 AI 交付相关条目逐条删除
2. 目录结构树（约第 142 / 158 / 160 / 166 行）：删除 `ai_delivery.rs` 与 `ai_delivery_service/` 两行；`models/` 与 `handlers/` 两行注释中的 `ai_delivery` 字样删除
3. 数据目录树（约第 188-189 行）：删除 `└── ai_delivery/` 与 `├── ai_delivery.db` 两行
4. changelog 区中全部 AI 交付条目（如「AI 交付窗口独立为配置窗口方案」「修复 AI 交付工作区缺失 CSS 导入」「`ai_delivery_service` 拆分为子模块」等）

- [ ] **Step 3: 重写 `version.json` 的 changelogMd**

打开仓库根 `version.json`，当前 `changelogMd` 整篇是 1.4.0 AI 交付发布说明。替换 `changelogMd` 字段为不含 AI 交付的内容，保留非 AI 部分，例如：

```json
"changelogMd": "## 1.4.0\n\n### 🛠️ 组件与 UI\n\n- `open_in_explorer` 路径不存在时逐级向上查找已存在目录，避免打开到文档目录\n- `components` 重组为按域子目录结构\n- 终端内决策交互（在 xterm 中确认/拒绝文件操作）、桌面 Toast 通知、任务状态实时追踪\n\n### 🔧 清理与维护\n\n- 错误分类本地化（前端可读错误码）\n- `needsInput` 重启恢复与旧 attempt 归档"
```

（版本号、releaseDate、mandatory、downloadUrl 字段保持不变。）

- [ ] **Step 4: 清理根 `CLAUDE.md`**

仓库根 `CLAUDE.md` 第 116 行，删除或改写：
```
- No CI or test framework exists, but `ai_delivery_service.rs` already contains `#[cfg(test)]` unit-test modules (`agent_decision_tests` at ~L5110, `terminal_command_tests` at ~L5991) runnable via `cargo test`; frontend has no tests
```
改为：
```
- No CI or test framework exists, but `bot_binding_service.rs` contains `#[cfg(test)]` unit tests runnable via `cargo test`; frontend has no tests
```
（删除整行也可，但保留 bot 测试信息更准确。）

- [ ] **Step 5: 确认 bot 文档无需改动**

```bash
grep -niE "AI 交付|ai_delivery|AiDelivery|ai-delivery" docs/bot-notification-setup.md docs/机器人通知接入指南.md
```
Expected: 无输出（实测这两个文件不含 AI 交付内容，bot 保留，无需改动）。若意外出现匹配，仅删除匹配的 AI 交付句子，保留 bot 内容。

- [ ] **Step 6: 残留验证**

```bash
grep -rniE "ai[_ -]?delivery|AI 交付" --include="*.md" --include="*.json" . 2>/dev/null | grep -vE "\.terminalbuddy-worktrees/|node_modules/|/dist/|/target/|^\./\.superpowers/" | grep -vE "^\./docs/superpowers/specs/2026-08-05-remove-ai-delivery-design\.md"
```
Expected: 无输出（README / README_zh / version.json / CLAUDE.md 均已清理；唯一允许的是本设计规格自身与 `.superpowers/` 会话数据）。

- [ ] **Step 7: 提交**

```bash
git add README.md README_zh.md version.json CLAUDE.md
git commit -m "[文档] 移除 AI 交付相关说明（README/version.json/CLAUDE.md）"
```

---

### Task 9: 全量验证与残留扫描

**Files:**
- 无既定修改；仅按验证结果修复残留

**Interfaces:**
- Consumes: Task 1-8 全部完成
- Produces: 满足规格「七、验证」全部四条门禁的最终状态

- [ ] **Step 1: Rust 编译检查**

```bash
cd terminal-buddy/src-tauri && cargo check 2>&1 | tee /tmp/cargo-check.log
```
Expected: 零错误、零警告。若出现 `warning: ... never used` / `unused import`，逐个清理并补测。

- [ ] **Step 2: Rust 测试**

```bash
cargo test 2>&1 | tee /tmp/cargo-test.log
```
Expected: 全部通过，特别是 `bot_binding_service` 相关测试（`direct_reply_selects_latest_pending_binding`、`unknown_mobile_quote_falls_back_to_latest_pending_binding` 等）。若 `bot_binding_service` 测试名过滤更方便：`cargo test bot_binding`。

- [ ] **Step 3: 前端类型检查**

```bash
cd terminal-buddy && npx tsc --noEmit
```
Expected: 零错误。

- [ ] **Step 4: Web SPA 构建**

```bash
cd terminal-buddy/web && npm run build
```
Expected: `tsc` 与 `vite build` 成功。

- [ ] **Step 5: 全局残留扫描**

```bash
grep -rniE "ai[_ -]?delivery|AI 交付" . 2>/dev/null | grep -vE "\.terminalbuddy-worktrees/|node_modules/|/dist/|/target/"
```
逐个核对每一处剩余匹配，允许的白名单（无需处理）：
- `.superpowers/sdd/**`（本仓库的会话记录目录，运行时数据）
- `src-tauri/gen/**`（tauri 构建生成文件，下次构建自动再生成）
- `docs/superpowers/specs/2026-08-05-remove-ai-delivery-design.md`（本设计规格文档本身）
- `terminal-buddy/src-tauri/src/commands/terminal.rs`（若第 872 行注释在 Task 3 已改，应无匹配；如遗漏则改掉）
- 其他所有匹配必须清除（含 `version.json`、`README*`、`CLAUDE.md`、`tauri.conf.json`、`capabilities/default.json`、`web/`、`src/`、`src-tauri/src/` 任何文件）

- [ ] **Step 6: 运行时冒烟（可选但推荐）**

```bash
cd terminal-buddy && npm run tauri dev
```
Expected: 应用正常启动；主窗口正常打开；不再出现 AI 交付窗口/悬浮按钮；系统托盘、终端、设置（含机器人通知设置）功能正常。观察 `terminalbuddy_boot.log`（`%TEMP%/terminalbuddy_boot.log`）无 AI 交付启动日志（Task 1 已删除恢复/派发块）。验证后关闭应用。

- [ ] **Step 7: 提交遗留修复（如有）**

若 Step 1-5 发现并修复了任何残留：
```bash
git add -A
git commit -m "[移除AI交付] 清理验证残留引用"
```

---

## Self-Review 记录

**规格覆盖核对：**
- 一、整个文件删除（Rust 4 处 / 前端 3 处 / 配置脚本 4 项 / 文档 8 项）→ Task 2（Rust 模块）、Task 4（配置/脚本/演示页/文档）、Task 5-7（前端/Web）
- 二、引用点清理（Rust）→ Task 1（lib.rs / mod.rs 外的全部中枢）、Task 2（mod.rs 声明、notification.rs）、Task 3（database_service.rs）；`commands/mod.rs` / `services/mod.rs` / `models/mod.rs` / `web/handlers/mod.rs` 声明删除在 Task 2 与文件删除同步完成
- 三、bot 交叉点剥离 → Task 2（bot_handler / bot_long_connection / models/bot.rs / bot_settings_service）与 Task 6（前端 BotChannelDialog / BotNotificationSettings / tauri.ts 字段）
- 四、database_service.rs → Task 3
- 五、引用点清理（前端）→ Task 5（main.tsx / App.tsx）、Task 6（tauri.ts / settings.ts / BotChannelDialog）、Task 7（web/api.ts / web/App.tsx / Nav.tsx）；TerminalTabBar.tsx 为规格未列出但实际存在的同类过滤，并入 Task 5
- 六、文档清理 → Task 4（删除类）+ Task 8（修改类）；bot 两篇文档实测无 AI 交付内容，Task 8 Step 5 仅做确认
- 七、验证 → Task 9
- 八、不做的事 → Global Constraints 中固化；本计划不删除任何旧库表、不改共享服务行为（仅注释）、不触碰运行时目录

**规格之外的新发现（已纳入）：**
1. `commands/bot.rs` 的 `send_feishu_text`（368-379）唯一调用方在 ai_delivery_service，删除后成死代码（`pub(crate)` 触发 unused warning）→ Task 2 Step 4
2. `src/components/terminal/TerminalTabBar.tsx:30-32` 的 `extraParamTag === 'AI 交付'` 过滤（与 App.tsx 同款）→ Task 5 Step 4
3. `src/components/settings/BotNotificationSettings.tsx` 才是 AI 交付推送开关的实际 UI（规格只列了 BotChannelDialog.tsx）→ Task 6 Step 6
4. `App.tsx` 的 `open-ai-attempt-terminal` 监听（302-319）规格未列出 → Task 5 Step 2
5. `commands/terminal.rs:872` 注释提及 AI 交付 → Task 3 Step 5（仅注释文字）

**类型一致性核对：** 纯删除任务，无新增类型/签名。删除的 `Ai*` 类型、`ai_delivery_enabled` 字段、`openAiDeliveryWindow` 等在 Rust 与 TypeScript 两侧同步移除，任务顺序保证每一步编译通过：Task 1（中枢不引用）→ Task 2（bot 不再引用服务）→ Task 3（库方法无调用方）→ Task 5（前端调用方先删）→ Task 6（封装与字段后删）。`visibleSessions`、`BotSettings`、`BotChannelConfig` 等保留标识符在任务间名称一致。
