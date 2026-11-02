//! 原生 AI 会话：Claude print/stream-json 与 Codex app-server 的结构化消息适配。
//! CLI 进程在服务端执行，手机断开不会终止任务。所有文件/进程操作由 handler 的
//! spawn_blocking 或专用工作线程承载；用户文本只进入 stdin，不拼进 shell 命令。
use crate::models::ai_chat::*;
use super::{ai_chat_approval::{self as approval, ClaudeApproval}, ai_chat_usage as usage};
use super::ai_chat_claude_hooks::{NativeClaudeHooks, NativeHookEvent};
use super::{atomic_file::atomic_write_private, terminal_task_service::SessionSummaryTracker, PathService};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashMap, HashSet}, fs, io::{BufRead, BufReader, Read, Write}, path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, OnceLock, mpsc, atomic::{AtomicBool, AtomicUsize, Ordering}},
    thread, time::{Duration, Instant}};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
// 仅记录运行任务以便退出时收尾，不限制任务并发数。
static RUNNING: AtomicUsize = AtomicUsize::new(0);
struct RunningTask;
impl Drop for RunningTask { fn drop(&mut self) { RUNNING.fetch_sub(1, Ordering::Relaxed); } }

enum Control { Stop, Retire, Message { text: String, request_id: String }, Approval(AnswerAiApproval) }
enum WorkerExit { Completed, Retired }
struct Cell {
    data: Mutex<AiSession>,
    control: Mutex<Option<mpsc::Sender<Control>>>,
    summary: Mutex<SessionSummaryTracker>,
    deleted: AtomicBool,
    path: PathBuf,
}
fn registry() -> &'static Mutex<HashMap<PathBuf, Arc<Cell>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<Cell>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}
fn directory() -> Result<PathBuf> {
    let path = PathService::require_data_dir()?.join("AiSessions");
    fs::create_dir_all(&path).map_err(|e| format!("创建 AI 会话目录失败：{e}"))?;
    Ok(path)
}
fn touch(data: &mut AiSession) {
    data.updated_at = chrono::Utc::now().timestamp_millis();
    data.revision = data.revision.saturating_add(1).max(data.updated_at.max(0) as u64);
}
fn persist(cell: &Cell) -> Result<()> {
    let data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    persist_data(cell, &data)
}
fn persist_data(cell: &Cell, data: &AiSession) -> Result<()> {
    if cell.deleted.load(Ordering::Acquire) { return Err("AI 会话不存在".into()); }
    // API 序列化隐藏的字段在磁盘中单独保留。
    let mut value = serde_json::to_value(data).map_err(|e| e.to_string())?;
    value["owner"] = json!(data.owner);
    value["threadId"] = json!(data.thread_id);
    value["requestIds"] = json!(data.request_ids);
    value["usageCheckpoint"] = json!(data.usage_checkpoint);
    value["pendingInputs"] = json!(data.pending_inputs);
    atomic_write_private(&cell.path, &serde_json::to_vec(&value).map_err(|e| e.to_string())?)
        .map_err(|e| format!("保存 AI 会话失败：{e}"))
}
fn load(id: &str, owner: &str) -> Result<Arc<Cell>> {
    let id = Uuid::parse_str(id).map_err(|_| "AI 会话不存在")?.to_string();
    let path = directory()?.join(format!("{id}.json"));
    let mut registry = registry().lock().map_err(|_| "AI 会话状态不可用")?;
    if !registry.contains_key(&path) {
        let bytes = fs::read(&path).map_err(|_| "AI 会话不存在")?;
        let mut data: AiSession = serde_json::from_slice(&bytes).map_err(|_| "AI 会话文件损坏")?;
        if data.owner != owner { return Err("AI 会话不存在".into()); }
        // 兼容旧会话：尚未发送的排队消息只保留在队列，真正执行时再加入正文。
        let pending_ids: HashSet<_> = data.pending_inputs.iter().map(|item| item.request_id.as_str()).collect();
        let previous_count = data.messages.len();
        data.messages.retain(|message| !pending_ids.contains(message.id.as_str()));
        let migrated = data.messages.len() != previous_count;
        if migrated { touch(&mut data); }
        let interrupted = matches!(data.status.as_str(), "running" | "approval" | "background" | "stopping");
        if interrupted {
            data.status = "interrupted".into(); data.approvals.clear();
            usage::finish_turn(&mut data);
            data.error = Some("服务已重启，上次执行已中断，可以继续发送消息".into()); touch(&mut data);
            data.result_revision = data.revision;
        }
        let cell = Arc::new(Cell { data: Mutex::new(data), control: Mutex::new(None), summary: Mutex::default(), deleted: AtomicBool::new(false), path: path.clone() });
        // 重启中断标记与结束版本一起落盘，避免再次重启时重复生成同一结束事件。
        if interrupted || migrated { persist(&cell)?; }
        registry.insert(path.clone(), cell);
    }
    let cell = registry.get(&path).ok_or("AI 会话不存在")?.clone();
    if cell.data.lock().map_err(|_| "AI 会话状态不可用")?.owner != owner { return Err("AI 会话不存在".into()); }
    Ok(cell)
}
pub fn get(id: &str, owner: &str) -> Result<AiSession> {
    let cell = load(id, owner)?;
    let snapshot = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.clone();
    Ok(snapshot)
}
/// 列表、详情与 WebSocket 共用摘要刷新；会话内缓存限制磁盘检查频率。
pub fn get_with_summary(id: &str, owner: &str) -> Result<AiSession> {
    let cell = load(id, owner)?;
    refresh_title(&cell, false);
    let snapshot = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.clone();
    Ok(snapshot)
}
pub fn list(owner: &str) -> Result<Vec<AiSession>> {
    let mut sessions = Vec::new();
    for entry in fs::read_dir(directory()?).map_err(|e| e.to_string())?.flatten() {
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            if let Some(id) = entry.path().file_stem().and_then(|id| id.to_str()) {
                if let Ok(cell) = load(id, owner) {
                    refresh_title(&cell, false);
                    if let Ok(data) = cell.data.lock() { sessions.push(data.metadata()); };
                }
            }
        }
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(sessions)
}
fn new_session(owner: &str, input: CreateAiSession) -> Result<AiSession> {
    if !matches!(input.provider.as_str(), "claude" | "codex" | "pi") { return Err("请选择 Claude、Codex 或 Pi".into()); }
    if input.model.as_ref().is_some_and(|v| !v.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/[]@+".contains(c))) { return Err("模型名称无效".into()); }
    if let Some(resume_id) = input.resume_session_id.clone().filter(|id| !id.trim().is_empty()) {
        return resume_from_history(owner, input, &resume_id);
    }
    let selection = super::ai_catalog_service::selection(&input.provider, input.provider_id.as_deref(), input.model.as_deref())?;
    let id = Uuid::new_v4().to_string();
    let data = AiSession { id: id.clone(), title: "新对话".into(), provider: input.provider,
        provider_id: selection.as_ref().map(|(id, _)| id.clone()), provider_name: selection.map(|(_, name)| name),
        project_path: input.project_path, model: input.model.filter(|m| !m.trim().is_empty()),
        status: "idle".into(), messages: Vec::new(), approvals: Vec::new(), error: None,
        usage: Some(usage::initial()), usage_checkpoint: None,
        updated_at: chrono::Utc::now().timestamp_millis(), revision: 1, result_revision: 0, owner: owner.into(), thread_id: None, request_ids: Vec::new(), pending_inputs: Vec::new() };
    Ok(data)
}
fn save_new_session(data: AiSession) -> Result<AiSession> {
    let cell = Arc::new(Cell { data: Mutex::new(data.clone()), control: Mutex::new(None), summary: Mutex::default(), deleted: AtomicBool::new(false), path: directory()?.join(format!("{}.json", data.id)) });
    persist(&cell)?;
    registry().lock().map_err(|_| "AI 会话状态不可用")?.insert(cell.path.clone(), cell);
    Ok(data)
}

/// 恢复历史会话时预填的最大消息条数：按 seq 从尾部截取，避免超大转录拖慢创建。
const RESUME_PREFILL_MESSAGES: usize = 300;

/// CLI 历史会话的分发入口：三种 Agent 共用 `models::session_history` 协议。
pub fn list_history(agent: &str, include_archived: bool, project_dir: Option<&str>) -> Result<Vec<crate::models::session_history::SessionHistoryItem>> {
    match agent {
        "claude" => super::claude_history_service::list_sessions(include_archived, project_dir),
        "codex" => super::codex_history_service::list_sessions(include_archived, project_dir),
        "pi" => super::pi_history_service::list_sessions(include_archived, project_dir),
        _ => Err("未知 Agent，请选择 Claude、Codex 或 Pi".into()),
    }
}

/// 打开历史列表前的增量索引（与 PC 端历史面板同一入口，剩余由后台补齐）。
pub fn rescan_history(app: &crate::runtime::AppHandle, agent: &str) -> Result<crate::models::session_history::SessionHistoryScanResult> {
    match agent {
        "claude" => super::claude_history_service::scan_and_index(app),
        "codex" => super::codex_history_service::scan_and_index(app),
        "pi" => super::pi_history_service::scan_and_index(app),
        _ => Err("未知 Agent，请选择 Claude、Codex 或 Pi".into()),
    }
}

/// 读取历史会话回放页（分页），三种 Agent 返回同一协议结构。
pub fn replay_page(agent: &str, session_id: &str, offset: usize, limit: usize) -> Result<crate::models::session_history::SessionReplayPage> {
    match agent {
        "claude" => super::claude_history_service::get_replay(session_id, offset, limit),
        "codex" => super::codex_history_service::get_replay(session_id, offset, limit),
        "pi" => super::pi_history_service::get_replay(session_id, offset, limit),
        _ => Err("未知 Agent，请选择 Claude、Codex 或 Pi".into()),
    }
}

/// 从 CLI 历史会话恢复为原生 AI 会话：绑定历史线程并预填最近消息，之后的发送
/// 走各 Agent 已有的续接通道（Claude `--resume`、Codex `thread/resume`、Pi 复用会话文件）。
fn resume_from_history(owner: &str, input: CreateAiSession, resume_id: &str) -> Result<AiSession> {
    let provider = input.provider.as_str();
    // 第一页只取元数据：标题、项目目录与消息总数均来自历史索引。
    let first = replay_page(provider, resume_id, 0, 1)?;
    if first.project_dir.trim().is_empty() { return Err("历史会话缺少项目目录，无法恢复".into()); }
    let selection = super::ai_catalog_service::selection(provider, input.provider_id.as_deref(), input.model.as_deref())?;
    let provider_id = selection.as_ref().map(|(id, _)| id.clone());
    let model = input.model.filter(|model| !model.trim().is_empty());
    // 复用同一历史线程，并纠正之前恢复时被快速开始覆盖的模型配置。
    if let Some(existing) = find_by_thread(owner, provider, resume_id) {
        let cell = load(&existing.id, owner)?;
        let control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
        let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
        if data.provider_id != provider_id || data.model != model {
            if control.is_some() || matches!(data.status.as_str(), "running" | "approval" | "background" | "stopping") {
                return Err("该历史会话仍在执行，模型配置不一致，请先停止会话后重试".into());
            }
            let before = data.clone();
            data.provider_id = provider_id;
            data.provider_name = selection.map(|(_, name)| name);
            data.model = model;
            if let Some(usage) = data.usage.as_mut() { usage.context = AiContextUsage::default(); }
            touch(&mut data);
            if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
        }
        // 空闲会话重进时刷新预填：上次恢复后转录可能又有新输出（电脑端或 Web 端续写过），
        // 直接复用旧 messages 会让客户端看到落后于历史索引的旧数据。预填仍取自索引，
        // 客户端点按恢复前会先触发一次 rescan；刷新失败不阻断恢复，沿用旧消息。
        if reused_prefill_needs_refresh(data.status.as_str(), control.is_some()) {
            if let Ok(fresh) = prefill_history_messages(provider, resume_id, first.total.max(0) as usize) {
                if prefill_differs(&data.messages, &fresh) {
                    let before = data.clone();
                    data.messages = fresh;
                    // 只落盘消息，不动 updated_at / revision / 标题，避免最近列表重排与在途实时流被打扰。
                    if persist_data(&cell, &data).is_err() { *data = before; }
                }
            }
        }
        return Ok(data.clone());
    }
    // Pi 的 RPC 会话 ID 即 AiSession ID（进程按该 ID 落盘并复用同一会话文件）。
    let id = if provider == "pi" { resume_id.to_string() } else { Uuid::new_v4().to_string() };
    let path = directory()?.join(format!("{id}.json"));
    if provider == "pi" && path.is_file() {
        return Err("该 Pi 历史会话正被其他账号使用，无法恢复".into());
    }
    let title = if first.title.trim().is_empty() { "恢复的对话".to_string() } else { first.title };
    let messages = prefill_history_messages(provider, resume_id, first.total.max(0) as usize)?;
    let data = AiSession { id: id.clone(), title, provider: provider.to_string(),
        provider_id, provider_name: selection.map(|(_, name)| name),
        project_path: first.project_dir, model,
        status: "idle".into(), messages, approvals: Vec::new(), error: None,
        usage: Some(usage::initial()), usage_checkpoint: None,
        updated_at: chrono::Utc::now().timestamp_millis(), revision: 1, result_revision: 0,
        owner: owner.into(), thread_id: Some(resume_id.to_string()), request_ids: Vec::new(), pending_inputs: Vec::new() };
    let cell = Arc::new(Cell { data: Mutex::new(data.clone()), control: Mutex::new(None), summary: Mutex::default(), deleted: AtomicBool::new(false), path });
    persist(&cell)?;
    registry().lock().map_err(|_| "AI 会话状态不可用")?.insert(cell.path.clone(), cell);
    Ok(data)
}

/// 在已落盘的 AI 会话里找绑定同一历史线程的会话（磁盘 JSON 持久化过 owner 与 threadId）。
fn find_by_thread(owner: &str, provider: &str, thread_id: &str) -> Option<AiSession> {
    let dir = directory().ok()?;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext != "json") { continue; }
        let Ok(bytes) = fs::read(&path) else { continue };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { continue };
        if value["owner"] != owner || value["provider"] != provider || value["threadId"] != thread_id { continue; }
        if let Ok(data) = serde_json::from_slice::<AiSession>(&bytes) { return Some(data); }
    }
    None
}

/// 复用已恢复的历史会话时是否刷新预填：有进程在跑（control 存在）或状态属于执行中一律不动消息。
fn reused_prefill_needs_refresh(status: &str, has_control: bool) -> bool {
    !has_control && !matches!(status, "running" | "approval" | "background" | "stopping")
}

/// 预填差异判定：条数或任一条 id/role/text/created_at 变化即视为有新内容（AiMessage 未实现 PartialEq）。
fn prefill_differs(old: &[AiMessage], fresh: &[AiMessage]) -> bool {
    old.len() != fresh.len() || old.iter().zip(fresh).any(|(a, b)| {
        a.id != b.id || a.role != b.role || a.text != b.text || a.created_at != b.created_at
    })
}

/// 预填历史消息：按 seq 保留最近若干条，角色收敛到客户端支持的三种。
fn prefill_history_messages(provider: &str, session_id: &str, total: usize) -> Result<Vec<AiMessage>> {
    if total == 0 { return Ok(Vec::new()); }
    let mut messages = Vec::new();
    let mut offset = total.saturating_sub(RESUME_PREFILL_MESSAGES);
    while offset < total {
        let page = replay_page(provider, session_id, offset, 100)?;
        if page.messages.is_empty() { break; }
        let mut advanced = false;
        for item in page.messages {
            if offset >= total { break; }
            offset += 1; advanced = true;
            if !matches!(item.role.as_str(), "user" | "assistant" | "tool") || item.text.trim().is_empty() { continue; }
            messages.push(AiMessage { id: format!("history-{}", item.seq), role: item.role, text: item.text, created_at: item.timestamp.unwrap_or(0) });
        }
        if !advanced { break; }
    }
    Ok(messages)
}
pub fn create(owner: &str, input: CreateAiSession) -> Result<AiSession> {
    if input.resume_session_id.as_deref().is_some_and(|id| !id.trim().is_empty()) { return new_session(owner, input); }
    save_new_session(new_session(owner, input)?)
}

fn history_messages(session_id: &str, history: &crate::models::session_history::SessionReplayPage) -> Vec<AiMessage> {
    history.messages.iter().filter_map(|message| {
        let mut parts = Vec::new();
        if !message.text.trim().is_empty() { parts.push(message.text.clone()); }
        for tool in &message.tools {
            parts.push(if tool.summary.is_empty() { tool.name.clone() } else { format!("{}\n{}", tool.name, tool.summary) });
        }
        if parts.is_empty() { return None; }
        Some(AiMessage { id: format!("history-{session_id}-{}", message.seq), role: message.role.clone(),
            text: parts.join("\n\n"), created_at: message.timestamp.unwrap_or(history.updated_at) })
    }).collect()
}

/// 保留原生 threadId，首条新消息走现有 thread/resume，而非新建无上下文的线程。
pub fn resume_codex_history(owner: &str, session_id: &str, project_path: String, input: ResumeCodexHistory,
    history: crate::models::session_history::SessionReplayPage) -> Result<AiSession> {
    Uuid::parse_str(session_id).map_err(|_| "Codex 历史会话标识无效")?;
    static RESUME_LOCK: Mutex<()> = Mutex::new(());
    let _guard = RESUME_LOCK.lock().map_err(|_| "历史会话恢复锁不可用")?;
    let mut data = new_session(owner, CreateAiSession { provider: "codex".into(), provider_id: input.provider_id,
        project_path, model: input.model, resume_session_id: None })?;
    // 网络重试或重复点击复用同账号、同线程和同启动配置的会话，不产生重复副本。
    for item in list(owner)? {
        let Ok(existing) = get(&item.id, owner) else { continue; };
        if existing.provider == "codex" && existing.thread_id.as_deref() == Some(session_id)
            && existing.project_path == data.project_path && existing.provider_id == data.provider_id && existing.model == data.model {
            return Ok(existing);
        }
    }
    data.title = history.title.clone();
    data.thread_id = Some(session_id.into());
    data.messages = history_messages(session_id, &history);
    // 历史索引缺少完整缓存与推理分项，不把不完整的旧统计冒充完整累计。
    data.usage = None;
    save_new_session(data)
}
pub fn delete(id: &str, owner: &str) -> Result<()> {
    let cell = load(id, owner)?;
    let mut control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    let data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if control.is_some() && data.status != "idle" {
        return Err("会话正在执行，请先中断再删除".into());
    }
    fs::remove_file(&cell.path).map_err(|e| format!("删除 AI 会话失败：{e}"))?;
    cell.deleted.store(true, Ordering::Release);
    // 空闲会话仍保留常驻 CLI 进程；删除时退出，但不能再执行普通收尾把文件写回来。
    if let Some(tx) = control.take() { let _ = tx.send(Control::Retire); }
    drop(data);
    registry().lock().map_err(|_| "AI 会话状态不可用")?.remove(&cell.path);
    Ok(())
}
pub fn stop(id: &str, owner: &str) -> Result<()> {
    let cell = load(id, owner)?;
    if let Some(tx) = cell.control.lock().map_err(|_| "AI 会话状态不可用")?.as_ref() {
        tx.send(Control::Stop).map_err(|_| "执行已经结束")?;
        update(&cell, |data| data.status = "stopping".into());
    }
    Ok(())
}
pub fn answer(id: &str, owner: &str, input: AnswerAiApproval) -> Result<()> {
    let cell = load(id, owner)?;
    let pending = {
        let data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
        let pending = data.approvals.iter().find(|a| a.id == input.approval_id).ok_or("该请求已经结束，请刷新会话")?;
        approval::validate(pending, &input)?;
        pending.clone()
    };
    if pending.method == approval::CLAUDE_HOOK_METHOD {
        if input.decision == "accept" {
            super::ClaudeHookService::answer_all(&input.approval_id, approval::claude_hook_answers(&pending, &input)?)?;
        } else { super::ClaudeHookService::decline(&input.approval_id)?; }
        update(&cell, |data| {
            data.approvals.retain(|item| item.id != input.approval_id);
            if data.status == "approval" && data.approvals.is_empty() { data.status = "running".into(); }
        });
        return Ok(());
    }
    let result = cell.control.lock().map_err(|_| "AI 会话状态不可用")?.as_ref().ok_or("执行已经结束")?
        .send(Control::Approval(input)).map_err(|_| "执行已经结束".to_string());
    result
}
pub fn send(id: &str, owner: &str, input: SendAiMessage) -> Result<AiSession> {
    let cell = load(id, owner)?;
    if input.text.trim().is_empty() { return Err("消息不能为空".into()); }
    Uuid::parse_str(&input.request_id).map_err(|_| "消息请求标识无效")?;
    let mut control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if !cell.path.is_file() { return Err("AI 会话不存在".into()); }
    if data.request_ids.contains(&input.request_id) { return Ok(data.clone()); }
    // 原生插话，或会话空闲且没有排队消息时，直接把消息交给当前 CLI 进程。
    // 插话由 CLI 自己决定在合适节点消费；排队则等当前回合任务完全结束后再写入同一个进程。
    let idle_delivery = data.status == "idle" && data.pending_inputs.is_empty();
    if let Some(tx) = control.as_ref().filter(|_| data.status != "stopping" && (input.steer || idle_delivery)) {
        return deliver_now(&cell, &mut data, tx, input.request_id, input.text);
    }
    if control.is_some() {
        // 执行期间只入队，当前回合结束后由 worker 直接写入同一个 CLI 进程，不需要 --resume。
        let before = data.clone();
        data.request_ids.push(input.request_id.clone());
        data.pending_inputs.push(PendingInput { text: input.text, request_id: input.request_id });
        touch(&mut data);
        let snapshot = data.clone();
        if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
        return Ok(snapshot);
    }
    let before = data.clone();
    data.request_ids.push(input.request_id.clone());
    // 新消息进队尾，先启动队首：中断/出错后保留的排队消息仍按用户发送顺序执行。
    data.pending_inputs.push(PendingInput { text: input.text, request_id: input.request_id });
    let next = begin_pending_turn(&mut data).ok_or("没有排队中的消息")?;
    let snapshot = data.clone();
    if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
    if let Err(error) = start_turn(&cell, next, &mut control) {
        // 保持发送与 worker 安装串行，失败时还原本次发送。
        *data = before;
        persist_data(&cell, &data)?;
        return Err(error);
    }
    Ok(snapshot)
}

/// 把指定排队消息立即插话到当前回合：直接交给运行中的 CLI 进程，由它选择合适节点接收，
/// 不中断当前任务。worker 已退出（中断/出错后队列保留）时按选中消息启动新回合，其余随后自动续发。
pub fn flush(id: &str, owner: &str, request_id: Option<&str>) -> Result<()> {
    let cell = load(id, owner)?;
    let mut control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if !cell.path.is_file() { return Err("AI 会话不存在".into()); }
    if data.status == "stopping" { return Err("正在中断当前回复，请稍候".into()); }
    if data.pending_inputs.is_empty() { return Err("没有排队中的消息".into()); }
    let index = match request_id {
        Some(request_id) => data.pending_inputs.iter().position(|item| item.request_id == request_id)
            .ok_or("该消息不在排队队列中")?,
        None => 0,
    };
    let before = data.clone();
    if let Some(tx) = control.as_ref() {
        // 运行中或空闲常驻：直接把选中的消息交给当前 CLI 进程，不重置队列顺序，也不打断当前任务。
        let item = data.pending_inputs.remove(index);
        accept_input(&mut data, &item.request_id, &item.text);
        if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
        if tx.send(Control::Message { text: item.text, request_id: item.request_id }).is_err() {
            *data = before;
            persist_data(&cell, &data)?;
            return Err("服务端进程已退出，请再次发送消息".into());
        }
        return Ok(());
    }
    // worker 已退出（中断/出错后队列保留）：把选中消息移到队首并启动新回合，其余随后自动续发。
    if index > 0 {
        let item = data.pending_inputs.remove(index);
        data.pending_inputs.insert(0, item);
    }
    let next = begin_pending_turn(&mut data).ok_or("没有排队中的消息")?;
    if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
    if let Err(error) = start_turn(&cell, next, &mut control) {
        *data = before;
        data.status = "error".into(); data.error = Some(error.clone()); touch(&mut data);
        data.result_revision = data.revision;
        persist_data(&cell, &data)?;
        return Err(error);
    }
    Ok(())
}

/// 直接交付给运行中的 CLI：消息立即进入聊天记录并置为执行中，
/// 由 worker 决定是插话到当前回合还是开始新回合。
fn deliver_now(cell: &Cell, data: &mut AiSession, control: &mpsc::Sender<Control>,
    request_id: String, text: String) -> Result<AiSession> {
    let before = data.clone();
    accept_input(data, &request_id, &text);
    let snapshot = data.clone();
    if let Err(error) = persist_data(cell, data) { *data = before; return Err(error); }
    if control.send(Control::Message { text, request_id }).is_err() {
        *data = before;
        persist_data(cell, data)?;
        return Err("服务端进程已退出，请再次发送消息".into());
    }
    Ok(snapshot)
}

/// 立即写入聊天记录；排队消息出队时由 begin_pending_turn 完成同样的登记。
fn accept_input(data: &mut AiSession, request_id: &str, text: &str) {
    if !data.request_ids.iter().any(|id| id == request_id) { data.request_ids.push(request_id.to_string()); }
    data.messages.push(AiMessage { id: request_id.to_string(), role: "user".into(), text: text.into(),
        created_at: chrono::Utc::now().timestamp_millis() });
    if data.title == "新对话" { data.title = text.trim().chars().take(36).collect(); }
    // 等待确认时保留 approval 状态，让决策卡片继续显示；其余情况视为执行中。
    if data.approvals.is_empty() { data.status = "running".into(); }
    data.error = None;
    touch(data);
}

/// 原地编辑队列，不改变消息的请求标识与排队顺序。
pub fn update_pending_input(id: &str, owner: &str, request_id: &str, text: String) -> Result<AiSession> {
    if text.trim().is_empty() { return Err("消息不能为空".into()); }
    change_pending_input(id, owner, request_id, Some(text))
}

pub fn delete_pending_input(id: &str, owner: &str, request_id: &str) -> Result<AiSession> {
    change_pending_input(id, owner, request_id, None)
}

fn change_pending_input(id: &str, owner: &str, request_id: &str, text: Option<String>) -> Result<AiSession> {
    let cell = load(id, owner)?;
    // 与发送、删除会话、回合交接串行；已被 worker 取走的消息不能再编辑或删除。
    let _control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if !cell.path.is_file() { return Err("AI 会话不存在".into()); }
    let index = data.pending_inputs.iter().position(|item| item.request_id == request_id)
        .ok_or("该消息已发送或已移出队列，请刷新会话")?;
    let before = data.clone();
    match text {
        Some(text) => data.pending_inputs[index].text = text,
        None => { data.pending_inputs.remove(index); },
    }
    // 删除后仍保留 request_ids 去重记录，避免旧的发送重试令消息重新入队。
    touch(&mut data);
    if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
    Ok(data.clone())
}

/// 调用方持有 control 和 data 锁直到 worker 安装完成，避免队列交接时重复启动。
fn start_turn(cell: &Arc<Cell>, next: PendingInput, control: &mut Option<mpsc::Sender<Control>>) -> Result<()> {
    let thread_name = cell.path.file_stem().and_then(|id| id.to_str())
        .map(|id| format!("ai-{id}")).unwrap_or_else(|| "ai-turn".into());
    RUNNING.fetch_add(1, Ordering::Relaxed);
    let task = RunningTask;
    let (tx, rx) = mpsc::channel();
    *control = Some(tx);
    let worker_cell = cell.clone();
    if let Err(error) = thread::Builder::new().name(thread_name).spawn(move || {
        let _task = task;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_turn(&worker_cell, &next.text, rx)))
            .unwrap_or_else(|_| Err("AI 执行意外结束，可以重新发送消息".into()));
        match result {
            Ok(WorkerExit::Retired) => {},
            result => finish(&worker_cell, result.map(|_| ())),
        }
    }) {
        *control = None;
        return Err(format!("启动 AI 任务失败：{error}"));
    }
    Ok(())
}

/// 真正开始执行时才把队首加入聊天记录，三种 Agent 共用同一出队逻辑。
fn begin_pending_turn(data: &mut AiSession) -> Option<PendingInput> {
    if data.pending_inputs.is_empty() { return None; }
    let next = data.pending_inputs.remove(0);
    data.messages.push(AiMessage { id: next.request_id.clone(), role: "user".into(), text: next.text.clone(),
        created_at: chrono::Utc::now().timestamp_millis() });
    if data.title == "新对话" { data.title = next.text.trim().chars().take(36).collect(); }
    usage::begin_turn(data);
    data.status = "running".into(); data.error = None; data.approvals.clear(); touch(data);
    Some(next)
}
/// 常驻进程空闲后持续检查队列，覆盖结算事件之后才到达的新消息。
fn take_pending_if_idle(cell: &Cell) -> Result<Option<PendingInput>> {
    let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if data.status != "idle" || data.pending_inputs.is_empty() { return Ok(None); }
    let before = data.clone();
    let next = begin_pending_turn(&mut data);
    if let Err(error) = persist_data(cell, &data) { *data = before; return Err(error); }
    Ok(next)
}
fn active_request_id(data: &AiSession) -> Option<&str> {
    data.messages.iter().rev().find(|message| message.role == "user").map(|message| message.id.as_str())
}
fn refresh_title(cell: &Cell, force: bool) {
    // 正文轮询不等待其他客户端的扫描；回合结束时等待后强制刷新。
    let summary = if force { cell.summary.lock().ok() } else { cell.summary.try_lock().ok() };
    let Some(mut summary) = summary else { return; };
    let (provider, session_id, project_path) = {
        let Ok(data) = cell.data.lock() else { return; };
        let Some(session_id) = &data.thread_id else { return; };
        (data.provider.clone(), session_id.clone(), data.project_path.clone())
    };
    let Some(title) = summary.refresh(&provider, &session_id, &project_path, force) else { return; };
    // 保存失败保留旧标题，下次轮询重试，不打断正文流。
    let _ = save_summary_title(cell, &provider, &session_id, title);
}
fn save_summary_title(cell: &Cell, provider: &str, session_id: &str, title: String) -> Result<()> {
    // 与发送、删除及回合收尾串行，避免删除后被摘要刷新重新创建。
    let _control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if data.provider != provider || data.thread_id.as_deref() != Some(session_id) || data.title == title {
        return Ok(());
    }
    if !cell.path.is_file() { return Err("AI 会话不存在".into()); }
    let previous_title = std::mem::replace(&mut data.title, title);
    let previous_revision = data.revision;
    // 只更新标题与版本；正文继续变化不会导致摘要丢失，也不改变列表活动顺序。
    data.revision = data.revision.saturating_add(1);
    if let Err(error) = persist_data(cell, &data) {
        data.title = previous_title;
        data.revision = previous_revision;
        return Err(error);
    }
    Ok(())
}
fn finish(cell: &Arc<Cell>, result: Result<()>) {
    let succeeded = result.is_ok();
    refresh_title(cell, true);
    let Ok(mut control) = cell.control.lock() else { return; };
    let Ok(mut data) = cell.data.lock() else { return; };
    let was_active = matches!(data.status.as_str(), "running" | "approval" | "background" | "stopping");
    data.approvals.clear();
    usage::finish_turn(&mut data);
    match result {
        Ok(()) => { data.status = "idle".into(); data.error = None; }
        Err(error) => { data.status = if error == "已中断" { "interrupted" } else { "error" }.into(); data.error = Some(error); }
    }
    touch(&mut data);
    // 空闲常驻进程退出时不重复生成正常完成事件。
    if was_active || data.status != "idle" { data.result_revision = data.revision; }
    *control = None;
    let settled = data.clone();
    // 收尾、出队、持久化与安装下一回合共用锁，其他发送不能插入交接窗口。
    let next = if succeeded { begin_pending_turn(&mut data) } else { None };
    let started = persist_data(cell, &data).and_then(|_| {
        if let Some(next) = next { start_turn(cell, next, &mut control) } else { Ok(()) }
    });
    if let Err(error) = started {
        // 保存或启动失败时还原队列，消息不会被提前移出或写入聊天记录。
        *data = settled;
        data.status = "error".into(); data.error = Some(error); touch(&mut data);
        data.result_revision = data.revision;
        let _ = persist_data(cell, &data);
    }
}
fn update(cell: &Cell, action: impl FnOnce(&mut AiSession)) {
    if let Ok(mut data) = cell.data.lock() { action(&mut data); touch(&mut data); }
}
fn update_usage(cell: &Cell, action: impl FnOnce(&mut AiSession) -> bool) {
    if let Ok(mut data) = cell.data.lock() { if action(&mut data) { touch(&mut data); } }
}
fn message(cell: &Cell, key: &str, role: &str, text: &str, append: bool) {
    if text.is_empty() { return; }
    update(cell, |data| {
        if let Some(item) = data.messages.iter_mut().find(|m| m.id == key) {
            if append { item.text.push_str(text); } else { item.text = text.into(); }
        } else {
            data.messages.push(AiMessage { id: key.into(), role: role.into(), text: text.into(), created_at: chrono::Utc::now().timestamp_millis() });
        }
    });
}
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        { let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", self.0.id())]).stdout(Stdio::null()).stderr(Stdio::null()).status(); }
        #[cfg(windows)]
        { let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &self.0.id().to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status(); }
        let _ = self.0.kill(); let _ = self.0.wait();
    }
}
fn cli_command(provider: &str) -> Command {
    let configured = std::env::var_os(match provider {
        "claude" => "TERMINAL_BUDDY_CLAUDE_BIN", "codex" => "TERMINAL_BUDDY_CODEX_BIN", _ => "TERMINAL_BUDDY_PI_BIN",
    });
    let mut path = configured.map(PathBuf::from).unwrap_or_else(|| PathBuf::from(provider));
    if path.components().count() == 1 {
        if let Some(home) = dirs::home_dir() {
            let candidate = home.join(".local/bin").join(if cfg!(windows) { format!("{provider}.exe") } else { provider.into() });
            if candidate.is_file() { path = candidate; }
        }
    }
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = if path.extension().is_some_and(|ext| ext == "exe") { Command::new(&path) }
        else { let mut command = Command::new("cmd.exe"); command.args(["/D", "/C"]).arg(&path); command };
        command.creation_flags(0x0800_0000); command
    };
    #[cfg(not(windows))]
    let mut command = Command::new(path);
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; command.process_group(0); }
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}
fn write_json(stdin: &mut impl Write, value: Value) -> Result<()> {
    serde_json::to_writer(&mut *stdin, &value).map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").and_then(|_| stdin.flush()).map_err(|e| format!("AI 输入通道已关闭：{e}"))
}
/// 写入一条 Claude 用户消息。进程常驻时后续回合复用同一个 stdin，因此不能关闭它或改用 --resume。
fn write_claude_user(stdin: &mut impl Write, session_id: &str, text: &str) -> Result<()> {
    write_json(stdin, json!({"type":"user","message":{"role":"user","content":text},
        "parent_tool_use_id":null,"session_id":session_id}))
}
/// 当前回合任务全部结束后，把队首消息直接写入同一个 Claude 进程。
fn take_pending_for_claude(cell: &Cell, stdin: &mut impl Write) -> Result<Option<()>> {
    let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if data.status != "idle" || data.pending_inputs.is_empty() { return Ok(None); }
    let before = data.clone();
    let next = begin_pending_turn(&mut data).ok_or("没有排队中的消息")?;
    let session_id = data.thread_id.clone().unwrap_or_default();
    if let Err(error) = persist_data(cell, &data) { *data = before; return Err(error); }
    if let Err(error) = write_claude_user(stdin, &session_id, &next.text) {
        *data = before;
        let _ = persist_data(cell, &data);
        return Err(error);
    }
    Ok(Some(()))
}
fn run_turn(cell: &Cell, prompt: &str, controls: mpsc::Receiver<Control>) -> Result<WorkerExit> {
    let session = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.clone();
    let mut launch = super::ai_catalog_service::prepare(&session.provider, session.provider_id.as_deref(), session.model.as_deref())?;
    let hooks = if session.provider == "claude" {
        let hooks = NativeClaudeHooks::register()?;
        launch.enable_claude_hooks()?;
        Some(hooks)
    } else { None };
    let permissions = super::ai_permission_service::for_agent(&session.provider)?;
    update(cell, |data| usage::configured_window(data, launch.context_window));
    let mut command = cli_command(&session.provider);
    command.args(&launch.args);
    command.current_dir(&session.project_path);
    if let Some(hooks) = &hooks { hooks.configure(&mut command); }
    if session.provider == "claude" {
        command.args(&permissions.claude_args);
        command.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--permission-prompt-tool", "stdio"]);
        if let Some(id) = &session.thread_id { command.arg("--resume").arg(id); }
        if let Some(model) = &session.model { command.arg("--model").arg(model); }
    } else if session.provider == "pi" {
        // 注入 TerminalBuddy 扩展：无环境变量时完全 no-op，工具审批开关经环境变量开启。
        if let Ok(path) = super::pi_extension_service::ensure_extension() {
            command.arg("--extension").arg(path);
        }
        // RPC 会话 ID 直接复用 AiSession ID：Pi 按该 ID 落盘并复用同一会话文件，
        // 会话目录随 current_dir 归档，历史索引与标题摘要据此绑定。
        command.args(["--mode", "rpc", "--session-id"]).arg(&session.id);
    } else {
        // 新旧对话均优先使用普通模式的标准提问工具；动态工具仅作补充。
        command.args(&permissions.codex_args).args(["-c", "features.default_mode_request_user_input=true"]).arg("app-server");
    }
    let mut process = Process(command.spawn().map_err(|e| format!("无法启动 {}，请确认服务端已安装并配置该 CLI：{e}", session.provider))?);
    let mut stdin = process.0.stdin.take().ok_or("AI 输入通道不可用")?;
    let stdout = process.0.stdout.take().ok_or("AI 输出通道不可用")?;
    let stderr = process.0.stderr.take().ok_or("AI 错误通道不可用")?;
    let errors = Arc::new(Mutex::new(String::new()));
    let error_buffer = errors.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr); let mut buffer = [0; 2048];
        while let Ok(size) = reader.read(&mut buffer) { if size == 0 { break; }
            if let Ok(mut text) = error_buffer.lock() { text.push_str(&String::from_utf8_lossy(&buffer[..size])); }
        }
    });
    let (tx, output) = mpsc::sync_channel(64);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut bytes = Vec::new();
            let result = reader.read_until(b'\n', &mut bytes);
            match result {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) { if tx.send(Ok(value)).is_err() { break; } }
                }
                Err(error) => { let _ = tx.send(Err(format!("读取 AI 输出失败：{error}"))); break; }
            }
        }
    });
    if session.provider == "claude" {
        write_claude_user(&mut stdin, session.thread_id.as_deref().unwrap_or(""), prompt)?;
        run_claude(cell, &mut process, stdin, controls, output, errors, hooks.as_ref().ok_or("Claude 决策 Hook 未初始化")?)
    } else if session.provider == "pi" {
        run_pi(cell, &session, prompt, stdin, controls, output, errors)
    } else {
        write_json(&mut stdin, json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"terminal_buddy_native","version":"1.0.0"},"capabilities":{"experimentalApi":true}}}))?;
        run_codex(cell, &session, prompt, &permissions, &mut stdin, controls, output, errors)
    }
}
fn next_output(output: &mpsc::Receiver<Result<Value>>, errors: &Mutex<String>) -> Result<Option<Value>> {
    match output.recv_timeout(Duration::from_millis(100)) {
        Ok(value) => value.map(Some),
        Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
        Err(_) => {
            let details = errors.lock().map(|e| e.clone()).unwrap_or_default();
            Err(if details.trim().is_empty() { "AI 进程已退出，未收到完成事件".into() } else { format!("AI 进程已退出：{}", details.trim()) })
        }
    }
}
#[derive(Default)]
struct ClaudeContentBlock {
    kind: String,
    started: bool,
    completed: bool,
}
#[derive(Default)]
struct ClaudeMessageBlocks {
    blocks: BTreeMap<u64, ClaudeContentBlock>,
    next_index: u64,
}
#[derive(Default)]
struct ClaudeOutputState {
    message_number: u64,
    current_message: String,
    messages: HashMap<String, ClaudeMessageBlocks>,
    seen_uuids: HashSet<String>,
    response_start: usize,
    response_number: u64,
    response_completed: bool,
    usage: usage::ClaudeUsageTracker,
}
impl ClaudeOutputState {
    fn stream(&mut self, cell: &Cell, turn: &str, event: &Value) {
        match event["type"].as_str().unwrap_or("") {
            "message_start" => {
                self.message_number += 1;
                self.current_message = event["message"]["id"].as_str().map(str::to_string)
                    .unwrap_or_else(|| format!("message-{}", self.message_number));
                self.messages.entry(self.current_message.clone()).or_default();
            }
            "content_block_start" | "content_block_delta" => {
                let Some(index) = event["index"].as_u64() else { return; };
                let blocks = self.messages.entry(self.current_message.clone()).or_default();
                blocks.next_index = blocks.next_index.max(index.saturating_add(1));
                let block = blocks.blocks.entry(index).or_default();
                if block.completed { return; }
                let key = format!("{turn}-text-{}-{index}", self.current_message);
                if event["type"] == "content_block_start" {
                    if block.started { return; }
                    block.started = true;
                    block.kind = event["content_block"]["type"].as_str().unwrap_or("").into();
                    if block.kind == "text" {
                        message(cell, &key, "assistant", event["content_block"]["text"].as_str().unwrap_or(""), true);
                    }
                } else if event["delta"]["type"] == "text_delta" {
                    block.kind = "text".into();
                    message(cell, &key, "assistant", event["delta"]["text"].as_str().unwrap_or(""), true);
                }
            }
            _ => {}
        }
    }
    fn assistant(&mut self, cell: &Cell, turn: &str, assistant: &Value) {
        let Some(content) = assistant["content"].as_array() else { return; };
        let id = assistant["id"].as_str().unwrap_or(&self.current_message);
        let blocks = self.messages.entry(id.to_string()).or_default();
        for (offset, item) in content.iter().enumerate() {
            let kind = item["type"].as_str().unwrap_or("");
            // 单块完成消息的数组下标会重置，按原始块顺序和类型领取尚未完成的块。
            // 保留每个块的状态，避免依赖最近事件的位置，兼容停止事件及后续块先到达。
            let index = if content.len() == 1 {
                blocks.blocks.iter().find(|(_, block)| !block.completed && block.kind == kind)
                    .map(|(&index, _)| index).unwrap_or(blocks.next_index)
            } else { offset as u64 };
            blocks.next_index = blocks.next_index.max(index.saturating_add(1));
            let block = blocks.blocks.entry(index).or_default();
            block.kind = kind.into(); block.completed = true;
            if kind == "text" {
                message(cell, &format!("{turn}-text-{id}-{index}"), "assistant", item["text"].as_str().unwrap_or(""), false);
            }
            if kind == "tool_use" {
                message(cell, &format!("{turn}-tool-{}", item["id"]), "tool",
                    &format!("{}\n{}", item["name"].as_str().unwrap_or("工具调用"), item["input"]), false);
            }
        }
    }
}
fn apply_claude_event(cell: &Cell, turn: &str, state: &mut ClaudeOutputState, value: &Value) -> Result<bool> {
    if let Some(uuid) = value["uuid"].as_str().filter(|id| !id.is_empty()) {
        let event_key = format!("{}:{uuid}", value["type"].as_str().unwrap_or(""));
        if !state.seen_uuids.insert(event_key) { return Ok(false); }
    }
    // 后台任务唤醒主会话后还会产生新的回复与 result，不能沿用上一段的已结算用量。
    if state.response_completed && (value["type"] == "assistant"
        || value["type"] == "stream_event" && value["event"]["type"] == "message_start") {
        state.usage = usage::ClaudeUsageTracker::default();
        state.response_completed = false;
    }
    update_usage(cell, |data| state.usage.observe(data, value));
    if let Some(id) = value["session_id"].as_str() { update(cell, |data| data.thread_id = Some(id.into())); }
    match value["type"].as_str().unwrap_or("") {
        "stream_event" => state.stream(cell, turn, &value["event"]),
        "assistant" => state.assistant(cell, turn, &value["message"]),
        "user" => {
            if let Some(blocks) = value["message"]["content"].as_array() {
                for item in blocks { if item["type"] == "tool_result" {
                    let body = item["content"].as_str().map(str::to_string).unwrap_or_else(|| item["content"].to_string());
                    message(cell, &format!("{turn}-result-{}", item["tool_use_id"]), "tool", &body, false);
                } }
            }
        }
        "result" => {
            if value["is_error"] == true { return Err(value["result"].as_str().map(str::to_string).unwrap_or_else(|| value["errors"].to_string())); }
            if let Some(text) = value["result"].as_str() {
                let has_answer = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.messages.iter()
                    .skip(state.response_start).any(|m| m.id.starts_with(turn) && m.role == "assistant");
                if !has_answer { message(cell, &format!("{turn}-result-{}", state.response_number), "assistant", text, false); }
            }
            if let Some(denials) = value["permission_denials"].as_array().filter(|items| !items.is_empty()) {
                message(cell, &format!("{turn}-permissions"), "tool", "部分工具操作未获服务端权限。请在服务端配置 Claude 的工具权限后重试。", false);
                let _ = denials;
            }
            state.response_start = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.messages.len();
            state.response_number += 1;
            state.response_completed = true;
            return Ok(true);
        }
        _ => {}
    }
    Ok(false)
}
#[derive(Default)]
struct ClaudeBackgroundTasks {
    tasks: HashSet<String>,
    has_snapshot: bool,
}
impl ClaudeBackgroundTasks {
    fn observe(&mut self, cell: &Cell, turn: &str, value: &Value) {
        if value["type"] != "system" { return; }
        let subtype = value["subtype"].as_str().unwrap_or("");
        if subtype == "background_tasks_changed" {
            if let Some(tasks) = value["tasks"].as_array() {
                // 新版 CLI 的完整快照优先于开始/完成事件，两者的到达顺序没有保证。
                self.has_snapshot = true;
                self.tasks = tasks.iter().filter(|task| task["ambient"] != true && task["awaited"] != true)
                    .filter_map(|task| task["task_id"].as_str().filter(|id| !id.is_empty()).map(str::to_string)).collect();
            }
            return;
        }
        if !matches!(subtype, "task_started" | "task_progress" | "task_notification") { return; }
        if value["ambient"] == true || value["awaited"] == true { return; }
        let Some(id) = value["task_id"].as_str().filter(|id| !id.is_empty()) else { return; };
        if !self.has_snapshot {
            if subtype == "task_started" && value["is_backgrounded"] != false { self.tasks.insert(id.into()); }
            if subtype == "task_notification" { self.tasks.remove(id); }
        }
        let status = match subtype {
            "task_started" => "任务已启动",
            "task_progress" => "任务正在执行",
            _ => match value["status"].as_str().unwrap_or("") {
                "completed" => "任务已完成", "failed" => "任务失败", "stopped" => "任务已停止", _ => "任务状态更新",
            },
        };
        let detail = value["summary"].as_str().or_else(|| value["description"].as_str()).unwrap_or("");
        message(cell, &format!("{turn}-background-{id}"), "tool", &format!("{status}\n{detail}"), false);
    }
}
/// 回合未结算时允许的最长无输出时间：与 CLI 默认 API 超时（600 秒）对齐，超过即判定任务停滞
/// （模型接口挂起、CLI 无限重试等），主动结束回合并保留聊天记录。等待用户决策不算停滞。
/// Claude / Codex / Pi 三家循环共用。
const AGENT_STALL_TIMEOUT: Duration = Duration::from_secs(600);
fn run_claude(cell: &Cell, process: &mut Process, stdin: ChildStdin, controls: mpsc::Receiver<Control>,
    output: mpsc::Receiver<Result<Value>>, errors: Arc<Mutex<String>>, hooks: &NativeClaudeHooks) -> Result<WorkerExit> {
    let mut checkpoint = Instant::now();
    let mut turn = Uuid::new_v4().to_string();
    let mut state = ClaudeOutputState::default();
    let mut tasks = ClaudeBackgroundTasks::default();
    let mut input = Some(stdin);
    let mut pending: HashMap<String, ClaudeApproval> = HashMap::new();
    // 每条写入 stdin 的用户消息都会产生一个 result；归零才表示当前回合任务全部结束。
    let mut pending_results = 1u64;
    let mut output_closed = false;
    // 最近一次活动（CLI 输出或用户操作）时间，用于识别模型接口挂起导致的回合停滞。
    let mut last_event = Instant::now();
    loop {
        while let Ok(event) = hooks.receiver.try_recv() {
            update(cell, |data| match event {
                NativeHookEvent::Decision(event) => {
                    if data.status != "stopping" && !data.approvals.iter().any(|item| item.id == event.decision_id) {
                        data.approvals.push(approval::claude_hook_approval(&event));
                        data.status = "approval".into();
                    }
                }
                NativeHookEvent::Settled(id) => {
                    data.approvals.retain(|item| item.id != id);
                    if data.status == "approval" && data.approvals.is_empty() { data.status = "running".into(); }
                }
            });
        }
        while let Ok(control) = controls.try_recv() {
            match control {
                Control::Stop => return Err("已中断".into()),
                Control::Retire => { drop(input.take()); return Ok(WorkerExit::Retired); }
                Control::Message { text, request_id: _ } => {
                    let stdin = input.as_mut().ok_or("Claude 输入通道已关闭，请重新发送消息")?;
                    // 空闲后收到的新消息开始新回合；运行中收到的直接交给 CLI 自行插话。
                    let new_turn = pending_results == 0;
                    if new_turn { turn = Uuid::new_v4().to_string(); }
                    update(cell, |data| {
                        if new_turn { usage::begin_turn(data); }
                        if data.approvals.is_empty() { data.status = "running".into(); }
                    });
                    let session_id = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.thread_id.clone().unwrap_or_default();
                    write_claude_user(stdin, &session_id, &text)?;
                    pending_results = pending_results.saturating_add(1);
                    last_event = Instant::now();
                }
                Control::Approval(answer) => {
                    if let Some(request) = pending.remove(&answer.approval_id) {
                        let stdin = input.as_mut().ok_or("Claude 输入通道已关闭，请重新发送消息")?;
                        write_json(stdin, request.response(&answer)?)?;
                        update(cell, |data| {
                            data.approvals.retain(|a| a.id != answer.approval_id);
                            if data.approvals.is_empty() { data.status = "running".into(); }
                        });
                        last_event = Instant::now();
                    }
                }
            }
        }
        if checkpoint.elapsed() > Duration::from_secs(5) { persist(cell)?; checkpoint = Instant::now(); }
        if output_closed {
            if let Some(status) = process.0.try_wait().map_err(|e| format!("读取 Claude 进程状态失败：{e}"))? {
                let details = errors.lock().map(|e| e.clone()).unwrap_or_default();
                if !status.success() {
                    return Err(if !details.trim().is_empty() { format!("Claude 进程已退出：{}", details.trim()) }
                        else { format!("Claude 进程异常结束（{status}），可以继续发送消息") });
                }
                if pending_results > 0 { return Err("Claude 进程已退出，未收到完成事件，可以继续发送消息".into()); }
                if !tasks.tasks.is_empty() { return Err("Claude 进程已退出，但仍有后台任务未完成，可以继续发送消息".into()); }
                return Ok(WorkerExit::Completed);
            }
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        // 回合任务全部结束后保持进程与 stdin 存活，把队列直接写入同一个 CLI 进程，不再 --resume。
        let waiting_for_hook = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.approvals.iter()
            .any(|item| item.method == approval::CLAUDE_HOOK_METHOD);
        // 回合未结算且长时间无任何输出（模型接口挂起、CLI 静默重试）时主动判停，
        // 否则 status 永远停在 running，App 端会一直显示「思考中」。等待用户决策不算停滞。
        if !output_closed && pending_results > 0 && pending.is_empty() && !waiting_for_hook
            && last_event.elapsed() > AGENT_STALL_TIMEOUT {
            return Err(format!("Claude 已超过 {} 分钟没有任何输出，任务可能已停止；聊天记录已保留，可重新发送消息继续",
                AGENT_STALL_TIMEOUT.as_secs() / 60));
        }
        if pending_results == 0 && tasks.tasks.is_empty() && pending.is_empty() && !waiting_for_hook {
            let became_idle = cell.data.lock().map(|mut data| {
                if data.status == "idle" { false } else {
                    data.status = "idle".into(); touch(&mut data); data.result_revision = data.revision; true
                }
            }).unwrap_or(false);
            if became_idle { persist(cell)?; }
            if let Some(stdin) = input.as_mut() {
                if take_pending_for_claude(cell, stdin)?.is_some() {
                    turn = Uuid::new_v4().to_string();
                    pending_results = 1;
                }
            }
        } else if pending_results == 0 && pending.is_empty() && !waiting_for_hook {
            // 回合已结算但后台任务仍在执行：转入 background 而不是停在 running，
            // App 端按「后台任务执行中」展示，任务清空后由上方分支转 idle。
            update(cell, |data| { if data.status == "running" { data.status = "background".into(); } });
        }
        let value = match output.recv_timeout(Duration::from_millis(100)) {
            Ok(value) => { last_event = Instant::now(); value? }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => { output_closed = true; drop(input.take()); continue; }
        };
        if value["type"] == "control_request" {
            if let Some(stdin) = input.as_mut() {
                if let Some(request) = ClaudeApproval::from_request(&value) {
                    if !pending.values().any(|item| item.request_id == request.request_id) {
                        let approval = request.approval.clone();
                        pending.insert(approval.id.clone(), request);
                        update(cell, |data| { data.status = "approval".into(); data.approvals.push(approval); });
                    }
                } else if value["request"]["subtype"] == "can_use_tool" && value["request"]["tool_name"] == "AskUserQuestion" {
                    write_json(stdin, json!({"type":"control_response","response":{
                        "subtype":"success","request_id":value["request_id"],"response":{
                            "behavior":"deny","message":"决策未通过 TerminalBuddy PreToolUse Hook 完成，请检查会话 Hook 配置后重新提问。"
                        }
                    }}))?;
                } else {
                    write_json(stdin, json!({"type":"control_response","response":{
                        "subtype":"error","request_id":value["request_id"],"error":"原生 AI 会话暂不支持此 Claude 交互请求",
                    }}))?;
                }
            }
            continue;
        }
        if value["type"] == "control_cancel_request" {
            let cancelled: HashSet<_> = pending.iter().filter(|(_, item)| item.request_id == value["request_id"])
                .map(|(id, _)| id.clone()).collect();
            pending.retain(|id, _| !cancelled.contains(id));
            if !cancelled.is_empty() {
                update(cell, |data| {
                    data.approvals.retain(|a| !cancelled.contains(&a.id));
                    if data.approvals.is_empty() { data.status = "running".into(); }
                });
            }
            continue;
        }
        tasks.observe(cell, &turn, &value);
        if apply_claude_event(cell, &turn, &mut state, &value)? {
            pending_results = pending_results.saturating_sub(1);
            // result 表示这一段回复及用量已结算；后台唤醒产生的新 result 也会走到这里。
            update(cell, |data| usage::finish_turn(data));
            refresh_title(cell, true);
        }
    }
}
#[derive(Default)]
struct CodexCommandOutput {
    command: String,
    output: String,
    running: bool,
}
#[derive(Default)]
struct CodexOutputState {
    thread_id: Option<String>,
    turn_id: Option<String>,
    completed_items: HashSet<String>,
    commands: HashMap<String, CodexCommandOutput>,
    finished: bool,
    usage: usage::CodexUsageTracker,
}
impl CodexOutputState {
    fn accepts(&self, params: &Value) -> bool {
        if let (Some(expected), Some(actual)) = (self.thread_id.as_deref(), params["threadId"].as_str()) {
            if expected != actual { return false; }
        }
        let actual_turn = params["turnId"].as_str().or_else(|| params["turn"]["id"].as_str());
        if let (Some(expected), Some(actual)) = (self.turn_id.as_deref(), actual_turn) {
            if expected != actual { return false; }
        }
        true
    }
    fn item(&mut self, cell: &Cell, turn: &str, item: &Value, completed: bool) {
        let Some(id) = item["id"].as_str().filter(|id| !id.is_empty()) else { return; };
        // unified exec 的工具调用可以先返回，但 PTY 仍在后台执行；此时条目还不是最终快照。
        let final_item = completed && !(item["type"] == "commandExecution" && item["status"] == "inProgress");
        if !final_item && self.completed_items.contains(id) { return; }
        if final_item { self.completed_items.insert(id.into()); }
        let key = format!("{turn}-item-{id}");
        match item["type"].as_str().unwrap_or("") {
            "agentMessage" if completed => message(cell, &key, "assistant", item["text"].as_str().unwrap_or(""), false),
            "commandExecution" => {
                let command = self.commands.entry(id.into()).or_default();
                command.running = !final_item;
                if let Some(text) = item["command"].as_str() { command.command = text.into(); }
                if let Some(output) = item["aggregatedOutput"].as_str() {
                    if completed || command.output.is_empty() { command.output = output.into(); }
                }
                let name = if command.command.is_empty() { "执行命令" } else { &command.command };
                message(cell, &key, "tool", &format!("{name}\n{}", command.output), false);
            }
            "fileChange" => message(cell, &key, "tool", &format!("文件变更\n{}", item["changes"]), false),
            "collabAgentToolCall" | "collabToolCall" => {
                message(cell, &key, "tool", &format!("协作任务：{}\n{}", item["tool"].as_str().unwrap_or("子任务"),
                    item.get("agentsStates").or_else(|| item.get("agentStatus")).unwrap_or(&Value::Null)), false);
            }
            _ => {}
        }
    }
}
fn apply_codex_event(cell: &Cell, turn: &str, state: &mut CodexOutputState, value: &Value) -> Result<bool> {
    let method = value["method"].as_str().unwrap_or(""); let params = &value["params"];
    if !state.accepts(params) {
        // 上一回合启动的后台命令可以在新回合期间继续输出，只接收已知命令的事件。
        if state.thread_id.as_deref() != params["threadId"].as_str() { return Ok(false); }
        let id = params["itemId"].as_str().or_else(|| params["item"]["id"].as_str());
        if !id.is_some_and(|id| state.commands.contains_key(id))
            || !(method == "item/commandExecution/outputDelta" || matches!(method, "item/started" | "item/completed") && params["item"]["type"] == "commandExecution") {
            return Ok(false);
        }
    }
    update_usage(cell, |data| state.usage.observe(data, value));
    match method {
        "turn/started" => {
            state.finished = false;
            if state.turn_id.is_none() { state.turn_id = params["turn"]["id"].as_str().map(str::to_string); }
        }
        "item/agentMessage/delta" | "item/commandExecution/outputDelta" => {
            let Some(id) = params["itemId"].as_str().filter(|id| !id.is_empty()) else { return Ok(false); };
            // 完成快照是最终内容，迟到或重放的增量不能再追加到已完成的条目。
            if state.completed_items.contains(id) { return Ok(false); }
            let text = params["delta"].as_str().unwrap_or("");
            let key = format!("{turn}-item-{id}");
            if method == "item/agentMessage/delta" {
                message(cell, &key, "assistant", text, true);
            } else {
                let command = state.commands.entry(id.into()).or_default();
                command.output.push_str(text);
                let name = if command.command.is_empty() { "执行命令" } else { &command.command };
                message(cell, &key, "tool", &format!("{name}\n{}", command.output), false);
            }
        }
        "item/started" | "item/completed" => state.item(cell, turn, &params["item"], method == "item/completed"),
        "turn/completed" => {
            state.finished = true;
            if let Some(items) = params["turn"]["items"].as_array() {
                for item in items { state.item(cell, turn, item, true); }
            }
            return match params["turn"]["status"].as_str().unwrap_or("") {
                "completed" => Ok(true), "interrupted" => Err("已中断".into()),
                _ => Err(params["turn"]["error"]["message"].as_str().unwrap_or("Codex 执行失败").into()),
            };
        }
        "error" if params["willRetry"] != true => return Err(params["error"]["message"].as_str().unwrap_or("Codex 执行失败").into()),
        _ => {}
    }
    Ok(false)
}
#[derive(Default)]
struct CodexBackgroundState {
    known_agents: HashSet<String>,
    running_agents: HashSet<String>,
    completed_items: HashSet<String>,
}
impl CodexBackgroundState {
    fn agent_status(&mut self, cell: &Cell, turn: &str, id: &str, status: &str, detail: &str) {
        self.known_agents.insert(id.into());
        if matches!(status, "running" | "pendingInit" | "active") { self.running_agents.insert(id.into()); }
        else if matches!(status, "idle" | "completed" | "interrupted" | "errored" | "shutdown" | "notFound" | "notLoaded" | "systemError") {
            let was_running = self.running_agents.remove(id);
            if was_running || !detail.is_empty() {
                let label = if matches!(status, "idle" | "completed") { "子任务已完成" } else { "子任务已结束" };
                message(cell, &format!("{turn}-agent-{id}"), "tool", &format!("{label}\n{detail}"), false);
            }
        }
    }
    fn observe(&mut self, cell: &Cell, turn: &str, main: &str, value: &Value) {
        let params = &value["params"];
        let method = value["method"].as_str().unwrap_or("");
        let source = params["thread"]["source"]["subAgent"]["thread_spawn"]["parent_thread_id"].as_str();
        if method == "thread/started" && source.is_some_and(|id| id == main || self.known_agents.contains(id)) {
            if let Some(id) = params["thread"]["id"].as_str() { self.known_agents.insert(id.into()); }
        }
        let Some(thread_id) = params["threadId"].as_str() else { return; };
        if self.known_agents.contains(thread_id) {
            if method == "thread/status/changed" {
                self.agent_status(cell, turn, thread_id, params["status"]["type"].as_str().unwrap_or(""), "");
            }
            if method == "turn/completed" {
                let detail = params["turn"]["items"].as_array().map(|items| items.iter().filter(|item| item["type"] == "agentMessage")
                    .filter_map(|item| item["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                self.agent_status(cell, turn, thread_id, params["turn"]["status"].as_str().unwrap_or(""), &detail);
            }
        }
        if thread_id != main { return; }
        if matches!(method, "item/started" | "item/completed") {
            self.item(cell, turn, &params["item"], method == "item/completed");
        }
        if method == "turn/completed" {
            if let Some(items) = params["turn"]["items"].as_array() { for item in items { self.item(cell, turn, item, true); } }
        }
    }
    fn item(&mut self, cell: &Cell, turn: &str, item: &Value, completed: bool) {
        if let Some(id) = item["id"].as_str() {
            if self.completed_items.contains(id) { return; }
            if completed { self.completed_items.insert(id.into()); }
        }
        match item["type"].as_str().unwrap_or("") {
            "collabAgentToolCall" | "collabToolCall" => {
                if matches!(item["tool"].as_str(), Some("spawnAgent" | "resumeAgent" | "sendInput" | "followupTask"))
                    && item["status"] != "failed" && item["status"] != "interrupted" {
                    if let Some(ids) = item["receiverThreadIds"].as_array() {
                        for id in ids.iter().filter_map(Value::as_str) { self.agent_status(cell, turn, id, "running", ""); }
                    }
                    if let Some(id) = item["newThreadId"].as_str().or_else(|| item["receiverThreadId"].as_str()) {
                        self.agent_status(cell, turn, id, "running", "");
                    }
                }
                if let Some(states) = item["agentsStates"].as_object() {
                    for (id, state) in states { self.agent_status(cell, turn, id, state["status"].as_str().unwrap_or(""), state["message"].as_str().unwrap_or("")); }
                }
                if let (Some(id), Some(status)) = (item["receiverThreadId"].as_str().or_else(|| item["newThreadId"].as_str()), item["agentStatus"].as_str().or_else(|| item["agentStatus"]["status"].as_str())) {
                    self.agent_status(cell, turn, id, status, "");
                }
            }
            "subAgentActivity" => {
                if let Some(id) = item["agentThreadId"].as_str() {
                    let status = match item["kind"].as_str().unwrap_or("") { "started" | "interacted" => "running", "completed" => "completed", "interrupted" => "interrupted", _ => "" };
                    self.agent_status(cell, turn, id, status, "");
                }
            }
            _ => {},
        }
    }
    fn running(&self, state: &CodexOutputState) -> bool {
        !self.running_agents.is_empty() || state.commands.values().any(|command| command.running)
    }
}
fn codex_request(stdin: &mut impl Write, next_id: &mut u64, method: &str, params: Value) -> Result<u64> {
    let id = *next_id;
    *next_id += 1;
    write_json(stdin, json!({"id":id,"method":method,"params":params}))?;
    Ok(id)
}
fn codex_status(cell: &Cell, state: &CodexOutputState, background: &CodexBackgroundState, request_id: Option<&str>, submitting: bool) {
    if let Ok(mut data) = cell.data.lock() {
        // 发送接口可能刚接纳了下一条消息，旧回合的迟到事件不能把它改回空闲。
        if active_request_id(&data) != request_id || data.status == "stopping" { return; }
        let status = if !data.approvals.is_empty() { "approval" } else if submitting || !state.finished { "running" }
            else if background.running(state) { "background" } else { "idle" };
        if data.status != status {
            data.status = status.into(); touch(&mut data);
            if status == "idle" { data.result_revision = data.revision; }
        }
    }
}
fn run_codex(cell: &Cell, session: &AiSession, prompt: &str, permissions: &super::ai_permission_service::NativePermissions, stdin: &mut impl Write,
    controls: mpsc::Receiver<Control>, output: mpsc::Receiver<Result<Value>>, errors: Arc<Mutex<String>>) -> Result<WorkerExit> {
    let mut checkpoint = Instant::now(); let turn = Uuid::new_v4().to_string();
    let mut last_persisted = session.revision;
    let mut pending: HashMap<String, (Value, String)> = HashMap::new();
    let mut state = CodexOutputState { thread_id: session.thread_id.clone(), ..Default::default() };
    let mut background = CodexBackgroundState::default();
    let mut next_id = 2;
    let mut config_request = None;
    let mut decision_instructions = approval::codex_decision_instructions(None);
    let mut resume_request = None;
    let mut turn_request = None;
    let mut queued_prompt = Some(prompt.to_string());
    let mut request_id = active_request_id(session).map(str::to_string);
    let mut agent_queries: HashMap<u64, String> = HashMap::new();
    let mut agent_checkpoint = Instant::now();
    let mut settle_at: Option<Instant> = None;
    // 最近一次活动（app-server 输出或用户操作）时间，用于识别模型接口挂起导致的回合停滞。
    let mut last_event = Instant::now();
    if let Ok(mut data) = cell.data.lock() { state.usage.start(&mut data); }
    loop {
        while let Ok(control) = controls.try_recv() {
            match control {
                Control::Stop => return Err("已中断".into()),
                Control::Retire => return Ok(WorkerExit::Retired),
                Control::Message { text, request_id: accepted_id } => {
                    request_id = Some(accepted_id);
                    let id = state.thread_id.as_deref().ok_or("Codex 会话尚未初始化")?;
                    if !state.finished && state.turn_id.is_some() {
                        // 原生插话：turn/start 由 app-server 原子处理活动回合的补充输入，不重置本回合用量。
                        let mut params = json!({"threadId":id,"input":[{"type":"text","text":text}]});
                        super::ai_permission_service::for_agent("codex")?.apply_turn(&mut params);
                        turn_request = Some(codex_request(stdin, &mut next_id, "turn/start", params)?);
                    } else {
                        state.usage = usage::CodexUsageTracker::default();
                        if let Ok(mut data) = cell.data.lock() { state.usage.start(&mut data); }
                        let permissions = super::ai_permission_service::for_agent("codex")?;
                        let mut params = json!({"threadId":id,"cwd":session.project_path,"developerInstructions":decision_instructions});
                        permissions.apply_thread(&mut params);
                        if let Some(model) = &session.model { params["model"] = json!(model); }
                        resume_request = Some(codex_request(stdin, &mut next_id, "thread/resume", params)?);
                        queued_prompt = Some(text);
                        state.turn_id = None;
                    }
                    last_event = Instant::now();
                }
                Control::Approval(answer) => {
                    if let Some((id, method)) = pending.remove(&answer.approval_id) {
                        let result = approval::codex_response(&method, &answer);
                        write_json(stdin, json!({"id":id,"result":result}))?;
                        update(cell, |data| { data.approvals.retain(|a| a.id != answer.approval_id); });
                        last_event = Instant::now();
                    }
                }
            }
        }
        if settle_at.is_some_and(|deadline| Instant::now() >= deadline) {
            settle_at = None;
            update(cell, |data| { state.usage.completed(data); usage::finish_turn(data); });
            codex_status(cell, &state, &background, request_id.as_deref(), resume_request.is_some() || turn_request.is_some());
            persist(cell)?;
        }
        // 主回合与后台任务全部结束后，常驻进程直接按队首先后启动下一回合。
        if state.thread_id.is_some() && resume_request.is_none() && turn_request.is_none() && settle_at.is_none() {
            if let Some(next) = take_pending_if_idle(cell)? {
                let Some(id) = state.thread_id.clone() else { continue };
                request_id = Some(next.request_id);
                state.usage = usage::CodexUsageTracker::default();
                if let Ok(mut data) = cell.data.lock() { state.usage.start(&mut data); }
                let permissions = super::ai_permission_service::for_agent("codex")?;
                let mut params = json!({"threadId":id,"cwd":session.project_path,"developerInstructions":decision_instructions});
                permissions.apply_thread(&mut params);
                if let Some(model) = &session.model { params["model"] = json!(model); }
                resume_request = Some(codex_request(stdin, &mut next_id, "thread/resume", params)?);
                queued_prompt = Some(next.text);
                state.turn_id = None;
                continue;
            }
        }
        if checkpoint.elapsed() > Duration::from_secs(5) {
            let revision = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.revision;
            if revision != last_persisted { persist(cell)?; last_persisted = revision; }
            checkpoint = Instant::now();
        }
        // 子线程不一定向此连接广播状态，用只读查询补齐完成状态，避免后台标记停留。
        if agent_checkpoint.elapsed() > Duration::from_secs(3) {
            for id in &background.running_agents {
                if !agent_queries.values().any(|pending| pending == id) {
                    let rpc_id = codex_request(stdin, &mut next_id, "thread/read", json!({"threadId":id,"includeTurns":false}))?;
                    agent_queries.insert(rpc_id, id.clone());
                }
            }
            agent_checkpoint = Instant::now();
        }
        codex_status(cell, &state, &background, request_id.as_deref(), resume_request.is_some() || turn_request.is_some() || settle_at.is_some());
        // 回合未结算且长时间无任何输出（模型接口挂起、app-server 静默）时主动判停，
        // 否则 status 永远停在 running，App 端会一直显示「思考中」。等待用户决策不算停滞；
        // 回合已结算、仅后台命令在执行的场景显示为 background，也不在此列。
        if (resume_request.is_some() || turn_request.is_some() || settle_at.is_some() || !state.finished)
            && pending.is_empty() && last_event.elapsed() > AGENT_STALL_TIMEOUT {
            return Err(format!("Codex 已超过 {} 分钟没有任何输出，任务可能已停止；聊天记录已保留，可重新发送消息继续",
                AGENT_STALL_TIMEOUT.as_secs() / 60));
        }
        let Some(value) = next_output(&output, &errors)? else { continue; };
        last_event = Instant::now();
        if let Some(id) = value["id"].as_u64().filter(|_| value.get("method").is_none()) {
            if let Some(agent_id) = agent_queries.remove(&id) {
                if value.get("error").is_none() {
                    background.agent_status(cell, &turn, &agent_id, value["result"]["thread"]["status"]["type"].as_str().unwrap_or(""), "");
                }
                continue;
            }
        }
        if value.get("error").is_some() { return Err(value["error"]["message"].as_str().unwrap_or("Codex 请求失败").into()); }
        if value["id"] == 1 && value.get("result").is_some() {
            write_json(stdin, json!({"method":"initialized","params":{}}))?;
            // 先读取按项目目录合并的配置，再追加客户端指引，避免覆盖用户原有指令。
            config_request = Some(codex_request(stdin, &mut next_id, "config/read", json!({"cwd":session.project_path,"includeLayers":false}))?);
        } else if value["id"].as_u64().is_some_and(|id| Some(id) == config_request) && value.get("result").is_some() {
            config_request = None;
            decision_instructions = approval::codex_decision_instructions(value["result"]["config"]["developer_instructions"].as_str());
            let mut params = json!({"cwd":session.project_path,"developerInstructions":decision_instructions});
            permissions.apply_thread(&mut params);
            if let Some(model) = &session.model { params["model"] = json!(model); }
            let method = if let Some(id) = &session.thread_id { params["threadId"] = json!(id); "thread/resume" }
                else { params["dynamicTools"] = approval::codex_tools(); "thread/start" };
            resume_request = Some(codex_request(stdin, &mut next_id, method, params)?);
        } else if value["id"].as_u64().is_some_and(|id| Some(id) == resume_request) && value.get("result").is_some() {
            resume_request = None;
            let id = value["result"]["thread"]["id"].as_str().ok_or("Codex 未返回会话标识")?;
            state.thread_id = Some(id.into());
            update(cell, |data| data.thread_id = Some(id.into())); persist(cell)?;
            let text = queued_prompt.take().ok_or("Codex 待发送消息不可用")?;
            let mut params = json!({"threadId":id,"input":[{"type":"text","text":text}]});
            super::ai_permission_service::for_agent("codex")?.apply_turn(&mut params);
            state.usage.submitted();
            state.finished = false;
            turn_request = Some(codex_request(stdin, &mut next_id, "turn/start", params)?);
        }
        if value["id"].as_u64().is_some_and(|id| Some(id) == turn_request) && value.get("result").is_some() {
            turn_request = None;
            if let Some(id) = value["result"]["turn"]["id"].as_str().or_else(|| value["result"]["turnId"].as_str()) { state.turn_id = Some(id.into()); }
        }
        let method = value["method"].as_str().unwrap_or(""); let params = &value["params"];
        if value.get("id").is_some() && !method.is_empty() {
            let details = if method == "item/tool/call" && approval::is_codex_decision_tool(params) {
                match approval::codex_decision_details(params) {
                    Ok(details) => Some(details),
                    Err(error) => {
                        write_json(stdin, json!({"id":value["id"],"result":approval::codex_tool_result(json!({"error":error}), false)}))?;
                        continue;
                    }
                }
            } else if matches!(method, "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
                | "item/tool/requestUserInput" | "tool/requestUserInput") { Some(params.clone()) } else { None };
            if let Some(details) = details {
                if !pending.values().any(|(id, _)| id == &value["id"]) {
                    let id = Uuid::new_v4().to_string(); pending.insert(id.clone(), (value["id"].clone(), method.into()));
                    update(cell, |data| { data.status = "approval".into(); data.approvals.push(AiApproval { id, method: method.into(), details }); });
                }
            } else { write_json(stdin, json!({"id":value["id"],"error":{"code":-32601,"message":"客户端暂不支持此交互请求"}}))?; }
        }
        if method == "serverRequest/resolved" {
            let resolved: HashSet<_> = pending.iter().filter(|(_, (id, _))| id == &params["requestId"])
                .map(|(id, _)| id.clone()).collect();
            pending.retain(|id, _| !resolved.contains(id));
            if !resolved.is_empty() { update(cell, |data| data.approvals.retain(|item| !resolved.contains(&item.id))); }
        }
        let Some(main) = state.thread_id.clone() else { continue; };
        background.observe(cell, &turn, &main, &value);
        if method == "turn/started" && params["threadId"] == main && resume_request.is_none()
            && (state.finished || state.turn_id.is_none()) {
            if state.finished {
                settle_at = None;
                // 自动唤醒仍属于最近一次用户输入，沿用累计基线，避免漏算后台处理的消耗。
                update(cell, |data| {
                    if let Some(last) = data.usage.as_mut().and_then(|usage| usage.last_turn.as_mut()) { last.state = "provisional".into(); }
                });
            }
            state.turn_id = params["turn"]["id"].as_str().map(str::to_string);
            state.finished = false;
        }
        // 恢复请求尚未完成时，旧主回合的回复不能冒充新消息的执行结果。
        if resume_request.is_some() && params["threadId"] == main { continue; }
        let completed = apply_codex_event(cell, &turn, &mut state, &value)?;
        if state.finished && (completed || method == "thread/tokenUsage/updated" && state.accepts(params)) {
            update(cell, |data| state.usage.completed(data));
        }
        if completed { settle_at = Some(Instant::now() + Duration::from_millis(300)); }
        codex_status(cell, &state, &background, request_id.as_deref(), resume_request.is_some() || turn_request.is_some() || settle_at.is_some());
        if completed { refresh_title(cell, true); persist(cell)?; }
        // turn/completed 仅结束主回合；app-server 持续存活，以接收后台输出、自动唤醒及手机后续消息。
    }
}

/// 应用退出时同时收尾原生 AI 任务，防止留下无主 CLI 子进程。
// ── Pi RPC 原生会话 ──────────────────────────────────────────────────────

/// Pi 命令是 `{id, type: <命令>, ...参数}` 的平铺结构。
fn pi_request(stdin: &mut impl Write, next_id: &mut u64, command: &str, mut params: Value) -> Result<u64> {
    let id = *next_id;
    *next_id += 1;
    let mut value = json!({"id":id, "type":command});
    if let Some(fields) = params.as_object_mut() { for (key, item) in fields { value[key] = item.take(); } }
    write_json(stdin, value)?;
    Ok(id)
}

#[derive(Default)]
struct PiOutputState {
    request_id: Option<String>,
    message_number: u64,
    current_key: String,
    /// 最近一次 prompt 正在执行（含重试、压缩恢复），直到 `agent_settled`。
    running: bool,
    /// `agent_settled` 已到，等待 `get_session_stats` 做权威结算。
    settling: bool,
    usage: usage::PiUsageTracker,
}

fn apply_pi_event(cell: &Cell, turn: &str, state: &mut PiOutputState, value: &Value) {
    match value["type"].as_str().unwrap_or("") {
        "message_start" if value["message"]["role"] == "assistant" => {
            state.message_number += 1;
            state.current_key = format!("{turn}-text-{}", state.message_number);
        }
        "message_update" => {
            let event = &value["assistantMessageEvent"];
            if event["type"] == "text_delta" {
                let key = state.current_key.clone();
                message(cell, &key, "assistant", event["delta"].as_str().unwrap_or(""), true);
            }
            let index = state.message_number;
            update_usage(cell, |data| state.usage.observe(data, index, &value["usage"]));
        }
        "message_end" => {
            let assistant = &value["message"];
            if assistant["role"] == "assistant" && !state.current_key.is_empty() {
                // 权威正文按内容块顺序拼接 text；工具卡片由 tool_execution 事件呈现。
                let text = assistant["content"].as_array().map(|blocks| blocks.iter()
                    .filter(|block| block["type"] == "text")
                    .map(|block| block["text"].as_str().unwrap_or("")).collect::<String>()).unwrap_or_default();
                let key = state.current_key.clone();
                message(cell, &key, "assistant", &text, false);
                let index = state.message_number;
                update_usage(cell, |data| state.usage.observe(data, index, &assistant["usage"]));
                if assistant["stopReason"] == "error" {
                    let detail = assistant["errorMessage"].as_str().unwrap_or("模型请求失败");
                    message(cell, &format!("{turn}-error-{index}"), "assistant", &format!("⚠ {detail}"), false);
                }
            }
        }
        "tool_execution_start" => {
            let id = value["toolCallId"].as_str().unwrap_or_default();
            message(cell, &format!("{turn}-tool-{id}"), "tool",
                &format!("{}\n{}", value["toolName"].as_str().unwrap_or("工具调用"), value["args"]), false);
        }
        "tool_execution_end" => {
            let id = value["toolCallId"].as_str().unwrap_or_default();
            let body = value["result"]["content"].as_array().map(|blocks| blocks.iter()
                .filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
            let title = if value["isError"] == true { "工具执行失败" } else { "工具执行完成" };
            message(cell, &format!("{turn}-tool-{id}"), "tool", &format!("{title}\n{body}"), false);
        }
        "compaction_start" => update_usage(cell, |data| { usage::invalidate_context(data); true }),
        _ => {}
    }
}

fn pi_status(cell: &Cell, state: &PiOutputState) {
    if let Ok(mut data) = cell.data.lock() {
        // API 已交接新输入或正在中断时，旧回合不能覆盖新状态。
        if active_request_id(&data) != state.request_id.as_deref() || data.status == "stopping" { return; }
        let status = if !data.approvals.is_empty() { "approval" } else if state.running || state.settling { "running" } else { "idle" };
        if data.status != status {
            data.status = status.into(); touch(&mut data);
            if status == "idle" { data.result_revision = data.revision; }
        }
    }
}

fn run_pi(cell: &Cell, session: &AiSession, prompt: &str, stdin: ChildStdin, controls: mpsc::Receiver<Control>,
    output: mpsc::Receiver<Result<Value>>, errors: Arc<Mutex<String>>) -> Result<WorkerExit> {
    let mut input = Some(stdin);
    let mut next_id = 2;
    let mut turn = Uuid::new_v4().to_string();
    let mut state = PiOutputState { request_id: active_request_id(session).map(str::to_string), ..Default::default() };
    let mut stats_request: Option<u64> = None;
    let mut pending: HashMap<String, AiApproval> = HashMap::new();
    let mut checkpoint = Instant::now();
    let mut last_persisted = session.revision;
    let mut retired = false;
    // 最近一次活动（Pi RPC 输出或用户操作）时间，用于识别模型接口挂起导致的回合停滞。
    let mut last_event = Instant::now();
    // Pi 会话文件与摘要绑定到 Pi 会话 ID（即 AiSession ID），首回合即登记。
    if session.thread_id.is_none() { update(cell, |data| data.thread_id = Some(session.id.clone())); persist(cell)?; }
    pi_request(input.as_mut().ok_or("Pi 输入通道不可用")?, &mut next_id, "prompt", json!({"message":prompt}))?;
    state.running = true;
    loop {
        while let Ok(control) = controls.try_recv() {
            match control {
                // 先请求中断再由外层清理进程树；Pi 会话文件已持久，上下文不丢失。
                Control::Stop => {
                    if let Some(stdin) = input.as_mut() { let _ = pi_request(stdin, &mut next_id, "abort", json!({})); }
                    return Err("已中断".into());
                }
                Control::Retire => { drop(input.take()); retired = true; }
                Control::Message { text, request_id } => {
                    let stdin = input.as_mut().ok_or("Pi 进程已退出，请再次发送消息")?;
                    if state.running {
                        // 原生插话走 Pi RPC 的 steer，保留当前消息的流式上下文与用量。
                        state.request_id = Some(request_id);
                        pi_request(stdin, &mut next_id, "steer", json!({"message":text}))?;
                    } else {
                        turn = Uuid::new_v4().to_string();
                        state = PiOutputState { request_id: Some(request_id), ..Default::default() };
                        if let Ok(mut data) = cell.data.lock() { state.usage.start(&mut data); }
                        stats_request = None;
                        pi_request(stdin, &mut next_id, "prompt", json!({"message":text}))?;
                    }
                    state.running = true;
                    last_event = Instant::now();
                }
                Control::Approval(answer) => {
                    if let Some(approval) = pending.remove(&answer.approval_id) {
                        let stdin = input.as_mut().ok_or("Pi 输入通道已关闭，请重新发送消息")?;
                        write_json(stdin, approval::pi_extension_response(&approval, &answer)?)?;
                        update(cell, |data| {
                            data.approvals.retain(|item| item.id != answer.approval_id);
                            if data.approvals.is_empty() && data.status == "approval"
                                && (state.running || state.settling) { data.status = "running".into(); }
                        });
                        last_event = Instant::now();
                    }
                }
            }
        }
        if checkpoint.elapsed() > Duration::from_secs(5) {
            let revision = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.revision;
            if revision != last_persisted { persist(cell)?; last_persisted = revision; }
            checkpoint = Instant::now();
        }
        pi_status(cell, &state);
        // 回合未结算且长时间无任何输出（模型接口挂起、RPC 静默）时主动判停，
        // 否则 status 永远停在 running，App 端会一直显示「思考中」。等待用户决策不算停滞。
        if !retired && (state.running || state.settling) && pending.is_empty()
            && last_event.elapsed() > AGENT_STALL_TIMEOUT {
            return Err(format!("Pi 已超过 {} 分钟没有任何输出，任务可能已停止；聊天记录已保留，可重新发送消息继续",
                AGENT_STALL_TIMEOUT.as_secs() / 60));
        }
        // 结算完成后持续检查，而非只在统计响应里取一次，避免收尾期间入队的消息滞留。
        if !retired && !state.running && !state.settling {
            if let Some(next) = take_pending_if_idle(cell)? {
                turn = Uuid::new_v4().to_string();
                state = PiOutputState { request_id: Some(next.request_id), ..Default::default() };
                if let Ok(mut data) = cell.data.lock() { state.usage.start(&mut data); }
                pi_request(input.as_mut().ok_or("Pi 输入通道已关闭")?, &mut next_id, "prompt", json!({"message":next.text}))?;
                state.running = true;
            }
        }
        let value = match next_output(&output, &errors) {
            Ok(Some(value)) => { last_event = Instant::now(); value }
            Ok(None) => continue,
            Err(message) => { if retired { return Ok(WorkerExit::Retired); } return Err(message); }
        };
        if value["type"] == "response" {
            let command = value["command"].as_str().unwrap_or("");
            if matches!(command, "prompt" | "steer") {
                if value["success"] != true { return Err(value["error"].as_str().unwrap_or("Pi 拒绝了本次消息").into()); }
                // 扩展命令被即时处理，不会产生 agent_settled，直接进入结算；插话不改动当前回合。
                if command == "prompt" && value["data"]["disposition"] == "handled" {
                    let stdin = input.as_mut().ok_or("Pi 输入通道已关闭")?;
                    stats_request = Some(pi_request(stdin, &mut next_id, "get_session_stats", json!({}))?);
                    state.running = false; state.settling = true;
                }
            } else if value["id"].as_u64().is_some_and(|id| stats_request == Some(id)) {
                stats_request = None;
                let stats = value["data"].clone();
                if let Ok(mut data) = cell.data.lock() {
                    state.usage.settled(&mut data, &stats);
                    usage::finish_turn(&mut data);
                    touch(&mut data);
                }
                refresh_title(cell, true);
                persist(cell)?;
                state.settling = false;
            }
            continue;
        }
        if value["type"] == "extension_ui_request" {
            if let Some(approval) = approval::pi_extension_approval(&value) {
                pending.insert(approval.id.clone(), approval.clone());
                update(cell, |data| { data.status = "approval".into(); data.approvals.push(approval); });
            }
            continue;
        }
        if value["type"] == "agent_settled" {
            let stdin = input.as_mut().ok_or("Pi 输入通道已关闭")?;
            stats_request = Some(pi_request(stdin, &mut next_id, "get_session_stats", json!({}))?);
            state.running = false; state.settling = true;
            continue;
        }
        apply_pi_event(cell, &turn, &mut state, &value);
    }
}

pub fn shutdown_all() {
    let cells = registry().lock().map(|items| items.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
    for cell in cells {
        if let Ok(control) = cell.control.lock() {
            if let Some(tx) = control.as_ref() {
                let idle = cell.data.lock().map(|data| data.status == "idle").unwrap_or(false);
                let _ = tx.send(if idle { Control::Retire } else { Control::Stop });
            }
        }
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while RUNNING.load(Ordering::Relaxed) > 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_history_keeps_message_ids_text_tools_and_timestamps() {
        let history = serde_json::from_value(json!({
            "total": 4, "title": "Codex 历史", "projectDir": "/project", "model": null,
            "inputTokens": 0, "outputTokens": 0, "startedAt": null, "updatedAt": 456,
            "messages": [
                {"seq": 0, "role": "user", "timestamp": 123, "text": "继续处理中文任务", "tools": [], "toolName": null},
                {"seq": 1, "role": "assistant", "timestamp": null, "text": "已完成分析", "tools": [], "toolName": null},
                {"seq": 2, "role": "tool", "timestamp": null, "text": "", "tools": [{"name": "exec", "summary": "执行结果"}], "toolName": "exec"},
                {"seq": 3, "role": "assistant", "timestamp": null, "text": "", "tools": [], "toolName": null}
            ]
        })).unwrap();
        let messages = history_messages("original-thread", &history);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].id, "history-original-thread-0");
        assert_eq!(messages[0].text, "继续处理中文任务");
        assert_eq!(messages[0].created_at, 123);
        assert_eq!(messages[1].created_at, 456);
        assert_eq!(messages[2].role, "tool");
        assert_eq!(messages[2].text, "exec\n执行结果");
    }

    #[test]
    fn claude_user_message_reuses_stream_json_input() {
        let mut out = Vec::new();
        write_claude_user(&mut out, "session-1", "继续处理").unwrap();
        let value: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(value["type"], "user");
        assert_eq!(value["session_id"], "session-1");
        assert_eq!(value["message"]["role"], "user");
        assert_eq!(value["message"]["content"], "继续处理");
        assert!(value["parent_tool_use_id"].is_null());
    }

    #[test]
    fn claude_queue_writes_to_same_process_after_settle() {
        let saved = SavedCell::new();
        let request_id = "00000000-0000-4000-8000-000000000002";
        {
            let mut data = saved.0.data.lock().unwrap();
            data.status = "idle".into();
            data.pending_inputs.push(PendingInput { text: "继续".into(), request_id: request_id.into() });
            persist_data(&saved.0, &data).unwrap();
        }
        let mut out = Vec::new();
        assert!(take_pending_for_claude(&saved.0, &mut out).unwrap().is_some());
        let value: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(value["message"]["content"], "继续");
        let data = saved.0.data.lock().unwrap();
        assert_eq!(data.status, "running");
        assert!(data.pending_inputs.is_empty());
        assert_eq!(data.messages.last().unwrap().id, request_id);
    }

    #[test]
    fn send_message_defaults_to_queue_and_accepts_steer() {
        let request_id = "00000000-0000-4000-8000-000000000001";
        let queue: SendAiMessage = serde_json::from_value(json!({"text": "继续", "requestId": request_id})).unwrap();
        assert!(!queue.steer);
        let steer: SendAiMessage = serde_json::from_value(json!({"text": "插话", "requestId": request_id, "steer": true})).unwrap();
        assert!(steer.steer);
        // 旧客户端残留的 immediate 字段不再生效，按默认排队处理。
        let legacy: SendAiMessage = serde_json::from_value(json!({"text": "旧客户端", "requestId": request_id, "immediate": true})).unwrap();
        assert!(!legacy.steer);
    }

    #[test]
    fn resume_history_accepts_server_default_model_without_client_path() {
        let input: ResumeCodexHistory = serde_json::from_value(json!({"providerId": "default:codex"})).unwrap();
        assert_eq!(input.provider_id.as_deref(), Some("default:codex"));
        assert!(input.model.is_none());
    }

    #[test]
    fn reused_prefill_refresh_skips_running_sessions() {
        // 有进程或执行中状态一律不刷新，避免覆盖实时写入的消息。
        for status in ["running", "approval", "background", "stopping"] {
            assert!(!reused_prefill_needs_refresh(status, false), "{} 不应刷新", status);
        }
        assert!(!reused_prefill_needs_refresh("idle", true));
        // 空闲与异常终态可以刷新：没有进程会再写旧消息。
        assert!(reused_prefill_needs_refresh("idle", false));
        assert!(reused_prefill_needs_refresh("error", false));
        assert!(reused_prefill_needs_refresh("interrupted", false));
    }

    #[test]
    fn prefill_differs_detects_append_and_rewrite() {
        let message = |id: &str, text: &str, at: i64| AiMessage {
            id: id.into(), role: "user".into(), text: text.into(), created_at: at,
        };
        let old = vec![message("history-0", "第一问", 1)];
        // 条数相同、内容相同 → 不替换，避免无意义的落盘。
        assert!(!prefill_differs(&old, &[message("history-0", "第一问", 1)]));
        // 尾部追加（电脑端续写了新回合）→ 替换。
        assert!(prefill_differs(&old, &[message("history-0", "第一问", 1), message("history-1", "回答", 2)]));
        // 条数不变但正文变化（索引重解析）→ 替换。
        assert!(prefill_differs(&old, &[message("history-0", "新的回答", 1)]));
    }

    fn cell() -> Cell {
        let data = serde_json::from_value(json!({
            "id": "test-session", "title": "测试会话", "provider": "claude", "projectPath": ".",
            "model": null, "status": "running", "messages": [], "approvals": [], "error": null,
            "updatedAt": 0, "revision": 0,
        })).unwrap();
        Cell { data: Mutex::new(data), control: Mutex::new(None), summary: Mutex::default(), deleted: AtomicBool::new(false), path: PathBuf::new() }
    }
    struct SavedCell(Cell);
    impl SavedCell {
        fn new() -> Self {
            let mut cell = cell();
            cell.path = std::env::temp_dir().join(format!("terminal-buddy-title-test-{}", Uuid::new_v4())).join("session.json");
            {
                let mut data = cell.data.lock().unwrap();
                data.thread_id = Some("00000000-0000-4000-8000-000000000001".into());
                data.owner = "title-test".into();
                data.updated_at = 123;
                data.revision = 7;
            }
            persist(&cell).unwrap();
            Self(cell)
        }
        fn read(&self) -> AiSession { serde_json::from_slice(&fs::read(&self.0.path).unwrap()).unwrap() }
        fn title(&self, provider: &str, id: &str, title: &str) -> Result<()> {
            save_summary_title(&self.0, provider, id, title.into())
        }
    }
    impl Drop for SavedCell {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0.path);
            if let Some(parent) = self.0.path.parent() { let _ = fs::remove_dir(parent); }
        }
    }

    #[test]
    fn summary_title_is_persisted_without_changing_session_order() {
        let saved = SavedCell::new();
        let id = saved.read().thread_id.unwrap();
        saved.title("claude", &id, "修复实时摘要").unwrap();
        let data = saved.read();
        assert_eq!(data.title, "修复实时摘要");
        assert_eq!(data.updated_at, 123);
        assert_eq!(data.revision, 8);
        assert_eq!(data.owner, "title-test");
        assert_eq!(data.thread_id.as_deref(), Some(id.as_str()));
        saved.title("claude", &id, "修复实时摘要").unwrap();
        assert_eq!(saved.read().revision, 8);
        assert_eq!(saved.0.data.lock().unwrap().title, "修复实时摘要");
    }

    #[test]
    fn summary_title_preserves_new_streaming_messages() {
        let saved = SavedCell::new();
        let id = saved.read().thread_id.unwrap();
        message(&saved.0, "reply", "assistant", "正在继续回复", true);
        let (revision, updated_at) = {
            let data = saved.0.data.lock().unwrap();
            (data.revision, data.updated_at)
        };
        saved.title("claude", &id, "新的任务标题").unwrap();
        let data = saved.read();
        assert_eq!(data.title, "新的任务标题");
        assert_eq!(data.messages[0].text, "正在继续回复");
        assert_eq!(data.revision, revision + 1);
        assert_eq!(data.updated_at, updated_at);
    }

    #[test]
    fn summary_title_ignores_another_provider_or_thread() {
        let saved = SavedCell::new();
        let id = saved.read().thread_id.unwrap();
        saved.title("codex", &id, "其他供应商").unwrap();
        saved.title("claude", "00000000-0000-4000-8000-000000000002", "其他会话").unwrap();
        assert_eq!(saved.read().title, "测试会话");
        assert_eq!(saved.read().revision, 7);
    }

    #[test]
    fn summary_title_does_not_restore_a_deleted_session() {
        let saved = SavedCell::new();
        let id = saved.read().thread_id.unwrap();
        fs::remove_file(&saved.0.path).unwrap();
        assert!(saved.title("claude", &id, "迟到的摘要").is_err());
        assert!(!saved.0.path.exists());
        let data = saved.0.data.lock().unwrap();
        assert_eq!(data.title, "测试会话");
        assert_eq!(data.revision, 7);
    }

    fn stream(event: Value) -> Value { json!({"type": "stream_event", "event": event}) }
    fn start(id: &str) -> Value { stream(json!({"type": "message_start", "message": {"id": id}})) }
    fn block(index: u64, kind: &str) -> Value {
        stream(json!({"type": "content_block_start", "index": index, "content_block": {"type": kind}}))
    }
    fn delta(index: u64, text: &str) -> Value {
        stream(json!({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text}}))
    }
    fn stop(index: u64) -> Value { stream(json!({"type": "content_block_stop", "index": index})) }
    fn assistant(id: &str, content: Value) -> Value { json!({"type": "assistant", "message": {"id": id, "content": content}}) }
    fn replay(events: &[Value]) -> Vec<AiMessage> {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        for event in events { apply_claude_event(&cell, "turn", &mut state, event).unwrap(); }
        cell.data.into_inner().unwrap().messages
    }

    #[test]
    fn claude_text_after_thinking_replaces_streamed_message() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        for event in [
            start("msg-1"), block(0, "thinking"),
            assistant("msg-1", json!([{"type": "thinking", "thinking": "分析中"}])), stop(0),
            block(1, "text"), delta(1, "我先获取今天的市场数据"),
        ] { apply_claude_event(&cell, "turn", &mut state, &event).unwrap(); }
        let streamed_id = cell.data.lock().unwrap().messages[0].id.clone();
        let text = "我先获取今天的市场数据再分析。";
        apply_claude_event(&cell, "turn", &mut state,
            &assistant("msg-1", json!([{"type": "text", "text": text}]))).unwrap();
        apply_claude_event(&cell, "turn", &mut state, &json!({"type": "result", "result": text})).unwrap();
        let data = cell.data.lock().unwrap();
        assert_eq!(data.messages.len(), 1);
        assert_eq!(data.messages[0].id, streamed_id);
        assert_eq!(data.messages[0].text, text);
    }

    #[test]
    fn claude_completed_text_after_stop_reuses_original_index() {
        let messages = replay(&[
            start("msg-1"), block(0, "thinking"), stop(0), block(1, "text"), delta(1, "我先获取"), stop(1),
            stream(json!({"type": "message_stop"})),
            assistant("msg-1", json!([{"type": "text", "text": "我先获取今天的市场数据再分析。"}])),
        ]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "我先获取今天的市场数据再分析。");
    }

    #[test]
    fn claude_separate_text_blocks_keep_their_order_around_tools() {
        let messages = replay(&[
            start("msg-1"), block(0, "text"), delta(0, "先搜索。"),
            assistant("msg-1", json!([{"type": "text", "text": "先搜索。"}])), stop(0),
            block(1, "tool_use"),
            assistant("msg-1", json!([{"type": "tool_use", "id": "tool-1", "name": "WebSearch", "input": {}}])), stop(1),
            block(2, "text"), delta(2, "再分析。"),
            assistant("msg-1", json!([{"type": "text", "text": "再分析。"}])), stop(2),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "tool-1", "content": "搜索结果"}]}}),
        ]);
        assert_eq!(messages.iter().map(|m| (m.role.as_str(), m.text.as_str())).collect::<Vec<_>>(),
            vec![("assistant", "先搜索。"), ("tool", "WebSearch\n{}"), ("assistant", "再分析。"), ("tool", "搜索结果")]);
        assert_ne!(messages[0].id, messages[2].id);
    }

    #[test]
    fn claude_complete_only_blocks_do_not_overwrite_each_other() {
        let messages = replay(&[
            assistant("msg-1", json!([{"type": "thinking", "thinking": "分析中"}])),
            assistant("msg-1", json!([{"type": "text", "text": "第一段"}])),
            assistant("msg-1", json!([{"type": "tool_use", "id": "tool-1", "name": "WebSearch", "input": {}}])),
            assistant("msg-1", json!([{"type": "text", "text": "第二段"}])),
            assistant("msg-2", json!([{"type": "text", "text": "第三段"}])),
        ]);
        let texts: Vec<_> = messages.iter().filter(|m| m.role == "assistant").map(|m| m.text.as_str()).collect();
        assert_eq!(texts, vec!["第一段", "第二段", "第三段"]);
    }

    #[test]
    fn claude_text_without_deltas_and_full_snapshots_are_preserved() {
        let messages = replay(&[
            start("msg-1"), block(0, "thinking"), stop(0), block(1, "text"),
            assistant("msg-1", json!([{"type": "text", "text": "完整回复"}])), stop(1),
            start("msg-2"), block(0, "thinking"), stop(0), block(1, "text"), delta(1, "快照"),
            assistant("msg-2", json!([{"type": "thinking", "thinking": "分析中"}, {"type": "text", "text": "快照回复"}])),
        ]);
        assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["完整回复", "快照回复"]);
    }

    #[test]
    fn claude_equal_text_in_different_messages_is_not_deduplicated() {
        let messages = replay(&[
            start("msg-1"), block(0, "text"), delta(0, "继续分析。"),
            assistant("msg-1", json!([{"type": "text", "text": "继续分析。"}])), stop(0),
            stream(json!({"type": "message_stop"})),
            start("msg-2"), block(0, "text"), delta(0, "继续分析。"),
            assistant("msg-2", json!([{"type": "text", "text": "继续分析。"}])), stop(0),
        ]);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].text, messages[1].text);
        assert_ne!(messages[0].id, messages[1].id);
    }

    #[test]
    fn claude_result_only_still_provides_a_reply() {
        let messages = replay(&[json!({"type": "result", "result": "最终回复"})]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "assistant");
        assert_eq!(messages[0].text, "最终回复");
    }
    #[test]
    fn claude_delayed_completion_uses_pending_block_instead_of_latest_block() {
        let messages = replay(&[
            start("msg-1"), block(0, "text"), delta(0, "第一段"), stop(0),
            block(1, "text"), delta(1, "第二段"),
            assistant("msg-1", json!([{"type": "text", "text": "第一段完整内容"}])),
            assistant("msg-1", json!([{"type": "text", "text": "第二段完整内容"}])),
        ]);
        assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["第一段完整内容", "第二段完整内容"]);
    }

    #[test]
    fn claude_replayed_completion_uuid_is_idempotent_without_stream_events() {
        let mut event = assistant("msg-1", json!([{"type": "text", "text": "只显示一次"}]));
        event["uuid"] = json!("assistant-event-1");
        let messages = replay(&[event.clone(), event]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "只显示一次");
    }

    #[test]
    fn claude_replayed_stream_uuid_and_late_delta_do_not_duplicate_text() {
        let mut chunk = delta(0, "正文");
        chunk["uuid"] = json!("stream-event-1");
        let messages = replay(&[
            start("msg-1"), block(0, "text"), chunk.clone(), chunk,
            assistant("msg-1", json!([{"type": "text", "text": "完整正文"}])), delta(0, "迟到片段"),
        ]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "完整正文");
    }

    #[test]
    fn claude_text_in_content_block_start_is_preserved_once() {
        let initial = stream(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "开头"}}));
        let messages = replay(&[start("msg-1"), initial.clone(), initial, delta(0, "正文")]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "开头正文");
    }

    fn codex(method: &str, mut params: Value) -> Value {
        if params.get("threadId").is_none() { params["threadId"] = json!("thread-1"); }
        if params.get("turnId").is_none() { params["turnId"] = json!("turn-1"); }
        json!({"method": method, "params": params})
    }
    fn codex_state() -> CodexOutputState {
        CodexOutputState { thread_id: Some("thread-1".into()), turn_id: Some("turn-1".into()), ..Default::default() }
    }
    fn replay_codex(events: &[Value]) -> Vec<AiMessage> {
        let cell = cell(); let mut state = codex_state();
        for event in events { apply_codex_event(&cell, "turn", &mut state, event).unwrap(); }
        cell.data.into_inner().unwrap().messages
    }

    #[test]
    fn codex_completion_replaces_deltas_and_ignores_late_chunks() {
        let completed = codex("item/completed", json!({"item": {"id": "answer-1", "type": "agentMessage", "text": "完整回复"}}));
        let messages = replay_codex(&[
            codex("item/agentMessage/delta", json!({"itemId": "answer-1", "delta": "完整"})),
            codex("item/agentMessage/delta", json!({"itemId": "answer-1", "delta": "回复"})),
            completed.clone(), completed,
            codex("item/agentMessage/delta", json!({"itemId": "answer-1", "delta": "完整回复"})),
        ]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "assistant");
        assert_eq!(messages[0].text, "完整回复");
    }

    #[test]
    fn codex_command_start_output_and_completion_share_one_message() {
        let started = codex("item/started", json!({"item": {"id": "cmd-1", "type": "commandExecution", "command": "echo hello", "aggregatedOutput": ""}}));
        let completed = codex("item/completed", json!({"item": {"id": "cmd-1", "type": "commandExecution", "command": "echo hello", "aggregatedOutput": "hello"}}));
        let messages = replay_codex(&[
            started.clone(), codex("item/commandExecution/outputDelta", json!({"itemId": "cmd-1", "delta": "hel"})),
            codex("item/commandExecution/outputDelta", json!({"itemId": "cmd-1", "delta": "lo"})),
            completed.clone(), completed, started,
            codex("item/commandExecution/outputDelta", json!({"itemId": "cmd-1", "delta": "hello"})),
        ]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].text, "echo hello\nhello");
    }

    #[test]
    fn codex_output_before_started_is_kept_in_same_command_message() {
        let messages = replay_codex(&[
            codex("item/commandExecution/outputDelta", json!({"itemId": "cmd-1", "delta": "hello"})),
            codex("item/started", json!({"item": {"id": "cmd-1", "type": "commandExecution", "command": "echo hello", "aggregatedOutput": ""}})),
        ]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "echo hello\nhello");
    }

    #[test]
    fn codex_turn_snapshot_updates_existing_reply_without_adding_another() {
        let messages = replay_codex(&[
            codex("item/agentMessage/delta", json!({"itemId": "answer-1", "delta": "回复"})),
            codex("turn/completed", json!({"turn": {"id": "turn-1", "status": "completed", "items": [
                {"id": "answer-1", "type": "agentMessage", "text": "回复完整内容"},
            ]}})),
        ]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "回复完整内容");
    }

    #[test]
    fn codex_foreign_thread_and_turn_do_not_add_or_finish_current_reply() {
        let cell = cell(); let mut state = codex_state();
        for event in [
            codex("item/agentMessage/delta", json!({"threadId": "subagent-thread", "itemId": "answer-2", "delta": "其它线程"})),
            codex("item/completed", json!({"turnId": "previous-turn", "item": {"id": "answer-3", "type": "agentMessage", "text": "旧回合"}})),
            codex("turn/completed", json!({"threadId": "subagent-thread", "turn": {"id": "turn-1", "status": "completed"}})),
        ] { assert!(!apply_codex_event(&cell, "turn", &mut state, &event).unwrap()); }
        assert!(cell.data.lock().unwrap().messages.is_empty());
    }

    #[test]
    fn codex_equal_text_from_distinct_items_is_preserved() {
        let messages = replay_codex(&[
            codex("item/completed", json!({"item": {"id": "answer-1", "type": "agentMessage", "text": "继续分析"}})),
            codex("item/completed", json!({"item": {"id": "answer-2", "type": "agentMessage", "text": "继续分析"}})),
        ]);
        assert_eq!(messages.len(), 2);
        assert_ne!(messages[0].id, messages[1].id);
    }

    #[test]
    fn codex_missing_item_ids_are_ignored_instead_of_sharing_a_null_key() {
        let messages = replay_codex(&[
            codex("item/agentMessage/delta", json!({"delta": "无标识片段"})),
            codex("item/completed", json!({"item": {"type": "agentMessage", "text": "无标识快照"}})),
        ]);
        assert!(messages.is_empty());
    }

    #[test]
    fn pi_events_stream_and_finalize_assistant_text() {
        let cell = cell();
        let mut state = PiOutputState::default();
        let events = [
            json!({"type":"message_start","message":{"role":"assistant"}}),
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"你"},"usage":{"input":10,"output":1}}),
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"好"},"usage":{"input":10,"output":2}}),
            json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"略"},{"type":"text","text":"你好，世界"}],"usage":{"input":10,"output":3,"cacheRead":2}}}),
        ];
        for event in &events { apply_pi_event(&cell, "turn", &mut state, event); }
        let data = cell.data.into_inner().unwrap();
        assert_eq!(data.messages.len(), 1);
        assert_eq!(data.messages[0].role, "assistant");
        assert_eq!(data.messages[0].text, "你好，世界");
        let usage = data.usage.unwrap();
        let turn = usage.last_turn.unwrap();
        assert_eq!(turn.state, "provisional");
        assert_eq!(turn.tokens.input_tokens, Some(12));
        assert_eq!(turn.tokens.output_tokens, Some(3));
        assert_eq!(turn.tokens.cache_read_input_tokens, Some(2));
    }

    #[test]
    fn pi_tool_events_replace_the_same_card() {
        let cell = cell();
        let mut state = PiOutputState::default();
        let events = [
            json!({"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}),
            json!({"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","isError":false,"result":{"content":[{"type":"text","text":"file"}]}}),
            json!({"type":"tool_execution_start","toolCallId":"c2","toolName":"edit","args":{"path":"a.rs"}}),
            json!({"type":"tool_execution_end","toolCallId":"c2","toolName":"edit","isError":true,"result":{"content":[{"type":"text","text":"拒绝"}]}}),
        ];
        for event in &events { apply_pi_event(&cell, "turn", &mut state, event); }
        let data = cell.data.into_inner().unwrap();
        assert_eq!(data.messages.len(), 2);
        assert_eq!(data.messages[0].text, "工具执行完成\nfile");
        assert_eq!(data.messages[1].text, "工具执行失败\n拒绝");
    }

    #[test]
    fn pi_usage_settles_with_authoritative_stats() {
        let cell = cell();
        {
            let mut data = cell.data.lock().unwrap();
            data.usage = Some(usage::initial());
            let mut tracker = usage::PiUsageTracker::default();
            tracker.start(&mut data);
            tracker.observe(&mut data, 1, &json!({"input":100,"output":5}));
            tracker.settled(&mut data, &json!({
                "tokens":{"input":500,"output":50,"cacheRead":40},
                "contextUsage":{"tokens":600,"contextWindow":200000},
            }));
        }
        let data = cell.data.into_inner().unwrap();
        let usage = data.usage.unwrap();
        assert_eq!(usage.session_total.tokens.input_tokens, Some(540));
        assert_eq!(usage.session_total.tokens.output_tokens, Some(50));
        let turn = usage.last_turn.unwrap();
        assert_eq!(turn.state, "final");
        assert_eq!(turn.tokens.input_tokens, Some(540));
        assert_eq!(usage.context.used_tokens, Some(600));
        assert_eq!(usage.context.window_tokens, Some(200000));
        assert_eq!(usage.context.window_source.as_deref(), Some("cli"));
    }

    #[test]
    fn pi_status_waits_for_stats_before_idle() {
        let cell = cell();
        let mut state = PiOutputState { running: true, ..Default::default() };
        pi_status(&cell, &state);
        assert_eq!(cell.data.lock().unwrap().status, "running");
        state = PiOutputState { settling: true, ..Default::default() };
        pi_status(&cell, &state);
        assert_eq!(cell.data.lock().unwrap().status, "running");
        state = PiOutputState::default();
        pi_status(&cell, &state);
        let data = cell.data.lock().unwrap();
        assert_eq!(data.status, "idle");
        assert_eq!(data.result_revision, data.revision);
    }

}
