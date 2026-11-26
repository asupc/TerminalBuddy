//! 日志格式变化或在 Shell 中手动启动 CLI 时，通过正在打开的 rollout 文件关联会话。
//! 文件必须由确切属于该终端的 Codex 进程占用；目录、时间只用于缩小扫描范围。
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

pub(super) struct AntigravityProcessScope {
    pub terminal_id: String,
    pub process_id: u32,
    pub root: PathBuf,
    pub started_at: SystemTime,
}

pub(super) struct AntigravityDiscovery {
    pub live_terminals: HashSet<String>,
    pub sessions: HashMap<String, String>,
}

/// tmux / HUD 会让 CLI 脱离 PTY 的进程树，但仍继承创建终端时注入的 ID。
/// 只读取这一项，环境中的 Hook token 等敏感信息不会进入关联结果。
#[cfg(not(windows))]
fn inherited_terminal_id(pid: u32) -> Option<String> {
    let environment = fs::read(format!("/proc/{pid}/environ")).ok()?;
    environment.split(|byte| *byte == 0).find_map(|entry| {
        let id = entry.strip_prefix(b"TERMINAL_BUDDY_TERMINAL_ID=")?;
        std::str::from_utf8(id).ok().filter(|id| !id.is_empty()).map(str::to_string)
    })
}

#[cfg(windows)]
fn inherited_terminal_id(_pid: u32) -> Option<String> { None }

fn associate_agent_processes(
    terminal_pids: &[(String, u32)],
    processes: &[(u32, u32, String)],
    inherited_id: impl Fn(u32) -> Option<String>,
    matches_name: impl Fn(&str) -> bool,
) -> HashMap<String, HashMap<u32, usize>> {
    let roots: HashMap<_, _> = terminal_pids.iter().map(|(id, pid)| (*pid, id)).collect();
    let terminal_ids: HashSet<_> = terminal_pids.iter().map(|(id, _)| id.as_str()).collect();
    let parents: HashMap<_, _> = processes.iter().map(|(pid, parent, _)| (*pid, *parent)).collect();
    let mut result = HashMap::<String, HashMap<u32, usize>>::new();
    for (pid, _, name) in processes {
        if !matches_name(name) { continue; }
        let mut current = *pid;
        let mut visited = HashSet::new();
        let mut terminal_id = None;
        while visited.insert(current) {
            if terminal_id.is_none() {
                terminal_id = roots.get(&current).map(|id| (*id).clone());
            }
            let Some(parent) = parents.get(&current) else { break; };
            current = *parent;
        }
        let terminal_id = terminal_id.or_else(|| inherited_id(*pid)
            .filter(|id| terminal_ids.contains(id.as_str())));
        if let Some(id) = terminal_id {
            // 从完整进程树计算深度，普通子进程与脱离 PTY 的进程使用同一标尺；
            // 外层 CLI 排在它启动的嵌套 CLI 前面，避免子代理抢走主会话绑定。
            result.entry(id).or_default().insert(*pid, visited.len());
        }
    }
    result
}

fn associate_codex_processes(
    terminal_pids: &[(String, u32)],
    processes: &[(u32, u32, String)],
    inherited_id: impl Fn(u32) -> Option<String>,
) -> HashMap<String, HashMap<u32, usize>> {
    associate_agent_processes(terminal_pids, processes, inherited_id, |name| name.contains("codex"))
}

// 仅匹配 CLI 可执行文件；`antigravity.exe` 是桌面 IDE，不能误判为终端 CLI。
fn is_antigravity_cli_process(name: &str) -> bool {
    name.eq_ignore_ascii_case("agy")
        || name.eq_ignore_ascii_case("agy.exe")
        || name.eq_ignore_ascii_case("antigravity")
}

fn associate_antigravity_processes(
    terminal_pids: &[(String, u32)],
    processes: &[(u32, u32, String)],
    inherited_id: impl Fn(u32) -> Option<String>,
) -> HashMap<String, HashMap<u32, usize>> {
    associate_agent_processes(terminal_pids, processes, inherited_id, is_antigravity_cli_process)
}

pub(super) fn codex_processes_with_processes(
    terminal_pids: &[(String, u32)],
    processes: &[(u32, u32, String)],
) -> HashMap<String, HashMap<u32, usize>> {
    if terminal_pids.is_empty() { return HashMap::new(); }
    associate_codex_processes(terminal_pids, processes, inherited_terminal_id)
}

pub(super) fn antigravity_processes_with_processes(
    terminal_pids: &[(String, u32)],
    processes: &[(u32, u32, String)],
) -> HashMap<String, HashMap<u32, usize>> {
    if terminal_pids.is_empty() { return HashMap::new(); }
    associate_antigravity_processes(terminal_pids, processes, inherited_terminal_id)
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

pub(super) fn discover_with_processes(
    scopes: Vec<CodexProcessScope>,
    processes: &[(u32, u32, String)],
) -> (HashMap<String, (String, PathBuf)>, HashSet<String>) {
    if scopes.is_empty() { return (HashMap::new(), HashSet::new()); }
    let terminal_pids: Vec<_> = scopes.iter().map(|scope| (scope.terminal_id.clone(), scope.process_id)).collect();
    let mut associated = codex_processes_with_processes(&terminal_pids, processes);
    let live_terminals: HashSet<String> = associated.keys().cloned().collect();
    let mut trees = Vec::new();
    let mut roots = HashMap::<PathBuf, (SystemTime, HashSet<u32>)>::new();
    for scope in scopes {
        let Some(codex_pids) = associated.remove(&scope.terminal_id) else { continue; };
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
    (result, live_terminals)
}

fn lock_conversation_id(path: &Path) -> Option<String> {
    if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("lock")) {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    uuid::Uuid::parse_str(stem).ok()?;
    Some(stem.to_string())
}

#[cfg(not(windows))]
fn open_antigravity_locks(process_ids: &HashSet<u32>, root: &Path) -> Vec<(String, HashSet<u32>)> {
    let presence_dir = root.join("presence");
    let presence_dir = fs::canonicalize(&presence_dir).unwrap_or(presence_dir);
    let mut by_conversation: HashMap<String, HashSet<u32>> = HashMap::new();
    for pid in process_ids {
        let Ok(entries) = fs::read_dir(format!("/proc/{}/fd", pid)) else { continue; };
        for entry in entries.flatten() {
            let Ok(path) = fs::read_link(entry.path()) else { continue; };
            if !path.starts_with(&presence_dir) { continue; }
            let Some(conversation_id) = lock_conversation_id(&path) else { continue; };
            by_conversation.entry(conversation_id).or_default().insert(*pid);
        }
    }
    by_conversation.into_iter().collect()
}

#[cfg(windows)]
fn open_antigravity_locks(process_ids: &HashSet<u32>, root: &Path) -> Vec<(String, HashSet<u32>)> {
    use std::os::windows::fs::OpenOptionsExt;

    let Ok(entries) = fs::read_dir(root.join("presence")) else { return Vec::new(); };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue; };
        if !kind.is_file() { continue; }
        let path = entry.path();
        let Some(conversation_id) = lock_conversation_id(&path) else { continue; };
        // 必须指定 share_mode(0) 请求独占打开：Go 默认以 FILE_SHARE_READ|WRITE 打开锁文件，
        // 不加 share_mode(0) 时普通 OpenOptions::open 会直接成功并误跳过所有存活锁文件。
        if fs::OpenOptions::new().read(true).write(true).share_mode(0).open(&path).is_ok() {
            continue;
        }
        let holders: HashSet<_> = restart_manager::holders(&path)
            .intersection(process_ids)
            .copied()
            .collect();
        if !holders.is_empty() {
            result.push((conversation_id, holders));
        }
    }
    result
}

/// 把 `agy` 进程的后代子进程（如语言服务 / ACP 子进程）一并纳入句柄归属集合，
/// 防止锁文件由 `agy` 拉起的子进程持有而被漏判。
fn expand_with_descendants(
    agy_pids: &mut HashMap<u32, usize>,
    processes: &[(u32, u32, String)],
) {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, parent, _) in processes {
        children.entry(*parent).or_default().push(*pid);
    }
    let mut queue: Vec<(u32, usize)> = agy_pids.iter().map(|(&pid, &depth)| (pid, depth)).collect();
    while let Some((pid, depth)) = queue.pop() {
        let Some(kids) = children.get(&pid) else { continue; };
        for &kid in kids {
            let next_depth = depth.saturating_add(1);
            let should_push = match agy_pids.get(&kid) {
                Some(&existing) if existing <= next_depth => false,
                _ => {
                    agy_pids.insert(kid, next_depth);
                    true
                }
            };
            if should_push {
                queue.push((kid, next_depth));
            }
        }
    }
}

/// 兜底：若 `presence/<uuid>.lock` 未命中（例如某些版本不常驻持锁），
/// 当同一 `antigravity_root` 下只有一个未绑定的存活 `agy` 终端时，
/// 选取该终端启动后最近更新的非子代理 `brain/<uuid>/.system_generated/logs/transcript*.jsonl`。
fn latest_recent_antigravity_session(
    root: &Path,
    since: SystemTime,
    subagents: &HashSet<String>,
    already_bound: &HashSet<String>,
) -> Option<String> {
    let Ok(entries) = fs::read_dir(root.join("brain")) else { return None; };
    let mut best: Option<(SystemTime, String)> = None;
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue; };
        if !kind.is_dir() { continue; }
        let name = entry.file_name();
        let Some(id) = name.to_str() else { continue; };
        if uuid::Uuid::parse_str(id).is_err() || subagents.contains(id) || already_bound.contains(id) {
            continue;
        }
        let logs = entry.path().join(".system_generated").join("logs");
        let mut latest_mtime: Option<SystemTime> = None;
        for file_name in ["transcript_full.jsonl", "transcript.jsonl"] {
            let candidate = logs.join(file_name);
            let Ok(meta) = fs::metadata(&candidate) else { continue; };
            if !meta.is_file() { continue; }
            let Ok(modified) = meta.modified() else { continue; };
            if modified >= since && latest_mtime.is_none_or(|prev| modified > prev) {
                latest_mtime = Some(modified);
            }
        }
        if let Some(modified) = latest_mtime {
            if best.as_ref().is_none_or(|(prev, _)| modified > *prev) {
                best = Some((modified, id.to_string()));
            }
        }
    }
    best.map(|(_, id)| id)
}

pub(super) fn discover_antigravity_with_processes(
    scopes: Vec<AntigravityProcessScope>,
    processes: &[(u32, u32, String)],
) -> AntigravityDiscovery {
    if scopes.is_empty() {
        return AntigravityDiscovery {
            live_terminals: HashSet::new(),
            sessions: HashMap::new(),
        };
    }
    let terminal_pids: Vec<_> = scopes
        .iter()
        .map(|scope| (scope.terminal_id.clone(), scope.process_id))
        .collect();
    let mut associated = antigravity_processes_with_processes(&terminal_pids, processes);
    let live_terminals: HashSet<String> = associated.keys().cloned().collect();
    let mut trees = Vec::new();
    let mut roots = HashMap::<PathBuf, HashSet<u32>>::new();
    for scope in scopes {
        let Some(mut agy_pids) = associated.remove(&scope.terminal_id) else { continue; };
        expand_with_descendants(&mut agy_pids, processes);
        roots.entry(scope.root.clone()).or_default().extend(agy_pids.keys().copied());
        trees.push((scope, agy_pids));
    }
    // 同一个 ANTIGRAVITY_CLI_HOME 的锁文件与子代理清单只扫描一次。
    let root_data: HashMap<_, _> = roots
        .into_iter()
        .map(|(root, pids)| {
            let locks = open_antigravity_locks(&pids, &root);
            let subagents = super::antigravity_history_service::subagent_conversation_ids(&root);
            (root, (locks, subagents))
        })
        .collect();
    let mut sessions = HashMap::new();
    let mut unmatched_by_root: HashMap<PathBuf, Vec<(String, SystemTime)>> = HashMap::new();
    for (scope, agy_pids) in trees {
        let Some((locks, subagents)) = root_data.get(&scope.root) else { continue; };
        let mut candidates = Vec::new();
        for (conversation_id, holders) in locks {
            if subagents.contains(conversation_id) { continue; }
            let Some(depth) = holders.iter().filter_map(|pid| agy_pids.get(pid)).min().copied() else {
                continue;
            };
            candidates.push((depth, conversation_id));
        }
        candidates.sort_by_key(|(depth, _)| *depth);
        if let Some((depth, id)) = candidates.first() {
            if candidates.iter().filter(|(d, _)| d == depth).all(|(_, other)| other == id) {
                sessions.insert(scope.terminal_id, (*id).clone());
                continue;
            }
        }
        unmatched_by_root
            .entry(scope.root)
            .or_default()
            .push((scope.terminal_id, scope.started_at));
    }
    let already_bound: HashSet<String> = sessions.values().cloned().collect();
    for (root, unmatched) in unmatched_by_root {
        if unmatched.len() != 1 {
            continue;
        }
        let (terminal_id, started_at) = &unmatched[0];
        let Some((_, subagents)) = root_data.get(&root) else { continue; };
        if let Some(id) = latest_recent_antigravity_session(&root, *started_at, subagents, &already_bound) {
            sessions.insert(terminal_id.clone(), id);
        }
    }
    AntigravityDiscovery { live_terminals, sessions }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, parent: u32, name: &str) -> (u32, u32, String) {
        (pid, parent, name.to_string())
    }

    #[test]
    fn associates_hud_codex_outside_terminal_process_tree() {
        let terminals = vec![("terminal-a".to_string(), 10)];
        let processes = vec![
            process(10, 1, "bash"), process(11, 10, "python3"), process(12, 11, "tmux: client"),
            process(20, 1, "tmux: server"), process(21, 20, "python3"), process(22, 21, "codex"),
            process(23, 22, "codex"), process(30, 1, "codex"), process(31, 1, "codex"),
        ];
        let owners = associate_codex_processes(&terminals, &processes, |pid| match pid {
            22 | 23 => Some("terminal-a".to_string()),
            30 => Some("closed-terminal".to_string()),
            _ => None,
        });
        let pids = &owners["terminal-a"];
        assert_eq!(pids.len(), 2);
        assert!(pids[&22] < pids[&23]);
        assert_eq!(owners.len(), 1);
    }

    #[test]
    fn process_tree_owner_takes_precedence_over_inherited_id() {
        let terminals = vec![("terminal-a".to_string(), 10), ("terminal-b".to_string(), 20)];
        let processes = vec![process(10, 1, "bash"), process(11, 10, "codex.exe"), process(20, 1, "bash")];
        let owners = associate_codex_processes(&terminals, &processes, |_| Some("terminal-b".to_string()));
        assert!(owners["terminal-a"].contains_key(&11));
        assert!(!owners.contains_key("terminal-b"));
    }

    #[test]
    fn exited_detached_codex_does_not_keep_terminal_alive() {
        let terminals = vec![("terminal-a".to_string(), 10)];
        let processes = vec![process(10, 1, "bash"), process(20, 1, "tmux: server"), process(21, 20, "python3")];
        let owners = associate_codex_processes(&terminals, &processes, |_| Some("terminal-a".to_string()));
        assert!(owners.is_empty());
    }

    #[test]
    fn associates_agy_cli_and_ignores_antigravity_ide() {
        let terminals = vec![("terminal-a".to_string(), 10), ("terminal-b".to_string(), 20)];
        let processes = vec![
            process(10, 1, "powershell.exe"),
            process(11, 10, "agy.exe"),
            process(12, 10, "antigravity.exe"),
            process(20, 1, "bash"),
            process(21, 20, "agy"),
            process(30, 1, "antigravity.exe"),
        ];
        let owners = associate_antigravity_processes(&terminals, &processes, |_| None);
        assert_eq!(owners["terminal-a"].len(), 1);
        assert!(owners["terminal-a"].contains_key(&11));
        assert!(!owners["terminal-a"].contains_key(&12));
        assert_eq!(owners["terminal-b"].len(), 1);
        assert!(owners["terminal-b"].contains_key(&21));
    }
}
