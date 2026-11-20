//! Claude Code 会话发现：通过终端进程树定位 ~/.claude/sessions/<pid>.json。

use crate::commands::terminal::TerminalService;
use serde::Deserialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use crate::runtime::{AppHandle, Manager, State};

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// Claude Code 会话文件结构 (位于 ~/.claude/sessions/<pid>.json)
#[derive(Deserialize)]
struct ClaudeSessionFile {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

#[cfg(not(windows))]
pub(crate) fn get_all_processes() -> Vec<(u32, u32, String)> {
    let Ok(entries) = fs::read_dir("/proc") else { return Vec::new(); };
    entries.flatten().filter_map(|entry| {
        let pid = entry.file_name().to_string_lossy().parse::<u32>().ok()?;
        let stat = fs::read_to_string(entry.path().join("stat")).ok()?;
        let end = stat.rfind(')')?;
        let name = stat[stat.find('(')? + 1..end].to_lowercase();
        let parent = stat[end + 1..].split_whitespace().nth(1)?.parse().ok()?;
        Some((pid, parent, name))
    }).collect()
}

/// 一次性获取所有进程的父子关系，返回 (pid, parent_pid, name)
/// 使用 Windows API CreateToolhelp32Snapshot（几十毫秒），远快于 PowerShell/WMIC
#[cfg(windows)]
pub(crate) fn get_all_processes() -> Vec<(u32, u32, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut result = Vec::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return result,
        };
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                let ppid = entry.th32ParentProcessID;
                let name_end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_end]).to_lowercase();
                result.push((pid, ppid, name));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    result
}

/// 按终端进程树精确发现会话；兼容 CLAUDE_CONFIG_DIR 与 node 启动的 CLI。
pub(crate) fn discover_claude_sessions(
    terminal_pids: &[(String, u32)],
    config_dirs: &HashMap<String, PathBuf>,
) -> HashMap<String, String> {
    if terminal_pids.is_empty() { return HashMap::new(); }
    let all_processes = get_all_processes();
    let mut result = HashMap::new();
    for (terminal_id, root_pid) in terminal_pids {
        let Some(config_dir) = config_dirs.get(terminal_id) else { continue; };
        let mut pending = vec![*root_pid];
        let mut visited = HashSet::new();
        let mut best: Option<ClaudeSessionFile> = None;
        while let Some(pid) = pending.pop() {
            if !visited.insert(pid) { continue; }
            pending.extend(all_processes.iter().filter(|(_, parent, _)| *parent == pid).map(|(child, _, _)| *child));
            let file = config_dir.join("sessions").join(format!("{}.json", pid));
            if let Some(session) = fs::read_to_string(file).ok().and_then(|content| serde_json::from_str::<ClaudeSessionFile>(&content).ok()) {
                if best.as_ref().map_or(true, |old| session.updated_at > old.updated_at) {
                    best = Some(session);
                }
            }
        }
        if let Some(session) = best { result.insert(terminal_id.clone(), session.session_id); }
    }
    result
}

/// 批量获取多个终端的 Claude Code 会话 ID，只读取一次系统进程快照。
///
/// 已经结束的 terminal ID（容器重启后恢复页签的场景）回退到服务端持久化登记表；
/// 仍存活的终端只信任实时进程发现结果——用户退出 Claude 回到 shell 后，
/// 不能再把旧会话 ID 塞回去导致误 resume。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_claude_sessions_for_terminals(
    terminal_ids: Vec<String>,
    service: State<'_, TerminalService>,
) -> Result<HashMap<String, String>, String> {
    let terminal_pids = terminal_processes(&terminal_ids, &service);
    let live_ids: HashSet<String> = terminal_pids.iter().map(|(id, _)| id.clone()).collect();
    let settings = crate::services::SettingsService::get_settings();
    let root = crate::services::resolve_claude_config_dir(settings.claude_hook_config_dir.as_deref())?;
    let roots = terminal_pids.iter().map(|(id, _)| (id.clone(), root.clone())).collect();
    let mut sessions = discover_claude_sessions(&terminal_pids, &roots);
    let missing: Vec<String> = terminal_ids
        .into_iter()
        .filter(|id| !live_ids.contains(id) && !sessions.contains_key(id))
        .collect();
    if !missing.is_empty() {
        sessions.extend(crate::services::claude_session_registry_service::lookup(&missing, now_ms()));
    }
    Ok(sessions)
}

/// 批量获取多个终端的统一 Agent 会话绑定（Claude / Codex）。
/// 存活终端优先用当前绑定；容器重启后已结束的 terminal ID 回退到持久化登记表。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_agent_sessions_for_terminals(
    terminal_ids: Vec<String>,
    service: State<'_, TerminalService>,
) -> Result<HashMap<String, crate::services::claude_session_registry_service::AgentSessionRecord>, String> {
    let live: HashSet<String> = service.lock_instances().keys().cloned().collect();
    let requested: HashSet<String> = terminal_ids.iter().cloned().collect();
    let mut sessions: HashMap<_, _> = crate::services::terminal_task_service::session_bindings()
        .into_iter()
        .filter(|(id, record)| requested.contains(id) && matches!(record.provider.as_str(), "claude" | "codex"))
        .collect();
    let missing: Vec<String> = terminal_ids
        .into_iter()
        // 存活终端只信任当前绑定，避免用户退出 Codex 回到 shell 后又被旧登记表误恢复。
        .filter(|id| !live.contains(id) && !sessions.contains_key(id))
        .collect();
    if !missing.is_empty() {
        sessions.extend(crate::services::claude_session_registry_service::lookup_agents(&missing, now_ms()));
    }
    Ok(sessions)
}

/// 扫描所有存活终端并写入持久化登记表。由服务端后台任务周期性调用；
/// 没有存活终端时直接返回，避免空转扫描 /proc。
pub fn refresh_claude_session_registry(app: &AppHandle) -> Result<(), String> {
    let service = app.state::<TerminalService>();
    let terminal_pids: Vec<(String, u32)> = {
        let instances = service.lock_instances();
        instances
            .iter()
            .filter_map(|(id, instance)| instance.process_id().map(|pid| (id.clone(), pid)))
            .collect()
    };
    if terminal_pids.is_empty() {
        return Ok(());
    }
    let settings = crate::services::SettingsService::get_settings();
    let root = crate::services::resolve_claude_config_dir(settings.claude_hook_config_dir.as_deref())?;
    let roots = terminal_pids.iter().map(|(id, _)| (id.clone(), root.clone())).collect();
    let discovered = discover_claude_sessions(&terminal_pids, &roots);
    crate::services::claude_session_registry_service::merge(discovered, now_ms())?;
    // Codex 的绑定来自启动注入与日志上报，统一写入登记表。
    let bindings = crate::services::terminal_task_service::session_bindings();
    crate::services::claude_session_registry_service::merge_agents(bindings, now_ms())
}

/// relay 必须复用这条不受 showTaskSummary 开关控制的进程快照路径：
/// 只把已经过调用方鉴权的 terminalId 传进来（scan 缓存传的是服务端自有实例表）。
pub(crate) fn terminal_processes(ids: &[String], service: &TerminalService) -> Vec<(String, u32)> {
    let instances = service.lock_instances();
    ids.iter().filter_map(|id| instances.get(id).and_then(|instance| instance.process_id()).map(|pid| (id.clone(), pid))).collect()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTaskSummaries {
    enabled: bool,
    summaries: HashMap<String, crate::services::terminal_task_service::TerminalTaskSummary>,
    activities: HashMap<String, crate::services::ClaudeHookTerminalEvent>,
    providers: HashMap<String, String>,
}

/// 前端只传终端 ID；会话 ID 和文件路径始终由服务端发现。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_terminal_task_summaries(
    terminal_ids: Vec<String>,
    service: State<'_, TerminalService>,
) -> Result<TerminalTaskSummaries, String> {
    let enabled = crate::services::SettingsService::get_settings().show_task_summary;
    let activities = crate::services::codex_activity_service::snapshot(&terminal_ids);
    if !enabled {
        let providers = crate::services::terminal_task_service::current_providers(&terminal_ids);
        return Ok(TerminalTaskSummaries {
            enabled,
            summaries: HashMap::new(),
            activities,
            providers,
        });
    }
    let pids = terminal_processes(&terminal_ids, &service);
    let summaries = super::claude_task(move || Ok(crate::services::terminal_task_service::summaries(pids))).await?;
    let providers = crate::services::terminal_task_service::current_providers(&terminal_ids);
    Ok(TerminalTaskSummaries { enabled, summaries, activities, providers })
}
