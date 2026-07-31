# TerminalBuddy → 运维 Agent 编排器(扩展设计草案)

**状态**:草案 — 已完成澄清与 3 段设计(架构 / 数据模型 / 组件接口),尚未完成数据流 / 错误处理 / 测试三段。
**暂停原因**:用户明确指示"先保存调研,暂不推进",待后续继续。
**关联**:参照 multica-ai/multica(开源 managed agents platform),但采用差异化路线。

---

## 0. 核心澄清决策(已确认)

通过 brainstorming skill 的"一次一个澄清问题"流程,与用户达成 9 项关键决策:

| # | 维度 | 决策 | 备注 |
|---|---|---|---|
| 1 | 核心路线 | **Multica 路线**(管理现有 CLI 子进程,**不接 LLM**) | 复用现有 Claude Hook,避开自建 LLM SDK 复杂度 |
| 2 | 完整方向 | **方向 C:运维 Agent 编排**(差异化) | 避开 Multica 的 coding agent 战场,复用 SSH/Docker/K8s/MSTSC 优势 |
| 3 | 部署形态 | **本机自用 + Web 远程查看** | 复用现有 axum + JWT,Web 端只读 |
| 4 | Agent 形态 | **Agent = 运行时包装**(零迁移) | Profile 仍是单一事实源,Task 运行时拉取 profile + skill 实例化 |
| 5 | 任务内容 | **Task = Skill 引用 + Profile** | 不引入自由 prompt,跟"不接 LLM"一致 |
| 6 | 触发器 | **手动 + Cron + Server Monitor 事件源** | Server Monitor 触发是 TerminalBuddy 最强差异化(Multica 没有) |
| 7 | 状态机 | **5 态 + cancelled**(复用现有 phase) | `queued → running → succeeded / failed / timeout / cancelled` |
| 8 | Skill 字段 | **CommandTemplate + 6 新字段**(含任务拓扑雏形) | required_profile_type / parameters / timeout_ms / retry_count / on_success_skill_id / on_failure_skill_id |
| 9 | UI 形态 | **Kanban 看板** | 5 列:queued / running / succeeded / failed / timeout+cancelled |

**未决项**:Web SPA 是否要做任务看板(目前方案仅 PC 端 web 端只读查看)。Server Monitor 阈值规则的更详细形态(简单阈值 vs 表达式)留待第 4 段设计。

---

## 1. 架构概览(已确认)

### 1.1 核心思想

**新增四块模块,围绕"Task 是一等公民"组织。**

```
┌─────────────────────────────────────────────────────────────────┐
│                      前端层 (React)                              │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │  TaskCenter  │  │ TriggerPanel   │  │  SkillEditor       │  │
│  │  (Kanban)    │  │ (Cron/Monitor) │  │  (升级版模板)       │  │
│  └──────────────┘  └────────────────┘  └────────────────────┘  │
└─────────────────────────────┬───────────────────────────────────┘
                              │ invoke + listen
┌─────────────────────────────▼───────────────────────────────────┐
│                    Tauri 命令层 (新增)                            │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │ task_command │  │ trigger_command│  │ agent_skill_command│  │
│  │ (CRUD+执行)  │  │ (Cron/Monitor) │  │ (升级版模板 CRUD)   │  │
│  └──────────────┘  └────────────────┘  └────────────────────┘  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                    服务层 (新增 + 复用)                            │
│  ┌──────────────────┐  ┌────────────────┐  ┌─────────────────┐ │
│  │ task_service     │  │ trigger_service│  │ skill_service   │ │
│  │ 调度 / 状态机    │  │ Cron / Monitor │  │ 模板 / 参数     │ │
│  └──────────────────┘  └────────────────┘  └─────────────────┘ │
│  复用:TerminalService + SshSessionService + ServerMonitor       │
│       + ProfileService + CommandTemplate (升级)                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                    数据层 (新增 + 复用)                            │
│  新增:<data_dir>/Tasks/<task_id>.json                            │
│  新增:<data_dir>/Tasks/<task_id>/runs/<run_id>.json             │
│  新增:<data_dir>/Triggers/<trigger_id>.json                      │
│  升级:command_templates.json 字段扩展(Skill 升级)                │
│  复用:Profiles/, settings.json(加 enable_agent 开关)             │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 新增 / 复用 / 升级 清单

| 类别 | 模块 | 改动量 |
|---|---|---|
| 新增 | `commands/task.rs` | ~300 行 |
| 新增 | `commands/trigger.rs` | ~150 行 |
| 新增 | `commands/agent_skill.rs` | ~150 行 |
| 新增 | `services/task_service.rs` | ~500 行 |
| 新增 | `services/trigger_service.rs` | ~250 行 |
| 新增 | `services/skill_service.rs` | ~150 行 |
| 新增 | `models/task.rs` | ~150 行 |
| 新增 | `models/trigger.rs` | ~80 行 |
| 新增 | `models/agent_skill.rs` | ~80 行 |
| 复用 | `TerminalService` | 零改动,通过现有 API 调用 |
| 复用 | `SshSessionService` | 零改动 |
| 复用 | `ServerMonitor` | 零改动 |
| 复用 | `ProfileService` | 零改动 |
| 升级 | `command_templates.json` schema | 加 6 字段,旧 JSON 兼容 |
| 升级 | `settings.json` | 加 `enable_agent: bool` 默认 false |
| 升级 | `WsServerMessage` | 加 `TaskUpdate` variant |
| 新增前端 | `TaskCenter.tsx` (Kanban) | ~400 行 |
| 新增前端 | `TriggerPanel.tsx` | ~200 行 |
| 新增前端 | `SkillEditor.tsx` | ~250 行 |
| 新增前端 | `stores/taskStore.ts` | ~150 行 |

**总新增代码量估计:约 2700 行 Rust + 1000 行 TS**,零迁移、零破坏性改动。

---

## 2. 数据模型(已确认)

### 2.1 `Task` 模型

存于 `<data_dir>/Tasks/<task_id>.json`,**每任务一个文件**。

```rust
pub struct Task {
    pub id: String,
    pub name: String,
    pub skill_id: String,
    pub profile_id: String,
    pub parameters: HashMap<String, String>,
    pub triggers: Vec<TriggerRef>,
    pub phase: TaskPhase,
    pub last_run_at: Option<String>,
    pub last_run_id: Option<String>,
    pub next_run_at: Option<String>,
    pub stats: TaskStats {
        total_runs: u32,
        succeeded_runs: u32,
        failed_runs: u32,
        timeout_runs: u32,
        cancelled_runs: u32,
    },
    pub created_at: String,
    pub updated_at: String,
    pub enabled: bool,
}

pub enum TaskPhase {
    Queued,
    Running,
    Succeeded,
    Failed,
    Timeout,
    Cancelled,
}
```

### 2.2 `TaskRun` 模型(执行历史)

存于 `<data_dir>/Tasks/<task_id>/runs/<run_id>.json`,**每次执行一个文件**。

```rust
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub terminal_id: Option<String>,         // 运行结束后保留 1h
    pub trigger_source: TriggerSource,       // Manual | Cron | MonitorEvent
    pub trigger_meta: Option<HashMap<String, String>>,
    pub phase: TaskPhase,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub log_path: String,                    // <data_dir>/Tasks/<task_id>/runs/<run_id>.log
    pub artifacts: Vec<TaskArtifact>,
    pub retry_count: u32,
    pub error: Option<String>,
}
```

### 2.3 `Trigger` 模型

存于 `<data_dir>/Triggers/<trigger_id>.json`。

```rust
pub struct Trigger {
    pub id: String,
    pub task_id: String,
    pub kind: TriggerKind,
    pub enabled: bool,
    pub created_at: String,
}

pub enum TriggerKind {
    Manual,
    Cron {
        expression: String,                  // 标准 5 字段 cron
        timezone: String,                    // IANA
        catch_up_missed: bool,
    },
    Monitor {
        profile_id: String,
        metric: MonitorMetric,               // CpuPercent | MemPercent | DiskPercent | NetRxKbps | NetTxKbps
        threshold_op: ThresholdOp,           // Gt | Lt | Gte | Lte
        threshold_value: f64,
        cooldown_seconds: u32,
    },
}
```

### 2.4 Skill 模型升级(在 `command_templates.json` 现有 schema 扩展)

**保留所有现有字段,加 6 个新字段**(旧 JSON 无新字段时取默认值)。

```rust
pub struct Skill {
    // 现有字段(保留)
    pub category: String,
    pub commands: Vec<CommandItem>,

    // 新增 6 字段
    pub required_profile_type: Vec<String>,  // e.g. ["ssh", "k8s"]
    pub parameters: Vec<SkillParameter>,
    pub timeout_ms: Option<u64>,             // 默认 600_000
    pub retry_count: Option<u32>,            // 默认 0,上限 5
    pub on_success_skill_id: Option<String>, // 单跳,非 DAG
    pub on_failure_skill_id: Option<String>,
}

pub struct SkillParameter {
    pub name: String,
    pub label: String,
    pub default: Option<String>,
    pub required: bool,
    pub kind: ParamKind,                     // String | Int | Bool | Enum(Vec<String>)
}
```

**命令渲染逻辑**:
```
rendered_command = skill.commands[0].command
  .replace("{{namespace}}", task.parameters["namespace"] ?? skill_param.default)
```

### 2.5 `TaskArtifact` 模型

```rust
pub struct TaskArtifact {
    pub name: String,
    pub local_path: String,                  // <data_dir>/Tasks/<task_id>/runs/<run_id>/<name>
    pub size_bytes: u64,
    pub mime: Option<String>,
}
```

**自动捕获规则**:Skill 在 `commands[0]` 加 `> /path/to/artifact.log` 重定向时,后端把目标文件自动登记为 artifact。

### 2.6 与现有模型关系

```
┌──────────┐   profile_id   ┌──────────┐
│   Task   │──────────────►│ Profile  │ (复用,零改动)
└────┬─────┘               └──────────┘
     │ skill_id
     ▼
┌──────────┐               ┌──────────────────┐
│  Skill   │               │ TerminalInstance │ (复用,零改动)
└──────────┘               └──────────────────┘
     │ on_success/on_failure              ▲
     ▼                                    │ terminal_id
┌──────────┐   trigger   ┌─────────────┐  │
│ Trigger  │───────────►│  TaskRun    │──┘
└──────────┘             └─────────────┘
                              │ log_path
                              ▼
                        <disk file>
```

**关键事实**:Task 不存任何"连接信息 / 命令模板内容",全靠 `profile_id` + `skill_id` 运行时拉取。Profile 和 Skill 仍是单一事实源。

---

## 3. 组件清单与接口(已确认)

### 3.1 后端 services 详细职责

#### `services/task_service.rs`(新增,~500 行)

```rust
impl TaskService {
    pub fn list_tasks() -> Result<Vec<Task>, String>;
    pub fn get_task(id: &str) -> Result<Task, String>;
    pub fn create_task(input: TaskCreateInput) -> Result<Task, String>;
    pub fn update_task(task: Task) -> Result<(), String>;
    pub fn delete_task(id: &str) -> Result<(), String>;

    pub fn trigger_now(id: &str) -> Result<TaskRun, String>;
    pub fn cancel_run(run_id: &str) -> Result<(), String>;
    pub fn retry_run(run_id: &str) -> Result<TaskRun, String>;

    pub fn list_runs(task_id: &str, limit: u32, offset: u32) -> Result<Vec<TaskRun>, String>;
    pub fn get_run(run_id: &str) -> Result<TaskRun, String>;
    pub fn read_run_log(run_id: &str, tail_bytes: Option<u64>) -> Result<String, String>;
    pub fn download_artifact(run_id: &str, artifact_name: &str) -> Result<Vec<u8>, String>;
}
```

**核心状态机推进**(伪代码):
```rust
async fn execute_run(task: Task, source: TriggerSource) -> TaskRun {
    let skill = skill_service.get(&task.skill_id)?;
    profile_service.assert_terminal_type_matches(&task.profile_id, &skill.required_profile_type)?;
    let cmd = skill_service.render_command(&skill, &task.parameters)?;
    let timeout_ms = skill.timeout_ms.unwrap_or(600_000);

    let terminal_id = terminal_service.start_terminal(task.profile_id.clone()).await?;
    terminal_service.write_to_terminal(&terminal_id, &cmd).await?;
    let (exit_code, log_path, timed_out) = terminal_service
        .wait_for_exit(&terminal_id, timeout_ms).await;

    let phase = match (exit_code, timed_out) {
        (Some(0), false) => Succeeded,
        (Some(c), false) if c != 0 => Failed,
        (_, true) => Timeout,
    };

    let artifacts = capture_artifacts(&cmd, &log_path);

    if phase == Succeeded && skill.on_success_skill_id.is_some() {
        chain_to_skill(task.id, skill.on_success_skill_id.unwrap()).await;
    }
    if phase == Failed && skill.on_failure_skill_id.is_some() {
        chain_to_skill(task.id, skill.on_failure_skill_id.unwrap()).await;
    }

    if phase in [Failed, Timeout] && retry_count < skill.retry_count {
        schedule_retry(task, source, retry_count + 1);
    }

    emit_task_update(task.id, phase, progress=100);

    TaskRun { /* ... */ }
}
```

#### `services/trigger_service.rs`(新增,~250 行)

```rust
impl TriggerService {
    pub fn list_cron_triggers() -> Result<Vec<Trigger>, String>;
    pub fn upsert_cron_trigger(input: CronTriggerInput) -> Result<Trigger, String>;
    pub fn delete_trigger(id: &str) -> Result<(), String>;
    pub fn next_fire_time(id: &str) -> Result<Option<String>, String>;

    pub fn list_monitor_triggers() -> Result<Vec<Trigger>, String>;
    pub fn upsert_monitor_trigger(input: MonitorTriggerInput) -> Result<Trigger, String>;

    pub async fn tick(&self) {
        for trigger in enabled_monitor_triggers() {
            let stats = server_monitor.get_server_stats(trigger.profile_id).await?;
            if evaluate_threshold(&trigger, &stats) && cooldown_elapsed(&trigger) {
                task_service.trigger_now(trigger.task_id).await;
            }
        }
    }
}
```

#### `services/skill_service.rs`(新增,~150 行)

```rust
impl SkillService {
    pub fn list_skills() -> Result<Vec<Skill>, String>;
    pub fn get_skill(id: &str) -> Result<Skill, String>;
    pub fn create_skill(input: SkillInput) -> Result<Skill, String>;
    pub fn update_skill(skill: Skill) -> Result<(), String>;
    pub fn delete_skill(id: &str) -> Result<(), String>;

    pub fn render_command(&self, skill: &Skill, params: &HashMap<String, String>) -> Result<String, String>;
    pub fn validate_parameters(&self, skill: &Skill, params: &HashMap<String, String>) -> Result<(), String>;
}
```

**存储决策**:`SkillService` 不新写文件,直接读写现有 `<data_dir>/command_templates.json`,schema 兼容升级。

### 3.2 现有服务复用点(关键路径)

| 调用 | 复用现有 API | 在哪 |
|---|---|---|
| 启动执行 PTY | `terminal_service.start_terminal(profile_id)` | `commands/terminal.rs:start_terminal` |
| 写入命令 | `terminal_service.write_to_terminal(id, &cmd)` | `commands/terminal.rs:write_to_terminal` |
| 等待退出 | **新增** `terminal_service.wait_for_exit(id, timeout_ms)` | 包装现有 reader thread,改阻塞 join + timeout |
| Server Monitor 数据 | `get_server_stats(terminal_id)` | `commands/server_monitor.rs:get_server_stats` |
| Profile 校验 | `profile_service.get_profile(id)` | `services/profile_service.rs:get_profile` |

**新增的最小 Tauri API 表面**:只为 `wait_for_exit` 新增 1 个命令。

### 3.3 前端组件清单

| 组件 | 路径 | 职责 | props / state |
|---|---|---|---|
| `TaskCenter` | `src/components/TaskCenter.tsx` | Kanban 主入口,五列布局 | `{ open: boolean; onClose: () => void }` |
| `TaskColumn` | `src/components/task/TaskColumn.tsx` | 单列卡片列表 | `{ phase: TaskPhase; tasks: Task[] }` |
| `TaskCard` | `src/components/task/TaskCard.tsx` | 单卡片 | `{ task: Task }` |
| `TaskDetailDrawer` | `src/components/task/TaskDetailDrawer.tsx` | 右侧抽屉 | `{ taskId: string }` |
| `TaskEditorDialog` | `src/components/task/TaskEditorDialog.tsx` | 新建/编辑 Task | `{ taskId?: string; open: boolean }` |
| `TriggerPanel` | `src/components/TriggerPanel.tsx` | 触发器配置 | `{ taskId: string }` |
| `SkillEditor` | `src/components/SkillEditor.tsx` | Skill 编辑 | `{ skillId?: string }` |
| `taskStore` | `src/stores/taskStore.ts` | Zustand,Task 列表 + 详情 + 日志 | (新增,持久化关闭) |

### 3.4 TitleBar 入口集成

新增 1 个 icon-button 在 `TitleBar.tsx` 左侧 nav-btn 区:
```tsx
<IconButton title="任务中心" onClick={() => setTaskCenterOpen(true)}>
  <ListChecks />
</IconButton>
```

**新增图标位**:`PanelLeft` / `Folder` / `Globe2` / `BarChart3` / **`ListChecks(新)`** / `Settings`。

### 3.5 事件总线新增

后端 emit:
```rust
emit("task-update", TaskUpdate { task_id, run_id, phase, progress, last_log_preview: String })
emit("task-created", task_id)
emit("task-deleted", task_id)
```

前端 listen:
```ts
listen<TaskUpdate>("task-update", (e) => {
  taskStore.applyUpdate(e.payload);
});
```

---

## 4. 数据流(TBD — 未完成)

待设计:手动触发 / Cron 触发 / Server Monitor 触发 / 执行中 / 重试 / 失败回滚 / 拓扑串接 的端到端时序图。

---

## 5. 错误处理与测试(TBD — 未完成)

待设计:
- SSH 掉线、超时、PTY 崩溃时的清理路径
- Server Monitor 阈值误触发的去抖策略
- Cron 表达式解析失败的反馈
- 任务并发上限(单 PC 同时跑 N 个 Task)
- 测试策略(项目无自动化测试,至少列出关键测试点)

---

## 后续工作(用户恢复时)

1. 完成第 4 段设计:数据流
2. 完成第 5 段设计:错误处理与测试
3. spec 自审(占位符、一致性、范围、歧义)
4. 用户审查 spec
5. 调用 `writing-plans` skill 生成实施计划
6. 进入实施阶段(subagent-driven-development / executing-plans)

---

## 参考来源

### Multica
- GitHub: https://github.com/multica-ai/multica
- CLI_AND_DAEMON.md: https://github.com/multica-ai/multica/blob/main/CLI_AND_DAEMON.md
- 技术架构深解: https://blog.csdn.net/qq_41067796/article/details/161161780

### TerminalBuddy 内部
- `terminal-buddy/src-tauri/src/commands/ai_usage.rs` — 用量查询
- `terminal-buddy/src-tauri/src/commands/terminal.rs` — TerminalService
- `terminal-buddy/src-tauri/src/commands/server_monitor.rs` — Server Monitor
- `terminal-buddy/src-tauri/src/services/profile_service.rs` — Profile CRUD
- `terminal-buddy/src-tauri/src/services/template_service.rs` — CommandTemplate
- `terminal-buddy/src-tauri/src/web/server.rs` — axum Web API
- `terminal-buddy/src-tauri/src/lib.rs` — invoke_handler 注册
- `terminal-buddy/src/App.tsx` — 主布局
- `terminal-buddy/src/components/TitleBar.tsx` — TitleBar
- `terminal-buddy/src/stores/appStore.ts` — Zustand 状态
- `terminal-buddy/src/types/index.ts` — 类型定义