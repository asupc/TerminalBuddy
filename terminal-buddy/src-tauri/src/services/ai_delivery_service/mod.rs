//! AI 交付服务（服务入口，自 ai_delivery_service.rs 拆分）：常量/锁/结构体与模块汇总

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
mod quality;
use quality::*;
mod entity;
mod dispatch;
mod delivery;

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

const WORKFLOW_REVIEW_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["approved", "comments"],
  "properties": {
    "approved": { "type": "boolean" },
    "comments": { "type": "string", "minLength": 1 }
  },
  "additionalProperties": false
}"#;

