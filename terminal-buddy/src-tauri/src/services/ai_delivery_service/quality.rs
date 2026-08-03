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

