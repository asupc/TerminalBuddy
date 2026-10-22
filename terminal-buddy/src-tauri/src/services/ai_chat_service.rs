//! 原生 AI 会话：Claude print/stream-json 与 Codex app-server 的结构化消息适配。
//! CLI 进程在服务端执行，手机断开不会终止任务。所有文件/进程操作由 handler 的
//! spawn_blocking 或专用工作线程承载；用户文本只进入 stdin，不拼进 shell 命令。
use crate::models::ai_chat::*;
use super::{atomic_file::atomic_write_private, PathService};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Read, Write}, path::PathBuf,
    process::{Child, Command, Stdio}, sync::{Arc, Mutex, OnceLock, mpsc, atomic::{AtomicUsize, Ordering}},
    thread, time::{Duration, Instant}};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const MAX_TEXT: usize = 512 * 1024;
const MAX_LINE: u64 = 8 * 1024 * 1024;
static RUNNING: AtomicUsize = AtomicUsize::new(0);
struct RunningSlot;
impl Drop for RunningSlot { fn drop(&mut self) { RUNNING.fetch_sub(1, Ordering::Relaxed); } }

enum Control { Stop, Approval(AnswerAiApproval) }
struct Cell {
    data: Mutex<AiSession>,
    control: Mutex<Option<mpsc::Sender<Control>>>,
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
    // API 序列化隐藏的字段在磁盘中单独保留。
    let mut value = serde_json::to_value(&*data).map_err(|e| e.to_string())?;
    value["owner"] = json!(data.owner);
    value["threadId"] = json!(data.thread_id);
    value["requestIds"] = json!(data.request_ids);
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
        if matches!(data.status.as_str(), "running" | "approval") {
            data.status = "interrupted".into(); data.approvals.clear();
            data.error = Some("服务已重启，上次执行已中断，可以继续发送消息".into()); touch(&mut data);
        }
        registry.insert(path.clone(), Arc::new(Cell { data: Mutex::new(data), control: Mutex::new(None), path: path.clone() }));
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
pub fn list(owner: &str) -> Result<Vec<AiSession>> {
    let mut sessions = Vec::new();
    for entry in fs::read_dir(directory()?).map_err(|e| e.to_string())?.flatten() {
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            if let Some(id) = entry.path().file_stem().and_then(|id| id.to_str()) {
                if let Ok(mut data) = get(id, owner) { data.messages.clear(); sessions.push(data); }
            }
        }
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(sessions)
}
pub fn create(owner: &str, input: CreateAiSession) -> Result<AiSession> {
    if !matches!(input.provider.as_str(), "claude" | "codex") { return Err("请选择 Claude 或 Codex".into()); }
    if input.model.as_ref().is_some_and(|v| v.len() > 200 || !v.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/[]@+".contains(c))) { return Err("模型名称无效".into()); }
    if list(owner)?.len() >= 200 { return Err("AI 会话数量已达 200，请先删除旧会话".into()); }
    let selection = super::ai_catalog_service::selection(&input.provider, input.provider_id.as_deref(), input.model.as_deref())?;
    let id = Uuid::new_v4().to_string();
    let data = AiSession { id: id.clone(), title: "新对话".into(), provider: input.provider,
        provider_id: selection.as_ref().map(|(id, _)| id.clone()), provider_name: selection.map(|(_, name)| name),
        project_path: input.project_path, model: input.model.filter(|m| !m.trim().is_empty()),
        status: "idle".into(), messages: Vec::new(), approvals: Vec::new(), error: None,
        updated_at: chrono::Utc::now().timestamp_millis(), revision: 1, owner: owner.into(), thread_id: None, request_ids: Vec::new() };
    let cell = Arc::new(Cell { data: Mutex::new(data.clone()), control: Mutex::new(None), path: directory()?.join(format!("{id}.json")) });
    persist(&cell)?;
    registry().lock().map_err(|_| "AI 会话状态不可用")?.insert(cell.path.clone(), cell);
    Ok(data)
}
pub fn delete(id: &str, owner: &str) -> Result<()> {
    let cell = load(id, owner)?;
    let control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    if control.is_some() { return Err("会话正在执行，请先中断再删除".into()); }
    fs::remove_file(&cell.path).map_err(|e| format!("删除 AI 会话失败：{e}"))?;
    registry().lock().map_err(|_| "AI 会话状态不可用")?.remove(&cell.path);
    Ok(())
}
pub fn stop(id: &str, owner: &str) -> Result<()> {
    let cell = load(id, owner)?;
    if let Some(tx) = cell.control.lock().map_err(|_| "AI 会话状态不可用")?.as_ref() {
        tx.send(Control::Stop).map_err(|_| "执行已经结束")?;
    }
    Ok(())
}
pub fn answer(id: &str, owner: &str, input: AnswerAiApproval) -> Result<()> {
    let cell = load(id, owner)?;
    if !cell.data.lock().map_err(|_| "AI 会话状态不可用")?.approvals.iter().any(|a| a.id == input.approval_id) {
        return Err("该请求已经结束，请刷新会话".into());
    }
    if !matches!(input.decision.as_str(), "accept" | "decline") { return Err("无效的确认操作".into()); }
    let result = cell.control.lock().map_err(|_| "AI 会话状态不可用")?.as_ref().ok_or("执行已经结束")?
        .send(Control::Approval(input)).map_err(|_| "执行已经结束".to_string());
    result
}
pub fn send(id: &str, owner: &str, input: SendAiMessage) -> Result<AiSession> {
    let cell = load(id, owner)?;
    if input.text.trim().is_empty() || input.text.len() > 64 * 1024 { return Err("消息不能为空，且不能超过 64 KiB".into()); }
    Uuid::parse_str(&input.request_id).map_err(|_| "消息请求标识无效")?;
    let mut control = cell.control.lock().map_err(|_| "AI 会话状态不可用")?;
    let mut data = cell.data.lock().map_err(|_| "AI 会话状态不可用")?;
    if data.request_ids.contains(&input.request_id) { return Ok(data.clone()); }
    if control.is_some() { return Err("AI 正在回复，请等待完成或先中断".into()); }
    if data.messages.len() >= 400 { return Err("当前会话消息过多，请新建对话".into()); }
    RUNNING.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| (n < 4).then_some(n + 1))
        .map_err(|_| "服务器同时执行的 AI 任务已达上限，请稍后再试")?;
    let slot = RunningSlot;
    let (tx, rx) = mpsc::channel();
    let before = data.clone();
    data.messages.push(AiMessage { id: input.request_id.clone(), role: "user".into(), text: input.text.clone(), created_at: chrono::Utc::now().timestamp_millis() });
    if data.title == "新对话" { data.title = input.text.trim().chars().take(36).collect(); }
    data.request_ids.push(input.request_id); data.status = "running".into(); data.error = None; data.approvals.clear(); touch(&mut data);
    let snapshot = data.clone(); drop(data);
    if let Err(error) = persist(&cell) { *cell.data.lock().map_err(|_| "AI 会话状态不可用")? = before; return Err(error); }
    *control = Some(tx); drop(control);
    let worker_cell = cell.clone();
    if let Err(error) = thread::Builder::new().name(format!("ai-{id}")).spawn(move || {
        let _slot = slot;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_turn(&worker_cell, &input.text, rx)))
            .unwrap_or_else(|_| Err("AI 执行意外结束，可以重新发送消息".into()));
        finish(&worker_cell, result);
    }) {
        *cell.control.lock().map_err(|_| "AI 会话状态不可用")? = None;
        *cell.data.lock().map_err(|_| "AI 会话状态不可用")? = before;
        persist(&cell)?;
        return Err(format!("启动 AI 任务失败：{error}"));
    }
    Ok(snapshot)
}
fn finish(cell: &Cell, result: Result<()>) {
    if let Ok(mut control) = cell.control.lock() {
        if let Ok(mut data) = cell.data.lock() {
            data.approvals.clear();
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
fn message(cell: &Cell, key: &str, role: &str, text: &str, append: bool) {
    if text.is_empty() { return; }
    update(cell, |data| {
        let used: usize = data.messages.iter().filter(|m| m.id != key).map(|m| m.text.len()).sum();
        let budget = MAX_TEXT.min((4 * 1024 * 1024usize).saturating_sub(used));
        if budget == 0 { return; }
        if let Some(item) = data.messages.iter_mut().find(|m| m.id == key) {
            if append { if item.text.len() < MAX_TEXT { item.text.push_str(text); } } else { item.text = text.into(); }
            truncate(&mut item.text, budget);
        } else if data.messages.len() < 400 {
            let mut text = text.to_string(); truncate(&mut text, budget);
            data.messages.push(AiMessage { id: key.into(), role: role.into(), text, created_at: chrono::Utc::now().timestamp_millis() });
        }
    });
}
fn truncate(text: &mut String, max: usize) {
    if text.len() > max { let mut end = max; while !text.is_char_boundary(end) { end -= 1; } text.truncate(end); }
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
fn run_turn(cell: &Cell, prompt: &str, controls: mpsc::Receiver<Control>) -> Result<()> {
    let session = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.clone();
    let launch = super::ai_catalog_service::prepare(&session.provider, session.provider_id.as_deref(), session.model.as_deref())?;
    let mut command = cli_command(&session.provider);
    command.args(&launch.args);
    command.current_dir(&session.project_path);
    if session.provider == "claude" {
        command.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
        if let Some(id) = &session.thread_id { command.arg("--resume").arg(id); }
        if let Some(model) = &session.model { command.arg("--model").arg(model); }
    } else { command.arg("app-server"); }
    let mut process = Process(command.spawn().map_err(|e| format!("无法启动 {}，请确认服务端已安装并配置该 CLI：{e}", session.provider))?);
    let mut stdin = process.0.stdin.take().ok_or("AI 输入通道不可用")?;
    let stdout = process.0.stdout.take().ok_or("AI 输出通道不可用")?;
    let stderr = process.0.stderr.take().ok_or("AI 错误通道不可用")?;
    let errors = Arc::new(Mutex::new(String::new()));
    let error_buffer = errors.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr); let mut buffer = [0; 2048];
        while let Ok(size) = reader.read(&mut buffer) { if size == 0 { break; }
            if let Ok(mut text) = error_buffer.lock() { if text.len() < 8192 { text.push_str(&String::from_utf8_lossy(&buffer[..size])); } }
        }
    });
    let (tx, output) = mpsc::sync_channel(64);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut bytes = Vec::new();
            let result = (&mut reader).take(MAX_LINE + 1).read_until(b'\n', &mut bytes);
            match result {
                Ok(0) => break,
                Ok(_) if bytes.len() as u64 <= MAX_LINE => {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) { if tx.send(Ok(value)).is_err() { break; } }
                }
                _ => { let _ = tx.send(Err("AI 输出超出单条消息限制或读取失败".to_string())); break; }
            }
        }
    });
    if session.provider == "claude" {
        stdin.write_all(prompt.as_bytes()).map_err(|e| e.to_string())?; drop(stdin);
        run_claude(cell, &mut process, controls, output, errors)
    } else {
        write_json(&mut stdin, json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"terminal_buddy_native","version":"1.0.0"}}}))?;
        run_codex(cell, &session, prompt, &mut stdin, controls, output, errors)
    }
}
fn next_output(output: &mpsc::Receiver<Result<Value>>, started: Instant, errors: &Mutex<String>) -> Result<Option<Value>> {
    if started.elapsed() > Duration::from_secs(60 * 60) { return Err("本次 AI 执行超过一小时，已停止".into()); }
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
struct ClaudeMessageBlocks {
    // 保留最近的原始块序号，兼容完成消息在 stop 事件之后到达。
    current_index: Option<u64>,
    next_index: u64,
}
#[derive(Default)]
struct ClaudeOutputState {
    message_number: u64,
    current_message: String,
    messages: HashMap<String, ClaudeMessageBlocks>,
}
impl ClaudeOutputState {
    fn stream(&mut self, cell: &Cell, turn: &str, event: &Value) {
        match event["type"].as_str().unwrap_or("") {
            "message_start" => {
                self.message_number += 1;
                self.current_message = event["message"]["id"].as_str().map(str::to_string)
                    .unwrap_or_else(|| format!("message-{}", self.message_number));
                self.messages.entry(self.current_message.clone()).or_default().current_index = None;
            }
            "content_block_start" | "content_block_delta" => {
                let Some(index) = event["index"].as_u64() else { return; };
                let blocks = self.messages.entry(self.current_message.clone()).or_default();
                blocks.current_index = Some(index);
                blocks.next_index = blocks.next_index.max(index + 1);
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta" {
                    message(cell, &format!("{turn}-text-{}-{index}", self.current_message), "assistant",
                        event["delta"]["text"].as_str().unwrap_or(""), true);
                }
            }
            _ => {}
        }
    }
    fn assistant(&mut self, cell: &Cell, turn: &str, assistant: &Value) {
        let Some(content) = assistant["content"].as_array() else { return; };
        let id = assistant["id"].as_str().unwrap_or(&self.current_message);
        let blocks = self.messages.entry(id.to_string()).or_default();
        // Claude 按内容块回传完成消息，其数组下标会重置为 0；必须沿用流式块的原始序号。
        // 没有流式事件时按已接收的内容块递增；完整多块快照则保留数组中的原始序号。
        let first_index = if content.len() == 1 { blocks.current_index.unwrap_or(blocks.next_index) } else { 0 };
        for (offset, item) in content.iter().enumerate() {
            let index = first_index + offset as u64;
            if item["type"] == "text" {
                message(cell, &format!("{turn}-text-{id}-{index}"), "assistant", item["text"].as_str().unwrap_or(""), false);
            }
            if item["type"] == "tool_use" {
                message(cell, &format!("{turn}-tool-{}", item["id"]), "tool",
                    &format!("{}\n{}", item["name"].as_str().unwrap_or("工具调用"), item["input"]), false);
            }
        }
        blocks.next_index = blocks.next_index.max(first_index + content.len() as u64);
    }
}
fn apply_claude_event(cell: &Cell, turn: &str, state: &mut ClaudeOutputState, value: &Value) -> Result<bool> {
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
                let has_answer = cell.data.lock().map_err(|_| "AI 会话状态不可用")?.messages.iter().any(|m| m.id.starts_with(turn) && m.role == "assistant");
                if !has_answer { message(cell, &format!("{turn}-result"), "assistant", text, false); }
            }
            if let Some(denials) = value["permission_denials"].as_array().filter(|items| !items.is_empty()) {
                message(cell, &format!("{turn}-permissions"), "tool", "部分工具操作未获服务端权限。请在服务端配置 Claude 的工具权限后重试。", false);
                let _ = denials;
            }
            return Ok(true);
        }
        _ => {}
    }
    Ok(false)
}
fn run_claude(cell: &Cell, _process: &mut Process, controls: mpsc::Receiver<Control>, output: mpsc::Receiver<Result<Value>>, errors: Arc<Mutex<String>>) -> Result<()> {
    let started = Instant::now(); let mut checkpoint = Instant::now(); let turn = Uuid::new_v4().to_string();
    let mut state = ClaudeOutputState::default();
    loop {
        if matches!(controls.try_recv(), Ok(Control::Stop)) { return Err("已中断".into()); }
        if checkpoint.elapsed() > Duration::from_secs(5) { persist(cell)?; checkpoint = Instant::now(); }
        let Some(value) = next_output(&output, started, &errors)? else { continue; };
        if apply_claude_event(cell, &turn, &mut state, &value)? { return Ok(()); }
    }
}
fn run_codex(cell: &Cell, session: &AiSession, prompt: &str, stdin: &mut impl Write,
    controls: mpsc::Receiver<Control>, output: mpsc::Receiver<Result<Value>>, errors: Arc<Mutex<String>>) -> Result<()> {
    let started = Instant::now(); let mut checkpoint = Instant::now(); let turn = Uuid::new_v4().to_string();
    let mut pending: HashMap<String, (Value, String)> = HashMap::new();
    loop {
        while let Ok(control) = controls.try_recv() {
            match control {
                Control::Stop => return Err("已中断".into()),
                Control::Approval(answer) => {
                    if let Some((id, method)) = pending.remove(&answer.approval_id) {
                        let result = if method == "item/tool/requestUserInput" {
                            json!({"answers": if answer.decision == "accept" { answer.answers } else { json!({}) }})
                        } else { json!({"decision":answer.decision}) };
                        write_json(stdin, json!({"id":id,"result":result}))?;
                        update(cell, |data| { data.approvals.retain(|a| a.id != answer.approval_id); if data.approvals.is_empty() { data.status = "running".into(); } });
                    }
                }
            }
        }
        if checkpoint.elapsed() > Duration::from_secs(5) { persist(cell)?; checkpoint = Instant::now(); }
        let Some(value) = next_output(&output, started, &errors)? else { continue; };
        if value.get("error").is_some() { return Err(value["error"]["message"].as_str().unwrap_or("Codex 请求失败").into()); }
        if value["id"] == 1 && value.get("result").is_some() {
            write_json(stdin, json!({"method":"initialized","params":{}}))?;
            let mut params = json!({"cwd": session.project_path});
            if let Some(model) = &session.model { params["model"] = json!(model); }
            let method = if let Some(id) = &session.thread_id { params["threadId"] = json!(id); "thread/resume" } else { "thread/start" };
            write_json(stdin, json!({"id":2,"method":method,"params":params}))?;
        } else if value["id"] == 2 && value.get("result").is_some() {
            let id = value["result"]["thread"]["id"].as_str().ok_or("Codex 未返回会话标识")?;
            update(cell, |data| data.thread_id = Some(id.into())); persist(cell)?;
            write_json(stdin, json!({"id":3,"method":"turn/start","params":{"threadId":id,"input":[{"type":"text","text":prompt}]}}))?;
        }
        let method = value["method"].as_str().unwrap_or(""); let params = &value["params"];
        if value.get("id").is_some() && !method.is_empty() {
            if matches!(method, "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/tool/requestUserInput") {
                let id = Uuid::new_v4().to_string(); pending.insert(id.clone(), (value["id"].clone(), method.into()));
                update(cell, |data| { data.status = "approval".into(); data.approvals.push(AiApproval { id, method: method.into(), details: params.clone() }); });
            } else { write_json(stdin, json!({"id":value["id"],"error":{"code":-32601,"message":"客户端暂不支持此交互请求"}}))?; }
        }
        match method {
            "item/agentMessage/delta" => message(cell, &format!("{turn}-{}", params["itemId"]), "assistant", params["delta"].as_str().unwrap_or(""), true),
            "item/commandExecution/outputDelta" => message(cell, &format!("{turn}-output-{}", params["itemId"]), "tool", params["delta"].as_str().unwrap_or(""), true),
            "item/started" | "item/completed" => {
                let item = &params["item"]; let key = format!("{turn}-{}", item["id"]);
                match item["type"].as_str().unwrap_or("") {
                    "agentMessage" if method == "item/completed" => message(cell, &key, "assistant", item["text"].as_str().unwrap_or(""), false),
                    "commandExecution" => {
                        let command = item["command"].as_str().unwrap_or("执行命令");
                        let text = format!("{command}\n{}", item["aggregatedOutput"].as_str().unwrap_or(""));
                        message(cell, &key, "tool", &text, false);
                    }
                    "fileChange" => message(cell, &key, "tool", &format!("文件变更\n{}", item["changes"]), false),
                    _ => {}
                }
            }
            "turn/completed" => {
                return match params["turn"]["status"].as_str().unwrap_or("") {
                    "completed" => Ok(()), "interrupted" => Err("已中断".into()),
                    _ => Err(params["turn"]["error"]["message"].as_str().unwrap_or("Codex 执行失败").into()),
                };
            }
            "error" if params["willRetry"] != true => return Err(params["error"]["message"].as_str().unwrap_or("Codex 执行失败").into()),
            _ => {}
        }
    }
}

/// 应用退出时同时收尾原生 AI 任务，防止留下无主 CLI 子进程。
pub fn shutdown_all() {
    let cells = registry().lock().map(|items| items.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
    for cell in cells {
        if let Ok(control) = cell.control.lock() {
            if let Some(tx) = control.as_ref() { let _ = tx.send(Control::Stop); }
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
        Cell { data: Mutex::new(data), control: Mutex::new(None), path: PathBuf::new() }
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
}
