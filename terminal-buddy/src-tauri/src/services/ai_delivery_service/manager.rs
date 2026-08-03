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
