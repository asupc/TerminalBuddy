//! AI 交付服务 · 实体 CRUD 模块（自 ai_delivery_service.rs 拆分）
use super::*;

impl AiDeliveryService {
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
