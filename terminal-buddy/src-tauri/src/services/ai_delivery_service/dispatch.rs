//! AI 交付服务 · 派发域模块（自 ai_delivery_service.rs 拆分）
use super::*;

impl AiDeliveryService {
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
            // 引用常量而非硬编码：fail_queued_attempt 按文案区分暂时性错误（回退待执行队列），
            // 两处文案漂移会使容量错误被误判为结构性失败而把任务置 failed
            return Err(GLOBAL_CAPACITY_ERROR.to_string());
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
        // 验收命令预检：在 Agent 启动前发现验收命令引用的构建文件不存在
        // （如 sln/csproj 名拼错），给出明确原因；任务保持待执行状态，
        // 由用户修正验收命令后重新派发，避免 Agent 反复执行后仍验收失败。
        if let Err(preflight_error) = preflight_acceptance_commands(
            Path::new(&contract.working_directory),
            &contract.acceptance_commands,
        ) {
            // 任务回退为 planned：ready 状态不可编辑，回退后用户可直接修正
            // 验收命令（如 sln 文件名）再重新派发。
            task.state = "planned".to_string();
            task.updated_at = chrono::Utc::now().to_rfc3339();
            let _ = Self::save(TASK_NODES_DIR, &task.id, &task);
            return Err(format!("验收命令预检失败: {}", preflight_error));
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
        // 检查重试次数上限。retry_count=0 表示不限制，>0 时已用尽则拦截本次重试。
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
                // 触顶只拦截本任务，不暂停整个交付：暂停后「编辑提高上限再重试」会被下方
                // 「仅运行中的交付」检查拦死，形成无法派发的死锁；交付保持运行，
                // 用户编辑提高上限后可直接重新派发本任务。
                Self::append_event(
                    &task.delivery_id,
                    Some(&task.id),
                    None,
                    "taskRetryBlocked",
                    &format!(
                        "任务「{}」已达到重试上限（{} / {}），请在任务编辑中调整「最大重试次数」后重新派发",
                        task.title, attempted, effective_retry_limit
                    ),
                )?;
                // 触顶清理后旧契约已失效（worktree/分支已回收）：清空 contract_id 并删除契约文件。
                // 否则用户「编辑提高上限再重试」时 dispatch_task_node 会命中契约的
                // 「执行目录不可用」检查而永久卡死（契约存在但 worktree 目录已被清理）。
                if let Some(contract_id) = task.contract_id.take() {
                    let _ = Self::delete(CONTRACTS_DIR, &contract_id, "任务契约");
                }
                task.updated_at = chrono::Utc::now().to_rfc3339();
                let _ = Self::save(TASK_NODES_DIR, &task.id, &task);
                return Err(format!(
                    "任务已达到最大重试次数（{} / {}），请在任务编辑中调整「最大重试次数」（0 = 不限）后重新派发",
                    attempted, effective_retry_limit
                ));
            }
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
                    // 事件写盘失败不中断批量派发：其余就绪任务仍应继续派发
                    let _ = Self::append_event(
                        delivery_id,
                        Some(&task.id),
                        None,
                        "dispatchDeferred",
                        &error,
                    );
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
            return Err(GLOBAL_CAPACITY_ERROR.to_string());
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
            // 派发前探活：CLI 缺失或版本与注入标志不兼容时提前报出明确原因，
            // 避免历史故障中「终端秒退 exit=2 且无任何输出」的模糊失败。
            if let Err(probe_error) = probe_runtime_for_dispatch(&runtime) {
                return Err(format!("派发前 Runtime 探活失败: {}", probe_error));
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
                    "\n推荐做法：不要用 Markdown 代码块包裹 JSON，也不要把结论只放在对话里。审查结束后，直接在终端执行以下命令写入结论（把 comments 的中文结论替换成你的实际结论）：\nSet-Content -LiteralPath {} -Encoding UTF8 -Value '{{\"approved\":true,\"comments\":\"中文审查结论和剩余风险\"}}'\n写入后必须重新读取该文件并自行校验（例如 ConvertFrom-Json），确认合法后再退出当前 CLI。",
                    powershell_literal(&control.review_path.to_string_lossy()),
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
                // 审查结论文件必须由 Agent 按提示词直接写入（Set-Content 等），
                // 不能把 codex 的 --output-last-message 指向 review.json：
                // codex 退出时会用最终消息覆盖该文件，而 DeepSeek 等模型的最终
                // 消息常是散文，把模型已写好的合法 JSON 冲掉（实测复现：写入并
                // 自检通过后 review.json 仍变成 Markdown 导致协议失败）。
                None,
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
                // Review 协议文件缺失/格式不符时最多自动修复 2 轮；
                // 每轮都会用新提示重跑同一 Agent，失败信息累计进 transcript 便于定位。
                let mut review_repairs_left: u32 = 2;
                let mut review_repair_history: Vec<String> = Vec::new();
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
                                if review_repairs_left > 0 {
                                    review_repairs_left -= 1;
                                    review_repair_history.push(validation_error.clone());
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
                let transcript = if review_repair_history.is_empty() {
                    transcript
                } else {
                    format!(
                        "{}\n\nReviewer 协议修复记录：\n{}",
                        transcript,
                        review_repair_history.join("\n")
                    )
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
            let _ = Self::fail_queued_attempt(attempt_id, error);
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
        // 运行目录保留：取消后用户仍需查看现场输出；重试时新 attempt 使用新目录
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
                    // 运行目录保留：取消后现场输出仍可查看
                    let _ = Self::persist_attempt(&updated);
                }
            }
        }
        // 排队中的 attempt 一并取消：否则任务置 cancelled 后仍可被手动 start_attempt
        // 启动，monitor 收尾会把已取消任务的状态覆盖为终态（任务“复活”）。
        Self::cancel_queued_attempts_of_task(&task);
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
        // 级联：依赖链上任一任务被跳过，下游 planned/ready/queued 任务无法再获得产物，一并跳过。
        // queued 必须纳入：已入队未启动的任务若只取消 attempt 而任务保持 queued，
        // 会永久卡死且阻塞交付收尾（合并要求全部 succeeded/skipped）。
        loop {
            let mut cascaded = false;
            for mut downstream in Self::get_task_nodes(&delivery_id)? {
                if skipped_ids.contains(&downstream.id)
                    || !matches!(downstream.state.as_str(), "planned" | "ready" | "queued")
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
    pub(crate) fn cancel_queued_attempts_of_task(task: &AiTaskNode) {
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
    pub(crate) fn cleanup_skipped_task_worktree(task: &AiTaskNode) {
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
        // 重跑验收（skip_audit=true：现场已人工确认，不再重复静态越权判定）。
        // readonly 编排审查任务（requires_workflow_review）需要 review.json 结论：
        // 越权拦截发生在验收前，review.json 未被消费，仍在运行目录中。
        let workflow_review_path = if requires_workflow_review(&task) {
            Some(terminal_run_dir_by_id(&attempt.id).join("review.json"))
        } else {
            None
        };
        let completion_error = Self::run_acceptance_validation(
            &task,
            &contract,
            &project,
            Some(0),
            &None,
            workflow_managed,
            workflow_review_path.as_deref(),
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

    /// 启动本机终端前失败时，不能让任务永久停留在“已排队”。
    /// 容量不足属暂时性错误：任务回退到就绪队列等待自动/手动补派，不置失败；
    /// 其余结构性错误（目录/契约缺失、Agent 禁用等）才置失败要求人工介入。
    pub(crate) fn fail_queued_attempt(attempt_id: &str, reason: &str) -> Result<(), String> {
        let mut attempt = Self::get::<AiAttempt>(ATTEMPTS_DIR, attempt_id, "执行尝试")?;
        if attempt.state != "queued" {
            return Ok(());
        }
        let now = chrono::Utc::now().to_rfc3339();
        // 暂时性错误：容量不足 / 交付被暂停。任务回退就绪队列，恢复后自动补派，不置失败。
        let transient = reason == GLOBAL_CAPACITY_ERROR || reason.contains("交付已暂停或未运行");
        if transient {
            // 全局并发已满：把任务退回就绪/规划态，attempt 取消留痕（不入任务失败统计），
            // 后续工作流步骤完成、恢复、回答决策等自动派发点会再次尝试。
            attempt.state = "cancelled".to_string();
            attempt.finished_at = Some(now.clone());
            attempt.updated_at = now.clone();
            attempt.summary = Some(format!("启动暂缓，任务已退回待执行队列: {}", reason));
            Self::persist_attempt(&attempt)?;
            let mut task = Self::get_task_node(&attempt.task_node_id)?;
            // 依赖读取失败按「未满足」处理（回退 planned），不让回退路径本身报错卡死任务
            let dependencies_ready = task.dependency_ids.iter().all(|dependency_id| {
                Self::get_task_node(dependency_id)
                    .map(|dependency| dependency.state == "succeeded")
                    .unwrap_or(false)
            });
            task.state = if dependencies_ready {
                "ready"
            } else {
                "planned"
            }
            .to_string();
            task.updated_at = now;
            Self::save(TASK_NODES_DIR, &task.id, &task)?;
            // 事件写盘失败不阻断回退流程
            let _ = Self::append_event(
                &attempt.delivery_id,
                Some(&task.id),
                Some(&attempt.id),
                "dispatchDeferred",
                "任务启动暂缓（并发已满或交付暂停），已退回待执行队列，稍后自动重试",
            );
            // 容量满：延时自动补派（60 秒后）——把回退的就绪任务重新排队（创建 queued attempt）。
            // 注意只用 dispatch_ready_tasks 而不经 dispatch_ready_and_start：
            // start_attempt 链路会把 tauri 窗口/菜单系统（comctl32 的 TaskDialogIndirect）拉进
            // 链接，无 manifest 的 cargo test 二进制会因入口点缺失无法加载（见 mod.rs 注释）。
            // queued attempt 的启动由既有自动派发点（其他任务完成续派、resume/answer、重启恢复）
            // 或前端手动「启动」按钮兜底；「交付已暂停」不自动补派——恢复时 resume 路径会派发。
            if reason == GLOBAL_CAPACITY_ERROR {
                let delivery_id_for_retry = task.delivery_id.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(60));
                    let _ = Self::dispatch_ready_tasks(&delivery_id_for_retry);
                });
            }
            return Ok(());
        }
        let mut task = Self::get_task_node(&attempt.task_node_id)?;
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

    pub(crate) fn pause_attempt_for_decision(
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
    pub(crate) fn run_acceptance_validation(
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
                .and_then(|_| {
                    // 模型常忘记提交：允许路径内的改动由平台自动提交，
                    // 避免「Agent 执行后存在未提交改动」直接失败阻断推进。
                    match auto_commit_allowed_changes(
                        contract,
                        &format!("TerminalBuddy: {}", task.title),
                    )? {
                        Some(commit) => {
                            let _ = Self::append_event(
                                &task.delivery_id,
                                Some(&task.id),
                                None,
                                "autoCommitted",
                                &format!("Agent 未提交的改动已由平台自动提交：{}", commit),
                            );
                            Ok(())
                        }
                        None => Ok(()),
                    }
                })
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

    pub(crate) fn finish_attempt(
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
        attempt.summary = Some(match (policy_violation.as_deref(), completion_error.as_deref(), workflow_review.as_ref()) {
            // 越权拦截：summary 必须携带违规原因（stderr 可能为空，不能作为唯一来源）
            (Some(violation), _, _) => format!("{}：{}", violation, compact_output(stderr)),
            (None, Some(error), _) => format!("{}：{}", error, compact_output(stderr)),
            (None, None, Some(review)) => review.comments.clone(),
            _ => compact_output(if successful { stdout } else { stderr }),
        });
       Self::persist_attempt(&attempt)?;
        // 运行目录保留到交付/任务/项目删除：read_attempt_output（前端「查看成果」）、
        // 产物列表/归档/导出与重试续接上下文（final-message.txt / transcript.log）都依赖它，
        // 终态立即删除会让全部成果查看与重试续接失效。
        // 验收所用 review.json / transcript 已在 run_acceptance_validation 中消费完毕。
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

    pub(crate) fn return_review_dependencies_for_rework(
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

    pub(crate) fn select_agent(
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

    pub(crate) fn active_attempt_count_for_agent(agent_id: &str) -> Result<usize, String> {
        Ok(Self::active_attempts_snapshot()?
            .into_iter()
            .filter(|attempt| attempt.agent_id == agent_id)
            .count())
    }

    /// 活跃 attempt 内存索引（N18）：attempt 置 queued/starting/running 时 insert，
    /// 置任何非活跃态（含 needsInput/cancelled/failed/completed/interrupted）时 remove。
    /// 由 persist_attempt 统一维护；lib.rs setup 启动时 rebuild 一次。
    pub(crate) fn active_attempts_index() -> &'static Mutex<HashMap<String, AiAttempt>> {
        static INDEX: OnceLock<Mutex<HashMap<String, AiAttempt>>> = OnceLock::new();
        INDEX.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// 保存 attempt 并同步活跃索引（所有 attempt 持久化的统一收口点）。
    pub(crate) fn persist_attempt(attempt: &AiAttempt) -> Result<(), String> {
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
    pub(crate) fn active_attempts_snapshot() -> Result<Vec<AiAttempt>, String> {
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
    pub(crate) fn global_active_attempts() -> Result<usize, String> {
        Ok(Self::active_attempts_snapshot()?.len())
    }

    /// 派发优先级：workflow 首步 + taskWorktree 的写入任务优先；其余（含 readonly/workspaceRoot）延后。
    pub(crate) fn dispatch_priority(task: &AiTaskNode, delivery: &AiDelivery) -> u8 {
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

    pub(crate) fn check_capacity(
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
    pub(crate) fn prune_delivery_events(delivery_id: &str) {
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
    pub(crate) fn cleanup_attempt_run_dir(attempt_id: &str) {
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
        // 滚动清理：每 50 次写入 prune 一次（prune 全量扫描 EVENTS_DIR，降频避免每次 O(N)）。
        // 只 prune 当前交付会让其他交付的事件文件无限增长（交付数通常小，全量遍历开销可接受）。
        static EVENT_APPEND_COUNTER: AtomicUsize = AtomicUsize::new(0);
        if EVENT_APPEND_COUNTER.fetch_add(1, Ordering::Relaxed) % 50 == 49 {
            if let Ok(deliveries) = Self::get_all_deliveries(None) {
                for delivery in deliveries {
                    Self::prune_delivery_events(&delivery.id);
                }
            }
        }
        Ok(event)
    }

    // ---------- AI 交付事件推送（微信/飞书） ----------

    /// 外部消息 ID → AI 交付决策 ID 映射（推送决策请求时登记，聊天引用回复时解析）。
    /// 进程内映射即可：决策请求推送后通常立即被引用回复回答。
    pub(crate) fn delivery_decision_bindings() -> &'static Mutex<HashMap<String, String>> {
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

    pub(crate) fn delivery_push_client() -> reqwest::Client {
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
                // 交付文件缺失（重启前已被删除）时该 attempt 无法归属，跳过而非中断整个恢复
                let Ok(delivery) = Self::get_delivery(&attempt.delivery_id) else {
                    continue;
                };
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
                // 任务文件缺失（已删除）时只中断 attempt，不阻断其他 attempt 的恢复
                if let Ok(mut task) = Self::get_task_node(&attempt.task_node_id) {
                    if matches!(task.state.as_str(), "queued" | "running") {
                        task.state = "cancelled".to_string();
                        task.updated_at = chrono::Utc::now().to_rfc3339();
                        Self::save(TASK_NODES_DIR, &task.id, &task)?;
                    }
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

}
