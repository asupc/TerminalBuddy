//! 定时任务：存储、Cron / 时区计算、调度循环与执行器。
//!
//! 调度器随 TerminalBuddy 进程运行：桌面端退出即停止，Docker 服务端可 7×24 执行。
//! 任务只能启动已登记项目的 Profile，或向 Agent 发送 Prompt，不执行任意 Shell 命令。
//! Agent 任务的执行形态跟随「新会话形态」设置：原生会话走 `ai_chat_service`，
//! 终端接力则在项目目录启动 Agent 终端后把任务描述键入 REPL。
use crate::commands::terminal::{default_terminal_type, teardown_terminal, TerminalCloseReason};
use crate::commands::TerminalService;
use crate::models::ai_chat::{AiSession, CreateAiSession, SendAiMessage};
use crate::models::scheduled_task::*;
use crate::models::{TerminalActor, TerminalCreator, TerminalOwner};
use crate::runtime::{AppHandle, Emitter, Manager};
use crate::services::{
    agent_usage_service, ai_catalog_service, ai_chat_service, ai_permission_service,
    terminal_agent_relay, terminal_task_service, AppNotificationService, PathService,
    ProfileService, SettingsService,
};
use chrono::{DateTime, Duration, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

/// 错过超过该宽限期就不补跑，避免停机后一次补跑几十次。
const GRACE_MINUTES: i64 = 5;
/// 全局同时执行的定时任务上限。
const MAX_CONCURRENT_RUNS: usize = 3;
/// 手动运行同一任务的去重窗口。
const MANUAL_DEDUP_MS: i64 = 5_000;
const TICK_SECONDS: u64 = 30;
const POLL_SECONDS: u64 = 5;

type Result<T> = std::result::Result<T, String>;

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskRunEvent {
    task_id: String,
    run: ScheduledRun,
    task: ScheduledTask,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TasksChangedEvent {
    task_id: Option<String>,
    action: String,
}

fn emit_run(app: &AppHandle, task: &ScheduledTask, run: &ScheduledRun) {
    let _ = app.emit(
        "scheduled-task-run",
        TaskRunEvent { task_id: task.id.clone(), run: run.clone(), task: task.clone() },
    );
}

fn emit_changed(app: &AppHandle, task_id: Option<String>, action: &str) {
    let _ = app.emit(
        "scheduled-tasks-changed",
        TasksChangedEvent { task_id, action: action.to_string() },
    );
}

/// 广播定时任务创建的终端。
///
/// 桌面端创建的终端属于 `Pc`：浏览器在「会话不共享」时不能看到它，因此桌面模式下
/// 只推给 Tauri 窗口，只有开启共享才同时进入 EventBus（浏览器事件通道）。
/// 服务端创建的终端属于 `Web`，正常广播给所有已登录客户端。
fn emit_terminal_created(app: &AppHandle, payload: serde_json::Value) {
    #[cfg(feature = "desktop")]
    {
        let _ = tauri::Emitter::emit(app, "terminal-created", payload.clone());
        if crate::services::SettingsService::share_sessions_enabled() {
            let message = crate::runtime::RuntimeEvent {
                event: "terminal-created".to_string(),
                payload,
            };
            let _ = app.state::<crate::runtime::EventBus>().0.send(message);
        }
    }
    #[cfg(not(feature = "desktop"))]
    {
        let _ = app.emit("terminal-created", payload);
    }
}

/// 定时任务（项目配置 / Agent 终端）创建终端后统一补开标签：
/// `activate=false` 不抢当前焦点，`groupName` 让标签落入项目分组。
fn emit_created_terminal(app: &AppHandle, terminal_id: &str) {
    if let Some(info) = app
        .state::<TerminalService>()
        .list_terminals_info()
        .into_iter()
        .find(|info| info.id == terminal_id)
    {
        let group = info.group.clone();
        emit_terminal_created(
            app,
            serde_json::json!({
                "id": info.id,
                "profileId": info.profile_id,
                "profileName": info.profile_name,
                "terminalType": info.terminal_type,
                "owner": info.owner,
                "group": info.group,
                "groupName": group,
                "activate": false,
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn storage_dir() -> Result<PathBuf> {
    let dir = PathService::require_data_dir()?.join("ScheduledTasks");
    fs::create_dir_all(&dir).map_err(|e| format!("创建定时任务目录失败：{e}"))?;
    Ok(dir)
}

fn tasks_path() -> Result<PathBuf> {
    Ok(storage_dir()?.join("tasks.json"))
}

fn runs_dir() -> Result<PathBuf> {
    let dir = storage_dir()?.join("runs");
    fs::create_dir_all(&dir).map_err(|e| format!("创建定时任务运行记录目录失败：{e}"))?;
    Ok(dir)
}

fn run_path(task_id: &str) -> Result<PathBuf> {
    // 任务 id 一律为 UUID；借用户输入的 id 拼路径前先校验，杜绝路径穿越。
    let id = Uuid::parse_str(task_id).map_err(|_| "定时任务标识无效".to_string())?;
    Ok(runs_dir()?.join(format!("{id}.json")))
}

#[derive(Serialize, Deserialize)]
struct TasksFile {
    version: u32,
    tasks: Vec<ScheduledTask>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TasksFileCompat {
    Versioned(TasksFile),
    Legacy(Vec<ScheduledTask>),
}

pub(crate) fn load_defs() -> Result<Vec<ScheduledTask>> {
    let path = tasks_path()?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取定时任务失败：{e}"))?;
    match serde_json::from_slice::<TasksFileCompat>(&bytes) {
        Ok(TasksFileCompat::Versioned(file)) => Ok(file.tasks),
        Ok(TasksFileCompat::Legacy(tasks)) => Ok(tasks),
        Err(error) => Err(format!("定时任务文件格式无效：{error}")),
    }
}

fn save_defs(tasks: &[ScheduledTask]) -> Result<()> {
    let content = serde_json::to_vec_pretty(&TasksFile { version: 1, tasks: tasks.to_vec() })
        .map_err(|e| format!("编码定时任务失败：{e}"))?;
    crate::services::atomic_file::atomic_write(&tasks_path()?, &content)
        .map_err(|e| format!("保存定时任务失败：{e}"))
}

fn read_runs_unlocked(task_id: &str) -> Vec<ScheduledRun> {
    let Ok(path) = run_path(task_id) else { return Vec::new() };
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<ScheduledRun>>(&bytes).ok())
        .unwrap_or_default()
}

fn write_runs_unlocked(task_id: &str, runs: &[ScheduledRun]) -> Result<()> {
    let content = serde_json::to_vec(runs).map_err(|e| format!("编码运行记录失败：{e}"))?;
    crate::services::atomic_file::atomic_write(&run_path(task_id)?, &content)
        .map_err(|e| format!("保存运行记录失败：{e}"))
}

fn append_run(run: &ScheduledRun) {
    let Ok(_guard) = store_lock().lock() else { return };
    let mut runs = read_runs_unlocked(&run.task_id);
    runs.push(run.clone());
    if runs.len() > MAX_RUNS_PER_TASK {
        let excess = runs.len() - MAX_RUNS_PER_TASK;
        runs.drain(0..excess);
    }
    let _ = write_runs_unlocked(&run.task_id, &runs);
}

fn update_run(run: &ScheduledRun) {
    let Ok(_guard) = store_lock().lock() else { return };
    if load_defs().is_ok_and(|tasks| !tasks.iter().any(|task| task.id == run.task_id)) {
        return;
    }
    let mut runs = read_runs_unlocked(&run.task_id);
    match runs.iter_mut().find(|item| item.id == run.id) {
        Some(existing) => *existing = run.clone(),
        None => runs.push(run.clone()),
    }
    if runs.len() > MAX_RUNS_PER_TASK {
        let excess = runs.len() - MAX_RUNS_PER_TASK;
        runs.drain(0..excess);
    }
    let _ = write_runs_unlocked(&run.task_id, &runs);
}

pub fn read_runs(task_id: &str) -> Vec<ScheduledRun> {
    read_runs_unlocked(task_id)
}

fn touch_task(task_id: &str, last_run_at: i64) {
    let Ok(_guard) = store_lock().lock() else { return };
    let Ok(mut tasks) = load_defs() else { return };
    if let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) {
        task.last_run_at = Some(last_run_at);
        let _ = save_defs(&tasks);
    }
}

// ---------------------------------------------------------------------------
// 运行态（内存）
// ---------------------------------------------------------------------------

/// Agent 任务的执行形态：派发时按「新会话形态」设置固化，运行期间不再变化，
/// 停止入口据此决定是停原生会话还是关终端（不依赖运行中再去读设置）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentRunMode {
    Native,
    Terminal,
}

#[derive(Debug, Clone)]
struct ActiveRun {
    run_id: String,
    mode: Option<AgentRunMode>,
    session_id: Option<String>,
    terminal_id: Option<String>,
    stop_requested: bool,
}

fn active() -> &'static Mutex<HashMap<String, ActiveRun>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, ActiveRun>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_active() -> std::sync::MutexGuard<'static, HashMap<String, ActiveRun>> {
    active().lock().unwrap_or_else(|error| error.into_inner())
}

fn active_run_id(task_id: &str) -> Option<String> {
    lock_active().get(task_id).map(|entry| entry.run_id.clone())
}

fn set_active_session(task_id: &str, run_id: &str, session_id: Option<String>, terminal_id: Option<String>) {
    if let Some(entry) = lock_active().get_mut(task_id) {
        if entry.run_id == run_id {
            entry.session_id = session_id;
            entry.terminal_id = terminal_id;
        }
    }
}

fn stop_requested(task_id: &str, run_id: &str) -> bool {
    lock_active()
        .get(task_id)
        .is_some_and(|entry| entry.run_id == run_id && entry.stop_requested)
}

fn remove_active(task_id: &str, run_id: &str) {
    let mut map = lock_active();
    if map.get(task_id).is_some_and(|entry| entry.run_id == run_id) {
        map.remove(task_id);
    }
}

fn last_manual() -> &'static Mutex<HashMap<String, i64>> {
    static LAST: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

fn manual_run_allowed(last: Option<i64>, now_ms: i64) -> bool {
    last.map_or(true, |last| now_ms - last >= MANUAL_DEDUP_MS)
}

#[derive(Debug, PartialEq, Eq)]
enum RunAdmission {
    Allowed,
    TaskRunning,
    GlobalLimit,
}

fn run_admission(active_same_task: bool, active_total: usize) -> RunAdmission {
    if active_same_task {
        RunAdmission::TaskRunning
    } else if active_total >= MAX_CONCURRENT_RUNS {
        RunAdmission::GlobalLimit
    } else {
        RunAdmission::Allowed
    }
}

// ---------------------------------------------------------------------------
// 时间计算
// ---------------------------------------------------------------------------

/// 返回严格晚于 `after` 的下一次计划时刻。
pub(crate) fn next_after(schedule: &TaskSchedule, after: DateTime<Utc>, tz: Tz) -> Option<DateTime<Utc>> {
    match schedule {
        TaskSchedule::Cron { expression } => {
            let schedule = crate::models::scheduled_task::parse_cron_schedule(expression).ok()?;
            schedule
                .after(&after.with_timezone(&tz))
                .next()
                .map(|value| value.with_timezone(&Utc))
        }
        TaskSchedule::Once { run_at } => {
            let utc = once_as_utc(run_at, tz)?;
            (utc > after).then_some(utc)
        }
    }
}

/// 返回 (最近一次已到期的计划时刻, 是否在宽限期内、应当执行)。
pub(crate) fn due_occurrence(task: &ScheduledTask, now: DateTime<Utc>) -> Option<(DateTime<Utc>, bool)> {
    let tz = parse_timezone(&task.timezone).ok()?;
    let anchor_ms = task.last_scheduled_at.unwrap_or(task.created_at);
    let anchor = Utc.timestamp_millis_opt(anchor_ms).single().unwrap_or(now);
    match &task.schedule {
        TaskSchedule::Once { run_at } => {
            let at = once_as_utc(run_at, tz)?;
            if at <= anchor || at > now {
                return None;
            }
            Some((at, now - at <= Duration::minutes(GRACE_MINUTES)))
        }
        TaskSchedule::Cron { .. } => {
            let first = next_after(&task.schedule, anchor, tz)?;
            if first > now {
                return None;
            }
            // 长时间停机后逐条迭代可能有几十万次。先检查宽限窗口内是否还有计划时刻：
            // 有（如每分钟任务）就只处理最近一次；宽限窗口内没有则可直接跳过本次补跑。
            let window_start = now - Duration::minutes(GRACE_MINUTES) - Duration::seconds(1);
            let mut latest = if first >= window_start {
                first
            } else {
                match next_after(&task.schedule, window_start, tz) {
                    Some(candidate) if candidate <= now => candidate,
                    _ => {
                        // 宽限窗口内没有计划时刻：本次不执行。锚点推进到 now 即可，
                        // 下一轮从当前时刻起算，不会把停机期间的时刻逐个补跑。
                        return Some((now, false));
                    }
                }
            };
            while let Some(next) = next_after(&task.schedule, latest, tz) {
                if next > now {
                    break;
                }
                latest = next;
            }
            Some((latest, now - latest <= Duration::minutes(GRACE_MINUTES)))
        }
    }
}

/// 未来最近一次运行时间（毫秒）；禁用任务由调用方决定是否展示。
pub(crate) fn next_run_at(task: &ScheduledTask, now: DateTime<Utc>) -> Option<i64> {
    let tz = parse_timezone(&task.timezone).ok()?;
    let anchor_ms = task
        .last_scheduled_at
        .unwrap_or(task.created_at)
        .max(now.timestamp_millis());
    let anchor = Utc.timestamp_millis_opt(anchor_ms).single()?;
    next_after(&task.schedule, anchor, tz).map(|value| value.timestamp_millis())
}

pub fn preview(expression: &str, timezone: &str, count: usize) -> Result<Vec<i64>> {
    let tz = parse_timezone(timezone)?;
    let schedule = crate::models::scheduled_task::parse_cron_schedule(expression)?;
    let count = count.clamp(1, 20);
    let mut cursor = Utc::now().with_timezone(&tz);
    let mut result = Vec::with_capacity(count);
    while result.len() < count {
        let Some(next) = schedule.after(&cursor).next() else { break };
        result.push(next.timestamp_millis());
        cursor = next;
    }
    if result.is_empty() {
        return Err("Cron 表达式在未来没有可执行时间，请检查".into());
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// 视图与 CRUD
// ---------------------------------------------------------------------------

/// 进程重启后运行记录里可能残留 running / waitingApproval：内存中的活动表已经清空，
/// 这些记录不应继续显示为执行中。只在读取视图时修正，不改写历史文件。
fn reconcile_run(mut run: ScheduledRun) -> ScheduledRun {
    if matches!(run.status.as_str(), "running" | "waitingApproval")
        && active_run_id(&run.task_id).as_deref() != Some(run.id.as_str())
    {
        run.status = "stopped".into();
        run.message = Some("执行已中断（应用已重启）".into());
        // 不伪造结束时间：真实收尾时刻未知，界面显示「—」比编造耗时要诚实。
    }
    run
}

fn view_for(task: ScheduledTask, now: DateTime<Utc>) -> ScheduledTaskView {
    let next_run_at = if task.enabled { next_run_at(&task, now) } else { None };
    let running_run_id = active_run_id(&task.id);
    let last_run = {
        let mut runs = read_runs_unlocked(&task.id);
        runs.pop().map(reconcile_run)
    };
    ScheduledTaskView { task, next_run_at, running_run_id, last_run }
}

pub fn list() -> Result<Vec<ScheduledTaskView>> {
    let tasks = load_defs()?;
    let now = Utc::now();
    Ok(tasks.into_iter().map(|task| view_for(task, now)).collect())
}

fn schedule_key(schedule: &TaskSchedule) -> String {
    match schedule {
        TaskSchedule::Cron { expression } => format!("cron:{}", expression.trim()),
        TaskSchedule::Once { run_at } => format!("once:{}", run_at.trim()),
    }
}

/// 在已校验输入上执行存储层的「读-改-写」。调用方负责传入当前项目 / Profile 列表。
fn persist_save(
    input: ScheduledTaskInput,
    projects: &[crate::commands::profile::Project],
    profiles: &[crate::models::Profile],
    now_ms: i64,
) -> Result<(ScheduledTask, bool)> {
    let mut task = validate_input(input, projects, profiles)?;
    let _guard = store_lock().lock().unwrap_or_else(|error| error.into_inner());
    let mut tasks = load_defs()?;
    let existing_index = if task.id.is_empty() {
        None
    } else {
        tasks.iter().position(|existing| existing.id == task.id)
    };
    let created = existing_index.is_none();
    match existing_index {
        Some(index) => {
            let old = &tasks[index];
            task.created_at = old.created_at;
            task.last_run_at = old.last_run_at;
            // 只有调度方式 / 时区变化才重置锚点：改名、改 Prompt 不应导致立刻触发。
            let schedule_changed =
                schedule_key(&task.schedule) != schedule_key(&old.schedule) || task.timezone != old.timezone;
            task.last_scheduled_at = if schedule_changed { Some(now_ms) } else { old.last_scheduled_at };
            task.updated_at = now_ms;
            tasks[index] = task.clone();
        }
        None => {
            if !task.id.is_empty() {
                return Err("定时任务不存在，可能已被删除".into());
            }
            if tasks.len() >= MAX_TASKS {
                return Err(format!("定时任务数量已达上限（{} 个）", MAX_TASKS));
            }
            task.id = Uuid::new_v4().to_string();
            task.created_at = now_ms;
            task.updated_at = now_ms;
            // 保存后不应立刻补跑创建之前的计划时刻。
            task.last_scheduled_at = Some(now_ms);
            tasks.push(task.clone());
        }
    }
    save_defs(&tasks)?;
    Ok((task, created))
}

pub fn save(app: &AppHandle, input: ScheduledTaskInput) -> Result<ScheduledTaskView> {
    let projects = crate::commands::profile::get_projects()?;
    let profiles = ProfileService::get_all_profiles()?;
    let (task, created) = persist_save(input, &projects, &profiles, Utc::now().timestamp_millis())?;
    emit_changed(
        app,
        Some(task.id.clone()),
        if created { "created" } else { "updated" },
    );
    Ok(view_for(task, Utc::now()))
}

pub fn delete(app: &AppHandle, id: &str) -> Result<()> {
    if active_run_id(id).is_some() {
        return Err("定时任务正在执行中，请先停止后再删除".into());
    }
    let _guard = store_lock().lock().unwrap_or_else(|error| error.into_inner());
    let mut tasks = load_defs()?;
    let Some(index) = tasks.iter().position(|task| task.id == id) else {
        return Err("定时任务不存在，可能已被删除".into());
    };
    tasks.remove(index);
    save_defs(&tasks)?;
    if let Ok(path) = run_path(id) {
        let _ = fs::remove_file(path);
    }
    if let Ok(mut last) = last_manual().lock() {
        last.remove(id);
    }
    drop(_guard);
    emit_changed(app, Some(id.to_string()), "deleted");
    Ok(())
}

pub fn set_enabled(app: &AppHandle, id: &str, enabled: bool) -> Result<ScheduledTaskView> {
    let task = {
        let _guard = store_lock().lock().unwrap_or_else(|error| error.into_inner());
        let mut tasks = load_defs()?;
        let index = tasks
            .iter()
            .position(|task| task.id == id)
            .ok_or_else(|| "定时任务不存在，可能已被删除".to_string())?;
        let task = &mut tasks[index];
        task.enabled = enabled;
        // 重新启用时从当前时刻起算，避免停机期间错过的时间立即补跑。
        if enabled {
            task.last_scheduled_at = Some(Utc::now().timestamp_millis());
        }
        task.updated_at = Utc::now().timestamp_millis();
        let task = task.clone();
        save_defs(&tasks)?;
        task
    };
    emit_changed(app, Some(id.to_string()), if enabled { "enabled" } else { "disabled" });
    Ok(view_for(task, Utc::now()))
}

pub fn runs(id: &str, limit: Option<usize>) -> Result<Vec<ScheduledRun>> {
    let mut runs = read_runs(id);
    runs.reverse();
    if let Some(limit) = limit {
        runs.truncate(limit);
    }
    Ok(runs.into_iter().map(reconcile_run).collect())
}

pub fn options() -> Result<ScheduledTaskOptions> {
    Ok(ScheduledTaskOptions {
        projects: crate::commands::profile::get_projects()?,
        profiles: ProfileService::get_all_profiles()?,
        catalog: ai_catalog_service::catalog()?,
    })
}

// ---------------------------------------------------------------------------
// 调度循环
// ---------------------------------------------------------------------------

static STARTED: AtomicBool = AtomicBool::new(false);

pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::runtime::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(TICK_SECONDS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let tick_app = app.clone();
            match crate::runtime::async_runtime::spawn_blocking(move || tick(&tick_app)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("定时任务调度失败：{error}"),
                Err(error) => eprintln!("定时任务调度任务失败：{error}"),
            }
        }
    });
}

enum TickAction {
    Run(ScheduledTask),
    Skip(ScheduledTask, String),
}

fn tick(app: &AppHandle) -> Result<()> {
    let now = Utc::now();
    let (actions, changed) = {
        let _guard = store_lock().lock().unwrap_or_else(|error| error.into_inner());
        let mut tasks = load_defs()?;
        let mut actions = Vec::new();
        let mut changed = false;
        for task in tasks.iter_mut().filter(|task| task.enabled) {
            let Some((latest, should_run)) = due_occurrence(task, now) else { continue };
            let latest_ms = latest.timestamp_millis();
            task.last_scheduled_at = Some(latest_ms);
            let once = task.schedule.is_once();
            if once {
                // 仅一次任务消费后自动停止，无论是否在宽限期内。
                task.enabled = false;
            }
            changed = true;
            if should_run {
                actions.push(TickAction::Run(task.clone()));
            } else if once {
                actions.push(TickAction::Skip(task.clone(), "已错过计划时间".into()));
            }
        }
        if changed {
            save_defs(&tasks)?;
        }
        (actions, changed)
    };
    if changed {
        emit_changed(app, None, "scheduled");
    }
    for action in actions {
        match action {
            TickAction::Run(task) => match dispatch(app, task.clone(), "scheduled") {
                Ok(_) => {}
                Err(RunAdmission::TaskRunning) => {
                    record_skipped(app, &task, "任务正在运行，本次已跳过");
                }
                Err(RunAdmission::GlobalLimit) => {
                    record_skipped(app, &task, "同时执行的定时任务已达上限，本次已跳过");
                }
                Err(RunAdmission::Allowed) => {}
            },
            TickAction::Skip(task, message) => record_skipped(app, &task, &message),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

fn new_run(task: &ScheduledTask, trigger: &str) -> ScheduledRun {
    let (agent, model) = match &task.target {
        TaskTarget::AgentPrompt { agent, model, .. } => (Some(agent.clone()), model.clone()),
        TaskTarget::ProjectProfile { .. } => (None, None),
    };
    ScheduledRun {
        id: Uuid::new_v4().to_string(),
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        trigger: trigger.to_string(),
        status: "running".to_string(),
        started_at: Utc::now().timestamp_millis(),
        finished_at: None,
        message: None,
        terminal_id: None,
        session_id: None,
        agent,
        provider_name: None,
        model,
        input_tokens: None,
        output_tokens: None,
    }
}

fn record_skipped(app: &AppHandle, task: &ScheduledTask, message: &str) {
    let mut run = new_run(task, "scheduled");
    run.status = "skipped".to_string();
    run.finished_at = Some(run.started_at);
    run.message = Some(message.to_string());
    append_run(&run);
    emit_run(app, task, &run);
}

/// 原子地占用运行名额：单任务串行 + 全局并发上限在同一把锁内判定，
/// 避免调度 tick 与手动运行同时通过检查而超限。
fn try_admit(
    task_id: &str,
    run_id: &str,
    mode: Option<AgentRunMode>,
) -> std::result::Result<(), RunAdmission> {
    let mut map = lock_active();
    match run_admission(map.contains_key(task_id), map.len()) {
        RunAdmission::Allowed => {
            map.insert(
                task_id.to_string(),
                ActiveRun {
                    run_id: run_id.to_string(),
                    mode,
                    session_id: None,
                    terminal_id: None,
                    stop_requested: false,
                },
            );
            Ok(())
        }
        other => Err(other),
    }
}

fn agent_run_mode(task: &ScheduledTask) -> Option<AgentRunMode> {
    match &task.target {
        TaskTarget::ProjectProfile { .. } => None,
        // 原生会话开启时，Claude / Codex / Antigravity（ACP）均走原生会话。
        TaskTarget::AgentPrompt { .. } => {
            Some(if !SettingsService::get_settings().native_chat_sessions {
                AgentRunMode::Terminal
            } else {
                AgentRunMode::Native
            })
        }
    }
}

fn dispatch(app: &AppHandle, task: ScheduledTask, trigger: &str) -> std::result::Result<ScheduledRun, RunAdmission> {
    let run = new_run(&task, trigger);
    // 先登记活动运行，再写运行记录：其它客户端在两次写之间读取列表时，
    // 不会把刚创建、马上就要执行的记录误判为「应用重启导致的中断」。
    let mode = agent_run_mode(&task);
    try_admit(&task.id, &run.id, mode)?;
    append_run(&run);
    emit_run(app, &task, &run);

    let task_for_run = task.clone();
    let run_for_run = run.clone();
    let app_for_run = app.clone();
    crate::runtime::async_runtime::spawn(async move {
        let outcome = match &task_for_run.target {
            TaskTarget::ProjectProfile { .. } => {
                run_profile(app_for_run.clone(), &task_for_run, &run_for_run).await
            }
            TaskTarget::AgentPrompt { .. } => {
                run_agent(app_for_run.clone(), &task_for_run, &run_for_run, mode.unwrap_or(AgentRunMode::Native)).await
            }
        };
        finish_run(app_for_run, task_for_run, run_for_run, outcome).await;
    });
    Ok(run)
}

pub fn run_now(app: &AppHandle, id: &str) -> Result<ScheduledRun> {
    let task = load_defs()?
        .into_iter()
        .find(|task| task.id == id)
        .ok_or_else(|| "定时任务不存在，可能已被删除".to_string())?;
    let now = Utc::now().timestamp_millis();
    {
        let mut last = last_manual().lock().unwrap_or_else(|error| error.into_inner());
        if !manual_run_allowed(last.get(id).copied(), now) {
            return Err("任务刚刚已启动，请稍后再试".into());
        }
        last.insert(id.to_string(), now);
    }
    match dispatch(app, task.clone(), "manual") {
        Ok(run) => Ok(run),
        Err(RunAdmission::TaskRunning) => {
            Ok(skipped_run(app, &task, "manual", "任务正在运行，本次已跳过"))
        }
        Err(RunAdmission::GlobalLimit) => {
            Ok(skipped_run(app, &task, "manual", "同时执行的定时任务已达上限，本次已跳过"))
        }
        Err(RunAdmission::Allowed) => Ok(skipped_run(app, &task, "manual", "本次已跳过")),
    }
}

fn skipped_run(app: &AppHandle, task: &ScheduledTask, trigger: &str, message: &str) -> ScheduledRun {
    let mut run = new_run(task, trigger);
    run.status = "skipped".to_string();
    run.finished_at = Some(run.started_at);
    run.message = Some(message.to_string());
    append_run(&run);
    emit_run(app, task, &run);
    run
}

pub fn stop(app: &AppHandle, id: &str) -> Result<()> {
    // 先取快照再释放锁：teardown / ai_chat 调用都不允许在持锁期间执行。
    // 带上 run_id，避免读取后被新一次运行顶替、误停到下一轮。
    let (run_id, mode, session, terminal) = {
        let map = lock_active();
        let entry = map
            .get(id)
            .ok_or_else(|| "任务当前没有运行中的执行".to_string())?;
        (entry.run_id.clone(), entry.mode, entry.session_id.clone(), entry.terminal_id.clone())
    };
    let request_stop = || {
        let mut map = lock_active();
        if let Some(entry) = map.get_mut(id) {
            if entry.run_id == run_id {
                entry.stop_requested = true;
            }
        }
    };
    if mode == Some(AgentRunMode::Terminal) {
        request_stop();
        if let Some(terminal) = terminal {
            teardown_terminal(app, &terminal, TerminalCloseReason::ScheduledClose);
        }
        // 终端尚未创建完成时也返回成功：执行器建完终端会立即检查停止标志。
        return Ok(());
    }
    let Some(session) = session else {
        // Agent 任务在创建会话前也会占用运行名额；此时没有 session_id 可停止。
        let is_agent = load_defs()
            .ok()
            .and_then(|tasks| tasks.into_iter().find(|task| task.id == id))
            .map(|task| matches!(task.target, TaskTarget::AgentPrompt { .. }))
            .unwrap_or(true);
        return Err(if is_agent {
            "会话正在创建，请稍后再试".to_string()
        } else {
            "项目配置任务请在终端标签中关闭".to_string()
        });
    };
    request_stop();
    let owner = crate::commands::ai_chat::desktop_owner();
    // 会话可能刚好自然结束：停止失败不应把用户操作变成报错。
    let _ = ai_chat_service::stop(&session, &owner);
    Ok(())
}

#[derive(Default)]
struct RunOutcome {
    status: String,
    message: Option<String>,
    session_id: Option<String>,
    terminal_id: Option<String>,
    agent: Option<String>,
    provider_name: Option<String>,
    model: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

fn failed(message: impl Into<String>) -> RunOutcome {
    RunOutcome { status: "failed".into(), message: Some(message.into()), ..Default::default() }
}

async fn finish_run(app: AppHandle, task: ScheduledTask, mut run: ScheduledRun, outcome: RunOutcome) {
    let finished_at = Utc::now().timestamp_millis();
    run.status = if outcome.status.is_empty() { "failed".to_string() } else { outcome.status };
    run.finished_at = Some(finished_at);
    run.message = outcome.message;
    run.session_id = outcome.session_id.or(run.session_id);
    run.terminal_id = outcome.terminal_id.or(run.terminal_id);
    run.agent = outcome.agent.or(run.agent);
    run.provider_name = outcome.provider_name.or(run.provider_name);
    run.model = outcome.model.or(run.model);
    run.input_tokens = outcome.input_tokens.or(run.input_tokens);
    run.output_tokens = outcome.output_tokens.or(run.output_tokens);

    let run_for_write = run.clone();
    let _ = crate::runtime::async_runtime::spawn_blocking(move || update_run(&run_for_write)).await;
    remove_active(&task.id, &run.id);
    let task_id = task.id.clone();
    let _ = crate::runtime::async_runtime::spawn_blocking(move || touch_task(&task_id, finished_at)).await;
    emit_run(&app, &task, &run);
    emit_changed(&app, Some(task.id.clone()), "run");
    notify_result(&app, &task, &run);
}

fn notify_result(_app: &AppHandle, task: &ScheduledTask, run: &ScheduledRun) {
    if !task.notify {
        return;
    }
    let summary = run.message.as_deref().unwrap_or("");
    match run.status.as_str() {
        "completed" => AppNotificationService::publish_scheduled(
            "completed", &task.name, summary, &task.id, &run.id, run.session_id.as_deref(),
        ),
        "failed" | "timeout" => AppNotificationService::publish_scheduled(
            "failed", &task.name, summary, &task.id, &run.id, run.session_id.as_deref(),
        ),
        "waitingApproval" => AppNotificationService::publish_scheduled(
            "approval", &task.name, summary, &task.id, &run.id, run.session_id.as_deref(),
        ),
        _ => {}
    }
}

async fn blocking<T, F>(task: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    crate::runtime::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("定时任务后台操作失败：{error}"))?
}

fn find_project(name: &str) -> Result<crate::commands::profile::Project> {
    crate::commands::profile::get_projects()?
        .into_iter()
        .find(|project| project.name == name)
        .ok_or_else(|| "项目已删除或不存在，请编辑任务".to_string())
}

fn project_path(project: &crate::commands::profile::Project) -> Result<String> {
    if !Path::new(&project.path).is_dir() {
        return Err("项目路径不可用，请编辑任务".into());
    }
    Ok(project.path.clone())
}

fn summarize(session: &AiSession) -> Option<String> {
    session
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
        .map(|message| truncate_chars(message.text.trim(), 500))
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut result: String = value.chars().take(limit).collect();
    result.push('…');
    result
}

fn usage_tokens(session: &AiSession) -> (Option<u64>, Option<u64>) {
    session
        .usage
        .as_ref()
        .and_then(|usage| usage.last_turn.as_ref())
        .map(|turn| (turn.tokens.input_tokens, turn.tokens.output_tokens))
        .unwrap_or((None, None))
}

/// Agent 任务按派发时固化的形态执行：原生会话保持原有结构化链路；
/// 终端接力（设置 `nativeChatSessions=false`）改为在项目目录启动 Agent 终端。
async fn run_agent(
    app: AppHandle,
    task: &ScheduledTask,
    run: &ScheduledRun,
    mode: AgentRunMode,
) -> RunOutcome {
    match mode {
        AgentRunMode::Native => run_agent_native(app, task, run).await,
        AgentRunMode::Terminal => run_agent_terminal(app, task, run).await,
    }
}

async fn run_agent_native(app: AppHandle, task: &ScheduledTask, run: &ScheduledRun) -> RunOutcome {
    let TaskTarget::AgentPrompt { project_name, agent, provider_id, model, prompt } = &task.target else {
        return failed("任务类型不匹配");
    };
    let (project_name, agent, provider_id, model, prompt) =
        (project_name.clone(), agent.clone(), provider_id.clone(), model.clone(), prompt.clone());

    let project = match blocking(move || find_project(&project_name)).await {
        Ok(project) => project,
        Err(error) => return failed(error),
    };
    let project_path = match project_path(&project) {
        Ok(path) => path,
        Err(error) => return failed(error),
    };

    let selection_agent = agent.clone();
    let selection_model = model.clone();
    let selection = match blocking(move || {
        ai_catalog_service::selection(&selection_agent, provider_id.as_deref(), selection_model.as_deref())
    })
    .await
    {
        Ok(selection) => selection,
        Err(error) => return failed(error),
    };
    let (resolved_provider_id, provider_name) = match selection {
        Some((id, name)) => (Some(id), Some(name)),
        None => (None, None),
    };

    let owner = crate::commands::ai_chat::desktop_owner();
    let create_owner = owner.clone();
    let create_agent = agent.clone();
    let create_model = model.clone();
    let create_input = CreateAiSession {
        provider: create_agent,
        provider_id: resolved_provider_id,
        project_path,
        model: create_model,
        resume_session_id: None,
    };
    let session = match blocking(move || ai_chat_service::create(&create_owner, create_input)).await {
        Ok(session) => session,
        Err(error) => return failed(format!("创建会话失败：{error}")),
    };

    set_active_session(&task.id, &run.id, Some(session.id.clone()), None);
    let mut live_run = run.clone();
    live_run.session_id = Some(session.id.clone());
    live_run.agent = Some(agent.clone());
    live_run.provider_name = provider_name.clone().or(session.provider_name.clone());
    live_run.model = model.clone().or(session.model.clone());
    let live_run_for_write = live_run.clone();
    let _ = crate::runtime::async_runtime::spawn_blocking(move || update_run(&live_run_for_write)).await;
    emit_run(&app, task, &live_run);

    let session_id = session.id.clone();
    if stop_requested(&task.id, &run.id) {
        let _ = release_session(&session_id, &owner).await;
        return RunOutcome {
            status: "stopped".into(),
            message: Some("已手动停止".into()),
            session_id: Some(session_id),
            agent: Some(agent),
            provider_name,
            model,
            ..Default::default()
        };
    }

    let send_owner = owner.clone();
    let send_session = session_id.clone();
    let send_input = SendAiMessage {
        text: prompt,
        request_id: Uuid::new_v4().to_string(),
        steer: false,
        images: Vec::new(),
    };
    if let Err(error) = blocking(move || ai_chat_service::send(&send_session, &send_owner, send_input)).await {
        let _ = release_session(&session_id, &owner).await;
        return RunOutcome {
            status: "failed".into(),
            message: Some(format!("发送任务失败：{error}")),
            session_id: Some(session_id),
            agent: Some(agent),
            provider_name,
            model,
            ..Default::default()
        };
    }

    let timeout = std::time::Duration::from_secs(task.timeout_minutes.max(1) as u64 * 60);
    let started = std::time::Instant::now();
    let mut approval_notified = false;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_SECONDS)).await;
        if stop_requested(&task.id, &run.id) {
            let stop_owner = owner.clone();
            let stop_session = session_id.clone();
            let _ = blocking(move || ai_chat_service::stop(&stop_session, &stop_owner)).await;
        }
        if started.elapsed() > timeout {
            let stop_owner = owner.clone();
            let stop_session = session_id.clone();
            let _ = blocking(move || ai_chat_service::stop(&stop_session, &stop_owner)).await;
            let _ = release_session(&session_id, &owner).await;
            return RunOutcome {
                status: "timeout".into(),
                message: Some(format!("执行超时（{} 分钟），已停止", task.timeout_minutes)),
                session_id: Some(session_id),
                agent: Some(agent),
                provider_name,
                model,
                ..Default::default()
            };
        }
        let get_owner = owner.clone();
        let get_session = session_id.clone();
        let snapshot = match blocking(move || ai_chat_service::get(&get_session, &get_owner)).await {
            Ok(snapshot) => snapshot,
            Err(error) => return failed(format!("读取会话状态失败：{error}")),
        };

        // 权限询问可能先出现在 approvals 里、状态随后才切到 approval：
        // 两个信号任一存在都按「等待确认」处理，避免误判为已完成。
        if snapshot.status == "approval" || !snapshot.approvals.is_empty() {
            if !approval_notified {
                approval_notified = true;
                let mut waiting = live_run.clone();
                waiting.status = "waitingApproval".into();
                waiting.message = Some("等待处理权限询问，请打开会话回答".into());
                let waiting_for_write = waiting.clone();
                let _ = crate::runtime::async_runtime::spawn_blocking(move || update_run(&waiting_for_write)).await;
                emit_run(&app, task, &waiting);
                if task.notify {
                    AppNotificationService::publish_scheduled(
                        "approval",
                        &task.name,
                        "等待处理权限询问，请打开会话回答",
                        &task.id,
                        &run.id,
                        Some(&session_id),
                    );
                }
            }
            continue;
        }

        match snapshot.status.as_str() {
            "running" | "background" | "stopping" => {
                // 用户回答权限询问后回合继续：把运行记录从「等待确认」恢复为运行中，
                // 并允许下一次询问重新发布通知。
                if approval_notified {
                    approval_notified = false;
                    let mut resumed = live_run.clone();
                    resumed.status = "running".into();
                    resumed.message = Some("继续执行中".into());
                    let resumed_for_write = resumed.clone();
                    let _ = crate::runtime::async_runtime::spawn_blocking(move || update_run(&resumed_for_write)).await;
                    emit_run(&app, task, &resumed);
                }
                continue;
            }
            "idle" | "interrupted" | "error" => {
                let user_stopped = stop_requested(&task.id, &run.id);
                let (status, message) = match snapshot.status.as_str() {
                    "idle" if user_stopped => ("stopped", Some("已手动停止".to_string())),
                    "idle" => (
                        "completed",
                        Some(summarize(&snapshot).unwrap_or_else(|| "执行完成".to_string())),
                    ),
                    "interrupted" if user_stopped => ("stopped", Some("已手动停止".to_string())),
                    "interrupted" => (
                        "failed",
                        Some(snapshot.error.clone().unwrap_or_else(|| "执行被中断".to_string())),
                    ),
                    _ => (
                        "failed",
                        Some(snapshot.error.clone().unwrap_or_else(|| "Agent 执行失败".to_string())),
                    ),
                };
                let (input_tokens, output_tokens) = usage_tokens(&snapshot);
                let _ = release_session(&session_id, &owner).await;
                return RunOutcome {
                    status: status.into(),
                    message,
                    session_id: Some(session_id),
                    agent: Some(agent),
                    provider_name,
                    model,
                    input_tokens,
                    output_tokens,
                    ..Default::default()
                };
            }
            _ => continue,
        }
    }
}

async fn release_session(session_id: &str, owner: &str) -> Result<()> {
    let session_id = session_id.to_string();
    let owner = owner.to_string();
    blocking(move || ai_chat_service::release_process(&session_id, &owner)).await
}

// ---------------------------------------------------------------------------
// 终端接力执行器
// ---------------------------------------------------------------------------

/// 终端 Agent 的轮询分类结果（纯函数，便于单测）。
#[derive(Debug, PartialEq, Eq)]
enum TerminalRunAction {
    Continue,
    WaitingApproval,
    Completed { message: Option<String> },
    Failed { message: String },
    Stopped { message: String },
}

fn classify_terminal_snapshot(
    saw_running: &mut bool,
    idle_streak: &mut u32,
    provider: Option<&str>,
    phase: &str,
    turn_end: Option<&str>,
    pending: usize,
    stop_requested: bool,
) -> TerminalRunAction {
    if stop_requested {
        return TerminalRunAction::Stopped { message: "已手动停止".into() };
    }
    // 待决策卡片与 attention 两个信号任一存在都按「等待确认」处理。
    if pending > 0 || phase == "attention" {
        return TerminalRunAction::WaitingApproval;
    }
    match phase {
        "running" | "background" => {
            *saw_running = true;
            *idle_streak = 0;
            TerminalRunAction::Continue
        }
        "failed" => TerminalRunAction::Failed { message: "Agent 执行失败".into() },
        "completed" => {
            if turn_end == Some("interrupted") {
                TerminalRunAction::Failed { message: "Agent 回合已被中断".into() }
            } else {
                TerminalRunAction::Completed { message: None }
            }
        }
        "ended" => {
            if turn_end == Some("completed") || *saw_running {
                // Stop→completed 可能在一个轮询间隔内被 SessionEnd→ended 覆盖；
                // 进程在完成回合后正常退出不算失败。
                TerminalRunAction::Completed { message: None }
            } else {
                TerminalRunAction::Failed { message: "Agent 会话已结束，未报告完成".into() }
            }
        }
        "idle" => {
            if !*saw_running {
                // 启动期 SessionStart 就是 idle，等任务描述被接受。
                return TerminalRunAction::Continue;
            }
            *idle_streak += 1;
            if *idle_streak < 2 { return TerminalRunAction::Continue; }
            if provider == Some("codex") {
                // Codex 正常完成会写 completed（task_complete）；idle 表示回合被中止。
                TerminalRunAction::Stopped { message: "Agent 回合已中止".into() }
            } else if turn_end == Some("interrupted") {
                TerminalRunAction::Failed { message: "Agent 回合已被中断".into() }
            } else {
                TerminalRunAction::Completed { message: None }
            }
        }
        // unknown 等：绑定可能仍在刷新，继续等（外层有 60 秒无响应兜底）。
        _ => TerminalRunAction::Continue,
    }
}

fn shell_quote(token: &str, terminal_type: &str) -> Result<String> {
    match terminal_type {
        "powershell" | "pwsh" => Ok(format!("'{}'", token.replace('\'', "''"))),
        "bash" | "sh" | "zsh" => Ok(format!("'{}'", token.replace('\'', "'\\''"))),
        other => Err(format!("终端接力暂不支持 {} 终端", other)),
    }
}

fn agent_binary(agent: &str) -> Result<&'static str> {
    match agent {
        "claude" => Ok("claude"),
        "codex" => Ok("codex"),
        "antigravity" => Ok("agy"),
        _ => Err("请选择 Claude、Codex 或 Antigravity".into()),
    }
}

/// Antigravity CLI 的基础启动命令（与前端 `DEFAULT_ANTIGRAVITY_COMMAND` 一致）。
const DEFAULT_ANTIGRAVITY_COMMAND: &str = "agy --dangerously-skip-permissions";

/// Antigravity CLI 不走供应商 / 模型引用：直接使用「Agent 管理」里的基础启动命令，
/// 空值回退到默认的免确认命令。
fn antigravity_launch_command() -> String {
    resolve_antigravity_command(&SettingsService::get_settings().agent_commands.antigravity)
}

fn resolve_antigravity_command(configured: &str) -> String {
    let command = configured.trim();
    if command.is_empty() { DEFAULT_ANTIGRAVITY_COMMAND.to_string() } else { command.to_string() }
}

/// 组装终端里的 Agent 启动命令：供应商引用/裸命令 + 权限参数。
/// 任务描述不进入命令字符串（见 `run_agent_terminal` 的 PTY 注入）。
fn build_terminal_agent_command(
    agent: &str,
    catalog_id: Option<&str>,
    model: Option<&str>,
    terminal_type: &str,
) -> Result<String> {
    // Antigravity 的基础命令自带全部参数（含免确认开关），不再追加供应商或权限参数。
    if agent == "antigravity" {
        return Ok(antigravity_launch_command());
    }
    let head = terminal_command_head(agent, catalog_id, model)?;
    let permissions = ai_permission_service::for_agent(agent)?;
    let args = if agent == "claude" { permissions.claude_args } else { permissions.codex_args };
    let mut parts = vec![head];
    for arg in args {
        parts.push(shell_quote(&arg, terminal_type)?);
    }
    Ok(parts.join(" "))
}

/// 供应商标识 → 终端命令头（不含权限参数）。`llm:` / `codex:` 目录 id 必须剥掉
/// 来源前缀，因为终端 ref 只接受原始供应商主键；`claude:` 走独立 ref。
fn terminal_command_head(
    agent: &str,
    catalog_id: Option<&str>,
    model: Option<&str>,
) -> Result<String> {
    if agent == "antigravity" {
        return Ok(antigravity_launch_command());
    }
    let binary = agent_binary(agent)?;
    let model = model.unwrap_or_default().trim();
    let head = match catalog_id {
        None => binary.to_string(),
        Some(id) if id == format!("default:{agent}") => binary.to_string(),
        Some(id) => {
            let (source, raw) = id
                .split_once(':')
                .ok_or_else(|| "供应商配置无效，请重新选择".to_string())?;
            match (source, agent) {
                ("llm", "claude") => {
                    if model.is_empty() { return Err("所选供应商没有可用模型，请重新选择".into()); }
                    format!(
                        "{}{}:{}",
                        crate::models::llm_provider::CLAUDE_REF_PREFIX,
                        raw,
                        model
                    )
                }
                ("claude", "claude") => {
                    if model.is_empty() {
                        format!(
                            "{}{}",
                            crate::models::llm_provider::CLAUDE_PROVIDER_REF_PREFIX,
                            raw
                        )
                    } else {
                        format!(
                            "{}{}:{}",
                            crate::models::llm_provider::CLAUDE_PROVIDER_REF_PREFIX,
                            raw,
                            model
                        )
                    }
                }
                ("codex", "codex") => {
                    if model.is_empty() { return Err("所选供应商没有可用模型，请重新选择".into()); }
                    format!(
                        "{}{}:{}",
                        crate::services::codex_provider_service::CODEX_REF_PREFIX,
                        raw,
                        model
                    )
                }
                _ => return Err("供应商与 Agent 类型不匹配，请重新选择".into()),
            }
        }
    };
    Ok(head)
}

/// 任务描述的注入前校验：允许斜杠命令与换行，拒绝其余控制字符（Tab/Ctrl/Escape）。
fn normalize_task_prompt(prompt: &str) -> Result<String> {
    let prompt = prompt.replace("\r\n", "\n").replace('\r', "\n");
    if prompt.trim().is_empty() {
        return Err("任务描述不能为空".into());
    }
    if let Some(bad) = prompt.chars().find(|character| *character != '\n' && character.is_control()) {
        return Err(format!(
            "任务描述不能包含换行以外的控制字符（检测到 U+{:04X}），请删除后重试",
            bad as u32
        ));
    }
    Ok(prompt)
}

/// 终端接力：在项目目录启动真实 Agent 终端，就绪后把任务描述键入输入框。
/// 状态按终端 Agent 阶段/待决策判定；完成或失败都保留终端，只有超时/手动停止才关闭。
async fn run_agent_terminal(app: AppHandle, task: &ScheduledTask, run: &ScheduledRun) -> RunOutcome {
    let TaskTarget::AgentPrompt { project_name, agent, provider_id, model, prompt } = &task.target else {
        return failed("任务类型不匹配");
    };
    let (project_name, agent, provider_id, model, prompt) =
        (project_name.clone(), agent.clone(), provider_id.clone(), model.clone(), prompt.clone());

    let project_lookup = project_name.clone();
    let project = match blocking(move || find_project(&project_lookup)).await {
        Ok(project) => project,
        Err(error) => return failed(error),
    };
    let project_path = match project_path(&project) {
        Ok(path) => path,
        Err(error) => return failed(error),
    };
    // 先校验描述再建终端，避免非法描述留下一个空跑的终端。
    let prompt = match normalize_task_prompt(&prompt) {
        Ok(prompt) => prompt,
        Err(error) => return failed(error),
    };

    let selection_agent = agent.clone();
    let selection_model = model.clone();
    let selection = match blocking(move || {
        ai_catalog_service::selection(&selection_agent, provider_id.as_deref(), selection_model.as_deref())
    })
    .await
    {
        Ok(selection) => selection,
        Err(error) => return failed(error),
    };
    let (resolved_provider_id, provider_name) = match selection {
        Some((id, name)) => (Some(id), Some(name)),
        None => (None, None),
    };

    let terminal_type = default_terminal_type();
    let command_agent = agent.clone();
    let command_provider = resolved_provider_id.clone();
    let command_model = model.clone();
    let command_terminal_type = terminal_type.to_string();
    let command = match blocking(move || {
        build_terminal_agent_command(
            &command_agent,
            command_provider.as_deref(),
            command_model.as_deref(),
            &command_terminal_type,
        )
    })
    .await
    {
        Ok(command) => command,
        Err(error) => return failed(error),
    };

    let display_name = format!("定时 · {}", task.name);
    let (owner, actor) = if cfg!(feature = "desktop") {
        (TerminalOwner::Pc, TerminalActor::Pc)
    } else {
        (TerminalOwner::Web, TerminalActor::Web)
    };
    let terminal_app = app.clone();
    let terminal_name = display_name.clone();
    let terminal_group = project_name.clone();
    let terminal_path = project_path.clone();
    let terminal_command = command;
    let terminal_id = match blocking(move || {
        let service = terminal_app.state::<TerminalService>().inner().clone();
        service.create_blank_terminal(
            terminal_type,
            Some(&terminal_name),
            Some(&terminal_group),
            0,
            0,
            Some(&terminal_path),
            Some(&terminal_command),
            true,
            terminal_app.clone(),
            owner,
            TerminalCreator::Desktop,
        )
    })
    .await
    {
        Ok(id) => id,
        Err(error) => return failed(format!("启动终端失败：{error}")),
    };

    set_active_session(&task.id, &run.id, None, Some(terminal_id.clone()));
    emit_created_terminal(&app, &terminal_id);

    let mut live_run = run.clone();
    live_run.terminal_id = Some(terminal_id.clone());
    live_run.agent = Some(agent.clone());
    live_run.provider_name = provider_name.clone();
    live_run.model = model.clone();
    let live_for_write = live_run.clone();
    let _ = crate::runtime::async_runtime::spawn_blocking(move || update_run(&live_for_write)).await;
    emit_run(&app, task, &live_run);

    // 停止可能发生在终端创建之前；建完立刻补一次检查。
    if stop_requested(&task.id, &run.id) {
        let teardown_app = app.clone();
        let teardown_id = terminal_id.clone();
        let _ = crate::runtime::async_runtime::spawn_blocking(move || {
            teardown_terminal(&teardown_app, &teardown_id, TerminalCloseReason::ScheduledClose);
        })
        .await;
        return RunOutcome {
            status: "stopped".into(),
            message: Some("已手动停止".into()),
            terminal_id: Some(terminal_id),
            agent: Some(agent),
            provider_name,
            model,
            ..Default::default()
        };
    }

    // 等待 Agent 就绪后注入任务描述。不能把描述塞进启动参数：
    // 首条 argv 不经过 REPL 输入框，斜杠命令不会展开。
    let inject_started = std::time::Instant::now();
    // Codex / Antigravity 没有可用的启动阶段信号时，等一小段时间后照常键入。
    let agent_fallback_at = inject_started + std::time::Duration::from_secs(8);
    loop {
        if stop_requested(&task.id, &run.id) {
            let teardown_app = app.clone();
            let teardown_id = terminal_id.clone();
            let _ = crate::runtime::async_runtime::spawn_blocking(move || {
                teardown_terminal(&teardown_app, &teardown_id, TerminalCloseReason::ScheduledClose);
            })
            .await;
            return RunOutcome {
                status: "stopped".into(),
                message: Some("已手动停止".into()),
                terminal_id: Some(terminal_id),
                agent: Some(agent),
                provider_name,
                model,
                ..Default::default()
            };
        }
        if inject_started.elapsed() > std::time::Duration::from_secs(60) {
            return RunOutcome {
                status: "failed".into(),
                message: Some("Agent 未启动或未注册 Hook，请查看终端".into()),
                terminal_id: Some(terminal_id),
                agent: Some(agent),
                provider_name,
                model,
                ..Default::default()
            };
        }
        let Some(snapshot) = terminal_agent_relay::scheduled_snapshot(&app, actor, &terminal_id).await else {
            // 停止先关终端、下一轮才回到循环顶部时，这里也要按停止收尾。
            let stopped_by_user = stop_requested(&task.id, &run.id);
            return RunOutcome {
                status: if stopped_by_user { "stopped".into() } else { "failed".into() },
                message: Some(if stopped_by_user { "已手动停止".into() } else { "终端已关闭".into() }),
                terminal_id: Some(terminal_id),
                agent: Some(agent),
                provider_name,
                model,
                ..Default::default()
            };
        };
        let ready = if agent == "codex" {
            snapshot.provider.is_some() || std::time::Instant::now() >= agent_fallback_at
        } else if agent == "antigravity" {
            // 优先等进程发现链绑定 conversation；新会话可能在首条消息后才有 id，
            // 超时后直接按启动命令已识别出的 Antigravity 就绪处理。
            snapshot.provider.as_deref() == Some("antigravity")
                && (terminal_task_service::current_binding(&terminal_id).is_some()
                    || std::time::Instant::now() >= agent_fallback_at)
        } else {
            snapshot.provider.as_deref() == Some("claude") && snapshot.phase == "idle"
        };
        if ready {
            // SessionStart / 进程发现只代表会话已建立，输入框与 MCP/技能初始化可能还在跑；
            // 留一段时间再键入，过早写入会落进尚未挂载的输入框。
            tokio::time::sleep(std::time::Duration::from_millis(if agent == "antigravity" { 2_500 } else { 1_500 })).await;
            if stop_requested(&task.id, &run.id) {
                let teardown_app = app.clone();
                let teardown_id = terminal_id.clone();
                let _ = crate::runtime::async_runtime::spawn_blocking(move || {
                    teardown_terminal(&teardown_app, &teardown_id, TerminalCloseReason::ScheduledClose);
                })
                .await;
                return RunOutcome {
                    status: "stopped".into(),
                    message: Some("已手动停止".into()),
                    terminal_id: Some(terminal_id),
                    agent: Some(agent),
                    provider_name,
                    model,
                    ..Default::default()
                };
            }
            if let Err(error) =
                terminal_agent_relay::submit_task_prompt(&app, actor, &terminal_id, &prompt).await
            {
                let stopped_by_user = stop_requested(&task.id, &run.id);
                return RunOutcome {
                    status: if stopped_by_user { "stopped".into() } else { "failed".into() },
                    message: Some(if stopped_by_user {
                        "已手动停止".into()
                    } else {
                        format!("提交任务描述失败：{}", error.message())
                    }),
                    terminal_id: Some(terminal_id),
                    agent: Some(agent),
                    provider_name,
                    model,
                    ..Default::default()
                };
            }
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    let timeout = std::time::Duration::from_secs(task.timeout_minutes.max(1) as u64 * 60);
    let started = std::time::Instant::now();
    let injected_at = std::time::Instant::now();
    let mut saw_running = false;
    let mut idle_streak = 0u32;
    let mut approval_notified = false;
    let mut last_summary: Option<String> = None;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_SECONDS)).await;
        if started.elapsed() > timeout {
            let teardown_app = app.clone();
            let teardown_id = terminal_id.clone();
            let _ = crate::runtime::async_runtime::spawn_blocking(move || {
                teardown_terminal(&teardown_app, &teardown_id, TerminalCloseReason::ScheduledClose);
            })
            .await;
            return RunOutcome {
                status: "timeout".into(),
                message: Some(format!("执行超时（{} 分钟），已停止", task.timeout_minutes)),
                terminal_id: Some(terminal_id),
                agent: Some(agent),
                provider_name,
                model,
                ..Default::default()
            };
        }
        if stop_requested(&task.id, &run.id) {
            let teardown_app = app.clone();
            let teardown_id = terminal_id.clone();
            let _ = crate::runtime::async_runtime::spawn_blocking(move || {
                teardown_terminal(&teardown_app, &teardown_id, TerminalCloseReason::ScheduledClose);
            })
            .await;
            return RunOutcome {
                status: "stopped".into(),
                message: Some("已手动停止".into()),
                terminal_id: Some(terminal_id),
                agent: Some(agent),
                provider_name,
                model,
                ..Default::default()
            };
        }
        let Some(snapshot) = terminal_agent_relay::scheduled_snapshot(&app, actor, &terminal_id).await else {
            return RunOutcome {
                status: "stopped".into(),
                message: Some("终端已关闭".into()),
                terminal_id: Some(terminal_id),
                agent: Some(agent),
                provider_name,
                model,
                ..Default::default()
            };
        };
        if let Some(text) = &snapshot.last_assistant_message {
            last_summary = Some(text.clone());
        }
        let action = classify_terminal_snapshot(
            &mut saw_running,
            &mut idle_streak,
            snapshot.provider.as_deref(),
            &snapshot.phase,
            snapshot.turn_end.as_deref(),
            snapshot.pending_decision_count,
            false,
        );
        // 注入后 60 秒还没进入 running：描述可能没被接受（Hook 失效/输入没落进
        // 输入框），不能一直挂到 timeout_minutes。
        if matches!(action, TerminalRunAction::Continue)
            && !saw_running
            && injected_at.elapsed() > std::time::Duration::from_secs(60)
        {
            return RunOutcome {
                status: "failed".into(),
                message: Some("Agent 未响应任务描述，请查看终端".into()),
                terminal_id: Some(terminal_id),
                agent: Some(agent),
                provider_name,
                model,
                ..Default::default()
            };
        }
        match action {
            TerminalRunAction::Continue => {
                if approval_notified && snapshot.phase == "running" {
                    approval_notified = false;
                    let mut resumed = live_run.clone();
                    resumed.status = "running".into();
                    resumed.message = Some("继续执行中".into());
                    let resumed_for_write = resumed.clone();
                    let _ = crate::runtime::async_runtime::spawn_blocking(move || update_run(&resumed_for_write)).await;
                    emit_run(&app, task, &resumed);
                }
            }
            TerminalRunAction::WaitingApproval => {
                if !approval_notified {
                    approval_notified = true;
                    let mut waiting = live_run.clone();
                    waiting.status = "waitingApproval".into();
                    waiting.message = Some("等待处理权限询问，请在终端中回答".into());
                    let waiting_for_write = waiting.clone();
                    let _ = crate::runtime::async_runtime::spawn_blocking(move || update_run(&waiting_for_write)).await;
                    emit_run(&app, task, &waiting);
                    if task.notify {
                        AppNotificationService::publish_scheduled(
                            "approval",
                            &task.name,
                            "等待处理权限询问，请在终端中回答",
                            &task.id,
                            &run.id,
                            None,
                        );
                    }
                }
            }
            TerminalRunAction::Completed { message } => {
                let (input_tokens, output_tokens) = terminal_usage(&terminal_id).await;
                return RunOutcome {
                    status: "completed".into(),
                    message: Some(message.or(last_summary).unwrap_or_else(|| "执行完成".to_string())),
                    terminal_id: Some(terminal_id),
                    agent: Some(agent),
                    provider_name,
                    model,
                    input_tokens,
                    output_tokens,
                    ..Default::default()
                };
            }
            TerminalRunAction::Failed { message } => {
                let (input_tokens, output_tokens) = terminal_usage(&terminal_id).await;
                return RunOutcome {
                    status: "failed".into(),
                    message: Some(message),
                    terminal_id: Some(terminal_id),
                    agent: Some(agent),
                    provider_name,
                    model,
                    input_tokens,
                    output_tokens,
                    ..Default::default()
                };
            }
            TerminalRunAction::Stopped { message } => {
                let (input_tokens, output_tokens) = terminal_usage(&terminal_id).await;
                return RunOutcome {
                    status: "stopped".into(),
                    message: Some(message),
                    terminal_id: Some(terminal_id),
                    agent: Some(agent),
                    provider_name,
                    model,
                    input_tokens,
                    output_tokens,
                    ..Default::default()
                };
            }
        }
    }
}

async fn terminal_usage(terminal_id: &str) -> (Option<u64>, Option<u64>) {
    let id = terminal_id.to_string();
    match blocking(move || agent_usage_service::usage(&id)).await {
        Ok(Some(usage)) => (usage.total.input_tokens, usage.total.output_tokens),
        _ => (None, None),
    }
}

async fn run_profile(app: AppHandle, task: &ScheduledTask, _run: &ScheduledRun) -> RunOutcome {
    let TaskTarget::ProjectProfile { project_name, profile_id, auto_close_minutes } = &task.target else {
        return failed("任务类型不匹配");
    };
    let (project_name, profile_id, auto_close_minutes) =
        (project_name.clone(), profile_id.clone(), *auto_close_minutes);

    let profile = match blocking(move || ProfileService::get_profile(&profile_id)).await {
        Ok(profile) => profile,
        Err(_) => return failed("所选终端配置已删除，请编辑任务"),
    };
    let normalized_group = if profile.group.trim().is_empty() { "默认" } else { profile.group.as_str() };
    if normalized_group != project_name {
        return failed("终端配置不属于所选项目，请编辑任务");
    }
    let project = match blocking(move || find_project(&project_name)).await {
        Ok(project) => project,
        Err(error) => return failed(error),
    };
    let project_path = match project_path(&project) {
        Ok(path) => path,
        Err(error) => return failed(error),
    };

    let display_name = format!("定时 · {}", task.name);
    let terminal_app = app.clone();
    let terminal_profile = profile.id.clone();
    let owner = if cfg!(feature = "desktop") { TerminalOwner::Pc } else { TerminalOwner::Web };
    let terminal_id = match blocking(move || {
        let service = terminal_app.state::<TerminalService>().inner().clone();
        service.create_terminal(
            &terminal_profile,
            Some(&display_name),
            None,
            None,
            0,
            0,
            Some(&project_path),
            false,
            terminal_app.clone(),
            owner,
            TerminalCreator::Desktop,
        )
    })
    .await
    {
        Ok(id) => id,
        Err(error) => return failed(format!("启动终端失败：{error}")),
    };

    set_active_session(&task.id, &_run.id, None, Some(terminal_id.clone()));
    emit_created_terminal(&app, &terminal_id);

    if auto_close_minutes > 0 {
        let close_app = app.clone();
        let close_terminal = terminal_id.clone();
        crate::runtime::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(auto_close_minutes as u64 * 60)).await;
            let _ = crate::runtime::async_runtime::spawn_blocking(move || {
                teardown_terminal(&close_app, &close_terminal, TerminalCloseReason::ScheduledClose)
            })
            .await;
        });
    }

    RunOutcome {
        status: "started".into(),
        message: Some("终端已启动".into()),
        terminal_id: Some(terminal_id),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_task(schedule: TaskSchedule) -> ScheduledTask {
        ScheduledTask {
            id: Uuid::new_v4().to_string(),
            name: "测试任务".into(),
            enabled: true,
            timezone: "Asia/Shanghai".into(),
            schedule,
            target: TaskTarget::ProjectProfile {
                project_name: "TerminalBuddy".into(),
                profile_id: "p1".into(),
                auto_close_minutes: 0,
            },
            notify: true,
            timeout_minutes: 30,
            created_at: 0,
            updated_at: 0,
            last_scheduled_at: None,
            last_run_at: None,
        }
    }

    fn utc(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, hour, minute, 0).unwrap()
    }

    #[test]
    fn cron_next_run_respects_task_timezone() {
        let schedule = TaskSchedule::Cron { expression: "0 9 * * *".into() };
        let after = utc(2026, 11, 17, 0, 0);
        let shanghai = parse_timezone("Asia/Shanghai").unwrap();
        let utc_zone = parse_timezone("UTC").unwrap();
        let in_shanghai = next_after(&schedule, after, shanghai).unwrap();
        let in_utc = next_after(&schedule, after, utc_zone).unwrap();
        // 北京时间 09:00 = 01:00 UTC；UTC 09:00 = 09:00 UTC，相差 8 小时。
        assert_eq!(in_shanghai, utc(2026, 11, 17, 1, 0));
        assert_eq!(in_utc, utc(2026, 11, 17, 9, 0));
        assert_eq!(in_utc - in_shanghai, Duration::hours(8));
    }

    #[test]
    fn standard_crontab_weekdays_are_translated() {
        let shanghai = parse_timezone("Asia/Shanghai").unwrap();
        // 标准 crontab：1 = 周一 .. 5 = 周五。周五 18:00 之后下一工作日是周一 09:00。
        let weekdays = TaskSchedule::Cron { expression: "0 9 * * 1-5".into() };
        let next = next_after(&weekdays, utc(2026, 11, 13, 10, 0), shanghai).unwrap();
        assert_eq!(next, utc(2026, 11, 16, 1, 0));

        // 标准 crontab：7 = 周日。周六 18:00 之后下一次是周日 09:00。
        let sunday = TaskSchedule::Cron { expression: "0 9 * * 7".into() };
        let next = next_after(&sunday, utc(2026, 11, 14, 10, 0), shanghai).unwrap();
        assert_eq!(next, utc(2026, 11, 15, 1, 0));
    }

    #[test]
    fn missed_occurrence_outside_grace_is_skipped() {
        let mut task = fixed_task(TaskSchedule::Cron { expression: "0 9 * * *".into() });
        task.created_at = utc(2026, 11, 15, 0, 0).timestamp_millis();
        task.last_scheduled_at = Some(task.created_at);
        let now = utc(2026, 11, 17, 12, 0);
        let (_, should_run) = due_occurrence(&task, now).unwrap();
        // 最近一次是北京时间今天 09:00，已经过去 11 小时，超出 5 分钟宽限。
        assert!(!should_run);
        // 锚点推进后同一时刻不会重复触发。
        task.last_scheduled_at = Some(now.timestamp_millis());
        assert!(due_occurrence(&task, now).is_none());
    }

    #[test]
    fn hourly_task_does_not_burst_after_downtime() {
        let mut task = fixed_task(TaskSchedule::Cron { expression: "0 * * * *".into() });
        task.created_at = utc(2026, 11, 17, 0, 30).timestamp_millis();
        task.last_scheduled_at = Some(task.created_at);
        // 停机 6 小时：只返回一次决策且不补跑，不会逐个补跑 06:00 之前的时刻。
        let (_, should_run) = due_occurrence(&task, utc(2026, 11, 17, 6, 10)).unwrap();
        assert!(!should_run);
        // 宽限期内的最近一次仍然执行。
        let (latest, should_run) = due_occurrence(&task, utc(2026, 11, 17, 6, 3)).unwrap();
        assert_eq!(latest, utc(2026, 11, 17, 6, 0));
        assert!(should_run);
    }

    #[test]
    fn once_task_consumes_and_stops_repeating() {
        let shanghai = parse_timezone("Asia/Shanghai").unwrap();
        let run_at = "2026-11-20T09:30";
        let at = once_as_utc(run_at, shanghai).unwrap();
        let mut task = fixed_task(TaskSchedule::Once { run_at: run_at.into() });
        task.created_at = (at - Duration::hours(1)).timestamp_millis();
        let (latest, should_run) = due_occurrence(&task, at + Duration::minutes(1)).unwrap();
        assert_eq!(latest, at);
        assert!(should_run);

        // 模拟 tick：锚点推进到计划时刻，并把仅一次任务停用。
        task.last_scheduled_at = Some(latest.timestamp_millis());
        task.enabled = false;
        assert!(due_occurrence(&task, at + Duration::minutes(10)).is_none());
    }

    #[test]
    fn manual_run_dedup_within_five_seconds() {
        assert!(manual_run_allowed(None, 10_000));
        assert!(!manual_run_allowed(Some(10_000), 14_999));
        assert!(manual_run_allowed(Some(10_000), 15_000));
    }

    #[test]
    fn concurrency_skip_policy() {
        assert_eq!(run_admission(false, 0), RunAdmission::Allowed);
        assert_eq!(run_admission(false, 2), RunAdmission::Allowed);
        assert_eq!(run_admission(true, 0), RunAdmission::TaskRunning);
        assert_eq!(run_admission(false, 3), RunAdmission::GlobalLimit);
    }

    fn test_data_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "terminal-buddy-scheduled-{name}-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        PathService::set_test_data_dir(Some(dir.clone()));
        dir
    }

    fn cleanup(dir: &Path) {
        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn versioned_tasks_file_reads_legacy_array() {
        let dir = test_data_dir("legacy");
        let tasks_dir = dir.join("ScheduledTasks");
        fs::create_dir_all(&tasks_dir).unwrap();
        let task = fixed_task(TaskSchedule::Cron { expression: "0 9 * * *".into() });
        // 旧版本是无包装的数组。
        fs::write(
            tasks_dir.join("tasks.json"),
            serde_json::to_vec(&vec![task.clone()]).unwrap(),
        )
        .unwrap();
        let loaded = load_defs().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, task.id);

        // 版本化包装同样可读。
        let file = TasksFile { version: 1, tasks: vec![task.clone()] };
        fs::write(tasks_dir.join("tasks.json"), serde_json::to_vec(&file).unwrap()).unwrap();
        assert_eq!(load_defs().unwrap().len(), 1);
        cleanup(&dir);
    }

    #[test]
    fn runs_are_capped_at_100() {
        let dir = test_data_dir("runs");
        let task = fixed_task(TaskSchedule::Cron { expression: "0 9 * * *".into() });
        for index in 0..105 {
            let mut run = new_run(&task, "scheduled");
            run.id = format!("run-{index}");
            run.started_at = index;
            append_run(&run);
        }
        let runs = read_runs(&task.id);
        assert_eq!(runs.len(), MAX_RUNS_PER_TASK);
        assert_eq!(runs.first().unwrap().id, "run-5");
        assert_eq!(runs.last().unwrap().id, "run-104");
        cleanup(&dir);
    }

    #[test]
    fn next_run_resets_after_schedule_edit() {
        let dir = test_data_dir("edit");
        let projects = vec![crate::commands::profile::Project {
            name: "TerminalBuddy".into(),
            path: dir.to_string_lossy().to_string(),
            startup_command: String::new(),
            enabled_agents: Default::default(),
        }];
        let profiles = vec![crate::models::Profile {
            id: "p1".into(),
            name: "开发环境".into(),
            group: "TerminalBuddy".into(),
            terminal_type: "cmd".into(),
            startup_path: String::new(),
            startup_commands: Vec::new(),
            environment_variables: Default::default(),
            color_theme: "dark-default".into(),
            tab_color: None,
            window_size: None,
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_auth_type: None,
            ssh_key_path: None,
            ssh_password: None,
            docker_container_id: None,
            docker_container_name: None,
            k8s_namespace: None,
            k8s_pod_name: None,
            k8s_container_name: None,
            mstsc_host: None,
            mstsc_port: None,
            mstsc_user: None,
            mstsc_password: None,
            mstsc_resolution: None,
            created_at: String::new(),
            last_used_at: None,
            pinned: false,
        }];
        let target = TaskTarget::ProjectProfile {
            project_name: "TerminalBuddy".into(),
            profile_id: "p1".into(),
            auto_close_minutes: 0,
        };
        let make_input = |id: Option<String>, expression: &str| ScheduledTaskInput {
            id,
            name: "测试任务".into(),
            enabled: true,
            timezone: "Asia/Shanghai".into(),
            schedule: TaskSchedule::Cron { expression: expression.into() },
            target: target.clone(),
            notify: None,
            timeout_minutes: None,
        };
        let (created, is_new) = persist_save(make_input(None, "0 9 * * *"), &projects, &profiles, 1_000).unwrap();
        assert!(is_new);
        // 把锚点改到很久以前，模拟历史任务。
        {
            let _guard = store_lock().lock().unwrap();
            let mut tasks = load_defs().unwrap();
            tasks[0].last_scheduled_at = Some(0);
            save_defs(&tasks).unwrap();
        }
        let (updated, is_new) = persist_save(
            make_input(Some(created.id.clone()), "30 10 * * *"),
            &projects,
            &profiles,
            2_000_000_000_000,
        )
        .unwrap();
        assert!(!is_new);
        assert_eq!(updated.last_scheduled_at, Some(2_000_000_000_000));
        // 修改调度后从当前时刻重新计算，下次执行一定在未来。
        assert!(next_run_at(&updated, Utc.timestamp_millis_opt(2_000_000_000_000).unwrap())
            .is_some_and(|next| next > 2_000_000_000_000));
        cleanup(&dir);
    }

    #[test]
    fn terminal_command_head_strips_catalog_source_prefix() {
        assert_eq!(
            terminal_command_head("claude", Some("llm:abc-123"), Some("deepseek-v4.1-flash")).unwrap(),
            "__TB_CLAUDE_REF__:abc-123:deepseek-v4.1-flash"
        );
        assert_eq!(
            terminal_command_head("codex", Some("codex:abc-123"), Some("gpt-5-codex")).unwrap(),
            "__TB_CODEX_REF__:abc-123:gpt-5-codex"
        );
        assert_eq!(
            terminal_command_head("claude", Some("claude:abc-123"), Some("opus")).unwrap(),
            "__TB_CLAUDE_PROVIDER_REF__:abc-123:opus"
        );
        // Claude 订阅供应商允许空模型（目录里存在「服务端默认模型」）。
        assert_eq!(
            terminal_command_head("claude", Some("claude:abc-123"), None).unwrap(),
            "__TB_CLAUDE_PROVIDER_REF__:abc-123"
        );
        assert_eq!(terminal_command_head("claude", Some("default:claude"), None).unwrap(), "claude");
        assert_eq!(terminal_command_head("codex", Some("default:codex"), None).unwrap(), "codex");
        assert_eq!(terminal_command_head("claude", None, None).unwrap(), "claude");
        // 供应商与 Agent 不匹配、llm/codex 缺模型都必须明确报错。
        assert!(terminal_command_head("codex", Some("llm:abc"), Some("m")).is_err());
        assert!(terminal_command_head("claude", Some("llm:abc"), None).is_err());
        assert!(terminal_command_head("claude", Some("codex:abc"), Some("m")).is_err());
    }

    #[test]
    fn antigravity_command_uses_configured_base_or_default() {
        assert_eq!(resolve_antigravity_command(""), DEFAULT_ANTIGRAVITY_COMMAND);
        assert_eq!(resolve_antigravity_command("   "), DEFAULT_ANTIGRAVITY_COMMAND);
        assert_eq!(
            resolve_antigravity_command("agy --model gemini-3.1-pro-high"),
            "agy --model gemini-3.1-pro-high"
        );
    }

    #[test]
    fn shell_quote_handles_both_shell_families() {
        assert_eq!(shell_quote("a b", "powershell").unwrap(), "'a b'");
        assert_eq!(shell_quote("it's", "pwsh").unwrap(), "'it''s'");
        assert_eq!(shell_quote("it's", "bash").unwrap(), "'it'\\''s'");
        assert!(shell_quote("x", "cmd").is_err());
    }

    #[test]
    fn task_prompt_allows_slash_and_rejects_control_chars() {
        assert_eq!(normalize_task_prompt("/git-commit-helper").unwrap(), "/git-commit-helper");
        assert_eq!(normalize_task_prompt("!echo hi").unwrap(), "!echo hi");
        assert_eq!(normalize_task_prompt("a\r\nb\rc").unwrap(), "a\nb\nc");
        assert_eq!(normalize_task_prompt(&"x".repeat(8_000)).unwrap().len(), 8_000);
        assert!(normalize_task_prompt("  ").is_err());
        assert!(normalize_task_prompt("a\u{3}b").is_err());
        assert!(normalize_task_prompt("a\tb").is_err());
    }

    #[test]
    fn terminal_classifier_handles_completion_interruption_and_stop() {
        // stop 优先于一切。
        assert_eq!(
            classify_terminal_snapshot(&mut true, &mut 0, Some("claude"), "running", None, 0, true),
            TerminalRunAction::Stopped { message: "已手动停止".into() }
        );
        // 待决策 / attention 两种信号都算等待确认。
        assert_eq!(
            classify_terminal_snapshot(&mut true, &mut 0, Some("claude"), "running", None, 1, false),
            TerminalRunAction::WaitingApproval
        );
        assert_eq!(
            classify_terminal_snapshot(&mut true, &mut 0, Some("claude"), "attention", None, 0, false),
            TerminalRunAction::WaitingApproval
        );
        // running 记住「已开始」，unknown 不应误判完成。
        let mut saw_running = false;
        let mut idle_streak = 0;
        assert_eq!(
            classify_terminal_snapshot(&mut saw_running, &mut idle_streak, Some("claude"), "running", None, 0, false),
            TerminalRunAction::Continue
        );
        assert!(saw_running);
        assert_eq!(
            classify_terminal_snapshot(&mut saw_running, &mut idle_streak, Some("claude"), "unknown", None, 0, false),
            TerminalRunAction::Continue
        );
        // completed：正常完成；带 interrupted 标记视为失败。
        assert_eq!(
            classify_terminal_snapshot(&mut saw_running, &mut idle_streak, Some("claude"), "completed", None, 0, false),
            TerminalRunAction::Completed { message: None }
        );
        assert_eq!(
            classify_terminal_snapshot(&mut saw_running, &mut idle_streak, Some("claude"), "completed", Some("interrupted"), 0, false),
            TerminalRunAction::Failed { message: "Agent 回合已被中断".into() }
        );
        // ended：完成回合后进程退出算完成；从没 running 过才算失败。
        assert_eq!(
            classify_terminal_snapshot(&mut saw_running, &mut idle_streak, Some("claude"), "ended", None, 0, false),
            TerminalRunAction::Completed { message: None }
        );
        assert_eq!(
            classify_terminal_snapshot(&mut false, &mut 0, Some("claude"), "ended", None, 0, false),
            TerminalRunAction::Failed { message: "Agent 会话已结束，未报告完成".into() }
        );
        // idle：启动期 idle 继续等；Claude 连续两轮才算完成。
        let mut not_started = false;
        let mut idle_zero = 0;
        assert_eq!(
            classify_terminal_snapshot(&mut not_started, &mut idle_zero, Some("claude"), "idle", None, 0, false),
            TerminalRunAction::Continue
        );
        assert_eq!(
            classify_terminal_snapshot(&mut saw_running, &mut idle_streak, Some("claude"), "idle", None, 0, false),
            TerminalRunAction::Continue
        );
        assert_eq!(
            classify_terminal_snapshot(&mut saw_running, &mut idle_streak, Some("claude"), "idle", None, 0, false),
            TerminalRunAction::Completed { message: None }
        );
        // Codex 正常完成写 completed；idle 是回合中止。
        let mut codex_running = true;
        let mut codex_idle = 0;
        assert_eq!(
            classify_terminal_snapshot(&mut codex_running, &mut codex_idle, Some("codex"), "idle", None, 0, false),
            TerminalRunAction::Continue
        );
        assert_eq!(
            classify_terminal_snapshot(&mut codex_running, &mut codex_idle, Some("codex"), "idle", None, 0, false),
            TerminalRunAction::Stopped { message: "Agent 回合已中止".into() }
        );
        // Claude 中断后落在 idle：不算成功。
        assert_eq!(
            classify_terminal_snapshot(&mut true, &mut 1, Some("claude"), "idle", Some("interrupted"), 0, false),
            TerminalRunAction::Failed { message: "Agent 回合已被中断".into() }
        );
    }
}
