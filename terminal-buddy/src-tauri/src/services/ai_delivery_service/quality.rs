//! AI 交付服务 · 质量域模块（自 ai_delivery_service.rs 拆分）
use super::*;

pub(crate) fn normalize_quality_gate(mut quality_gate: AiQualityGate) -> Result<AiQualityGate, String> {
    quality_gate.commands = quality_gate
        .commands
        .into_iter()
        .map(|command| command.trim().to_string())
        .filter(|command| !command.is_empty())
        .collect();
    if quality_gate.commands.is_empty() {
        return Err("质量门禁命令至少需要一条，确保交付能够审核和本地合并".to_string());
    }
    Ok(quality_gate)
}

pub(crate) fn scan_repository_quality_contexts(
    workspace_root: &Path,
) -> Result<Vec<RepositoryQualityContext>, String> {
    let repositories = discover_repositories(workspace_root)?;
    let mut contexts = Vec::new();
    for repository in repositories {
        let repository_path = if repository.relative_path == "." {
            workspace_root.to_path_buf()
        } else {
            workspace_root.join(&repository.relative_path)
        };
        let manifests = scan_quality_manifests(&repository_path);
        let stacks = detect_repository_stacks(&repository.relative_path, &manifests);
        contexts.push(RepositoryQualityContext {
            name: repository.name,
            relative_path: repository.relative_path,
            default_branch: repository.default_branch,
            stacks,
            manifests,
        });
    }
    Ok(contexts)
}

pub(crate) fn scan_quality_manifests(root: &Path) -> Vec<QualityManifest> {
    let mut manifests = Vec::new();
    scan_quality_manifests_recursive(root, root, 0, &mut manifests);
    manifests.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    manifests
}

pub(crate) fn scan_quality_manifests_recursive(
    root: &Path,
    directory: &Path,
    depth: usize,
    manifests: &mut Vec<QualityManifest>,
) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if path.is_dir() {
            if matches!(
                name.as_str(),
                ".git"
                    | "node_modules"
                    | "dist"
                    | "build"
                    | "target"
                    | ".next"
                    | ".nuxt"
                    | ".venv"
                    | "venv"
                    | "vendor"
                    | "__pycache__"
                    | ".idea"
                    | ".vscode"
            ) || (name.starts_with('.') && name != ".github")
            {
                continue;
            }
            scan_quality_manifests_recursive(root, &path, depth + 1, manifests);
        } else if QUALITY_MANIFEST_NAMES.contains(&name.as_str())
            || name.ends_with(".csproj")
        {
            let relative_path = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string()
                .replace('\\', "/");
            let scripts = if name == "package.json" {
                package_scripts(&path)
            } else {
                None
            };
            manifests.push(QualityManifest {
                relative_path,
                scripts,
            });
        }
    }
}

pub(crate) fn package_scripts(path: &Path) -> Option<Vec<String>> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > 256 * 1024 {
        return None;
    }
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let scripts = value.get("scripts")?.as_object()?;
    let mut names = scripts
        .keys()
        .filter(|name| {
            !name.is_empty()
                && name.chars().all(|character| {
                    character.is_ascii_alphanumeric()
                        || matches!(character, ':' | '-' | '_')
                })
        })
        .cloned()
        .collect::<Vec<String>>();
    names.sort();
    names.dedup();
    Some(names)
}

pub(crate) fn detect_repository_stacks(
    relative_path: &str,
    manifests: &[QualityManifest],
) -> Vec<String> {
    let mut stacks = Vec::<String>::new();
    let normalized = relative_path.replace('\\', "/").to_ascii_lowercase();
    let segments = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.iter().any(|segment| {
        matches!(
            *segment,
            "web"
                | "frontend"
                | "front"
                | "client"
                | "ui"
                | "h5"
                | "uniapp"
                | "uni-app"
                | "app"
                | "applet"
                | "applets"
        )
    }) {
        stacks.push("frontend".to_string());
    }
    if segments.iter().any(|segment| {
        matches!(
            *segment,
            "server" | "backend" | "api" | "service" | "services" | "admin-api"
        )
    }) {
        stacks.push("backend".to_string());
    }
    for manifest in manifests {
        let manifest_path = manifest.relative_path.to_ascii_lowercase();
        let manifest_name = manifest_path
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string();
        if matches!(
            manifest_name.as_str(),
            "package.json" | "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock"
        ) {
            push_stack(&mut stacks, "typescript/javascript".to_string());
            if manifest_path.contains("src-tauri") {
                push_stack(&mut stacks, "desktop".to_string());
            }
            if manifest_path.starts_with("web/") || manifest_path.starts_with("frontend/") {
                push_stack(&mut stacks, "frontend".to_string());
            }
            if manifest.scripts.as_deref().is_some_and(|scripts| {
                scripts.iter().any(|script| {
                    script.contains("web")
                        || script.contains("frontend")
                        || script.contains("ui")
                })
            }) {
                push_stack(&mut stacks, "frontend".to_string());
            }
            if manifest.scripts.as_deref().is_some_and(|scripts| {
                scripts
                    .iter()
                    .any(|script| script.contains("server") || script.contains("api"))
            }) {
                push_stack(&mut stacks, "backend".to_string());
            }
        }
        if matches!(
            manifest_name.as_str(),
            "cargo.toml" | "cargo.lock"
        ) {
            push_stack(&mut stacks, "rust".to_string());
            if manifest_path.contains("src-tauri") {
                push_stack(&mut stacks, "desktop".to_string());
            }
        }
        if matches!(
            manifest_name.as_str(),
            "requirements.txt" | "pyproject.toml"
        ) {
            push_stack(&mut stacks, "python".to_string());
        }
        if manifest_name == "go.mod" {
            push_stack(&mut stacks, "go".to_string());
        }
        if matches!(
            manifest_name.as_str(),
            "pom.xml" | "build.gradle" | "build.gradle.kts"
        ) {
            push_stack(&mut stacks, "java".to_string());
        }
        if manifest_name.ends_with(".csproj") {
            push_stack(&mut stacks, ".net".to_string());
        }
    }
    if stacks.is_empty() {
        stacks.push("mixed".to_string());
    }
    stacks
}

pub(crate) fn push_stack(stacks: &mut Vec<String>, stack: String) {
    if !stacks.contains(&stack) {
        stacks.push(stack);
    }
}

pub(crate) fn build_quality_gate_prompt(
    contexts: &[RepositoryQualityContext],
    workspace_root: &Path,
    result_path: &Path,
    schema_path: &Path,
    cli_captures_output: bool,
) -> String {
    let contexts_json = serde_json::to_string_pretty(contexts).unwrap_or_default();
    let output_instruction = if cli_captures_output {
        format!(
            "最终响应必须只包含 JSON，不要包含 Markdown 代码块，也不要使用文件工具写入结果文件；平台会将最终响应保存到：{}",
            result_path.display(),
        )
    } else {
        format!(
            "必须使用文件工具把最终 JSON 原样写入：{}",
            result_path.display(),
        )
    };
    format!(
        "你是 AI 交付项目的质量门禁配置专家。\n\
当前工作目录：{}\n\
请先扫描并理解以下工作区结构，再为整个项目生成质量门禁命令。\n\n\
工作区仓库与技术栈扫描结果：\n{}\n\n\
硬性约束：\n\
1. 覆盖所有 Git 仓库；同一仓库包含前端、后端或桌面端时，分别生成对应模块的验证命令。\n\
2. 命令必须是可在当前工作区根目录执行的 PowerShell 命令；优先从各仓库的构建脚本、包管理器和配置文件推导。\n\
3. 只允许类型检查、静态检查、构建、单元测试、集成测试等非破坏性验证；禁止 git push、git reset、git clean、rm -rf、Remove-Item、部署、发布、修改配置、迁移或删除数据。\n\
4. 每条命令单独一个字符串，建议 4-12 条，必须至少包含一次构建或类型检查和一次测试或检查类命令。\n\
5. {}\n\
6. JSON 必须符合 Schema：{}\n\
7. 只输出 JSON 文件内容，不输出额外解释；若某个模块没有可执行的检查命令，不要编造，改为列出该模块的构建命令。",
        workspace_root.display(),
        contexts_json,
        output_instruction,
        schema_path.display(),
    )
}


pub(crate) fn discover_repositories(workspace_root: &Path) -> Result<Vec<AiRepository>, String> {
    let workspace_root = normalize_path_for_external_process(workspace_root);
    let mut candidates = vec![workspace_root.clone()];
    for entry in fs::read_dir(&workspace_root)
        .map_err(|error| format!("读取工作区目录失败: {}", error))?
        .flatten()
    {
        if entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            candidates.push(entry.path());
        }
    }
    let mut repositories = BTreeMap::<String, AiRepository>::new();
    for candidate in candidates {
        let Ok(root) = git_root(&candidate) else {
            continue;
        };
        let canonical_root =
            normalize_path_for_external_process(&root.canonicalize().unwrap_or(root));
        let relative_path = canonical_root
            .strip_prefix(&workspace_root)
            .map_err(|_| "Git 仓库不在工作区内".to_string())?
            .to_string_lossy()
            .to_string();
        let relative_path = if relative_path.is_empty() {
            ".".to_string()
        } else {
            relative_path
        };
        let name = if relative_path == "." {
            workspace_root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("repository")
                .to_string()
        } else {
            canonical_root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("repository")
                .to_string()
        };
        let branch = current_branch(&canonical_root).unwrap_or_else(|| "main".to_string());
        let key = canonical_root.to_string_lossy().to_ascii_lowercase();
        repositories.entry(key).or_insert_with(|| AiRepository {
            id: Uuid::new_v4().to_string(),
            name,
            relative_path,
            default_branch: branch,
            write_concurrency: 2,
            write_enabled: true,
        });
    }
    Ok(repositories.into_values().collect())
}


impl AiDeliveryService {

    pub fn get_review_gates(delivery_id: Option<&str>) -> Result<Vec<AiReviewGate>, String> {
        let mut gates = Self::list(REVIEW_GATES_DIR)?;
        if let Some(delivery_id) = delivery_id {
            gates.retain(|gate: &AiReviewGate| gate.delivery_id == delivery_id);
        }
        gates.sort_by(|left: &AiReviewGate, right: &AiReviewGate| {
            right.updated_at.cmp(&left.updated_at)
        });
        Ok(gates)
    }

    /// 审查用增量 Diff：取任务契约的基线提交与任务分支 HEAD，返回文件清单与双侧文本。
    /// 返回 { baseCommit, headCommit, files: [{path,status,additions,deletions}], diffs: [{path,original,modified}] }。
    pub fn get_review_diff(
        delivery_id: &str,
        task_node_id: &str,
    ) -> Result<serde_json::Value, String> {
        let task = Self::get_task_node(task_node_id)?;
        if task.delivery_id != delivery_id {
            return Err("任务不属于该交付".to_string());
        }
        let contract_id = task
            .contract_id
            .as_deref()
            .ok_or_else(|| "任务缺少任务契约，无法查看代码变更".to_string())?;
        let contract =
            Self::get::<AiTaskContract>(CONTRACTS_DIR, contract_id, "任务契约")?;
        let base_commit = contract
            .base_commit
            .as_deref()
            .ok_or_else(|| "任务契约缺少基线提交，无法查看代码变更".to_string())?;
        let worktree = contract
            .worktree_path
            .as_deref()
            .ok_or_else(|| "任务缺少工作目录，无法查看代码变更".to_string())?;
        let repository = PathBuf::from(worktree);
        let range = format!("{}...HEAD", base_commit);
        let head_commit = run_git(&repository, &["rev-parse".to_string(), "HEAD".to_string()])?;

        let name_status = run_git(
            &repository,
            &["diff".to_string(), range.clone(), "--name-status".to_string()],
        )?;
        let numstat = run_git(
            &repository,
            &["diff".to_string(), range, "--numstat".to_string()],
        )?;

        let name_lines: Vec<&str> = name_status.lines().collect();
        let num_lines: Vec<&str> = numstat.lines().collect();
        let mut files: Vec<serde_json::Value> = Vec::new();
        for (index, line) in name_lines.iter().enumerate() {
            // 行格式：状态符 + TAB + 路径（重命名时含两个路径，取新路径）
            let mut parts = line.split('\t');
            let status = parts
                .next()
                .unwrap_or("?")
                .chars()
                .next()
                .unwrap_or('?')
                .to_string();
            let path = parts.last().unwrap_or("").trim().to_string();
            if path.is_empty() {
                continue;
            }
            let (additions, deletions) = num_lines
                .get(index)
                .map(|line| {
                    let mut parts = line.split('\t');
                    let added = parts
                        .next()
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0);
                    let removed = parts
                        .next()
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0);
                    (added, removed)
                })
                .unwrap_or((0, 0));
            files.push(serde_json::json!({
                "path": path,
                "status": status,
                "additions": additions,
                "deletions": deletions,
            }));
        }

        let mut diffs: Vec<serde_json::Value> = Vec::new();
        for file in &files {
            let path = file["path"].as_str().unwrap_or("");
            let status = file["status"].as_str().unwrap_or("M");
            let original = if status == "A" {
                String::new()
            } else {
                run_git(
                    &repository,
                    &[
                        "show".to_string(),
                        format!("{}:{}", base_commit, path),
                    ],
                )
                .unwrap_or_default()
            };
            let modified = if status == "D" {
                String::new()
            } else {
                run_git(
                    &repository,
                    &["show".to_string(), format!("HEAD:{}", path)],
                )
                .unwrap_or_default()
            };
            diffs.push(serde_json::json!({
                "path": path,
                "original": original,
                "modified": modified,
            }));
        }

        Ok(serde_json::json!({
            "baseCommit": base_commit,
            "headCommit": head_commit,
            "files": files,
            "diffs": diffs,
        }))
    }

    /// 添加审查行评论到 reviewGate.lineComments 并持久化。
    pub fn add_review_line_comment(
        gate_id: &str,
        path: &str,
        line: i64,
        text: &str,
    ) -> Result<AiReviewGate, String> {
        let mut gate = Self::get::<AiReviewGate>(REVIEW_GATES_DIR, gate_id, "审核门禁")?;
        if text.trim().is_empty() {
            return Err("评论内容不能为空".to_string());
        }
        gate.line_comments.push(serde_json::json!({
            "path": path,
            "line": line,
            "text": text.trim(),
            "createdAt": chrono::Utc::now().to_rfc3339(),
        }));
        gate.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(REVIEW_GATES_DIR, &gate.id, &gate)?;
        Ok(gate)
    }

    pub fn run_quality_gate(
        task_node_id: &str,
        reviewer_agent_id: Option<&str>,
        app: tauri::AppHandle,
        terminal_service: TerminalService,
    ) -> Result<AiReviewGate, String> {
        let _guard = acquire_quality_gate_lock(task_node_id)?;
        Self::run_quality_gate_inner(
            task_node_id,
            reviewer_agent_id,
            app,
            terminal_service,
        )
    }

    pub(crate) fn run_quality_gate_inner(
        task_node_id: &str,
        reviewer_agent_id: Option<&str>,
        app: tauri::AppHandle,
        terminal_service: TerminalService,
    ) -> Result<AiReviewGate, String> {
        let mut task = Self::get_task_node(task_node_id)?;
        if task.state != "awaitingReview" {
            return Err(format!("当前任务不能进入质量门禁: {}", task.state));
        }
        let delivery = Self::get_delivery(&task.delivery_id)?;
        let project = Self::get_project(&delivery.project_id)?;
        let reviewer = match reviewer_agent_id {
            Some(reviewer_id) => Self::get::<AiAgent>(AGENTS_DIR, reviewer_id, "Reviewer Agent")?,
            None => Self::get_all_agents()?
                .into_iter()
                .find(|agent| {
                    agent.enabled && task.assigned_agent_id.as_deref() != Some(agent.id.as_str())
                })
                .ok_or_else(|| "未找到可用的独立 Reviewer Agent".to_string())?,
        };
        if !reviewer.enabled || task.assigned_agent_id.as_deref() == Some(reviewer.id.as_str()) {
            return Err("产出任务的 Agent 不能审核自己的改动".to_string());
        }
        let contract_id = task
            .contract_id
            .clone()
            .ok_or_else(|| "任务未关联任务契约".to_string())?;
        let contract = Self::get::<AiTaskContract>(CONTRACTS_DIR, &contract_id, "任务契约")?;
        let worktree = PathBuf::from(&contract.working_directory);
        if !worktree.is_dir() {
            return Err("任务 worktree 不存在".to_string());
        }
        ensure_expected_artifacts(&contract, &worktree)?;
        ensure_task_branch_clean(&worktree)?;
        let commands = project
            .quality_gate
            .commands
            .iter()
            .chain(task.acceptance_commands.iter())
            .cloned()
            .collect::<Vec<_>>();
        let mut results = Vec::new();
        for command in commands {
            let result = run_shell_command(&worktree, &command)?;
            let failed = result.exit_code != 0;
            results.push(result);
            if failed {
                task.state = "rework".to_string();
                task.updated_at = chrono::Utc::now().to_rfc3339();
                Self::save(TASK_NODES_DIR, &task.id, &task)?;
                let gate = Self::save_review_gate(AiReviewGate {
                    id: Uuid::new_v4().to_string(),
                    delivery_id: delivery.id.clone(),
                    task_node_id: task.id.clone(),
                    reviewer_agent_id: Some(reviewer.id.clone()),
                    state: "failed".to_string(),
                    comments: Some("质量门禁失败，任务已退回返工".to_string()),
                    command_results: results,
                    line_comments: Vec::new(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                    updated_at: chrono::Utc::now().to_rfc3339(),
                })?;
                Self::append_event(
                    &delivery.id,
                    Some(&task.id),
                    None,
                    "qualityGateFailed",
                    "质量门禁失败，任务已退回返工",
                )?;
                return Ok(gate);
            }
        }
        let reviewer_runtime =
            Self::get::<AiAgentRuntime>(RUNTIMES_DIR, &reviewer.runtime_id, "Reviewer Runtime")?;
        if !reviewer_runtime.enabled {
            return Err("Reviewer Runtime 已禁用".to_string());
        }
        let active_reviewer_attempts = Self::active_attempt_count_for_agent(&reviewer.id)?;
        if active_reviewer_attempts >= reviewer.max_concurrency as usize {
            return Err(format!(
                "Reviewer Agent 已达到并发上限（{}）",
                reviewer.max_concurrency
            ));
        }
        let reviewer_attempt_id = Uuid::new_v4().to_string();
        let reviewer_started_at = chrono::Utc::now().to_rfc3339();
        let reviewer_attempt = AiAttempt {
            id: reviewer_attempt_id.clone(),
            delivery_id: delivery.id.clone(),
            task_node_id: task.id.clone(),
            contract_id: contract.id.clone(),
            agent_id: reviewer.id.clone(),
            runtime_id: reviewer_runtime.id.clone(),
            terminal_id: None,
            state: "running".to_string(),
            started_at: reviewer_started_at.clone(),
            finished_at: None,
            exit_code: None,
            summary: Some("Reviewer 正在独立审查".to_string()),
            created_at: reviewer_started_at.clone(),
            updated_at: reviewer_started_at,
        };
        Self::persist_attempt(&reviewer_attempt)?;
        let review_result = run_reviewer_agent(
            &reviewer,
            &reviewer_runtime,
            &task,
            &contract,
            &worktree,
            &reviewer_attempt_id,
            &project,
            app.clone(),
            terminal_service,
        );
        let mut finished_reviewer_attempt =
            Self::get::<AiAttempt>(ATTEMPTS_DIR, &reviewer_attempt_id, "Reviewer 执行")?;
        finished_reviewer_attempt.finished_at = Some(chrono::Utc::now().to_rfc3339());
        finished_reviewer_attempt.updated_at = finished_reviewer_attempt
            .finished_at
            .clone()
            .unwrap_or_default();
        let review_comments = match review_result {
            Ok((comments, exit_code)) => {
                finished_reviewer_attempt.state = "completed".to_string();
                finished_reviewer_attempt.exit_code = Some(exit_code);
                finished_reviewer_attempt.summary = Some(comments.clone());
                comments
            }
            Err(error) => {
                finished_reviewer_attempt.state = "failed".to_string();
                finished_reviewer_attempt.summary = Some(error.clone());
                Self::save(
                    ATTEMPTS_DIR,
                    &finished_reviewer_attempt.id,
                    &finished_reviewer_attempt,
                )?;
                let _ = Self::append_event(
                    &delivery.id,
                    Some(&task.id),
                    Some(&reviewer_attempt_id),
                    "reviewerFailed",
                    &error,
                )?;
                return Err(error);
            }
        };
        Self::save(
            ATTEMPTS_DIR,
            &finished_reviewer_attempt.id,
            &finished_reviewer_attempt,
        )?;
        let _ = Self::append_event(
            &delivery.id,
            Some(&task.id),
            Some(&reviewer_attempt_id),
            "reviewerCompleted",
            "Reviewer Agent 已完成独立审查",
        )?;
        let now = chrono::Utc::now().to_rfc3339();
        let gate = Self::save_review_gate(AiReviewGate {
            id: Uuid::new_v4().to_string(),
            delivery_id: delivery.id.clone(),
            task_node_id: task.id.clone(),
            reviewer_agent_id: Some(reviewer.id),
            state: "awaitingReviewer".to_string(),
            comments: Some(review_comments),
            command_results: results,
            line_comments: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        })?;
        task.state = "awaitingReview".to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        Self::append_event(
            &delivery.id,
            Some(&task.id),
            None,
            "qualityGatePassed",
            "质量门禁通过，等待独立 Reviewer 审核",
        )?;
        Ok(gate)
    }

    pub fn resolve_review_gate(
        id: &str,
        approved: bool,
        comments: String,
    ) -> Result<AiReviewGate, String> {
        let mut gate = Self::get::<AiReviewGate>(REVIEW_GATES_DIR, id, "审核门")?;
        if gate.state != "awaitingReviewer" {
            return Err(format!("当前审核门不能处理: {}", gate.state));
        }
        let mut task = Self::get_task_node(&gate.task_node_id)?;
        gate.state = if approved { "approved" } else { "rework" }.to_string();
        gate.comments = Some(comments.trim().to_string()).filter(|value| !value.is_empty());
        gate.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(REVIEW_GATES_DIR, &gate.id, &gate)?;
        task.state = if approved { "succeeded" } else { "rework" }.to_string();
        task.updated_at = chrono::Utc::now().to_rfc3339();
        Self::save(TASK_NODES_DIR, &task.id, &task)?;
        let message = if approved {
            "独立审核已通过"
        } else {
            "独立审核要求返工"
        };
        Self::append_event(
            &gate.delivery_id,
            Some(&task.id),
            None,
            if approved {
                "reviewApproved"
            } else {
                "reviewRework"
            },
            message,
        )?;
        if approved {
            let _ = Self::refresh_ready_task_nodes(&gate.delivery_id)?;
            let _ = Self::try_complete_workflow_delivery(&gate.delivery_id)?;
        }
        Ok(gate)
    }

    pub(crate) fn save_review_gate(mut gate: AiReviewGate) -> Result<AiReviewGate, String> {
        if gate.created_at.is_empty() {
            gate.created_at = chrono::Utc::now().to_rfc3339();
        }
        if gate.updated_at.is_empty() {
            gate.updated_at = gate.created_at.clone();
        }
        Self::save(REVIEW_GATES_DIR, &gate.id, &gate)?;
        Ok(gate)
    }


    pub fn generate_quality_gate_commands(
        workspace_root: &str,
        runtime_id: Option<&str>,
        agent_id: Option<&str>,
    ) -> Result<AiQualityGate, String> {
        let workspace_root = canonical_directory(workspace_root)?;
        let contexts = scan_repository_quality_contexts(&workspace_root)?;
        if contexts.is_empty() {
            return Err("工作区中未发现 Git 仓库，无法生成质量门禁命令".to_string());
        }
        let runtime =
            if let Some(runtime_id) = runtime_id.filter(|id| !id.trim().is_empty()) {
                let runtime = Self::get::<AiAgentRuntime>(RUNTIMES_DIR, runtime_id, "Runtime")?;
                if !runtime.enabled {
                    return Err("所选 Runtime 已禁用".to_string());
                }
                runtime
            } else if let Some(agent_id) = agent_id.filter(|id| !id.trim().is_empty()) {
                let agent = Self::get::<AiAgent>(AGENTS_DIR, agent_id, "管理者 Agent")?;
                if !agent.enabled {
                    return Err("项目关联的管理者 Agent 已禁用".to_string());
                }
                let runtime = Self::get::<AiAgentRuntime>(
                    RUNTIMES_DIR,
                    &agent.runtime_id,
                    "管理者 Runtime",
                )?;
                if !runtime.enabled {
                    return Err("项目关联的管理者 Runtime 已禁用".to_string());
                }
                runtime
            } else {
                Self::get_all_runtimes()?
                    .into_iter()
                    .find(|r| r.enabled)
                    .ok_or_else(|| {
                        "未找到可用的 Runtime，请先在 AI 交付设置中启用一个 Runtime"
                            .to_string()
                    })?
            };
        generate_quality_gate_with_runtime(&runtime, &workspace_root, &contexts)
    }

   pub fn delete_project(id: &str) -> Result<(), String> {
       let project = Self::get_project(id)?;
        let contracts = Self::get_all_task_contracts(Some(id))?;
        if contracts
            .iter()
            .any(|contract| !matches!(contract.state.as_str(), "completed" | "cancelled"))
        {
            return Err("项目仍有未完成的任务契约，无法删除".to_string());
        }

        let deliveries = Self::get_all_deliveries(Some(id))?;
        let delivery_ids = deliveries
            .iter()
            .map(|delivery| delivery.id.as_str())
            .collect::<HashSet<_>>();
        let attempts = Self::get_all_attempts(None)?
            .into_iter()
            .filter(|attempt| delivery_ids.contains(attempt.delivery_id.as_str()))
            .collect::<Vec<_>>();
        if attempts
            .iter()
            .any(|attempt| matches!(attempt.state.as_str(), "queued" | "starting" | "running"))
        {
            return Err("项目仍有正在运行的 Agent，无法删除".to_string());
        }

       // 项目删除时清理本应用创建的 worktree、Git 分支和产出物目录，避免资源泄漏。
       for delivery in &deliveries {
           cleanup_delivery_task_worktrees(&project, delivery);
           let _ = cleanup_delivery_integration_workspace(&project, delivery);
           for task in Self::get_task_nodes(&delivery.id)? {
                Self::delete(TASK_NODES_DIR, &task.id, "任务节点")?;
            }
            for attempt in attempts
                .iter()
                .filter(|attempt| attempt.delivery_id == delivery.id)
            {
                Self::delete(ATTEMPTS_DIR, &attempt.id, "执行尝试")?;
                let terminal_run_dir = terminal_run_dir_by_id(&attempt.id);
                let _ = fs::remove_dir_all(terminal_run_dir);
            }
            for gate in Self::get_review_gates(Some(&delivery.id))? {
                Self::delete(REVIEW_GATES_DIR, &gate.id, "审核门禁")?;
            }
            for request in Self::get_decision_requests(Some(&delivery.id))? {
                Self::delete(DECISIONS_DIR, &request.id, "决策请求")?;
            }
            for event in Self::get_delivery_events(&delivery.id)? {
                Self::delete(EVENTS_DIR, &event.id, "交付事件")?;
            }
            for record in Self::get_merge_records(Some(&delivery.id))? {
                Self::delete(MERGE_RECORDS_DIR, &record.id, "合并记录")?;
            }
            let plan_directory = Self::entity_dir(PLANS_DIR).join(safe_path_segment(&delivery.id));
            let _ = fs::remove_dir_all(plan_directory);
            Self::delete(DELIVERIES_DIR, &delivery.id, "交付")?;
        }
        for contract in contracts {
            Self::delete(CONTRACTS_DIR, &contract.id, "任务契约")?;
        }
        Self::delete(PROJECTS_DIR, id, "AI 项目")
    }
}
