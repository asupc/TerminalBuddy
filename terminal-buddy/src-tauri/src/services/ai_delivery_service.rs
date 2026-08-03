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

    pub fn delete_workflow(id: &str) -> Result<(), String> {
        Self::delete(WORKFLOWS_DIR, id, "编排方案")
    }

}
