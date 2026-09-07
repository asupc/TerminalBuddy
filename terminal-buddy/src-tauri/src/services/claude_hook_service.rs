use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tokio::sync::oneshot;

pub const CLAUDE_HOOK_PORT: u16 = 19601;
pub const CLAUDE_HOOK_URL: &str = "http://127.0.0.1:19601/api/claude/hooks";
pub const CLAUDE_HOOK_CLIENT_ARG: &str = "__terminal_buddy_claude_hook";

/// 业务 decision TTL 由机器人设置（`decisionTtlMinutes`，1..=1440 分钟）控制，
/// 是 pending 表里决策的存活期；单次 HTTP hook 请求的最长挂起时间是另一个概念，
/// 不能让 24 小时 TTL 直接把 HTTP 连接也挂 24 小时。
pub const HTTP_WAIT_CAP: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// 全局同时 pending 的 decision 上限。超过后新请求立刻 429，不建 receiver、
/// 不发通知卡片、不占 HTTP 连接。
pub const MAX_PENDING_DECISIONS: usize = 32;
/// 单个 terminal 同时 pending 的 decision 上限：正常场景一个终端同时只有一个
/// AskUserQuestion 在等；超过说明 hook 请求失控（比如脚本循环调用）。
pub const MAX_PENDING_DECISIONS_PER_TERMINAL: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookQuestion {
    pub question: String,
    pub header: String,
    pub options: Vec<ClaudeHookOption>,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookDecisionEvent {
    pub decision_id: String,
    pub terminal_id: String,
    pub questions: Vec<ClaudeHookQuestion>,
    pub expires_at: i64,
    pub occurred_at: i64,
}

struct PendingDecision {
    terminal_id: String,
    questions: Vec<ClaudeHookQuestion>,
    expires_at: i64,
    occurred_at: i64,
    answers: HashMap<String, String>,
    response: Option<oneshot::Sender<ClaudeHookResolution>>,
    notification_state: DecisionNotificationState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DecisionNotificationState {
    Pending,
    Sending(u64),
    Sent,
}

pub struct ClaudeHookNotificationLease {
    pub terminal_id: String,
    pub questions: Vec<ClaudeHookQuestion>,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookTerminalEvent {
    pub event_id: String,
    pub terminal_id: String,
    pub session_id: String,
    pub event_name: String,
    pub phase: String,
    pub occurred_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

pub enum ClaudeHookResolution {
    Answers(HashMap<String, String>),
    ContinueInTerminal,
}

/// 统一 Mutex 访问：毒锁时取回内部值，避免 panic 扩散。
fn lock_map<K, V>(map: &Mutex<HashMap<K, V>>) -> std::sync::MutexGuard<'_, HashMap<K, V>> {
    map.lock().unwrap_or_else(|value| value.into_inner())
}

fn lock_pending() -> std::sync::MutexGuard<'static, HashMap<String, PendingDecision>> {
    lock_map(pending())
}

fn pending() -> &'static Mutex<HashMap<String, PendingDecision>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingDecision>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn terminal_tokens() -> &'static Mutex<HashMap<String, String>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn recent_prompts() -> &'static Mutex<HashMap<(String, String), String>> {
    static PROMPTS: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    PROMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn hook_server_running() -> &'static AtomicBool {
    static RUNNING: OnceLock<AtomicBool> = OnceLock::new();
    RUNNING.get_or_init(|| AtomicBool::new(false))
}

pub(crate) fn hook_server_port() -> &'static AtomicU16 {
    static PORT: OnceLock<AtomicU16> = OnceLock::new();
    PORT.get_or_init(|| AtomicU16::new(0))
}

fn next_notification_generation() -> u64 {
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    GENERATION.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
}

/// 运行统计：当前 pending 数、等待后超时数、超限拒绝数。
/// 只含计数，不含 prompt 或问题内容（日志同样不得写入完整 prompt）。
pub struct ClaudeHookStats {
    pub pending: usize,
    pub expired: u64,
    pub rejected: u64,
}

fn expired_count() -> &'static AtomicU64 {
    static EXPIRED: OnceLock<AtomicU64> = OnceLock::new();
    EXPIRED.get_or_init(|| AtomicU64::new(0))
}

fn rejected_count() -> &'static AtomicU64 {
    static REJECTED: OnceLock<AtomicU64> = OnceLock::new();
    REJECTED.get_or_init(|| AtomicU64::new(0))
}

/// 决策被拒绝（超限）时的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionRejectReason {
    /// 全局 pending 数已达上限。
    GlobalLimit,
    /// 该 terminal 的 pending 数已达上限。
    TerminalLimit,
}

impl DecisionRejectReason {
    pub fn message(&self) -> &'static str {
        match self {
            DecisionRejectReason::GlobalLimit => "系统等待中的 Claude 决策数量已达上限，请稍后重试或先处理已有决策。",
            DecisionRejectReason::TerminalLimit => "该终端等待中的 Claude 决策数量已达上限，请先处理已有决策。",
        }
    }
}

fn cancel_decision_cards(decision_id: &str, question_count: usize) {
    for index in 0..question_count {
        let _ = crate::services::BotBindingService::cancel(&card_decision_id(decision_id, index));
    }
}

pub struct ClaudeHookService;

impl ClaudeHookService {
    /// 单次 HTTP hook 请求的最长挂起时间（见 [`HTTP_WAIT_CAP`]）。
    pub fn http_wait_cap() -> std::time::Duration {
        HTTP_WAIT_CAP
    }

    pub fn set_server_state(running: bool, port: u16) {
        hook_server_running().store(running, Ordering::SeqCst);
        hook_server_port().store(if running { port } else { 0 }, Ordering::SeqCst);
    }

    pub fn server_port() -> u16 {
        hook_server_port().load(Ordering::SeqCst)
    }

    pub fn register_terminal(terminal_id: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        lock_map(terminal_tokens())
            .insert(terminal_id.to_string(), token.clone());
        token
    }

    pub fn unregister_terminal(terminal_id: &str) {
        lock_map(terminal_tokens())
            .remove(terminal_id);
        lock_map(recent_prompts())
            .retain(|(registered_terminal_id, _), _| registered_terminal_id != terminal_id);
        // 决策移除时向 receiver 发送 ContinueInTerminal：HTTP hook 请求因此立刻
        // 返回，而不是挂到 TTL 超时。终端已关闭，「继续在终端里」是安全答案。
        let removed = {
            let mut current = lock_pending();
            let removed = current
                .iter()
                .filter(|(_, decision)| decision.terminal_id == terminal_id)
                .map(|(decision_id, decision)| {
                    (decision_id.clone(), decision.questions.len())
                })
                .collect::<Vec<_>>();
            for (decision_id, _) in &removed {
                if let Some(mut decision) = current.remove(decision_id) {
                    if let Some(response) = decision.response.take() {
                        let _ = response.send(ClaudeHookResolution::ContinueInTerminal);
                    }
                }
            }
            removed
        };
        for (decision_id, question_count) in removed {
            cancel_decision_cards(&decision_id, question_count);
        }
    }

    /// 应用退出：释放全部 pending 的 sender/receiver 并清空状态。
    /// 进程即将结束，不再尝试通知卡片撤销。
    pub fn release_all_on_shutdown() {
        lock_map(terminal_tokens()).clear();
        lock_map(recent_prompts()).clear();
        let mut current = lock_pending();
        for (_, mut decision) in current.drain() {
            if let Some(response) = decision.response.take() {
                let _ = response.send(ClaudeHookResolution::ContinueInTerminal);
            }
        }
    }

    /// 读取运行统计并记录一次超时/拒绝事件。
    pub fn stats() -> ClaudeHookStats {
        ClaudeHookStats {
            pending: lock_pending().len(),
            expired: expired_count().load(Ordering::Relaxed),
            rejected: rejected_count().load(Ordering::Relaxed),
        }
    }

    pub(crate) fn note_expired() {
        expired_count().fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn note_rejected() {
        rejected_count().fetch_add(1, Ordering::Relaxed);
    }

    pub fn validate_terminal(terminal_id: &str, token: &str) -> bool {
        lock_map(terminal_tokens())
            .get(terminal_id)
            .is_some_and(|expected| expected == token)
    }

    /// 登记一条 pending decision。全局与单 terminal 上限在**同一次加锁**内检查，
    /// 超限时不创建通道、不进表，调用方应直接让 hook 请求快速失败。
    pub fn insert_decision(
        decision_id: String,
        terminal_id: String,
        questions: Vec<ClaudeHookQuestion>,
        expires_at: i64,
        occurred_at: i64,
    ) -> Result<oneshot::Receiver<ClaudeHookResolution>, DecisionRejectReason> {
        let mut current = lock_pending();
        if current.len() >= MAX_PENDING_DECISIONS {
            Self::note_rejected();
            return Err(DecisionRejectReason::GlobalLimit);
        }
        let per_terminal = current
            .values()
            .filter(|decision| decision.terminal_id == terminal_id)
            .count();
        if per_terminal >= MAX_PENDING_DECISIONS_PER_TERMINAL {
            Self::note_rejected();
            return Err(DecisionRejectReason::TerminalLimit);
        }
        let (tx, rx) = oneshot::channel();
        current.insert(
            decision_id,
            PendingDecision {
                terminal_id,
                questions,
                expires_at,
                occurred_at,
                answers: HashMap::new(),
                response: Some(tx),
                notification_state: DecisionNotificationState::Pending,
            },
        );
        Ok(rx)
    }

    pub fn remember_prompt(terminal_id: &str, session_id: &str, prompt: String) {
        lock_map(recent_prompts())
            .insert((terminal_id.to_string(), session_id.to_string()), prompt);
    }

    pub fn recent_prompt(terminal_id: &str, session_id: &str) -> Option<String> {
        lock_map(recent_prompts())
            .get(&(terminal_id.to_string(), session_id.to_string()))
            .cloned()
    }

    pub fn clear_session_prompt(terminal_id: &str, session_id: &str) {
        lock_map(recent_prompts())
            .remove(&(terminal_id.to_string(), session_id.to_string()));
    }

    pub fn list_pending_decisions() -> Vec<ClaudeHookDecisionEvent> {
        let mut decisions = pending()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .iter()
            .map(|(decision_id, decision)| ClaudeHookDecisionEvent {
                decision_id: decision_id.clone(),
                terminal_id: decision.terminal_id.clone(),
                questions: decision.questions.clone(),
                expires_at: decision.expires_at,
                occurred_at: decision.occurred_at,
            })
            .collect::<Vec<_>>();
        decisions.sort_by_key(|decision| decision.occurred_at);
        decisions
    }

    pub fn begin_notification(decision_id: &str) -> Option<ClaudeHookNotificationLease> {
        let mut current = lock_pending();
        let decision = current.get_mut(decision_id)?;
        if decision.notification_state != DecisionNotificationState::Pending {
            return None;
        }
        let generation = next_notification_generation();
        decision.notification_state = DecisionNotificationState::Sending(generation);
        Some(ClaudeHookNotificationLease {
            terminal_id: decision.terminal_id.clone(),
            questions: decision.questions.clone(),
            generation,
        })
    }

    pub fn notification_is_current(decision_id: &str, generation: u64) -> bool {
        pending()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .get(decision_id)
            .is_some_and(|decision| {
                decision.notification_state == DecisionNotificationState::Sending(generation)
            })
    }

    pub fn finish_notification(decision_id: &str, generation: u64, sent: bool) -> bool {
        let mut current = lock_pending();
        let Some(decision) = current.get_mut(decision_id) else {
            return false;
        };
        if decision.notification_state != DecisionNotificationState::Sending(generation) {
            return false;
        }
        decision.notification_state = if sent {
            DecisionNotificationState::Sent
        } else {
            DecisionNotificationState::Pending
        };
        true
    }

    pub fn cancel_notification_cards(decision_id: &str, question_count: usize) {
        cancel_decision_cards(decision_id, question_count);
    }

    pub fn expire_decision(decision_id: &str) {
        let question_count = pending()
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .remove(decision_id)
            .map(|decision| decision.questions.len())
            .unwrap_or_default();
        Self::note_expired();
        cancel_decision_cards(decision_id, question_count);
    }

    pub fn answer_all(decision_id: &str, answers: HashMap<String, String>) -> Result<(), String> {
        let mut current = lock_pending();
        let decision = current
            .get_mut(decision_id)
            .ok_or_else(|| "该 Claude 决策已失效".to_string())?;
        for question in &decision.questions {
            if !answers.contains_key(&question.question) {
                return Err(format!("问题“{}”尚未回答", question.question));
            }
        }
        let question_count = decision.questions.len();
        let response = decision
            .response
            .take()
            .ok_or_else(|| "该 Claude 决策已处理".to_string())?;
        let _ = response.send(ClaudeHookResolution::Answers(answers));
        current.remove(decision_id);
        drop(current);
        cancel_decision_cards(decision_id, question_count);
        Ok(())
    }

    /// 记录答案；全部问题答完时发送响应、移除决策并撤销卡片。
    fn record_answer(
        mut current: std::sync::MutexGuard<'static, HashMap<String, PendingDecision>>,
        decision_id: &str,
        question_index: usize,
        answer: String,
    ) -> Result<(), String> {
        let decision = current
            .get_mut(decision_id)
            .ok_or_else(|| "该 Claude 决策已失效".to_string())?;
        let question = decision
            .questions
            .get(question_index)
            .ok_or_else(|| "Claude 决策问题不存在".to_string())?;
        decision.answers.insert(question.question.clone(), answer);
        let complete = decision
            .questions
            .iter()
            .all(|item| decision.answers.contains_key(&item.question));
        let question_count = if complete {
            let answers = decision.answers.clone();
            if let Some(response) = decision.response.take() {
                let _ = response.send(ClaudeHookResolution::Answers(answers));
            }
            let question_count = decision.questions.len();
            current.remove(decision_id);
            Some(question_count)
        } else {
            None
        };
        drop(current);
        if let Some(question_count) = question_count {
            cancel_decision_cards(decision_id, question_count);
        }
        Ok(())
    }

    pub fn answer_card(card_decision_id: &str, selected_indexes: &[usize]) -> Result<bool, String> {
        let Some((decision_id, question_index)) = parse_card_decision_id(card_decision_id) else {
            return Ok(false);
        };
        let current = lock_pending();
        let decision = current
            .get(decision_id)
            .ok_or_else(|| "该 Claude 决策已失效".to_string())?;
        let question = decision
            .questions
            .get(question_index)
            .ok_or_else(|| "Claude 决策问题不存在".to_string())?;
        let labels = selected_indexes
            .iter()
            .map(|index| {
                question
                    .options
                    .get(*index)
                    .map(|option| option.label.clone())
                    .ok_or_else(|| "Claude 决策选项不存在".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if labels.is_empty() {
            return Err("请至少选择一个选项".to_string());
        }
        Self::record_answer(current, decision_id, question_index, labels.join(", "))?;
        Ok(true)
    }

    pub fn continue_in_terminal(decision_id: &str) -> Result<(), String> {
        let mut current = lock_pending();
        let mut decision = current
            .remove(decision_id)
            .ok_or_else(|| "该 Claude 决策已失效".to_string())?;
        let question_count = decision.questions.len();
        let response = decision
            .response
            .take()
            .ok_or_else(|| "该 Claude 决策已处理".to_string())?;
        let _ = response.send(ClaudeHookResolution::ContinueInTerminal);
        drop(current);
        cancel_decision_cards(decision_id, question_count);
        Ok(())
    }

    pub fn answer_card_text(card_decision_id: &str, text: &str) -> Result<bool, String> {
        let Some((decision_id, question_index)) = parse_card_decision_id(card_decision_id) else {
            return Ok(false);
        };
        let answer = text.trim();
        if answer.is_empty() {
            return Err("回复内容为空".to_string());
        }
        Self::record_answer(lock_pending(), decision_id, question_index, answer.to_string())?;
        Ok(true)
    }
}

pub fn card_decision_id(decision_id: &str, question_index: usize) -> String {
    format!("{}::q{}", decision_id, question_index)
}

fn parse_card_decision_id(value: &str) -> Option<(&str, usize)> {
    let (decision_id, suffix) = value.rsplit_once("::q")?;
    Some((decision_id, suffix.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::{
        card_decision_id, parse_card_decision_id, ClaudeHookOption, ClaudeHookQuestion,
        ClaudeHookResolution, ClaudeHookService,
    };

    #[test]
    fn card_decision_id_round_trip() {
        let value = card_decision_id("session:tool", 2);
        assert_eq!(parse_card_decision_id(&value), Some(("session:tool", 2)));
    }

    #[test]
    fn notification_generation_allows_only_one_current_sender() {
        let decision_id = format!("notification-test-{}", uuid::Uuid::new_v4());
        let _receiver = ClaudeHookService::insert_decision(
            decision_id.clone(),
            "terminal-test".to_string(),
            Vec::new(),
            123,
            100,
        );
        let first = ClaudeHookService::begin_notification(&decision_id).unwrap();
        assert!(ClaudeHookService::notification_is_current(
            &decision_id,
            first.generation
        ));
        assert!(ClaudeHookService::begin_notification(&decision_id).is_none());
        assert!(ClaudeHookService::finish_notification(
            &decision_id,
            first.generation,
            false
        ));

        let second = ClaudeHookService::begin_notification(&decision_id).unwrap();
        assert_ne!(second.generation, first.generation);
        assert!(ClaudeHookService::finish_notification(
            &decision_id,
            second.generation,
            true
        ));
        assert!(ClaudeHookService::begin_notification(&decision_id).is_none());
        ClaudeHookService::expire_decision(&decision_id);
    }

    #[test]
    fn recent_prompts_are_isolated_by_terminal_and_session_and_cleared_on_unregister() {
        let terminal_id = format!("prompt-terminal-{}", uuid::Uuid::new_v4());
        let other_terminal_id = format!("prompt-terminal-{}", uuid::Uuid::new_v4());
        ClaudeHookService::remember_prompt(&terminal_id, "session-a", "任务 A".to_string());
        ClaudeHookService::remember_prompt(&terminal_id, "session-b", "任务 B".to_string());
        ClaudeHookService::remember_prompt(
            &other_terminal_id,
            "session-a",
            "其他终端任务".to_string(),
        );

        assert_eq!(
            ClaudeHookService::recent_prompt(&terminal_id, "session-a").as_deref(),
            Some("任务 A")
        );
        ClaudeHookService::clear_session_prompt(&terminal_id, "session-a");
        assert!(ClaudeHookService::recent_prompt(&terminal_id, "session-a").is_none());
        assert_eq!(
            ClaudeHookService::recent_prompt(&terminal_id, "session-b").as_deref(),
            Some("任务 B")
        );

        ClaudeHookService::unregister_terminal(&terminal_id);
        assert!(ClaudeHookService::recent_prompt(&terminal_id, "session-b").is_none());
        assert_eq!(
            ClaudeHookService::recent_prompt(&other_terminal_id, "session-a").as_deref(),
            Some("其他终端任务")
        );
        ClaudeHookService::unregister_terminal(&other_terminal_id);
    }

    #[tokio::test]
    async fn card_answer_resolves_structured_hook_response() {
        let decision_id = "session:tool-test";
        let receiver = ClaudeHookService::insert_decision(
            decision_id.to_string(),
            "terminal-test".to_string(),
            vec![ClaudeHookQuestion {
                question: "选择语言".to_string(),
                header: "语言".to_string(),
                options: vec![
                    ClaudeHookOption {
                        label: "中文".to_string(),
                        description: None,
                    },
                    ClaudeHookOption {
                        label: "English".to_string(),
                        description: None,
                    },
                ],
                multi_select: false,
            }],
            123,
            100,
        )
        .unwrap();
        assert!(ClaudeHookService::answer_card(&card_decision_id(decision_id, 0), &[1]).unwrap());
        let ClaudeHookResolution::Answers(answers) = receiver.await.unwrap() else {
            panic!("应返回结构化回答");
        };
        assert_eq!(answers.get("选择语言").map(String::as_str), Some("English"));
    }

    #[tokio::test]
    async fn continue_in_terminal_releases_the_hook_without_answers() {
        let decision_id = "session:terminal-test";
        let receiver = ClaudeHookService::insert_decision(
            decision_id.to_string(),
            "terminal-test".to_string(),
            vec![ClaudeHookQuestion {
                question: "继续处理？".to_string(),
                header: "处理方式".to_string(),
                options: vec![],
                multi_select: false,
            }],
            123,
            100,
        )
        .unwrap();

        ClaudeHookService::continue_in_terminal(decision_id).unwrap();
        assert!(matches!(
            receiver.await.unwrap(),
            ClaudeHookResolution::ContinueInTerminal
        ));
    }

    /// 单 terminal 的 pending 数达到上限后，新决策被拒绝且不进表。
    #[test]
    fn per_terminal_pending_limit_rejects_new_decisions() {
        let terminal_id = format!("limit-terminal-{}", uuid::Uuid::new_v4());
        let mut receivers = Vec::new();
        for index in 0..super::MAX_PENDING_DECISIONS_PER_TERMINAL {
            match ClaudeHookService::insert_decision(
                format!("{}:decision-{}", terminal_id, index),
                terminal_id.clone(),
                Vec::new(),
                123,
                100,
            ) {
                Ok(receiver) => receivers.push(receiver),
                Err(reason) => panic!("第 {} 条决策不应被拒绝: {:?}", index, reason),
            }
        }
        assert!(matches!(
            ClaudeHookService::insert_decision(
                format!("{}:overflow", terminal_id),
                terminal_id.clone(),
                Vec::new(),
                123,
                100,
            ),
            Err(super::DecisionRejectReason::TerminalLimit)
        ));
        // 释放后可以再次登记
        drop(receivers);
        for decision in ClaudeHookService::list_pending_decisions() {
            if decision.terminal_id == terminal_id {
                ClaudeHookService::expire_decision(&decision.decision_id);
            }
        }
        assert!(ClaudeHookService::insert_decision(
            format!("{}:after-release", terminal_id),
            terminal_id,
            Vec::new(),
            123,
            100,
        )
        .is_ok());
    }

    /// unregister_terminal（终端关闭）会立刻释放该 terminal 的挂起 HTTP 请求。
    #[tokio::test]
    async fn unregister_terminal_releases_pending_http_waiters() {
        let terminal_id = format!("unregister-terminal-{}", uuid::Uuid::new_v4());
        let receiver = ClaudeHookService::insert_decision(
            format!("{}:waiter", terminal_id),
            terminal_id.clone(),
            Vec::new(),
            i64::MAX,
            100,
        )
        .unwrap();

        ClaudeHookService::unregister_terminal(&terminal_id);
        // HTTP 请求立即收到结果而不是挂到 TTL 超时
        assert!(matches!(
            receiver.await.unwrap(),
            ClaudeHookResolution::ContinueInTerminal
        ));
        assert!(ClaudeHookService::list_pending_decisions()
            .iter()
            .all(|decision| decision.terminal_id != terminal_id));
    }

    /// release_all_on_shutdown 释放所有 pending 的 receiver。
    #[tokio::test]
    async fn shutdown_release_drains_all_pending_decisions() {
        let terminal_a = format!("shutdown-a-{}", uuid::Uuid::new_v4());
        let terminal_b = format!("shutdown-b-{}", uuid::Uuid::new_v4());
        let receiver_a = ClaudeHookService::insert_decision(
            format!("{}:waiter", terminal_a),
            terminal_a.clone(),
            Vec::new(),
            i64::MAX,
            100,
        )
        .unwrap();
        let receiver_b = ClaudeHookService::insert_decision(
            format!("{}:waiter", terminal_b),
            terminal_b.clone(),
            Vec::new(),
            i64::MAX,
            100,
        )
        .unwrap();

        ClaudeHookService::release_all_on_shutdown();
        assert!(ClaudeHookService::list_pending_decisions().is_empty());
        assert!(matches!(
            receiver_a.await.unwrap(),
            ClaudeHookResolution::ContinueInTerminal
        ));
        assert!(matches!(
            receiver_b.await.unwrap(),
            ClaudeHookResolution::ContinueInTerminal
        ));
    }
}
