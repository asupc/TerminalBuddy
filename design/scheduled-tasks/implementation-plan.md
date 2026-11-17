# 定时任务功能 · 详细实施方案

> 对应设计稿：`design/scheduled-tasks/design.md`
> UI 预览：`design/scheduled-tasks/preview.html`
> 目标版本：v1.10.0（建议）
> 本文落实两项界面要求：
> 1. **定时任务是独立工作区页面**，不放入设置页。
> 2. **底部状态栏「定时」入口直接打开该页面**（不弹浮层）。

## 1. 实施目标与验收

### 1.1 功能目标

1. 用户可在定时任务页面创建 / 编辑 / 启停 / 删除任务。
2. 两类任务可执行：
   - **项目配置**：到点启动指定项目下已配置的 Profile 终端。
   - **Agent 任务**：指定 Agent + 供应商 + 模型 + 项目，发送一段 Prompt 执行。
3. 调度按任务时区计算，支持 Cron（5 段）与「仅一次」。
4. 支持「立即运行」、停止 Agent 运行、查看运行记录。
5. 定时任务使用**独立工作区页面**（与 Git 历史、未提交变更同级的特殊标签页），提供列表、编辑器、运行记录；不放入设置页。
6. **底部状态栏新增「定时」快捷入口**：显示启用数量 / 下次运行 / 运行中状态，点击直接打开定时任务页面。
7. 桌面端、完整网页界面（含 Docker 服务端）行为一致。

### 1.2 验收标准

- [ ] 定时任务以独立工作区页面打开（顶部标签 / 左侧标签树可见），不在设置页中。
- [ ] 页面内可完成全部 CRUD、立即运行、停止、查看运行记录。
- [ ] 创建一个 2 分钟后执行的 Agent 任务，到点自动创建原生会话并执行 Prompt；运行记录有状态、耗时、摘要、Token。
- [ ] 创建一个项目配置任务，到点创建终端标签，且不抢当前焦点。
- [ ] 任务时区设为 `Asia/Shanghai`，Docker 容器为 UTC，仍按北京时间执行。
- [ ] 应用重启后不重复触发同一计划时刻；停机超过宽限期不补跑。
- [ ] 状态栏「定时」入口显示启用数量与下次运行时间；点击直接打开 / 切换到定时任务页面。
- [ ] 运行中 / 等待确认 / 失败状态在状态栏入口与页面中可见。
- [ ] `npx tsc --noEmit`、`cargo check`、`cargo test --lib`、`check-invoke-coverage.py` 全部通过。

## 2. 交付清单

### 2.1 新增文件

```
terminal-buddy/src-tauri/src/
├─ models/scheduled_task.rs              # 模型、校验、默认值
├─ services/scheduled_task_service.rs    # 存储、Cron、调度、执行、运行记录
└─ commands/scheduled_task.rs            # Tauri 命令薄包装

terminal-buddy/src/
├─ types/scheduledTask.ts                # TS 类型
├─ services/tauri/scheduledTasks.ts      # invoke 包装
├─ utils/scheduledTaskFormat.ts          # 时间 / 状态文案（页面与状态栏共用）
├─ hooks/useScheduledTasksStatus.ts      # 状态栏数据轮询 + 事件刷新
├─ components/scheduled-tasks/ScheduledTasksPage.tsx
├─ components/scheduled-tasks/ScheduledTasksPage.css
├─ components/scheduled-tasks/ScheduledTaskDialog.tsx
├─ components/scheduled-tasks/ScheduledTaskRunsDialog.tsx
├─ components/shell/ScheduledTasksStatusEntry.tsx
└─ components/shell/ScheduledTasksStatusEntry.css

design/scheduled-tasks/statusbar-preview.html   # 状态栏入口预览（无浮层）
```

### 2.2 修改文件

```
terminal-buddy/src-tauri/
├─ Cargo.toml                            # cron、chrono-tz
├─ src/models/mod.rs                     # 导出 scheduled_task
├─ src/services/mod.rs                   # 导出 scheduled_task_service
├─ src/commands/mod.rs                   # 导出 scheduled_task
├─ src/desktop.rs                        # 注册命令 + 启动调度器
├─ src/server_main.rs                    # 启动调度器
├─ src/web/handlers/desktop_dispatch.rs  # 浏览器模式命令白名单
├─ src/services/ai_chat_service.rs       # 新增 release_process
├─ src/commands/terminal.rs              # TerminalCloseReason::ScheduledClose
└─ src/services/app_notification_service.rs  # 定时任务通知（P1，可与 P0 一起）

terminal-buddy/src/
├─ components/terminal/TerminalPanel.tsx     # 渲染独立页面
├─ components/terminal/TerminalTabBar.tsx    # 顶部标签（关闭标签导航时）
├─ components/shell/TabNav.tsx               # 左侧「工具」分组入口
├─ components/shell/AppStatusBar.tsx         # 挂载快捷入口
├─ components/shell/AppStatusBar.css         # 入口样式
├─ stores/appStore.ts                        # special tab 类型、页面开关
├─ services/tauri/index.ts                   # 导出 invoke 包装
└─ App.tsx 或新 hook                         # scheduled-task-run 刷新 / toast
```

## 3. 后端实施

### 3.1 依赖与模块注册

`Cargo.toml`：

```toml
cron = "0.15"
chrono-tz = "0.10"
```

- `cron` 只做 5 段表达式解析与 `after()` 迭代。
- `chrono-tz` 提供 IANA 时区，避免 Docker 默认 UTC 偏差。
- 两者均基于现有 `chrono 0.4`。

注册：

- `models/mod.rs`：`pub mod scheduled_task;`
- `services/mod.rs`：`pub mod scheduled_task_service;` + `pub use scheduled_task_service::ScheduledTaskService;`
- `commands/mod.rs`：`pub mod scheduled_task;`

### 3.2 数据模型 `models/scheduled_task.rs`

#### 3.2.1 任务定义

```rust
pub const MAX_TASKS: usize = 200;
pub const MAX_PROMPT_CHARS: usize = 8_000;
pub const MAX_TIMEOUT_MINUTES: u32 = 240;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub timezone: String,
    pub schedule: TaskSchedule,
    pub target: TaskTarget,
    #[serde(default = "default_true")]
    pub notify: bool,
    #[serde(default = "default_timeout_minutes")]
    pub timeout_minutes: u32,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub last_scheduled_at: Option<i64>,
    #[serde(default)]
    pub last_run_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskSchedule {
    Cron { expression: String },
    /// 任务时区下的本地墙钟时间："2026-11-20T09:00"
    Once { run_at: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskTarget {
    ProjectProfile {
        project_name: String,
        profile_id: String,
        #[serde(default)]
        auto_close_minutes: u32,
    },
    AgentPrompt {
        project_name: String,
        agent: String,
        #[serde(default)]
        provider_id: Option<String>,
        #[serde(default)]
        model: Option<String>,
        prompt: String,
    },
}
```

#### 3.2.2 运行记录

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    pub id: String,
    pub task_id: String,
    pub task_name: String,
    pub trigger: String,       // scheduled | manual
    pub status: String,        // 见下表
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: Option<i64>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
}
```

状态：`running` / `waitingApproval` / `completed` / `failed` / `timeout` / `stopped` / `started` / `skipped`。

#### 3.2.3 输入与视图

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledTaskInput {
    pub id: Option<String>,
    pub name: String,
    pub enabled: bool,
    pub timezone: String,
    pub schedule: TaskSchedule,
    pub target: TaskTarget,
    #[serde(default)]
    pub notify: Option<bool>,
    #[serde(default)]
    pub timeout_minutes: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskView {
    #[serde(flatten)]
    pub task: ScheduledTask,
    pub next_run_at: Option<i64>,
    pub running_run_id: Option<String>,
    pub last_run: Option<ScheduledRun>,
}
```

#### 3.2.4 校验函数

```rust
pub fn validate_input(
    input: ScheduledTaskInput,
    projects: &[Project],
    profiles: &[Profile],
) -> Result<ScheduledTask, String>
```

规则：

- 名称 trim 后 1–40 字符，无控制字符。
- 任务数上限 200。
- `timezone.parse::<chrono_tz::Tz>()` 成功。
- Cron 解析成功且 `after(now).next()` 存在。
- `Once.runAt` 可解析为 `NaiveDateTime`，且不早于当前时刻 1 分钟。
- `ProjectProfile`：项目存在、Profile 存在、`profile.group`（空视为「默认」）等于项目名。
- `AgentPrompt`：项目存在；agent ∈ {claude, codex}；`ai_catalog_service::selection(agent, providerId, model)` 成功；Prompt 非空 ≤ 8000 字符。
- `timeoutMinutes` 1–240；`autoCloseMinutes` 0–1440。

### 3.3 存储层

#### 3.3.1 路径与格式

```
<dataDir>/ScheduledTasks/tasks.json
<dataDir>/ScheduledTasks/runs/<taskId>.json
```

`tasks.json` 使用版本化包装，便于未来迁移：

```json
{ "version": 1, "tasks": [ { "...": "ScheduledTask" } ] }
```

读取时兼容旧数组（无 `version` 时按 v1 处理）。写入使用 `atomic_file::atomic_write`。

#### 3.3.2 进程内锁

```rust
fn store_lock() -> &'static Mutex<()> { ... }
```

- `load_tasks()` / `save_tasks()` / `mutate_task()` 全部先拿锁。
- 调度执行期间不持锁；任务快照复制后释放。
- 运行记录按任务分文件，单任务最多 100 条，写入时截断。

#### 3.3.3 主要函数

```rust
impl ScheduledTaskService {
    pub fn list() -> Result<Vec<ScheduledTaskView>, String>;
    pub fn save(input: ScheduledTaskInput) -> Result<ScheduledTaskView, String>;
    pub fn delete(id: &str) -> Result<(), String>;
    pub fn set_enabled(id: &str, enabled: bool) -> Result<ScheduledTaskView, String>;
    pub fn runs(id: &str, limit: usize) -> Result<Vec<ScheduledRun>, String>;

    fn load_defs() -> Result<Vec<ScheduledTask>, String>;
    fn save_defs(tasks: &[ScheduledTask]) -> Result<(), String>;
    fn mutate_task<F>(id: &str, f: F) -> Result<ScheduledTask, String>
        where F: FnOnce(&mut ScheduledTask);
    fn append_run(run: &ScheduledRun);
    fn update_run(run: &ScheduledRun);
    fn read_runs(task_id: &str) -> Vec<ScheduledRun>;
}
```

保存逻辑：

- 新建：生成 UUID、`createdAt = now`、`lastScheduledAt = now`。
- 编辑：保留 `createdAt`；仅当 `schedule` 或 `timezone` 改变时把 `lastScheduledAt` 重置为当前时刻，避免保存后立刻触发。
- 校验失败返回中文原因，前端就地展示。
- 保存 / 删除 / 启停后发射 `scheduled-tasks-changed` 事件。

### 3.4 时间计算

#### 3.4.1 核心函数

```rust
fn next_after(
    schedule: &TaskSchedule,
    after: DateTime<Utc>,
    tz: chrono_tz::Tz,
) -> Option<DateTime<Utc>>
```

- `Cron`：`Schedule::from_str(expr)?.after(&after.with_timezone(&tz)).next()?.with_timezone(&Utc)`。
- `Once`：解析本地墙钟，`tz.from_local_datetime(&naive).earliest()`，转 UTC；仅当结果晚于 `after` 时返回。

```rust
/// 返回 (最近一次已到期的计划时刻, 是否应执行)
fn due_occurrence(
    task: &ScheduledTask,
    now: DateTime<Utc>,
) -> Option<(DateTime<Utc>, bool)>
```

算法：

1. 锚点 = `lastScheduledAt` 或 `createdAt`。
2. 从锚点向后迭代，找到所有 ≤ now 的计划时刻，保留最后一次。
3. `shouldRun = now - latest <= GRACE`（5 分钟）。
4. 返回 `(latest, shouldRun)`；调用方**无论是否执行**都把 `lastScheduledAt = latest`。
5. `Once` 任务消费后自动 `enabled = false`。

#### 3.4.2 预览

```rust
pub fn preview(expression: &str, timezone: &str, count: usize) -> Result<Vec<i64>, String>
```

返回未来 N 次执行的 UTC 毫秒时间戳（`count` 限制 1–20）。

### 3.5 调度循环

```rust
pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) { return; }
    crate::runtime::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(30));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if PAUSED.load(Ordering::Relaxed) { continue; }
            tick(&app);
        }
    });
}
```

`tick`：

1. `load_defs()`；失败则打印日志并返回。
2. 遍历 enabled 任务，调 `due_occurrence`。
3. 对每个到期任务：
   - 先持久化 `lastScheduledAt`。
   - 检查单任务运行中 / 全局并发（3）：
     - 冲突 → 写一条 `skipped` 运行记录。
   - 否则 `spawn_run(app, task, Trigger::Scheduled)`。
4. `Once` 任务消费后置 `enabled=false` 并保存。
5. 整个 tick 不阻塞 tokio 工作线程：文件读写放 `spawn_blocking` 或在启动时用阻塞线程池；任务执行本身异步。

启动入口：

- 桌面端 `desktop.rs` 的 `setup`，状态注册完成后：
  ```rust
  crate::services::scheduled_task_service::start(app.handle().clone());
  ```
- 服务端 `server_main.rs`，`AppHandle::new()` 与 `set_app_handle` 之后。

### 3.6 执行器

#### 3.6.1 运行上下文

```rust
static ACTIVE: Mutex<HashMap<String, ActiveRun>> = ...;

struct ActiveRun {
    run_id: String,
    task_id: String,
    session_id: Option<String>,
    terminal_id: Option<String>,
    started_at: i64,
}
```

- key 为 `taskId`（单任务串行）。
- `active_count()` 用于全局并发上限。
- `scheduled_task_stop` 通过 `session_id` 调 `ai_chat_service::stop`。

#### 3.6.2 Agent 任务

```rust
async fn run_agent(
    app: AppHandle,
    task: ScheduledTask,
    run: ScheduledRun,
) -> RunOutcome
```

步骤：

1. 解析项目：`get_projects()` 按名称查找，校验路径存在。
2. 再次校验供应商/模型：`ai_catalog_service::selection(...)`。
3. 创建原生会话（`spawn_blocking`）：
   ```rust
   let owner = crate::commands::ai_chat::desktop_owner();
   let session = ai_chat_service::create(&owner, CreateAiSession {
       provider, provider_id, project_path, model,
       resume_session_id: None,
   })?;
   ```
4. 更新运行记录 `sessionId`、`agent`、`providerName`、`model`。
5. 发送 Prompt：
   ```rust
   ai_chat_service::send(&session.id, &owner, SendAiMessage {
       text: prompt,
       request_id: Uuid::new_v4().to_string(),
       steer: false,
       images: Vec::new(),
   })?;
   ```
6. 轮询（每 5 秒，`spawn_blocking(ai_chat_service::get)`）：
   - `running` / `background` → 继续。
   - `idle` → `completed`。
   - `approval` → `waitingApproval`；首次进入时发布通知；继续轮询。
   - `interrupted` / `error` → `failed`。
   - 超过 `timeoutMinutes` → `ai_chat_service::stop` → `timeout`。
7. 收尾：
   - 摘要取最后一条 assistant 消息，截断 500 字符；失败取 `session.error`。
   - Token 取 `session.usage.last_turn`。
   - 调 `ai_chat_service::release_process(sessionId, owner)` 回收常驻 CLI 进程，保留会话文件。
   - 更新运行记录并发射事件。

新增 `ai_chat_service::release_process`：

```rust
pub fn release_process(id: &str, owner: &str) -> Result<()> {
    let cell = load(id, owner)?;
    let mut control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    let data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if data.status != "idle" || !data.approvals.is_empty() || !data.pending_inputs.is_empty() {
        return Ok(());
    }
    if let Some(tx) = control.take() { let _ = tx.send(Control::Retire); }
    Ok(())
}
```

#### 3.6.3 项目配置任务

```rust
async fn run_profile(
    app: AppHandle,
    task: ScheduledTask,
    run: ScheduledRun,
) -> RunOutcome
```

1. 解析项目与 Profile；校验 `profile.group` 与项目名一致。
2. `spawn_blocking` 调 `TerminalService::create_terminal`：
   ```rust
   let owner = if cfg!(feature = "desktop") { TerminalOwner::Pc } else { TerminalOwner::Web };
   let terminal_id = ts.create_terminal(
       &profile_id,
       Some(&format!("定时 · {}", task.name)),
       None, None, 0, 0,
       Some(&project.path),
       false,
       app.clone(),
       owner,
       TerminalCreator::Desktop,
   )?;
   ```
3. 主动广播 `terminal-created`，`activate: false`，并带 `groupName`。
4. 运行记录 `status = "started"`，`terminalId`、`message = "终端已启动"`。
5. `autoCloseMinutes > 0` 时起定时器，到点 `teardown_terminal(app, id, ScheduledClose)`。
6. 新增 `TerminalCloseReason::ScheduledClose`（`as_str` 返回 `"scheduled-close"`）。

### 3.7 命令层与 Web dispatch

`commands/scheduled_task.rs`：

```rust
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_list() -> Result<Vec<ScheduledTaskView>, String>;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_save(app: AppHandle, input: ScheduledTaskInput) -> Result<ScheduledTaskView, String>;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_delete(app: AppHandle, id: String) -> Result<(), String>;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<ScheduledTaskView, String>;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_run_now(app: AppHandle, id: String) -> Result<ScheduledRun, String>;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_stop(app: AppHandle, id: String) -> Result<(), String>;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_runs(id: String, limit: Option<usize>) -> Result<Vec<ScheduledRun>, String>;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_options() -> Result<ScheduledTaskOptions, String>;

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn scheduled_task_preview(expression: String, timezone: String, count: Option<usize>) -> Result<Vec<i64>, String>;
```

- 所有阻塞操作走 `spawn_blocking`。
- `scheduled_task_run_now` 只创建运行记录并异步派发，立即返回。
- `scheduled_task_stop` 只支持 Agent 运行；项目配置任务提示「请关闭对应终端」。

注册：

- `desktop.rs` 的 `invoke_handler![]` 加入 9 个命令。
- `web/handlers/desktop_dispatch.rs` 增加同名分支（浏览器模式通过 `/api/desktop/invoke/:command` 调用）。
- `scripts/check-invoke-coverage.py` 校验前端 invoke 是命令列表子集。

### 3.8 事件与通知

#### 3.8.1 事件

- `scheduled-task-run`：`{ taskId, run, task }`，开始 / 等待确认 / 结束各发一次。
- `scheduled-tasks-changed`：任务定义或启停变化，供状态栏与列表刷新。

使用 `crate::runtime::Emitter::emit`，桌面与浏览器（EventBus → `/ws/events`）都能收到。

#### 3.8.2 App 通知（可与 P0 一起）

`AppNotificationService` 增加：

- `scheduled_completed`
- `scheduled_failed`
- `scheduled_approval`

`AppNotificationEvent` 增加可选字段（全部 `#[serde(default)]`）：`taskId`、`runId`、`sessionId`。

通知文案：

- 完成：「定时任务完成：{name}」+ 摘要前 120 字。
- 失败：「定时任务失败：{name}」+ 错误原因。
- 等待确认：「定时任务等待确认：{name}」+ 点击打开会话。

## 4. 前端实施

### 4.1 类型与 invoke 包装

`src/types/scheduledTask.ts`：

```ts
export type ScheduledRunStatus =
  | 'running' | 'waitingApproval' | 'completed' | 'failed'
  | 'timeout' | 'stopped' | 'started' | 'skipped';

export interface ScheduledTask { ... }
export interface ScheduledTaskView extends ScheduledTask {
  nextRunAt: number | null;
  runningRunId: string | null;
  lastRun: ScheduledRun | null;
}
export interface ScheduledRun { ... }
export interface ScheduledTaskOptions {
  projects: Project[];
  profiles: Profile[];
  catalog: AiCatalog;
}
```

`src/services/tauri/scheduledTasks.ts`：包装 9 个 invoke，并在 `services/tauri/index.ts` 导出。

`src/utils/scheduledTaskFormat.ts`：

- `formatSchedule(task): string`：每天 / 工作日 / 每周一至五 / 每 N 小时 / 自定义 Cron / 仅一次。
- `formatNextRun(ms): string`：今天 HH:mm / 明天 HH:mm / MM-DD HH:mm。
- `formatRunStatus(status): { label, tone }`。
- `describeTarget(task): string`：`Claude · DeepSeek · deepseek-chat` / `TerminalBuddy · 开发环境`。

### 4.2 独立工作区页面

定时任务不进入设置页，而是作为与 Git 历史、未提交变更同级的**特殊工作区标签页**。

#### 4.2.1 页面开关与工作区集成

`appStore.ts`：

```ts
export type WorkspaceSpecialTab =
  | 'git-history' | 'git-changes' | 'claude-replay' | 'agent-chat'
  | 'scheduled-tasks' | null;

// 页面是否处于「已打开」状态：关闭后消失，切换终端时保留。
scheduledTasksTabOpen: boolean;
openScheduledTasksPage: () => void;   // 设为 true，并把 activeSpecialTab 切到 scheduled-tasks
closeScheduledTasksPage: () => void;  // 设为 false；若当前激活则 activeSpecialTab = null
```

行为：

- `openScheduledTasksPage()`：`scheduledTasksTabOpen = true`，`activeSpecialTab = 'scheduled-tasks'`。
- 用户切到终端 / 聊天 / Git 页面时，`scheduledTasksTabOpen` 保持 true，标签仍在，只是不激活。
- `closeScheduledTasksPage()`：关闭页面；若当前正激活则 `activeSpecialTab = null`。
- 该状态不持久化，重启后默认关闭。
- 点击状态栏入口时调用 `openScheduledTasksPage()`：已打开则切换过去，未打开则打开。

`TerminalPanel.tsx`：

```tsx
const scheduledTasksTabOpen = useAppStore(s => s.scheduledTasksTabOpen);

{scheduledTasksTabOpen && activeSpecialTab === 'scheduled-tasks' && (
  <div className="git-history-tab-content scheduled-tasks-tab-content">
    <Suspense fallback={<div className="lazy-panel-loading">加载定时任务…</div>}>
      <ScheduledTasksPage onClose={closeScheduledTasksPage} />
    </Suspense>
  </div>
)}
```

同时把 `renderTerminalContent()` 的「暂无终端会话」早退条件加上 `&& !scheduledTasksTabOpen`，避免页面打开时底层还渲染空终端状态。

`TerminalTabBar.tsx`（关闭标签导航时）：

- 渲染条件加入 `scheduledTasksTabOpen`。
- 标签：`CalendarClock` 图标 + 「定时任务」+ 关闭按钮。
- 点击激活；中键 / 关闭按钮调用 `closeScheduledTasksPage()`。

`TabNav.tsx`（左侧标签树）：

- 在会话树上方增加固定的「工具」分组，仅在 `scheduledTasksTabOpen` 时渲染：
  ```
  工具
    定时任务   [CalendarClock]  ×
  ```
- 激活条件：`activeSpecialTab === 'scheduled-tasks'`。
- 点击调用 `openScheduledTasksPage()`，关闭按钮调用 `closeScheduledTasksPage()`。
- 无终端会话时，只要页面打开，侧栏仍然渲染（调整现有空状态早退条件）。

页面头部：

- 标题「定时任务」+ 说明。
- 右侧：全部暂停 / 新建任务 / 关闭页面（`X`）。
- 关闭按钮调用 `onClose`，与标签关闭等价。

#### 4.2.2 `ScheduledTasksPage`

- 顶栏：标题、说明、全局暂停、新建任务、关闭。
- 提示条：桌面端退出后停止；7×24 请用 Docker 服务端。
- 紧凑摘要条：启用数 / 运行中 / 今日执行 / 下次触发。
- 任务卡片列表：
  - 名称、类型徽章、启用开关。
  - 目标摘要、调度文案、时区、下次运行。
  - 上次运行状态 + 摘要。
  - 操作：立即运行 / 编辑 / 运行记录 / 删除。
- 空状态：引导文案 + 示例按钮。
- 数据：
  - 页面挂载时加载 `scheduled_task_list` 与 `scheduled_task_options`。
  - 30 秒轮询一次；监听 `scheduled-task-run`、`scheduled-tasks-changed` 立即刷新。
  - 删除使用现有 `ConfirmDialog`。
  - 页面卸载时清理轮询与事件监听。
- 页面是主内容区的一部分，不再是设置弹窗；编辑器与运行记录仍使用 `Dialog` 覆盖在页面上。

#### 4.2.3 `ScheduledTaskDialog`

- 使用现有 `Dialog` 组件。
- 基本信息：名称、启用、通知。
- 执行内容：两个 Tab。
  - 项目配置：项目、配置（按 `profile.group` 过滤）、自动关闭。
  - Agent 任务：项目、Agent、供应商、模型、Prompt、超时、通知。
- 触发时间：预设 chips + 时间 / 星期 / Cron / 仅一次 + 时区 + 预览。
- 校验：
  - 前端即时校验必填与长度。
  - 保存调用后端，错误就地显示。
- 按钮：取消 / 保存 / 保存并立即运行。

#### 4.2.4 `ScheduledTaskRunsDialog`

- 汇总：执行次数、成功、失败、平均耗时、累计 Token。
- 表格：开始时间、触发、状态、耗时、摘要/错误、操作。
- 操作：
  - `sessionId` → 打开聊天标签（`openExistingAgentSession`）。
  - `terminalId` → 切到终端标签。
  - 运行中 → 停止。

### 4.3 底部状态栏快捷入口（本次新增重点）

#### 4.3.1 位置与视觉

挂载在 `AppStatusBar` 右侧组，放在 Web 状态之后、资源与时钟之前：

```
[会话/Agent/目录/Git]                         [Web] [定时 3 · 18:00] [CPU] [内存] [14:32] [v1.9.0]
```

入口结构：

```tsx
const openScheduledTasksPage = useAppStore(s => s.openScheduledTasksPage);
const scheduledActive = useAppStore(s => s.activeSpecialTab === 'scheduled-tasks');

<button
  type="button"
  className={`app-statusbar-item app-statusbar-clickable app-statusbar-optional${scheduledActive ? ' active' : ''}`}
  title="定时任务 · 3 个启用 · 下次今天 18:00 · 点击打开管理"
  onClick={openScheduledTasksPage}
>
  <CalendarClock className="app-statusbar-icon" />
  {running && <span className="app-statusbar-dot running" />}
  <span className="app-statusbar-label">定时</span>
  {enabledCount > 0 && <span className="app-statusbar-badge">{enabledCount}</span>}
  {nextRunAt && <span className="app-statusbar-mono">{formatNextRun(nextRunAt)}</span>}
</button>
```

状态表现：

| 状态 | 表现 |
| --- | --- |
| 无任务 | 时钟图标 + 「定时」灰字，无 badge |
| 有启用任务 | 图标 + 「定时」+ 启用数量 badge + 下次时间 |
| 有任务运行中 | 追加脉冲点，文案优先显示「运行中」 |
| 有待确认 | 追加警示色点，tooltip 提示「N 个任务等待确认」 |
| 页面当前激活 | 入口使用 `active` 背景，类似 Web 状态入口 |
| 加载失败 | 保持上次数据；tooltip 追加「状态暂不可用」 |

点击行为：

- 调用 `openScheduledTasksPage()`。
- 若页面未打开 → 打开并在主内容区显示。
- 若页面已打开但当前在别的标签 → 切换过去。
- 若页面已打开且激活 → 保持当前页面，不做切换/关闭。
- **不弹浮层**，不在状态栏内部做运行/停止操作；这些操作全部在独立页面完成。

响应式：

- `max-width: 720px` 时隐藏「定时」文字与时间，只保留图标 + 状态点/数量 badge。
- 入口不参与状态栏主布局伸缩，避免挤动目录/Git。

#### 4.3.2 数据 Hook `useScheduledTasksStatus`

```ts
interface ScheduledTasksStatusState {
  tasks: ScheduledTaskView[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useScheduledTasksStatus(enabled = true): ScheduledTasksStatusState
```

- 挂载时加载一次。
- 每 30 秒轮询（与后端 tick 对齐）。
- 监听 `scheduled-task-run` 与 `scheduled-tasks-changed` 事件，立即刷新。
- 请求失败不弹 toast，静默保留上次数据。
- 组件卸载清理定时器与事件监听。
- 使用 `requestRef` 丢弃过期响应，避免快速切换时的竞态。
- 只给状态栏图标/数量/下次时间使用，不承担页面数据；页面自己有完整加载与刷新逻辑。

#### 4.3.3 样式

- 复用 `app-statusbar-item` / `app-statusbar-icon` / `app-statusbar-badge` / `app-statusbar-dot`。
- 新增 `ScheduledTasksStatusEntry.css`：
  - 运行中状态点使用 `--accent`，等待确认使用 `--warning`。
  - 页面激活时入口背景使用 `--bg-tertiary`。
  - 浅色主题通过 CSS 变量自动适配。
- 入口不包含浮层，不需要 `createPortal`，也不会被状态栏 `overflow: hidden` 影响。

#### 4.3.4 键盘与可访问性

- 入口是原生 `<button>`，支持 Enter / Space。
- `title` 提供完整状态说明；`aria-label` 使用「打开定时任务管理」。
- 页面激活时 `aria-current="page"`。
- 点击后焦点移动到页面标题或任务列表，便于键盘用户继续操作。

### 4.4 事件、刷新与提示

- `App.tsx` 或 `ScheduledTasksStatusEntry` 监听 `scheduled-task-run`：
  - 状态栏入口刷新。
  - 定时任务页面打开时刷新列表。
  - `notify` 为 true 且窗口不可见时，可调用系统通知（P1）。
- 失败 / 完成 toast 只在用户主动操作（立即运行、停止）时弹出；后台计划执行不打断用户。
- 运行完成通知走 `AppNotificationService`（安卓）与 Windows Toast（P1）。

## 5. 接口契约

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `scheduled_task_list` | — | `ScheduledTaskView[]` |
| `scheduled_task_save` | `input` | `ScheduledTaskView` |
| `scheduled_task_delete` | `id` | `void` |
| `scheduled_task_set_enabled` | `id`, `enabled` | `ScheduledTaskView` |
| `scheduled_task_run_now` | `id` | `ScheduledRun` |
| `scheduled_task_stop` | `id` | `void` |
| `scheduled_task_runs` | `id`, `limit?` | `ScheduledRun[]` |
| `scheduled_task_options` | — | `{ projects, profiles, catalog }` |
| `scheduled_task_preview` | `expression`, `timezone`, `count?` | `number[]` |

事件：

| 事件 | 载荷 | 用途 |
| --- | --- | --- |
| `scheduled-task-run` | `{ taskId, run, task }` | 列表 / 状态栏刷新，运行提示 |
| `scheduled-tasks-changed` | `{ taskId?, action }` | 定义变化刷新 |

## 6. 关键流程时序

### 6.1 计划执行（Agent）

```
tick (30s)
  → load_defs
  → due_occurrence(task, now) == (latest, true)
  → persist lastScheduledAt
  → spawn_run
      → append run(running)
      → emit scheduled-task-run
      → resolve project/provider
      → ai_chat_service::create
      → ai_chat_service::send
      → poll every 5s
          running → continue
          approval → waitingApproval + notify
          idle → completed
          timeout → stop + timeout
      → release_process
      → update run + emit scheduled-task-run
```

### 6.2 状态栏入口

```
mount
  → useScheduledTasksStatus
      → scheduled_task_list
      → setInterval 30s
      → listen scheduled-task-run / scheduled-tasks-changed
  → render icon + count + nextRunAt

click
  → openScheduledTasksPage()
      → scheduledTasksTabOpen = true
      → activeSpecialTab = 'scheduled-tasks'
      → 主内容区渲染 ScheduledTasksPage
      → 顶部标签 / 左侧「工具」分组显示「定时任务」
```

## 7. 测试与验收

### 7.1 Rust 单元测试

- `cron_next_run_respects_task_timezone`
- `missed_occurrence_outside_grace_is_skipped`
- `hourly_task_does_not_burst_after_downtime`
- `once_task_disables_after_consumption`
- `invalid_cron_and_timezone_are_rejected`
- `save_rejects_unknown_project_profile_provider`
- `runs_are_capped_at_100`
- `next_run_resets_after_schedule_edit`
- `manual_run_dedup_within_five_seconds`
- `concurrency_skip_policy`
- `versioned_tasks_file_reads_legacy_array`

### 7.2 前端检查

- `npx tsc --noEmit`：类型、未使用变量。
- `python scripts/check-invoke-coverage.py`：9 个命令均在 `invoke_handler![]`。
- 手动：
  - 状态栏入口在桌面 / 浏览器模式均可见。
  - 点击状态栏入口直接打开定时任务页面；再次点击从其他标签切回该页面。
  - 页面在顶部标签栏 / 左侧「工具」分组中有对应条目，可关闭。
  - 无任务时空状态与「新建任务」可用。
  - 任务运行中状态点、页面内停止按钮、立即运行。
  - 页面关闭后入口数据仍同步。
  - 窄屏（720px 以下）只显示图标与数量。
  - 浅色主题样式正确。

### 7.3 端到端验收

1. 桌面端创建 Agent 任务 → 2 分钟后执行 → 聊天标签、运行记录、状态栏状态正确。
2. Docker 服务端创建同时区任务 → 容器 UTC → 执行时间正确。
3. 项目配置任务到点启动终端且不抢焦点。
4. 重启应用后不重复触发。
5. 失败任务在定时任务页面显示可读原因。
6. 从状态栏入口直接打开页面，页面内「新建任务」打开编辑弹窗。
7. 页面打开后切换到终端，再点状态栏入口能切回页面；关闭页面后状态栏入口可重新打开。

## 8. 实施顺序与工作量

建议按以下顺序提交，每步可独立编译 / 测试。

| 步骤 | 内容 | 预估 |
| --- | --- | --- |
| 1 | Cargo 依赖、模型、存储、校验、单元测试 | 0.5 天 |
| 2 | Cron / 时区 / due_occurrence / preview + 测试 | 0.5 天 |
| 3 | 调度循环、并发控制、启动接线（桌面 + 服务端） | 0.5 天 |
| 4 | Agent 执行器 + `release_process` + 运行记录 | 1 天 |
| 5 | Profile 执行器 + `ScheduledClose` + `terminal-created` | 0.5 天 |
| 6 | 命令层、Web dispatch、invoke 覆盖率 | 0.5 天 |
| 7 | 前端类型 / invoke / 格式化工具 | 0.25 天 |
| 8 | 独立工作区页面（列表 + 编辑器 + 运行记录）+ 标签集成 | 1.75 天 |
| 9 | 状态栏入口（直接打开页面）+ 样式 | 0.5 天 |
| 10 | 事件 / 通知 / 刷新串联 | 0.5 天 |
| 11 | 单元测试、手工验收、UI 预览更新 | 0.75 天 |

合计约 **7 人日**（不含安卓端专门适配）。

建议 commit 拆分：

1. `[定时任务] 后端模型、存储与 Cron 计算`
2. `[定时任务] 调度循环与 Agent / 项目配置执行器`
3. `[定时任务] 命令层与 Web dispatch`
4. `[定时任务] 独立工作区页面与运行记录`
5. `[状态栏] 定时任务快捷入口直接打开管理页面`
6. `[定时任务] 通知与验收测试`

## 9. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| Cron 库与 chrono 版本不兼容 | 锁定 `cron 0.15` + `chrono-tz 0.10`，`cargo tree` 检查 |
| 定时 Agent 会话堆积常驻进程 | 每轮结束 `release_process`；保留会话文件可恢复 |
| Docker 时区错误 | 任务显式 IANA 时区，不依赖容器 `TZ` |
| 桌面端退出后任务不执行 | UI 明确提示；需要常驻用 Docker 服务端 |
| 权限询问导致任务卡住 | 状态 `waitingApproval` + 通知；不自动批准 |
| 状态栏轮询增加开销 | 30 秒一次、≤200 条、组件独立 memo；必要时改轻量状态接口 |
| 多客户端并发编辑 | 后端 `Mutex` 串行化读改写；编辑冲突以最后保存为准 |
| 功能异常需要回退 | 移除状态栏入口与工作区页面注册、停止调度器启动即可；`ScheduledTasks/` 数据不受影响 |

数据格式版本：`tasks.json` 使用 `{ "version": 1, "tasks": [...] }`；读取兼容无版本的旧数组。

## 10. 待确认

1. 定时任务页面是否需要在左侧「工具」分组中常驻（即使未打开），还是只在打开时显示？本方案为「打开时显示」。
2. 页面切换走顶部标签栏还是左侧标签树，取决于现有 `enableTabNavigation` 设置；本方案两者都接入。
3. 项目配置任务是否需要「N 分钟后自动关闭」之外的停止方式（如页面内直接关闭终端）？
4. Agent 基础命令需要确认时，是否允许在定时任务页面内直接回答权限问题？（本方案只显示状态并提示打开会话。）
5. 运行记录每任务保留 100 条是否满足需要。
