//! 终端内运行的 Agent 用量快照（底部状态栏）。
//!
//! 原生聊天会话由 app-server 主动推送 usage；终端里启动的 Claude / Codex 没有这条通道，
//! 只能读 CLI 自己写的 transcript。这里只做只读解析，并把结果按文件 mtime/size 缓存，
//! 供状态栏按终端轮询。
use crate::models::ai_chat::AiTokenUsage;
use crate::services::{
    ai_catalog_service, claude_hook_settings, llm_provider_service,
    terminal_task_service,
};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentUsage {
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub context_used_tokens: Option<u64>,
    pub context_window_tokens: Option<u64>,
    pub total: AiTokenUsage,
    pub updated_at: i64,
}

#[derive(Clone, Default)]
struct ParsedUsage {
    model: Option<String>,
    context_used: Option<u64>,
    context_window: Option<u64>,
    total: AiTokenUsage,
}

#[derive(Clone, Default)]
struct ClaudeIncremental {
    line_index: usize,
    by_message: HashMap<String, AiTokenUsage>,
    last_main_used: Option<u64>,
    last_main_model: Option<String>,
}

#[derive(Clone, Default)]
struct CodexIncremental {
    model: Option<String>,
    context_used: Option<u64>,
    context_window: Option<u64>,
    total: AiTokenUsage,
    has_totals: bool,
    last_sum: AiTokenUsage,
}

#[derive(Clone, Default)]
struct AntigravityIncremental {
    line_index: usize,
    model: Option<String>,
    context_used: Option<u64>,
    by_step: HashMap<String, AiTokenUsage>,
}

#[derive(Clone)]
enum IncrementalState {
    Claude(ClaudeIncremental),
    Codex(CodexIncremental),
    Antigravity(AntigravityIncremental),
}

impl IncrementalState {
    fn new(provider: &str) -> Self {
        match provider {
            "codex" => Self::Codex(CodexIncremental::default()),
            "antigravity" => Self::Antigravity(AntigravityIncremental::default()),
            _ => Self::Claude(ClaudeIncremental::default()),
        }
    }

    fn feed_line(&mut self, trimmed_line: &str, has_newline: bool) -> bool {
        if !has_newline && trimmed_line.is_empty() {
            return true;
        }
        // `\n` 已落盘的行允许先做廉价子串过滤；末尾无 `\n` 的残行可能是半行写入，
        // 需先尝试解析完整 JSON 才能确认是否推进偏移。
        let parsed_value = if has_newline {
            let matches_prefilter = match self {
                Self::Claude(_) => trimmed_line.contains("\"assistant\""),
                Self::Codex(_) => {
                    trimmed_line.contains("token_count") || trimmed_line.contains("\"model\"")
                }
                Self::Antigravity(_) => trimmed_line.contains("PLANNER_RESPONSE") || trimmed_line.contains("CHECKPOINT"),
            };
            if !matches_prefilter {
                match self {
                    Self::Claude(state) => state.line_index += 1,
                    Self::Antigravity(state) => state.line_index += 1,
                    Self::Codex(_) => {}
                }
                return true;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed_line) else {
                match self {
                    Self::Claude(state) => state.line_index += 1,
                    Self::Antigravity(state) => state.line_index += 1,
                    Self::Codex(_) => {}
                }
                return true;
            };
            value
        } else {
            let Ok(value) = serde_json::from_str::<Value>(trimmed_line) else {
                // 半行仍未写完：不推进偏移或行号，等待下一轮补齐换行。
                return false;
            };
            value
        };

        match self {
            Self::Claude(state) => {
                let index = state.line_index;
                state.line_index += 1;
                if parsed_value.get("type").and_then(Value::as_str) != Some("assistant") {
                    return true;
                }
                let Some(message) = parsed_value.get("message") else {
                    return true;
                };
                let usage = message.get("usage").unwrap_or(&Value::Null);
                let fresh = number(usage, "input_tokens");
                let cached = number(usage, "cache_read_input_tokens");
                let created = number(usage, "cache_creation_input_tokens");
                let output = number(usage, "output_tokens");
                if fresh.is_none() && cached.is_none() && created.is_none() && output.is_none() {
                    return true;
                }
                let input = add(add(fresh, cached), created);
                let tokens = AiTokenUsage {
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_input_tokens: cached,
                    cache_creation_input_tokens: created,
                    reasoning_output_tokens: usage
                        .pointer("/output_tokens_details/thinking_tokens")
                        .and_then(Value::as_u64),
                };
                let id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("line-{index}"));
                merge_max(state.by_message.entry(id).or_default(), &tokens);
                if parsed_value.get("isSidechain").and_then(Value::as_bool) != Some(true) {
                    if let Some(model) = message
                        .get("model")
                        .and_then(Value::as_str)
                        .filter(|model| !model.is_empty())
                    {
                        state.last_main_model = Some(model.to_string());
                    }
                    if let Some(used) = input.filter(|used| *used > 0) {
                        state.last_main_used = Some(used);
                    }
                }
                true
            }
            Self::Codex(state) => {
                let payload = parsed_value.get("payload").unwrap_or(&parsed_value);
                let kind = parsed_value.get("type").and_then(Value::as_str).unwrap_or("");
                let payload_kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
                if let Some(model) = payload
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|model| !model.is_empty())
                {
                    state.model = Some(model.to_string());
                }
                if kind != "event_msg" || payload_kind != "token_count" {
                    return true;
                }
                let info = payload.get("info").unwrap_or(&Value::Null);
                if let Some(total) = info.get("total_token_usage").filter(|value| value.is_object()) {
                    state.has_totals = true;
                    merge_max(
                        &mut state.total,
                        &AiTokenUsage {
                            input_tokens: number(total, "input_tokens"),
                            output_tokens: number(total, "output_tokens"),
                            cache_read_input_tokens: number(total, "cached_input_tokens"),
                            cache_creation_input_tokens: None,
                            reasoning_output_tokens: number(total, "reasoning_output_tokens"),
                        },
                    );
                } else if !state.has_totals {
                    let last = info.get("last_token_usage").unwrap_or(&Value::Null);
                    state.last_sum = plus(
                        &state.last_sum,
                        &AiTokenUsage {
                            input_tokens: number(last, "input_tokens"),
                            output_tokens: number(last, "output_tokens"),
                            ..Default::default()
                        },
                    );
                }
                if let Some(last) = info.get("last_token_usage").filter(|value| value.is_object()) {
                    let used = number(last, "total_tokens")
                        .or_else(|| add(number(last, "input_tokens"), number(last, "output_tokens")));
                    if let Some(used) = used.filter(|used| *used > 0) {
                        state.context_used = Some(used);
                    }
                }
                if let Some(window) = number(info, "model_context_window")
                    .or_else(|| number(info, "modelContextWindow"))
                {
                    if window > 0 {
                        state.context_window = Some(window);
                    }
                }
                true
            }
            Self::Antigravity(state) => {
                let index = state.line_index;
                state.line_index += 1;
                let row_type = parsed_value.get("type").and_then(Value::as_str).unwrap_or("");
                let is_planner = row_type == "PLANNER_RESPONSE";
                let is_checkpoint = row_type == "CHECKPOINT";
                if !is_planner && !is_checkpoint {
                    return true;
                }
                if is_planner {
                    let source = parsed_value.get("source").and_then(Value::as_str).unwrap_or("");
                    if !matches!(source, "" | "MODEL") {
                        return true;
                    }
                }
                // 跳过明确标记为未完成的流式行（如 status: "GENERATING"），防止缺失 step_index 时重复累加。
                if let Some(status) = parsed_value
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|status| !status.is_empty())
                {
                    if status != "DONE" {
                        return true;
                    }
                }
                if is_planner {
                    if let Some(model) = parsed_value
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|model| !model.is_empty())
                    {
                        state.model = Some(model.to_string());
                    }
                }
                let fresh = number(&parsed_value, "input_tokens");
                let cached = number(&parsed_value, "cache_read_tokens");
                let created = number(&parsed_value, "cache_creation_input_tokens")
                    .or_else(|| number(&parsed_value, "cache_write_tokens"));
                let output = number(&parsed_value, "output_tokens");
                if fresh.is_none() && cached.is_none() && created.is_none() && output.is_none() {
                    return true;
                }
                let input = add(add(fresh, cached), created);
                let tokens = AiTokenUsage {
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_input_tokens: cached,
                    cache_creation_input_tokens: created,
                    reasoning_output_tokens: None,
                };
                let prefix = if is_checkpoint { "checkpoint" } else { "step" };
                let key = parsed_value
                    .get("step_index")
                    .and_then(Value::as_u64)
                    .map(|step| format!("{prefix}-{step}"))
                    .unwrap_or_else(|| format!("line-{index}"));
                merge_max(state.by_step.entry(key).or_default(), &tokens);
                if is_planner {
                    if let Some(used) = input.filter(|used| *used > 0) {
                        state.context_used = Some(used);
                    }
                }
                true
            }
        }
    }

    fn finalize(&self) -> ParsedUsage {
        match self {
            Self::Claude(state) => {
                let mut result = ParsedUsage {
                    model: state.last_main_model.clone(),
                    context_used: state.last_main_used,
                    context_window: None,
                    total: AiTokenUsage::default(),
                };
                for tokens in state.by_message.values() {
                    result.total = plus(&result.total, tokens);
                }
                result
            }
            Self::Codex(state) => ParsedUsage {
                model: state.model.clone(),
                context_used: state.context_used,
                context_window: state.context_window,
                total: if state.has_totals {
                    state.total.clone()
                } else {
                    state.last_sum.clone()
                },
            },
            Self::Antigravity(state) => {
                let mut result = ParsedUsage {
                    model: state.model.clone(),
                    context_used: state.context_used,
                    context_window: None,
                    total: AiTokenUsage::default(),
                };
                for tokens in state.by_step.values() {
                    result.total = plus(&result.total, tokens);
                }
                result
            }
        }
    }
}

#[derive(Clone)]
struct CachedParse {
    provider: String,
    mtime: u64,
    size: u64,
    parsed_offset: u64,
    state: IncrementalState,
    parsed: ParsedUsage,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CachedParse>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedParse>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn number(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|raw| {
        raw.as_u64()
            .or_else(|| raw.as_str()?.trim().parse::<u64>().ok())
    })
}

fn add(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (None, None) => None,
        _ => Some(a.unwrap_or(0).saturating_add(b.unwrap_or(0))),
    }
}

fn max(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        _ => a.or(b),
    }
}

fn plus(a: &AiTokenUsage, b: &AiTokenUsage) -> AiTokenUsage {
    AiTokenUsage {
        input_tokens: add(a.input_tokens, b.input_tokens),
        output_tokens: add(a.output_tokens, b.output_tokens),
        cache_read_input_tokens: add(a.cache_read_input_tokens, b.cache_read_input_tokens),
        cache_creation_input_tokens: add(a.cache_creation_input_tokens, b.cache_creation_input_tokens),
        reasoning_output_tokens: add(a.reasoning_output_tokens, b.reasoning_output_tokens),
    }
}

/// 同一 API 消息可能被 transcript 重复写入（流式落盘 / 重放）：
/// 同一字段取高水位，不能按行累加。
fn merge_max(target: &mut AiTokenUsage, source: &AiTokenUsage) {
    target.input_tokens = max(target.input_tokens, source.input_tokens);
    target.output_tokens = max(target.output_tokens, source.output_tokens);
    target.cache_read_input_tokens = max(target.cache_read_input_tokens, source.cache_read_input_tokens);
    target.cache_creation_input_tokens = max(target.cache_creation_input_tokens, source.cache_creation_input_tokens);
    target.reasoning_output_tokens = max(target.reasoning_output_tokens, source.reasoning_output_tokens);
}

#[cfg(test)]
fn parse_with_state(provider: &str, content: &str) -> ParsedUsage {
    let mut state = IncrementalState::new(provider);
    for raw in content.split_inclusive('\n') {
        let has_newline = raw.ends_with('\n');
        let trimmed = raw.trim_end_matches(['\r', '\n']);
        state.feed_line(trimmed, has_newline);
    }
    state.finalize()
}

/// Claude transcript：assistant 行既有正文也有 usage。上下文按主线程最后一条
/// 消息的输入量（含缓存读写）计算，累计量覆盖主线程与子代理的全部 API 调用。
#[cfg(test)]
fn parse_claude(content: &str) -> ParsedUsage {
    parse_with_state("claude", content)
}

/// Codex rollout：`token_count` 的 `total_token_usage` 是累计快照（取高水位），
/// `last_token_usage` 是本轮用量，可估算当前上下文占用；`model_context_window`
/// 由 CLI 直接给出。
#[cfg(test)]
fn parse_codex(content: &str) -> ParsedUsage {
    parse_with_state("codex", content)
}

/// Antigravity CLI transcript：`PLANNER_RESPONSE` 行中的 `input_tokens` 为未缓存输入，
/// `cache_read_tokens` 为缓存命中输入；两者之和才是该步总输入与上下文占用。
#[cfg(test)]
fn parse_antigravity(content: &str) -> ParsedUsage {
    parse_with_state("antigravity", content)
}

fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let metadata = fs::metadata(path).ok()?;
    let mtime = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((mtime, metadata.len()))
}

fn parse_file(path: &Path, provider: &str) -> Result<ParsedUsage, String> {
    let (mtime, size) = file_stamp(path)
        .ok_or_else(|| format!("读取会话文件信息失败：{}", path.display()))?;
    let mut resume_from: Option<(u64, IncrementalState)> = None;
    if let Ok(map) = cache().lock() {
        if let Some(cached) = map.get(path) {
            if cached.provider == provider && cached.mtime == mtime && cached.size == size {
                return Ok(cached.parsed.clone());
            }
            if cached.provider == provider && size > cached.size && cached.parsed_offset <= size {
                resume_from = Some((cached.parsed_offset, cached.state.clone()));
            }
        }
    }

    let (mut offset, mut state) =
        resume_from.unwrap_or_else(|| (0, IncrementalState::new(provider)));
    let mut file = File::open(path).map_err(|error| format!("读取会话文件失败：{}", error))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("定位会话文件失败：{}", error))?;
    let mut reader = BufReader::new(file);
    let mut raw_line = String::new();
    loop {
        raw_line.clear();
        let bytes = reader
            .read_line(&mut raw_line)
            .map_err(|error| format!("读取会话文件失败：{}", error))?;
        if bytes == 0 {
            break;
        }
        let has_newline = raw_line.ends_with('\n');
        let trimmed = raw_line.trim_end_matches(['\r', '\n']);
        if state.feed_line(trimmed, has_newline) {
            offset += bytes as u64;
        } else {
            break;
        }
    }
    let parsed = state.finalize();
    if let Ok(mut map) = cache().lock() {
        // 会话数量有限；超过上限时整体清空，避免长期运行后无界增长。
        if map.len() > 32 {
            map.clear();
        }
        map.insert(
            path.to_path_buf(),
            CachedParse {
                provider: provider.to_string(),
                mtime,
                size,
                parsed_offset: offset,
                state,
                parsed: parsed.clone(),
            },
        );
    }
    Ok(parsed)
}


// ── Antigravity 对话库 gen_metadata 解析（精确会话累计 Token）─────────
// `conversations/<conversation_id>.db` 的 `gen_metadata.data` 为 Protobuf，
// 完整记录主对话、CHECKPOINT 压缩、缓存写入与推理思考 token：
//   data(1).chat -> chat(4).usage (exa.codeium_common_pb.ModelUsageStats):
//     field 2 = input_tokens (未缓存输入)
//     field 3 = output_tokens (= thinking + response)
//     field 4 = cache_write_tokens
//     field 5 = cache_read_tokens
//     field 9 = thinking_output_tokens
//     field 10 = response_output_tokens
//     field 11 = response_id (去重键)
//   data(4) = generation_id (备用去重键)

#[derive(Clone)]
struct CachedGenDb {
    db_stamp: (u64, u64),
    wal_stamp: Option<(u64, u64)>,
    parsed: ParsedUsage,
}

fn gen_db_cache() -> &'static Mutex<HashMap<PathBuf, CachedGenDb>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedGenDb>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

enum PbField<'a> {
    Num(u64),
    Bytes(&'a [u8]),
}

fn pb_read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut value: u64 = 0;
    let mut shift: u32 = 0;
    for _ in 0..10 {
        let &byte = buf.get(*pos)?;
        *pos += 1;
        if shift == 63 && byte > 1 {
            return None;
        }
        value |= ((byte & 0x7f) as u64) << shift;
        if (byte & 0x80) == 0 {
            return Some(value);
        }
        if shift == 63 {
            return None;
        }
        shift += 7;
    }
    None
}

fn pb_field<'a>(buf: &'a [u8], wanted: u64) -> Option<PbField<'a>> {
    let mut pos = 0usize;
    let mut result = None;
    while pos < buf.len() {
        let key = pb_read_varint(buf, &mut pos)?;
        let field_no = key >> 3;
        if field_no == 0 {
            return None;
        }
        let field = match key & 7 {
            0 => PbField::Num(pb_read_varint(buf, &mut pos)?),
            2 => {
                let len = pb_read_varint(buf, &mut pos)? as usize;
                let end = pos.checked_add(len)?;
                if end > buf.len() {
                    return None;
                }
                let slice = &buf[pos..end];
                pos = end;
                PbField::Bytes(slice)
            }
            1 => {
                pos = pos.checked_add(8)?;
                if pos > buf.len() {
                    return None;
                }
                PbField::Num(0)
            }
            5 => {
                pos = pos.checked_add(4)?;
                if pos > buf.len() {
                    return None;
                }
                PbField::Num(0)
            }
            _ => return None,
        };
        if field_no == wanted {
            result = Some(field);
        }
    }
    result
}

fn pb_bytes<'a>(buf: &'a [u8], field_no: u64) -> Option<&'a [u8]> {
    match pb_field(buf, field_no)? {
        PbField::Bytes(bytes) => Some(bytes),
        PbField::Num(_) => None,
    }
}

fn pb_num(buf: &[u8], field_no: u64) -> u64 {
    match pb_field(buf, field_no) {
        Some(PbField::Num(n)) => n,
        _ => 0,
    }
}

fn pb_str(buf: &[u8], field_no: u64) -> Option<String> {
    let bytes = pb_bytes(buf, field_no)?;
    if bytes.is_empty() {
        return None;
    }
    std::str::from_utf8(bytes)
        .ok()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_antigravity_gen_metadata_blob(data: &[u8]) -> Option<(Option<String>, AiTokenUsage)> {
    let chat = pb_bytes(data, 1)?;
    let usage = pb_bytes(chat, 4)?;
    let fresh = pb_num(usage, 2);
    let thinking = pb_num(usage, 9);
    let response_out = pb_num(usage, 10);
    let raw_output = pb_num(usage, 3);
    let output = if raw_output > 0 {
        raw_output
    } else {
        thinking.saturating_add(response_out)
    };
    let cache_write = pb_num(usage, 4);
    let cache_read = pb_num(usage, 5);
    if fresh == 0 && output == 0 && cache_write == 0 && cache_read == 0 {
        return None;
    }
    let total_input = fresh.saturating_add(cache_read).saturating_add(cache_write);
    let dedup_id = pb_str(usage, 11).or_else(|| pb_str(data, 4));
    let tokens = AiTokenUsage {
        input_tokens: Some(total_input),
        output_tokens: Some(output),
        cache_read_input_tokens: Some(cache_read),
        cache_creation_input_tokens: (cache_write > 0).then_some(cache_write),
        reasoning_output_tokens: (thinking > 0).then_some(thinking),
    };
    Some((dedup_id, tokens))
}

fn is_uuid_like(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// 从 `<root>/brain/<conversation_id>/.system_generated/logs/transcript[_full].jsonl`
/// 推导同账号隔离目录下的 `<root>/conversations/<conversation_id>.db`。
fn derive_antigravity_conversation_db(transcript_path: &Path) -> Option<PathBuf> {
    let mut current = transcript_path.parent()?;
    while let Some(parent) = current.parent() {
        if parent.file_name().and_then(|n| n.to_str()) == Some("brain") {
            let conv_id = current.file_name().and_then(|n| n.to_str())?;
            if is_uuid_like(conv_id) {
                let root = parent.parent()?;
                return Some(root.join("conversations").join(format!("{conv_id}.db")));
            }
            return None;
        }
        current = parent;
    }
    None
}

fn is_wal_database(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut hdr = [0u8; 20];
    file.read_exact(&mut hdr).is_ok() && (hdr[18] == 2 || hdr[19] == 2)
}

fn sqlite_immutable_uri(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let mut encoded = String::with_capacity(raw.len() + 24);
    if raw.starts_with('/') {
        encoded.push_str("file://");
    } else {
        encoded.push_str("file:///");
    }
    for ch in raw.chars() {
        match ch {
            '%' => encoded.push_str("%25"),
            '?' => encoded.push_str("%3F"),
            '#' => encoded.push_str("%23"),
            _ => encoded.push(ch),
        }
    }
    encoded.push_str("?immutable=1");
    encoded
}

fn open_readonly_sqlite(path: &Path) -> Option<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = match Connection::open_with_flags(path, flags) {
        Ok(conn) => Some(conn),
        Err(_) => {
            // 已关闭的 WAL 数据库在缺少 -wal/-shm 时，SQLite 只读模式无法创建 -shm；
            // 当 -wal 不存在或为空时，用 immutable=1 只读打开是安全的。
            if !is_wal_database(path) {
                return None;
            }
            let wal_path = PathBuf::from(format!("{}-wal", path.display()));
            if fs::metadata(&wal_path).is_ok_and(|meta| meta.len() > 0) {
                return None;
            }
            let uri = sqlite_immutable_uri(path);
            Connection::open_with_flags(uri, flags | OpenFlags::SQLITE_OPEN_URI).ok()
        }
    }?;
    let _ = conn.busy_timeout(Duration::from_millis(50));
    Some(conn)
}

fn parse_antigravity_conversation_db(db_path: &Path) -> Option<ParsedUsage> {
    if !db_path.is_file() {
        return None;
    }
    let db_stamp = file_stamp(db_path)?;
    let wal_path = PathBuf::from(format!("{}-wal", db_path.display()));
    let wal_stamp = file_stamp(&wal_path);

    if let Ok(map) = gen_db_cache().lock() {
        if let Some(cached) = map.get(db_path) {
            if cached.db_stamp == db_stamp && cached.wal_stamp == wal_stamp {
                return Some(cached.parsed.clone());
            }
        }
    }

    let conn = open_readonly_sqlite(db_path)?;
    let mut stmt = conn
        .prepare("SELECT data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx ASC")
        .ok()?;
    let rows = stmt
        .query_map([], |row| row.get::<_, Vec<u8>>(0))
        .ok()?;

    let mut by_id: HashMap<String, AiTokenUsage> = HashMap::new();
    let mut last_input: Option<u64> = None;
    let mut row_idx: usize = 0;

    for row in rows {
        let Ok(blob) = row else {
            continue;
        };
        if let Some((dedup_id, tokens)) = parse_antigravity_gen_metadata_blob(&blob) {
            if let Some(used) = tokens.input_tokens.filter(|used| *used > 0) {
                last_input = Some(used);
            }
            let key = dedup_id.unwrap_or_else(|| format!("row-{row_idx}"));
            merge_max(by_id.entry(key).or_default(), &tokens);
        }
        row_idx += 1;
    }

    if by_id.is_empty() {
        return None;
    }

    let mut total = AiTokenUsage::default();
    for tokens in by_id.values() {
        total = plus(&total, tokens);
    }

    let parsed = ParsedUsage {
        model: None,
        context_used: last_input,
        context_window: None,
        total,
    };

    if let Ok(mut map) = gen_db_cache().lock() {
        if map.len() > 32 {
            map.clear();
        }
        map.insert(
            db_path.to_path_buf(),
            CachedGenDb {
                db_stamp,
                wal_stamp,
                parsed: parsed.clone(),
            },
        );
    }

    Some(parsed)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// settings 里的上下文窗口与思考强度；env 优先于文件里的 effortLevel。
fn settings_values(value: &Value) -> (Option<u64>, Option<String>) {
    let env = value.get("env");
    let window = env
        .and_then(|env| env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"))
        .and_then(|raw| raw.as_u64().or_else(|| raw.as_str()?.trim().parse().ok()))
        .filter(|window| *window > 0);
    let effort = env
        .and_then(|env| env.get("CLAUDE_CODE_EFFORT_LEVEL"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            value
                .get("effortLevel")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .map(str::to_string);
    (window, effort)
}

/// Claude 配置优先级：项目本地 → 项目共享 → 用户级，先命中的值生效。
fn claude_settings(cwd: Option<&str>) -> (Option<u64>, Option<String>) {
    let mut paths = Vec::new();
    if let Some(cwd) = cwd.filter(|cwd| !cwd.trim().is_empty()) {
        paths.push(Path::new(cwd).join(".claude").join("settings.local.json"));
        paths.push(Path::new(cwd).join(".claude").join("settings.json"));
    }
    if let Ok(dir) = claude_hook_settings::resolve_claude_config_dir(None) {
        paths.push(dir.join("settings.json"));
    }
    let mut window = None;
    let mut effort = None;
    for path in paths {
        let Some(value) = read_json(&path) else { continue };
        let (found_window, found_effort) = settings_values(&value);
        window = window.or(found_window);
        effort = effort.or(found_effort);
    }
    (window, effort)
}

/// 供应商目录里的思考强度：终端启动时无法从命令反查供应商，按模型匹配兜底。
fn catalog_effort(provider: &str, model: Option<&str>) -> Option<String> {
    let model = model?;
    let catalog = ai_catalog_service::catalog().ok()?;
    catalog
        .providers
        .iter()
        .filter(|provider_option| provider_option.agent == provider)
        .flat_map(|provider_option| provider_option.models.iter())
        .find(|option| option.id == model && !option.effort.trim().is_empty())
        .map(|option| option.effort.trim().to_string())
}

/// 没有显式配置时，只对能确定的 Claude 模型给出常见窗口；未知模型不猜，
/// 避免把错误的分母显示成占用率。
fn default_claude_window(model: Option<&str>) -> Option<u64> {
    let model = model?.to_ascii_lowercase();
    if model.contains("[1m]") || model.contains("-1m") {
        return Some(1_000_000);
    }
    if ["claude", "opus", "sonnet", "haiku", "fable", "mythos"]
        .iter()
        .any(|key| model.contains(key))
    {
        return Some(200_000);
    }
    None
}

fn antigravity_model_effort_suffix(model: Option<&str>) -> Option<String> {
    let lower = model?.trim().to_ascii_lowercase();
    for (suffix, level) in [
        ("-xhigh", "xhigh"),
        ("-medium", "medium"),
        ("-high", "high"),
        ("-low", "low"),
        ("-max", "max"),
    ] {
        if lower.ends_with(suffix) {
            return Some(level.to_string());
        }
    }
    None
}

fn resolve_antigravity_effort(launch_effort: Option<&str>, model: Option<&str>) -> Option<String> {
    launch_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| antigravity_model_effort_suffix(model))
}

fn default_antigravity_window(model: Option<&str>, context_used: Option<u64>) -> Option<u64> {
    let lower = model?.to_ascii_lowercase();
    if lower.contains("gemini") {
        return Some(1_000_000);
    }
    if ["claude", "opus", "sonnet", "haiku", "fable", "mythos"]
        .iter()
        .any(|key| lower.contains(key))
    {
        if lower.contains("[1m]")
            || lower.contains("-1m")
            || context_used.is_some_and(|used| used > 200_000)
        {
            return Some(1_000_000);
        }
        return Some(200_000);
    }
    None
}

/// 当前选中终端背后的 Agent 用量；终端尚未绑定 Agent 时返回 None。
pub fn usage(terminal_id: &str) -> Result<Option<TerminalAgentUsage>, String> {
    let launch = llm_provider_service::terminal_launch_config(terminal_id);
    let task_hints = terminal_task_service::launch_hints(terminal_id);
    let Some(location) = terminal_task_service::locate_transcript(terminal_id) else {
        // 绑定已经建立、但 transcript 还没落盘（Claude 首轮对话之前 / Codex 或 agy 刚启动）
        // 或暂时找不到文件时，先用启动配置给状态栏一个快照，避免整条 Agent 信息
        // 在会话最初几秒里消失；用量留空，下一轮轮询会补齐。
        let Some(provider) = terminal_task_service::current_binding(terminal_id)
            .map(|(provider, _)| provider)
            .or_else(|| {
                task_hints
                    .as_ref()
                    .and_then(|hints| hints.provider.clone())
                    .filter(|provider| provider == "antigravity")
            })
        else {
            return Ok(None);
        };
        if provider == "antigravity" {
            let model = task_hints.as_ref().and_then(|hints| hints.model.clone());
            let effort = resolve_antigravity_effort(
                task_hints.as_ref().and_then(|hints| hints.effort.as_deref()),
                model.as_deref(),
            );
            let context_window_tokens = default_antigravity_window(model.as_deref(), None);
            return Ok(Some(TerminalAgentUsage {
                provider,
                model,
                effort,
                context_window_tokens,
                updated_at: chrono::Utc::now().timestamp_millis(),
                ..Default::default()
            }));
        }
        return Ok(Some(TerminalAgentUsage {
            provider,
            model: launch.as_ref().and_then(|config| config.model.clone()),
            effort: launch.as_ref().and_then(|config| config.effort.clone()),
            context_window_tokens: launch.as_ref().and_then(|config| config.context_window),
            updated_at: chrono::Utc::now().timestamp_millis(),
            ..Default::default()
        }));
    };
    let mut parsed = parse_file(&location.path, &location.provider)?;
    let is_antigravity = location.provider == "antigravity";
    if is_antigravity {
        // 对话库 `gen_metadata` 包含完整的 CHECKPOINT 压缩、缓存写入与推理输出统计，
        // 优先作为本会话累计主源；上下文占用仍优先保留主线程 transcript 最新步。
        if let Some(db_path) = derive_antigravity_conversation_db(&location.path) {
            if let Some(db_usage) = parse_antigravity_conversation_db(&db_path) {
                parsed.total = db_usage.total;
                if parsed.context_used.is_none() {
                    parsed.context_used = db_usage.context_used;
                }
            }
        }
    }
    let is_claude = location.provider == "claude";
    let model = parsed.model.clone().or_else(|| {
        if is_antigravity {
            task_hints.as_ref().and_then(|hints| hints.model.clone())
        } else {
            launch.as_ref().and_then(|config| config.model.clone())
        }
    });
    let (settings_window, settings_effort) = if is_claude {
        claude_settings(terminal_task_service::current_cwd(terminal_id).as_deref())
    } else {
        (None, None)
    };
    let effort = if is_antigravity {
        resolve_antigravity_effort(
            task_hints.as_ref().and_then(|hints| hints.effort.as_deref()),
            model.as_deref(),
        )
    } else {
        launch
            .as_ref()
            .and_then(|config| config.effort.clone())
            .or(settings_effort)
            .or_else(|| catalog_effort(&location.provider, model.as_deref()))
    };
    let context_window = if is_antigravity {
        parsed
            .context_window
            .or_else(|| default_antigravity_window(model.as_deref(), parsed.context_used))
    } else {
        parsed
            .context_window
            .or_else(|| launch.as_ref().and_then(|config| config.context_window))
            .or(settings_window)
            .or_else(|| if is_claude { default_claude_window(model.as_deref()) } else { None })
    };
    Ok(Some(TerminalAgentUsage {
        provider: location.provider,
        model,
        effort,
        context_used_tokens: parsed.context_used,
        context_window_tokens: context_window,
        total: parsed.total,
        updated_at: chrono::Utc::now().timestamp_millis(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn jsonl(records: Vec<Value>) -> String {
        records.into_iter().map(|record| record.to_string()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn claude_usage_dedupes_messages_and_keeps_main_thread_context() {
        let content = jsonl(vec![
            json!({"type":"assistant","isSidechain":false,"message":{"id":"a","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":900,"cache_creation_input_tokens":50}}}),
            // 同一消息重复落盘：取高水位而不是累加。
            json!({"type":"assistant","isSidechain":false,"message":{"id":"a","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":12,"cache_read_input_tokens":900,"cache_creation_input_tokens":50}}}),
            json!({"type":"assistant","isSidechain":false,"message":{"id":"b","model":"claude-sonnet-4-5","usage":{"input_tokens":120,"output_tokens":8,"cache_read_input_tokens":1800,"cache_creation_input_tokens":0}}}),
            // 子代理的调用计入累计，但不覆盖主线程上下文与模型。
            json!({"type":"assistant","isSidechain":true,"message":{"id":"c","model":"claude-haiku-4-5","usage":{"input_tokens":30,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}),
        ]);
        let parsed = parse_claude(&content);
        assert_eq!(parsed.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(parsed.context_used, Some(1920));
        assert_eq!(parsed.total.input_tokens, Some(3000));
        assert_eq!(parsed.total.output_tokens, Some(25));
        assert_eq!(parsed.total.cache_read_input_tokens, Some(2700));
        assert_eq!(parsed.total.cache_creation_input_tokens, Some(50));
    }

    #[test]
    fn codex_usage_uses_high_water_totals_and_last_turn_context() {
        let content = jsonl(vec![
            json!({"type":"turn_context","payload":{"model":"gpt-5-codex"}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":10},"last_token_usage":{"input_tokens":40,"output_tokens":5,"total_tokens":45},"model_context_window":258400}}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":200,"output_tokens":25},"last_token_usage":{"input_tokens":60,"output_tokens":5,"total_tokens":65},"model_context_window":258400}}}),
        ]);
        let parsed = parse_codex(&content);
        assert_eq!(parsed.model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(parsed.context_used, Some(65));
        assert_eq!(parsed.context_window, Some(258400));
        assert_eq!(parsed.total.input_tokens, Some(300));
        assert_eq!(parsed.total.output_tokens, Some(25));
        assert_eq!(parsed.total.cache_read_input_tokens, Some(200));
    }

    #[test]
    fn tracked_terminal_transcript_returns_usage_snapshot() {
        let dir = std::env::temp_dir().join(format!("tb-usage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("创建临时目录");
        let session_id = uuid::Uuid::new_v4().to_string();
        let path = dir.join(format!("{session_id}.jsonl"));
        fs::write(&path, jsonl(vec![
            json!({"type":"assistant","isSidechain":false,"message":{"id":"a","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":90,"cache_creation_input_tokens":0}}}),
        ])).expect("写入会话文件");
        let terminal_id = format!("usage-test-{}", uuid::Uuid::new_v4());
        terminal_task_service::prepare_launch(&terminal_id, "bash", None, &[], Vec::new());
        terminal_task_service::record_agent_session(
            &terminal_id,
            "claude",
            &session_id,
            Some(&path.to_string_lossy()),
            true,
        );
        let snapshot = usage(&terminal_id).expect("读取用量").expect("应返回快照");
        terminal_task_service::forget_terminal(&terminal_id);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(snapshot.provider, "claude");
        assert_eq!(snapshot.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(snapshot.context_used_tokens, Some(100));
        assert_eq!(snapshot.total.input_tokens, Some(100));
        assert_eq!(snapshot.total.cache_read_input_tokens, Some(90));
    }

    #[test]
    fn antigravity_usage_sums_fresh_and_cached_and_dedupes_steps() {
        let content = jsonl(vec![
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"hi"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","model":"gemini-3.1-pro-low","input_tokens":100,"cache_read_tokens":900,"output_tokens":20}),
            // 同一步骤重复写入时按字段取高水位，不能重复累加。
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","model":"gemini-3.1-pro-low","input_tokens":100,"cache_read_tokens":900,"output_tokens":25}),
            json!({"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","model":"claude-opus-4-6-thinking","input_tokens":150,"cache_read_tokens":1850,"output_tokens":30}),
        ]);
        let parsed = parse_antigravity(&content);
        assert_eq!(parsed.model.as_deref(), Some("claude-opus-4-6-thinking"));
        assert_eq!(parsed.context_used, Some(2000));
        assert_eq!(parsed.total.input_tokens, Some(3000));
        assert_eq!(parsed.total.output_tokens, Some(55));
        assert_eq!(parsed.total.cache_read_input_tokens, Some(2750));
    }

    #[test]
    fn antigravity_window_and_effort_resolution() {
        assert_eq!(default_antigravity_window(Some("gemini-3.1-pro-high"), None), Some(1_000_000));
        assert_eq!(default_antigravity_window(Some("claude-sonnet-4-6"), Some(50_000)), Some(200_000));
        assert_eq!(default_antigravity_window(Some("claude-opus-4-6-thinking"), Some(250_000)), Some(1_000_000));
        assert_eq!(default_antigravity_window(Some("gpt-oss-120b-medium"), None), None);

        assert_eq!(antigravity_model_effort_suffix(Some("gemini-3.1-pro-high")).as_deref(), Some("high"));
        assert_eq!(antigravity_model_effort_suffix(Some("gpt-oss-120b-medium")).as_deref(), Some("medium"));
        assert_eq!(antigravity_model_effort_suffix(Some("claude-opus-4-6-thinking")), None);

        assert_eq!(
            resolve_antigravity_effort(Some("MAX"), Some("gemini-3.1-pro-low")).as_deref(),
            Some("max")
        );
        assert_eq!(
            resolve_antigravity_effort(None, Some("gemini-3.1-pro-low")).as_deref(),
            Some("low")
        );
        assert_eq!(resolve_antigravity_effort(None, Some("claude-opus-4-6-thinking")), None);
    }

    #[test]
    fn tracked_antigravity_terminal_returns_usage_snapshot() {
        let dir = std::env::temp_dir().join(format!("tb-agy-usage-{}", uuid::Uuid::new_v4()));
        let conv_id = uuid::Uuid::new_v4().to_string();
        let logs_dir = dir.join("brain").join(&conv_id).join(".system_generated").join("logs");
        fs::create_dir_all(&logs_dir).expect("创建临时日志目录");
        fs::write(
            logs_dir.join("transcript_full.jsonl"),
            jsonl(vec![json!({
                "step_index": 1,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "model": "gemini-3.1-pro-high",
                "input_tokens": 15000,
                "cache_read_tokens": 420000,
                "output_tokens": 800
            })]),
        )
        .expect("写入 Antigravity 转录");

        let terminal_id = format!("agy-usage-test-{}", uuid::Uuid::new_v4());
        terminal_task_service::prepare_launch(
            &terminal_id,
            "powershell",
            None,
            &[("ANTIGRAVITY_CLI_HOME".to_string(), dir.to_string_lossy().into_owned())],
            vec![format!(
                "agy --dangerously-skip-permissions --model gemini-3.1-pro-high --effort high --conversation {conv_id}"
            )],
        );
        let snapshot = usage(&terminal_id).expect("读取 Antigravity 用量").expect("应返回快照");
        terminal_task_service::forget_terminal(&terminal_id);
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(snapshot.provider, "antigravity");
        assert_eq!(snapshot.model.as_deref(), Some("gemini-3.1-pro-high"));
        assert_eq!(snapshot.effort.as_deref(), Some("high"));
        assert_eq!(snapshot.context_used_tokens, Some(435_000));
        assert_eq!(snapshot.context_window_tokens, Some(1_000_000));
        assert_eq!(snapshot.total.input_tokens, Some(435_000));
        assert_eq!(snapshot.total.output_tokens, Some(800));
        assert_eq!(snapshot.total.cache_read_input_tokens, Some(420_000));
    }

    #[test]
    fn incremental_parse_file_handles_append_partial_line_and_truncate() {
        let dir = std::env::temp_dir().join(format!("tb-usage-inc-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("创建临时目录");
        let path = dir.join("claude.jsonl");

        let line1 = json!({"type":"assistant","isSidechain":false,"message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":90,"cache_creation_input_tokens":0}}}).to_string();
        let line2 = json!({"type":"assistant","isSidechain":false,"message":{"id":"m2","model":"claude-sonnet-4-5","usage":{"input_tokens":20,"output_tokens":8,"cache_read_input_tokens":180,"cache_creation_input_tokens":0}}}).to_string();
        let split_at = line2.len() / 2;

        // 写入首行与半行（无换行结尾）：应先统计 line1，保留半行到下一轮。
        fs::write(&path, format!("{line1}\n{}", &line2[..split_at])).unwrap();
        let first = parse_file(&path, "claude").unwrap();
        assert_eq!(first.total.input_tokens, Some(100));
        assert_eq!(first.total.output_tokens, Some(5));

        // 补全第二行（无换行结尾同样完整 JSON），再追加噪声行（确保走过预过滤分支）。
        let noise = json!({"type":"user","message":{"role":"user","content":"ping"}}).to_string();
        fs::write(&path, format!("{line1}\n{line2}\n{noise}\n")).unwrap();
        let appended = parse_file(&path, "claude").unwrap();
        let full = parse_claude(&format!("{line1}\n{line2}\n{noise}\n"));
        assert_eq!(appended.total.input_tokens, full.total.input_tokens);
        assert_eq!(appended.total.output_tokens, full.total.output_tokens);
        assert_eq!(appended.context_used, full.context_used);

        // 文件被截断缩小后应重置解析状态。
        fs::write(&path, format!("{line1}\n")).unwrap();
        let truncated = parse_file(&path, "claude").unwrap();
        assert_eq!(truncated.total.input_tokens, Some(100));
        assert_eq!(truncated.total.output_tokens, Some(5));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn antigravity_usage_includes_checkpoint_and_skips_generating() {
        let content = jsonl(vec![
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"GENERATING","model":"gemini-4-neon-xhigh","input_tokens":50,"cache_read_tokens":500,"output_tokens":5}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","model":"gemini-4-neon-xhigh","input_tokens":100,"cache_read_tokens":900,"output_tokens":20}),
            json!({"step_index":2,"source":"SYSTEM","type":"CHECKPOINT","status":"DONE","input_tokens":200,"cache_read_tokens":800,"output_tokens":40}),
        ]);
        let parsed = parse_antigravity(&content);
        assert_eq!(parsed.model.as_deref(), Some("gemini-4-neon-xhigh"));
        // 上下文占用保持主线程 PLANNER_RESPONSE（1000），不被 CHECKPOINT 覆盖。
        assert_eq!(parsed.context_used, Some(1000));
        // 累计总量包含 CHECKPOINT。
        assert_eq!(parsed.total.input_tokens, Some(2000));
        assert_eq!(parsed.total.cache_read_input_tokens, Some(1700));
        assert_eq!(parsed.total.output_tokens, Some(60));
    }

    #[test]
    fn antigravity_gen_metadata_protobuf_parses_all_fields() {
        // 构造一个最小的 protobuf：
        // usage(chat field 4):
        //   field 2 (input_tokens) = 120 (0x10 0x78)
        //   field 3 (output_tokens) = 80 (0x18 0x50)
        //   field 4 (cache_write) = 30 (0x20 0x1e)
        //   field 5 (cache_read) = 1000 (0x28 0xe8 0x07)
        //   field 9 (thinking) = 50 (0x48 0x32)
        //   field 11 (response_id) = "r1" (0x5a 0x02 'r' '1')
        let usage = [0x10u8, 0x78, 0x18, 0x50, 0x20, 0x1e, 0x28, 0xe8, 0x07, 0x48, 0x32, 0x5a, 0x02, b'r', b'1'];
        let mut chat = vec![0x22u8, usage.len() as u8];
        chat.extend_from_slice(&usage);
        let mut root = vec![0x0au8, chat.len() as u8];
        root.extend_from_slice(&chat);

        let (dedup_id, tokens) = parse_antigravity_gen_metadata_blob(&root).expect("应成功解析");
        assert_eq!(dedup_id.as_deref(), Some("r1"));
        assert_eq!(tokens.input_tokens, Some(1150)); // 120 + 1000 + 30
        assert_eq!(tokens.output_tokens, Some(80));
        assert_eq!(tokens.cache_read_input_tokens, Some(1000));
        assert_eq!(tokens.cache_creation_input_tokens, Some(30));
        assert_eq!(tokens.reasoning_output_tokens, Some(50));
    }

    #[test]
    fn derive_antigravity_conversation_db_maps_isolated_profile_path() {
        let conv_id = "12345678-abcd-ef01-2345-6789abcdef01";
        let transcript = PathBuf::from(format!(
            "/data/antigravity-profiles/us/.gemini/antigravity-cli/brain/{conv_id}/.system_generated/logs/transcript_full.jsonl"
        ));
        let expected = PathBuf::from(format!(
            "/data/antigravity-profiles/us/.gemini/antigravity-cli/conversations/{conv_id}.db"
        ));
        assert_eq!(derive_antigravity_conversation_db(&transcript), Some(expected));
    }
}
