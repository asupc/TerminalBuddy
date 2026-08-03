use crate::commands::terminal::TerminalService;
use crate::models::{
    AiAgent, AiAgentRuntime, AiArtifactMeta, AiAttempt, AiCommandResult, AiDecisionOption,
    AiDecisionRequest, AiDelivery, AiDeliveryEvent, AiDeliveryTemplate, AiMergeRecord,
    AiMergeRepositoryRecord, AiProject, AiQualityGate, AiAttemptOutput, AiRepository,
    AiRepositoryStatusBaseline, AiReviewGate, AiRole, AiRuntimeProbe, AiStartupPreset,
    AiTaskContract, AiTaskNode, AiWorkflow, CreateAiDecisionRequestInput, CreateAiDeliveryInput,
    CreateAiDeliveryTemplateInput, CreateAiProjectInput, CreateAiTaskNodeInput,
    CreateTaskContractInput, TerminalOwner, UpdateAiDeliveryInput, UpdateAiTaskNodeInput,
    UpdateAiDeliveryTemplateInput,
};
use crate::services::{BotSettingsService, DatabaseService, PathService};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// 全局 AppHandle：append_event 统一从这里推送 ai-delivery-event，由 lib.rs setup 注入。
pub static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const PROJECTS_DIR: &str = "Projects";
const RUNTIMES_DIR: &str = "Runtimes";
const AGENTS_DIR: &str = "Agents";
const ROLES_DIR: &str = "Roles";
const WORKFLOWS_DIR: &str = "Workflows";
const CONTRACTS_DIR: &str = "TaskContracts";
const DELIVERIES_DIR: &str = "Deliveries";
const TASK_NODES_DIR: &str = "TaskNodes";
const DECISIONS_DIR: &str = "DecisionRequests";
const EVENTS_DIR: &str = "Events";
const ATTEMPTS_DIR: &str = "Attempts";
const REVIEW_GATES_DIR: &str = "ReviewGates";
const MERGE_RECORDS_DIR: &str = "MergeRecords";
const PLANS_DIR: &str = "Plans";
const TERMINAL_RUNS_DIR: &str = "TerminalRuns";
const TEMPLATES_DIR: &str = "Templates";
const STARTUP_PRESETS_DIR: &str = "StartupPresets";
/// 每交付保留事件条数上限（append_event 滚动清理，超出删最旧）。
pub const MAX_EVENTS_PER_DELIVERY: usize = 1000;
/// 每交付事件目录体积上限（字节），达到后继续删最旧直到达标。
pub const MAX_EVENTS_DIR_SIZE: u64 = 5 * 1024 * 1024;
const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const QUALITY_GATE_COMMAND_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
// 首次检查不应等待 Agent 自己退出；成果文件可能已经写完而 CLI 仍停留在终端中。
const ATTEMPT_WATCHDOG_DELAY: Duration = Duration::from_secs(30);
const ATTEMPT_WATCHDOG_INTERVAL: Duration = Duration::from_secs(60);
/// 任务级超时兜底（秒），与旧固定超时 ATTEMPT_MAX_DURATION（60 分钟）对齐。
pub const DEFAULT_ATTEMPT_TIMEOUT_SECONDS: u32 = 60 * 60;
/// 耗时达到超时的该比例时提前告警。
pub const TIMEOUT_WARNING_RATIO: f32 = 0.8;
const EXECUTION_CONTEXT_WORKSPACE_ROOT: &str = "workspaceRoot";
const EXECUTION_CONTEXT_TASK_WORKTREE: &str = "taskWorktree";
/// 跨项目全局并发上限（后续可做设置项）。
pub const GLOBAL_MAX_ATTEMPTS: usize = 4;

fn resolve_execution_context(execution_mode: &str, configured: &str) -> Result<String, String> {
    let context = if configured.trim().is_empty() {
        // 旧数据没有执行目录。历史只读步骤按分析语义处理，写入步骤继续使用 worktree。
        if execution_mode == "readonly" {
            EXECUTION_CONTEXT_WORKSPACE_ROOT
        } else {
            EXECUTION_CONTEXT_TASK_WORKTREE
        }
    } else {
        configured.trim()
    };
    match context {
        EXECUTION_CONTEXT_WORKSPACE_ROOT | EXECUTION_CONTEXT_TASK_WORKTREE => Ok(context.to_string()),
        _ => Err(format!("执行目录无效: {}", context)),
    }
}

fn integration_locks() -> &'static Mutex<HashSet<String>> {
    static LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashSet::new()))
}
/// 防止同一任务的质量门禁被并发重复触发。
fn quality_gate_locks() -> &'static Mutex<HashSet<String>> {
    static LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn active_manager_plans() -> &'static Mutex<HashSet<String>> {
    static PLANS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    PLANS.get_or_init(|| Mutex::new(HashSet::new()))
}


fn runtime_save_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct IntegrationGuard { project_id: String }
impl Drop for IntegrationGuard { fn drop(&mut self) { let _ = integration_locks().lock().map(|mut l| l.remove(&self.project_id)); } }
fn acquire_integration_lock(pid: &str, op: &str) -> Result<IntegrationGuard,String> { let mut l=integration_locks().lock().unwrap_or_else(|e|e.into_inner()); if !l.insert(pid.to_string()) { return Err(format!("busy:{}",op)); } drop(l); Ok(IntegrationGuard{project_id:pid.to_string()}) }
struct QualityGateGuard { task_node_id: String }
impl Drop for QualityGateGuard { fn drop(&mut self) { let _ = quality_gate_locks().lock().map(|mut l| l.remove(&self.task_node_id)); } }
fn acquire_quality_gate_lock(tid: &str) -> Result<QualityGateGuard,String> { let mut l=quality_gate_locks().lock().map_err(|_|"lock err".to_string())?; if !l.insert(tid.to_string()) { return Err("busy".to_string()); } drop(l); Ok(QualityGateGuard{task_node_id:tid.to_string()}) }

struct ManagerPlanGuard { delivery_id: String }
impl Drop for ManagerPlanGuard { fn drop(&mut self) { let _ = active_manager_plans().lock().map(|mut l| l.remove(&self.delivery_id)); } }
#[cfg(windows)]
fn same_runtime_command(left: &AiAgentRuntime, right: &AiAgentRuntime) -> bool {
    if !left.kind.trim().eq_ignore_ascii_case(right.kind.trim()) {
        return false;
    }
    left.command
        .trim()
        .eq_ignore_ascii_case(right.command.trim())
}

#[cfg(not(windows))]
fn same_runtime_command(left: &AiAgentRuntime, right: &AiAgentRuntime) -> bool {
    if !left.kind.trim().eq_ignore_ascii_case(right.kind.trim()) {
        return false;
    }
    left.command.trim() == right.command.trim()
}

pub struct AiDeliveryService;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagerPlan {
    tasks: Vec<ManagerPlanTask>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagerPlanTask {
    title: String,
    description: String,
    role_id: Option<String>,
    #[serde(default)]
    workflow_step_id: Option<String>,
    target_repository_id: String,
    allowed_write_paths: Vec<String>,
    #[serde(default)]
    dependency_indexes: Vec<usize>,
    #[serde(default)]
    input_artifacts: Vec<String>,
    #[serde(default)]
    expected_artifacts: Vec<String>,
    #[serde(default)]
    acceptance_commands: Vec<String>,
    #[serde(default)]
    retry_count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QualityGatePlan {
    commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct RepositoryQualityContext {
    name: String,
    relative_path: String,
    default_branch: String,
    stacks: Vec<String>,
    manifests: Vec<QualityManifest>,
}

#[derive(Debug, Clone, Serialize)]
struct QualityManifest {
    relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    scripts: Option<Vec<String>>,
}

const QUALITY_GATE_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["commands"],
  "properties": {
    "commands": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string", "minLength": 1 }
    }
  },
  "additionalProperties": false
}"#;

const WORKFLOW_REVIEW_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["approved", "comments"],
  "properties": {
    "approved": { "type": "boolean" },
    "comments": { "type": "string", "minLength": 1 }
  },
  "additionalProperties": false
}"#;

const QUALITY_MANIFEST_NAMES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "cargo.toml",
    "requirements.txt",
    "pyproject.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "makefile",
    "dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
];

impl AiDeliveryService {
    fn root_dir() -> PathBuf {
        let dir = PathService::get_data_dir().join("AiDelivery");
        fs::create_dir_all(&dir).ok();
        dir
    }

    fn entity_dir(name: &str) -> PathBuf {
        let dir = Self::root_dir().join(name);
        fs::create_dir_all(&dir).ok();
        dir
    }

    fn list<T: DeserializeOwned>(dir: &str) -> Result<Vec<T>, String> {
        DatabaseService::list_ai_entities(dir)
    }

    fn save<T: Serialize>(dir: &str, id: &str, value: &T) -> Result<(), String> {
        DatabaseService::save_ai_entity(dir, id, value)
    }

    fn get<T: DeserializeOwned>(dir: &str, id: &str, label: &str) -> Result<T, String> {
        DatabaseService::get_ai_entity(dir, id, label)
    }

    fn delete(dir: &str, id: &str, label: &str) -> Result<(), String> {
        DatabaseService::delete_ai_entity(dir, id, label)
    }

    pub fn get_all_projects() -> Result<Vec<AiProject>, String> {
        let mut projects = Self::list(PROJECTS_DIR)?;
        projects
            .sort_by(|left: &AiProject, right: &AiProject| right.updated_at.cmp(&left.updated_at));
        Ok(projects)
    }

    pub fn get_project(id: &str) -> Result<AiProject, String> {
        Self::get(PROJECTS_DIR, id, "AI 项目")
    }

    pub fn create_project(input: CreateAiProjectInput) -> Result<AiProject, String> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err("项目名称不能为空".to_string());
        }
        let workspace_root = canonical_directory(&input.workspace_root)?;
        let repositories = discover_repositories(&workspace_root)?;
        if repositories.is_empty() {
            return Err("工作区及其一级子目录中未发现 Git 仓库".to_string());
        }
        let quality_gate = normalize_quality_gate(input.quality_gate)?;
        let now = chrono::Utc::now().to_rfc3339();
        let project = AiProject {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            workspace_root: workspace_root.to_string_lossy().to_string(),
            repositories,
            worktree_root: normalize_optional_directory(input.worktree_root)?,
            quality_gate,
            manager_agent_id: input.manager_agent_id,
            max_concurrency: input.max_concurrency.clamp(1, 32),
            created_at: now.clone(),
            updated_at: now,
        };
        Self::save(PROJECTS_DIR, &project.id, &project)?;
        Ok(project)
    }

    pub fn refresh_project_repositories(id: &str) -> Result<AiProject, String> {
        let mut project = Self::get_project(id)?;
        let existing = project
            .repositories
            .iter()
            .map(|repository| (repository.relative_path.clone(), repository.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut repositories = discover_repositories(Path::new(&project.workspace_root))?;
        if repositories.is_empty() {
            return Err("未发现 Git 仓库，项目配置未更新".to_string());
        }
        for repository in &mut repositories {
            if let Some(previous) = existing.get(&repository.relative_path) {
                repository.id = previous.id.clone();
                repository.write_concurrency = previous.write_concurrency;
                repository.write_enabled = previous.write_enabled;
            }
        }
        project.repositories = repositories;
        project.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(PROJECTS_DIR, &project.id, &project)?;
        Ok(project)
    }

    pub fn update_project(mut project: AiProject) -> Result<AiProject, String> {
        let existing = Self::get_project(&project.id)?;
        if project.name.trim().is_empty() {
            return Err("项目名称不能为空".to_string());
        }
        if project.workspace_root != existing.workspace_root {
            return Err("项目创建后不能修改工作区根目录，请新建项目".to_string());
        }
        project.quality_gate = normalize_quality_gate(project.quality_gate)?;
        project.max_concurrency = project.max_concurrency.clamp(1, 32);
        project.created_at = existing.created_at;
        project.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(PROJECTS_DIR, &project.id, &project)?;
        Ok(project)
    }

    pub fn generate_quality_gate_commands(
        workspace_root: &str,
        runtime_id: Option<&str>,
        agent_id: Option<&str>,
    ) -> Result<AiQualityGate, String> {
        let workspace_root = canonical_directory(workspace_root)?;
        let contexts = scan_repository_quality_contexts(&workspace_root)?;
        if contexts.is_empty() {
            return Err("工作区中未发现 Git 仓库，无法生成质量门禁命令".to_string());
        }
        let runtime =
            if let Some(runtime_id) = runtime_id.filter(|id| !id.trim().is_empty()) {
                let runtime = Self::get::<AiAgentRuntime>(RUNTIMES_DIR, runtime_id, "Runtime")?;
                if !runtime.enabled {
                    return Err("所选 Runtime 已禁用".to_string());
                }
                runtime
            } else if let Some(agent_id) = agent_id.filter(|id| !id.trim().is_empty()) {
                let agent = Self::get::<AiAgent>(AGENTS_DIR, agent_id, "管理者 Agent")?;
                if !agent.enabled {
                    return Err("项目关联的管理者 Agent 已禁用".to_string());
                }
                let runtime = Self::get::<AiAgentRuntime>(
                    RUNTIMES_DIR,
                    &agent.runtime_id,
                    "管理者 Runtime",
                )?;
                if !runtime.enabled {
                    return Err("项目关联的管理者 Runtime 已禁用".to_string());
                }
                runtime
            } else {
                Self::get_all_runtimes()?
                    .into_iter()
                    .find(|r| r.enabled)
                    .ok_or_else(|| {
                        "未找到可用的 Runtime，请先在 AI 交付设置中启用一个 Runtime"
                            .to_string()
                    })?
            };
        generate_quality_gate_with_runtime(&runtime, &workspace_root, &contexts)
    }

   pub fn delete_project(id: &str) -> Result<(), String> {
       let project = Self::get_project(id)?;
        let contracts = Self::get_all_task_contracts(Some(id))?;
        if contracts
            .iter()
            .any(|contract| !matches!(contract.state.as_str(), "completed" | "cancelled"))
        {
            return Err("项目仍有未完成的任务契约，无法删除".to_string());
        }

        let deliveries = Self::get_all_deliveries(Some(id))?;
        let delivery_ids = deliveries
            .iter()
            .map(|delivery| delivery.id.as_str())
            .collect::<HashSet<_>>();
        let attempts = Self::get_all_attempts(None)?
            .into_iter()
            .filter(|attempt| delivery_ids.contains(attempt.delivery_id.as_str()))
            .collect::<Vec<_>>();
        if attempts
            .iter()
            .any(|attempt| matches!(attempt.state.as_str(), "queued" | "starting" | "running"))
        {
            return Err("项目仍有正在运行的 Agent，无法删除".to_string());
        }

       // 项目删除时清理本应用创建的 worktree、Git 分支和产出物目录，避免资源泄漏。
       for delivery in &deliveries {
           cleanup_delivery_task_worktrees(&project, delivery);
           let _ = cleanup_delivery_integration_workspace(&project, delivery);
           for task in Self::get_task_nodes(&delivery.id)? {
                Self::delete(TASK_NODES_DIR, &task.id, "任务节点")?;
            }
            for attempt in attempts
                .iter()
                .filter(|attempt| attempt.delivery_id == delivery.id)
            {
                Self::delete(ATTEMPTS_DIR, &attempt.id, "执行尝试")?;
                let terminal_run_dir = terminal_run_dir_by_id(&attempt.id);
                let _ = fs::remove_dir_all(terminal_run_dir);
            }
            for gate in Self::get_review_gates(Some(&delivery.id))? {
                Self::delete(REVIEW_GATES_DIR, &gate.id, "审核门禁")?;
            }
            for request in Self::get_decision_requests(Some(&delivery.id))? {
                Self::delete(DECISIONS_DIR, &request.id, "决策请求")?;
            }
            for event in Self::get_delivery_events(&delivery.id)? {
                Self::delete(EVENTS_DIR, &event.id, "交付事件")?;
            }
            for record in Self::get_merge_records(Some(&delivery.id))? {
                Self::delete(MERGE_RECORDS_DIR, &record.id, "合并记录")?;
            }
            let plan_directory = Self::entity_dir(PLANS_DIR).join(safe_path_segment(&delivery.id));
            let _ = fs::remove_dir_all(plan_directory);
            Self::delete(DELIVERIES_DIR, &delivery.id, "交付")?;
        }
        for contract in contracts {
            Self::delete(CONTRACTS_DIR, &contract.id, "任务契约")?;
        }
        Self::delete(PROJECTS_DIR, id, "AI 项目")
    }

    pub fn detect_local_runtimes() -> Vec<AiRuntimeProbe> {
        let mut runtime_commands = [
            ("codex", "codex"),
            ("claude", "claude"),
            ("opencode", "opencode"),
            ("hermes", "hermes"),
            ("pi", "pi"),
            ("mimo", "mimo"),
            ("kimi", "kimi"),
        ]
        .into_iter()
        .map(|(kind, command)| (kind.to_string(), command.to_string()))
        .collect::<Vec<_>>();

        // 自定义命令可能位于非标准 PATH。保留默认探测以发现新安装的 CLI，
        // 同时探测已保存的 Runtime，确保 Agent 实际会启动的命令得到准确状态。
        for runtime in Self::get_all_runtimes().unwrap_or_default() {
            if runtime.command.trim().is_empty()
                || runtime_commands
                    .iter()
                    .any(|(kind, command)| kind == &runtime.kind && command == &runtime.command)
            {
                continue;
            }
            runtime_commands.push((runtime.kind, runtime.command));
        }

        runtime_commands
            .into_iter()
            .map(|(kind, command)| {
                let fallback = unavailable_runtime_probe(&kind, &command);
                (
                    fallback,
                    thread::spawn(move || probe_local_runtime(&kind, &command)),
                )
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(fallback, handle)| handle.join().unwrap_or(fallback))
            .collect()
    }

    pub fn get_all_runtimes() -> Result<Vec<AiAgentRuntime>, String> {
        let mut runtimes = Self::list(RUNTIMES_DIR)?;
        runtimes
            .sort_by(|left: &AiAgentRuntime, right: &AiAgentRuntime| left.name.cmp(&right.name));
        Ok(runtimes)
    }

    pub fn save_runtime(mut runtime: AiAgentRuntime) -> Result<AiAgentRuntime, String> {
        let _lock = runtime_save_lock()
            .lock()
            .map_err(|_| "Runtime 保存锁异常".to_string())?;
        validate_runtime(&runtime)?;
        if let Some(existing) = Self::list::<AiAgentRuntime>(RUNTIMES_DIR)?
            .into_iter()
            .find(|item| item.id != runtime.id && same_runtime_command(item, &runtime))
        {
            return Ok(existing);
        }
        let now = chrono::Utc::now().to_rfc3339();
        if runtime.id.trim().is_empty() {
            runtime.id = Uuid::new_v4().to_string();
            runtime.created_at = now.clone();
        } else if let Ok(existing) =
            Self::get::<AiAgentRuntime>(RUNTIMES_DIR, &runtime.id, "运行时")
        {
            runtime.created_at = existing.created_at;
        } else if runtime.created_at.is_empty() {
            runtime.created_at = now.clone();
        }
        runtime.updated_at = now;
        Self::save(RUNTIMES_DIR, &runtime.id, &runtime)?;
        Ok(runtime)
    }

    pub fn delete_runtime(id: &str) -> Result<(), String> {
        if Self::get_all_agents()?
            .iter()
            .any(|agent| agent.runtime_id == id)
        {
            return Err("仍有 Agent 使用该运行时，无法删除".to_string());
        }
        Self::delete(RUNTIMES_DIR, id, "运行时")
    }

    pub fn get_all_agents() -> Result<Vec<AiAgent>, String> {
        let mut agents = Self::list(AGENTS_DIR)?;
        agents.sort_by(|left: &AiAgent, right: &AiAgent| left.name.cmp(&right.name));
        Ok(agents)
    }

    pub fn save_agent(mut agent: AiAgent) -> Result<AiAgent, String> {
        if agent.name.trim().is_empty() {
            return Err("Agent 名称不能为空".to_string());
        }
        Self::get::<AiAgentRuntime>(RUNTIMES_DIR, &agent.runtime_id, "运行时")?;
        validate_agent_configuration(&agent)?;
        let now = chrono::Utc::now().to_rfc3339();
        if agent.id.trim().is_empty() {
            agent.id = Uuid::new_v4().to_string();
            agent.created_at = now.clone();
        } else if let Ok(existing) = Self::get::<AiAgent>(AGENTS_DIR, &agent.id, "Agent") {
            agent.created_at = existing.created_at;
        } else if agent.created_at.is_empty() {
            agent.created_at = now.clone();
        }
        agent.max_concurrency = agent.max_concurrency.clamp(1, 16);
        agent.updated_at = now;
        Self::save(AGENTS_DIR, &agent.id, &agent)?;
        Ok(agent)
    }

    pub fn delete_agent(id: &str) -> Result<(), String> {
        if Self::get_all_roles()?.iter().any(|role| {
            role.locked_agent_id.as_deref() == Some(id)
                || role
                    .candidate_agent_ids
                    .iter()
                    .any(|agent_id| agent_id == id)
        }) {
            return Err("仍有角色引用该 Agent，无法删除".to_string());
        }
        if Self::get_all_workflows()?
            .iter()
            .any(|workflow| {
                workflow
                    .steps
                    .iter()
                    .any(|step| step.role_id.is_none() && step.agent_id == id)
            })
        {
            return Err("仍有编排步骤引用该 Agent，无法删除".to_string());
        }
        Self::delete(AGENTS_DIR, id, "Agent")
    }

    pub fn get_all_startup_presets() -> Result<Vec<AiStartupPreset>, String> {
        let mut presets = Self::list(STARTUP_PRESETS_DIR)?;
        presets.sort_by(|left: &AiStartupPreset, right: &AiStartupPreset| {
            right.updated_at.cmp(&left.updated_at)
        });
        Ok(presets)
    }

    pub fn get_startup_preset_by_name(name: &str) -> Result<AiStartupPreset, String> {
        Self::get_all_startup_presets()?
            .into_iter()
            .find(|preset| preset.name == name)
            .ok_or_else(|| format!("启动预设不存在: {}", name))
    }

    pub fn save_startup_preset(mut preset: AiStartupPreset) -> Result<AiStartupPreset, String> {
        let name = preset.name.trim();
        if name.is_empty() {
            return Err("预设名称不能为空".to_string());
        }
        preset.name = name.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let mut existing_created_at = None;
        if preset.id.trim().is_empty() {
            preset.id = Uuid::new_v4().to_string();
        } else {
            existing_created_at = Self::get::<AiStartupPreset>(
                STARTUP_PRESETS_DIR,
                &preset.id,
                "启动预设",
            )
            .ok()
            .map(|existing| existing.created_at);
        }
        if Self::get_all_startup_presets()?
            .iter()
            .any(|other| other.id != preset.id && other.name == preset.name)
        {
            return Err(format!("启动预设名称已存在: {}", preset.name));
        }
        preset.created_at = existing_created_at.unwrap_or_else(|| now.clone());
        preset.updated_at = now;
        Self::save(STARTUP_PRESETS_DIR, &preset.id, &preset)?;
        Ok(preset)
    }

    pub fn delete_startup_preset(id: &str) -> Result<(), String> {
        Self::delete(STARTUP_PRESETS_DIR, id, "启动预设")
    }

    pub fn get_all_roles() -> Result<Vec<AiRole>, String> {
        let mut roles = Self::list(ROLES_DIR)?;
        roles.sort_by(|left: &AiRole, right: &AiRole| left.name.cmp(&right.name));
        Ok(roles)
    }

    pub fn save_role(mut role: AiRole) -> Result<AiRole, String> {
        if role.name.trim().is_empty() {
            return Err("角色名称不能为空".to_string());
        }
        let agents = Self::get_all_agents()?;
        for agent_id in &role.candidate_agent_ids {
            if !agents.iter().any(|agent| agent.id == *agent_id) {
                return Err(format!("候选 Agent 不存在: {}", agent_id));
            }
        }
        if let Some(agent_id) = role.locked_agent_id.as_deref() {
            if !role
                .candidate_agent_ids
                .iter()
                .any(|candidate| candidate == agent_id)
            {
                return Err("锁定 Agent 必须包含在候选 Agent 中".to_string());
            }
        }
        let now = chrono::Utc::now().to_rfc3339();
        if role.id.trim().is_empty() {
            role.id = Uuid::new_v4().to_string();
            role.created_at = now.clone();
        } else if let Ok(existing) = Self::get::<AiRole>(ROLES_DIR, &role.id, "角色") {
            role.created_at = existing.created_at;
        } else if role.created_at.is_empty() {
            role.created_at = now.clone();
        }
        role.updated_at = now;
        Self::save(ROLES_DIR, &role.id, &role)?;
        Ok(role)
    }

    pub fn delete_role(id: &str) -> Result<(), String> {
        if Self::get_all_workflows()?.iter().any(|workflow| {
            workflow
                .steps
                .iter()
                .any(|step| step.role_id.as_deref() == Some(id))
        }) {
            return Err("仍有编排步骤引用该角色，无法删除".to_string());
        }
        Self::delete(ROLES_DIR, id, "角色")
    }

    pub fn get_all_workflows() -> Result<Vec<AiWorkflow>, String> {
        let mut workflows = Self::list(WORKFLOWS_DIR)?;
        workflows.sort_by(|left: &AiWorkflow, right: &AiWorkflow| {
            right.updated_at.cmp(&left.updated_at)
        });
        Ok(workflows)
    }

    /// 单步模拟测试（实验性）：用 {featureName} 占位替换后的步骤提示词，
    /// 走一次 claude --print 调用并返回输出前 2000 字符。
    /// 只调用不落盘、不建 attempt；失败仅前端展示错误，不影响既有功能。
    pub fn test_workflow_step(workflow_step_id: &str, feature_name: &str) -> Result<String, String> {
        let workflow = Self::get_all_workflows()?
            .into_iter()
            .find(|workflow| workflow.steps.iter().any(|step| step.id == workflow_step_id))
            .ok_or_else(|| "工作流步骤不存在".to_string())?;
        let step = workflow
            .steps
            .iter()
            .find(|step| step.id == workflow_step_id)
            .ok_or_else(|| "工作流步骤不存在".to_string())?;
        let prompt = if step.prompt.contains("{featureName}") {
            step.prompt.replace("{featureName}", feature_name)
        } else {
            format!("功能描述：{}\n\n{}", feature_name, step.prompt)
        };
        let runtime = Self::get_all_runtimes()?
            .into_iter()
            .filter(|runtime| runtime.enabled)
            .find(|runtime| runtime.kind == "claude")
            .ok_or_else(|| "未找到可用的 claude 运行时，无法模拟测试".to_string())?;
        let mut command_parts = split_runtime_command(&runtime.command)?;
        let executable = command_parts.remove(0);
        let mut command = Command::new(&executable);
        command.args(&command_parts);
        command.args(["--print".to_string()]);
        // 模拟测试用的提示词不落盘，直接作为参数传入（限制长度避免命令行超限）
        let clipped = if prompt.len() > 4000 {
            format!("{}…", &prompt[..prompt.ceil_char_boundary(4000)])
        } else {
            prompt
        };
        command.arg(clipped);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let output = run_command_with_timeout(
            &mut command,
            Duration::from_secs(60),
            "工作流步骤模拟测试",
        )?;
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        let text = text.trim();
        if text.is_empty() {
            return Err(format!(
                "Agent 未输出内容：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(if text.len() > 2000 {
            format!("{}…", &text[..text.ceil_char_boundary(2000)])
        } else {
            text.to_string()
        })
    }

    pub fn save_workflow(mut workflow: AiWorkflow) -> Result<AiWorkflow, String> {
        if workflow.name.trim().is_empty() {
            return Err("编排方案名称不能为空".to_string());
        }
        if workflow.steps.is_empty() {
            return Err("编排方案至少需要一个步骤".to_string());
        }
        let agents = Self::get_all_agents()?;
        let roles = Self::get_all_roles()?;
        let mut step_ids = HashSet::new();
        for step in &mut workflow.steps {
            if step.id.trim().is_empty() {
                step.id = Uuid::new_v4().to_string();
            }
            if !step_ids.insert(step.id.clone()) {
                return Err("编排步骤 ID 不能重复".to_string());
            }
            step.name = step.name.trim().to_string();
            step.prompt = step.prompt.trim().to_string();
            if step.name.is_empty() {
                return Err("编排步骤名称不能为空".to_string());
            }
            if !matches!(step.execution_mode.as_str(), "write" | "readonly") {
                return Err(format!("编排步骤“{}”的执行模式无效", step.name));
            }
            step.execution_context =
                resolve_execution_context(&step.execution_mode, &step.execution_context)?;
            if step.execution_mode == "write"
                && step.execution_context != EXECUTION_CONTEXT_TASK_WORKTREE
            {
                return Err(format!(
                    "编排步骤“{}”允许写入时必须在任务 worktree 中执行",
                    step.name
                ));
            }
            if let Some(role_id) = step.role_id.as_deref() {
                let role = roles
                    .iter()
                    .find(|role| role.id == role_id)
                    .ok_or_else(|| format!("编排步骤“{}”指定的角色不存在", step.name))?;
                if role.locked_agent_id.is_none() && role.candidate_agent_ids.is_empty() {
                    return Err(format!("编排步骤“{}”的角色未配置 Agent", step.name));
                }
            } else if step.agent_id.is_empty() {
                return Err(format!("编排步骤“{}”请选择执行角色", step.name));
            } else if !agents.iter().any(|agent| agent.id == step.agent_id) {
                return Err(format!("编排步骤“{}”指定的 Agent 不存在", step.name));
            }
        }
        workflow.name = workflow.name.trim().to_string();
        workflow.description = workflow.description.trim().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        if workflow.id.trim().is_empty() {
            workflow.id = Uuid::new_v4().to_string();
            workflow.created_at = now.clone();
        } else if let Ok(existing) =
            Self::get::<AiWorkflow>(WORKFLOWS_DIR, &workflow.id, "编排方案")
        {
            workflow.created_at = existing.created_at;
        } else if workflow.created_at.is_empty() {
            workflow.created_at = now.clone();
        }
        workflow.updated_at = now;
        Self::save(WORKFLOWS_DIR, &workflow.id, &workflow)?;
        Ok(workflow)
    }

    pub fn replan_legacy_delivery(
        id: &str,
        terminal_service: TerminalService,
    ) -> Result<AiDelivery, String> {
        let delivery = Self::get_delivery(id)?;
        let tasks = Self::get_task_nodes(id)?;
        if !is_legacy_delivery_plan(&delivery, &tasks) {
            return Err("当前交付不是需要重新规划的旧任务图".to_string());
        }
        if Self::get_all_attempts(Some(id))?
            .iter()
            .any(|attempt| matches!(attempt.state.as_str(), "queued" | "starting" | "running"))
        {
            return Err("仍有运行中的 Agent，不能重新规划".to_string());
        }
        let workflow_id = delivery
            .workflow_id
            .as_deref()
            .ok_or_else(|| "旧任务图未关联任务编排，无法自动重新规划".to_string())?;
        let mut workflow = Self::get::<AiWorkflow>(WORKFLOWS_DIR, workflow_id, "任务编排")?;
        if upgrade_legacy_workflow_steps(&mut workflow) {
            workflow.updated_at = chrono::Utc::now().to_rfc3339();
            Self::save(WORKFLOWS_DIR, &workflow.id, &workflow)?;
        }

        // 保留旧任务图、尝试和事件以便追溯；新交付从草案重新生成有效的任务契约。
        Self::cancel_delivery(id, terminal_service)?;
        let replacement = Self::create_delivery(CreateAiDeliveryInput {
            project_id: delivery.project_id.clone(),
            title: delivery.title.clone(),
            requirement: delivery.requirement.clone(),
            manager_agent_id: delivery.manager_agent_id.clone(),
            workflow_id: Some(workflow.id),
        })?;
        Self::append_event(
            &replacement.id,
            None,
            None,
            "deliveryReplanned",
            "已从旧任务图重新创建交付草案，将按升级后的流程重新生成任务节点",
        )?;
        Ok(replacement)
    }

    /// 规划中断「以当前状态重跑」：校验交付可重新规划并记录采纳事件。
    /// 基线是规划前的内存快照（非持久化），仓库被改动阻断后无需手动清理——
    /// 直接复用既有 plan 路径（commands 层 begin_delivery_planning + spawn_blocking）重新规划。
    pub fn replan_delivery_accepting_current_state(delivery_id: &str) -> Result<(), String> {
        let delivery = Self::get_delivery(delivery_id)?;
        if !matches!(delivery.state.as_str(), "drafting" | "planning" | "needsInput") {
            return Err(format!(
                "交付状态 {} 不可重新规划（仅草稿/规划中/等待决策可采纳当前状态重跑）",
                delivery.state
            ));
        }
        if Self::get_all_attempts(Some(delivery_id))?
            .iter()
            .any(|attempt| matches!(attempt.state.as_str(), "queued" | "starting" | "running"))
        {
            return Err("仍有运行中的 Agent，不能重新规划".to_string());
        }
        Self::append_event(
            delivery_id,
            None,
            None,
            "deliveryReplanned",
            "已采纳当前仓库状态并重新规划",
        )?;
        Ok(())
    }

    pub fn delete_workflow(id: &str) -> Result<(), String> {
        Self::delete(WORKFLOWS_DIR, id, "编排方案")
    }

    pub fn get_all_task_contracts(project_id: Option<&str>) -> Result<Vec<AiTaskContract>, String> {
        let mut contracts = Self::list(CONTRACTS_DIR)?;
        if let Some(project_id) = project_id {
            contracts.retain(|contract: &AiTaskContract| contract.project_id == project_id);
        }
        contracts.sort_by(|left: &AiTaskContract, right: &AiTaskContract| {
            right.updated_at.cmp(&left.updated_at)
        });
        Ok(contracts)
    }

    pub fn get_all_deliveries(project_id: Option<&str>) -> Result<Vec<AiDelivery>, String> {
        let mut deliveries: Vec<AiDelivery> = Self::list(DELIVERIES_DIR)?;
        let active_plans = active_manager_plans()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        for delivery in &mut deliveries {
            if delivery.state != "planning" || active_plans.contains(&delivery.id) {
                continue;
            }
            let stale_task_ids = std::mem::take(&mut delivery.task_node_ids);
            for task_id in stale_task_ids {
                let _ = Self::delete(TASK_NODES_DIR, &task_id, "任务节点");
            }
            for mut attempt in Self::get_all_attempts(Some(&delivery.id))?
                .into_iter()
                .filter(|attempt| attempt.task_node_id.is_empty() && attempt.state == "running")
            {
                attempt.state = "failed".to_string();
                attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
                attempt.updated_at = attempt.finished_at.clone().unwrap_or_default();
                attempt.summary = Some("应用中断，任务图生成状态已恢复".to_string());
                Self::persist_attempt(&attempt)?;
            }
            delivery.state = "drafting".to_string();
            delivery.updated_at = chrono::Utc::now().to_rfc3339();
            Self::save(DELIVERIES_DIR, &delivery.id, delivery)?;
            Self::append_event(
                &delivery.id,
                None,
                None,
                "managerPlanRecovered",
                "检测到上次应用中断的任务图生成，已恢复为草稿",
            )?;
        }
        if let Some(project_id) = project_id {
            deliveries.retain(|delivery: &AiDelivery| delivery.project_id == project_id);
        }
        deliveries.sort_by(|left: &AiDelivery, right: &AiDelivery| {
            right.updated_at.cmp(&left.updated_at)
        });
        Ok(deliveries)
    }

    pub fn get_delivery(id: &str) -> Result<AiDelivery, String> {
        Self::get(DELIVERIES_DIR, id, "交付")
    }

    pub fn create_delivery(input: CreateAiDeliveryInput) -> Result<AiDelivery, String> {
        if input.title.trim().is_empty() || input.requirement.trim().is_empty() {
            return Err("交付标题和需求不能为空".to_string());
        }
        Self::get_project(&input.project_id)?;
        if let Some(agent_id) = input.manager_agent_id.as_deref() {
            Self::get::<AiAgent>(AGENTS_DIR, agent_id, "管理者 Agent")?;
        }
        let workflow = input
            .workflow_id
            .as_deref()
            .map(|workflow_id| Self::get::<AiWorkflow>(WORKFLOWS_DIR, workflow_id, "编排方案"))
            .transpose()?;
        let now = chrono::Utc::now().to_rfc3339();
        let delivery = AiDelivery {
            id: Uuid::new_v4().to_string(),
            project_id: input.project_id,
            title: input.title.trim().to_string(),
            requirement: input.requirement.trim().to_string(),
            manager_agent_id: input.manager_agent_id,
            workflow_id: workflow.as_ref().map(|item| item.id.clone()),
            workflow_name: workflow.as_ref().map(|item| item.name.clone()),
            workflow_steps: workflow.map(|item| item.steps).unwrap_or_default(),
            state: "drafting".to_string(),
            task_node_ids: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
        Self::append_event(
            &delivery.id,
            None,
            None,
            "deliveryCreated",
            "已创建交付草案",
        )?;
        Ok(delivery)
    }

    pub fn update_delivery(input: UpdateAiDeliveryInput) -> Result<AiDelivery, String> {
        if input.title.trim().is_empty() || input.requirement.trim().is_empty() {
            return Err("交付标题和需求不能为空".to_string());
        }
        let mut delivery = Self::get_delivery(&input.id)?;
        if delivery.state != "drafting" || !delivery.task_node_ids.is_empty() {
            return Err("仅未生成任务图的交付草案可以编辑".to_string());
        }
        if let Some(manager_agent_id) = input.manager_agent_id.as_deref() {
            let manager = Self::get::<AiAgent>(AGENTS_DIR, manager_agent_id, "管理者 Agent")?;
            if !manager.enabled {
                return Err("管理者 Agent 已禁用".to_string());
            }
        }
        let workflow = input
            .workflow_id
            .as_deref()
            .map(|workflow_id| Self::get::<AiWorkflow>(WORKFLOWS_DIR, workflow_id, "编排方案"))
            .transpose()?;
        delivery.title = input.title.trim().to_string();
        delivery.requirement = input.requirement.trim().to_string();
        delivery.manager_agent_id = input.manager_agent_id;
        delivery.workflow_id = workflow.as_ref().map(|item| item.id.clone());
        delivery.workflow_name = workflow.as_ref().map(|item| item.name.clone());
        delivery.workflow_steps = workflow.map(|item| item.steps).unwrap_or_default();
        delivery.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
        Self::append_event(&delivery.id, None, None, "deliveryEdited", "交付草案已编辑")?;
        Ok(delivery)
    }

    pub fn begin_delivery_planning(id: &str) -> Result<AiAttempt, String> {
        let mut delivery = Self::get_delivery(id)?;
        if delivery.state != "drafting" || !delivery.task_node_ids.is_empty() {
            return Err("管理者仅能为尚未含任务的交付草案生成任务图".to_string());
        }
        let manager_id = delivery
            .manager_agent_id
            .as_deref()
            .ok_or_else(|| "交付未指定管理者 Agent".to_string())?;
        let manager = Self::get::<AiAgent>(AGENTS_DIR, manager_id, "管理者 Agent")?;
        if !manager.enabled {
            return Err("管理者 Agent 已禁用".to_string());
        }
        let runtime =
            Self::get::<AiAgentRuntime>(RUNTIMES_DIR, &manager.runtime_id, "管理者 Runtime")?;
        if !runtime.enabled {
            return Err("管理者 Runtime 已禁用".to_string());
        }
        let active_manager_attempts = Self::active_attempt_count_for_agent(&manager.id)?;
        if active_manager_attempts >= manager.max_concurrency as usize {
            return Err(format!(
                "管理者 Agent 已达到并发上限（{}）",
                manager.max_concurrency
            ));
        }
        active_manager_plans()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(delivery.id.clone());
        let result: Result<AiAttempt, String> = (|| {
            delivery.state = "planning".to_string();
            delivery.updated_at = chrono::Utc::now().to_rfc3339();
            Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
            let now = chrono::Utc::now().to_rfc3339();
            let attempt = AiAttempt {
                id: Uuid::new_v4().to_string(),
                delivery_id: delivery.id.clone(),
                task_node_id: String::new(),
                contract_id: String::new(),
                agent_id: manager.id,
                runtime_id: runtime.id,
                terminal_id: None,
                state: "running".to_string(),
                started_at: now.clone(),
                finished_at: None,
                exit_code: None,
                summary: Some("管理者正在分析需求并生成任务图".to_string()),
                created_at: now.clone(),
                updated_at: now,
            };
            Self::persist_attempt(&attempt)?;
            Self::append_event(
                &delivery.id,
                None,
                Some(&attempt.id),
                "managerPlanStarted",
                "管理者正在生成结构化任务图",
            )?;
            Ok(attempt)
        })();
        if let Err(error) = &result {
            let _ = Self::fail_delivery_planning(id, error);
        }
        result
    }

    pub fn fail_delivery_planning(id: &str, message: &str) -> Result<(), String> {
        let result: Result<(), String> = (|| {
            let mut delivery = Self::get_delivery(id)?;
            if !matches!(delivery.state.as_str(), "planning" | "awaitingApproval") {
                return Ok(());
            }
            let task_ids = std::mem::take(&mut delivery.task_node_ids);
            for task_id in task_ids {
                let _ = Self::delete(TASK_NODES_DIR, &task_id, "任务节点");
            }
            delivery.state = "drafting".to_string();
            delivery.updated_at = chrono::Utc::now().to_rfc3339();
            Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
            let mut manager_attempt_id = None;
            for mut attempt in Self::get_all_attempts(Some(&delivery.id))?
                .into_iter()
                .filter(|attempt| attempt.task_node_id.is_empty() && attempt.state == "running")
            {
                attempt.state = "failed".to_string();
                attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
                attempt.updated_at = attempt.finished_at.clone().unwrap_or_default();
                attempt.summary = Some(message.to_string());
                manager_attempt_id = Some(attempt.id.clone());
                Self::persist_attempt(&attempt)?;
            }
            Self::append_event(
                &delivery.id,
                None,
                manager_attempt_id.as_deref(),
                "managerPlanFailed",
                message,
            )?;
            Ok(())
        })();
        active_manager_plans()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id);
        result
    }

    pub fn plan_delivery_with_manager(
        id: &str,
        manager_attempt_id: &str,
        app: tauri::AppHandle,
        terminal_service: TerminalService,
    ) -> Result<Vec<AiTaskNode>, String> {
        let delivery = Self::get_delivery(id)?;
        if delivery.state != "planning" || !delivery.task_node_ids.is_empty() {
            return Err("交付未处于任务图生成状态".to_string());
        }
        let mut created = Vec::new();
        let _plan_guard = ManagerPlanGuard { delivery_id: delivery.id.clone() };
        let result = (|| -> Result<(), String> {
            let manager_id = delivery
                .manager_agent_id
                .as_deref()
                .ok_or_else(|| "交付未指定管理者 Agent".to_string())?;
            let manager = Self::get::<AiAgent>(AGENTS_DIR, manager_id, "管理者 Agent")?;
            let runtime =
                Self::get::<AiAgentRuntime>(RUNTIMES_DIR, &manager.runtime_id, "管理者 Runtime")?;
            let project = Self::get_project(&delivery.project_id)?;
            let roles = Self::get_all_roles()?;
            let prompt = build_manager_prompt(&delivery, &project, &roles);
            let repository_baseline = project_repository_statuses(&project)?;
            let plan_result = run_manager_planner(
                &runtime,
                &manager,
                &project,
                &delivery.id,
                manager_attempt_id,
                &prompt,
                app.clone(),
                terminal_service.clone(),
            );
            ensure_project_repository_statuses_unchanged(&project, &repository_baseline)?;
            let plan = plan_result?;
            if plan.tasks.is_empty() {
                return Err("管理者未生成任何任务节点".to_string());
            }
            validate_manager_workflow_plan(&plan, &delivery)?;
            for plan_task in plan.tasks {
                let workflow_step = plan_task.workflow_step_id.as_deref().and_then(|step_id| {
                    delivery
                        .workflow_steps
                        .iter()
                        .find(|step| step.id == step_id)
                });
                let dependencies = plan_task
                    .dependency_indexes
                    .iter()
                    .map(|index| {
                        created
                            .get(*index)
                            .map(|task: &AiTaskNode| task.id.clone())
                            .ok_or_else(|| format!("任务依赖索引无效: {}", index))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                let task = Self::create_task_node(CreateAiTaskNodeInput {
                    delivery_id: delivery.id.clone(),
                    title: plan_task.title,
                    description: plan_task.description,
                    role_id: workflow_step
                        .and_then(|step| step.role_id.clone())
                        .or(plan_task.role_id),
                    workflow_step_id: workflow_step.map(|step| step.id.clone()),
                    preferred_agent_id: workflow_step
                        .and_then(|step| {
                            (step.role_id.is_none() && !step.agent_id.is_empty())
                                .then(|| step.agent_id.clone())
                        }),
                    task_prompt: workflow_step
                        .map(|step| step.prompt.clone())
                        .unwrap_or_default(),
                    execution_mode: workflow_step
                        .map(|step| step.execution_mode.clone())
                        .unwrap_or_else(|| "write".to_string()),
                    execution_context: workflow_step
                        .map(|step| step.execution_context.clone())
                        .unwrap_or_else(|| EXECUTION_CONTEXT_TASK_WORKTREE.to_string()),
                    target_repository_id: plan_task.target_repository_id,
                    allowed_write_paths: plan_task.allowed_write_paths,
                    dependency_ids: dependencies,
                    input_artifacts: plan_task.input_artifacts,
                    expected_artifacts: plan_task.expected_artifacts,
                    acceptance_commands: plan_task.acceptance_commands,
                    retry_count: plan_task.retry_count,
            timeout_seconds: None,
                })?;
                created.push(task);
            }
            Ok(())
        })();
        let final_result = (|| match result {
            Ok(()) => {
                let mut manager_attempt =
                    Self::get::<AiAttempt>(ATTEMPTS_DIR, manager_attempt_id, "管理者执行")?;
                manager_attempt.state = "completed".to_string();
                manager_attempt.exit_code = Some(0);
                manager_attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
                manager_attempt.updated_at =
                    manager_attempt.finished_at.clone().unwrap_or_default();
                manager_attempt.summary =
                    Some(format!("任务图生成完成，共 {} 个任务节点", created.len()));
                Self::persist_attempt(&manager_attempt)?;
                Self::append_event(
                    &delivery.id,
                    None,
                    Some(manager_attempt_id),
                    "managerPlanCreated",
                    "管理者已生成结构化任务图，等待用户批准",
                )?;
                Ok(created)
            }
            Err(error) => {
                Self::fail_delivery_planning(&delivery.id, &format!("任务图生成失败: {}", error))?;
                Err(error)
            }
        })();
        final_result
    }

    pub fn delete_delivery(id: &str) -> Result<(), String> {
         let delivery = Self::get_delivery(id)?;
        if !matches!(
            delivery.state.as_str(),
            "drafting" | "cancelled" | "failed" | "succeeded" | "completed"
        ) {
            return Err("仅草稿或已结束（取消/失败/成功/完成）的交付可以删除；请先暂停或处理当前交付流程".to_string());
        }
        if delivery.state != "drafting" {
            // 非草稿状态：清理 worktree、分支和产出物目录后再删除
            if let Ok(project) = Self::get_project(&delivery.project_id) {
                cleanup_delivery_task_worktrees(&project, &delivery);
                let _ = cleanup_delivery_integration_workspace(&project, &delivery);
            }
        } else {
            let contracts = Self::get_all_task_contracts(Some(&delivery.project_id))?;
            if contracts
                .iter()
                .any(|contract| contract.delivery_id == delivery.id)
            {
                return Err("草稿已存在任务契约或 worktree，不能直接删除".to_string());
            }
        }
         let attempts = Self::get_all_attempts(Some(&delivery.id))?;
        if attempts
            .iter()
            .any(|attempt| matches!(attempt.state.as_str(), "queued" | "starting" | "running"))
        {
            return Err("交付仍有正在运行的 Agent，不能删除".to_string());
        }
        let tasks = Self::get_task_nodes(&delivery.id)?;
        Self::delete(DELIVERIES_DIR, id, "交付")?;
        for task in tasks {
            let _ = Self::delete(TASK_NODES_DIR, &task.id, "任务节点");
        }
        // 删除关联的任务契约
        for contract in Self::get_all_task_contracts(Some(&delivery.project_id))?
            .into_iter()
            .filter(|contract| contract.delivery_id == delivery.id)
        {
            let _ = Self::delete(CONTRACTS_DIR, &contract.id, "任务契约");
        }
        for attempt in attempts {
            let _ = Self::delete(ATTEMPTS_DIR, &attempt.id, "执行尝试");
            let terminal_run_dir = terminal_run_dir_by_id(&attempt.id);
            let _ = fs::remove_dir_all(terminal_run_dir);
        }
        for event in Self::get_delivery_events(&delivery.id)? {
            let _ = Self::delete(EVENTS_DIR, &event.id, "交付事件");
        }
        for request in Self::get_decision_requests(Some(&delivery.id))? {
            let _ = Self::delete(DECISIONS_DIR, &request.id, "决策请求");
        }
        for gate in Self::get_review_gates(Some(&delivery.id))? {
            let _ = Self::delete(REVIEW_GATES_DIR, &gate.id, "审核记录");
        }
        for record in Self::get_merge_records(Some(&delivery.id))? {
            let _ = Self::delete(MERGE_RECORDS_DIR, &record.id, "合并记录");
        }
        let plan_dir = Self::entity_dir(PLANS_DIR).join(safe_path_segment(&delivery.id));
        let _ = fs::remove_dir_all(plan_dir);
        Ok(())
    }

    pub fn get_task_nodes(delivery_id: &str) -> Result<Vec<AiTaskNode>, String> {
        let mut tasks = Self::list(TASK_NODES_DIR)?;
        tasks.retain(|task: &AiTaskNode| task.delivery_id == delivery_id);
        tasks.sort_by(|left: &AiTaskNode, right: &AiTaskNode| {
            left.created_at.cmp(&right.created_at)
        });
        Ok(tasks)
    }

    pub fn get_task_node(id: &str) -> Result<AiTaskNode, String> {
        Self::get(TASK_NODES_DIR, id, "任务节点")
    }

    /// 环依赖检测（自环、间接环），供 create/update task_node 共用。
    pub fn has_cycle(delivery_tasks: &[AiTaskNode]) -> bool {
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut stack: std::collections::HashSet<String> = std::collections::HashSet::new();

        fn dfs(
            by_id: &std::collections::HashMap<String, &AiTaskNode>,
            id: &str,
            visited: &mut std::collections::HashSet<String>,
            stack: &mut std::collections::HashSet<String>,
        ) -> bool {
            if stack.contains(id) {
                return true;
            }
            if visited.contains(id) {
                return false;
            }
            visited.insert(id.to_string());
            stack.insert(id.to_string());
            if let Some(task) = by_id.get(id) {
                for dep in &task.dependency_ids {
                    if dfs(by_id, dep, visited, stack) {
                        return true;
                    }
                }
            }
            stack.remove(id);
            false
        }

        let by_id: std::collections::HashMap<String, &AiTaskNode> =
            delivery_tasks.iter().map(|t| (t.id.clone(), t)).collect();
        for task in delivery_tasks {
            if dfs(&by_id, &task.id, &mut visited, &mut stack) {
                return true;
            }
        }
        false
    }

    /// create/update 共用的任务字段约束校验（不含 delivery 状态校验——create 侧单独保留）。
    fn validate_task_fields(task: &AiTaskNode, delivery: &AiDelivery) -> Result<(), String> {
        if task.title.trim().is_empty() || task.description.trim().is_empty() {
            return Err("任务标题和说明不能为空".to_string());
        }
        if !matches!(task.execution_mode.as_str(), "write" | "readonly") {
            return Err("任务执行模式无效".to_string());
        }
        if task.execution_mode == "write"
            && task.execution_context != EXECUTION_CONTEXT_TASK_WORKTREE
        {
            return Err("写入任务必须在任务 worktree 中执行".to_string());
        }
        if task.workflow_step_id.is_some()
            && !task
                .expected_artifacts
                .iter()
                .any(|artifact| !artifact.trim().is_empty())
        {
            return Err("每个编排阶段必须至少声明一个交付物".to_string());
        }
        validate_artifact_paths(&task.expected_artifacts, "交付物")?;
        validate_artifact_paths(&task.input_artifacts, "输入成果")?;
        if task.role_id.is_none() && task.preferred_agent_id.is_none() {
            return Err("任务必须指定角色或优先 Agent，才能由调度器派发".to_string());
        }
        let project = Self::get_project(&delivery.project_id)?;
        let repository = project
            .repositories
            .iter()
            .find(|repository| repository.id == task.target_repository_id)
            .ok_or_else(|| "任务目标仓库不属于交付项目".to_string())?;
        if !repository.write_enabled {
            return Err("任务目标仓库已禁止写入".to_string());
        }
        validate_write_paths(&task.allowed_write_paths)?;
        if let Some(role_id) = task.role_id.as_deref() {
            Self::get::<AiRole>(ROLES_DIR, role_id, "角色")?;
        }
        if let Some(agent_id) = task.preferred_agent_id.as_deref() {
            Self::get::<AiAgent>(AGENTS_DIR, agent_id, "指定 Agent")?;
        }
        for dependency_id in &task.dependency_ids {
            if !delivery
                .task_node_ids
                .iter()
                .any(|id| id == dependency_id)
            {
                return Err(format!("依赖任务不属于当前交付: {}", dependency_id));
            }
        }
        Ok(())
    }

    /// 清理任务下的未决 review gate 与 decision request（已完成的记录保留留痕）。
    /// needsInput 任务保留未决 decision request——它是 answer_decision 恢复任务的入口，删除后任务永久卡死。
    fn cleanup_pending_gates_and_decisions(
        delivery_id: &str,
        task_node_id: &str,
        task_state: &str,
    ) -> Result<(), String> {
        for gate in Self::get_review_gates(Some(delivery_id))? {
            if gate.task_node_id == task_node_id && gate.state == "awaitingReviewer" {
                Self::delete(REVIEW_GATES_DIR, &gate.id, "审核门禁")?;
            }
        }
        if task_state != "needsInput" {
            for request in Self::get_decision_requests(Some(delivery_id))? {
                if request.task_node_id.as_deref() == Some(task_node_id)
                    && request.state == "pending"
                {
                    Self::delete(DECISIONS_DIR, &request.id, "决策请求")?;
                }
            }
        }
        Ok(())
    }

    pub fn create_task_node(input: CreateAiTaskNodeInput) -> Result<AiTaskNode, String> {
        let execution_context =
            resolve_execution_context(&input.execution_mode, &input.execution_context)?;
        let mut delivery = Self::get_delivery(&input.delivery_id)?;
        if !matches!(
            delivery.state.as_str(),
            "planning" | "drafting" | "awaitingApproval"
        ) {
            return Err("只有草案或待批准交付可以新增任务".to_string());
        }
        let existing_tasks = Self::get_task_nodes(&delivery.id)?;
        let now = chrono::Utc::now().to_rfc3339();
        let task = AiTaskNode {
            id: Uuid::new_v4().to_string(),
            delivery_id: delivery.id.clone(),
            title: input.title.trim().to_string(),
            description: input.description.trim().to_string(),
            role_id: input.role_id,
            workflow_step_id: input.workflow_step_id,
            preferred_agent_id: input.preferred_agent_id,
            task_prompt: input.task_prompt.trim().to_string(),
            execution_mode: input.execution_mode,
            execution_context,
            target_repository_id: input.target_repository_id,
            allowed_write_paths: input.allowed_write_paths,
            dependency_ids: input.dependency_ids,
            input_artifacts: input.input_artifacts,
            expected_artifacts: input.expected_artifacts,
            acceptance_commands: input.acceptance_commands,
            retry_count: input.retry_count,
            timeout_seconds: input.timeout_seconds,
            state: "planned".to_string(),
            assigned_agent_id: None,
            contract_id: None,
            attempt_ids: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        // 统一字段约束（create 与 update 共用；delivery 状态校验已在上面单独执行）
        Self::validate_task_fields(&task, &delivery)?;
        // 环依赖校验：先建 A 依赖 B、再建 B 依赖 A 可绕过成员校验直接成环，必须整体检测
        let mut all_tasks = existing_tasks.clone();
        all_tasks.push(task.clone());
        if Self::has_cycle(&all_tasks) {
            return Err("依赖关系形成环，任务无法派发".to_string());
        }
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        delivery.task_node_ids.push(task.id.clone());
        delivery.state = "awaitingApproval".to_string();
        delivery.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
        Self::append_event(
            &delivery.id,
            Some(&task.id),
            None,
            "taskPlanned",
            "管理者已添加任务节点",
        )?;
        Ok(task)
    }

    /// 编辑任务节点：状态约束 → 字段应用 → 共用校验 → 标脏 contract → 未决清理 → 状态重算 → diff 事件。
    pub fn update_task_node(input: UpdateAiTaskNodeInput) -> Result<AiTaskNode, String> {
        let mut task = Self::get_task_node(&input.id)?;
        let delivery = Self::get_delivery(&task.delivery_id)?;

        // 1) 状态校验（task 状态，非 delivery 状态）
        let editable = match task.state.as_str() {
            "planned" => true,
            "failed" | "rework" | "cancelled" | "needsInput" | "policyViolation" => matches!(
                delivery.state.as_str(),
                "running" | "paused" | "needsInput"
            ),
            _ => false, // queued/running/succeeded/awaitingReview 拒绝
        };
        if !editable {
            return Err(format!(
                "任务状态 {} 不可编辑（仅 planned 或失败/返工/取消/待输入/策略违规且交付运行中可编辑）",
                task.state
            ));
        }

        let original = task.clone();

        // 2) 字段应用前快照变更标志（字段随后被移动，不能事后借用 input）
        let exec_fields_changed = [
            input.execution_mode.is_some(),
            input.execution_context.is_some(),
            input.target_repository_id.is_some(),
            input.task_prompt.is_some(),
            input.allowed_write_paths.is_some(),
            input.expected_artifacts.is_some(),
            input.acceptance_commands.is_some(),
            input.timeout_seconds.is_some(),
        ]
        .iter()
        .any(|changed| *changed);
        let dependency_ids_changed = input.dependency_ids.is_some();

        // 3) 字段应用（Option 语义：None 不改，Some(Some(v)) 赋值，Some(None) 置空）
        if let Some(v) = input.title {
            task.title = v;
        }
        if let Some(v) = input.description {
            task.description = v;
        }
        if let Some(v) = input.role_id {
            task.role_id = v;
        }
        if let Some(v) = input.preferred_agent_id {
            task.preferred_agent_id = v;
        }
        if let Some(v) = input.task_prompt {
            task.task_prompt = v;
        }
        if let Some(v) = input.execution_mode {
            task.execution_mode = v;
        }
        if let Some(v) = input.execution_context {
            task.execution_context = v;
        }
        if let Some(v) = input.target_repository_id {
            task.target_repository_id = v;
        }
        if let Some(v) = input.allowed_write_paths {
            task.allowed_write_paths = v;
        }
        if let Some(v) = input.dependency_ids {
            task.dependency_ids = v;
        }
        if let Some(v) = input.expected_artifacts {
            task.expected_artifacts = v;
        }
        if let Some(v) = input.acceptance_commands {
            task.acceptance_commands = v;
        }
        if let Some(v) = input.timeout_seconds {
            task.timeout_seconds = v;
        }
        if let Some(v) = input.retry_count {
            task.retry_count = v;
        }

        // 4) 复用 create_task_node 的既有约束（排除其 delivery 状态校验，由第 1 条负责）
        Self::validate_task_fields(&task, &delivery)?;

        // 5) 环依赖校验（本任务与同交付其余任务）
        let mut all_tasks = delivery
            .task_node_ids
            .iter()
            .filter(|id| *id != &task.id)
            .map(|id| Self::get_task_node(id))
            .collect::<Result<Vec<_>, _>>()?;
        all_tasks.push(task.clone());
        if Self::has_cycle(&all_tasks) {
            return Err("依赖关系形成环，任务无法保存".to_string());
        }

        // 6) 执行相关字段变更 → 标脏 contract（重试派发时重新审计/重建，避免旧 worktree 审计结果被复用）
        if exec_fields_changed {
            if let Some(contract_id) = &task.contract_id {
                if let Ok(mut contract) =
                    Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "任务契约")
                {
                    contract.dirty = true;
                    contract.updated_at = chrono::Utc::now().to_rfc3339();
                    Self::save(CONTRACTS_DIR, contract_id, &contract)?;
                }
            }
        }

        // 6) 未决 gate/decision 清理（needsInput 保留未决 decision request）
        Self::cleanup_pending_gates_and_decisions(&task.delivery_id, &task.id, task.state.as_str())?;

        // 8) 依赖变更 → 状态重算（refresh_ready_task_nodes 含 promote；demote 由 T4-3 扩展）
        if dependency_ids_changed {
            Self::refresh_ready_task_nodes(&task.delivery_id)?;
        }

        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;

        // 8) diff 审计事件
        let diff = build_task_diff(&original, &task);
        Self::append_event(
            &task.delivery_id,
            Some(&task.id),
            None,
            "taskNodeEdited",
            &diff,
        )?;
        Ok(task)
    }

    /// 删除任务节点：级联清理 contract/attempt 运行目录/审核记录/决策请求；
    /// 引用它的 dependencyIds 自动移除并重算受影响任务状态。
    pub fn delete_task_node(task_node_id: &str) -> Result<(), String> {
        let task = Self::get_task_node(task_node_id)?;
        let mut delivery = Self::get_delivery(&task.delivery_id)?;

        // 状态约束：queued/running 执行中拒绝；其余（planned/failed/rework/cancelled/needsInput/policyViolation 等）可删
        if matches!(task.state.as_str(), "queued" | "running") {
            return Err(format!("任务状态 {} 不可删除", task.state));
        }

        // 1) contract
        if let Some(contract_id) = &task.contract_id {
            let _ = Self::delete(CONTRACTS_DIR, contract_id, "任务契约");
        }
        // 2) attempt 文件 + 运行目录（terminal_run_dir_by_id 兼容「纯 UUID」与「label__UUID」目录）
        for attempt_id in &task.attempt_ids {
            if let Ok(attempt) = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试") {
                let run_dir = terminal_run_dir_by_id(&attempt.id);
                let _ = fs::remove_dir_all(run_dir);
            }
            let _ = Self::delete(ATTEMPTS_DIR, attempt_id, "执行尝试");
        }
        // 3) review gate / decision request（按 task_node_id 引用全删，删除场景不做未决/已决区分）
        for gate in Self::get_review_gates(Some(&delivery.id))? {
            if gate.task_node_id == task.id {
                let _ = Self::delete(REVIEW_GATES_DIR, &gate.id, "审核门禁");
            }
        }
        for request in Self::get_decision_requests(Some(&delivery.id))? {
            if request.task_node_id.as_deref() == Some(&task.id) {
                let _ = Self::delete(DECISIONS_DIR, &request.id, "决策请求");
            }
        }
        // 4) delivery.task_node_ids 移除
        delivery.task_node_ids.retain(|id| id != task_node_id);
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
        // 5) 删除任务文件
        let _ = Self::delete(TASK_NODES_DIR, task_node_id, "任务节点");
        // 6) 引用它的 dependencyIds 自动移除（不是直接报冲突）+ 状态重算
        for other_id in delivery.task_node_ids.clone() {
            if let Ok(mut other) = Self::get_task_node(&other_id) {
                if other.dependency_ids.contains(&task.id) {
                    other.dependency_ids.retain(|d| d != &task.id);
                    other.updated_at = chrono::Utc::now().to_rfc3339();
                    Self::save(TASK_NODES_DIR, &other.id, &other)?;
                }
            }
        }
        Self::refresh_ready_task_nodes(&task.delivery_id)?;
        Self::append_event(
            &task.delivery_id,
            Some(&task.id),
            None,
            "taskNodeDeleted",
            &format!("任务 {} 已删除", task.title),
        )?;
        Ok(())
    }

    pub fn approve_delivery(id: &str) -> Result<AiDelivery, String> {
        let mut delivery = Self::get_delivery(id)?;
        if !matches!(delivery.state.as_str(), "drafting" | "awaitingApproval") {
            return Err("当前交付不能批准执行".to_string());
        }
        let mut tasks = Self::get_task_nodes(id)?;
        if tasks.is_empty() {
            return Err("交付至少需要一个任务节点".to_string());
        }
        if let Some(task) = tasks.iter().find(|task| {
            task.workflow_step_id.is_some()
                && !task
                    .expected_artifacts
                    .iter()
                    .any(|artifact| !artifact.trim().is_empty())
        }) {
            return Err(format!(
                "任务“{}”未声明阶段交付物，请先重新生成或补充任务图",
                task.title
            ));
        }
        for task in &mut tasks {
            if task.state == "planned" && task.dependency_ids.is_empty() {
                task.state = "ready".to_string();
                task.updated_at = chrono::Utc::now().to_rfc3339();
                Self::save(TASK_NODES_DIR, &task.id, task)?;
            }
        }
        delivery.state = "running".to_string();
        delivery.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
        Self::append_event(
            &delivery.id,
            None,
            None,
            "deliveryApproved",
            "任务图已批准，等待调度",
        )?;
        Ok(delivery)
    }

    pub fn pause_delivery(id: &str) -> Result<AiDelivery, String> {
        let mut delivery = Self::get_delivery(id)?;
        if delivery.state != "running" {
            return Err("仅运行中的交付可以暂停".to_string());
        }
        delivery.state = "paused".to_string();
        delivery.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
        Self::append_event(
            &delivery.id,
            None,
            None,
            "deliveryPaused",
            "已暂停新任务派发，运行中的任务不会被中断",
        )?;
        Ok(delivery)
    }

    pub fn resume_delivery(id: &str) -> Result<AiDelivery, String> {
        let mut delivery = Self::get_delivery(id)?;
        if delivery.state != "paused" {
            return Err("仅已暂停的交付可以恢复".to_string());
        }
        delivery.state = "running".to_string();
        delivery.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
        Self::append_event(
            &delivery.id,
            None,
            None,
            "deliveryResumed",
        "交付已恢复，可以继续派发就绪任务",
        )?;
        Self::try_complete_workflow_delivery(id)?;
        Ok(delivery)
    }

    pub fn cancel_delivery(
        id: &str,
        terminal_service: TerminalService,
    ) -> Result<AiDelivery, String> {
        let mut delivery = Self::get_delivery(id)?;
        if matches!(
            delivery.state.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            return Err("已结束的交付不能再次终止".to_string());
        }

        let now = chrono::Utc::now().to_rfc3339();
        for mut attempt in Self::get_all_attempts(Some(&delivery.id))? {
            if !matches!(attempt.state.as_str(), "queued" | "starting" | "running") {
                continue;
            }
            if let Some(terminal_id) = attempt.terminal_id.as_deref() {
                let _ = terminal_service.close_terminal(terminal_id);
            }
            attempt.state = "cancelled".to_string();
            attempt.finished_at = Some(now.clone());
            attempt.updated_at = now.clone();
            attempt.summary = Some("交付已由用户终止".to_string());
            Self::persist_attempt(&attempt)?;
            // 逐 attempt 事件：事件写盘失败不中断取消主流程
            let _ = Self::append_event(
                &delivery.id,
                if attempt.task_node_id.is_empty() {
                    None
                } else {
                    Some(&attempt.task_node_id)
                },
                Some(&attempt.id),
                "attemptCancelled",
                "交付取消，任务已终止",
            );
        }
        for mut task in Self::get_task_nodes(&delivery.id)? {
            if matches!(task.state.as_str(), "succeeded" | "policyViolation") {
                continue;
            }
            task.state = "cancelled".to_string();
            task.updated_at = now.clone();
            Self::save(TASK_NODES_DIR, &task.id, &task)?;
        }
        for mut contract in Self::get_all_task_contracts(Some(&delivery.project_id))?
            .into_iter()
            .filter(|contract| contract.delivery_id == delivery.id)
        {
            if contract.state == "completed" {
                continue;
            }
            contract.state = "cancelled".to_string();
            contract.updated_at = now.clone();
            Self::save(CONTRACTS_DIR, &contract.id, &contract)?;
        }
        for mut request in Self::get_decision_requests(Some(&delivery.id))? {
            if request.state != "pending" {
                continue;
            }
            request.state = "cancelled".to_string();
            request.updated_at = now.clone();
            Self::save(DECISIONS_DIR, &request.id, &request)?;
        }
        delivery.state = "cancelled".to_string();
        delivery.updated_at = now;
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
        Self::append_event(
            &delivery.id,
            None,
            None,
            "deliveryCancelled",
            "用户已终止交付；未完成任务和 Agent 已停止，worktree 保留供人工检查",
        )?;
        Ok(delivery)
    }

    pub fn refresh_ready_task_nodes(delivery_id: &str) -> Result<Vec<AiTaskNode>, String> {
        let tasks = Self::get_task_nodes(delivery_id)?;
        let succeeded = tasks
            .iter()
            // 只有经过验收的成功任务才能解锁下游；取消和中断都不代表产物可用。
            .filter(|task| task.state == "succeeded")
            .map(|task| task.id.clone())
            .collect::<HashSet<_>>();
        let mut changed = Vec::new();
        for mut task in tasks {
            if task.state == "planned"
                && task
                    .dependency_ids
                    .iter()
                    .all(|dependency| succeeded.contains(dependency))
            {
                task.state = "ready".to_string();
                task.updated_at = chrono::Utc::now().to_rfc3339();
                Self::save(TASK_NODES_DIR, &task.id, &task)?;
                Self::append_event(
                    delivery_id,
                    Some(&task.id),
                    None,
                    "taskReady",
                    "依赖任务已完成，可以派发",
                )?;
                changed.push(task);
            }
        }
        // demote：ready 且依赖不全部 succeeded（依赖已删除 / failed / rework / cancelled / planned）→ 回退 planned
        for mut task in Self::get_task_nodes(delivery_id)? {
            if task.state == "ready"
                && !task.dependency_ids.is_empty()
                && !task
                    .dependency_ids
                    .iter()
                    .all(|dependency| succeeded.contains(dependency))
            {
                task.state = "planned".to_string();
                task.updated_at = chrono::Utc::now().to_rfc3339();
                Self::save(TASK_NODES_DIR, &task.id, &task)?;
                changed.push(task);
            }
        }
        Ok(changed)
    }

    pub fn get_delivery_events(delivery_id: &str) -> Result<Vec<AiDeliveryEvent>, String> {
        let mut events = Self::list(EVENTS_DIR)?;
        events.retain(|event: &AiDeliveryEvent| event.delivery_id == delivery_id);
        events.sort_by(|left: &AiDeliveryEvent, right: &AiDeliveryEvent| {
            left.occurred_at.cmp(&right.occurred_at)
        });
        Ok(events)
    }

    pub fn get_decision_requests(
        delivery_id: Option<&str>,
    ) -> Result<Vec<AiDecisionRequest>, String> {
        let mut requests = Self::list(DECISIONS_DIR)?;
        if let Some(delivery_id) = delivery_id {
            requests.retain(|request: &AiDecisionRequest| request.delivery_id == delivery_id);
        }
        requests.sort_by(|left: &AiDecisionRequest, right: &AiDecisionRequest| {
            right.updated_at.cmp(&left.updated_at)
        });
        Ok(requests)
    }

    pub fn create_decision_request(
        input: CreateAiDecisionRequestInput,
    ) -> Result<AiDecisionRequest, String> {
        if input.question.trim().is_empty() || input.impact.trim().is_empty() {
            return Err("决策问题和影响说明不能为空".to_string());
        }
        let mut delivery = Self::get_delivery(&input.delivery_id)?;
        if matches!(
            delivery.state.as_str(),
            "completed" | "cancelled" | "failed"
        ) {
            return Err("已结束的交付不能创建决策请求".to_string());
        }
        if let Some(task_id) = input.task_node_id.as_deref() {
            let mut task = Self::get_task_node(task_id)?;
            if task.delivery_id != delivery.id {
                return Err("决策任务不属于当前交付".to_string());
            }
            if matches!(
                task.state.as_str(),
                "running" | "ready" | "planned" | "rework"
            ) {
                task.state = "needsInput".to_string();
                task.updated_at = chrono::Utc::now().to_rfc3339();
                Self::save(TASK_NODES_DIR, &task.id, &task)?;
            }
        }
        let now = chrono::Utc::now().to_rfc3339();
        let request = AiDecisionRequest {
            id: Uuid::new_v4().to_string(),
            delivery_id: delivery.id.clone(),
            task_node_id: input.task_node_id,
            question: input.question.trim().to_string(),
            impact: input.impact.trim().to_string(),
            options: input.options,
            state: "pending".to_string(),
            answer: None,
            created_at: now.clone(),
            updated_at: now,
        };
        Self::save(DECISIONS_DIR, &request.id, &request)?;
        delivery.state = "needsInput".to_string();
        delivery.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
        Self::append_event(
            &delivery.id,
            request.task_node_id.as_deref(),
            None,
            "decisionRequested",
            "Agent 请求用户决策，交付已暂停",
        )?;
        // 推送决策请求到微信/飞书（含问题、影响与选项摘要；附决策 ID 供引用回复回答）
        Self::push_delivery_notice(
            &delivery.id,
            "决策请求",
            &format!(
                "交付「{}」需要决策：{}\n影响：{}\n选项：{}",
                delivery.title,
                request.question,
                request.impact,
                request
                    .options
                    .iter()
                    .map(|option| option.label.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            ),
            Some(&request.id),
        );
        Ok(request)
    }

    pub fn answer_decision_request(id: &str, answer: &str) -> Result<AiDecisionRequest, String> {
        if answer.trim().is_empty() {
            return Err("决策回答不能为空".to_string());
        }
        let mut request = Self::get::<AiDecisionRequest>(DECISIONS_DIR, id, "决策请求")?;
        if request.state != "pending" {
            return Err("当前决策请求已处理".to_string());
        }
        request.state = "answered".to_string();
        request.answer = Some(answer.trim().to_string());
        request.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(DECISIONS_DIR, &request.id, &request)?;
        if let Some(task_id) = request.task_node_id.as_deref() {
            // 归档该任务上 needsInput/interrupted 的旧 attempt（应用重启中断或已暂停的），
            // 避免回答决策后正常派发时旧记录残留。
            for stale in Self::get_all_attempts(Some(&request.delivery_id))? {
                if stale.task_node_id != task_id
                    || !matches!(stale.state.as_str(), "needsInput" | "interrupted")
                {
                    continue;
                }
                let mut archived = stale;
                archived.state = "cancelled".to_string();
                archived.finished_at = Some(chrono::Utc::now().to_rfc3339());
                archived.updated_at = archived.finished_at.clone().unwrap_or_default();
                archived.summary = Some("已由用户回答决策，旧执行记录归档".to_string());
                Self::persist_attempt(&archived)?;
                Self::append_event(
                    &archived.delivery_id,
                    Some(&archived.task_node_id),
                    Some(&archived.id),
                    "attemptCancelled",
                    "旧执行记录已归档（用户已回答决策）",
                )?;
            }
        }
        if let Some(task_id) = request.task_node_id.as_deref() {
            let mut task = Self::get_task_node(task_id)?;
            if task.state == "needsInput" {
                task.state = "ready".to_string();
                task.updated_at = chrono::Utc::now().to_rfc3339();
                Self::save(TASK_NODES_DIR, &task.id, &task)?;
            }
        }
        let pending = Self::get_decision_requests(Some(&request.delivery_id))?
            .into_iter()
            .any(|item| item.state == "pending");
        if !pending {
            let mut delivery = Self::get_delivery(&request.delivery_id)?;
            if delivery.state == "needsInput" {
                delivery.state = "running".to_string();
                delivery.updated_at = chrono::Utc::now().to_rfc3339();
                Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
            }
        }
        Self::append_event(
            &request.delivery_id,
            request.task_node_id.as_deref(),
            None,
            "decisionAnswered",
            "用户已回答决策请求，任务可继续调度",
        )?;
        // 推送决策已答（含回答内容），便于在聊天侧确认处理结果
        Self::push_delivery_notice(
            &request.delivery_id,
            "决策已答",
            &format!(
                "决策「{}」已回答：{}",
                request.question,
                answer.trim()
            ),
            None,
        );
        Ok(request)
    }

    pub fn get_all_attempts(delivery_id: Option<&str>) -> Result<Vec<AiAttempt>, String> {
        let mut attempts = Self::list(ATTEMPTS_DIR)?;
        if let Some(delivery_id) = delivery_id {
            attempts.retain(|attempt: &AiAttempt| attempt.delivery_id == delivery_id);
        }
        attempts
            .sort_by(|left: &AiAttempt, right: &AiAttempt| right.created_at.cmp(&left.created_at));
        Ok(attempts)
    }

    /// 读取单次执行的产出物（transcript、final-message、review.json、decision.json、prompt）。
    pub fn read_attempt_output(attempt_id: &str) -> Result<AiAttemptOutput, String> {
        use crate::models::{AiAttemptDecision, AiAttemptOutput, AiAttemptReview};
        // 同时兼容旧的纯 UUID 目录和新的“可读标签__UUID”目录。
        let run_dir = terminal_run_dir_by_id(attempt_id);

        // 读取文件辅助函数：自动去除 BOM，处理非 UTF-8 文件
        let read_file = |name: &str| -> Option<String> {
            let bytes = fs::read(run_dir.join(name)).ok()?;
            // 去除 UTF-8 BOM
            let content = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                String::from_utf8_lossy(&bytes[3..]).to_string()
            } else {
                String::from_utf8_lossy(&bytes).to_string()
            };
            let trimmed = content.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        };

        // transcript.log — 取最后 8000 字符
        let transcript_tail = read_file("transcript.log")
            .map(|content| {
                if content.len() > 8000 {
                    let cut = content.len() - 8000;
                    let safe_cut = content.ceil_char_boundary(cut);
                    format!("...{}", &content[safe_cut..])
                } else {
                    content
                }
            })
            .unwrap_or_default();

        // final-message.txt
        let final_message = read_file("final-message.txt");

        // review.json
        let review = read_file("review.json")
            .and_then(|s| serde_json::from_str::<AiAttemptReview>(&s).ok());

        // decision.json
        let decision = read_file("decision.json")
            .and_then(|s| serde_json::from_str::<AiAttemptDecision>(&s).ok());

        // plan.json
        let plan_json = read_file("plan.json")
            .and_then(|s| {
                // 尝试格式化 JSON
                serde_json::from_str::<serde_json::Value>(&s)
                    .ok()
                    .and_then(|v| serde_json::to_string_pretty(&v).ok())
                    .or(Some(s))
            });

        // prompt.txt — 完整内容
        let prompt_excerpt = read_file("prompt.txt");

        // 实时状态与 live 输出尾部（PC 端事件流零延迟；Web 端轮询此字段全量渲染）
        let is_live = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")
            .map(|a| a.state == "running")
            .unwrap_or(false);
        let live_output_tail = fs::read_to_string(run_dir.join("live-output.log")).unwrap_or_default();
        let live_output_tail = if live_output_tail.len() > 8000 {
            let cut = live_output_tail.len() - 8000;
            let safe_cut = live_output_tail.ceil_char_boundary(cut);
            format!("...{}", &live_output_tail[safe_cut..])
        } else {
            live_output_tail
        };

        Ok(AiAttemptOutput {
            attempt_id: attempt_id.to_string(),
            transcript_tail,
            final_message,
            review,
            decision,
            prompt_excerpt,
            plan_json,
            is_live,
            live_output_tail,
        })
    }

    /// 交付产物文件白名单：manager 与各 attempt 运行目录下的已知产物。
    const ARTIFACT_FILE_NAMES: &[&str] = &[
        "plan.json",
        "transcript.log",
        "review.json",
        "decision.json",
        "prompt.txt",
        "final-message.txt",
        "live-output.log",
        "review-schema.json",
        "exit-code.txt",
    ];

    /// 列出交付的全部产物文件元数据（两级结构：manager run_dir 的 plan.json + 各 attempt run_dir 的 transcript/review 等）。
    pub fn list_delivery_artifacts(delivery_id: &str) -> Result<Vec<AiArtifactMeta>, String> {
        let mut metas = Vec::new();
        let mut seen_dirs: HashSet<String> = HashSet::new();
        let attempts = Self::get_all_attempts(Some(delivery_id))?;
        for attempt in attempts {
            let run_dir = terminal_run_dir_by_id(&attempt.id);
            if !run_dir.is_dir() {
                continue;
            }
            let dir_key = run_dir.to_string_lossy().to_string();
            if !seen_dirs.insert(dir_key.clone()) {
                continue;
            }
            let run_dir_name = run_dir
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            for file_name in Self::ARTIFACT_FILE_NAMES {
                let file_path = run_dir.join(file_name);
                if let Ok(metadata) = fs::metadata(&file_path) {
                    if !metadata.is_file() {
                        continue;
                    }
                    let modified_at = metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|duration| {
                            let seconds = duration.as_secs() as i64;
                            let nanos = duration.subsec_nanos();
                            chrono::DateTime::<chrono::Utc>::from_timestamp(seconds, nanos)
                                .map(|time| time.to_rfc3339())
                                .unwrap_or_default()
                        })
                        .unwrap_or_default();
                    metas.push(AiArtifactMeta {
                        path: format!("{}/{}", run_dir_name, file_name),
                        size: metadata.len(),
                        modified_at,
                    });
                }
            }
        }
        metas.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(metas)
    }

    /// 按产物路径读取全文（BOM/非 UTF-8 容错，复用 read_attempt_output 的读取模式，不截断尾部）。
    pub fn read_delivery_artifact(delivery_id: &str, path: &str) -> Result<String, String> {
        // 路径必须是「run_dir 名/白名单文件名」两级，防止越权读取其他目录。
        let (dir_name, file_name) = path
            .split_once('/')
            .ok_or_else(|| format!("产物路径无效: {}", path))?;
        if !Self::ARTIFACT_FILE_NAMES.contains(&file_name) {
            return Err(format!("不支持的产物文件: {}", file_name));
        }
        let attempts = Self::get_all_attempts(Some(delivery_id))?;
        let run_dir = attempts
            .iter()
            .map(|attempt| terminal_run_dir_by_id(&attempt.id))
            .find(|dir| {
                dir.file_name()
                    .map(|name| name.to_string_lossy().to_string() == dir_name)
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("产物目录不存在: {}", dir_name))?;
        let bytes = fs::read(run_dir.join(file_name))
            .map_err(|error| format!("读取产物失败: {}", error))?;
        // 去除 UTF-8 BOM，非 UTF-8 用 lossy 转换（与 read_attempt_output 容错模式一致）
        let content = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            String::from_utf8_lossy(&bytes[3..]).to_string()
        } else {
            String::from_utf8_lossy(&bytes).to_string()
        };
        Ok(content)
    }

    /// 打包交付的全部产物（manager plan.json + 各 attempt 运行目录 + 交付 JSON）到 target_path。
    pub fn export_delivery_artifacts_zip(
        delivery_id: &str,
        target_path: &str,
    ) -> Result<String, String> {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let delivery: AiDelivery = Self::get(DELIVERIES_DIR, delivery_id, "交付")?;
        let target = PathBuf::from(target_path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建导出目录失败: {}", error))?;
        }
        let file = fs::File::create(&target)
            .map_err(|error| format!("创建 ZIP 文件失败: {}", error))?;
        let mut zip_writer = zip::ZipWriter::new(file);
        let options: SimpleFileOptions = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        // 1) 交付 JSON
        let delivery_json = serde_json::to_string_pretty(&delivery)
            .map_err(|error| format!("序列化交付失败: {}", error))?;
        zip_writer
            .start_file(format!("delivery-{}.json", delivery_id), options)
            .map_err(|error| format!("写入 ZIP 失败: {}", error))?;
        zip_writer
            .write_all(delivery_json.as_bytes())
            .map_err(|error| format!("写入 ZIP 失败: {}", error))?;

        // 2) 各 attempt 运行目录下的白名单产物
        let attempts = Self::get_all_attempts(Some(delivery_id))?;
        let mut seen_dirs: HashSet<String> = HashSet::new();
        for attempt in attempts {
            let run_dir = terminal_run_dir_by_id(&attempt.id);
            if !run_dir.is_dir() {
                continue;
            }
            let dir_key = run_dir.to_string_lossy().to_string();
            if !seen_dirs.insert(dir_key.clone()) {
                continue;
            }
            let run_dir_name = run_dir
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            for file_name in Self::ARTIFACT_FILE_NAMES {
                let file_path = run_dir.join(file_name);
                if !file_path.is_file() {
                    continue;
                }
                let bytes = fs::read(&file_path)
                    .map_err(|error| format!("读取产物失败: {}", error))?;
                zip_writer
                    .start_file(
                        format!("{}/{}", run_dir_name, file_name),
                        options,
                    )
                    .map_err(|error| format!("写入 ZIP 失败: {}", error))?;
                zip_writer
                    .write_all(&bytes)
                    .map_err(|error| format!("写入 ZIP 失败: {}", error))?;
            }
        }

        zip_writer
            .finish()
            .map_err(|error| format!("完成 ZIP 失败: {}", error))?;
        Ok(target.to_string_lossy().to_string())
    }

    /// 生成交付收尾报告（Markdown）：概览/任务结果表/重试与返工链/耗时统计/合并信息/事件摘要/遗留问题。
    pub fn generate_delivery_report(delivery_id: &str) -> Result<String, String> {
        let delivery = Self::get_delivery(delivery_id)?;
        let project = Self::get_project(&delivery.project_id)?;
        let tasks = Self::get_task_nodes(delivery_id)?;
        let attempts = Self::get_all_attempts(Some(delivery_id))?;
        let events = Self::get_delivery_events(delivery_id)?;
        let merge_records = Self::get_merge_records(Some(delivery_id))?;
        let decisions = Self::get_decision_requests(Some(delivery_id))?;

        let task_count = tasks.len();
        let succeeded_count = tasks
            .iter()
            .filter(|task| task.state == "succeeded")
            .count();
        let failed_count = tasks
            .iter()
            .filter(|task| {
                matches!(
                    task.state.as_str(),
                    "failed" | "rework" | "policyViolation" | "cancelled"
                )
            })
            .count();
        let attempt_count = attempts.len();
        let retried_attempt_count: usize = tasks.iter().map(|task| task.retry_count as usize).sum();
        // 实际耗时：最早 started_at 到最晚 finished_at（运行中任务按至今计）
        let earliest_start = attempts
            .iter()
            .map(|attempt| attempt.started_at.as_str())
            .min();
        let latest_end = attempts
            .iter()
            .filter_map(|attempt| attempt.finished_at.as_deref())
            .max();
        let started_epoch = earliest_start
            .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
            .map(|time| time.timestamp());
        let ended_epoch = latest_end
            .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
            .map(|time| time.timestamp())
            .or_else(|| Some(chrono::Utc::now().timestamp()));
        let elapsed = match (started_epoch, ended_epoch) {
            (Some(start), Some(end)) => {
                let seconds = (end - start).max(0);
                if seconds >= 3600 {
                    format!("{} 小时 {} 分钟", seconds / 3600, (seconds % 3600) / 60)
                } else if seconds >= 60 {
                    format!("{} 分钟", seconds / 60)
                } else {
                    format!("{} 秒", seconds)
                }
            }
            _ => "—".to_string(),
        };

        let mut lines = Vec::new();
        lines.push(format!("# 交付报告：{}", delivery.title));
        lines.push(String::new());
        lines.push("## 概览".to_string());
        lines.push(String::new());
        lines.push(format!("- 交付状态：{}", delivery.state));
        lines.push(format!("- 需求：{}", delivery.requirement));
        lines.push(format!("- 项目：{}", project.name));
        lines.push(format!(
            "- 任务图：{} 个任务，成功 {}，失败/取消 {}",
            task_count, succeeded_count, failed_count
        ));
        lines.push(format!("- 执行记录：{} 条 attempt，含 {} 条重试", attempt_count, retried_attempt_count));
        lines.push(format!("- 实际耗时：{}", elapsed));
        lines.push(format!("- 创建于：{}", delivery.created_at));
        lines.push(format!("- 更新于：{}", delivery.updated_at));
        lines.push(String::new());

        lines.push("## 任务结果".to_string());
        lines.push(String::new());
        if tasks.is_empty() {
            lines.push("（无任务记录）".to_string());
        } else {
            lines.push("| 任务 | 状态 | 重试次数 | 派发尝试 |".to_string());
            lines.push("| --- | --- | --- | --- |".to_string());
            for task in &tasks {
                let task_attempts = attempts
                    .iter()
                    .filter(|attempt| attempt.task_node_id == task.id)
                    .collect::<Vec<_>>();
                lines.push(format!(
                    "| {} | {} | {} | {} |",
                    task.title.replace('|', "\\|"),
                    task.state,
                    task.retry_count,
                    task_attempts.len(),
                ));
            }
        }
        lines.push(String::new());

        lines.push("## 重试与返工链".to_string());
        lines.push(String::new());
        let rework_events = events
            .iter()
            .filter(|event| {
                matches!(
                    event.event_type.as_str(),
                    "attemptRetried" | "taskReworkRequested" | "policyViolationDetected"
                )
            })
            .collect::<Vec<_>>();
        if rework_events.is_empty() {
            lines.push("（无重试/返工记录）".to_string());
        } else {
            lines.push("| 时间 | 类型 | 说明 |".to_string());
            lines.push("| --- | --- | --- |".to_string());
            for event in rework_events {
                lines.push(format!(
                    "| {} | {} | {} |",
                    event.occurred_at,
                    event.event_type,
                    event.message.replace('|', "\\|")
                ));
            }
        }
        lines.push(String::new());

        lines.push("## 合并信息".to_string());
        lines.push(String::new());
        if merge_records.is_empty() {
            lines.push("（尚未合并）".to_string());
        } else {
            for record in &merge_records {
                lines.push(format!("- 合并状态：{}（{}）", record.state, record.created_at));
                for repository in &record.repositories {
                    lines.push(format!(
                        "- 仓库 {}：分支 {}，{} → {}（{}）",
                        repository.repository_id,
                        repository.branch_name,
                        repository.pre_merge_head.get(..8).unwrap_or(&repository.pre_merge_head),
                        repository
                            .merged_head
                            .as_deref()
                            .map(|head| head.get(..8).unwrap_or(head).to_string())
                            .unwrap_or_else(|| "—".to_string()),
                        repository.state,
                    ));
                }
            }
        }
        lines.push(String::new());

        lines.push("## 决策请求".to_string());
        lines.push(String::new());
        if decisions.is_empty() {
            lines.push("（无决策请求）".to_string());
        } else {
            for request in &decisions {
                lines.push(format!(
                    "- {}：{}（回答：{}）",
                    request.created_at,
                    request.question,
                    request
                        .answer
                        .clone()
                        .unwrap_or_else(|| "（未回答）".to_string()),
                ));
            }
        }
        lines.push(String::new());

        lines.push("## 事件摘要（最近 20 条）".to_string());
        lines.push(String::new());
        let recent_events = events.iter().rev().take(20).collect::<Vec<_>>();
        if recent_events.is_empty() {
            lines.push("（无事件记录）".to_string());
        } else {
            lines.push("| 时间 | 类型 | 说明 |".to_string());
            lines.push("| --- | --- | --- |".to_string());
            for event in recent_events.iter().rev() {
                lines.push(format!(
                    "| {} | {} | {} |",
                    event.occurred_at,
                    event.event_type,
                    event.message.replace('|', "\\|")
                ));
            }
        }
        lines.push(String::new());

        lines.push("## 遗留问题（未完成任务）".to_string());
        lines.push(String::new());
        let open_tasks = tasks
            .iter()
            .filter(|task| task.state != "succeeded" && task.state != "skipped")
            .collect::<Vec<_>>();
        if open_tasks.is_empty() {
            lines.push("（无遗留任务）".to_string());
        } else {
            for task in open_tasks {
                lines.push(format!("- [ ] {}（{}）", task.title, task.state));
            }
        }

        Ok(lines.join("\n"))
    }

    /// 应用进程已退出时，内存中的终端无法恢复；保留现场并允许用户重新派发。
    pub fn recover_interrupted_attempts() -> Result<usize, String> {
        let interrupted = Self::get_all_attempts(None)?
            .into_iter()
            .filter(|attempt| {
                matches!(
                    attempt.state.as_str(),
                    "queued" | "starting" | "running" | "needsInput"
                )
            })
            .collect::<Vec<_>>();
        let mut recovered = 0;
        for mut attempt in interrupted {
            if attempt.state == "needsInput" {
                // 等待决策时应用重启：清理死终端引用（重启后 terminal_id 无效），
                // 标记 interrupted 供前端展示。任务 state 保持 needsInput，
                // 回答决策时（answer_decision_request 按 task.state 判断）可正常恢复派发。
                attempt.terminal_id = None;
                attempt.state = "interrupted".to_string();
                Self::persist_attempt(&attempt)?;
                Self::append_event(
                    &attempt.delivery_id,
                    if attempt.task_node_id.is_empty() {
                        None
                    } else {
                        Some(&attempt.task_node_id)
                    },
                    Some(&attempt.id),
                    "attemptInterrupted",
                    "等待决策时应用重启，attempt 已中断",
                )?;
                recovered += 1;
                continue;
            }
            let message =
                "TerminalBuddy 已重启，原 Agent 终端无法恢复；任务已取消，请检查现场后重新派发。";
            if attempt.task_node_id.is_empty() {
                let delivery = Self::get_delivery(&attempt.delivery_id)?;
                if matches!(delivery.state.as_str(), "planning" | "awaitingApproval") {
                    Self::fail_delivery_planning(&delivery.id, message)?;
                    recovered += 1;
                    continue;
                }
            }
            attempt.state = "cancelled".to_string();
            attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
            attempt.updated_at = attempt.finished_at.clone().unwrap_or_default();
            attempt.summary = Some(message.to_string());
            Self::persist_attempt(&attempt)?;
            if !attempt.task_node_id.is_empty() {
                let mut task = Self::get_task_node(&attempt.task_node_id)?;
                if matches!(task.state.as_str(), "queued" | "running") {
                    task.state = "cancelled".to_string();
                    task.updated_at = chrono::Utc::now().to_rfc3339();
                    Self::save(TASK_NODES_DIR, &task.id, &task)?;
                }
            }
            Self::append_event(
                &attempt.delivery_id,
                if attempt.task_node_id.is_empty() {
                    None
                } else {
                    Some(&attempt.task_node_id)
                },
                Some(&attempt.id),
                "attemptInterrupted",
                message,
            )?;
            recovered += 1;
        }
        Ok(recovered)
    }

    pub fn get_review_gates(delivery_id: Option<&str>) -> Result<Vec<AiReviewGate>, String> {
        let mut gates = Self::list(REVIEW_GATES_DIR)?;
        if let Some(delivery_id) = delivery_id {
            gates.retain(|gate: &AiReviewGate| gate.delivery_id == delivery_id);
        }
        gates.sort_by(|left: &AiReviewGate, right: &AiReviewGate| {
            right.updated_at.cmp(&left.updated_at)
        });
        Ok(gates)
    }

    /// 审查用增量 Diff：取任务契约的基线提交与任务分支 HEAD，返回文件清单与双侧文本。
    /// 返回 { baseCommit, headCommit, files: [{path,status,additions,deletions}], diffs: [{path,original,modified}] }。
    pub fn get_review_diff(
        delivery_id: &str,
        task_node_id: &str,
    ) -> Result<serde_json::Value, String> {
        let task = Self::get_task_node(task_node_id)?;
        if task.delivery_id != delivery_id {
            return Err("任务不属于该交付".to_string());
        }
        let contract_id = task
            .contract_id
            .as_deref()
            .ok_or_else(|| "任务缺少任务契约，无法查看代码变更".to_string())?;
        let contract =
            Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "任务契约")?;
        let base_commit = contract
            .base_commit
            .as_deref()
            .ok_or_else(|| "任务契约缺少基线提交，无法查看代码变更".to_string())?;
        let worktree = contract
            .worktree_path
            .as_deref()
            .ok_or_else(|| "任务缺少工作目录，无法查看代码变更".to_string())?;
        let repository = PathBuf::from(worktree);
        let range = format!("{}...HEAD", base_commit);
        let head_commit = run_git(&repository, &["rev-parse".to_string(), "HEAD".to_string()])?;

        let name_status = run_git(
            &repository,
            &["diff".to_string(), range.clone(), "--name-status".to_string()],
        )?;
        let numstat = run_git(
            &repository,
            &["diff".to_string(), range, "--numstat".to_string()],
        )?;

        let name_lines: Vec<&str> = name_status.lines().collect();
        let num_lines: Vec<&str> = numstat.lines().collect();
        let mut files: Vec<serde_json::Value> = Vec::new();
        for (index, line) in name_lines.iter().enumerate() {
            // 行格式：状态符 + TAB + 路径（重命名时含两个路径，取新路径）
            let mut parts = line.split('\t');
            let status = parts
                .next()
                .unwrap_or("?")
                .chars()
                .next()
                .unwrap_or('?')
                .to_string();
            let path = parts.last().unwrap_or("").trim().to_string();
            if path.is_empty() {
                continue;
            }
            let (additions, deletions) = num_lines
                .get(index)
                .map(|line| {
                    let mut parts = line.split('\t');
                    let added = parts
                        .next()
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0);
                    let removed = parts
                        .next()
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0);
                    (added, removed)
                })
                .unwrap_or((0, 0));
            files.push(serde_json::json!({
                "path": path,
                "status": status,
                "additions": additions,
                "deletions": deletions,
            }));
        }

        let mut diffs: Vec<serde_json::Value> = Vec::new();
        for file in &files {
            let path = file["path"].as_str().unwrap_or("");
            let status = file["status"].as_str().unwrap_or("M");
            let original = if status == "A" {
                String::new()
            } else {
                run_git(
                    &repository,
                    &[
                        "show".to_string(),
                        format!("{}:{}", base_commit, path),
                    ],
                )
                .unwrap_or_default()
            };
            let modified = if status == "D" {
                String::new()
            } else {
                run_git(
                    &repository,
                    &["show".to_string(), format!("HEAD:{}", path)],
                )
                .unwrap_or_default()
            };
            diffs.push(serde_json::json!({
                "path": path,
                "original": original,
                "modified": modified,
            }));
        }

        Ok(serde_json::json!({
            "baseCommit": base_commit,
            "headCommit": head_commit,
            "files": files,
            "diffs": diffs,
        }))
    }

    /// 添加审查行评论到 reviewGate.lineComments 并持久化。
    pub fn add_review_line_comment(
        gate_id: &str,
        path: &str,
        line: i64,
        text: &str,
    ) -> Result<AiReviewGate, String> {
        let mut gate = Self::get::<AiReviewGate>(REVIEW_GATES_DIR, gate_id, "审核门禁")?;
        if text.trim().is_empty() {
            return Err("评论内容不能为空".to_string());
        }
        gate.line_comments.push(serde_json::json!({
            "path": path,
            "line": line,
            "text": text.trim(),
            "createdAt": chrono::Utc::now().to_rfc3339(),
        }));
        gate.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(REVIEW_GATES_DIR, &gate.id, &gate)?;
        Ok(gate)
    }

    pub fn run_quality_gate(
        task_node_id: &str,
        reviewer_agent_id: Option<&str>,
        app: tauri::AppHandle,
        terminal_service: TerminalService,
    ) -> Result<AiReviewGate, String> {
        let _guard = acquire_quality_gate_lock(task_node_id)?;
        Self::run_quality_gate_inner(
            task_node_id,
            reviewer_agent_id,
            app,
            terminal_service,
        )
    }

    fn run_quality_gate_inner(
        task_node_id: &str,
        reviewer_agent_id: Option<&str>,
        app: tauri::AppHandle,
        terminal_service: TerminalService,
    ) -> Result<AiReviewGate, String> {
        let mut task = Self::get_task_node(task_node_id)?;
        if task.state != "awaitingReview" {
            return Err(format!("当前任务不能进入质量门禁: {}", task.state));
        }
        let delivery = Self::get_delivery(&task.delivery_id)?;
        let project = Self::get_project(&delivery.project_id)?;
        let reviewer = match reviewer_agent_id {
            Some(reviewer_id) => Self::get::<AiAgent>(AGENTS_DIR, reviewer_id, "Reviewer Agent")?,
            None => Self::get_all_agents()?
                .into_iter()
                .find(|agent| {
                    agent.enabled && task.assigned_agent_id.as_deref() != Some(agent.id.as_str())
                })
                .ok_or_else(|| "未找到可用的独立 Reviewer Agent".to_string())?,
        };
        if !reviewer.enabled || task.assigned_agent_id.as_deref() == Some(reviewer.id.as_str()) {
            return Err("产出任务的 Agent 不能审核自己的改动".to_string());
        }
        let contract_id = task
            .contract_id
            .clone()
            .ok_or_else(|| "任务未关联任务契约".to_string())?;
        let contract = Self::get::<AiTaskContract>(CONTRACTS_DIR, &contract_id, "任务契约")?;
        let worktree = PathBuf::from(&contract.working_directory);
        if !worktree.is_dir() {
            return Err("任务 worktree 不存在".to_string());
        }
        ensure_expected_artifacts(&contract, &worktree)?;
        ensure_task_branch_clean(&worktree)?;
        let commands = project
            .quality_gate
            .commands
            .iter()
            .chain(task.acceptance_commands.iter())
            .cloned()
            .collect::<Vec<_>>();
        let mut results = Vec::new();
        for command in commands {
            let result = run_shell_command(&worktree, &command)?;
            let failed = result.exit_code != 0;
            results.push(result);
            if failed {
                task.state = "rework".to_string();
                task.updated_at = chrono::Utc::now().to_rfc3339();
                Self::save(TASK_NODES_DIR, &task.id, &task)?;
                let gate = Self::save_review_gate(AiReviewGate {
                    id: Uuid::new_v4().to_string(),
                    delivery_id: delivery.id.clone(),
                    task_node_id: task.id.clone(),
                    reviewer_agent_id: Some(reviewer.id.clone()),
                    state: "failed".to_string(),
                    comments: Some("质量门禁失败，任务已退回返工".to_string()),
                    command_results: results,
                    line_comments: Vec::new(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                    updated_at: chrono::Utc::now().to_rfc3339(),
                })?;
                Self::append_event(
                    &delivery.id,
                    Some(&task.id),
                    None,
                    "qualityGateFailed",
                    "质量门禁失败，任务已退回返工",
                )?;
                return Ok(gate);
            }
        }
        let reviewer_runtime =
            Self::get::<AiAgentRuntime>(RUNTIMES_DIR, &reviewer.runtime_id, "Reviewer Runtime")?;
        if !reviewer_runtime.enabled {
            return Err("Reviewer Runtime 已禁用".to_string());
        }
        let active_reviewer_attempts = Self::active_attempt_count_for_agent(&reviewer.id)?;
        if active_reviewer_attempts >= reviewer.max_concurrency as usize {
            return Err(format!(
                "Reviewer Agent 已达到并发上限（{}）",
                reviewer.max_concurrency
            ));
        }
        let reviewer_attempt_id = Uuid::new_v4().to_string();
        let reviewer_started_at = chrono::Utc::now().to_rfc3339();
        let reviewer_attempt = AiAttempt {
            id: reviewer_attempt_id.clone(),
            delivery_id: delivery.id.clone(),
            task_node_id: task.id.clone(),
            contract_id: contract.id.clone(),
            agent_id: reviewer.id.clone(),
            runtime_id: reviewer_runtime.id.clone(),
            terminal_id: None,
            state: "running".to_string(),
            started_at: reviewer_started_at.clone(),
            finished_at: None,
            exit_code: None,
            summary: Some("Reviewer 正在独立审查".to_string()),
            created_at: reviewer_started_at.clone(),
            updated_at: reviewer_started_at,
        };
        Self::persist_attempt(&reviewer_attempt)?;
        let review_result = run_reviewer_agent(
            &reviewer,
            &reviewer_runtime,
            &task,
            &contract,
            &worktree,
            &reviewer_attempt_id,
            &project,
            app.clone(),
            terminal_service,
        );
        let mut finished_reviewer_attempt =
            Self::get::<AiAttempt>(ATTEMPTS_DIR, &reviewer_attempt_id, "Reviewer 执行")?;
        finished_reviewer_attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
        finished_reviewer_attempt.updated_at = finished_reviewer_attempt
            .finished_at
            .clone()
            .unwrap_or_default();
        let review_comments = match review_result {
            Ok((comments, exit_code)) => {
                finished_reviewer_attempt.state = "completed".to_string();
                finished_reviewer_attempt.exit_code = Some(exit_code);
                finished_reviewer_attempt.summary = Some(comments.clone());
                comments
            }
            Err(error) => {
                finished_reviewer_attempt.state = "failed".to_string();
                finished_reviewer_attempt.summary = Some(error.clone());
                Self::save(
                    ATTEMPTS_DIR,
                    &finished_reviewer_attempt.id,
                    &finished_reviewer_attempt,
                )?;
                let _ = Self::append_event(
                    &delivery.id,
                    Some(&task.id),
                    Some(&reviewer_attempt_id),
                    "reviewerFailed",
                    &error,
                )?;
                return Err(error);
            }
        };
        Self::save(
            ATTEMPTS_DIR,
            &finished_reviewer_attempt.id,
            &finished_reviewer_attempt,
        )?;
        let _ = Self::append_event(
            &delivery.id,
            Some(&task.id),
            Some(&reviewer_attempt_id),
            "reviewerCompleted",
            "Reviewer Agent 已完成独立审查",
        )?;
        let now = chrono::Utc::now().to_rfc3339();
        let gate = Self::save_review_gate(AiReviewGate {
            id: Uuid::new_v4().to_string(),
            delivery_id: delivery.id.clone(),
            task_node_id: task.id.clone(),
            reviewer_agent_id: Some(reviewer.id),
            state: "awaitingReviewer".to_string(),
            comments: Some(review_comments),
            command_results: results,
            line_comments: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        })?;
        task.state = "awaitingReview".to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        Self::append_event(
            &delivery.id,
            Some(&task.id),
            None,
            "qualityGatePassed",
            "质量门禁通过，等待独立 Reviewer 审核",
        )?;
        Ok(gate)
    }

    pub fn resolve_review_gate(
        id: &str,
        approved: bool,
        comments: String,
    ) -> Result<AiReviewGate, String> {
        let mut gate = Self::get::<AiReviewGate>(REVIEW_GATES_DIR, id, "审核门")?;
        if gate.state != "awaitingReviewer" {
            return Err(format!("当前审核门不能处理: {}", gate.state));
        }
        let mut task = Self::get_task_node(&gate.task_node_id)?;
        gate.state = if approved { "approved" } else { "rework" }.to_string();
        gate.comments = Some(comments.trim().to_string()).filter(|value| !value.is_empty());
        gate.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(REVIEW_GATES_DIR, &gate.id, &gate)?;
        task.state = if approved { "succeeded" } else { "rework" }.to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        let message = if approved {
            "独立审核已通过"
        } else {
            "独立审核要求返工"
        };
        Self::append_event(
            &gate.delivery_id,
            Some(&task.id),
            None,
            if approved {
                "reviewApproved"
            } else {
                "reviewRework"
            },
            message,
        )?;
        if approved {
            let _ = Self::refresh_ready_task_nodes(&gate.delivery_id)?;
            let _ = Self::try_complete_workflow_delivery(&gate.delivery_id)?;
        }
        Ok(gate)
    }

    fn save_review_gate(mut gate: AiReviewGate) -> Result<AiReviewGate, String> {
        if gate.created_at.is_empty() {
            gate.created_at = chrono::Utc::now().to_rfc3339();
        }
        if gate.updated_at.is_empty() {
            gate.updated_at = gate.created_at.clone();
        }
        Self::save(REVIEW_GATES_DIR, &gate.id, &gate)?;
        Ok(gate)
    }

    pub fn get_merge_records(delivery_id: Option<&str>) -> Result<Vec<AiMergeRecord>, String> {
        let mut records = Self::list(MERGE_RECORDS_DIR)?;
        if let Some(delivery_id) = delivery_id {
            records.retain(|record: &AiMergeRecord| record.delivery_id == delivery_id);
        }
        records.sort_by(|left: &AiMergeRecord, right: &AiMergeRecord| {
            right.updated_at.cmp(&left.updated_at)
        });
        Ok(records)
    }

    pub fn merge_delivery_locally(delivery_id: &str) -> Result<AiMergeRecord, String> {
        let delivery = Self::get_delivery(delivery_id)?;
        let project = Self::get_project(&delivery.project_id)?;
        let _guard = acquire_integration_lock(&project.id, "集成或合并")?;
        Self::merge_delivery_locally_locked(&delivery, &project)
    }

    pub fn cleanup_delivery_integration(delivery_id: &str) -> Result<(), String> {
        let delivery = Self::get_delivery(delivery_id)?;
        let project = Self::get_project(&delivery.project_id)?;
        let _guard = acquire_integration_lock(&project.id, "集成或合并")?;
        cleanup_delivery_integration_workspace(&project, &delivery)?;
        Self::append_event(
            &delivery.id,
            None,
            None,
            "integrationWorkspaceCleaned",
            "已清理该交付的临时集成工作区，可重新发起本地合并",
        )?;
        Ok(())
    }

   fn merge_delivery_locally_locked(
       delivery: &AiDelivery,
       project: &AiProject,
   ) -> Result<AiMergeRecord, String> {
       let result = Self::merge_delivery_locally_locked_impl(delivery, project);
       if result.is_err() {
           // 合并失败时清理临时集成工作区，避免遗留资源阻断后续重试
           let _ = cleanup_delivery_integration_workspace(project, delivery);
           // 统一失败出口：合并失败置 delivery 终态 mergeFailed。
           // 覆盖手动/自动/REST 全部入口及 merge_delivery_locally_locked_impl 内全部失败出口。
           if let Ok(mut failed_delivery) = Self::get_delivery(&delivery.id) {
               failed_delivery.state = "mergeFailed".to_string();
               failed_delivery.updated_at = chrono::Utc::now().to_rfc3339();
               let _ = Self::save(DELIVERIES_DIR, &failed_delivery.id, &failed_delivery);
               let _ = Self::append_event(
                   &failed_delivery.id,
                   None,
                   None,
                   "mergeFailed",
                   "本地合并失败，交付已置为合并失败终态",
               );
           }
       }
       result
   }

    /// 合并前置校验：全部任务须为 succeeded 或 skipped（skipped 含级联跳过、从未执行的
    /// planned/ready 标记忽略），且非编排任务须有已通过的独立审核门禁。
    /// 独立成函数供单测（合并主链路引用 comctl32 v6 专属 API，测试产物无 manifest 无法加载）。
    fn validate_tasks_mergeable(
        tasks: &[AiTaskNode],
        gates: &[AiReviewGate],
    ) -> Result<(), String> {
        if tasks.is_empty()
            || tasks
                .iter()
                .any(|task| !matches!(task.state.as_str(), "succeeded" | "skipped"))
        {
            return Err("仅当交付中的全部任务均已审核通过（或标记忽略）时才能本地合并".to_string());
        }
        for task in tasks
            .iter()
            .filter(|task| task.workflow_step_id.is_none() && task.state != "skipped")
        {
            if !gates
                .iter()
                .any(|gate| gate.task_node_id == task.id && gate.state == "approved")
            {
                return Err(format!("任务尚无通过的独立审核: {}", task.title));
            }
        }
        Ok(())
    }

   fn merge_delivery_locally_locked_impl(
       delivery: &AiDelivery,
       project: &AiProject,
   ) -> Result<AiMergeRecord, String> {
       let tasks = Self::get_task_nodes(&delivery.id)?;
        let gates = Self::get_review_gates(Some(&delivery.id))?;
        Self::validate_tasks_mergeable(&tasks, &gates)?;
        let mut task_groups = BTreeMap::<String, Vec<(AiTaskNode, AiTaskContract)>>::new();
        // skipped 任务没有可合并的分支（级联跳过的从未派发，无契约），跳过分组
        for task in tasks
            .iter()
            .filter(|task| task.execution_mode == "write" && task.state != "skipped")
        {
            let contract_id = task
                .contract_id
                .as_deref()
                .ok_or_else(|| "任务缺少任务契约".to_string())?;
            let contract = Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "任务契约")?;
            task_groups
                .entry(task.target_repository_id.clone())
                .or_default()
                .push((task.clone(), contract));
        }
        let mut integration_repositories = Vec::new();
        for (repository_id, group) in &task_groups {
            let repository = project
                .repositories
                .iter()
                .find(|repository| repository.id == *repository_id)
                .ok_or_else(|| "集成目标仓库不存在".to_string())?;
            let source = project_repository_path(project, repository)?;
            let integration_repo = repository_worktree_base_path(project, repository)?
                .join("integration")
                .join(compact_path_id(&delivery.id));
            if integration_repo.exists() {
                return Err(format!(
                    "集成工作区已存在，请先处理或清理: {}",
                    integration_repo.display()
                ));
            }
            let integration_root = integration_repo
                .parent()
                .ok_or_else(|| "集成 worktree 目录无效".to_string())?;
            fs::create_dir_all(integration_root)
                .map_err(|error| format!("创建集成工作区失败: {}", error))?;
            if project.worktree_root.is_none() {
                ensure_worktree_directory_is_ignored(&source)?;
            }
            let integration_branch = format!(
                "terminalbuddy/integration/{}-{}",
                safe_ref_segment(&delivery.id),
                safe_ref_segment(&repository.name)
            );
            run_git(
                &source,
                &vec![
                    "worktree".to_string(),
                    "add".to_string(),
                    "-b".to_string(),
                    integration_branch,
                    integration_repo.to_string_lossy().to_string(),
                    repository.default_branch.clone(),
                ],
            )?;
            integration_repositories.push((repository.name.clone(), integration_repo.clone()));
            for (_, contract) in group {
                let branch = contract
                    .branch_name
                    .as_deref()
                    .ok_or_else(|| "任务分支不存在".to_string())?;
                run_git(
                    &integration_repo,
                    &vec![
                        "merge".to_string(),
                        "--no-ff".to_string(),
                        "--no-commit".to_string(),
                        branch.to_string(),
                    ],
                )?;
                run_git(
                    &integration_repo,
                    &vec![
                        "-c".to_string(),
                        "user.name=TerminalBuddy".to_string(),
                        "-c".to_string(),
                        "user.email=terminalbuddy@local".to_string(),
                        "commit".to_string(),
                        "-m".to_string(),
                        format!("集成 {}", branch),
                    ],
                )?;
            }
        }
        for (repository_name, integration_repository) in integration_repositories {
            if project.quality_gate.commands.is_empty() {
                continue;
            }
            for command in &project.quality_gate.commands {
                let result = run_shell_command(&integration_repository, command)?;
                if result.exit_code != 0 {
                    Self::append_event(
                        &delivery.id,
                        None,
                        None,
                        "integrationFailed",
                        &format!("{} 的集成质量门禁失败: {}", repository_name, command),
                    )?;
                    return Err(format!(
                        "{} 的集成质量门禁失败: {}\n{}",
                        repository_name, command, result.output
                    ));
                }
            }
        }

        let now = chrono::Utc::now().to_rfc3339();
        let mut record = AiMergeRecord {
            id: Uuid::new_v4().to_string(),
            delivery_id: delivery.id.clone(),
            project_id: project.id.clone(),
            state: "merging".to_string(),
            repositories: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        for (repository_id, group) in &task_groups {
            let repository = project
                .repositories
                .iter()
                .find(|repository| repository.id == *repository_id)
                .ok_or_else(|| "合并目标仓库不存在".to_string())?;
            let source = project_repository_path(project, repository)?;
            ensure_clean_repository(&source)?;
            if current_branch(&source).as_deref() != Some(repository.default_branch.as_str()) {
                return Err(format!(
                    "原始仓库未位于目标分支 {}: {}",
                    repository.default_branch,
                    source.display()
                ));
            }
           for (_, contract) in group {
               let branch = contract
                   .branch_name
                   .clone()
                   .ok_or_else(|| "任务分支不存在".to_string())?;
                // 合并前验证分支 HEAD 未在验收后发生变化（TOCTOU 防护）
                if let Some(validated) = contract.validated_commit.as_deref() {
                    let branch_head = run_git(
                        &source,
                        &["rev-parse".to_string(), branch.clone()],
                    )?;
                    if branch_head != validated {
                        return Err(format!(
                            "任务分支 {} 在验收后发生了变化，已阻断合并（验收时: {}，当前: {}）",
                            branch,
                            validated.get(..8).unwrap_or(validated),
                            branch_head.get(..8).unwrap_or(&branch_head),
                        ));
                    }
                }
                let pre_merge_head =
                    run_git(&source, &vec!["rev-parse".to_string(), "HEAD".to_string()])?;
                record.repositories.push(AiMergeRepositoryRecord {
                    repository_id: repository.id.clone(),
                    branch_name: branch,
                    pre_merge_head,
                    merged_head: None,
                    state: "pending".to_string(),
                    error: None,
                });
            }
        }
        Self::save(MERGE_RECORDS_DIR, &record.id, &record)?;
        for index in 0..record.repositories.len() {
            let repository_id = record.repositories[index].repository_id.clone();
            let branch_name = record.repositories[index].branch_name.clone();
            let repository = project
                .repositories
                .iter()
                .find(|repository| repository.id == repository_id)
                .ok_or_else(|| "合并记录仓库不存在".to_string())?;
            match Self::merge_single_repository(project, repository, &branch_name, None) {
                Ok(merged_head) => {
                    record.repositories[index].state = "merged".to_string();
                    record.repositories[index].merged_head = Some(merged_head);
                    record.updated_at = chrono::Utc::now().to_rfc3339();
                    Self::save(MERGE_RECORDS_DIR, &record.id, &record)?;
                }
                Err(error) => {
                    record.repositories[index].state = "failed".to_string();
                    record.repositories[index].error = Some(error.clone());
                    let rollback_failed = Self::rollback_merge_record(project, &mut record);
                    record.state = if rollback_failed {
                        "blocked"
                    } else {
                        "rolledBack"
                    }
                    .to_string();
                    record.updated_at = chrono::Utc::now().to_rfc3339();
                    Self::save(MERGE_RECORDS_DIR, &record.id, &record)?;
                    Self::append_event(
                        &delivery.id,
                        None,
                        None,
                        "mergeFailed",
                        "本地合并失败，已尝试恢复已合并仓库",
                    )?;
                    // 系统托盘通知：合并冲突失败
                    if let Some(app) = APP_HANDLE.get() {
                        let _ = crate::commands::notification::show_ai_delivery_notification(
                            app.clone(),
                            "AI 交付合并冲突",
                            delivery.id.clone(),
                            format!("本地合并失败，已尝试恢复已合并仓库: {}", error),
                        );
                    }
                    return Err(format!("本地合并失败: {}", error));
                }
            }
        }
        record.state = "completed".to_string();
        record.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(MERGE_RECORDS_DIR, &record.id, &record)?;
        // 推送合并完成（交付级事件）
        Self::push_delivery_notice(
            &delivery.id,
            "合并完成",
            &format!("交付「{}」已合并到本地目标分支", delivery.title),
            None,
        );
        Self::complete_delivery_contracts(&delivery.id)?;
        let mut completed_delivery = delivery.clone();
        completed_delivery.state = "completed".to_string();
        completed_delivery.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(DELIVERIES_DIR, &completed_delivery.id, &completed_delivery)?;
        Self::append_event(
            &delivery.id,
            None,
            None,
            "mergedLocally",
            "交付已合并到本地目标分支，未执行远端推送",
        )?;
        // 系统托盘通知：合并成功
        if let Some(app) = APP_HANDLE.get() {
            let _ = crate::commands::notification::show_ai_delivery_notification(
                app.clone(),
                "AI 交付合并成功",
                delivery.id.clone(),
                format!("交付「{}」已合并到本地目标分支", completed_delivery.title),
            );
        }
        // 合并成功后清理临时集成 worktree、任务 worktree 和分支，避免资源累积
        let _ = cleanup_delivery_integration_workspace(project, delivery);
        cleanup_delivery_task_worktrees(project, delivery);
         Ok(record)
     }

     /// 单仓库合并：仓库干净（含冲突中间态检查）+ 目标分支确认 + validated_commit TOCTOU 校验
     /// + merge --no-ff。返回合并后的 HEAD。merge_delivery_locally_locked_impl 与
     /// continue_merge_after_conflict 共用。
     fn merge_single_repository(
         project: &AiProject,
         repository: &AiRepository,
         branch_name: &str,
         validated_commit: Option<&str>,
     ) -> Result<String, String> {
         let source = project_repository_path(project, repository)?;
         // porcelain status 非空即拦截：未提交改动、未完成的 merge 中间态（MERGE_HEAD 冲突未解决）都会命中
         ensure_clean_repository(&source)?;
         if current_branch(&source).as_deref() != Some(repository.default_branch.as_str()) {
             return Err(format!(
                 "原始仓库未位于目标分支 {}: {}",
                 repository.default_branch,
                 source.display()
             ));
         }
         if let Some(validated) = validated_commit {
             let branch_head = run_git(
                 &source,
                 &["rev-parse".to_string(), branch_name.to_string()],
             )?;
             if branch_head != validated {
                 return Err(format!(
                     "任务分支 {} 在验收后发生了变化，已阻断合并（验收时: {}，当前: {}）",
                     branch_name,
                     validated.get(..8).unwrap_or(validated),
                     branch_head.get(..8).unwrap_or(&branch_head),
                 ));
             }
         }
         run_git(
             &source,
             &vec![
                 "merge".to_string(),
                 "--no-ff".to_string(),
                 "-m".to_string(),
                 format!("TerminalBuddy: {}", branch_name),
                 branch_name.to_string(),
             ],
         )?;
         run_git(&source, &vec!["rev-parse".to_string(), "HEAD".to_string()])
     }

     /// 冲突已解决后继续合并：仅重跑 state == "failed" 的仓库子记录
     /// （TOCTOU 校验 + 干净状态检查由 merge_single_repository 保证），
     /// 全部成功则走既有收尾（契约完成/交付 completed/清理集成与任务 worktree）。
     pub fn continue_merge_after_conflict(delivery_id: &str) -> Result<(), String> {
         let delivery = Self::get_delivery(delivery_id)?;
         let project = Self::get_project(&delivery.project_id)?;
         let _guard = acquire_integration_lock(&project.id, "集成或合并")?;
         let mut records = Self::get_merge_records(Some(delivery_id))?;
         let record = records
             .first_mut()
             .ok_or_else(|| "该交付没有合并记录".to_string())?;
         if record.state != "blocked" {
             return Err(format!(
                 "merge 记录状态 {} 不可续接（仅 blocked）",
                 record.state
             ));
         }
         // 按分支名从契约解析 validated_commit（验收时记录），续接时做 TOCTOU 校验
         let contracts = Self::list::<AiTaskContract>(CONTRACTS_DIR)?;
         let mut all_ok = true;
         for index in 0..record.repositories.len() {
             if record.repositories[index].state != "failed" {
                 continue;
             }
             let repository_id = record.repositories[index].repository_id.clone();
             let branch_name = record.repositories[index].branch_name.clone();
             let Some(repository) = project
                 .repositories
                 .iter()
                 .find(|repository| repository.id == repository_id)
             else {
                 record.repositories[index].error = Some("目标仓库不存在".to_string());
                 all_ok = false;
                 continue;
             };
             let validated_commit = contracts
                 .iter()
                 .find(|contract| {
                     contract.delivery_id == delivery_id
                         && contract.branch_name.as_deref() == Some(branch_name.as_str())
                 })
                 .and_then(|contract| contract.validated_commit.as_deref());
             match Self::merge_single_repository(
                 &project,
                 repository,
                 &branch_name,
                 validated_commit,
             ) {
                 Ok(merged_head) => {
                     record.repositories[index].state = "merged".to_string();
                     record.repositories[index].merged_head = Some(merged_head);
                     record.repositories[index].error = None;
                     record.updated_at = chrono::Utc::now().to_rfc3339();
                     Self::save(MERGE_RECORDS_DIR, &record.id, &record)?;
                 }
                 Err(error) => {
                     record.repositories[index].error = Some(error);
                     all_ok = false;
                 }
             }
         }
         record.updated_at = chrono::Utc::now().to_rfc3339();
         Self::save(MERGE_RECORDS_DIR, &record.id, &record)?;
         if all_ok {
             record.state = "completed".to_string();
             Self::save(MERGE_RECORDS_DIR, &record.id, &record)?;
             Self::append_event(
                 delivery_id,
                 None,
                 None,
                 "mergedLocally",
                 "冲突已解决，合并完成",
             )?;
             Self::push_delivery_notice(
                 delivery_id,
                 "合并完成",
                 &format!("交付「{}」冲突已解决，合并完成", delivery.title),
                 None,
             );
             Self::complete_delivery_contracts(delivery_id)?;
             let mut completed_delivery = Self::get_delivery(delivery_id)?;
             completed_delivery.state = "completed".to_string();
             completed_delivery.updated_at = chrono::Utc::now().to_rfc3339();
             Self::save(DELIVERIES_DIR, &completed_delivery.id, &completed_delivery)?;
             let _ = cleanup_delivery_integration_workspace(&project, &delivery);
             cleanup_delivery_task_worktrees(&project, &delivery);
         } else {
             Self::append_event(
                 delivery_id,
                 None,
                 None,
                 "mergeFailed",
                 "仍有仓库合并失败，请解决冲突后再次续接",
             )?;
         }
         Ok(())
     }

     fn complete_delivery_contracts(delivery_id: &str) -> Result<(), String> {
        for mut contract in Self::list::<AiTaskContract>(CONTRACTS_DIR)?
            .into_iter()
            .filter(|contract| contract.delivery_id == delivery_id)
        {
            contract.state = "completed".to_string();
            contract.updated_at = chrono::Utc::now().to_rfc3339();
            Self::save(CONTRACTS_DIR, &contract.id, &contract)?;
        }
        Ok(())
    }

    fn rollback_merge_record(project: &AiProject, record: &mut AiMergeRecord) -> bool {
        let mut rollback_failed = false;
        for repository_record in record
            .repositories
            .iter_mut()
            .filter(|item| item.state == "merged")
        {
            let Some(repository) = project
                .repositories
                .iter()
                .find(|repository| repository.id == repository_record.repository_id)
            else {
                rollback_failed = true;
                continue;
            };
            match project_repository_path(project, repository).and_then(|source| {
                run_git(
                    &source,
                    &vec![
                        "reset".to_string(),
                        "--hard".to_string(),
                        repository_record.pre_merge_head.clone(),
                    ],
                )
            }) {
                Ok(_) => repository_record.state = "rolledBack".to_string(),
                Err(error) => {
                    repository_record.state = "rollbackFailed".to_string();
                    repository_record.error = Some(error);
                    rollback_failed = true;
                }
            }
        }
        rollback_failed
    }

    pub fn dispatch_task_node(
        task_node_id: &str,
        requested_agent_id: Option<&str>,
    ) -> Result<AiAttempt, String> {
        let _dispatch_guard = dispatch_lock()
            .lock()
            .map_err(|_| "任务派发锁异常".to_string())?;
        let mut task = Self::get_task_node(task_node_id)?;
        if task.state != "ready" {
            return Err(format!("当前任务不能派发: {}", task.state));
        }
        if task.workflow_step_id.is_some()
            && !task
                .expected_artifacts
                .iter()
                .any(|artifact| !artifact.trim().is_empty())
        {
            return Err("编排阶段缺少交付物，无法派发；请重新生成或补充任务图".to_string());
        }
        validate_artifact_paths(&task.expected_artifacts, "交付物")?;
        validate_artifact_paths(&task.input_artifacts, "输入成果")?;
        let delivery = Self::get_delivery(&task.delivery_id)?;
        if delivery.state != "running" {
            return Err("交付尚未进入运行状态".to_string());
        }
        if Self::global_active_attempts()? >= GLOBAL_MAX_ATTEMPTS {
            return Err("全局并发已达上限，稍后重试".to_string());
        }
        let project = Self::get_project(&delivery.project_id)?;
        let repository = project
            .repositories
            .iter()
            .find(|repository| repository.id == task.target_repository_id)
            .ok_or_else(|| "任务目标仓库不存在".to_string())?;
        // 显式指定的 Agent 用于处理 Runtime 不可用或临时切换模型的场景，优先级高于角色默认绑定。
        let selected_agent_id = requested_agent_id.or_else(|| {
            task.role_id
                .is_none()
                .then_some(task.preferred_agent_id.as_deref())
                .flatten()
        });
        let agent = Self::select_agent(&task, selected_agent_id, &project, repository)?;
        let execution_context =
            resolve_execution_context(&task.execution_mode, &task.execution_context)?;

        let contract = match task.contract_id.as_deref() {
            Some(contract_id) => {
                let mut contract =
                    Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "任务契约")?;
                if contract.state != "allocated"
                    || !PathBuf::from(&contract.working_directory).is_dir()
                    || (execution_context == EXECUTION_CONTEXT_TASK_WORKTREE
                        && contract.worktree_path.is_none())
                {
                    return Err("返工任务的执行目录不可用，无法重新派发".to_string());
                }
                // 编辑执行相关字段后契约被标脏（update_task_node）：用任务最新字段同步契约，
                // 否则 agent 提示词与验收校验仍按旧约束执行（契约字段是二者的数据源）。
                if contract.dirty {
                    contract.allowed_write_paths = task.allowed_write_paths.clone();
                    contract.expected_artifacts = task.expected_artifacts.clone();
                    contract.acceptance_commands = task.acceptance_commands.clone();
                    contract.execution_context = execution_context;
                    contract.retry_count = task.retry_count;
                    contract.dirty = false;
                    contract.updated_at = chrono::Utc::now().to_rfc3339();
                    Self::save(CONTRACTS_DIR, contract_id, &contract)?;
                }
                contract
            }
            None => {
                let contract = Self::create_task_contract(CreateTaskContractInput {
                    project_id: project.id.clone(),
                    delivery_id: delivery.id.clone(),
                    task_id: task.id.clone(),
                    title: task.title.clone(),
                    target_repository_id: task.target_repository_id.clone(),
                    allowed_write_paths: task.allowed_write_paths.clone(),
                    execution_context,
                    input_artifacts: task.input_artifacts.clone(),
                    expected_artifacts: task.expected_artifacts.clone(),
                    acceptance_commands: task.acceptance_commands.clone(),
                    retry_count: task.retry_count,
                })?;
                Self::allocate_task_worktree(&contract.id)?
            }
        };
        // 依赖基线校验：依赖任务验收时记录的 validated_commit 必须与分支当前 HEAD 一致，
        // 防止下游基于过期基线执行（readonly 依赖无分支/无基线，跳过）。
        if task.execution_mode == "write" && !task.dependency_ids.is_empty() {
            let source = project_repository_path(&project, repository)?;
            for dependency_id in &task.dependency_ids {
                let dependency = Self::get_task_node(dependency_id)?;
                if dependency.execution_mode != "write" {
                    continue;
                }
                let Some(contract_id) = dependency.contract_id.as_deref() else {
                    continue;
                };
                let Ok(dependency_contract) =
                    Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "依赖任务契约")
                else {
                    continue;
                };
                let Some(baseline) = dependency_contract.validated_commit.as_deref() else {
                    continue;
                };
                let Some(branch) = dependency_contract.branch_name.as_deref() else {
                    continue;
                };
                let current = run_git(&source, &["rev-parse".to_string(), branch.to_string()])?;
                if current != baseline {
                    return Err(format!(
                        "依赖任务「{}」的基线 commit 已过期（{} → {}），请先重跑上游任务",
                        dependency.title,
                        baseline.get(..8).unwrap_or(baseline),
                        current.get(..8).unwrap_or(&current),
                    ));
                }
            }
        }
        let now = chrono::Utc::now().to_rfc3339();
        let attempt = AiAttempt {
            id: Uuid::new_v4().to_string(),
            delivery_id: delivery.id.clone(),
            task_node_id: task.id.clone(),
            contract_id: contract.id.clone(),
            agent_id: agent.id.clone(),
            runtime_id: agent.runtime_id.clone(),
            terminal_id: None,
            state: "queued".to_string(),
            started_at: now.clone(),
            finished_at: None,
            exit_code: None,
            summary: None,
            created_at: now.clone(),
            updated_at: now,
        };
        Self::persist_attempt(&attempt)?;
        task.assigned_agent_id = Some(agent.id);
        task.contract_id = Some(contract.id);
        task.attempt_ids.push(attempt.id.clone());
        task.state = "queued".to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        Self::append_event(
            &delivery.id,
            Some(&task.id),
            Some(&attempt.id),
            "taskQueued",
            "任务已分配独立 worktree 并进入执行队列",
        )?;
        Ok(attempt)
    }

    pub fn retry_task_node(task_node_id: &str) -> Result<AiTaskNode, String> {
        let mut task = Self::get_task_node(task_node_id)?;
        if !matches!(
            task.state.as_str(),
            "failed" | "rework" | "cancelled" | "policyViolation"
        ) {
            return Err(format!("当前任务不能重新派发: {}", task.state));
        }
        // 检查重试次数上限。retry_count=0 表示不限制，>0 时已用尽则暂停交付。
        let effective_retry_limit = task.retry_count;
        if effective_retry_limit > 0 {
            let attempted = task.attempt_ids.len() as u32;
            if attempted >= effective_retry_limit {
                // 清理重试耗尽的 worktree 和分支，避免资源泄漏
                let _ = (|| -> Result<(), String> {
                    let delivery = Self::get_delivery(&task.delivery_id)?;
                    let project = Self::get_project(&delivery.project_id)?;
                    if let Some(contract_id) = task.contract_id.as_deref() {
                        let contract = Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "任务契约")?;
                        if let (Some(worktree), Some(branch)) = (contract.worktree_path.as_deref(), contract.branch_name.as_deref()) {
                            let repository = project.repositories.iter()
                                .find(|r| r.id == contract.target_repository_id)
                                .ok_or_else(|| "目标仓库不存在".to_string())?;
                            let source = project_repository_path(&project, repository)?;
                            cleanup_unallocated_task_worktree(&source, Path::new(worktree), branch);
                        }
                    }
                    Ok(())
                })();
                // 触顶：暂停交付并通知（不直接静默拒绝），人工检查后可继续
                let mut delivery = Self::get_delivery(&task.delivery_id)?;
                if delivery.state == "running" {
                    delivery.state = "paused".to_string();
                    delivery.updated_at = chrono::Utc::now().to_rfc3339();
                    Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
                }
                Self::append_event(
                    &delivery.id,
                    Some(&task.id),
                    None,
                    "deliveryPaused",
                    &format!("任务 {} 重试触顶，交付已暂停", task.title),
                )?;
                return Err(format!(
                    "任务已达到最大重试次数（{} / {}），交付已暂停，请检查现场后调整",
                    attempted, effective_retry_limit
                ));
            }
            // 动态扩展容错：已有重试记录多于当前设置时自动提高上限
            task.retry_count = task.retry_count.max(attempted.saturating_add(1));
        }
        let delivery = Self::get_delivery(&task.delivery_id)?;
        if delivery.state != "running" {
            return Err("仅运行中的交付可以重新派发任务".to_string());
        }
        let dependencies_ready = task
            .dependency_ids
            .iter()
            .map(|dependency_id| Self::get_task_node(dependency_id))
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .all(|dependency| dependency.state == "succeeded");
        task.state = if dependencies_ready {
            "ready"
        } else {
            "planned"
        }
        .to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        Self::append_event(
            &delivery.id,
            Some(&task.id),
            None,
            "taskRetryReady",
            if dependencies_ready {
                "任务已重新进入待执行队列，将在已有 worktree 基础上续接执行"
            } else {
                "任务等待前置依赖重新完成后再进入执行队列"
            },
        )?;
        Ok(task)
    }

    pub fn dispatch_ready_tasks(delivery_id: &str) -> Result<Vec<AiAttempt>, String> {
        let delivery = Self::get_delivery(delivery_id)?;
        if delivery.state != "running" {
            return Err("仅运行中的交付可以派发任务".to_string());
        }
        let _ = Self::refresh_ready_task_nodes(delivery_id)?;
        let tasks = Self::get_task_nodes(delivery_id)?;
        let mut attempts = Vec::new();
        // 优先级排序：workflow 首步 + taskWorktree 的写入任务先派发，其余延后
        let mut ready_tasks = tasks
            .into_iter()
            .filter(|task| task.state == "ready")
            .collect::<Vec<_>>();
        ready_tasks.sort_by_key(|task| Self::dispatch_priority(task, &delivery));
        for task in ready_tasks {
            match Self::dispatch_task_node(&task.id, None) {
                Ok(attempt) => attempts.push(attempt),
                Err(error) => {
                    let _ = Self::append_event(
                        delivery_id,
                        Some(&task.id),
                        None,
                        "dispatchDeferred",
                        &error,
                    )?;
                }
            }
        }
        Ok(attempts)
    }

    /// 统一派发 + 启动：dispatch_ready_tasks 后逐 attempt start_attempt，聚合错误。
    /// 返回成功启动的 attempt 数；任一步失败立即返回 Err（调用方决定是否静默）。
    pub fn dispatch_ready_and_start(
        delivery_id: &str,
        app: tauri::AppHandle,
        terminal_service: TerminalService,
    ) -> Result<usize, String> {
        let attempts = Self::dispatch_ready_tasks(delivery_id)?;
        let mut started = 0usize;
        let mut errors: Vec<String> = Vec::new();
        for attempt in attempts {
            match Self::start_attempt(&attempt.id, app.clone(), terminal_service.clone()) {
                Ok(_) => started += 1,
                Err(error) => errors.push(format!("{}: {}", attempt.id, error)),
            }
        }
        if !errors.is_empty() {
            return Err(format!(
                "部分任务启动失败（成功 {} 个）: {}",
                started,
                errors.join("; ")
            ));
        }
        Ok(started)
    }

    pub fn start_attempt(
        attempt_id: &str,
        app: tauri::AppHandle,
        terminal_service: TerminalService,
    ) -> Result<AiAttempt, String> {
        let _start_guard = attempt_start_lock()
            .lock()
            .map_err(|_| "Agent 启动锁异常".to_string())?;
        let mut attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?;
        if attempt.state != "queued" {
            return Err(format!("当前执行尝试不能启动: {}", attempt.state));
        }
        if Self::global_active_attempts()? >= GLOBAL_MAX_ATTEMPTS {
            return Err("全局并发已达上限，稍后重试".to_string());
        }
        let start_result = (|| -> Result<AiAttempt, String> {
            let delivery = Self::get_delivery(&attempt.delivery_id)?;
            if delivery.state != "running" {
                return Err("交付已暂停或未运行，不能启动任务".to_string());
            }
            let project = Self::get_project(&delivery.project_id)?;
            let contract =
                Self::get::<AiTaskContract>(CONTRACTS_DIR, &attempt.contract_id, "任务契约")?;
            let task = Self::get_task_node(&attempt.task_node_id)?;
            let agent = Self::get::<AiAgent>(AGENTS_DIR, &attempt.agent_id, "Agent")?;
            let runtime = Self::get::<AiAgentRuntime>(RUNTIMES_DIR, &attempt.runtime_id, "运行时")?;
            if !agent.enabled || !runtime.enabled {
                return Err("Agent 或 Runtime 已禁用".to_string());
            }
            let working_directory = PathBuf::from(&contract.working_directory);
            if !working_directory.is_dir()
                || (contract.execution_context == EXECUTION_CONTEXT_TASK_WORKTREE
                    && contract.worktree_path.is_none())
            {
                return Err("任务执行目录尚未分配或目录不可用".to_string());
            }
            let agent_start_directory = working_directory.clone();
            if !agent_start_directory.is_dir() {
                return Err("任务契约工作目录不可用，无法启动 Agent".to_string());
            }
            let mut prompt = build_agent_prompt(&task, &contract, &project)?;
            // 启动预设展开：prompt_prefix / context_strategy 拼入提示词，model_args 注入启动命令
            let mut preset_model_args: Vec<String> = Vec::new();
            if let Some(preset_name) = agent.startup_preset_name.as_deref() {
                if let Ok(preset) = Self::get_startup_preset_by_name(preset_name) {
                    if !preset.prompt_prefix.trim().is_empty() {
                        prompt = format!("{}\n\n{}", preset.prompt_prefix.trim(), prompt);
                    }
                    if let Some(strategy) = preset
                        .context_strategy
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                    {
                        prompt = format!("上下文策略：{}\n\n{}", strategy.trim(), prompt);
                    }
                    preset_model_args = preset_model_args_from_value(&preset.model_args);
                }
            }
            if let Some(continuation) = build_continuation_context(&task, &contract, &attempt.id) {
                prompt = format!("{}\n\n---\n\n{}", continuation, prompt);
            }
            let control = prepare_terminal_control(
                &attempt.id,
                Some(&format!("{} · {}", agent.name, task.title)),
                &prompt,
            )?;
            prompt.push_str(&format!(
            "\n\n需要用户决策时，不要猜测或继续修改。请将以下 JSON 写入文件 {}，然后退出当前 CLI：\n{{\"question\":\"需要用户回答的问题\",\"impact\":\"不决策会如何影响任务\",\"options\":[{{\"label\":\"方案名称\",\"description\":\"方案说明\"}}]}}\n只有确实需要用户决定时才创建该文件。",
            control.decision_path.display(),
        ));
            let workflow_review_required = requires_workflow_review(&task);
            let workflow_review_path = if workflow_review_required {
                fs::write(&control.review_schema_path, WORKFLOW_REVIEW_SCHEMA)
                    .map_err(|error| format!("写入 Reviewer 输出 Schema 失败: {}", error))?;
                prompt.push_str(&format!(
                    "\n\n这是编排中的独立审查步骤。完成审查后，必须将严格符合 Schema 的 JSON 写入 {}，再退出当前 CLI。Schema 文件：{}\n只允许以下两个字段，禁止输出 acceptedArtifacts 或任何其他字段：\n{{\"approved\":true,\"comments\":\"中文审查结论和剩余风险\"}}\n写入后必须重新读取 review.json，自检 JSON 格式、字段名、字段类型和 comments 非空。若发现需要返工的问题，将 approved 设为 false，并在 comments 中说明问题和修复方向。未写入或格式无效将视为审查失败。",
                    control.review_path.display(),
                    control.review_schema_path.display(),
                ));
                prompt.push_str(&format!(
                    "\n若 approved 为 false，必须再将所有需要用户选择的阻塞项汇总成一个 JSON 写入 {}：\n{{\"question\":\"需要用户决定的阻塞事项\",\"impact\":\"不决策会如何影响后续实现\",\"options\":[{{\"label\":\"选项名称\",\"description\":\"选项说明\"}}]}}\n拒绝评审时缺少该文件也视为审查失败。",
                    control.decision_path.display(),
                ));
                Some(control.review_path.clone())
            } else {
                None
            };
            fs::write(&control.prompt_path, &prompt)
                .map_err(|error| format!("更新 Agent 决策协议失败: {}", error))?;
            let mut codex_writable_directories = vec![control
                .decision_path
                .parent()
                .ok_or_else(|| "Agent 终端控制目录不可用".to_string())?
                .to_path_buf()];
            // Codex 需要访问任务目录和交接目录；只读任务的变更仍由完成校验拦截。
            codex_writable_directories.push(working_directory.clone());
            if let Some(directory) = contract.input_artifact_directory.as_deref() {
                codex_writable_directories.push(PathBuf::from(directory));
            }
            if let Some(directory) = contract.output_artifact_directory.as_deref() {
                codex_writable_directories.push(PathBuf::from(directory));
            }
            let terminal_command = build_interactive_terminal_command_with_codex_output(
                &runtime,
                &agent,
                &control,
                (workflow_review_required && runtime_is_codex(&runtime))
                    .then_some(control.review_schema_path.as_path()),
                (workflow_review_required && runtime_is_codex(&runtime))
                    .then_some(control.review_path.as_path()),
                &codex_writable_directories,
                &preset_model_args,
            )?;
            let terminal_id = create_ai_terminal(
                &terminal_service,
                &app,
                &format!("AI · {} · {}", agent.name, task.title),
                &agent_start_directory,
                &project,
            )?;
            let attempt_id = attempt.id.clone();
            let delivery_id = attempt.delivery_id.clone();
            let task_node_id = attempt.task_node_id.clone();
            let app_handle = app.clone();
            attempt.terminal_id = Some(terminal_id.clone());
            attempt.state = "running".to_string();
            attempt.started_at = chrono::Utc::now().to_rfc3339();
            attempt.updated_at = attempt.started_at.clone();
           Self::persist_attempt(&attempt)?;
           let mut running_task = task;
           running_task.state = "running".to_string();
           running_task.updated_at = chrono::Utc::now().to_rfc3339();
           // task 状态保存失败不阻止 Agent 启动，watchdog 会确保最终一致性
           let _ = Self::save(TASK_NODES_DIR, &running_task.id, &running_task);
           let _ = Self::append_event(
               &delivery_id,
               Some(&task_node_id),
               Some(&attempt_id),
               "attemptStarted",
               "Agent 已在原生终端中启动，可打开终端查看并继续沟通",
           );

            let input_terminal_service = terminal_service.clone();
            let input_terminal_id = terminal_id.clone();
            let input_start_directory = agent_start_directory.clone();
            thread::spawn(move || {
                if start_interactive_terminal_command(
                    &input_terminal_service,
                    &input_terminal_id,
                    &input_start_directory,
                    &terminal_command,
                )
                .is_err()
                {
                    let _ = input_terminal_service.close_terminal(&input_terminal_id);
                }
            });

            let monitor_terminal_service = terminal_service.clone();
            let monitor_delivery_id = delivery_id.clone();
            let monitor_task_node_id = task_node_id.clone();
            let monitor_runtime = runtime.clone();
            let monitor_agent = agent.clone();
            let monitor_working_directory = agent_start_directory.clone();
            thread::spawn(move || {
                // 运行目录：transcript.log 与 live-output.log 同目录
                let run_dir = control
                    .transcript_path
                    .parent()
                    .map(std::path::Path::to_path_buf)
                    .unwrap_or_default();
                let mut review_repair_attempted = false;
                let (exit_code, _output, transcript) = loop {
                    let exit_code = loop {
                        if let Some(code) = read_terminal_exit_code(&control.exit_marker) {
                            break Some(code);
                        }
                        // drain 独占消费：缓冲被消费后无 last_len 竞态、无内存增长
                        // 注意：Err 表示终端已关闭，必须 break None（unwrap_or_default 会吞错成空串且不 break → 死循环）
                        let output = match monitor_terminal_service
                            .drain_terminal_output(&terminal_id)
                        {
                            Ok(output) => output,
                            Err(_) => break None,
                        };
                        if !output.is_empty() {
                            // 追加写 live-output.log（写入侧截断：>5MB 保留尾部一半再续写）
                            let log_path = run_dir.join("live-output.log");
                            if let Ok(meta) = fs::metadata(&log_path) {
                                if meta.len() > 5 * 1024 * 1024 {
                                    let content = fs::read_to_string(&log_path).unwrap_or_default();
                                    // 截断必须落在字符边界：多字节 UTF-8 中点 slice 会 panic 并杀死 monitor 线程
                                    let boundary =
                                        content.ceil_char_boundary(content.len() - content.len() / 2);
                                    let _ = fs::write(&log_path, &content[boundary..]);
                                }
                            }
                            if let Ok(mut f) = fs::OpenOptions::new().append(true).open(&log_path) {
                                let _ = f.write_all(output.as_bytes());
                            }
                        }
                        thread::sleep(Duration::from_millis(300));
                    };
                    // 结束时 transcript 兜底：transcript.log 为空则以 live-output.log 尾部 20k 字符兜底
                    // （Out-File 缓冲写入，进程退出前文件基本为空；兜底只取尾部，MB 级文本不得进入 finish_attempt 链）
                    let transcript = fs::read_to_string(&control.transcript_path)
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| {
                            fs::read_to_string(run_dir.join("live-output.log"))
                                .map(|s| {
                                    s.chars()
                                        .rev()
                                        .take(20_000)
                                        .collect::<String>()
                                        .chars()
                                        .rev()
                                        .collect::<String>()
                                })
                                .unwrap_or_default()
                        });

                    if exit_code.is_some() {
                        if let Some(review_path) = workflow_review_path.as_deref() {
                            if let Err(validation_error) = read_workflow_review(review_path) {
                                if !review_repair_attempted {
                                    review_repair_attempted = true;
                                    match repair_workflow_review(
                                        &control,
                                        &monitor_runtime,
                                        &monitor_agent,
                                        &monitor_terminal_service,
                                        &terminal_id,
                                        &monitor_working_directory,
                                        &validation_error,
                                    ) {
                                        Ok(()) => continue,
                                        Err(repair_error) => {
                                            let failure = format!(
                                                "{}\nReviewer 协议修复启动失败: {}",
                                                transcript, repair_error
                                            );
                                            break (Some(1), failure.clone(), failure);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    break (exit_code, String::new(), transcript);
                };
                if exit_code.is_none() {
                    if let Ok(current_attempt) = Self::get::<AiAttempt>(
                        ATTEMPTS_DIR,
                        &attempt_id,
                        "终端关闭后的执行尝试",
                    ) {
                        if let Err(error) = reconcile_running_attempt(
                            &current_attempt,
                            app_handle.clone(),
                            monitor_terminal_service.clone(),
                        ) {
                            let _ = fail_attempt_from_watchdog(
                                &current_attempt,
                                &format!("Agent 终端已关闭，任务状态检查失败：{}", error),
                                "attemptFailed",
                                app_handle.clone(),
                                monitor_terminal_service.clone(),
                            );
                        }
                    }
                    return;
                }
                match read_agent_decision(&control.decision_path) {
                    Ok(Some(decision)) => {
                        if let Err(e) = Self::pause_attempt_for_decision(
                            &attempt_id,
                            &monitor_delivery_id,
                            &monitor_task_node_id,
                            decision,
                            app_handle.clone(),
                        ) {
                          eprintln!("[AI Delivery] pause_attempt_for_decision 失败: {}", e);
                          // 决策暂停失败时回退到正常完成流程，避免任务卡死
                          let _ = Self::finish_attempt(
                              &attempt_id,
                              &monitor_delivery_id,
                              &monitor_task_node_id,
                              exit_code,
                              &transcript,
                              &transcript,
                              workflow_review_path.as_deref(),
                              app_handle.clone(),
                              monitor_terminal_service.clone(),
                              false,
                          );
                        } else {
                            // 决策暂停成功后关闭终端，Agent CLI 已退出
                            let _ = monitor_terminal_service.close_terminal(&terminal_id);
                        }
                    }
                    Ok(None) => {
                        if let Err(e) = Self::finish_attempt(
                            &attempt_id,
                            &monitor_delivery_id,
                            &monitor_task_node_id,
                            exit_code,
                            &transcript,
                            &transcript,
                            workflow_review_path.as_deref(),
                            app_handle.clone(),
                            monitor_terminal_service.clone(),
                            false,
                        ) {
                            eprintln!("[AI Delivery] finish_attempt 失败: {}", e);
                        }
                    }
                    Err(error) => {
                        let failure = format!("{}\n决策协议文件无效: {}", transcript, error);
                        let _ = Self::finish_attempt(
                            &attempt_id,
                            &monitor_delivery_id,
                            &monitor_task_node_id,
                            Some(1),
                            &transcript,
                            &failure,
                            workflow_review_path.as_deref(),
                            app_handle.clone(),
                            monitor_terminal_service.clone(),
                            false,
                        );
                    }
                }
            });
            // watchdog 超时值快照：任务级 → Agent 默认 → 全局兜底（attempt running 期间任务不可编辑，快照与运行态一致）
            let watchdog_timeout = Self::get_task_node(&attempt.task_node_id)
                .ok()
                .and_then(|task| task.timeout_seconds)
                .or_else(|| {
                    Self::get::<AiAgent>(AGENTS_DIR, &attempt.agent_id, "Agent 超时默认")
                        .ok()
                        .and_then(|agent| agent.default_timeout_seconds)
                })
                .unwrap_or(DEFAULT_ATTEMPT_TIMEOUT_SECONDS) as u64;
            let watchdog_attempt_id = attempt.id.clone();
            let watchdog_delivery_id = delivery_id.clone();
            let watchdog_task_node_id = task_node_id.clone();
            let watchdog_app = app.clone();
            let watchdog_terminal_service = terminal_service.clone();
            thread::spawn(move || {
                run_attempt_watchdog(
                    &watchdog_attempt_id,
                    &watchdog_delivery_id,
                    &watchdog_task_node_id,
                    watchdog_app,
                    watchdog_terminal_service,
                    watchdog_timeout,
                );
            });
            Ok(attempt)
        })();
        if let Err(error) = &start_result {
            let _ = Self::fail_queued_attempt(attempt_id, error, &app);
        }
        start_result
    }

    pub fn cancel_attempt(
        attempt_id: &str,
        terminal_service: TerminalService,
    ) -> Result<AiAttempt, String> {
        let mut attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?;
        if attempt.state != "running" {
            return Err("执行尝试当前不在运行".to_string());
        }
        let terminal_id = attempt
            .terminal_id
            .clone()
            .ok_or_else(|| "执行尝试未关联终端".to_string())?;
        attempt.state = "cancelled".to_string();
        attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
        attempt.updated_at = attempt.finished_at.clone().unwrap_or_default();
        Self::persist_attempt(&attempt)?;
        Self::cleanup_attempt_run_dir(&attempt.id);
        let _ = terminal_service.close_terminal(&terminal_id);
        let mut task = Self::get_task_node(&attempt.task_node_id)?;
        task.state = "cancelled".to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        Self::append_event(
            &attempt.delivery_id,
            Some(&task.id),
            Some(&attempt.id),
            "attemptCancelled",
            "用户已取消 Agent 执行",
        )?;
        Ok(attempt)
    }

    /// 批量取消任务节点：queued/ready/planned/rework/needsInput 置 cancelled，
    /// 并级联终止其仍在运行中的 attempt（关闭对应终端）。
    pub fn cancel_task_node(
        task_node_id: &str,
        terminal_service: TerminalService,
    ) -> Result<AiTaskNode, String> {
        let mut task = Self::get_task_node(task_node_id)?;
        if !matches!(
            task.state.as_str(),
            "queued" | "ready" | "planned" | "rework" | "needsInput"
        ) {
            return Err(format!("任务状态 {} 不可取消", task.state));
        }
        for attempt_id in &task.attempt_ids {
            if let Ok(attempt) = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试") {
                if attempt.state == "running" {
                    if let Some(terminal_id) = attempt.terminal_id.as_deref() {
                        let _ = terminal_service.close_terminal(terminal_id);
                    }
                    let mut updated = attempt;
                    updated.state = "cancelled".to_string();
                    updated.finished_at = Some(chrono::Utc::now().to_rfc3339());
                    updated.updated_at = updated.finished_at.clone().unwrap_or_default();
                    let _ = Self::persist_attempt(&updated);
                    Self::cleanup_attempt_run_dir(&updated.id);
                }
            }
        }
        task.state = "cancelled".to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        Self::append_event(
            &task.delivery_id,
            Some(&task.id),
            None,
            "taskCancelled",
            &format!("任务 {} 已取消", task.title),
        )?;
        Ok(task)
    }

    /// 标记任务忽略（skipped）：failed/policyViolation/rework/needsInput/planned/ready 可标记，
    /// 收尾判定将 skipped 视为可完成状态（不阻塞后续合并）。
    /// planned/ready 允许直接标记（缩小交付范围）；依赖被跳过会级联跳过下游 planned/ready 任务，
    /// 否则下游因「依赖须全 succeeded 才 ready」永久停在 planned，交付无法收尾合并。
    pub fn mark_task_skipped(task_node_id: &str) -> Result<(), String> {
        let mut task = Self::get_task_node(task_node_id)?;
        if !matches!(
            task.state.as_str(),
            "failed" | "policyViolation" | "rework" | "needsInput" | "planned" | "ready"
        ) {
            return Err(format!("任务状态 {} 不可标记忽略", task.state));
        }
        // 注：交付整体收尾（全部任务完成/跳过后自动合并）由命令层 mark_ai_task_skipped
        // 在服务层返回后触发 try_complete_workflow_delivery，不在本函数内调用——
        // 使级联逻辑可独立单测（合并链路引用 comctl32 v6 专属 API，无 manifest 的
        // cargo test 产物加载时会因 TaskDialogIndirect 缺失而失败）。
        let delivery_id = task.delivery_id.clone();
        let mut skipped_ids = vec![task.id.clone()];
        task.state = "skipped".to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        Self::cancel_queued_attempts_of_task(&task);
        Self::cleanup_skipped_task_worktree(&task);
        Self::append_event(
            &delivery_id,
            Some(&task.id),
            None,
            "taskSkipped",
            &format!("任务 {} 已标记忽略（不阻塞后续合并）", task.title),
        )?;
        // 级联：依赖链上任一任务被跳过，下游 planned/ready 任务无法再获得产物，一并跳过。
        loop {
            let mut cascaded = false;
            for mut downstream in Self::get_task_nodes(&delivery_id)? {
                if skipped_ids.contains(&downstream.id)
                    || !matches!(downstream.state.as_str(), "planned" | "ready")
                    || !downstream.dependency_ids.iter().any(|dep| skipped_ids.contains(dep))
                {
                    continue;
                }
                downstream.state = "skipped".to_string();
                downstream.updated_at = chrono::Utc::now().to_rfc3339();
                Self::save(TASK_NODES_DIR, &downstream.id, &downstream)?;
                Self::cancel_queued_attempts_of_task(&downstream);
                Self::cleanup_skipped_task_worktree(&downstream);
                Self::append_event(
                    &delivery_id,
                    Some(&downstream.id),
                    None,
                    "taskSkipped",
                    &format!("依赖任务已忽略，任务 {} 级联跳过", downstream.title),
                )?;
                skipped_ids.push(downstream.id.clone());
                cascaded = true;
            }
            if !cascaded {
                break;
            }
        }
        Ok(())
    }

    /// 取消任务上排队中的 attempt（跳过与自动派发的竞态窗口：ready 任务被级联跳过时
    /// 可能已被 dispatch 置 queued，若不取消会被后续 start_attempt 启动已跳过的任务）。
    fn cancel_queued_attempts_of_task(task: &AiTaskNode) {
        for attempt_id in &task.attempt_ids {
            if let Ok(mut attempt) = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试") {
                if attempt.state == "queued" {
                    attempt.state = "cancelled".to_string();
                    attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
                    attempt.updated_at = attempt.finished_at.clone().unwrap_or_default();
                    attempt.summary = Some("任务已标记忽略，排队中的执行记录取消".to_string());
                    let _ = Self::persist_attempt(&attempt);
                }
            }
        }
    }

    /// 跳过任务的 worktree/分支资源回收（尽力执行）：被跳过的任务不再续接执行，
    /// 提前清理避免合并永远不发生时资源累积。契约文件保留供历史查看。
    fn cleanup_skipped_task_worktree(task: &AiTaskNode) {
        let _ = (|| -> Result<(), String> {
            let delivery = Self::get_delivery(&task.delivery_id)?;
            let project = Self::get_project(&delivery.project_id)?;
            let Some(contract_id) = task.contract_id.as_deref() else {
                return Ok(());
            };
            let contract = Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "任务契约")?;
            let (Some(worktree), Some(branch)) =
                (contract.worktree_path.as_deref(), contract.branch_name.as_deref())
            else {
                return Ok(());
            };
            let repository = project
                .repositories
                .iter()
                .find(|repository| repository.id == contract.target_repository_id)
                .ok_or_else(|| "目标仓库不存在".to_string())?;
            let source = project_repository_path(&project, repository)?;
            cleanup_unallocated_task_worktree(&source, Path::new(worktree), branch);
            Ok(())
        })();
    }

    /// 确认 policyViolation 现场可接受：跳过静态越权审计重跑验收（skip_audit 防死循环），
    /// 按既有规则置 completed/failed/awaitingReview 并落事件。
    pub fn confirm_policy_violation_site(task_node_id: &str) -> Result<(), String> {
        let mut task = Self::get_task_node(task_node_id)?;
        if task.state != "policyViolation" {
            return Err(format!("任务状态 {} 不是 policyViolation", task.state));
        }
        let attempt_id = task
            .attempt_ids
            .last()
            .ok_or_else(|| "无 attempt 可复核".to_string())?;
        let mut attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?;
        if attempt.state != "policyViolation" {
            return Err(format!("执行尝试状态 {} 不是 policyViolation", attempt.state));
        }
        let contract =
            Self::get::<AiTaskContract>(CONTRACTS_DIR, &attempt.contract_id, "任务契约")?;
        let project = Self::get_project(&Self::get_delivery(&attempt.delivery_id)?.project_id)?;
        let workflow_managed = task.workflow_step_id.is_some();
        let mut workflow_review = None;
        attempt.state = "running".to_string();
        attempt.updated_at = chrono::Utc::now().to_rfc3339();
        Self::persist_attempt(&attempt)?;
        // 重跑验收（skip_audit=true：现场已人工确认，不再重复静态越权判定）
        let completion_error = Self::run_acceptance_validation(
            &task,
            &contract,
            &project,
            Some(0),
            &None,
            workflow_managed,
            None,
            &mut workflow_review,
        );
        let successful = completion_error.is_none();
        let reviewer_rejected = workflow_review
            .as_ref()
            .is_some_and(|review| !review.approved);
        let workflow_step_completed = successful && workflow_managed && !reviewer_rejected;
        attempt.state = if successful {
            "completed"
        } else {
            "failed"
        }
        .to_string();
        attempt.exit_code = Some(0);
        attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
        attempt.updated_at = attempt.finished_at.clone().unwrap_or_default();
        attempt.summary = Some(match completion_error.as_deref() {
            Some(error) => format!("现场确认后重跑验收失败：{}", error),
            None if let Some(review) = workflow_review.as_ref() => review.comments.clone(),
            None => "现场已确认，重跑验收通过".to_string(),
        });
        Self::persist_attempt(&attempt)?;
        // 验收通过时记录当前分支 HEAD 作为 validated_commit，合并前须再次确认一致
        if successful && task.execution_mode == "write" {
            if let Some(worktree) = contract.worktree_path.as_deref() {
                if let Ok(head) = run_git(
                    &PathBuf::from(worktree),
                    &["rev-parse".to_string(), "HEAD".to_string()],
                ) {
                    let mut updated_contract = contract.clone();
                    updated_contract.validated_commit = Some(head);
                    updated_contract.updated_at = chrono::Utc::now().to_rfc3339();
                    let _ = Self::save(CONTRACTS_DIR, &updated_contract.id, &updated_contract);
                }
            }
        }
        task.state = if reviewer_rejected {
            "planned"
        } else if workflow_step_completed {
            "succeeded"
        } else if successful {
            "awaitingReview"
        } else {
            "failed"
        }
        .to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        if reviewer_rejected {
            Self::return_review_dependencies_for_rework(
                &task,
                workflow_review
                    .as_ref()
                    .map(|review| review.comments.as_str())
                    .unwrap_or("Reviewer 要求返工"),
            )?;
        }
        if workflow_step_completed {
            let _ = Self::refresh_ready_task_nodes(&task.delivery_id)?;
        }
        let (event_type, message) = if successful {
            (
                "attemptCompleted",
                if workflow_managed {
                    "现场已确认，重跑验收通过，编排步骤完成".to_string()
                } else {
                    "现场已确认，重跑验收通过，等待审核".to_string()
                },
            )
        } else {
            (
                "attemptFailed",
                format!(
                    "现场确认后重跑验收失败：{}",
                    completion_error.unwrap_or_default()
                ),
            )
        };
        Self::append_event(
            &task.delivery_id,
            Some(&task.id),
            Some(&attempt.id),
            "policyViolationAccepted",
            &format!("任务 {} 现场已确认，重跑验收", task.title),
        )?;
        Self::append_event(
            &task.delivery_id,
            Some(&task.id),
            Some(&attempt.id),
            event_type,
            &message,
        )?;
        Ok(())
    }

    pub fn ensure_manual_completion_allowed(attempt_id: &str) -> Result<(), String> {
        let attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "manual completion check")?;
        let delivery = Self::get_delivery(&attempt.delivery_id)?;
        let task = Self::get_task_node(&attempt.task_node_id)?;
        // 无编排方案的交付允许手动确认完成；有编排方案时仅最后阶段允许
        if delivery.workflow_steps.is_empty() || is_last_workflow_stage(&delivery, &task) {
            Ok(())
        } else {
            Err("仅任务编排的最后一个阶段允许手动确认完成".to_string())
        }
    }

    pub fn complete_attempt(
        attempt_id: &str,
        app: tauri::AppHandle,
        terminal_service: TerminalService,
    ) -> Result<AiAttempt, String> {
        let attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?;
        if attempt.state != "running" {
            return Err(format!("当前执行尝试不能确认完成: {}", attempt.state));
        }
        let task = Self::get_task_node(&attempt.task_node_id)?;
        let output = attempt
            .terminal_id
            .as_deref()
            .and_then(|terminal_id| terminal_service.peek_terminal_output(terminal_id).ok())
            .unwrap_or_else(|| "用户确认 Agent 已完成执行".to_string());
        let workflow_review_path = requires_workflow_review(&task)
            .then(|| terminal_run_dir_by_id(&attempt.id).join("review.json"));
        Self::finish_attempt(
            &attempt.id,
            &attempt.delivery_id,
            &attempt.task_node_id,
            Some(0),
            &output,
            &output,
            workflow_review_path.as_deref(),
            app,
            terminal_service.clone(),
            false,
        )?;
        if let Some(terminal_id) = attempt.terminal_id.as_deref() {
            let _ = terminal_service.close_terminal(terminal_id);
        }
        Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")
    }

    #[allow(dead_code)]
    fn interrupt_attempt(
        attempt_id: &str,
        message: &str,
        _app: tauri::AppHandle,
    ) -> Result<(), String> {
        let mut attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?;
        if attempt.state != "running" {
            return Ok(());
        }
        let mut task = Self::get_task_node(&attempt.task_node_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        attempt.state = "cancelled".to_string();
        attempt.finished_at = Some(now.clone());
        attempt.updated_at = now.clone();
        attempt.summary = Some(message.to_string());
        task.state = "cancelled".to_string();
        task.updated_at = now;
        Self::persist_attempt(&attempt)?;
        Self::cleanup_attempt_run_dir(&attempt.id);
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        let _ = Self::append_event(
            &attempt.delivery_id,
            Some(&task.id),
            Some(&attempt.id),
            "attemptCancelled",
            message,
        )?;
        Ok(())
    }

    /// 启动本机终端前失败时，不能让任务永久停留在“已排队”。
    fn fail_queued_attempt(
        attempt_id: &str,
        reason: &str,
        _app: &tauri::AppHandle,
    ) -> Result<(), String> {
        let mut attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?;
        if attempt.state != "queued" {
            return Ok(());
        }
        let mut task = Self::get_task_node(&attempt.task_node_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        attempt.state = "failed".to_string();
        attempt.finished_at = Some(now.clone());
        attempt.updated_at = now.clone();
        attempt.summary = Some(format!("任务启动失败: {}", reason));
        task.state = "failed".to_string();
        task.updated_at = now;
        Self::persist_attempt(&attempt)?;
        Self::cleanup_attempt_run_dir(&attempt.id);
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        let _ = Self::append_event(
            &attempt.delivery_id,
            Some(&task.id),
            Some(&attempt.id),
            "attemptStartFailed",
            &format!("Agent 启动失败，任务可重新派发: {}", reason),
        )?;
        Ok(())
    }

    fn pause_attempt_for_decision(
        attempt_id: &str,
        delivery_id: &str,
        task_node_id: &str,
        decision: AgentDecisionFile,
        app: tauri::AppHandle,
    ) -> Result<(), String> {
        let mut attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?;
        if attempt.state != "running" {
            return Ok(());
        }
        let request = Self::create_decision_request(CreateAiDecisionRequestInput {
            delivery_id: delivery_id.to_string(),
            task_node_id: Some(task_node_id.to_string()),
            question: decision.question,
            impact: decision.impact,
            options: decision.options,
        })?;
       attempt.state = "needsInput".to_string();
       attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
       attempt.updated_at = attempt.finished_at.clone().unwrap_or_default();
       attempt.summary = Some(format!("已请求用户决策：{}", request.question));
       Self::persist_attempt(&attempt)?;
        // 同步将任务状态设为 needsInput，使 answer_decision_request 能正确识别并转回 ready。
        let mut task = Self::get_task_node(task_node_id)?;
        if task.state == "running" {
            task.state = "needsInput".to_string();
            task.updated_at = chrono::Utc::now().to_rfc3339();
            Self::save(TASK_NODES_DIR, &task.id, &task)?;
        }
       let _ = Self::append_event(
            delivery_id,
            Some(task_node_id),
            Some(attempt_id),
            "attemptAwaitingDecision",
            "Agent 已请求用户决策，任务已暂停。",
        )?;
        let _ = crate::commands::notification::show_ai_delivery_notification(
            app,
            "AI 交付等待决策",
            delivery_id.to_string(),
            request.question.clone(),
        );
        Ok(())
    }

    /// 验收执行：成果检查 + 验收命令（质量门禁）+ 工作流评审。
    /// 返回验收失败原因（None 表示通过）；workflow_review 为评审结论。
    /// 与 finish_attempt / confirm_policy_violation_site 共用。
    fn run_acceptance_validation(
        task: &AiTaskNode,
        contract: &AiTaskContract,
        project: &AiProject,
        exit_code: Option<i32>,
        policy_violation: &Option<String>,
        workflow_managed: bool,
        workflow_review_path: Option<&Path>,
        workflow_review: &mut Option<WorkflowReviewFile>,
    ) -> Option<String> {
        if exit_code != Some(0)
            || policy_violation.is_some()
            || (!workflow_managed && task.expected_artifacts.is_empty())
        {
            return None;
        }
        let worktree = PathBuf::from(&contract.working_directory);
        let validation = if task.execution_mode == "readonly" {
            ensure_readonly_execution_unchanged(project, contract, &worktree)
                .and_then(|_| ensure_expected_artifacts(contract, &worktree))
                .and_then(|_| {
                    if !requires_workflow_review(task) {
                        return Ok(());
                    }
                    let review_path = workflow_review_path
                        .ok_or_else(|| "评审步骤缺少 Reviewer 结论文件路径".to_string())?;
                    let review = read_workflow_review(review_path)?;
                    *workflow_review = Some(review);
                    Ok(())
                })
        } else {
            ensure_expected_artifacts(contract, &worktree)
                .and_then(|_| ensure_task_branch_clean(&worktree))
                .and_then(|_| {
                    for command in &contract.acceptance_commands {
                        let result = run_shell_command(&worktree, command)?;
                        if result.exit_code != 0 {
                            return Err(format!(
                                "验收命令执行失败：{}（退出码 {}）",
                                command, result.exit_code
                            ));
                        }
                    }
                    Ok(())
                })
        };
        match validation {
            Ok(()) => None,
            Err(error) => Some(error),
        }
    }

    fn finish_attempt(
        attempt_id: &str,
        delivery_id: &str,
        task_node_id: &str,
        exit_code: Option<i32>,
        stdout: &str,
        stderr: &str,
        workflow_review_path: Option<&Path>,
        app: tauri::AppHandle,
        terminal_service: TerminalService,
        skip_audit: bool,
    ) -> Result<(), String> {
        let mut attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?;
        if attempt.state != "running" {
            return Ok(());
        }
        let contract =
            Self::get::<AiTaskContract>(CONTRACTS_DIR, &attempt.contract_id, "任务契约")?;
        let project_id = Self::get_delivery(delivery_id)?.project_id;
        let project = Self::get_project(&project_id)?;
        // skip_audit：确认现场后重跑验收时跳过静态越权审计，防止现场未改导致死循环
        let policy_violation = if skip_audit {
            None
        } else {
            audit_contract_scope(&project, &contract)?
        };
        let mut task = Self::get_task_node(task_node_id)?;
        let workflow_managed = task.workflow_step_id.is_some();
        let mut workflow_review = None;
        let completion_error = Self::run_acceptance_validation(
            &task,
            &contract,
            &project,
            exit_code,
            &policy_violation,
            workflow_managed,
            workflow_review_path,
            &mut workflow_review,
        );
        let successful =
            exit_code == Some(0) && policy_violation.is_none() && completion_error.is_none();
        let reviewer_rejected = workflow_review
            .as_ref()
            .is_some_and(|review| !review.approved);
        let workflow_step_completed = successful && workflow_managed && !reviewer_rejected;
        attempt.state = if policy_violation.is_some() {
            "policyViolation"
        } else if successful {
            "completed"
        } else {
            "failed"
        }
        .to_string();
        attempt.exit_code = exit_code;
        attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
        attempt.updated_at = attempt.finished_at.clone().unwrap_or_default();
        attempt.summary = Some(match completion_error.as_deref() {
            Some(error) => format!("{}：{}", error, compact_output(stderr)),
            None if let Some(review) = workflow_review.as_ref() => review.comments.clone(),
            None => compact_output(if successful { stdout } else { stderr }),
        });
       Self::persist_attempt(&attempt)?;
        // attempt 达到终态（completed/failed/policyViolation）后清理运行目录；
        // 验收所用 review.json / transcript 已在 run_acceptance_validation 中消费完毕。
        Self::cleanup_attempt_run_dir(&attempt.id);
        // 验收通过时记录当前分支 HEAD 作为 validated_commit，合并前须再次确认一致
        if successful && task.execution_mode == "write" {
            if let Some(worktree) = contract.worktree_path.as_deref() {
                if let Ok(head) = run_git(
                    &PathBuf::from(worktree),
                    &["rev-parse".to_string(), "HEAD".to_string()],
                ) {
                    let mut updated_contract = contract.clone();
                    updated_contract.validated_commit = Some(head);
                    updated_contract.updated_at = chrono::Utc::now().to_rfc3339();
                    let _ = Self::save(CONTRACTS_DIR, &updated_contract.id, &updated_contract);
                }
            }
        }
        task.state = if policy_violation.is_some() {
            "policyViolation"
        } else if reviewer_rejected {
            "planned"
        } else if workflow_step_completed {
            "succeeded"
        } else if successful {
            "awaitingReview"
        } else {
            "failed"
        }
        .to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        if reviewer_rejected {
            Self::return_review_dependencies_for_rework(
                &task,
                workflow_review
                    .as_ref()
                    .map(|review| review.comments.as_str())
                    .unwrap_or("Reviewer 要求返工"),
            )?;
        }
        let (event_type, message) = if let Some(violation) = policy_violation {
            ("policyViolation", violation)
        } else if let Some(error) = completion_error {
            ("attemptFailed", error)
        } else if reviewer_rejected {
            (
                "reviewRework",
                workflow_review
                    .as_ref()
                    .map(|review| review.comments.clone())
                    .unwrap_or_else(|| "Reviewer 要求返工".to_string()),
            )
        } else if workflow_step_completed {
            (
                "workflowStepCompleted",
                "编排步骤执行完成，后续步骤可以继续调度".to_string(),
            )
        } else if successful {
            ("attemptCompleted", "Agent 执行结束，等待审核".to_string())
        } else {
            ("attemptFailed", "Agent 执行失败".to_string())
        };
        let _ = Self::append_event(
            delivery_id,
            Some(task_node_id),
            Some(attempt_id),
            event_type,
            &message,
        )?;
        // 任务失败/违规时推送微信/飞书（含任务标题与失败摘要）
        if matches!(event_type, "attemptFailed" | "policyViolation") {
            Self::push_delivery_notice(
                delivery_id,
                "任务失败",
                &format!("任务「{}」{}：{}", task.title, event_type, message),
                None,
            );
        }
        if workflow_step_completed {
            let _ = Self::refresh_ready_task_nodes(delivery_id)?;
            if Self::get_delivery(delivery_id)?.state == "running" {
                for next_attempt in Self::dispatch_ready_tasks(delivery_id)? {
                    if let Err(error) =
                        Self::start_attempt(&next_attempt.id, app.clone(), terminal_service.clone())
                    {
                        let _ = Self::append_event(
                            delivery_id,
                            Some(&next_attempt.task_node_id),
                            Some(&next_attempt.id),
                            "dispatchFailed",
                            &format!("后续编排任务启动失败: {}", error),
                        )?;
                   }
               }
           }
       }
        // 所有编排步骤完成后自动收尾交付：先合并到目标分支，合并成功后再宣告交付成功，
        // 避免合并失败时出现误导性的「交付成功」事件与通知（merge 失败路径已置 mergeFailed 终态）。
        if workflow_step_completed {
            let tasks = Self::get_task_nodes(delivery_id)?;
            if !tasks.is_empty()
                && tasks.iter().all(|t| matches!(t.state.as_str(), "succeeded" | "skipped"))
            {
                let delivery = Self::get_delivery(delivery_id)?;
                if delivery.state == "running" {
                    let merge_delivery_id = delivery.id.clone();
                    match Self::merge_delivery_locally(&merge_delivery_id) {
                        Ok(_) => {
                            let _ = Self::append_event(
                                delivery_id,
                                None,
                                None,
                                "autoMerged",
                                "交付已自动合并到本地目标分支",
                            );
                            // 合并成功后才宣告交付成功
                            let _ = Self::append_event(
                                delivery_id,
                                None,
                                None,
                                "deliverySucceeded",
                                "全部任务已完成，交付成功",
                            )?;
                            Self::push_delivery_notice(
                                delivery_id,
                                "交付成功",
                                &format!("交付「{}」全部任务已完成，交付成功", delivery.title),
                                None,
                            );
                            // 系统托盘通知：交付整体收尾
                            if let Some(app) = APP_HANDLE.get() {
                                let _ = crate::commands::notification::show_ai_delivery_notification(
                                    app.clone(),
                                    "AI 交付完成",
                                    delivery_id.to_string(),
                                    format!("交付「{}」全部任务已完成，交付成功", delivery.title),
                                );
                            }
                        }
                        Err(error) => {
                            let _ = Self::append_event(
                                delivery_id,
                                None,
                                None,
                                "autoMergeFailed",
                                &format!("自动合并失败（可在界面手动重试）: {}", error),
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn return_review_dependencies_for_rework(
        reviewer_task: &AiTaskNode,
        reviewer_comments: &str,
    ) -> Result<(), String> {
        let mut returned = 0;
        for dependency_id in &reviewer_task.dependency_ids {
            let mut dependency = Self::get_task_node(dependency_id)?;
            // 允许 readonly 和 write 模式的已完成任务返工。
            // 之前仅允许 write 模式，导致 readonly 分析任务无法被标记返工，
            // 审查拒绝后系统陷入循环。
            if dependency.state != "succeeded" {
                continue;
            }
            dependency.state = "rework".to_string();
            dependency.retry_count = dependency
                .retry_count
                .max(dependency.attempt_ids.len() as u32);
            dependency.updated_at = chrono::Utc::now().to_rfc3339();
            Self::save(TASK_NODES_DIR, &dependency.id, &dependency)?;
            Self::append_event(
                &dependency.delivery_id,
                Some(&dependency.id),
                None,
                "taskReworkRequested",
                &format!("Reviewer 要求返工: {}", reviewer_comments),
            )?;
            returned += 1;
        }
        if returned == 0 {
            return Err("Reviewer 退回返工时未找到可返工的前置写入任务".to_string());
        }
        Ok(())
    }

    fn select_agent(
        task: &AiTaskNode,
        requested_agent_id: Option<&str>,
        project: &AiProject,
        repository: &AiRepository,
    ) -> Result<AiAgent, String> {
        let agents = Self::get_all_agents()?;
        if let Some(agent_id) = requested_agent_id {
            let agent = agents
                .into_iter()
                .find(|agent| agent.id == agent_id)
                .ok_or_else(|| "指定 Agent 不存在".to_string())?;
            if !agent.enabled {
                return Err("指定 Agent 已禁用".to_string());
            }
            if let Err(error) = Self::check_capacity(project, repository, &agent, task) {
                // 指定 Agent 无容量：任务保持 ready（dispatch_task_node 置 queued 前即返回），
                // 由既有轮询/手动派发兜底
                let _ = Self::append_event(
                    &task.delivery_id,
                    Some(&task.id),
                    None,
                    "dispatchDeferred",
                    &format!("指定 Agent 当前无容量，任务保持待执行: {}", error),
                );
                return Err(error);
            }
            return Ok(agent);
        }
        let role_id = task
            .role_id
            .as_deref()
            .ok_or_else(|| "任务未指定角色，无法自动选择 Agent".to_string())?;
        let role = Self::get::<AiRole>(ROLES_DIR, role_id, "角色")?;
        let candidate_ids = if let Some(ref locked_id) = role.locked_agent_id {
            let locked_runtime_available = agents
                .iter()
                .find(|a| a.id == *locked_id && a.enabled)
                .and_then(|agent| {
                    Self::get::<AiAgentRuntime>(RUNTIMES_DIR, &agent.runtime_id, "Runtime").ok()
                })
                .map(|rt| probe_local_runtime(&rt.kind, &rt.command).available)
                .unwrap_or(false);
            if locked_runtime_available {
                vec![locked_id.clone()]
            } else if !role.candidate_agent_ids.is_empty() {
                role.candidate_agent_ids.clone()
            } else {
                vec![locked_id.clone()]
            }
        } else {
            role.candidate_agent_ids.clone()
        };
        if candidate_ids.is_empty() {
            return Err("角色未配置候选 Agent".to_string());
        }
        let mut candidates = agents
            .into_iter()
            .filter(|agent| agent.enabled && candidate_ids.iter().any(|id| id == &agent.id))
            .collect::<Vec<_>>();
        candidates.sort_by_key(|agent| {
            Self::active_attempt_count_for_agent(&agent.id).unwrap_or(usize::MAX)
        });
        // 逐个试候选：跳过容量不足者继续补派；写入范围冲突是硬冲突（重试无解），单独保留
        let mut conflict_error = None;
        let mut capacity_blocked_count = 0usize;
        for agent in candidates {
            match Self::check_capacity(project, repository, &agent, task) {
                Ok(()) => return Ok(agent),
                Err(error) => {
                    if error.contains("重叠写入范围") {
                        conflict_error = Some(error);
                    } else {
                        capacity_blocked_count += 1;
                    }
                }
            }
        }
        if capacity_blocked_count > 0 && conflict_error.is_none() {
            // 全部候选无容量：专用错误 + 事件（任务保持 ready，依赖既有轮询自动补派）
            let _ = Self::append_event(
                &task.delivery_id,
                Some(&task.id),
                None,
                "dispatchDeferred",
                "全部候选 Agent 无容量，稍后自动重试",
            );
            return Err("全部候选 Agent 无容量，稍后自动重试".to_string());
        }
        Err(conflict_error.unwrap_or_else(|| {
            "角色候选 Agent 当前均无可用容量或存在写入范围冲突".to_string()
        }))
    }

    fn active_attempt_count_for_agent(agent_id: &str) -> Result<usize, String> {
        Ok(Self::active_attempts_snapshot()?
            .into_iter()
            .filter(|attempt| attempt.agent_id == agent_id)
            .count())
    }

    /// 活跃 attempt 内存索引（N18）：attempt 置 queued/starting/running 时 insert，
    /// 置任何非活跃态（含 needsInput/cancelled/failed/completed/interrupted）时 remove。
    /// 由 persist_attempt 统一维护；lib.rs setup 启动时 rebuild 一次。
    fn active_attempts_index() -> &'static Mutex<HashMap<String, AiAttempt>> {
        static INDEX: OnceLock<Mutex<HashMap<String, AiAttempt>>> = OnceLock::new();
        INDEX.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// 保存 attempt 并同步活跃索引（所有 attempt 持久化的统一收口点）。
    fn persist_attempt(attempt: &AiAttempt) -> Result<(), String> {
        if let Ok(mut index) = Self::active_attempts_index().lock() {
            if matches!(attempt.state.as_str(), "queued" | "starting" | "running") {
                index.insert(attempt.id.clone(), attempt.clone());
            } else {
                index.remove(&attempt.id);
            }
        }
        Self::save(ATTEMPTS_DIR, &attempt.id, attempt)
    }

    /// 启动时重建活跃索引一次（lib.rs setup 调用）。返回活跃 attempt 数。
    pub fn rebuild_active_attempt_index() -> Result<usize, String> {
        let attempts = Self::get_all_attempts(None)?;
        let mut index = HashMap::new();
        for attempt in attempts {
            if matches!(attempt.state.as_str(), "queued" | "starting" | "running") {
                index.insert(attempt.id.clone(), attempt);
            }
        }
        let count = index.len();
        *Self::active_attempts_index()
            .lock()
            .map_err(|_| "活跃索引锁异常".to_string())? = index;
        Ok(count)
    }

    /// 活跃 attempt 快照（读内存索引；索引为空时回退全量扫描，保证启动早期正确性）。
    /// 测试模式下始终回退全量扫描：测试数据目录是 thread_local 而索引是全局静态，
    /// 并行测试共享索引会交叉污染；且测试直接用 `save` 置终态会绕过索引维护。
    /// 索引项按 state 防御性过滤：直接 `save` 绕过的场景（如测试置 completed）不会残留误计。
    fn active_attempts_snapshot() -> Result<Vec<AiAttempt>, String> {
        #[cfg(test)]
        {
            return Ok(Self::get_all_attempts(None)?
                .into_iter()
                .filter(|attempt| {
                    matches!(attempt.state.as_str(), "queued" | "starting" | "running")
                })
                .collect());
        }
        #[cfg(not(test))]
        {
            let guard = Self::active_attempts_index()
                .lock()
                .map_err(|_| "活跃索引锁异常".to_string())?;
            if guard.is_empty() {
                drop(guard);
                return Ok(Self::get_all_attempts(None)?
                    .into_iter()
                    .filter(|attempt| {
                        matches!(attempt.state.as_str(), "queued" | "starting" | "running")
                    })
                    .collect());
            }
            Ok(guard
                .values()
                .filter(|attempt| {
                    matches!(attempt.state.as_str(), "queued" | "starting" | "running")
                })
                .cloned()
                .collect())
        }
    }

    /// 全局活跃 attempt 数（queued/starting/running，三态口径与既有 7 处过滤一致）。
    fn global_active_attempts() -> Result<usize, String> {
        Ok(Self::active_attempts_snapshot()?.len())
    }

    /// 派发优先级：workflow 首步 + taskWorktree 的写入任务优先；其余（含 readonly/workspaceRoot）延后。
    fn dispatch_priority(task: &AiTaskNode, delivery: &AiDelivery) -> u8 {
        let is_workflow_first = task
            .workflow_step_id
            .as_deref()
            .zip(delivery.workflow_steps.first())
            .map(|(step_id, first)| step_id == first.id)
            .unwrap_or(false);
        let is_high =
            task.execution_context == EXECUTION_CONTEXT_TASK_WORKTREE && is_workflow_first;
        if is_high {
            0
        } else {
            1
        }
    }

    fn check_capacity(
        project: &AiProject,
        repository: &AiRepository,
        agent: &AiAgent,
        task: &AiTaskNode,
    ) -> Result<(), String> {
        let active = Self::active_attempts_snapshot()?;
        let project_active = active
            .iter()
            .filter(|attempt| {
                attempt.delivery_id != ""
                    && Self::get_delivery(&attempt.delivery_id)
                        .map(|delivery| delivery.project_id == project.id)
                        .unwrap_or(false)
            })
            .count();
        if project_active >= project.max_concurrency as usize {
            return Err("项目并发配额已满".to_string());
        }
        if active
            .iter()
            .filter(|attempt| attempt.agent_id == agent.id)
            .count()
            >= agent.max_concurrency as usize
        {
            return Err("Agent 并发配额已满".to_string());
        }
        let repository_active = active
            .iter()
            .filter(|attempt| {
                Self::get::<AiTaskContract>(CONTRACTS_DIR, &attempt.contract_id, "任务契约")
                    .map(|contract| contract.target_repository_id == repository.id)
                    .unwrap_or(false)
            })
            .count();
        if repository_active >= repository.write_concurrency as usize {
            return Err("仓库写入并发配额已满".to_string());
        }
        for attempt in &active {
            let Ok(contract) =
                Self::get::<AiTaskContract>(CONTRACTS_DIR, &attempt.contract_id, "任务契约")
            else {
                continue;
            };
            if contract.target_repository_id != repository.id {
                continue;
            }
            if write_paths_overlap(&task.allowed_write_paths, &contract.allowed_write_paths) {
                return Err("同一仓库存在重叠写入范围的运行任务".to_string());
            }
        }
        Ok(())
    }

    /// 检查交付是否所有任务均已完成，是则自动标记成功并合并。
    /// 用于恢复暂停后或审核通过后等 finish_attempt 未覆盖的场景。
    pub fn try_complete_workflow_delivery(delivery_id: &str) -> Result<bool, String> {
        let tasks = Self::get_task_nodes(delivery_id)?;
        if tasks.is_empty()
            || !tasks.iter().all(|t| matches!(t.state.as_str(), "succeeded" | "skipped"))
        {
            return Ok(false);
        }
        let delivery = Self::get_delivery(delivery_id)?;
        if delivery.state != "running" {
            return Ok(false);
        }
        // 先合并到目标分支，合并成功后再宣告交付成功（merge 成功路径内部置交付为 completed 终态，
        // 失败路径置 mergeFailed 终态），避免合并失败时出现误导性的「交付成功」事件与通知。
        match Self::merge_delivery_locally(&delivery.id) {
            Ok(_) => {
                let _ = Self::append_event(
                    delivery_id,
                    None,
                    None,
                    "autoMerged",
                    "交付已自动合并到本地目标分支",
                );
                Self::append_event(
                    delivery_id,
                    None,
                    None,
                    "deliverySucceeded",
                    "全部任务已完成，交付成功",
                )?;
                // 推送交付成功到微信/飞书
                Self::push_delivery_notice(
                    delivery_id,
                    "交付成功",
                    &format!("交付「{}」全部任务已完成，交付成功", delivery.title),
                    None,
                );
            }
            Err(error) => {
                let _ = Self::append_event(
                    delivery_id,
                    None,
                    None,
                    "autoMergeFailed",
                    &format!("自动合并失败（可在界面手动重试）: {}", error),
                );
            }
        }
        Ok(true)
    }

    /// 滚动清理指定交付的事件文件：先按条数上限删最旧，再按体积上限删最旧。
    /// 只删除事件文件，绝不触碰 attempt 运行目录——运行目录按 attempt 终态
    /// （cancel_attempt / finish_attempt 等）单独清理，避免误删运行中 Agent 的控制文件。
    fn prune_delivery_events(delivery_id: &str) {
        let Ok(events) = Self::get_delivery_events(delivery_id) else {
            return;
        };
        let file_size = |event_id: &str| -> u64 {
            let path = Self::entity_dir(EVENTS_DIR).join(safe_path_segment(event_id));
            fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0)
        };
        let mut size: u64 = events.iter().map(|event| file_size(&event.id)).sum();
        let mut index = 0;
        while index < events.len()
            && (events.len() - index > MAX_EVENTS_PER_DELIVERY || size > MAX_EVENTS_DIR_SIZE)
        {
            let event = &events[index];
            size = size.saturating_sub(file_size(&event.id));
            let _ = Self::delete(EVENTS_DIR, &event.id, "交付事件");
            index += 1;
        }
    }

    /// attempt 达到终态（cancelled/failed/completed/policyViolation）时清理其终端运行目录。
    /// 与事件 prune 解耦：prune 只删事件文件；运行目录只在 attempt 终态后删除，
    /// 避免 attempt 记录仍在、卡片仍展示时「查看成果」读到被误删的目录。
    /// （取消交付等「保留供人工检查」的路径不调用本函数。）
    fn cleanup_attempt_run_dir(attempt_id: &str) {
        let _ = fs::remove_dir_all(terminal_run_dir_by_id(attempt_id));
    }

    pub fn append_event(
        delivery_id: &str,
        task_node_id: Option<&str>,
        attempt_id: Option<&str>,
        event_type: &str,
        message: &str,
    ) -> Result<AiDeliveryEvent, String> {
        let event = AiDeliveryEvent {
            id: Uuid::new_v4().to_string(),
            delivery_id: delivery_id.to_string(),
            task_node_id: task_node_id.map(str::to_string),
            attempt_id: attempt_id.map(str::to_string),
            event_type: event_type.to_string(),
            message: message.to_string(),
            occurred_at: chrono::Utc::now().to_rfc3339(),
        };
        Self::save(EVENTS_DIR, &event.id, &event)?;
        // 统一实时推送：所有 append_event 写入的事件自动送达前端，调用点不再各自 emit
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("ai-delivery-event", &event);
        }
        // 滚动清理：每 50 次写入 prune 一次（prune 全量扫描 EVENTS_DIR，降频避免每次 O(N)）
        static EVENT_APPEND_COUNTER: AtomicUsize = AtomicUsize::new(0);
        if EVENT_APPEND_COUNTER.fetch_add(1, Ordering::Relaxed) % 50 == 49 {
            Self::prune_delivery_events(delivery_id);
        }
        Ok(event)
    }

    // ---------- AI 交付事件推送（微信/飞书） ----------

    /// 外部消息 ID → AI 交付决策 ID 映射（推送决策请求时登记，聊天引用回复时解析）。
    /// 进程内映射即可：决策请求推送后通常立即被引用回复回答。
    fn delivery_decision_bindings() -> &'static Mutex<HashMap<String, String>> {
        static BINDINGS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        BINDINGS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// 登记「外部消息 ID → 决策 ID」，供聊天引用回复驱动 answer_decision_request。
    pub fn register_delivery_decision_binding(external_message_id: &str, decision_id: &str) {
        Self::delivery_decision_bindings()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(external_message_id.to_string(), decision_id.to_string());
    }

    /// 解析引用回复指向的 AI 交付决策 ID。
    pub fn resolve_delivery_decision_binding(external_message_id: &str) -> Option<String> {
        Self::delivery_decision_bindings()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(external_message_id)
            .cloned()
    }

    /// 从回复文本提取兜底标识「决策ID: <id>」（映射丢失时用户手动复制）。
    pub fn extract_delivery_decision_id(text: &str) -> Option<String> {
        const MARKER: &str = "决策ID:";
        let index = text.rfind(MARKER)?;
        text[index + MARKER.len()..]
            .split_whitespace()
            .next()
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    fn delivery_push_client() -> reqwest::Client {
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        CLIENT
            .get_or_init(|| {
                reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(20))
                    .build()
                    .unwrap_or_else(|_| reqwest::Client::new())
            })
            .clone()
    }

    /// 推送 AI 交付事件到标记了「AI 交付推送」的微信/飞书通道。
    /// 尽力而为：任何失败仅记日志，不阻断交付流程（调用点全部为同步函数，故异步发送用 spawn 包装）。
    pub fn push_delivery_notice(
        delivery_id: &str,
        event_type: &str,
        message: &str,
        decision_id: Option<&str>,
    ) {
        let Ok(bot_settings) = BotSettingsService::get_runtime() else {
            return;
        };
        let channels = bot_settings
            .channels
            .iter()
            .filter(|channel| channel.enabled && channel.ai_delivery_enabled)
            .cloned()
            .collect::<Vec<_>>();
        if channels.is_empty() {
            return;
        }
        let text = match decision_id {
            Some(id) => format!("[AI 交付] {}\n{}\n\n决策ID: {}", event_type, message, id),
            None => format!("[AI 交付] {}\n{}", event_type, message),
        };
        for channel in channels {
            let text = text.clone();
            let decision_id = decision_id.map(str::to_string);
            let delivery_id = delivery_id.to_string();
            match channel.platform.as_str() {
                "weixin" => {
                    // 预生成 message_id 并登记引用映射（决策类推送支持引用回复回答）
                    let message_id =
                        crate::services::bot_weixin_service::new_weixin_message_id();
                    if let Some(decision_id) = decision_id.as_deref() {
                        Self::register_delivery_decision_binding(&message_id, decision_id);
                    }
                    let text = crate::services::bot_weixin_service::append_weixin_reply_marker(
                        &text,
                        &message_id,
                    );
                    tauri::async_runtime::spawn(async move {
                        let client = Self::delivery_push_client();
                        if let Err(error) = crate::services::bot_weixin_service::
                            send_weixin_text_with_id(
                                &client,
                                &channel,
                                &channel.target_id,
                                &text,
                                &message_id,
                            )
                            .await
                        {
                            eprintln!(
                                "[AI交付] 微信推送失败 (delivery {}): {}",
                                delivery_id, error
                            );
                        }
                    });
                }
                "feishu" => {
                    tauri::async_runtime::spawn(async move {
                        match crate::commands::bot::send_feishu_text(&channel, &text).await {
                            Ok(message_id) => {
                                if let Some(decision_id) = decision_id.as_deref() {
                                    Self::register_delivery_decision_binding(
                                        &message_id,
                                        decision_id,
                                    );
                                }
                            }
                            Err(error) => eprintln!(
                                "[AI交付] 飞书推送失败 (delivery {}): {}",
                                delivery_id, error
                            ),
                        }
                    });
                }
                _ => {}
            }
        }
    }

    // ---------- 交付模板 ----------

    pub fn list_ai_delivery_templates() -> Result<Vec<AiDeliveryTemplate>, String> {
        let mut templates = Self::list(TEMPLATES_DIR)?;
        templates.sort_by(|left: &AiDeliveryTemplate, right: &AiDeliveryTemplate| {
            right.updated_at.cmp(&left.updated_at)
        });
        Ok(templates)
    }

    pub fn create_ai_delivery_template(
        input: CreateAiDeliveryTemplateInput,
    ) -> Result<AiDeliveryTemplate, String> {
        if input.name.trim().is_empty() {
            return Err("模板名称不能为空".to_string());
        }
        let now = chrono::Utc::now().to_rfc3339();
        let template = AiDeliveryTemplate {
            id: Uuid::new_v4().to_string(),
            name: input.name.trim().to_string(),
            description: input.description.trim().to_string(),
            workflow_id: input.workflow_id,
            quality_gate: input.quality_gate,
            role_mappings: input.role_mappings,
            common_prompt: input.common_prompt,
            created_at: now.clone(),
            updated_at: now,
        };
        Self::save(TEMPLATES_DIR, &template.id, &template)?;
        Ok(template)
    }

    pub fn update_ai_delivery_template(
        input: UpdateAiDeliveryTemplateInput,
    ) -> Result<AiDeliveryTemplate, String> {
        if input.name.trim().is_empty() {
            return Err("模板名称不能为空".to_string());
        }
        let mut template =
            Self::get::<AiDeliveryTemplate>(TEMPLATES_DIR, &input.id, "交付模板")?;
        template.name = input.name.trim().to_string();
        template.description = input.description.trim().to_string();
        template.workflow_id = input.workflow_id;
        template.quality_gate = input.quality_gate;
        template.role_mappings = input.role_mappings;
        template.common_prompt = input.common_prompt;
        template.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TEMPLATES_DIR, &template.id, &template)?;
        Ok(template)
    }

    pub fn delete_ai_delivery_template(id: &str) -> Result<(), String> {
        Self::delete(TEMPLATES_DIR, id, "交付模板")
    }

    /// 占位符替换：返回 (requirement, common_prompt)——`{featureName}`/`{moduleName}`。
    pub fn expand_template(
        template: &AiDeliveryTemplate,
        feature: &str,
        module: &str,
    ) -> (String, String) {
        let requirement = template
            .description
            .replace("{featureName}", feature)
            .replace("{moduleName}", module);
        let prompt = template
            .common_prompt
            .replace("{featureName}", feature)
            .replace("{moduleName}", module);
        (requirement, prompt)
    }

    /// 从已完成交付提取模板：workflowId + 需求文本；质量门禁来自项目配置。
    pub fn save_delivery_as_template(
        delivery_id: &str,
        name: &str,
    ) -> Result<AiDeliveryTemplate, String> {
        let delivery = Self::get_delivery(delivery_id)?;
        let project = Self::get_project(&delivery.project_id)?;
        let quality_gate = serde_json::to_string(&project.quality_gate).ok();
        Self::create_ai_delivery_template(CreateAiDeliveryTemplateInput {
            name: name.trim().to_string(),
            description: delivery.requirement.clone(),
            workflow_id: delivery.workflow_id.clone().unwrap_or_default(),
            quality_gate,
            role_mappings: Vec::new(),
            common_prompt: delivery.requirement.clone(),
        })
    }

    pub fn create_task_contract(input: CreateTaskContractInput) -> Result<AiTaskContract, String> {
        validate_task_input(&input)?;
        let project = Self::get_project(&input.project_id)?;
        let repository = project
            .repositories
            .iter()
            .find(|repository| repository.id == input.target_repository_id)
            .ok_or_else(|| "目标仓库不属于该项目".to_string())?;
        if !repository.write_enabled {
            return Err("目标仓库已禁止写入任务".to_string());
        }
        let execution_context =
            resolve_execution_context("write", &input.execution_context).or_else(|_| {
                resolve_execution_context("readonly", &input.execution_context)
            })?;
        let now = chrono::Utc::now().to_rfc3339();
        let contract_id = Uuid::new_v4().to_string();
        let working_directory = if execution_context == EXECUTION_CONTEXT_WORKSPACE_ROOT {
            PathBuf::from(&project.workspace_root)
        } else {
            repository_worktree_base_path(&project, repository)?
                .join(compact_path_id(&input.delivery_id))
                .join(compact_path_id(&input.task_id))
        };
        let contract = AiTaskContract {
            id: contract_id,
            project_id: input.project_id,
            delivery_id: input.delivery_id,
            task_id: input.task_id,
            title: input.title.trim().to_string(),
            target_repository_id: repository.id.clone(),
            target_repository_name: repository.name.clone(),
            allowed_write_paths: input.allowed_write_paths,
            execution_context,
            forbidden_repository_ids: project
                .repositories
                .iter()
                .filter(|item| item.id != repository.id)
                .map(|item| item.id.clone())
                .collect(),
            repository_status_baselines: project
                .repositories
                .iter()
                .map(|item| {
                    let path = project_repository_path(&project, item)?;
                    Ok(AiRepositoryStatusBaseline {
                        repository_id: item.id.clone(),
                        status: repository_status(&path)?,
                        head_commit: Some(run_git(
                            &path,
                            &["rev-parse".to_string(), "HEAD".to_string()],
                        )?),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?,
            input_artifacts: input.input_artifacts,
            input_artifact_directory: None,
            output_artifact_directory: None,
            expected_artifacts: input.expected_artifacts,
            acceptance_commands: input.acceptance_commands,
            retry_count: input.retry_count,
            state: "planned".to_string(),
            working_directory: working_directory.to_string_lossy().to_string(),
            branch_name: None,
            worktree_path: None,
            base_commit: None,
            validated_commit: None,
            dirty: false,
            created_at: now.clone(),
            updated_at: now,
        };
        Self::save(CONTRACTS_DIR, &contract.id, &contract)?;
        Ok(contract)
    }

    pub fn allocate_task_worktree(id: &str) -> Result<AiTaskContract, String> {
        let mut contract = Self::get::<AiTaskContract>(CONTRACTS_DIR, id, "任务契约")?;
        if let Some(path) = contract.worktree_path.as_ref() {
            return Err(format!("任务已分配 worktree: {}", path));
        }
        if contract.state != "planned" {
            return Err(format!("当前任务状态不能创建 worktree: {}", contract.state));
        }
        let project = Self::get_project(&contract.project_id)?;
        let repository = project
            .repositories
            .iter()
            .find(|repository| repository.id == contract.target_repository_id)
            .ok_or_else(|| "任务目标仓库已从项目中移除".to_string())?;
        let source_path = project_repository_path(&project, repository)?;
        ensure_clean_repository(&source_path)?;
        if project.worktree_root.is_none() {
            ensure_worktree_directory_is_ignored(&source_path)?;
        }
        let task = Self::get_task_node(&contract.task_id)?;
        if contract.execution_context == EXECUTION_CONTEXT_WORKSPACE_ROOT {
            let workspace_root = PathBuf::from(&project.workspace_root);
            if !workspace_root.is_dir() {
                return Err(format!("项目工作区根目录不可用: {}", workspace_root.display()));
            }
            contract.working_directory = workspace_root.to_string_lossy().to_string();
            contract.input_artifact_directory = materialize_dependency_artifacts(&project, &task, &contract)?;
            contract.output_artifact_directory = prepare_output_artifact_directory(&project, &task, &contract)?;
            contract.state = "allocated".to_string();
            contract.updated_at = chrono::Utc::now().to_rfc3339();
            Self::save(CONTRACTS_DIR, &contract.id, &contract)?;
            return Ok(contract);
        }
        let mut dependency_branches = Vec::new();
        for dependency_id in &task.dependency_ids {
            let dependency = Self::get_task_node(dependency_id)?;
            if dependency.target_repository_id != repository.id {
                continue;
            }
            if dependency.state != "succeeded" {
                return Err(format!("同仓库前置任务尚未审核通过: {}", dependency.title));
            }
            let dependency_contract_id = dependency
                .contract_id
                .as_deref()
                .ok_or_else(|| format!("前置任务缺少任务契约: {}", dependency.title))?;
            let dependency_contract =
                Self::get::<AiTaskContract>(CONTRACTS_DIR, dependency_contract_id, "前置任务契约")?;
            // 只读步骤在项目工作区执行，成果经外部目录交接，不会也不应创建 Git 分支。
            let Some(branch) = dependency_contract.branch_name else {
                if dependency.execution_mode == "readonly"
                    || dependency_contract.execution_context == EXECUTION_CONTEXT_WORKSPACE_ROOT
                {
                    continue;
                }
                return Err(format!("前置任务分支不存在: {}", dependency.title));
            };
            if !dependency_branches.contains(&branch) {
                dependency_branches.push(branch);
            }
        }

        let base_path = repository_worktree_base_path(&project, repository)?;
        let expected_worktree_path = base_path
            .join(compact_path_id(&contract.delivery_id))
            .join(compact_path_id(&contract.task_id));
        let configured_worktree_path = PathBuf::from(&contract.working_directory);
        if configured_worktree_path != expected_worktree_path {
            if configured_worktree_path.exists() {
                return Err(format!(
                    "任务 worktree 目录不符合当前目标仓库约定且已存在: {}",
                    configured_worktree_path.display()
                ));
            }
            contract.working_directory = expected_worktree_path.to_string_lossy().to_string();
        }
        let worktree_path = expected_worktree_path;
        if worktree_path.exists() {
            return Err(format!(
                "任务 worktree 目录已存在: {}",
                worktree_path.display()
            ));
        }
        let task_root = worktree_path
            .parent()
            .ok_or_else(|| "任务 worktree 目录无效".to_string())?;
        fs::create_dir_all(task_root)
            .map_err(|error| format!("创建任务 worktree 目录失败: {}", error))?;
        let branch_name = format!(
            "terminalbuddy/{}/{}",
            safe_ref_segment(&contract.delivery_id),
            safe_ref_segment(&contract.task_id),
        );
        let arguments = vec![
            "worktree".to_string(),
            "add".to_string(),
            "-b".to_string(),
            branch_name.clone(),
            worktree_path.to_string_lossy().to_string(),
            repository.default_branch.clone(),
        ];
        if let Err(error) = run_git(&source_path, &arguments) {
            // worktree add 失败时尽力回滚：同名分支/目录可能残留（上次中断），
            // 不清理会导致「任务 worktree 目录已存在」/「分支已存在」使重试永久阻塞。
            let _ = run_git(
                &source_path,
                &[
                    "worktree".to_string(),
                    "remove".to_string(),
                    "--force".to_string(),
                    worktree_path.to_string_lossy().to_string(),
                ],
            );
            let _ = run_git(
                &source_path,
                &["branch".to_string(), "-D".to_string(), branch_name.clone()],
            );
            return Err(error);
        }
        for dependency_branch in dependency_branches {
            if let Err(error) = run_git(
                &worktree_path,
                &vec![
                    "-c".to_string(),
                    "user.name=TerminalBuddy".to_string(),
                    "-c".to_string(),
                    "user.email=terminalbuddy@local".to_string(),
                    "merge".to_string(),
                    "--no-ff".to_string(),
                    "--no-edit".to_string(),
                    dependency_branch.clone(),
                ],
            ) {
                let _ = run_git(
                    &source_path,
                    &vec![
                        "worktree".to_string(),
                        "remove".to_string(),
                        "--force".to_string(),
                        worktree_path.to_string_lossy().to_string(),
                    ],
                );
                let _ = run_git(
                    &source_path,
                    &vec!["branch".to_string(), "-D".to_string(), branch_name.clone()],
                );
                return Err(format!(
                    "无法将前置任务分支合入下游 worktree（{}）: {}",
                    dependency_branch, error
                ));
            }
        }
        contract.input_artifact_directory =
            match materialize_dependency_artifacts(&project, &task, &contract) {
                Ok(directory) => directory,
                Err(error) => {
                    cleanup_unallocated_task_worktree(&source_path, &worktree_path, &branch_name);
                    let handoff_root = project_artifact_base_path(&project)
                        .join("handoff")
                        .join(compact_path_id(&contract.delivery_id))
                        .join(compact_path_id(&contract.task_id));
                    let _ = fs::remove_dir_all(&handoff_root);
                    return Err(error);
                }
            };
        contract.output_artifact_directory = match prepare_output_artifact_directory(&project, &task, &contract) {
            Ok(directory) => directory,
            Err(error) => {
                cleanup_unallocated_task_worktree(&source_path, &worktree_path, &branch_name);
                let handoff_root = project_artifact_base_path(&project)
                    .join("handoff")
                    .join(compact_path_id(&contract.delivery_id))
                    .join(compact_path_id(&contract.task_id));
                let _ = fs::remove_dir_all(&handoff_root);
                return Err(error);
            }
        };

        let base_commit = match run_git(
            &worktree_path,
            &["rev-parse".to_string(), "HEAD".to_string()],
        ) {
            Ok(commit) => commit,
            Err(error) => {
                cleanup_unallocated_task_worktree(&source_path, &worktree_path, &branch_name);
                return Err(error);
            }
        };
        contract.branch_name = Some(branch_name);
        contract.worktree_path = Some(worktree_path.to_string_lossy().to_string());
        contract.base_commit = Some(base_commit);
        contract.state = "allocated".to_string();
        contract.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(CONTRACTS_DIR, &contract.id, &contract)?;
        Ok(contract)
    }
}

