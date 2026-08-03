use crate::commands::terminal::TerminalService;
use crate::models::{
    AiAgent, AiAgentRuntime, AiAttempt, AiDelivery, AiDeliveryEvent, AiDeliveryTemplate,
    AiMergeRecord, AiProject, AiAttemptOutput, AiQualityGate, AiReviewGate, AiRole,
    AiRuntimeProbe, AiStartupPreset, AiTaskContract, AiTaskNode, AiWorkflow,
    CreateAiDecisionRequestInput, CreateAiDeliveryInput, CreateAiDeliveryTemplateInput,
    CreateAiProjectInput, CreateAiTaskNodeInput, CreateTaskContractInput, UpdateAiDeliveryInput,
    UpdateAiTaskNodeInput, UpdateAiDeliveryTemplateInput,
};
use crate::services::AiDeliveryService;
use tauri::command;

#[command]
pub fn get_ai_projects() -> Result<Vec<AiProject>, String> {
    AiDeliveryService::get_all_projects()
}

#[command]
pub fn create_ai_project(input: CreateAiProjectInput) -> Result<AiProject, String> {
    AiDeliveryService::create_project(input)
}

#[command]
pub fn refresh_ai_project_repositories(id: String) -> Result<AiProject, String> {
    AiDeliveryService::refresh_project_repositories(&id)
}

#[command]
pub fn update_ai_project(project: AiProject) -> Result<AiProject, String> {
    AiDeliveryService::update_project(project)
}

#[command]
pub async fn generate_ai_quality_gate_commands(
    workspace_root: String,
    runtime_id: Option<String>,
    agent_id: Option<String>,
) -> Result<AiQualityGate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::generate_quality_gate_commands(
            &workspace_root,
            runtime_id.as_deref(),
            agent_id.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("AI 质量门禁生成线程失败: {}", error))?
}

#[command]
pub fn delete_ai_project(id: String) -> Result<(), String> {
    AiDeliveryService::delete_project(&id)
}

#[command]
pub async fn detect_ai_runtimes() -> Vec<AiRuntimeProbe> {
    tauri::async_runtime::spawn_blocking(AiDeliveryService::detect_local_runtimes)
        .await
        .unwrap_or_default()
}

#[command]
pub fn list_ai_delivery_templates() -> Result<Vec<AiDeliveryTemplate>, String> {
    AiDeliveryService::list_ai_delivery_templates()
}

#[command]
pub fn create_ai_delivery_template(
    input: CreateAiDeliveryTemplateInput,
) -> Result<AiDeliveryTemplate, String> {
    AiDeliveryService::create_ai_delivery_template(input)
}

#[command]
pub fn update_ai_delivery_template(
    input: UpdateAiDeliveryTemplateInput,
) -> Result<AiDeliveryTemplate, String> {
    AiDeliveryService::update_ai_delivery_template(input)
}

#[command]
pub fn delete_ai_delivery_template(id: String) -> Result<(), String> {
    AiDeliveryService::delete_ai_delivery_template(&id)
}

#[command]
pub fn save_ai_delivery_as_template(
    delivery_id: String,
    name: String,
) -> Result<AiDeliveryTemplate, String> {
    AiDeliveryService::save_delivery_as_template(&delivery_id, &name)
}

#[command]
pub fn get_ai_runtimes() -> Result<Vec<AiAgentRuntime>, String> {
    AiDeliveryService::get_all_runtimes()
}

#[command]
pub fn save_ai_runtime(runtime: AiAgentRuntime) -> Result<AiAgentRuntime, String> {
    AiDeliveryService::save_runtime(runtime)
}

#[command]
pub fn delete_ai_runtime(id: String) -> Result<(), String> {
    AiDeliveryService::delete_runtime(&id)
}

#[command]
pub fn get_ai_agents() -> Result<Vec<AiAgent>, String> {
    AiDeliveryService::get_all_agents()
}

#[command]
pub fn save_ai_agent(agent: AiAgent) -> Result<AiAgent, String> {
    AiDeliveryService::save_agent(agent)
}

#[command]
pub fn delete_ai_agent(id: String) -> Result<(), String> {
    AiDeliveryService::delete_agent(&id)
}

#[command]
pub fn get_ai_roles() -> Result<Vec<AiRole>, String> {
    AiDeliveryService::get_all_roles()
}

#[command]
pub async fn test_ai_workflow_step(
    workflow_step_id: String,
    feature_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::test_workflow_step(&workflow_step_id, &feature_name)
    })
    .await
    .map_err(|error| format!("工作流步骤模拟测试线程失败: {}", error))?
}

#[command]
pub fn list_ai_startup_presets() -> Result<Vec<AiStartupPreset>, String> {
    AiDeliveryService::get_all_startup_presets()
}

#[command]
pub fn create_ai_startup_preset(preset: AiStartupPreset) -> Result<AiStartupPreset, String> {
    AiDeliveryService::save_startup_preset(preset)
}

#[command]
pub fn update_ai_startup_preset(preset: AiStartupPreset) -> Result<AiStartupPreset, String> {
    AiDeliveryService::save_startup_preset(preset)
}

#[command]
pub fn delete_ai_startup_preset(id: String) -> Result<(), String> {
    AiDeliveryService::delete_startup_preset(&id)
}

#[command]
pub fn save_ai_role(role: AiRole) -> Result<AiRole, String> {
    AiDeliveryService::save_role(role)
}

#[command]
pub fn delete_ai_role(id: String) -> Result<(), String> {
    AiDeliveryService::delete_role(&id)
}

#[command]
pub fn get_ai_workflows() -> Result<Vec<AiWorkflow>, String> {
    AiDeliveryService::get_all_workflows()
}

#[command]
pub fn save_ai_workflow(workflow: AiWorkflow) -> Result<AiWorkflow, String> {
    AiDeliveryService::save_workflow(workflow)
}

#[command]
pub fn delete_ai_workflow(id: String) -> Result<(), String> {
    AiDeliveryService::delete_workflow(&id)
}

#[command]
pub fn get_ai_task_contracts(project_id: Option<String>) -> Result<Vec<AiTaskContract>, String> {
    AiDeliveryService::get_all_task_contracts(project_id.as_deref())
}

#[command]
pub fn create_ai_task_contract(input: CreateTaskContractInput) -> Result<AiTaskContract, String> {
    AiDeliveryService::create_task_contract(input)
}

#[command]
pub fn allocate_ai_task_worktree(id: String) -> Result<AiTaskContract, String> {
    AiDeliveryService::allocate_task_worktree(&id)
}

#[command]
pub fn get_ai_deliveries(project_id: Option<String>) -> Result<Vec<AiDelivery>, String> {
    AiDeliveryService::get_all_deliveries(project_id.as_deref())
}

#[command]
pub fn create_ai_delivery(input: CreateAiDeliveryInput) -> Result<AiDelivery, String> {
    AiDeliveryService::create_delivery(input)
}

#[command]
pub fn update_ai_delivery(input: UpdateAiDeliveryInput) -> Result<AiDelivery, String> {
    AiDeliveryService::update_delivery(input)
}

#[command]
pub async fn plan_ai_delivery_with_manager(
    id: String,
    app: tauri::AppHandle,
    terminal_service: tauri::State<'_, TerminalService>,
) -> Result<Vec<AiTaskNode>, String> {
    let manager_attempt = AiDeliveryService::begin_delivery_planning(&id)?;
    let planning_id = id.clone();
    let manager_attempt_id = manager_attempt.id;
    let terminal_service = terminal_service.inner().clone();
    match tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::plan_delivery_with_manager(
            &planning_id,
            &manager_attempt_id,
            app,
            terminal_service,
        )
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let message = format!("管理者任务图生成线程失败: {}", error);
            let _ = AiDeliveryService::fail_delivery_planning(&id, &message);
            Err(message)
        }
    }
}

#[command]
pub fn replan_legacy_ai_delivery(
    id: String,
    terminal_service: tauri::State<TerminalService>,
) -> Result<AiDelivery, String> {
    AiDeliveryService::replan_legacy_delivery(&id, terminal_service.inner().clone())
}

/// 规划中断「以当前状态重跑」：校验可重跑后直接复用既有规划路径重新生成任务图。
#[command]
pub async fn replan_ai_delivery_accepting_current_state(
    id: String,
    app: tauri::AppHandle,
    terminal_service: tauri::State<'_, TerminalService>,
) -> Result<Vec<AiTaskNode>, String> {
    AiDeliveryService::replan_delivery_accepting_current_state(&id)?;
    let manager_attempt = AiDeliveryService::begin_delivery_planning(&id)?;
    let planning_id = id.clone();
    let manager_attempt_id = manager_attempt.id;
    let terminal_service = terminal_service.inner().clone();
    match tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::plan_delivery_with_manager(
            &planning_id,
            &manager_attempt_id,
            app,
            terminal_service,
        )
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let message = format!("管理者任务图生成线程失败: {}", error);
            let _ = AiDeliveryService::fail_delivery_planning(&id, &message);
            Err(message)
        }
    }
}

#[command]
pub fn delete_ai_delivery(id: String) -> Result<(), String> {
    AiDeliveryService::delete_delivery(&id)
}

#[command]
pub fn get_ai_task_nodes(delivery_id: String) -> Result<Vec<AiTaskNode>, String> {
    AiDeliveryService::get_task_nodes(&delivery_id)
}

#[command]
pub fn create_ai_task_node(input: CreateAiTaskNodeInput) -> Result<AiTaskNode, String> {
    AiDeliveryService::create_task_node(input)
}

#[command]
pub fn update_ai_task_node(input: UpdateAiTaskNodeInput) -> Result<AiTaskNode, String> {
    AiDeliveryService::update_task_node(input)
}

#[command]
pub fn delete_ai_task_node(task_node_id: String) -> Result<(), String> {
    AiDeliveryService::delete_task_node(&task_node_id)
}

#[command]
pub fn approve_ai_delivery(id: String) -> Result<AiDelivery, String> {
    AiDeliveryService::approve_delivery(&id)
}

#[command]
pub fn pause_ai_delivery(id: String) -> Result<AiDelivery, String> {
    AiDeliveryService::pause_delivery(&id)
}

#[command]
pub fn resume_ai_delivery(
    id: String,
    app: tauri::AppHandle,
    terminal_service: tauri::State<TerminalService>,
) -> Result<AiDelivery, String> {
    let delivery = AiDeliveryService::resume_delivery(&id)?;
    // 恢复后自动派发所有就绪任务
    let terminal_service = terminal_service.inner().clone();
    AiDeliveryService::dispatch_ready_and_start(&id, app, terminal_service)?;
    Ok(delivery)
}

#[command]
pub fn cancel_ai_delivery(
    id: String,
    terminal_service: tauri::State<TerminalService>,
) -> Result<AiDelivery, String> {
    AiDeliveryService::cancel_delivery(&id, terminal_service.inner().clone())
}

#[command]
pub fn refresh_ai_ready_task_nodes(delivery_id: String) -> Result<Vec<AiTaskNode>, String> {
    AiDeliveryService::refresh_ready_task_nodes(&delivery_id)
}

#[command]
pub fn get_ai_delivery_events(delivery_id: String) -> Result<Vec<AiDeliveryEvent>, String> {
    AiDeliveryService::get_delivery_events(&delivery_id)
}

#[command]
pub fn get_ai_decision_requests(
    delivery_id: Option<String>,
) -> Result<Vec<crate::models::AiDecisionRequest>, String> {
    AiDeliveryService::get_decision_requests(delivery_id.as_deref())
}

#[command]
pub fn create_ai_decision_request(
    input: CreateAiDecisionRequestInput,
    app: tauri::AppHandle,
) -> Result<crate::models::AiDecisionRequest, String> {
    let request = AiDeliveryService::create_decision_request(input)?;
    let _ = crate::commands::notification::show_ai_delivery_notification(
        app,
        "AI 交付等待决策",
        request.delivery_id.clone(),
        request.question.clone(),
    );
    Ok(request)
}

#[command]
pub fn answer_ai_decision_request(
    id: String,
    answer: String,
    app: tauri::AppHandle,
    terminal_service: tauri::State<TerminalService>,
) -> Result<crate::models::AiDecisionRequest, String> {
    let request = AiDeliveryService::answer_decision_request(&id, &answer)?;
    if AiDeliveryService::get_delivery(&request.delivery_id)?.state == "running" {
        let terminal_service = terminal_service.inner().clone();
        AiDeliveryService::dispatch_ready_and_start(
            &request.delivery_id,
            app,
            terminal_service,
        )?;
    }
    Ok(request)
}

#[command]
pub fn get_ai_attempts(delivery_id: Option<String>) -> Result<Vec<AiAttempt>, String> {
    AiDeliveryService::get_all_attempts(delivery_id.as_deref())
}

#[command]
pub fn dispatch_ai_task_node(
    task_node_id: String,
    agent_id: Option<String>,
) -> Result<AiAttempt, String> {
    AiDeliveryService::dispatch_task_node(&task_node_id, agent_id.as_deref())
}

#[command]
pub fn dispatch_ai_ready_tasks(delivery_id: String) -> Result<Vec<AiAttempt>, String> {
    AiDeliveryService::dispatch_ready_tasks(&delivery_id)
}

#[command]
pub fn retry_ai_task_node(task_node_id: String) -> Result<AiTaskNode, String> {
    AiDeliveryService::retry_task_node(&task_node_id)
}

#[command]
pub fn start_ai_attempt(
    id: String,
    app: tauri::AppHandle,
    terminal_service: tauri::State<TerminalService>,
) -> Result<AiAttempt, String> {
    AiDeliveryService::start_attempt(&id, app, terminal_service.inner().clone())
}

#[command]
pub fn cancel_ai_attempt(
    id: String,
    terminal_service: tauri::State<TerminalService>,
) -> Result<AiAttempt, String> {
    AiDeliveryService::cancel_attempt(&id, terminal_service.inner().clone())
}

#[command]
pub fn cancel_ai_task_node(
    task_node_id: String,
    terminal_service: tauri::State<TerminalService>,
) -> Result<AiTaskNode, String> {
    AiDeliveryService::cancel_task_node(&task_node_id, terminal_service.inner().clone())
}

#[command]
pub fn mark_ai_task_skipped(task_node_id: String) -> Result<(), String> {
    AiDeliveryService::mark_task_skipped(&task_node_id)
}

#[command]
pub fn confirm_ai_policy_violation_site(task_node_id: String) -> Result<(), String> {
    AiDeliveryService::confirm_policy_violation_site(&task_node_id)
}

#[command]
pub fn continue_ai_merge_after_conflict(delivery_id: String) -> Result<(), String> {
    AiDeliveryService::continue_merge_after_conflict(&delivery_id)
}

#[command]
pub fn complete_ai_attempt(
    id: String,
    app: tauri::AppHandle,
    terminal_service: tauri::State<TerminalService>,
) -> Result<AiAttempt, String> {
    AiDeliveryService::ensure_manual_completion_allowed(&id)?;
    AiDeliveryService::complete_attempt(&id, app, terminal_service.inner().clone())
}

#[command]
pub fn get_ai_review_gates(delivery_id: Option<String>) -> Result<Vec<AiReviewGate>, String> {
    AiDeliveryService::get_review_gates(delivery_id.as_deref())
}

#[command]
pub async fn run_ai_quality_gate(
    task_node_id: String,
    reviewer_agent_id: Option<String>,
    app: tauri::AppHandle,
    terminal_service: tauri::State<'_, TerminalService>,
) -> Result<AiReviewGate, String> {
    let terminal_service = terminal_service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::run_quality_gate(
            &task_node_id,
            reviewer_agent_id.as_deref(),
            app,
            terminal_service,
        )
    })
    .await
    .map_err(|error| format!("质量门禁执行线程失败: {}", error))?
}

#[command]
pub fn resolve_ai_review_gate(
    id: String,
    approved: bool,
    comments: String,
) -> Result<AiReviewGate, String> {
    AiDeliveryService::resolve_review_gate(&id, approved, comments)
}

#[command]
pub async fn get_ai_review_diff(
    delivery_id: String,
    task_node_id: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::get_review_diff(&delivery_id, &task_node_id)
    })
    .await
    .map_err(|error| format!("Diff 读取线程失败: {}", error))?
}

#[command]
pub fn add_ai_review_line_comment(
    gate_id: String,
    path: String,
    line: i64,
    text: String,
) -> Result<AiReviewGate, String> {
    AiDeliveryService::add_review_line_comment(&gate_id, &path, line, &text)
}

#[command]
pub fn get_ai_merge_records(delivery_id: Option<String>) -> Result<Vec<AiMergeRecord>, String> {
    AiDeliveryService::get_merge_records(delivery_id.as_deref())
}

#[command]
pub async fn merge_ai_delivery_locally(delivery_id: String) -> Result<AiMergeRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::merge_delivery_locally(&delivery_id)
    })
    .await
    .map_err(|error| format!("本地合并执行线程失败: {}", error))?
}

#[command]
pub async fn cleanup_ai_delivery_integration(delivery_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::cleanup_delivery_integration(&delivery_id)
    })
    .await
    .map_err(|error| format!("清理集成工作区线程失败: {}", error))?
}

#[command]
pub fn read_ai_attempt_output(attempt_id: String) -> Result<AiAttemptOutput, String> {
    AiDeliveryService::read_attempt_output(&attempt_id)
}

#[command]
pub fn list_ai_delivery_artifacts(
    delivery_id: String,
) -> Result<Vec<crate::models::AiArtifactMeta>, String> {
    AiDeliveryService::list_delivery_artifacts(&delivery_id)
}

#[command]
pub fn read_ai_delivery_artifact(delivery_id: String, path: String) -> Result<String, String> {
    AiDeliveryService::read_delivery_artifact(&delivery_id, &path)
}

#[command]
pub async fn export_ai_delivery_artifacts_zip(
    delivery_id: String,
    target_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::export_delivery_artifacts_zip(&delivery_id, &target_path)
    })
    .await
    .map_err(|error| format!("产物 ZIP 导出线程失败: {}", error))?
}
