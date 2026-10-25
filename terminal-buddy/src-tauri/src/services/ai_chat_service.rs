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
        if matches!(data.status.as_str(), "running" | "approval" | "background" | "stopping") {
            data.status = "interrupted".into(); data.approvals.clear();
            usage::finish_turn(&mut data);
            data.error = Some("服务已重启，上次执行已中断，可以继续发送消息".into()); touch(&mut data);
        }
        registry.insert(path.clone(), Arc::new(Cell { data: Mutex::new(data), control: Mutex::new(None), summary: Mutex::default(), deleted: AtomicBool::new(false), path: path.clone() }));
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
                if let Ok(mut data) = get_with_summary(id, owner) { data.messages.clear(); sessions.push(data); }
            }
        }
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(sessions)
}
pub fn create(owner: &str, input: CreateAiSession) -> Result<AiSession> {
    if !matches!(input.provider.as_str(), "claude" | "codex") { return Err("请选择 Claude 或 Codex".into()); }
    if input.model.as_ref().is_some_and(|v| !v.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/[]@+".contains(c))) { return Err("模型名称无效".into()); }
    let selection = super::ai_catalog_service::selection(&input.provider, input.provider_id.as_deref(), input.model.as_deref())?;
    let id = Uuid::new_v4().to_string();
    let data = AiSession { id: id.clone(), title: "新对话".into(), provider: input.provider,
        provider_id: selection.as_ref().map(|(id, _)| id.clone()), provider_name: selection.map(|(_, name)| name),
        project_path: input.project_path, model: input.model.filter(|m| !m.trim().is_empty()),
        status: "idle".into(), messages: Vec::new(), approvals: Vec::new(), error: None,
        usage: Some(usage::initial()), usage_checkpoint: None,
        updated_at: chrono::Utc::now().timestamp_millis(), revision: 1, owner: owner.into(), thread_id: None, request_ids: Vec::new() };
    let cell = Arc::new(Cell { data: Mutex::new(data.clone()), control: Mutex::new(None), summary: Mutex::default(), deleted: AtomicBool::new(false), path: directory()?.join(format!("{id}.json")) });
    persist(&cell)?;
    registry().lock().map_err(|_| "AI 会话状态不可用")?.insert(cell.path.clone(), cell);
    Ok(data)
}
pub fn delete(id: &str, owner: &str) -> Result<()> {
    let cell = load(id, owner)?;
    let mut control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    let data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if control.is_some() && (data.provider != "codex" || data.status != "idle") {
        return Err("会话正在执行，请先中断再删除".into());
    }
    fs::remove_file(&cell.path).map_err(|e| format!("删除 AI 会话失败：{e}"))?;
    cell.deleted.store(true, Ordering::Release);
    // 空闲 Codex 仍保留 app-server；删除时退出，但不能再执行普通收尾把文件写回来。
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
    let reuse = data.provider == "codex" && control.is_some() && matches!(data.status.as_str(), "idle" | "background");
    if control.is_some() && !reuse { return Err("AI 正在回复，请等待完成或先中断".into()); }
    let before = data.clone();
    data.messages.push(AiMessage { id: input.request_id.clone(), role: "user".into(), text: input.text.clone(), created_at: chrono::Utc::now().timestamp_millis() });
    if data.title == "新对话" { data.title = input.text.trim().chars().take(36).collect(); }
    usage::begin_turn(&mut data);
    data.request_ids.push(input.request_id.clone()); data.status = "running".into(); data.error = None; data.approvals.clear(); touch(&mut data);
    let snapshot = data.clone();
    if let Err(error) = persist_data(&cell, &data) { *data = before; return Err(error); }
    if reuse {
        if control.as_ref().ok_or("AI 输入通道不可用")?.send(Control::Message { text: input.text, request_id: input.request_id }).is_err() {
            *data = before;
            persist_data(&cell, &data)?;
            return Err("Codex 进程已退出，请再次发送消息".into());
        }
        return Ok(snapshot);
    }
    drop(data);
    RUNNING.fetch_add(1, Ordering::Relaxed);
    let task = RunningTask;
    let (tx, rx) = mpsc::channel();
    *control = Some(tx); drop(control);
    let worker_cell = cell.clone();
    if let Err(error) = thread::Builder::new().name(format!("ai-{id}")).spawn(move || {
        let _task = task;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_turn(&worker_cell, &input.text, rx)))
            .unwrap_or_else(|_| Err("AI 执行意外结束，可以重新发送消息".into()));
        match result {
            Ok(WorkerExit::Retired) => {},
            result => finish(&worker_cell, result.map(|_| ())),
        }
    }) {
        *cell.control.lock().map_err(|_| "AI 会话状态不可用")? = None;
        *cell.data.lock().map_err(|_| "AI 会话状态不可用")? = before;
        persist(&cell)?;
        return Err(format!("启动 AI 任务失败：{error}"));
    }
    Ok(snapshot)
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
fn finish(cell: &Cell, result: Result<()>) {
    refresh_title(cell, true);
    if let Ok(mut control) = cell.control.lock() {
        if let Ok(mut data) = cell.data.lock() {
            data.approvals.clear();
            usage::finish_turn(&mut data);
            match result {
                Ok(()) => { data.status = "idle".into(); data.error = None; }
                Err(error) => { data.status = if error == "已中断" { "interrupted" } else { "error" }.into(); data.error = Some(error); }
            }
            touch(&mut data);
        }
        *control = None;
        if let Err(error) = persist(cell) {
            if let Ok(mut data) = cell.data.lock() { data.status = "error".into(); data.error = Some(error); touch(&mut data); }
        }
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
    let configured = std::env::var_os(if provider == "claude" { "TERMINAL_BUDDY_CLAUDE_BIN" } else { "TERMINAL_BUDDY_CODEX_BIN" });
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
    } else {
        // 已有线程无法追加 dynamicTools，启用普通模式的原生提问工具兼容旧对话。
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
        write_json(&mut stdin, json!({"type":"user","message":{"role":"user","content":prompt},
            "parent_tool_use_id":null,"session_id":session.thread_id.as_deref().unwrap_or("")}))?;
        run_claude(cell, &mut process, stdin, controls, output, errors, hooks.as_ref().ok_or("Claude 决策 Hook 未初始化")?)
            .map(|_| WorkerExit::Completed)
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
fn run_claude(cell: &Cell, process: &mut Process, stdin: ChildStdin, controls: mpsc::Receiver<Control>,
    output: mpsc::Receiver<Result<Value>>, errors: Arc<Mutex<String>>, hooks: &NativeClaudeHooks) -> Result<()> {
    let mut checkpoint = Instant::now(); let turn = Uuid::new_v4().to_string();
    let mut state = ClaudeOutputState::default();
    let mut tasks = ClaudeBackgroundTasks::default();
    let mut input = Some(stdin);
    let mut pending: HashMap<String, ClaudeApproval> = HashMap::new();
    let mut received_result = false;
    let mut output_closed = false;
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
            if matches!(control, Control::Stop) { return Err("已中断".into()); }
            if let Control::Approval(answer) = control {
                if let Some(request) = pending.remove(&answer.approval_id) {
                    let stdin = input.as_mut().ok_or("Claude 输入通道已关闭，请重新发送消息")?;
                    write_json(stdin, request.response(&answer)?)?;
                    update(cell, |data| {
                        data.approvals.retain(|a| a.id != answer.approval_id);
                        if data.approvals.is_empty() { data.status = "running".into(); }
                    });
                }
            }
        }
        if checkpoint.elapsed() > Duration::from_secs(5) { persist(cell)?; checkpoint = Instant::now(); }
        if output_closed {
            if let Some(status) = process.0.try_wait().map_err(|e| format!("读取 Claude 进程状态失败：{e}"))? {
                if !status.success() || !received_result {
                    let details = errors.lock().map(|e| e.clone()).unwrap_or_default();
                    return Err(if !details.trim().is_empty() { format!("Claude 进程已退出：{}", details.trim()) }
                        else if !received_result { "Claude 进程已退出，未收到完成事件，可以继续发送消息".into() }
                        else { format!("Claude 进程异常结束（{status}），可以继续发送消息") });
                }
                if !tasks.tasks.is_empty() { return Err("Claude 进程已退出，但仍有后台任务未完成，可以继续发送消息".into()); }
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        let value = match output.recv_timeout(Duration::from_millis(100)) {
            Ok(value) => value?,
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
        if apply_claude_event(cell, &turn, &mut state, &value)? { received_result = true; }
        // result 只表示一段回复结束。后台工作仍在执行时保留输入连接，CLI 才能继续接收唤醒与结果。
        // 任务全部结束后关闭输入，并读完 stdout、等到正常退出，再由外层统一收尾。
        let waiting_for_hook = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.approvals.iter()
            .any(|item| item.method == approval::CLAUDE_HOOK_METHOD);
        if received_result && tasks.tasks.is_empty() && pending.is_empty() && !waiting_for_hook { drop(input.take()); }
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
        if data.request_ids.last().map(String::as_str) != request_id || data.status == "stopping" { return; }
        let status = if !data.approvals.is_empty() { "approval" } else if submitting || !state.finished { "running" }
            else if background.running(state) { "background" } else { "idle" };
        if data.status != status { data.status = status.into(); touch(&mut data); }
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
    let mut resume_request = None;
    let mut turn_request = None;
    let mut queued_prompt = Some(prompt.to_string());
    let mut request_id = session.request_ids.last().cloned();
    let mut agent_queries: HashMap<u64, String> = HashMap::new();
    let mut agent_checkpoint = Instant::now();
    let mut settle_at: Option<Instant> = None;
    if let Ok(mut data) = cell.data.lock() { state.usage.start(&mut data); }
    loop {
        while let Ok(control) = controls.try_recv() {
            match control {
                Control::Stop => return Err("已中断".into()),
                Control::Retire => return Ok(WorkerExit::Retired),
                Control::Message { text, request_id: accepted_id } => {
                    request_id = Some(accepted_id);
                    state.usage = usage::CodexUsageTracker::default();
                    if let Ok(mut data) = cell.data.lock() { state.usage.start(&mut data); }
                    let id = state.thread_id.as_deref().ok_or("Codex 会话尚未初始化")?;
                    if !state.finished && state.turn_id.is_some() {
                        // turn/start 由 app-server 原子处理活动回合的补充输入，也兼容它刚好结束的竞争情况。
                        let mut params = json!({"threadId":id,"input":[{"type":"text","text":text}]});
                        super::ai_permission_service::for_agent("codex")?.apply_turn(&mut params);
                        state.usage.submitted();
                        turn_request = Some(codex_request(stdin, &mut next_id, "turn/start", params)?);
                    } else {
                        let permissions = super::ai_permission_service::for_agent("codex")?;
                        let mut params = json!({"threadId":id,"cwd":session.project_path});
                        permissions.apply_thread(&mut params);
                        if let Some(model) = &session.model { params["model"] = json!(model); }
                        resume_request = Some(codex_request(stdin, &mut next_id, "thread/resume", params)?);
                        queued_prompt = Some(text);
                        state.turn_id = None;
                    }
                }
                Control::Approval(answer) => {
                    if let Some((id, method)) = pending.remove(&answer.approval_id) {
                        let result = approval::codex_response(&method, &answer);
                        write_json(stdin, json!({"id":id,"result":result}))?;
                        update(cell, |data| { data.approvals.retain(|a| a.id != answer.approval_id); });
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
        let Some(value) = next_output(&output, &errors)? else { continue; };
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
            let mut params = json!({"cwd": session.project_path});
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

}
