use serde::{Deserialize, Serialize};

fn default_project_concurrency() -> u32 {
    4
}

fn default_agent_concurrency() -> u32 {
    2
}

fn default_repository_write_concurrency() -> u32 {
    2
}

fn default_workflow_execution_mode() -> String {
    "write".to_string()
}

fn default_task_worktree_execution_context() -> String {
    "taskWorktree".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQualityGate {
    #[serde(default)]
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRepository {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub default_branch: String,
    #[serde(default = "default_repository_write_concurrency")]
    pub write_concurrency: u32,
    #[serde(default = "default_true")]
    pub write_enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProject {
    pub id: String,
    pub name: String,
    pub workspace_root: String,
    pub repositories: Vec<AiRepository>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub worktree_root: Option<String>,
    #[serde(default)]
    pub quality_gate: AiQualityGate,
    #[serde(default)]
    pub manager_agent_id: Option<String>,
    #[serde(default = "default_project_concurrency")]
    pub max_concurrency: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiProjectInput {
    pub name: String,
    pub workspace_root: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub worktree_root: Option<String>,
    #[serde(default)]
    pub quality_gate: AiQualityGate,
    #[serde(default)]
    pub manager_agent_id: Option<String>,
    #[serde(default = "default_project_concurrency")]
    pub max_concurrency: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRuntimeProbe {
    pub kind: String,
    pub command: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentRuntime {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub command: String,
    #[serde(default)]
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgent {
    pub id: String,
    pub name: String,
    pub runtime_id: String,
    /// 复用既有“启动参数预设”时冻结下来的 Runtime 参数，不保存密钥。
    #[serde(default)]
    pub runtime_args: Vec<String>,
    #[serde(default)]
    pub startup_preset_name: Option<String>,
    #[serde(default = "default_agent_concurrency")]
    pub max_concurrency: u32,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 该 Agent 执行任务的兜底超时（秒），None 时使用全局默认。
    #[serde(default)]
    pub default_timeout_seconds: Option<u32>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRole {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub candidate_agent_ids: Vec<String>,
    #[serde(default)]
    pub locked_agent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWorkflowStep {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role_id: Option<String>,
    // 仅用于读取旧编排；新步骤通过 role_id 选择执行 Agent。
    #[serde(default)]
    pub agent_id: String,
    #[serde(default = "default_workflow_execution_mode")]
    pub execution_mode: String,
    /// `workspaceRoot` 用于需求分析等跨仓库只读工作；`taskWorktree` 用于实现与任务分支审查。
    #[serde(default)]
    pub execution_context: String,
    #[serde(default)]
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWorkflow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub steps: Vec<AiWorkflowStep>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskContractInput {
    pub project_id: String,
    pub delivery_id: String,
    pub task_id: String,
    pub title: String,
    pub target_repository_id: String,
    pub allowed_write_paths: Vec<String>,
    #[serde(default)]
    pub execution_context: String,
    #[serde(default)]
    pub input_artifacts: Vec<String>,
    #[serde(default)]
    pub acceptance_commands: Vec<String>,
    #[serde(default)]
    pub expected_artifacts: Vec<String>,
    #[serde(default)]
    pub retry_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTaskContract {
    pub id: String,
    pub project_id: String,
    pub delivery_id: String,
    pub task_id: String,
    pub title: String,
    pub target_repository_id: String,
    pub target_repository_name: String,
    pub allowed_write_paths: Vec<String>,
    #[serde(default = "default_task_worktree_execution_context")]
    pub execution_context: String,
    pub forbidden_repository_ids: Vec<String>,
    #[serde(default)]
    pub repository_status_baselines: Vec<AiRepositoryStatusBaseline>,
    pub input_artifacts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_artifact_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_artifact_directory: Option<String>,
    pub expected_artifacts: Vec<String>,
    pub acceptance_commands: Vec<String>,
    #[serde(default)]
    pub retry_count: u32,
    pub state: String,
    pub working_directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    /// 最近一次通过确定性验收的任务分支提交。合并前必须再次确认分支仍指向该提交。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validated_commit: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRepositoryStatusBaseline {
    pub repository_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiDeliveryInput {
    pub project_id: String,
    pub title: String,
    pub requirement: String,
    #[serde(default)]
    pub manager_agent_id: Option<String>,
    #[serde(default)]
    pub workflow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAiDeliveryInput {
    pub id: String,
    pub title: String,
    pub requirement: String,
    #[serde(default)]
    pub manager_agent_id: Option<String>,
    #[serde(default)]
    pub workflow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDelivery {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub requirement: String,
    #[serde(default)]
    pub manager_agent_id: Option<String>,
    #[serde(default)]
    pub workflow_id: Option<String>,
    #[serde(default)]
    pub workflow_name: Option<String>,
    #[serde(default)]
    pub workflow_steps: Vec<AiWorkflowStep>,
    pub state: String,
    #[serde(default)]
    pub task_node_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiTaskNodeInput {
    pub delivery_id: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub role_id: Option<String>,
    #[serde(default)]
    pub workflow_step_id: Option<String>,
    #[serde(default)]
    pub preferred_agent_id: Option<String>,
    #[serde(default)]
    pub task_prompt: String,
    #[serde(default = "default_workflow_execution_mode")]
    pub execution_mode: String,
    #[serde(default)]
    pub execution_context: String,
    pub target_repository_id: String,
    pub allowed_write_paths: Vec<String>,
    #[serde(default)]
    pub dependency_ids: Vec<String>,
    #[serde(default)]
    pub input_artifacts: Vec<String>,
    #[serde(default)]
    pub expected_artifacts: Vec<String>,
    #[serde(default)]
    pub acceptance_commands: Vec<String>,
    #[serde(default)]
    pub retry_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTaskNode {
    pub id: String,
    pub delivery_id: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub role_id: Option<String>,
    #[serde(default)]
    pub workflow_step_id: Option<String>,
    #[serde(default)]
    pub preferred_agent_id: Option<String>,
    #[serde(default)]
    pub task_prompt: String,
    #[serde(default = "default_workflow_execution_mode")]
    pub execution_mode: String,
    #[serde(default)]
    pub execution_context: String,
    pub target_repository_id: String,
    pub allowed_write_paths: Vec<String>,
    pub dependency_ids: Vec<String>,
    pub input_artifacts: Vec<String>,
    pub expected_artifacts: Vec<String>,
    pub acceptance_commands: Vec<String>,
    pub retry_count: u32,
    /// 单次执行超时（秒），None 时使用 Agent/AiAgent 默认值。
    #[serde(default)]
    pub timeout_seconds: Option<u32>,
    pub state: String,
    #[serde(default)]
    pub assigned_agent_id: Option<String>,
    #[serde(default)]
    pub contract_id: Option<String>,
    #[serde(default)]
    pub attempt_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAttempt {
    pub id: String,
    pub delivery_id: String,
    pub task_node_id: String,
    pub contract_id: String,
    pub agent_id: String,
    pub runtime_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    pub state: String,
    pub started_at: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReviewGate {
    pub id: String,
    pub delivery_id: String,
    pub task_node_id: String,
    #[serde(default)]
    pub reviewer_agent_id: Option<String>,
    pub state: String,
    #[serde(default)]
    pub comments: Option<String>,
    #[serde(default)]
    pub command_results: Vec<AiCommandResult>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommandResult {
    pub command: String,
    pub exit_code: i32,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDecisionOption {
    pub label: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAttemptReview {
    pub approved: bool,
    pub comments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAttemptDecision {
    pub question: String,
    pub impact: String,
    #[serde(default)]
    pub options: Vec<AiDecisionOption>,
}

/// 单次执行的产出物快照，供前端"查看成果"面板使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAttemptOutput {
    pub attempt_id: String,
    /// transcript.log 的尾部（最多 8000 字符），用于快速预览
    #[serde(default)]
    pub transcript_tail: String,
    /// final-message.txt 的完整内容（如果存在）
    #[serde(default)]
    pub final_message: Option<String>,
    /// review.json 解析结果（如果存在）
    #[serde(default)]
    pub review: Option<AiAttemptReview>,
    /// decision.json 解析结果（如果存在）
    #[serde(default)]
    pub decision: Option<AiAttemptDecision>,
    /// prompt.txt 的前 500 字符摘要
    #[serde(default)]
    pub prompt_excerpt: Option<String>,
    /// plan.json 原始内容（如果存在），用于查看成果
    #[serde(default)]
    pub plan_json: Option<String>,
    /// attempt 是否仍在运行（Web 端轮询实时状态用）
    #[serde(default)]
    pub is_live: bool,
    /// live-output.log 尾部（最多 8000 字符），Web 端轮询用
    #[serde(default)]
    pub live_output_tail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDecisionRequest {
    pub id: String,
    pub delivery_id: String,
    #[serde(default)]
    pub task_node_id: Option<String>,
    pub question: String,
    pub impact: String,
    #[serde(default)]
    pub options: Vec<AiDecisionOption>,
    pub state: String,
    #[serde(default)]
    pub answer: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiDecisionRequestInput {
    pub delivery_id: String,
    #[serde(default)]
    pub task_node_id: Option<String>,
    pub question: String,
    pub impact: String,
    #[serde(default)]
    pub options: Vec<AiDecisionOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDeliveryEvent {
    pub id: String,
    pub delivery_id: String,
    #[serde(default)]
    pub task_node_id: Option<String>,
    #[serde(default)]
    pub attempt_id: Option<String>,
    pub event_type: String,
    pub message: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMergeRepositoryRecord {
    pub repository_id: String,
    pub branch_name: String,
    pub pre_merge_head: String,
    #[serde(default)]
    pub merged_head: Option<String>,
    pub state: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMergeRecord {
    pub id: String,
    pub delivery_id: String,
    pub project_id: String,
    pub state: String,
    pub repositories: Vec<AiMergeRepositoryRecord>,
    pub created_at: String,
    pub updated_at: String,
}
