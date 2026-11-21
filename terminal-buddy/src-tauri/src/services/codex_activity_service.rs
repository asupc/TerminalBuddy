//! Codex TUI 没有 Claude Hook：从确切绑定的 rollout 同步终端活动状态。
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

use crate::commands::TerminalService;
use crate::runtime::{AppHandle, Emitter, Manager};
use super::{codex_transcript, terminal_agent_relay, terminal_task_service, ClaudeHookTerminalEvent};

fn activities() -> &'static Mutex<HashMap<String, ClaudeHookTerminalEvent>> {
    static ACTIVITIES: OnceLock<Mutex<HashMap<String, ClaudeHookTerminalEvent>>> = OnceLock::new();
    ACTIVITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 页面重载后也能恢复当前灯态；不依赖任务摘要是否显示。
pub fn snapshot(terminal_ids: &[String]) -> HashMap<String, ClaudeHookTerminalEvent> {
    let current = activities().lock().unwrap_or_else(|error| error.into_inner());
    terminal_ids.iter().filter_map(|id| {
        let event = current.get(id)?;
        (terminal_task_service::current_binding(id) == Some(("codex".to_string(), event.session_id.clone())))
            .then(|| (id.clone(), event.clone()))
    }).collect()
}

#[derive(Clone, Default)]
struct RolloutState {
    phase: &'static str,
    turn_id: Option<String>,
    at: i64,
    summary: Option<String>,
    explicit_turn: bool,
}

fn parse_state(content: &str, previous: &RolloutState) -> RolloutState {
    let mut state = previous.clone();
    for line in content.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue; };
        let payload = &row["payload"];
        let kind = payload["type"].as_str().unwrap_or_default();
        let at = row.get("timestamp").and_then(codex_transcript::timestamp).unwrap_or(0);
        // 尾部窗口会重读旧记录；历史完成记录不能覆盖后来的回合。
        if at < state.at { continue; }
        let phase = match (row["type"].as_str().unwrap_or_default(), kind) {
            ("event_msg", "task_started" | "turn_started") => {
                state.explicit_turn = true;
                state.turn_id = payload["turn_id"].as_str().map(str::to_string);
                state.summary = None;
                Some("running")
            }
            ("event_msg", "task_complete" | "task_completed" | "turn_complete" | "turn_completed") => {
                state.explicit_turn = true;
                state.turn_id = payload["turn_id"].as_str().map(str::to_string).or(state.turn_id);
                state.summary = payload["last_agent_message"].as_str().map(|text| codex_transcript::excerpt(text, 220));
                Some("completed")
            }
            ("event_msg", "turn_aborted" | "task_cancelled" | "task_canceled") => {
                state.explicit_turn = true;
                Some("idle")
            }
            ("event_msg", "task_failed" | "turn_failed") => {
                state.explicit_turn = true;
                state.summary = payload["message"].as_str().map(|text| codex_transcript::excerpt(text, 220));
                Some("failed")
            }
            // 长回合的开始标记可能已不在尾部窗口中；工具与思考仍表示正在工作。
            ("response_item", "function_call" | "custom_tool_call" | "reasoning") if !state.explicit_turn || state.phase == "running" => Some("running"),
            ("response_item", "message") if !state.explicit_turn && payload["role"] == "assistant" => {
                match payload["phase"].as_str() {
                    Some("final" | "final_answer") => Some("completed"),
                    Some("commentary") => Some("running"),
                    _ => None,
                }
            }
            _ => None,
        };
        if let Some(phase) = phase {
            state.phase = phase;
            state.at = at;
        }
    }
    state
}

#[derive(Default)]
struct TrackedRollout {
    session_id: String,
    path: Option<PathBuf>,
    stamp: Option<(SystemTime, u64)>,
    state: RolloutState,
    published: Option<RolloutState>,
}

impl TrackedRollout {
    fn refresh(&mut self, terminal_id: &str) {
        let Some(location) = terminal_task_service::locate_transcript(terminal_id) else { return; };
        if location.provider != "codex" || location.session_id != self.session_id { return; }
        let Ok(mut file) = File::open(&location.path) else { return; };
        let Ok(metadata) = file.metadata() else { return; };
        let Ok(modified) = metadata.modified() else { return; };
        let stamp = (modified, metadata.len());
        if self.path.as_ref() == Some(&location.path) && self.stamp == Some(stamp) { return; }
        // 只读完整尾行，避免长会话每秒全量解析；未落完的 JSON 留待下次读取。
        let start = metadata.len().saturating_sub(512 * 1024);
        if file.seek(SeekFrom::Start(start)).is_err() { return; }
        let mut bytes = Vec::new();
        if file.take(512 * 1024).read_to_end(&mut bytes).is_err() { return; }
        let content = String::from_utf8_lossy(&bytes);
        let content = if start > 0 {
            content.split_once('\n').map(|(_, tail)| tail).unwrap_or_default()
        } else { &content };
        self.state = parse_state(content, &self.state);
        self.path = Some(location.path);
        self.stamp = Some(stamp);
    }

    fn changed(&self) -> bool {
        self.published.as_ref().map_or(true, |old| {
            old.phase != self.state.phase || old.turn_id != self.state.turn_id
                // 长回合心跳同时维持前端现有的 30 分钟执行态过期机制。
                || (self.state.phase == "running" && self.state.at.saturating_sub(old.at) >= 60_000)
        })
    }
}

fn publish(app: &AppHandle, terminal_id: &str, tracked: &TrackedRollout, phase: &str) {
    if terminal_task_service::current_binding(terminal_id) != Some(("codex".to_string(), tracked.session_id.clone())) { return; }
    let mut current = activities().lock().unwrap_or_else(|error| error.into_inner());
    let occurred_at = chrono::Utc::now().timestamp_millis().max(
        current.get(terminal_id).map_or(0, |event| event.occurred_at.saturating_add(1)),
    );
    let event = ClaudeHookTerminalEvent {
        event_id: uuid::Uuid::new_v4().to_string(), terminal_id: terminal_id.to_string(),
        session_id: tracked.session_id.clone(),
        event_name: if tracked.published.is_none() { "CodexTranscriptSnapshot" } else { "CodexTranscriptState" }.to_string(),
        phase: phase.to_string(), occurred_at, provider: Some("codex".to_string()),
        notification_type: None, title: None, message: None, task_title: None,
        summary: tracked.state.summary.clone(),
    };
    current.insert(terminal_id.to_string(), event.clone());
    drop(current);
    terminal_agent_relay::note_phase(terminal_id, "codex", &tracked.session_id, phase, occurred_at);
    let _ = app.emit("claude-hook-terminal-event", event);
}

/// 桌面与独立服务端共用：发现每 4 秒一次，已绑定转录每秒读取一次。
pub fn start(app: AppHandle) {
    crate::runtime::async_runtime::spawn(async move {
        let mut tracked = HashMap::<String, TrackedRollout>::new();
        let mut last_scan: Option<Instant> = None;
        let mut live = HashSet::new();
        loop {
            let no_instances = app.state::<TerminalService>().lock_instances().is_empty();
            let no_activities = activities().lock().map(|map| map.is_empty()).unwrap_or(false);
            if tracked.is_empty() && no_instances && no_activities {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            let poll_app = app.clone();
            let result = crate::runtime::async_runtime::spawn_blocking(move || {
                let service = poll_app.state::<TerminalService>();
                let ids: Vec<_> = service.lock_instances().keys().cloned().collect();
                let pids = crate::commands::claude_session::terminal_processes(&ids, &service);
                if last_scan.map_or(true, |at| at.elapsed() >= Duration::from_secs(4)) {
                    // 发现与灯态不受 showTaskSummary 控制，手动启动与 resume 也走同一绑定链；
                    // 直接复用同一份进程快照返回的 codex_live，避免重复扫描进程树。
                    live = terminal_task_service::summaries_with_codex_live(pids.clone()).1;
                    last_scan = Some(Instant::now());
                }
                let bindings = terminal_task_service::session_bindings();
                tracked.retain(|id, old| {
                    let same = bindings.get(id).is_some_and(|record| record.provider == "codex" && record.session_id == old.session_id);
                    if ids.contains(id) && same && !live.contains(id) { publish(&poll_app, id, old, "ended"); }
                    ids.contains(id) && same && live.contains(id)
                });
                activities().lock().unwrap_or_else(|error| error.into_inner()).retain(|id, _| {
                    ids.contains(id) && bindings.get(id).is_some_and(|record| record.provider == "codex")
                });
                for (id, record) in bindings {
                    if record.provider != "codex" || !live.contains(&id) { continue; }
                    let entry = tracked.entry(id.clone()).or_insert_with(|| TrackedRollout {
                        session_id: record.session_id, state: RolloutState { phase: "idle", ..Default::default() }, ..Default::default()
                    });
                    entry.refresh(&id);
                    if entry.changed() {
                        publish(&poll_app, &id, entry, entry.state.phase);
                        entry.published = Some(entry.state.clone());
                    }
                }
                (tracked, last_scan, live)
            }).await;
            match result {
                Ok((next_tracked, next_scan, next_live)) => { tracked = next_tracked; last_scan = next_scan; live = next_live; }
                Err(error) => { eprintln!("[CodexActivity] 状态同步失败：{error}"); break; }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}
