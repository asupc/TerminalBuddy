//! AI 交付服务 · 交付域模块（自 ai_delivery_service.rs 拆分）
use super::*;

impl AiDeliveryService {

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

    pub fn delete_delivery(id: &str) -> Result<(), String> {
         let delivery = Self::get_delivery(id)?;
        if !matches!(
            delivery.state.as_str(),
            "drafting" | "cancelled" | "failed" | "succeeded" | "completed" | "mergeFailed"
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
    pub(crate) fn validate_task_fields(task: &AiTaskNode, delivery: &AiDelivery) -> Result<(), String> {
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
    pub(crate) fn cleanup_pending_gates_and_decisions(
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
        // 执行环境字段快照：字段随后被移动，先克隆用于「是否实际变更」判断
        let proposed_execution_mode = input.execution_mode.clone();
        let proposed_execution_context = input.execution_context.clone();
        let proposed_target_repository_id = input.target_repository_id.clone();

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

        // 6) 执行环境字段（目标仓库/执行模式/执行上下文）实际变更 → 丢弃旧契约重建；
        //    其余执行参数变更 → 标脏 contract（重试派发时同步字段重新审计，避免旧 worktree 审计结果被复用）
        let environment_rebuilt = [
            (
                proposed_execution_mode.is_some(),
                task.execution_mode != original.execution_mode,
            ),
            (
                proposed_execution_context.is_some(),
                task.execution_context != original.execution_context,
            ),
            (
                proposed_target_repository_id.is_some(),
                task.target_repository_id != original.target_repository_id,
            ),
        ]
        .iter()
        .any(|(provided, changed)| *provided && *changed);
        if environment_rebuilt {
            discard_task_contract(&mut task);
        } else if exec_fields_changed {
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

        // 1) contract：先回收 worktree/分支（尽力，契约文件随后删除），避免删除任务残留目录与分支。
        //    仓库已从项目移除时退化为直接删目录（与 cleanup_delivery_task_worktrees 的退化一致）。
        if let Some(contract_id) = &task.contract_id {
            if let Ok(contract) =
                Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "任务契约")
            {
                if let (Some(worktree), Some(branch)) = (
                    contract.worktree_path.as_deref(),
                    contract.branch_name.as_deref(),
                ) {
                    if let Ok(project) = Self::get_project(&delivery.project_id) {
                        let source = project
                            .repositories
                            .iter()
                            .find(|repository| repository.id == contract.target_repository_id)
                            .and_then(|repository| {
                                project_repository_path(&project, repository).ok()
                            });
                        match source {
                            Some(source) => cleanup_unallocated_task_worktree(
                                &source,
                                Path::new(worktree),
                                branch,
                            ),
                            None => {
                                let _ = fs::remove_dir_all(worktree);
                            }
                        }
                    }
                }
            }
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
        // 删除未决审核门禁：取消后任务已置 cancelled，残留的 awaitingReviewer gate
        // 无法再被处理（resolve 校验任务状态），保留只会让前端按任务渲染旧 gate 干扰展示。
        for gate in Self::get_review_gates(Some(&delivery.id))? {
            if gate.state == "awaitingReviewer" {
                let _ = Self::delete(REVIEW_GATES_DIR, &gate.id, "审核门禁");
            }
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

   pub(crate) fn merge_delivery_locally_locked(
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
    pub(crate) fn validate_tasks_mergeable(
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

   pub(crate) fn merge_delivery_locally_locked_impl(
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
     pub(crate) fn merge_single_repository(
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

     /// 续接合并需要重跑的仓库子记录状态：failed（冲突/失败待重试）与 rolledBack（已回滚需重新合并）。
     /// 只重跑 failed 会让被回滚仓库的改动永久丢失——交付宣告完成但目标分支上没有这些改动。
     pub(crate) fn merge_continuation_needed(state: &str) -> bool {
         matches!(state, "failed" | "rolledBack")
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
             // 只重跑 failed 会让已回滚（rolledBack）仓库的改动永久丢失：
             // 首次合并失败时 rollback_merge_record 会把已合并仓库 reset 回合并前 HEAD，
             // 若续接不再合并它们，交付会宣告完成但目标分支上没有这些仓库的任何改动。
             // rollbackFailed / merged 仓库的代码已在目标分支，跳过。
             if !Self::merge_continuation_needed(&record.repositories[index].state) {
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

     pub(crate) fn complete_delivery_contracts(delivery_id: &str) -> Result<(), String> {
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

    pub(crate) fn rollback_merge_record(project: &AiProject, record: &mut AiMergeRecord) -> bool {
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

}
