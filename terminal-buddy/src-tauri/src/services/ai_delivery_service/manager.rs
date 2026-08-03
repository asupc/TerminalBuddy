//! AI 交付服务 · 规划域模块（自 ai_delivery_service.rs 拆分）
use super::*;

pub(crate) fn run_manager_planner(
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
    AiDeliveryService::persist_attempt(&manager_attempt)?;
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

pub(crate) fn generate_quality_gate_with_runtime(
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

pub(crate) fn normalize_path_for_external_process(path: &Path) -> PathBuf {
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

pub(crate) fn run_command_with_timeout(
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

pub(crate) fn manager_plan_schema() -> &'static str {
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

pub(crate) fn run_reviewer_agent(
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
    AiDeliveryService::persist_attempt(&attempt)?;
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

pub(crate) fn repair_workflow_review(
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
        &[],
    )?;
    start_interactive_terminal_command(
        terminal_service,
        terminal_id,
        working_directory,
        &terminal_command,
    )
}

pub(crate) fn wait_for_manager_plan(
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

pub(crate) fn build_agent_prompt(
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

impl AiDeliveryService {

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

    /// 规划中断「以当前状态重跑」：校验交付可重新规划并记录采纳事件。
    /// 基线是规划前的内存快照（非持久化），仓库被改动阻断后无需手动清理——
    /// 直接复用既有 plan 路径（commands 层 begin_delivery_planning + spawn_blocking）重新规划。
    pub fn replan_delivery_accepting_current_state(delivery_id: &str) -> Result<(), String> {
        let delivery = Self::get_delivery(delivery_id)?;
        if !matches!(delivery.state.as_str(), "drafting" | "planning" | "needsInput") {
            return Err(format!(
                "交付状态 {} 不可重新规划（仅草稿/规划中/等待决策可采纳当前状态重跑）",
                delivery.state
            ));
        }
        if Self::get_all_attempts(Some(delivery_id))?
            .iter()
            .any(|attempt| matches!(attempt.state.as_str(), "queued" | "starting" | "running"))
        {
            return Err("仍有运行中的 Agent，不能重新规划".to_string());
        }
        Self::append_event(
            delivery_id,
            None,
            None,
            "deliveryReplanned",
            "已采纳当前仓库状态并重新规划",
        )?;
        Ok(())
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
            Self::persist_attempt(&attempt)?;
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
                Self::persist_attempt(&attempt)?;
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
                Self::persist_attempt(&manager_attempt)?;
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

}
