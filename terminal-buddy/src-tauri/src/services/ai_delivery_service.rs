use crate::commands::terminal::TerminalService;
use crate::models::{
    AiAgent, AiAgentRuntime, AiAttempt, AiCommandResult, AiDecisionOption, AiDecisionRequest,
    AiDelivery, AiDeliveryEvent, AiDeliveryTemplate, AiMergeRecord, AiMergeRepositoryRecord,
    AiProject, AiQualityGate, AiAttemptOutput, AiRepository, AiRepositoryStatusBaseline,
    AiReviewGate, AiRole, AiRuntimeProbe, AiTaskContract, AiTaskNode, AiWorkflow,
    CreateAiDecisionRequestInput, CreateAiDeliveryInput, CreateAiDeliveryTemplateInput,
    CreateAiProjectInput, CreateAiTaskNodeInput, CreateTaskContractInput, TerminalOwner,
    UpdateAiDeliveryInput, UpdateAiTaskNodeInput, UpdateAiDeliveryTemplateInput,
};
use crate::services::{BotSettingsService, DatabaseService, PathService};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
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
            profile_id: input.profile_id,
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
                Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
            Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
                Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
                Self::save(ATTEMPTS_DIR, &manager_attempt.id, &manager_attempt)?;
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
            Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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

    /// 应用进程已退出时，内存中的终端无法恢复；保留现场并允许用户重新派发。
    pub fn recover_interrupted_attempts() -> Result<usize, String> {
        let interrupted = Self::get_all_attempts(None)?
            .into_iter()
            .filter(|attempt| matches!(attempt.state.as_str(), "queued" | "starting" | "running"))
            .collect::<Vec<_>>();
        let mut recovered = 0;
        for mut attempt in interrupted {
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
            Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
        Self::save(ATTEMPTS_DIR, &reviewer_attempt.id, &reviewer_attempt)?;
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
       }
       result
   }

   fn merge_delivery_locally_locked_impl(
       delivery: &AiDelivery,
       project: &AiProject,
   ) -> Result<AiMergeRecord, String> {
       let tasks = Self::get_task_nodes(&delivery.id)?;
        if tasks.is_empty()
            || tasks
                .iter()
                .any(|task| !matches!(task.state.as_str(), "succeeded" | "skipped"))
        {
            return Err("仅当交付中的全部任务均已审核通过（或标记忽略）时才能本地合并".to_string());
        }
        let gates = Self::get_review_gates(Some(&delivery.id))?;
        for task in tasks.iter().filter(|task| task.workflow_step_id.is_none()) {
            if !gates
                .iter()
                .any(|gate| gate.task_node_id == task.id && gate.state == "approved")
            {
                return Err(format!("任务尚无通过的独立审核: {}", task.title));
            }
        }
        let mut task_groups = BTreeMap::<String, Vec<(AiTaskNode, AiTaskContract)>>::new();
        for task in tasks.iter().filter(|task| task.execution_mode == "write") {
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
                let contract = Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "任务契约")?;
                if contract.state != "allocated"
                    || !PathBuf::from(&contract.working_directory).is_dir()
                    || (execution_context == EXECUTION_CONTEXT_TASK_WORKTREE
                        && contract.worktree_path.is_none())
                {
                    return Err("返工任务的执行目录不可用，无法重新派发".to_string());
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
        Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
        for task in tasks.into_iter().filter(|task| task.state == "ready") {
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
           Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
        Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
                    let _ = Self::save(ATTEMPTS_DIR, &updated.id, &updated);
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

    /// 标记任务忽略（skipped）：failed/policyViolation/rework/needsInput 可标记，
    /// 收尾判定将 skipped 视为可完成状态（不阻塞后续合并）。
    pub fn mark_task_skipped(task_node_id: &str) -> Result<(), String> {
        let mut task = Self::get_task_node(task_node_id)?;
        if !matches!(
            task.state.as_str(),
            "failed" | "policyViolation" | "rework" | "needsInput"
        ) {
            return Err(format!("任务状态 {} 不可标记忽略", task.state));
        }
        task.state = "skipped".to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        Self::append_event(
            &task.delivery_id,
            Some(&task.id),
            None,
            "taskSkipped",
            &format!("任务 {} 已标记忽略（不阻塞后续合并）", task.title),
        )?;
        Ok(())
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
        Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
        Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
        Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
        Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
       Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
       Self::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
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
        // 所有编排步骤完成后自动标记交付成功
        if workflow_step_completed {
            let tasks = Self::get_task_nodes(delivery_id)?;
            if !tasks.is_empty()
                && tasks.iter().all(|t| matches!(t.state.as_str(), "succeeded" | "skipped"))
            {
                let mut delivery = Self::get_delivery(delivery_id)?;
                if delivery.state == "running" {
                    delivery.state = "succeeded".to_string();
                    let now = chrono::Utc::now();
                    delivery.updated_at = now.to_rfc3339();
                    Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
                    let _ = Self::append_event(
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
                    // 系统托盘通知：交付整体收尾
                    if let Some(app) = APP_HANDLE.get() {
                        let _ = crate::commands::notification::show_ai_delivery_notification(
                            app.clone(),
                            "AI 交付完成",
                            delivery_id.to_string(),
                            format!("交付「{}」全部任务已完成，交付成功", delivery.title),
                        );
                    }
                    // 自动合并到目标分支
                    let merge_delivery_id = delivery.id.clone();
                    let merge_result = Self::merge_delivery_locally(&merge_delivery_id);
                    match &merge_result {
                        Ok(_) => {
                            let _ = Self::append_event(
                                delivery_id,
                                None,
                                None,
                                "autoMerged",
                                "交付已自动合并到本地目标分支",
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
                    // merge 结果已通过 autoMerged/autoMergeFailed 事件记录
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
            Self::check_capacity(project, repository, &agent, task)?;
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
        for agent in candidates {
            if Self::check_capacity(project, repository, &agent, task).is_ok() {
                return Ok(agent);
            }
        }
        Err("角色候选 Agent 当前均无可用容量或存在写入范围冲突".to_string())
    }

    fn active_attempt_count_for_agent(agent_id: &str) -> Result<usize, String> {
        Ok(Self::get_all_attempts(None)?
            .into_iter()
            .filter(|attempt| {
                matches!(attempt.state.as_str(), "queued" | "starting" | "running")
                    && attempt.agent_id == agent_id
            })
            .count())
    }

    fn check_capacity(
        project: &AiProject,
        repository: &AiRepository,
        agent: &AiAgent,
        task: &AiTaskNode,
    ) -> Result<(), String> {
        let active = Self::get_all_attempts(None)?
            .into_iter()
            .filter(|attempt| matches!(attempt.state.as_str(), "queued" | "starting" | "running"))
            .collect::<Vec<_>>();
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
        let mut delivery = Self::get_delivery(delivery_id)?;
        if delivery.state != "running" {
            return Ok(false);
        }
        delivery.state = "succeeded".to_string();
        delivery.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(DELIVERIES_DIR, &delivery.id, &delivery)?;
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
        let merge_result = Self::merge_delivery_locally(&delivery.id);
        match &merge_result {
            Ok(_) => {
                let _ = Self::append_event(
                    delivery_id,
                    None,
                    None,
                    "autoMerged",
                    "交付已自动合并到本地目标分支",
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
        run_git(&source_path, &arguments)?;
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

/// 构造任务字段 diff 审计文本：只列变更字段，格式 `field: '旧值' → '新值'`。
fn build_task_diff(original: &AiTaskNode, updated: &AiTaskNode) -> String {
    let mut parts = Vec::new();
    if original.title != updated.title {
        parts.push(format!("title: '{}' → '{}'", original.title, updated.title));
    }
    if original.description != updated.description {
        parts.push(format!(
            "description: '{}' → '{}'",
            original.description, updated.description
        ));
    }
    if original.role_id != updated.role_id {
        parts.push(format!(
            "roleId: '{:?}' → '{:?}'",
            original.role_id, updated.role_id
        ));
    }
    if original.preferred_agent_id != updated.preferred_agent_id {
        parts.push(format!(
            "preferredAgentId: '{:?}' → '{:?}'",
            original.preferred_agent_id, updated.preferred_agent_id
        ));
    }
    if original.execution_mode != updated.execution_mode {
        parts.push(format!(
            "executionMode: '{}' → '{}'",
            original.execution_mode, updated.execution_mode
        ));
    }
    if original.execution_context != updated.execution_context {
        parts.push(format!(
            "executionContext: '{:?}' → '{:?}'",
            original.execution_context, updated.execution_context
        ));
    }
    if original.task_prompt != updated.task_prompt {
        parts.push("taskPrompt: 已变更".to_string());
    }
    if original.timeout_seconds != updated.timeout_seconds {
        parts.push(format!(
            "timeoutSeconds: '{:?}' → '{:?}'",
            original.timeout_seconds, updated.timeout_seconds
        ));
    }
    if original.retry_count != updated.retry_count {
        parts.push(format!(
            "retryCount: '{}' → '{}'",
            original.retry_count, updated.retry_count
        ));
    }
    for (label, original_items, updated_items) in [
        ("allowedWritePaths", &original.allowed_write_paths, &updated.allowed_write_paths),
        ("expectedArtifacts", &original.expected_artifacts, &updated.expected_artifacts),
        ("acceptanceCommands", &original.acceptance_commands, &updated.acceptance_commands),
        ("dependencyIds", &original.dependency_ids, &updated.dependency_ids),
    ] {
        if original_items != updated_items {
            parts.push(format!(
                "{}: 已变更（{} 项 → {} 项）",
                label,
                original_items.len(),
                updated_items.len()
            ));
        }
    }
    if parts.is_empty() {
        "无字段变更".to_string()
    } else {
        parts.join("；")
    }
}

fn cleanup_unallocated_task_worktree(source: &Path, worktree: &Path, branch_name: &str) {
    let _ = run_git(
        source,
        &[
            "worktree".to_string(),
            "remove".to_string(),
            "--force".to_string(),
            worktree.to_string_lossy().to_string(),
        ],
    );
    let _ = run_git(
        source,
        &[
            "branch".to_string(),
            "-D".to_string(),
            branch_name.to_string(),
        ],
    );
    if worktree.exists() {
        let _ = fs::remove_dir_all(worktree);
    }
}

/// 递归收集所有传递依赖的任务节点 ID（含直接依赖及其上游依赖）
fn collect_transitive_dependency_ids(task: &AiTaskNode) -> Result<Vec<String>, String> {
    let mut visited = std::collections::HashSet::new();
    let mut result = Vec::new();
    let mut stack: Vec<String> = task.dependency_ids.clone();
    while let Some(dep_id) = stack.pop() {
        if !visited.insert(dep_id.clone()) {
            continue;
        }
        let dep = AiDeliveryService::get_task_node(&dep_id)?;
        stack.extend(dep.dependency_ids.iter().cloned());
        result.push(dep_id);
    }
    Ok(result)
}

fn materialize_dependency_artifacts(
    project: &AiProject,
    task: &AiTaskNode,
    contract: &AiTaskContract,
) -> Result<Option<String>, String> {
    if contract.input_artifacts.is_empty() {
        return Ok(None);
    }
    if task.dependency_ids.is_empty() {
        return Err("任务声明了输入成果，但未指定任何前置任务".to_string());
    }
    let handoff_root = project_artifact_base_path(project)
        .join("handoff")
        .join(compact_path_id(&contract.delivery_id))
        .join(compact_path_id(&contract.task_id));
    if handoff_root.exists() {
        return Err(format!(
            "任务成果交接目录已存在: {}",
            handoff_root.display()
        ));
    }
    let mut missing = contract
        .input_artifacts
        .iter()
        .map(|artifact| artifact.trim().to_string())
        .collect::<HashSet<_>>();
    let all_dependency_ids = collect_transitive_dependency_ids(&task)?;
    for dependency_id in &all_dependency_ids {
        let dependency = AiDeliveryService::get_task_node(dependency_id)?;
        if dependency.state != "succeeded" {
            return Err(format!("前置任务尚未审核通过: {}", dependency.title));
        }
        let dependency_contract_id = dependency
            .contract_id
            .as_deref()
            .ok_or_else(|| format!("前置任务缺少任务契约: {}", dependency.title))?;
        let dependency_contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            dependency_contract_id,
            "前置任务契约",
        )?;
        let dependency_output_directory = dependency_contract
            .output_artifact_directory
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&dependency_contract.working_directory));
        for artifact in &contract.input_artifacts {
            let relative = artifact.trim();
            let artifact_path = Path::new(relative);
            if relative.is_empty()
                || artifact_path.is_absolute()
                || artifact_path
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return Err(format!("输入成果路径不安全: {}", artifact));
            }
            let source = dependency_output_directory.join(artifact_path);
            if !source.exists() {
                continue;
            }
            let destination = handoff_root
                .join(safe_path_segment(dependency_id))
                .join(artifact_path);
            copy_artifact_path(&source, &destination)?;
            missing.remove(relative);
        }
    }
    if !missing.is_empty() {
        let _ = fs::remove_dir_all(&handoff_root);
        return Err(format!(
            "未能从前置任务取得声明的输入成果: {}",
            missing.into_iter().collect::<Vec<_>>().join("、")
        ));
    }
    Ok(Some(handoff_root.to_string_lossy().to_string()))
}

fn prepare_output_artifact_directory(
    project: &AiProject,
    task: &AiTaskNode,
    contract: &AiTaskContract,
) -> Result<Option<String>, String> {
    if task.execution_mode != "readonly" || contract.expected_artifacts.is_empty() {
        return Ok(None);
    }
    let output_root = project_artifact_base_path(project)
        .join("outputs")
        .join(compact_path_id(&contract.delivery_id))
        .join(compact_path_id(&contract.task_id));
    if output_root.exists() {
        return Err(format!("只读任务成果目录已存在: {}", output_root.display()));
    }
    fs::create_dir_all(&output_root)
        .map_err(|error| format!("创建只读任务成果目录失败: {}", error))?;
    Ok(Some(output_root.to_string_lossy().to_string()))
}

fn copy_artifact_path(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_file() {
        let parent = destination
            .parent()
            .ok_or_else(|| "输入成果目标路径无效".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建成果交接目录失败: {}", error))?;
        fs::copy(source, destination).map_err(|error| format!("复制输入成果失败: {}", error))?;
        return Ok(());
    }
    if !source.is_dir() {
        return Err(format!("输入成果不是文件或目录: {}", source.display()));
    }
    fs::create_dir_all(destination).map_err(|error| format!("创建成果目录失败: {}", error))?;
    for entry in fs::read_dir(source).map_err(|error| format!("读取输入成果目录失败: {}", error))?
    {
        let entry = entry.map_err(|error| format!("读取输入成果失败: {}", error))?;
        copy_artifact_path(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

fn unavailable_runtime_probe(kind: &str, command: &str) -> AiRuntimeProbe {
    AiRuntimeProbe {
        kind: kind.to_string(),
        command: command.to_string(),
        available: false,
        version: None,
    }
}

/// 检查可执行文件是否在 PATH 中存在（不实际运行）。
/// 作为 --version 探测失败时的兜底，避免冷启动慢导致误判为不可用。
fn executable_exists_in_path(executable: &str) -> bool {
    // 如果已经是绝对/相对路径，直接检查文件
    let path = Path::new(executable);
    if path.is_absolute() || path.components().count() > 1 {
        #[cfg(windows)]
        {
            // 无扩展名时尝试 .exe / .cmd / .bat
            if path.extension().is_none() {
                for ext in &["exe", "cmd", "bat"] {
                    if path.with_extension(ext).is_file() {
                        return true;
                    }
                }
            }
            return path.is_file();
        }
        #[cfg(not(windows))]
        return path.is_file();
    }
    // 裸命令名，在 PATH 中搜索
    #[cfg(windows)]
    {
        let path_var = match std::env::var_os("PATH") {
            Some(p) => p,
            None => return false,
        };
        for dir in std::env::split_paths(&path_var) {
            for ext in &["exe", "cmd", "bat", "ps1"] {
                if dir.join(executable).with_extension(ext).is_file() {
                    return true;
                }
            }
            // 也检查无扩展名的精确匹配
            if dir.join(executable).is_file() {
                return true;
            }
        }
        false
    }
    #[cfg(not(windows))]
    {
        which::which(executable).is_ok()
    }
}

fn probe_local_runtime(kind: &str, command: &str) -> AiRuntimeProbe {
    // command 可能包含参数（如 "claude --dangerously-skip-permissions"），
    // 但探测版本时只需要可执行文件名，不应传额外参数。
    let probe_executable = if let Ok(parts) = split_runtime_command(command) {
        parts.into_iter().next().unwrap_or_else(|| command.to_string())
    } else {
        command.to_string()
    };
    #[cfg(windows)]
    let mut process = if Path::new(&probe_executable).extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    }) {
        npm_command_probe(Path::new(&probe_executable))
    } else if Path::new(&probe_executable).is_absolute() {
        // 绝对路径（如 .exe）可以直接执行
        let mut process = Command::new(&probe_executable);
        process.arg("--version");
        process
    } else {
        // 裸命令名（如 "codex"、"claude"）需通过 cmd /C 执行，
        // Rust 的 Command::new 不会自动解析 PATHEXT (.exe/.cmd/.bat)
        let mut process = Command::new("cmd");
        process.args(["/D", "/S", "/C"]);
        process.raw_arg(format!("\"{}\" --version", probe_executable));
        process
    };
    #[cfg(not(windows))]
    let mut process = {
        let mut process = Command::new(&probe_executable);
        process.arg("--version");
        process
    };
    if let Ok(output) =
        run_command_with_timeout(&mut process, RUNTIME_PROBE_TIMEOUT, "Runtime 探测")
    {
        if output.status.success() {
            return available_runtime_probe(kind, command, output);
        }
    }

    #[cfg(windows)]
    if let Some(npm_command) = npm_global_command(&probe_executable) {
        let mut process = npm_command_probe(&npm_command);
        if let Ok(output) =
            run_command_with_timeout(&mut process, RUNTIME_PROBE_TIMEOUT, "Runtime 探测")
        {
            if output.status.success() {
                return available_runtime_probe(
                    kind,
                    npm_command.to_string_lossy().as_ref(),
                    output,
                );
            }
        }
    }

    // 兜底：如果以上探测都失败，用 where/which 检查可执行文件是否存在于 PATH 中。
    // 很多 CLI 在应用启动时冷启动慢，--version 可能超时，但文件确实可用。
    if executable_exists_in_path(&probe_executable) {
        return AiRuntimeProbe {
            kind: kind.to_string(),
            command: command.to_string(),
            available: true,
            version: None,
        };
    }

    unavailable_runtime_probe(kind, command)
}

fn available_runtime_probe(kind: &str, command: &str, output: Output) -> AiRuntimeProbe {
    AiRuntimeProbe {
        kind: kind.to_string(),
        command: command.to_string(),
        available: true,
        version: String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    }
}

#[cfg(windows)]
fn npm_global_command(command: &str) -> Option<PathBuf> {
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    let user_app_data = dirs::home_dir().map(|directory| directory.join("AppData").join("Roaming"));
    [app_data, user_app_data]
        .into_iter()
        .flatten()
        .map(|directory| directory.join("npm").join(format!("{}.cmd", command)))
        .find(|path| path.is_file())
}

#[cfg(windows)]
fn npm_command_probe(command: &Path) -> Command {
    let mut process = Command::new("cmd");
    process.args(["/D", "/S", "/C"]);
    process.raw_arg(format!("\"{}\" --version", command.display()));
    if let Some(node_directory) = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .map(|directory| directory.join("nodejs"))
        .filter(|directory| directory.join("node.exe").is_file())
    {
        let current_path = std::env::var_os("PATH").unwrap_or_default();
        let mut search_path = node_directory.into_os_string();
        search_path.push(";");
        search_path.push(current_path);
        process.env("PATH", search_path);
    }
    process
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("工作区路径不能为空".to_string());
    }
    let canonical = PathBuf::from(trimmed)
        .canonicalize()
        .map_err(|error| format!("工作区路径不可用: {}", error))?;
    if !canonical.is_dir() {
        return Err("工作区路径不是目录".to_string());
    }
    Ok(normalize_path_for_external_process(&canonical))
}

fn normalize_optional_directory(path: Option<String>) -> Result<Option<String>, String> {
    path.filter(|value| !value.trim().is_empty())
        .map(|value| canonical_directory(&value).map(|path| path.to_string_lossy().to_string()))
        .transpose()
}

fn discover_repositories(workspace_root: &Path) -> Result<Vec<AiRepository>, String> {
    let workspace_root = normalize_path_for_external_process(workspace_root);
    let mut candidates = vec![workspace_root.clone()];
    for entry in fs::read_dir(&workspace_root)
        .map_err(|error| format!("读取工作区目录失败: {}", error))?
        .flatten()
    {
        if entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            candidates.push(entry.path());
        }
    }
    let mut repositories = BTreeMap::<String, AiRepository>::new();
    for candidate in candidates {
        let Ok(root) = git_root(&candidate) else {
            continue;
        };
        let canonical_root =
            normalize_path_for_external_process(&root.canonicalize().unwrap_or(root));
        let relative_path = canonical_root
            .strip_prefix(&workspace_root)
            .map_err(|_| "Git 仓库不在工作区内".to_string())?
            .to_string_lossy()
            .to_string();
        let relative_path = if relative_path.is_empty() {
            ".".to_string()
        } else {
            relative_path
        };
        let name = if relative_path == "." {
            workspace_root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("repository")
                .to_string()
        } else {
            canonical_root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("repository")
                .to_string()
        };
        let branch = current_branch(&canonical_root).unwrap_or_else(|| "main".to_string());
        let key = canonical_root.to_string_lossy().to_ascii_lowercase();
        repositories.entry(key).or_insert_with(|| AiRepository {
            id: Uuid::new_v4().to_string(),
            name,
            relative_path,
            default_branch: branch,
            write_concurrency: 2,
            write_enabled: true,
        });
    }
    Ok(repositories.into_values().collect())
}

fn git_root(path: &Path) -> Result<PathBuf, String> {
    let output = run_git(
        path,
        &["rev-parse".to_string(), "--show-toplevel".to_string()],
    )?;
    Ok(PathBuf::from(output))
}

fn current_branch(path: &Path) -> Option<String> {
    run_git(path, &["branch".to_string(), "--show-current".to_string()])
        .ok()
        .filter(|branch| !branch.is_empty())
}

fn normalize_quality_gate(mut quality_gate: AiQualityGate) -> Result<AiQualityGate, String> {
    quality_gate.commands = quality_gate
        .commands
        .into_iter()
        .map(|command| command.trim().to_string())
        .filter(|command| !command.is_empty())
        .collect();
    if quality_gate.commands.is_empty() {
        return Err("质量门禁命令至少需要一条，确保交付能够审核和本地合并".to_string());
    }
    Ok(quality_gate)
}

fn scan_repository_quality_contexts(
    workspace_root: &Path,
) -> Result<Vec<RepositoryQualityContext>, String> {
    let repositories = discover_repositories(workspace_root)?;
    let mut contexts = Vec::new();
    for repository in repositories {
        let repository_path = if repository.relative_path == "." {
            workspace_root.to_path_buf()
        } else {
            workspace_root.join(&repository.relative_path)
        };
        let manifests = scan_quality_manifests(&repository_path);
        let stacks = detect_repository_stacks(&repository.relative_path, &manifests);
        contexts.push(RepositoryQualityContext {
            name: repository.name,
            relative_path: repository.relative_path,
            default_branch: repository.default_branch,
            stacks,
            manifests,
        });
    }
    Ok(contexts)
}

fn scan_quality_manifests(root: &Path) -> Vec<QualityManifest> {
    let mut manifests = Vec::new();
    scan_quality_manifests_recursive(root, root, 0, &mut manifests);
    manifests.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    manifests
}

fn scan_quality_manifests_recursive(
    root: &Path,
    directory: &Path,
    depth: usize,
    manifests: &mut Vec<QualityManifest>,
) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if path.is_dir() {
            if matches!(
                name.as_str(),
                ".git"
                    | "node_modules"
                    | "dist"
                    | "build"
                    | "target"
                    | ".next"
                    | ".nuxt"
                    | ".venv"
                    | "venv"
                    | "vendor"
                    | "__pycache__"
                    | ".idea"
                    | ".vscode"
            ) || (name.starts_with('.') && name != ".github")
            {
                continue;
            }
            scan_quality_manifests_recursive(root, &path, depth + 1, manifests);
        } else if QUALITY_MANIFEST_NAMES.contains(&name.as_str())
            || name.ends_with(".csproj")
        {
            let relative_path = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string()
                .replace('\\', "/");
            let scripts = if name == "package.json" {
                package_scripts(&path)
            } else {
                None
            };
            manifests.push(QualityManifest {
                relative_path,
                scripts,
            });
        }
    }
}

fn package_scripts(path: &Path) -> Option<Vec<String>> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > 256 * 1024 {
        return None;
    }
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let scripts = value.get("scripts")?.as_object()?;
    let mut names = scripts
        .keys()
        .filter(|name| {
            !name.is_empty()
                && name.chars().all(|character| {
                    character.is_ascii_alphanumeric()
                        || matches!(character, ':' | '-' | '_')
                })
        })
        .cloned()
        .collect::<Vec<String>>();
    names.sort();
    names.dedup();
    Some(names)
}

fn detect_repository_stacks(
    relative_path: &str,
    manifests: &[QualityManifest],
) -> Vec<String> {
    let mut stacks = Vec::<String>::new();
    let normalized = relative_path.replace('\\', "/").to_ascii_lowercase();
    let segments = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.iter().any(|segment| {
        matches!(
            *segment,
            "web"
                | "frontend"
                | "front"
                | "client"
                | "ui"
                | "h5"
                | "uniapp"
                | "uni-app"
                | "app"
                | "applet"
                | "applets"
        )
    }) {
        stacks.push("frontend".to_string());
    }
    if segments.iter().any(|segment| {
        matches!(
            *segment,
            "server" | "backend" | "api" | "service" | "services" | "admin-api"
        )
    }) {
        stacks.push("backend".to_string());
    }
    for manifest in manifests {
        let manifest_path = manifest.relative_path.to_ascii_lowercase();
        let manifest_name = manifest_path
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string();
        if matches!(
            manifest_name.as_str(),
            "package.json" | "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock"
        ) {
            push_stack(&mut stacks, "typescript/javascript".to_string());
            if manifest_path.contains("src-tauri") {
                push_stack(&mut stacks, "desktop".to_string());
            }
            if manifest_path.starts_with("web/") || manifest_path.starts_with("frontend/") {
                push_stack(&mut stacks, "frontend".to_string());
            }
            if manifest.scripts.as_deref().is_some_and(|scripts| {
                scripts.iter().any(|script| {
                    script.contains("web")
                        || script.contains("frontend")
                        || script.contains("ui")
                })
            }) {
                push_stack(&mut stacks, "frontend".to_string());
            }
            if manifest.scripts.as_deref().is_some_and(|scripts| {
                scripts
                    .iter()
                    .any(|script| script.contains("server") || script.contains("api"))
            }) {
                push_stack(&mut stacks, "backend".to_string());
            }
        }
        if matches!(
            manifest_name.as_str(),
            "cargo.toml" | "cargo.lock"
        ) {
            push_stack(&mut stacks, "rust".to_string());
            if manifest_path.contains("src-tauri") {
                push_stack(&mut stacks, "desktop".to_string());
            }
        }
        if matches!(
            manifest_name.as_str(),
            "requirements.txt" | "pyproject.toml"
        ) {
            push_stack(&mut stacks, "python".to_string());
        }
        if manifest_name == "go.mod" {
            push_stack(&mut stacks, "go".to_string());
        }
        if matches!(
            manifest_name.as_str(),
            "pom.xml" | "build.gradle" | "build.gradle.kts"
        ) {
            push_stack(&mut stacks, "java".to_string());
        }
        if manifest_name.ends_with(".csproj") {
            push_stack(&mut stacks, ".net".to_string());
        }
    }
    if stacks.is_empty() {
        stacks.push("mixed".to_string());
    }
    stacks
}

fn push_stack(stacks: &mut Vec<String>, stack: String) {
    if !stacks.contains(&stack) {
        stacks.push(stack);
    }
}

fn build_quality_gate_prompt(
    contexts: &[RepositoryQualityContext],
    workspace_root: &Path,
    result_path: &Path,
    schema_path: &Path,
    cli_captures_output: bool,
) -> String {
    let contexts_json = serde_json::to_string_pretty(contexts).unwrap_or_default();
    let output_instruction = if cli_captures_output {
        format!(
            "最终响应必须只包含 JSON，不要包含 Markdown 代码块，也不要使用文件工具写入结果文件；平台会将最终响应保存到：{}",
            result_path.display(),
        )
    } else {
        format!(
            "必须使用文件工具把最终 JSON 原样写入：{}",
            result_path.display(),
        )
    };
    format!(
        "你是 AI 交付项目的质量门禁配置专家。\n\
当前工作目录：{}\n\
请先扫描并理解以下工作区结构，再为整个项目生成质量门禁命令。\n\n\
工作区仓库与技术栈扫描结果：\n{}\n\n\
硬性约束：\n\
1. 覆盖所有 Git 仓库；同一仓库包含前端、后端或桌面端时，分别生成对应模块的验证命令。\n\
2. 命令必须是可在当前工作区根目录执行的 PowerShell 命令；优先从各仓库的构建脚本、包管理器和配置文件推导。\n\
3. 只允许类型检查、静态检查、构建、单元测试、集成测试等非破坏性验证；禁止 git push、git reset、git clean、rm -rf、Remove-Item、部署、发布、修改配置、迁移或删除数据。\n\
4. 每条命令单独一个字符串，建议 4-12 条，必须至少包含一次构建或类型检查和一次测试或检查类命令。\n\
5. {}\n\
6. JSON 必须符合 Schema：{}\n\
7. 只输出 JSON 文件内容，不输出额外解释；若某个模块没有可执行的检查命令，不要编造，改为列出该模块的构建命令。",
        workspace_root.display(),
        contexts_json,
        output_instruction,
        schema_path.display(),
    )
}

fn validate_runtime(runtime: &AiAgentRuntime) -> Result<(), String> {
    if runtime.name.trim().is_empty()
        || runtime.kind.trim().is_empty()
        || runtime.command.trim().is_empty()
    {
        return Err("运行时名称、类型和命令不能为空".to_string());
    }
    if runtime.command.contains('\n') || runtime.command.contains('\r') {
        return Err("运行时命令不能包含换行符".to_string());
    }
    Ok(())
}

fn validate_agent_configuration(agent: &AiAgent) -> Result<(), String> {
    for argument in &agent.runtime_args {
        let normalized = argument.trim().to_ascii_lowercase();
        if normalized.is_empty() || normalized.contains('\n') || normalized.contains('\r') {
            return Err("Agent 启动参数不能为空且不能包含换行符".to_string());
        }
        if [
            "--dangerously-skip-permissions",
            "--bypass-permissions",
            "--yolo",
            "--no-sandbox",
        ]
        .iter()
        .any(|blocked| normalized == *blocked)
        {
            return Err(format!("禁止使用不安全的 Agent 启动参数: {}", argument));
        }
    }
    Ok(())
}

fn validate_task_input(input: &CreateTaskContractInput) -> Result<(), String> {
    if input.delivery_id.trim().is_empty()
        || input.task_id.trim().is_empty()
        || input.title.trim().is_empty()
    {
        return Err("交付编号、任务编号和标题不能为空".to_string());
    }
    validate_write_paths(&input.allowed_write_paths)
}

fn validate_write_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("必须声明至少一个允许写入路径".to_string());
    }
    for path in paths {
        let normalized = path.trim().replace('\\', "/");
        if normalized.is_empty()
            || normalized.starts_with('/')
            || normalized.contains("../")
            || normalized == ".."
        {
            return Err(format!("允许写入路径不合法: {}", path));
        }
    }
    Ok(())
}

fn write_paths_overlap(left: &[String], right: &[String]) -> bool {
    left.iter().any(|left_path| {
        let left_path = left_path
            .trim()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        right.iter().any(|right_path| {
            let right_path = right_path
                .trim()
                .replace('\\', "/")
                .trim_end_matches('/')
                .to_ascii_lowercase();
            left_path == right_path
                || left_path.starts_with(&(right_path.clone() + "/"))
                || right_path.starts_with(&(left_path.clone() + "/"))
        })
    })
}

fn project_repository_path(
    project: &AiProject,
    repository: &AiRepository,
) -> Result<PathBuf, String> {
    let root = canonical_directory(&project.workspace_root)?;
    let path = if repository.relative_path == "." {
        root
    } else {
        root.join(&repository.relative_path)
    };
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("目标仓库目录不可用: {}", error))?;
    if git_root(&canonical).is_err() {
        return Err("目标仓库已不是有效 Git 仓库".to_string());
    }
    Ok(canonical)
}

fn ensure_clean_repository(path: &Path) -> Result<(), String> {
    let status = repository_status(path)?;
    if !status.is_empty() {
        return Err(format!(
            "目标仓库存在未提交改动，拒绝创建 worktree: {}",
            path.display()
        ));
    }
    Ok(())
}

fn repository_status(path: &Path) -> Result<String, String> {
    run_git(path, &["status".to_string(), "--porcelain=v1".to_string()])
}

fn project_repository_statuses(project: &AiProject) -> Result<BTreeMap<String, String>, String> {
    project
        .repositories
        .iter()
        .map(|repository| {
            let path = project_repository_path(project, repository)?;
            let head = run_git(&path, &["rev-parse".to_string(), "HEAD".to_string()])?;
            Ok((
                repository.id.clone(),
                format!("{}\n{}", head, repository_status(&path)?),
            ))
        })
        .collect()
}

fn ensure_project_repository_statuses_unchanged(
    project: &AiProject,
    baseline: &BTreeMap<String, String>,
) -> Result<(), String> {
    let current = project_repository_statuses(project)?;
    let changed = project
        .repositories
        .iter()
        .filter(|repository| baseline.get(&repository.id) != current.get(&repository.id))
        .map(|repository| repository.name.as_str())
        .collect::<Vec<_>>();
    if changed.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "管理者规划期间修改了项目仓库，已阻断任务图：{}。请检查并处理这些改动后重试。",
            changed.join("、")
        ))
    }
}

fn audit_contract_scope(
    project: &AiProject,
    contract: &AiTaskContract,
) -> Result<Option<String>, String> {
    for baseline in &contract.repository_status_baselines {
        if !contract
            .forbidden_repository_ids
            .iter()
            .any(|id| id == &baseline.repository_id)
        {
            continue;
        }
        let repository = project
            .repositories
            .iter()
            .find(|repository| repository.id == baseline.repository_id)
            .ok_or_else(|| "任务契约引用的禁止仓库不存在".to_string())?;
        let path = project_repository_path(project, repository)?;
        let current = repository_status(&path)?;
        let current_head = run_git(&path, &["rev-parse".to_string(), "HEAD".to_string()])?;
        if current != baseline.status
            || baseline
                .head_commit
                .as_deref()
                .is_some_and(|head| head != current_head)
        {
            return Ok(Some(format!(
                "检测到未授权仓库改动: {}，已阻断审核与合并",
                repository.name
            )));
        }
    }
    audit_allowed_write_paths(contract)
}

fn audit_allowed_write_paths(contract: &AiTaskContract) -> Result<Option<String>, String> {
    let Some(base_commit) = contract.base_commit.as_deref() else {
        // 升级前创建的契约没有记录基线提交，保留兼容性；重新派发会创建带基线的新契约。
        return Ok(None);
    };
    let worktree = PathBuf::from(&contract.working_directory);
    let mut changed_paths = run_git(
        &worktree,
        &[
            "diff".to_string(),
            "--name-only".to_string(),
            base_commit.to_string(),
        ],
    )?
    .lines()
    .map(str::trim)
    .filter(|path| !path.is_empty())
    .map(str::to_string)
    .collect::<Vec<_>>();
    changed_paths.extend(
        run_git(
            &worktree,
            &[
                "ls-files".to_string(),
                "--others".to_string(),
                "--exclude-standard".to_string(),
            ],
        )?
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string),
    );
    changed_paths.sort();
    changed_paths.dedup();
    let out_of_scope = changed_paths
        .into_iter()
        .filter(|path| !is_allowed_write_path(path, &contract.allowed_write_paths))
        .collect::<Vec<_>>();
    if out_of_scope.is_empty() {
        Ok(None)
    } else {
        Ok(Some(format!(
            "检测到任务写入超出允许路径，已阻断审核与合并：{}",
            out_of_scope.join("、")
        )))
    }
}

fn is_allowed_write_path(path: &str, allowed_paths: &[String]) -> bool {
    let path = path.trim().replace('\\', "/");
    allowed_paths.iter().any(|allowed| {
        let allowed = allowed
            .trim()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string();
        allowed == "." || path == allowed || path.starts_with(&(allowed + "/"))
    })
}

fn project_artifact_base_path(project: &AiProject) -> PathBuf {
    let base = if let Some(path) = project.worktree_root.as_ref() {
        PathBuf::from(path).join(compact_path_id(&project.id))
    } else {
        let workspace = PathBuf::from(&project.workspace_root);
        workspace
            .parent()
            .unwrap_or(workspace.as_path())
            .join(".terminalbuddy-worktrees")
            .join(compact_path_id(&project.id))
    };
    normalize_path_for_external_process(&base)
}

fn repository_worktree_base_path(
    project: &AiProject,
    repository: &AiRepository,
) -> Result<PathBuf, String> {
    let base = if let Some(path) = project.worktree_root.as_ref() {
        PathBuf::from(path)
            .join(compact_path_id(&project.id))
            .join(safe_path_segment(&repository.name))
    } else {
        project_repository_path(project, repository)?.join(".terminalbuddy-worktrees")
    };
    Ok(normalize_path_for_external_process(&base))
}

fn ensure_worktree_directory_is_ignored(repository: &Path) -> Result<(), String> {
    let git_dir = PathBuf::from(run_git(
        repository,
        &["rev-parse".to_string(), "--git-dir".to_string()],
    )?);
    let git_dir = if git_dir.is_absolute() {
        git_dir
    } else {
        repository.join(git_dir)
    };
    let exclude_path = git_dir.join("info").join("exclude");
    let exclude = match fs::read_to_string(&exclude_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取仓库本地排除规则失败: {}", error)),
    };
    const ENTRY: &str = "/.terminalbuddy-worktrees/";
    if exclude.lines().any(|line| line.trim() == ENTRY) {
        return Ok(());
    }
    let parent = exclude_path
        .parent()
        .ok_or_else(|| "仓库本地排除规则路径无效".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建仓库本地排除规则目录失败: {}", error))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&exclude_path)
        .map_err(|error| format!("写入仓库本地排除规则失败: {}", error))?;
    if !exclude.is_empty() && !exclude.ends_with('\n') {
        writeln!(file).map_err(|error| format!("写入仓库本地排除规则失败: {}", error))?;
    }
    writeln!(file, "{}", ENTRY).map_err(|error| format!("写入仓库本地排除规则失败: {}", error))?;
    Ok(())
}

fn cleanup_delivery_integration_workspace(
    project: &AiProject,
    delivery: &AiDelivery,
) -> Result<(), String> {
    for repository in &project.repositories {
        let source = project_repository_path(project, repository)?;
        let integration_repository = repository_worktree_base_path(project, repository)?
            .join("integration")
            .join(compact_path_id(&delivery.id));
        if integration_repository.exists() {
            run_git(
                &source,
                &[
                    "worktree".to_string(),
                    "remove".to_string(),
                    "--force".to_string(),
                    integration_repository.to_string_lossy().to_string(),
                ],
            )?;
        }
        let integration_branch = format!(
            "terminalbuddy/integration/{}-{}",
            safe_ref_segment(&delivery.id),
            safe_ref_segment(&repository.name)
        );
        let _ = run_git(
            &source,
            &["branch".to_string(), "-D".to_string(), integration_branch],
        );
    }
    Ok(())
}

/// 将显示标签中的不安全字符替换为下划线，用于构造可读的终端运行目录名。
/// 清理交付关联的所有任务 worktree、分支和产出物交接目录。
/// 用于交付删除或合并完成后的资源回收，全部以尽力方式执行，不阻断主流程。
fn cleanup_delivery_task_worktrees(project: &AiProject, delivery: &AiDelivery) {
    let contracts = match AiDeliveryService::get_all_task_contracts(Some(&project.id)) {
        Ok(contracts) => contracts,
        Err(_) => return,
    };
    for contract in contracts
        .into_iter()
        .filter(|contract| contract.delivery_id == delivery.id)
    {
        let Some(branch_name) = contract.branch_name.as_deref() else {
            continue;
        };
        let Some(repository) = project
            .repositories
            .iter()
            .find(|repository| repository.id == contract.target_repository_id)
        else {
            continue;
        };
        let Ok(source) = project_repository_path(project, repository) else {
            continue;
        };
        if let Some(worktree_path) = contract.worktree_path.as_deref() {
            cleanup_unallocated_task_worktree(&source, Path::new(worktree_path), branch_name);
        } else {
            let _ = run_git(
                &source,
                &[
                    "branch".to_string(),
                    "-D".to_string(),
                    branch_name.to_string(),
                ],
            );
        }
    }
    let handoff_root = project_artifact_base_path(project)
        .join("handoff")
        .join(compact_path_id(&delivery.id));
    let _ = fs::remove_dir_all(&handoff_root);
}

fn safe_display_segment(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            let code = c as u32;
            if code < 32 || matches!(code, 34 | 42 | 47 | 58 | 60 | 62 | 63 | 92 | 124) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches(|ch: char| ch == '.' || ch.is_whitespace())
        .to_string()
}

fn dispatch_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn attempt_start_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 生成终端运行目录名：{可读标签}__{UUID}，无标签时退回纯 UUID。
fn make_terminal_run_dir_name(run_id: &str, display_label: Option<&str>) -> String {
    let id_seg = safe_path_segment(run_id);
    let label = display_label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| safe_display_segment(s));
    match label {
        Some(slug) if !slug.is_empty() => {
            let truncated: String = slug.chars().take(50).collect();
            format!("{}__{}", truncated, id_seg)
        }
        _ => id_seg,
    }
}

/// 按尝试 ID 查找终端运行目录，兼容旧格式（纯 UUID）和新格式（标签__UUID）。
fn terminal_run_dir_by_id(run_id: &str) -> PathBuf {
    let base = AiDeliveryService::entity_dir(TERMINAL_RUNS_DIR);
    let id_seg = safe_path_segment(run_id);
    if let Ok(entries) = fs::read_dir(&base) {
        let suffix = format!("__{}", id_seg);
        for entry in entries.flatten() {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name == id_seg || name.ends_with(&suffix) {
                        return entry.path();
                    }
                }
            }
        }
    }
    base.join(id_seg)
}

fn safe_path_segment(value: &str) -> String {
    let result = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if result.is_empty() {
        "task".to_string()
    } else {
        result
    }
}

fn compact_path_id(value: &str) -> String {
    let safe = safe_path_segment(value);
    safe.chars().take(16).collect()
}

fn safe_ref_segment(value: &str) -> String {
    safe_path_segment(value)
        .trim_matches('.')
        .trim_matches('/')
        .to_string()
}

fn run_git(path: &Path, arguments: &[String]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(normalize_path_for_external_process(path))
        .args(arguments);
    let output = run_command_with_timeout(&mut cmd, GIT_COMMAND_TIMEOUT, "Git 命令")?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "Git 命令执行失败".to_string()
        } else {
            message
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn build_agent_prompt(
    task: &AiTaskNode,
    contract: &AiTaskContract,
    project: &AiProject,
) -> Result<String, String> {
    let allowed_paths = contract.allowed_write_paths.join(", ");
    let artifacts = if contract.expected_artifacts.is_empty() {
        "无".to_string()
    } else {
        contract.expected_artifacts.join("；")
    };
    let checks = if contract.acceptance_commands.is_empty() {
        "未配置".to_string()
    } else {
        contract.acceptance_commands.join("；")
    };
    let input_artifacts = match contract.input_artifact_directory.as_deref() {
        Some(directory) => format!(
            "前置任务成果位于交接目录 {}。可读取其中的文件作为输入，但不得修改该目录。",
            directory
        ),
        None => "无前置任务成果目录。".to_string(),
    };
    let workflow_prompt = if task.task_prompt.trim().is_empty() {
        "未配置额外步骤提示词。".to_string()
    } else {
        task.task_prompt.trim().to_string()
    };
    let dependency_summaries = if task.dependency_ids.is_empty() {
        "无前置步骤结论。".to_string()
    } else {
        task.dependency_ids
            .iter()
            .map(|dependency_id| {
                let dependency = AiDeliveryService::get_task_node(dependency_id)?;
                let summary = dependency
                    .attempt_ids
                    .last()
                    .map(|attempt_id| {
                        AiDeliveryService::get::<AiAttempt>(
                            ATTEMPTS_DIR,
                            attempt_id,
                            "前置步骤执行",
                        )
                    })
                    .transpose()?
                    .and_then(|attempt| {
                        fs::read_to_string(
                            terminal_run_dir_by_id(&attempt.id).join("transcript.log"),
                        )
                        .ok()
                        .filter(|output| !output.trim().is_empty())
                        .map(|output| compact_output(&output))
                        .or(attempt.summary)
                    })
                    .unwrap_or_else(|| "未提供执行摘要".to_string());
                Ok(format!("- {}：{}", dependency.title, summary))
            })
            .collect::<Result<Vec<_>, String>>()?
            .join("\n")
    };
    let resolved_decisions = AiDeliveryService::get_decision_requests(Some(&task.delivery_id))?
        .into_iter()
        .filter(|request| {
            request.state == "answered"
                && request
                    .task_node_id
                    .as_deref()
                    .is_none_or(|task_id| task_id == task.id)
        })
        .filter_map(|request| {
            request
                .answer
                .map(|answer| format!("- 问题：{}\n  用户决定：{}", request.question, answer))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let resolved_decisions = if resolved_decisions.is_empty() {
        "无。".to_string()
    } else {
        resolved_decisions
    };
    let output_artifacts = match contract.output_artifact_directory.as_deref() {
        Some(directory) => {
            let expected_paths = contract
                .expected_artifacts
                .iter()
                .map(|artifact| {
                    format!(
                        "- {}：{}",
                        artifact,
                        PathBuf::from(directory).join(artifact).display()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "预期产物只能写入成果目录 {}。必须严格按下列完整路径创建文件（包含相对目录层级）：\n{}\n该目录位于项目工作区之外，不属于项目源码；不得向其他位置写入。",
                directory, expected_paths
            )
        }
        None => "无需写入外部成果目录。".to_string(),
    };
    let task_worktree = contract
        .worktree_path
        .as_deref()
        .unwrap_or("未创建；本步骤在项目工作区根目录只读执行");
    let mode_constraints = if task.execution_mode == "readonly" {
        let context_name = if contract.execution_context == EXECUTION_CONTEXT_WORKSPACE_ROOT {
            "项目工作区根目录"
        } else {
            "任务 worktree"
        };
        format!(
            "- Agent 已从本任务契约目录启动；本步骤的只读对象是{}：{}。\n- 项目文件只能读取，不得修改、创建或删除；不得创建 Git 提交。\n- 若配置了外部成果目录，只能在该目录写入预期产物。若发现阻断问题，请在最终结论中明确说明。",
            context_name, contract.working_directory
        )
    } else {
        format!(
            "- Agent 已从本任务 worktree 启动：{}。\n- 项目工作区根目录仅用于理解项目上下文，严禁在其中或其他目录修改项目文件。\n- 只能修改 worktree 中的这些相对路径：{}\n- 完成后必须只在当前任务分支创建本地 Git 提交；未提交改动不能进入下一步骤。",
            contract.working_directory, allowed_paths
        )
    };
    Ok(format!(
        "你正在执行一项由 TerminalBuddy 调度的用户项目任务。TerminalBuddy 只是调度平台，不是本任务要搜索、读取或修改的代码仓库；任务对象只限下方列出的项目工作区、任务 worktree 与成果目录。\n\n任务：{}\n说明：{}\n\n执行位置：\n- Agent 当前工作目录：{}\n- 项目工作区根目录：{}\n- 本任务 worktree：{}\n\n当前编排步骤的通用任务提示词：\n{}\n\n前置步骤结论：\n{}\n\n用户已做出的决策：\n{}\n\n不可变约束：\n{}\n- Windows 源码、任务说明和结果文件均使用 UTF-8。使用 PowerShell 读取或写入文件时，必须显式指定 `-Encoding UTF8`；不得使用默认编码读取包含中文的源码。\n- 终端输出只保留简短的进度、结论、执行过的验证及必要报错。禁止回显完整源码、配置、构建日志、JSON 或命令输出；检索时限制结果数量，读取文件时只读取所需片段，其余输出重定向或丢弃。\n- 禁止访问或修改其他服务仓库。\n- 禁止执行 git push、创建 Pull Request、部署、强制推送或破坏性操作。\n\n输入成果：{}\n预期产物：{}\n成果写入：{}\n验收命令：{}\n\n完成后简要说明结论、改动或发现、执行过的验证和仍存在的风险。确认任务与沟通均结束后，请退出当前 CLI；TerminalBuddy 会在 CLI 退出后推进下一编排步骤。",
        task.title,
        task.description,
        contract.working_directory,
        project.workspace_root,
        task_worktree,
        workflow_prompt,
        dependency_summaries,
        resolved_decisions,
        mode_constraints,
        input_artifacts,
        artifacts,
        output_artifacts,
        checks,
    ))
}

struct TerminalControl {
    prompt_path: PathBuf,
    exit_marker: PathBuf,
    result_path: PathBuf,
    final_message_path: PathBuf,
    transcript_path: PathBuf,
    decision_path: PathBuf,
    review_path: PathBuf,
    review_schema_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentDecisionFile {
    question: String,
    impact: String,
    #[serde(default)]
    options: Vec<AiDecisionOption>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowReviewFile {
    approved: bool,
    comments: String,
}

fn prepare_terminal_control(
    run_id: &str,
    display_label: Option<&str>,
    prompt: &str,
) -> Result<TerminalControl, String> {
    let directory = AiDeliveryService::entity_dir(TERMINAL_RUNS_DIR)
        .join(make_terminal_run_dir_name(run_id, display_label));
    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建 Agent 终端控制目录失败: {}", error))?;
    let prompt_path = directory.join("prompt.txt");
    let exit_marker = directory.join("exit-code.txt");
    let result_path = directory.join("plan.json");
    let final_message_path = directory.join("final-message.txt");
    let transcript_path = directory.join("transcript.log");
    let decision_path = directory.join("decision.json");
    let review_path = directory.join("review.json");
    let review_schema_path = directory.join("review-schema.json");
    fs::write(&prompt_path, prompt)
        .map_err(|error| format!("写入 Agent 任务说明失败: {}", error))?;
    for stale_path in [
        &exit_marker,
        &result_path,
        &final_message_path,
        &transcript_path,
        &decision_path,
        &review_path,
        &review_schema_path,
    ] {
        if stale_path.exists() {
            fs::remove_file(stale_path)
                .map_err(|error| format!("清理 Agent 终端控制文件失败: {}", error))?;
        }
    }
    Ok(TerminalControl {
        prompt_path,
        exit_marker,
        result_path,
        final_message_path,
        transcript_path,
        decision_path,
        review_path,
        review_schema_path,
    })
}

fn read_agent_decision(path: &Path) -> Result<Option<AgentDecisionFile>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取 Agent 决策文件失败: {}", error))?;
    let decision = serde_json::from_str::<AgentDecisionFile>(content.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("解析 Agent 决策文件失败: {}", error))?;
    if decision.question.trim().is_empty() || decision.impact.trim().is_empty() {
        return Err("Agent 决策文件中的问题和影响说明不能为空".to_string());
    }
    Ok(Some(decision))
}

fn read_workflow_review(path: &Path) -> Result<WorkflowReviewFile, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "读取 Reviewer 结论文件失败（必须写入 review.json）: {}",
            error
        )
    })?;
    let review = serde_json::from_str::<WorkflowReviewFile>(content.trim_start_matches('﻿'))
        .map_err(|error| format!("Reviewer 结论文件不符合协议: {}", error))?;
    if review.comments.trim().is_empty() {
        return Err("Reviewer 结论必须包含 comments".to_string());
    }
    Ok(review)
}

#[cfg(test)]
mod agent_decision_tests {
    use super::*;

    #[test]
    fn reads_strict_agent_decision_file() {
        let path =
            std::env::temp_dir().join(format!("terminal-buddy-decision-{}.json", Uuid::new_v4()));
        fs::write(
            &path,
            r#"{"question":"选择数据源","impact":"无法确定接口实现","options":[{"label":"方案 A","description":"使用现有接口"}]}"#,
        )
        .unwrap();
        let decision = read_agent_decision(&path).unwrap().unwrap();
        let _ = fs::remove_file(&path);
        assert_eq!(decision.question, "选择数据源");
        assert_eq!(decision.options.len(), 1);
    }

    #[test]
    fn rejects_unknown_agent_decision_fields() {
        let path =
            std::env::temp_dir().join(format!("terminal-buddy-decision-{}.json", Uuid::new_v4()));
        fs::write(
            &path,
            r#"{"question":"选择数据源","impact":"无法确定接口实现","unexpected":true}"#,
        )
        .unwrap();
        let result = read_agent_decision(&path);
        let _ = fs::remove_file(&path);
        assert!(result.is_err());
    }

    #[test]
    fn normalizes_quality_gate_commands() {
        let gate = normalize_quality_gate(AiQualityGate {
            commands: vec![
                "  npm run build  ".to_string(),
                "".to_string(),
                "npm test".to_string(),
            ],
        })
        .unwrap();
        assert_eq!(gate.commands, vec!["npm run build", "npm test"]);
    }

    #[test]
    fn rejects_empty_quality_gate() {
        assert!(normalize_quality_gate(AiQualityGate {
            commands: vec!["  ".to_string()],
        })
        .is_err());
    }

    #[test]
    fn scans_frontend_and_backend_quality_manifests() {
        let root = std::env::temp_dir().join(format!(
            "terminal-buddy-quality-scan-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(root.join("web")).unwrap();
        fs::create_dir_all(root.join("server/src-tauri")).unwrap();
        fs::write(
            root.join("web/package.json"),
            r#"{"name":"web","scripts":{"dev":"vite","build":"tsc && vite build","test":"vitest run"}}"#,
        )
        .unwrap();
        fs::write(root.join("web/pnpm-lock.yaml"), "lockfileVersion: '9.0'\n").unwrap();
        fs::write(
            root.join("server/src-tauri/Cargo.toml"),
            "[package]\nname = \"server\"\n",
        )
        .unwrap();

        let manifests = scan_quality_manifests(&root);
        let web_package = manifests
            .iter()
            .find(|manifest| manifest.relative_path == "web/package.json")
            .unwrap();
        assert_eq!(
            web_package.scripts.as_ref(),
            Some(&vec![
                "build".to_string(),
                "dev".to_string(),
                "test".to_string()
            ])
        );
        assert!(manifests
            .iter()
            .any(|manifest| manifest.relative_path == "server/src-tauri/Cargo.toml"));

        let web_stacks = detect_repository_stacks("web", &manifests);
        assert!(web_stacks.contains(&"frontend".to_string()));
        assert!(web_stacks.contains(&"typescript/javascript".to_string()));

        let server_stacks = detect_repository_stacks("server", &manifests);
        assert!(server_stacks.contains(&"backend".to_string()));
        assert!(server_stacks.contains(&"rust".to_string()));
        assert!(server_stacks.contains(&"desktop".to_string()));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quality_gate_prompt_covers_repositories_and_forbids_destructive_commands() {
        let contexts = vec![RepositoryQualityContext {
            name: "web".to_string(),
            relative_path: "web".to_string(),
            default_branch: "main".to_string(),
            stacks: vec!["frontend".to_string()],
            manifests: vec![QualityManifest {
                relative_path: "web/package.json".to_string(),
                scripts: Some(vec!["build".to_string(), "test".to_string()]),
            }],
        }];
        let prompt = build_quality_gate_prompt(
            &contexts,
            Path::new(r"D:\project"),
            Path::new(r"D:\result.json"),
            Path::new(r"D:\schema.json"),
            false,
        );
        assert!(prompt.contains("web/package.json"));
        assert!(prompt.contains("git push"));
        assert!(prompt.contains("D:\\result.json"));

        let codex_prompt = build_quality_gate_prompt(
            &contexts,
            Path::new(r"D:\project"),
            Path::new(r"D:\result.json"),
            Path::new(r"D:\schema.json"),
            true,
        );
        assert!(codex_prompt.contains("最终响应必须只包含 JSON"));
        assert!(!codex_prompt.contains("必须使用文件工具把最终 JSON 原样写入"));
    }

    #[cfg(windows)]
    #[test]
    fn probes_runtime_from_absolute_cmd_path() {
        let directory =
            std::env::temp_dir().join(format!("terminal-buddy-runtime-probe-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let command = directory.join("custom-runtime.cmd");
        fs::write(&command, "@echo off\r\necho custom-runtime 1.0\r\n").unwrap();

        let probe = probe_local_runtime("custom", command.to_string_lossy().as_ref());
        let _ = fs::remove_dir_all(&directory);

        assert!(probe.available);
        assert_eq!(probe.command, command.to_string_lossy());
        assert_eq!(probe.version.as_deref(), Some("custom-runtime 1.0"));
    }

    #[test]
    fn reads_workflow_reviewer_result() {
        let path =
            std::env::temp_dir().join(format!("terminal-buddy-review-{}.json", Uuid::new_v4()));
        fs::write(
            &path,
            r#"{"approved":false,"comments":"需要补充边界条件测试"}"#,
        )
        .unwrap();
        let review = read_workflow_review(&path).unwrap();
        let _ = fs::remove_file(&path);
        assert!(!review.approved);
        assert_eq!(review.comments, "需要补充边界条件测试");
    }

    #[test]
    fn rejects_invalid_workflow_reviewer_result() {
        let path =
            std::env::temp_dir().join(format!("terminal-buddy-review-{}.json", Uuid::new_v4()));
        fs::write(&path, r#"{"approved":true,"unexpected":true}"#).unwrap();
        let result = read_workflow_review(&path);
        let _ = fs::remove_file(&path);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_descriptive_or_unsafe_artifact_paths() {
        assert!(validate_artifact_paths(
            &["任务分析结论：接口依赖和风险".to_string()],
            "交付物",
        )
        .is_err());
        assert!(validate_artifact_paths(&["../outside.md".to_string()], "交付物").is_err());
        assert!(validate_artifact_paths(&["analysis/result.md".to_string()], "交付物").is_ok());
    }

    #[test]
    fn upgrades_legacy_standard_workflow_execution_contexts() {
        let mut workflow = AiWorkflow {
            id: "workflow".to_string(),
            name: "标准交付流程".to_string(),
            description: String::new(),
            steps: vec![
                crate::models::AiWorkflowStep {
                    id: "analysis".to_string(),
                    name: "任务分析".to_string(),
                    role_id: None,
                    agent_id: String::new(),
                    execution_mode: "write".to_string(),
                    execution_context: String::new(),
                    prompt: String::new(),
                },
                crate::models::AiWorkflowStep {
                    id: "review".to_string(),
                    name: "功能测试、Code Review".to_string(),
                    role_id: None,
                    agent_id: String::new(),
                    execution_mode: "readonly".to_string(),
                    execution_context: String::new(),
                    prompt: String::new(),
                },
                crate::models::AiWorkflowStep {
                    id: "implementation".to_string(),
                    name: "编码实现".to_string(),
                    role_id: None,
                    agent_id: String::new(),
                    execution_mode: "write".to_string(),
                    execution_context: String::new(),
                    prompt: String::new(),
                },
            ],
            created_at: String::new(),
            updated_at: String::new(),
        };

        assert!(upgrade_legacy_workflow_steps(&mut workflow));
        assert_eq!(workflow.steps[0].execution_mode, "readonly");
        assert_eq!(workflow.steps[0].execution_context, EXECUTION_CONTEXT_WORKSPACE_ROOT);
        assert_eq!(workflow.steps[1].execution_mode, "readonly");
        assert_eq!(workflow.steps[1].execution_context, EXECUTION_CONTEXT_TASK_WORKTREE);
        assert_eq!(workflow.steps[2].execution_mode, "write");
        assert_eq!(workflow.steps[2].execution_context, EXECUTION_CONTEXT_TASK_WORKTREE);
    }

    #[test]
    fn replans_legacy_delivery_without_overwriting_history() {
        let root = std::env::temp_dir().join(format!("terminal-buddy-replan-{}", Uuid::new_v4()));
        PathService::set_test_data_dir(Some(root.join("data")));
        let now = chrono::Utc::now().to_rfc3339();
        let project = AiProject {
            id: "project".to_string(),
            name: "测试项目".to_string(),
            workspace_root: root.to_string_lossy().to_string(),
            repositories: Vec::new(),
            profile_id: None,
            worktree_root: None,
            quality_gate: AiQualityGate::default(),
            manager_agent_id: None,
            max_concurrency: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        AiDeliveryService::save(PROJECTS_DIR, &project.id, &project).unwrap();
        let workflow = AiWorkflow {
            id: "workflow".to_string(),
            name: "标准交付流程".to_string(),
            description: String::new(),
            steps: vec![crate::models::AiWorkflowStep {
                id: "analysis".to_string(),
                name: "任务分析".to_string(),
                role_id: None,
                agent_id: String::new(),
                execution_mode: "write".to_string(),
                execution_context: String::new(),
                prompt: String::new(),
            }],
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        AiDeliveryService::save(WORKFLOWS_DIR, &workflow.id, &workflow).unwrap();
        let mut delivery = AiDeliveryService::create_delivery(CreateAiDeliveryInput {
            project_id: project.id.clone(),
            title: "旧交付".to_string(),
            requirement: "验证重新规划".to_string(),
            manager_agent_id: None,
            workflow_id: Some(workflow.id.clone()),
        })
        .unwrap();
        let task = AiTaskNode {
            id: "legacy-task".to_string(),
            delivery_id: delivery.id.clone(),
            title: "旧分析任务".to_string(),
            description: "旧交付物是描述文本".to_string(),
            role_id: None,
            workflow_step_id: Some("analysis".to_string()),
            preferred_agent_id: None,
            task_prompt: String::new(),
            execution_mode: "write".to_string(),
            execution_context: String::new(),
            target_repository_id: String::new(),
            allowed_write_paths: vec![".".to_string()],
            dependency_ids: Vec::new(),
            input_artifacts: Vec::new(),
            expected_artifacts: vec!["任务分析结论：风险与验收标准".to_string()],
            acceptance_commands: Vec::new(),
            retry_count: 0,
            timeout_seconds: None,
            state: "failed".to_string(),
            assigned_agent_id: None,
            contract_id: None,
            attempt_ids: Vec::new(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        AiDeliveryService::save(TASK_NODES_DIR, &task.id, &task).unwrap();
        delivery.task_node_ids.push(task.id.clone());
        delivery.state = "running".to_string();
        AiDeliveryService::save(DELIVERIES_DIR, &delivery.id, &delivery).unwrap();

        let replacement = AiDeliveryService::replan_legacy_delivery(
            &delivery.id,
            TerminalService::new(),
        )
        .unwrap();
        assert_eq!(replacement.state, "drafting");
        assert_ne!(replacement.id, delivery.id);
        assert_eq!(AiDeliveryService::get_delivery(&delivery.id).unwrap().state, "cancelled");
        assert_eq!(AiDeliveryService::get_task_node(&task.id).unwrap().state, "cancelled");
        let upgraded = AiDeliveryService::get::<AiWorkflow>(WORKFLOWS_DIR, &workflow.id, "任务编排").unwrap();
        assert_eq!(upgraded.steps[0].execution_mode, "readonly");
        assert_eq!(upgraded.steps[0].execution_context, EXECUTION_CONTEXT_WORKSPACE_ROOT);

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn allocates_a_task_worktree_in_an_isolated_project() {
        let root = std::env::temp_dir().join(format!("terminal-buddy-ai-e2e-{}", Uuid::new_v4()));
        let data_dir = root.join("data");
        let workspace = root.join("workspace");
        let repository = workspace.join("service-a");
        fs::create_dir_all(&repository).unwrap();
        PathService::set_test_data_dir(Some(data_dir));

        let run = |arguments: &[&str]| {
            let output = Command::new("git")
                .args(arguments)
                .current_dir(&repository)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {} failed: {}",
                arguments.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init"]);
        run(&["config", "user.name", "TerminalBuddy Test"]);
        run(&["config", "user.email", "test@terminalbuddy.local"]);
        fs::write(repository.join("README.md"), "# service-a\n").unwrap();
        run(&["add", "README.md"]);
        run(&["commit", "-m", "initial"]);

        let now = chrono::Utc::now().to_rfc3339();
        let runtime = AiDeliveryService::save_runtime(AiAgentRuntime {
            id: String::new(),
            name: "测试 Runtime".to_string(),
            kind: "test".to_string(),
            command: "cmd".to_string(),
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .unwrap();
        let agent = AiDeliveryService::save_agent(AiAgent {
            id: String::new(),
            name: "测试 Agent".to_string(),
            runtime_id: runtime.id,
            runtime_args: Vec::new(),
            startup_preset_name: None,
            max_concurrency: 1,
            enabled: true,
            default_timeout_seconds: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .unwrap();
        let project = AiDeliveryService::create_project(CreateAiProjectInput {
            name: "测试项目".to_string(),
            workspace_root: workspace.to_string_lossy().to_string(),
            profile_id: None,
            worktree_root: None,
            quality_gate: AiQualityGate {
                commands: vec!["git status --porcelain".to_string()],
            },
            manager_agent_id: None,
            max_concurrency: 1,
        })
        .unwrap();
        let repository_baseline = project_repository_statuses(&project).unwrap();
        fs::write(repository.join("README.md"), "manager changed source\n").unwrap();
        assert!(
            ensure_project_repository_statuses_unchanged(&project, &repository_baseline).is_err()
        );
        run(&["checkout", "--", "README.md"]);
        let delivery = AiDeliveryService::create_delivery(CreateAiDeliveryInput {
            project_id: project.id.clone(),
            title: "测试交付".to_string(),
            requirement: "验证任务 worktree 分配".to_string(),
            manager_agent_id: None,
            workflow_id: None,
        })
        .unwrap();
        let task = AiDeliveryService::create_task_node(CreateAiTaskNodeInput {
            delivery_id: delivery.id.clone(),
            title: "实现测试".to_string(),
            description: "创建独立 worktree".to_string(),
            role_id: None,
            workflow_step_id: None,
            preferred_agent_id: Some(agent.id.clone()),
            task_prompt: String::new(),
            execution_mode: "write".to_string(),
            execution_context: EXECUTION_CONTEXT_TASK_WORKTREE.to_string(),
            target_repository_id: project.repositories[0].id.clone(),
            allowed_write_paths: vec!["README.md".to_string()],
            dependency_ids: Vec::new(),
            input_artifacts: Vec::new(),
            expected_artifacts: Vec::new(),
            acceptance_commands: Vec::new(),
            retry_count: 0,
            timeout_seconds: None,
        })
        .unwrap();
        AiDeliveryService::approve_delivery(&delivery.id).unwrap();
        let attempt = AiDeliveryService::dispatch_task_node(&task.id, None).unwrap();
        let contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &attempt.contract_id,
            "任务契约",
        )
        .unwrap();
        let decision = AiDeliveryService::create_decision_request(CreateAiDecisionRequestInput {
            delivery_id: delivery.id.clone(),
            task_node_id: Some(task.id.clone()),
            question: "选择数据格式".to_string(),
            impact: "决定接口兼容方式".to_string(),
            options: Vec::new(),
        })
        .unwrap();
        AiDeliveryService::answer_decision_request(&decision.id, "使用 JSON 格式").unwrap();
        let prompt = build_agent_prompt(&task, &contract, &project).unwrap();
        assert!(prompt.contains("用户决定：使用 JSON 格式"));
        assert!(prompt.contains(&project.workspace_root));
        assert!(prompt.contains(contract.worktree_path.as_deref().unwrap()));
        let worktree = PathBuf::from(contract.worktree_path.clone().unwrap());
        fs::write(worktree.join("out-of-scope.txt"), "not allowed\n").unwrap();
        assert!(audit_contract_scope(&project, &contract).unwrap().is_some());
        fs::remove_file(worktree.join("out-of-scope.txt")).unwrap();
        let branch = contract.branch_name.unwrap();
        assert!(worktree.is_dir());
        let expected_worktree_root =
            repository_worktree_base_path(&project, &project.repositories[0]).unwrap();
        assert!(worktree.starts_with(expected_worktree_root));
        assert!(repository_status(&repository).unwrap().is_empty());
        assert!(AiDeliveryService::delete_delivery(&delivery.id).is_err());

        let mut completed_attempt =
            AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, &attempt.id, "执行尝试").unwrap();
        completed_attempt.state = "completed".to_string();
        AiDeliveryService::save(ATTEMPTS_DIR, &completed_attempt.id, &completed_attempt).unwrap();
        let mut completed_task = AiDeliveryService::get_task_node(&task.id).unwrap();
        completed_task.state = "succeeded".to_string();
        AiDeliveryService::save(TASK_NODES_DIR, &completed_task.id, &completed_task).unwrap();

        let analysis_delivery = AiDeliveryService::create_delivery(CreateAiDeliveryInput {
            project_id: project.id.clone(),
            title: "分析交付".to_string(),
            requirement: "验证只读分析任务的交付物契约".to_string(),
            manager_agent_id: None,
            workflow_id: None,
        })
        .unwrap();
        let analysis_task = AiDeliveryService::create_task_node(CreateAiTaskNodeInput {
            delivery_id: analysis_delivery.id.clone(),
            title: "任务分析".to_string(),
            description: "仅分析现有实现并产出结论".to_string(),
            role_id: None,
            workflow_step_id: Some("analysis".to_string()),
            preferred_agent_id: Some(agent.id.clone()),
            task_prompt: "仅分析，不得修改项目源码。".to_string(),
            execution_mode: "readonly".to_string(),
            execution_context: EXECUTION_CONTEXT_WORKSPACE_ROOT.to_string(),
            target_repository_id: project.repositories[0].id.clone(),
            allowed_write_paths: vec![".".to_string()],
            dependency_ids: Vec::new(),
            input_artifacts: Vec::new(),
            expected_artifacts: vec!["analysis/service-a.md".to_string()],
            acceptance_commands: Vec::new(),
            retry_count: 0,
            timeout_seconds: None,
        })
        .unwrap();
        AiDeliveryService::approve_delivery(&analysis_delivery.id).unwrap();
        let analysis_attempt = AiDeliveryService::dispatch_task_node(&analysis_task.id, None).unwrap();
        let mut analysis_contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &analysis_attempt.contract_id,
            "任务契约",
        )
        .unwrap();
        assert_eq!(analysis_contract.execution_context, EXECUTION_CONTEXT_WORKSPACE_ROOT);
        assert_eq!(analysis_contract.working_directory, project.workspace_root);
        assert!(analysis_contract.worktree_path.is_none());
        let analysis_output_directory = PathBuf::from(
            analysis_contract.output_artifact_directory.as_deref().unwrap(),
        );
        assert!(analysis_output_directory.is_dir());
        let analysis_prompt = build_agent_prompt(&analysis_task, &analysis_contract, &project).unwrap();
        assert!(analysis_prompt.contains("项目文件只能读取"));
        assert!(analysis_prompt.contains("analysis/service-a.md"));
        assert!(analysis_prompt.contains(analysis_output_directory.to_string_lossy().as_ref()));
        let mut completed_analysis_attempt = AiDeliveryService::get::<AiAttempt>(
            ATTEMPTS_DIR,
            &analysis_attempt.id,
            "执行尝试",
        )
        .unwrap();
        completed_analysis_attempt.state = "completed".to_string();
        AiDeliveryService::save(
            ATTEMPTS_DIR,
            &completed_analysis_attempt.id,
            &completed_analysis_attempt,
        )
        .unwrap();
        let mut completed_analysis_task = AiDeliveryService::get_task_node(&analysis_task.id).unwrap();
        completed_analysis_task.state = "succeeded".to_string();
        AiDeliveryService::save(
            TASK_NODES_DIR,
            &completed_analysis_task.id,
            &completed_analysis_task,
        )
        .unwrap();
        analysis_contract.state = "completed".to_string();
        AiDeliveryService::save(CONTRACTS_DIR, &analysis_contract.id, &analysis_contract).unwrap();

        let mut editable_delivery = AiDeliveryService::get_delivery(&delivery.id).unwrap();
        editable_delivery.state = "awaitingApproval".to_string();
        AiDeliveryService::save(DELIVERIES_DIR, &editable_delivery.id, &editable_delivery).unwrap();
        let downstream_task = AiDeliveryService::create_task_node(CreateAiTaskNodeInput {
            delivery_id: delivery.id.clone(),
            title: "使用前置成果".to_string(),
            description: "验证输入成果失败后回收资源".to_string(),
            role_id: None,
            workflow_step_id: None,
            preferred_agent_id: Some(agent.id.clone()),
            task_prompt: String::new(),
            execution_mode: "write".to_string(),
            execution_context: EXECUTION_CONTEXT_TASK_WORKTREE.to_string(),
            target_repository_id: project.repositories[0].id.clone(),
            allowed_write_paths: vec!["README.md".to_string()],
            dependency_ids: vec![task.id.clone()],
            input_artifacts: vec!["missing-artifact.txt".to_string()],
            expected_artifacts: Vec::new(),
            acceptance_commands: Vec::new(),
            retry_count: 0,
            timeout_seconds: None,
        })
        .unwrap();
        editable_delivery.state = "running".to_string();
        AiDeliveryService::save(DELIVERIES_DIR, &editable_delivery.id, &editable_delivery).unwrap();
        AiDeliveryService::refresh_ready_task_nodes(&delivery.id).unwrap();
        assert!(AiDeliveryService::dispatch_task_node(&downstream_task.id, None).is_err());
        let downstream_contract = AiDeliveryService::get_all_task_contracts(Some(&project.id))
            .unwrap()
            .into_iter()
            .find(|item| item.task_id == downstream_task.id)
            .unwrap();
        assert!(downstream_contract.worktree_path.is_none());
        assert!(!PathBuf::from(&downstream_contract.working_directory).exists());

        let cancelled_delivery = AiDeliveryService::create_delivery(CreateAiDeliveryInput {
            project_id: project.id.clone(),
            title: "终止测试交付".to_string(),
            requirement: "验证终止时回收状态".to_string(),
            manager_agent_id: None,
            workflow_id: None,
        })
        .unwrap();
        let cancelled_task = AiDeliveryService::create_task_node(CreateAiTaskNodeInput {
            delivery_id: cancelled_delivery.id.clone(),
            title: "终止测试任务".to_string(),
            description: "创建后终止".to_string(),
            role_id: None,
            workflow_step_id: None,
            preferred_agent_id: Some(agent.id.clone()),
            task_prompt: String::new(),
            execution_mode: "write".to_string(),
            execution_context: EXECUTION_CONTEXT_TASK_WORKTREE.to_string(),
            target_repository_id: project.repositories[0].id.clone(),
            allowed_write_paths: vec!["README.md".to_string()],
            dependency_ids: Vec::new(),
            input_artifacts: Vec::new(),
            expected_artifacts: Vec::new(),
            acceptance_commands: Vec::new(),
            retry_count: 0,
            timeout_seconds: None,
        })
        .unwrap();
        AiDeliveryService::approve_delivery(&cancelled_delivery.id).unwrap();
        let cancelled_attempt =
            AiDeliveryService::dispatch_task_node(&cancelled_task.id, None).unwrap();
        let cancelled_contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &cancelled_attempt.contract_id,
            "任务契约",
        )
        .unwrap();
        let cancelled_worktree = PathBuf::from(cancelled_contract.worktree_path.clone().unwrap());
        let cancelled_branch = cancelled_contract.branch_name.clone().unwrap();
        let cancelled =
            AiDeliveryService::cancel_delivery(&cancelled_delivery.id, TerminalService::new())
                .unwrap();
        assert_eq!(cancelled.state, "cancelled");
        assert_eq!(
            AiDeliveryService::get_task_node(&cancelled_task.id)
                .unwrap()
                .state,
            "cancelled"
        );
        assert_eq!(
            AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, &cancelled_attempt.id, "执行尝试")
                .unwrap()
                .state,
            "cancelled"
        );
        assert_eq!(
            AiDeliveryService::get::<AiTaskContract>(
                CONTRACTS_DIR,
                &cancelled_attempt.contract_id,
                "任务契约"
            )
            .unwrap()
            .state,
            "cancelled"
        );

        assert!(AiDeliveryService::delete_project(&project.id).is_err());
        let mut completed_contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &attempt.contract_id,
            "任务契约",
        )
        .unwrap();
        completed_contract.state = "completed".to_string();
        AiDeliveryService::save(CONTRACTS_DIR, &completed_contract.id, &completed_contract)
            .unwrap();
        let mut completed_downstream_contract = downstream_contract;
        completed_downstream_contract.state = "completed".to_string();
        AiDeliveryService::save(
            CONTRACTS_DIR,
            &completed_downstream_contract.id,
            &completed_downstream_contract,
        )
        .unwrap();
        AiDeliveryService::delete_project(&project.id).unwrap();
        assert!(AiDeliveryService::get_project(&project.id).is_err());
        assert!(AiDeliveryService::get_all_deliveries(Some(&project.id))
            .unwrap()
            .is_empty());
        assert!(AiDeliveryService::get_all_task_contracts(Some(&project.id))
            .unwrap()
            .is_empty());

        cleanup_unallocated_task_worktree(&repository, &worktree, &branch);
        cleanup_unallocated_task_worktree(&repository, &cancelled_worktree, &cancelled_branch);
        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }
}

fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn split_runtime_command(command: &str) -> Result<Vec<String>, String> {
    let command = command.trim();
    if Path::new(command).is_file() {
        return Ok(vec![command.to_string()]);
    }
    let parts = shell_words::split(command)
        .map_err(|error| format!("解析 Runtime 命令失败: {}", error))?;
    if parts.is_empty() {
        return Err("Runtime 命令不能为空".to_string());
    }
    Ok(parts)
}

fn runtime_kind_matches(runtime: &AiAgentRuntime, executable: &str, kind: &str) -> bool {
    runtime.kind.trim().eq_ignore_ascii_case(kind)
        || Path::new(executable)
            .file_stem()
            .is_some_and(|name| name.eq_ignore_ascii_case(kind))
}

fn runtime_is_codex(runtime: &AiAgentRuntime) -> bool {
    split_runtime_command(&runtime.command)
        .ok()
        .and_then(|parts| parts.first().cloned())
        .is_some_and(|executable| runtime_kind_matches(runtime, &executable, "codex"))
}

fn wrap_terminal_command(
    invocation: &str,
    control: &TerminalControl,
    final_message_path: Option<&Path>,
    transcript_path: Option<&Path>,
) -> String {
    let completion_output = match (final_message_path, transcript_path) {
        (Some(final_message_path), Some(transcript_path)) => format!(
            " if (Test-Path -LiteralPath {}) {{ Get-Content -LiteralPath {} -Raw -Encoding UTF8 }} elseif (Test-Path -LiteralPath {}) {{ Get-Content -LiteralPath {} -Tail 40 -Encoding UTF8 }}",
            powershell_literal(final_message_path.to_string_lossy().as_ref()),
            powershell_literal(final_message_path.to_string_lossy().as_ref()),
            powershell_literal(transcript_path.to_string_lossy().as_ref()),
            powershell_literal(transcript_path.to_string_lossy().as_ref()),
        ),
        _ => String::new(),
    };
    format!(
        "{}; $tbSucceeded = $?; $tbExit = $LASTEXITCODE; if ($null -eq $tbExit) {{ if ($tbSucceeded) {{ $tbExit = 0 }} else {{ $tbExit = 1 }} }};{}; Set-Content -LiteralPath {} -Value $tbExit; Write-Host \"`n[TerminalBuddy] Agent 已退出，退出码 $tbExit。终端将保留供查看。\"",
        invocation,
        completion_output,
        powershell_literal(control.exit_marker.to_string_lossy().as_ref()),
    )
}

fn build_interactive_terminal_command(
    runtime: &AiAgentRuntime,
    agent: &AiAgent,
    control: &TerminalControl,
) -> Result<String, String> {
    build_interactive_terminal_command_with_codex_output(
        runtime,
        agent,
        control,
        None,
        None,
        &[],
    )
}

fn build_interactive_terminal_command_with_codex_output(
    runtime: &AiAgentRuntime,
    agent: &AiAgent,
    control: &TerminalControl,
    codex_output_schema: Option<&Path>,
    codex_output_path: Option<&Path>,
    codex_writable_directories: &[PathBuf],
) -> Result<String, String> {
    let mut command_parts = split_runtime_command(&runtime.command)?;
    let executable = command_parts.remove(0);
    let is_codex = runtime_kind_matches(runtime, &executable, "codex");
    let is_claude = runtime_kind_matches(runtime, &executable, "claude");
    let is_opencode = runtime_kind_matches(runtime, &executable, "opencode");
    let is_hermes = runtime_kind_matches(runtime, &executable, "hermes");
    let is_pi = runtime_kind_matches(runtime, &executable, "pi");
    let is_mimo = runtime_kind_matches(runtime, &executable, "mimo");
    let is_kimi = runtime_kind_matches(runtime, &executable, "kimi");
    if is_codex && !command_parts.iter().any(|argument| argument == "exec") {
        command_parts.push("exec".to_string());
    }
    // AI 交付从用户选择的工作区根目录启动，该目录可以包含多个仓库而自身不是 Git 仓库。
    if is_codex
        && !command_parts
            .iter()
            .any(|argument| argument == "--skip-git-repo-check")
        && !agent
            .runtime_args
            .iter()
            .any(|argument| argument == "--skip-git-repo-check")
    {
        command_parts.push("--skip-git-repo-check".to_string());
    }
    if is_opencode && !command_parts.iter().any(|argument| argument == "run") {
        command_parts.push("run".to_string());
    }
    let pipes_prompt_to_stdin = is_codex || is_claude || is_pi || is_mimo;
    let mut invocation = if pipes_prompt_to_stdin {
        format!(
            "$tbPrompt = Get-Content -LiteralPath {} -Raw -Encoding UTF8; $OutputEncoding = [System.Text.UTF8Encoding]::new($false); $tbPrompt | & {}",
            powershell_literal(control.prompt_path.to_string_lossy().as_ref()),
            powershell_literal(&executable),
        )
    } else {
        format!(
            "$tbPrompt = Get-Content -LiteralPath {} -Raw -Encoding UTF8; & {}",
            powershell_literal(control.prompt_path.to_string_lossy().as_ref()),
            powershell_literal(&executable),
        )
    };
    for argument in &command_parts {
        invocation.push(' ');
        invocation.push_str(&powershell_literal(argument));
    }
    for argument in &agent.runtime_args {
        invocation.push(' ');
        invocation.push_str(&powershell_literal(argument));
    }
    let captures_one_shot_output = is_codex || is_claude || is_opencode || is_hermes || is_pi || is_mimo || is_kimi;
    let codex_final_message_path =
        codex_output_path.unwrap_or(control.final_message_path.as_path());
    if is_codex {
        let has_sandbox_mode = command_parts
            .iter()
            .chain(agent.runtime_args.iter())
            .any(|argument| {
                argument == "--sandbox"
                    || argument == "-s"
                    || argument.starts_with("--sandbox=")
                    || argument == "--full-auto"
            });
        if !codex_writable_directories.is_empty() && !has_sandbox_mode {
            invocation.push_str(" '--sandbox' 'workspace-write'");
        }
        for (index, directory) in codex_writable_directories.iter().enumerate() {
            if codex_writable_directories[..index].contains(directory) {
                continue;
            }
            invocation.push_str(" '--add-dir' ");
            invocation.push_str(&powershell_literal(
                normalize_path_for_external_process(directory)
                    .to_string_lossy()
                    .as_ref(),
            ));
        }
        if let Some(schema_path) = codex_output_schema {
            invocation.push_str(" '--output-schema' ");
            invocation.push_str(&powershell_literal(
                schema_path.to_string_lossy().as_ref(),
            ));
        }
        invocation.push_str(" '--output-last-message' ");
        invocation.push_str(&powershell_literal(
            codex_final_message_path.to_string_lossy().as_ref(),
        ));
        invocation.push_str(" '-' 2>&1 | Out-File -LiteralPath ");
        invocation.push_str(&powershell_literal(
            control.transcript_path.to_string_lossy().as_ref(),
        ));
        invocation.push_str(" -Encoding UTF8");
    } else if is_claude || is_pi || is_mimo {
        invocation.push_str(" '--print'");
    } else if is_kimi {
        invocation.push_str(" '--prompt' (Get-Content -LiteralPath ");
        invocation.push_str(&powershell_literal(control.prompt_path.to_string_lossy().as_ref()));
        invocation.push_str(" -Raw -Encoding UTF8)");
    } else if is_hermes {
        if command_parts.iter().any(|argument| argument == "chat") {
            invocation.push_str(" '--quiet' '--query' $tbPrompt");
        } else {
            invocation.push_str(" '--oneshot' $tbPrompt");
        }
    } else if is_opencode {
        // opencode.cmd 在 Windows 下会将多行位置参数截断为首行；用附件传递完整任务契约。
        invocation.push_str(" '请完整阅读附件中的任务说明，并严格执行其中的所有约束。' '--file' ");
        invocation.push_str(&powershell_literal(
            control.prompt_path.to_string_lossy().as_ref(),
        ));
    } else {
        invocation.push_str(" $tbPrompt");
    }
    if captures_one_shot_output && !is_codex {
        invocation.push_str(" 2>&1 | Out-File -LiteralPath ");
        invocation.push_str(&powershell_literal(
            control.transcript_path.to_string_lossy().as_ref(),
        ));
        invocation.push_str(" -Encoding UTF8");
    }
    Ok(wrap_terminal_command(
        &invocation,
        control,
        if is_codex {
            Some(codex_final_message_path)
        } else if captures_one_shot_output {
            Some(control.transcript_path.as_path())
        } else {
            None
        },
        captures_one_shot_output.then_some(control.transcript_path.as_path()),
    ))
}

#[cfg(test)]
mod cycle_detection_tests {
    use super::*;

    fn node(id: &str, dependency_ids: Vec<String>) -> AiTaskNode {
        AiTaskNode {
            id: id.to_string(),
            delivery_id: "delivery".to_string(),
            title: id.to_string(),
            description: String::new(),
            role_id: None,
            workflow_step_id: None,
            preferred_agent_id: None,
            task_prompt: String::new(),
            execution_mode: "write".to_string(),
            execution_context: "taskWorktree".to_string(),
            target_repository_id: String::new(),
            allowed_write_paths: Vec::new(),
            dependency_ids,
            input_artifacts: Vec::new(),
            expected_artifacts: Vec::new(),
            acceptance_commands: Vec::new(),
            retry_count: 0,
            timeout_seconds: None,
            state: "planned".to_string(),
            assigned_agent_id: None,
            contract_id: None,
            attempt_ids: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn cycle_detection_self_loop() {
        let tasks = vec![node("a", vec!["a".to_string()])]; // 自环
        assert!(AiDeliveryService::has_cycle(&tasks));
    }

    #[test]
    fn cycle_detection_indirect_loop() {
        let tasks = vec![
            node("a", vec!["b".to_string()]),
            node("b", vec!["a".to_string()]), // 间接环
        ];
        assert!(AiDeliveryService::has_cycle(&tasks));
    }

    #[test]
    fn cycle_detection_complex() {
        // V 形分叉 + 汇合后的环：a->b, a->c, b->d, c->d, d->a
        let tasks = vec![
            node("a", vec!["b".to_string(), "c".to_string()]),
            node("b", vec!["d".to_string()]),
            node("c", vec!["d".to_string()]),
            node("d", vec!["a".to_string()]),
        ];
        assert!(AiDeliveryService::has_cycle(&tasks));
    }

    #[test]
    fn cycle_detection_acyclic() {
        let tasks = vec![
            node("a", vec!["b".to_string()]),
            node("b", vec!["d".to_string()]),
            node("c", vec!["d".to_string()]),
            node("d", vec![]),
        ];
        assert!(!AiDeliveryService::has_cycle(&tasks));
    }
}

#[cfg(test)]
mod terminal_command_tests {
    use super::*;

    fn test_runtime(kind: &str, command: &str) -> AiAgentRuntime {
        AiAgentRuntime {
            id: "runtime".to_string(),
            name: kind.to_string(),
            kind: kind.to_string(),
            command: command.to_string(),
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn test_agent() -> AiAgent {
        AiAgent {
            id: "agent".to_string(),
            name: "测试 Agent".to_string(),
            runtime_id: "runtime".to_string(),
            runtime_args: vec!["--model".to_string(), "test-model".to_string()],
            startup_preset_name: None,
            max_concurrency: 1,
            enabled: true,
            default_timeout_seconds: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn test_control() -> TerminalControl {
        TerminalControl {
            prompt_path: PathBuf::from(r"C:\TerminalBuddy\prompt.txt"),
            exit_marker: PathBuf::from(r"C:\TerminalBuddy\exit.txt"),
            result_path: PathBuf::from(r"C:\TerminalBuddy\result.txt"),
            final_message_path: PathBuf::from(r"C:\TerminalBuddy\final-message.txt"),
            transcript_path: PathBuf::from(r"C:\TerminalBuddy\transcript.log"),
            decision_path: PathBuf::from(r"C:\TerminalBuddy\decision.json"),
            review_path: PathBuf::from(r"C:\TerminalBuddy\review.json"),
            review_schema_path: PathBuf::from(r"C:\TerminalBuddy\review-schema.json"),
        }
    }

    #[test]
    fn codex_reads_prompt_from_standard_input() {
        let command = build_interactive_terminal_command(
            &test_runtime("codex", "codex"),
            &test_agent(),
            &test_control(),
        )
        .unwrap();

        assert!(command.contains("Get-Content -LiteralPath 'C:\\TerminalBuddy\\prompt.txt' -Raw -Encoding UTF8"));
        assert!(command.contains("$OutputEncoding = [System.Text.UTF8Encoding]::new($false)"));
        assert!(command.contains("'--skip-git-repo-check'"));
        assert!(command.contains("$tbPrompt | & 'codex' 'exec' '--skip-git-repo-check' '--model' 'test-model'"));
        assert!(!command.contains("'--sandbox' 'workspace-write'"));
        assert!(command.contains("'--output-last-message' 'C:\\TerminalBuddy\\final-message.txt' '-' 2>&1 | Out-File -LiteralPath 'C:\\TerminalBuddy\\transcript.log' -Encoding UTF8"));
        assert!(command.contains("Get-Content -LiteralPath 'C:\\TerminalBuddy\\final-message.txt' -Raw -Encoding UTF8"));
        assert!(!command.contains("'--' $tbPrompt"));
    }

    #[test]
    fn codex_structured_output_is_written_by_cli() {
        let control = test_control();
        let schema_path = PathBuf::from(r"C:\TerminalBuddy\schema.json");
        let command = build_interactive_terminal_command_with_codex_output(
            &test_runtime("codex", "codex"),
            &test_agent(),
            &control,
            Some(&schema_path),
            Some(&control.result_path),
            &[],
        )
        .unwrap();

        assert!(command.contains(
            "'--output-schema' 'C:\\TerminalBuddy\\schema.json' '--output-last-message' 'C:\\TerminalBuddy\\result.txt'"
        ));
        assert!(command.contains(
            "Get-Content -LiteralPath 'C:\\TerminalBuddy\\result.txt' -Raw -Encoding UTF8"
        ));
        assert!(!command.contains("'--output-last-message' 'C:\\TerminalBuddy\\final-message.txt'"));
    }

    #[test]
    fn codex_task_receives_only_scoped_writable_directories() {
        let command = build_interactive_terminal_command_with_codex_output(
            &test_runtime("codex", "codex"),
            &test_agent(),
            &test_control(),
            None,
            None,
            &[
                PathBuf::from(r"D:\project\task-worktree"),
                PathBuf::from(r"C:\TerminalBuddy\run"),
            ],
        )
        .unwrap();

        assert!(command.contains("'--sandbox' 'workspace-write'"));
        assert!(command.contains("'--add-dir' 'D:\\project\\task-worktree'"));
        assert!(command.contains("'--add-dir' 'C:\\TerminalBuddy\\run'"));
        assert!(!command.contains("danger-full-access"));
        assert!(!command.contains("dangerously-bypass-approvals-and-sandbox"));
    }

    #[test]
    fn claude_uses_non_interactive_mode_and_captures_output() {
        let command = build_interactive_terminal_command(
            &test_runtime("claude", "claude"),
            &test_agent(),
            &test_control(),
        )
        .unwrap();

        assert!(command.contains("$tbPrompt | & 'claude' '--model' 'test-model' '--print' 2>&1 | Out-File -LiteralPath 'C:\\TerminalBuddy\\transcript.log' -Encoding UTF8"));
    }

    #[test]
    fn supported_runtimes_use_non_interactive_commands() {
        for (kind, executable, expected) in [
            (
                "opencode",
                "opencode",
                "& 'opencode' 'run' '--model' 'test-model' '请完整阅读附件中的任务说明，并严格执行其中的所有约束。' '--file' 'C:\\TerminalBuddy\\prompt.txt'",
            ),
            ("hermes", "hermes", "& 'hermes' '--model' 'test-model' '--oneshot' $tbPrompt"),
            ("pi", "pi", "$tbPrompt | & 'pi' '--model' 'test-model' '--print'"),
            ("mimo", "mimo", "$tbPrompt | & 'mimo' '--model' 'test-model' '--print'"),
            ("kimi", "kimi", "& 'kimi' '--model' 'test-model' '--prompt'"),
        ] {
            let command = build_interactive_terminal_command(
                &test_runtime(kind, executable),
                &test_agent(),
                &test_control(),
            )
            .unwrap();
            assert!(command.contains(expected), "{} command was: {}", kind, command);
            assert!(command.contains("Out-File -LiteralPath 'C:\\TerminalBuddy\\transcript.log' -Encoding UTF8"));
        }
    }

    #[test]
    fn hermes_chat_uses_its_query_mode() {
        let command = build_interactive_terminal_command(
            &test_runtime("hermes", "hermes chat"),
            &test_agent(),
            &test_control(),
        )
        .unwrap();

        assert!(command.contains("& 'hermes' 'chat' '--model' 'test-model' '--quiet' '--query' $tbPrompt"));
    }

    #[test]
    fn reads_bom_prefixed_terminal_exit_code() {
        let path = std::env::temp_dir().join(format!(
            "terminal-buddy-exit-code-{}.txt",
            Uuid::new_v4()
        ));
        fs::write(&path, b"\xEF\xBB\xBF0\r\n").unwrap();
        assert_eq!(read_terminal_exit_code(&path), Some(0));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn compact_output_removes_terminal_control_sequences() {
        assert_eq!(
            compact_output("\u{1b}[31m结论\u{1b}[0m\u{1b}]0;Terminal\u{7}\n完成"),
            "结论\n完成"
        );
    }

    #[test]
    fn watchdog_detects_new_expected_artifacts() {
        let root = std::env::temp_dir().join(format!(
            "terminal-buddy-watchdog-artifacts-{}",
            Uuid::new_v4()
        ));
        let output_directory = root.join("outputs");
        fs::create_dir_all(&output_directory).unwrap();
        let started_at = chrono::Utc::now().to_rfc3339();
        let artifact = output_directory.join("analysis/result.md");
        fs::create_dir_all(artifact.parent().unwrap()).unwrap();
        fs::write(&artifact, "result").unwrap();
        let contract = AiTaskContract {
            id: "contract".to_string(),
            project_id: "project".to_string(),
            delivery_id: "delivery".to_string(),
            task_id: "task".to_string(),
            title: "task".to_string(),
            target_repository_id: "repository".to_string(),
            target_repository_name: "repository".to_string(),
            allowed_write_paths: vec![".".to_string()],
            execution_context: EXECUTION_CONTEXT_WORKSPACE_ROOT.to_string(),
            forbidden_repository_ids: Vec::new(),
            repository_status_baselines: Vec::new(),
            input_artifacts: Vec::new(),
            input_artifact_directory: None,
            output_artifact_directory: Some(output_directory.to_string_lossy().to_string()),
            expected_artifacts: vec!["analysis/result.md".to_string()],
            acceptance_commands: Vec::new(),
            retry_count: 0,
            state: "allocated".to_string(),
            working_directory: root.to_string_lossy().to_string(),
            branch_name: None,
            worktree_path: None,
            base_commit: None,
            validated_commit: None,
            dirty: false,
            created_at: started_at.clone(),
            updated_at: started_at.clone(),
        };

        assert!(expected_artifacts_written(&contract, &started_at).unwrap());
        let _ = fs::remove_dir_all(root);
    }
}

fn create_ai_terminal(
    terminal_service: &TerminalService,
    app: &tauri::AppHandle,
    display_name: &str,
    working_directory: &Path,
    project: &AiProject,
) -> Result<String, String> {
    let terminal_working_directory = normalize_path_for_external_process(working_directory);
    let terminal_id = terminal_service.create_blank_terminal(
        "powershell",
        Some(display_name),
        Some(&project.name),
        28,
        120,
        Some(terminal_working_directory.to_string_lossy().as_ref()),
        app.clone(),
        TerminalOwner::Pc,
    )?;
    // 标记 AI 交付终端：drain_terminal_output 对其只读不消费，monitor 线程独占消费落盘
    terminal_service.set_ai_delivery_flag(&terminal_id)?;
    if let Err(error) = app.emit(
        "terminal-created",
        serde_json::json!({
            "id": terminal_id,
            "profileId": "",
            "profileName": display_name,
            "terminalType": "powershell",
            "owner": "pc",
            "groupId": format!("ai-delivery-project-{}", safe_path_segment(&project.id)),
            "groupName": project.name,
            "extraParamTag": "AI 交付",
            "extraParamTagColor": "#22c55e",
        }),
    ) {
        let _ = terminal_service.close_terminal(&terminal_id);
        return Err(format!("通知前端创建 Agent 终端失败: {}", error));
    }
    Ok(terminal_id)
}

fn read_terminal_exit_code(path: &Path) -> Option<i32> {
    fs::read_to_string(path)
        .ok()?
        .trim()
        .trim_start_matches('\u{feff}')
        .parse::<i32>()
        .ok()
}

fn run_attempt_watchdog(
    attempt_id: &str,
    delivery_id: &str,
    task_node_id: &str,
    app: tauri::AppHandle,
    terminal_service: TerminalService,
    timeout_seconds: u64,
) {
    // 用秒数 i64 比较：循环内 elapsed 是 chrono::TimeDelta，不能与 std::time::Duration 直接比较
    let warning_at_secs = (timeout_seconds as f64 * TIMEOUT_WARNING_RATIO as f64).round() as i64;
    let mut warning_emitted = false;
    thread::sleep(ATTEMPT_WATCHDOG_DELAY);
    loop {
        let attempt = match AiDeliveryService::get::<AiAttempt>(
            ATTEMPTS_DIR,
            attempt_id,
            "执行尝试 watchdog",
        ) {
            Ok(attempt) => attempt,
            Err(_) => return,
        };
       if attempt.state != "running" {
           return;
       }

       // 检查 Agent 执行是否超过最大持续时间
       if let Ok(started) = chrono::DateTime::parse_from_rfc3339(&attempt.started_at) {
           let elapsed = chrono::Utc::now().signed_duration_since(started.with_timezone(&chrono::Utc));
           // 80% 耗时一次性提前告警
           if elapsed.num_seconds() >= warning_at_secs && !warning_emitted {
               let _ = AiDeliveryService::append_event(
                   delivery_id,
                   Some(task_node_id),
                   Some(attempt_id),
                   "approachingTimeout",
                   &format!(
                       "已耗时 {}s，预计 {}s 后超时",
                       elapsed.num_seconds(),
                       timeout_seconds
                   ),
               );
               warning_emitted = true;
           }
           if elapsed.num_seconds() > timeout_seconds as i64 {
               // 系统托盘通知：任务超时终止（不放 fail_attempt_from_watchdog 内——它无法区分超时与终端结束）
               let _ = crate::commands::notification::show_ai_delivery_notification(
                   app.clone(),
                   "AI 交付任务超时",
                   delivery_id.to_string(),
                   format!(
                       "任务 {} 执行超时（超过 {} 分钟），已自动终止",
                       task_node_id,
                       timeout_seconds / 60
                   ),
               );
               let _ = fail_attempt_from_watchdog(
                   &attempt,
                   &format!(
                       "Agent 执行已超时（超过 {} 分钟），已自动终止",
                       timeout_seconds / 60
                   ),
                   app.clone(),
                   terminal_service.clone(),
               );
               return;
           }
       }

       if let Err(error) = reconcile_running_attempt(
            &attempt,
            app.clone(),
            terminal_service.clone(),
        ) {
            if !attempt_terminal_running(&attempt, &terminal_service) {
                let _ = fail_attempt_from_watchdog(
                    &attempt,
                    &format!("Agent 终端已结束，任务状态检查失败：{}", error),
                    app.clone(),
                    terminal_service.clone(),
                );
                return;
            }
            let _ = record_watchdog_observation(
                delivery_id,
                task_node_id,
                attempt_id,
                &format!("watchdog 检查失败，任务暂保持运行：{}", error),
            );
        }

        thread::sleep(ATTEMPT_WATCHDOG_INTERVAL);
    }
}

fn terminal_exit_marker_path(attempt_id: &str) -> PathBuf {
    terminal_run_dir_by_id(attempt_id).join("exit-code.txt")
}

fn attempt_terminal_running(attempt: &AiAttempt, terminal_service: &TerminalService) -> bool {
    // exit-code.txt 是 Agent 命令的完成信号。外层 cmd.exe 仍存活时，不能把它误判为 Agent 仍在执行。
    if read_terminal_exit_code(&terminal_exit_marker_path(&attempt.id)).is_some() {
        return false;
    }
    attempt
        .terminal_id
        .as_deref()
        .is_some_and(|terminal_id| terminal_service.is_terminal_running(terminal_id))
}

fn reconcile_running_attempt(
    attempt: &AiAttempt,
    app: tauri::AppHandle,
    terminal_service: TerminalService,
) -> Result<(), String> {
    let contract = AiDeliveryService::get::<AiTaskContract>(
        CONTRACTS_DIR,
        &attempt.contract_id,
        "任务契约 watchdog",
    )?;
    let artifacts_written = expected_artifacts_written(&contract, &attempt.started_at)?;
    let terminal_running = attempt_terminal_running(attempt, &terminal_service);

    // 成果文件优先于终端状态：Agent 可能已经写完成果，但还没有退出 CLI。
    if artifacts_written {
        match AiDeliveryService::complete_attempt(
            &attempt.id,
            app.clone(),
            terminal_service.clone(),
        ) {
            Ok(_) => return Ok(()),
            Err(error) if terminal_running => {
                return Err(format!("已发现完整成果文件，但完成校验尚未通过：{}", error));
            }
            Err(error) => {
                fail_attempt_from_watchdog(
                    attempt,
                    &format!("Agent 终端已结束；已发现成果文件，但自动完成校验失败：{}", error),
                    app,
                    terminal_service,
                )?;
                return Ok(());
            }
        }
    }

    if !terminal_running {
        fail_attempt_from_watchdog(
            attempt,
            "Agent 终端已结束，且尚未检测到本次执行写入的完整成果文件",
            app,
            terminal_service,
        )?;
    }
    Ok(())
}

fn fail_attempt_from_watchdog(
    attempt: &AiAttempt,
    message: &str,
    _app: tauri::AppHandle,
    terminal_service: TerminalService,
) -> Result<(), String> {
    let mut current = AiDeliveryService::get::<AiAttempt>(
        ATTEMPTS_DIR,
        &attempt.id,
        "watchdog 异常任务",
    )?;
    if current.state != "running" {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    current.state = "failed".to_string();
    current.finished_at = Some(now.clone());
    current.updated_at = now.clone();
    current.summary = Some(message.to_string());
    AiDeliveryService::save(ATTEMPTS_DIR, &current.id, &current)?;

    let mut task = AiDeliveryService::get_task_node(&current.task_node_id)?;
    if matches!(task.state.as_str(), "queued" | "running") {
        task.state = "failed".to_string();
        task.updated_at = now;
        AiDeliveryService::save(TASK_NODES_DIR, &task.id, &task)?;
    }
    let _ = AiDeliveryService::append_event(
        &current.delivery_id,
        Some(&current.task_node_id),
        Some(&current.id),
        "attemptFailed",
        message,
    )?;
    if let Some(terminal_id) = current.terminal_id.as_deref() {
        let _ = terminal_service.close_terminal(terminal_id);
    }
    Ok(())
}

fn expected_artifacts_written(
    contract: &AiTaskContract,
    started_at: &str,
) -> Result<bool, String> {
    validate_artifact_paths(&contract.expected_artifacts, "交付物")?;
    if contract.expected_artifacts.is_empty() {
        return Ok(false);
    }
    let artifact_directory = contract
        .output_artifact_directory
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&contract.working_directory));
    let started_seconds = chrono::DateTime::parse_from_rfc3339(started_at)
        .map_err(|error| format!("执行开始时间无效：{}", error))?
        .timestamp();

    for artifact in &contract.expected_artifacts {
        let path = artifact_directory.join(artifact.trim());
        if !path.starts_with(&artifact_directory) || !path.exists() {
            return Ok(false);
        }
        let modified_seconds = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);
        if modified_seconds.is_none_or(|modified| modified < started_seconds - 5) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn is_last_workflow_stage(delivery: &AiDelivery, task: &AiTaskNode) -> bool {
    delivery
        .workflow_steps
        .last()
        .is_some_and(|step| task.workflow_step_id.as_deref() == Some(step.id.as_str()))
}

fn record_watchdog_observation(
    delivery_id: &str,
    task_node_id: &str,
    attempt_id: &str,
    message: &str,
) -> Result<(), String> {
    let mut attempt = AiDeliveryService::get::<AiAttempt>(
        ATTEMPTS_DIR,
        attempt_id,
        "更新 watchdog 状态",
    )?;
    if attempt.state != "running" {
        return Ok(());
    }
    attempt.updated_at = chrono::Utc::now().to_rfc3339();
    attempt.summary = Some(message.to_string());
    AiDeliveryService::save(ATTEMPTS_DIR, attempt_id, &attempt)?;
    let mut task = AiDeliveryService::get_task_node(task_node_id)?;
    if task.state == "running" {
        task.updated_at = attempt.updated_at.clone();
        AiDeliveryService::save(TASK_NODES_DIR, task_node_id, &task)?;
    }
    let _ = AiDeliveryService::append_event(
        delivery_id,
        Some(task_node_id),
        Some(attempt_id),
        "attemptWatchdogCheck",
        message,
    )?;
    Ok(())
}

/// 轮询终端输出检测 PowerShell 提示符，替代固定时长等待。
fn wait_for_shell_ready(
    terminal_service: &TerminalService,
    terminal_id: &str,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if std::time::Instant::now() > deadline {
            return Err("等待 PowerShell 启动超时".to_string());
        }
        let output = terminal_service
            .peek_terminal_output(terminal_id)
            .unwrap_or_default();
        if output.contains("PS ") || output.contains("PS>") {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn start_interactive_terminal_command(
    terminal_service: &TerminalService,
    terminal_id: &str,
    working_directory: &Path,
    terminal_command: &str,
) -> Result<(), String> {
    let terminal_working_directory = normalize_path_for_external_process(working_directory);
    let _ = wait_for_shell_ready(terminal_service, terminal_id, Duration::from_millis(8500));
    terminal_service.write_to_terminal(
        terminal_id,
        &format!(
            "$tbUtf8 = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = $tbUtf8; [Console]::OutputEncoding = $tbUtf8; $PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'; $PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'; Set-Location -LiteralPath {}\r",
            powershell_literal(terminal_working_directory.to_string_lossy().as_ref())
        ),
    )?;
    thread::sleep(Duration::from_millis(500));
    terminal_service.write_to_terminal(terminal_id, &format!("{}\r", terminal_command))?;
    Ok(())
}

fn wait_for_terminal_exit(
    terminal_service: &TerminalService,
    terminal_id: &str,
    exit_marker: &Path,
) -> Result<(i32, String), String> {
    let started_at = Instant::now();
    loop {
        if let Some(exit_code) = read_terminal_exit_code(exit_marker) {
            let output = terminal_service
                .peek_terminal_output(terminal_id)
                .unwrap_or_default();
            return Ok((exit_code, output));
        }
        if terminal_service.peek_terminal_output(terminal_id).is_err() {
            return Err("Agent 终端已在执行完成前关闭".to_string());
        }
        // 超时保护：防止 Reviewer Agent 挂起导致永久阻塞（上限 60 分钟）
        if started_at.elapsed() > Duration::from_secs(3600) {
            return Err("Reviewer Agent 执行超时（60 分钟），已自动中止".to_string());
        }
        thread::sleep(Duration::from_millis(300));
    }
}

fn repair_workflow_review(
    control: &TerminalControl,
    runtime: &AiAgentRuntime,
    agent: &AiAgent,
    terminal_service: &TerminalService,
    terminal_id: &str,
    working_directory: &Path,
    validation_error: &str,
) -> Result<(), String> {
    let repair_prompt = format!(
        "上一轮 Reviewer 输出未通过平台协议校验：{}\n\n请不要继续解释审查过程。请重新检查当前审查结论，并覆盖写入 {}。JSON 必须严格符合 {}，只能包含 approved（布尔值）和 comments（非空字符串）两个字段，禁止 acceptedArtifacts 或任何其他字段。写入后请重新读取该文件并自行校验 JSON，再退出当前 CLI。",
        validation_error,
        control.review_path.display(),
        control.review_schema_path.display(),
    );
    fs::write(&control.prompt_path, repair_prompt)
        .map_err(|error| format!("写入 Reviewer 修复提示失败: {}", error))?;
    let _ = fs::remove_file(&control.exit_marker);
    let _ = fs::remove_file(&control.review_path);
    let terminal_command = build_interactive_terminal_command_with_codex_output(
        runtime,
        agent,
        control,
        runtime_is_codex(runtime).then_some(control.review_schema_path.as_path()),
        runtime_is_codex(runtime).then_some(control.review_path.as_path()),
        &[],
    )?;
    start_interactive_terminal_command(
        terminal_service,
        terminal_id,
        working_directory,
        &terminal_command,
    )
}

fn wait_for_manager_plan(
    terminal_service: &TerminalService,
    terminal_id: &str,
    result_path: &Path,
    exit_marker: &Path,
) -> Result<ManagerPlan, String> {
    let mut last_result_error = None;
    let started_at = Instant::now();
    loop {
        match fs::read_to_string(result_path) {
            Ok(content) if !content.trim().is_empty() => {
                match serde_json::from_str::<ManagerPlan>(content.trim_start_matches('\u{feff}')) {
                    Ok(plan) => return Ok(plan),
                    Err(error) => {
                        last_result_error =
                            Some(format!("管理者返回的任务图不符合 Schema: {}", error));
                    }
                }
            }
            Ok(_) => {
                last_result_error = Some("管理者任务图文件为空".to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                last_result_error = Some(format!("读取管理者任务图失败: {}", error));
            }
        }

        if let Some(exit_code) = read_terminal_exit_code(exit_marker) {
            if exit_code != 0 {
                let output = terminal_service
                    .peek_terminal_output(terminal_id)
                    .unwrap_or_default();
                return Err(format!(
                    "管理者 Agent 执行失败（退出码 {}）: {}",
                    exit_code,
                    compact_output(&output)
                ));
            }
            return Err(last_result_error
                .unwrap_or_else(|| "管理者 Agent 已退出，但未生成 plan.json".to_string()));
        }

        if terminal_service.peek_terminal_output(terminal_id).is_err() {
            return Err(last_result_error
                .unwrap_or_else(|| "管理者终端已关闭，但尚未生成 plan.json".to_string()));
        }
        // 超时保护：防止 Manager Agent 挂起导致永久阻塞（上限 30 分钟）
        if started_at.elapsed() > Duration::from_secs(1800) {
            return Err(last_result_error
                .unwrap_or_else(|| "管理器规划超时（30 分钟），已自动中止".to_string()));
        }
        thread::sleep(Duration::from_millis(300));
    }
}

fn run_reviewer_agent(
    reviewer: &AiAgent,
    runtime: &AiAgentRuntime,
    task: &AiTaskNode,
    contract: &AiTaskContract,
    worktree: &Path,
    attempt_id: &str,
    project: &AiProject,
    app: tauri::AppHandle,
    terminal_service: TerminalService,
) -> Result<(String, i32), String> {
    let agent_start_directory = worktree.to_path_buf();
    if !agent_start_directory.is_dir() {
        return Err("任务 worktree 不可用，无法启动 Reviewer Agent".to_string());
    }
    let prompt = format!(
        "你是独立 Reviewer。请审查当前任务分支的本地提交和 git diff，确认是否覆盖需求、是否违反允许写入范围、是否有明显风险。\n\n任务：{}\n说明：{}\nAgent 起始目录：{}\n项目工作区根目录：{}\n本任务 worktree：{}\n允许写入范围：{}\n预期产物：{}\n\n只读审查：终端已从本任务 worktree 启动。项目工作区根目录只用于了解上下文，不得修改文件、不得提交、不得推送、不得执行部署或破坏性操作。请输出中文审核意见，包括发现的问题与剩余风险。确认审核完成后请退出当前 CLI，TerminalBuddy 将进入人工审核确认。",
        task.title,
        task.description,
        agent_start_directory.display(),
        project.workspace_root,
        worktree.display(),
        contract.allowed_write_paths.join(", "),
        contract.expected_artifacts.join("；"),
    );
    let control = prepare_terminal_control(attempt_id, Some(&format!("审查 · {}", task.title)), &prompt)?;
    let terminal_command = build_interactive_terminal_command(runtime, reviewer, &control)?;
    let terminal_id = create_ai_terminal(
        &terminal_service,
        &app,
        &format!("AI 审核 · {}", task.title),
        &agent_start_directory,
        project,
    )?;
    let mut attempt =
        AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "Reviewer 执行")?;
    attempt.terminal_id = Some(terminal_id.clone());
    attempt.updated_at = chrono::Utc::now().to_rfc3339();
    AiDeliveryService::save(ATTEMPTS_DIR, &attempt.id, &attempt)?;
    let _ = AiDeliveryService::append_event(
        &attempt.delivery_id,
        Some(&attempt.task_node_id),
        Some(attempt_id),
        "reviewerTerminalStarted",
        "Reviewer CLI 已在原生终端中启动",
    )?;
    start_interactive_terminal_command(
        &terminal_service,
        &terminal_id,
        &agent_start_directory,
        &terminal_command,
    )?;
    let (exit_code, terminal_output) = wait_for_terminal_exit(
        &terminal_service,
        &terminal_id,
        &control.exit_marker,
    )?;
    if exit_code != 0 {
        return Err(format!(
            "Reviewer Agent 执行失败（退出码 {}）: {}",
            exit_code,
            compact_output(&terminal_output)
        ));
    }
    ensure_task_branch_clean(worktree)?;
    Ok((compact_output(&terminal_output), exit_code))
}

fn compact_output(value: &str) -> String {
    const MAX_CHARS: usize = 4_000;
    let cleaned = strip_terminal_control_sequences(value);
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= MAX_CHARS {
        return trimmed.to_string();
    }
    format!("{}…", trimmed.chars().take(MAX_CHARS).collect::<String>())
}

fn strip_terminal_control_sequences(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    while let Some(next) = chars.next() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.next() == Some('\\') {
                            break;
                        }
                    }
                }
                Some(_) | None => {}
            }
        } else if !character.is_control() || matches!(character, '\n' | '\r' | '\t') {
            output.push(character);
        }
    }
    output
}

/// 检查任务的 worktree 是否已有之前执行的进展，如果有则返回续接上下文供 Agent 理解已有工作并续接完成。
fn build_continuation_context(
    task: &AiTaskNode,
    contract: &AiTaskContract,
    current_attempt_id: &str,
) -> Option<String> {
    let prior_notes: Vec<String> = task
        .attempt_ids
        .iter()
        .rev()
        .filter(|id| *id != current_attempt_id)
        .filter_map(|id| {
            let attempt = AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, id, "").ok()?;
           if !matches!(
               attempt.state.as_str(),
                "failed" | "policyViolation" | "cancelled" | "needsInput"
           ) {
               return None;
           }
           let summary = attempt.summary.unwrap_or_default();
            let run_dir = terminal_run_dir_by_id(id);
            let final_msg = fs::read_to_string(run_dir.join("final-message.txt"))
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|m| {
                    let truncated = if m.len() > 800 {
                        format!("{}...", &m[..m.floor_char_boundary(800)])
                    } else {
                        m
                    };
                    format!("\n{}\n{}", "上次最终消息", truncated)
                })
                .unwrap_or_default();
            if summary.is_empty() && final_msg.is_empty() {
                None
            } else {
                Some(format!(
                    "上次执行（{}）：{}{}",
                    attempt.state, summary, final_msg
                ))
            }
        })
        .take(3)
        .collect();

    let (mut uncommitted, mut committed) = (String::new(), String::new());
    if task.execution_mode != "readonly" {
        if let Some(worktree_path) = contract.worktree_path.as_deref() {
            let worktree = PathBuf::from(worktree_path);
            if worktree.is_dir() {
                uncommitted = run_git(
                    &worktree,
                    &["status".to_string(), "--porcelain=v1".to_string()],
                )
                .unwrap_or_default();
                if let Some(base) = contract.base_commit.as_deref() {
                    let log_args = vec![
                        "log".to_string(),
                        "--oneline".to_string(),
                        format!("{}..HEAD", base),
                    ];
                    committed = run_git(&worktree, &log_args).unwrap_or_default();
                }
            }
        }
    }

    let mut partial_outputs = String::new();
    if task.execution_mode == "readonly" {
        if let Some(dir) = contract.output_artifact_directory.as_deref() {
            let output_dir = PathBuf::from(dir);
            let existing: Vec<String> = contract
                .expected_artifacts
                .iter()
                .filter(|a| output_dir.join(a).exists())
                .map(|a| format!("  - {}", a))
                .collect();
            if !existing.is_empty() {
                partial_outputs = existing.join("\n");
            }
        }
    }

    // 查找已回答的决策请求，将其注入续接上下文供 Agent 参考
    let answered_decisions: Vec<String> = AiDeliveryService::get_decision_requests(
        Some(&contract.delivery_id),
    )
    .unwrap_or_default()
    .into_iter()
    .filter(|req| req.state == "answered")
    .filter(|req| req.task_node_id.as_deref() == Some(&task.id))
    .map(|req| {
        format!(
            "问题：{}\n回答：{}",
            req.question,
            req.answer.unwrap_or_default()
        )
    })
    .collect();

    if prior_notes.is_empty()
        && uncommitted.is_empty()
        && committed.is_empty()
        && partial_outputs.is_empty()
        && answered_decisions.is_empty()
    {
        return None;
    }

    let mut sections = vec![
        "这是续接执行的任务。之前的执行在当前任务 worktree 中已产生部分工作，请在此基础上续接完成，不要从头重做。".to_string(),
    ];

    if !committed.is_empty() {
        sections.push(format!("已提交的改动：\n{}", committed));
    }
    if !uncommitted.is_empty() {
        sections.push(format!("未提交的改动（需要你完成提交）：\n{}", uncommitted));
    }
    if !partial_outputs.is_empty() {
        sections.push(format!("成果目录中已有的产物：\n{}", partial_outputs));
    }
    if !prior_notes.is_empty() {
        sections.push(format!("之前执行未完成的原因：\n{}", prior_notes.join("\n")));
    }
    if !answered_decisions.is_empty() {
        sections.push(format!("用户已做出的决策：\n{}", answered_decisions.join("\n\n")));
    }

    sections.push(
        "请先用 git status、git log、git diff 检查当前进展，理解已完成的部分，然后完成剩余工作。不要撤销已有的合理改动。完成后确保所有改动已在当前任务分支提交。".to_string(),
    );

    Some(sections.join("\n\n"))
}

fn ensure_expected_artifacts(contract: &AiTaskContract, working_directory: &Path) -> Result<(), String> {
    validate_artifact_paths(&contract.expected_artifacts, "交付物")?;
    let artifact_directory = contract
        .output_artifact_directory
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| working_directory.to_path_buf());
    for artifact in &contract.expected_artifacts {
        let relative = artifact.trim();
        if relative.is_empty() {
            continue;
        }
        let path = artifact_directory.join(relative);
        if !path.starts_with(&artifact_directory) || !path.exists() {
            return Err(format!("未找到预期产物: {}", artifact));
        }
    }
    Ok(())
}

fn validate_artifact_paths(artifacts: &[String], label: &str) -> Result<(), String> {
    for artifact in artifacts {
        let relative = artifact.trim();
        let path = Path::new(relative);
        if relative.is_empty()
            || path.is_absolute()
            || path.components().any(|component| matches!(component, std::path::Component::ParentDir))
            || relative.contains(['\r', '\n', '：'])
        {
            return Err(format!(
                "{}必须是安全的相对文件或目录路径，不能使用说明文字: {}",
                label, artifact
            ));
        }
    }
    Ok(())
}

fn is_legacy_delivery_plan(delivery: &AiDelivery, tasks: &[AiTaskNode]) -> bool {
    !delivery.workflow_steps.is_empty()
        && tasks.iter().any(|task| {
            task.execution_context.trim().is_empty()
                || task.expected_artifacts.is_empty()
                || validate_artifact_paths(&task.expected_artifacts, "交付物").is_err()
        })
}

fn upgrade_legacy_workflow_steps(workflow: &mut AiWorkflow) -> bool {
    let mut changed = false;
    for step in &mut workflow.steps {
        if !step.execution_context.trim().is_empty() {
            continue;
        }
        let (execution_mode, execution_context) = match step.name.as_str() {
            "任务分析" | "需求评审" => ("readonly", EXECUTION_CONTEXT_WORKSPACE_ROOT),
            "功能测试、Code Review" => ("readonly", EXECUTION_CONTEXT_TASK_WORKTREE),
            _ => (step.execution_mode.as_str(), EXECUTION_CONTEXT_TASK_WORKTREE),
        };
        step.execution_mode = execution_mode.to_string();
        step.execution_context = execution_context.to_string();
        changed = true;
    }
    changed
}

fn ensure_readonly_execution_unchanged(
    project: &AiProject,
    contract: &AiTaskContract,
    working_directory: &Path,
) -> Result<(), String> {
    if contract.execution_context == EXECUTION_CONTEXT_WORKSPACE_ROOT {
        let changed = contract
            .repository_status_baselines
            .iter()
            .map(|baseline| -> Result<Option<&str>, String> {
                let repository = project
                    .repositories
                    .iter()
                    .find(|repository| repository.id == baseline.repository_id)
                    .ok_or_else(|| "只读步骤引用的项目仓库不存在".to_string())?;
                let path = project_repository_path(project, repository)?;
                let status_changed = repository_status(&path)? != baseline.status;
                let head_changed = match baseline.head_commit.as_deref() {
                    Some(head) => {
                        run_git(&path, &["rev-parse".to_string(), "HEAD".to_string()])? != head
                    }
                    None => false,
                };
                Ok((status_changed || head_changed).then_some(repository.name.as_str()))
            })
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if changed.is_empty() {
            Ok(())
        } else {
            Err(format!("只读步骤修改了项目仓库: {}", changed.join("、")))
        }
    } else {
        repository_status(working_directory).and_then(|status| {
            if status.is_empty() {
                Ok(())
            } else {
                Err("只读步骤产生了任务 worktree 文件改动".to_string())
            }
        })
    }
}

fn ensure_task_branch_clean(worktree: &Path) -> Result<(), String> {
    let status = run_git(
        worktree,
        &["status".to_string(), "--porcelain=v1".to_string()],
    )?;
    if !status.is_empty() {
        return Err(
            "Agent 执行后存在未提交改动，无法审核或合并；请在任务分支创建本地提交".to_string(),
        );
    }
    Ok(())
}

fn run_shell_command(working_directory: &Path, command: &str) -> Result<AiCommandResult, String> {
    // 验收命令与质量门禁命令使用 PowerShell 语法（Test-Path、Select-String 等 cmdlet），
    // 必须通过 powershell.exe 执行，cmd.exe 无法识别 PowerShell cmdlet。
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", command])
        .current_dir(working_directory);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let output = run_command_with_timeout(&mut cmd, QUALITY_GATE_COMMAND_TIMEOUT, "质量门禁命令")?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    Ok(AiCommandResult {
        command: command.to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        output: compact_output(&combined),
    })
}

fn build_manager_prompt(delivery: &AiDelivery, project: &AiProject, roles: &[AiRole]) -> String {
    let repositories = project
        .repositories
        .iter()
        .map(|repository| {
            format!(
                "- id={} name={} path={} branch={}",
                repository.id, repository.name, repository.relative_path, repository.default_branch
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let roles = roles
        .iter()
        .map(|role| {
            format!(
                "- id={} name={} description={}",
                role.id, role.name, role.description
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let workflow = if delivery.workflow_steps.is_empty() {
        "未选择编排方案；workflowStepId 必须返回 null。".to_string()
    } else {
        delivery
            .workflow_steps
            .iter()
            .enumerate()
            .map(|(index, step)| {
                format!(
                    "{}. stepId={} name={} mode={} context={} roleId={} agentId={} commonPrompt={}",
                    index + 1,
                    step.id,
                    step.name,
                    step.execution_mode,
                    resolve_execution_context(&step.execution_mode, &step.execution_context)
                        .unwrap_or_else(|_| "invalid".to_string()),
                    step.role_id.as_deref().unwrap_or("null"),
                    if step.role_id.is_some() { "由角色绑定" } else { &step.agent_id },
                    if step.prompt.is_empty() {
                        "无"
                    } else {
                        &step.prompt
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "你是 AI 交付团队的管理者。请把用户需求拆解为可执行的结构化任务图。\n\n需求标题：{}\n需求正文：{}\n\n项目工作区：{}\n可用仓库：\n{}\n\n可用角色：\n{}\n\n用户指定的任务编排（必须逐步覆盖并保持顺序）：\n{}\n\n硬性约束：\n1. 每个写入任务只能指定一个 targetRepositoryId，禁止单个 Agent 跨服务修改。\n2. 跨服务改动必须拆成多个节点，用 dependencyIndexes 表示前置关系。\n3. 每个阶段任务必须声明至少一个具体交付物 expectedArtifacts，禁止空数组；每个元素只能是安全相对路径，例如 `analysis/mom-app-item1-4.md` 或 `uni-app/pages/outbounds/index.vue`，不能填写说明句子、绝对路径或 `../`。任务只有在交付物实际存在并通过校验后才能更新为完成。只读步骤的交付物会写入平台提供的项目外成果目录，并自动交接给后续步骤。\n4. 每个任务必须声明 allowedWritePaths 和验收命令；只读步骤的 allowedWritePaths 使用 [\".\"]。\n5. workflowStepId 必须使用上面给出的 stepId；每个编排步骤至少生成一个任务，同一步骤可以按服务拆成多个并行任务。\n6. 后一步骤的每个任务必须依赖前一步骤的全部任务；tasks 按编排顺序和拓扑顺序输出，dependencyIndexes 从 0 开始且只能引用之前的任务。\n7. 不要计划 git push、PR、部署、删除数据或破坏性操作。\n8. 只返回符合提供 JSON Schema 的数据。",
        delivery.title,
        delivery.requirement,
        project.workspace_root,
        repositories,
        roles,
        workflow,
    )
}

fn validate_manager_workflow_plan(plan: &ManagerPlan, delivery: &AiDelivery) -> Result<(), String> {
    for (task_index, task) in plan.tasks.iter().enumerate() {
        if task
            .dependency_indexes
            .iter()
            .any(|dependency_index| *dependency_index >= task_index)
        {
            return Err(format!(
                "任务 {} 的 dependencyIndexes 必须只引用之前的任务",
                task_index
            ));
        }
    }
    if delivery.workflow_steps.is_empty() {
        return Ok(());
    }
    let step_positions = delivery
        .workflow_steps
        .iter()
        .enumerate()
        .map(|(index, step)| (step.id.as_str(), index))
        .collect::<BTreeMap<_, _>>();
    let mut task_indexes_by_step = vec![Vec::<usize>::new(); delivery.workflow_steps.len()];
    let mut last_step_index = 0;
    for (task_index, task) in plan.tasks.iter().enumerate() {
        let step_id = task
            .workflow_step_id
            .as_deref()
            .ok_or_else(|| format!("任务 {} 缺少 workflowStepId", task_index))?;
        let step_index = *step_positions
            .get(step_id)
            .ok_or_else(|| format!("任务 {} 引用了未知的 workflowStepId", task_index))?;
        if !task
            .expected_artifacts
            .iter()
            .any(|artifact| !artifact.trim().is_empty())
        {
            return Err(format!(
                "编排步骤“{}”的任务必须声明至少一个交付物",
                delivery.workflow_steps[step_index].name
            ));
        }
        validate_artifact_paths(&task.expected_artifacts, "交付物")?;
        validate_artifact_paths(&task.input_artifacts, "输入成果")?;
        if task_index > 0 && step_index < last_step_index {
            return Err("任务没有按照用户编排步骤顺序输出".to_string());
        }
        last_step_index = step_index;
        task_indexes_by_step[step_index].push(task_index);
    }
    for (step_index, task_indexes) in task_indexes_by_step.iter().enumerate() {
        if task_indexes.is_empty() {
            return Err(format!(
                "编排步骤“{}”没有生成任务",
                delivery.workflow_steps[step_index].name
            ));
        }
        if step_index == 0 {
            continue;
        }
        let previous_indexes = &task_indexes_by_step[step_index - 1];
        for task_index in task_indexes {
            let dependencies = &plan.tasks[*task_index].dependency_indexes;
            if previous_indexes
                .iter()
                .any(|previous_index| !dependencies.contains(previous_index))
            {
                return Err(format!(
                    "编排步骤“{}”的任务必须依赖前一步骤的全部任务",
                    delivery.workflow_steps[step_index].name
                ));
            }
        }
    }
    Ok(())
}

// 任务分析是只读交付，但不应被当作审核关卡；有前置依赖的只读编排任务才需要审核结论。
fn requires_workflow_review(task: &AiTaskNode) -> bool {
    task.execution_mode == "readonly"
        && task.workflow_step_id.is_some()
        && !task.dependency_ids.is_empty()
}

fn run_manager_planner(
    runtime: &AiAgentRuntime,
    manager: &AiAgent,
    project: &AiProject,
    delivery_id: &str,
    manager_attempt_id: &str,
    prompt: &str,
    app: tauri::AppHandle,
    terminal_service: TerminalService,
) -> Result<ManagerPlan, String> {
    let plan_dir = AiDeliveryService::entity_dir(PLANS_DIR).join(safe_path_segment(delivery_id));
    fs::create_dir_all(&plan_dir).map_err(|error| format!("创建管理者计划目录失败: {}", error))?;
    let schema_path = plan_dir.join("schema.json");
    fs::write(&schema_path, manager_plan_schema())
        .map_err(|error| format!("写入管理者计划 Schema 失败: {}", error))?;
    let control = prepare_terminal_control(manager_attempt_id, Some("管理器规划"), "")?;
    let working_directory = PathBuf::from(&project.workspace_root);
    if !working_directory.is_dir() {
        return Err("项目工作区目录不存在或不可用".to_string());
    }
    let manager_command_parts = split_runtime_command(&runtime.command)?;
    let manager_is_codex = runtime_kind_matches(runtime, &manager_command_parts[0], "codex");
    let output_protocol = if manager_is_codex {
        format!(
            "9. 完成规划后，最终响应必须只包含符合 Schema 的 JSON，不要包含 Markdown 代码块，也不要使用文件工具写入 plan.json。平台会将最终响应直接保存到：{}\n10. 输出必须符合 Schema：{}\n11. 最终 JSON 是任务图完成信号；平台读取后会自动更新交付状态。",
            control.result_path.display(),
            schema_path.display(),
        )
    } else {
        format!(
            "9. 完成规划后，必须使用文件工具将最终 JSON 写入：{}\n10. 输出必须符合 Schema：{}\n11. plan.json 是任务图完成信号。最终版本写入并重新读取确认后，必须立即退出当前 CLI。",
            control.result_path.display(),
            schema_path.display(),
        )
    };
    let manager_prompt = format!(
        "{}\n8. 你的当前工作目录是用户为本次 AI 交付选择的项目工作区，只能分析项目结构，不得修改项目源码。\n{}",
        prompt,
        output_protocol,
    );
    fs::write(&control.prompt_path, &manager_prompt)
        .map_err(|error| format!("写入管理者任务说明失败: {}", error))?;
    let terminal_command = build_interactive_terminal_command_with_codex_output(
        runtime,
        manager,
        &control,
        manager_is_codex.then_some(schema_path.as_path()),
        manager_is_codex.then_some(control.result_path.as_path()),
        &[],
    )?;
    let terminal_id = create_ai_terminal(
        &terminal_service,
        &app,
        "AI 管理者 · 生成任务图",
        &working_directory,
        project,
    )?;
    let mut manager_attempt =
        AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, manager_attempt_id, "管理者执行")?;
    manager_attempt.terminal_id = Some(terminal_id.clone());
    manager_attempt.summary = Some("管理者已在原生终端中启动".to_string());
    manager_attempt.updated_at = chrono::Utc::now().to_rfc3339();
    AiDeliveryService::save(ATTEMPTS_DIR, &manager_attempt.id, &manager_attempt)?;
    let _ = AiDeliveryService::append_event(
        delivery_id,
        None,
        Some(manager_attempt_id),
        "managerTerminalStarted",
        "管理者 CLI 已在原生终端中启动",
    )?;
    start_interactive_terminal_command(
        &terminal_service,
        &terminal_id,
        &working_directory,
        &terminal_command,
    )?;
    let result = wait_for_manager_plan(
        &terminal_service,
        &terminal_id,
        &control.result_path,
        &control.exit_marker,
    );
    // plan.json 已经冻结后不再允许管理者进程继续访问用户工作区。
    let _ = terminal_service.close_terminal(&terminal_id);
    result
}

fn generate_quality_gate_with_runtime(
    runtime: &AiAgentRuntime,
    workspace_root: &Path,
    contexts: &[RepositoryQualityContext],
) -> Result<AiQualityGate, String> {
    let run_id = Uuid::new_v4().to_string();
    let control = prepare_terminal_control(&run_id, Some("质量门禁生成"), "")?;
    let control_dir = control
        .result_path
        .parent()
        .ok_or_else(|| "质量门禁生成目录不可用".to_string())?;
    let schema_path = control_dir.join("quality-gate-schema.json");
    fs::write(&schema_path, QUALITY_GATE_SCHEMA)
        .map_err(|error| format!("写入质量门禁 Schema 失败: {}", error))?;
    let runtime_command_parts = split_runtime_command(&runtime.command)?;
    let is_codex = runtime_kind_matches(runtime, &runtime_command_parts[0], "codex");
    let prompt = build_quality_gate_prompt(
        contexts,
        workspace_root,
        &control.result_path,
        &schema_path,
        is_codex,
    );
    fs::write(&control.prompt_path, prompt)
        .map_err(|error| format!("写入质量门禁生成任务失败: {}", error))?;
    let now = chrono::Utc::now().to_rfc3339();
    let agent = AiAgent {
        id: Uuid::new_v4().to_string(),
        name: "质量门禁生成器".to_string(),
        runtime_id: runtime.id.clone(),
        runtime_args: Vec::new(),
        startup_preset_name: None,
        max_concurrency: 1,
        enabled: true,
        default_timeout_seconds: None,
        created_at: now.clone(),
        updated_at: now,
    };
    let terminal_command = build_interactive_terminal_command_with_codex_output(
        runtime,
        &agent,
        &control,
        is_codex.then_some(schema_path.as_path()),
        is_codex.then_some(control.result_path.as_path()),
        &[],
    )?;
    let result = run_shell_command(workspace_root, &terminal_command)?;
    if result.exit_code != 0 {
        return Err(format!(
            "AI 质量门禁生成失败（退出码 {}）: {}",
            result.exit_code, result.output
        ));
    }
    let content = fs::read_to_string(&control.result_path)
        .map_err(|error| format!("读取 AI 生成的质量门禁失败: {}", error))?;
    let plan: QualityGatePlan =
        serde_json::from_str(content.trim_start_matches('\u{feff}'))
            .map_err(|error| format!("解析 AI 生成的质量门禁失败: {}", error))?;
    let gate = normalize_quality_gate(AiQualityGate {
        commands: plan.commands,
    })
    .map_err(|error| format!("AI 生成的质量门禁命令无效: {}", error))?;
    Ok(gate)
}

fn normalize_path_for_external_process(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        const VERBATIM_PREFIX: &[u16] = &[92, 92, 63, 92];
        const VERBATIM_UNC_PREFIX: &[u16] = &[92, 92, 63, 92, 85, 78, 67, 92];

        let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.starts_with(VERBATIM_UNC_PREFIX) {
            let normalized: Vec<u16> = [92, 92]
                .into_iter()
                .chain(wide[VERBATIM_UNC_PREFIX.len()..].iter().copied())
                .collect();
            return PathBuf::from(OsString::from_wide(&normalized));
        }
        if wide.starts_with(VERBATIM_PREFIX) {
            return PathBuf::from(OsString::from_wide(&wide[VERBATIM_PREFIX.len()..]));
        }
    }

    path.to_path_buf()
}

fn run_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
    label: &str,
) -> Result<Output, String> {
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动{}失败: {}", label, error))?;
    let process_id = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("无法读取{}标准输出", label))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("无法读取{}错误输出", label))?;
    let stdout_handle = thread::spawn(move || {
        let mut reader = stdout;
        let mut content = Vec::new();
        let _ = reader.read_to_end(&mut content);
        content
    });
    let stderr_handle = thread::spawn(move || {
        let mut reader = stderr;
        let mut content = Vec::new();
        let _ = reader.read_to_end(&mut content);
        content
    });
    let started_at = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started_at.elapsed() >= timeout => {
                let mut kill = Command::new("taskkill");
                kill.args(["/PID", &process_id.to_string(), "/T", "/F"]);
                #[cfg(windows)]
                kill.creation_flags(CREATE_NO_WINDOW);
                let _ = kill.status();
                child
                    .wait()
                    .map_err(|error| format!("终止超时{}失败: {}", label, error))?;
                return Err(format!("{}执行超时（{} 秒）", label, timeout.as_secs()));
            }
            Ok(None) => thread::sleep(Duration::from_millis(200)),
            Err(error) => return Err(format!("等待{}结束失败: {}", label, error)),
        }
    };
    Ok(Output {
        status,
        stdout: stdout_handle.join().unwrap_or_default(),
        stderr: stderr_handle.join().unwrap_or_default(),
    })
}

fn manager_plan_schema() -> &'static str {
    r#"{
  "type": "object",
  "additionalProperties": false,
  "required": ["tasks"],
  "properties": {
    "tasks": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "description", "roleId", "workflowStepId", "targetRepositoryId", "allowedWritePaths", "dependencyIndexes", "inputArtifacts", "expectedArtifacts", "acceptanceCommands", "retryCount"],
        "properties": {
          "title": { "type": "string" },
          "description": { "type": "string" },
          "roleId": { "type": ["string", "null"] },
          "workflowStepId": { "type": ["string", "null"] },
          "targetRepositoryId": { "type": "string" },
          "allowedWritePaths": { "type": "array", "minItems": 1, "items": { "type": "string" } },
          "dependencyIndexes": { "type": "array", "items": { "type": "integer", "minimum": 0 } },
          "inputArtifacts": { "type": "array", "items": { "type": "string" } },
          "expectedArtifacts": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
          "acceptanceCommands": { "type": "array", "items": { "type": "string" } },
          "retryCount": { "type": "integer", "minimum": 0, "maximum": 10 }
        }
      }
    }
  }
}"#
}
