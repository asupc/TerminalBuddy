//! AI 交付服务 · 通用工具模块（自 ai_delivery_service.rs 拆分）
use super::*;

pub(crate) fn compact_output(value: &str) -> String {
    const MAX_CHARS: usize = 4_000;
    let cleaned = strip_terminal_control_sequences(value);
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= MAX_CHARS {
        return trimmed.to_string();
    }
    format!("{}…", trimmed.chars().take(MAX_CHARS).collect::<String>())
}

pub(crate) fn strip_terminal_control_sequences(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    while let Some(next) = chars.next() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.next() == Some('\\') {
                            break;
                        }
                    }
                }
                Some(_) | None => {}
            }
        } else if !character.is_control() || matches!(character, '\n' | '\r' | '\t') {
            output.push(character);
        }
    }
    output
}

/// 检查任务的 worktree 是否已有之前执行的进展，如果有则返回续接上下文供 Agent 理解已有工作并续接完成。
pub(crate) fn build_continuation_context(
    task: &AiTaskNode,
    contract: &AiTaskContract,
    current_attempt_id: &str,
) -> Option<String> {
    let prior_notes: Vec<String> = task
        .attempt_ids
        .iter()
        .rev()
        .filter(|id| *id != current_attempt_id)
        .filter_map(|id| {
            let attempt = AiDeliveryService::get::<AiAttempt>(ATTEMPTS_DIR, id, "").ok()?;
           if !matches!(
               attempt.state.as_str(),
                "failed" | "policyViolation" | "cancelled" | "needsInput"
           ) {
               return None;
           }
           let summary = attempt.summary.unwrap_or_default();
            let run_dir = terminal_run_dir_by_id(id);
            let final_msg = fs::read_to_string(run_dir.join("final-message.txt"))
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|m| {
                    let truncated = if m.len() > 800 {
                        format!("{}...", &m[..m.floor_char_boundary(800)])
                    } else {
                        m
                    };
                    format!("\n{}\n{}", "上次最终消息", truncated)
                })
                .unwrap_or_default();
            if summary.is_empty() && final_msg.is_empty() {
                None
            } else {
                Some(format!(
                    "上次执行（{}）：{}{}",
                    attempt.state, summary, final_msg
                ))
            }
        })
        .take(3)
        .collect();

    let (mut uncommitted, mut committed) = (String::new(), String::new());
    if task.execution_mode != "readonly" {
        if let Some(worktree_path) = contract.worktree_path.as_deref() {
            let worktree = PathBuf::from(worktree_path);
            if worktree.is_dir() {
                uncommitted = run_git(
                    &worktree,
                    &["status".to_string(), "--porcelain=v1".to_string()],
                )
                .unwrap_or_default();
                if let Some(base) = contract.base_commit.as_deref() {
                    let log_args = vec![
                        "log".to_string(),
                        "--oneline".to_string(),
                        format!("{}..HEAD", base),
                    ];
                    committed = run_git(&worktree, &log_args).unwrap_or_default();
                }
            }
        }
    }

    let mut partial_outputs = String::new();
    if task.execution_mode == "readonly" {
        if let Some(dir) = contract.output_artifact_directory.as_deref() {
            let output_dir = PathBuf::from(dir);
            let existing: Vec<String> = contract
                .expected_artifacts
                .iter()
                .filter(|a| output_dir.join(a).exists())
                .map(|a| format!("  - {}", a))
                .collect();
            if !existing.is_empty() {
                partial_outputs = existing.join("\n");
            }
        }
    }

    // 查找已回答的决策请求，将其注入续接上下文供 Agent 参考
    let answered_decisions: Vec<String> = AiDeliveryService::get_decision_requests(
        Some(&contract.delivery_id),
    )
    .unwrap_or_default()
    .into_iter()
    .filter(|req| req.state == "answered")
    .filter(|req| req.task_node_id.as_deref() == Some(&task.id))
    .map(|req| {
        format!(
            "问题：{}\n回答：{}",
            req.question,
            req.answer.unwrap_or_default()
        )
    })
    .collect();

    if prior_notes.is_empty()
        && uncommitted.is_empty()
        && committed.is_empty()
        && partial_outputs.is_empty()
        && answered_decisions.is_empty()
    {
        return None;
    }

    let mut sections = vec![
        "这是续接执行的任务。之前的执行在当前任务 worktree 中已产生部分工作，请在此基础上续接完成，不要从头重做。".to_string(),
    ];

    if !committed.is_empty() {
        sections.push(format!("已提交的改动：\n{}", committed));
    }
    if !uncommitted.is_empty() {
        sections.push(format!("未提交的改动（需要你完成提交）：\n{}", uncommitted));
    }
    if !partial_outputs.is_empty() {
        sections.push(format!("成果目录中已有的产物：\n{}", partial_outputs));
    }
    if !prior_notes.is_empty() {
        sections.push(format!("之前执行未完成的原因：\n{}", prior_notes.join("\n")));
    }
    if !answered_decisions.is_empty() {
        sections.push(format!("用户已做出的决策：\n{}", answered_decisions.join("\n\n")));
    }

    sections.push(
        "请先用 git status、git log、git diff 检查当前进展，理解已完成的部分，然后完成剩余工作。不要撤销已有的合理改动。完成后确保所有改动已在当前任务分支提交。".to_string(),
    );

    Some(sections.join("\n\n"))
}

pub(crate) fn ensure_expected_artifacts(contract: &AiTaskContract, working_directory: &Path) -> Result<(), String> {
    validate_artifact_paths(&contract.expected_artifacts, "交付物")?;
    let artifact_directory = contract
        .output_artifact_directory
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| working_directory.to_path_buf());
    for artifact in &contract.expected_artifacts {
        let relative = artifact.trim();
        if relative.is_empty() {
            continue;
        }
        let path = artifact_directory.join(relative);
        if !path.starts_with(&artifact_directory) || !path.exists() {
            return Err(format!("未找到预期产物: {}", artifact));
        }
    }
    Ok(())
}

pub(crate) fn validate_artifact_paths(artifacts: &[String], label: &str) -> Result<(), String> {
    for artifact in artifacts {
        let relative = artifact.trim();
        let path = Path::new(relative);
        if relative.is_empty()
            || path.is_absolute()
            || path.components().any(|component| matches!(component, std::path::Component::ParentDir))
            || relative.contains(['\r', '\n', '：'])
        {
            return Err(format!(
                "{}必须是安全的相对文件或目录路径，不能使用说明文字: {}",
                label, artifact
            ));
        }
    }
    Ok(())
}

pub(crate) fn is_legacy_delivery_plan(delivery: &AiDelivery, tasks: &[AiTaskNode]) -> bool {
    !delivery.workflow_steps.is_empty()
        && tasks.iter().any(|task| {
            task.execution_context.trim().is_empty()
                || task.expected_artifacts.is_empty()
                || validate_artifact_paths(&task.expected_artifacts, "交付物").is_err()
        })
}

pub(crate) fn upgrade_legacy_workflow_steps(workflow: &mut AiWorkflow) -> bool {
    let mut changed = false;
    for step in &mut workflow.steps {
        if !step.execution_context.trim().is_empty() {
            continue;
        }
        let (execution_mode, execution_context) = match step.name.as_str() {
            "任务分析" | "需求评审" => ("readonly", EXECUTION_CONTEXT_WORKSPACE_ROOT),
            "功能测试、Code Review" => ("readonly", EXECUTION_CONTEXT_TASK_WORKTREE),
            _ => (step.execution_mode.as_str(), EXECUTION_CONTEXT_TASK_WORKTREE),
        };
        step.execution_mode = execution_mode.to_string();
        step.execution_context = execution_context.to_string();
        changed = true;
    }
    changed
}

pub(crate) fn ensure_readonly_execution_unchanged(
    project: &AiProject,
    contract: &AiTaskContract,
    working_directory: &Path,
) -> Result<(), String> {
    if contract.execution_context == EXECUTION_CONTEXT_WORKSPACE_ROOT {
        let changed = contract
            .repository_status_baselines
            .iter()
            .map(|baseline| -> Result<Option<&str>, String> {
                let repository = project
                    .repositories
                    .iter()
                    .find(|repository| repository.id == baseline.repository_id)
                    .ok_or_else(|| "只读步骤引用的项目仓库不存在".to_string())?;
                let path = project_repository_path(project, repository)?;
                let status_changed = repository_status(&path)? != baseline.status;
                let head_changed = match baseline.head_commit.as_deref() {
                    Some(head) => {
                        run_git(&path, &["rev-parse".to_string(), "HEAD".to_string()])? != head
                    }
                    None => false,
                };
                Ok((status_changed || head_changed).then_some(repository.name.as_str()))
            })
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if changed.is_empty() {
            Ok(())
        } else {
            Err(format!("只读步骤修改了项目仓库: {}", changed.join("、")))
        }
    } else {
        repository_status(working_directory).and_then(|status| {
            if status.is_empty() {
                Ok(())
            } else {
                Err("只读步骤产生了任务 worktree 文件改动".to_string())
            }
        })
    }
}

pub(crate) fn ensure_task_branch_clean(worktree: &Path) -> Result<(), String> {
    let status = run_git(
        worktree,
        &["status".to_string(), "--porcelain=v1".to_string()],
    )?;
    if !status.is_empty() {
        return Err(
            "Agent 执行后存在未提交改动，无法审核或合并；请在任务分支创建本地提交".to_string(),
        );
    }
    Ok(())
}

pub(crate) fn run_shell_command(working_directory: &Path, command: &str) -> Result<AiCommandResult, String> {
    // 验收命令与质量门禁命令使用 PowerShell 语法（Test-Path、Select-String 等 cmdlet），
    // 必须通过 powershell.exe 执行，cmd.exe 无法识别 PowerShell cmdlet。
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", command])
        .current_dir(working_directory);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let output = run_command_with_timeout(&mut cmd, QUALITY_GATE_COMMAND_TIMEOUT, "质量门禁命令")?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    Ok(AiCommandResult {
        command: command.to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        output: compact_output(&combined),
    })
}

pub(crate) fn build_manager_prompt(delivery: &AiDelivery, project: &AiProject, roles: &[AiRole]) -> String {
    let repositories = project
        .repositories
        .iter()
        .map(|repository| {
            format!(
                "- id={} name={} path={} branch={}",
                repository.id, repository.name, repository.relative_path, repository.default_branch
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let roles = roles
        .iter()
        .map(|role| {
            format!(
                "- id={} name={} description={}",
                role.id, role.name, role.description
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let workflow = if delivery.workflow_steps.is_empty() {
        "未选择编排方案；workflowStepId 必须返回 null。".to_string()
    } else {
        delivery
            .workflow_steps
            .iter()
            .enumerate()
            .map(|(index, step)| {
                format!(
                    "{}. stepId={} name={} mode={} context={} roleId={} agentId={} commonPrompt={}",
                    index + 1,
                    step.id,
                    step.name,
                    step.execution_mode,
                    resolve_execution_context(&step.execution_mode, &step.execution_context)
                        .unwrap_or_else(|_| "invalid".to_string()),
                    step.role_id.as_deref().unwrap_or("null"),
                    if step.role_id.is_some() { "由角色绑定" } else { &step.agent_id },
                    if step.prompt.is_empty() {
                        "无"
                    } else {
                        &step.prompt
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "你是 AI 交付团队的管理者。请把用户需求拆解为可执行的结构化任务图。\n\n需求标题：{}\n需求正文：{}\n\n项目工作区：{}\n可用仓库：\n{}\n\n可用角色：\n{}\n\n用户指定的任务编排（必须逐步覆盖并保持顺序）：\n{}\n\n硬性约束：\n1. 每个写入任务只能指定一个 targetRepositoryId，禁止单个 Agent 跨服务修改。\n2. 跨服务改动必须拆成多个节点，用 dependencyIndexes 表示前置关系。\n3. 每个阶段任务必须声明至少一个具体交付物 expectedArtifacts，禁止空数组；每个元素只能是安全相对路径，例如 `analysis/mom-app-item1-4.md` 或 `uni-app/pages/outbounds/index.vue`，不能填写说明句子、绝对路径或 `../`。任务只有在交付物实际存在并通过校验后才能更新为完成。只读步骤的交付物会写入平台提供的项目外成果目录，并自动交接给后续步骤。\n4. 每个任务必须声明 allowedWritePaths 和验收命令；只读步骤的 allowedWritePaths 使用 [\".\"]。\n5. workflowStepId 必须使用上面给出的 stepId；每个编排步骤至少生成一个任务，同一步骤可以按服务拆成多个并行任务。\n6. 后一步骤的每个任务必须依赖前一步骤的全部任务；tasks 按编排顺序和拓扑顺序输出，dependencyIndexes 从 0 开始且只能引用之前的任务。\n7. 不要计划 git push、PR、部署、删除数据或破坏性操作。\n8. 只返回符合提供 JSON Schema 的数据。",
        delivery.title,
        delivery.requirement,
        project.workspace_root,
        repositories,
        roles,
        workflow,
    )
}

pub(crate) fn validate_manager_workflow_plan(plan: &ManagerPlan, delivery: &AiDelivery) -> Result<(), String> {
    for (task_index, task) in plan.tasks.iter().enumerate() {
        if task
            .dependency_indexes
            .iter()
            .any(|dependency_index| *dependency_index >= task_index)
        {
            return Err(format!(
                "任务 {} 的 dependencyIndexes 必须只引用之前的任务",
                task_index
            ));
        }
    }
    if delivery.workflow_steps.is_empty() {
        return Ok(());
    }
    let step_positions = delivery
        .workflow_steps
        .iter()
        .enumerate()
        .map(|(index, step)| (step.id.as_str(), index))
        .collect::<BTreeMap<_, _>>();
    let mut task_indexes_by_step = vec![Vec::<usize>::new(); delivery.workflow_steps.len()];
    let mut last_step_index = 0;
    for (task_index, task) in plan.tasks.iter().enumerate() {
        let step_id = task
            .workflow_step_id
            .as_deref()
            .ok_or_else(|| format!("任务 {} 缺少 workflowStepId", task_index))?;
        let step_index = *step_positions
            .get(step_id)
            .ok_or_else(|| format!("任务 {} 引用了未知的 workflowStepId", task_index))?;
        if !task
            .expected_artifacts
            .iter()
            .any(|artifact| !artifact.trim().is_empty())
        {
            return Err(format!(
                "编排步骤“{}”的任务必须声明至少一个交付物",
                delivery.workflow_steps[step_index].name
            ));
        }
        validate_artifact_paths(&task.expected_artifacts, "交付物")?;
        validate_artifact_paths(&task.input_artifacts, "输入成果")?;
        if task_index > 0 && step_index < last_step_index {
            return Err("任务没有按照用户编排步骤顺序输出".to_string());
        }
        last_step_index = step_index;
        task_indexes_by_step[step_index].push(task_index);
    }
    for (step_index, task_indexes) in task_indexes_by_step.iter().enumerate() {
        if task_indexes.is_empty() {
            return Err(format!(
                "编排步骤“{}”没有生成任务",
                delivery.workflow_steps[step_index].name
            ));
        }
        if step_index == 0 {
            continue;
        }
        let previous_indexes = &task_indexes_by_step[step_index - 1];
        for task_index in task_indexes {
            let dependencies = &plan.tasks[*task_index].dependency_indexes;
            if previous_indexes
                .iter()
                .any(|previous_index| !dependencies.contains(previous_index))
            {
                return Err(format!(
                    "编排步骤“{}”的任务必须依赖前一步骤的全部任务",
                    delivery.workflow_steps[step_index].name
                ));
            }
        }
    }
    Ok(())
}

// 任务分析是只读交付，但不应被当作审核关卡；有前置依赖的只读编排任务才需要审核结论。
pub(crate) fn requires_workflow_review(task: &AiTaskNode) -> bool {
    task.execution_mode == "readonly"
        && task.workflow_step_id.is_some()
        && !task.dependency_ids.is_empty()
}

pub(crate) fn safe_display_segment(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            let code = c as u32;
            if code < 32 || matches!(code, 34 | 42 | 47 | 58 | 60 | 62 | 63 | 92 | 124) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches(|ch: char| ch == '.' || ch.is_whitespace())
        .to_string()
}

pub(crate) fn dispatch_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn attempt_start_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 生成终端运行目录名：{可读标签}__{UUID}，无标签时退回纯 UUID。
pub(crate) fn make_terminal_run_dir_name(run_id: &str, display_label: Option<&str>) -> String {
    let id_seg = safe_path_segment(run_id);
    let label = display_label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| safe_display_segment(s));
    match label {
        Some(slug) if !slug.is_empty() => {
            let truncated: String = slug.chars().take(50).collect();
            format!("{}__{}", truncated, id_seg)
        }
        _ => id_seg,
    }
}

/// 按尝试 ID 查找终端运行目录，兼容旧格式（纯 UUID）和新格式（标签__UUID）。
pub(crate) fn terminal_run_dir_by_id(run_id: &str) -> PathBuf {
    let base = AiDeliveryService::entity_dir(TERMINAL_RUNS_DIR);
    let id_seg = safe_path_segment(run_id);
    if let Ok(entries) = fs::read_dir(&base) {
        let suffix = format!("__{}", id_seg);
        for entry in entries.flatten() {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name == id_seg || name.ends_with(&suffix) {
                        return entry.path();
                    }
                }
            }
        }
    }
    base.join(id_seg)
}

pub(crate) fn safe_path_segment(value: &str) -> String {
    let result = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if result.is_empty() {
        "task".to_string()
    } else {
        result
    }
}

pub(crate) fn compact_path_id(value: &str) -> String {
    let safe = safe_path_segment(value);
    safe.chars().take(16).collect()
}

pub(crate) fn safe_ref_segment(value: &str) -> String {
    safe_path_segment(value)
        .trim_matches('.')
        .trim_matches('/')
        .to_string()
}

pub(crate) fn run_git(path: &Path, arguments: &[String]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(normalize_path_for_external_process(path))
        .args(arguments);
    let output = run_command_with_timeout(&mut cmd, GIT_COMMAND_TIMEOUT, "Git 命令")?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "Git 命令执行失败".to_string()
        } else {
            message
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}


pub(crate) fn validate_runtime(runtime: &AiAgentRuntime) -> Result<(), String> {
    if runtime.name.trim().is_empty()
        || runtime.kind.trim().is_empty()
        || runtime.command.trim().is_empty()
    {
        return Err("运行时名称、类型和命令不能为空".to_string());
    }
    if runtime.command.contains('\n') || runtime.command.contains('\r') {
        return Err("运行时命令不能包含换行符".to_string());
    }
    Ok(())
}

pub(crate) fn validate_agent_configuration(agent: &AiAgent) -> Result<(), String> {
    for argument in &agent.runtime_args {
        let normalized = argument.trim().to_ascii_lowercase();
        if normalized.is_empty() || normalized.contains('\n') || normalized.contains('\r') {
            return Err("Agent 启动参数不能为空且不能包含换行符".to_string());
        }
        if [
            "--dangerously-skip-permissions",
            "--bypass-permissions",
            "--yolo",
            "--no-sandbox",
        ]
        .iter()
        .any(|blocked| normalized == *blocked)
        {
            return Err(format!("禁止使用不安全的 Agent 启动参数: {}", argument));
        }
    }
    Ok(())
}

pub(crate) fn validate_task_input(input: &CreateTaskContractInput) -> Result<(), String> {
    if input.delivery_id.trim().is_empty()
        || input.task_id.trim().is_empty()
        || input.title.trim().is_empty()
    {
        return Err("交付编号、任务编号和标题不能为空".to_string());
    }
    validate_write_paths(&input.allowed_write_paths)
}

pub(crate) fn validate_write_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("必须声明至少一个允许写入路径".to_string());
    }
    for path in paths {
        let normalized = path.trim().replace('\\', "/");
        if normalized.is_empty()
            || normalized.starts_with('/')
            || normalized.contains("../")
            || normalized == ".."
        {
            return Err(format!("允许写入路径不合法: {}", path));
        }
    }
    Ok(())
}

pub(crate) fn write_paths_overlap(left: &[String], right: &[String]) -> bool {
    left.iter().any(|left_path| {
        let left_path = left_path
            .trim()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        right.iter().any(|right_path| {
            let right_path = right_path
                .trim()
                .replace('\\', "/")
                .trim_end_matches('/')
                .to_ascii_lowercase();
            left_path == right_path
                || left_path.starts_with(&(right_path.clone() + "/"))
                || right_path.starts_with(&(left_path.clone() + "/"))
        })
    })
}

pub(crate) fn project_repository_path(
    project: &AiProject,
    repository: &AiRepository,
) -> Result<PathBuf, String> {
    let root = canonical_directory(&project.workspace_root)?;
    let path = if repository.relative_path == "." {
        root
    } else {
        root.join(&repository.relative_path)
    };
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("目标仓库目录不可用: {}", error))?;
    if git_root(&canonical).is_err() {
        return Err("目标仓库已不是有效 Git 仓库".to_string());
    }
    Ok(canonical)
}

pub(crate) fn ensure_clean_repository(path: &Path) -> Result<(), String> {
    let status = repository_status(path)?;
    if !status.is_empty() {
        return Err(format!(
            "目标仓库存在未提交改动，拒绝创建 worktree: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn repository_status(path: &Path) -> Result<String, String> {
    run_git(path, &["status".to_string(), "--porcelain=v1".to_string()])
}

pub(crate) fn project_repository_statuses(project: &AiProject) -> Result<BTreeMap<String, String>, String> {
    project
        .repositories
        .iter()
        .map(|repository| {
            let path = project_repository_path(project, repository)?;
            let head = run_git(&path, &["rev-parse".to_string(), "HEAD".to_string()])?;
            Ok((
                repository.id.clone(),
                format!("{}\n{}", head, repository_status(&path)?),
            ))
        })
        .collect()
}

pub(crate) fn ensure_project_repository_statuses_unchanged(
    project: &AiProject,
    baseline: &BTreeMap<String, String>,
) -> Result<(), String> {
    let current = project_repository_statuses(project)?;
    let changed = project
        .repositories
        .iter()
        .filter(|repository| baseline.get(&repository.id) != current.get(&repository.id))
        .map(|repository| repository.name.as_str())
        .collect::<Vec<_>>();
    if changed.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "管理者规划期间修改了项目仓库，已阻断任务图：{}。请检查并处理这些改动后重试。",
            changed.join("、")
        ))
    }
}

pub(crate) fn audit_contract_scope(
    project: &AiProject,
    contract: &AiTaskContract,
) -> Result<Option<String>, String> {
    for baseline in &contract.repository_status_baselines {
        if !contract
            .forbidden_repository_ids
            .iter()
            .any(|id| id == &baseline.repository_id)
        {
            continue;
        }
        let repository = project
            .repositories
            .iter()
            .find(|repository| repository.id == baseline.repository_id)
            .ok_or_else(|| "任务契约引用的禁止仓库不存在".to_string())?;
        let path = project_repository_path(project, repository)?;
        let current = repository_status(&path)?;
        let current_head = run_git(&path, &["rev-parse".to_string(), "HEAD".to_string()])?;
        if current != baseline.status
            || baseline
                .head_commit
                .as_deref()
                .is_some_and(|head| head != current_head)
        {
            return Ok(Some(format!(
                "检测到未授权仓库改动: {}，已阻断审核与合并",
                repository.name
            )));
        }
    }
    audit_allowed_write_paths(contract)
}

pub(crate) fn audit_allowed_write_paths(contract: &AiTaskContract) -> Result<Option<String>, String> {
    let Some(base_commit) = contract.base_commit.as_deref() else {
        // 升级前创建的契约没有记录基线提交，保留兼容性；重新派发会创建带基线的新契约。
        return Ok(None);
    };
    let worktree = PathBuf::from(&contract.working_directory);
    let mut changed_paths = run_git(
        &worktree,
        &[
            "diff".to_string(),
            "--name-only".to_string(),
            base_commit.to_string(),
        ],
    )?
    .lines()
    .map(str::trim)
    .filter(|path| !path.is_empty())
    .map(str::to_string)
    .collect::<Vec<_>>();
    changed_paths.extend(
        run_git(
            &worktree,
            &[
                "ls-files".to_string(),
                "--others".to_string(),
                "--exclude-standard".to_string(),
            ],
        )?
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string),
    );
    changed_paths.sort();
    changed_paths.dedup();
    let out_of_scope = changed_paths
        .into_iter()
        .filter(|path| !is_allowed_write_path(path, &contract.allowed_write_paths))
        .collect::<Vec<_>>();
    if out_of_scope.is_empty() {
        Ok(None)
    } else {
        Ok(Some(format!(
            "检测到任务写入超出允许路径，已阻断审核与合并：{}",
            out_of_scope.join("、")
        )))
    }
}

pub(crate) fn is_allowed_write_path(path: &str, allowed_paths: &[String]) -> bool {
    let path = path.trim().replace('\\', "/");
    allowed_paths.iter().any(|allowed| {
        let allowed = allowed
            .trim()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string();
        allowed == "." || path == allowed || path.starts_with(&(allowed + "/"))
    })
}

pub(crate) fn project_artifact_base_path(project: &AiProject) -> PathBuf {
    let base = if let Some(path) = project.worktree_root.as_ref() {
        PathBuf::from(path).join(compact_path_id(&project.id))
    } else {
        let workspace = PathBuf::from(&project.workspace_root);
        workspace
            .parent()
            .unwrap_or(workspace.as_path())
            .join(".terminalbuddy-worktrees")
            .join(compact_path_id(&project.id))
    };
    normalize_path_for_external_process(&base)
}

pub(crate) fn repository_worktree_base_path(
    project: &AiProject,
    repository: &AiRepository,
) -> Result<PathBuf, String> {
    let base = if let Some(path) = project.worktree_root.as_ref() {
        PathBuf::from(path)
            .join(compact_path_id(&project.id))
            .join(safe_path_segment(&repository.name))
    } else {
        project_repository_path(project, repository)?.join(".terminalbuddy-worktrees")
    };
    Ok(normalize_path_for_external_process(&base))
}

pub(crate) fn ensure_worktree_directory_is_ignored(repository: &Path) -> Result<(), String> {
    let git_dir = PathBuf::from(run_git(
        repository,
        &["rev-parse".to_string(), "--git-dir".to_string()],
    )?);
    let git_dir = if git_dir.is_absolute() {
        git_dir
    } else {
        repository.join(git_dir)
    };
    let exclude_path = git_dir.join("info").join("exclude");
    let exclude = match fs::read_to_string(&exclude_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取仓库本地排除规则失败: {}", error)),
    };
    const ENTRY: &str = "/.terminalbuddy-worktrees/";
    if exclude.lines().any(|line| line.trim() == ENTRY) {
        return Ok(());
    }
    let parent = exclude_path
        .parent()
        .ok_or_else(|| "仓库本地排除规则路径无效".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建仓库本地排除规则目录失败: {}", error))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&exclude_path)
        .map_err(|error| format!("写入仓库本地排除规则失败: {}", error))?;
    if !exclude.is_empty() && !exclude.ends_with('\n') {
        writeln!(file).map_err(|error| format!("写入仓库本地排除规则失败: {}", error))?;
    }
    writeln!(file, "{}", ENTRY).map_err(|error| format!("写入仓库本地排除规则失败: {}", error))?;
    Ok(())
}

pub(crate) fn cleanup_delivery_integration_workspace(
    project: &AiProject,
    delivery: &AiDelivery,
) -> Result<(), String> {
    for repository in &project.repositories {
        let source = project_repository_path(project, repository)?;
        let integration_repository = repository_worktree_base_path(project, repository)?
            .join("integration")
            .join(compact_path_id(&delivery.id));
        if integration_repository.exists() {
            run_git(
                &source,
                &[
                    "worktree".to_string(),
                    "remove".to_string(),
                    "--force".to_string(),
                    integration_repository.to_string_lossy().to_string(),
                ],
            )?;
        }
        let integration_branch = format!(
            "terminalbuddy/integration/{}-{}",
            safe_ref_segment(&delivery.id),
            safe_ref_segment(&repository.name)
        );
        let _ = run_git(
            &source,
            &["branch".to_string(), "-D".to_string(), integration_branch],
        );
    }
    Ok(())
}

/// 将显示标签中的不安全字符替换为下划线，用于构造可读的终端运行目录名。
/// 清理交付关联的所有任务 worktree、分支和产出物交接目录。
/// 用于交付删除或合并完成后的资源回收，全部以尽力方式执行，不阻断主流程。
pub(crate) fn cleanup_delivery_task_worktrees(project: &AiProject, delivery: &AiDelivery) {
    let contracts = match AiDeliveryService::get_all_task_contracts(Some(&project.id)) {
        Ok(contracts) => contracts,
        Err(_) => return,
    };
    for contract in contracts
        .into_iter()
        .filter(|contract| contract.delivery_id == delivery.id)
    {
        let Some(branch_name) = contract.branch_name.as_deref() else {
            continue;
        };
        let Some(repository) = project
            .repositories
            .iter()
            .find(|repository| repository.id == contract.target_repository_id)
        else {
            continue;
        };
        let Ok(source) = project_repository_path(project, repository) else {
            continue;
        };
        if let Some(worktree_path) = contract.worktree_path.as_deref() {
            cleanup_unallocated_task_worktree(&source, Path::new(worktree_path), branch_name);
        } else {
            let _ = run_git(
                &source,
                &[
                    "branch".to_string(),
                    "-D".to_string(),
                    branch_name.to_string(),
                ],
            );
        }
    }
    let handoff_root = project_artifact_base_path(project)
        .join("handoff")
        .join(compact_path_id(&delivery.id));
    let _ = fs::remove_dir_all(&handoff_root);
}


pub(crate) fn git_root(path: &Path) -> Result<PathBuf, String> {
    let output = run_git(
        path,
        &["rev-parse".to_string(), "--show-toplevel".to_string()],
    )?;
    Ok(PathBuf::from(output))
}

pub(crate) fn current_branch(path: &Path) -> Option<String> {
    run_git(path, &["branch".to_string(), "--show-current".to_string()])
        .ok()
        .filter(|branch| !branch.is_empty())
}


pub(crate) fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("工作区路径不能为空".to_string());
    }
    let canonical = PathBuf::from(trimmed)
        .canonicalize()
        .map_err(|error| format!("工作区路径不可用: {}", error))?;
    if !canonical.is_dir() {
        return Err("工作区路径不是目录".to_string());
    }
    Ok(normalize_path_for_external_process(&canonical))
}

pub(crate) fn normalize_optional_directory(path: Option<String>) -> Result<Option<String>, String> {
    path.filter(|value| !value.trim().is_empty())
        .map(|value| canonical_directory(&value).map(|path| path.to_string_lossy().to_string()))
        .transpose()
}


pub(crate) fn unavailable_runtime_probe(kind: &str, command: &str) -> AiRuntimeProbe {
    AiRuntimeProbe {
        kind: kind.to_string(),
        command: command.to_string(),
        available: false,
        version: None,
    }
}

/// 检查可执行文件是否在 PATH 中存在（不实际运行）。
/// 作为 --version 探测失败时的兜底，避免冷启动慢导致误判为不可用。
pub(crate) fn executable_exists_in_path(executable: &str) -> bool {
    // 如果已经是绝对/相对路径，直接检查文件
    let path = Path::new(executable);
    if path.is_absolute() || path.components().count() > 1 {
        #[cfg(windows)]
        {
            // 无扩展名时尝试 .exe / .cmd / .bat
            if path.extension().is_none() {
                for ext in &["exe", "cmd", "bat"] {
                    if path.with_extension(ext).is_file() {
                        return true;
                    }
                }
            }
            return path.is_file();
        }
        #[cfg(not(windows))]
        return path.is_file();
    }
    // 裸命令名，在 PATH 中搜索
    #[cfg(windows)]
    {
        let path_var = match std::env::var_os("PATH") {
            Some(p) => p,
            None => return false,
        };
        for dir in std::env::split_paths(&path_var) {
            for ext in &["exe", "cmd", "bat", "ps1"] {
                if dir.join(executable).with_extension(ext).is_file() {
                    return true;
                }
            }
            // 也检查无扩展名的精确匹配
            if dir.join(executable).is_file() {
                return true;
            }
        }
        false
    }
    #[cfg(not(windows))]
    {
        which::which(executable).is_ok()
    }
}

pub(crate) fn probe_local_runtime(kind: &str, command: &str) -> AiRuntimeProbe {
    // command 可能包含参数（如 "claude --dangerously-skip-permissions"），
    // 但探测版本时只需要可执行文件名，不应传额外参数。
    let probe_executable = if let Ok(parts) = split_runtime_command(command) {
        parts.into_iter().next().unwrap_or_else(|| command.to_string())
    } else {
        command.to_string()
    };
    #[cfg(windows)]
    let mut process = if Path::new(&probe_executable).extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    }) {
        npm_command_probe(Path::new(&probe_executable))
    } else if Path::new(&probe_executable).is_absolute() {
        // 绝对路径（如 .exe）可以直接执行
        let mut process = Command::new(&probe_executable);
        process.arg("--version");
        process
    } else {
        // 裸命令名（如 "codex"、"claude"）需通过 cmd /C 执行，
        // Rust 的 Command::new 不会自动解析 PATHEXT (.exe/.cmd/.bat)
        let mut process = Command::new("cmd");
        process.args(["/D", "/S", "/C"]);
        process.raw_arg(format!("\"{}\" --version", probe_executable));
        process
    };
    #[cfg(not(windows))]
    let mut process = {
        let mut process = Command::new(&probe_executable);
        process.arg("--version");
        process
    };
    if let Ok(output) =
        run_command_with_timeout(&mut process, RUNTIME_PROBE_TIMEOUT, "Runtime 探测")
    {
        if output.status.success() {
            return available_runtime_probe(kind, command, output);
        }
    }

    #[cfg(windows)]
    if let Some(npm_command) = npm_global_command(&probe_executable) {
        let mut process = npm_command_probe(&npm_command);
        if let Ok(output) =
            run_command_with_timeout(&mut process, RUNTIME_PROBE_TIMEOUT, "Runtime 探测")
        {
            if output.status.success() {
                return available_runtime_probe(
                    kind,
                    npm_command.to_string_lossy().as_ref(),
                    output,
                );
            }
        }
    }

    // 兜底：如果以上探测都失败，用 where/which 检查可执行文件是否存在于 PATH 中。
    // 很多 CLI 在应用启动时冷启动慢，--version 可能超时，但文件确实可用。
    if executable_exists_in_path(&probe_executable) {
        return AiRuntimeProbe {
            kind: kind.to_string(),
            command: command.to_string(),
            available: true,
            version: None,
        };
    }

    unavailable_runtime_probe(kind, command)
}

pub(crate) fn available_runtime_probe(kind: &str, command: &str, output: Output) -> AiRuntimeProbe {
    AiRuntimeProbe {
        kind: kind.to_string(),
        command: command.to_string(),
        available: true,
        version: String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    }
}

#[cfg(windows)]
pub(crate) fn npm_global_command(command: &str) -> Option<PathBuf> {
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    let user_app_data = dirs::home_dir().map(|directory| directory.join("AppData").join("Roaming"));
    [app_data, user_app_data]
        .into_iter()
        .flatten()
        .map(|directory| directory.join("npm").join(format!("{}.cmd", command)))
        .find(|path| path.is_file())
}

#[cfg(windows)]
pub(crate) fn npm_command_probe(command: &Path) -> Command {
    let mut process = Command::new("cmd");
    process.args(["/D", "/S", "/C"]);
    process.raw_arg(format!("\"{}\" --version", command.display()));
    if let Some(node_directory) = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .map(|directory| directory.join("nodejs"))
        .filter(|directory| directory.join("node.exe").is_file())
    {
        let current_path = std::env::var_os("PATH").unwrap_or_default();
        let mut search_path = node_directory.into_os_string();
        search_path.push(";");
        search_path.push(current_path);
        process.env("PATH", search_path);
    }
    process
}


/// 构造任务字段 diff 审计文本：只列变更字段，格式 `field: '旧值' → '新值'`。
pub(crate) fn build_task_diff(original: &AiTaskNode, updated: &AiTaskNode) -> String {
    let mut parts = Vec::new();
    if original.title != updated.title {
        parts.push(format!("title: '{}' → '{}'", original.title, updated.title));
    }
    if original.description != updated.description {
        parts.push(format!(
            "description: '{}' → '{}'",
            original.description, updated.description
        ));
    }
    if original.role_id != updated.role_id {
        parts.push(format!(
            "roleId: '{:?}' → '{:?}'",
            original.role_id, updated.role_id
        ));
    }
    if original.preferred_agent_id != updated.preferred_agent_id {
        parts.push(format!(
            "preferredAgentId: '{:?}' → '{:?}'",
            original.preferred_agent_id, updated.preferred_agent_id
        ));
    }
    if original.execution_mode != updated.execution_mode {
        parts.push(format!(
            "executionMode: '{}' → '{}'",
            original.execution_mode, updated.execution_mode
        ));
    }
    if original.execution_context != updated.execution_context {
        parts.push(format!(
            "executionContext: '{:?}' → '{:?}'",
            original.execution_context, updated.execution_context
        ));
    }
    if original.task_prompt != updated.task_prompt {
        parts.push("taskPrompt: 已变更".to_string());
    }
    if original.timeout_seconds != updated.timeout_seconds {
        parts.push(format!(
            "timeoutSeconds: '{:?}' → '{:?}'",
            original.timeout_seconds, updated.timeout_seconds
        ));
    }
    if original.retry_count != updated.retry_count {
        parts.push(format!(
            "retryCount: '{}' → '{}'",
            original.retry_count, updated.retry_count
        ));
    }
    for (label, original_items, updated_items) in [
        ("allowedWritePaths", &original.allowed_write_paths, &updated.allowed_write_paths),
        ("expectedArtifacts", &original.expected_artifacts, &updated.expected_artifacts),
        ("acceptanceCommands", &original.acceptance_commands, &updated.acceptance_commands),
        ("dependencyIds", &original.dependency_ids, &updated.dependency_ids),
    ] {
        if original_items != updated_items {
            parts.push(format!(
                "{}: 已变更（{} 项 → {} 项）",
                label,
                original_items.len(),
                updated_items.len()
            ));
        }
    }
    if parts.is_empty() {
        "无字段变更".to_string()
    } else {
        parts.join("；")
    }
}

pub(crate) fn cleanup_unallocated_task_worktree(source: &Path, worktree: &Path, branch_name: &str) {
    let _ = run_git(
        source,
        &[
            "worktree".to_string(),
            "remove".to_string(),
            "--force".to_string(),
            worktree.to_string_lossy().to_string(),
        ],
    );
    let _ = run_git(
        source,
        &[
            "branch".to_string(),
            "-D".to_string(),
            branch_name.to_string(),
        ],
    );
    if worktree.exists() {
        let _ = fs::remove_dir_all(worktree);
    }
}

/// 递归收集所有传递依赖的任务节点 ID（含直接依赖及其上游依赖）
pub(crate) fn collect_transitive_dependency_ids(task: &AiTaskNode) -> Result<Vec<String>, String> {
    let mut visited = std::collections::HashSet::new();
    let mut result = Vec::new();
    let mut stack: Vec<String> = task.dependency_ids.clone();
    while let Some(dep_id) = stack.pop() {
        if !visited.insert(dep_id.clone()) {
            continue;
        }
        let dep = AiDeliveryService::get_task_node(&dep_id)?;
        stack.extend(dep.dependency_ids.iter().cloned());
        result.push(dep_id);
    }
    Ok(result)
}

pub(crate) fn materialize_dependency_artifacts(
    project: &AiProject,
    task: &AiTaskNode,
    contract: &AiTaskContract,
) -> Result<Option<String>, String> {
    if contract.input_artifacts.is_empty() {
        return Ok(None);
    }
    if task.dependency_ids.is_empty() {
        return Err("任务声明了输入成果，但未指定任何前置任务".to_string());
    }
    let handoff_root = project_artifact_base_path(project)
        .join("handoff")
        .join(compact_path_id(&contract.delivery_id))
        .join(compact_path_id(&contract.task_id));
    if handoff_root.exists() {
        return Err(format!(
            "任务成果交接目录已存在: {}",
            handoff_root.display()
        ));
    }
    let mut missing = contract
        .input_artifacts
        .iter()
        .map(|artifact| artifact.trim().to_string())
        .collect::<HashSet<_>>();
    let all_dependency_ids = collect_transitive_dependency_ids(&task)?;
    for dependency_id in &all_dependency_ids {
        let dependency = AiDeliveryService::get_task_node(dependency_id)?;
        if dependency.state != "succeeded" {
            return Err(format!("前置任务尚未审核通过: {}", dependency.title));
        }
        let dependency_contract_id = dependency
            .contract_id
            .as_deref()
            .ok_or_else(|| format!("前置任务缺少任务契约: {}", dependency.title))?;
        let dependency_contract = AiDeliveryService::get::<AiTaskContract>(
            CONTRACTS_DIR,
            dependency_contract_id,
            "前置任务契约",
        )?;
        let dependency_output_directory = dependency_contract
            .output_artifact_directory
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&dependency_contract.working_directory));
        for artifact in &contract.input_artifacts {
            let relative = artifact.trim();
            let artifact_path = Path::new(relative);
            if relative.is_empty()
                || artifact_path.is_absolute()
                || artifact_path
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return Err(format!("输入成果路径不安全: {}", artifact));
            }
            let source = dependency_output_directory.join(artifact_path);
            if !source.exists() {
                continue;
            }
            let destination = handoff_root
                .join(safe_path_segment(dependency_id))
                .join(artifact_path);
            copy_artifact_path(&source, &destination)?;
            missing.remove(relative);
        }
    }
    if !missing.is_empty() {
        let _ = fs::remove_dir_all(&handoff_root);
        return Err(format!(
            "未能从前置任务取得声明的输入成果: {}",
            missing.into_iter().collect::<Vec<_>>().join("、")
        ));
    }
    Ok(Some(handoff_root.to_string_lossy().to_string()))
}

pub(crate) fn prepare_output_artifact_directory(
    project: &AiProject,
    task: &AiTaskNode,
    contract: &AiTaskContract,
) -> Result<Option<String>, String> {
    if task.execution_mode != "readonly" || contract.expected_artifacts.is_empty() {
        return Ok(None);
    }
    let output_root = project_artifact_base_path(project)
        .join("outputs")
        .join(compact_path_id(&contract.delivery_id))
        .join(compact_path_id(&contract.task_id));
    if output_root.exists() {
        return Err(format!("只读任务成果目录已存在: {}", output_root.display()));
    }
    fs::create_dir_all(&output_root)
        .map_err(|error| format!("创建只读任务成果目录失败: {}", error))?;
    Ok(Some(output_root.to_string_lossy().to_string()))
}

pub(crate) fn copy_artifact_path(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_file() {
        let parent = destination
            .parent()
            .ok_or_else(|| "输入成果目标路径无效".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建成果交接目录失败: {}", error))?;
        fs::copy(source, destination).map_err(|error| format!("复制输入成果失败: {}", error))?;
        return Ok(());
    }
    if !source.is_dir() {
        return Err(format!("输入成果不是文件或目录: {}", source.display()));
    }
    fs::create_dir_all(destination).map_err(|error| format!("创建成果目录失败: {}", error))?;
    for entry in fs::read_dir(source).map_err(|error| format!("读取输入成果目录失败: {}", error))?
    {
        let entry = entry.map_err(|error| format!("读取输入成果失败: {}", error))?;
        copy_artifact_path(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

