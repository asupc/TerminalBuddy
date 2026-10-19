//! 日志格式变化或在 Shell 中手动启动 CLI 时，通过正在打开的 rollout 文件关联会话。
//! 文件必须确实由终端的 Codex 子进程占用；目录、时间只用于缩小扫描范围。
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub(super) struct CodexProcessScope {
    pub terminal_id: String,
    pub process_id: u32,
    pub root: PathBuf,
    pub started_at: SystemTime,
}

fn root_session(path: &Path) -> Option<String> {
    let line = BufReader::new(fs::File::open(path).ok()?).lines().next()?.ok()?;
    let row: serde_json::Value = serde_json::from_str(&line).ok()?;
    if row["type"] != "session_meta" { return None; }
    let meta = &row["payload"];
    if meta["source"].get("subagent").is_some() || meta["thread_source"] == "subagent"
        || meta["source"].as_str().is_some_and(|source| source.starts_with("subagent")) {
        return None;
    }
    let id = meta["id"].as_str()?;
    uuid::Uuid::parse_str(id).ok()?;
    Some(id.to_string())
}

#[cfg(not(windows))]
fn open_rollouts(process_ids: &HashSet<u32>, root: &Path, _since: SystemTime) -> Vec<(PathBuf, HashSet<u32>)> {
    let root = fs::canonicalize(root.join("sessions")).unwrap_or_else(|_| root.join("sessions"));
    let mut result = Vec::new();
    for pid in process_ids {
        let Ok(entries) = fs::read_dir(format!("/proc/{}/fd", pid)) else { continue; };
        for entry in entries.flatten() {
            let Ok(path) = fs::read_link(entry.path()) else { continue; };
            if path.starts_with(&root) && path.extension().is_some_and(|ext| ext == "jsonl") {
                result.push((path, HashSet::from([*pid])));
            }
        }
    }
    result
}

#[cfg(windows)]
mod restart_manager {
    use super::*;
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct UniqueProcess { pid: u32, started_low: u32, started_high: u32 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ProcessInfo {
        process: UniqueProcess,
        app_name: [u16; 256],
        service_name: [u16; 64],
        app_type: u32,
        app_status: u32,
        session_id: u32,
        restartable: i32,
    }

    #[link(name = "Rstrtmgr")]
    extern "system" {
        fn RmStartSession(handle: *mut u32, flags: u32, key: *mut u16) -> u32;
        fn RmEndSession(handle: u32) -> u32;
        fn RmRegisterResources(handle: u32, files: u32, paths: *const *const u16,
            applications: u32, processes: *const UniqueProcess, services: u32, names: *const *const u16) -> u32;
        fn RmGetList(handle: u32, needed: *mut u32, count: *mut u32, processes: *mut ProcessInfo, reasons: *mut u32) -> u32;
    }
    struct Session(u32);
    impl Drop for Session { fn drop(&mut self) { unsafe { RmEndSession(self.0); } } }

    // 只查询占用者，绝不调用 RmShutdown / RmRestart。
    pub(super) fn holders(path: &Path) -> HashSet<u32> {
        unsafe {
            let mut handle = 0;
            let mut key = [0_u16; 33];
            if RmStartSession(&mut handle, 0, key.as_mut_ptr()) != 0 { return HashSet::new(); }
            let _session = Session(handle);
            let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let paths = [path.as_ptr()];
            if RmRegisterResources(handle, 1, paths.as_ptr(), 0, std::ptr::null(), 0, std::ptr::null()) != 0 { return HashSet::new(); }
            let (mut needed, mut count, mut reasons) = (0, 0, 0);
            if RmGetList(handle, &mut needed, &mut count, std::ptr::null_mut(), &mut reasons) != 234 || needed > 1024 {
                return HashSet::new();
            }
            // 进程列表可在两次调用间变化；失败则留给下一轮发现。
            let mut processes: Vec<ProcessInfo> = vec![std::mem::zeroed(); needed as usize];
            count = needed;
            if RmGetList(handle, &mut needed, &mut count, processes.as_mut_ptr(), &mut reasons) != 0 { return HashSet::new(); }
            processes.iter().take(count as usize).map(|info| info.process.pid).collect()
        }
    }
}

#[cfg(windows)]
fn open_rollouts(process_ids: &HashSet<u32>, root: &Path, since: SystemTime) -> Vec<(PathBuf, HashSet<u32>)> {
    let mut dirs = vec![root.join("sessions")];
    let mut result = Vec::new();
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(dir) else { continue; };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue; };
            if kind.is_dir() { dirs.push(entry.path()); continue; }
            if !kind.is_file() || entry.path().extension().map_or(true, |ext| ext != "jsonl") { continue; }
            if entry.metadata().and_then(|meta| meta.modified()).is_ok_and(|modified| modified < since) { continue; }
            let path = entry.path();
            if root_session(&path).is_none() { continue; }
            let holders = restart_manager::holders(&path);
            let holders: HashSet<_> = holders.intersection(process_ids).copied().collect();
            if !holders.is_empty() { result.push((path, holders)); }
        }
    }
    result
}

pub(super) fn discover(scopes: Vec<CodexProcessScope>) -> HashMap<String, (String, PathBuf)> {
    if scopes.is_empty() { return HashMap::new(); }
    let processes = crate::commands::claude_session::get_all_processes();
    let mut trees = Vec::new();
    let mut roots = HashMap::<PathBuf, (SystemTime, HashSet<u32>)>::new();
    for scope in scopes {
        let mut pending = vec![(scope.process_id, 0_usize)];
        let mut visited = HashSet::new();
        let mut codex_pids = HashMap::new();
        while let Some((pid, depth)) = pending.pop() {
            if !visited.insert(pid) { continue; }
            for (child, parent, name) in &processes {
                if *parent != pid { continue; }
                pending.push((*child, depth + 1));
                if name.contains("codex") { codex_pids.insert(*child, depth + 1); }
            }
        }
        if codex_pids.is_empty() { continue; }
        let root = roots.entry(scope.root.clone()).or_insert_with(|| (scope.started_at, HashSet::new()));
        root.0 = root.0.min(scope.started_at);
        root.1.extend(codex_pids.keys().copied());
        trees.push((scope, codex_pids));
    }
    // 同一个 CODEX_HOME 的文件只扫描一次；Windows 仅对新增或有变化的文件查询占用者。
    let files: HashMap<_, _> = roots.into_iter().map(|(root, (since, pids))| {
        let files = open_rollouts(&pids, &root, since);
        (root, files)
    }).collect();
    let mut result = HashMap::new();
    for (scope, codex_pids) in trees {
        let mut candidates = Vec::new();
        let Some(files) = files.get(&scope.root) else { continue; };
        for (path, holders) in files {
            let Some(depth) = holders.iter().filter_map(|pid| codex_pids.get(pid)).min().copied() else { continue; };
            let Some(id) = root_session(path) else { continue; };
            candidates.push((depth, id, path.clone()));
        }
        candidates.sort_by_key(|(depth, _, _)| *depth);
        if let Some((depth, id, path)) = candidates.first() {
            // 同层存在多个主会话时不猜；保留日志或 Hook 提供的精确关联。
            if candidates.iter().filter(|(d, _, _)| d == depth).all(|(_, other, _)| other == id) {
                result.insert(scope.terminal_id, (id.clone(), path.clone()));
            }
        }
    }
    result
}
