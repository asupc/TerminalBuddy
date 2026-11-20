//! 终端 Agent 会话接力（relay）：把桌面/服务端终端里正在运行的 Claude / Codex
//! 会话镜像成只读聊天气泡，并提供受限的多行回复注入（括号粘贴，整段插入后回车提交）。
//!
//! 设计依据：docs/specs/2026-11-01--terminal-agent-chat-relay.md。要点：
//! - 只读转录文件、只写 PTY 输入；不碰 SQLite、不碰 settings.json；
//! - 发现链固定为：可见终端 → PID → `terminal_task_service::summaries`（补写 transcript）
//!   → `session_bindings()`，顺序不能反，且不受 `showTaskSummary` 开关控制；
//! - 镜像同步不假定解析器 seq 稳定：完整消息比较 + revision 代次，任何旧消息变化、
//!   Codex 去重重排都发完整尾页（rotated），不做原地 patch；
//! - 回复七闸门 + 每终端串行临界区 + requestId 幂等，PTY 写失败结果未知、不自动重试；
//! - 订阅是带身份与唯一 subscriptionId 的租约，watcher 全终端唯一，零租约 30 秒后停止。

use crate::commands::TerminalService;
use crate::models::session_history::SessionReplayMessage;
use crate::models::{TerminalAction, TerminalActor};
use crate::runtime::{AppHandle, Emitter, Manager};
use crate::services::claude_session_registry_service::AgentSessionRecord;
use crate::services::terminal_task_service::{self, TerminalTaskSummary};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ───────────────────────── 首版常量（集中定义，客户端不硬编码） ─────────────────────────

/// watcher 轮询周期。
const WATCH_TICK: Duration = Duration::from_secs(1);
/// 最后一个租约释放后 watcher 的停留窗口。
const WATCHER_LINGER: Duration = Duration::from_secs(30);
/// 完整进程扫描（/proc + 目录定位）结果的 TTL；watcher tick 与各调用方共用。
const SCAN_CACHE_TTL: Duration = Duration::from_secs(2);
/// 定位转录失败（找不到文件）的负缓存 TTL。
const LOCATE_NEGATIVE_TTL: Duration = Duration::from_secs(2);
/// hook 上报 running 之后，jsonl 尚未落盘的起始宽限期：UserPromptSubmit 先于文件写入，
/// 宽限期内找不到转录仍按空镜像处理，避免新会话首帧闪一下「读取失败」。
const TRANSCRIPT_START_GRACE_MS: i64 = 10_000;
/// 镜像缓存条目无人访问后的清理时间。
const MIRROR_IDLE_EVICT: Duration = Duration::from_secs(30 * 60);
/// 超过该大小的转录直接判定 `transcript_too_large`，不做大字符串分配。
const FILE_TOO_LARGE_BYTES: u64 = 128 * 1024 * 1024;
/// 完整解析超过该体量（或消息条数超限）时只保留尾部窗口。
const TRUNCATE_PARSE_BYTES: usize = 32 * 1024 * 1024;
/// 触发尾部截断保留的最大完整解析消息数。
const MAX_PARSE_MESSAGES: usize = 5000;
/// 截断后保留的尾部窗口大小。
const RETAIN_TAIL: usize = 500;
/// 消息页缺省条数。
pub const DEFAULT_PAGE_LIMIT: usize = 200;
/// 消息页上限。
pub const MAX_PAGE_LIMIT: usize = 500;
/// afterSeq 的最小值（无消息时的游标哨兵）。
pub const MIN_AFTER_SEQ: i64 = -1;
/// 单次 append 推送的消息上限，超过则改发完整 mirror 快照。
const MAX_APPEND_MESSAGES: usize = 200;
/// 回复文本的最大 Unicode 字符数。
const REPLY_MAX_CHARS: usize = 2000;
/// 同终端两次成功回复的最小间隔。
const REPLY_COOLDOWN: Duration = Duration::from_secs(3);
/// 文本与提交回车之间的停顿：让 TUI 结束「粘贴 / 批量输入」判定窗口。
/// 文本与 "\r" 同一次到达时（尤其长文本），Claude Code 的输入框会把整块
/// 当作粘贴批量插入，回车被并入粘贴内容，消息停在输入框里不提交。
const REPLY_SUBMIT_DELAY: Duration = Duration::from_millis(150);
/// 写入失败（结果未知）标记的保留时间，用于诊断与防重复试探。
const REPLY_FAILURE_TTL: Duration = Duration::from_secs(30);
/// requestId 幂等记录 TTL。
const REQUEST_ID_TTL: Duration = Duration::from_secs(5 * 60);
/// requestId 幂等记录条数上限。
const REQUEST_ID_CAP: usize = 500;
/// 阶段表保留时长。
const PHASE_RETAIN: Duration = Duration::from_secs(24 * 60 * 60);
/// 阶段表条数上限（按最近使用淘汰）。
const PHASE_CAP: usize = 500;
/// idle / completed / failed 阶段允许回复的最大龄期（毫秒）。
const IDLE_PHASE_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
/// 每终端出站帧队列上限（WS 慢消费者溢出即断开）。
const OUTBOUND_QUEUE: usize = 64;
/// 事件租约（桌面 React / 浏览器事件通道）的续租周期上限，超时未续租即释放。
const LEASE_TTL: Duration = Duration::from_secs(30);

/// 桌面 React / 浏览器事件通道的事件名（watcher 经 `crate::runtime::Emitter` 双通道推送）。
pub const AGENT_UPDATE_EVENT: &str = "terminal-agent-update";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

// ───────────────────────── 对外数据模型（camelCase 序列化） ─────────────────────────

/// 镜像可用性。`reason` 是服务端定义的机器码（transcript_unreadable / transcript_too_large），
/// 客户端据此显示引导文案。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 列表 / 首帧 / 状态更新共用的会话元数据。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentSession {
    pub terminal_id: String,
    pub profile_name: String,
    pub terminal_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    pub provider: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// attention / running / idle / completed / failed / ended / unknown
    /// （unknown 仅作为兜底：阶段表无记录时按镜像推断为 running / idle）
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_decision_id: Option<String>,
    pub pending_decision_count: usize,
    pub can_reply: bool,
    /// 不可回复时可直接显示的中文原因；可回复为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_blocked_reason: Option<String>,
    /// 镜像重建代次（进程内单调递增；客户端只比较是否相等）。
    pub revision: u64,
    pub mirror: MirrorStatus,
}

/// 消息页：快照与重连补偿共用同一响应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentPage {
    pub session: TerminalAgentSession,
    pub messages: Vec<SessionReplayMessage>,
    /// 本页最后一条的 seq；无消息时为 -1，不是消息条数或 total。
    pub cursor: i64,
    /// 本次完整解析得到的展示消息数（截断前）。
    pub total: i64,
    /// 服务端只保留尾部窗口时为 true。
    pub truncated: bool,
    /// 增量请求是否还有下一页；快照页恒为 false。
    pub has_more: bool,
    pub next_cursor: i64,
    /// 保留窗口中最小 seq；无消息为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_retained_seq: Option<i64>,
    /// true 时客户端必须清空本地并整体采用本页。
    pub reset_required: bool,
}

/// 推送帧：mirror / append / status / rotated / unavailable / error。
/// 用扁平结构而非 enum，让 Android（手动解析）最简单；
/// 所有帧都含 terminalId，判别字段是 `type`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentFrame {
    pub r#type: String,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<Box<TerminalAgentSession>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<SessionReplayMessage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_retained_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 事件通道（terminal-agent-update）附带：本帧发往的仍有效的租约；
    /// WS 直发帧不填。桌面 / 浏览器按自己的 subscriptionId 过滤。
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub subscription_ids: Vec<String>,
}

impl TerminalAgentFrame {
    fn content(kind: &str, terminal_id: &str, session: TerminalAgentSession, core: &TailCore) -> Self {
        Self {
            r#type: kind.to_string(),
            terminal_id: terminal_id.to_string(),
            session: Some(Box::new(session)),
            messages: Some(core.messages.clone()),
            revision: Some(core.revision),
            cursor: Some(core.cursor),
            total: Some(core.total),
            truncated: Some(core.truncated),
            has_more: Some(core.has_more),
            next_cursor: Some(core.next_cursor),
            oldest_retained_seq: core.oldest_retained_seq,
            reason: None,
            code: None,
            message: None,
            subscription_ids: Vec::new(),
        }
    }

    /// 同 revision 纯尾部新增。
    fn append(terminal_id: &str, revision: u64, tail: Vec<SessionReplayMessage>, total: i64, truncated: bool) -> Self {
        let cursor = tail.last().map(|message| message.seq).unwrap_or(-1);
        Self {
            r#type: "append".to_string(),
            terminal_id: terminal_id.to_string(),
            session: None,
            messages: Some(tail),
            revision: Some(revision),
            cursor: Some(cursor),
            total: Some(total),
            truncated: Some(truncated),
            has_more: Some(false),
            next_cursor: Some(cursor),
            oldest_retained_seq: None,
            reason: None,
            code: None,
            message: None,
            subscription_ids: Vec::new(),
        }
    }

    fn status(terminal_id: &str, session: TerminalAgentSession) -> Self {
        Self {
            r#type: "status".to_string(),
            terminal_id: terminal_id.to_string(),
            session: Some(Box::new(session)),
            messages: None,
            revision: None,
            cursor: None,
            total: None,
            truncated: None,
            has_more: None,
            next_cursor: None,
            oldest_retained_seq: None,
            reason: None,
            code: None,
            message: None,
            subscription_ids: Vec::new(),
        }
    }

    fn unavailable(terminal_id: &str, session: TerminalAgentSession) -> Self {
        let reason = session.mirror.reason.clone();
        Self {
            r#type: "unavailable".to_string(),
            terminal_id: terminal_id.to_string(),
            session: Some(Box::new(session)),
            messages: Some(Vec::new()),
            revision: None,
            cursor: None,
            total: None,
            truncated: None,
            has_more: None,
            next_cursor: None,
            oldest_retained_seq: None,
            reason,
            code: None,
            message: None,
            subscription_ids: Vec::new(),
        }
    }

    pub fn error(terminal_id: &str, code: &str, message: &str) -> Self {
        Self {
            r#type: "error".to_string(),
            terminal_id: terminal_id.to_string(),
            session: None,
            messages: None,
            revision: None,
            cursor: None,
            total: None,
            truncated: None,
            has_more: None,
            next_cursor: None,
            oldest_retained_seq: None,
            reason: None,
            code: Some(code.to_string()),
            message: Some(message.to_string()),
            subscription_ids: Vec::new(),
        }
    }
}

/// 回复写入结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyOutcome {
    pub accepted: bool,
    pub duplicated: bool,
    pub phase: String,
    pub at: i64,
}

/// `terminal_agent_subscribe` / WS 握手 `subscribe` 的返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeOutcome {
    pub subscription_id: String,
    pub initial_frame: TerminalAgentFrame,
}

/// `terminal_agent_heartbeat` 的单项与返回。
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatLease {
    pub terminal_id: String,
    pub subscription_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatOutcome {
    pub alive: Vec<HeartbeatLease>,
}

// ───────────────────────── 错误模型 ─────────────────────────

/// relay 业务错误：REST 映射为 `ApiError`，不允许把 404 / 403 / 409 / 429 统一降级成 400。
#[derive(Debug, Clone)]
pub enum RelayError {
    BadRequest(String),
    NotFound(String),
    Forbidden(String),
    /// 回复闸门失败（409），可附带 decisionId / replyBlockedReason。
    Conflict {
        message: String,
        decision_id: Option<String>,
        reply_blocked_reason: Option<String>,
    },
    TooManyRequests {
        message: String,
        retry_after_secs: u64,
    },
    Internal(String),
}

impl RelayError {
    /// Tauri 命令侧的机器码（§4.8）。
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadRequest(_) => "bad_request",
            Self::NotFound(_) => "not_found",
            Self::Forbidden(_) => "forbidden",
            Self::Conflict { .. } => "conflict",
            Self::TooManyRequests { .. } => "too_many_requests",
            Self::Internal(_) => "internal",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::BadRequest(message)
            | Self::NotFound(message)
            | Self::Forbidden(message)
            | Self::Internal(message) => message.clone(),
            Self::Conflict { message, .. } | Self::TooManyRequests { message, .. } => message.clone(),
        }
    }

    pub fn decision_id(&self) -> Option<String> {
        match self {
            Self::Conflict { decision_id, .. } => decision_id.clone(),
            _ => None,
        }
    }

    pub fn reply_blocked_reason(&self) -> Option<String> {
        match self {
            Self::Conflict { reply_blocked_reason, .. } => reply_blocked_reason.clone(),
            _ => None,
        }
    }

    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            Self::TooManyRequests { retry_after_secs, .. } => Some(*retry_after_secs),
            _ => None,
        }
    }
}

/// 终端路径参数只允许现有 ID 字符集，非法一律 400，不拼文件路径、不执行 shell。
pub fn valid_terminal_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn access_error(error: crate::models::TerminalAccessError) -> RelayError {
    match error {
        crate::models::TerminalAccessError::NotFound => RelayError::NotFound("终端不存在或已关闭".to_string()),
        crate::models::TerminalAccessError::Denied { .. } => {
            RelayError::Forbidden(error.to_string())
        }
    }
}

// ───────────────────────── 纯函数：回复闸门（可单测，不依赖 PTY / AppHandle） ─────────────────────────

/// 文本规则（§4.6 第 5 条）：trim 后非空、≤2000 个 Unicode 字符、不以 / ! @ # 开头、
/// 除换行（\n，多行草稿）外不含任何控制字符（C0/DEL/Unicode 控制区，覆盖 \r \t \x03 ESC DEL）。
/// 换行由注入层用括号粘贴包住，避免每一行都被当成一次提交。
/// trim 只用于校验，实际注入保留用户原始非控制字符文本。
pub(crate) fn validate_reply_text(text: &str) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("回复内容不能为空".to_string());
    }
    if text.chars().count() > REPLY_MAX_CHARS {
        return Err(format!("回复不能超过 {} 个字符", REPLY_MAX_CHARS));
    }
    if let Some(first) = trimmed.chars().next() {
        if matches!(first, '/' | '!' | '@' | '#') {
            return Err("暂不支持斜杠命令与 !、@、# 开头的输入，请回到终端操作".to_string());
        }
    }
    if let Some(control) = text.chars().find(|character| *character != '\n' && character.is_control()) {
        return Err(format!("回复不能包含换行以外的控制字符（如 Tab、Ctrl 组合键，检测到 U+{:04X}）", control as u32));
    }
    Ok(())
}

/// 构造写往 PTY 的文本载荷（**不含**提交回车）：
/// - 单行直接写原文；
/// - 多行用括号粘贴（`ESC[200~ … ESC[201~`）作为一个整体插入输入框，
///   避免换行被 TUI 当成逐行回车。
///
/// 提交回车必须由调用方在 `REPLY_SUBMIT_DELAY` 停顿后**单独**写入。
/// PTY 一次写入的长文本会被 Ink 输入框判定为粘贴批量输入，紧随其后的
/// `"\r"` 会被并入粘贴内容，表现为「文字进了输入框但没有发送」。
pub(crate) fn reply_payload(text: &str) -> String {
    if text.contains('\n') {
        format!("\x1b[200~{text}\x1b[201~")
    } else {
        text.to_string()
    }
}

/// requestId 必须是 8–64 位 ASCII 字母 / 数字 / `-` / `_`。
pub(crate) fn valid_request_id(request_id: &str) -> bool {
    (8..=64).contains(&request_id.len())
        && request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

/// 「agent 仍在」判定（§4.6 第 7 条存活表）。
/// unknown 及未来新增值一律放行：会话出现在列表里即表示发现链（进程扫描）确认了
/// agent 进程仍在该终端里运行——无 Hook 上报（Codex / 手动启动 / 服务重启后）
/// 不再作为禁回理由。idle 的 24 小时闲置判定只在 Hook 上报过真实时间戳时生效；
/// 推断路径（无时间戳）视为此刻存活。
pub(crate) fn phase_allows_reply(phase: &str, phase_at: Option<i64>, now_ms: i64) -> Result<(), String> {
    match phase {
        "running" => Ok(()),
        // attention 由第 3 条闸门单独区分原因，这里兜底拒绝。
        "attention" => Err("Agent 正在等待确认，请先处理待决策问题或打开终端".to_string()),
        "idle" | "completed" | "failed" => {
            let Some(at) = phase_at else { return Ok(()) };
            if now_ms.saturating_sub(at) <= IDLE_PHASE_MAX_AGE_MS {
                Ok(())
            } else {
                Err("会话已闲置超过 24 小时，无法确认 Agent 仍在终端前台，已禁止回复".to_string())
            }
        }
        "ended" => Err("会话已结束，输入会落入 shell；如需继续请使用历史会话恢复".to_string()),
        _ => Ok(()),
    }
}

/// 阶段表无记录时按镜像尾条推断阶段（「绑定存在即进程存活」的同步状态）：
/// 最后一条是用户消息 → running（Agent 正在处理），否则 → idle（等待输入）。
/// phaseAt 取尾条时间戳，缺失时用转录文件 mtime；两者皆无为 None（视为存活）。
/// 推断值不写入阶段表：每次构建元数据时基于最新镜像重算，Hook 恢复上报后自动被真实值取代。
fn inferred_phase(entry: Option<&MirrorEntry>) -> (String, Option<i64>) {
    let Some(entry) = entry.filter(|entry| entry.available) else {
        return ("idle".to_string(), None);
    };
    if let Some(end) = entry.turn_end { return (end.phase().to_string(), Some(end.at())); }
    let last = entry.messages.last();
    let phase = if last.is_some_and(|message| message.role == "user") { "running" } else { "idle" };
    let at = last
        .and_then(|message| message.timestamp)
        .or_else(|| entry.file_stamp.map(|(mtime, _)| mtime.duration_since(UNIX_EPOCH).ok().map(|value| value.as_millis() as i64)).flatten());
    (phase.to_string(), at)
}

/// 列表页的 canReply（§4.2 第 6 条）：复用第 1/2/3/7 条闸门，不检查文本、requestId 与频率。
pub(crate) fn evaluate_can_reply(
    input_allowed: bool,
    denied_message: Option<String>,
    phase: &str,
    phase_at: Option<i64>,
    pending_count: usize,
    now_ms: i64,
) -> (bool, Option<String>) {
    if !input_allowed {
        return (false, denied_message.or_else(|| Some("当前无权向该终端输入".to_string())));
    }
    if pending_count > 0 {
        return (false, Some(format!("有 {pending_count} 项待确认的决策，请先处理后再回复")));
    }
    if let Err(reason) = phase_allows_reply(phase, phase_at, now_ms) {
        return (false, Some(reason));
    }
    (true, None)
}

// ───────────────────────── 纯函数：快照 diff 与分页 ─────────────────────────

/// 镜像基线（diff / 分页的输入视图；生产上由 MirrorEntry 提供，测试可直接构造）。
#[derive(Debug, Clone, Default)]
pub(crate) struct MirrorBaseline {
    pub messages: Vec<SessionReplayMessage>,
    pub total: i64,
    pub truncated: bool,
}

/// 与旧基线比较的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ContentDiff {
    Unchanged,
    /// 同 revision 纯尾部新增。
    Append,
    /// 同 revision 整页刷新（截断窗口滑动）。
    Mirror,
    /// 旧消息变化 / 重排：revision + 1 全量重建。
    Rotated,
}

/// 完整消息比较 + 追加判定（§4.3）。
/// 任何旧 seq 的完整内容变化、同 seq 重复、旧消息消失、total 变小、Codex 去重重排
/// 都判 Rotated；已截断的基线不再做 append（窗口会滑动）。
pub(crate) fn diff_content(
    old: &MirrorBaseline,
    new_messages: &[SessionReplayMessage],
    new_total: i64,
    new_truncated: bool,
) -> ContentDiff {
    // total 变小（Codex 去重把 event 收编等）一定 rotated。
    if new_total < old.total {
        return ContentDiff::Rotated;
    }
    if old.truncated {
        if !new_truncated {
            // 服务端窗口从截断恢复为完整（文件重写变小）：无法验证前缀，全量重建。
            return ContentDiff::Rotated;
        }
        if old.messages.as_slice() == new_messages {
            return ContentDiff::Unchanged;
        }
        // 窗口滑动：同 revision 发完整尾页，客户端整体采用，不伪造 append。
        return ContentDiff::Mirror;
    }
    let old_len = old.messages.len();
    if new_messages.len() >= old_len && old.messages.as_slice() == &new_messages[..old_len] {
        if new_messages.len() == old_len {
            ContentDiff::Unchanged
        } else {
            ContentDiff::Append
        }
    } else {
        ContentDiff::Rotated
    }
}

/// 尾页/增量切片的公共字段。
#[derive(Debug, Clone)]
pub(crate) struct TailCore {
    pub messages: Vec<SessionReplayMessage>,
    pub revision: u64,
    pub cursor: i64,
    pub total: i64,
    pub truncated: bool,
    pub has_more: bool,
    pub next_cursor: i64,
    pub oldest_retained_seq: Option<i64>,
}

impl TailCore {
    /// 当前 revision 的完整尾页（快照 / 重建 / 首帧共用）。
    pub(crate) fn tail(baseline: &MirrorBaseline, revision: u64, limit: usize) -> Self {
        let limit = limit.clamp(1, RETAIN_TAIL);
        let start = baseline.messages.len().saturating_sub(limit);
        let messages = baseline.messages[start..].to_vec();
        let cursor = messages.last().map(|message| message.seq).unwrap_or(-1);
        Self {
            oldest_retained_seq: baseline.messages.first().map(|message| message.seq),
            cursor,
            has_more: false,
            next_cursor: cursor,
            messages,
            revision,
            total: baseline.total,
            truncated: baseline.truncated,
        }
    }

    /// 增量切片：按 seq 升序取最早的 limit 条 seq > after 的消息。
    /// `reset_required` 为 true 时返回完整尾页（调用方置位）。
    pub(crate) fn incremental(baseline: &MirrorBaseline, revision: u64, after: i64, limit: usize) -> Self {
        let limit = limit.clamp(1, MAX_PAGE_LIMIT);
        let first = baseline.messages.partition_point(|message| message.seq <= after);
        let end = (first + limit).min(baseline.messages.len());
        let messages = baseline.messages[first..end].to_vec();
        let has_more = end < baseline.messages.len();
        let cursor = messages.last().map(|message| message.seq).unwrap_or(after.max(-1));
        Self {
            oldest_retained_seq: baseline.messages.first().map(|message| message.seq),
            messages,
            revision,
            cursor,
            has_more,
            next_cursor: cursor,
            total: baseline.total,
            truncated: baseline.truncated,
        }
    }
}

/// 判定增量请求是否必须 reset（§4.4）：revision 不同、或截断窗口已越过请求游标。
pub(crate) fn incremental_requires_reset(
    baseline: &MirrorBaseline,
    revision: u64,
    after_seq: i64,
    request_revision: Option<u64>,
) -> bool {
    if request_revision != Some(revision) {
        return true;
    }
    if baseline.truncated {
        if let Some(oldest) = baseline.messages.first().map(|message| message.seq) {
            return after_seq < oldest;
        }
    }
    false
}

// ───────────────────────── 阶段表（内存态，键 = terminalId + provider + sessionId） ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct PhaseKey {
    pub terminal_id: String,
    pub provider: String,
    pub session_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PhaseEntry {
    pub phase: String,
    pub occurred_at: i64,
    pub last_seen: Instant,
    /// Stop 已确认仍有真实后台工作时，不用前台回合结束记录提前结算。
    pub background_pending: bool,
    /// Claude 用户提示词的回合标识；工具心跳不能启动或切换用户回合。
    prompt_id: Option<String>,
    /// 最新一次 UserPromptSubmit 的时间，区别于工具心跳的到达时间。
    prompt_started_at: Option<i64>,
}

/// 阶段表：允许每终端多代次留存；至少保留 24 小时、上限 500 条并按最近使用淘汰。
#[derive(Default)]
pub(crate) struct PhaseTable {
    entries: HashMap<PhaseKey, PhaseEntry>,
}

impl PhaseTable {
    pub fn note(&mut self, key: PhaseKey, phase: &str, occurred_at: i64) {
        let entry = self.entries.get_mut(&key);
        match entry {
            Some(existing) => {
                existing.phase = phase.to_string();
                existing.occurred_at = occurred_at;
                existing.last_seen = Instant::now();
                if phase != "running" { existing.background_pending = false; }
            }
            None => {
                self.entries.insert(
                    key,
                    PhaseEntry {
                        phase: phase.to_string(),
                        occurred_at,
                        last_seen: Instant::now(),
                        background_pending: false,
                        prompt_id: None,
                        prompt_started_at: None,
                    },
                );
            }
        }
        self.prune();
    }

    /// 回合开始由 UserPromptSubmit 确认；迟到的工具 / 通知不能重新点亮已结算的回合。
    fn note_claude_hook(
        &mut self, key: PhaseKey, event_name: &str, prompt_id: Option<&str>, phase: &str, occurred_at: i64,
    ) -> bool {
        let prompt_id = prompt_id.filter(|id| !id.is_empty());
        let current = self.entries.get(&key);
        let settled = current.is_some_and(|entry| {
            matches!(entry.phase.as_str(), "completed" | "failed" | "ended")
                || (entry.phase == "idle" && entry.prompt_started_at.is_some())
        });
        let new_prompt = event_name == "UserPromptSubmit";
        if event_name != "SessionStart" {
            if !new_prompt {
                if matches!(phase, "running" | "attention") && settled { return false; }
                if current.and_then(|entry| entry.prompt_id.as_deref()).zip(prompt_id)
                    .is_some_and(|(active, incoming)| active != incoming) { return false; }
            } else if current.filter(|entry| entry.prompt_started_at.is_some())
                .and_then(|entry| entry.prompt_id.as_deref()).zip(prompt_id)
                .is_some_and(|(active, incoming)| active == incoming) {
                // 同一提示词的重复提交事件不能改变回合开始时间或覆盖完成状态。
                return false;
            }
        }
        self.note(key.clone(), phase, occurred_at);
        let entry = self.entries.get_mut(&key).expect("刚写入的回合状态必须存在");
        if event_name == "SessionStart" {
            entry.prompt_id = prompt_id.map(str::to_string);
            entry.prompt_started_at = None;
        } else if new_prompt {
            entry.prompt_id = prompt_id.map(str::to_string);
            entry.prompt_started_at = Some(occurred_at);
        } else if entry.prompt_id.is_none() {
            entry.prompt_id = prompt_id.map(str::to_string);
        }
        true
    }

    /// 审批结束等场景：已 ended（或换绑后键不匹配）则不覆盖。
    pub fn note_unless_ended(&mut self, key: &PhaseKey, phase: &str, occurred_at: i64) {
        if self.entries.get(key).is_some_and(|existing| existing.phase == "ended") {
            return;
        }
        self.note(key.clone(), phase, occurred_at);
    }

    pub fn current(&self, terminal_id: &str, provider: &str, session_id: &str) -> Option<(String, i64)> {
        self.entries
            .get(&PhaseKey {
                terminal_id: terminal_id.to_string(),
                provider: provider.to_string(),
                session_id: session_id.to_string(),
            })
            .map(|entry| (entry.phase.clone(), entry.occurred_at))
    }

    /// 只结算早于结束记录的活动回合；用户中断还会解除 attention 和旧后台等待标记。
    fn settle_from_transcript(&mut self, key: &PhaseKey, end: ClaudeTurnEnd) -> bool {
        let Some(entry) = self.entries.get_mut(key) else { return false; };
        let interrupted = matches!(end, ClaudeTurnEnd::Interrupted(_));
        if (entry.phase != "running" && !(interrupted && entry.phase == "attention"))
            || (!interrupted && entry.background_pending)
            || end.at() <= entry.prompt_started_at.unwrap_or(entry.occurred_at) {
            return false;
        }
        entry.phase = end.phase().to_string();
        // 结算依据是用户回合开始时间；广播时间仍须晚于迟到心跳，前端才会接受纠正。
        entry.occurred_at = end.at().max(entry.occurred_at.saturating_add(1));
        entry.background_pending = false;
        entry.last_seen = Instant::now();
        true
    }

    pub fn prune_expired(&mut self) {
        let cutoff = Instant::now() - PHASE_RETAIN;
        self.entries.retain(|_, entry| entry.last_seen >= cutoff);
        if self.entries.len() > PHASE_CAP {
            let mut keys: Vec<PhaseKey> = self.entries.keys().cloned().collect();
            keys.sort_by_key(|key| std::cmp::Reverse(self.entries[key].last_seen));
            for key in keys.into_iter().skip(PHASE_CAP) {
                self.entries.remove(&key);
            }
        }
    }

    fn prune(&mut self) {
        if self.entries.len() > PHASE_CAP * 2 {
            self.prune_expired();
        }
    }

    fn remove_terminal(&mut self, terminal_id: &str) {
        self.entries.retain(|key, _| key.terminal_id != terminal_id);
    }
}

// ───────────────────────── requestId 幂等表 ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct RequestKey {
    /// 区分 Pc / Web：同一 requestId 在两侧是不同的幂等域。
    pub actor_web: bool,
    pub terminal_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LedgerStatus {
    /// 写入成功；TTL 内同键同文本重放返回 duplicated=true。
    Completed,
    /// 写入结果未知；30 秒内同键重放返回同一未知结果，不自动重试。
    Unknown,
}

#[derive(Debug, Clone)]
pub(crate) struct LedgerEntry {
    pub normalized_text: String,
    pub status: LedgerStatus,
    pub at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LedgerCheck {
    Fresh,
    Duplicated,
    /// 同键不同文本。
    Mismatch,
}

/// requestId 幂等表：TTL 5 分钟、上限 500 条，按插入时间淘汰。
#[derive(Default)]
pub(crate) struct ReplyLedger {
    entries: HashMap<RequestKey, LedgerEntry>,
}

impl ReplyLedger {
    pub fn check(&self, key: &RequestKey, normalized_text: &str) -> LedgerCheck {
        match self.entries.get(key) {
            Some(entry) if entry.normalized_text == normalized_text => LedgerCheck::Duplicated,
            Some(_) => LedgerCheck::Mismatch,
            None => LedgerCheck::Fresh,
            }
    }

    pub fn record(&mut self, key: RequestKey, normalized_text: &str, status: LedgerStatus) {
        self.entries.insert(
            key,
            LedgerEntry {
                normalized_text: normalized_text.to_string(),
                status,
                at: Instant::now(),
            },
        );
        self.prune();
    }

    pub fn status_of(&self, key: &RequestKey) -> Option<LedgerStatus> {
        self.entries.get(key).map(|entry| entry.status)
    }

    fn prune(&mut self) {
        let now = Instant::now();
        self.entries.retain(|_, entry| {
            let ttl = match entry.status {
                LedgerStatus::Completed => REQUEST_ID_TTL,
                LedgerStatus::Unknown => REPLY_FAILURE_TTL,
            };
            now - entry.at < ttl
        });
        if self.entries.len() > REQUEST_ID_CAP {
            let mut keys: Vec<RequestKey> = self.entries.keys().cloned().collect();
            keys.sort_by_key(|key| self.entries[key].at);
            for key in keys.into_iter().take(self.entries.len().saturating_sub(REQUEST_ID_CAP)) {
                self.entries.remove(&key);
            }
        }
    }

    fn remove_terminal(&mut self, terminal_id: &str) {
        self.entries.retain(|key, _| key.terminal_id != terminal_id);
    }
}

// ───────────────────────── 全局状态 ─────────────────────────

/// 镜像缓存条目：`messages` 是当前 revision 的基线（仅在超大阈值下裁剪为尾部窗口）。
#[derive(Clone)]
struct MirrorEntry {
    provider: String,
    session_id: String,
    path: Option<PathBuf>,
    revision: u64,
    available: bool,
    reason: Option<String>,
    messages: Vec<SessionReplayMessage>,
    total: i64,
    truncated: bool,
    file_stamp: Option<(SystemTime, u64)>,
    /// 主会话最后一个正常结束或被用户中断的回合；后续输入或模型请求会清空。
    turn_end: Option<ClaudeTurnEnd>,
    last_access: Instant,
}

impl MirrorEntry {
    fn baseline(&self) -> MirrorBaseline {
        MirrorBaseline {
            messages: self.messages.clone(),
            total: self.total,
            truncated: self.truncated,
        }
    }

    fn identity(&self) -> (String, String) {
        (self.provider.clone(), self.session_id.clone())
    }
}

#[derive(Clone)]
struct Lease {
    actor: TerminalActor,
    /// Socket：Android / 浏览器 WS 订阅，连接结束由 RAII 释放，不按租约超时回收；
    /// Event：桌面 React / 浏览器事件通道租约，30 秒未续租即释放。
    kind: &'static str,
    /// WS 订阅由连接生命周期管理（None）；事件租约到期即回收。
    sender: Option<tokio::sync::mpsc::Sender<TerminalAgentFrame>>,
    expires: Option<Instant>,
}

struct WatcherHandle {
    leases: HashMap<String, Lease>,
    /// 每个身份最近一次下发的会话元数据（判定 status 帧是否需要发送）。
    last_meta: HashMap<TerminalActor, TerminalAgentSession>,
    linger_since: Option<Instant>,
}

#[derive(Default)]
struct RelayState {
    mirrors: HashMap<String, MirrorEntry>,
    phases: PhaseTable,
    ledger: ReplyLedger,
    /// 同终端两次成功回复的时间（monotonic，避免时钟回拨绕过限流）。
    rate: HashMap<String, Instant>,
    watchers: HashMap<String, WatcherHandle>,
    /// Hook 驱动的活动监测独立于聊天镜像租约，终端界面也能收到中断 / 结束事件。
    activity_monitors: HashSet<String>,
    /// 每终端回复临界区。
    reply_locks: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
    /// 每终端 poll 串行锁：page_for / subscribe / watcher 并发驱动时保证
    /// 「单条解析任务串行」，旧结果不会覆盖已提交的新快照。
    poll_locks: HashMap<String, Arc<std::sync::Mutex<()>>>,
    scan_cache: Option<(Instant, u64, Arc<ScanData>)>,
    locate_negative: HashMap<String, Instant>,
}

impl RelayState {
    fn remove_terminal(&mut self, terminal_id: &str) -> Vec<tokio::sync::mpsc::Sender<TerminalAgentFrame>> {
        self.mirrors.remove(terminal_id);
        self.activity_monitors.remove(terminal_id);
        self.phases.remove_terminal(terminal_id);
        self.ledger.remove_terminal(terminal_id);
        self.rate.remove(terminal_id);
        self.reply_locks.remove(terminal_id);
        self.poll_locks.remove(terminal_id);
        self.locate_negative.remove(terminal_id);
        self.watchers
            .remove(terminal_id)
            .map(|handle| handle.leases.into_values().filter_map(|lease| lease.sender).collect())
            .unwrap_or_default()
    }
}

fn state() -> &'static Mutex<RelayState> {
    static STATE: OnceLock<Mutex<RelayState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(RelayState::default()))
}

fn lock_state() -> std::sync::MutexGuard<'static, RelayState> {
    state().lock().unwrap_or_else(|error| error.into_inner())
}

// ───────────────────────── 进程扫描缓存（权限无关数据，2 秒 TTL） ─────────────────────────

pub(crate) struct ScanData {
    pub summaries: HashMap<String, TerminalTaskSummary>,
    pub bindings: HashMap<String, AgentSessionRecord>,
}

/// 完整进程扫描：summaries 先补写 transcript，再读绑定表——顺序不能反（§4.2）。
/// 结果为不带权限语义的快照，各调用方自行按可见终端过滤与鉴权。
fn relay_scan(app: &AppHandle) -> Arc<ScanData> {
    let service = app.state::<TerminalService>();
    let ids: Vec<String> = service.lock_instances().keys().cloned().collect();
    let pids = crate::commands::claude_session::terminal_processes(&ids, &service);
    let pids_key = {
        let mut sorted = pids.clone();
        sorted.sort();
        let mut hash = 1469598103934665603_u64;
        for (id, pid) in sorted {
            for byte in id.as_bytes().iter().chain(pid.to_string().as_bytes()) {
                hash ^= *byte as u64;
                hash = hash.wrapping_mul(1099511628211);
            }
        }
        hash
    };
    {
        let current = lock_state();
        if let Some((at, key, data)) = &current.scan_cache {
            if *key == pids_key && at.elapsed() < SCAN_CACHE_TTL {
                return data.clone();
            }
        }
    }
    let summaries = terminal_task_service::summaries(pids);
    let bindings = terminal_task_service::session_bindings()
        .into_iter()
        .filter(|(_, record)| matches!(record.provider.as_str(), "claude" | "codex"))
        .collect();
    let data = Arc::new(ScanData { summaries, bindings });
    lock_state().scan_cache = Some((Instant::now(), pids_key, data.clone()));
    data
}

// ───────────────────────── 转录读取与解析（阻塞上下文） ─────────────────────────

enum TranscriptRead {
    Ok { content: String, stamp: (SystemTime, u64) },
    TooLarge,
    Unreadable,
    /// 读取期间文件持续变化：本轮保留旧快照，下一 tick 重试。
    Unstable,
}

/// 读取前后各取一次元数据，只解析到最后一个换行；严格 UTF-8，不做 lossy 转换。
fn read_transcript_stable(path: &std::path::Path) -> TranscriptRead {
    for _ in 0..3 {
        let Ok(before) = std::fs::metadata(path) else { return TranscriptRead::Unreadable; };
        if before.len() > FILE_TOO_LARGE_BYTES {
            return TranscriptRead::TooLarge;
        }
        let Ok(content) = std::fs::read_to_string(path) else { return TranscriptRead::Unreadable; };
        let Ok(after) = std::fs::metadata(path) else { return TranscriptRead::Unreadable; };
        let before_mtime = before.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let after_mtime = after.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if after.len() != before.len() || after_mtime != before_mtime {
            continue;
        }
        let complete = match content.rfind('\n') {
            Some(end) => content[..=end].to_string(),
            // 一个完整行都还没有：视为空快照，而不是把半行喂给解析器。
            None => String::new(),
        };
        return TranscriptRead::Ok { content: complete, stamp: (before_mtime, before.len()) };
    }
    TranscriptRead::Unstable
}

/// 解析并按阈值裁剪：返回（保留消息、截断前总数、是否裁剪、分支身份）。
fn parse_and_retain(provider: &str, content: &str) -> (Vec<SessionReplayMessage>, i64, bool) {
    let mut messages = match provider {
        "claude" => super::claude_history_service::parse_replay_messages(content),
        _ => super::codex_transcript::parse(content).messages,
    };
    let total = messages.len() as i64;
    let oversize = content.len() > TRUNCATE_PARSE_BYTES || messages.len() > MAX_PARSE_MESSAGES;
    let mut truncated = false;
    if oversize && messages.len() > RETAIN_TAIL {
        let keep = messages.len() - RETAIN_TAIL;
        messages.drain(..keep);
        truncated = true;
    }
    (messages, total, truncated)
}

fn locate_negative_fresh(terminal_id: &str) -> bool {
    lock_state()
        .locate_negative
        .get(terminal_id)
        .is_some_and(|at| at.elapsed() < LOCATE_NEGATIVE_TTL)
}

fn mark_locate_negative(terminal_id: &str) {
    lock_state().locate_negative.insert(terminal_id.to_string(), Instant::now());
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaudeTurnEnd {
    Completed(i64),
    Interrupted(i64),
}

impl ClaudeTurnEnd {
    fn at(self) -> i64 {
        match self { Self::Completed(at) | Self::Interrupted(at) => at }
    }

    fn phase(self) -> &'static str {
        match self { Self::Completed(_) => "completed", Self::Interrupted(_) => "idle" }
    }
}

fn is_claude_interrupt_message(content: &serde_json::Value) -> bool {
    let text = content.as_str().or_else(|| {
        let blocks = content.as_array()?;
        if blocks.len() != 1 || blocks[0]["type"] != "text" { return None; }
        blocks[0]["text"].as_str()
    });
    matches!(text, Some("[Request interrupted by user]" | "[Request interrupted by user for tool use]"))
}

/// Claude 用户中断可能不触发 Stop，也不一定写 turn_duration；必须单独识别中断消息。
/// 只接受主会话的完整标记，工具输出 / 引用文本 / 子任务均不能结束当前回合。
fn claude_turn_end(content: &str) -> Option<ClaudeTurnEnd> {
    let mut end = None;
    for line in content.lines() {
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else { continue; };
        if row["isSidechain"] == true || row["is_sidechain"] == true { continue; }
        let timestamp = || row["timestamp"].as_str()
            .and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
            .map(|timestamp| timestamp.timestamp_millis());
        match row["type"].as_str() {
            Some("user") if is_claude_interrupt_message(&row["message"]["content"]) => {
                end = timestamp().map(ClaudeTurnEnd::Interrupted);
            }
            Some("user" | "assistant" | "api-request") => end = None,
            Some("system") if row["subtype"] == "turn_duration" => {
                // 中断后的耗时统计不应把主动取消改成任务成功。
                if !matches!(end, Some(ClaudeTurnEnd::Interrupted(_))) {
                    end = timestamp().map(ClaudeTurnEnd::Completed);
                }
            }
            _ => {}
        }
    }
    end
}

// ───────────────────────── poll：镜像刷新（阻塞上下文，串行由调用频次与提交校验保证） ─────────────────────────

#[derive(Debug)]
pub(crate) enum PollContent {
    None,
    Append {
        revision: u64,
        tail: Vec<SessionReplayMessage>,
        total: i64,
        truncated: bool,
    },
    Page {
        kind: &'static str,
        core: TailCore,
    },
    Unavailable {
        reason: String,
    },
}

/// 刷新某终端的镜像缓存；返回需要下发的内容变化（帧由调用方组合会话元数据）。
/// 文件未变化不重复解析；旧任务完成后身份已变则丢弃结果。
fn poll_mirror(terminal_id: &str, scan: &ScanData) -> PollContent {
    // 串行化同终端的解析任务（§4.3）：锁是叶子锁，内部只再取 relay 状态锁，
    // 与 tracked / instances 锁无嵌套；持锁期间允许文件 I/O（这正是它的职责）。
    let serial_lock = Arc::clone(lock_state().poll_locks.entry(terminal_id.to_string()).or_default());
    let _serial = serial_lock.lock().unwrap_or_else(|error| error.into_inner());
    let Some(record) = scan.bindings.get(terminal_id).cloned() else {
        return PollContent::None;
    };
    if !matches!(record.provider.as_str(), "claude" | "codex") {
        return PollContent::None;
    }
    let existing = lock_state().mirrors.get(terminal_id).cloned();
    let identity_matches = existing
        .as_ref()
        .is_some_and(|entry| entry.provider == record.provider && entry.session_id == record.session_id);

    if !identity_matches {
        // 首次建镜像或换绑。
        if locate_negative_fresh(terminal_id) {
            return PollContent::None;
        }
        let located = terminal_task_service::locate_transcript(terminal_id)
            .filter(|location| location.provider == record.provider && location.session_id == record.session_id);
        let Some(location) = located else {
            mark_locate_negative(terminal_id);
            // 新建会话在用户发出第一条消息前不会写 jsonl：找不到转录是正常状态，
            // 按「已就绪但还没有消息」的空镜像处理，而不是报读取失败。
            if transcript_not_started(terminal_id, &record) {
                return commit_empty_mirror(terminal_id, &record, existing.as_ref());
            }
            return commit_unavailable(terminal_id, &record, existing.as_ref(), "transcript_unreadable");
        };
        return match read_transcript_stable(&location.path) {
            TranscriptRead::Ok { content, stamp } => {
                let (messages, total, truncated) = parse_and_retain(&record.provider, &content);
                let revision = existing.as_ref().map_or(1, |entry| entry.revision.wrapping_add(1));
                let entry = MirrorEntry {
                    provider: record.provider.clone(),
                    session_id: record.session_id.clone(),
                    path: Some(location.path),
                    revision,
                    available: true,
                    reason: None,
                    messages: messages.clone(),
                    total,
                    truncated,
                    file_stamp: Some(stamp),
                    turn_end: if record.provider == "claude" { claude_turn_end(&content) } else { None },
                    last_access: Instant::now(),
                };
                let kind: &'static str = if existing.is_some() { "rotated" } else { "mirror" };
                let core = TailCore::tail(&entry.baseline(), entry.revision, RETAIN_TAIL);
                commit_entry(terminal_id, entry, PollContent::Page { kind, core }, existing.as_ref().map(|old| old.identity()))
            }
            TranscriptRead::TooLarge => commit_unavailable(terminal_id, &record, existing.as_ref(), "transcript_too_large"),
            TranscriptRead::Unreadable => commit_unavailable(terminal_id, &record, existing.as_ref(), "transcript_unreadable"),
            TranscriptRead::Unstable => PollContent::None,
        };
    }

    let entry = existing.expect("identity_matches 蕴含 existing.is_some()");
    // 同身份：文件未变化则不重复解析。
    let stamp_now = entry
        .path
        .as_ref()
        .filter(|path| path.is_file())
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|metadata| Some((metadata.modified().ok()?, metadata.len())));
    if entry.available && stamp_now.is_some_and(|stamp| Some(stamp) == entry.file_stamp) {
        return PollContent::None;
    }
    // 路径失效（重定位）或文件变化。
    let path = match entry.path.as_ref().filter(|path| path.is_file()) {
        Some(path) => path.clone(),
        None => {
            if locate_negative_fresh(terminal_id) {
                return PollContent::None;
            }
            let relocated = terminal_task_service::locate_transcript(terminal_id).filter(|location| {
                location.provider == entry.provider && location.session_id == entry.session_id
            });
            match relocated {
                Some(location) => location.path,
                None => {
                    mark_locate_negative(terminal_id);
                    // 空镜像（会话建立后尚未写入任何消息）继续维持空态；
                    // 一旦镜像里有过内容，文件消失就是真实故障，照常上报不可用。
                    if entry.messages.is_empty() && transcript_not_started(terminal_id, &record) {
                        return PollContent::None;
                    }
                    return commit_unavailable(terminal_id, &record, Some(&entry), "transcript_unreadable");
                }
            }
        }
    };
    match read_transcript_stable(&path) {
        TranscriptRead::TooLarge => commit_unavailable(terminal_id, &record, Some(&entry), "transcript_too_large"),
        TranscriptRead::Unreadable => commit_unavailable(terminal_id, &record, Some(&entry), "transcript_unreadable"),
        TranscriptRead::Unstable => PollContent::None,
        TranscriptRead::Ok { content, stamp } => {
            let (messages, total, truncated) = parse_and_retain(&record.provider, &content);
            let turn_end = if record.provider == "claude" { claude_turn_end(&content) } else { None };
            let baseline = entry.baseline();
            // 从不可用恢复：revision + 1 全量快照。
            if !entry.available {
                let mut next = entry.clone();
                next.available = true;
                next.reason = None;
                next.path = Some(path);
                next.file_stamp = Some(stamp);
                next.turn_end = turn_end;
                next.messages = messages;
                next.total = total;
                next.truncated = truncated;
                next.last_access = Instant::now();
                next.revision = next.revision.wrapping_add(1);
                let core = TailCore::tail(&next.baseline(), next.revision, RETAIN_TAIL);
                return commit_entry(terminal_id, next, PollContent::Page { kind: "mirror", core }, None);
            }
            match diff_content(&baseline, &messages, total, truncated) {
                ContentDiff::Unchanged => {
                    // 内容未变但文件戳变了（touch/重写同内容）：只更新戳，避免每 tick 重读。
                    let mut next = entry.clone();
                    next.file_stamp = Some(stamp);
                    next.turn_end = turn_end;
                    next.last_access = Instant::now();
                    commit_entry(terminal_id, next, PollContent::None, None)
                }
                ContentDiff::Append => {
                    let tail: Vec<SessionReplayMessage> = messages[baseline.messages.len()..].to_vec();
                    let mut next = entry.clone();
                    next.messages = messages;
                    next.total = total;
                    next.truncated = truncated;
                    next.file_stamp = Some(stamp);
                    next.turn_end = turn_end;
                    next.path = Some(path);
                    next.last_access = Instant::now();
                    if tail.len() > MAX_APPEND_MESSAGES {
                        let core = TailCore::tail(&next.baseline(), next.revision, RETAIN_TAIL);
                        commit_entry(terminal_id, next, PollContent::Page { kind: "mirror", core }, None)
                    } else {
                        let revision = next.revision;
                        let total = next.total;
                        let truncated = next.truncated;
                        commit_entry(
                            terminal_id,
                            next,
                            PollContent::Append { revision, tail, total, truncated },
                            None,
                        )
                    }
                }
                ContentDiff::Mirror => {
                    let mut next = entry;
                    next.messages = messages;
                    next.total = total;
                    next.truncated = truncated;
                    next.file_stamp = Some(stamp);
                    next.turn_end = turn_end;
                    next.path = Some(path);
                    next.last_access = Instant::now();
                    let core = TailCore::tail(&next.baseline(), next.revision, RETAIN_TAIL);
                    commit_entry(terminal_id, next, PollContent::Page { kind: "mirror", core }, None)
                }
                ContentDiff::Rotated => {
                    let mut next = entry;
                    next.messages = messages;
                    next.total = total;
                    next.truncated = truncated;
                    next.file_stamp = Some(stamp);
                    next.turn_end = turn_end;
                    next.path = Some(path);
                    next.last_access = Instant::now();
                    next.revision = next.revision.wrapping_add(1);
                    let core = TailCore::tail(&next.baseline(), next.revision, RETAIN_TAIL);
                    commit_entry(terminal_id, next, PollContent::Page { kind: "rotated", core }, None)
                }
            }
        }
    }
}

/// 提交新镜像条目。`observed` 是本次 poll 起点观察到的镜像身份（None = 当时无条目）：
/// 只有当状态在 poll 期间被并发的另一次写入推进到了**其他**身份（既不是起点也不是
/// 本次要提交的身份）时才丢弃结果；起点身份 → 新身份正是合法的换绑提交路径。
fn commit_entry(
    terminal_id: &str,
    entry: MirrorEntry,
    content: PollContent,
    observed: Option<(String, String)>,
) -> PollContent {
    let identity = entry.identity();
    let mut current = lock_state();
    let stale = match current.mirrors.get(terminal_id) {
        None => false,
        Some(existing) => {
            let current_identity = existing.identity();
            current_identity != identity && Some(current_identity) != observed
        }
    };
    if stale {
        return PollContent::None;
    }
    current.mirrors.insert(terminal_id.to_string(), entry);
    content
}

/// 绑定已建立但会话尚未产生任何转录（例如 App 新建会话后还没发消息）。
/// Claude 只在产生消息后才写 jsonl，此时「找不到文件」是正常状态：
/// 以空镜像代替不可用，避免把「等待第一条消息」显示成读取失败。
/// 一旦 hook 上报过非 idle 阶段（已提交提示词 / 正在执行 / 已结束等），
/// 仍找不到文件就属于真实异常，继续按不可用上报；
/// 唯一例外是 running（UserPromptSubmit 先于 jsonl 落盘）的起始宽限期。
fn transcript_not_started(terminal_id: &str, record: &AgentSessionRecord) -> bool {
    match lock_state()
        .phases
        .current(terminal_id, &record.provider, &record.session_id)
    {
        None => true,
        Some((phase, _)) if phase == "idle" => true,
        // hook 已上报「已提交提示词」，但 Claude 还没把首条消息写进 jsonl：
        // 这是启动瞬间的正常竞态，宽限期内仍按空镜像处理，过了宽限期才算故障。
        Some((phase, at)) if phase == "running" => now_ms().saturating_sub(at) < TRANSCRIPT_START_GRACE_MS,
        Some(_) => false,
    }
}

/// 提交空镜像：可用但没有任何消息。文件出现后由同身份分支按 append 或快照补齐。
fn commit_empty_mirror(
    terminal_id: &str,
    record: &AgentSessionRecord,
    existing: Option<&MirrorEntry>,
) -> PollContent {
    let revision = existing.map_or(1, |entry| entry.revision.wrapping_add(1));
    let kind: &'static str = if existing.is_some() { "rotated" } else { "mirror" };
    let entry = MirrorEntry {
        provider: record.provider.clone(),
        session_id: record.session_id.clone(),
        path: None,
        revision,
        available: true,
        reason: None,
        messages: Vec::new(),
        total: 0,
        truncated: false,
        file_stamp: None,
        turn_end: None,
        last_access: Instant::now(),
    };
    let core = TailCore::tail(&entry.baseline(), entry.revision, RETAIN_TAIL);
    commit_entry(terminal_id, entry, PollContent::Page { kind, core }, existing.map(|old| old.identity()))
}

/// 提交不可用状态。进入不可用不提升代次（恢复时 +1）；重复的相同原因不再发帧。
fn commit_unavailable(
    terminal_id: &str,
    record: &AgentSessionRecord,
    existing: Option<&MirrorEntry>,
    reason: &str,
) -> PollContent {
    let already_unavailable = existing.is_some_and(|entry| {
        !entry.available && entry.reason.as_deref() == Some(reason) && entry.provider == record.provider && entry.session_id == record.session_id
    });
    let revision = existing
        .filter(|entry| entry.provider == record.provider && entry.session_id == record.session_id)
        .map(|entry| entry.revision)
        .unwrap_or_else(|| existing.map(|entry| entry.revision.wrapping_add(1)).unwrap_or(1));
    // 只有身份相同才允许沿用旧条目的转录路径；换绑后进入不可用时保留旧路径
    // 会让同身份分支把旧会话的内容当成新会话的镜像（且 stamp 不再变化、永不自愈）。
    let same_identity = existing
        .is_some_and(|entry| entry.provider == record.provider && entry.session_id == record.session_id);
    let entry = MirrorEntry {
        provider: record.provider.clone(),
        session_id: record.session_id.clone(),
        path: if same_identity { existing.and_then(|entry| entry.path.clone()) } else { None },
        revision,
        available: false,
        reason: Some(reason.to_string()),
        messages: Vec::new(),
        total: 0,
        truncated: false,
        file_stamp: None,
        turn_end: None,
        last_access: Instant::now(),
    };
    let result = if already_unavailable { PollContent::None } else { PollContent::Unavailable { reason: reason.to_string() } };
    // observed 取 poll 起点的身份：换绑后进入不可用时，起点身份 != 新身份是合法路径。
    let observed = existing.map(|old| old.identity());
    commit_entry(terminal_id, entry, result, observed)
}

// ───────────────────────── 会话元数据 ─────────────────────────

fn pending_decision_ids(terminal_id: &str) -> Vec<String> {
    crate::services::ClaudeHookService::list_pending_decisions()
        .into_iter()
        .filter(|decision| decision.terminal_id == terminal_id)
        .map(|decision| decision.decision_id)
        .collect()
}

fn file_mtime_ms(path: Option<&std::path::Path>) -> Option<i64> {
    let metadata = std::fs::metadata(path?).ok();
    metadata?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_millis() as i64)
}

/// lastActivityAt = max(转录文件 mtime, phaseAt)，都取不到为 None。
/// 不用 AgentSessionRecord.updated_at——它恒为读取时刻，没有信息量。
fn last_activity_ms(path: Option<&std::path::Path>, phase_at: Option<i64>) -> Option<i64> {
    match (file_mtime_ms(path), phase_at) {
        (Some(mtime), Some(at)) => Some(mtime.max(at)),
        (value, None) | (None, value) => value,
    }
}

/// 从转录补齐正常结束 / 用户中断事件，电脑和手机沿用同一状态通道。
fn reconcile_transcript_end(
    app: &AppHandle, info: &crate::models::web_api::TerminalInfo, record: &AgentSessionRecord,
) {
    if record.provider != "claude" { return; }
    if terminal_task_service::current_binding(&info.id) != Some((record.provider.clone(), record.session_id.clone())) {
        return;
    }
    let decision_prefix = format!("{}:", record.session_id);
    let pending = super::ClaudeHookService::list_pending_decisions().into_iter()
        .filter(|decision| decision.terminal_id == info.id && decision.decision_id.starts_with(&decision_prefix))
        .collect::<Vec<_>>();
    let key = PhaseKey {
        terminal_id: info.id.clone(), provider: record.provider.clone(), session_id: record.session_id.clone(),
    };
    let (end, occurred_at, summary) = {
        let mut current = lock_state();
        let Some(entry) = current.mirrors.get(&info.id)
            .filter(|entry| entry.available && entry.provider == record.provider && entry.session_id == record.session_id)
        else { return; };
        let Some(end) = entry.turn_end else { return; };
        // 中断前的决策已失效；正常完成仍须等待当前决策处理完毕。
        if pending.iter().any(|decision| end.phase() != "idle" || decision.occurred_at >= end.at()) { return; }
        let summary = if matches!(end, ClaudeTurnEnd::Interrupted(_)) {
            Some("用户已中断，等待输入".to_string())
        } else {
            entry.messages.iter().rev()
                .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
                .map(|message| super::codex_transcript::excerpt(&message.text, 220))
        };
        if !current.phases.settle_from_transcript(&key, end) { return; }
        (end, current.phases.entries[&key].occurred_at, summary)
    };
    for decision in pending {
        super::ClaudeHookService::expire_decision(&decision.decision_id);
    }
    let event = crate::services::ClaudeHookTerminalEvent {
        event_id: uuid::Uuid::new_v4().to_string(), terminal_id: info.id.clone(),
        session_id: record.session_id.clone(),
        event_name: if matches!(end, ClaudeTurnEnd::Interrupted(_)) { "TranscriptTurnInterrupted" } else { "TranscriptTurnComplete" }.to_string(),
        phase: end.phase().to_string(), occurred_at, provider: Some(record.provider.clone()),
        notification_type: None, title: None, message: None, task_title: None, summary,
    };
    eprintln!("[TerminalActivity] 从转录补齐回合结束 terminal={} session={} phase={} occurred_at={}",
        info.id, record.session_id, event.phase, event.occurred_at);
    let _ = app.emit("claude-hook-terminal-event", event.clone());
    crate::services::AppNotificationService::publish_terminal_result(&event, info.profile_name.clone());
}

/// 不依赖用户打开聊天接力页：Hook 进入活动态后每秒检查一次转录，文件未变化时复用镜像缓存。
/// 同一终端只启动一个监测任务，始终跟随当前绑定，回合结束或终端关闭后自动停止。
pub(crate) fn monitor_claude_activity(app: &AppHandle, terminal_id: &str) {
    if !lock_state().activity_monitors.insert(terminal_id.to_string()) { return; }
    let app = app.clone();
    let terminal_id = terminal_id.to_string();
    crate::runtime::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(WATCH_TICK).await;
            let poll_app = app.clone();
            let poll_id = terminal_id.clone();
            let result = crate::runtime::async_runtime::spawn_blocking(move || {
                let record = terminal_task_service::session_bindings().remove(&poll_id);
                let info = find_terminal_info(&poll_app, &poll_id);
                {
                    let mut current = lock_state();
                    let active = record.as_ref().filter(|record| record.provider == "claude")
                        .and_then(|record| current.phases.current(&poll_id, &record.provider, &record.session_id))
                        .is_some_and(|(phase, _)| matches!(phase.as_str(), "running" | "attention"));
                    if info.is_none() || !active {
                        current.activity_monitors.remove(&poll_id);
                        return false;
                    }
                }
                if let (Some(record), Some(info)) = (record, info) {
                    let scan = ScanData {
                        summaries: HashMap::new(), bindings: HashMap::from([(poll_id.clone(), record.clone())]),
                    };
                    let content = poll_mirror(&poll_id, &scan);
                    reconcile_transcript_end(&poll_app, &info, &record);
                    if lock_state().watchers.contains_key(&poll_id) {
                        // 有聊天订阅时沿用完整发现链的摘要，避免活动监测发出缺失标题的状态帧。
                        let delivery_scan = relay_scan(&poll_app);
                        deliver_poll_result(&poll_app, &poll_id, &delivery_scan, &content);
                    }
                }
                true
            }).await;
            match result {
                Ok(true) => {}
                Ok(false) => break,
                Err(_) => {
                    lock_state().activity_monitors.remove(&terminal_id);
                    break;
                }
            }
        }
    });
}

/// 组装某个终端的会话元数据。`info` 由调用方按可见性过滤后传入。
/// 返回 None 表示该终端当前没有可接力的 Agent 绑定；Some 附带镜像缓存条目。
fn build_session_meta(
    app: &AppHandle,
    info: &crate::models::web_api::TerminalInfo,
    scan: &ScanData,
    actor: TerminalActor,
) -> Option<(TerminalAgentSession, Option<MirrorEntry>)> {
    let record = scan.bindings.get(&info.id)?;
    if !matches!(record.provider.as_str(), "claude" | "codex") {
        return None;
    }
    reconcile_transcript_end(app, info, record);
    let summary = scan.summaries.get(&info.id);
    let (entry, phase, phase_at) = {
        let current = lock_state();
        let entry = current.mirrors.get(&info.id).cloned();
        let (phase, phase_at) = current
            .phases
            .current(&info.id, &record.provider, &record.session_id)
            .map(|(phase, at)| (phase, Some(at)))
            .unwrap_or_else(|| inferred_phase(entry.as_ref()));
        (entry, phase, phase_at)
    };
    let pending = pending_decision_ids(&info.id);
    let authorize = app
        .state::<TerminalService>()
        .authorize(&info.id, actor, TerminalAction::Input);
    let (input_allowed, denied_message) = match authorize {
        Ok(()) => (true, None),
        Err(error) => (false, Some(error.to_string())),
    };
    let (can_reply, reply_blocked_reason) = evaluate_can_reply(
        input_allowed,
        denied_message,
        &phase,
        phase_at,
        pending.len(),
        now_ms(),
    );
    let revision = entry.as_ref().map_or(1, |entry| entry.revision);
    let mirror = entry
        .as_ref()
        .map(|entry| MirrorStatus { available: entry.available, reason: entry.reason.clone() })
        .unwrap_or(MirrorStatus { available: true, reason: None });
    // 尚未打开过镜像的会话也有发现链定位的转录路径，列表据此取得真实活动时间。
    let transcript_path = entry
        .as_ref()
        .and_then(|entry| entry.path.clone())
        .or_else(|| record.session_file.as_ref().map(std::path::PathBuf::from));
    let session = TerminalAgentSession {
        terminal_id: info.id.clone(),
        profile_name: info.profile_name.clone(),
        terminal_type: info.terminal_type.clone(),
        directory: info.directory.clone().or_else(|| record.cwd.clone()),
        provider: record.provider.clone(),
        session_id: record.session_id.clone(),
        title: summary.map(|summary| summary.summary.clone()),
        model: summary.and_then(|summary| summary.model.clone()),
        phase,
        phase_at,
        last_activity_at: last_activity_ms(transcript_path.as_deref(), phase_at),
        pending_decision_id: pending.first().cloned(),
        pending_decision_count: pending.len(),
        can_reply,
        reply_blocked_reason,
        revision,
        mirror,
    };
    Some((session, entry))
}

fn find_terminal_info(app: &AppHandle, terminal_id: &str) -> Option<crate::models::web_api::TerminalInfo> {
    app.state::<TerminalService>()
        .list_terminals_info()
        .into_iter()
        .find(|info| info.id == terminal_id)
}

// ───────────────────────── 用例：列表与消息页 ─────────────────────────

/// 可接力的终端会话列表（§4.2）。发现链：可见终端 → PID → summaries → 绑定。
pub async fn sessions_for(app: &AppHandle, actor: TerminalActor) -> Vec<TerminalAgentSession> {
    let app = app.clone();
    let result = crate::runtime::async_runtime::spawn_blocking(move || {
        let scan = relay_scan(&app);
        let service = app.state::<TerminalService>();
        let sessions = service
            .list_terminals_info_for(actor)
            .into_iter()
            .filter_map(|info| build_session_meta(&app, &info, &scan, actor).map(|(session, _)| session))
            .collect::<Vec<_>>();
        // 列表请求也会路过镜像缓存：顺带做无人访问条目的回收
        //（watcher 停止后只剩这条路径能清理这些终端的镜像）。
        housekeeping();
        sessions
    })
    .await;
    result.unwrap_or_default()
}

/// 消息页（§4.4）：不带 afterSeq 为首屏尾页；带 afterSeq 为限界增量或 reset 尾页。
pub async fn page_for(
    app: &AppHandle,
    actor: TerminalActor,
    terminal_id: &str,
    after_seq: Option<i64>,
    revision: Option<u64>,
    limit: Option<usize>,
) -> Result<TerminalAgentPage, RelayError> {
    if !valid_terminal_id(terminal_id) {
        return Err(RelayError::BadRequest("终端标识符无效".to_string()));
    }
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT);
    if !(1..=MAX_PAGE_LIMIT).contains(&limit) {
        return Err(RelayError::BadRequest(format!("limit 必须在 1..={MAX_PAGE_LIMIT} 之间")));
    }
    if let Some(after) = after_seq {
        if after < MIN_AFTER_SEQ {
            return Err(RelayError::BadRequest("afterSeq 必须是不小于 -1 的整数".to_string()));
        }
    }
    app.state::<TerminalService>()
        .authorize(terminal_id, actor, TerminalAction::View)
        .map_err(access_error)?;
    let terminal_id = terminal_id.to_string();
    let app = app.clone();
    crate::runtime::async_runtime::spawn_blocking(move || {
        let scan = relay_scan(&app);
        // page 请求也驱动一次镜像构建/刷新（首屏不依赖 watcher）；有订阅者时
        // 提交的新内容立即下发（提交即交付），不依赖下一次 watcher tick。
        let content = poll_mirror(&terminal_id, &scan);
        if !matches!(content, PollContent::None)
            && lock_state().watchers.contains_key(&terminal_id)
        {
            deliver_poll_result(&app, &terminal_id, &scan, &content);
        }
        let Some(info) = find_terminal_info(&app, &terminal_id) else {
            return Err(RelayError::NotFound("终端不存在或已关闭".to_string()));
        };
        let Some((session, entry)) = build_session_meta(&app, &info, &scan, actor) else {
            return Err(RelayError::NotFound("该终端没有正在运行的 Agent".to_string()));
        };
        let current_revision = entry.as_ref().map_or(1, |entry| entry.revision);
        let baseline = entry.map(|entry| entry.baseline()).unwrap_or_default();
        let (core, reset_required) = match after_seq {
            None => (TailCore::tail(&baseline, current_revision, limit), false),
            Some(after) => {
                if incremental_requires_reset(&baseline, current_revision, after, revision) {
                    (TailCore::tail(&baseline, current_revision, RETAIN_TAIL), true)
                } else {
                    (TailCore::incremental(&baseline, current_revision, after, limit), false)
                }
            }
        };
        Ok(TerminalAgentPage {
            session,
            messages: core.messages,
            cursor: core.cursor,
            total: core.total,
            truncated: core.truncated,
            has_more: core.has_more,
            next_cursor: core.next_cursor,
            oldest_retained_seq: core.oldest_retained_seq,
            reset_required,
        })
    })
    .await
    .map_err(|error| RelayError::Internal(error.to_string()))?
}

// ───────────────────────── 用例：订阅（WS 直发租约） ─────────────────────────

/// `terminal_agent_subscribe` / WS 握手共用。
/// socket=true 时返回接收端（Android / 浏览器直连 WS）；socket=false 是事件租约
/// （桌面 React / 浏览器事件通道，帧经 `AGENT_UPDATE_EVENT` 推送）。
pub async fn subscribe(
    app: &AppHandle,
    actor: TerminalActor,
    terminal_id: &str,
    socket: bool,
) -> Result<(SubscribeOutcome, Option<tokio::sync::mpsc::Receiver<TerminalAgentFrame>>), RelayError> {
    if !valid_terminal_id(terminal_id) {
        return Err(RelayError::BadRequest("终端标识符无效".to_string()));
    }
    app.state::<TerminalService>()
        .authorize(terminal_id, actor, TerminalAction::View)
        .map_err(access_error)?;
    let terminal_id = terminal_id.to_string();
    let app = app.clone();
    let app_for_task = app.clone();
    let terminal_for_task = terminal_id.clone();
    let prepared = crate::runtime::async_runtime::spawn_blocking(move || {
        let app = &app_for_task;
        let terminal_id = &terminal_for_task;
        let scan = relay_scan(app);
        let has_agent = scan
            .bindings
            .get(terminal_id)
            .is_some_and(|record| matches!(record.provider.as_str(), "claude" | "codex"));
        if !has_agent {
            return Err(RelayError::NotFound("该终端没有正在运行的 Agent".to_string()));
        }
        let Some(info) = find_terminal_info(app, terminal_id) else {
            return Err(RelayError::NotFound("终端不存在或已关闭".to_string()));
        };
        let subscription_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = if socket {
            let pair = tokio::sync::mpsc::channel(OUTBOUND_QUEUE);
            (Some(pair.0), Some(pair.1))
        } else {
            // 事件通道：帧经 Emitter 广播，不占用每租约出站队列。
            (None, None)
        };
        // 先注册租约、再 poll：首帧从最新已提交状态构建，poll 之后提交的任何
        // 内容都会经 deliver 到达本租约，不存在「快照与注册之间」的漏帧窗口。
        let mut spawn_watcher = false;
        {
            let mut current = lock_state();
            if !current.watchers.contains_key(terminal_id) {
                current.watchers.insert(
                    terminal_id.clone(),
                    WatcherHandle { leases: HashMap::new(), last_meta: HashMap::new(), linger_since: None },
                );
                spawn_watcher = true;
            }
            if let Some(handle) = current.watchers.get_mut(terminal_id) {
                handle.leases.insert(
                    subscription_id.clone(),
                    Lease {
                        actor,
                        kind: if socket { "socket" } else { "event" },
                        sender,
                        expires: if socket { None } else { Some(Instant::now() + LEASE_TTL) },
                    },
                );
            }
        }
        poll_and_deliver(app, terminal_id);
        let Some((session, entry)) = build_session_meta(app, &info, &scan, actor) else {
            // 绑定在注册后消失（极端窗口）：回收刚注册的租约再报错。
            let mut current = lock_state();
            if let Some(handle) = current.watchers.get_mut(terminal_id) {
                handle.leases.remove(&subscription_id);
            }
            return Err(RelayError::NotFound("该终端没有正在运行的 Agent".to_string()));
        };
        let initial = if session.mirror.available {
            let revision = entry.as_ref().map_or(1, |entry| entry.revision);
            let baseline = entry.map(|entry| entry.baseline()).unwrap_or_default();
            let core = TailCore::tail(&baseline, revision, RETAIN_TAIL);
            TerminalAgentFrame::content("mirror", terminal_id, session, &core)
        } else {
            TerminalAgentFrame::unavailable(terminal_id, session)
        };
        Ok((
            SubscribeOutcome { subscription_id, initial_frame: initial },
            receiver,
            spawn_watcher,
        ))
    })
    .await
    .map_err(|error| RelayError::Internal(error.to_string()))?;
    let (outcome, receiver, spawn_watcher) = prepared?;
    if spawn_watcher {
        tokio::spawn(run_watcher(app.clone(), terminal_id.clone()));
    }
    Ok((outcome, receiver))
}

/// 释放指定租约；重复释放幂等。
pub fn unsubscribe(terminal_id: &str, subscription_id: &str) {
    if !valid_terminal_id(terminal_id) || !valid_request_id(subscription_id) {
        return;
    }
    let mut current = lock_state();
    if let Some(handle) = current.watchers.get_mut(terminal_id) {
        handle.leases.remove(subscription_id);
    }
}

/// 事件租约续租：只续本人身份的租约，返回仍然存活的子集。
/// 心跳失败或 alive 不含当前句柄时，客户端应退订旧句柄再重新 subscribe。
pub fn heartbeat(actor: TerminalActor, leases: &[HeartbeatLease]) -> Vec<HeartbeatLease> {
    let now = Instant::now();
    let mut alive = Vec::new();
    let mut current = lock_state();
    for lease in leases {
        if !valid_terminal_id(&lease.terminal_id) || !valid_request_id(&lease.subscription_id) {
            continue;
        }
        let renewed = current
            .watchers
            .get_mut(&lease.terminal_id)
            .and_then(|handle| handle.leases.get_mut(&lease.subscription_id))
            .filter(|entry| entry.actor == actor)
            .map(|entry| {
                if entry.kind == "event" {
                    entry.expires = Some(now + LEASE_TTL);
                }
                true
            })
            .unwrap_or(false);
        if renewed {
            alive.push(lease.clone());
        }
    }
    alive
}

// ───────────────────────── 用例：回复（七闸门 + 幂等 + 每终端串行） ─────────────────────────

enum ReplyDecision {
    Accepted { duplicated: bool, phase: String },
    Failed(RelayError),
    WriteFailed,
    /// 文本已写入 PTY，等待停顿后单独写入提交回车。
    TextWritten,
}

/// 受限回复（§4.6）。校验链顺序固定，任何一步失败都不写 PTY；
/// writer 失败标记 write_outcome_unknown，不自动重试。
pub async fn reply(
    app: &AppHandle,
    actor: TerminalActor,
    terminal_id: &str,
    text: &str,
    request_id: &str,
) -> Result<ReplyOutcome, RelayError> {
    if !valid_terminal_id(terminal_id) {
        return Err(RelayError::BadRequest("终端标识符无效".to_string()));
    }
    if !valid_request_id(request_id) {
        return Err(RelayError::BadRequest("requestId 必须是 8-64 位字母、数字、- 或 _".to_string()));
    }
    // CRLF / CR 统一成 LF：多行草稿只允许 LF，避免 \r 被 TUI 当成回车提交。
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.as_str();
    app.state::<TerminalService>()
        .authorize(terminal_id, actor, TerminalAction::Input)
        .map_err(access_error)?;
    // 预取扫描数据（spawn_blocking）：必须在每终端临界区之外执行，
    // 临界区不包裹文件扫描（§4.9）。
    let terminal_id_owned = terminal_id.to_string();
    let app_clone = app.clone();
    let context = crate::runtime::async_runtime::spawn_blocking(move || {
        let scan = relay_scan(&app_clone);
        let binding = scan
            .bindings
            .get(&terminal_id_owned)
            .filter(|record| matches!(record.provider.as_str(), "claude" | "codex"))
            .map(|record| (record.provider.clone(), record.session_id.clone()));
        let (phase, phase_at) = binding
            .as_ref()
            .and_then(|(provider, session_id)| {
                lock_state().phases.current(&terminal_id_owned, provider, session_id)
            })
            .map(|(phase, at)| (phase, Some(at)))
            .unwrap_or_else(|| {
                // 阶段表无记录（Codex / 手动启动 / 服务重启后）按镜像推断；
                // 镜像身份与绑定不一致（换绑未刷新）时不采信旧镜像。
                let current = lock_state();
                let entry = current
                    .mirrors
                    .get(&terminal_id_owned)
                    .filter(|entry| binding.as_ref().is_some_and(|identity| &entry.identity() == identity));
                inferred_phase(entry)
            });
        (
            binding,
            pending_decision_ids(&terminal_id_owned),
            phase,
            phase_at,
        )
    })
    .await
    .map_err(|error| RelayError::Internal(error.to_string()))?;
    let (binding, _prefetched_pending, phase, _prefetched_phase_at) = context;
    // 每终端串行临界区：重新授权 → 重读绑定/阶段/决策 → 幂等/文本/限流 → 写 PTY。
    let lock = {
        let mut current = lock_state();
        Arc::clone(current.reply_locks.entry(terminal_id.to_string()).or_default())
    };
    let _guard = lock.lock().await;
    let key = RequestKey {
        actor_web: actor == TerminalActor::Web,
        terminal_id: terminal_id.to_string(),
        request_id: request_id.to_string(),
    };
    let normalized = text.trim().to_string();
    // ── 临界区：重新授权 → 重读绑定/阶段/决策 → 幂等/文本/限流 → 写 PTY ──
    let decide = || -> ReplyDecision {
        // 第 1 条（重新授权）：任何一步失败都不写 PTY。
        if let Err(error) = app
            .state::<TerminalService>()
            .authorize(terminal_id, actor, TerminalAction::Input)
        {
            return ReplyDecision::Failed(access_error(error));
        }
        // 第 2–7 条为纯函数判定（可单测）：幂等表与限流快照在锁内读取。
        // 待决策与阶段同样在锁内重读（审查 M-17）：预取发生在拿锁之前，
        // attention/待决策窗口期内状态可能已被其他事件改变；绑定来自文件
        // 扫描，按 §4.9 不在临界区重跑，维持预取值。
        let (pending, phase, phase_at) = {
            let current = lock_state();
            let pending = pending_decision_ids(terminal_id);
            let (phase, phase_at) = binding
                .as_ref()
                .and_then(|(provider, session_id)| current.phases.current(terminal_id, provider, session_id))
                .map(|(phase, at)| (phase, Some(at)))
                .unwrap_or_else(|| {
                    let entry = current
                        .mirrors
                        .get(terminal_id)
                        .filter(|entry| binding.as_ref().is_some_and(|identity| &entry.identity() == identity));
                    inferred_phase(entry)
                });
            (pending, phase, phase_at)
        };
        let (mirror_identity, last_success) = {
            let current = lock_state();
            (
                current.mirrors.get(terminal_id).map(|entry| entry.identity()),
                current.rate.get(terminal_id).copied(),
            )
        };
        let outcome = {
            let current = lock_state();
            evaluate_reply_gates(
                ReplyGateContext {
                    binding: binding.as_ref(),
                    mirror_identity: mirror_identity.as_ref(),
                    pending: &pending,
                    phase: &phase,
                    phase_at,
                    text,
                    request_id,
                    terminal_id,
                    actor_web: actor == TerminalActor::Web,
                },
                &current.ledger,
                last_success,
            )
        };
        match outcome {
            GateOutcome::Write => {
                // 先只写文本；回车在临界区外用 REPLY_SUBMIT_DELAY 停顿后单独提交。
                match app
                    .state::<TerminalService>()
                    .write_to_terminal(terminal_id, &reply_payload(text), actor)
                {
                    Ok(()) => ReplyDecision::TextWritten,
                    Err(_) => ReplyDecision::WriteFailed,
                }
            }
            GateOutcome::Duplicated => ReplyDecision::Accepted { duplicated: true, phase: phase.clone() },
            GateOutcome::Rejected(error) => ReplyDecision::Failed(error),
        }
    };
    let decision = decide();
    // 文本写成功后，停顿再单独写回车：长文本与 "\r" 同一批到达会被 TUI
    // 当作粘贴整体插入，回车被吞掉，消息停在输入框里不发送。
    let decision = match decision {
        ReplyDecision::TextWritten => {
            tokio::time::sleep(REPLY_SUBMIT_DELAY).await;
            match app
                .state::<TerminalService>()
                .write_to_terminal(terminal_id, "\r", actor)
            {
                Ok(()) => ReplyDecision::Accepted { duplicated: false, phase: phase.clone() },
                Err(_) => ReplyDecision::WriteFailed,
            }
        }
        other => other,
    };
    match decision {
        ReplyDecision::Accepted { duplicated, phase } => {
            let mut current = lock_state();
            current.ledger.record(key, &normalized, LedgerStatus::Completed);
            if !duplicated {
                current.rate.insert(terminal_id.to_string(), Instant::now());
            }
            Ok(ReplyOutcome { accepted: true, duplicated, phase, at: now_ms() })
        }
        ReplyDecision::WriteFailed => {
            // PTY 的 write_all/flush 无法报告已写字节数：不保证恰好一次。
            // 服务端与客户端均不自动重试，由用户确认后用新 requestId 主动重发。
            lock_state().ledger.record(key, &normalized, LedgerStatus::Unknown);
            Err(RelayError::Conflict {
                message: "终端写入结果未知，请打开终端确认；如未生效请用新的 requestId 重新发送".to_string(),
                decision_id: None,
                reply_blocked_reason: None,
            })
        }
        ReplyDecision::Failed(error) => Err(error),
        // 上面的提交步骤已把 TextWritten 转换为具体结果；到此说明后续改动破坏了该约定。
        ReplyDecision::TextWritten => Err(RelayError::Internal("回复状态异常，请重试".to_string())),
    }
}

// ───────────────────────── 定时任务：终端 Agent 快照与任务描述注入 ─────────────────────────

/// 定时任务用的单终端快照。与 relay 列表不同：未绑定时也返回（phase = "unknown"），
/// 让调度器能区分「终端还活着、Agent 还没起来」和「终端已被关闭」。
pub(crate) struct ScheduledAgentSnapshot {
    pub provider: Option<String>,
    pub phase: String,
    pub pending_decision_count: usize,
    pub last_assistant_message: Option<String>,
    /// "completed" | "interrupted"；仅 Claude 转录可识别。
    pub turn_end: Option<String>,
}

/// None = 终端已不存在。内部调用，不做 actor 可见性过滤（actor 只用于授权校验）。
pub(crate) async fn scheduled_snapshot(
    app: &AppHandle,
    actor: TerminalActor,
    terminal_id: &str,
) -> Option<ScheduledAgentSnapshot> {
    let app = app.clone();
    let terminal_id = terminal_id.to_string();
    crate::runtime::async_runtime::spawn_blocking(move || {
        let scan = relay_scan(&app);
        // 与 page_for 一致：快照请求顺带驱动镜像刷新，首轮不依赖 watcher。
        let _ = poll_mirror(&terminal_id, &scan);
        let info = find_terminal_info(&app, &terminal_id)?;
        // Antigravity CLI 没有 Hook，也不参与镜像接力：直接按转录末尾步骤判断回合状态。
        if let Some((provider, session_id)) = terminal_task_service::current_binding(&terminal_id) {
            if provider == "antigravity" {
                return Some(antigravity_snapshot(&terminal_id, &session_id));
            }
        }
        // 新会话在用户发出第一条消息前可能还没有 conversation id / 转录目录。
        // 启动命令本身已能识别出 `agy`，据此报告「已启动、空回合」，让调度器
        // 有机会键入任务描述；conversation 建立后自然切到真实转录。
        if terminal_task_service::launch_hints(&terminal_id)
            .and_then(|hints| hints.provider)
            .as_deref() == Some("antigravity")
        {
            return Some(ScheduledAgentSnapshot {
                provider: Some("antigravity".to_string()),
                phase: "idle".to_string(),
                pending_decision_count: 0,
                last_assistant_message: None,
                turn_end: None,
            });
        }
        let Some((session, entry)) = build_session_meta(&app, &info, &scan, actor) else {
            return Some(ScheduledAgentSnapshot {
                provider: None,
                phase: "unknown".to_string(),
                pending_decision_count: pending_decision_ids(&terminal_id).len(),
                last_assistant_message: None,
                turn_end: None,
            });
        };
        let last_assistant_message = entry.as_ref().and_then(|entry| {
            entry
                .messages
                .iter()
                .rev()
                .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
                .map(|message| truncate_text(message.text.trim(), 500))
        });
        let turn_end = entry.as_ref().and_then(|entry| entry.turn_end).map(|end| match end {
            ClaudeTurnEnd::Completed(_) => "completed".to_string(),
            ClaudeTurnEnd::Interrupted(_) => "interrupted".to_string(),
        });
        Some(ScheduledAgentSnapshot {
            provider: Some(session.provider),
            phase: session.phase,
            pending_decision_count: session.pending_decision_count,
            last_assistant_message,
            turn_end,
        })
    })
    .await
    .ok()
    .flatten()
}

/// Antigravity 转录尾部窗口：只读最后 2 MiB 即可拿到最后一条步骤与最终回答，
/// 避免长会话在每 5 秒一次的快照里整文件重读。
const ANTIGRAVITY_TAIL_BYTES: u64 = 2 * 1024 * 1024;

fn read_antigravity_tail(path: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(ANTIGRAVITY_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(ANTIGRAVITY_TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    // 从文件中间截断时丢掉第一个半行，避免 JSON 解析噪声。
    if start > 0 {
        if let Some(end) = text.find('\n') {
            text.drain(..=end);
        }
    }
    Some(text)
}

/// Antigravity 定时任务快照：进程发现链已经绑定 conversation 时，
/// 按转录文件末尾步骤判断 `running` / `idle`，并取最后一条助手文本作为执行摘要。
fn antigravity_snapshot(terminal_id: &str, session_id: &str) -> ScheduledAgentSnapshot {
    let content = terminal_task_service::locate_transcript(terminal_id)
        .filter(|location| location.provider == "antigravity" && location.session_id == session_id)
        .and_then(|location| read_antigravity_tail(&location.path));
    let Some(content) = content else {
        // 进程已启动但还没写第一条消息：视为就绪的空回合。
        return ScheduledAgentSnapshot {
            provider: Some("antigravity".to_string()),
            phase: "idle".to_string(),
            pending_decision_count: 0,
            last_assistant_message: None,
            turn_end: None,
        };
    };
    let parsed = super::antigravity_transcript::parse(&content);
    let last_assistant_message = parsed
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
        .map(|message| truncate_text(message.text.trim(), 500));
    ScheduledAgentSnapshot {
        provider: Some("antigravity".to_string()),
        phase: super::antigravity_transcript::turn_phase(&content).to_string(),
        pending_decision_count: 0,
        last_assistant_message,
        turn_end: None,
    }
}

fn truncate_text(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut result: String = value.chars().take(limit).collect();
    result.push('…');
    result
}

/// 调度器向自己创建的 Agent 终端提交任务描述。
///
/// 与受限回复不同：允许 `/`、`!`、`@`、`#` 开头（斜杠命令必须由 REPL 输入框展开），
/// 也允许超过回复上限的长文本；仍拒绝除换行外的控制字符。不加绑定/阶段/限流闸门——
/// 这是调度器自己的任务描述，不是用户 relay 回复；写入失败也不重试（避免重复提交）。
pub(crate) async fn submit_task_prompt(
    app: &AppHandle,
    actor: TerminalActor,
    terminal_id: &str,
    text: &str,
) -> Result<(), RelayError> {
    if !valid_terminal_id(terminal_id) {
        return Err(RelayError::BadRequest("终端标识符无效".to_string()));
    }
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    if text.trim().is_empty() {
        return Err(RelayError::BadRequest("任务描述不能为空".to_string()));
    }
    if let Some(control) = text.chars().find(|character| *character != '\n' && character.is_control()) {
        return Err(RelayError::BadRequest(format!(
            "任务描述不能包含换行以外的控制字符（U+{:04X}）",
            control as u32
        )));
    }
    app.state::<TerminalService>()
        .authorize(terminal_id, actor, TerminalAction::Input)
        .map_err(access_error)?;
    // 先只写文本；回车在停顿后单独提交，避免被 Ink 输入框当成粘贴内容吞掉。
    app.state::<TerminalService>()
        .write_to_terminal(terminal_id, &reply_payload(&text), actor)
        .map_err(|error| RelayError::Internal(format!("写入任务描述失败：{error}")))?;
    tokio::time::sleep(REPLY_SUBMIT_DELAY).await;
    app.state::<TerminalService>()
        .write_to_terminal(terminal_id, "\r", actor)
        .map_err(|error| RelayError::Internal(format!("提交任务描述失败：{error}")))?;
    Ok(())
}

// ───────────────────────── 阶段上报与终端关闭 ─────────────────────────

/// Hook 阶段上报（§4.7）：键 = (terminalId, provider, sessionId)。
/// 只有与当前绑定完全匹配才写入，旧 sessionId 的延迟事件不得污染新会话。
pub fn note_phase(terminal_id: &str, provider: &str, session_id: &str, phase: &str, occurred_at: i64) {
    match terminal_task_service::current_binding(terminal_id) {
        Some((bound_provider, bound_session)) if bound_provider == provider && bound_session == session_id => {}
        _ => return,
    }
    lock_state().phases.note(
        PhaseKey {
            terminal_id: terminal_id.to_string(),
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        },
        phase,
        occurred_at,
    );
}

/// Claude Hook 按提示词回合更新；返回 false 时调用方也不能向客户端广播被拒绝的状态。
pub(crate) fn note_claude_hook_phase(
    terminal_id: &str, session_id: &str, event_name: &str, prompt_id: Option<&str>, phase: &str, occurred_at: i64,
) -> bool {
    if terminal_task_service::current_binding(terminal_id) != Some(("claude".to_string(), session_id.to_string())) {
        return false;
    }
    lock_state().phases.note_claude_hook(
        PhaseKey { terminal_id: terminal_id.to_string(), provider: "claude".to_string(), session_id: session_id.to_string() },
        event_name, prompt_id, phase, occurred_at,
    )
}

/// Stop 明确携带真实后台工作时，阻止前台 turn_duration 把整个任务提前结束。
pub(crate) fn hold_for_background_work(terminal_id: &str, session_id: &str, prompt_id: Option<&str>, occurred_at: i64) -> bool {
    if terminal_task_service::current_binding(terminal_id) != Some(("claude".to_string(), session_id.to_string())) { return false; }
    let key = PhaseKey { terminal_id: terminal_id.to_string(), provider: "claude".to_string(), session_id: session_id.to_string() };
    let mut current = lock_state();
    if !current.phases.note_claude_hook(key.clone(), "Stop", prompt_id, "running", occurred_at) { return false; }
    if let Some(entry) = current.phases.entries.get_mut(&key) { entry.background_pending = true; }
    true
}

/// 审批结束等场景：会话已 ended（或已换绑）时不把 running 写回去。
pub fn note_phase_unless_ended(terminal_id: &str, provider: &str, session_id: &str, phase: &str, occurred_at: i64) {
    match terminal_task_service::current_binding(terminal_id) {
        Some((bound_provider, bound_session)) if bound_provider == provider && bound_session == session_id => {}
        _ => return,
    }
    let key = PhaseKey {
        terminal_id: terminal_id.to_string(),
        provider: provider.to_string(),
        session_id: session_id.to_string(),
    };
    lock_state().phases.note_unless_ended(&key, phase, occurred_at);
}

/// 终端真正 teardown：发 terminal_closed、清理该终端全部 relay 状态。
/// `ended` 不调用这里——PTY 仍活着，只读镜像与 watcher 都保留。
/// 除 WS 直发外，传入 AppHandle 时同时经事件通道广播 error 帧，让桌面 / 浏览器
/// 事件租约立即进入只读终态而不是等下一次心跳。
pub fn on_terminal_closed(app: Option<&AppHandle>, terminal_id: &str) {
    let senders = lock_state().remove_terminal(terminal_id);
    let frame = TerminalAgentFrame::error(terminal_id, "terminal_closed", "终端已关闭");
    for sender in &senders {
        let _ = sender.try_send(frame.clone());
    }
    if let Some(app) = app {
        let _ = app.emit(AGENT_UPDATE_EVENT, frame);
    }
}

// ───────────────────────── watcher（每终端唯一） ─────────────────────────

enum TickAction {
    Continue,
    Stop,
}

/// watcher：订阅数 0→1 启动，归零 30 秒后停止。tick 检查绑定/文件/阶段/决策，
/// 复用 2 秒扫描缓存；帧只发给仍然授权的租约；`session_change_tx` 只是唤醒信号。
async fn run_watcher(app: AppHandle, terminal_id: String) {
    let mut session_rx = app.state::<TerminalService>().session_change_tx.subscribe();
    let mut tick = tokio::time::interval(WATCH_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            wake = session_rx.recv() => {
                if matches!(wake, Err(tokio::sync::broadcast::error::RecvError::Closed)) {
                    break;
                }
                // 广播仅唤醒：创建、改名、关闭都可能触发，不据此认定目标关闭。
            }
        }
        match watcher_tick(&app, &terminal_id).await {
            TickAction::Continue => continue,
            TickAction::Stop => break,
        }
    }
}

async fn watcher_tick(app: &AppHandle, terminal_id: &str) -> TickAction {
    let service = app.state::<TerminalService>();
    // 终端真正关闭才终止；phase=ended 保留只读 watcher。
    if service.terminal_owner(terminal_id).is_none() {
        on_terminal_closed(Some(app), terminal_id);
        return TickAction::Stop;
    }
    // 状态里已无句柄（on_terminal_closed 或回收）→ 自然退出。
    if !lock_state().watchers.contains_key(terminal_id) {
        return TickAction::Stop;
    }
    // 租约到期回收 + 幽灵租约回收（WS 升级失败/接收端已关闭）+ 失权移除。
    let leases: Vec<(String, TerminalActor, Option<tokio::sync::mpsc::Sender<TerminalAgentFrame>>)> = {
        let now = Instant::now();
        let mut current = lock_state();
        if let Some(entry) = current.mirrors.get_mut(terminal_id) {
            entry.last_access = now;
        }
        let Some(handle) = current.watchers.get_mut(terminal_id) else {
            return TickAction::Stop;
        };
        handle.leases.retain(|_, lease| {
            let not_expired = lease.expires.is_none_or(|expires| expires > now);
            // socket 租约无 TTL：接收端已关闭（WS 任务结束或升级从未完成）时回收。
            let alive = lease.sender.as_ref().is_none_or(|sender| !sender.is_closed());
            not_expired && alive
        });
        handle
            .leases
            .iter()
            .map(|(id, lease)| (id.clone(), lease.actor, lease.sender.clone()))
            .collect()
    };
    if leases.is_empty() {
        // 零租约：停留 30 秒后停止 watcher；移除前在同一锁内复查，
        // 避免把快照与移除之间新注册的租约误删。
        let stop = {
            let mut current = lock_state();
            let Some(handle) = current.watchers.get_mut(terminal_id) else {
                return TickAction::Stop;
            };
            if !handle.leases.is_empty() {
                handle.linger_since = None;
                false
            } else {
                let since = *handle.linger_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= WATCHER_LINGER {
                    current.watchers.remove(terminal_id);
                    true
                } else {
                    false
                }
            }
        };
        return if stop { TickAction::Stop } else { TickAction::Continue };
    }
    {
        let mut current = lock_state();
        if let Some(handle) = current.watchers.get_mut(terminal_id) {
            handle.linger_since = None;
        }
    }
    let mut has_valid = false;
    let mut removed_forbidden = Vec::new();
    for (subscription_id, actor, sender) in leases {
        match service.authorize(terminal_id, actor, TerminalAction::View) {
            Ok(()) => has_valid = true,
            Err(_) => removed_forbidden.push((subscription_id, sender)),
        }
    }
    if !removed_forbidden.is_empty() {
        let mut current = lock_state();
        if let Some(handle) = current.watchers.get_mut(terminal_id) {
            for (subscription_id, sender) in &removed_forbidden {
                handle.leases.remove(subscription_id);
                if let Some(sender) = sender {
                    let _ = sender.try_send(TerminalAgentFrame::error(terminal_id, "forbidden", "已无权查看该终端"));
                }
            }
        }
    }
    if !has_valid {
        return TickAction::Continue;
    }
    let app = app.clone();
    let terminal_id = terminal_id.to_string();
    let _ = crate::runtime::async_runtime::spawn_blocking(move || poll_and_deliver(&app, &terminal_id)).await;
    TickAction::Continue
}

/// poll + 分发（阻塞上下文）：watcher tick 与 REST/subscribe 驱动的 poll 共用，
/// 保证「提交即交付」——任何驱动方提交的新内容都会立即到达现有订阅者，
/// 不会出现 watcher 因 stamp 未变而永久漏发某段消息。
fn poll_and_deliver(app: &AppHandle, terminal_id: &str) {
    let scan = relay_scan(app);
    let content = poll_mirror(terminal_id, &scan);
    deliver_poll_result(app, terminal_id, &scan, &content);
}

/// 组帧并下发一次 poll 的结果。帧按身份分别组（canReply / replyBlockedReason
/// 随身份不同）经 WS 直发；慢消费者（有界队列满或已关闭）直接移除租约断开，
/// 由客户端以首帧重建（§4.5）。
fn deliver_poll_result(
    app: &AppHandle,
    terminal_id: &str,
    scan: &ScanData,
    content: &PollContent,
) {
    let Some(info) = find_terminal_info(app, terminal_id) else {
        return;
    };
    let leases: Vec<(String, TerminalActor, Option<tokio::sync::mpsc::Sender<TerminalAgentFrame>>)> = {
        let current = lock_state();
        match current.watchers.get(terminal_id) {
            Some(handle) => handle
                .leases
                .iter()
                .map(|(id, lease)| (id.clone(), lease.actor, lease.sender.clone()))
                .collect(),
            None => Vec::new(),
        }
    };
    if leases.is_empty() {
        housekeeping();
        return;
    }
    let actors: Vec<TerminalActor> = {
        let mut actors: Vec<TerminalActor> = leases.iter().map(|(_, actor, _)| *actor).collect();
        actors.sort_by_key(|actor| matches!(actor, TerminalActor::Pc));
        actors.dedup();
        actors
    };
    let mut slow_consumers: Vec<String> = Vec::new();
    for actor in actors {
        // 帧按身份分组下发：每个 actor 只收到自己视角的 session（跨身份
        // 采纳对方视角的 canReply/replyBlockedReason 会误导客户端）。
        let actor_leases: Vec<(String, Option<tokio::sync::mpsc::Sender<TerminalAgentFrame>>)> = leases
            .iter()
            .filter(|(_, lease_actor, _)| *lease_actor == actor)
            .map(|(id, _, sender)| (id.clone(), sender.clone()))
            .collect();
        let subscription_ids: Vec<String> = actor_leases.iter().map(|(id, _)| id.clone()).collect();
        let Some((session, _)) = build_session_meta(app, &info, &scan, actor) else {
            continue;
        };
        // 内容帧（mirror / append / rotated / unavailable）。
        let content_frame = match content {
            PollContent::None => None,
            PollContent::Append { revision, tail, total, truncated } => Some(TerminalAgentFrame::append(
                terminal_id,
                *revision,
                tail.clone(),
                *total,
                *truncated,
            )),
            PollContent::Page { kind, core } => {
                Some(TerminalAgentFrame::content(kind, terminal_id, session.clone(), core))
            }
            PollContent::Unavailable { reason } => {
                // 帧的 reason 与 session.mirror.reason 同源；显式采用 poll 结果。
                let mut frame = TerminalAgentFrame::unavailable(terminal_id, session.clone());
                frame.reason = Some(reason.clone());
                Some(frame)
            }
        };
        let mut frames = Vec::new();
        if let Some(frame) = content_frame {
            frames.push(frame);
        }
        // status 帧：内容帧未携带元数据且元数据有变化时发送。
        let meta_changed = {
            let current = lock_state();
            current
                .watchers
                .get(terminal_id)
                .is_some_and(|handle| handle.last_meta.get(&actor) != Some(&session))
        };
        if meta_changed {
            frames.push(TerminalAgentFrame::status(terminal_id, session.clone()));
        }
        {
            let mut current = lock_state();
            if let Some(handle) = current.watchers.get_mut(terminal_id) {
                handle.last_meta.insert(actor, session);
            }
        }
        for mut frame in frames {
            for (lease_id, sender) in &actor_leases {
                let Some(sender) = sender else { continue };
                if sender.try_send(frame.clone()).is_err() {
                    // 队列满或接收端已关闭：断开慢消费者，客户端以首帧重建。
                    slow_consumers.push(lease_id.clone());
                }
            }
            // 事件通道附带本帧发往的租约，桌面 / 浏览器按自己的句柄过滤。
            frame.subscription_ids = subscription_ids.clone();
            let _ = app.emit(AGENT_UPDATE_EVENT, frame);
        }
    }
    if !slow_consumers.is_empty() {
        let mut current = lock_state();
        if let Some(handle) = current.watchers.get_mut(terminal_id) {
            for lease_id in &slow_consumers {
                handle.leases.remove(lease_id);
            }
        }
    }
    // 顺手做轻量回收（map 均很小）。
    housekeeping();
}

/// 镜像缓存 30 分钟无人访问清理；阶段表/幂等表按各自 TTL 与上限淘汰。
fn housekeeping() {
    let mut current = lock_state();
    let now = Instant::now();
    current.mirrors.retain(|_, entry| now - entry.last_access < MIRROR_IDLE_EVICT);
    current.phases.prune_expired();
}

// ───────────────────────── 纯函数：回复闸门链（第 2–7 条，可单测） ─────────────────────────

pub(crate) struct ReplyGateContext<'a> {
    /// 当前绑定 (provider, sessionId)；None 即第 2 条失败。
    pub binding: Option<&'a (String, String)>,
    /// relay 镜像缓存身份；与当前绑定不一致表示换绑后未刷新。
    pub mirror_identity: Option<&'a (String, String)>,
    /// 该终端待决策 id（按 occurredAt 升序）。
    pub pending: &'a [String],
    pub phase: &'a str,
    pub phase_at: Option<i64>,
    pub text: &'a str,
    pub request_id: &'a str,
    pub terminal_id: &'a str,
    pub actor_web: bool,
}

pub(crate) enum GateOutcome {
    /// 全部闸门通过，执行 PTY 写入。
    Write,
    /// 幂等命中（已成功写入的同键同文本）。
    Duplicated,
    Rejected(RelayError),
}

/// 第 2–7 条闸门（第 1 条授权与 PTY 写入由调用方处理）。
/// 返回 Rejected 时 writer 一次都不能被调用。
pub(crate) fn evaluate_reply_gates(
    context: ReplyGateContext<'_>,
    ledger: &ReplyLedger,
    last_success: Option<Instant>,
) -> GateOutcome {
    let reject_conflict = |message: String| GateOutcome::Rejected(RelayError::Conflict {
        message,
        decision_id: None,
        reply_blocked_reason: None,
    });
    // 第 2 条：存在当前 agent 绑定，且 relay 快照身份一致。
    let Some(binding) = context.binding else {
        return reject_conflict("该终端没有正在运行的 Agent".to_string());
    };
    if let Some(identity) = context.mirror_identity {
        if identity != binding {
            return reject_conflict("会话已切换，请刷新后再试".to_string());
        }
    }
    // 第 3 条：无待决策且 phase != attention。
    if let Some(decision_id) = context.pending.first() {
        return GateOutcome::Rejected(RelayError::Conflict {
            message: "有待确认的决策，请先处理后再回复".to_string(),
            decision_id: Some(decision_id.clone()),
            reply_blocked_reason: None,
        });
    }
    if context.phase == "attention" {
        return reject_conflict("Agent 正在等待终端内确认，请打开终端处理当前确认".to_string());
    }
    // 第 4 条：requestId 幂等。
    let key = RequestKey {
        actor_web: context.actor_web,
        terminal_id: context.terminal_id.to_string(),
        request_id: context.request_id.to_string(),
    };
    let normalized = context.text.trim().to_string();
    match (ledger.check(&key, &normalized), ledger.status_of(&key)) {
        (LedgerCheck::Duplicated, Some(LedgerStatus::Completed)) => return GateOutcome::Duplicated,
        (LedgerCheck::Duplicated, _) => {
            return reject_conflict(
                "终端写入结果未知，请打开终端确认；如未生效请用新的 requestId 重新发送".to_string(),
            )
        }
        (LedgerCheck::Mismatch, _) => {
            return reject_conflict("同一 requestId 已用于其他回复内容".to_string());
        }
        (LedgerCheck::Fresh, _) => {}
    }
    // 第 5 条：文本规则。
    if let Err(reason) = validate_reply_text(context.text) {
        return GateOutcome::Rejected(RelayError::BadRequest(reason));
    }
    // 第 6 条：同终端 3 秒内最多 1 条（monotonic；Retry-After 向上取整）。
    if let Some(last) = last_success {
        if let Some(deadline) = last.checked_add(REPLY_COOLDOWN) {
            let now = Instant::now();
            if deadline > now {
                let seconds = ((deadline - now).as_millis() as u64 + 999) / 1000;
                let seconds = seconds.max(1);
                return GateOutcome::Rejected(RelayError::TooManyRequests {
                    message: format!("回复过于频繁，请 {seconds} 秒后再试"),
                    retry_after_secs: seconds,
                });
            }
        }
    }
    // 第 7 条：阶段存活。
    if let Err(reason) = phase_allows_reply(context.phase, context.phase_at, now_ms()) {
        return GateOutcome::Rejected(RelayError::Conflict {
            message: reason.clone(),
            decision_id: None,
            reply_blocked_reason: Some(reason),
        });
    }
    GateOutcome::Write
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::session_history::SessionReplayTool;
    use serde_json::json;
    use std::fs;

    fn message(seq: i64, role: &str, text: &str) -> SessionReplayMessage {
        SessionReplayMessage {
            seq,
            role: role.to_string(),
            timestamp: None,
            text: text.to_string(),
            tools: Vec::new(),
            tool_name: None,
            skill_name: None,
        }
    }

    fn baseline(messages: Vec<SessionReplayMessage>) -> MirrorBaseline {
        let total = messages.len() as i64;
        MirrorBaseline { messages, total, truncated: false }
    }

    // ── 半行 JSONL：只读到最后换行 ──

    #[test]
    fn half_written_line_never_enters_the_parser() {
        let dir = std::env::temp_dir().join(format!("tb-relay-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("half.jsonl");
        // 先写一行完整 + 半行，然后补全：补全后才应出现第二条。
        fs::write(&path, "{\"type\":\"a\"}\n{\"type\":").unwrap();
        let first = read_transcript_stable(&path);
        let TranscriptRead::Ok { content, .. } = first else {
            panic!("稳定文件应读取成功");
        };
        assert_eq!(content, "{\"type\":\"a\"}\n", "半行不得进入解析器");
        fs::write(&path, "{\"type\":\"a\"}\n{\"type\":\"b\"}\n").unwrap();
        let TranscriptRead::Ok { content, .. } = read_transcript_stable(&path) else {
            panic!("应读取成功");
        };
        assert_eq!(content, "{\"type\":\"a\"}\n{\"type\":\"b\"}\n");
        // 重复读取同一损坏文件不会导致 revision 振荡：内容稳定即结果稳定。
        let TranscriptRead::Ok { content: again, .. } = read_transcript_stable(&path) else {
            panic!("应读取成功");
        };
        assert_eq!(content, again);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unreadable_and_oversize_transcripts_degrade_instead_of_allocating() {
        let dir = std::env::temp_dir().join(format!("tb-relay-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing.jsonl");
        assert!(matches!(read_transcript_stable(&missing), TranscriptRead::Unreadable));
        // 非法 UTF-8：严格读取失败，不做 lossy 转换。
        let invalid = dir.join("invalid.jsonl");
        fs::write(&invalid, b"\xff\xfe\n").unwrap();
        assert!(matches!(read_transcript_stable(&invalid), TranscriptRead::Unreadable));
        fs::remove_dir_all(&dir).ok();
    }

    // ── Claude 追加：seq 空洞保留，纯尾部新增为 append ──

    #[test]
    fn claude_append_with_seq_holes_is_append_and_cursor_is_last_seq() {
        // assistant 空文本行消耗 seq 但不产出消息 → seq 0,2 有消息，1 是空洞。
        let old_content = concat!(
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"第一问\"}]}}\n",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"   \"}]}}\n",
            "{\"type\":\"user\",\"message\":{\"content\":\"继续\"}}\n",
        );
        let old_messages = super::super::claude_history_service::parse_replay_messages(old_content);
        assert_eq!(old_messages.len(), 2);
        assert_eq!(old_messages[1].seq, 2, "空洞之后的 seq 应保留编号");
        let old = baseline(old_messages.clone());
        let new_content = format!(
            "{old_content}{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"收到\"}}]}}}}\n"
        );
        let new_messages = super::super::claude_history_service::parse_replay_messages(&new_content);
        assert_eq!(new_messages.len(), 3);
        // 纯尾部新增：append；cursor 是最后 seq（3），不是 total（3 恰好相等，改用含空洞断言）。
        assert_eq!(diff_content(&old, &new_messages, new_messages.len() as i64, false), ContentDiff::Append);
        let core = TailCore::incremental(&MirrorBaseline { messages: new_messages.clone(), total: 3, truncated: false }, 1, -1, 200);
        assert_eq!(core.cursor, 3);
        assert_eq!(core.messages.len(), 3);
        assert!(!core.has_more);
    }

    // ── Codex 去重重排：event 后出现 canonical response_item，total 不变也 rotated ──

    #[test]
    fn codex_dedup_reorder_rotates_even_when_total_is_unchanged() {
        // 场景（§4.3）：旧文件只有 event_msg(user x) + assistant 回复；
        // 追加对应 canonical response_item(user x) 后，event 被去重、canonical
        // 按行号排到末尾 → 可见顺序重排，total 不变也必须 rotated。
        let event_line = json!({"type":"event_msg","payload":{"type":"user_message","message":"修复登录"}});
        let reply_line = json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":"已修复"}});
        let canonical_line = json!({"type":"response_item","payload":{"type":"message","role":"user","content":"修复登录"}});
        let with_event = format!("{event_line}\n{reply_line}\n");
        let with_canonical = format!("{event_line}\n{reply_line}\n{canonical_line}\n");
        let old_messages = super::super::codex_transcript::parse(&with_event).messages;
        let new_messages = super::super::codex_transcript::parse(&with_canonical).messages;
        assert_eq!(old_messages.len(), new_messages.len(), "去重后条数不变");
        assert_eq!(old_messages[0].role, "user");
        assert_eq!(new_messages[0].role, "assistant", "canonical 被排到末尾：可见顺序已重排");
        let old = baseline(old_messages);
        assert_eq!(
            diff_content(&old, &new_messages, new_messages.len() as i64, false),
            ContentDiff::Rotated
        );
    }

    // ── 完整消息 diff：timestamp / tools / toolName 任一变化均 rotated ──

    #[test]
    fn full_message_comparison_covers_timestamp_tools_and_tool_name() {
        let old = baseline(vec![SessionReplayMessage {
            seq: 0,
            role: "assistant".to_string(),
            timestamp: Some(1000),
            text: "内容".to_string(),
            tools: vec![SessionReplayTool { name: "Bash".to_string(), summary: "ls".to_string() }],
            tool_name: None,
            skill_name: None,
        }]);
        let changed_timestamp = vec![SessionReplayMessage {
            seq: 0,
            role: "assistant".to_string(),
            timestamp: Some(2000),
            text: "内容".to_string(),
            tools: vec![SessionReplayTool { name: "Bash".to_string(), summary: "ls".to_string() }],
            tool_name: None,
            skill_name: None,
        }];
        assert_eq!(diff_content(&old, &changed_timestamp, 1, false), ContentDiff::Rotated);
        let changed_tools = vec![SessionReplayMessage {
            seq: 0,
            role: "assistant".to_string(),
            timestamp: Some(1000),
            text: "内容".to_string(),
            tools: vec![SessionReplayTool { name: "Bash".to_string(), summary: "pwd".to_string() }],
            tool_name: None,
            skill_name: None,
        }];
        assert_eq!(diff_content(&old, &changed_tools, 1, false), ContentDiff::Rotated);
        let changed_tool_name = vec![SessionReplayMessage {
            seq: 0,
            role: "tool".to_string(),
            timestamp: Some(1000),
            text: "内容".to_string(),
            tools: Vec::new(),
            tool_name: Some("Read".to_string()),
            skill_name: None,
        }];
        assert_eq!(diff_content(&old, &changed_tool_name, 1, false), ContentDiff::Rotated);
        // total 变小 → rotated。
        assert_eq!(diff_content(&old, &[], 0, false), ContentDiff::Rotated);
    }

    // ── 分页与截断 ──

    #[test]
    fn incremental_pages_take_earliest_limit_and_can_catch_up() {
        let messages: Vec<SessionReplayMessage> = (0..10).map(|seq| message(seq, "user", &format!("m{seq}"))).collect();
        let view = MirrorBaseline { messages: messages.clone(), total: 10, truncated: false };
        let page1 = TailCore::incremental(&view, 1, -1, 3);
        assert_eq!(page1.messages.iter().map(|m| m.seq).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert!(page1.has_more);
        assert_eq!(page1.next_cursor, 2);
        let page2 = TailCore::incremental(&view, 1, 2, 3);
        assert_eq!(page2.messages.iter().map(|m| m.seq).collect::<Vec<_>>(), vec![3, 4, 5]);
        let last = TailCore::incremental(&view, 1, 9, 3);
        assert!(last.messages.is_empty());
        assert!(!last.has_more);
        assert_eq!(last.cursor, 9, "空增量页保留请求游标");
        // N 超过当前最大 seq：revision 相同时是未追平的空增量页，不 reset。
        assert!(!incremental_requires_reset(&view, 1, 99, Some(1)));
        // revision 不同 → reset。
        assert!(incremental_requires_reset(&view, 2, 0, Some(1)));
    }

    #[test]
    fn truncated_window_beyond_request_cursor_requires_reset() {
        let mut messages: Vec<SessionReplayMessage> = (0..600).map(|seq| message(seq, "user", "m")).collect();
        messages.drain(..100); // 只保留 100..599（模拟截断窗口）
        let view = MirrorBaseline { messages, total: 600, truncated: true };
        assert!(incremental_requires_reset(&view, 1, 50, Some(1)), "游标在窗口之前必须 reset");
        assert!(!incremental_requires_reset(&view, 1, 150, Some(1)));
        // 截断基线的变化永远是整页 mirror，不伪造 append。
        let same = view.messages.clone();
        assert_eq!(diff_content(&view, &same, 600, true), ContentDiff::Unchanged);
        let mut slid = view.messages.clone();
        slid.push(message(600, "user", "m"));
        assert_eq!(diff_content(&view, &slid, 601, true), ContentDiff::Mirror);
    }

    #[test]
    fn parse_retention_keeps_tail_window_and_reports_full_total() {
        // >5000 条触发保留窗口：total 是完整解析数，只保留尾部 500 条。
        let content = (0..5200)
            .map(|index| json!({"type":"event_msg","payload":{"type":"user_message","message": format!("m{index}")}}).to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let (messages, total, truncated) = parse_and_retain("codex", &content);
        assert_eq!(total, 5200);
        assert_eq!(messages.len(), RETAIN_TAIL);
        assert!(truncated);
        assert_eq!(messages.last().unwrap().text, "m5199");
    }

    // ── 回复闸门（第 2–7 条逐条覆盖；拒绝时 writer 一次都不调用） ──

    #[test]
    fn transcript_completion_requires_a_finished_main_turn() {
        let answer = json!({"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"完成"}]}}).to_string();
        // 最终正文和 thinking 的 end_turn 都不等同于 Stop hooks 已结束。
        assert_eq!(claude_turn_end(&answer), None);
        let done = json!({"type":"system","subtype":"turn_duration","timestamp":"2026-11-06T07:44:36.778Z"}).to_string();
        let completed = format!("{answer}\n{done}\n");
        let at = chrono::DateTime::parse_from_rfc3339("2026-11-06T07:44:36.778Z").unwrap().timestamp_millis();
        assert_eq!(claude_turn_end(&completed), Some(ClaudeTurnEnd::Completed(at)));
        // 元数据与子会话的后续写入不改变主会话完成状态。
        let sidechain = json!({"type":"user","isSidechain":true,"message":{"content":"子任务"}});
        assert_eq!(claude_turn_end(&format!("{completed}{{broken\n{sidechain}")), Some(ClaudeTurnEnd::Completed(at)));
        for row in [
            json!({"type":"user","message":{"content":"继续"}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"结果"}]}}),
            json!({"type":"api-request"}),
        ] {
            assert_eq!(claude_turn_end(&format!("{completed}{row}")), None);
        }
    }

    #[test]
    fn settled_claude_turn_rejects_late_heartbeats_and_old_prompt_events() {
        let key = PhaseKey { terminal_id: "terminal".into(), provider: "claude".into(), session_id: "session".into() };
        for (event, phase) in [("Stop", "completed"), ("StopFailure", "failed"), ("TranscriptTurnInterrupted", "idle")] {
            let mut table = PhaseTable::default();
            assert!(table.note_claude_hook(key.clone(), "UserPromptSubmit", Some("first"), "running", 100));
            assert!(table.note_claude_hook(key.clone(), event, Some("first"), phase, 200));
            for prompt in [Some("first"), None] {
                assert!(!table.note_claude_hook(key.clone(), "PreToolUse", prompt, "running", 250));
                assert!(!table.note_claude_hook(key.clone(), "Notification", prompt, "attention", 260));
            }
            assert!(!table.note_claude_hook(key.clone(), "UserPromptSubmit", Some("first"), "running", 270));
            assert_eq!(table.current("terminal", "claude", "session"), Some((phase.into(), 200)));
            // 真正的新输入仍正常执行；旧回合的工具和完成事件不能污染新回合。
            assert!(table.note_claude_hook(key.clone(), "UserPromptSubmit", Some("second"), "running", 300));
            assert!(!table.note_claude_hook(key.clone(), "PreToolUse", Some("first"), "running", 350));
            assert!(!table.note_claude_hook(key.clone(), "Stop", Some("first"), "completed", 360));
            assert!(table.note_claude_hook(key.clone(), "PreToolUse", Some("second"), "running", 400));
            assert_eq!(table.entries[&key].prompt_started_at, Some(300));
        }
        // 兼容不提供 prompt_id 的旧版 Claude：下一次真实输入仍能启动回合。
        let mut table = PhaseTable::default();
        assert!(table.note_claude_hook(key.clone(), "UserPromptSubmit", None, "running", 100));
        assert!(table.note_claude_hook(key.clone(), "Stop", None, "completed", 200));
        assert!(!table.note_claude_hook(key.clone(), "PreToolUse", None, "running", 250));
        assert!(table.note_claude_hook(key, "UserPromptSubmit", None, "running", 300));
    }

    #[test]
    fn transcript_end_uses_prompt_start_and_broadcasts_after_late_heartbeat() {
        let key = PhaseKey { terminal_id: "terminal".into(), provider: "claude".into(), session_id: "session".into() };
        let mut table = PhaseTable::default();
        table.note_claude_hook(key.clone(), "UserPromptSubmit", Some("first"), "running", 100);
        table.note_claude_hook(key.clone(), "PreToolUse", Some("first"), "running", 300);
        // 转录 200 已结束、心跳 300 才到达：仍须结算，并让前端接受纠正事件。
        assert!(table.settle_from_transcript(&key, ClaudeTurnEnd::Completed(200)));
        assert_eq!(table.current("terminal", "claude", "session"), Some(("completed".into(), 301)));
        table.note_claude_hook(key.clone(), "UserPromptSubmit", Some("second"), "running", 400);
        assert!(!table.settle_from_transcript(&key, ClaudeTurnEnd::Completed(200)), "旧结束记录不能关闭新输入");
        table.note_claude_hook(key.clone(), "PreToolUse", Some("second"), "running", 500);
        table.entries.get_mut(&key).unwrap().background_pending = true;
        assert!(!table.settle_from_transcript(&key, ClaudeTurnEnd::Completed(450)), "保留真实后台任务");
        assert!(table.settle_from_transcript(&key, ClaudeTurnEnd::Interrupted(450)));
        assert_eq!(table.current("terminal", "claude", "session"), Some(("idle".into(), 501)));
    }

    #[test]
    fn transcript_interrupt_is_idle_until_the_next_main_turn() {
        let timestamp = "2026-11-09T05:59:26.509Z";
        let at = chrono::DateTime::parse_from_rfc3339(timestamp).unwrap().timestamp_millis();
        for text in ["[Request interrupted by user]", "[Request interrupted by user for tool use]"] {
            for content in [json!(text), json!([{"type":"text","text":text}])] {
                let interrupted = json!({"type":"user","timestamp":timestamp,"message":{"content":content}}).to_string();
                let expected = Some(ClaudeTurnEnd::Interrupted(at));
                assert_eq!(claude_turn_end(&interrupted), expected);
                // Claude 可能继续写耗时和离开摘要，它们都不代表任务成功或开始了新回合。
                let metadata = json!({"type":"system","subtype":"away_summary"});
                let duration = json!({"type":"system","subtype":"turn_duration","timestamp":timestamp});
                assert_eq!(claude_turn_end(&format!("{interrupted}\n{duration}\n{metadata}")), expected);
                for next in [
                    json!({"type":"user","message":{"content":"继续"}}),
                    json!({"type":"assistant","message":{"content":"继续执行"}}),
                    json!({"type":"api-request"}),
                ] {
                    assert_eq!(claude_turn_end(&format!("{interrupted}\n{next}")), None);
                }
            }
            for row in [
                json!({"type":"user","isSidechain":true,"timestamp":timestamp,"message":{"content":text}}),
                json!({"type":"user","is_sidechain":true,"timestamp":timestamp,"message":{"content":text}}),
                json!({"type":"assistant","timestamp":timestamp,"message":{"content":text}}),
                json!({"type":"user","timestamp":timestamp,"message":{"content":[{"type":"tool_result","content":text}]}}),
                json!({"type":"user","timestamp":timestamp,"message":{"content":format!("请解释 {text}")}}),
            ] {
                assert_eq!(claude_turn_end(&row.to_string()), None, "不能把引用或子任务当成主回合中断");
            }
        }
    }

    #[test]
    fn transcript_interrupt_settles_only_the_older_active_turn() {
        let key = PhaseKey { terminal_id: "terminal".into(), provider: "claude".into(), session_id: "session".into() };
        let mut table = PhaseTable::default();
        for phase in ["running", "attention"] {
            table.note(key.clone(), phase, 100);
            table.entries.get_mut(&key).unwrap().background_pending = true;
            assert!(table.settle_from_transcript(&key, ClaudeTurnEnd::Interrupted(200)));
            assert_eq!(table.current("terminal", "claude", "session"), Some(("idle".into(), 200)));
            assert!(!table.entries[&key].background_pending);
            assert!(!table.settle_from_transcript(&key, ClaudeTurnEnd::Interrupted(200)), "中断只结算一次");
        }
        table.note(key.clone(), "running", 300);
        assert!(!table.settle_from_transcript(&key, ClaudeTurnEnd::Interrupted(200)), "旧中断不能结束新输入");
        for phase in ["failed", "ended", "completed"] {
            table.note(key.clone(), phase, 100);
            assert!(!table.settle_from_transcript(&key, ClaudeTurnEnd::Interrupted(200)));
        }
    }

    #[test]
    fn transcript_completion_preserves_newer_work_and_background_tasks() {
        let key = PhaseKey { terminal_id: "terminal".into(), provider: "claude".into(), session_id: "session".into() };
        let mut table = PhaseTable::default();
        table.note(key.clone(), "running", 100);
        assert!(table.settle_from_transcript(&key, ClaudeTurnEnd::Completed(200)));
        assert!(!table.settle_from_transcript(&key, ClaudeTurnEnd::Completed(200)), "同一回合只补发一次完成事件");
        table.note(key.clone(), "running", 300);
        assert!(!table.settle_from_transcript(&key, ClaudeTurnEnd::Completed(200)), "旧回合不能结束新输入");
        table.entries.get_mut(&key).unwrap().background_pending = true;
        assert!(!table.settle_from_transcript(&key, ClaudeTurnEnd::Completed(400)), "真实后台任务保持执行中");
        table.note(key.clone(), "completed", 500);
        table.note(key.clone(), "running", 600);
        assert!(table.settle_from_transcript(&key, ClaudeTurnEnd::Completed(700)), "后续正常回合可再次完成");
        for phase in ["attention", "failed", "ended"] {
            table.note(key.clone(), phase, 800);
            assert!(!table.settle_from_transcript(&key, ClaudeTurnEnd::Completed(900)));
        }
    }

    /// 没有明确结束标记时沿用尾条推断：用户消息 → running，其余 → idle。
    #[test]
    fn inferred_phase_follows_last_mirror_message() {
        let entry = |messages: Vec<SessionReplayMessage>| MirrorEntry {
            provider: "claude".to_string(),
            session_id: "s".to_string(),
            path: None,
            revision: 1,
            available: true,
            reason: None,
            messages,
            total: 0,
            truncated: false,
            file_stamp: None,
            turn_end: None,
            last_access: Instant::now(),
        };
        let (phase, at) = inferred_phase(None);
        assert_eq!((phase.as_str(), at), ("idle", None));
        let (phase, at) = inferred_phase(Some(&entry(vec![])));
        assert_eq!((phase.as_str(), at), ("idle", None));
        let mut last_user = message(1, "assistant", "答");
        last_user.timestamp = Some(111);
        let mut tail = message(2, "user", "问");
        tail.timestamp = Some(222);
        let (phase, at) = inferred_phase(Some(&entry(vec![last_user.clone(), tail.clone()])));
        assert_eq!((phase.as_str(), at), ("running", Some(222)));
        let (phase, at) = inferred_phase(Some(&entry(vec![tail.clone(), last_user])));
        assert_eq!((phase.as_str(), at), ("idle", Some(111)));
        // 镜像不可用（transcript 读不到）时仍给出可回复的 idle，不阻断。
        let mut unavailable = entry(vec![tail]);
        unavailable.available = false;
        let (phase, _) = inferred_phase(Some(&unavailable));
        assert_eq!(phase, "idle");
    }

    fn gate_context<'a>(
        binding: Option<&'a (String, String)>,
        pending: &'a [String],
        phase: &'a str,
        text: &'a str,
    ) -> ReplyGateContext<'a> {
        ReplyGateContext {
            binding,
            mirror_identity: binding,
            pending,
            phase,
            phase_at: Some(now_ms()),
            text,
            request_id: "req-1234_abcd",
            terminal_id: "terminal-gate-test",
            actor_web: false,
        }
    }

    #[test]
    fn reply_gates_reject_each_failure_without_writing() {
        let binding = ("claude".to_string(), "3f2c".to_string());
        let no_pending: Vec<String> = Vec::new();
        let ledger = ReplyLedger::default();

        // 第 2 条：无绑定。
        let outcome = evaluate_reply_gates(gate_context(None, &no_pending, "running", "正常回复"), &ledger, None);
        assert!(matches!(outcome, GateOutcome::Rejected(ref error) if matches!(error, RelayError::Conflict { .. })));
        // 第 2 条：换绑未刷新。
        let stale = ("claude".to_string(), "aaaa".to_string());
        let identity = ("claude".to_string(), "3f2c".to_string());
        let outcome = evaluate_reply_gates(
            ReplyGateContext { binding: Some(&binding), mirror_identity: Some(&stale), ..gate_context(Some(&binding), &no_pending, "running", "正常回复") },
            &ledger,
            None,
        );
        assert!(matches!(outcome, GateOutcome::Rejected(ref error) if error.message().contains("会话已切换")));
        let _ = identity;
        // 第 3 条：有待决策 → 带 decisionId。
        let pending = vec!["decision-1".to_string()];
        let outcome = evaluate_reply_gates(gate_context(Some(&binding), &pending, "running", "正常回复"), &ledger, None);
        match outcome {
            GateOutcome::Rejected(error) => {
                assert_eq!(error.decision_id().as_deref(), Some("decision-1"));
            }
            _ => panic!("有待决策必须拒绝"),
        }
        // 第 3 条：无卡片 attention。
        let outcome = evaluate_reply_gates(gate_context(Some(&binding), &no_pending, "attention", "正常回复"), &ledger, None);
        assert!(matches!(outcome, GateOutcome::Rejected(ref error) if error.message().contains("打开终端")));
        // 第 5 条：控制字符。
        let outcome = evaluate_reply_gates(gate_context(Some(&binding), &no_pending, "running", "好的\x03"), &ledger, None);
        assert!(matches!(outcome, GateOutcome::Rejected(RelayError::BadRequest(_))));
        // 第 7 条：unknown 放行（绑定存在即进程存活，无 Hook 不再禁回）。
        let outcome = evaluate_reply_gates(gate_context(Some(&binding), &no_pending, "unknown", "正常回复"), &ledger, None);
        assert!(matches!(outcome, GateOutcome::Write));
        // 第 7 条：推断路径 idle 无时间戳（phaseAt 缺失）同样放行。
        let outcome = evaluate_reply_gates(
            ReplyGateContext { phase_at: None, ..gate_context(Some(&binding), &no_pending, "idle", "正常回复") },
            &ledger,
            None,
        );
        assert!(matches!(outcome, GateOutcome::Write));
        // 第 7 条：ended。
        let outcome = evaluate_reply_gates(gate_context(Some(&binding), &no_pending, "ended", "正常回复"), &ledger, None);
        assert!(matches!(outcome, GateOutcome::Rejected(_)));
        // 第 7 条：idle 超过 24 小时。
        let outcome = evaluate_reply_gates(
            ReplyGateContext { phase_at: Some(now_ms() - IDLE_PHASE_MAX_AGE_MS - 1), ..gate_context(Some(&binding), &no_pending, "idle", "正常回复") },
            &ledger,
            None,
        );
        assert!(matches!(outcome, GateOutcome::Rejected(_)));
        // 全部通过 → Write。
        let outcome = evaluate_reply_gates(gate_context(Some(&binding), &no_pending, "running", "正常回复"), &ledger, None);
        assert!(matches!(outcome, GateOutcome::Write));
    }

    #[test]
    fn reply_rate_limit_uses_ceiled_retry_after_on_monotonic_clock() {
        let binding = ("claude".to_string(), "s".to_string());
        let no_pending: Vec<String> = Vec::new();
        let ledger = ReplyLedger::default();
        let outcome = evaluate_reply_gates(
            gate_context(Some(&binding), &no_pending, "running", "正常回复"),
            &ledger,
            Some(Instant::now()),
        );
        match outcome {
            GateOutcome::Rejected(RelayError::TooManyRequests { retry_after_secs, .. }) => {
                assert!(retry_after_secs >= 1 && retry_after_secs <= 3);
            }
            _ => panic!("3 秒内重复回复必须 429"),
        }
        // 冷却结束放行。
        let outcome = evaluate_reply_gates(
            gate_context(Some(&binding), &no_pending, "running", "正常回复"),
            &ledger,
            Some(Instant::now() - REPLY_COOLDOWN - Duration::from_millis(10)),
        );
        assert!(matches!(outcome, GateOutcome::Write));
    }

    #[test]
    fn reply_idempotency_same_key_same_text_vs_different_text() {
        let binding = ("claude".to_string(), "s".to_string());
        let no_pending: Vec<String> = Vec::new();
        let mut ledger = ReplyLedger::default();
        let context = gate_context(Some(&binding), &no_pending, "running", "先跳过测试");
        let key = RequestKey {
            actor_web: false,
            terminal_id: context.terminal_id.to_string(),
            request_id: context.request_id.to_string(),
        };
        // 首次：Fresh → Write；记录成功后同键同文本 → Duplicated。
        assert!(matches!(evaluate_reply_gates(gate_context(Some(&binding), &no_pending, "running", "先跳过测试"), &ledger, None), GateOutcome::Write));
        ledger.record(key.clone(), "先跳过测试", LedgerStatus::Completed);
        assert!(matches!(evaluate_reply_gates(gate_context(Some(&binding), &no_pending, "running", "先跳过测试"), &ledger, None), GateOutcome::Duplicated));
        // 同键不同文本 → 409。
        let outcome = evaluate_reply_gates(gate_context(Some(&binding), &no_pending, "running", "别的文本"), &ledger, None);
        assert!(matches!(outcome, GateOutcome::Rejected(ref error) if matches!(error, RelayError::Conflict { .. })));
        // 写入结果未知：重放同一键返回同一未知结果，绝不能返回 duplicated 成功。
        ledger.record(key.clone(), "结果未知文本", LedgerStatus::Unknown);
        let outcome = evaluate_reply_gates(
            ReplyGateContext { text: "结果未知文本", ..gate_context(Some(&binding), &no_pending, "running", "结果未知文本") },
            &ledger,
            None,
        );
        assert!(matches!(outcome, GateOutcome::Rejected(ref error) if error.message().contains("结果未知")));
    }

    // ── 控制字符 ──

    #[test]
    fn reply_text_rules_reject_controls_and_commands_but_allow_unicode() {
        for bad in ["\x03", "\t", "\x7f", "a\rb", "/斜杠", "!bang", "@提及", "#标签", "  "] {
            assert!(validate_reply_text(bad).is_err(), "应拒绝：{bad:?}");
        }
        assert!(validate_reply_text("先跳过这个测试，直接修登录超时").is_ok());
        assert!(validate_reply_text("emoji 🎉 与中文").is_ok());
        assert!(validate_reply_text("第一行\n第二行").is_ok());
        assert!(validate_reply_text(&"长".repeat(2000)).is_ok());
        assert!(validate_reply_text(&"长".repeat(2001)).is_err());
        assert!(valid_request_id("0f1c9d2e-3b4a"));
        assert!(!valid_request_id("short"));
        assert!(!valid_request_id(""));
        assert!(!valid_request_id(&"x".repeat(65)));
        assert!(!valid_request_id("带空格 的键"));
    }

    #[test]
    fn reply_payload_defers_submit_to_separate_write() {
        // 文本载荷不再携带回车：提交键由调用方停顿后单独写入，
        // 否则长文本与 "\r" 同批到达会被 TUI 当成粘贴吞掉回车。
        assert_eq!(reply_payload("正常回复"), "正常回复");
        assert_eq!(reply_payload("第一行\n第二行"), "\x1b[200~第一行\n第二行\x1b[201~");
        assert!(!reply_payload("第一行\n第二行").contains('\r'));
    }

    // ── 阶段身份：旧 sessionId 的延迟事件不污染新会话；ended 不被审批完成覆盖 ──

    /// record_agent_session 只对已 tracked 的终端生效：先经 prepare_launch 建条目。
    fn seed_tracked(terminal_id: &str) {
        super::super::terminal_task_service::prepare_launch(terminal_id, "cmd", None, &[], Vec::new());
    }

    #[test]
    fn phase_events_are_scoped_by_binding_identity() {
        let terminal_id = format!("relay-phase-{}", uuid::Uuid::new_v4());
        let session = "01900000-0000-7000-8000-0000000000aa";
        seed_tracked(&terminal_id);
        super::super::terminal_task_service::record_agent_session(&terminal_id, "codex", session, None, true);
        note_phase(&terminal_id, "codex", session, "running", 100);
        // 旧会话延迟 SessionEnd：绑定已换，不得写新会话阶段。
        let old_session = "01900000-0000-7000-8000-0000000000bb";
        note_phase(&terminal_id, "codex", old_session, "ended", 200);
        let phases = lock_state();
        let current = phases.phases.current(&terminal_id, "codex", session);
        drop(phases);
        assert_eq!(current.as_ref().map(|(phase, _)| phase.as_str()), Some("running"));
        // ended 粘滞：审批完成不得把 ended 覆盖成 running。
        note_phase(&terminal_id, "codex", session, "ended", 300);
        note_phase_unless_ended(&terminal_id, "codex", session, "running", 400);
        let phases = lock_state();
        assert_eq!(
            phases.phases.current(&terminal_id, "codex", session).as_ref().map(|(phase, _)| phase.as_str()),
            Some("ended")
        );
        drop(phases);
        super::super::terminal_task_service::forget_terminal(&terminal_id);
    }

    #[test]
    fn phase_table_prunes_by_retention_and_cap() {
        let mut table = PhaseTable::default();
        for index in 0..(PHASE_CAP + 50) {
            table.note(
                PhaseKey {
                    terminal_id: format!("t{index}"),
                    provider: "claude".to_string(),
                    session_id: format!("s{index}"),
                },
                "running",
                index as i64,
            );
        }
        assert!(table.entries.len() <= PHASE_CAP * 2);
        table.prune_expired();
        assert!(table.entries.len() <= PHASE_CAP, "淘汰后不得超上限");
    }

    // ── 换绑 / 路径变化 / 不可用恢复：revision 语义（经 poll_mirror + 临时转录文件） ──

    fn temp_transcript(name: &str, content: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("tb-relay-poll-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let session = format!("01900000-0000-7000-8000-{:012x}", uuid::Uuid::new_v4().as_u128() & 0xffff_ffff_ffff);
        let path = dir.join(format!("{name}.jsonl"));
        fs::write(&path, content).unwrap();
        (dir, session)
    }

    fn scan_with_binding(terminal_id: &str, provider: &str, session_id: &str) -> ScanData {
        let mut bindings = HashMap::new();
        bindings.insert(
            terminal_id.to_string(),
            AgentSessionRecord {
                provider: provider.to_string(),
                session_id: session_id.to_string(),
                session_file: None,
                cwd: None,
                updated_at: 0,
            },
        );
        ScanData { summaries: HashMap::new(), bindings }
    }

    #[test]
    fn completion_metadata_updates_even_when_replay_messages_are_unchanged() {
        let terminal_id = format!("relay-complete-{}", uuid::Uuid::new_v4());
        seed_tracked(&terminal_id);
        let answer = json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"完成"}]}}).to_string();
        let (dir, session) = temp_transcript("session", &format!("{answer}\n"));
        let path = dir.join("session.jsonl");
        super::super::terminal_task_service::record_agent_session(&terminal_id, "claude", &session, Some(&path.to_string_lossy()), true);
        let scan = scan_with_binding(&terminal_id, "claude", &session);
        let _ = poll_mirror(&terminal_id, &scan);
        assert_eq!(lock_state().mirrors[&terminal_id].turn_end, None);
        let done = json!({"type":"system","subtype":"turn_duration","timestamp":"2026-11-06T07:44:36.778Z"});
        fs::write(&path, format!("{answer}\n{done}\n")).unwrap();
        assert!(matches!(poll_mirror(&terminal_id, &scan), PollContent::None));
        assert!(lock_state().mirrors[&terminal_id].turn_end.is_some(), "完成标记不依赖消息正文变化");
        lock_state().remove_terminal(&terminal_id);
        super::super::terminal_task_service::forget_terminal(&terminal_id);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn poll_mirror_append_then_unavailable_then_recovery_bumps_revision() {
        let terminal_id = format!("relay-poll-{}", uuid::Uuid::new_v4());
        seed_tracked(&terminal_id);
        let claude_line = |text: &str| {
            json!({"type":"user","message":{"content": text}}).to_string()
        };
        let (dir, session) = temp_transcript("session", &format!("{}\n", claude_line("第一问")));
        let path = dir.join("session.jsonl");
        super::super::terminal_task_service::record_agent_session(&terminal_id, "claude", &session, Some(&path.to_string_lossy()), true);
        let scan = scan_with_binding(&terminal_id, "claude", &session);
        // 首次：mirror。
        let first = poll_mirror(&terminal_id, &scan);
        let PollContent::Page { kind, core } = first else { panic!("首建应为 mirror：{first:?}") };
        assert_eq!(kind, "mirror");
        assert_eq!(core.revision, 1);
        // 追加：append，revision 不变。
        fs::write(&path, format!("{}\n{}\n", claude_line("第一问"), claude_line("第二问"))).unwrap();
        match poll_mirror(&terminal_id, &scan) {
            PollContent::Append { revision, tail, .. } => {
                assert_eq!(revision, 1);
                assert_eq!(tail.len(), 1);
            }
            other => panic!("追加应为 append：{other:?}"),
        }
        // 旧消息被改写：rotated，revision +1。
        fs::write(&path, format!("{}\n{}\n", claude_line("被改写的第一问"), claude_line("第二问"))).unwrap();
        match poll_mirror(&terminal_id, &scan) {
            PollContent::Page { kind, core } => {
                assert_eq!(kind, "rotated");
                assert_eq!(core.revision, 2);
            }
            other => panic!("改写应 rotated：{other:?}"),
        }
        // 文件消失：unavailable（代次不变），重新出现：恢复 mirror revision+1。
        fs::remove_file(&path).unwrap();
        match poll_mirror(&terminal_id, &scan) {
            PollContent::Unavailable { reason } => assert_eq!(reason, "transcript_unreadable"),
            other => panic!("文件消失应 unavailable：{other:?}"),
        }
        // 状态已提交为不可用：重复 poll 不再重复发帧。
        assert!(matches!(poll_mirror(&terminal_id, &scan), PollContent::None));
        fs::write(&path, format!("{}\n", claude_line("恢复后的第一问"))).unwrap();
        match poll_mirror(&terminal_id, &scan) {
            PollContent::Page { kind, core } => {
                assert_eq!(kind, "mirror");
                assert_eq!(core.revision, 3, "从不可用恢复 revision+1");
            }
            other => panic!("恢复应 mirror：{other:?}"),
        }
        lock_state().remove_terminal(&terminal_id);
        super::super::terminal_task_service::forget_terminal(&terminal_id);
        fs::remove_dir_all(&dir).ok();
    }

    /// hook 链路不直传 transcript 路径（record_claude_session 只设 binding），
    /// 新建会话在发出第一条消息前没有 jsonl：首帧必须是「可用的空镜像」而不是
    /// 不可用；transcript 在 claude_root 下出现后必须能靠 find_transcript 递归
    /// 定位并把新消息补进同一 revision（App「开始对话」后立即打开会话页的路径）。
    #[test]
    fn empty_mirror_waits_for_first_transcript() {
        let terminal_id = format!("relay-find-{}", uuid::Uuid::new_v4());
        let claude_line = |text: &str| {
            json!({"type":"user","message":{"content": text}}).to_string()
        };
        // 临时 CLAUDE_CONFIG_DIR 根：tracked.claude_root 指向它，避免触碰真实 HOME。
        let base = std::env::temp_dir().join(format!("tb-relay-find-{}", uuid::Uuid::new_v4()));
        let config_dir = base.join("claude");
        fs::create_dir_all(&config_dir).unwrap();
        let session = format!("01900000-0000-7000-8000-{:012x}", uuid::Uuid::new_v4().as_u128() & 0xffff_ffff_ffff);
        super::super::terminal_task_service::prepare_launch(
            &terminal_id, "bash", None,
            &[("CLAUDE_CONFIG_DIR".to_string(), config_dir.to_string_lossy().into_owned())],
            Vec::new(),
        );
        // 模拟 hook 上报：只登记绑定，不传 transcript 路径。
        super::super::terminal_task_service::record_agent_session(&terminal_id, "claude", &session, None, true);
        let scan = scan_with_binding(&terminal_id, "claude", &session);
        // transcript 尚未创建（Agent 空闲）：空镜像，不是 unavailable。
        match poll_mirror(&terminal_id, &scan) {
            PollContent::Page { kind, core } => {
                assert_eq!(kind, "mirror");
                assert_eq!(core.revision, 1);
                assert!(core.messages.is_empty(), "空镜像不得带消息");
            }
            other => panic!("无 transcript 应为空镜像：{other:?}"),
        }
        // 空态保持：等 locate 负缓存（2s TTL）过期后再 poll，仍是空镜像且不报错。
        std::thread::sleep(std::time::Duration::from_millis(2_100));
        assert!(matches!(poll_mirror(&terminal_id, &scan), PollContent::None));
        // transcript 出现在 claude_root/projects/<项目目录>/ 下：同 revision 追加消息。
        let project_dir = config_dir.join("projects").join("-tmp-demo");
        fs::create_dir_all(&project_dir).unwrap();
        let path = project_dir.join(format!("{session}.jsonl"));
        fs::write(&path, format!("{}\n", claude_line("第一条消息"))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2_100));
        match poll_mirror(&terminal_id, &scan) {
            PollContent::Append { revision, tail, .. } => {
                assert_eq!(revision, 1, "空镜像补消息不提升代次");
                assert_eq!(tail.len(), 1);
            }
            other => panic!("transcript 出现后应 append：{other:?}"),
        }
        lock_state().remove_terminal(&terminal_id);
        super::super::terminal_task_service::forget_terminal(&terminal_id);
        fs::remove_dir_all(&base).ok();
    }

    /// 已提交过提示词（阶段表 running）却找不到 transcript：
    /// 起始宽限期内按空镜像（UserPromptSubmit 先于 jsonl 落盘的竞态），过了宽限期才是真实故障。
    #[test]
    fn started_session_without_transcript_respects_start_grace() {
        let terminal_id = format!("relay-started-{}", uuid::Uuid::new_v4());
        let session = "01900000-0000-7000-8000-0000000000cd";
        let base = std::env::temp_dir().join(format!("tb-relay-started-{}", uuid::Uuid::new_v4()));
        let config_dir = base.join("claude");
        fs::create_dir_all(&config_dir).unwrap();
        super::super::terminal_task_service::prepare_launch(
            &terminal_id, "bash", None,
            &[("CLAUDE_CONFIG_DIR".to_string(), config_dir.to_string_lossy().into_owned())],
            Vec::new(),
        );
        super::super::terminal_task_service::record_agent_session(&terminal_id, "claude", session, None, true);
        let scan = scan_with_binding(&terminal_id, "claude", session);
        // 刚提交提示词：jsonl 还没落盘是正常竞态，给空镜像。
        note_phase(&terminal_id, "claude", session, "running", now_ms());
        match poll_mirror(&terminal_id, &scan) {
            PollContent::Page { kind, core } => {
                assert_eq!(kind, "mirror");
                assert!(core.messages.is_empty());
            }
            other => panic!("起始宽限期内应空镜像：{other:?}"),
        }
        // 宽限期外仍无 transcript：真实故障。
        note_phase(&terminal_id, "claude", session, "running", now_ms() - TRANSCRIPT_START_GRACE_MS - 1);
        lock_state().locate_negative.remove(&terminal_id);
        match poll_mirror(&terminal_id, &scan) {
            PollContent::Unavailable { reason } => assert_eq!(reason, "transcript_unreadable"),
            other => panic!("宽限期外无 transcript 应 unavailable：{other:?}"),
        }
        lock_state().remove_terminal(&terminal_id);
        super::super::terminal_task_service::forget_terminal(&terminal_id);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn poll_mirror_rebind_to_new_session_rotates() {
        let terminal_id = format!("relay-rebind-{}", uuid::Uuid::new_v4());
        seed_tracked(&terminal_id);
        let claude_line = |text: &str| json!({"type":"user","message":{"content": text}}).to_string();
        let (dir, session_a) = temp_transcript("a", &format!("{}\n", claude_line("A 会话")));
        let path_a = dir.join("a.jsonl");
        super::super::terminal_task_service::record_agent_session(&terminal_id, "claude", &session_a, Some(&path_a.to_string_lossy()), true);
        let scan_a = scan_with_binding(&terminal_id, "claude", &session_a);
        assert!(matches!(poll_mirror(&terminal_id, &scan_a), PollContent::Page { .. }));
        // 换绑：SessionStart 允许换绑到 B。
        let (dir_b, session_b) = temp_transcript("b", &format!("{}\n", claude_line("B 会话")));
        let path_b = dir_b.join("b.jsonl");
        super::super::terminal_task_service::record_agent_session(&terminal_id, "claude", &session_b, Some(&path_b.to_string_lossy()), true);
        let scan_b = scan_with_binding(&terminal_id, "claude", &session_b);
        match poll_mirror(&terminal_id, &scan_b) {
            PollContent::Page { kind, core } => {
                assert_eq!(kind, "rotated", "换绑必须 rotated");
                assert_eq!(core.revision, 2);
                assert_eq!(core.messages.len(), 1);
                assert_eq!(core.messages[0].text, "B 会话");
            }
            other => panic!("换绑应 rotated：{other:?}"),
        }
        lock_state().remove_terminal(&terminal_id);
        super::super::terminal_task_service::forget_terminal(&terminal_id);
        fs::remove_dir_all(&dir).ok();
    }

    // ── watcher / 租约状态机（不经 AppHandle，直接驱动全局状态） ──

    fn seed_lease(terminal_id: &str, subscription_id: &str, socket: bool) -> Option<tokio::sync::mpsc::Receiver<TerminalAgentFrame>> {
        let (sender, receiver) = if socket {
            let (sender, receiver) = tokio::sync::mpsc::channel(OUTBOUND_QUEUE);
            (Some(sender), Some(receiver))
        } else { (None, None) };
        let mut current = lock_state();
        let handle = current.watchers.entry(terminal_id.to_string()).or_insert(WatcherHandle {
            leases: HashMap::new(),
            last_meta: HashMap::new(),
            linger_since: None,
        });
        handle.leases.insert(
            subscription_id.to_string(),
            Lease {
                actor: TerminalActor::Web,
                kind: if socket { "socket" } else { "event" },
                sender,
                expires: if socket { None } else { Some(Instant::now() + LEASE_TTL) },
            },
        );
        receiver
    }

    #[test]
    fn unsubscribe_releases_only_the_named_handle_and_is_idempotent() {
        let terminal_id = format!("relay-lease-{}", uuid::Uuid::new_v4());
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        seed_lease(&terminal_id, &first, false);
        seed_lease(&terminal_id, &second, false);
        unsubscribe(&terminal_id, &first);
        unsubscribe(&terminal_id, &first); // 重复释放幂等
        let current = lock_state();
        let handle = current.watchers.get(&terminal_id).unwrap();
        assert!(!handle.leases.contains_key(&first));
        assert!(handle.leases.contains_key(&second), "不得误删其他租约");
        drop(current);
        unsubscribe(&terminal_id, &second);
        assert!(lock_state().watchers.get(&terminal_id).is_none_or(|handle| handle.leases.is_empty()));
        lock_state().watchers.remove(&terminal_id);
    }

    #[test]
    fn heartbeat_renews_only_same_actor_event_leases() {
        let terminal_id = format!("relay-heartbeat-{}", uuid::Uuid::new_v4());
        let subscription = uuid::Uuid::new_v4().to_string();
        seed_lease(&terminal_id, &subscription, false);
        // Pc 续不上 Web 的租约。
        let alive = heartbeat(TerminalActor::Pc, &[HeartbeatLease { terminal_id: terminal_id.clone(), subscription_id: subscription.clone() }]);
        assert!(alive.is_empty());
        // Web 本人续租成功且返回存活。
        let alive = heartbeat(TerminalActor::Web, &[HeartbeatLease { terminal_id: terminal_id.clone(), subscription_id: subscription.clone() }]);
        assert_eq!(alive.len(), 1);
        // 不存在的句柄不复活。
        let alive = heartbeat(TerminalActor::Web, &[HeartbeatLease { terminal_id: terminal_id.clone(), subscription_id: "missing-handle-000".to_string() }]);
        assert!(alive.is_empty());
        lock_state().watchers.remove(&terminal_id);
    }

    #[tokio::test]
    async fn terminal_close_pushes_error_frame_and_clears_state() {
        let terminal_id = format!("relay-close-{}", uuid::Uuid::new_v4());
        let subscription = uuid::Uuid::new_v4().to_string();
        let mut receiver = seed_lease(&terminal_id, &subscription, true).expect("WS 租约应有接收端");
        on_terminal_closed(None, &terminal_id);
        let frame = receiver.recv().await.expect("应收到 terminal_closed 错误帧");
        assert_eq!(frame.r#type, "error");
        assert_eq!(frame.code.as_deref(), Some("terminal_closed"));
        // 状态全部清理。
        let current = lock_state();
        assert!(!current.watchers.contains_key(&terminal_id));
        assert!(!current.mirrors.contains_key(&terminal_id));
    }

    // ── 桌面 / Web 错误适配：错误码与业务字段保留，不统一降级 ──

    #[test]
    fn relay_error_codes_and_business_fields_survive_both_adapters() {
        let conflict = RelayError::Conflict {
            message: "有待确认的决策".to_string(),
            decision_id: Some("d-1".to_string()),
            reply_blocked_reason: None,
        };
        assert_eq!(conflict.code(), "conflict");
        assert_eq!(conflict.decision_id().as_deref(), Some("d-1"));
        let rate = RelayError::TooManyRequests { message: "太快".to_string(), retry_after_secs: 3 };
        assert_eq!(rate.code(), "too_many_requests");
        assert_eq!(rate.retry_after_secs(), Some(3));
        assert_eq!(RelayError::NotFound("终端不存在或已关闭".to_string()).code(), "not_found");
        assert_eq!(RelayError::Forbidden("无权".to_string()).code(), "forbidden");
        assert_eq!(RelayError::BadRequest("参数".to_string()).code(), "bad_request");
    }

    // ── 双身份：canReply 的授权原因可区分（权限矩阵本身见 models::terminal_access 测试） ──

    #[test]
    fn can_reply_reports_actionable_denied_reason() {
        let (allowed, reason) = evaluate_can_reply(true, None, "running", Some(now_ms()), 0, now_ms());
        assert!(allowed);
        assert!(reason.is_none());
        let (allowed, reason) = evaluate_can_reply(false, Some("该终端由桌面端创建，Web 端当前无权输入。".to_string()), "running", None, 0, now_ms());
        assert!(!allowed);
        assert!(reason.as_ref().is_some_and(|reason| reason.contains("共享终端会话") || reason.contains("无权")));
        let (allowed, reason) = evaluate_can_reply(true, None, "running", Some(now_ms()), 2, now_ms());
        assert!(!allowed);
        assert!(reason.unwrap().contains("待确认"));
    }
}
