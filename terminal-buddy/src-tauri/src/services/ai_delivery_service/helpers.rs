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
