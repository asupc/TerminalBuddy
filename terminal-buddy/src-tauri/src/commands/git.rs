use crate::commands::git_parse::{
    ensure_not_option_like, ensure_revision_arg, file_extension, find_history_ref,
    git_show_revision_file, git_status_entries, history_log_revisions, history_status_code,
    history_status_label, local_branch_ref, lookup_numstat, mark_configured_history_base_ref,
    normalize_commit_pathspec, normalize_history_revision, numstat_map, parse_commits,
    parse_history_files, parse_history_numstats, parse_history_refs, push_ref_if_missing,
    push_refspec, refs_by_revision, remote_refs_prefix, remote_tracking_ref, revision_range,
    status_label, GitStatusEntry, END_OF_OPTIONS,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{command, Emitter};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(crate) const EMPTY_TREE_REVISION: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
static GIT_COMMANDS_STOPPED: AtomicBool = AtomicBool::new(false);

pub(crate) fn stop_git_commands() {
    GIT_COMMANDS_STOPPED.store(true, Ordering::Release);
}

pub(crate) fn resume_git_commands() {
    GIT_COMMANDS_STOPPED.store(false, Ordering::Release);
}

fn ensure_git_commands_allowed() -> Result<(), String> {
    if GIT_COMMANDS_STOPPED.load(Ordering::Acquire) {
        Err("系统正在退出，已取消 Git 操作".to_string())
    } else {
        Ok(())
    }
}

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
    pub(crate) name: String,
    pub(crate) full_name: String,
    pub(crate) revision: String,
    pub(crate) kind: String,
    pub(crate) is_current: bool,
    pub(crate) is_upstream: bool,
    pub(crate) is_base: bool,
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
    pub(crate) hash: String,
    pub(crate) short_hash: String,
    pub(crate) parents: Vec<String>,
    pub(crate) refs: Vec<GitHistoryRef>,
    pub(crate) author: String,
    pub(crate) date: String,
    pub(crate) subject: String,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    command: String,
    output: String,
    remote: String,
    local_branch: String,
    remote_branch: String,
    outgoing_commits: Vec<GitCommit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushPreview {
    command: String,
    remote: String,
    local_branch: String,
    remote_branch: String,
    target_ref: String,
    target_exists: bool,
    commits: Vec<GitCommit>,
    warning: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushOptions {
    path: String,
    remote: String,
    local_branch: String,
    remote_branch: String,
    set_upstream: bool,
    follow_tags: bool,
    force_with_lease: bool,
    operation_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitPushOutputEvent {
    operation_id: String,
    chunk: String,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryFile {
    pub(crate) path: String,
    pub(crate) old_path: Option<String>,
    pub(crate) extension: String,
    pub(crate) status: String,
    pub(crate) status_code: String,
    pub(crate) additions: u32,
    pub(crate) deletions: u32,
    pub(crate) binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryFileDiff {
    path: String,
    old_path: Option<String>,
    status: String,
    status_code: String,
    old_revision: String,
    new_revision: String,
    old_content: String,
    new_content: String,
    binary: bool,
}

struct GitCommandOutput {
    stdout: String,
    stderr: String,
}

fn git_cwd(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if fs::metadata(&path)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
    {
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

pub(crate) fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    Ok(run_git_capture(cwd, args)?.stdout.trim().to_string())
}

/// git 命令整体超时：网络 stall 时终止进程树，避免前端永久 pending。
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(300);

struct GitRunOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
    /// stdout/stderr 按到达序拼接，流式场景（push）最终展示文本
    combined: String,
}

/// git 子进程树的生命周期控制。
///
/// git 会派生 ssh / git-remote-https / credential helper 等后代进程，它们继承了
/// stdout/stderr 管道写端：只 kill 直接子进程，管道不会关闭，reader 线程就永远读不到
/// EOF。此前用 `taskkill /PID <pid> /T /F` 按 PID 杀树，而 PID 在子进程退出后会被系统
/// 复用——父进程先退出时 `/T` 会沿着已复用的 PID 找错对象，可能杀掉无关进程。
///
/// Windows 改用 Job Object：spawn 后立刻把子进程加入 job，`TerminateJobObject` 一次性
/// 结束整棵树，`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 保证 Drop 关闭句柄时残留后代也被
/// 回收（管道随之关闭，detach 的 reader 线程能退出）。已知固有窗口：spawn 到
/// AssignProcessToJobObject 之间派生的后代会逃出 job；消除它需要 CREATE_SUSPENDED +
/// 恢复主线程的额外机制，这里按可接受的残余风险处理。
struct GitProcessTree {
    #[cfg(windows)]
    job: Option<windows::Win32::Foundation::HANDLE>,
}

impl GitProcessTree {
    /// spawn 之后立即调用。失败（老系统、权限受限）时退化为 `child.kill()`。
    fn attach(child: &std::process::Child) -> Self {
        #[cfg(windows)]
        {
            use windows::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
                JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };

            let job = unsafe { CreateJobObjectW(None, None) }.ok();
            let Some(job) = job else {
                return Self { job: None };
            };

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }
            .is_ok();
            // Windows 8 起支持嵌套 job，子进程已在别的 job 里也能加入成功。
            let assigned = unsafe {
                AssignProcessToJobObject(
                    job,
                    windows::Win32::Foundation::HANDLE(child.as_raw_handle()),
                )
            }
            .is_ok();

            if configured && assigned {
                Self { job: Some(job) }
            } else {
                unsafe {
                    let _ = windows::Win32::Foundation::CloseHandle(job);
                }
                Self { job: None }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Self {}
        }
    }

    /// 终止整棵进程树。
    fn terminate(&self, child: &mut std::process::Child) {
        #[cfg(windows)]
        if let Some(job) = self.job {
            use windows::Win32::System::JobObjects::TerminateJobObject;
            if unsafe { TerminateJobObject(job, 1) }.is_ok() {
                return;
            }
        }
        let _ = child.kill();
    }
}

impl Drop for GitProcessTree {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            // KILL_ON_JOB_CLOSE：最后一个句柄关闭即回收所有仍存活的后代。
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
        }
    }
}

/// 进程输出块：stdout/stderr 共用一条通道，保留跨流到达序（push 流式展示依赖此顺序）。
enum GitChunk {
    Stdout(String),
    Stderr(String),
}

fn accept_git_chunk(
    chunk: GitChunk,
    stdout: &mut String,
    stderr: &mut String,
    combined: &mut String,
    on_chunk: &mut Option<&dyn Fn(&str)>,
) {
    let text = match &chunk {
        GitChunk::Stdout(text) => {
            stdout.push_str(text);
            text
        }
        GitChunk::Stderr(text) => {
            stderr.push_str(text);
            text
        }
    };
    combined.push_str(text);
    if let Some(callback) = on_chunk.as_deref() {
        callback(text);
    }
}

fn drain_git_channel(
    rx: &mpsc::Receiver<GitChunk>,
    stdout: &mut String,
    stderr: &mut String,
    combined: &mut String,
    on_chunk: &mut Option<&dyn Fn(&str)>,
) {
    while let Ok(chunk) = rx.try_recv() {
        accept_git_chunk(chunk, stdout, stderr, combined, on_chunk);
    }
}

/// reader 收尾等待的上限。git 已退出，剩下的只是把管道里的残留读完；超过这个时间说明
/// 还有后代进程握着管道写端。
const GIT_READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

enum GitDrainOutcome {
    /// 两个 reader 都结束（通道全部发送端已释放）。
    Completed,
    TimedOut,
    Cancelled,
}

/// 有上限地等待 reader 线程读完。
///
/// 不能用 `JoinHandle::join()`：git 主进程退出后，握着 stdout/stderr 写端的后代进程
/// （ssh、credential helper）会让 reader 阻塞在 read 上，join 就是无上限等待，请求线程
/// 随之永久挂住。父进程未克隆保留 `tx`（一份 clone 给 stdout、原件 move 给 stderr），
/// 所以 `Disconnected` 精确等价于「两个 reader 都退出了」。
fn drain_git_channel_until(
    rx: &mpsc::Receiver<GitChunk>,
    timeout: Duration,
    stdout: &mut String,
    stderr: &mut String,
    combined: &mut String,
    on_chunk: &mut Option<&dyn Fn(&str)>,
) -> GitDrainOutcome {
    let deadline = Instant::now() + timeout;
    loop {
        if GIT_COMMANDS_STOPPED.load(Ordering::Acquire) {
            return GitDrainOutcome::Cancelled;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return GitDrainOutcome::TimedOut;
        }
        // 单次等待封顶 100ms，保证退出开关能被及时轮询到。
        match rx.recv_timeout(remaining.min(Duration::from_millis(100))) {
            Ok(chunk) => accept_git_chunk(chunk, stdout, stderr, combined, on_chunk),
            Err(mpsc::RecvTimeoutError::Disconnected) => return GitDrainOutcome::Completed,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

/// 统一执行 git 命令：双流 reader 防管道满阻塞，整体超时（GIT_COMMAND_TIMEOUT）或
/// 系统退出开关置位（stop_git_commands）时终止进程树。`on_chunk` 非空时逐块转发
/// 输出事件（push 流式进度场景）。
fn run_git_process(
    cwd: &Path,
    args: &[&str],
    mut on_chunk: Option<&dyn Fn(&str)>,
) -> Result<GitRunOutput, String> {
    ensure_git_commands_allowed()?;
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("无法运行 git：{}", e))?;
    let process_tree = GitProcessTree::attach(&child);
    let (tx, rx) = mpsc::channel::<GitChunk>();
    if let Some(stdout) = child.stdout.take() {
        spawn_git_output_reader(stdout, tx.clone(), GitChunk::Stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_git_output_reader(stderr, tx, GitChunk::Stderr);
    }

    let started_at = Instant::now();
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut combined = String::new();
    let status = loop {
        drain_git_channel(&rx, &mut stdout, &mut stderr, &mut combined, &mut on_chunk);
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("读取 git 状态失败：{}", e))?
        {
            break status;
        }
        if GIT_COMMANDS_STOPPED.load(Ordering::Acquire)
            || started_at.elapsed() >= GIT_COMMAND_TIMEOUT
        {
            process_tree.terminate(&mut child);
            let _ = child.wait();
            return Err(if GIT_COMMANDS_STOPPED.load(Ordering::Acquire) {
                "系统正在退出，已取消 Git 操作".to_string()
            } else {
                format!(
                    "git {:?} 执行超时（{} 秒），已终止",
                    args,
                    GIT_COMMAND_TIMEOUT.as_secs()
                )
            });
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    // git 已退出，但后代进程可能还握着管道写端。等待有上限；超时/取消时终止整棵进程树
    // 并返回错误——此时输出必然是截断的，而调用方会去解析它，静默给出半截数据比明确
    // 报错更危险。
    match drain_git_channel_until(
        &rx,
        GIT_READER_DRAIN_TIMEOUT,
        &mut stdout,
        &mut stderr,
        &mut combined,
        &mut on_chunk,
    ) {
        GitDrainOutcome::Completed => {}
        GitDrainOutcome::Cancelled => {
            process_tree.terminate(&mut child);
            return Err("系统正在退出，已取消 Git 操作".to_string());
        }
        GitDrainOutcome::TimedOut => {
            process_tree.terminate(&mut child);
            return Err(format!(
                "git {:?} 已结束，但仍有子进程占用输出管道超过 {} 秒，输出不完整。\
                 已终止相关进程，请重试；若持续出现，请检查是否有 ssh 或凭据助手进程卡住。",
                args,
                GIT_READER_DRAIN_TIMEOUT.as_secs()
            ));
        }
    }

    Ok(GitRunOutput {
        status,
        stdout,
        stderr,
        combined,
    })
}

fn git_failure_error(args: &[&str], status: std::process::ExitStatus) -> String {
    format!("git {:?} 退出码 {}", args, status.code().unwrap_or(-1))
}

/// 统一失败分支：优先返回 stderr，其次 stdout，最后退出码。
fn git_output_error(output: &GitRunOutput, args: &[&str]) -> Result<(), String> {
    let stdout = output.stdout.trim().to_string();
    let stderr = output.stderr.trim().to_string();
    if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err(git_failure_error(args, output.status))
    }
}

fn run_git_capture(cwd: &Path, args: &[&str]) -> Result<GitCommandOutput, String> {
    let output = run_git_process(cwd, args, None)?;
    if !output.status.success() {
        git_output_error(&output, args)?;
    }
    Ok(GitCommandOutput {
        stdout: output.stdout.trim().to_string(),
        stderr: output.stderr.trim().to_string(),
    })
}

pub(crate) fn run_git_stdout_raw(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = run_git_process(cwd, args, None)?;
    if !output.status.success() {
        git_output_error(&output, args)?;
    }
    Ok(output.stdout)
}

fn combine_git_output(output: &GitCommandOutput) -> String {
    normalize_git_output(&[output.stdout.as_str(), output.stderr.as_str()])
}

fn normalize_git_output(parts: &[&str]) -> String {
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

fn emit_git_push_chunk(app: &tauri::AppHandle, operation_id: Option<&str>, chunk: &str) {
    let Some(operation_id) = operation_id else {
        return;
    };
    if chunk.is_empty() {
        return;
    }

    let _ = app.emit(
        "git_push_output",
        GitPushOutputEvent {
            operation_id: operation_id.to_string(),
            chunk: chunk.to_string(),
        },
    );
}

/// 读线程只负责把管道内容送进通道，不再返回 JoinHandle：收尾等待改由
/// `drain_git_channel_until` 通过通道断开来判定，避免无上限 join。
fn spawn_git_output_reader<R>(
    mut reader: R,
    tx: mpsc::Sender<GitChunk>,
    variant: fn(String) -> GitChunk,
) where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let chunk = String::from_utf8_lossy(&buffer[..size]).replace('\r', "\n");
                    let _ = tx.send(variant(chunk));
                }
                Err(_) => break,
            }
        }
    });
}

/// 流式执行结果转 push 输出：成功返回归一化全文，失败带完整输出或退出码。
fn git_push_run_output(output: GitRunOutput, args: &[&str]) -> Result<String, String> {
    let normalized = normalize_git_output(&[output.combined.as_str()]);
    if output.status.success() {
        Ok(normalized)
    } else if !normalized.is_empty() {
        Err(normalized)
    } else {
        Err(git_failure_error(args, output.status))
    }
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



fn git_log_commits<S: AsRef<str>>(root: &Path, args: &[S]) -> Result<Vec<GitCommit>, String> {
    let arg_refs = args.iter().map(|arg| arg.as_ref()).collect::<Vec<_>>();
    let output = run_git(root, &arg_refs)?;
    Ok(parse_commits(&output, None))
}

fn parse_ahead_behind(root: &Path, upstream: Option<&str>) -> (u32, u32) {
    if upstream.is_none() {
        return (0, 0);
    }

    let counts = run_git(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .unwrap_or_default();
    let mut parts = counts.split_whitespace();
    let ahead = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn parse_status_counts(entries: &[GitStatusEntry]) -> (u32, u32, u32, u32) {
    let mut changed = 0;
    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;

    for entry in entries {
        changed += 1;
        if entry.x == '?' && entry.y == '?' {
            untracked += 1;
            continue;
        }

        if entry.x != ' ' {
            staged += 1;
        }
        if entry.y != ' ' {
            unstaged += 1;
        }
    }

    (changed, staged, unstaged, untracked)
}

#[command]
pub async fn get_git_repository_status(
    path: String,
) -> Result<Option<GitRepositoryStatus>, String> {
    git_task(move || get_git_repository_status_impl(path)).await
}

fn get_git_repository_status_impl(path: String) -> Result<Option<GitRepositoryStatus>, String> {
    let Some(root) = repo_root_for_path(&path)? else {
        return Ok(None);
    };

    let branch = current_branch(&root);
    let upstream = upstream_short_name(&root);
    let (ahead, behind) = parse_ahead_behind(&root, upstream.as_deref());
    let status_entries = git_status_entries(&root).unwrap_or_default();
    let (changed_count, staged_count, unstaged_count, untracked_count) =
        parse_status_counts(&status_entries);
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
        &[
            "branch",
            "--format=%(HEAD)\t%(refname:short)\t%(upstream:short)",
        ],
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

    // `git switch` 只接受分支短名（给完整 ref 会报 `fatal: a branch is expected`），
    // 因此这里用 `--` 终止选项解析；实测 `--end-of-options` 与 switch 不兼容
    // （`fatal: only one reference expected`）。
    if is_remote {
        let local_name = branch
            .split_once('/')
            .map(|(_, name)| name)
            .unwrap_or(branch);
        let local_ref = local_branch_ref(local_name)?;
        if run_git(
            &root,
            &["show-ref", "--verify", "--quiet", END_OF_OPTIONS, &local_ref],
        )
        .is_ok()
        {
            run_git(&root, &["switch", "--", local_name])
        } else {
            run_git(&root, &["switch", "--track", "--", branch])
        }
    } else {
        run_git(&root, &["switch", "--", branch])
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
            // old/new 都是 head_hash 拿到的 SHA，仍走统一构造保证格式。
            let range = revision_range(old, new)?;
            git_log_commits(
                &root,
                &[
                    "log",
                    "--date=short",
                    "--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ad%x1f%s%x1e",
                    END_OF_OPTIONS,
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

fn normalize_push_options(options: &GitPushOptions) -> Result<(String, String, String), String> {
    let remote = options.remote.trim();
    if remote.is_empty() {
        return Err("未配置远端仓库".to_string());
    }

    let local_branch = options.local_branch.trim();
    let remote_branch = options.remote_branch.trim();
    if local_branch.is_empty() || remote_branch.is_empty() {
        return Err("分支名称不能为空".to_string());
    }

    Ok((
        remote.to_string(),
        local_branch.to_string(),
        remote_branch.to_string(),
    ))
}

fn build_push_args(
    options: &GitPushOptions,
    remote: &str,
    local_branch: &str,
    remote_branch: &str,
) -> Result<Vec<String>, String> {
    // refspec 两端都用完整 ref，再加 `--end-of-options`：否则 `--receive-pack=<prog>`
    // 这类选项形状的分支名会被 git 当成选项，直接执行本地程序。
    let refspec = push_refspec(local_branch, remote_branch)?;
    ensure_not_option_like("远端名称", remote)?;

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
        args.push("--force-with-lease".to_string());
    }
    args.push(END_OF_OPTIONS.to_string());
    args.push(remote.to_string());
    args.push(refspec);
    Ok(args)
}

fn push_command_preview(args: &[String]) -> String {
    format!("git.exe {}", args.join(" "))
}

/// 待推送提交列表的 log 参数。
///
/// 这里只能靠完整 ref 防选项注入：调用方随后会追加 `--not <远端 refs>`，而
/// `--end-of-options` 要求所有选项前置，实测会报
/// `fatal: option '--not' must come before non-option arguments`。
fn push_log_args(
    local_ref: &str,
    target_ref: &str,
    target_exists: bool,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "log".to_string(),
        "-n100".to_string(),
        "--date=short".to_string(),
        "--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ad%x1f%s%x1e".to_string(),
    ];
    if target_exists {
        args.push(revision_range(target_ref, local_ref)?);
    } else {
        ensure_revision_arg("本地分支引用", local_ref)?;
        args.push(local_ref.to_string());
    }
    Ok(args)
}

fn preview_push_impl(options: GitPushOptions) -> Result<GitPushPreview, String> {
    let root = require_repo_root(&options.path)?;
    let (remote, local_branch, remote_branch) = normalize_push_options(&options)?;

    // 本地分支统一转成完整 ref 后再交给 git；`rev-parse --verify` 用 `--end-of-options`
    // 兜底（实测这里不能用 `--`，`rev-parse --verify --quiet -- main` 会直接失败）。
    let local_ref = local_branch_ref(&local_branch)?;
    run_git(
        &root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            END_OF_OPTIONS,
            local_ref.as_str(),
        ],
    )
    .map_err(|_| format!("本地分支不存在：{}", local_branch))?;

    let args = build_push_args(&options, &remote, &local_branch, &remote_branch)?;
    let target_ref = remote_tracking_ref(&remote, &remote_branch)?;
    let target_exists = run_git(
        &root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            END_OF_OPTIONS,
            target_ref.as_str(),
        ],
    )
    .is_ok();

    let mut warning = None;
    let commits = if target_exists {
        git_log_commits(&root, &push_log_args(&local_ref, &target_ref, true)?)?
    } else {
        warning = Some("远端分支尚未在本地缓存中找到，将按新分支推送预览。".to_string());
        let refs_prefix = remote_refs_prefix(&remote)?;
        let remote_refs = run_git(
            &root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                END_OF_OPTIONS,
                refs_prefix.as_str(),
            ],
        )
        .unwrap_or_default();
        let refs = remote_refs
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.ends_with("/HEAD"))
            .map(str::to_string)
            .collect::<Vec<_>>();

        let mut log_args = push_log_args(&local_ref, &target_ref, false)?;
        if refs.is_empty() {
            warning =
                Some("本地没有该远端的引用缓存，预览显示本地分支最近 100 条提交。".to_string());
        } else {
            log_args.push("--not".to_string());
            log_args.extend(refs);
        }
        git_log_commits(&root, &log_args)?
    };

    Ok(GitPushPreview {
        command: push_command_preview(&args),
        remote,
        local_branch,
        remote_branch,
        target_ref,
        target_exists,
        commits,
        warning,
    })
}

#[command]
pub async fn git_preview_push(options: GitPushOptions) -> Result<GitPushPreview, String> {
    git_task(move || preview_push_impl(options)).await
}

#[command]
pub async fn git_push_with_options(
    app: tauri::AppHandle,
    options: GitPushOptions,
) -> Result<GitPushResult, String> {
    git_task(move || git_push_with_options_impl(app, options)).await
}

fn git_push_with_options_impl(
    app: tauri::AppHandle,
    options: GitPushOptions,
) -> Result<GitPushResult, String> {
    let root = require_repo_root(&options.path)?;
    let preview = preview_push_impl(options.clone())?;
    let args = build_push_args(
        &options,
        &preview.remote,
        &preview.local_branch,
        &preview.remote_branch,
    )?;
    let command = push_command_preview(&args);
    let arg_refs: Vec<&str> = args.iter().map(|value| value.as_str()).collect();
    let output = run_git_process(
        &root,
        &arg_refs,
        Some(&|chunk| emit_git_push_chunk(&app, options.operation_id.as_deref(), chunk)),
    )?;
    let output = git_push_run_output(output, &arg_refs)?;

    Ok(GitPushResult {
        command,
        output,
        remote: preview.remote,
        local_branch: preview.local_branch,
        remote_branch: preview.remote_branch,
        outgoing_commits: preview.commits,
    })
}

#[command]
pub async fn git_get_changed_files(path: String) -> Result<Vec<GitChangedFile>, String> {
    git_task(move || git_get_changed_files_impl(path)).await
}

fn git_get_changed_files_impl(path: String) -> Result<Vec<GitChangedFile>, String> {
    let root = require_repo_root(&path)?;
    let status_entries = git_status_entries(&root)?;
    let stats = numstat_map(&root);

    let mut files = status_entries
        .into_iter()
        .map(|entry| {
            let GitStatusEntry { x, y, path } = entry;
            let untracked = x == '?' && y == '?';
            let (additions, deletions) = lookup_numstat(&stats, &path);

            GitChangedFile {
                extension: file_extension(&path),
                status: status_label(x, y, untracked),
                additions,
                deletions,
                staged: x != ' ' && x != '?',
                untracked,
                path,
            }
        })
        .collect::<Vec<_>>();

    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(files)
}

#[command]
pub async fn git_get_history_files(
    path: String,
    from_revision: Option<String>,
    to_revision: String,
) -> Result<Vec<GitHistoryFile>, String> {
    git_task(move || git_get_history_files_impl(path, from_revision, to_revision)).await
}

fn git_get_history_files_impl(
    path: String,
    from_revision: Option<String>,
    to_revision: String,
) -> Result<Vec<GitHistoryFile>, String> {
    let root = require_repo_root(&path)?;
    let from_revision = normalize_history_revision(from_revision);
    let to_revision = to_revision.trim().to_string();
    if to_revision.is_empty() {
        return Err("目标版本不能为空".to_string());
    }
    ensure_revision_arg("起始版本", &from_revision)?;
    ensure_revision_arg("目标版本", &to_revision)?;

    // `--end-of-options` 之后是两个 revision，末尾 `--` 之后是 pathspec（此处为空）：
    // 两个分隔符各司其职，不能用 `--` 代替选项终止符。
    let name_status = run_git(
        &root,
        &[
            "diff",
            "--name-status",
            "-z",
            "-M",
            "-C",
            END_OF_OPTIONS,
            from_revision.as_str(),
            to_revision.as_str(),
            "--",
        ],
    )?;
    let numstat = run_git(
        &root,
        &[
            "diff",
            "--numstat",
            "-M",
            "-C",
            END_OF_OPTIONS,
            from_revision.as_str(),
            to_revision.as_str(),
            "--",
        ],
    )
    .unwrap_or_default();
    let stats = parse_history_numstats(&numstat);

    Ok(parse_history_files(&name_status, &stats))
}

#[command]
pub async fn git_get_history_file_diff(
    path: String,
    from_revision: Option<String>,
    to_revision: String,
    file_path: String,
    old_path: Option<String>,
    status_code: String,
    binary: bool,
) -> Result<GitHistoryFileDiff, String> {
    git_task(move || {
        git_get_history_file_diff_impl(
            path,
            from_revision,
            to_revision,
            file_path,
            old_path,
            status_code,
            binary,
        )
    })
    .await
}

fn git_get_history_file_diff_impl(
    path: String,
    from_revision: Option<String>,
    to_revision: String,
    file_path: String,
    old_path: Option<String>,
    status_code: String,
    binary: bool,
) -> Result<GitHistoryFileDiff, String> {
    let root = require_repo_root(&path)?;
    let from_revision = normalize_history_revision(from_revision);
    let to_revision = to_revision.trim().to_string();
    let file_path = file_path.trim().to_string();
    let old_path = old_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let status_code = history_status_code(&status_code);

    if to_revision.is_empty() {
        return Err("目标版本不能为空".to_string());
    }
    if file_path.is_empty() {
        return Err("文件路径不能为空".to_string());
    }

    let old_content = if status_code == "A" {
        String::new()
    } else {
        git_show_revision_file(
            &root,
            from_revision.as_str(),
            old_path.as_deref().unwrap_or(file_path.as_str()),
        )?
        .unwrap_or_default()
    };
    let new_content = if status_code == "D" {
        String::new()
    } else {
        git_show_revision_file(&root, to_revision.as_str(), file_path.as_str())?.unwrap_or_default()
    };

    Ok(GitHistoryFileDiff {
        path: file_path,
        old_path,
        status: history_status_label(&status_code),
        status_code,
        old_revision: from_revision,
        new_revision: to_revision,
        old_content,
        new_content,
        binary,
    })
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
pub async fn git_get_history(
    path: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<GitHistoryResult, String> {
    git_task(move || git_get_history_impl(path, limit, skip)).await
}

fn current_branch_name(root: &Path) -> Option<String> {
    run_git(root, &["branch", "--show-current"])
        .ok()
        .filter(|value| !value.is_empty())
}

fn upstream_short_name(root: &Path) -> Option<String> {
    run_git(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok()
    .filter(|value| !value.is_empty())
}

fn upstream_hash_and_merge_base(
    root: &Path,
    upstream_short: Option<&str>,
) -> (Option<String>, Option<String>) {
    if upstream_short.is_none() {
        return (None, None);
    }
    let hash = run_git(root, &["rev-parse", "--verify", "@{upstream}"])
        .ok()
        .filter(|value| !value.is_empty());
    let merge_base = run_git(root, &["merge-base", "HEAD", "@{upstream}"])
        .ok()
        .filter(|value| !value.is_empty());
    (hash, merge_base)
}

/// 合成当前分支 ref：优先在已解析 refs 中查找，找不到时兜底手工构造。
fn synthesize_current_ref(
    refs: &mut Vec<GitHistoryRef>,
    head: &str,
    current_branch: Option<&str>,
) -> Option<GitHistoryRef> {
    let current_ref = match current_branch {
        Some(branch) => {
            let full_name = format!("refs/heads/{}", branch);
            find_history_ref(refs, head, Some(&full_name), Some(branch)).or_else(|| {
                Some(GitHistoryRef {
                    name: branch.to_string(),
                    full_name,
                    revision: head.to_string(),
                    kind: "local".to_string(),
                    is_current: true,
                    is_upstream: false,
                    is_base: false,
                })
            })
        }
        None => Some(GitHistoryRef {
            name: "HEAD".to_string(),
            full_name: "HEAD".to_string(),
            revision: head.to_string(),
            kind: "head".to_string(),
            is_current: true,
            is_upstream: false,
            is_base: false,
        }),
    };
    if let Some(git_ref) = current_ref.as_ref() {
        push_ref_if_missing(refs, git_ref);
    }
    current_ref
}

/// 合成上游 ref：优先在已解析 refs 中查找，找不到时兜底手工构造。
fn synthesize_upstream_ref(
    refs: &mut Vec<GitHistoryRef>,
    upstream_short: Option<&str>,
    upstream_hash: Option<&str>,
) -> Option<GitHistoryRef> {
    let upstream_ref = match (upstream_short, upstream_hash) {
        (Some(upstream), Some(revision)) => {
            let full_name = format!("refs/remotes/{}", upstream);
            find_history_ref(refs, revision, Some(&full_name), Some(upstream)).or_else(|| {
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
        push_ref_if_missing(refs, git_ref);
    }
    upstream_ref
}

fn build_history_log_args(
    limit: Option<u32>,
    skip: Option<u32>,
    head: &str,
    upstream_ref: Option<&GitHistoryRef>,
    base_ref: Option<&GitHistoryRef>,
) -> Vec<String> {
    let limit_arg = format!("-n{}", limit.unwrap_or(200).clamp(1, 500));
    let mut log_args = vec![
        "log".to_string(),
        "--topo-order".to_string(),
        limit_arg,
        "--date=relative".to_string(),
        "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ar%x1f%s%x1e".to_string(),
    ];
    if let Some(skip) = skip.filter(|value| *value > 0) {
        log_args.push(format!("--skip={}", skip));
    }
    // revision 全部来自 git 自己输出的 objectname，仍统一加选项终止符：这里不追加
    // `--not`，`--end-of-options` 可用。
    log_args.push(END_OF_OPTIONS.to_string());
    log_args.extend(history_log_revisions(head, upstream_ref, base_ref));
    log_args
}

fn git_get_history_impl(
    path: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<GitHistoryResult, String> {
    let root = require_repo_root(&path)?;
    let Some(head) = head_hash(&root) else {
        return Ok(empty_git_history_result());
    };

    let current_branch = current_branch_name(&root);
    let upstream_short = upstream_short_name(&root);
    let (upstream_hash, merge_base) = upstream_hash_and_merge_base(&root, upstream_short.as_deref());
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
        current_branch.as_deref(),
        upstream_short.as_deref(),
    );

    let current_ref = synthesize_current_ref(&mut refs, &head, current_branch.as_deref());
    let upstream_ref =
        synthesize_upstream_ref(&mut refs, upstream_short.as_deref(), upstream_hash.as_deref());
    let base_ref = mark_configured_history_base_ref(
        &root,
        current_branch.as_deref(),
        upstream_ref.as_ref(),
        &mut refs,
    );

    let refs_by_revision = refs_by_revision(&refs);
    let log_args = build_history_log_args(
        limit,
        skip,
        &head,
        upstream_ref.as_ref(),
        base_ref.as_ref(),
    );
    let log_arg_refs = log_args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_git(&root, &log_arg_refs)?;

    Ok(GitHistoryResult {
        commits: parse_commits(&output, Some(&refs_by_revision)),
        refs,
        current_ref,
        upstream_ref,
        base_ref,
        merge_base,
        ahead,
        behind,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_push_args, drain_git_channel_until, push_log_args, GitDrainOutcome, GitPushOptions,
    };
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn push_options() -> GitPushOptions {
        GitPushOptions {
            path: String::new(),
            remote: "origin".to_string(),
            local_branch: "main".to_string(),
            remote_branch: "main".to_string(),
            set_upstream: false,
            follow_tags: false,
            force_with_lease: false,
            operation_id: None,
        }
    }

    #[test]
    fn build_push_args_puts_end_of_options_before_remote_and_refspec() {
        let args = build_push_args(&push_options(), "origin", "main", "main").unwrap();
        assert_eq!(
            args,
            vec![
                "push",
                "-v",
                "--progress",
                "--end-of-options",
                "origin",
                "refs/heads/main:refs/heads/main",
            ]
        );
    }

    #[test]
    fn build_push_args_keeps_options_ahead_of_the_terminator() {
        let mut options = push_options();
        options.set_upstream = true;
        options.follow_tags = true;
        options.force_with_lease = true;
        let args = build_push_args(&options, "origin", "feat/a", "feat/a").unwrap();
        let terminator = args.iter().position(|arg| arg == "--end-of-options").unwrap();
        for flag in ["-u", "--follow-tags", "--force-with-lease"] {
            let index = args.iter().position(|arg| arg == flag).unwrap();
            assert!(index < terminator, "{} 必须排在选项终止符之前", flag);
        }
        assert_eq!(args[terminator + 1], "origin");
        assert_eq!(args[terminator + 2], "refs/heads/feat/a:refs/heads/feat/a");
    }

    /// `--receive-pack=<prog>` 形状的分支名会让 git push 执行本地程序。
    #[test]
    fn build_push_args_neutralizes_option_shaped_branch_names() {
        let args = build_push_args(&push_options(), "origin", "main", "--receive-pack=calc.exe")
            .unwrap();
        assert!(args.iter().all(|arg| arg != "--receive-pack=calc.exe"));
        assert_eq!(
            args.last().unwrap(),
            "refs/heads/main:refs/heads/--receive-pack=calc.exe"
        );
        let bad_remote = build_push_args(&push_options(), "--upload-pack=calc.exe", "main", "main");
        assert!(bad_remote.is_err());
    }

    /// 这里必须用完整 ref 而不是 `--end-of-options`：调用方随后追加 `--not`，
    /// 实测 git 会报 `option '--not' must come before non-option arguments`。
    #[test]
    fn push_log_args_uses_full_refs_without_option_terminator() {
        let args = push_log_args("refs/heads/main", "refs/remotes/origin/main", true).unwrap();
        assert!(args.iter().all(|arg| arg != "--end-of-options"));
        assert_eq!(args.last().unwrap(), "refs/remotes/origin/main..refs/heads/main");

        let args = push_log_args("refs/heads/main", "refs/remotes/origin/main", false).unwrap();
        assert_eq!(args.last().unwrap(), "refs/heads/main");

        let bad_local =
            push_log_args("--output=audit-output.txt", "refs/remotes/origin/main", false);
        assert!(bad_local.is_err());
    }

    #[test]
    fn drain_completes_when_all_readers_exit() {
        let (tx, rx) = mpsc::channel();
        tx.send(super::GitChunk::Stdout("hello".to_string())).unwrap();
        drop(tx);

        let (mut out, mut err, mut all) = (String::new(), String::new(), String::new());
        let outcome = drain_git_channel_until(
            &rx,
            Duration::from_secs(5),
            &mut out,
            &mut err,
            &mut all,
            &mut None,
        );

        assert!(matches!(outcome, GitDrainOutcome::Completed));
        assert_eq!(out, "hello");
        assert_eq!(all, "hello");
    }

    /// 后代进程握着管道写端时 reader 永远读不到 EOF；等待必须有上限，
    /// 不能像旧实现那样无上限 join 把请求线程挂死。
    #[test]
    fn drain_times_out_while_a_reader_still_holds_the_pipe() {
        let (tx, rx) = mpsc::channel::<super::GitChunk>();
        let started = Instant::now();

        let (mut out, mut err, mut all) = (String::new(), String::new(), String::new());
        let outcome = drain_git_channel_until(
            &rx,
            Duration::from_millis(200),
            &mut out,
            &mut err,
            &mut all,
            &mut None,
        );

        assert!(matches!(outcome, GitDrainOutcome::TimedOut));
        assert!(started.elapsed() >= Duration::from_millis(200));
        assert!(started.elapsed() < Duration::from_secs(5));
        drop(tx);
    }
}
