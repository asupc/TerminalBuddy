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

/// 读取 Agent 运行记录（transcript.log，为空时回退 live-output.log）的尾部，
/// 用于在「终端已结束且无完整成果」这类模糊失败中附带真实原因，便于人工定位。
pub(crate) fn terminal_transcript_tail(run_id: &str) -> Option<String> {
    let directory = terminal_run_dir_by_id(run_id);
    let content = fs::read_to_string(directory.join("transcript.log"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            fs::read_to_string(directory.join("live-output.log"))
                .ok()
                .filter(|value| !value.trim().is_empty())
        })?;
    let compact = strip_terminal_control_sequences(&content);
    const MAX_TAIL_CHARS: usize = 600;
    let tail = compact
        .chars()
        .rev()
        .take(MAX_TAIL_CHARS)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let trimmed = tail.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 写任务验收前，把 Agent 遗留的、位于允许写入路径内的未提交改动自动提交，
/// 避免「Agent 执行后存在未提交改动」直接失败阻断任务推进。
/// - 全部改动都在允许范围内：自动提交并返回提交摘要；
/// - 无改动：返回 None；
/// - 存在允许范围外的改动：跳过自动提交返回 None，交由静态越权审计判定。
pub(crate) fn auto_commit_allowed_changes(
    contract: &AiTaskContract,
    commit_message: &str,
) -> Result<Option<String>, String> {
    let worktree = PathBuf::from(&contract.working_directory);
    if !worktree.is_dir() {
        return Err("任务 worktree 不可用，无法自动提交".to_string());
    }
    let mut changed_paths = Vec::new();
    // 只统计尚未提交的改动：工作树未暂存 + 已暂存 + 未跟踪。
    // 不能用 `git diff <base>`：它包含相对基线已提交的改动，重试场景下
    // 改动早已提交，git commit 会报「nothing to commit」退出码 1，误判失败。
    changed_paths.extend(
        run_git(
            &worktree,
            &["diff".to_string(), "--name-only".to_string()],
        )?
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string),
    );
    changed_paths.extend(
        run_git(
            &worktree,
            &[
                "diff".to_string(),
                "--cached".to_string(),
                "--name-only".to_string(),
            ],
        )?
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string),
    );
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
    if changed_paths.is_empty() {
        return Ok(None);
    }
    let in_scope = changed_paths
        .iter()
        .all(|path| is_allowed_write_path(path, &contract.allowed_write_paths));
    if !in_scope {
        // 越权改动交给 audit_contract_scope 判定（policyViolation），平台不代提交。
        return Ok(None);
    }
    let mut add_args = vec!["-c".to_string(), "user.name=TerminalBuddy".to_string()];
    add_args.extend([
        "-c".to_string(),
        "user.email=terminalbuddy@local".to_string(),
        "add".to_string(),
        "-A".to_string(),
        "--".to_string(),
    ]);
    add_args.extend(changed_paths.iter().cloned());
    run_git(&worktree, &add_args)?;
    run_git(
        &worktree,
        &[
            "-c".to_string(),
            "user.name=TerminalBuddy".to_string(),
            "-c".to_string(),
            "user.email=terminalbuddy@local".to_string(),
            "commit".to_string(),
            "-m".to_string(),
            commit_message.to_string(),
        ],
    )?;
    let head = run_git(&worktree, &["rev-parse".to_string(), "HEAD".to_string()])?;
    Ok(Some(format!(
        "{}（{} 个文件）",
        head.get(..8).unwrap_or(&head),
        changed_paths.len()
    )))
}

pub(crate) fn run_shell_command(working_directory: &Path, command: &str) -> Result<AiCommandResult, String> {
    // 验收命令与质量门禁命令使用 PowerShell 语法（Test-Path、Select-String 等 cmdlet），
    // 必须通过 powershell.exe 执行，cmd.exe 无法识别 PowerShell cmdlet。
    let run_powershell = || -> Result<AiCommandResult, String> {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", command])
            .current_dir(working_directory);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let output =
            run_command_with_timeout(&mut cmd, QUALITY_GATE_COMMAND_TIMEOUT, "质量门禁命令")?;
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
    };
    let mut result = run_powershell()?;
    // bash 兼容回退：管理者/Agent 生成的验收命令可能混入 bash 语法（如
    // `test -f docs/x.md`、`test -z "$(git status --porcelain)"`），PowerShell 5.1
    // 无法识别会直接退出码 1，把「命令不兼容」误判成「验收失败」。
    // PowerShell 失败且本机存在 Git Bash 时用 bash -c 重跑一次（bash 仍失败则如实失败）。
    if result.exit_code != 0 {
        if let Some(bash) = git_bash_executable() {
            let mut cmd = Command::new(bash);
            cmd.args(["-c", command]).current_dir(working_directory);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            if let Ok(output) = run_command_with_timeout(
                &mut cmd,
                QUALITY_GATE_COMMAND_TIMEOUT,
                "验收命令（bash 兼容回退）",
            ) {
                let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stderr.trim().is_empty() {
                    if !combined.is_empty() {
                        combined.push('\n');
                    }
                    combined.push_str(&stderr);
                }
                result = AiCommandResult {
                    command: format!("{}（bash 回退）", command),
                    exit_code: output.status.code().unwrap_or(-1),
                    output: compact_output(&combined),
                };
            }
        }
    }
    Ok(result)
}

pub(crate) fn git_bash_executable() -> Option<&'static str> {
    static BASH: OnceLock<Option<&'static str>> = OnceLock::new();
    *BASH.get_or_init(|| {
        let candidates = [
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
            "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        ];
        candidates
            .iter()
            .find(|candidate| Path::new(candidate).is_file())
            .copied()
            .or_else(|| {
                which_bash_from_path().map(|value| {
                    let leaked: &'static str = Box::leak(value.into_boxed_str());
                    leaked
                })
            })
    })
}

fn which_bash_from_path() -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path_var) {
        let candidate = directory.join("bash.exe");
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
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
        "你是 AI 交付团队的管理者。请把用户需求拆解为可执行的结构化任务图。\n\n需求标题：{}\n需求正文：{}\n\n项目工作区：{}\n可用仓库：\n{}\n\n可用角色：\n{}\n\n用户指定的任务编排（必须逐步覆盖并保持顺序）：\n{}\n\n硬性约束：\n1. 每个写入任务只能指定一个 targetRepositoryId，禁止单个 Agent 跨服务修改。\n2. 跨服务依赖判断（必须遵守）：\n   - 若任务 B 的正确改动需要任务 A 先完成，则 B 的 dependencyIndexes 必须包含 A，且 A 在 tasks 中排在 B 之前（dependencyIndexes 只能引用更早的任务）。\n   - 出现以下任一情况即视为存在依赖，必须建立：\n     a) A 改动了 B 依赖的契约：API 接口/参数/返回值、数据模型、DB schema/迁移、共享类型定义、对外配置项；\n     b) A 属于基础/底层服务（如基础数据、用户、字典、权限等），B 属于依赖它的上层业务服务（如仓储 wms、订单、库存）；\n     c) 同一编排步骤内按服务拆分的并行任务，若存在 a/b 所述契约依赖，也要建立依赖，而非默认并行；必要时把被依赖的服务拆到更早的编排步骤。\n   - 反之，若两个跨服务任务无任何契约或数据依赖，不得建立依赖（避免不必要串行）。\n   - 判断口诀：B 离开 A 能否独立正确完成——不能则必须依赖。\n3. 每个阶段任务必须声明至少一个具体交付物 expectedArtifacts，禁止空数组；每个元素只能是安全相对路径，例如 `analysis/mom-app-item1-4.md` 或 `uni-app/pages/outbounds/index.vue`，不能填写说明句子、绝对路径或 `../`。任务只有在交付物实际存在并通过校验后才能更新为完成。只读步骤的交付物会写入平台提供的项目外成果目录，并自动交接给后续步骤。\n4. 每个任务必须声明 allowedWritePaths 和验收命令；只读步骤的 allowedWritePaths 使用 [\".\"]。\n   - 验收命令由平台在 Windows PowerShell 5.1 中执行：必须使用 PowerShell 兼容语法，并以非零退出码表示验收失败（如 `Test-Path -LiteralPath 'docs/x.md'` 判文件存在、`git status --porcelain` 判工作树干净，失败时 `exit 1`）。\n   - 禁止使用 bash 专属语法（如 `test -f`、`test -z \"$(...)\"`、`&&`/`||` 连接、`$()` 命令替换）；反例 `test -f docs/x.md` 在 PowerShell 中必然报“test 不是 cmdlet”而失败。\n   - 正确示例：`if (Test-Path -LiteralPath 'docs/team-conventions.md') {{ exit 0 }} else {{ exit 1 }}`。\n5. workflowStepId 必须使用上面给出的 stepId；每个编排步骤至少生成一个任务，同一步骤可以按服务拆成多个并行任务。\n6. 后一步骤的每个任务必须依赖前一步骤的全部任务；tasks 按编排顺序和拓扑顺序输出，dependencyIndexes 从 0 开始且只能引用之前的任务。\n7. 不要计划 git push、PR、部署、删除数据或破坏性操作。\n8. 只返回符合提供 JSON Schema 的数据。",
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

/// 将显示标签中的不安全字符替换为下划线，用于构造可读的终端运行目录名。
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
        let repository = project
            .repositories
            .iter()
            .find(|repository| repository.id == contract.target_repository_id);
        if let Some(worktree_path) = contract.worktree_path.as_deref() {
            match repository.and_then(|repository| project_repository_path(project, repository).ok()) {
                Some(source) => {
                    cleanup_unallocated_task_worktree(&source, Path::new(worktree_path), branch_name)
                }
                // 仓库已从项目移除（或目录不可用）时退化为直接删目录，
                // 避免 worktree 目录永久残留；契约文件保留供历史查看
                None => {
                    let _ = fs::remove_dir_all(worktree_path);
                }
            }
        } else if let Some(repository) = repository {
            let Ok(source) = project_repository_path(project, repository) else {
                continue;
            };
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

/// 按 PowerShell 的命令解析规则解析 runtime 可执行文件（优先 .ps1/.cmd 包装器），
/// 与 AI 终端内 `& 'codex'` 的解析保持一致，避免派发前探活与实际执行命中不同版本。
pub(crate) fn resolve_runtime_executable(command: &str) -> Result<String, String> {
    let parts = split_runtime_command(command)?;
    let executable = &parts[0];
    let path = Path::new(executable);
    if path.is_absolute() || path.components().count() > 1 {
        return Ok(executable.clone());
    }
    // 裸命令名：用 PowerShell Get-Command 解析（与终端内一致），
    // 不用 cmd 的 PATHEXT 规则，避免命中 WinGet/WindowsApps 等不同版本。
    let script = format!(
        "(Get-Command -Name {} -ErrorAction Stop | Select-Object -First 1).Source",
        powershell_literal(executable)
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let output =
        run_command_with_timeout(&mut cmd, RUNTIME_PROBE_TIMEOUT, "Runtime 命令解析")?;
    let source = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || source.is_empty() {
        return Err(format!("无法在系统 PATH 中找到 Runtime CLI「{}」", executable));
    }
    Ok(source)
}

/// 运行 runtime CLI（兼容 .ps1 包装器：需经 powershell.exe 执行）。
fn run_runtime_cli(executable: &str, args: &[&str], label: &str) -> Result<String, String> {
    let mut process = if executable.to_ascii_lowercase().ends_with(".ps1") {
        let mut script = format!("& {}", powershell_literal(executable));
        for argument in args {
            script.push(' ');
            script.push_str(&powershell_literal(argument));
        }
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        cmd
    } else {
        let mut cmd = Command::new(executable);
        cmd.args(args);
        cmd
    };
    #[cfg(windows)]
    process.creation_flags(CREATE_NO_WINDOW);
    process.stdout(Stdio::piped());
    process.stderr(Stdio::piped());
    let output = run_command_with_timeout(&mut process, RUNTIME_PROBE_TIMEOUT, label)?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    if !output.status.success() {
        return Err(format!(
            "{}失败（退出码 {}）: {}",
            label,
            output.status.code().unwrap_or(-1),
            compact_output(&combined)
        ));
    }
    Ok(combined)
}

/// 派发前探活：确认 Runtime CLI 可用，并校验 Codex 支持 AI 交付注入的关键标志。
/// 历史故障中 Codex CLI 版本与注入标志不兼容时会在终端内秒退（exit=2）且几乎无输出，
/// 这里提前在平台侧验证，失败时返回可直接展示给用户的明确原因。
pub(crate) fn probe_runtime_for_dispatch(runtime: &AiAgentRuntime) -> Result<(), String> {
    let resolved = resolve_runtime_executable(&runtime.command)?;
    let _ = run_runtime_cli(&resolved, &["--version"], "Runtime CLI 版本探测")?;
    let is_codex = split_runtime_command(&runtime.command)?.into_iter().next().is_some_and(
        |executable| runtime_kind_matches(runtime, &executable, "codex"),
    );
    if !is_codex {
        return Ok(());
    }
    // Codex：校验 exec 非交互执行所需的关键标志，版本过旧时提前报错而不是秒退。
    let help = run_runtime_cli(&resolved, &["exec", "--help"], "Codex exec 参数探测")?;
    const REQUIRED_FLAGS: [&str; 4] = [
        "--output-schema",
        "--output-last-message",
        "--add-dir",
        "--skip-git-repo-check",
    ];
    let missing: Vec<&str> = REQUIRED_FLAGS
        .iter()
        .copied()
        .filter(|flag| !help.contains(flag))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Codex CLI 版本过旧，缺少 AI 交付所需的参数：{}。请升级：npm install -g @openai/codex@latest",
            missing.join("、")
        ));
    }
    Ok(())
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

/// 丢弃任务契约并尽力清理其 worktree/分支：任务执行环境字段（目标仓库/执行模式/
/// 执行上下文）变更后旧契约的 worktree 位于旧仓库旧目录，重试若复用会让 Agent 在
/// 错误位置执行、审计按旧基线、合并时分支不在新目标仓库——必须重建契约与 worktree。
/// 返回清理是否完整（false 表示 worktree 可能残留，交付删除时兜底清理）。
pub(crate) fn discard_task_contract(task: &mut AiTaskNode) -> bool {
    let Some(contract_id) = task.contract_id.clone() else {
        return true;
    };
    let mut cleaned = true;
    if let Ok(contract) =
        AiDeliveryService::get::<AiTaskContract>(CONTRACTS_DIR, &contract_id, "任务契约")
    {
        if let Ok(delivery) = AiDeliveryService::get_delivery(&task.delivery_id) {
            if let Ok(project) = AiDeliveryService::get_project(&delivery.project_id) {
                if let (Some(worktree), Some(branch)) = (
                    contract.worktree_path.as_deref(),
                    contract.branch_name.as_deref(),
                ) {
                    if let Some(repository) = project
                        .repositories
                        .iter()
                        .find(|repository| repository.id == contract.target_repository_id)
                    {
                        match project_repository_path(&project, repository) {
                            Ok(source) => {
                                cleanup_unallocated_task_worktree(
                                    &source,
                                    Path::new(worktree),
                                    branch,
                                );
                            }
                            Err(_) => cleaned = false,
                        }
                    }
                }
                // 同时回收成果交接目录（handoff/{delivery}/{task}）：旧契约的交接目录若残留，
                // 重试派发时 materialize_dependency_artifacts 会以「任务成果交接目录已存在」
                // 拒绝创建，任务永久卡死（编辑环境字段后走全新契约路径的场景）。
                let handoff_root = project_artifact_base_path(&project)
                    .join("handoff")
                    .join(compact_path_id(&delivery.id))
                    .join(compact_path_id(&task.id));
                let _ = fs::remove_dir_all(&handoff_root);
                // 同理回收只读任务成果目录（outputs/{delivery}/{task}），避免重派被
                // prepare_output_artifact_directory 的残留检查阻塞。
                let output_root = project_artifact_base_path(&project)
                    .join("outputs")
                    .join(compact_path_id(&delivery.id))
                    .join(compact_path_id(&task.id));
                let _ = fs::remove_dir_all(&output_root);
            }
        }
    }
    let _ = AiDeliveryService::delete(CONTRACTS_DIR, &contract_id, "任务契约");
    task.contract_id = None;
    cleaned
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

/// 传递依赖裁剪：仅保留直接依赖，去掉可由其他直接依赖间接到达的依赖。
/// 例如 D 依赖 [A, B, C] 且 C→B→A（C 依赖 B、B 依赖 A）时，D 只保留 [C]，
/// 间接链路 C→B→A 已隐式满足，DAG 不再出现 D→A、D→B 这类冗余依赖线。
/// all_tasks 需包含可能被引用的任务节点，用于沿既有依赖链做可达性分析。
pub(crate) fn reduce_transitive_dependencies<'a, I>(
    dependency_ids: impl IntoIterator<Item = String>,
    all_tasks: I,
) -> Vec<String>
where
    I: IntoIterator<Item = &'a AiTaskNode>,
{
    let by_id: HashMap<&str, &AiTaskNode> = all_tasks
        .into_iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    fn collect_reachable<'a>(
        start: &str,
        by_id: &HashMap<&str, &'a AiTaskNode>,
        visited: &mut HashSet<String>,
    ) {
        if !visited.insert(start.to_string()) {
            return;
        }
        if let Some(task) = by_id.get(start) {
            for dep in &task.dependency_ids {
                collect_reachable(dep, by_id, visited);
            }
        }
    }
    let mut seen = HashSet::new();
    let unique: Vec<String> = dependency_ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    let mut reachable_from: HashMap<String, HashSet<String>> = HashMap::new();
    for dep in &unique {
        let mut set = HashSet::new();
        collect_reachable(dep, &by_id, &mut set);
        set.remove(dep);
        reachable_from.insert(dep.clone(), set);
    }
    unique
        .iter()
        .filter(|dep| {
            let dep_id: &String = dep;
            !unique.iter().any(|other| {
                let other_id: &String = other;
                other_id != dep_id
                    && reachable_from
                        .get(other_id.as_str())
                        .is_some_and(|set| set.contains(dep_id.as_str()))
            })
        })
        .cloned()
        .collect()
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
    // handoff 残留（上次拷贝中断/回收未清理）会让任务被空目录永久卡死；
    // 派发对应新建契约，清理后重建并重新拷贝前置成果。
    if handoff_root.exists() {
        fs::remove_dir_all(&handoff_root)
            .map_err(|error| format!("清理任务成果交接目录失败: {}", error))?;
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
    // outputs 残留（上次派发未产出/中断、或契约回收未清理）会让任务被空目录永久卡死；
    // 派发对应新建契约，旧 outputs 无意义，清理后重建。
    if output_root.exists() {
        fs::remove_dir_all(&output_root)
            .map_err(|error| format!("清理只读任务成果目录失败: {}", error))?;
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


impl AiDeliveryService {
    pub fn detect_local_runtimes() -> Vec<AiRuntimeProbe> {
        let mut runtime_commands = [
            ("codex", "codex"),
            ("claude", "claude"),
            ("opencode", "opencode"),
            ("hermes", "hermes"),
            ("pi", "pi"),
            ("mimo", "mimo"),
            ("kimi", "kimi"),
        ]
        .into_iter()
        .map(|(kind, command)| (kind.to_string(), command.to_string()))
        .collect::<Vec<_>>();

        // 自定义命令可能位于非标准 PATH。保留默认探测以发现新安装的 CLI，
        // 同时探测已保存的 Runtime，确保 Agent 实际会启动的命令得到准确状态。
        for runtime in Self::get_all_runtimes().unwrap_or_default() {
            if runtime.command.trim().is_empty()
                || runtime_commands
                    .iter()
                    .any(|(kind, command)| kind == &runtime.kind && command == &runtime.command)
            {
                continue;
            }
            runtime_commands.push((runtime.kind, runtime.command));
        }

        runtime_commands
            .into_iter()
            .map(|(kind, command)| {
                let fallback = unavailable_runtime_probe(&kind, &command);
                (
                    fallback,
                    thread::spawn(move || probe_local_runtime(&kind, &command)),
                )
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(fallback, handle)| handle.join().unwrap_or(fallback))
            .collect()
    }
}
