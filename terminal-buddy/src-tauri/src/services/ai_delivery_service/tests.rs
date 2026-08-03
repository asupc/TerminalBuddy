//! AI 交付服务 · 跨域测试模块（自 ai_delivery_service.rs 拆分）
use super::*;

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

    #[test]
    fn skipping_failed_task_cascades_to_downstream_and_unblocks_merge() {
        let root = std::env::temp_dir().join(format!(
            "terminal-buddy-skip-cascade-{}",
            Uuid::new_v4()
        ));
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
            max_concurrency: 2,
        })
        .unwrap();
        let delivery = AiDeliveryService::create_delivery(CreateAiDeliveryInput {
            project_id: project.id.clone(),
            title: "级联跳过测试".to_string(),
            requirement: "验证跳过级联与合并解锁".to_string(),
            manager_agent_id: None,
            workflow_id: None,
        })
        .unwrap();
        let make_task = |title: &str, dependency_ids: Vec<String>| {
            AiDeliveryService::create_task_node(CreateAiTaskNodeInput {
                delivery_id: delivery.id.clone(),
                title: title.to_string(),
                description: "测试任务".to_string(),
                role_id: None,
                workflow_step_id: None,
                preferred_agent_id: Some(agent.id.clone()),
                task_prompt: String::new(),
                execution_mode: "write".to_string(),
                execution_context: EXECUTION_CONTEXT_TASK_WORKTREE.to_string(),
                target_repository_id: project.repositories[0].id.clone(),
                allowed_write_paths: vec!["README.md".to_string()],
                dependency_ids,
                input_artifacts: Vec::new(),
                expected_artifacts: Vec::new(),
                acceptance_commands: Vec::new(),
                retry_count: 0,
                timeout_seconds: None,
            })
            .unwrap()
        };
        let task_a = make_task("任务 A", Vec::new());
        let task_b = make_task("任务 B", vec![task_a.id.clone()]);
        let task_c = make_task("任务 C", vec![task_b.id.clone()]);

        // A 失败 → 标记忽略 → B/C 级联跳过（修复前：B/C 永久停在 planned，交付无法合并）
        let mut failed_a = AiDeliveryService::get_task_node(&task_a.id).unwrap();
        failed_a.state = "failed".to_string();
        AiDeliveryService::save(TASK_NODES_DIR, &failed_a.id, &failed_a).unwrap();
        AiDeliveryService::mark_task_skipped(&task_a.id).unwrap();
        assert_eq!(
            AiDeliveryService::get_task_node(&task_a.id).unwrap().state,
            "skipped"
        );
        assert_eq!(
            AiDeliveryService::get_task_node(&task_b.id).unwrap().state,
            "skipped"
        );
        assert_eq!(
            AiDeliveryService::get_task_node(&task_c.id).unwrap().state,
            "skipped"
        );

        // planned 任务可直接标记忽略（缩小交付范围）
        let task_d = make_task("任务 D", Vec::new());
        AiDeliveryService::mark_task_skipped(&task_d.id).unwrap();
        assert_eq!(
            AiDeliveryService::get_task_node(&task_d.id).unwrap().state,
            "skipped"
        );

        // 合并前置校验：全部 skipped 放行；存在 planned/queued 时拒绝
        let tasks = AiDeliveryService::get_task_nodes(&delivery.id).unwrap();
        let gates = AiDeliveryService::get_review_gates(Some(&delivery.id)).unwrap();
        assert!(AiDeliveryService::validate_tasks_mergeable(&tasks, &gates).is_ok());
        let mut stuck = tasks[0].clone();
        stuck.state = "planned".to_string();
        assert!(AiDeliveryService::validate_tasks_mergeable(&[stuck], &gates).is_err());
        // 非编排 succeeded 任务缺独立门禁时拒绝（回归：门禁校验不被 skipped 过滤破坏）
        let mut need_gate = tasks[0].clone();
        need_gate.state = "succeeded".to_string();
        need_gate.workflow_step_id = None;
        assert!(AiDeliveryService::validate_tasks_mergeable(&[need_gate], &[]).is_err());

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }
}
