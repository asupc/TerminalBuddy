//! 原生 AI 会话：Claude print/stream-json 与 Codex app-server 的结构化消息适配。
//! CLI 进程在服务端执行，手机断开不会终止任务。所有文件/进程操作由 handler 的
//! spawn_blocking 或专用工作线程承载；用户文本只进入 stdin，不拼进 shell 命令。
use crate::models::ai_chat::*;
use crate::runtime::Emitter;
use super::{ai_chat_approval::{self as approval, ClaudeApproval}, ai_chat_usage as usage};
use super::ai_chat_claude_hooks::{NativeClaudeHooks, NativeHookEvent};
use super::{atomic_file::atomic_write_private, process_tree::ProcessTree, terminal_task_service::SessionSummaryTracker, PathService};
use base64::Engine;
use serde::Deserialize as _;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashMap, HashSet}, fs, io::{BufRead, BufReader, Read, Write}, path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, OnceLock, mpsc, atomic::{AtomicBool, AtomicUsize, Ordering}},
    thread, time::{Duration, Instant}};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
// 仅记录运行任务以便退出时收尾，不限制任务并发数。
static RUNNING: AtomicUsize = AtomicUsize::new(0);

/// 桌面端当前打开着的原生会话标签（由桌面端实时上报，服务重启即清空）。
/// 只用于给会话元数据打 `desktopOpen` 标记，不参与会话持久化。
static DESKTOP_OPEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
fn desktop_open_set() -> &'static Mutex<HashSet<String>> {
    DESKTOP_OPEN.get_or_init(|| Mutex::new(HashSet::new()))
}
/// 整体替换桌面端打开集合：打开/关闭标签、启动恢复标签页都会触发一次上报。
pub fn set_desktop_open(ids: Vec<String>) {
    let ids = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    if let Ok(mut open) = desktop_open_set().lock() { *open = ids; }
}
fn is_desktop_open(id: &str) -> bool {
    desktop_open_set().lock().map(|open| open.contains(id)).unwrap_or(false)
}

struct RunningTask;
impl Drop for RunningTask { fn drop(&mut self) { RUNNING.fetch_sub(1, Ordering::Relaxed); } }

enum Control { Stop, Retire, Message { text: String, request_id: String, images: Vec<AiImage> }, Approval(AnswerAiApproval) }
enum WorkerExit { Completed, Retired }
/// 桌面 webview 与浏览器事件通道共用的 AppHandle（启动时注入）。
static APP: OnceLock<crate::runtime::AppHandle> = OnceLock::new();
pub fn set_app_handle(app: crate::runtime::AppHandle) {
    let _ = APP.set(app);
}

/// 已推送给客户端的内容基线：用于计算增量消息，避免每次重传整段对话。
#[derive(Default)]
struct Emitted {
    revision: u64,
    /// id → (text, subagent, subagentKey, todo)：除正文外，子代理字段变化（流式早期的
    /// 兜底名修正、分组键补写）与 `todo` 标记（tool_result 先于 tool_use 到达时的补写）
    /// 也必须触发推送，否则前端停留在旧值（审查 V-4）。
    messages: HashMap<String, (String, Option<String>, Option<String>, bool)>,
}

struct Cell {
    data: Mutex<AiSession>,
    control: Mutex<Option<mpsc::Sender<Control>>>,
    summary: Mutex<SessionSummaryTracker>,
    emitted: Mutex<Emitted>,
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
/// 实时推送会话变化：载荷与 HTTP WS 的 `update` 帧同构（session 元数据 + 变化的消息），
/// 桌面 webview 与浏览器事件通道共用同一套解析逻辑。
fn emit_update(cell: &Cell) {
    let Some(app) = APP.get() else { return; };
    if cell.deleted.load(Ordering::Acquire) { return; }
    let data = match cell.data.lock() { Ok(data) => data, Err(_) => return };
    let mut emitted = match cell.emitted.lock() { Ok(emitted) => emitted, Err(_) => return };
    if emitted.revision == data.revision { return; }
    // 增量维护已发射内容：只克隆本次变化的消息，未触及的消息仅做哈希查找。
    // 旧实现每帧全量重建 id→text 表，长会话流式期间每秒克隆整段对话文本数十次。
    let mut changed: Vec<AiMessage> = Vec::new();
    for message in &data.messages {
        match emitted.messages.get(&message.id) {
            Some((text, subagent, subagent_key, todo)) if *text == message.text
                && *subagent == message.subagent
                && *subagent_key == message.subagent_key
                && *todo == message.todo => continue,
            _ => {}
        }
        emitted.messages.insert(message.id.clone(),
            (message.text.clone(), message.subagent.clone(), message.subagent_key.clone(), message.todo));
        changed.push(message.clone());
    }
    if emitted.messages.len() != data.messages.len() {
        // 消息被整段替换（/clear、resume 预填）：清掉已不存在的条目。
        let alive: HashSet<&str> = data.messages.iter().map(|message| message.id.as_str()).collect();
        emitted.messages.retain(|id, _| alive.contains(id.as_str()));
    }
    emitted.revision = data.revision;
    drop(emitted);
    let metadata = data.metadata();
    drop(data);
    let _ = app.emit("ai-session-update", json!({"type":"update","session":metadata,"messages":changed}));
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
    // 思考快照只是「此刻在做什么」的实时状态：既不进聊天记录，也不落盘
    // （否则每批 delta 都要重写整个会话文件，长回合下磁盘写放大非常可观）。
    if let Some(object) = value.as_object_mut() { object.remove("thinking"); }
    // 桌面端打开状态由客户端实时上报，落盘后会变成过期标记。
    if let Some(object) = value.as_object_mut() { object.remove("desktopOpen"); }
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
        // 旧版本把后台 Bash 命令（`task_type=local_bash`）也记成了子代理：它们没有
        // 任何子代理消息，点开只能是空抽屉。有 task_type 的按类型剔除；更早的记录
        // 没有该字段，改用 tool_use 对应的工具名兜底（子代理调用才会是 Task / Agent）。
        let before_agents = data.agents.len();
        prune_non_subagent_agents(&mut data);
        let migrated = data.messages.len() != previous_count || data.agents.len() != before_agents;
        if migrated { touch(&mut data); }
        let interrupted = matches!(data.status.as_str(), "running" | "approval" | "background" | "stopping");
        if interrupted {
            data.status = "interrupted".into(); data.approvals.clear();
            usage::finish_turn(&mut data);
            // 进程已随服务重启消失：仍在「执行中」的子代理一律置终态。
            settle_agents(&mut data, "stopped");
            data.error = Some("服务已重启，上次执行已中断，可以继续发送消息".into()); touch(&mut data);
            data.result_revision = data.revision;
        }
        let cell = Arc::new(Cell { data: Mutex::new(data), control: Mutex::new(None), summary: Mutex::default(), emitted: Mutex::default(), deleted: AtomicBool::new(false), path: path.clone() });
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
    let mut snapshot = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.clone();
    snapshot.desktop_open = is_desktop_open(&snapshot.id);
    Ok(snapshot)
}
pub fn list(owner: &str) -> Result<Vec<AiSession>> {
    let mut sessions = Vec::new();
    for entry in fs::read_dir(directory()?).map_err(|e| e.to_string())?.flatten() {
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            if let Some(id) = entry.path().file_stem().and_then(|id| id.to_str()) {
                if let Ok(cell) = load(id, owner) {
                    refresh_title(&cell, false);
                    if let Ok(data) = cell.data.lock() {
                        let mut meta = data.metadata();
                        meta.desktop_open = is_desktop_open(&meta.id);
                        sessions.push(meta);
                    };
                }
            }
        }
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(sessions)
}
fn new_session(owner: &str, input: CreateAiSession) -> Result<AiSession> {
    if !matches!(input.provider.as_str(), "claude" | "codex") { return Err("请选择 Claude 或 Codex".into()); }
    if input.model.as_ref().is_some_and(|v| !v.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/[]@+".contains(c))) { return Err("模型名称无效".into()); }
    if let Some(resume_id) = input.resume_session_id.clone().filter(|id| !id.trim().is_empty()) {
        return resume_from_history(owner, input, &resume_id);
    }
    let selection = super::ai_catalog_service::selection(&input.provider, input.provider_id.as_deref(), input.model.as_deref())?;
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let data = AiSession { id: id.clone(), title: "新对话".into(), provider: input.provider,
        provider_id: selection.as_ref().map(|(id, _)| id.clone()), provider_name: selection.map(|(_, name)| name),
        project_path: input.project_path, model: input.model.filter(|m| !m.trim().is_empty()),
        status: "idle".into(), messages: Vec::new(), approvals: Vec::new(), error: None,
        usage: Some(usage::initial()), usage_checkpoint: None,
        created_at: now, updated_at: now, revision: 1, result_revision: 0, owner: owner.into(), thread_id: None, request_ids: Vec::new(), pending_inputs: Vec::new(),
        slash_catalog: None, todos: Vec::new(), agents: Vec::new(), thinking: None, compactions: 0, desktop_open: false };
    Ok(data)
}
/// 创建/恢复会话时就把配置里已知的上下文窗口写进用量：首条消息发出前，
/// 界面也能显示最大上下文，不必等 CLI 的第一份用量报告。
fn seed_context_window(data: &mut AiSession) {
    if data.usage.is_none() { return; }
    let window = super::ai_catalog_service::configured_context_window(
        &data.provider, data.provider_id.as_deref(), data.model.as_deref());
    usage::configured_window(data, window);
}
fn save_new_session(mut data: AiSession) -> Result<AiSession> {
    seed_context_window(&mut data);
    let cell = Arc::new(Cell { data: Mutex::new(data.clone()), control: Mutex::new(None), summary: Mutex::default(), emitted: Mutex::default(), deleted: AtomicBool::new(false), path: directory()?.join(format!("{}.json", data.id)) });
    persist(&cell)?;
    registry().lock().map_err(|_| "AI 会话状态不可用")?.insert(cell.path.clone(), cell);
    // 新建/恢复会话即时广播：桌面端据此补开聊天标签（不抢焦点），
    // 与终端会话的 `terminal-created` 对齐。手机 App 建会话时桌面端也能看到。
    if let Some(app) = APP.get() {
        let _ = app.emit("ai-session-created", json!({"type": "created", "session": data.metadata()}));
    }
    Ok(data)
}

/// 恢复历史会话时预填的最大消息条数：按 seq 从尾部截取，避免超大转录拖慢创建。
const RESUME_PREFILL_MESSAGES: usize = 300;

/// CLI 历史会话的分发入口：三种 Agent 共用 `models::session_history` 协议。
pub fn list_history(agent: &str, include_archived: bool, project_dir: Option<&str>) -> Result<Vec<crate::models::session_history::SessionHistoryItem>> {
    match agent {
        "claude" => super::claude_history_service::list_sessions(include_archived, project_dir),
        "codex" => super::codex_history_service::list_sessions(include_archived, project_dir),
        _ => Err("未知 Agent，请选择 Claude 或 Codex".into()),
    }
}

/// 打开历史列表前的增量索引（与 PC 端历史面板同一入口，剩余由后台补齐）。
pub fn rescan_history(app: &crate::runtime::AppHandle, agent: &str) -> Result<crate::models::session_history::SessionHistoryScanResult> {
    match agent {
        "claude" => super::claude_history_service::scan_and_index(app),
        "codex" => super::codex_history_service::scan_and_index(app),
        _ => Err("未知 Agent，请选择 Claude 或 Codex".into()),
    }
}

/// 读取历史会话回放页（分页），三种 Agent 返回同一协议结构。
pub fn replay_page(agent: &str, session_id: &str, offset: usize, limit: usize) -> Result<crate::models::session_history::SessionReplayPage> {
    match agent {
        "claude" => super::claude_history_service::get_replay(session_id, offset, limit),
        "codex" => super::codex_history_service::get_replay(session_id, offset, limit),
        _ => Err("未知 Agent，请选择 Claude 或 Codex".into()),
    }
}

/// 从 CLI 历史会话恢复为原生 AI 会话：绑定历史线程并预填最近消息，之后的发送
/// 走各 Agent 已有的续接通道（Claude `--resume`、Codex `thread/resume`）。
fn resume_from_history(owner: &str, input: CreateAiSession, resume_id: &str) -> Result<AiSession> {
    // 恢复全程持锁（审查 M-16，对齐 codex 侧 RESUME_LOCK）：find_by_thread 与落盘
    // 注册之间存在窗口，重复点击/双端同时恢复会各自新建一个绑定同一线程的会话。
    static RESUME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = RESUME_LOCK.lock().map_err(|_| "历史会话恢复锁不可用")?;
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
            seed_context_window(&mut data);
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
                    // 消息被整段替换后按新历史回填清单，否则会留下上一版预填的幽灵条目。
                    data.todos = todos_from_messages(&data.messages);
                    // 只落盘消息，不动 updated_at / revision / 标题，避免最近列表重排与在途实时流被打扰。
                    if persist_data(&cell, &data).is_err() { *data = before; }
                }
            }
        }
        return Ok(data.clone());
    }
    let id = Uuid::new_v4().to_string();
    let path = directory()?.join(format!("{id}.json"));
    let title = if first.title.trim().is_empty() { "恢复的对话".to_string() } else { first.title };
    let messages = prefill_history_messages(provider, resume_id, first.total.max(0) as usize)?;
    // 历史预填里可能带 TodoWrite 摘要：据此还原底部清单（agents 不回填，历史子代理已结束）。
    let todos = todos_from_messages(&messages);
    let mut data = AiSession { id: id.clone(), title, provider: provider.to_string(),
        provider_id, provider_name: selection.map(|(_, name)| name),
        project_path: first.project_dir, model,
        status: "idle".into(), messages, approvals: Vec::new(), error: None,
        usage: Some(usage::initial()), usage_checkpoint: None,
        created_at: chrono::Utc::now().timestamp_millis(), updated_at: chrono::Utc::now().timestamp_millis(), revision: 1, result_revision: 0,
        owner: owner.into(), thread_id: Some(resume_id.to_string()), request_ids: Vec::new(), pending_inputs: Vec::new(),
        slash_catalog: None, todos, agents: Vec::new(), thinking: None, compactions: 0, desktop_open: false };
    seed_context_window(&mut data);
    let cell = Arc::new(Cell { data: Mutex::new(data.clone()), control: Mutex::new(None), summary: Mutex::default(), emitted: Mutex::default(), deleted: AtomicBool::new(false), path });
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
            if !matches!(item.role.as_str(), "user" | "assistant" | "tool") { continue; }
            if !item.text.trim().is_empty() {
                // Skill 展开在历史里已被解析成 `skill_name`：沿用该标记，恢复后渲染成
                // 可折叠的 skill 卡片，而不是把整段技能原文当成用户发送的消息。
                messages.push(AiMessage { id: format!("history-{}", item.seq), role: item.role.clone(), text: item.text.clone(), created_at: item.timestamp.unwrap_or(0), skill_name: item.skill_name.clone(), model_switch: None, subagent_key: None, subagent: None, images: Vec::new(), todo: false });
            }
            // 任务类工具的入参在历史里以工具摘要形式保留：单独成条并打标记供回填清单。
            for (index, tool) in item.tools.iter().enumerate() {
                if !is_task_tool(&tool.name) { continue; }
                let text = if tool.summary.is_empty() { tool.name.clone() } else { format!("{}\n{}", tool.name, tool.summary) };
                messages.push(AiMessage { id: format!("history-{}-{index}", item.seq), role: "tool".into(), text, created_at: item.timestamp.unwrap_or(0), skill_name: None, model_switch: None, subagent_key: None, subagent: None, images: Vec::new(), todo: true });
            }
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
    let mut result = Vec::new();
    for message in &history.messages {
        if !message.text.trim().is_empty() {
            result.push(AiMessage { id: format!("history-{session_id}-{}", message.seq), role: message.role.clone(),
                text: message.text.clone(), created_at: message.timestamp.unwrap_or(history.updated_at),
                skill_name: message.skill_name.clone(), model_switch: None, subagent_key: None, subagent: None, images: Vec::new(), todo: false });
        }
        // 每个工具单独成一条 `工具名\n入参摘要`：任务类工具据此打标记并回填清单，
        // 与实时链路的正文格式完全一致（此前 join 进同一条消息会让回填无从识别）。
        for (index, tool) in message.tools.iter().enumerate() {
            let text = if tool.summary.is_empty() { tool.name.clone() } else { format!("{}\n{}", tool.name, tool.summary) };
            result.push(AiMessage { id: format!("history-{session_id}-{}-{}", message.seq, index), role: "tool".into(),
                text, created_at: message.timestamp.unwrap_or(history.updated_at),
                skill_name: None, model_switch: None, subagent_key: None, subagent: None, images: Vec::new(),
                todo: is_task_tool(&tool.name) });
        }
    }
    result
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
    data.todos = todos_from_messages(&data.messages);
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
    // 跨端同步：其他客户端据此关闭已删除会话的标签。
    if let Some(app) = APP.get() { let _ = app.emit("ai-session-removed", id.to_string()); }
    Ok(())
}
pub fn stop(id: &str, owner: &str) -> Result<()> {
    let cell = load(id, owner)?;
    if let Some(tx) = cell.control.lock().map_err(|_| "AI 会话状态不可用")?.as_ref() {
        tx.send(Control::Stop).map_err(|_| "执行已经结束")?;
        update(&cell, |data| {
            data.status = "stopping".into();
            // 子代理随进程一起被杀：就地置终态，避免界面上残留「执行中」。
            settle_agents(data, "stopped");
            // 中断也算本轮收尾：状态栏不必等 result 事件才能显示速度。
            usage::end_turn(data);
        });
    }
    Ok(())
}

/// 清掉被误记成子代理的后台命令（历史数据迁移）。
///
/// 有 `task_type` 的记录直接按类型剔除；更早的会话没有该字段，则看它的
/// `tool_use_id` 在主线程消息里对应的工具名——后台 Bash 任务的 `tool_use_id`
/// 指向的是 `Bash` 调用，而子代理只由 `Task` / `Agent` 启动。找不到工具消息的
/// 条目（历史被截断）保持原样，宁多勿删。
fn prune_non_subagent_agents(data: &mut AiSession) {
    if data.agents.is_empty() { return; }
    let mut tool_names: HashMap<String, String> = HashMap::new();
    for message in &data.messages {
        if message.subagent.is_some() || message.role != "tool" { continue; }
        let Some((name, _)) = message.text.split_once('\n') else { continue; };
        // 工具消息 id 形如 `{turn}-tool-{tool_use_id}`（结果类是 `-result-`）。
        if let Some(tool_id) = message.id.rsplit_once("-tool-").map(|(_, id)| id) {
            tool_names.entry(tool_id.to_string()).or_insert_with(|| name.to_string());
        }
    }
    data.agents.retain(|agent| {
        if matches!(agent.task_type.as_deref(), Some("local_bash" | "background_shell")) { return false; }
        match agent.tool_use_id.as_deref().and_then(|id| tool_names.get(id)) {
            Some(name) => subagent_tool_name(name),
            None => true,
        }
    });
}

/// 子代理状态落终态：用于中断、进程退出、/clear 等「不会再收到 task_* 事件」的场合。
/// 只处理仍在运行中的条目，已结束的保留原状态与耗时。
fn settle_agents(data: &mut AiSession, status: &str) {
    let now = chrono::Utc::now().timestamp_millis();
    for agent in data.agents.iter_mut().filter(|agent| agent.status == "running") {
        agent.status = status.into();
        agent.ended_at.get_or_insert(now);
        if agent.duration_ms.is_none() {
            agent.duration_ms = Some(now.saturating_sub(agent.started_at).max(0));
        }
    }
}

/// 会话中途切换供应商与模型（仅 Claude 原生会话）。
///
/// 空闲时才允许：先让常驻 CLI 进程退出，再写入新配置与切换分段。下一条消息由
/// `run_turn` 按新配置 `prepare()` 并带 `--resume thread_id` 拉起新进程，上下文续接，对用户无感。
pub fn switch_model(id: &str, owner: &str, provider_id: &str, model: &str) -> Result<AiSession> {
    let cell = load(id, owner)?;
    // 与发送、删除、回合交接共用 control 锁：不会与 start_turn 交错。
    let mut control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if data.provider != "claude" {
        return Err("当前仅 Claude 会话支持切换模型，Codex 会话请新建".into());
    }
    // 空闲会话的 CLI 进程仍常驻（control = Some）：允许切换，先让它退出。
    if data.status != "idle" || !data.pending_inputs.is_empty() {
        return Err("会话正在执行或有排队消息，请等待完成（或先中断）后再切换模型".into());
    }
    let selection = super::ai_catalog_service::selection(&data.provider, Some(provider_id), Some(model))?;
    let (to_provider, to_name) = selection.ok_or("所选供应商无效，请刷新后重新选择")?;
    if data.provider_id.as_deref() == Some(to_provider.as_str()) && data.model.as_deref() == Some(model) {
        return Ok(data.clone());
    }
    // 先结束常驻进程（不会写回文件），再修改配置，避免旧进程在新配置下继续接收消息。
    if let Some(tx) = control.take() { let _ = tx.send(Control::Retire); }
    let before = data.clone();
    let from_label = [before.model.clone(), before.provider_name.clone()].into_iter()
        .flatten().collect::<Vec<_>>().join(" · ");
    let to_label = [Some(model.to_string()), Some(to_name.clone())].into_iter()
        .flatten().collect::<Vec<_>>().join(" · ");
    let switch_text = format!("模型切换：{} → {}", if from_label.is_empty() { "服务端默认" } else { &from_label }, to_label);
    let switch = crate::models::ai_chat::ModelSwitch {
        from_provider: before.provider_name.clone(),
        from_model: before.model.clone(),
        to_provider: Some(to_name.clone()),
        to_model: Some(model.to_string()),
    };
    data.messages.push(AiMessage {
        id: format!("switch-{}", Uuid::new_v4()),
        role: "system".into(),
        text: switch_text,
        created_at: chrono::Utc::now().timestamp_millis(),
        skill_name: None,
        subagent: None,
        subagent_key: None,
        model_switch: Some(switch),
        images: Vec::new(),
        todo: false,
    });
    data.provider_id = Some(to_provider);
    data.provider_name = Some(to_name);
    data.model = Some(model.to_string());
    touch(&mut data);
    if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
    let snapshot = data.clone();
    drop(data);
    drop(control);
    emit_update(&cell);
    Ok(snapshot)
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
/// 单条消息最多附带的图片数量与体积：base64 解码后校验，防止超大附件拖垮会话与 CLI。
const MAX_IMAGE_COUNT: usize = 8;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES: usize = 24 * 1024 * 1024;

/// 把客户端提交的 base64 图片写入 `ClientData/ai-images`，返回只含元数据的附件。
/// 消息与排队项只保存路径，不内嵌 base64，避免会话文件与推送帧被大图撑爆。
fn save_send_images(images: &[SendAiImage]) -> Result<Vec<AiImage>> {
    if images.is_empty() { return Ok(Vec::new()); }
    if images.len() > MAX_IMAGE_COUNT { return Err(format!("一次最多发送 {MAX_IMAGE_COUNT} 张图片")); }
    let dir = PathService::require_data_dir()?.join("ClientData").join("ai-images");
    fs::create_dir_all(&dir).map_err(|e| format!("创建图片目录失败：{e}"))?;
    let engine = base64::engine::general_purpose::STANDARD;
    let mut saved = Vec::with_capacity(images.len());
    let mut total = 0usize;
    for (index, image) in images.iter().enumerate() {
        let (media_type, extension) = normalized_image_type(&image.media_type)
            .ok_or_else(|| format!("第 {} 张图片格式不支持（仅 PNG / JPEG / GIF / WebP）", index + 1))?;
        // 前端直接传 data URL 时也能工作，避免两端各自处理前缀。
        let payload = image.data.split_once(',')
            .filter(|(head, _)| head.starts_with("data:"))
            .map(|(_, body)| body)
            .unwrap_or(&image.data);
        let bytes = engine.decode(payload.trim()).map_err(|_| format!("第 {} 张图片数据无效", index + 1))?;
        if bytes.is_empty() { return Err(format!("第 {} 张图片为空", index + 1)); }
        if bytes.len() > MAX_IMAGE_BYTES { return Err(format!("第 {} 张图片超过 10MB", index + 1)); }
        if !looks_like_image(media_type, &bytes) {
            return Err(format!("第 {} 张图片数据与格式不匹配", index + 1));
        }
        total = total.saturating_add(bytes.len());
        if total > MAX_IMAGE_TOTAL_BYTES { return Err("图片总大小超过 24MB".into()); }
        let path = dir.join(format!("{}.{}", Uuid::new_v4(), extension));
        fs::write(&path, bytes).map_err(|e| format!("保存图片失败：{e}"))?;
        saved.push(AiImage {
            path: path.to_string_lossy().to_string(),
            media_type: media_type.to_string(),
            name: if image.name.trim().is_empty() { format!("图片{}", index + 1) }
                else { image.name.chars().take(120).collect() },
        });
    }
    Ok(saved)
}

fn normalized_image_type(input: &str) -> Option<(&'static str, &'static str)> {
    match input.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some(("image/png", "png")),
        "image/jpeg" | "image/jpg" => Some(("image/jpeg", "jpg")),
        "image/gif" => Some(("image/gif", "gif")),
        "image/webp" => Some(("image/webp", "webp")),
        _ => None,
    }
}

/// 轻量魔数校验：拒绝把任意文件伪装成图片送进多模态内容块。
fn looks_like_image(media_type: &str, bytes: &[u8]) -> bool {
    match media_type {
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => bytes.starts_with(b"GIF8"),
        "image/webp" => bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

/// Claude stream-json 的图片内容块：从落盘文件重新编码为 base64。
fn claude_image_blocks(images: &[AiImage]) -> Result<Vec<Value>> {
    let engine = base64::engine::general_purpose::STANDARD;
    images.iter().map(|image| {
        let bytes = fs::read(&image.path).map_err(|e| format!("无法读取图片附件：{e}"))?;
        Ok(json!({"type":"image","source":{"type":"base64","media_type":image.media_type,"data":engine.encode(bytes)}}))
    }).collect()
}

/// Codex app-server `turn/start` 的 input：文本 + `localImage` 绝对路径，由 CLI 自己读文件。
fn codex_user_input(text: &str, images: &[AiImage]) -> Value {
    let mut input = Vec::with_capacity(images.len() + 1);
    if !text.is_empty() { input.push(json!({"type":"text","text":text})); }
    for image in images { input.push(json!({"type":"localImage","path":image.path})); }
    Value::Array(input)
}

pub fn send(id: &str, owner: &str, input: SendAiMessage) -> Result<AiSession> {
    let cell = load(id, owner)?;
    let outcome = send_locked(&cell, input);
    emit_update(&cell);
    outcome
}
fn send_locked(cell: &Arc<Cell>, input: SendAiMessage) -> Result<AiSession> {
    let SendAiMessage { text, request_id, steer, images: draft_images } = input;
    if text.trim().is_empty() && draft_images.is_empty() { return Err("消息不能为空".into()); }
    Uuid::parse_str(&request_id).map_err(|_| "消息请求标识无效")?;
    let mut control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if !cell.path.is_file() { return Err("AI 会话不存在".into()); }
    if data.request_ids.contains(&request_id) { return Ok(data.clone()); }
    // 幂等检查通过后再落盘，重试同一请求不会重复写文件。
    let images = save_send_images(&draft_images)?;
    // 原生插话，或会话空闲且没有排队消息时，直接把消息交给当前 CLI 进程。
    // 插话由 CLI 自己决定在合适节点消费；排队则等当前回合任务完全结束后再写入同一个进程。
    let idle_delivery = data.status == "idle" && data.pending_inputs.is_empty();
    if let Some(tx) = control.as_ref().filter(|_| data.status != "stopping" && (steer || idle_delivery)) {
        return deliver_now(&cell, &mut data, tx, request_id, text, images);
    }
    if control.is_some() {
        // 执行期间只入队，当前回合结束后由 worker 直接写入同一个 CLI 进程，不需要 --resume。
        let before = data.clone();
        data.request_ids.push(request_id.clone());
        data.pending_inputs.push(PendingInput { text, request_id, images });
        touch(&mut data);
        let snapshot = data.clone();
        if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
        return Ok(snapshot);
    }
    let before = data.clone();
    data.request_ids.push(request_id.clone());
    // 新消息进队尾，先启动队首：中断/出错后保留的排队消息仍按用户发送顺序执行。
    data.pending_inputs.push(PendingInput { text, request_id, images });
    let next = begin_pending_turn(&mut data).ok_or("没有排队中的消息")?;
    let snapshot = data.clone();
    if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
    if let Err(error) = start_turn(cell, next, &mut control) {
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
    let outcome = flush_locked(&cell, request_id);
    emit_update(&cell);
    outcome
}
fn flush_locked(cell: &Arc<Cell>, request_id: Option<&str>) -> Result<()> {
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
        accept_input(&mut data, &item.request_id, &item.text, &item.images);
        if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
        if tx.send(Control::Message { text: item.text, request_id: item.request_id, images: item.images }).is_err() {
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
    if let Err(error) = start_turn(cell, next, &mut control) {
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
    request_id: String, text: String, images: Vec<AiImage>) -> Result<AiSession> {
    let before = data.clone();
    accept_input(data, &request_id, &text, &images);
    let snapshot = data.clone();
    if let Err(error) = persist_data(cell, data) { *data = before; return Err(error); }
    if control.send(Control::Message { text, request_id, images }).is_err() {
        *data = before;
        persist_data(cell, data)?;
        return Err("服务端进程已退出，请再次发送消息".into());
    }
    Ok(snapshot)
}

/// 会话首条消息的标题：纯图片消息没有正文，用图片数量兜底。
fn input_title(text: &str, images: &[AiImage]) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() { format!("{} 张图片", images.len()) } else { trimmed.chars().take(36).collect() }
}

/// 立即写入聊天记录；排队消息出队时由 begin_pending_turn 完成同样的登记。
fn accept_input(data: &mut AiSession, request_id: &str, text: &str, images: &[AiImage]) {
    // 空闲态直达的消息开启新回合：上一轮的任务清单与子代理不再适用，清空以免残留。
    let new_turn = data.status == "idle";
    if !data.request_ids.iter().any(|id| id == request_id) { data.request_ids.push(request_id.to_string()); }
    data.messages.push(AiMessage { id: request_id.to_string(), role: "user".into(), text: text.into(),
        created_at: chrono::Utc::now().timestamp_millis(), skill_name: None, model_switch: None, subagent_key: None, subagent: None,
        images: images.to_vec(), todo: false });
    if new_turn { data.todos.clear(); data.agents.clear(); }
    if data.title == "新对话" { data.title = input_title(text, images); }
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
    let outcome = change_pending_input_locked(&cell, request_id, text);
    emit_update(&cell);
    outcome
}
fn change_pending_input_locked(cell: &Cell, request_id: &str, text: Option<String>) -> Result<AiSession> {
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
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_turn(&worker_cell, &next, rx)))
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
        created_at: chrono::Utc::now().timestamp_millis(), skill_name: None, model_switch: None, subagent_key: None, subagent: None,
        images: next.images.clone(), todo: false });
    if data.title == "新对话" { data.title = input_title(&next.text, &next.images); }
    usage::begin_turn(data);
    // 新一轮任务开始：上一轮的任务清单、子代理与思考快照不再对应当前上下文，清空以免残留误导。
    data.todos.clear(); data.agents.clear();
    data.thinking = None;
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
    drop(data);
    emit_update(cell);
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
    let outcome = match persist_data(cell, &data) {
        Ok(()) => Ok(()),
        Err(error) => { data.title = previous_title; data.revision = previous_revision; Err(error) }
    };
    drop(data);
    drop(_control);
    emit_update(cell);
    outcome
}
fn finish(cell: &Arc<Cell>, result: Result<()>) {
    let succeeded = result.is_ok();
    refresh_title(cell, true);
    let Ok(mut control) = cell.control.lock() else { return; };
    let Ok(mut data) = cell.data.lock() else { return; };
    let was_active = matches!(data.status.as_str(), "running" | "approval" | "background" | "stopping");
    data.approvals.clear();
    usage::finish_turn(&mut data);
    // 进程已退出：不再会有 task_* 事件，仍在「执行中」的子代理就地置终态。
    settle_agents(&mut data, "stopped");
    // 思考实时状态随回合结束清空（它是过程量，不是聊天记录）。
    thinking_clear(&mut data);
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
    // 回合收尾后推送最终状态：解锁后再发，避免事件回调与状态锁互等。
    drop(data);
    drop(control);
    emit_update(cell);
}
fn update(cell: &Cell, action: impl FnOnce(&mut AiSession)) {
    if let Ok(mut data) = cell.data.lock() { action(&mut data); touch(&mut data); }
    emit_update(cell);
}
fn update_usage(cell: &Cell, action: impl FnOnce(&mut AiSession) -> bool) {
    if let Ok(mut data) = cell.data.lock() { if action(&mut data) { touch(&mut data); } }
    emit_update(cell);
}
fn message(cell: &Cell, key: &str, role: &str, text: &str, append: bool) {
    if text.is_empty() { return; }
    update(cell, |data| {
        // 倒序查找：流式增量命中的几乎总是尾部消息，长会话下避免逐 token 全表扫描。
        if let Some(item) = data.messages.iter_mut().rev().find(|m| m.id == key) {
            if append { item.text.push_str(text); } else { item.text = text.into(); }
        } else {
            data.messages.push(AiMessage { id: key.into(), role: role.into(), text: text.into(),
                created_at: chrono::Utc::now().timestamp_millis(), skill_name: None, model_switch: None, subagent_key: None, subagent: None, images: Vec::new(), todo: false });
        }
    });
}
/// TodoWrite 的工具调用/结果消息：正文原样保留（历史恢复据此回填清单），
/// 只打 `todo` 标记让前端跳过渲染。
fn message_todo(cell: &Cell, key: &str, role: &str, text: &str) {
    if text.is_empty() { return; }
    update(cell, |data| {
        if let Some(item) = data.messages.iter_mut().rev().find(|m| m.id == key) {
            item.text = text.into();
            item.todo = true;
        } else {
            data.messages.push(AiMessage { id: key.into(), role: role.into(), text: text.into(),
                created_at: chrono::Utc::now().timestamp_millis(), skill_name: None, model_switch: None,
                subagent_key: None, subagent: None, images: Vec::new(), todo: true });
        }
    });
}
/// TodoWrite 的 `input.todos` → 会话任务清单（全量快照，直接整体替换）。
/// 未知 status 归一为 pending：前端只认识三种状态，多出来的值会被渲染成空行。
fn parse_todos(value: &Value) -> Vec<AiTodo> {
    value.as_array().map(|items| items.iter().filter_map(|item| {
        let content = item["content"].as_str()?.trim();
        if content.is_empty() { return None; }
        Some(AiTodo {
            content: content.to_string(),
            status: normalize_todo_status(item["status"].as_str()).unwrap_or_else(|| "pending".into()),
            active_form: item["activeForm"].as_str().map(str::trim)
                .filter(|text| !text.is_empty()).map(str::to_string),
        })
    }).collect()).unwrap_or_default()
}

/// 任务状态归一：`TaskUpdate` 与 `TodoWrite` 共用同一条映射，未知值返回 None（不改动）。
fn normalize_todo_status(status: Option<&str>) -> Option<String> {
    Some(match status? {
        "completed" => "completed", "in_progress" | "inProgress" | "running" => "in_progress",
        "pending" | "not_started" => "pending",
        _ => return None,
    }.to_string())
}

/// `TaskCreate` 的调用先记住内容，等结果里的真实任务号回来再落位。
enum PendingTaskCall {
    Create { content: String, active_form: Option<String> },
}

/// 任务编号在清单里的位置：CLI 的编号从 1 开始递增，清单里的第 N 条即编号 N。
/// 编号越界（清单尚未同步）时返回 None，由调用方决定追加到末尾。
fn task_position(todos: &[AiTodo], task_id: &str) -> Option<usize> {
    let number: usize = task_id.trim_start_matches('#').parse().ok()?;
    let index = number.checked_sub(1)?;
    (index < todos.len()).then_some(index)
}

/// `TaskUpdate` 的增量补丁：只改请求里出现的字段。
fn apply_todo_patch(todo: &mut AiTodo, status: Option<String>, subject: Option<String>, active_form: Option<String>) {
    if let Some(status) = status { todo.status = status; }
    if let Some(subject) = subject { todo.content = subject; }
    if let Some(active_form) = active_form { todo.active_form = Some(active_form); }
}

/// 任务类工具名（TodoWrite 全量快照 + Task* 增量）。历史索引只保留工具名与摘要，
/// 因此这里也用于判定「这条历史消息属于任务工具」。
fn is_task_tool(name: &str) -> bool {
    matches!(name, "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet")
}

/// 启动子代理的工具名：Claude CLI 2.1.x 起由 `Task` 改称 `Agent`，
/// 两代名字都会出现在历史会话与实时 stream-json 里。
fn subagent_tool_name(name: &str) -> bool {
    matches!(name, "Task" | "Agent")
}

/// `TaskList` 的结果解析：每行形如 `#1 [completed] 读取 AGENTS.md`。
fn parse_task_list(text: &str) -> Option<Vec<(String, String, String)>> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('#') else { continue };
        let (number, rest) = rest.split_once(' ')?;
        if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) { return None; }
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('[') else { return None; };
        let (status, rest) = rest.split_once(']')?;
        let status = normalize_todo_status(Some(status.trim()))?;
        let content = rest.trim();
        if content.is_empty() { return None; }
        rows.push((number.to_string(), status, content.to_string()));
    }
    (!rows.is_empty()).then_some(rows)
}
/// 从历史消息回填任务清单：倒序找最后一条 TodoWrite 工具消息（带 `todo` 标记，
/// 或本功能上线前写入的 `tools` 角色原文），解析正文里的完整 input JSON。
/// 历史索引里的工具入参会被截断，解析失败静默跳过。
fn todos_from_messages(messages: &[AiMessage]) -> Vec<AiTodo> {
    // Task* 序列没有全量快照：正序重放调用与结果，用同一套状态机还原本轮清单。
    // 先判断是否存在 Task* 记录，避免对只有 TodoWrite 的会话白跑一遍。
    let has_task_calls = messages.iter().any(|message| message.todo && message.text.split_once('\n')
        .map(|(name, _)| name.trim()).is_some_and(is_task_tool)
        && !message.text.starts_with("TodoWrite\n"));
    if has_task_calls { return todos_from_task_calls(messages); }
    messages.iter().rev()
        .filter(|message| message.todo || (message.role == "tool" && message.text.contains("TodoWrite\n")))
        .find_map(|message| {
            // 正文可能由多段工具摘要拼接（历史预填），定位 TodoWrite 之后的第一段 JSON。
            let start = message.text.find("TodoWrite\n")? + "TodoWrite\n".len();
            let mut stream = serde_json::Deserializer::from_str(&message.text[start..]);
            let input = Value::deserialize(&mut stream).ok()?;
            input.get("todos").map(parse_todos)
        })
        .unwrap_or_default()
}

/// 历史里的 Task* 序列还原：`TaskCreate` 的调用记内容、其结果给编号，
/// `TaskUpdate` 按编号改状态，`TaskList` 结果整表校准。
/// 解析不了的条目静默跳过——历史索引会截断长文本。
fn todos_from_task_calls(messages: &[AiMessage]) -> Vec<AiTodo> {
    // 只需要 todos 一个字段：用一个空清单做载体，避免为回填构造完整会话。
    let mut todos: Vec<AiTodo> = Vec::new();
    // 尚未遇到结果的创建调用，按出现顺序排队。历史预填的 id 是 `history-{seq}`，
    // 无法与结果行按 tool_use_id 配对，因此用 FIFO 顺序消耗（CLI 总是先发调用再发结果）。
    let mut pending: std::collections::VecDeque<(String, Option<String>)> = std::collections::VecDeque::new();
    for message in messages {
        // 任务工具的结果行本身不带 `todo` 标记（它与调用是两条独立的历史条目），
        // 因此这里既要收带标记的调用，也要收可能是结果的普通工具消息。
        let maybe_result = message.role == "tool";
        if !message.todo && !maybe_result { continue; }
        // 结果行（`Task #1 created successfully: …` / `#1 [completed] …`）没有工具名，单独认。
        if !message.text.starts_with("TaskCreate\n") && !message.text.starts_with("TaskUpdate\n")
            && !message.text.starts_with("TaskList\n") && !message.text.starts_with("TodoWrite\n") {
            // TaskList 的结果是多行 `#N [status] 标题`：整表校准。
            if let Some(rows) = parse_task_list(&message.text) {
                todos = rows.into_iter().map(|(_, status, content)| AiTodo { content, status, active_form: None }).collect();
                continue;
            }
            if let Some((task_id, content)) = created_task(&message.text) {
                let active_form = pending.pop_front().and_then(|(_, active_form)| active_form);
                let position = task_position(&todos, &task_id).unwrap_or(todos.len());
                let todo = AiTodo { content, status: "pending".into(), active_form };
                if position < todos.len() { todos.insert(position, todo); } else { todos.push(todo); }
            }
            continue;
        }
        // 历史里工具结果为独立消息（`Updated task #1 status`），只带编号：状态由调用里的 input 决定。
        let (name, json) = message.text.split_once('\n').unwrap_or((&message.text, ""));
        let Ok(input) = serde_json::from_str::<Value>(json.trim()) else { continue };
        match name.trim() {
            "TaskCreate" => {
                let content = text_field(&input, "subject").or_else(|| text_field(&input, "content"))
                    .unwrap_or_else(|| "新任务".into());
                pending.push_back((content, text_field(&input, "activeForm")));
            }
            "TaskUpdate" => {
                let Some(task_id) = text_field(&input, "taskId").or_else(|| input["taskId"].as_i64().map(|id| id.to_string())) else { continue };
                if let Some(index) = task_position(&todos, &task_id) {
                    apply_todo_patch(&mut todos[index], normalize_todo_status(input["status"].as_str()),
                        text_field(&input, "subject"), text_field(&input, "activeForm"));
                }
            }
            _ => {}
        }
    }
    // 没有编号结果的创建调用（结果被截断时）：按出现顺序补在末尾，保持可见。
    for (content, active_form) in pending {
        todos.push(AiTodo { content, status: "pending".into(), active_form });
    }
    todos
}

/// `Task #1 created successfully: 读取 AGENTS.md` → (编号, 标题)。
fn created_task(text: &str) -> Option<(String, String)> {
    let rest = text.trim().strip_prefix("Task #")?;
    let (number, rest) = rest.split_once(" created")?;
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) { return None; }
    let title = rest.split_once(':').map(|(_, title)| title.trim()).filter(|title| !title.is_empty())?;
    Some((number.to_string(), title.to_string()))
}
fn message_with_skill(cell: &Cell, key: &str, name: &str, text: &str) {
    if text.is_empty() { return; }
    update(cell, |data| {
        if let Some(item) = data.messages.iter_mut().find(|m| m.id == key) {
            item.text = text.into();
            item.skill_name = Some(name.into());
        } else {
            data.messages.push(AiMessage { id: key.into(), role: "user".into(), text: text.into(),
                created_at: chrono::Utc::now().timestamp_millis(), skill_name: Some(name.into()), model_switch: None, subagent_key: None, subagent: None, images: Vec::new(), todo: false });
        }
    });
}
/// 流式 token 增量的静默写入：只更新数据不立即推送。
/// CLI 的 partial 流每秒可产出几十条 text_delta，逐条 emit 会造成 IPC 与前端重渲染风暴；
/// 调用方（run_claude 批处理循环）在整批事件处理完后统一 emit_update。
fn message_append_quiet(cell: &Cell, key: &str, text: &str) {
    if text.is_empty() { return; }
    if let Ok(mut data) = cell.data.lock() {
        if let Some(item) = data.messages.iter_mut().rev().find(|m| m.id == key) {
            item.text.push_str(text);
        } else {
            data.messages.push(AiMessage { id: key.into(), role: "assistant".into(), text: text.into(),
                created_at: chrono::Utc::now().timestamp_millis(), skill_name: None, model_switch: None, subagent_key: None, subagent: None, images: Vec::new(), todo: false });
        }
        touch(&mut data);
    }
}
/// 子代理（Task 工具启动）消息：携带 subagent 标记，前端合并为可折叠的「子代理」条目。
/// 已存在的消息总是覆盖名字：流式早期可能先以兜底名 "subagent" 建立条目，
/// Task 登记的准确名称随完整消息到达。
fn message_with_subagent(cell: &Cell, key: &str, group: &str, role: &str, text: &str, agent: &str) {
    if text.is_empty() { return; }
    update(cell, |data| {
        if let Some(item) = data.messages.iter_mut().rev().find(|m| m.id == key) {
            item.text = text.into();
            item.subagent = Some(agent.into());
            item.subagent_key = Some(group.into());
        } else {
            data.messages.push(AiMessage { id: key.into(), role: role.into(), text: text.into(),
                created_at: chrono::Utc::now().timestamp_millis(), skill_name: None, model_switch: None,
                subagent: Some(agent.into()), subagent_key: Some(group.into()), images: Vec::new(), todo: false });
        }
    });
}
/// 子代理消息的流式增量：静默写入，批末统一推送（同 message_append_quiet）。
/// group 为分组键（turn + parent_tool_use_id），同一子代理共享（审查 V-5）。
fn message_sub_quiet(cell: &Cell, key: &str, group: &str, text: &str, agent: &str) {
    if text.is_empty() { return; }
    if let Ok(mut data) = cell.data.lock() {
        if let Some(item) = data.messages.iter_mut().rev().find(|m| m.id == key) {
            item.text.push_str(text);
            if item.subagent_key.is_none() { item.subagent_key = Some(group.into()); }
        } else {
            data.messages.push(AiMessage { id: key.into(), role: "assistant".into(), text: text.into(),
                created_at: chrono::Utc::now().timestamp_millis(), skill_name: None, model_switch: None,
                subagent: Some(agent.into()), subagent_key: Some(group.into()), images: Vec::new(), todo: false });
        }
        touch(&mut data);
    }
}
/// 思考快照只保留尾部若干字符：一是思考可能长达数万字（实测单段最大 2.3 万字），
/// 每帧全量下发会撑爆 IPC；二是前端折叠态只显示最后一两句。截断点回退到最近的
/// 换行/句号，避免把半句话当成开头展示。
const THINKING_TAIL_CHARS: usize = 4000;

fn thinking_tail(text: &str) -> String {
    let count = text.chars().count();
    if count <= THINKING_TAIL_CHARS { return text.to_string(); }
    let tail: String = text.chars().skip(count - THINKING_TAIL_CHARS).collect();
    // 回退到最近的段落/句子边界，最多再丢 200 字。窗口按字符数切，
    // 不能按字节切：中文一个字三字节，字节下标会落在字符中间直接 panic。
    let window: String = tail.chars().take(200).collect();
    let cut = window.rfind('\n').or_else(|| window.rfind("。")).or_else(|| window.rfind('.'))
        .map(|at| at + window[at..].chars().next().map_or(0, char::len_utf8))
        .filter(|at| *at > 0);
    match cut {
        Some(at) => tail[at..].to_string(),
        None => tail,
    }
}

/// 思考增量：静默写入会话级 `thinking` 快照，批末统一推送
/// （与 message_append_quiet 同一套节流，思考 delta 的频率同样是 token 级）。
/// 子代理的思考不记录：那属于子代理抽屉的内容，混进主线程快照会让用户分不清
/// 「主线程在等子代理」和「主线程自己在想」。
fn thinking_append_quiet(cell: &Cell, text: &str) {
    if text.is_empty() { return; }
    if let Ok(mut data) = cell.data.lock() {
        let now = chrono::Utc::now().timestamp_millis();
        match data.thinking.as_mut() {
            Some(thinking) if thinking.active => {
                thinking.text.push_str(text);
                thinking.total_chars += text.chars().count() as u64;
                thinking.updated_at = now;
                let tail = thinking_tail(&thinking.text);
                thinking.text = tail;
            }
            // 上一段已结束（正文/工具已开始）：开新的一段。
            _ => {
                data.thinking = Some(crate::models::ai_chat::AiThinking {
                    text: thinking_tail(text),
                    started_at: now,
                    updated_at: now,
                    active: true,
                    blocks: data.thinking.as_ref().map_or(1, |previous| previous.blocks + 1),
                    total_chars: text.chars().count() as u64,
                });
            }
        }
        touch(&mut data);
    }
}

/// 完整快照里的整段思考：没有 delta 流可追加时，直接用这段覆盖当前思考段。
/// 已有更长的活动段时不覆盖（delta 与快照会重复到达，快照可能反而是旧的）。
fn thinking_replace_quiet(cell: &Cell, text: &str) {
    if let Ok(mut data) = cell.data.lock() {
        let chars = text.chars().count();
        let replace = match data.thinking.as_ref() {
            Some(thinking) => !thinking.active || thinking.text.chars().count() < chars,
            None => true,
        };
        if !replace { return; }
        let now = chrono::Utc::now().timestamp_millis();
        let blocks = data.thinking.as_ref().map_or(1, |previous| previous.blocks.max(1));
        data.thinking = Some(crate::models::ai_chat::AiThinking {
            text: thinking_tail(text),
            started_at: data.thinking.as_ref().map_or(now, |previous| previous.started_at),
            updated_at: now,
            active: false,
            blocks,
            total_chars: chars as u64,
        });
        touch(&mut data);
    }
}

/// 思考块结束：保留文本供前端展开回看，但标记为非活动，下次思考开新段。
fn thinking_finish(cell: &Cell) {
    if let Ok(mut data) = cell.data.lock() {
        match data.thinking.as_mut() {
            Some(thinking) if thinking.active => {
                thinking.active = false;
                thinking.updated_at = chrono::Utc::now().timestamp_millis();
                touch(&mut data);
            }
            _ => return,
        }
    }
}

/// 回合收尾时清空思考快照：它只是「此刻在做什么」的实时状态，不是聊天记录。
fn thinking_clear(data: &mut AiSession) {
    if data.thinking.take().is_some() { touch(data); }
}

/// 常驻 CLI 子进程 + 它的进程树。退出时整棵树一起回收：CLI 会派生 node / shell /
/// 子代理等后代，只杀直接子进程会留下孤儿。Windows 走 Job Object（不再 spawn
/// `taskkill`：GUI 子系统下它会弹控制台并打报错，且 PID 复用后可能杀错进程），
/// Unix 走进程组信号 + `child.kill()` 兜底。
struct Process(Child, ProcessTree);
impl Process {
    fn spawn(command: &mut Command, provider: &str) -> Result<Self> {
        let child = command.spawn()
            .map_err(|e| format!("无法启动 {}，请确认服务端已安装并配置该 CLI：{e}", provider))?;
        let tree = ProcessTree::attach(&child);
        Ok(Self(child, tree))
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        { let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", self.0.id())]).stdout(Stdio::null()).stderr(Stdio::null()).status(); }
        self.1.terminate(&mut self.0);
        let _ = self.0.wait();
    }
}
fn cli_command(provider: &str) -> Command {
    let configured = std::env::var_os(match provider {
        "claude" => "TERMINAL_BUDDY_CLAUDE_BIN", _ => "TERMINAL_BUDDY_CODEX_BIN",
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
/// CLI 以 `result` + `is_error` 返回的中断类提示：只是本段回复被打断，
/// 不该把整个会话判为失败（用户仍可继续发送）。
fn is_interrupt_notice(detail: &str) -> bool {
    let text = detail.to_ascii_lowercase();
    ["interrupt", "aborted", "cancelled", "canceled", "stopped by user"]
        .iter().any(|needle| text.contains(needle))
        || detail.contains("已中断") || detail.contains("被中断") || detail.contains("用户中断")
}

fn write_claude_user(stdin: &mut impl Write, session_id: &str, text: &str, images: &[AiImage]) -> Result<()> {
    if images.is_empty() {
        return write_json(stdin, json!({"type":"user","message":{"role":"user","content":text},
            "parent_tool_use_id":null,"session_id":session_id}));
    }
    // 带图片时改用内容块数组：文本在前，图片以 base64 内联，CLI 直接交给多模态模型。
    let mut content = Vec::with_capacity(images.len() + 1);
    if !text.is_empty() { content.push(json!({"type":"text","text":text})); }
    content.extend(claude_image_blocks(images)?);
    write_json(stdin, json!({"type":"user","message":{"role":"user","content":content},
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
    if let Err(error) = write_claude_user(stdin, &session_id, &next.text, &next.images) {
        *data = before;
        let _ = persist_data(cell, &data);
        return Err(error);
    }
    Ok(Some(()))
}
fn run_turn(cell: &Cell, prompt: &PendingInput, controls: mpsc::Receiver<Control>) -> Result<WorkerExit> {
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
            "--permission-prompt-tool", "stdio",
            // 子代理的文本与思考默认不转发：不加这个开关时，子代理抽屉里只能看到
            // 工具调用与结果，「该子代理干了什么、说了什么」完全缺失。
            "--forward-subagent-text"]);
        if let Some(id) = &session.thread_id { command.arg("--resume").arg(id); }
        if let Some(model) = &session.model { command.arg("--model").arg(model); }
    } else {
        // 新旧对话均优先使用普通模式的标准提问工具；动态工具仅作补充。
        command.args(&permissions.codex_args).args(["-c", "features.default_mode_request_user_input=true"]).arg("app-server");
    }
    let mut process = Process::spawn(&mut command, &session.provider)?;
    let mut stdin = process.0.stdin.take().ok_or("AI 输入通道不可用")?;
    let stdout = process.0.stdout.take().ok_or("AI 输出通道不可用")?;
    let stderr = process.0.stderr.take().ok_or("AI 错误通道不可用")?;
    let errors = Arc::new(Mutex::new(String::new()));
    let error_buffer = errors.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr); let mut buffer = [0; 2048];
        while let Ok(size) = reader.read(&mut buffer) { if size == 0 { break; }
            if let Ok(mut text) = error_buffer.lock() {
                text.push_str(&String::from_utf8_lossy(&buffer[..size]));
                // stderr 只用于错误提示，长期运行的 CLI 可能持续输出；按字节上限
                // 保留尾部，避免缓冲无界增长。
                const STDERR_CAP: usize = 16 * 1024;
                if text.len() > STDERR_CAP {
                    let mut cut = text.len() - STDERR_CAP;
                    while cut < text.len() && !text.is_char_boundary(cut) { cut += 1; }
                    text.drain(..cut);
                }
            }
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
        write_claude_user(&mut stdin, session.thread_id.as_deref().unwrap_or(""), &prompt.text, &prompt.images)?;
        run_claude(cell, &mut process, stdin, controls, output, errors, hooks.as_ref().ok_or("Claude 决策 Hook 未初始化")?)
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
    /// Task 工具的 tool_use_id → 子代理显示名（subagent_type，缺失时回落 description）。
    /// 带 parent_tool_use_id 的消息据此打上 subagent 标记。
    subagents: HashMap<String, String>,
    /// 主线程 TodoWrite 的 tool_use_id：对应的 tool_result 也要打 `todo` 标记，
    /// 与工具调用成对跳过渲染。
    todo_tools: HashSet<String>,
    /// 工具调用 id → TaskCreate/TaskUpdate 的序号：TaskCreate 的结果（`Task #1 created
    /// successfully`）是异步回来的，只能先记住"这个调用会创建任务"，等结果到达再落位。
    pending_tasks: HashMap<String, PendingTaskCall>,
    /// 子代理当前流式消息的 id（parent_tool_use_id → message id）：
    /// content_block 事件不带 message id，只能从 message_start 记住。
    current_sub_messages: HashMap<String, String>,
    response_start: usize,
    response_number: u64,
    response_completed: bool,
    usage: usage::ClaudeUsageTracker,
}
/// 事件顶层的 `parent_tool_use_id`：Skill（forked-command- 前缀）与空值之外即子代理归属。
fn subagent_parent(value: &Value) -> Option<&str> {
    value["parent_tool_use_id"].as_str()
        .filter(|parent| !parent.is_empty() && !parent.starts_with("forked-command-"))
}
impl ClaudeOutputState {
    /// 子代理显示名：优先 Task tool_use 登记的 subagent_type，兜底事件自带的 agent 字段。
    fn subagent_name(&self, parent: &str, value: &Value) -> String {
        self.subagents.get(parent).cloned()
            .or_else(|| value["agent"].as_str().map(str::to_string))
            .unwrap_or_else(|| "subagent".into())
    }
    fn stream(&mut self, cell: &Cell, turn: &str, value: &Value) {
        let event = &value["event"];
        let parent = subagent_parent(value);
        match event["type"].as_str().unwrap_or("") {
            "message_start" => {
                // 子代理与主线程的消息交错到达：只在主线程上推进 current_message，
                // 子代理的消息块用 parent 前缀单独跟踪，避免串扰。
                self.message_number += 1;
                let id = event["message"]["id"].as_str().map(str::to_string)
                    .unwrap_or_else(|| format!("message-{}", self.message_number));
                match parent {
                    Some(parent) => { self.current_sub_messages.insert(parent.to_string(), id.clone()); }
                    None => { self.current_message = id.clone(); }
                }
                self.messages.entry(match parent {
                    Some(parent) => format!("sub:{parent}:{id}"),
                    None => id,
                }).or_default();
            }
            "content_block_start" | "content_block_delta" => {
                let Some(index) = event["index"].as_u64() else { return; };
                let (tracking, key, agent, group) = match parent {
                    Some(parent) => {
                        // content_block 事件没有 message id：取 message_start 记下的当前子代理消息。
                        let id = self.current_sub_messages.get(parent).cloned()
                            .unwrap_or_else(|| self.current_message.clone());
                        let name = self.subagent_name(parent, value);
                        let group = format!("{turn}:{parent}");
                        (format!("sub:{parent}:{id}"), format!("{turn}-sub-text-{parent}-{id}-{index}"), Some(name), group)
                    }
                    None => (self.current_message.clone(), format!("{turn}-text-{}-{index}", self.current_message), None, String::new()),
                };
                let blocks = self.messages.entry(tracking).or_default();
                blocks.next_index = blocks.next_index.max(index.saturating_add(1));
                let block = blocks.blocks.entry(index).or_default();
                if block.completed { return; }
                if event["type"] == "content_block_start" {
                    if block.started { return; }
                    block.started = true;
                    block.kind = event["content_block"]["type"].as_str().unwrap_or("").into();
                    if block.kind == "text" {
                        match &agent {
                            Some(name) => message_sub_quiet(cell, &key, &group, event["content_block"]["text"].as_str().unwrap_or(""), name),
                            None => message_append_quiet(cell, &key, event["content_block"]["text"].as_str().unwrap_or("")),
                        }
                    }
                    // 新块（正文/工具）开始：上一段思考到此收尾，折叠态停止滚动。
                    if block.kind != "thinking" { thinking_finish(cell); }
                } else if event["delta"]["type"] == "text_delta" {
                    block.kind = "text".into();
                    match &agent {
                        Some(name) => message_sub_quiet(cell, &key, &group, event["delta"]["text"].as_str().unwrap_or(""), name),
                        None => message_append_quiet(cell, &key, event["delta"]["text"].as_str().unwrap_or("")),
                    }
                } else if event["delta"]["type"] == "thinking_delta" {
                    // 思考内容只做主线程的实时状态，不进 messages（见 AiThinking）：
                    // 它不是聊天记录，历史回放与安卓端都不该按消息渲染它。
                    block.kind = "thinking".into();
                    if agent.is_none() {
                        thinking_append_quiet(cell, event["delta"]["thinking"].as_str().unwrap_or(""));
                    }
                }
            }
            "content_block_stop" => {
                // 思考块结束：标记为非活动，前端折叠态停止滚动，等待正文或下一次思考。
                let Some(index) = event["index"].as_u64() else { return; };
                let tracking = match parent {
                    Some(parent) => self.current_sub_messages.get(parent)
                        .map(|id| format!("sub:{parent}:{id}")),
                    None => Some(self.current_message.clone()),
                };
                let was_thinking = tracking.and_then(|tracking| self.messages.get(&tracking))
                    .and_then(|blocks| blocks.blocks.get(&index))
                    .is_some_and(|block| block.kind == "thinking");
                if was_thinking { thinking_finish(cell); }
            }
            _ => {}
        }
    }
    /// 任务类工具的统一入口（TodoWrite 全量快照 / TaskCreate 追加 / TaskUpdate 改状态）。
    /// TaskCreate 的真实任务号只在结果里出现，因此这里先把调用记进 `pending_tasks`，
    /// 由 `apply_task_result` 在结果到达时落位。
    fn apply_task_tool(&mut self, cell: &Cell, name: &str, tool_id: &str, input: &Value) {
        match name {
            "TodoWrite" => {
                let todos = parse_todos(&input["todos"]);
                update(cell, |data| data.todos = todos);
            }
            "TaskCreate" => {
                let subject = text_field(input, "subject").or_else(|| text_field(input, "content"))
                    .unwrap_or_else(|| "新任务".into());
                let active_form = text_field(input, "activeForm");
                self.pending_tasks.insert(tool_id.to_string(),
                    PendingTaskCall::Create { content: subject, active_form });
            }
            "TaskUpdate" => {
                let task_id = text_field(input, "taskId").or_else(|| input["taskId"].as_i64().map(|id| id.to_string()));
                let status = normalize_todo_status(input["status"].as_str());
                let subject = text_field(input, "subject");
                let active_form = text_field(input, "activeForm");
                if let Some(task_id) = task_id {
                    update(cell, |data| {
                        if let Some(index) = task_position(&data.todos, &task_id) {
                            apply_todo_patch(&mut data.todos[index], status, subject, active_form);
                        }
                    });
                }
            }
            // TaskList 是只读工具：结果到达时用 `#1 [completed] 标题` 校准整张清单。
            _ => {}
        }
    }
    /// 任务类工具的结果：TaskCreate 把新任务插进清单，TaskList 用结果重排清单。
    fn apply_task_result(&mut self, cell: &Cell, tool_id: &str, text: &str) {
        if let Some(PendingTaskCall::Create { content, active_form }) = self.pending_tasks.remove(tool_id) {
            // 结果形如 `Task #1 created successfully: 读取 AGENTS.md`，编号即后续 TaskUpdate 的 taskId。
            let task_id = text.split('#').nth(1)
                .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
                .filter(|id| !id.is_empty()).map(str::to_string);
            update(cell, |data| {
                let position = task_id.as_deref().and_then(|id| task_position(&data.todos, id))
                    .unwrap_or(data.todos.len());
                let todo = AiTodo { content, status: "pending".into(), active_form };
                if position < data.todos.len() { data.todos.insert(position, todo); }
                else { data.todos.push(todo); }
            });
            return;
        }
        if let Some(list) = parse_task_list(text) {
            update(cell, |data| {
                // 结果只带编号、状态与标题：保留服务端已知的 activeForm，未知条目整条替换。
                let mut merged: Vec<AiTodo> = list.into_iter().map(|(id, status, content)| {
                    let active_form = task_position(&data.todos, &id)
                        .and_then(|index| data.todos.get(index)).and_then(|todo| todo.active_form.clone());
                    AiTodo { content, status, active_form }
                }).collect();
                // 结果里没有的条目（并发创建尚未返回）保留在末尾，避免短暂丢行。
                for todo in &data.todos {
                    if !merged.iter().any(|item| item.content == todo.content) { merged.push(todo.clone()); }
                }
                data.todos = merged;
            });
        }
    }
    fn assistant(&mut self, cell: &Cell, turn: &str, value: &Value) {        let assistant = &value["message"];
        let Some(content) = assistant["content"].as_array() else { return; };
        let parent = subagent_parent(value);
        let subagent = parent.map(|parent| self.subagent_name(parent, value));
        // 克隆一份：循环里会以可变借用调用 self 上的任务工具解析。
        let id = assistant["id"].as_str().unwrap_or(&self.current_message).to_string();
        let tracking = match parent {
            Some(parent) => format!("sub:{parent}:{id}"),
            None => id.clone(),
        };
        // 先确保块表存在；循环内按索引重新借用，避免持有 self.messages 的借用时
        // 又去调用会写 self 的任务工具解析（借用冲突）。
        self.messages.entry(tracking.clone()).or_default();
        for (offset, item) in content.iter().enumerate() {
            let kind = item["type"].as_str().unwrap_or("");
            let index = {
                let Some(blocks) = self.messages.get_mut(&tracking) else { return; };
                // 单块完成消息的数组下标会重置，按原始块顺序和类型领取尚未完成的块。
                // 保留每个块的状态，避免依赖最近事件的位置，兼容停止事件及后续块先到达。
                let index = if content.len() == 1 {
                    blocks.blocks.iter().find(|(_, block)| !block.completed && block.kind == kind)
                        .map(|(&index, _)| index).unwrap_or(blocks.next_index)
                } else { offset as u64 };
                blocks.next_index = blocks.next_index.max(index.saturating_add(1));
                let block = blocks.blocks.entry(index).or_default();
                block.kind = kind.into(); block.completed = true;
                index
            };
            if kind == "text" {
                let text = item["text"].as_str().unwrap_or("");
                match &subagent {
                    // subagent 为 Some 时 parent 必为 Some，unwrap_or("") 仅满足类型。
                    Some(name) => message_with_subagent(cell, &format!("{turn}-sub-text-{}-{id}-{index}", parent.unwrap_or("")), &format!("{turn}:{}", parent.unwrap_or("")), "assistant", text, name),
                    None => message(cell, &format!("{turn}-text-{id}-{index}"), "assistant", text, false),
                }
                // 正文已经落地：这段思考结束，实时状态不再展示。
                if subagent.is_none() { thinking_finish(cell); }
            }
            // 完整快照里的思考块：部分模型/代理不发 thinking_delta，只在 assistant 事件里
            // 带完整思考。此时没有增量可追加，直接把这一段作为当前思考段呈现。
            if kind == "thinking" && subagent.is_none() {
                let text = item["thinking"].as_str().unwrap_or("");
                if !text.trim().is_empty() { thinking_replace_quiet(cell, text); }
            }
            if kind == "tool_use" {
                // 主线程发起子代理时登记 tool_use_id → 子代理名，供后续带 parent 的事件取用。
                // 新版 CLI 把该工具改名为 `Agent`，旧版叫 `Task`，两者都要认——
                // 漏认时子代理消息会全部回落成通用名 "subagent"。
                if subagent_tool_name(item["name"].as_str().unwrap_or("")) && parent.is_none() {
                    if let Some(tool_id) = item["id"].as_str() {
                        let display = item["input"]["subagent_type"].as_str()
                            .or(item["input"]["description"].as_str())
                            .filter(|name| !name.trim().is_empty())
                            .unwrap_or("subagent");
                        self.subagents.insert(tool_id.to_string(), display.to_string());
                    }
                }
                // 主线程 TodoWrite：全量快照直接投影到会话级 todos，消息本身打 `todo` 标记，
                // 前端不渲染，历史恢复时据此回填（正文保留完整 input JSON）。
                let name = item["name"].as_str().unwrap_or("");
                let is_todo = parent.is_none() && is_task_tool(name);
                let tool_id = item["id"].as_str().unwrap_or_default();
                if is_todo {
                    if let Some(id) = item["id"].as_str().filter(|id| !id.is_empty()) {
                        self.todo_tools.insert(id.to_string());
                    }
                    self.apply_task_tool(cell, name, tool_id, &item["input"]);
                }
                let body = format!("{}\n{}", item["name"].as_str().unwrap_or("工具调用"), item["input"]);
                match &subagent {
                    Some(name) => message_with_subagent(cell, &format!("{turn}-sub-tool-{}-{tool_id}", parent.unwrap_or("")), &format!("{turn}:{}", parent.unwrap_or("")), "tool", &body, name),
                    None if is_todo => message_todo(cell, &format!("{turn}-tool-{tool_id}"), "tool", &body),
                    None => message(cell, &format!("{turn}-tool-{tool_id}"), "tool", &body, false),
                }
            }
        }
    }
}
/// 消息内容里的第一段文本（`content` 可能是字符串或内容块数组）。
fn first_text_block(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return (!text.trim().is_empty()).then(|| text.to_string());
    }
    content.as_array()?.iter()
        .filter(|item| item["type"] == "text")
        .find_map(|item| item["text"].as_str().filter(|text| !text.trim().is_empty()).map(str::to_string))
}
/// 从用户原始输入推导 Skill 名称：`/code-review src-a` → `code-review`。
fn skill_name_from_input(input: &str) -> Option<String> {
    let token = input.split_whitespace().next()?;
    token.strip_prefix('/')
        .filter(|name| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':')))
        .map(str::to_string)
}
fn string_list(value: &Value) -> Vec<String> {
    value.as_array().map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}
/// Skill 展开判定：主判据是 `parent_tool_use_id` 的 `forked-command-` 前缀；
/// 字段缺失时用「文本显著长于本轮原始输入」兜底（短 Skill 前缀缺失时退化为普通气泡）。
/// 兜底只对主线程 user 消话生效：子代理回传的长文本不是 Skill 展开。
fn expanded_skill(value: &Value, original: &str) -> Option<(String, String)> {
    let text = first_text_block(&value["message"]["content"])?;
    if let Some(name) = value["parent_tool_use_id"].as_str().and_then(|parent| parent.strip_prefix("forked-command-")) {
        return Some((name.to_string(), text));
    }
    if subagent_parent(value).is_some() { return None; }
    let length = text.chars().count();
    if length > original.chars().count().saturating_mul(3) && length > 500 {
        return skill_name_from_input(original).map(|name| (name, text));
    }
    None
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
        "stream_event" => state.stream(cell, turn, value),
        "assistant" => state.assistant(cell, turn, value),
        "user" => {
            // 子代理的工具结果同样带 parent_tool_use_id：写入子代理分组而不是主线程。
            let subagent = subagent_parent(value).map(|parent| state.subagent_name(parent, value));
            if let Some(blocks) = value["message"]["content"].as_array() {
                for item in blocks { if item["type"] == "tool_result" {
                    let body = item["content"].as_str().map(str::to_string).unwrap_or_else(|| item["content"].to_string());
                    let tool_id = item["tool_use_id"].as_str().unwrap_or_default();
                    // TodoWrite / Task* 的工具结果与调用成对跳过渲染；历史恢复时也不会误当正文。
                    let is_todo = state.todo_tools.contains(tool_id) && subagent.is_none();
                    if is_todo { state.apply_task_result(cell, tool_id, &body); }
                    match &subagent {
                        Some(name) => message_with_subagent(cell, &format!("{turn}-sub-result-{}-{tool_id}", subagent_parent(value).unwrap_or("")), &format!("{turn}:{}", subagent_parent(value).unwrap_or("")), "tool", &body, name),
                        None if is_todo => message_todo(cell, &format!("{turn}-result-{tool_id}"), "tool", &body),
                        None => message(cell, &format!("{turn}-result-{tool_id}"), "tool", &body, false),
                    }
                } }
            }
            // Skill 会被 CLI 展开成完整提示词回传；记录为可展开条目而不是普通气泡。
            let original = cell.data.lock().ok().and_then(|data| data.messages.iter()
                .rev().find(|message| message.role == "user").map(|message| message.text.clone())).unwrap_or_default();
            if let Some((name, text)) = expanded_skill(value, &original) {
                message_with_skill(cell, &format!("{turn}-skill-{name}"), &name, &text);
                return Ok(false);
            }
        }
        // CLI 每次启动（含 --resume）都会发 system/init，随会话缓存命令清单。
        "system" if value["subtype"] == "init" => {
            let catalog = SlashCatalog {
                skills: string_list(&value["skills"]),
                slash_commands: string_list(&value["slash_commands"]),
                terminal_slash_commands: string_list(&value["terminal_slash_commands"]),
            };
            update(cell, |data| data.slash_catalog = Some(catalog));
        }
        "result" => {
            // 子代理的收尾 result 带 parent_tool_use_id：最终文本归入子代理分组，
            // 且不结算主回合（主线程的 pending_results 由自己的 result 递减）。
            if let Some(parent) = subagent_parent(value) {
                if let Some(text) = value["result"].as_str().filter(|text| !text.trim().is_empty()) {
                    let name = state.subagent_name(parent, value);
                    message_with_subagent(cell, &format!("{turn}-sub-final-{parent}"), &format!("{turn}:{parent}"), "assistant", text, &name);
                }
                return Ok(false);
            }
            // `is_error` 的 result 不一定代表进程失败：用户中断、CLI 把运行中的新消息
            // 当作重新排队的提示（"Interrupted by user" 等）都会走这里。
            // 之前直接 return Err 会把整轮判成错误/中断，用户看到的就是「发送后会话中断」。
            if value["is_error"] == true {
                let detail = value["result"].as_str().map(str::to_string)
                    .unwrap_or_else(|| value["errors"].to_string());
                // 中断类提示只结束本段回复，保留聊天记录与进程，允许继续发送。
                if is_interrupt_notice(&detail) {
                    update(cell, |data| {
                        data.status = "idle".into();
                        data.error = None;
                        data.result_revision = data.revision;
                    });
                    state.response_start = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.messages.len();
                    state.response_number += 1;
                    state.response_completed = true;
                    return Ok(true);
                }
                return Err(detail);
            }
            if let Some(text) = value["result"].as_str() {
                // 子代理消息 id 同样以 turn 开头：主线程是否已有回答要排除子代理，
                // 否则子代理干完活、主线程只回 result 时最终文本会被误判吞掉。
                let has_answer = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.messages.iter()
                    .skip(state.response_start).any(|m| m.id.starts_with(turn) && m.role == "assistant" && m.subagent.is_none());
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
/// 子代理状态机：把 `task_started / task_updated / task_notification` 与
/// `background_tasks_changed` 快照映射为会话级 `agents`，供底部 chip 带与抽屉展示。
///
/// 与 `ClaudeBackgroundTasks` 刻意分开维护：那边的职责是判断「后台任务是否还撑着回合」，
/// 因此 `awaited == true`（前台阻塞等待的 resumed 子代理）必须排除，否则回合永远不结束；
/// 这边要回答「派发过哪些子代理」，awaited 同样是被派发的代理，必须保留。
/// `ambient == true`（内部杂务）与 `skip_transcript == true` 两边都过滤——它们不是用户可见的子代理。
#[derive(Default)]
struct ClaudeAgents {
    /// tool_use_id → task_id：`background_tasks_changed` 快照只带 task_id，
    /// 记下映射才能在快照里补回与消息（subagentKey）的关联。
    tool_ids: HashMap<String, String>,
    /// task_id → 已见过的 run_id：同一 task 被 resume 后 run_id 会变（task_id 不变），
    /// 旧 run 的迟到帧按字典序比较判断，直接丢弃。
    runs: HashMap<String, String>,
}
impl ClaudeAgents {
    fn observe(&mut self, cell: &Cell, value: &Value) {
        if value["type"] != "system" { return; }
        match value["subtype"].as_str().unwrap_or("") {
            "task_started" => self.start(cell, value),
            "task_updated" => self.patch(cell, value),
            "task_notification" => self.notify(cell, value),
            "background_tasks_changed" => self.snapshot(cell, value),
            _ => {}
        }
    }
    /// 记录 run_id 并判断该帧是否过时（CLI 文档：同一 task 的 run_id 可按字符串排序，
    /// 比已见过的更小的帧是迟到的）。没有 run_id 的帧一律接受（老版本 CLI）。
    fn accept_run(&mut self, task_id: &str, value: &Value) -> bool {
        let Some(run) = value["run_id"].as_str().filter(|run| !run.is_empty()) else { return true; };
        match self.runs.get(task_id) {
            Some(known) if run < known.as_str() => false,
            _ => { self.runs.insert(task_id.to_string(), run.to_string()); true }
        }
    }
    fn start(&mut self, cell: &Cell, value: &Value) {
        let Some(task_id) = visible_task_id(value) else { return; };
        if !self.accept_run(&task_id, value) { return; }
        let tool_use_id = text_field(value, "tool_use_id");
        let description = text_field(value, "description");
        // CLI 的代理类型字段：新版叫 subagent_type，部分事件用 agent_type / agent；
        // 都缺时回落 description，再回落通用名。
        let name = text_field(value, "subagent_type").or_else(|| text_field(value, "agent_type"))
            .or_else(|| text_field(value, "agent")).or_else(|| description.clone())
            .unwrap_or_else(|| "subagent".into());
        let background = value["is_backgrounded"] == true;
        let parent_task_id = text_field(value, "parent_task_id");
        let depth = value["spawn_depth"].as_u64().map(|depth| depth as u32)
            .unwrap_or(if parent_task_id.is_some() { 2 } else { 1 });
        if let Some(tool_id) = &tool_use_id { self.tool_ids.insert(tool_id.clone(), task_id.clone()); }
        let now = chrono::Utc::now().timestamp_millis();
        update(cell, |data| {
            if let Some(agent) = data.agents.iter_mut().find(|agent| agent.task_id == task_id) {
                // CLI 可能重发 task_started：只补空白字段，不重置开始时间与已落定的终态。
                if agent.tool_use_id.is_none() { agent.tool_use_id = tool_use_id.clone(); }
                if agent.description.is_none() { agent.description = description.clone(); }
                if agent.name == "subagent" { agent.name = name.clone(); }
                return;
            }
            data.agents.push(AiAgent {
                task_id, tool_use_id, name, description,
                model: text_field(value, "model"),
                status: "running".into(), task_type: text_field(value, "task_type"),
                background, parent_task_id, depth,
                started_at: now, ended_at: None, summary: None, duration_ms: None, tool_uses: None,
            });
        });
    }
    fn patch(&mut self, cell: &Cell, value: &Value) {
        let Some(task_id) = visible_task_id(value) else { return; };
        if !self.accept_run(&task_id, value) { return; }
        // 新版 CLI 把变更放在 `patch` 里，旧版是平铺字段；两种都要认。
        let patch = if value["patch"].is_object() { &value["patch"] } else { value };
        // 状态可缺省（只改 is_backgrounded / description），此时不碰 status。
        let status = normalize_status(patch["status"].as_str());
        let background = patch["is_backgrounded"].as_bool();
        let description = text_field(patch, "description");
        if status.is_none() && background.is_none() && description.is_none() { return; }
        let now = chrono::Utc::now().timestamp_millis();
        update(cell, |data| {
            let Some(agent) = data.agents.iter_mut().find(|agent| agent.task_id == task_id) else { return; };
            if let Some(description) = description { agent.description = Some(description); }
            if let Some(background) = background { agent.background = background; }
            let Some(status) = status else { return; };
            // 终态不回退：迟到/乱序的 running 事件不能把已结束的代理复活。
            if is_terminal(&agent.status) { return; }
            agent.status = status.clone();
            if is_terminal(&status) {
                agent.ended_at.get_or_insert(now);
                if agent.duration_ms.is_none() {
                    agent.duration_ms = Some(now.saturating_sub(agent.started_at).max(0));
                }
            }
        });
    }
    fn notify(&mut self, cell: &Cell, value: &Value) {
        let Some(task_id) = visible_task_id(value) else { return; };
        if !self.accept_run(&task_id, value) { return; }
        let status = match value["status"].as_str().unwrap_or("") {
            "failed" => "failed", "stopped" => "stopped", _ => "completed",
        };
        let summary = text_field(value, "summary");
        let usage = &value["usage"];
        let duration_ms = usage["duration_ms"].as_i64().or_else(|| usage["durationMs"].as_i64());
        let tool_uses = usage["tool_uses"].as_i64().or_else(|| usage["toolUses"].as_i64());
        let tool_use_id = self.tool_ids.iter().find(|(_, id)| **id == task_id).map(|(tool, _)| tool.clone());
        let now = chrono::Utc::now().timestamp_millis();
        update(cell, |data| {
            let Some(agent) = data.agents.iter_mut().find(|agent| agent.task_id == task_id) else {
                // 通知先于开始事件到达（快照校准的补漏）：补一条终态记录，不留空白。
                let name = text_field(value, "subagent_type").or_else(|| text_field(value, "agent_type"))
                    .or_else(|| summary.clone()).unwrap_or_else(|| "subagent".into());
                data.agents.push(AiAgent {
                    task_id, tool_use_id, name, description: summary.clone(), status: status.into(),
                    model: text_field(value, "model"),
                    task_type: text_field(value, "task_type"),
                    background: false, parent_task_id: None, depth: 1,
                    started_at: now.saturating_sub(duration_ms.unwrap_or(0)), ended_at: Some(now),
                    summary, duration_ms, tool_uses,
                });
                return;
            };
            // 同一 task 可收到多次通知（resume 或等待结束），后到的替换先到的展示内容。
            agent.status = status.into();
            agent.ended_at = Some(now);
            agent.summary = summary.or(agent.summary.take());
            agent.duration_ms = duration_ms.or(agent.duration_ms)
                .or_else(|| Some(now.saturating_sub(agent.started_at).max(0)));
            agent.tool_uses = tool_uses.or(agent.tool_uses);
        });
    }
    /// 快照校准：以完整快照为准补齐缺失条目，缺项置终态而非删除（历史仍要给人看）。
    fn snapshot(&mut self, cell: &Cell, value: &Value) {
        let Some(tasks) = value["tasks"].as_array() else { return; };
        let visible: Vec<&Value> = tasks.iter().filter(|task| is_visible_task(task)).collect();
        // 快照带的是「当前」的 run：同样记进 runs，后续旧 run 的迟到帧才能被识别。
        for task in &visible {
            if let Some(task_id) = task["task_id"].as_str() {
                self.accept_run(task_id, task);
            }
        }
        let ids: HashSet<String> = visible.iter().filter_map(|task| task["task_id"].as_str())
            .filter(|id| !id.is_empty()).map(str::to_string).collect();
        let now = chrono::Utc::now().timestamp_millis();
        let entries: Vec<AiAgent> = visible.iter().filter_map(|task| {
            let task_id = task["task_id"].as_str().filter(|id| !id.is_empty())?.to_string();
            let status = normalize_status(task["status"].as_str()).unwrap_or_else(|| "running".into());
            let tool_use_id = text_field(task, "tool_use_id").or_else(|| self.tool_ids.iter()
                .find(|(_, id)| **id == task_id).map(|(tool, _)| tool.clone()));
            let name = text_field(task, "subagent_type").or_else(|| text_field(task, "description"))
                .unwrap_or_else(|| "subagent".into());
            Some(AiAgent {
                task_id, tool_use_id,
                description: text_field(task, "description"), name,
                model: text_field(task, "model"),
                status, task_type: text_field(task, "task_type"), background: task["is_backgrounded"] == true || task["awaited"] != true,
                parent_task_id: text_field(task, "parent_task_id"),
                depth: task["spawn_depth"].as_u64().map(|depth| depth as u32).unwrap_or(1),
                started_at: now, ended_at: None, summary: None, duration_ms: None, tool_uses: None,
            })
        }).collect();
        update(cell, |data| {
            for agent in data.agents.iter_mut() {
                // 只在快照里消失、且仍在运行中的条目落终态；已结束的保持原样（不复活、不覆盖耗时）。
                if agent.status == "running" && !ids.contains(&agent.task_id) {
                    agent.status = "stopped".into();
                    agent.ended_at.get_or_insert(now);
                    if agent.duration_ms.is_none() {
                        agent.duration_ms = Some(now.saturating_sub(agent.started_at).max(0));
                    }
                }
            }
            for entry in &entries {
                if data.agents.iter().any(|agent| agent.task_id == entry.task_id) { continue; }
                let mut entry = entry.clone();
                entry.started_at = now;
                if is_terminal(&entry.status) { entry.ended_at = Some(now); }
                data.agents.push(entry);
            }
        });
    }
}

/// 用户可见子代理的过滤：内部杂务（ambient）、不上转录的条目，以及**后台命令**
/// （`task_type == "local_bash"`，例如后台跑 `sleep` / `cargo test`）都不属于面板。
///
/// `task_*` 事件对子代理与后台 Bash 命令是同构下发的，唯一可靠的区分是 `task_type`：
/// 子代理是 `local_agent`（还有 `remote_agent` / `local_workflow` 等代理形式），
/// 而 `local_bash` / `background_shell` 是命令，没有任何子代理消息可展示——
/// 若不过滤，点开它们只会看到「该子代理尚未产生输出」的空抽屉。
fn is_visible_task(task: &Value) -> bool {
    if task["ambient"] == true || task["skip_transcript"] == true { return false; }
    if task["task_id"].as_str().is_none_or(str::is_empty) { return false; }
    !matches!(task["task_type"].as_str(), Some("local_bash" | "background_shell"))
}
fn visible_task_id(value: &Value) -> Option<String> {
    if !is_visible_task(value) { return None; }
    value["task_id"].as_str().map(str::to_string)
}
fn text_field(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::trim).filter(|text| !text.is_empty()).map(str::to_string)
}
fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "stopped" | "killed")
}
/// CLI 状态的归一：`pending / in_progress / running / paused` 归为面板可显示的状态。
fn normalize_status(status: Option<&str>) -> Option<String> {
    Some(match status? {
        "pending" => "pending", "in_progress" => "running", "running" => "running",
        "completed" => "completed", "failed" => "failed", "stopped" => "stopped",
        "killed" => "killed", "paused" => "paused",
        _ => return None,
    }.to_string())
}

/// 回合未结算时允许的最长无输出时间：与 CLI 默认 API 超时（600 秒）对齐，超过即判定任务停滞
/// （模型接口挂起、CLI 无限重试等），主动结束回合并保留聊天记录。等待用户决策不算停滞。
/// Claude / Codex 两家循环共用。
const AGENT_STALL_TIMEOUT: Duration = Duration::from_secs(600);
fn run_claude(cell: &Cell, process: &mut Process, stdin: ChildStdin, controls: mpsc::Receiver<Control>,
    output: mpsc::Receiver<Result<Value>>, errors: Arc<Mutex<String>>, hooks: &NativeClaudeHooks) -> Result<WorkerExit> {
    let mut checkpoint = Instant::now();
    let mut persisted_revision = 0;
    let mut turn = Uuid::new_v4().to_string();
    let mut state = ClaudeOutputState::default();
    let mut tasks = ClaudeBackgroundTasks::default();
    let mut agents = ClaudeAgents::default();
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
                Control::Message { text, request_id: _, images } => {
                    let stdin = input.as_mut().ok_or("Claude 输入通道已关闭，请重新发送消息")?;
                    // 空闲后收到的新消息开始新回合；运行中收到的直接交给 CLI 自行插话。
                    let new_turn = pending_results == 0;
                    if new_turn { turn = Uuid::new_v4().to_string(); }
                    update(cell, |data| {
                        if new_turn { usage::begin_turn(data); }
                        if data.approvals.is_empty() { data.status = "running".into(); }
                    });
                    let session_id = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.thread_id.clone().unwrap_or_default();
                    write_claude_user(stdin, &session_id, &text, &images)?;
                    // 等待审批时注入的消息不会单独产生 result（审批恢复后并回同一回合），
                    // 那时再加计数会让 pending_results 永远多 1，回合结束后状态卡在 running。
                    if pending.is_empty() {
                        pending_results = pending_results.saturating_add(1);
                    }
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
        // 正文持续入内存，每秒合并一次原子落盘；空闲且没有变化时不重复写历史。
        if checkpoint.elapsed() >= Duration::from_secs(1) {
            let data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
            if data.revision != persisted_revision {
                persist_data(cell, &data)?;
                persisted_revision = data.revision;
            }
            checkpoint = Instant::now();
        }
        // 主进程已退出就立刻收尾，不等 output_closed。
        // stdout 是否 EOF 依赖管道写端全部关闭，但 CLI 派生的子进程（bash、子代理）
        // 会继承写端并可能在主进程死后继续存活——此时读取线程永远等不到 EOF，
        // 旧实现只能靠 600 秒停滞超时兜底，用户看到的是「10 分钟没有任何输出」，
        // 实际任务早就结束了（服务重启、进程被杀等场景尤其常见）。
        if let Some(status) = process.0.try_wait().map_err(|e| format!("读取 Claude 进程状态失败：{e}"))? {
            // 进程已回收：先尽力排空已就绪的输出，避免丢掉最后几条事件。
            let mut drained = Vec::new();
            while let Ok(ready) = output.try_recv() { drained.push(ready); }
            for ready in drained {
                let value = ready?;
                if value["type"] == "control_request" { continue; }
                tasks.observe(cell, &turn, &value);
                agents.observe(cell, &value);
                if apply_claude_event(cell, &turn, &mut state, &value)? {
                    pending_results = pending_results.saturating_sub(1);
                    update(cell, |data| usage::finish_turn(data));
                }
            }
            let details = errors.lock().map(|e| e.clone()).unwrap_or_default();
            if !status.success() {
                let hint = if details.trim().is_empty() { format!("Claude 进程异常结束（{status}），可以继续发送消息") }
                    else { format!("Claude 进程已退出：{}", details.trim()) };
                // 进程被外部杀掉时给出更贴近事实的提示：任务没有输出不是模型卡住。
                return Err(if pending_results > 0 && last_event.elapsed() > Duration::from_secs(30) {
                    format!("{hint}；上次输出已过去 {} 秒，任务可能被执行环境中断（如服务重启）",
                        last_event.elapsed().as_secs())
                } else { hint });
            }
            if pending_results > 0 { return Err("Claude 进程已退出，未收到完成事件，可以继续发送消息".into()); }
            if !tasks.tasks.is_empty() { return Err("Claude 进程已退出，但仍有后台任务未完成，可以继续发送消息".into()); }
            return Ok(WorkerExit::Completed);
        }
        if output_closed {
            // 进程仍在但输出通道已关闭：稍等它退出，不要空转占满 CPU。
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
            let became_idle = {
                let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
                if data.status == "idle" { false } else {
                    data.status = "idle".into(); touch(&mut data); data.result_revision = data.revision;
                    // 完成状态与最终正文一起落盘，通知连接读到 idle 时结果已经保存。
                    persist_data(cell, &data)?;
                    persisted_revision = data.revision;
                    true
                }
            };
            if became_idle {
                refresh_title(cell, true);
                // 标题无变化时 refresh_title 不会触发推送：这里显式补一帧，
                // 前端无需等 6 秒兜底轮询就能看到回合结束。
                emit_update(cell);
            }
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
        // 批量排空已就绪的输出再统一处理：partial 流的 token 级增量一秒可达几十条，
        // 逐条 emit 会让 IPC 与前端重渲染跟不上，也是内存与 CPU 占用的主要来源之一。
        let mut batch = Vec::with_capacity(8);
        batch.push(value);
        while batch.len() < 64 {
            match output.try_recv() {
                Ok(Ok(more)) => batch.push(more),
                Ok(Err(error)) => return Err(error),
                Err(_) => break,
            }
        }
        for value in batch {
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
            agents.observe(cell, &value);
            if apply_claude_event(cell, &turn, &mut state, &value)? {
                pending_results = pending_results.saturating_sub(1);
                // result 表示这一段回复及用量已结算；后台唤醒产生的新 result 也会走到这里。
                update(cell, |data| usage::finish_turn(data));
                persist(cell)?;
            }
        }
        // 批末统一推送：流式期间的静默增量（message_append_quiet）在这里一次性到达前端。
        emit_update(cell);
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
    emit_update(cell);
}
fn run_codex(cell: &Cell, session: &AiSession, prompt: &PendingInput, permissions: &super::ai_permission_service::NativePermissions, stdin: &mut impl Write,
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
    let mut queued_prompt = Some(prompt.clone());
    let mut request_id = active_request_id(session).map(str::to_string);
    let mut agent_queries: HashMap<u64, String> = HashMap::new();
    let mut agent_checkpoint = Instant::now();
    let mut settle_at: Option<Instant> = None;
    // 最近一次活动（app-server 输出或用户操作）时间，用于识别模型接口挂起导致的回合停滞。
    let mut last_event = Instant::now();
    if let Ok(mut data) = cell.data.lock() { usage::begin_turn(&mut data); state.usage.start(&mut data); }
    loop {
        while let Ok(control) = controls.try_recv() {
            match control {
                Control::Stop => return Err("已中断".into()),
                Control::Retire => return Ok(WorkerExit::Retired),
                Control::Message { text, request_id: accepted_id, images } => {
                    request_id = Some(accepted_id.clone());
                    let id = state.thread_id.as_deref().ok_or("Codex 会话尚未初始化")?;
                    if !state.finished && state.turn_id.is_some() {
                        // 原生插话：turn/start 由 app-server 原子处理活动回合的补充输入，不重置本回合用量。
                        let mut params = json!({"threadId":id,"input": codex_user_input(&text, &images)});
                        super::ai_permission_service::for_agent("codex")?.apply_turn(&mut params);
                        turn_request = Some(codex_request(stdin, &mut next_id, "turn/start", params)?);
                    } else {
                        state.usage = usage::CodexUsageTracker::default();
                        if let Ok(mut data) = cell.data.lock() { usage::begin_turn(&mut data); state.usage.start(&mut data); }
                        let permissions = super::ai_permission_service::for_agent("codex")?;
                        let mut params = json!({"threadId":id,"cwd":session.project_path,"developerInstructions":decision_instructions});
                        permissions.apply_thread(&mut params);
                        if let Some(model) = &session.model { params["model"] = json!(model); }
                        resume_request = Some(codex_request(stdin, &mut next_id, "thread/resume", params)?);
                        queued_prompt = Some(PendingInput { text, request_id: accepted_id, images });
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
                request_id = Some(next.request_id.clone());
                state.usage = usage::CodexUsageTracker::default();
                if let Ok(mut data) = cell.data.lock() { usage::begin_turn(&mut data); state.usage.start(&mut data); }
                let permissions = super::ai_permission_service::for_agent("codex")?;
                let mut params = json!({"threadId":id,"cwd":session.project_path,"developerInstructions":decision_instructions});
                permissions.apply_thread(&mut params);
                if let Some(model) = &session.model { params["model"] = json!(model); }
                resume_request = Some(codex_request(stdin, &mut next_id, "thread/resume", params)?);
                queued_prompt = Some(next);
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
            let pending = queued_prompt.take().ok_or("Codex 待发送消息不可用")?;
            let mut params = json!({"threadId":id,"input": codex_user_input(&pending.text, &pending.images)});
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
        write_claude_user(&mut out, "session-1", "继续处理", &[]).unwrap();
        let value: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(value["type"], "user");
        assert_eq!(value["session_id"], "session-1");
        assert_eq!(value["message"]["role"], "user");
        assert_eq!(value["message"]["content"], "继续处理");
        assert!(value["parent_tool_use_id"].is_null());
    }

    #[test]
    fn claude_user_message_with_images_uses_content_blocks() {
        let dir = std::env::temp_dir().join(format!("tb-ai-image-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("paste.png");
        fs::write(&path, [0x89u8, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        let image = AiImage {
            path: path.to_string_lossy().to_string(),
            media_type: "image/png".into(),
            name: "paste.png".into(),
        };
        let mut out = Vec::new();
        write_claude_user(&mut out, "session-1", "看图", &[image]).unwrap();
        let value: Value = serde_json::from_slice(&out).unwrap();
        let content = value["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "看图");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert!(!content[1]["source"]["data"].as_str().unwrap_or_default().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_user_message_with_only_images_omits_text_block() {
        let dir = std::env::temp_dir().join(format!("tb-ai-image-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("only.png");
        fs::write(&path, [0x89u8, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        let image = AiImage {
            path: path.to_string_lossy().to_string(),
            media_type: "image/png".into(),
            name: String::new(),
        };
        let mut out = Vec::new();
        write_claude_user(&mut out, "session-1", "", &[image]).unwrap();
        let value: Value = serde_json::from_slice(&out).unwrap();
        let content = value["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "image");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_user_input_appends_local_images() {
        let image = AiImage {
            path: "/tmp/paste.png".into(),
            media_type: "image/png".into(),
            name: "paste.png".into(),
        };
        let input = codex_user_input("看图", &[image]);
        let items = input.as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["type"], "text");
        assert_eq!(items[1]["type"], "localImage");
        assert_eq!(items[1]["path"], "/tmp/paste.png");
    }

    #[test]
    fn image_only_message_title_uses_image_count() {
        let image = AiImage {
            path: "/tmp/paste.png".into(),
            media_type: "image/png".into(),
            name: String::new(),
        };
        assert_eq!(input_title("   ", &[image]), "1 张图片");
        assert_eq!(input_title("看图", &[]), "看图");
    }

    #[test]
    fn image_upload_validates_type_and_magic_bytes() {
        assert_eq!(normalized_image_type("IMAGE/PNG"), Some(("image/png", "png")));
        assert_eq!(normalized_image_type("image/jpg"), Some(("image/jpeg", "jpg")));
        assert_eq!(normalized_image_type("text/plain"), None);
        assert!(looks_like_image("image/png", &[0x89, b'P', b'N', b'G', 0]));
        assert!(!looks_like_image("image/png", b"not an image"));
        assert!(looks_like_image("image/webp", b"RIFF\0\0\0\0WEBPxxxx"));
    }

    #[test]
    fn claude_queue_writes_to_same_process_after_settle() {
        let saved = SavedCell::new();
        let request_id = "00000000-0000-4000-8000-000000000002";
        {
            let mut data = saved.0.data.lock().unwrap();
            data.status = "idle".into();
            data.pending_inputs.push(PendingInput { text: "继续".into(), request_id: request_id.into(), images: Vec::new() });
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
            id: id.into(), role: "user".into(), text: text.into(), created_at: at, skill_name: None, model_switch: None, subagent: None, subagent_key: None,
            images: Vec::new(), todo: false,
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
        Cell { data: Mutex::new(data), control: Mutex::new(None), summary: Mutex::default(), emitted: Mutex::default(), deleted: AtomicBool::new(false), path: PathBuf::new() }
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
    /// 排队消息可原地编辑：只改队列里的文本，不新增消息、不动当前回合。
    #[test]
    fn pending_input_text_can_be_edited_in_place() {
        let saved = SavedCell::new();
        {
            let mut data = saved.0.data.lock().unwrap();
            data.pending_inputs = vec![
                crate::models::ai_chat::PendingInput { text: "原始内容".into(), request_id: "req-1".into(), images: Vec::new() },
                crate::models::ai_chat::PendingInput { text: "第二条".into(), request_id: "req-2".into(), images: Vec::new() },
            ];
        }
        let before_messages = saved.0.data.lock().unwrap().messages.len();
        change_pending_input_locked(&saved.0, "req-1", Some("改过的内容".into())).unwrap();
        let data = saved.0.data.lock().unwrap();
        assert_eq!(data.pending_inputs[0].text, "改过的内容");
        assert_eq!(data.pending_inputs[1].text, "第二条", "其他排队消息不受影响");
        assert_eq!(data.pending_inputs.len(), 2, "编辑不该改变队列长度");
        assert_eq!(data.messages.len(), before_messages, "排队消息不是聊天记录，编辑不产生消息");
    }

    /// 编辑失败的两条边界：空文本被拒；已被 worker 取走的消息不能再改。
    #[test]
    fn pending_input_edit_rejects_blank_and_already_sent() {
        // 空校验发生在加载会话之前，所以不存在的会话也能验证到这条分支。
        let blank = update_pending_input("00000000-0000-4000-8000-000000000000", "o", "req-1", "  ".into());
        assert_eq!(blank.err().as_deref(), Some("消息不能为空"));
        let saved = SavedCell::new();
        {
            let mut data = saved.0.data.lock().unwrap();
            data.pending_inputs = vec![
                crate::models::ai_chat::PendingInput { text: "原始内容".into(), request_id: "req-1".into(), images: Vec::new() },
            ];
        }
        // 已经被取走（队列里没有这个 requestId）时给出明确错误，而不是静默成功。
        let missing = match change_pending_input_locked(&saved.0, "req-gone", Some("新内容".into())) {
            Ok(_) => panic!("已被取走的消息不该编辑成功"),
            Err(error) => error,
        };
        assert!(missing.contains("已发送或已移出队列"), "错误应说明原因：{missing}");
        assert_eq!(saved.0.data.lock().unwrap().pending_inputs.len(), 1, "失败的编辑不改队列");
    }

    /// 思考是实时状态：随实时帧下发（metadata）但不落盘，避免每批 delta 重写会话文件。
    #[test]
    fn thinking_is_emitted_but_never_persisted() {
        let saved = SavedCell::new();
        {
            let mut data = saved.0.data.lock().unwrap();
            data.thinking = Some(crate::models::ai_chat::AiThinking {
                text: "实时思考".into(), started_at: 1, updated_at: 2, active: true, blocks: 3, total_chars: 9,
            });
            touch(&mut data);
        }
        // 实时帧：metadata 必须带上思考快照，否则前端拿不到。
        let metadata = saved.0.data.lock().unwrap().metadata();
        assert_eq!(metadata.thinking.as_ref().map(|t| t.text.as_str()), Some("实时思考"));
        assert_eq!(metadata.thinking.as_ref().map(|t| t.blocks), Some(3));
        // 落盘：会话文件里不能出现 thinking 字段。
        persist(&saved.0).unwrap();
        let file = serde_json::from_slice::<Value>(&fs::read(&saved.0.path).unwrap()).unwrap();
        assert!(file.get("thinking").is_none(), "思考不该写进磁盘");
        assert_eq!(file["messages"].as_array().map(|m| m.len()), Some(0), "思考也不该进聊天记录");
    }

    /// 回合收尾清空思考快照：回合结束后不该再显示「正在想什么」。
    #[test]
    fn thinking_is_cleared_when_the_turn_finishes() {
        let mut data = cell().data.lock().unwrap().clone();
        data.thinking = Some(crate::models::ai_chat::AiThinking {
            text: "旧思考".into(), started_at: 1, updated_at: 1, active: true, blocks: 1, total_chars: 3,
        });
        thinking_clear(&mut data);
        assert!(data.thinking.is_none());
    }

    fn replay(events: &[Value]) -> Vec<AiMessage> {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        for event in events { apply_claude_event(&cell, "turn", &mut state, event).unwrap(); }
        cell.data.into_inner().unwrap().messages
    }
    fn thinking_delta(index: u64, text: &str) -> Value {
        stream(json!({"type": "content_block_delta", "index": index,
            "delta": {"type": "thinking_delta", "thinking": text}}))
    }

    /// 思考不再被丢弃：delta 累积进会话级快照，且不写进 messages（不是聊天记录）。
    #[test]
    fn claude_thinking_deltas_fill_session_snapshot_without_becoming_messages() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        for event in [start("msg-1"), block(0, "thinking"),
            thinking_delta(0, "先看会话数据"), thinking_delta(0, "，再定位渲染逻辑")] {
            apply_claude_event(&cell, "turn", &mut state, &event).unwrap();
        }
        let data = cell.data.lock().unwrap();
        assert!(data.messages.is_empty(), "思考不应进入消息流");
        let thinking = data.thinking.as_ref().expect("应记录思考快照");
        assert_eq!(thinking.text, "先看会话数据，再定位渲染逻辑");
        assert!(thinking.active);
        assert_eq!(thinking.blocks, 1);
    }

    /// 正文开始后当前段思考收尾；再来的思考开新的一段并累加段数。
    #[test]
    fn claude_thinking_segments_close_on_text_and_restart() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        for event in [start("msg-1"), block(0, "thinking"), thinking_delta(0, "第一段"),
            stop(0), block(1, "text"), delta(1, "正文"), stop(1),
            start("msg-2"), block(0, "thinking"), thinking_delta(0, "第二段")] {
            apply_claude_event(&cell, "turn", &mut state, &event).unwrap();
        }
        let data = cell.data.lock().unwrap();
        let thinking = data.thinking.as_ref().unwrap();
        assert_eq!(thinking.text, "第二段", "新段应覆盖上一段的尾部内容");
        assert_eq!(thinking.blocks, 2);
        assert!(thinking.active, "正在输出的这一段是活动的");
        assert!(data.messages.iter().any(|m| m.role == "assistant" && m.text == "正文"));
    }

    /// 思考过长时只保留尾部：整段（实测单段可达 2.3 万字）全量下发会撑爆 IPC。
    #[test]
    fn thinking_tail_keeps_only_the_end() {
        let text = format!("开头应该被丢掉。{}", "尾部内容".repeat(2000));
        let tail = thinking_tail(&text);
        assert!(tail.chars().count() <= THINKING_TAIL_CHARS);
        assert!(tail.contains("尾部内容"));
        assert!(!tail.contains("开头应该被丢掉"));
    }

    /// 只在 assistant 快照里出现的思考（没有 delta 流）也要能显示。
    #[test]
    fn claude_complete_thinking_block_without_deltas_is_kept() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        apply_claude_event(&cell, "turn", &mut state,
            &assistant("msg-1", json!([{"type": "thinking", "thinking": "整段思考"}])),).unwrap();
        let data = cell.data.lock().unwrap();
        let thinking = data.thinking.as_ref().expect("快照里的思考也要保留");
        assert_eq!(thinking.text, "整段思考");
        assert!(!thinking.active, "快照到达时该段已结束");
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

    fn push_user(cell: &Cell, text: &str) {
        cell.data.lock().unwrap().messages.push(AiMessage {
            id: "user-input".into(), role: "user".into(), text: text.into(), created_at: 0, skill_name: None, model_switch: None, subagent: None, subagent_key: None,
            images: Vec::new(), todo: false,
        });
    }

    #[test]
    fn claude_skill_expansion_is_marked_with_skill_name() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        push_user(&cell, "/code-review src-tauri");
        let expanded = "审查指令".repeat(1000);
        let event = json!({"type": "user", "parent_tool_use_id": "forked-command-code-review",
            "message": {"content": [{"type": "text", "text": expanded}]}});
        apply_claude_event(&cell, "turn", &mut state, &event).unwrap();
        let data = cell.data.lock().unwrap();
        let skill = data.messages.iter().find(|message| message.skill_name.is_some()).expect("应生成 Skill 消息");
        assert_eq!(skill.skill_name.as_deref(), Some("code-review"));
        assert_eq!(skill.text, expanded);
        assert_eq!(data.messages.len(), 2, "原始输入保留为独立气泡");
    }

    #[test]
    fn claude_skill_falls_back_to_length_without_parent_field() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        push_user(&cell, "/code-review src-tauri");
        // 字段缺失但文本显著长于原始输入：按 Skill 归类。
        let expanded = "长内容".repeat(200);
        apply_claude_event(&cell, "turn", &mut state, &json!({"type": "user", "message": {"content": expanded}})).unwrap();
        let data = cell.data.lock().unwrap();
        let skill = data.messages.iter().find(|message| message.skill_name.is_some()).expect("兜底应识别 Skill");
        assert_eq!(skill.skill_name.as_deref(), Some("code-review"));
    }

    fn with_parent(mut value: Value, parent: &str) -> Value {
        value["parent_tool_use_id"] = json!(parent);
        value
    }

    #[test]
    fn claude_subagent_events_are_tagged_with_task_name() {
        let messages = replay(&[
            // 主线程发起 Task：登记 tool_use_id → subagent_type。
            assistant("msg-1", json!([{"type": "tool_use", "id": "toolu-task", "name": "Task",
                "input": {"subagent_type": "Explore", "description": "检索代码", "prompt": "找相关代码"}}])),
            // 子代理流式文本（静默写入，随后被完整消息替换）。
            with_parent(stream(json!({"type": "message_start", "message": {"id": "sub-1"}})), "toolu-task"),
            with_parent(block(0, "text"), "toolu-task"),
            with_parent(delta(0, "子代理正在检索"), "toolu-task"),
            with_parent(assistant("sub-1", json!([{"type": "text", "text": "找到了三个相关文件"}])), "toolu-task"),
            // 子代理自己的工具调用与结果。
            with_parent(assistant("sub-2", json!([{"type": "tool_use", "id": "toolu-sub-read", "name": "Read",
                "input": {"path": "src/a.rs"}}])), "toolu-task"),
            with_parent(json!({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "toolu-sub-read", "content": "文件内容"}]}}), "toolu-task"),
            // 子代理收尾 result：文本归入子代理分组，不结算主回合。
            with_parent(json!({"type": "result", "result": "共 3 个文件相关", "is_error": false}), "toolu-task"),
            // 主线程收尾。
            json!({"type": "result", "result": "检索完成", "is_error": false}),
        ]);
        // Task 调用本身是主线程工具消息，不带子代理标记。
        let task = messages.iter().find(|message| message.id == "turn-tool-toolu-task").expect("Task 调用应入列");
        assert_eq!(task.subagent, None);
        // 子代理的文本（完整消息替换了流式增量）、工具调用、结果与收尾全部带标记。
        let tagged: Vec<&AiMessage> = messages.iter()
            .filter(|message| message.subagent.as_deref() == Some("Explore")).collect();
        assert_eq!(tagged.len(), 4, "子代理应有四条消息：文本、工具、结果、收尾");
        assert!(tagged.iter().any(|message| message.role == "assistant" && message.text == "找到了三个相关文件"));
        assert!(tagged.iter().any(|message| message.role == "tool" && message.text.starts_with("Read")));
        assert!(tagged.iter().any(|message| message.role == "tool" && message.text.contains("文件内容")));
        assert!(tagged.iter().any(|message| message.text == "共 3 个文件相关"));
        // 主线程 result 文本正常补为 assistant 气泡，不受子代理干扰。
        assert!(messages.iter().any(|message| message.role == "assistant" && message.text == "检索完成" && message.subagent.is_none()));
    }

    #[test]
    fn claude_subagent_long_text_is_not_mistaken_for_skill() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        push_user(&cell, "/review");
        let long_text = "子代理回传".repeat(150);
        let event = json!({"type": "user", "parent_tool_use_id": "toolu-task",
            "message": {"content": [{"type": "text", "text": long_text}]}});
        apply_claude_event(&cell, "turn", &mut state, &event).unwrap();
        let data = cell.data.lock().unwrap();
        assert!(data.messages.iter().all(|message| message.skill_name.is_none()),
            "带非 forked parent 的长文本不是 Skill 展开");
    }

    #[test]
    fn claude_short_user_text_is_ignored() {
        // 短文本不判定为 Skill，也不产生气泡（避免普通回传刷屏）。
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        push_user(&cell, "/code-review src-tauri");
        apply_claude_event(&cell, "turn", &mut state, &json!({"type": "user", "message": {"content": "短回传"}})).unwrap();
        assert_eq!(cell.data.lock().unwrap().messages.len(), 1);
    }

    #[test]
    fn claude_init_event_caches_slash_catalog() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        let init = json!({"type": "system", "subtype": "init",
            "skills": ["code-review", "simplify"],
            "slash_commands": ["cost", "model", "code-review", "simplify"],
            "terminal_slash_commands": ["doctor", "color"]});
        apply_claude_event(&cell, "turn", &mut state, &init).unwrap();
        let catalog = cell.data.lock().unwrap().slash_catalog.clone().expect("init 应写入清单");
        assert_eq!(catalog.skills, vec!["code-review", "simplify"]);
        assert_eq!(catalog.slash_commands, vec!["cost", "model", "code-review", "simplify"]);
        assert_eq!(catalog.terminal_slash_commands, vec!["doctor", "color"]);
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

    /// 原生会话切换供应商/模型：配置更新 + 写入可渲染的切换分段；执行中被拒绝。
    #[test]
    fn switch_model_updates_config_and_writes_divider() {
        use crate::models::llm_provider::{LlmModelConfig, LlmProviderInput};
        let directory = std::env::temp_dir().join(format!("ai-switch-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        crate::services::PathService::set_test_data_dir(Some(directory.clone()));
        let verify = || {
            let saved = crate::services::llm_provider_service::save_provider(LlmProviderInput {
                id: String::new(), name: "切换中转".into(), base_url: "https://a.example/v1".into(),
                auth_type: "ANTHROPIC_AUTH_TOKEN".into(), api_key: Some("secret".into()), is_default: true,
                default_effort_level: "high".into(), default_model: String::new(), models_url: String::new(),
                enabled_models: vec![
                    LlmModelConfig { id: "m1".into(), enabled: true, context_window: 0, effort_level: String::new(), max_output_tokens: 0 },
                    LlmModelConfig { id: "m2".into(), enabled: true, context_window: 0, effort_level: String::new(), max_output_tokens: 0 },
                ],
                sort_index: 0,
            }).unwrap();
            let provider_id = format!("llm:{}", saved.id);
            let data = create("switch-owner", CreateAiSession {
                provider: "claude".into(), provider_id: Some(provider_id.clone()), project_path: "/tmp".into(),
                model: Some("m1".into()), resume_session_id: None,
            }).unwrap();

            let switched = switch_model(&data.id, "switch-owner", &provider_id, "m2").unwrap();
            assert_eq!(switched.model.as_deref(), Some("m2"));
            let divider = switched.messages.iter().find(|m| m.role == "system").expect("应写入切换分段");
            let info = divider.model_switch.as_ref().unwrap();
            assert_eq!(info.from_model.as_deref(), Some("m1"));
            assert_eq!(info.to_model.as_deref(), Some("m2"));
            assert_eq!(info.to_provider.as_deref(), Some("切换中转"));
            // 携带可读文本：旧客户端（不认识 modelSwitch）也能显示切换说明。
            assert!(divider.text.contains("m1") && divider.text.contains("m2"));
            // 相同配置重复切换是幂等的，不再叠加分段。
            let again = switch_model(&data.id, "switch-owner", &provider_id, "m2").unwrap();
            assert_eq!(again.messages.iter().filter(|m| m.role == "system").count(), 1);

            // 执行中拒绝切换。
            let cell = registry().lock().unwrap().values()
                .find(|c| c.path.file_stem().and_then(|s| s.to_str()) == Some(data.id.as_str()))
                .cloned().expect("会话应已注册");
            cell.data.lock().unwrap().status = "running".into();
            let rejected = switch_model(&data.id, "switch-owner", &provider_id, "m1");
            assert!(rejected.is_err());
        };
        verify();
        crate::services::PathService::set_test_data_dir(None);
        let _ = fs::remove_dir_all(&directory);
    }

}

#[cfg(test)]
mod todo_agent_tests {
    use super::*;

    fn cell() -> Cell {
        let data = serde_json::from_value(json!({
            "id": "todo-test", "title": "任务面板", "provider": "claude", "projectPath": ".",
            "model": null, "status": "running", "messages": [], "approvals": [], "error": null,
            "updatedAt": 0, "revision": 0,
        })).unwrap();
        Cell { data: Mutex::new(data), control: Mutex::new(None), summary: Mutex::default(),
            emitted: Mutex::default(), deleted: AtomicBool::new(false), path: PathBuf::new() }
    }

    fn todo_use(id: &str, todos: Value) -> Value {
        json!({"type": "assistant", "message": {"id": format!("m-{id}"), "content": [
            {"type": "tool_use", "id": id, "name": "TodoWrite", "input": {"todos": todos}}
        ]}})
    }

    fn task_event(subtype: &str, extra: Value) -> Value {
        let mut base = json!({"type": "system", "subtype": subtype});
        if let (Some(map), Some(fields)) = (base.as_object_mut(), extra.as_object()) {
            for (key, value) in fields { map.insert(key.clone(), value.clone()); }
        }
        base
    }

    #[test]
    fn todowrite_replaces_whole_snapshot_and_marks_message() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        apply_claude_event(&cell, "t", &mut state, &todo_use("a", json!([
            {"content": "读代码", "status": "completed", "activeForm": "读代码"},
            {"content": "写解析", "status": "in_progress", "activeForm": "正在写解析"},
        ]))).unwrap();
        {
            let data = cell.data.lock().unwrap();
            assert_eq!(data.todos.len(), 2);
            assert_eq!(data.todos[1].status, "in_progress");
            assert_eq!(data.todos[1].active_form.as_deref(), Some("正在写解析"));
            let message = data.messages.iter().find(|m| m.id == "t-tool-a").expect("应写入工具消息");
            assert!(message.todo, "工具消息应带 todo 标记");
            assert!(message.text.contains("TodoWrite"), "正文需保留原文供恢复");
        }
        // 第二次调用是新的全量快照：不叠加、不残留旧条目。
        apply_claude_event(&cell, "t", &mut state, &todo_use("b", json!([
            {"content": "收尾", "status": "pending"},
        ]))).unwrap();
        let data = cell.data.lock().unwrap();
        assert_eq!(data.todos.len(), 1);
        assert_eq!(data.todos[0].content, "收尾");
    }

    #[test]
    fn todowrite_empty_array_clears_and_unknown_status_is_pending() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        apply_claude_event(&cell, "t", &mut state, &todo_use("a", json!([
            {"content": "甲", "status": "weird"}, {"content": "  ", "status": "pending"},
        ]))).unwrap();
        let data = cell.data.lock().unwrap();
        assert_eq!(data.todos.len(), 1, "空白 content 被丢弃");
        assert_eq!(data.todos[0].status, "pending", "未知状态归一为 pending");
        drop(data);
        apply_claude_event(&cell, "t", &mut state, &todo_use("b", json!([]))).unwrap();
        assert!(cell.data.lock().unwrap().todos.is_empty(), "空数组清空清单");
    }

    #[test]
    fn todowrite_result_is_also_marked() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        apply_claude_event(&cell, "t", &mut state, &todo_use("a", json!([{"content": "甲", "status": "pending"}]))).unwrap();
        apply_claude_event(&cell, "t", &mut state, &json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "a", "content": "Todos modified"}
        ]}})).unwrap();
        let data = cell.data.lock().unwrap();
        let result = data.messages.iter().find(|m| m.id == "t-result-a").expect("应写入结果消息");
        assert!(result.todo, "TodoWrite 的结果消息同样不渲染");
        // 普通工具结果不受影响。
        drop(data);
        apply_claude_event(&cell, "t", &mut state, &json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "zzz", "content": "ok"}
        ]}})).unwrap();
        assert!(!cell.data.lock().unwrap().messages.iter().find(|m| m.id == "t-result-zzz").unwrap().todo);
    }

    #[test]
    fn todos_backfill_from_tool_message() {
        let message = |id: &str, text: &str, todo: bool| AiMessage {
            id: id.into(), role: "tool".into(), text: text.into(), created_at: 0,
            skill_name: None, model_switch: None, subagent_key: None, subagent: None,
            images: Vec::new(), todo,
        };
        // 旧会话没有 todo 标记：正文里能找到 TodoWrite 也能回填。
        let history = vec![
            message("a", "TodoWrite\n{\"todos\":[{\"content\":\"甲\",\"status\":\"completed\"}]}", false),
            message("b", "TodoWrite\n{\"todos\":[{\"content\":\"乙\",\"status\":\"in_progress\"}]}", true),
        ];
        let todos = todos_from_messages(&history);
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].content, "乙", "取最后一次快照");
        // 被截断的 JSON 静默跳过，不影响会话加载。
        assert!(todos_from_messages(&[message("c", "TodoWrite\n{\"todos\":[{\"content\":\"截", true)]).is_empty());
        assert!(todos_from_messages(&[]).is_empty());
    }

    #[test]
    fn agent_lifecycle_start_update_notify() {
        let cell = cell();
        let mut agents = ClaudeAgents::default();
        agents.observe(&cell, &task_event("task_started", json!({
            "task_id": "task-1", "tool_use_id": "tool-1", "subagent_type": "Explore",
            "description": "找代码", "is_backgrounded": true, "spawn_depth": 1,
        })));
        {
            let data = cell.data.lock().unwrap();
            assert_eq!(data.agents.len(), 1);
            let agent = &data.agents[0];
            assert_eq!(agent.name, "Explore");
            assert_eq!(agent.status, "running");
            assert!(agent.background);
            assert_eq!(agent.tool_use_id.as_deref(), Some("tool-1"));
        }
        agents.observe(&cell, &task_event("task_updated", json!({
            "task_id": "task-1", "patch": {"status": "completed", "end_time": 1},
        })));
        assert_eq!(cell.data.lock().unwrap().agents[0].status, "completed");
        // 迟到的事件不能把已结束的代理复活。
        agents.observe(&cell, &task_event("task_started", json!({"task_id": "task-1", "subagent_type": "Explore"})));
        agents.observe(&cell, &task_event("task_updated", json!({"task_id": "task-1", "patch": {"status": "running"}})));
        assert_eq!(cell.data.lock().unwrap().agents[0].status, "completed");
        // 通知补上 summary 与用量。
        agents.observe(&cell, &task_event("task_notification", json!({
            "task_id": "task-1", "status": "failed", "summary": "没找到",
            "usage": {"duration_ms": 1200, "tool_uses": 3},
        })));
        let data = cell.data.lock().unwrap();
        let agent = &data.agents[0];
        assert_eq!(agent.status, "failed");
        assert_eq!(agent.summary.as_deref(), Some("没找到"));
        assert_eq!(agent.duration_ms, Some(1200));
        assert_eq!(agent.tool_uses, Some(3));
        assert!(agent.ended_at.is_some());
    }

    #[test]
    fn agent_snapshot_settles_missing_entries_and_filters_noise() {
        let cell = cell();
        let mut agents = ClaudeAgents::default();
        let snapshot = |tasks: Value| task_event("background_tasks_changed", json!({"tasks": tasks}));
        agents.observe(&cell, &snapshot(json!([
            {"task_id": "a", "status": "running", "subagent_type": "Explore"},
            {"task_id": "noise", "status": "running", "ambient": true},
            {"task_id": "hidden", "status": "running", "skip_transcript": true},
        ])));
        {
            let data = cell.data.lock().unwrap();
            assert_eq!(data.agents.len(), 1, "ambient / skip_transcript 不进面板");
            assert_eq!(data.agents[0].task_id, "a");
        }
        // 快照重放：不重复、不复活、不覆盖已落定的耗时。
        agents.observe(&cell, &snapshot(json!([{"task_id": "a", "status": "running"}])));
        assert_eq!(cell.data.lock().unwrap().agents.len(), 1);
        // 快照里消失 → 置 stopped 而不是删除（历史仍要给人看）。
        agents.observe(&cell, &snapshot(json!([])));
        let data = cell.data.lock().unwrap();
        assert_eq!(data.agents.len(), 1);
        assert_eq!(data.agents[0].status, "stopped");
        assert!(data.agents[0].ended_at.is_some());
    }

    #[test]
    fn awaited_agents_stay_visible_but_out_of_background_count() {
        let cell = cell();
        let mut agents = ClaudeAgents::default();
        let mut tasks = ClaudeBackgroundTasks::default();
        let started = task_event("task_started", json!({
            "task_id": "aw", "subagent_type": "Plan", "awaited": true, "is_backgrounded": false,
        }));
        tasks.observe(&cell, "t", &started);
        agents.observe(&cell, &started);
        assert_eq!(cell.data.lock().unwrap().agents.len(), 1, "awaited 也是被派发的子代理");
        assert!(tasks.tasks.is_empty(), "awaited 不占用后台任务计数");
    }

    #[test]
    fn stale_run_frames_are_dropped() {
        let cell = cell();
        let mut agents = ClaudeAgents::default();
        let snapshot = |tasks: Value| task_event("background_tasks_changed", json!({"tasks": tasks}));
        agents.observe(&cell, &snapshot(json!([
            {"task_id": "a", "run_id": "run-0002", "status": "running", "subagent_type": "Explore"},
        ])));
        // 一个属于更早 run 的迟到帧：run_id 字典序更小，整帧丢弃。
        agents.observe(&cell, &task_event("task_notification", json!({
            "task_id": "a", "run_id": "run-0001", "status": "completed",
        })));
        assert_eq!(cell.data.lock().unwrap().agents[0].status, "running", "旧 run 的结论不能生效");
        agents.observe(&cell, &task_event("task_notification", json!({
            "task_id": "a", "run_id": "run-0003", "status": "completed",
        })));
        assert_eq!(cell.data.lock().unwrap().agents[0].status, "completed");
    }

    #[test]
    fn patch_without_status_still_updates_background_flag() {
        let cell = cell();
        let mut agents = ClaudeAgents::default();
        agents.observe(&cell, &task_event("task_started", json!({
            "task_id": "a", "subagent_type": "Explore", "is_backgrounded": false,
        })));
        assert!(!cell.data.lock().unwrap().agents[0].background);
        agents.observe(&cell, &task_event("task_updated", json!({
            "task_id": "a", "patch": {"is_backgrounded": true},
        })));
        let data = cell.data.lock().unwrap();
        assert!(data.agents[0].background, "转后台的补丁即使不带 status 也要生效");
        assert_eq!(data.agents[0].status, "running");
    }

    #[test]
    fn background_shell_tasks_are_not_listed_as_subagents() {
        let cell = cell();
        let mut agents = ClaudeAgents::default();
        // CLI 对后台 Bash 命令也下发同构的 task_* 事件：它不是子代理，不能进 chip 带，
        // 否则点开只有空抽屉（用户报障的成因之一）。
        agents.observe(&cell, &task_event("task_started", json!({
            "task_id": "bash-1", "tool_use_id": "tool-bash", "description": "后台运行 sleep 60",
            "is_backgrounded": true, "task_type": "local_bash",
        })));
        assert!(cell.data.lock().unwrap().agents.is_empty(), "后台命令不进子代理面板");
        // 子代理的 task_type 是 local_agent：必须保留，并记录类型供前端判断。
        agents.observe(&cell, &task_event("task_started", json!({
            "task_id": "agent-1", "tool_use_id": "tool-agent", "subagent_type": "Explore",
            "description": "找代码", "task_type": "local_agent",
        })));
        let data = cell.data.lock().unwrap();
        assert_eq!(data.agents.len(), 1);
        assert_eq!(data.agents[0].task_type.as_deref(), Some("local_agent"));
        // 快照同样要剔除后台命令。
        drop(data);
        agents.observe(&cell, &task_event("background_tasks_changed", json!({"tasks": [
            {"task_id": "bash-2", "status": "running", "task_type": "local_bash"},
            {"task_id": "agent-1", "status": "running", "task_type": "local_agent"},
        ]})));
        assert_eq!(cell.data.lock().unwrap().agents.len(), 1);
    }

    #[test]
    fn subagent_tool_alias_registers_display_name() {
        // 新版 CLI 的子代理工具叫 `Agent`：漏认时子代理消息会回落成通用名。
        assert!(subagent_tool_name("Agent"));
        assert!(subagent_tool_name("Task"));
        assert!(!subagent_tool_name("Bash"));
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        let event = json!({"type": "assistant", "message": {"id": "m-1", "content": [
            {"type": "tool_use", "id": "toolu-agent", "name": "Agent",
             "input": {"subagent_type": "Explore", "description": "检索代码"}}
        ]}});
        apply_claude_event(&cell, "turn", &mut state, &event).unwrap();
        let sub = json!({"type": "assistant", "parent_tool_use_id": "toolu-agent",
            "message": {"id": "sub-1", "content": [{"type": "text", "text": "找到了"}]}});
        apply_claude_event(&cell, "turn", &mut state, &sub).unwrap();
        let data = cell.data.lock().unwrap();
        assert!(data.messages.iter().any(|message| message.subagent.as_deref() == Some("Explore")));
        assert!(data.messages.iter().all(|message| message.subagent.as_deref() != Some("subagent")));
    }

    #[test]
    fn repeated_notifications_replace_previous_report() {
        let cell = cell();
        let mut agents = ClaudeAgents::default();
        agents.observe(&cell, &task_event("task_started", json!({"task_id": "a", "subagent_type": "Explore"})));
        agents.observe(&cell, &task_event("task_notification", json!({
            "task_id": "a", "status": "completed", "summary": "第一版", "usage": {"duration_ms": 100},
        })));
        agents.observe(&cell, &task_event("task_notification", json!({
            "task_id": "a", "status": "completed", "summary": "第二版", "usage": {"duration_ms": 200},
        })));
        let data = cell.data.lock().unwrap();
        assert_eq!(data.agents.len(), 1, "重复通知不新增条目");
        assert_eq!(data.agents[0].summary.as_deref(), Some("第二版"));
        assert_eq!(data.agents[0].duration_ms, Some(200));
    }

    fn task_use(id: &str, name: &str, input: Value) -> Value {
        json!({"type": "assistant", "message": {"id": format!("m-{id}"), "content": [
            {"type": "tool_use", "id": id, "name": name, "input": input}
        ]}})
    }
    fn task_result(id: &str, text: &str) -> Value {
        json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": id, "content": text}
        ]}})
    }

    #[test]
    fn task_create_lands_after_result_reports_number() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        // 调用本身不落清单：真实任务号只在结果里出现。
        apply_claude_event(&cell, "t", &mut state,
            &task_use("a", "TaskCreate", json!({"subject": "读取 AGENTS.md", "description": "了解约定"}))).unwrap();
        assert!(cell.data.lock().unwrap().todos.is_empty());
        apply_claude_event(&cell, "t", &mut state, &task_result("a", "Task #1 created successfully: 读取 AGENTS.md")).unwrap();
        apply_claude_event(&cell, "t", &mut state,
            &task_use("b", "TaskCreate", json!({"subject": "检查 package.json"}))).unwrap();
        apply_claude_event(&cell, "t", &mut state, &task_result("b", "Task #2 created successfully: 检查 package.json")).unwrap();
        let data = cell.data.lock().unwrap();
        assert_eq!(data.todos.len(), 2);
        assert_eq!(data.todos[0].content, "读取 AGENTS.md");
        assert_eq!(data.todos[0].status, "pending");
        assert_eq!(data.todos[1].content, "检查 package.json");
        // 工具调用与结果都要打 todo 标记：正文不渲染原文。
        assert!(data.messages.iter().filter(|m| m.todo).count() == 4);
    }

    #[test]
    fn task_update_patches_status_by_number() {
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        for (id, number, subject) in [("a", 1, "甲"), ("b", 2, "乙")] {
            apply_claude_event(&cell, "t", &mut state, &task_use(id, "TaskCreate", json!({"subject": subject}))).unwrap();
            apply_claude_event(&cell, "t", &mut state,
                &task_result(id, &format!("Task #{number} created successfully: {subject}"))).unwrap();
        }
        apply_claude_event(&cell, "t", &mut state,
            &task_use("c", "TaskUpdate", json!({"taskId": "1", "status": "in_progress"}))).unwrap();
        {
            let data = cell.data.lock().unwrap();
            assert_eq!(data.todos[0].status, "in_progress");
            assert_eq!(data.todos[1].status, "pending");
        }
        apply_claude_event(&cell, "t", &mut state,
            &task_use("d", "TaskUpdate", json!({"taskId": "1", "status": "completed"}))).unwrap();
        assert_eq!(cell.data.lock().unwrap().todos[0].status, "completed");
        // 越界编号与未知状态都不改动清单。
        apply_claude_event(&cell, "t", &mut state,
            &task_use("e", "TaskUpdate", json!({"taskId": "9", "status": "completed"}))).unwrap();
        apply_claude_event(&cell, "t", &mut state,
            &task_use("f", "TaskUpdate", json!({"taskId": "2", "status": "weird"}))).unwrap();
        let data = cell.data.lock().unwrap();
        assert_eq!(data.todos.len(), 2);
        assert_eq!(data.todos[1].status, "pending");
    }

    #[test]
    fn task_list_result_realigns_rows() {
        // 结果里只有编号/状态/标题：整张清单按结果重排。
        let rows = parse_task_list("#1 [completed] 读取 AGENTS.md\n#2 [pending] 检查 package.json").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].0, "2");
        assert_eq!(rows[1].1, "pending");
        // 解析不了的内容（普通工具输出）不误伤清单。
        assert!(parse_task_list("普通输出").is_none());
        assert!(parse_task_list("").is_none());

        // 端到端：TaskList 的结果把清单校准成结果里的状态。
        let cell = cell();
        let mut state = ClaudeOutputState::default();
        apply_claude_event(&cell, "t", &mut state, &task_use("a", "TaskCreate", json!({"subject": "甲"}))).unwrap();
        apply_claude_event(&cell, "t", &mut state, &task_result("a", "Task #1 created successfully: 甲")).unwrap();
        apply_claude_event(&cell, "t", &mut state, &task_use("l", "TaskList", json!({}))).unwrap();
        apply_claude_event(&cell, "t", &mut state, &task_result("l", "#1 [completed] 甲")).unwrap();
        let data = cell.data.lock().unwrap();
        assert_eq!(data.todos.len(), 1);
        assert_eq!(data.todos[0].status, "completed");
    }

    #[test]
    fn task_calls_backfill_from_history() {
        let message = |id: &str, text: &str, todo: bool| AiMessage {
            id: id.into(), role: "tool".into(), text: text.into(), created_at: 0,
            skill_name: None, model_switch: None, subagent_key: None, subagent: None,
            images: Vec::new(), todo,
        };
        let history = vec![
            message("a", "TaskCreate\n{\"subject\":\"读取 AGENTS.md\",\"description\":\"看约定\"}", true),
            message("a-r", "Task #1 created successfully: 读取 AGENTS.md", true),
            message("b", "TaskCreate\n{\"subject\":\"检查 package.json\"}", true),
            message("b-r", "Task #2 created successfully: 检查 package.json", true),
            message("c", "TaskUpdate\n{\"taskId\":\"1\",\"status\":\"in_progress\"}", true),
            message("c-r", "Updated task #1 status", true),
            message("d", "TaskUpdate\n{\"taskId\":\"1\",\"status\":\"completed\"}", true),
        ];
        let todos = todos_from_messages(&history);
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].content, "读取 AGENTS.md");
        assert_eq!(todos[0].status, "completed");
        assert_eq!(todos[1].content, "检查 package.json");
        assert_eq!(todos[1].status, "pending");
        // TaskList 的结果整表校准（编号 → 状态 → 标题）。
        // TaskList 的 ok 结果就是 `#1 [..]` 多行本身：往流里追加这两条后重新还原。
        let mut with_list = history;
        with_list.push(message("l", "TaskList\n{}", true));
        with_list.push(message("l-r", "#1 [pending] 读取 AGENTS.md\n#2 [completed] 检查 package.json", true));
        let todos = todos_from_messages(&with_list);
        assert_eq!(todos[0].status, "pending", "TaskList 结果把第一条改回 pending");
        assert_eq!(todos[1].status, "completed");
    }

    #[test]
    fn task_calls_backfill_from_real_history_shape() {
        // 历史回放里调用与结果是各自独立的条目（`TaskCreate\n{json}` 与 `Task #1 created…`），
        // 且 id 为 `history-{seq}`：这是恢复会话时真正会遇到的形状。
        let entry = |id: &str, role: &str, text: &str, todo: bool| AiMessage {
            id: id.into(), role: role.into(), text: text.into(), created_at: 0,
            skill_name: None, model_switch: None, subagent_key: None, subagent: None,
            images: Vec::new(), todo,
        };
        let history = vec![
            entry("history-8", "tool", "TaskCreate\n{\"activeForm\":\"正在读取 AGENTS.md\",\"subject\":\"读取 AGENTS.md\"}", true),
            entry("history-9", "tool", "Task #1 created successfully: 读取 AGENTS.md", false),
            entry("history-11", "tool", "TaskCreate\n{\"activeForm\":\"正在检查包\",\"subject\":\"检查 package.json\"}", true),
            entry("history-12", "tool", "Task #2 created successfully: 检查 package.json", false),
            entry("history-16", "tool", "TaskUpdate\n{\"status\":\"in_progress\",\"taskId\":\"1\"}", true),
            entry("history-17", "tool", "Updated task #1 status", false),
            entry("history-18", "tool", "TaskUpdate\n{\"status\":\"completed\",\"taskId\":\"1\"}", true),
            entry("history-19", "tool", "Updated task #1 status", false),
        ];
        let todos = todos_from_messages(&history);
        assert_eq!(todos.len(), 2, "恢复后应有两条任务，而不是空清单");
        assert_eq!(todos[0].content, "读取 AGENTS.md");
        assert_eq!(todos[0].status, "completed");
        assert_eq!(todos[0].active_form.as_deref(), Some("正在读取 AGENTS.md"));
        assert_eq!(todos[1].content, "检查 package.json");
        assert_eq!(todos[1].status, "pending");
    }

    #[test]
    fn settle_agents_only_closes_running_entries() {
        let mut data = cell().data.lock().map(|guard| guard.clone()).unwrap();
        data.agents = vec![
            AiAgent { task_id: "a".into(), tool_use_id: None, name: "A".into(), description: None, model: None,
                status: "running".into(), task_type: None, background: false, parent_task_id: None, depth: 1,
                started_at: 0, ended_at: None, summary: None, duration_ms: None, tool_uses: None },
            AiAgent { task_id: "b".into(), tool_use_id: None, name: "B".into(), description: None, model: None,
                status: "completed".into(), task_type: None, background: false, parent_task_id: None, depth: 1,
                started_at: 0, ended_at: Some(5), summary: None, duration_ms: Some(5), tool_uses: None },
        ];
        settle_agents(&mut data, "stopped");
        assert_eq!(data.agents[0].status, "stopped");
        assert_eq!(data.agents[1].status, "completed");
        assert_eq!(data.agents[1].duration_ms, Some(5));
    }

    #[test]
    fn prune_drops_background_shell_agents_from_history() {
        let mut data: AiSession = serde_json::from_value(json!({
            "id": "legacy", "title": "旧会话", "provider": "claude", "projectPath": "/tmp",
            "model": null, "status": "idle", "error": null, "updatedAt": 1, "revision": 1,
            "approvals": [],
            "messages": [
                {"id": "t-tool-bash-1", "role": "tool", "text": "Bash\n{\"command\":\"sleep 60\"}", "createdAt": 0},
                {"id": "t-tool-agent-1", "role": "tool", "text": "Task\n{\"subagent_type\":\"Explore\"}", "createdAt": 0},
            ],
            "agents": [
                {"taskId": "a", "toolUseId": "bash-1", "name": "后台运行 sleep 60", "status": "completed",
                 "background": true, "depth": 1, "startedAt": 0},
                {"taskId": "b", "toolUseId": "agent-1", "name": "Explore", "status": "completed",
                 "background": false, "depth": 1, "startedAt": 0},
                {"taskId": "c", "name": "老记录", "status": "completed", "background": false, "depth": 1, "startedAt": 0},
            ],
        })).unwrap();
        prune_non_subagent_agents(&mut data);
        let ids: Vec<&str> = data.agents.iter().map(|agent| agent.task_id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c"], "后台命令按工具名剔除，无 tool_use 的老记录保留");
    }

    #[test]
    fn legacy_session_json_without_new_fields_still_loads() {
        let legacy: AiSession = serde_json::from_value(json!({
            "id": "old", "title": "旧会话", "provider": "claude", "projectPath": "/tmp",
            "model": null, "status": "idle", "messages": [], "approvals": [], "error": null,
            "updatedAt": 1, "revision": 1,
        })).unwrap();
        assert!(legacy.todos.is_empty());
        assert!(legacy.agents.is_empty());
        // 空集合不落盘：旧格式序列化后不应多出 null / 空数组字段。
        let value = serde_json::to_value(&legacy).unwrap();
        assert!(value.get("todos").is_none());
        assert!(value.get("agents").is_none());
    }
}

#[cfg(test)]
mod interrupt_notice_tests {
    use super::is_interrupt_notice;

    /// 中断类 result 只应结束本段回复，不能把会话判为失败。
    #[test]
    fn recognizes_interrupt_notices() {
        for text in [
            "Interrupted by user",
            "Request was aborted",
            "Operation cancelled",
            "已中断",
            "当前回合被中断",
        ] {
            assert!(is_interrupt_notice(text), "应识别为中断：{text}");
        }
    }

    /// 真实错误不能被误判为中断，否则会吞掉失败原因。
    #[test]
    fn real_errors_are_not_treated_as_interrupts() {
        for text in [
            "API Error: 500 internal server error",
            "上下文超长，请压缩后再试",
            "rate limit exceeded",
        ] {
            assert!(!is_interrupt_notice(text), "不应误判为中断：{text}");
        }
    }
}
