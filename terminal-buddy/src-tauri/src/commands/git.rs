use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryStatus {
    repo_root: String,
    branch: String,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    changed_count: u32,
    staged_count: u32,
    unstaged_count: u32,
    untracked_count: u32,
    has_remote: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    name: String,
    is_current: bool,
    is_remote: bool,
    upstream: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryRef {
    name: String,
    full_name: String,
    revision: String,
    kind: String,
    is_current: bool,
    is_upstream: bool,
    is_base: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryResult {
    commits: Vec<GitCommit>,
    refs: Vec<GitHistoryRef>,
    current_ref: Option<GitHistoryRef>,
    upstream_ref: Option<GitHistoryRef>,
    base_ref: Option<GitHistoryRef>,
    merge_base: Option<String>,
    ahead: u32,
    behind: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    hash: String,
    short_hash: String,
    parents: Vec<String>,
    refs: Vec<GitHistoryRef>,
    author: String,
    date: String,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPullResult {
    command: String,
    output: String,
    old_head: Option<String>,
    new_head: Option<String>,
    updated_commits: Vec<GitCommit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    command: String,
    output: String,
    remote: String,
    local_branch: String,
    remote_branch: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushOptions {
    path: String,
    remote: String,
    local_branch: String,
    remote_branch: String,
    set_upstream: bool,
    follow_tags: bool,
    force_with_lease: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    path: String,
    extension: String,
    status: String,
    additions: u32,
    deletions: u32,
    staged: bool,
    untracked: bool,
}

struct GitCommandOutput {
    stdout: String,
    stderr: String,
}

fn git_cwd(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if fs::metadata(&path).map(|meta| meta.is_file()).unwrap_or(false) {
        path.parent().map(Path::to_path_buf).unwrap_or(path)
    } else {
        path
    }
}

fn discover_git_root(path: &str) -> Option<PathBuf> {
    let mut cwd = git_cwd(path);

    loop {
        let marker = cwd.join(".git");
        if marker.is_dir() || marker.is_file() {
            return Some(cwd);
        }

        if !cwd.pop() {
            return None;
        }
    }
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    Ok(run_git_capture(cwd, args)?.stdout.trim().to_string())
}

fn run_git_capture(cwd: &Path, args: &[&str]) -> Result<GitCommandOutput, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("无法运行 git：{}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        Ok(GitCommandOutput { stdout, stderr })
    } else if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err(format!(
            "git {:?} 退出码 {}",
            args,
            output.status.code().unwrap_or(-1)
        ))
    }
}

fn combine_git_output(output: &GitCommandOutput) -> String {
    let mut parts = Vec::new();
    if !output.stdout.trim().is_empty() {
        parts.push(output.stdout.as_str());
    }
    if !output.stderr.trim().is_empty() {
        parts.push(output.stderr.as_str());
    }

    parts
        .join("\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn repo_root_for_path(path: &str) -> Result<Option<PathBuf>, String> {
    let Some(discovered_root) = discover_git_root(path) else {
        return Ok(None);
    };

    match run_git(&discovered_root, &["rev-parse", "--show-toplevel"]) {
        Ok(root) if !root.is_empty() => Ok(Some(PathBuf::from(root))),
        Ok(_) => Ok(Some(discovered_root)),
        Err(err) if err.starts_with("无法运行 git") => Err(err),
        Err(_) => Ok(Some(discovered_root)),
    }
}

fn require_repo_root(path: &str) -> Result<PathBuf, String> {
    repo_root_for_path(path)?.ok_or_else(|| "当前目录不是 Git 仓库".to_string())
}

async fn git_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("Git 后台任务失败：{}", e))?
}

fn current_branch(root: &Path) -> String {
    let branch = run_git(root, &["branch", "--show-current"]).unwrap_or_default();
    if !branch.is_empty() {
        return branch;
    }

    let short_hash = run_git(root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    if short_hash.is_empty() {
        "未提交".to_string()
    } else {
        format!("HEAD@{}", short_hash)
    }
}

fn head_hash(root: &Path) -> Option<String> {
    run_git(root, &["rev-parse", "--verify", "HEAD"])
        .ok()
        .filter(|value| !value.is_empty())
}

fn empty_git_history_result() -> GitHistoryResult {
    GitHistoryResult {
        commits: Vec::new(),
        refs: Vec::new(),
        current_ref: None,
        upstream_ref: None,
        base_ref: None,
        merge_base: None,
        ahead: 0,
        behind: 0,
    }
}

fn history_ref_kind(full_name: &str) -> &'static str {
    if full_name == "HEAD" {
        "head"
    } else if full_name.starts_with("refs/remotes/") {
        "remote"
    } else if full_name.starts_with("refs/tags/") {
        "tag"
    } else if full_name == "MERGE_BASE" {
        "base"
    } else {
        "local"
    }
}

fn decorated_ref_to_history_ref(revision: &str, raw_ref: &str) -> Option<GitHistoryRef> {
    let trimmed = raw_ref.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (name, full_name, is_current) = if let Some(branch) = trimmed.strip_prefix("HEAD -> ") {
        (
            branch.trim().to_string(),
            format!("refs/heads/{}", branch.trim()),
            true,
        )
    } else if let Some(tag) = trimmed.strip_prefix("tag: ") {
        (
            tag.trim().to_string(),
            format!("refs/tags/{}", tag.trim()),
            false,
        )
    } else if trimmed == "HEAD" {
        ("HEAD".to_string(), "HEAD".to_string(), true)
    } else if trimmed.contains('/') {
        (
            trimmed.to_string(),
            format!("refs/remotes/{}", trimmed),
            false,
        )
    } else {
        (
            trimmed.to_string(),
            format!("refs/heads/{}", trimmed),
            false,
        )
    };

    Some(GitHistoryRef {
        kind: history_ref_kind(&full_name).to_string(),
        name,
        full_name,
        revision: revision.to_string(),
        is_current,
        is_upstream: false,
        is_base: false,
    })
}

fn parse_decorated_refs(revision: &str, decorations: &str) -> Vec<GitHistoryRef> {
    decorations
        .split(',')
        .filter_map(|raw_ref| decorated_ref_to_history_ref(revision, raw_ref))
        .collect()
}

fn parse_history_refs(
    output: &str,
    current_branch: Option<&str>,
    upstream_short: Option<&str>,
) -> Vec<GitHistoryRef> {
    let current_full_name = current_branch.map(|branch| format!("refs/heads/{}", branch));
    let upstream_full_name = upstream_short.map(|upstream| format!("refs/remotes/{}", upstream));

    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let full_name = parts.next()?.trim();
            let name = parts.next()?.trim();
            let object_name = parts.next()?.trim();
            let peeled_object_name = parts.next().unwrap_or("").trim();
            let revision = if full_name.starts_with("refs/tags/") && !peeled_object_name.is_empty() {
                peeled_object_name
            } else {
                object_name
            };

            if full_name.is_empty() || name.is_empty() || revision.is_empty() {
                return None;
            }

            Some(GitHistoryRef {
                name: name.to_string(),
                full_name: full_name.to_string(),
                revision: revision.to_string(),
                kind: history_ref_kind(full_name).to_string(),
                is_current: current_full_name
                    .as_deref()
                    .is_some_and(|value| value == full_name),
                is_upstream: upstream_short.is_some_and(|value| value == name)
                    || upstream_full_name
                        .as_deref()
                        .is_some_and(|value| value == full_name),
                is_base: false,
            })
        })
        .collect()
}

fn refs_by_revision(refs: &[GitHistoryRef]) -> HashMap<String, Vec<GitHistoryRef>> {
    let mut grouped: HashMap<String, Vec<GitHistoryRef>> = HashMap::new();
    for git_ref in refs {
        grouped
            .entry(git_ref.revision.clone())
            .or_default()
            .push(git_ref.clone());
    }
    grouped
}

fn parse_history_commits(
    output: &str,
    refs_by_revision: &HashMap<String, Vec<GitHistoryRef>>,
) -> Vec<GitCommit> {
    output
        .split('\x1e')
        .filter_map(|record| {
            let record = record.trim();
            if record.is_empty() {
                return None;
            }

            let mut parts = record.split('\x1f');
            let hash = parts.next()?.to_string();
            let short_hash = parts.next()?.to_string();
            let parents = parts
                .next()
                .unwrap_or("")
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>();

            Some(GitCommit {
                refs: refs_by_revision.get(&hash).cloned().unwrap_or_default(),
                hash,
                short_hash,
                parents,
                author: parts.next()?.to_string(),
                date: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
            })
        })
        .collect()
}

fn find_history_ref(
    refs: &[GitHistoryRef],
    revision: &str,
    full_name: Option<&str>,
    short_name: Option<&str>,
) -> Option<GitHistoryRef> {
    refs.iter()
        .find(|git_ref| {
            git_ref.revision == revision
                && (full_name.is_some_and(|value| value == git_ref.full_name)
                    || short_name.is_some_and(|value| value == git_ref.name))
        })
        .cloned()
}

fn push_ref_if_missing(refs: &mut Vec<GitHistoryRef>, candidate: &GitHistoryRef) {
    let exists = refs.iter().any(|git_ref| {
        git_ref.full_name == candidate.full_name && git_ref.revision == candidate.revision
    });
    if !exists {
        refs.push(candidate.clone());
    }
}

fn parse_commits(output: &str) -> Vec<GitCommit> {
    output
        .split('\x1e')
        .filter_map(|record| {
            let record = record.trim();
            if record.is_empty() {
                return None;
            }

            let mut parts = record.split('\x1f');
            let hash = parts.next()?.to_string();
            let short_hash = parts.next()?.to_string();
            let parents = parts
                .next()
                .unwrap_or("")
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>();
            let refs = parse_decorated_refs(&hash, parts.next().unwrap_or(""));

            Some(GitCommit {
                hash,
                short_hash,
                parents,
                refs,
                author: parts.next()?.to_string(),
                date: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
            })
        })
        .collect()
}

fn file_extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default()
}

fn status_label(x: char, y: char, untracked: bool) -> String {
    if untracked {
        return "未版本控制".to_string();
    }
    if x == 'U' || y == 'U' {
        return "冲突".to_string();
    }
    if x == 'A' || y == 'A' {
        return "已添加".to_string();
    }
    if x == 'D' || y == 'D' {
        return "已删除".to_string();
    }
    if x == 'R' || y == 'R' {
        return "已重命名".to_string();
    }
    if x == 'C' || y == 'C' {
        return "已复制".to_string();
    }
    if x == 'M' || y == 'M' {
        return "已修改".to_string();
    }

    "已更改".to_string()
}

fn numstat_map(root: &Path) -> HashSet<(String, u32, u32)> {
    run_git(root, &["diff", "--numstat", "HEAD", "--"])
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let additions = parts.next()?.parse().ok().unwrap_or(0);
            let deletions = parts.next()?.parse().ok().unwrap_or(0);
            let path = parts.next()?.to_string();
            Some((path, additions, deletions))
        })
        .collect()
}

fn lookup_numstat(stats: &HashSet<(String, u32, u32)>, path: &str) -> (u32, u32) {
    stats
        .iter()
        .find(|(stat_path, _, _)| stat_path == path)
        .map(|(_, additions, deletions)| (*additions, *deletions))
        .unwrap_or((0, 0))
}

fn path_to_git_pathspec(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn normalize_git_pathspec_value(value: String) -> String {
    let normalized = value.replace('\\', "/");
    let mut value = normalized.trim();
    while let Some(stripped) = value.strip_prefix("./") {
        value = stripped;
    }
    value.trim_matches('/').to_string()
}

fn push_pathspec_candidate(
    candidates: &mut Vec<String>,
    seen: &mut HashSet<String>,
    candidate: String,
) {
    let normalized = normalize_git_pathspec_value(candidate);
    if !normalized.is_empty() && seen.insert(normalized.clone()) {
        candidates.push(normalized);
    }
}

fn strip_leading_path_component(path: &str, component_name: &str) -> Option<String> {
    let mut components = Path::new(path).components();
    let first = components.next()?;
    if !first
        .as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(component_name)
    {
        return None;
    }

    let mut stripped = PathBuf::new();
    for component in components {
        stripped.push(component.as_os_str());
    }

    let value = path_to_git_pathspec(&stripped);
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn repair_truncated_leading_component(path: &str, component_name: &str) -> Option<String> {
    let normalized = normalize_git_pathspec_value(path.to_string());
    let (first, rest) = normalized
        .split_once('/')
        .map(|(first, rest)| (first, Some(rest)))
        .unwrap_or((normalized.as_str(), None));
    let component_tail = component_name
        .char_indices()
        .nth(1)
        .map(|(index, _)| &component_name[index..])
        .unwrap_or("");

    if component_tail.is_empty() || !first.eq_ignore_ascii_case(component_tail) {
        return None;
    }

    Some(match rest {
        Some(rest) if !rest.is_empty() => format!("{}/{}", component_name, rest),
        _ => component_name.to_string(),
    })
}

fn git_pathspec_matches(root: &Path, candidate: &str) -> bool {
    let candidate_path = Path::new(candidate);
    let filesystem_path = if candidate_path.is_absolute() {
        candidate_path.to_path_buf()
    } else {
        root.join(candidate_path)
    };

    filesystem_path.exists()
        || run_git(root, &["ls-files", "--error-unmatch", "--", candidate]).is_ok()
}

fn push_base_relative_pathspec_candidate(
    candidates: &mut Vec<String>,
    seen: &mut HashSet<String>,
    root: &Path,
    base: &Path,
    raw_path: &str,
) {
    let input_path = PathBuf::from(raw_path);
    if input_path.is_absolute() {
        return;
    }

    let absolute_from_base = base.join(&input_path);
    if let Ok(stripped) = absolute_from_base.strip_prefix(root) {
        push_pathspec_candidate(candidates, seen, path_to_git_pathspec(stripped));
    }
}

fn normalize_commit_pathspec(root: &Path, base: &Path, raw_path: &str) -> Result<String, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("提交路径不能为空".to_string());
    }

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let input_path = PathBuf::from(trimmed);

    if input_path.is_absolute() {
        if let Ok(stripped) = input_path.strip_prefix(root) {
            push_pathspec_candidate(
                &mut candidates,
                &mut seen,
                path_to_git_pathspec(stripped),
            );
        }
        push_pathspec_candidate(
            &mut candidates,
            &mut seen,
            path_to_git_pathspec(&input_path),
        );
    } else {
        push_pathspec_candidate(&mut candidates, &mut seen, trimmed.to_string());
        push_base_relative_pathspec_candidate(
            &mut candidates,
            &mut seen,
            root,
            base,
            trimmed,
        );
    }

    if let Some(root_name) = root.file_name().and_then(|value| value.to_str()) {
        let existing = candidates.clone();
        for candidate in existing {
            if let Some(repaired) = repair_truncated_leading_component(&candidate, root_name) {
                push_pathspec_candidate(&mut candidates, &mut seen, repaired.clone());
                if let Some(stripped) = strip_leading_path_component(&repaired, root_name) {
                    push_pathspec_candidate(&mut candidates, &mut seen, stripped);
                }
            }
            if let Some(stripped) = strip_leading_path_component(&candidate, root_name) {
                push_pathspec_candidate(&mut candidates, &mut seen, stripped);
            }
        }
    }

    for candidate in &candidates {
        if git_pathspec_matches(root, candidate) {
            return Ok(candidate.clone());
        }
    }

    Ok(candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| trimmed.to_string()))
}

#[cfg(test)]
mod tests {
    use super::normalize_commit_pathspec;
    use std::path::{Path, PathBuf};
    use std::{env, fs, process};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempRepo {
        root: PathBuf,
        cleanup_root: PathBuf,
    }

    impl TempRepo {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let cleanup_root = env::temp_dir().join(format!(
                "terminal_buddy_git_test_{}_{}",
                process::id(),
                nanos
            ));
            let root = cleanup_root.join("terminal-buddy");
            fs::create_dir_all(&root).unwrap();
            Self { root, cleanup_root }
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.cleanup_root);
        }
    }

    fn write_file(root: &Path, relative_path: &str) {
        let path = root.join(relative_path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "").unwrap();
    }

    #[test]
    fn normalize_commit_pathspec_keeps_repo_relative_path() {
        let repo = TempRepo::new();
        let path = "terminal-buddy/src-tauri/src/commands/git.rs";
        write_file(&repo.root, path);

        let normalized = normalize_commit_pathspec(&repo.root, &repo.root, path).unwrap();

        assert_eq!(normalized, path);
    }

    #[test]
    fn normalize_commit_pathspec_converts_base_relative_path() {
        let repo = TempRepo::new();
        let repo_relative_path = "terminal-buddy/src-tauri/src/commands/git.rs";
        write_file(&repo.root, repo_relative_path);
        let base = repo.root.join("terminal-buddy");

        let normalized =
            normalize_commit_pathspec(&repo.root, &base, "src-tauri/src/commands/git.rs").unwrap();

        assert_eq!(normalized, repo_relative_path);
    }

    #[test]
    fn normalize_commit_pathspec_repairs_truncated_root_named_component() {
        let repo = TempRepo::new();
        let repo_relative_path = "terminal-buddy/src-tauri/src/commands/git.rs";
        write_file(&repo.root, repo_relative_path);

        let normalized = normalize_commit_pathspec(
            &repo.root,
            &repo.root,
            "erminal-buddy/src-tauri/src/commands/git.rs",
        )
        .unwrap();

        assert_eq!(normalized, repo_relative_path);
    }

    #[test]
    fn normalize_commit_pathspec_strips_extra_root_component_for_inner_root() {
        let repo = TempRepo::new();
        let inner_root = repo.root.join("terminal-buddy");
        let inner_relative_path = "src-tauri/src/commands/git.rs";
        write_file(&inner_root, inner_relative_path);

        let normalized = normalize_commit_pathspec(
            &inner_root,
            &inner_root,
            "terminal-buddy/src-tauri/src/commands/git.rs",
        )
        .unwrap();

        assert_eq!(normalized, inner_relative_path);
    }
}

fn git_log_commits(root: &Path, args: &[&str]) -> Result<Vec<GitCommit>, String> {
    let output = run_git(root, args)?;
    Ok(parse_commits(&output))
}

fn parse_ahead_behind(root: &Path, upstream: Option<&str>) -> (u32, u32) {
    if upstream.is_none() {
        return (0, 0);
    }

    let counts = run_git(root, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
        .unwrap_or_default();
    let mut parts = counts.split_whitespace();
    let ahead = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn parse_status_counts(porcelain: &str) -> (u32, u32, u32, u32) {
    let mut changed = 0;
    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;

    for line in porcelain.lines().filter(|line| !line.trim().is_empty()) {
        changed += 1;
        if line.starts_with("??") {
            untracked += 1;
            continue;
        }

        let bytes = line.as_bytes();
        if bytes.first().is_some_and(|c| *c != b' ') {
            staged += 1;
        }
        if bytes.get(1).is_some_and(|c| *c != b' ') {
            unstaged += 1;
        }
    }

    (changed, staged, unstaged, untracked)
}

#[command]
pub async fn get_git_repository_status(path: String) -> Result<Option<GitRepositoryStatus>, String> {
    git_task(move || get_git_repository_status_impl(path)).await
}

fn get_git_repository_status_impl(path: String) -> Result<Option<GitRepositoryStatus>, String> {
    let Some(root) = repo_root_for_path(&path)? else {
        return Ok(None);
    };

    let branch = current_branch(&root);
    let upstream = run_git(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        .ok()
        .filter(|value| !value.is_empty());
    let (ahead, behind) = parse_ahead_behind(&root, upstream.as_deref());
    let porcelain = run_git(&root, &["status", "--porcelain=v1"]).unwrap_or_default();
    let (changed_count, staged_count, unstaged_count, untracked_count) =
        parse_status_counts(&porcelain);
    let has_remote = run_git(&root, &["remote"])
        .map(|output| !output.trim().is_empty())
        .unwrap_or(false);

    Ok(Some(GitRepositoryStatus {
        repo_root: root.to_string_lossy().to_string(),
        branch,
        upstream,
        ahead,
        behind,
        changed_count,
        staged_count,
        unstaged_count,
        untracked_count,
        has_remote,
    }))
}

#[command]
pub async fn git_list_branches(path: String) -> Result<Vec<GitBranch>, String> {
    git_task(move || git_list_branches_impl(path)).await
}

fn git_list_branches_impl(path: String) -> Result<Vec<GitBranch>, String> {
    let root = require_repo_root(&path)?;
    let local_output = run_git(
        &root,
        &["branch", "--format=%(HEAD)\t%(refname:short)\t%(upstream:short)"],
    )?;
    let remote_output =
        run_git(&root, &["branch", "-r", "--format=%(refname:short)"]).unwrap_or_default();

    let mut branches = Vec::new();
    let mut local_names = HashSet::new();

    for line in local_output.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        let name = parts.get(1).map(|value| value.trim()).unwrap_or("");
        if name.is_empty() {
            continue;
        }

        local_names.insert(name.to_string());
        branches.push(GitBranch {
            name: name.to_string(),
            is_current: parts.first().is_some_and(|value| value.trim() == "*"),
            is_remote: false,
            upstream: parts
                .get(2)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        });
    }

    for line in remote_output.lines() {
        let name = line.trim();
        if name.is_empty() || name.ends_with("/HEAD") || name.contains(" -> ") {
            continue;
        }
        if local_names.contains(name) {
            continue;
        }

        branches.push(GitBranch {
            name: name.to_string(),
            is_current: false,
            is_remote: true,
            upstream: None,
        });
    }

    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(a.is_remote.cmp(&b.is_remote))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(branches)
}

#[command]
pub async fn git_checkout_branch(path: String, branch: String) -> Result<String, String> {
    git_task(move || git_checkout_branch_impl(path, branch)).await
}

fn git_checkout_branch_impl(path: String, branch: String) -> Result<String, String> {
    let root = require_repo_root(&path)?;
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("分支名不能为空".to_string());
    }

    let remote_output =
        run_git(&root, &["branch", "-r", "--format=%(refname:short)"]).unwrap_or_default();
    let is_remote = remote_output.lines().any(|line| line.trim() == branch);

    if is_remote {
        let local_name = branch
            .split_once('/')
            .map(|(_, name)| name)
            .unwrap_or(branch);
        let local_ref = format!("refs/heads/{}", local_name);
        if run_git(&root, &["show-ref", "--verify", "--quiet", &local_ref]).is_ok() {
            run_git(&root, &["switch", local_name])
        } else {
            run_git(&root, &["switch", "--track", branch])
        }
    } else {
        run_git(&root, &["switch", branch])
    }
}

#[command]
pub async fn git_pull(path: String) -> Result<GitPullResult, String> {
    git_task(move || git_pull_impl(path)).await
}

fn git_pull_impl(path: String) -> Result<GitPullResult, String> {
    let root = require_repo_root(&path)?;
    let old_head = head_hash(&root);
    let command = "git.exe pull -v --progress".to_string();
    let output = run_git_capture(&root, &["pull", "-v", "--progress"])?;
    let new_head = head_hash(&root);
    let updated_commits = match (old_head.as_deref(), new_head.as_deref()) {
        (Some(old), Some(new)) if old != new => {
            let range = format!("{}..{}", old, new);
            git_log_commits(
                &root,
                &[
                    "log",
                    "--date=short",
                    "--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ad%x1f%s%x1e",
                    &range,
                ],
            )
            .unwrap_or_default()
        }
        _ => Vec::new(),
    };

    Ok(GitPullResult {
        command,
        output: combine_git_output(&output),
        old_head,
        new_head,
        updated_commits,
    })
}

#[command]
pub async fn git_push(path: String) -> Result<String, String> {
    git_task(move || git_push_impl(path)).await
}

fn git_push_impl(path: String) -> Result<String, String> {
    let root = require_repo_root(&path)?;
    run_git(&root, &["push"])
}

#[command]
pub async fn git_push_with_options(options: GitPushOptions) -> Result<GitPushResult, String> {
    git_task(move || git_push_with_options_impl(options)).await
}

fn git_push_with_options_impl(options: GitPushOptions) -> Result<GitPushResult, String> {
    let root = require_repo_root(&options.path)?;

    let remote = options.remote.trim();
    if remote.is_empty() {
        return Err("未配置远端仓库".to_string());
    }

    let local_branch = options.local_branch.trim();
    let remote_branch = options.remote_branch.trim();
    if local_branch.is_empty() || remote_branch.is_empty() {
        return Err("分支名称不能为空".to_string());
    }

    // 始终用 Vec 参数调用 git，绝不拼 shell 字符串执行。
    let mut args: Vec<String> = vec![
        "push".to_string(),
        "-v".to_string(),
        "--progress".to_string(),
    ];
    if options.set_upstream {
        args.push("-u".to_string());
    }
    if options.follow_tags {
        args.push("--follow-tags".to_string());
    }
    if options.force_with_lease {
        // 强制推送只用 --force-with-lease，禁止 --force。
        args.push("--force-with-lease".to_string());
    }
    args.push(remote.to_string());
    args.push(format!("{}:{}", local_branch, remote_branch));

    let command = format!("git.exe {}", args.join(" "));
    let arg_refs: Vec<&str> = args.iter().map(|value| value.as_str()).collect();
    let output = run_git_capture(&root, &arg_refs)?;

    Ok(GitPushResult {
        command,
        output: combine_git_output(&output),
        remote: remote.to_string(),
        local_branch: local_branch.to_string(),
        remote_branch: remote_branch.to_string(),
    })
}

#[command]
pub async fn git_commit_all(path: String, message: String) -> Result<String, String> {
    git_task(move || git_commit_all_impl(path, message)).await
}

fn git_commit_all_impl(path: String, message: String) -> Result<String, String> {
    let root = require_repo_root(&path)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("提交说明不能为空".to_string());
    }

    run_git(&root, &["add", "-A"])?;
    run_git(&root, &["commit", "-m", message])
}

#[command]
pub async fn git_get_changed_files(path: String) -> Result<Vec<GitChangedFile>, String> {
    git_task(move || git_get_changed_files_impl(path)).await
}

fn git_get_changed_files_impl(path: String) -> Result<Vec<GitChangedFile>, String> {
    let root = require_repo_root(&path)?;
    let status_output = run_git(&root, &["status", "--porcelain=v1"])?;
    let stats = numstat_map(&root);

    let mut files = status_output
        .lines()
        .filter_map(|line| {
            if line.len() < 3 {
                return None;
            }

            let mut chars = line.chars();
            let x = chars.next().unwrap_or(' ');
            let y = chars.next().unwrap_or(' ');
            let untracked = x == '?' && y == '?';
            let raw_path = line[3..].trim();
            let path = raw_path
                .split(" -> ")
                .last()
                .unwrap_or(raw_path)
                .trim()
                .to_string();
            let (additions, deletions) = lookup_numstat(&stats, &path);

            Some(GitChangedFile {
                extension: file_extension(&path),
                status: status_label(x, y, untracked),
                additions,
                deletions,
                staged: x != ' ' && x != '?',
                untracked,
                path,
            })
        })
        .collect::<Vec<_>>();

    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(files)
}

#[command]
pub async fn git_commit_paths(
    path: String,
    message: String,
    paths: Vec<String>,
) -> Result<String, String> {
    git_task(move || git_commit_paths_impl(path, message, paths)).await
}

fn git_commit_paths_impl(
    path: String,
    message: String,
    paths: Vec<String>,
) -> Result<String, String> {
    let base = git_cwd(&path);
    let root = require_repo_root(&path)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("提交说明不能为空".to_string());
    }
    if paths.is_empty() {
        return Err("请至少选择一个文件".to_string());
    }

    let normalized_paths = paths
        .iter()
        .map(|path| normalize_commit_pathspec(&root, &base, path))
        .collect::<Result<Vec<_>, _>>()?;

    let mut add_args = vec!["add", "--"];
    for path in &normalized_paths {
        add_args.push(path.as_str());
    }
    run_git(&root, &add_args)?;
    run_git(&root, &["commit", "-m", message])
}

#[command]
pub async fn git_get_history(path: String, limit: Option<u32>) -> Result<GitHistoryResult, String> {
    git_task(move || git_get_history_impl(path, limit)).await
}

fn git_get_history_impl(path: String, limit: Option<u32>) -> Result<GitHistoryResult, String> {
    let root = require_repo_root(&path)?;
    let Some(head) = head_hash(&root) else {
        return Ok(empty_git_history_result());
    };

    let current_branch_name = run_git(&root, &["branch", "--show-current"])
        .ok()
        .filter(|value| !value.is_empty());
    let upstream_short = run_git(
        &root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )
    .ok()
    .filter(|value| !value.is_empty());
    let upstream_hash = if upstream_short.is_some() {
        run_git(&root, &["rev-parse", "--verify", "@{upstream}"])
            .ok()
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    let merge_base = if upstream_short.is_some() {
        run_git(&root, &["merge-base", "HEAD", "@{upstream}"])
            .ok()
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    let (ahead, behind) = parse_ahead_behind(&root, upstream_short.as_deref());

    let refs_output = run_git(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname)%x1f%(refname:short)%x1f%(objectname)%x1f%(*objectname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )
    .unwrap_or_default();
    let mut refs = parse_history_refs(
        &refs_output,
        current_branch_name.as_deref(),
        upstream_short.as_deref(),
    );

    let current_ref = if let Some(branch) = current_branch_name.as_deref() {
        let full_name = format!("refs/heads/{}", branch);
        find_history_ref(&refs, &head, Some(&full_name), Some(branch)).or_else(|| {
            Some(GitHistoryRef {
                name: branch.to_string(),
                full_name,
                revision: head.clone(),
                kind: "local".to_string(),
                is_current: true,
                is_upstream: false,
                is_base: false,
            })
        })
    } else {
        Some(GitHistoryRef {
            name: "HEAD".to_string(),
            full_name: "HEAD".to_string(),
            revision: head.clone(),
            kind: "head".to_string(),
            is_current: true,
            is_upstream: false,
            is_base: false,
        })
    };
    if let Some(git_ref) = current_ref.as_ref() {
        push_ref_if_missing(&mut refs, git_ref);
    }

    let upstream_ref = match (upstream_short.as_deref(), upstream_hash.as_deref()) {
        (Some(upstream), Some(revision)) => {
            let full_name = format!("refs/remotes/{}", upstream);
            find_history_ref(&refs, revision, Some(&full_name), Some(upstream)).or_else(|| {
                Some(GitHistoryRef {
                    name: upstream.to_string(),
                    full_name,
                    revision: revision.to_string(),
                    kind: "remote".to_string(),
                    is_current: false,
                    is_upstream: true,
                    is_base: false,
                })
            })
        }
        _ => None,
    };
    if let Some(git_ref) = upstream_ref.as_ref() {
        push_ref_if_missing(&mut refs, git_ref);
    }

    let base_ref = merge_base.as_ref().map(|revision| GitHistoryRef {
        name: "base".to_string(),
        full_name: "MERGE_BASE".to_string(),
        revision: revision.clone(),
        kind: "base".to_string(),
        is_current: false,
        is_upstream: false,
        is_base: true,
    });
    if let Some(git_ref) = base_ref.as_ref() {
        push_ref_if_missing(&mut refs, git_ref);
    }

    let refs_by_revision = refs_by_revision(&refs);

    let limit_arg = format!("-n{}", limit.unwrap_or(200).clamp(1, 500));
    let output = run_git(
        &root,
        &[
            "log",
            "--all",
            "--topo-order",
            &limit_arg,
            "--date=relative",
            "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ar%x1f%s%x1e",
        ],
    )?;

    Ok(GitHistoryResult {
        commits: parse_history_commits(&output, &refs_by_revision),
        refs,
        current_ref,
        upstream_ref,
        base_ref,
        merge_base,
        ahead,
        behind,
    })
}
