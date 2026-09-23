//! Claude Code 会话发现：通过终端进程树定位 ~/.claude/sessions/<pid>.json。

use crate::commands::terminal::TerminalService;
use serde::Deserialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use tauri::{command, State};

/// Claude Code 会话文件结构 (位于 ~/.claude/sessions/<pid>.json)
#[derive(Deserialize)]
struct ClaudeSessionFile {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

/// 一次性获取所有进程的父子关系，返回 (pid, parent_pid, name)
/// 使用 Windows API CreateToolhelp32Snapshot（几十毫秒），远快于 PowerShell/WMIC
fn get_all_processes() -> Vec<(u32, u32, String)> {
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

/// 在进程树中查找 Claude Code 进程（基于预加载的进程列表）
/// 只匹配进程名包含 "claude" 的进程，排除 node（避免 IDE/codegraph 误报）
fn find_claude_pids_in_tree(
    parent_pid: u32,
    all_processes: &[(u32, u32, String)],
    visited: &mut HashSet<u32>,
) -> Vec<u32> {
    let mut result = Vec::new();
    if visited.contains(&parent_pid) {
        return result;
    }
    visited.insert(parent_pid);

    for &(pid, ppid, ref name) in all_processes {
        if ppid == parent_pid {
            if name.contains("claude") {
                // 检查这个进程是否有对应的 session 文件
                let home = dirs::home_dir().unwrap_or_default();
                let session_file = home
                    .join(".claude")
                    .join("sessions")
                    .join(format!("{}.json", pid));
                if session_file.exists() {
                    result.push(pid);
                }
            }
            // 递归查找子进程（即使当前进程不是 claude，子进程也可能是）
            result.extend(find_claude_pids_in_tree(pid, all_processes, visited));
        }
    }

    result
}

/// 批量获取多个终端的 Claude Code 会话 ID
/// 只调用一次 CreateToolhelp32Snapshot，对所有终端在内存中查找，避免 N 次进程快照
#[command]
pub fn get_claude_sessions_for_terminals(
    terminal_ids: Vec<String>,
    service: State<'_, TerminalService>,
) -> Result<HashMap<String, String>, String> {
    // 1. 一次性获取所有终端的 PID
    let terminal_pids: Vec<(String, u32)> = {
        let instances = service.lock_instances();
        terminal_ids
            .iter()
            .filter_map(|id| {
                instances
                    .get(id)
                    .and_then(|instance| instance.process_id())
                    .map(|pid| (id.clone(), pid))
            })
            .collect()
    };

    if terminal_pids.is_empty() {
        return Ok(HashMap::new());
    }

    // 2. 一次性获取所有进程（Windows API，几十毫秒）
    let all_processes = get_all_processes();

    // 3. 对每个终端在进程树中查找 Claude session
    let home = dirs::home_dir().ok_or("无法获取用户主目录")?;
    let sessions_dir = home.join(".claude").join("sessions");

    let mut result = HashMap::new();

    for (terminal_id, pid) in &terminal_pids {
        let mut visited = HashSet::new();
        let claude_pids = find_claude_pids_in_tree(*pid, &all_processes, &mut visited);

        let mut best: Option<(String, u64)> = None;
        for claude_pid in claude_pids {
            let session_file = sessions_dir.join(format!("{}.json", claude_pid));
            if let Ok(content) = fs::read_to_string(&session_file) {
                if let Ok(session) = serde_json::from_str::<ClaudeSessionFile>(&content) {
                    match &best {
                        Some((_, ts)) if session.updated_at <= *ts => {}
                        _ => best = Some((session.session_id.clone(), session.updated_at)),
                    }
                }
            }
        }

        if let Some((id, _)) = best {
            result.insert(terminal_id.clone(), id);
        }
    }

    Ok(result)
}
