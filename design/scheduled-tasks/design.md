# 定时任务（Scheduled Tasks）设计

> 状态：设计稿，未实现
> 日期：2026-11-17
> 关联模块：`src-tauri/src/services`、`src-tauri/src/commands`、`src/components/settings`

## 1. 目标与范围

### 1.1 目标

在 TerminalBuddy 内新增「定时任务」，让用户按计划自动做两类事情：

1. **项目配置任务**：到点启动某个项目下已经配置好的终端（Profile），例如每天 09:30 启动 `项目 A / 开发环境`。
2. **Agent 任务**：指定 Agent（Claude Code / Codex / Antigravity CLI）+ 供应商 + 模型 + 项目目录，把一段任务描述交给它执行。例如「工作日 18:00 用 DeepSeek Flash 打开 Claude，汇总今天项目里的提交」。Antigravity CLI 使用 Google 账号登录，不需要供应商 / 模型，固定以终端接力执行。

### 1.2 MVP 范围

- 任务定义的新增 / 编辑 / 删除 / 启停。
- 调度：Cron（5 段）+ 仅一次；按任务时区计算。
- 执行：项目 Profile 启动、原生 Agent 会话执行 Prompt。
- 手动「立即运行」、运行记录、失败原因。
- 桌面端与完整网页界面（含 Docker 服务端）共用一套能力。
- 运行完成 / 失败 / 等待确认的通知（桌面事件 + 复用 App 通知通道）。

### 1.3 明确不做（MVP）

- **不注册 Windows 计划任务 / systemd timer**。调度器随 TerminalBuddy 进程运行：
  - 桌面端：应用退出即停止（托盘常驻时继续）。
  - Docker/服务端：进程常驻，可 7×24 执行。
  - 需要关机后仍执行时，后续做「系统级守护进程」独立方案。
- 不执行任意 Shell 命令。MVP 只允许启动已登记项目的 Profile，以及向 Agent 发送 Prompt。
- 不自动批准 Agent 的权限询问（见 §6.4）。
- 不做任务依赖、任务串联、多目标任务。
- 不做「错过补跑」；应用停机期间错过的计划默认跳过（见 §5.3）。

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│ 前端（桌面 WebView / 浏览器）                              │
│  TerminalPanel → ScheduledTasksPage（独立工作区标签页）   │
│    ├─ 列表 / 运行记录                                     │
│    └─ 新建·编辑对话框                                     │
│  监听 scheduled-task-run 事件，刷新列表 / 提示            │
└───────────────┬──────────────────────────────────────────┘
                │ Tauri invoke / POST /api/desktop/invoke/:cmd
┌───────────────▼──────────────────────────────────────────┐
│ commands/scheduled_task.rs（薄命令层）                    │
│        │                                                 │
│ services/scheduled_task_service.rs                        │
│    ├─ 任务定义读写（tasks.json）                          │
│    ├─ Cron 计算 / 时区 / 下次运行时间                     │
│    ├─ 调度循环（每 30s tick）                             │
│    └─ 执行器                                              │
│         ├─ Agent：ai_chat_service（原生会话）             │
│         └─ Profile：TerminalService（PTY 终端）           │
│                                                          │
│ 运行记录 runs/<taskId>.json                               │
│ 事件：EventBus / Tauri event / AppNotificationService     │
└──────────────────────────────────────────────────────────┘
```

要点：

- **调度与执行都在 Rust 后端**，不依赖前端页面是否打开。前端只是管理和展示。
- 复用现有「原生 AI 会话」作为 Agent 任务的执行载体：`ai_chat_service` 已经把 Claude `stream-json` / Codex app-server 的结构化消息、用量、停止、权限询问封装好了，且不依赖 PTY。相比「开终端再注入文本」，完成判定、失败原因、token 统计都可靠得多。
- 复用现有「终端创建」作为项目配置任务的执行载体：Profile 的启动命令、环境变量、项目路径解析（`ProfileService::effective_startup_path`）、Claude 模型引用展开、Hook 注入全部保持原行为。

## 3. 数据模型

新增 `src-tauri/src/models/scheduled_task.rs`。

### 3.1 任务定义

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledTask {
    pub id: String,              // UUID
    pub name: String,            // 1..=40 字符
    pub enabled: bool,
    pub timezone: String,        // IANA，如 "Asia/Shanghai"
    pub schedule: TaskSchedule,
    pub target: TaskTarget,
    #[serde(default)]
    pub notify: bool,            // 默认 true
    #[serde(default = "default_timeout_minutes")]
    pub timeout_minutes: u32,    // Agent 任务专用，默认 30
    pub created_at: i64,
    pub updated_at: i64,
    /// 调度锚点：上一次「已被调度消费」的计划时刻（不是实际开始时刻）。
    /// 用它计算下一次，保证重启后不会重复触发。
    #[serde(default)]
    pub last_scheduled_at: Option<i64>,
    #[serde(default)]
    pub last_run_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskSchedule {
    /// 标准 5 段 Cron：分 时 日 月 周。
    Cron { expression: String },
    /// 仅一次；runAt 是任务时区下的本地墙钟时间，避免浏览器/容器时区不一致。
    Once { run_at: String }, // "2026-11-20T09:00"
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskTarget {
    /// 启动项目下已配置的终端。
    ProjectProfile {
        project_name: String,
        profile_id: String,
        /// 启动后多少分钟自动关闭；0 = 不自动关闭。
        #[serde(default)]
        auto_close_minutes: u32,
    },
    /// 用指定 Agent + 供应商 + 模型执行一段任务描述。
    AgentPrompt {
        project_name: String,
        agent: String,                 // "claude" | "codex"
        #[serde(default)]
        provider_id: Option<String>,   // 目录 ID，如 "llm:<uuid>" / "default:claude"
        #[serde(default)]
        model: Option<String>,
        prompt: String,                // 1..=8000 字符
    },
}
```

### 3.2 运行记录

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    pub id: String,
    pub task_id: String,
    /// 任务名快照：任务改名/删除后历史仍可读。
    pub task_name: String,
    /// scheduled | manual
    pub trigger: String,
    /// running | completed | failed | waitingApproval | timeout | stopped | skipped | started
    pub status: String,
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

状态语义：

| 状态 | 含义 |
| --- | --- |
| `running` | Agent 会话执行中 |
| `waitingApproval` | Agent 停在权限询问，等待用户处理 |
| `completed` | Agent 回合正常结束 |
| `failed` | 创建会话 / 发送失败、Agent 报错、项目或供应商已失效 |
| `timeout` | 超过 `timeoutMinutes`，已主动 stop |
| `stopped` | 用户手动停止 |
| `started` | 项目 Profile 终端已成功创建（PTY 不提供退出码，不假装「完成」） |
| `skipped` | 并发/全局上限导致本次未执行 |

### 3.3 视图模型

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskView {
    #[serde(flatten)]
    pub task: ScheduledTask,
    pub next_run_at: Option<i64>,
    pub running_run_id: Option<String>,
    pub last_run: Option<ScheduledRun>, // 仅最近一条
}
```

`nextRunAt`、`runningRunId`、`lastRun` 都是运行时计算值，不落盘。

### 3.4 存储布局

```
%APPDATA%/TerminalBuddy/
└─ ScheduledTasks/
   ├─ tasks.json             # { "version": 1, "tasks": [...] }，原子写入
   └─ runs/
      ├─ <taskId>.json       # 该任务最近 100 条运行记录
      └─ ...
```

- 定义用 JSON，和 `profiles.json` / `projects.json` / `settings.json` 风格一致，便于排查和导出。
- `tasks.json` 使用版本化包装 `{ "version": 1, "tasks": [...] }`，读取时兼容旧的无版本数组格式，便于后续迁移。
- 运行记录按任务分文件，避免每次追加都重写全部历史；单个任务只保留最近 100 条，删除任务时一并删除。
- 所有写入走 `services/atomic_file.rs::atomic_write`。
- 进程内用 `OnceLock<Mutex<()>>` 串行化「读-改-写」，调度循环执行任务期间不持锁。

示例（省略外层 `{ "version": 1, "tasks": [...] }` 包装，只展示单条任务结构）：

```json
[
  {
    "id": "e1f1…",
    "name": "工作日晨间开发环境",
    "enabled": true,
    "timezone": "Asia/Shanghai",
    "schedule": { "kind": "cron", "expression": "30 9 * * 1-5" },
    "target": {
      "kind": "projectProfile",
      "projectName": "TerminalBuddy",
      "profileId": "3d2c…",
      "autoCloseMinutes": 0
    },
    "notify": true,
    "timeoutMinutes": 30,
    "createdAt": 1763340000000,
    "updatedAt": 1763340000000,
    "lastScheduledAt": 1763340600000
  },
  {
    "id": "a7b2…",
    "name": "每日提交汇总",
    "enabled": true,
    "timezone": "Asia/Shanghai",
    "schedule": { "kind": "cron", "expression": "0 18 * * 1-5" },
    "target": {
      "kind": "agentPrompt",
      "projectName": "TerminalBuddy",
      "agent": "claude",
      "providerId": "llm:9c0e…",
      "model": "deepseek-chat",
      "prompt": "汇总今天本项目的 git 提交，按模块列出改动要点，不要修改任何文件。"
    },
    "notify": true,
    "timeoutMinutes": 20
  }
]
```

## 4. 调度设计

### 4.1 依赖

`src-tauri/Cargo.toml` 新增：

```toml
cron = "0.15"        # 5 段 Cron 解析与 next/after 计算
chrono-tz = "0.10"   # IANA 时区，避免 Docker 容器默认 UTC 导致 8 小时偏差
```

两者都基于 `chrono 0.4`，与现有依赖树兼容。

### 4.2 时区

- 任务显式保存 `timezone`（IANA 名称）。
- 新建任务时前端用 `Intl.DateTimeFormat().resolvedOptions().timeZone` 作为默认值，用户可改。
- 后端用 `chrono_tz::Tz` 解析；无效时区在保存阶段拒绝。
- Cron 在任务时区下求值，跨 DST 的重复/跳过小时按 `chrono-tz` 语义处理。
- Docker 部署不再依赖容器 `TZ` 环境变量。

### 4.3 调度循环

单例后台任务：

```rust
pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) { return; }
    async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(30));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if paused() { continue; }
            let now = Utc::now();
            for task in collect_due(now) {   // 内部已推进 lastScheduledAt
                dispatch(app.clone(), task, Trigger::Scheduled);
            }
        }
    });
}
```

- tick 间隔 30 秒，触发精度 ±30 秒。
- 每轮重新读 `tasks.json`，Web/桌面修改任务后无需重启调度器。
- 启动入口：
  - 桌面端：`desktop.rs` 的 `setup` 中，状态注册完成后调用 `scheduled_task_service::start(app.handle().clone())`。
  - 服务端：`server_main.rs` 在 `AppHandle::new()` 与 `set_app_handle` 之后调用。
- 单例保护用 `AtomicBool`，避免热重载/重复初始化。

### 4.4 计算到期任务（纯函数，便于测试）

```rust
fn due_occurrence(task: &ScheduledTask, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let tz: Tz = task.timezone.parse().ok()?;
    let anchor = task.last_scheduled_at
        .map(|ms| Utc.timestamp_millis_opt(ms).unwrap())
        .unwrap_or_else(|| Utc.timestamp_millis_opt(task.created_at).unwrap());

    let mut next = next_after(&task.schedule, anchor, tz)?; // 按 tz 求值后转 UTC
    if next > now { return None; }

    // 应用长时间停机：只考虑宽限期内的最后一次，避免一次补跑几十次。
    while let Some(after) = next_after(&task.schedule, next, tz) {
        if after > now { break; }
        next = after;
    }
    (now - next <= GRACE).then_some(next)   // GRACE = 5 分钟
}
```

处理规则：

1. 到期后先把 `lastScheduledAt = 该次计划时刻` 落盘，再执行；即使执行失败也不会在同一时刻重复触发。
2. 停机超过 5 分钟的错过时刻直接跳过，不补跑。
3. `Once` 任务消费后自动置 `enabled = false`；若错过宽限期，也置 false 并记录一条 `skipped`。
4. 创建任务 / 修改调度表达式 / 重新启用时，把 `lastScheduledAt` 重置为当前时刻，避免「一保存就立刻触发」。
5. 仅修改名称、Prompt、供应商等不重置锚点。

### 4.5 并发控制

- 单任务：内存 `HashSet<taskId>` 标记运行中；同一任务重叠时 `skipped`（MVP 只有 `skip` 策略，模型保留 `concurrency` 字段供未来扩展）。
- 全局：最多 3 个定时任务同时执行；超出时记录 `skipped`。
- 手动运行与计划运行共用同一套并发判断。
- 同一任务手动运行 5 秒内去重，防止连点。

### 4.6 下次运行时间

- `list_scheduled_tasks` 返回时实时计算 `nextRunAt`：从 `lastScheduledAt`（或当前时刻）求下一次。
- `preview_schedule(expression, timezone, count)` 返回未来 N 次时间，供前端表单预览。前端不重复实现 Cron 语义。
- `Once` 的 `nextRunAt` 由 `runAt` + 时区直接换算。

## 5. 执行器

所有执行统一走：

```rust
async fn dispatch(app: AppHandle, task: ScheduledTask, trigger: Trigger) {
    let run = new_run(&task, trigger);       // 先写 running 记录
    emit_run(&app, &run, &task);
    let outcome = match &task.target {
        TaskTarget::ProjectProfile { .. } => run_profile(&app, &task, &run).await,
        TaskTarget::AgentPrompt { .. } => run_agent(&app, &task, &run).await,
    };
    finish_run(&task, &run, outcome);
    emit_run(&app, &run, &task);
    notify_if_needed(&app, &task, &run);
    RUNNING.remove(&task.id);
}
```

### 5.1 Agent 任务

执行步骤：

1. **解析项目**：按 `projectName` 查 `projects.json`；项目不存在 / 路径不是绝对路径 / 目录不存在 → `failed`，消息「项目已删除或路径不可用」。
2. **校验供应商与模型**：调用 `ai_catalog_service::selection(agent, providerId, model)`；已被删除或模型停用 → `failed`，消息「所选供应商或模型不可用，请编辑任务」。
3. **创建原生会话**：
   ```rust
   let owner = crate::commands::ai_chat::desktop_owner();
   let session = ai_chat_service::create(&owner, CreateAiSession {
       provider, provider_id, project_path, model,
       resume_session_id: None,
   })?;
   ```
   会话创建会广播 `ai-session-created`，桌面端自动追加一个聊天标签（不抢焦点），用户可实时打开查看。
4. **发送 Prompt**：
   ```rust
   ai_chat_service::send(&session.id, &owner, SendAiMessage {
       text: prompt,
       request_id: Uuid::new_v4().to_string(),
       steer: false,
       images: Vec::new(),
   })?;
   ```
   Prompt 只进入 CLI stdin，不拼 Shell 命令，不存在命令注入。
5. **轮询回合状态**（每 5 秒，`spawn_blocking` 调 `ai_chat_service::get`）：
   - `running` / `background`：继续等待。
   - `idle`：回合结束 → `completed`。
   - `approval`：→ `waitingApproval`，发布一次「等待确认」通知，继续轮询；用户回答后回到 `running`。
   - `error` / `interrupted`：→ `failed`。
   - 超过 `timeoutMinutes`：调用 `ai_chat_service::stop` → `timeout`。
6. **收尾**：
   - 摘要取最后一条 assistant 消息，截断 500 字符；失败时取 `session.error`。
   - 本轮 token 取 `session.usage.last_turn`。
   - 调用新增的 `ai_chat_service::release_process(sessionId, owner)`：空闲时发送 `Control::Retire`，**保留会话记录，只回收常驻 CLI 进程**。否则每次定时运行都会留下一个常驻 Claude 进程，按小时任务会迅速堆积。
   - 记录 `sessionId`，前端运行记录可直接打开对应聊天标签。

`release_process` 是 `ai_chat_service` 需要新增的唯一公开函数，语义与 `delete` 的进程回收部分一致，但不动会话文件。

### 5.2 项目 Profile 任务

1. 解析项目；确认 `ProfileService::get_profile(profileId)` 存在，且 `profile.group == projectName`（空 group 视为「默认」）。
2. `spawn_blocking` 调用：
   ```rust
   let ts = app.state::<TerminalService>();
   let terminal_id = ts.create_terminal(
       &profile_id,
       Some(&format!("定时 · {}", task.name)),
       None, None,
       0, 0,
       Some(&project.path),   // 以项目根为启动目录
       false,
       app.clone(),
       owner, creator,
   )?;
   ```
   - `owner`：桌面端 `TerminalOwner::Pc`，服务端 `TerminalOwner::Web`（这样手机端能看到）。
   - `creator`：桌面端 `TerminalCreator::Desktop`，服务端也用 `Desktop`（服务端是电脑，不是手机；`Mobile` 只用于 User-Agent 判定为手机的创建请求）。
3. 创建成功后主动广播 `terminal-created`：
   ```json
   {
     "id": "…",
     "profileId": "…",
     "profileName": "定时 · 工作日晨间开发环境",
     "terminalType": "cmd",
     "owner": "pc",
     "groupName": "TerminalBuddy",
     "activate": false
   }
   ```
   `activate: false` 保证凌晨任务不抢焦点、不切走用户当前标签。桌面端已有该事件处理器，会自动把标签放进对应项目分组。
4. 记录 `status = "started"`、`terminalId`，消息「终端已启动」。
5. `autoCloseMinutes > 0` 时起一个定时器，到点调用 `teardown_terminal(&app, &terminal_id, TerminalCloseReason::ScheduledClose)`。需要给 `TerminalCloseReason` 增加 `ScheduledClose` 变体，日志更准确。
6. Profile 是 SSH / Docker / K8s / MSTSC 时照常启动，不额外限制；凭据与连接参数沿用现有 Profile 流程。

### 5.3 失败与边界

| 场景 | 行为 |
| --- | --- |
| 任务被删除时正在运行 | 运行继续；完成后写历史到已删除任务的文件会失败，忽略并日志 |
| 项目被删除 | `failed`，提示编辑任务 |
| Profile 被删除 | `failed`，提示重新选择 |
| 供应商/模型被删除 | `failed`，提示重新选择 |
| 数据目录不可用 | 调度 tick 打日志，下轮重试；不 panic |
| 应用退出时 Agent 仍在跑 | `runtime::shutdown` 现有逻辑会 stop/retire，与手动会话一致 |
| 同一任务重叠 | `skipped` |
| 服务器 UTC 容器 | 任务自带时区，不受影响 |

## 6. 通知与事件

### 6.1 前端事件

新增 Tauri/EventBus 事件 `scheduled-task-run`：

```json
{
  "taskId": "…",
  "run": { "...": "ScheduledRun 全量" },
  "task": { "...": "ScheduledTaskView 精简信息" }
}
```

触发时机：开始执行、状态变为 `waitingApproval`、结束。前端监听后：

- 定时任务页面打开时立即刷新列表；
- 非页面场景用现有 `showToast` 提示（仅在应用窗口可见/托盘模式下，避免骚扰）。

### 6.2 App 通知通道

`AppNotificationService` 是安卓端 `/ws/notifications` 的数据源。新增通知类型：

- `scheduled_completed`
- `scheduled_failed`
- `scheduled_approval`

`AppNotificationEvent` 增加可选字段（全部 `#[serde(default)]`，保持旧客户端兼容）：

```rust
pub task_id: Option<String>,
pub run_id: Option<String>,
pub session_id: Option<String>,
```

标题 / 摘要：

- 完成：「定时任务完成：{name}」/ Agent 摘要前 120 字。
- 失败：「定时任务失败：{name}」/ 错误原因。
- 等待确认：「定时任务等待确认：{name}」/ 点击打开对应会话。

安卓端对未知 kind 的兼容策略需要确认；旧版本会忽略或展示通用通知，不影响主流程。

### 6.3 系统通知（Windows）

桌面端窗口最小化/托盘时，复用现有 `tauri-winrt-notification` 链路新增命令：

```rust
show_scheduled_task_notification(task_id, run_id, session_id, title, body)
```

点击后唤起主窗口并发出 `scheduled-task-notification-activated`，前端按 `sessionId` 打开聊天标签或定位到运行记录。仅 Windows 桌面端实现，其他平台静默跳过。

### 6.4 权限询问

- 定时 Agent 任务默认沿用「Agent 管理」里的基础启动命令。Claude 默认 `--dangerously-skip-permissions`、Codex 默认 `--dangerously-bypass-approvals-and-sandbox`，因此默认可以无人值守执行。
- 如果用户把基础命令改成了需要确认的模式，任务会停在 `waitingApproval`：不自动批准、不假装成功，发布通知并保留现场，等待用户打开会话回答。
- 不提供「自动同意所有权限」开关，避免把危险操作变成默认行为。

## 7. 后端改造清单

### 7.1 新增文件

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/models/scheduled_task.rs` | 数据模型、校验、默认值 |
| `src-tauri/src/services/scheduled_task_service.rs` | 存储、Cron、调度循环、执行器、运行记录 |
| `src-tauri/src/commands/scheduled_task.rs` | Tauri 命令薄包装 |

### 7.2 修改文件

| 文件 | 改动 |
| --- | --- |
| `src-tauri/Cargo.toml` | 增加 `cron`、`chrono-tz` |
| `src-tauri/src/models/mod.rs` | 导出 `scheduled_task` |
| `src-tauri/src/services/mod.rs` | 导出 `scheduled_task_service` |
| `src-tauri/src/commands/mod.rs` | 导出 `scheduled_task` |
| `src-tauri/src/desktop.rs` | `invoke_handler![]` 注册命令；`setup` 启动调度器 |
| `src-tauri/src/server_main.rs` | 启动调度器 |
| `src-tauri/src/web/handlers/desktop_dispatch.rs` | 增加命令白名单分支（浏览器模式） |
| `src-tauri/src/services/ai_chat_service.rs` | 新增 `release_process` |
| `src-tauri/src/commands/terminal.rs` | `TerminalCloseReason::ScheduledClose` |
| `src-tauri/src/services/app_notification_service.rs` | 定时任务通知类型与字段（可与 P1 一起） |
| `src-tauri/src/commands/notification.rs` | 定时任务系统通知（P1） |

### 7.3 命令 / API

Tauri 命令与 `/api/desktop/invoke/:command` 同名同参：

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `scheduled_task_list` | — | `Vec<ScheduledTaskView>` |
| `scheduled_task_save` | `input: ScheduledTaskInput` | `ScheduledTaskView` |
| `scheduled_task_delete` | `id` | `()` |
| `scheduled_task_set_enabled` | `id`, `enabled` | `ScheduledTaskView` |
| `scheduled_task_run_now` | `id` | `ScheduledRun` |
| `scheduled_task_stop` | `id` | `()`（仅 Agent 运行中） |
| `scheduled_task_runs` | `id`, `limit?` | `Vec<ScheduledRun>` |
| `scheduled_task_options` | — | `{ projects, profiles, catalog }` |
| `scheduled_task_preview` | `expression`, `timezone`, `count?` | `Vec<i64>` |

`ScheduledTaskInput`：

```rust
pub struct ScheduledTaskInput {
    pub id: Option<String>,       // None = 新建
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
```

`options` 返回三项，避免前端拼装多套接口：

- `projects`：`get_projects()`。
- `profiles`：`get_all_profiles()`。
- `catalog`：`ai_catalog_service::catalog()`（含 `default:claude` / `default:codex`）。

### 7.4 校验规则

保存时统一校验：

- 名称 1–40 字符，去除首尾空白，不允许控制字符。
- 任务总数 ≤ 200。
- 时区可被 `chrono_tz::Tz` 解析。
- Cron 可解析且未来 5 年内至少有一次触发（`Schedule::after(now).next().is_some()`）。
- `Once.runAt` 可被 `NaiveDateTime` 解析，且不早于当前时刻 1 分钟。
- `ProjectProfile`：项目存在；Profile 存在；`profile.group` 与项目名一致。
- `AgentPrompt`：项目存在；`agent` ∈ {claude, codex, antigravity}；Claude / Codex 需 `selection(agent, providerId, model)` 成功，Antigravity 固定清空供应商与模型；Prompt 非空 ≤ 8000 字符。
- `timeoutMinutes` 1–240；`autoCloseMinutes` 0–1440。

项目范围：不接受任意绝对路径，只接受 `projects.json` 里的项目名。这样 Web 端即使拿到登录态，也不能把 Agent 指到任意目录。

## 8. 前端设计

> 可交互 HTML 预览：
> - `design/scheduled-tasks/preview.html`：独立工作区页面、编辑器、运行记录。
> - `design/scheduled-tasks/statusbar-preview.html`：底部状态栏快捷入口（直接打开页面，无浮层）。
>
> 直接双击用浏览器打开即可；顶部工具条可切换浅色/深色与不同状态。
> 页面锚点：`#editor`（Agent 任务）、`#editor-profile`（项目配置）、`#editor-cron`（自定义 Cron）、`#editor-weekly`（每周）、`#editor-once`（仅一次）、`#runs`（运行记录）、`#empty`（空状态）；追加 `?theme=light` 查看浅色主题。
> 状态栏锚点：`#running`（运行中）、`#empty`（无任务）。

### 8.1 入口与页面形态

定时任务是一个**独立工作区页面**，与 Git 历史、未提交变更同级，不放入设置页。

- `WorkspaceSpecialTab` 增加 `'scheduled-tasks'`。
- `appStore` 增加 `scheduledTasksTabOpen`、`openScheduledTasksPage()`、`closeScheduledTasksPage()`。
- `TerminalPanel` 在 `activeSpecialTab === 'scheduled-tasks'` 时渲染 `ScheduledTasksPage`。
- 关闭标签导航时：`TerminalTabBar` 显示「定时任务」标签。
- 开启标签导航时：左侧 `TabNav` 的「工具」分组显示「定时任务」条目（页面打开时）。
- 页面头部提供关闭按钮，与标签关闭等价。
- 底部状态栏「定时」入口直接调用 `openScheduledTasksPage()`，不弹浮层；页面已打开时从其他标签切回。

### 8.2 页面布局

页面占据主内容区：顶部是工作区标签（「定时任务」），底部是应用状态栏。

```
┌ 定时任务 ───────────────────────────────────────────────┐
│ 按计划自动启动项目环境或执行 Agent 任务。      [暂停全部] [新建任务] │
├─────────────────────────────────────────────────────────┤
│ ● 工作日晨间开发环境                          [开关]  ⋮   │
│   Claude · DeepSeek · deepseek-chat                        │
│   每天 09:30（Asia/Shanghai） · 下次 2 小时后              │
│   上次：今天 09:30 已完成 · 12s                            │
├─────────────────────────────────────────────────────────┤
│ ○ 每日提交汇总                                [开关]  ⋮   │
│   项目 TerminalBuddy · Claude · 默认供应商                 │
│   工作日 18:00 · 下次 明天 18:00                           │
│   上次：昨天 18:00 失败（供应商已删除）                    │
└─────────────────────────────────────────────────────────┘
```

每行操作（右键菜单或 `⋮`）：编辑、立即运行、运行记录、复制、删除。

空状态给出示例按钮：

- 「每天 09:30 启动开发环境」
- 「工作日 18:00 用 DeepSeek 汇总提交」

### 8.3 新建 / 编辑对话框

分三块：

1. **基本信息**：名称、启用、通知开关。
2. **执行内容**（Tab 二选一）：
   - **项目配置**
     - 项目下拉（`projects`）。
     - 配置下拉：只列 `profile.group === 项目名` 的 Profile；显示终端类型、启动命令首条、路径。
     - 自动关闭：0 = 保持运行 / 30 / 60 / 120 分钟。
   - **Agent 任务**
     - 项目下拉。
     - Agent 分段选择（Claude / Codex / Antigravity），按项目 `enabledAgents` 过滤。
     - 供应商下拉 + 模型下拉：来自 `catalog`，Agent 过滤；包含「服务端默认配置」。
     - Antigravity 不显示供应商 / 模型，固定使用 Google 账号与「Agent 管理」中的基础启动命令，按终端接力执行。
     - 任务描述 textarea（带字数）。
     - 超时分钟（默认 30）。
     - 提示：定时任务会以当前 Agent 基础启动命令运行；若该命令需要确认，任务会停在「等待确认」。
3. **触发时间**
   - 重复方式：每天 / 工作日 / 每周 / 每小时 / 自定义 Cron / 仅一次。
   - 时间选择器、星期多选、Cron 输入框。
   - 时区下拉，默认浏览器时区。
   - 预览：「接下来 5 次：…」，300ms 防抖调用 `scheduled_task_preview`。
   - 非法表达式就地报错，禁用保存。

底部：「取消」「保存」「保存并立即运行」。

### 8.4 运行记录

点击「运行记录」打开抽屉/对话框：

| 开始时间 | 触发 | 状态 | 耗时 | 摘要 / 错误 | 操作 |
| --- | --- | --- | --- | --- | --- |
| 11-17 09:30 | 计划 | 已完成 | 42s | 已汇总 6 个提交 | 打开会话 |
| 11-16 18:00 | 计划 | 失败 | 3s | 供应商已删除 | 编辑任务 |

- `sessionId` 存在时「打开会话」：调用 `openExistingAgentSession` / 切到对应标签。
- `terminalId` 存在时「查看终端」：切到对应终端标签；若已关闭则提示。
- 运行中显示 `running` 和「停止」按钮（仅 Agent）。

### 8.5 底部状态栏快捷入口

在 `AppStatusBar` 右侧组、Web 状态与资源读数之间新增「定时」入口：

```
[会话/Agent/目录/Git]                  [Web] [定时 3 · 18:00] [CPU] [内存] [14:32] [v1.9.0]
```

- 图标：`CalendarClock`，与本地时间 `Clock3` 区分。
- 有启用任务时显示数量 badge 与下次运行时间；有任务运行中时显示脉冲点；有待确认时显示警示点。
- 无任务时仍保留入口（灰字「定时」），点击打开页面空状态。
- **左键直接调用 `openScheduledTasksPage()`**：
  - 页面未打开 → 打开并显示。
  - 页面已打开但在其他标签 → 切回页面。
  - 页面已激活 → 保持当前页面。
- 不弹浮层；运行 / 停止 / 新建 / 编辑全部在独立页面完成。
- 数据由 `useScheduledTasksStatus` 提供：挂载时加载、30 秒轮询、监听 `scheduled-task-run` / `scheduled-tasks-changed` 立即刷新。
- 窄屏（≤720px）只保留图标与状态点/数量，隐藏文字与时间。
- 页面激活时入口使用 `active` 背景，`aria-current="page"`。

详细交互与实现见 `implementation-plan.md` §4.3，预览见 `statusbar-preview.html`。

### 8.6 前端文件

| 文件 | 内容 |
| --- | --- |
| `src/types/scheduledTask.ts` | TS 类型与状态文案 |
| `src/services/tauri/scheduledTasks.ts` | invoke 包装 |
| `src/services/tauri/index.ts` | 导出 |
| `src/utils/scheduledTaskFormat.ts` | 调度 / 状态 / 下次运行文案 |
| `src/hooks/useScheduledTasksStatus.ts` | 状态栏数据轮询与事件刷新 |
| `src/components/scheduled-tasks/ScheduledTasksPage.tsx` | 独立工作区页面 |
| `src/components/scheduled-tasks/ScheduledTasksPage.css` | 页面样式 |
| `src/components/scheduled-tasks/ScheduledTaskDialog.tsx` | 新建 / 编辑 |
| `src/components/scheduled-tasks/ScheduledTaskRunsDialog.tsx` | 运行记录 |
| `src/components/terminal/TerminalPanel.tsx` | 渲染独立页面 |
| `src/components/terminal/TerminalTabBar.tsx` | 顶部标签入口 |
| `src/components/shell/TabNav.tsx` | 左侧「工具」分组入口 |
| `src/components/shell/ScheduledTasksStatusEntry.tsx` | 状态栏入口 |
| `src/components/shell/ScheduledTasksStatusEntry.css` | 状态栏入口样式 |
| `src/components/shell/AppStatusBar.tsx` | 挂载快捷入口 |
| `src/stores/appStore.ts` | special tab 类型与页面开关 |
| `src/App.tsx` 或新 hook | 监听 `scheduled-task-run` 刷新/提示 |

TypeScript 严格模式注意 `noUnusedLocals` / `noUnusedParameters`；所有文案使用简体中文。

## 9. 安全与权限

- 管理入口：
  - 桌面端：Tauri command，天然受本机用户权限约束。
  - 浏览器：必须登录（JWT），走 `desktop_dispatch` 白名单；未认证请求在路由层被拒。
- 项目范围：任务只能引用 `projects.json` 中已登记的项目，禁止传入任意路径。
- Prompt 不经过 Shell：只写入 CLI stdin。
- Profile 启动沿用现有 `reject_control_chars`、Claude 引用展开、Hook 注入与路径校验。
- 资源上限：最多 200 个任务、全局同时 3 个执行、单任务超时 ≤ 240 分钟、Prompt ≤ 8000 字符、Cron 最小粒度 1 分钟。
- 不记录 API Key / 密码；运行记录只保存任务名、状态、摘要与 token 数。
- 手动运行有 5 秒去重，防止接口被刷导致进程风暴。

## 10. 测试计划

### 10.1 Rust 单元测试（`cargo test --lib`）

- `cron_next_run_uses_task_timezone`：同一表达式在 `Asia/Shanghai` 与 `UTC` 下结果相差 8 小时。
- `missed_occurrence_outside_grace_is_skipped`：停机 2 天后不补跑，锚点推进到最近一次。
- `hourly_task_does_not_burst_after_downtime`：停机期间多个时刻只处理一次。
- `once_task_disables_after_consumption`。
- `invalid_cron_and_timezone_are_rejected`。
- `save_rejects_unknown_project_profile_provider`。
- `runs_are_capped_at_100`。
- `next_run_is_monotonic_after_edit`：改调度后从当前时刻重新计算，不立即触发。
- `manual_run_dedup_within_five_seconds`（用注入时钟）。
- `concurrency_skip_policy`。

### 10.2 手工验收

1. 创建「项目配置」任务，设 2 分钟后执行，关闭应用 → 不执行；保持托盘运行 → 到点创建终端且不抢焦点。
2. 创建 Agent 任务，选 `DeepSeek` + 模型，立即运行：聊天标签出现、执行完成、运行记录有 token 与摘要、CLI 进程被回收（任务管理器确认）。
3. 把 Agent 基础命令改成需要确认，运行后在 `waitingApproval` 停住并收到通知；打开会话回答后任务完成。
4. Docker 服务端创建任务，时区选 `Asia/Shanghai`，容器为 UTC，验证执行时间正确。
5. 修改系统时间 / 停机跨过触发点，验证不重复、不爆发。
6. 删除项目 / Profile / 供应商后运行，验证失败原因可读。

### 10.3 类型与编译检查

按 AGENTS.md 验证顺序：

```bash
cd terminal-buddy && npx tsc --noEmit
cd src-tauri && cargo check
cd src-tauri && cargo test --lib
cd terminal-buddy && python scripts/check-invoke-coverage.py
```

## 11. 分阶段实施

### P0（MVP，建议一次交付）

1. `Cargo.toml` 依赖 + 数据模型 + 存储 + 校验。
2. Cron / 时区 / 到期计算 + 调度循环 + 并发控制。
3. Agent 执行器 + `ai_chat_service::release_process`。
4. Profile 执行器 + `ScheduledClose` + `terminal-created` 广播。
5. 命令层 + 桌面注册 + Web dispatch。
6. 独立工作区页面、编辑器、运行记录、立即运行。
7. Rust 单元测试 + 手工验收。

### P1

- App 通知通道与 Windows 系统通知。
- 全局暂停、任务复制、任务导入导出。
- Android 完整界面的入口与通知跳转。

### P2

- 错过补跑（可选开关）。
- Shell 命令任务（项目目录 + 命令 + 退出码）。
- 多目标任务、任务依赖、间隔触发（每 N 分钟，不与 Cron 混用）。
- Git 事件 / Webhook 触发。

## 12. 待确认的问题

1. **桌面端退出后是否必须继续执行？** 本设计的答案是「不」，需要常驻请用 Docker 服务端。若必须，需另做 Windows 计划任务 / 服务方案。
2. **定时 Agent 任务结束后是否回收 CLI 进程？** 本设计默认回收（保留会话记录），否则按小时任务会堆积常驻进程。
3. **项目配置任务是否需要知道命令退出码？** PTY 不提供退出码，本设计只标记「已启动」。若需要退出码，应改为无终端命令执行器（P2 的 Shell 命令任务）。
4. **是否允许自动批准 Agent 权限询问？** 本设计默认不允许，停在等待确认并通知。
5. **运行记录保留多少？** 本设计每任务 100 条，是否够用。
