//! AI 交付服务 · 实体 CRUD 模块（自 ai_delivery_service.rs 拆分）
use super::*;

impl AiDeliveryService {
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

    pub(crate) fn root_dir() -> PathBuf {
        let dir = PathService::get_data_dir().join("AiDelivery");
        fs::create_dir_all(&dir).ok();
        dir
    }

    pub(crate) fn entity_dir(name: &str) -> PathBuf {
        let dir = Self::root_dir().join(name);
        fs::create_dir_all(&dir).ok();
        dir
    }

    pub(crate) fn list<T: DeserializeOwned>(dir: &str) -> Result<Vec<T>, String> {
        DatabaseService::list_ai_entities(dir)
    }

    pub(crate) fn save<T: Serialize>(dir: &str, id: &str, value: &T) -> Result<(), String> {
        DatabaseService::save_ai_entity(dir, id, value)
    }

    pub(crate) fn get<T: DeserializeOwned>(dir: &str, id: &str, label: &str) -> Result<T, String> {
        DatabaseService::get_ai_entity(dir, id, label)
    }

    pub(crate) fn delete(dir: &str, id: &str, label: &str) -> Result<(), String> {
        DatabaseService::delete_ai_entity(dir, id, label)
    }

    /// 单个事务批量删除同一 kind 的多条记录（删除交付/项目时替代逐条 delete，减少连接开销）。
    pub(crate) fn delete_many(dir: &str, ids: &[&str], label: &str) -> Result<(), String> {
        DatabaseService::delete_ai_entities(dir, ids, label)
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

    /// 应用启动时自动扫描本机已就绪的 CLI 并初始化 Runtime 配置。
    /// 只添加「可用且 kind 未配置」的条目，已配置的 kind 不覆盖（尊重用户配置）；
    /// 幂等，可反复调用。返回本次新增数量。
    pub fn auto_init_runtimes() -> Result<usize, String> {
        let probes = Self::detect_local_runtimes();
        let existing = Self::get_all_runtimes().unwrap_or_default();
        let configured_kinds = existing
            .iter()
            .map(|runtime| runtime.kind.trim().to_ascii_lowercase())
            .collect::<HashSet<_>>();
        let now = chrono::Utc::now().to_rfc3339();
        let mut created = 0usize;
        for probe in probes {
            if !probe.available {
                continue;
            }
            let kind = probe.kind.trim().to_string();
            if kind.is_empty()
                || configured_kinds.contains(&kind.to_ascii_lowercase())
            {
                continue;
            }
            if Self::save_runtime(AiAgentRuntime {
                id: Uuid::new_v4().to_string(),
                name: runtime_display_name(&kind),
                kind: kind.clone(),
                command: probe.command,
                enabled: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
            .is_ok()
            {
                created += 1;
            }
        }
        Ok(created)
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
    /// 按步骤关联角色解析 Agent → Runtime 后走一次对应 Runtime 的一次性调用，
    /// 返回输出前 2000 字符。只调用不落盘、不建 attempt；失败仅前端展示错误，不影响既有功能。
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
        // 步骤 → Agent：优先按角色（锁定 Agent 优先，其次候选）解析，否则取第一个启用的 Agent。
        let agents = Self::get_all_agents()?;
        let agent = if let Some(role_id) = step.role_id.as_deref() {
            let role = Self::get_all_roles()?
                .into_iter()
                .find(|role| role.id == role_id)
                .ok_or_else(|| "工作流步骤关联的角色不存在".to_string())?;
            let locked = role
                .locked_agent_id
                .as_deref()
                .and_then(|id| agents.iter().find(|agent| agent.id == id && agent.enabled));
            locked
                .or_else(|| {
                    role.candidate_agent_ids
                        .iter()
                        .find_map(|id| {
                            agents.iter().find(|agent| agent.id == *id && agent.enabled)
                        })
                })
                .ok_or_else(|| "工作流步骤关联的角色未配置可用的 Agent".to_string())?
        } else {
            agents
                .iter()
                .find(|agent| agent.enabled)
                .ok_or_else(|| {
                    "未找到可用的 Agent（请先在 Agent 管理中启用至少一个）".to_string()
                })?
        };
        // Agent → Runtime：按 Runtime kind 分支拼接一次性命令。
        let runtime = Self::get_all_runtimes()?
            .into_iter()
            .find(|runtime| runtime.id == agent.runtime_id && runtime.enabled)
            .ok_or_else(|| {
                "未找到可用的 Runtime（请先在 Runtime 管理中启用至少一个）".to_string()
            })?;
        Self::run_runtime_one_shot(&runtime, &prompt)
    }

    /// 按 Runtime kind 构造一次性命令并执行（60s 超时），返回输出前 2000 字符。
    fn run_runtime_one_shot(runtime: &AiAgentRuntime, prompt: &str) -> Result<String, String> {
        let mut command_parts = split_runtime_command(&runtime.command)?;
        let executable = command_parts.remove(0);
        let mut command = Command::new(&executable);
        command.args(&command_parts);
        // 模拟测试用的提示词不落盘，直接作为参数传入（限制长度避免命令行超限）
        let clipped = if prompt.len() > 4000 {
            format!("{}…", &prompt[..prompt.ceil_char_boundary(4000)])
        } else {
            prompt.to_string()
        };
        match runtime.kind.trim().to_ascii_lowercase().as_str() {
            // codex 需要 exec 子命令与 --skip-git-repo-check（AI 交付从非 Git 仓库根目录启动）
            "codex" => {
                if !command_parts.iter().any(|argument| argument == "exec") {
                    command.arg("exec");
                }
                if !command_parts.iter().any(|argument| argument == "--skip-git-repo-check") {
                    command.arg("--skip-git-repo-check");
                }
                command.arg("--print").arg(&clipped);
            }
            "opencode" => {
                if !command_parts.iter().any(|argument| argument == "run") {
                    command.arg("run");
                }
                command.arg(&clipped);
            }
            "kimi" => {
                command.arg("--prompt").arg(&clipped);
            }
            "hermes" => {
                // hermes 顶层必须指定子命令（--oneshot 无效），chat --quiet 为程序化单次查询
                if !command_parts.iter().any(|argument| argument == "chat") {
                    command.arg("chat");
                }
                command.arg("--quiet").arg("--query").arg(&clipped);
            }
            "mimo" => {
                // mimo 没有 --print 参数也不从 stdin 读 prompt，run 子命令 + message 传提示词
                if !command_parts.iter().any(|argument| argument == "run") {
                    command.arg("run");
                }
                command.arg(&clipped);
            }
            // claude / pi 走 --print 非交互输出
            "claude" | "pi" => {
                command.arg("--print").arg(&clipped);
            }
            // 未知 kind 兜底：作为最后一个位置参数传入
            _ => {
                command.arg(&clipped);
            }
        }
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
