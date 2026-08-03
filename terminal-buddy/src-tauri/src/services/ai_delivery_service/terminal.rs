//! AI 交付服务 · 终端域模块（自 ai_delivery_service.rs 拆分）
use super::*;

pub(crate) struct TerminalControl {
    pub(crate) prompt_path: PathBuf,
    pub(crate) exit_marker: PathBuf,
    pub(crate) result_path: PathBuf,
    pub(crate) final_message_path: PathBuf,
    pub(crate) transcript_path: PathBuf,
    pub(crate) decision_path: PathBuf,
    pub(crate) review_path: PathBuf,
    pub(crate) review_schema_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentDecisionFile {
    pub(crate) question: String,
    pub(crate) impact: String,
    #[serde(default)]
    pub(crate) options: Vec<AiDecisionOption>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowReviewFile {
    pub(crate) approved: bool,
    pub(crate) comments: String,
}

pub(crate) fn prepare_terminal_control(
    run_id: &str,
    display_label: Option<&str>,
    prompt: &str,
) -> Result<TerminalControl, String> {
    let directory = AiDeliveryService::entity_dir(TERMINAL_RUNS_DIR)
        .join(make_terminal_run_dir_name(run_id, display_label));
    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建 Agent 终端控制目录失败: {}", error))?;
    let prompt_path = directory.join("prompt.txt");
    let exit_marker = directory.join("exit-code.txt");
    let result_path = directory.join("plan.json");
    let final_message_path = directory.join("final-message.txt");
    let transcript_path = directory.join("transcript.log");
    let decision_path = directory.join("decision.json");
    let review_path = directory.join("review.json");
    let review_schema_path = directory.join("review-schema.json");
    fs::write(&prompt_path, prompt)
        .map_err(|error| format!("写入 Agent 任务说明失败: {}", error))?;
    for stale_path in [
        &exit_marker,
        &result_path,
        &final_message_path,
        &transcript_path,
        &decision_path,
        &review_path,
        &review_schema_path,
    ] {
        if stale_path.exists() {
            fs::remove_file(stale_path)
                .map_err(|error| format!("清理 Agent 终端控制文件失败: {}", error))?;
        }
    }
    Ok(TerminalControl {
        prompt_path,
        exit_marker,
        result_path,
        final_message_path,
        transcript_path,
        decision_path,
        review_path,
        review_schema_path,
    })
}

pub(crate) fn read_agent_decision(path: &Path) -> Result<Option<AgentDecisionFile>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取 Agent 决策文件失败: {}", error))?;
    let decision = serde_json::from_str::<AgentDecisionFile>(content.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("解析 Agent 决策文件失败: {}", error))?;
    if decision.question.trim().is_empty() || decision.impact.trim().is_empty() {
        return Err("Agent 决策文件中的问题和影响说明不能为空".to_string());
    }
    Ok(Some(decision))
}

pub(crate) fn read_workflow_review(path: &Path) -> Result<WorkflowReviewFile, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "读取 Reviewer 结论文件失败（必须写入 review.json）: {}",
            error
        )
    })?;
    let review = serde_json::from_str::<WorkflowReviewFile>(content.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("Reviewer 结论文件不符合协议: {}", error))?;
    if review.comments.trim().is_empty() {
        return Err("Reviewer 结论必须包含 comments".to_string());
    }
    Ok(review)
}

pub(crate) fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(crate) fn split_runtime_command(command: &str) -> Result<Vec<String>, String> {
    let command = command.trim();
    if Path::new(command).is_file() {
        return Ok(vec![command.to_string()]);
    }
    let parts = shell_words::split(command)
        .map_err(|error| format!("解析 Runtime 命令失败: {}", error))?;
    if parts.is_empty() {
        return Err("Runtime 命令不能为空".to_string());
    }
    Ok(parts)
}

pub(crate) fn runtime_kind_matches(runtime: &AiAgentRuntime, executable: &str, kind: &str) -> bool {
    runtime.kind.trim().eq_ignore_ascii_case(kind)
        || Path::new(executable)
            .file_stem()
            .is_some_and(|name| name.eq_ignore_ascii_case(kind))
}

pub(crate) fn runtime_is_codex(runtime: &AiAgentRuntime) -> bool {
    split_runtime_command(&runtime.command)
        .ok()
        .and_then(|parts| parts.first().cloned())
        .is_some_and(|executable| runtime_kind_matches(runtime, &executable, "codex"))
}

pub(crate) fn wrap_terminal_command(
    invocation: &str,
    control: &TerminalControl,
    final_message_path: Option<&Path>,
    transcript_path: Option<&Path>,
) -> String {
    let completion_output = match (final_message_path, transcript_path) {
        (Some(final_message_path), Some(transcript_path)) => format!(
            " if (Test-Path -LiteralPath {}) {{ Get-Content -LiteralPath {} -Raw -Encoding UTF8 }} elseif (Test-Path -LiteralPath {}) {{ Get-Content -LiteralPath {} -Tail 40 -Encoding UTF8 }}",
            powershell_literal(final_message_path.to_string_lossy().as_ref()),
            powershell_literal(final_message_path.to_string_lossy().as_ref()),
            powershell_literal(transcript_path.to_string_lossy().as_ref()),
            powershell_literal(transcript_path.to_string_lossy().as_ref()),
        ),
        _ => String::new(),
    };
    format!(
        "{}; $tbSucceeded = $?; $tbExit = $LASTEXITCODE; if ($null -eq $tbExit) {{ if ($tbSucceeded) {{ $tbExit = 0 }} else {{ $tbExit = 1 }} }};{}; Set-Content -LiteralPath {} -Value $tbExit; Write-Host \"`n[TerminalBuddy] Agent 已退出，退出码 $tbExit。终端将保留供查看。\"",
        invocation,
        completion_output,
        powershell_literal(control.exit_marker.to_string_lossy().as_ref()),
    )
}

pub(crate) fn build_interactive_terminal_command(
    runtime: &AiAgentRuntime,
    agent: &AiAgent,
    control: &TerminalControl,
) -> Result<String, String> {
    build_interactive_terminal_command_with_codex_output(
        runtime,
        agent,
        control,
        None,
        None,
        &[],
        &[],
    )
}

/// 将预设 model_args（JSON 对象）转为命令行参数：{"temperature": 0.2} → "--temperature=0.2"。
pub(crate) fn preset_model_args_from_value(model_args: &Option<serde_json::Value>) -> Vec<String> {
    let Some(serde_json::Value::Object(object)) = model_args else {
        return Vec::new();
    };
    let mut arguments = Vec::new();
    for (key, value) in object {
        let rendered = match value {
            serde_json::Value::String(text) => Some(text.clone()),
            serde_json::Value::Number(number) => Some(number.to_string()),
            serde_json::Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        };
        if let Some(rendered) = rendered {
            arguments.push(format!("--{}={}", key, rendered));
        }
    }
    arguments
}

pub(crate) fn build_interactive_terminal_command_with_codex_output(
    runtime: &AiAgentRuntime,
    agent: &AiAgent,
    control: &TerminalControl,
    codex_output_schema: Option<&Path>,
    codex_output_path: Option<&Path>,
    codex_writable_directories: &[PathBuf],
    preset_model_args: &[String],
) -> Result<String, String> {
    let mut command_parts = split_runtime_command(&runtime.command)?;
    let executable = command_parts.remove(0);
    let is_codex = runtime_kind_matches(runtime, &executable, "codex");
    let is_claude = runtime_kind_matches(runtime, &executable, "claude");
    let is_opencode = runtime_kind_matches(runtime, &executable, "opencode");
    let is_hermes = runtime_kind_matches(runtime, &executable, "hermes");
    let is_pi = runtime_kind_matches(runtime, &executable, "pi");
    let is_mimo = runtime_kind_matches(runtime, &executable, "mimo");
    let is_kimi = runtime_kind_matches(runtime, &executable, "kimi");
    if is_codex && !command_parts.iter().any(|argument| argument == "exec") {
        command_parts.push("exec".to_string());
    }
    // AI 交付从用户选择的工作区根目录启动，该目录可以包含多个仓库而自身不是 Git 仓库。
    if is_codex
        && !command_parts
            .iter()
            .any(|argument| argument == "--skip-git-repo-check")
        && !agent
            .runtime_args
            .iter()
            .any(|argument| argument == "--skip-git-repo-check")
    {
        command_parts.push("--skip-git-repo-check".to_string());
    }
    if is_opencode && !command_parts.iter().any(|argument| argument == "run") {
        command_parts.push("run".to_string());
    }
    let pipes_prompt_to_stdin = is_codex || is_claude || is_pi || is_mimo;
    let mut invocation = if pipes_prompt_to_stdin {
        format!(
            "$tbPrompt = Get-Content -LiteralPath {} -Raw -Encoding UTF8; $OutputEncoding = [System.Text.UTF8Encoding]::new($false); $tbPrompt | & {}",
            powershell_literal(control.prompt_path.to_string_lossy().as_ref()),
            powershell_literal(&executable),
        )
    } else {
        format!(
            "$tbPrompt = Get-Content -LiteralPath {} -Raw -Encoding UTF8; & {}",
            powershell_literal(control.prompt_path.to_string_lossy().as_ref()),
            powershell_literal(&executable),
        )
    };
    for argument in &command_parts {
        invocation.push(' ');
        invocation.push_str(&powershell_literal(argument));
    }
    for argument in &agent.runtime_args {
        invocation.push(' ');
        invocation.push_str(&powershell_literal(argument));
    }
    // 启动预设的 model_args 以 --key=value 形式注入（在 runtime_args 之后）
    for argument in preset_model_args {
        invocation.push(' ');
        invocation.push_str(&powershell_literal(argument));
    }
    let captures_one_shot_output = is_codex || is_claude || is_opencode || is_hermes || is_pi || is_mimo || is_kimi;
    let codex_final_message_path =
        codex_output_path.unwrap_or(control.final_message_path.as_path());
    if is_codex {
        let has_sandbox_mode = command_parts
            .iter()
            .chain(agent.runtime_args.iter())
            .any(|argument| {
                argument == "--sandbox"
                    || argument == "-s"
                    || argument.starts_with("--sandbox=")
                    || argument == "--full-auto"
            });
        if !codex_writable_directories.is_empty() && !has_sandbox_mode {
            invocation.push_str(" '--sandbox' 'workspace-write'");
        }
        for (index, directory) in codex_writable_directories.iter().enumerate() {
            if codex_writable_directories[..index].contains(directory) {
                continue;
            }
            invocation.push_str(" '--add-dir' ");
            invocation.push_str(&powershell_literal(
                normalize_path_for_external_process(directory)
                    .to_string_lossy()
                    .as_ref(),
            ));
        }
        if let Some(schema_path) = codex_output_schema {
            invocation.push_str(" '--output-schema' ");
            invocation.push_str(&powershell_literal(
                schema_path.to_string_lossy().as_ref(),
            ));
        }
        invocation.push_str(" '--output-last-message' ");
        invocation.push_str(&powershell_literal(
            codex_final_message_path.to_string_lossy().as_ref(),
        ));
        invocation.push_str(" '-' 2>&1 | Out-File -LiteralPath ");
        invocation.push_str(&powershell_literal(
            control.transcript_path.to_string_lossy().as_ref(),
        ));
        invocation.push_str(" -Encoding UTF8");
    } else if is_claude || is_pi || is_mimo {
        invocation.push_str(" '--print'");
    } else if is_kimi {
        invocation.push_str(" '--prompt' (Get-Content -LiteralPath ");
        invocation.push_str(&powershell_literal(control.prompt_path.to_string_lossy().as_ref()));
        invocation.push_str(" -Raw -Encoding UTF8)");
    } else if is_hermes {
        if command_parts.iter().any(|argument| argument == "chat") {
            invocation.push_str(" '--quiet' '--query' $tbPrompt");
        } else {
            // hermes.cmd 在 Windows 下若直接传多行位置参数会被截断为首行；
            // 用 Get-Content 子表达式从 prompt.txt 读入，避免引号转义崩溃。
            invocation.push_str(" '--oneshot' (Get-Content -LiteralPath ");
            invocation.push_str(&powershell_literal(
                control.prompt_path.to_string_lossy().as_ref(),
            ));
            invocation.push_str(" -Raw -Encoding UTF8)");
        }
    } else if is_opencode {
        // opencode.cmd 在 Windows 下会将多行位置参数截断为首行；用附件传递完整任务契约。
        invocation.push_str(" '请完整阅读附件中的任务说明，并严格执行其中的所有约束。' '--file' ");
        invocation.push_str(&powershell_literal(
            control.prompt_path.to_string_lossy().as_ref(),
        ));
    } else {
        invocation.push_str(" $tbPrompt");
    }
    if captures_one_shot_output && !is_codex {
        invocation.push_str(" 2>&1 | Out-File -LiteralPath ");
        invocation.push_str(&powershell_literal(
            control.transcript_path.to_string_lossy().as_ref(),
        ));
        invocation.push_str(" -Encoding UTF8");
    }
    Ok(wrap_terminal_command(
        &invocation,
        control,
        if is_codex {
            Some(codex_final_message_path)
        } else if captures_one_shot_output {
            Some(control.transcript_path.as_path())
        } else {
            None
        },
        captures_one_shot_output.then_some(control.transcript_path.as_path()),
    ))
}

#[cfg(test)]
mod terminal_command_tests {
    use super::*;

    fn test_runtime(kind: &str, command: &str) -> AiAgentRuntime {
        AiAgentRuntime {
            id: "runtime".to_string(),
            name: kind.to_string(),
            kind: kind.to_string(),
            command: command.to_string(),
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn test_agent() -> AiAgent {
        AiAgent {
            id: "agent".to_string(),
            name: "测试 Agent".to_string(),
            runtime_id: "runtime".to_string(),
            runtime_args: vec!["--model".to_string(), "test-model".to_string()],
            startup_preset_name: None,
            max_concurrency: 1,
            enabled: true,
            default_timeout_seconds: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn test_control() -> TerminalControl {
        TerminalControl {
            prompt_path: PathBuf::from(r"C:\TerminalBuddy\prompt.txt"),
            exit_marker: PathBuf::from(r"C:\TerminalBuddy\exit.txt"),
            result_path: PathBuf::from(r"C:\TerminalBuddy\result.txt"),
            final_message_path: PathBuf::from(r"C:\TerminalBuddy\final-message.txt"),
            transcript_path: PathBuf::from(r"C:\TerminalBuddy\transcript.log"),
            decision_path: PathBuf::from(r"C:\TerminalBuddy\decision.json"),
            review_path: PathBuf::from(r"C:\TerminalBuddy\review.json"),
            review_schema_path: PathBuf::from(r"C:\TerminalBuddy\review-schema.json"),
        }
    }

    #[test]
    fn codex_reads_prompt_from_standard_input() {
        let command = build_interactive_terminal_command(
            &test_runtime("codex", "codex"),
            &test_agent(),
            &test_control(),
        )
        .unwrap();

        assert!(command.contains("Get-Content -LiteralPath 'C:\\TerminalBuddy\\prompt.txt' -Raw -Encoding UTF8"));
        assert!(command.contains("$OutputEncoding = [System.Text.UTF8Encoding]::new($false)"));
        assert!(command.contains("'--skip-git-repo-check'"));
        assert!(command.contains("$tbPrompt | & 'codex' 'exec' '--skip-git-repo-check' '--model' 'test-model'"));
        assert!(!command.contains("'--sandbox' 'workspace-write'"));
        assert!(command.contains("'--output-last-message' 'C:\\TerminalBuddy\\final-message.txt' '-' 2>&1 | Out-File -LiteralPath 'C:\\TerminalBuddy\\transcript.log' -Encoding UTF8"));
        assert!(command.contains("Get-Content -LiteralPath 'C:\\TerminalBuddy\\final-message.txt' -Raw -Encoding UTF8"));
        assert!(!command.contains("'--' $tbPrompt"));
    }

    #[test]
    fn codex_structured_output_is_written_by_cli() {
        let control = test_control();
        let schema_path = PathBuf::from(r"C:\TerminalBuddy\schema.json");
        let command = build_interactive_terminal_command_with_codex_output(
            &test_runtime("codex", "codex"),
            &test_agent(),
            &control,
            Some(&schema_path),
            Some(&control.result_path),
            &[],
            &[],
        )
        .unwrap();

        assert!(command.contains(
            "'--output-schema' 'C:\\TerminalBuddy\\schema.json' '--output-last-message' 'C:\\TerminalBuddy\\result.txt'"
        ));
        assert!(command.contains(
            "Get-Content -LiteralPath 'C:\\TerminalBuddy\\result.txt' -Raw -Encoding UTF8"
        ));
        assert!(!command.contains("'--output-last-message' 'C:\\TerminalBuddy\\final-message.txt'"));
    }

    #[test]
    fn codex_task_receives_only_scoped_writable_directories() {
        let command = build_interactive_terminal_command_with_codex_output(
            &test_runtime("codex", "codex"),
            &test_agent(),
            &test_control(),
            None,
            None,
            &[
                PathBuf::from(r"D:\project\task-worktree"),
                PathBuf::from(r"C:\TerminalBuddy\run"),
            ],
            &[],
        )
        .unwrap();

        assert!(command.contains("'--sandbox' 'workspace-write'"));
        assert!(command.contains("'--add-dir' 'D:\\project\\task-worktree'"));
        assert!(command.contains("'--add-dir' 'C:\\TerminalBuddy\\run'"));
        assert!(!command.contains("danger-full-access"));
        assert!(!command.contains("dangerously-bypass-approvals-and-sandbox"));
    }

    #[test]
    fn claude_uses_non_interactive_mode_and_captures_output() {
        let command = build_interactive_terminal_command(
            &test_runtime("claude", "claude"),
            &test_agent(),
            &test_control(),
        )
        .unwrap();

        assert!(command.contains("$tbPrompt | & 'claude' '--model' 'test-model' '--print' 2>&1 | Out-File -LiteralPath 'C:\\TerminalBuddy\\transcript.log' -Encoding UTF8"));
    }

    #[test]
    fn supported_runtimes_use_non_interactive_commands() {
        for (kind, executable, expected) in [
            (
                "opencode",
                "opencode",
                "& 'opencode' 'run' '--model' 'test-model' '请完整阅读附件中的任务说明，并严格执行其中的所有约束。' '--file' 'C:\\TerminalBuddy\\prompt.txt'",
            ),
            ("hermes", "hermes", "& 'hermes' '--model' 'test-model' '--oneshot' (Get-Content -LiteralPath 'C:\\TerminalBuddy\\prompt.txt' -Raw -Encoding UTF8)"),
            ("pi", "pi", "$tbPrompt | & 'pi' '--model' 'test-model' '--print'"),
            ("mimo", "mimo", "$tbPrompt | & 'mimo' '--model' 'test-model' '--print'"),
            ("kimi", "kimi", "& 'kimi' '--model' 'test-model' '--prompt'"),
        ] {
            let command = build_interactive_terminal_command(
                &test_runtime(kind, executable),
                &test_agent(),
                &test_control(),
            )
            .unwrap();
            assert!(command.contains(expected), "{} command was: {}", kind, command);
            assert!(command.contains("Out-File -LiteralPath 'C:\\TerminalBuddy\\transcript.log' -Encoding UTF8"));
        }
    }

    #[test]
    fn hermes_chat_uses_its_query_mode() {
        let command = build_interactive_terminal_command(
            &test_runtime("hermes", "hermes chat"),
            &test_agent(),
            &test_control(),
        )
        .unwrap();

        assert!(command.contains("& 'hermes' 'chat' '--model' 'test-model' '--quiet' '--query' $tbPrompt"));
    }

    #[test]
    fn hermes_oneshot_prompt_comes_from_prompt_file_and_model_args_precede_oneshot() {
        let model_args =
            preset_model_args_from_value(&Some(serde_json::json!({ "temperature": 0.2 })));
        let command = build_interactive_terminal_command_with_codex_output(
            &test_runtime("hermes", "hermes"),
            &test_agent(),
            &test_control(),
            None,
            None,
            &[],
            &model_args,
        )
        .unwrap();

        assert!(command.contains("'--temperature=0.2' '--oneshot' (Get-Content -LiteralPath 'C:\\TerminalBuddy\\prompt.txt' -Raw -Encoding UTF8)"));
        assert!(!command.contains("'--oneshot' $tbPrompt"));
    }

    #[test]
    fn hermes_cmd_absolute_path_still_uses_oneshot() {
        // shell_words 是 POSIX 分词器，反斜杠会被当作转义符；
        // 绝对路径用例采用 Windows 兼容的正斜杠形式（file_stem 仍匹配 hermes）。
        let command = build_interactive_terminal_command(
            &test_runtime("hermes", "C:/Users/me/hermes.cmd"),
            &test_agent(),
            &test_control(),
        )
        .unwrap();

        assert!(command.contains("& 'C:/Users/me/hermes.cmd' '--model' 'test-model' '--oneshot' (Get-Content"));
        assert!(command.contains("Out-File -LiteralPath 'C:\\TerminalBuddy\\transcript.log' -Encoding UTF8"));
    }

    #[test]
    fn reads_bom_prefixed_terminal_exit_code() {
        let path = std::env::temp_dir().join(format!(
            "terminal-buddy-exit-code-{}.txt",
            Uuid::new_v4()
        ));
        fs::write(&path, b"\xEF\xBB\xBF0\r\n").unwrap();
        assert_eq!(read_terminal_exit_code(&path), Some(0));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn compact_output_removes_terminal_control_sequences() {
        assert_eq!(
            compact_output("\u{1b}[31m结论\u{1b}[0m\u{1b}]0;Terminal\u{7}\n完成"),
            "结论\n完成"
        );
    }

    #[test]
    fn watchdog_detects_new_expected_artifacts() {
        let root = std::env::temp_dir().join(format!(
            "terminal-buddy-watchdog-artifacts-{}",
            Uuid::new_v4()
        ));
        let output_directory = root.join("outputs");
        fs::create_dir_all(&output_directory).unwrap();
        let started_at = chrono::Utc::now().to_rfc3339();
        let artifact = output_directory.join("analysis/result.md");
        fs::create_dir_all(artifact.parent().unwrap()).unwrap();
        fs::write(&artifact, "result").unwrap();
        let contract = AiTaskContract {
            id: "contract".to_string(),
            project_id: "project".to_string(),
            delivery_id: "delivery".to_string(),
            task_id: "task".to_string(),
            title: "task".to_string(),
            target_repository_id: "repository".to_string(),
            target_repository_name: "repository".to_string(),
            allowed_write_paths: vec![".".to_string()],
            execution_context: EXECUTION_CONTEXT_WORKSPACE_ROOT.to_string(),
            forbidden_repository_ids: Vec::new(),
            repository_status_baselines: Vec::new(),
            input_artifacts: Vec::new(),
            input_artifact_directory: None,
            output_artifact_directory: Some(output_directory.to_string_lossy().to_string()),
            expected_artifacts: vec!["analysis/result.md".to_string()],
            acceptance_commands: Vec::new(),
            retry_count: 0,
            state: "allocated".to_string(),
            working_directory: root.to_string_lossy().to_string(),
            branch_name: None,
            worktree_path: None,
            base_commit: None,
            validated_commit: None,
            dirty: false,
            created_at: started_at.clone(),
            updated_at: started_at.clone(),
        };

        assert!(expected_artifacts_written(&contract, &started_at).unwrap());
        let _ = fs::remove_dir_all(root);
    }
}

pub(crate) fn create_ai_terminal(
    terminal_service: &TerminalService,
    app: &tauri::AppHandle,
    display_name: &str,
    working_directory: &Path,
    project: &AiProject,
) -> Result<String, String> {
    let terminal_working_directory = normalize_path_for_external_process(working_directory);
    let terminal_id = terminal_service.create_blank_terminal(
        "powershell",
        Some(display_name),
        Some(&project.name),
        28,
        120,
        Some(terminal_working_directory.to_string_lossy().as_ref()),
        app.clone(),
        TerminalOwner::Pc,
    )?;
    // 标记 AI 交付终端：drain_terminal_output 对其只读不消费，monitor 线程独占消费落盘
    terminal_service.set_ai_delivery_flag(&terminal_id)?;
    if let Err(error) = app.emit(
        "terminal-created",
        serde_json::json!({
            "id": terminal_id,
            "profileId": "",
            "profileName": display_name,
            "terminalType": "powershell",
            "owner": "pc",
            "groupId": format!("ai-delivery-project-{}", safe_path_segment(&project.id)),
            "groupName": project.name,
            "extraParamTag": "AI 交付",
            "extraParamTagColor": "#22c55e",
        }),
    ) {
        let _ = terminal_service.close_terminal(&terminal_id);
        return Err(format!("通知前端创建 Agent 终端失败: {}", error));
    }
    Ok(terminal_id)
}

pub(crate) fn read_terminal_exit_code(path: &Path) -> Option<i32> {
    fs::read_to_string(path)
        .ok()?
        .trim()
        .trim_start_matches('\u{feff}')
        .parse::<i32>()
        .ok()
}

pub(crate) fn run_attempt_watchdog(
    attempt_id: &str,
    delivery_id: &str,
    task_node_id: &str,
    app: tauri::AppHandle,
    terminal_service: TerminalService,
    timeout_seconds: u64,
) {
    // 用秒数 i64 比较：循环内 elapsed 是 chrono::TimeDelta，不能与 std::time::Duration 直接比较
    let warning_at_secs = (timeout_seconds as f64 * TIMEOUT_WARNING_RATIO as f64).round() as i64;
    let mut warning_emitted = false;
    thread::sleep(ATTEMPT_WATCHDOG_DELAY);
    loop {
        let attempt = match AiDeliveryService::get::<AiAttempt>(
            ATTEMPTS_DIR,
            attempt_id,
            "执行尝试 watchdog",
        ) {
            Ok(attempt) => attempt,
            Err(_) => return,
        };
       if attempt.state != "running" {
           return;
       }

       // 检查 Agent 执行是否超过最大持续时间
       if let Ok(started) = chrono::DateTime::parse_from_rfc3339(&attempt.started_at) {
           let elapsed = chrono::Utc::now().signed_duration_since(started.with_timezone(&chrono::Utc));
           // 80% 耗时一次性提前告警
           if elapsed.num_seconds() >= warning_at_secs && !warning_emitted {
               let _ = AiDeliveryService::append_event(
                   delivery_id,
                   Some(task_node_id),
                   Some(attempt_id),
                   "approachingTimeout",
                   &format!(
                       "已耗时 {}s，预计 {}s 后超时",
                       elapsed.num_seconds(),
                       timeout_seconds
                   ),
               );
               warning_emitted = true;
           }
           if elapsed.num_seconds() > timeout_seconds as i64 {
               // 系统托盘通知：任务超时终止（不放 fail_attempt_from_watchdog 内——它无法区分超时与终端结束）
               let _ = crate::commands::notification::show_ai_delivery_notification(
                   app.clone(),
                   "AI 交付任务超时",
                   delivery_id.to_string(),
                   format!(
                       "任务 {} 执行超时（超过 {} 分钟），已自动终止",
                       task_node_id,
                       timeout_seconds / 60
                   ),
               );
               let _ = fail_attempt_from_watchdog(
                   &attempt,
                   &format!(
                       "Agent 执行已超时（超过 {} 分钟），已自动终止",
                       timeout_seconds / 60
                   ),
                   "attemptTimedOut",
                   app.clone(),
                   terminal_service.clone(),
               );
               return;
           }
       }

       if let Err(error) = reconcile_running_attempt(
            &attempt,
            app.clone(),
            terminal_service.clone(),
        ) {
            if !attempt_terminal_running(&attempt, &terminal_service) {
                let _ = fail_attempt_from_watchdog(
                    &attempt,
                    &format!("Agent 终端已结束，任务状态检查失败：{}", error),
                    "attemptFailed",
                    app.clone(),
                    terminal_service.clone(),
                );
                return;
            }
            let _ = record_watchdog_observation(
                delivery_id,
                task_node_id,
                attempt_id,
                &format!("watchdog 检查失败，任务暂保持运行：{}", error),
            );
        }

        thread::sleep(ATTEMPT_WATCHDOG_INTERVAL);
    }
}

pub(crate) fn terminal_exit_marker_path(attempt_id: &str) -> PathBuf {
    terminal_run_dir_by_id(attempt_id).join("exit-code.txt")
}

pub(crate) fn attempt_terminal_running(attempt: &AiAttempt, terminal_service: &TerminalService) -> bool {
    // exit-code.txt 是 Agent 命令的完成信号。外层 cmd.exe 仍存活时，不能把它误判为 Agent 仍在执行。
    if read_terminal_exit_code(&terminal_exit_marker_path(&attempt.id)).is_some() {
        return false;
    }
    attempt
        .terminal_id
        .as_deref()
        .is_some_and(|terminal_id| terminal_service.is_terminal_running(terminal_id))
}

pub(crate) fn reconcile_running_attempt(
    attempt: &AiAttempt,
    app: tauri::AppHandle,
    terminal_service: TerminalService,
) -> Result<(), String> {
    let contract = AiDeliveryService::get::<AiTaskContract>(
        CONTRACTS_DIR,
        &attempt.contract_id,
        "任务契约 watchdog",
    )?;
    let artifacts_written = expected_artifacts_written(&contract, &attempt.started_at)?;
    let terminal_running = attempt_terminal_running(attempt, &terminal_service);

    // 成果文件优先于终端状态：Agent 可能已经写完成果，但还没有退出 CLI。
    if artifacts_written {
        match AiDeliveryService::complete_attempt(
            &attempt.id,
            app.clone(),
            terminal_service.clone(),
        ) {
            Ok(_) => return Ok(()),
            Err(error) if terminal_running => {
                return Err(format!("已发现完整成果文件，但完成校验尚未通过：{}", error));
            }
            Err(error) => {
                fail_attempt_from_watchdog(
                    attempt,
                    &format!("Agent 终端已结束；已发现成果文件，但自动完成校验失败：{}", error),
                    "attemptFailed",
                    app,
                    terminal_service,
                )?;
                return Ok(());
            }
        }
    }

    if !terminal_running {
        fail_attempt_from_watchdog(
            attempt,
            "Agent 终端已结束，且尚未检测到本次执行写入的完整成果文件",
            "attemptFailed",
            app,
            terminal_service,
        )?;
    }
    Ok(())
}

pub(crate) fn fail_attempt_from_watchdog(
    attempt: &AiAttempt,
    message: &str,
    event_type: &str,
    _app: tauri::AppHandle,
    terminal_service: TerminalService,
) -> Result<(), String> {
    let mut current = AiDeliveryService::get::<AiAttempt>(
        ATTEMPTS_DIR,
        &attempt.id,
        "watchdog 异常任务",
    )?;
    if current.state != "running" {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    current.state = "failed".to_string();
    current.finished_at = Some(now.clone());
    current.updated_at = now.clone();
    current.summary = Some(message.to_string());
    AiDeliveryService::persist_attempt(&current)?;

    let mut task = AiDeliveryService::get_task_node(&current.task_node_id)?;
    if matches!(task.state.as_str(), "queued" | "running") {
        task.state = "failed".to_string();
        task.updated_at = now;
        AiDeliveryService::save(TASK_NODES_DIR, &task.id, &task)?;
    }
    let _ = AiDeliveryService::append_event(
        &current.delivery_id,
        Some(&current.task_node_id),
        Some(&current.id),
        event_type,
        message,
    )?;
    if let Some(terminal_id) = current.terminal_id.as_deref() {
        let _ = terminal_service.close_terminal(terminal_id);
    }
    Ok(())
}

pub(crate) fn expected_artifacts_written(
    contract: &AiTaskContract,
    started_at: &str,
) -> Result<bool, String> {
    validate_artifact_paths(&contract.expected_artifacts, "交付物")?;
    if contract.expected_artifacts.is_empty() {
        return Ok(false);
    }
    let artifact_directory = contract
        .output_artifact_directory
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&contract.working_directory));
    let started_seconds = chrono::DateTime::parse_from_rfc3339(started_at)
        .map_err(|error| format!("执行开始时间无效：{}", error))?
        .timestamp();

    for artifact in &contract.expected_artifacts {
        let path = artifact_directory.join(artifact.trim());
        if !path.starts_with(&artifact_directory) || !path.exists() {
            return Ok(false);
        }
        let modified_seconds = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);
        if modified_seconds.is_none_or(|modified| modified < started_seconds - 5) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn is_last_workflow_stage(delivery: &AiDelivery, task: &AiTaskNode) -> bool {
    delivery
        .workflow_steps
        .last()
        .is_some_and(|step| task.workflow_step_id.as_deref() == Some(step.id.as_str()))
}

pub(crate) fn record_watchdog_observation(
    delivery_id: &str,
    task_node_id: &str,
    attempt_id: &str,
    message: &str,
) -> Result<(), String> {
    let mut attempt = AiDeliveryService::get::<AiAttempt>(
        ATTEMPTS_DIR,
        attempt_id,
        "更新 watchdog 状态",
    )?;
    if attempt.state != "running" {
        return Ok(());
    }
    attempt.updated_at = chrono::Utc::now().to_rfc3339();
    attempt.summary = Some(message.to_string());
    AiDeliveryService::persist_attempt(&attempt)?;
    let mut task = AiDeliveryService::get_task_node(task_node_id)?;
    if task.state == "running" {
        task.updated_at = attempt.updated_at.clone();
        AiDeliveryService::save(TASK_NODES_DIR, task_node_id, &task)?;
    }
    let _ = AiDeliveryService::append_event(
        delivery_id,
        Some(task_node_id),
        Some(attempt_id),
        "attemptWatchdogCheck",
        message,
    )?;
    Ok(())
}

/// 轮询终端输出检测 PowerShell 提示符，替代固定时长等待。
pub(crate) fn wait_for_shell_ready(
    terminal_service: &TerminalService,
    terminal_id: &str,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if std::time::Instant::now() > deadline {
            return Err("等待 PowerShell 启动超时".to_string());
        }
        let output = terminal_service
            .peek_terminal_output(terminal_id)
            .unwrap_or_default();
        if output.contains("PS ") || output.contains("PS>") {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
}

pub(crate) fn start_interactive_terminal_command(
    terminal_service: &TerminalService,
    terminal_id: &str,
    working_directory: &Path,
    terminal_command: &str,
) -> Result<(), String> {
    let terminal_working_directory = normalize_path_for_external_process(working_directory);
    let _ = wait_for_shell_ready(terminal_service, terminal_id, Duration::from_millis(8500));
    terminal_service.write_to_terminal(
        terminal_id,
        &format!(
            "$tbUtf8 = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = $tbUtf8; [Console]::OutputEncoding = $tbUtf8; $PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'; $PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'; Set-Location -LiteralPath {}\r",
            powershell_literal(terminal_working_directory.to_string_lossy().as_ref())
        ),
    )?;
    thread::sleep(Duration::from_millis(500));
    terminal_service.write_to_terminal(terminal_id, &format!("{}\r", terminal_command))?;
    Ok(())
}

pub(crate) fn wait_for_terminal_exit(
    terminal_service: &TerminalService,
    terminal_id: &str,
    exit_marker: &Path,
) -> Result<(i32, String), String> {
    let started_at = Instant::now();
    loop {
        if let Some(exit_code) = read_terminal_exit_code(exit_marker) {
            let output = terminal_service
                .peek_terminal_output(terminal_id)
                .unwrap_or_default();
            return Ok((exit_code, output));
        }
        if terminal_service.peek_terminal_output(terminal_id).is_err() {
            return Err("Agent 终端已在执行完成前关闭".to_string());
        }
        // 超时保护：防止 Reviewer Agent 挂起导致永久阻塞（上限 60 分钟）
        if started_at.elapsed() > Duration::from_secs(3600) {
            return Err("Reviewer Agent 执行超时（60 分钟），已自动中止".to_string());
        }
        thread::sleep(Duration::from_millis(300));
    }
}
