//! git 输出解析层：历史图 refs/提交记录、status/numstat/diff、pathspec 归一化。
//! 与执行层（`super::git` 的 `run_git_*`）分离，纯解析函数可独立测试。

use super::git::{
    run_git, run_git_stdout_raw, EMPTY_TREE_REVISION, GitCommit, GitHistoryFile, GitHistoryRef,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

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

pub(crate) fn parse_history_refs(
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
            let revision = if full_name.starts_with("refs/tags/") && !peeled_object_name.is_empty()
            {
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

pub(crate) fn refs_by_revision(refs: &[GitHistoryRef]) -> HashMap<String, Vec<GitHistoryRef>> {
    let mut grouped: HashMap<String, Vec<GitHistoryRef>> = HashMap::new();
    for git_ref in refs {
        grouped
            .entry(git_ref.revision.clone())
            .or_default()
            .push(git_ref.clone());
    }
    grouped
}

pub(crate) fn find_history_ref(
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

pub(crate) fn push_ref_if_missing(refs: &mut Vec<GitHistoryRef>, candidate: &GitHistoryRef) {
    let exists = refs.iter().any(|git_ref| {
        git_ref.full_name == candidate.full_name && git_ref.revision == candidate.revision
    });
    if !exists {
        refs.push(candidate.clone());
    }
}

/// Mirrors VS Code's Graph "Auto" filter. Only the current revision, its
/// upstream and a configured branch base participate in the history walk.
/// Using `git log --all` here would pull unrelated refs into the topological
/// order and produce a different graph from VS Code for the same checkout.
pub(crate) fn history_log_revisions(
    head: &str,
    upstream_ref: Option<&GitHistoryRef>,
    base_ref: Option<&GitHistoryRef>,
) -> Vec<String> {
    let mut revisions = vec![head.to_string()];

    for git_ref in [upstream_ref, base_ref].into_iter().flatten() {
        if !git_ref.revision.is_empty()
            && !revisions
                .iter()
                .any(|revision| revision == &git_ref.revision)
        {
            revisions.push(git_ref.revision.clone());
        }
    }

    revisions
}

/// VS Code persists the selected branch base in this Git config key. It is
/// only a graph base when it differs from the current branch's upstream.
pub(crate) fn mark_configured_history_base_ref(
    root: &Path,
    current_branch: Option<&str>,
    upstream_ref: Option<&GitHistoryRef>,
    refs: &mut [GitHistoryRef],
) -> Option<GitHistoryRef> {
    let branch = current_branch?;
    let config_key = format!("branch.{}.vscode-merge-base", branch);
    let configured_ref = run_git(root, &["config", "--get", &config_key])
        .ok()
        .filter(|value| !value.is_empty())?;
    let full_name = run_git(
        root,
        &["rev-parse", "--symbolic-full-name", &configured_ref],
    )
    .ok()
    .filter(|value| value.starts_with("refs/remotes/"))?;

    if upstream_ref.is_some_and(|upstream| upstream.full_name == full_name) {
        return None;
    }

    let revision = run_git(root, &["rev-parse", "--verify", &configured_ref])
        .ok()
        .filter(|value| !value.is_empty())?;
    let base_ref = refs
        .iter_mut()
        .find(|git_ref| git_ref.full_name == full_name && git_ref.revision == revision)?;

    base_ref.kind = "base".to_string();
    base_ref.is_base = true;
    Some(base_ref.clone())
}

/// 解析 `git log --pretty=format:%H%x1f%h%x1f%P%x1f[%D]%x1f%an%x1f%ad%x1f%s%x1e` 输出。
/// 传 `refs_by_revision` 时按哈希查表取 refs（历史图场景，log 不带 %D 装饰）；
/// 传 `None` 时解析 %D 装饰字段（push/pull 场景）。
pub(crate) fn parse_commits(
    output: &str,
    refs_by_revision: Option<&HashMap<String, Vec<GitHistoryRef>>>,
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
            let refs = match refs_by_revision {
                Some(by_revision) => by_revision.get(&hash).cloned().unwrap_or_default(),
                None => parse_decorated_refs(&hash, parts.next().unwrap_or("")),
            };

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

pub(crate) fn file_extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct GitStatusEntry {
    pub(crate) x: char,
    pub(crate) y: char,
    pub(crate) path: String,
}

fn parse_git_status(output: &str) -> Vec<GitStatusEntry> {
    let mut records = output.split_terminator('\0');
    let mut entries = Vec::new();

    while let Some(record) = records.next() {
        let bytes = record.as_bytes();
        if bytes.len() < 3 || bytes[2] != b' ' {
            continue;
        }

        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = &record[3..];
        if path.is_empty() {
            continue;
        }

        entries.push(GitStatusEntry {
            x,
            y,
            path: path.to_string(),
        });

        // In porcelain -z output, rename/copy destinations precede a separate source record.
        if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            let _ = records.next();
        }
    }

    entries
}

pub(crate) fn git_status_entries(root: &Path) -> Result<Vec<GitStatusEntry>, String> {
    let output = run_git_stdout_raw(
        root,
        &["--no-optional-locks", "status", "--porcelain=v1", "-z"],
    )?;
    Ok(parse_git_status(&output))
}

pub(crate) fn status_label(x: char, y: char, untracked: bool) -> String {
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

pub(crate) fn numstat_map(root: &Path) -> HashSet<(String, u32, u32)> {
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

pub(crate) fn lookup_numstat(stats: &HashSet<(String, u32, u32)>, path: &str) -> (u32, u32) {
    stats
        .iter()
        .find(|(stat_path, _, _)| stat_path == path)
        .map(|(_, additions, deletions)| (*additions, *deletions))
        .unwrap_or((0, 0))
}

pub(crate) fn normalize_history_revision(revision: Option<String>) -> String {
    revision
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| EMPTY_TREE_REVISION.to_string())
}

pub(crate) fn history_status_code(raw_status: &str) -> String {
    raw_status
        .chars()
        .next()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "M".to_string())
}

pub(crate) fn history_status_label(status_code: &str) -> String {
    status_label(status_code.chars().next().unwrap_or('M'), ' ', false)
}

#[derive(Clone)]
pub(crate) struct GitHistoryNumstat {
    path: String,
    additions: u32,
    deletions: u32,
    binary: bool,
}

pub(crate) fn parse_history_numstats(output: &str) -> Vec<GitHistoryNumstat> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let additions_raw = parts.next()?.trim();
            let deletions_raw = parts.next()?.trim();
            let path = parts.collect::<Vec<_>>().join("\t").trim().to_string();
            if path.is_empty() {
                return None;
            }

            let binary = additions_raw == "-" || deletions_raw == "-";
            Some(GitHistoryNumstat {
                path,
                additions: additions_raw.parse().ok().unwrap_or(0),
                deletions: deletions_raw.parse().ok().unwrap_or(0),
                binary,
            })
        })
        .collect()
}

fn history_numstat_matches(stat_path: &str, path: &str, old_path: Option<&str>) -> bool {
    stat_path == path
        || old_path.is_some_and(|value| stat_path == value)
        || stat_path.ends_with(path)
        || old_path.is_some_and(|value| stat_path.ends_with(value))
        || stat_path.contains(path)
        || old_path.is_some_and(|value| stat_path.contains(value))
}

fn lookup_history_numstat(
    stats: &[GitHistoryNumstat],
    path: &str,
    old_path: Option<&str>,
) -> (u32, u32, bool) {
    stats
        .iter()
        .find(|stat| history_numstat_matches(&stat.path, path, old_path))
        .map(|stat| (stat.additions, stat.deletions, stat.binary))
        .unwrap_or((0, 0, false))
}

fn make_history_file(
    path: String,
    old_path: Option<String>,
    status_code: String,
    stats: &[GitHistoryNumstat],
) -> GitHistoryFile {
    let (additions, deletions, binary) = lookup_history_numstat(stats, &path, old_path.as_deref());

    GitHistoryFile {
        extension: file_extension(&path),
        status: history_status_label(&status_code),
        path,
        old_path,
        status_code,
        additions,
        deletions,
        binary,
    }
}

pub(crate) fn parse_history_files(
    name_status_output: &str,
    stats: &[GitHistoryNumstat],
) -> Vec<GitHistoryFile> {
    let tokens = name_status_output
        .split('\0')
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut index = 0;

    while index < tokens.len() {
        let raw_status = tokens[index].trim();
        index += 1;
        if raw_status.is_empty() {
            continue;
        }

        let status_code = history_status_code(raw_status);
        if status_code == "R" || status_code == "C" {
            if index + 1 >= tokens.len() {
                break;
            }

            let old_path = tokens[index].to_string();
            let path = tokens[index + 1].to_string();
            index += 2;
            files.push(make_history_file(path, Some(old_path), status_code, stats));
        } else {
            if index >= tokens.len() {
                break;
            }

            let path = tokens[index].to_string();
            index += 1;
            files.push(make_history_file(path, None, status_code, stats));
        }
    }

    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    files
}

pub(crate) fn git_show_revision_file(
    root: &Path,
    revision: &str,
    path: &str,
) -> Result<Option<String>, String> {
    if revision == EMPTY_TREE_REVISION {
        return Ok(None);
    }

    let spec = format!("{}:{}", revision, path);
    match run_git_stdout_raw(root, &["show", spec.as_str()]) {
        Ok(output) => Ok(Some(output)),
        Err(err)
            if err.contains("does not exist")
                || err.contains("exists on disk")
                || err.contains("Invalid object name")
                || err.contains("Path")
                || err.contains("not found") =>
        {
            Ok(None)
        }
        Err(err) => Err(err),
    }
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

pub(crate) fn normalize_commit_pathspec(root: &Path, base: &Path, raw_path: &str) -> Result<String, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("提交路径不能为空".to_string());
    }

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let input_path = PathBuf::from(trimmed);

    if input_path.is_absolute() {
        if let Ok(stripped) = input_path.strip_prefix(root) {
            push_pathspec_candidate(&mut candidates, &mut seen, path_to_git_pathspec(stripped));
        }
        push_pathspec_candidate(
            &mut candidates,
            &mut seen,
            path_to_git_pathspec(&input_path),
        );
    } else {
        push_pathspec_candidate(&mut candidates, &mut seen, trimmed.to_string());
        push_base_relative_pathspec_candidate(&mut candidates, &mut seen, root, base, trimmed);
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
    use super::{
        history_log_revisions, normalize_commit_pathspec, parse_git_status, GitHistoryRef,
    };
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};
    use std::{env, fs, process};

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

    fn history_ref(revision: &str) -> GitHistoryRef {
        GitHistoryRef {
            name: revision.to_string(),
            full_name: format!("refs/remotes/origin/{}", revision),
            revision: revision.to_string(),
            kind: "remote".to_string(),
            is_current: false,
            is_upstream: false,
            is_base: false,
        }
    }

    #[test]
    fn history_log_revisions_only_include_auto_filter_refs_once() {
        let upstream = history_ref("upstream");
        let duplicate_base = history_ref("upstream");
        let base = history_ref("base");

        assert_eq!(
            history_log_revisions("head", Some(&upstream), Some(&duplicate_base)),
            vec!["head", "upstream"]
        );
        assert_eq!(
            history_log_revisions("head", Some(&upstream), Some(&base)),
            vec!["head", "upstream", "base"]
        );
    }

    #[test]
    fn parse_git_status_preserves_first_unstaged_path() {
        let entries = parse_git_status(
            " M terminal-buddy/package-lock.json\0 M terminal-buddy/src-tauri/Cargo.toml\0",
        );

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].x, ' ');
        assert_eq!(entries[0].y, 'M');
        assert_eq!(entries[0].path, "terminal-buddy/package-lock.json");
        assert_eq!(entries[1].path, "terminal-buddy/src-tauri/Cargo.toml");
    }

    #[test]
    fn parse_git_status_uses_rename_destination_without_trimming_paths() {
        let entries = parse_git_status("R  new -> name.txt\0old name.txt\0??  leading-space.txt\0");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "new -> name.txt");
        assert_eq!(entries[1].path, " leading-space.txt");
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
