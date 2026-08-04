//! AI 交付服务 · 跨域测试模块（自 ai_delivery_service.rs 拆分）
#[cfg(test)]
#[allow(unused_imports)] // 仅被下方测试子模块的 use super::* 传播引用
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
    fn save_runtime_new_entry_with_same_command_is_persisted() {
        let root = std::env::temp_dir().join(format!(
            "terminal-buddy-save-runtime-{}",
            Uuid::new_v4()
        ));
        PathService::set_test_data_dir(Some(root.join("data")));
        let now = chrono::Utc::now().to_rfc3339();
        // 用户手动新建第一条
        let first = AiDeliveryService::save_runtime(AiAgentRuntime {
            id: "runtime-1".to_string(),
            name: "Pi".to_string(),
            kind: "pi".to_string(),
            command: "pi".to_string(),
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .unwrap();
        // 用户再次手动新建：显式新 id、相同 kind/command → 必须真实保存，
        // 不能被静默去重成「保存成功但列表无新增」（实测用户反馈：新建保存无数据）。
        let second = AiDeliveryService::save_runtime(AiAgentRuntime {
            id: "runtime-2".to_string(),
            name: "Pi（自定义）".to_string(),
            kind: "pi".to_string(),
            command: "pi".to_string(),
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .unwrap();
        assert_ne!(first.id, second.id, "新建条目不应被静默去重");
        let all = AiDeliveryService::get_all_runtimes().unwrap();
        assert_eq!(all.len(), 2, "两条相同命令的 Runtime 都应保存");

        // 编辑已有记录也不应因其它记录命令相同而被拦（重复项由用户管理/删除）
        let edited = AiDeliveryService::save_runtime(AiAgentRuntime {
            id: "runtime-1".to_string(),
            name: "Pi（已编辑）".to_string(),
            kind: "pi".to_string(),
            command: "pi".to_string(),
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .unwrap();
        assert_eq!(edited.name, "Pi（已编辑）");

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn auto_init_runtimes_does_not_duplicate_configured_kinds() {
        let root = std::env::temp_dir().join(format!(
            "terminal-buddy-auto-init-{}",
            Uuid::new_v4()
        ));
        PathService::set_test_data_dir(Some(root.join("data")));
        let now = chrono::Utc::now().to_rfc3339();
        // 预置一个已配置的 codex Runtime
        AiDeliveryService::save_runtime(AiAgentRuntime {
            id: "runtime-codex".to_string(),
            name: "Codex".to_string(),
            kind: "codex".to_string(),
            command: "codex".to_string(),
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .unwrap();
        let before = AiDeliveryService::get_all_runtimes().unwrap().len();
        let created = AiDeliveryService::auto_init_runtimes().unwrap();
        let after = AiDeliveryService::get_all_runtimes().unwrap();
        // 已配置 kind 不重复添加
        assert_eq!(
            after
                .iter()
                .filter(|runtime| runtime.kind.eq_ignore_ascii_case("codex"))
                .count(),
            1,
            "已配置的 codex 不应被重复初始化"
        );
        // 新增数量与列表增长一致（本机探测到其它可用 CLI 时才会新增）
        assert_eq!(after.len() - before, created);

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
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
    fn reduce_transitive_dependencies_keeps_only_direct_edges() {
        // A ← B ← C ← D：D 直接依赖 C，B 依赖 A，C 依赖 B
        let chain = vec![
            node("a", vec![]),
            node("b", vec!["a".to_string()]),
            node("c", vec!["b".to_string()]),
        ];
        // D 被写入 [A, B, C] 三个依赖（旧版/管理者常输出传递依赖）
        let reduced = reduce_transitive_dependencies(
            vec![
                "a".to_string(),
                "b".to_string(),
                "c".to_string(),
            ],
            chain.iter(),
        );
        assert_eq!(reduced, vec!["c".to_string()], "只应保留直接依赖 C");

        // 并行依赖互不可达，全部保留
        let parallel = vec![
            node("a", vec![]),
            node("b", vec![]),
            node("c", vec!["a".to_string(), "b".to_string()]),
        ];
        let reduced_parallel = reduce_transitive_dependencies(
            vec!["a".to_string(), "b".to_string()],
            parallel.iter(),
        );
        assert_eq!(
            reduced_parallel,
            vec!["a".to_string(), "b".to_string()],
            "并行依赖应全部保留"
        );

        // 重复依赖去重
        let reduced_dup = reduce_transitive_dependencies(
            vec!["a".to_string(), "a".to_string(), "c".to_string()],
            chain.iter(),
        );
        assert_eq!(reduced_dup, vec!["c".to_string()]);
    }

    #[test]
    fn preflight_acceptance_commands_detects_missing_build_target() {
        let root = std::env::temp_dir().join(format!(
            "terminal-buddy-preflight-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Kyber.Industry.Base.Data.sln"), "").unwrap();

        // 拼错 sln 名：应报“文件不存在”
        let missing = preflight_acceptance_commands(
            &root,
            &["dotnet build Kyber.Industry.BaseData.sln -c Debug --nologo -v q".to_string()],
        )
        .unwrap_err();
        assert!(
            missing.contains("不存在") && missing.contains("Kyber.Industry.BaseData.sln"),
            "应明确指出缺失文件: {}",
            missing
        );

        // 正确的 sln 名：通过
        preflight_acceptance_commands(
            &root,
            &["dotnet build Kyber.Industry.Base.Data.sln -c Debug --nologo -v q".to_string()],
        )
        .unwrap();

        // 产物验收（test -f / Test-Path）不预检：派发时产物尚不存在属正常
        preflight_acceptance_commands(
            &root,
            &[
                "test -f docs/team-conventions.md".to_string(),
                "if (Test-Path -LiteralPath 'docs/x.md') { exit 0 } else { exit 1 }".to_string(),
            ],
        )
        .unwrap();

        // 子目录 csproj：存在通过，不存在报错
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/App.csproj"), "").unwrap();
        preflight_acceptance_commands(&root, &["dotnet build src/App.csproj".to_string()])
            .unwrap();
        let missing_sub = preflight_acceptance_commands(
            &root,
            &["dotnet build src/NoSuch.csproj".to_string()],
        )
        .unwrap_err();
        assert!(missing_sub.contains("src/NoSuch.csproj"));

        // 非构建命令跳过
        preflight_acceptance_commands(&root, &["npm run build".to_string()]).unwrap();

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preflight_acceptance_commands_checks_default_build_dir() {
        // 无目标参数的 dotnet build：目录没有项目文件应报错
        let empty = std::env::temp_dir().join(format!(
            "terminal-buddy-preflight-empty-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&empty).unwrap();
        let err = preflight_acceptance_commands(
            &empty,
            &["dotnet build -c Debug".to_string()],
        )
        .unwrap_err();
        assert!(err.contains("未找到"), "应提示目录缺少项目文件: {}", err);

        // 有 sln 时通过
        fs::write(empty.join("Demo.sln"), "").unwrap();
        preflight_acceptance_commands(&empty, &["dotnet build -c Debug".to_string()]).unwrap();

        let _ = fs::remove_dir_all(empty);
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

    /// 快速搭建隔离的 git 仓库 + 项目 + 交付环境（与既有端到端测试同构）。
    fn setup_git_project() -> (PathBuf, AiProject, AiDelivery, AiAgent) {
        let root =
            std::env::temp_dir().join(format!("terminal-buddy-git-env-{}", Uuid::new_v4()));
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
            title: "测试交付".to_string(),
            requirement: "验证编排边界".to_string(),
            manager_agent_id: None,
            workflow_id: None,
        })
        .unwrap();
        (root, project, delivery, agent)
    }

    fn make_write_task(
        delivery: &AiDelivery,
        project: &AiProject,
        agent: &AiAgent,
        title: &str,
        dependency_ids: Vec<String>,
    ) -> AiTaskNode {
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
    }

    fn make_readonly_analysis_task(
        delivery: &AiDelivery,
        project: &AiProject,
        agent: &AiAgent,
    ) -> AiTaskNode {
        AiDeliveryService::create_task_node(CreateAiTaskNodeInput {
            delivery_id: delivery.id.clone(),
            title: "只读分析".to_string(),
            description: "只读分析任务".to_string(),
            role_id: None,
            workflow_step_id: None,
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
        .unwrap()
    }

    /// 约束 #2 升级后，manager prompt 必须给出可操作的跨服务依赖判断准则，
    /// 否则 AI 会漏建跨仓库依赖（根因见 docs/superpowers/specs/2026-08-04-dag-tab-and-cross-repo-dependency-design.md）。
    #[test]
    fn manager_prompt_includes_cross_service_dependency_guidance() {
        let (root, project, delivery, _agent) = setup_git_project();
        let prompt = build_manager_prompt(&delivery, &project, &[]);

        assert!(
            prompt.contains("跨服务依赖判断"),
            "manager prompt 缺少跨服务依赖判断小节: {prompt}"
        );
        assert!(
            prompt.contains("B 离开 A 能否独立正确完成"),
            "manager prompt 缺少判断口诀: {prompt}"
        );
        assert!(
            prompt.contains("不得建立依赖"),
            "manager prompt 缺少反向约束（无契约不得建依赖）: {prompt}"
        );

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn capacity_blocked_start_reverts_task_to_ready() {
        let root =
            std::env::temp_dir().join(format!("terminal-buddy-capacity-{}", Uuid::new_v4()));
        let data_dir = root.join("data");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        PathService::set_test_data_dir(Some(data_dir));

        let now = chrono::Utc::now().to_rfc3339();
        let project = AiProject {
            id: "project".to_string(),
            name: "测试项目".to_string(),
            workspace_root: workspace.to_string_lossy().to_string(),
            repositories: Vec::new(),
            worktree_root: None,
            quality_gate: AiQualityGate::default(),
            manager_agent_id: None,
            max_concurrency: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        AiDeliveryService::save(PROJECTS_DIR, &project.id, &project).unwrap();
        let delivery = AiDeliveryService::create_delivery(CreateAiDeliveryInput {
            project_id: project.id.clone(),
            title: "容量测试".to_string(),
            requirement: "验证容量回退".to_string(),
            manager_agent_id: None,
            workflow_id: None,
        })
        .unwrap();
        let mut running = delivery.clone();
        running.state = "running".to_string();
        AiDeliveryService::save(DELIVERIES_DIR, &running.id, &running).unwrap();
        let task = AiTaskNode {
            id: "task".to_string(),
            delivery_id: delivery.id.clone(),
            title: "容量任务".to_string(),
            description: "测试".to_string(),
            role_id: None,
            workflow_step_id: None,
            preferred_agent_id: None,
            task_prompt: String::new(),
            execution_mode: "write".to_string(),
            execution_context: EXECUTION_CONTEXT_TASK_WORKTREE.to_string(),
            target_repository_id: String::new(),
            allowed_write_paths: vec![".".to_string()],
            dependency_ids: Vec::new(),
            input_artifacts: Vec::new(),
            expected_artifacts: Vec::new(),
            acceptance_commands: Vec::new(),
            retry_count: 0,
            timeout_seconds: None,
            state: "ready".to_string(),
            assigned_agent_id: None,
            contract_id: None,
            attempt_ids: vec!["attempt".to_string()],
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        AiDeliveryService::save(TASK_NODES_DIR, &task.id, &task).unwrap();
        running.task_node_ids.push(task.id.clone());
        AiDeliveryService::save(DELIVERIES_DIR, &running.id, &running).unwrap();
        let attempt = AiAttempt {
            id: "attempt".to_string(),
            delivery_id: delivery.id.clone(),
            task_node_id: task.id.clone(),
            contract_id: "contract".to_string(),
            agent_id: "agent".to_string(),
            runtime_id: "runtime".to_string(),
            terminal_id: None,
            state: "queued".to_string(),
            started_at: now.clone(),
            finished_at: None,
            exit_code: None,
            summary: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        AiDeliveryService::persist_attempt(&attempt).unwrap();

        // 容量错误：任务回退 ready、attempt 取消留痕（不置 failed）
        AiDeliveryService::fail_queued_attempt(&attempt.id, GLOBAL_CAPACITY_ERROR).unwrap();
        assert_eq!(
            AiDeliveryService::get_task_node(&task.id).unwrap().state,
            "ready"
        );
        assert_eq!(
            AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, &attempt.id, "执行尝试")
                .unwrap()
                .state,
            "cancelled"
        );

        // 结构错误：仍置 failed（要求人工介入）
        let task2_id = "task2".to_string();
        let mut task2 = task.clone();
        task2.id = task2_id.clone();
        task2.attempt_ids = vec!["attempt2".to_string()];
        AiDeliveryService::save(TASK_NODES_DIR, &task2.id, &task2).unwrap();
        let mut attempt2 = attempt.clone();
        attempt2.id = "attempt2".to_string();
        attempt2.task_node_id = task2_id.clone();
        attempt2.state = "queued".to_string();
        AiDeliveryService::persist_attempt(&attempt2).unwrap();
        AiDeliveryService::fail_queued_attempt(&attempt2.id, "任务执行目录不可用").unwrap();
        assert_eq!(
            AiDeliveryService::get_task_node(&task2_id).unwrap().state,
            "failed"
        );

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn skipping_queued_downstream_cascades_and_cancels_attempt() {
        let (root, project, delivery, agent) = setup_git_project();
        let task_a = make_write_task(&delivery, &project, &agent, "任务 A", Vec::new());
        let task_b = make_write_task(&delivery, &project, &agent, "任务 B", vec![task_a.id.clone()]);

        // A 真实派发（创建契约+worktree）→ 置成功 → B ready → 派发 B（queued）
        AiDeliveryService::approve_delivery(&delivery.id).unwrap();
        let attempt_a = AiDeliveryService::dispatch_task_node(&task_a.id, None).unwrap();
        // A 验收通过：attempt 置终态释放 Agent 并发配额（agent max_concurrency = 1）
        let mut completed_a_attempt =
            AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, &attempt_a.id, "执行尝试").unwrap();
        completed_a_attempt.state = "completed".to_string();
        AiDeliveryService::persist_attempt(&completed_a_attempt).unwrap();
        let mut succeeded_a = AiDeliveryService::get_task_node(&task_a.id).unwrap();
        succeeded_a.state = "succeeded".to_string();
        AiDeliveryService::save(TASK_NODES_DIR, &succeeded_a.id, &succeeded_a).unwrap();
        AiDeliveryService::refresh_ready_task_nodes(&delivery.id).unwrap();
        assert_eq!(
            AiDeliveryService::get_task_node(&task_b.id).unwrap().state,
            "ready"
        );
        let attempt = AiDeliveryService::dispatch_task_node(&task_b.id, None).unwrap();
        assert_eq!(attempt.state, "queued");

        // A 改失败 → 标记跳过 → B（queued）级联跳过且 attempt 取消，不卡死
        let mut failed_a = AiDeliveryService::get_task_node(&task_a.id).unwrap();
        failed_a.state = "failed".to_string();
        AiDeliveryService::save(TASK_NODES_DIR, &failed_a.id, &failed_a).unwrap();
        AiDeliveryService::mark_task_skipped(&task_a.id).unwrap();
        let skipped_b = AiDeliveryService::get_task_node(&task_b.id).unwrap();
        assert_eq!(skipped_b.state, "skipped");
        assert_eq!(
            AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, &attempt.id, "执行尝试")
                .unwrap()
                .state,
            "cancelled"
        );
        // 跳过任务的 worktree 已回收（目录不存在），不再阻塞交付收尾
        let contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &skipped_b.contract_id.clone().unwrap(),
            "任务契约",
        )
        .unwrap();
        assert!(contract
            .worktree_path
            .as_deref()
            .map(|path| !PathBuf::from(path).exists())
            .unwrap_or(false));
        let tasks = AiDeliveryService::get_task_nodes(&delivery.id).unwrap();
        let gates = AiDeliveryService::get_review_gates(Some(&delivery.id)).unwrap();
        assert!(AiDeliveryService::validate_tasks_mergeable(&tasks, &gates).is_ok());

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn editing_execution_environment_rebuilds_contract() {
        let (root, project, delivery, agent) = setup_git_project();
        let task = make_write_task(&delivery, &project, &agent, "实现任务", Vec::new());
        AiDeliveryService::approve_delivery(&delivery.id).unwrap();
        let attempt = AiDeliveryService::dispatch_task_node(&task.id, None).unwrap();
        let contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &attempt.contract_id,
            "任务契约",
        )
        .unwrap();
        let worktree = PathBuf::from(contract.worktree_path.clone().unwrap());
        assert!(worktree.is_dir());

        // 任务失败后可编辑；执行环境字段（模式/上下文）变更 → 旧契约与 worktree 被丢弃重建
        let mut failed_attempt = attempt.clone();
        failed_attempt.state = "failed".to_string();
        AiDeliveryService::persist_attempt(&failed_attempt).unwrap();
        let mut failed_task = AiDeliveryService::get_task_node(&task.id).unwrap();
        failed_task.state = "failed".to_string();
        AiDeliveryService::save(TASK_NODES_DIR, &failed_task.id, &failed_task).unwrap();

        let updated = AiDeliveryService::update_task_node(UpdateAiTaskNodeInput {
            id: task.id.clone(),
            title: None,
            description: None,
            role_id: None,
            preferred_agent_id: None,
            task_prompt: None,
            execution_mode: Some("readonly".to_string()),
            execution_context: Some(EXECUTION_CONTEXT_WORKSPACE_ROOT.to_string()),
            target_repository_id: None,
            allowed_write_paths: None,
            dependency_ids: None,
            expected_artifacts: None,
            acceptance_commands: None,
            timeout_seconds: None,
            retry_count: None,
        })
        .unwrap();
        assert_eq!(updated.execution_mode, "readonly");
        assert_eq!(updated.execution_context, EXECUTION_CONTEXT_WORKSPACE_ROOT);
        assert!(updated.contract_id.is_none());
        assert!(AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &attempt.contract_id,
            "任务契约"
        )
        .is_err());
        assert!(!worktree.exists());

        // 重试派发走全新契约路径：新契约按新执行环境创建（workspaceRoot 无 worktree/分支）
        let retried = AiDeliveryService::retry_task_node(&task.id).unwrap();
        assert_eq!(retried.state, "ready");
        let new_attempt = AiDeliveryService::dispatch_task_node(&task.id, None).unwrap();
        let new_contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &new_attempt.contract_id,
            "任务契约",
        )
        .unwrap();
        assert_eq!(new_contract.execution_context, EXECUTION_CONTEXT_WORKSPACE_ROOT);
        assert!(new_contract.worktree_path.is_none());

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn merge_continuation_needed_covers_failed_and_rolled_back() {
        assert!(AiDeliveryService::merge_continuation_needed("failed"));
        assert!(AiDeliveryService::merge_continuation_needed("rolledBack"));
        assert!(!AiDeliveryService::merge_continuation_needed("merged"));
        assert!(!AiDeliveryService::merge_continuation_needed("rollbackFailed"));
        assert!(!AiDeliveryService::merge_continuation_needed("pending"));
    }

    /// F1 回归：continue_merge_after_conflict 必须重跑 failed 与 rolledBack 两类仓库子记录。
    /// 首次合并失败时 rollback_merge_record 会把已合并仓库 reset 回合并前 HEAD，
    /// 只重跑 failed 会让被回滚仓库的改动永久丢失而交付仍宣告完成。
    #[test]
    fn merge_continuation_retries_failed_and_rolled_back_repositories() {
        let (root, project, delivery, agent) = setup_git_project();
        // 测试同时派发两个任务：放宽 Agent 并发配额（默认 1）
        let mut editable_agent = agent.clone();
        editable_agent.max_concurrency = 2;
        let agent = AiDeliveryService::save_agent(editable_agent).unwrap();
        let task_a = make_write_task(&delivery, &project, &agent, "任务 A", Vec::new());
        let mut task_b = make_write_task(&delivery, &project, &agent, "任务 B", Vec::new());
        // 两个任务必须写入不同范围，否则派发时被「同一仓库重叠写入范围」拦截
        task_b.allowed_write_paths = vec!["docs/".to_string()];
        AiDeliveryService::save(TASK_NODES_DIR, &task_b.id, &task_b).unwrap();
        AiDeliveryService::approve_delivery(&delivery.id).unwrap();
        let attempt_a = AiDeliveryService::dispatch_task_node(&task_a.id, None).unwrap();
        let attempt_b = AiDeliveryService::dispatch_task_node(&task_b.id, None).unwrap();

        // 模拟两个任务均在各自 worktree 完成改动并通过验收（分支 HEAD 记录为 validated_commit）
        let source = project_repository_path(&project, &project.repositories[0]).unwrap();
        let pre_merge_head = run_git(&source, &["rev-parse".to_string(), "HEAD".to_string()]).unwrap();
        let mut branches = Vec::new();
        for (task, attempt) in [(&task_a, &attempt_a), (&task_b, &attempt_b)] {
            let contract = AiDeliveryService::get::<AiTaskContract>(
                CONTRACTS_DIR,
                &attempt.contract_id,
                "任务契约",
            )
            .unwrap();
            let worktree = PathBuf::from(contract.worktree_path.as_deref().unwrap());
            // 两个任务写不同文件，避免 merge 时产生真实冲突（本测试关注续接逻辑而非解决冲突）
            if task.title == "任务 A" {
                fs::write(worktree.join("README.md"), "change by A").unwrap();
            } else {
                fs::create_dir_all(worktree.join("docs")).unwrap();
                fs::write(worktree.join("docs/feature.md"), "change by B").unwrap();
            }
            run_git(&worktree, &["add".to_string(), ".".to_string()]).unwrap();
            run_git(
                &worktree,
                &["commit".to_string(), "-m".to_string(), task.title.clone()],
            )
            .unwrap();
            let head = run_git(&worktree, &["rev-parse".to_string(), "HEAD".to_string()]).unwrap();
            let mut updated_contract = contract.clone();
            updated_contract.validated_commit = Some(head);
            AiDeliveryService::save(CONTRACTS_DIR, &updated_contract.id, &updated_contract).unwrap();
            let mut completed_attempt = AiDeliveryService::get::<AiAttempt>(
                ATTEMPTS_DIR,
                &attempt.id,
                "执行尝试",
            )
            .unwrap();
            completed_attempt.state = "completed".to_string();
            AiDeliveryService::persist_attempt(&completed_attempt).unwrap();
            let mut succeeded_task = AiDeliveryService::get_task_node(&task.id).unwrap();
            succeeded_task.state = "succeeded".to_string();
            AiDeliveryService::save(TASK_NODES_DIR, &succeeded_task.id, &succeeded_task).unwrap();
            branches.push((
                updated_contract.branch_name.clone().unwrap(),
                task.title.clone(),
            ));
        }

        // 构造 blocked 合并记录：A 已合并后被回滚（rolledBack），B 冲突待续接（failed）
        let now = chrono::Utc::now().to_rfc3339();
        let mut record = AiMergeRecord {
            id: Uuid::new_v4().to_string(),
            delivery_id: delivery.id.clone(),
            project_id: project.id.clone(),
            state: "blocked".to_string(),
            repositories: branches
                .iter()
                .map(|(branch, _)| AiMergeRepositoryRecord {
                    repository_id: project.repositories[0].id.clone(),
                    branch_name: branch.clone(),
                    pre_merge_head: pre_merge_head.clone(),
                    merged_head: None,
                    state: "pending".to_string(),
                    error: None,
                })
                .collect(),
            created_at: now.clone(),
            updated_at: now,
        };
        record.repositories[0].state = "rolledBack".to_string();
        record.repositories[1].state = "failed".to_string();
        AiDeliveryService::save(MERGE_RECORDS_DIR, &record.id, &record).unwrap();

        AiDeliveryService::continue_merge_after_conflict(&delivery.id).unwrap();
        let stored =
            AiDeliveryService::get::<AiMergeRecord>(MERGE_RECORDS_DIR, &record.id, "合并记录")
                .unwrap();
        assert_eq!(
            stored.state,
            "completed",
            "续接失败: {:?}",
            stored
                .repositories
                .iter()
                .map(|r| (
                    r.branch_name.as_str(),
                    r.state.as_str(),
                    r.error.as_deref().unwrap_or("")
                ))
                .collect::<Vec<_>>()
        );
        assert!(
            stored.repositories.iter().all(|r| r.state == "merged"),
            "rolledBack 仓库必须一并重新合并: {:?}",
            stored
                .repositories
                .iter()
                .map(|r| (r.branch_name.as_str(), r.state.as_str()))
                .collect::<Vec<_>>()
        );
        // 目标仓库应包含两个任务分支的合并提交
        let log = run_git(&source, &["log".to_string(), "--oneline".to_string()]).unwrap();
        assert!(
            log.contains("TerminalBuddy:") && !log.contains("terminalbuddy/"),
            "合并提交消息应可读（不得使用 UUID 分支名）: {}",
            log
        );

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// F4 回归：重试触顶清理 worktree 后必须清空 contract_id 并删除契约文件，
    /// 否则用户提高重试上限后 dispatch 会命中「执行目录不可用」永久卡死。
    #[test]
    fn retry_cap_exhaustion_clears_contract_for_retry() {
        let (root, project, delivery, agent) = setup_git_project();
        let mut task = make_write_task(&delivery, &project, &agent, "实现任务", Vec::new());
        task.retry_count = 1;
        AiDeliveryService::save(TASK_NODES_DIR, &task.id, &task).unwrap();
        AiDeliveryService::approve_delivery(&delivery.id).unwrap();
        let attempt = AiDeliveryService::dispatch_task_node(&task.id, None).unwrap();
        let contract_id = attempt.contract_id.clone();
        assert!(AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &contract_id,
            "任务契约"
        )
        .is_ok());

        // 首次执行失败（attempt failed + task failed）
        let mut failed_attempt = AiDeliveryService::get::<AiAttempt>(
            ATTEMPTS_DIR,
            &attempt.id,
            "执行尝试",
        )
        .unwrap();
        failed_attempt.state = "failed".to_string();
        AiDeliveryService::persist_attempt(&failed_attempt).unwrap();
        let mut failed_task = AiDeliveryService::get_task_node(&task.id).unwrap();
        failed_task.state = "failed".to_string();
        AiDeliveryService::save(TASK_NODES_DIR, &failed_task.id, &failed_task).unwrap();

        // 触顶：attempted=1 >= retry_count=1 → worktree 回收 + contract_id 清空；交付保持运行，
        // 否则「编辑提高上限再重试」会被「仅运行中的交付」检查拦死，形成无法派发的死锁。
        let result = AiDeliveryService::retry_task_node(&task.id);
        assert!(result.is_err(), "应触顶报错: {:?}", result);
        let after_cap = AiDeliveryService::get_task_node(&task.id).unwrap();
        assert!(after_cap.contract_id.is_none(), "触顶后 contract_id 应清空");
        assert!(
            AiDeliveryService::get::<AiTaskContract>(CONTRACTS_DIR, &contract_id, "任务契约")
                .is_err(),
            "触顶后契约文件应删除"
        );
        assert_eq!(
            AiDeliveryService::get_delivery(&delivery.id).unwrap().state,
            "running",
            "触顶不应暂停交付"
        );

        // 用户编辑提高重试上限后无需恢复交付，直接重试派发走全新契约路径
        let updated = AiDeliveryService::update_task_node(UpdateAiTaskNodeInput {
            id: task.id.clone(),
            title: None,
            description: None,
            role_id: None,
            preferred_agent_id: None,
            task_prompt: None,
            execution_mode: None,
            execution_context: None,
            target_repository_id: None,
            allowed_write_paths: None,
            dependency_ids: None,
            expected_artifacts: None,
            acceptance_commands: None,
            timeout_seconds: None,
            retry_count: Some(3),
        })
        .unwrap();
        assert_eq!(updated.retry_count, 3);
        let retried = AiDeliveryService::retry_task_node(&task.id).unwrap();
        assert_eq!(retried.state, "ready");
        let new_attempt = AiDeliveryService::dispatch_task_node(&task.id, None).unwrap();
        assert_ne!(new_attempt.contract_id, contract_id, "重试应使用全新契约");
        assert!(AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &new_attempt.contract_id,
            "任务契约"
        )
        .is_ok());

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// F2 回归：discard_task_contract（编辑执行环境字段）必须同时回收成果交接目录，
    /// 否则重试派发被 materialize_dependency_artifacts 的「交接目录已存在」拒绝。
    #[test]
    fn discard_task_contract_removes_handoff_directory() {
        let (root, project, delivery, agent) = setup_git_project();
        let task = make_write_task(&delivery, &project, &agent, "实现任务", Vec::new());
        AiDeliveryService::approve_delivery(&delivery.id).unwrap();
        let attempt = AiDeliveryService::dispatch_task_node(&task.id, None).unwrap();
        let mut stored_task = AiDeliveryService::get_task_node(&task.id).unwrap();
        assert!(stored_task.contract_id.is_some());

        // 构造契约对应任务的成果交接目录（materialize_dependency_artifacts 的落点）
        let handoff_root = project_artifact_base_path(&project)
            .join("handoff")
            .join(compact_path_id(&delivery.id))
            .join(compact_path_id(&task.id));
        fs::create_dir_all(&handoff_root).unwrap();
        fs::write(handoff_root.join("analysis.md"), "result").unwrap();

        let cleaned = discard_task_contract(&mut stored_task);
        assert!(cleaned);
        assert!(stored_task.contract_id.is_none());
        assert!(!handoff_root.exists(), "交接目录应被回收");
        assert!(AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &attempt.contract_id,
            "任务契约"
        )
        .is_err());

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// 回归：readonly 任务派发时若 outputs 目录已存在但为空（上次未产出/中断残留），
    /// 不应拒绝派发——应清理重建，否则任务被空目录永久卡死。
    #[test]
    fn readonly_dispatch_recovers_from_empty_outputs_directory() {
        let (root, project, delivery, agent) = setup_git_project();
        let task = make_readonly_analysis_task(&delivery, &project, &agent);
        AiDeliveryService::approve_delivery(&delivery.id).unwrap();

        // 模拟上次派发未产出/中断留下的空 outputs 残留
        let output_root = project_artifact_base_path(&project)
            .join("outputs")
            .join(compact_path_id(&delivery.id))
            .join(compact_path_id(&task.id));
        fs::create_dir_all(&output_root).unwrap();
        assert_eq!(fs::read_dir(&output_root).unwrap().count(), 0);

        // 空残留不应阻塞派发：应清理重建
        let attempt = AiDeliveryService::dispatch_task_node(&task.id, None);
        assert!(
            attempt.is_ok(),
            "空 outputs 残留应允许派发: {:?}",
            attempt.err()
        );

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// 回归：write 任务派发时若 handoff 目录已存在但为空（上次拷贝中断/回收未清理），
    /// 不应拒绝派发——应清理重建并重新拷贝前置成果。
    #[test]
    fn write_dispatch_recovers_from_empty_handoff_directory() {
        let (root, project, delivery, agent) = setup_git_project();
        // 前置 readonly 任务产出成果并标记成功
        let upstream = make_readonly_analysis_task(&delivery, &project, &agent);
        // 下游 write 任务使用前置成果（须在交付审批前创建）
        let downstream = AiDeliveryService::create_task_node(CreateAiTaskNodeInput {
            delivery_id: delivery.id.clone(),
            title: "下游实现".to_string(),
            description: "使用前置成果".to_string(),
            role_id: None,
            workflow_step_id: None,
            preferred_agent_id: Some(agent.id.clone()),
            task_prompt: String::new(),
            execution_mode: "write".to_string(),
            execution_context: EXECUTION_CONTEXT_TASK_WORKTREE.to_string(),
            target_repository_id: project.repositories[0].id.clone(),
            allowed_write_paths: vec!["README.md".to_string()],
            dependency_ids: vec![upstream.id.clone()],
            input_artifacts: vec!["analysis/service-a.md".to_string()],
            expected_artifacts: Vec::new(),
            acceptance_commands: Vec::new(),
            retry_count: 0,
            timeout_seconds: None,
        })
        .unwrap();

        AiDeliveryService::approve_delivery(&delivery.id).unwrap();
        let upstream_attempt = AiDeliveryService::dispatch_task_node(&upstream.id, None).unwrap();
        let mut upstream_contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &upstream_attempt.contract_id,
            "任务契约",
        )
        .unwrap();
        let upstream_output =
            PathBuf::from(upstream_contract.output_artifact_directory.as_deref().unwrap());
        fs::create_dir_all(upstream_output.join("analysis")).unwrap();
        fs::write(upstream_output.join("analysis/service-a.md"), "结论").unwrap();
        let mut up_attempt = upstream_attempt.clone();
        up_attempt.state = "completed".to_string();
        AiDeliveryService::save(ATTEMPTS_DIR, &up_attempt.id, &up_attempt).unwrap();
        let mut up_task = AiDeliveryService::get_task_node(&upstream.id).unwrap();
        up_task.state = "succeeded".to_string();
        AiDeliveryService::save(TASK_NODES_DIR, &up_task.id, &up_task).unwrap();
        upstream_contract.state = "completed".to_string();
        AiDeliveryService::save(CONTRACTS_DIR, &upstream_contract.id, &upstream_contract)
            .unwrap();

        // 上游验收通过后下游就绪（手动模拟，聚焦 handoff 残留场景）
        let mut down_task = AiDeliveryService::get_task_node(&downstream.id).unwrap();
        down_task.state = "ready".to_string();
        AiDeliveryService::save(TASK_NODES_DIR, &down_task.id, &down_task).unwrap();

        // 模拟上次拷贝中断/回收未清理留下的空 handoff 残留
        let handoff_root = project_artifact_base_path(&project)
            .join("handoff")
            .join(compact_path_id(&delivery.id))
            .join(compact_path_id(&downstream.id));
        fs::create_dir_all(&handoff_root).unwrap();

        // 空残留不应阻塞派发：应清理重建并拷贝前置成果
        let attempt = AiDeliveryService::dispatch_task_node(&downstream.id, None);
        assert!(
            attempt.is_ok(),
            "空 handoff 残留应允许派发: {:?}",
            attempt.err()
        );

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// 回归：discard_task_contract 必须同时回收只读任务的 outputs 成果目录，
    /// 否则重派会被 prepare_output_artifact_directory 的残留检查阻塞。
    #[test]
    fn discard_task_contract_removes_outputs_directory() {
        let (root, _project, delivery, agent) = setup_git_project();
        let task = make_readonly_analysis_task(&delivery, &_project, &agent);
        AiDeliveryService::approve_delivery(&delivery.id).unwrap();
        let attempt = AiDeliveryService::dispatch_task_node(&task.id, None).unwrap();
        let mut stored_task = AiDeliveryService::get_task_node(&task.id).unwrap();
        assert!(stored_task.contract_id.is_some());

        let contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &attempt.contract_id,
            "任务契约",
        )
        .unwrap();
        let output_root = PathBuf::from(contract.output_artifact_directory.as_deref().unwrap());
        assert!(output_root.is_dir());
        fs::create_dir_all(output_root.join("analysis")).unwrap();
        fs::write(output_root.join("analysis/service-a.md"), "结论").unwrap();

        let cleaned = discard_task_contract(&mut stored_task);
        assert!(cleaned);
        assert!(stored_task.contract_id.is_none());
        assert!(!output_root.exists(), "只读成果目录应被回收");

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// F5 回归：mergeFailed 是交付终态（无继续入口除非续接成功），必须允许删除。
    #[test]
    fn deleting_merge_failed_delivery_allowed() {
        let (root, _project, delivery, _agent) = setup_git_project();
        let mut failed_delivery = AiDeliveryService::get_delivery(&delivery.id).unwrap();
        failed_delivery.state = "mergeFailed".to_string();
        AiDeliveryService::save(DELIVERIES_DIR, &failed_delivery.id, &failed_delivery).unwrap();
        AiDeliveryService::delete_delivery(&failed_delivery.id).unwrap();
        assert!(AiDeliveryService::get_delivery(&failed_delivery.id).is_err());

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// F3 回归：删除任务节点必须回收其 worktree 目录与 git 分支，避免资源残留。
    #[test]
    fn deleting_task_node_reclaims_worktree() {
        let (root, project, delivery, agent) = setup_git_project();
        let task = make_write_task(&delivery, &project, &agent, "实现任务", Vec::new());
        AiDeliveryService::approve_delivery(&delivery.id).unwrap();
        let attempt = AiDeliveryService::dispatch_task_node(&task.id, None).unwrap();
        let contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &attempt.contract_id,
            "任务契约",
        )
        .unwrap();
        let worktree = PathBuf::from(contract.worktree_path.as_deref().unwrap());
        assert!(worktree.is_dir());

        // 置 failed 后删除任务
        let mut failed_attempt = AiDeliveryService::get::<AiAttempt>(
            ATTEMPTS_DIR,
            &attempt.id,
            "执行尝试",
        )
        .unwrap();
        failed_attempt.state = "failed".to_string();
        AiDeliveryService::persist_attempt(&failed_attempt).unwrap();
        let mut failed_task = AiDeliveryService::get_task_node(&task.id).unwrap();
        failed_task.state = "failed".to_string();
        AiDeliveryService::save(TASK_NODES_DIR, &failed_task.id, &failed_task).unwrap();
        AiDeliveryService::delete_task_node(&task.id).unwrap();

        assert!(!worktree.exists(), "任务删除后 worktree 目录应被回收");
        assert!(AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            &attempt.contract_id,
            "任务契约"
        )
        .is_err());
        let source = project_repository_path(&project, &project.repositories[0]).unwrap();
        let branches = run_git(
            &source,
            &["branch".to_string(), "--list".to_string(), "terminalbuddy/*".to_string()],
        )
        .unwrap();
        assert!(branches.trim().is_empty(), "任务分支应被删除: {}", branches);

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// F6 回归：重启恢复时单条 attempt 的 task/delivery 文件缺失不应中断其余 attempt 的恢复。
    #[test]
    fn recover_interrupted_attempts_skips_missing_task_files() {
        let (root, project, delivery, agent) = setup_git_project();
        let task = make_write_task(&delivery, &project, &agent, "实现任务", Vec::new());
        AiDeliveryService::approve_delivery(&delivery.id).unwrap();
        // 任务先正常派发（任务置 queued + attempt 入目录），再模拟崩溃时 attempt 正在运行
        let dispatched = AiDeliveryService::dispatch_task_node(&task.id, None).unwrap();
        let mut running_attempt =
            AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, &dispatched.id, "执行尝试")
                .unwrap();
        running_attempt.state = "running".to_string();
        AiDeliveryService::persist_attempt(&running_attempt).unwrap();

        let now = chrono::Utc::now().to_rfc3339();
        // 第二个 attempt 的任务文件缺失（重启前已被删除）——恢复不应被它中断
        let orphan = AiAttempt {
            id: "attempt-orphan".to_string(),
            delivery_id: delivery.id.clone(),
            task_node_id: "missing-task".to_string(),
            contract_id: "contract".to_string(),
            agent_id: agent.id.clone(),
            runtime_id: "runtime".to_string(),
            terminal_id: None,
            state: "running".to_string(),
            started_at: now.clone(),
            finished_at: None,
            exit_code: None,
            summary: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        AiDeliveryService::persist_attempt(&orphan).unwrap();

        let recovered = AiDeliveryService::recover_interrupted_attempts().unwrap();
        assert_eq!(recovered, 2, "孤立 attempt 不应中断整体恢复");
        for id in [&dispatched.id, "attempt-orphan"] {
            assert_eq!(
                AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, id, "执行尝试")
                    .unwrap()
                    .state,
                "cancelled"
            );
        }
        assert_eq!(
            AiDeliveryService::get_task_node(&task.id).unwrap().state,
            "cancelled"
        );

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// Q3 回归：resolve_review_gate 必须要求任务处于 awaitingReview，
    /// 防止取消交付后残留的未决 gate 把已取消任务「复活」为 succeeded。
    #[test]
    fn resolving_gate_requires_awaiting_review_task() {
        let (root, project, delivery, agent) = setup_git_project();
        let task = make_write_task(&delivery, &project, &agent, "实现任务", Vec::new());
        let mut cancelled_task = AiDeliveryService::get_task_node(&task.id).unwrap();
        cancelled_task.state = "cancelled".to_string();
        AiDeliveryService::save(TASK_NODES_DIR, &cancelled_task.id, &cancelled_task).unwrap();
        let gate = AiReviewGate {
            id: "gate".to_string(),
            delivery_id: delivery.id.clone(),
            task_node_id: task.id.clone(),
            reviewer_agent_id: None,
            state: "awaitingReviewer".to_string(),
            comments: Some("待审核".to_string()),
            command_results: Vec::new(),
            line_comments: Vec::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        AiDeliveryService::save(REVIEW_GATES_DIR, &gate.id, &gate).unwrap();

        let result = AiDeliveryService::resolve_review_gate(&gate.id, true, "通过".to_string());
        assert!(result.is_err(), "取消的任务不应被审核通过");
        assert_eq!(
            AiDeliveryService::get_task_node(&task.id).unwrap().state,
            "cancelled"
        );

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// 写任务验收改进：允许路径内的未提交改动由平台自动提交，
    /// 避免「Agent 执行后存在未提交改动」直接失败阻断推进；越权改动不代提交。
    #[test]
    fn auto_commit_allowed_changes_commits_in_scope_only() {
        let root =
            std::env::temp_dir().join(format!("terminal-buddy-autocommit-{}", Uuid::new_v4()));
        let repository = root.join("service-a");
        fs::create_dir_all(&repository).unwrap();
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
        let base =
            run_git(&repository, &["rev-parse".to_string(), "HEAD".to_string()]).unwrap();

        let contract = AiTaskContract {
            id: "contract".to_string(),
            project_id: "project".to_string(),
            delivery_id: "delivery".to_string(),
            task_id: "task".to_string(),
            title: "task".to_string(),
            target_repository_id: "repository".to_string(),
            target_repository_name: "repository".to_string(),
            allowed_write_paths: vec!["README.md".to_string()],
            execution_context: EXECUTION_CONTEXT_TASK_WORKTREE.to_string(),
            forbidden_repository_ids: Vec::new(),
            repository_status_baselines: Vec::new(),
            input_artifacts: Vec::new(),
            input_artifact_directory: None,
            output_artifact_directory: None,
            expected_artifacts: Vec::new(),
            acceptance_commands: Vec::new(),
            retry_count: 0,
            state: "allocated".to_string(),
            working_directory: repository.to_string_lossy().to_string(),
            branch_name: None,
            worktree_path: None,
            base_commit: Some(base),
            validated_commit: None,
            dirty: false,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };

        // 范围内改动：自动提交并保持 worktree 干净
        fs::write(repository.join("README.md"), "# service-a\nupdated\n").unwrap();
        let committed =
            auto_commit_allowed_changes(&contract, "TerminalBuddy: 测试任务").unwrap();
        assert!(committed.is_some(), "范围内改动应被自动提交");
        let status = run_git(
            &repository,
            &["status".to_string(), "--porcelain".to_string()],
        )
        .unwrap();
        assert!(status.is_empty(), "自动提交后 worktree 应干净: {}", status);
        // 重试场景：改动已提交后再次自动提交应为无操作（不能因「nothing to commit」报错）
        let noop = auto_commit_allowed_changes(&contract, "TerminalBuddy: 测试任务").unwrap();
        assert!(noop.is_none(), "已提交后不应重复提交");

        // 存在越权改动：跳过自动提交，留给静态越权审计判定
        fs::write(repository.join("README.md"), "# service-a\nupdated-2\n").unwrap();
        fs::create_dir_all(repository.join("src")).unwrap();
        fs::write(repository.join("src/out.txt"), "out-of-scope\n").unwrap();
        let skipped =
            auto_commit_allowed_changes(&contract, "TerminalBuddy: 测试任务").unwrap();
        assert!(skipped.is_none(), "越权改动不应被自动提交");
        let status = run_git(
            &repository,
            &["status".to_string(), "--porcelain".to_string()],
        )
        .unwrap();
        assert!(
            status.contains("src"),
            "越权文件应保持未提交: {}",
            status
        );

        let _ = fs::remove_dir_all(root);
    }

    /// 失败信息改进：运行记录尾部为空时回退 live-output.log，并截断到合理长度。
    #[test]
    fn terminal_transcript_tail_reads_run_log_tail() {
        let root =
            std::env::temp_dir().join(format!("terminal-buddy-tail-{}", Uuid::new_v4()));
        PathService::set_test_data_dir(Some(root.join("data")));
        let run_id = Uuid::new_v4().to_string();
        let run_dir = AiDeliveryService::entity_dir(TERMINAL_RUNS_DIR).join(run_id.clone());
        fs::create_dir_all(&run_dir).unwrap();
        fs::write(run_dir.join("transcript.log"), "").unwrap();
        fs::write(run_dir.join("live-output.log"), "long-".repeat(200)).unwrap();
        let tail = terminal_transcript_tail(&run_id).unwrap();
        assert!(tail.len() <= 600, "尾部应截断到 600 字符: {}", tail.len());
        assert!(
            tail.starts_with("long-"),
            "应读取 live-output.log 尾部: {}",
            &tail[..20]
        );

        PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(root);
    }

    /// 验收命令兼容性：bash 语法（test -f）在 PowerShell 5.1 不可用，
    /// 平台应回退到 Git Bash 执行；文件真实不存在时 bash 回退同样失败。
    #[test]
    fn run_shell_command_falls_back_to_bash_for_bash_syntax() {
        if git_bash_executable().is_none() {
            eprintln!("跳过：本机未安装 Git Bash");
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "terminal-buddy-bash-fallback-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("x.md"), "x").unwrap();

        let result = run_shell_command(&root, "test -f x.md").unwrap();
        assert_eq!(result.exit_code, 0, "bash 回退应通过: {}", result.output);

        let missing = run_shell_command(&root, "test -f nope.md").unwrap();
        assert_ne!(missing.exit_code, 0, "不存在的文件 bash 回退也应失败");

        let _ = fs::remove_dir_all(root);
    }

    /// 派发前探活：裸命令名按 PowerShell 规则解析出绝对路径（与终端内一致）。
    #[test]
    fn resolve_runtime_executable_resolves_bare_command() {
        let resolved = resolve_runtime_executable("powershell").unwrap();
        assert!(
            !resolved.trim().is_empty(),
            "应解析出可执行文件路径: {}",
            resolved
        );
        let resolved_path = Path::new(resolved.trim());
        assert!(
            resolved_path.is_absolute(),
            "解析结果应为绝对路径: {}",
            resolved
        );
    }

    /// 派发前探活：CLI 不存在时返回明确错误，而不是放行后秒退成模糊失败。
    #[test]
    fn probe_runtime_for_dispatch_rejects_missing_cli() {
        let now = chrono::Utc::now().to_rfc3339();
        let runtime = AiAgentRuntime {
            id: "runtime".to_string(),
            name: "Missing CLI".to_string(),
            kind: "codex".to_string(),
            command: "terminal-buddy-no-such-cli-7f3a9c".to_string(),
            enabled: true,
            created_at: now.clone(),
            updated_at: now,
        };
        let error = probe_runtime_for_dispatch(&runtime).unwrap_err();
        assert!(
            error.contains("PATH") || error.contains("无法"),
            "应给出明确的 CLI 缺失原因: {}",
            error
        );
    }
}
