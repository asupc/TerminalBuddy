//! 原生会话用量适配。累计量由“回合开始前的基线 + 当前回合快照”计算，
//! 流式增量、完整消息和最终摘要互相校正，不能将它们重复相加。
use crate::models::ai_chat::*;
use serde_json::Value;
use std::collections::HashMap;

fn number(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| value.get(*key)?.as_u64()).filter(|n| *n <= i64::MAX as u64)
}
fn add(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (None, None) => None,
        _ => Some(a.unwrap_or(0).saturating_add(b.unwrap_or(0)).min(i64::MAX as u64)),
    }
}
fn maximum(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) { (Some(a), Some(b)) => Some(a.max(b)), _ => a.or(b) }
}
impl AiTokenUsage {
    fn plus(&self, other: &Self) -> Self {
        Self {
            input_tokens: add(self.input_tokens, other.input_tokens),
            output_tokens: add(self.output_tokens, other.output_tokens),
            cache_read_input_tokens: add(self.cache_read_input_tokens, other.cache_read_input_tokens),
            cache_creation_input_tokens: add(self.cache_creation_input_tokens, other.cache_creation_input_tokens),
            reasoning_output_tokens: add(self.reasoning_output_tokens, other.reasoning_output_tokens),
        }
    }
    fn merge(&mut self, other: &Self) {
        self.input_tokens = maximum(self.input_tokens, other.input_tokens);
        self.output_tokens = maximum(self.output_tokens, other.output_tokens);
        self.cache_read_input_tokens = maximum(self.cache_read_input_tokens, other.cache_read_input_tokens);
        self.cache_creation_input_tokens = maximum(self.cache_creation_input_tokens, other.cache_creation_input_tokens);
        self.reasoning_output_tokens = maximum(self.reasoning_output_tokens, other.reasoning_output_tokens);
    }
    fn minus(&self, base: &Self) -> Self {
        let subtract = |value: Option<u64>, before: Option<u64>| value.map(|n| n.saturating_sub(before.unwrap_or(0)));
        Self {
            input_tokens: subtract(self.input_tokens, base.input_tokens),
            output_tokens: subtract(self.output_tokens, base.output_tokens),
            cache_read_input_tokens: subtract(self.cache_read_input_tokens, base.cache_read_input_tokens),
            cache_creation_input_tokens: subtract(self.cache_creation_input_tokens, base.cache_creation_input_tokens),
            reasoning_output_tokens: subtract(self.reasoning_output_tokens, base.reasoning_output_tokens),
        }
    }
    fn reported(&self) -> bool { self.input_tokens.is_some() || self.output_tokens.is_some() }
    fn complete(&self) -> bool { self.input_tokens.is_some() && self.output_tokens.is_some() }
    fn before(&self, other: &Self) -> bool {
        self.input_tokens.zip(other.input_tokens).is_some_and(|(a, b)| a < b)
            || self.output_tokens.zip(other.output_tokens).is_some_and(|(a, b)| a < b)
    }
}

pub(super) fn initial() -> AiUsage {
    AiUsage {
        session_total: AiSessionUsage {
            tokens: AiTokenUsage { input_tokens: Some(0), output_tokens: Some(0), ..Default::default() },
            coverage: "complete".into(),
        },
        ..Default::default()
    }
}
fn ensure(data: &mut AiSession) -> &mut AiUsage {
    data.usage.get_or_insert_with(|| {
        let mut usage = initial();
        usage.session_total.coverage = "sinceUpgrade".into();
        usage
    })
}
pub(super) fn begin_turn(data: &mut AiSession) {
    let usage = ensure(data);
    usage.last_turn = Some(AiTurnUsage {
        state: "provisional".into(),
        started_at: Some(chrono::Utc::now().timestamp_millis()),
        ..Default::default()
    });
    // 新一轮开始时上次的上下文数字仍然有效（只是待刷新）：不要清成 0，
    // 否则界面会在 0 → 实际值 之间来回跳。
    usage.context.updating = true;
}
/// 标记本轮已收尾：只补结束时刻，用于底部状态栏估算平均输出速度。
pub(super) fn end_turn(data: &mut AiSession) {
    let now = chrono::Utc::now().timestamp_millis();
    if let Some(turn) = data.usage.as_mut().and_then(|usage| usage.last_turn.as_mut()) {
        turn.ended_at.get_or_insert(now);
    }
}
pub(super) fn finish_turn(data: &mut AiSession) {
    let Some(usage) = data.usage.as_mut() else { return; };
    if let Some(turn) = usage.last_turn.as_mut() {
        if turn.state != "final" || !turn.tokens.complete() {
            turn.state = "partial".into();
            if usage.session_total.coverage == "complete" { usage.session_total.coverage = "partial".into(); }
        }
    }
    // 无 result（中断/进程退出）的回合也要有结束时刻，否则状态栏永远算不出速度。
    end_turn(data);
}
pub(super) fn configured_window(data: &mut AiSession, window: Option<u64>) {
    let context = &mut ensure(data).context;
    // 显式配置即时生效；未配置时保留最近的 CLI 报告或上一次已知容量。
    // 会话的供应商和模型不变，把已知容量清成未知只会让界面数字闪动。
    if let Some(window) = window.filter(|n| *n > 0 && *n <= i64::MAX as u64) {
        context.window_tokens = Some(window);
        context.window_source = Some("configuration".into());
    }
}
fn store_turn(data: &mut AiSession, base: &AiTokenUsage, tokens: AiTokenUsage, state: &str) {
    let usage = ensure(data);
    usage.session_total.tokens = base.plus(&tokens);
    // 流式过程中 store_turn 会反复调用：保留本轮开始时刻（以及已经落定的结束时刻），
    // 否则速度统计的计时起点会被每次快照重置。
    let (started_at, ended_at) = usage.last_turn.as_ref()
        .map(|turn| (turn.started_at, turn.ended_at))
        .unwrap_or((None, None));
    usage.last_turn = Some(AiTurnUsage { tokens, state: state.into(), started_at, ended_at });
}
pub(super) fn invalidate_context(data: &mut AiSession) {
    let context = &mut ensure(data).context;
    // 压缩 / 切换后旧数字已不准确，但保留它并标记「待更新」比显示 0 更稳：
    // 客户端据此显示「上下文待更新」，等下一份报告到达再替换。
    context.updating = true;
}

/// 写入上下文占用。0 不是有效的上下文占用量：部分供应商 / 代理会在流式的
/// `message_start` 先报 `input_tokens: 0`（真实输入要到 `message_delta`
/// 或完整消息才出现），直接写入会让界面在回复过程中闪成 0%。
/// 遇到 0 时保留上一次的已知值并继续标记待更新。
fn store_context_used(context: &mut AiContextUsage, used: Option<u64>, basis: &str, source: &str) {
    let Some(used) = used.filter(|n| *n > 0) else { return; };
    context.used_tokens = Some(used);
    context.basis = basis.into();
    context.used_source = Some(source.into());
    context.updating = false;
}

fn claude_tokens(value: &Value) -> AiTokenUsage {
    let fresh = number(value, &["input_tokens", "inputTokens"]);
    let cached = number(value, &["cache_read_input_tokens", "cacheReadInputTokens"]);
    let created = number(value, &["cache_creation_input_tokens", "cacheCreationInputTokens"]);
    AiTokenUsage {
        input_tokens: add(add(fresh, cached), created),
        output_tokens: number(value, &["output_tokens", "outputTokens"]),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: created,
        reasoning_output_tokens: None,
    }
}

#[derive(Default)]
pub(super) struct ClaudeUsageTracker {
    base: Option<AiTokenUsage>,
    messages: HashMap<String, AiTokenUsage>,
    // 子 Agent 的流可能穿插到主对话中，分别记录当前 API 消息。
    current: HashMap<String, String>,
    latest_main: Option<String>,
    main_model: Option<String>,
    compacted: bool,
    final_received: bool,
}
impl ClaudeUsageTracker {
    pub(super) fn observe(&mut self, data: &mut AiSession, value: &Value) -> bool {
        let kind = value["type"].as_str().unwrap_or("");
        if value["parent_tool_use_id"].as_str().unwrap_or("").is_empty() && kind == "system" && matches!(value["subtype"].as_str(), Some("compact_boundary" | "status")) {
            if value["subtype"] == "compact_boundary" || value["status"] == "compacting" {
                // 同一次压缩会先来 status=compacting、再来 compact_boundary：
                // 只在边界事件计数，避免一次压缩被算两次。
                if value["subtype"] == "compact_boundary" {
                    data.compactions = data.compactions.saturating_add(1);
                }
                invalidate_context(data);
                self.compacted = true;
                self.latest_main = None;
                return true;
            }
        }
        if self.final_received { return false; }
        let parent = value["parent_tool_use_id"].as_str().unwrap_or("");
        let main = parent.is_empty();
        let message_id;
        let mut model = None;
        let tokens = match kind {
            "stream_event" => {
                let event = &value["event"];
                match event["type"].as_str().unwrap_or("") {
                    "message_start" => {
                        let Some(id) = event["message"]["id"].as_str() else { return false; };
                        self.current.insert(parent.into(), id.into());
                        if main { self.latest_main = Some(id.into()); self.compacted = false; }
                        message_id = Some(id.to_string());
                        model = event["message"]["model"].as_str();
                        claude_tokens(&event["message"]["usage"])
                    }
                    "message_delta" => {
                        message_id = self.current.get(parent).cloned();
                        claude_tokens(&event["usage"])
                    }
                    _ => return false,
                }
            }
            "assistant" => {
                message_id = value["message"]["id"].as_str().map(str::to_string);
                if main && !self.current.contains_key("") {
                    self.latest_main = message_id.clone();
                    self.compacted = false;
                }
                model = value["message"]["model"].as_str();
                claude_tokens(&value["message"]["usage"])
            }
            "result" => {
                let mut tokens = claude_tokens(&value["usage"]);
                let models = value["modelUsage"].as_object();
                if !tokens.reported() {
                    if let Some(models) = models {
                        for usage in models.values() { tokens = tokens.plus(&claude_tokens(usage)); }
                    }
                }
                if let Some(models) = models {
                    let selected = self.main_model.as_ref().and_then(|model| models.get(model))
                        .or_else(|| if models.len() == 1 { models.values().next() } else { None });
                    if let Some(window) = selected.and_then(|model| number(model, &["contextWindow"])).filter(|n| *n > 0) {
                        let context = &mut ensure(data).context;
                        context.window_tokens = Some(window);
                        context.window_source = Some("cli".into());
                    }
                }
                self.final_received = true;
                // 本轮收尾：记录结束时刻，供状态栏估算平均输出速度。
                end_turn(data);
                if tokens.reported() {
                    let base = self.base.get_or_insert_with(|| ensure(data).session_total.tokens.clone()).clone();
                    let state = if tokens.complete() { "final" } else { "partial" };
                    store_turn(data, &base, tokens, state);
                }
                return true;
            }
            _ => return false,
        };
        let Some(id) = message_id else { return false; };
        if !tokens.reported() { return false; }
        let base = self.base.get_or_insert_with(|| ensure(data).session_total.tokens.clone()).clone();
        let record = self.messages.entry(id.clone()).or_default();
        record.merge(&tokens);
        // 完整消息可能按内容块多次到达，只有新的主 API 消息才能替换当前上下文。
        if main && !self.compacted {
            if self.latest_main.as_deref() == Some(id.as_str()) {
                if let Some(model) = model.filter(|model| !model.is_empty()) { self.main_model = Some(model.into()); }
                let context = &mut ensure(data).context;
                store_context_used(context, record.input_tokens, "input", "cliUsage");
            }
        }
        let total = self.messages.values().fold(AiTokenUsage::default(), |sum, usage| sum.plus(usage));
        store_turn(data, &base, total, "provisional");
        true
    }
}

fn codex_tokens(value: &Value) -> AiTokenUsage {
    AiTokenUsage {
        // Codex 的 inputTokens 已经包含缓存命中，reasoningOutputTokens 也是 outputTokens 的子集。
        input_tokens: number(value, &["inputTokens", "input_tokens"]),
        output_tokens: number(value, &["outputTokens", "output_tokens"]),
        cache_read_input_tokens: number(value, &["cachedInputTokens", "cached_input_tokens"]),
        cache_creation_input_tokens: None,
        reasoning_output_tokens: number(value, &["reasoningOutputTokens", "reasoning_output_tokens"]),
    }
}

#[derive(Default)]
pub(super) struct CodexUsageTracker {
    base: Option<AiTokenUsage>,
    raw_base: Option<AiTokenUsage>,
    high_water: Option<AiTokenUsage>,
    started: bool,
    observed: bool,
    missing_turn_base: bool,
}
impl CodexUsageTracker {
    pub(super) fn start(&mut self, data: &mut AiSession) {
        self.base = Some(ensure(data).session_total.tokens.clone());
        self.raw_base = data.usage_checkpoint.clone();
        // 新线程的累计起点已知是 0；升级前的旧线程则等待恢复快照建立基线。
        if data.thread_id.is_none() && self.raw_base.is_none() { self.raw_base = Some(AiTokenUsage::default()); }
    }
    pub(super) fn submitted(&mut self) { self.started = true; }
    pub(super) fn observe(&mut self, data: &mut AiSession, value: &Value) -> bool {
        let method = value["method"].as_str().unwrap_or("");
        if method == "thread/compacted" {
            data.compactions = data.compactions.saturating_add(1);
            invalidate_context(data);
            return true;
        }
        if method == "item/started" && value["params"]["item"]["type"] == "contextCompaction" {
            // 与 thread/compacted 成对出现，只由后者计数，避免重复。
            invalidate_context(data);
            return true;
        }
        if method != "thread/tokenUsage/updated" { return false; }
        let reported = &value["params"]["tokenUsage"];
        if !reported.is_object() { return false; }
        let raw = codex_tokens(&reported["total"]);
        if raw.reported() {
            if !self.started {
                // 恢复通知可能补齐上轮退出前遗漏的累计，只补到会话，不算作本轮消耗。
                if data.usage_checkpoint.is_some() {
                    if let Some(before) = self.raw_base.as_ref().filter(|before| !raw.before(before)) {
                        let recovered = raw.minus(before);
                        let total = ensure(data).session_total.tokens.plus(&recovered);
                        ensure(data).session_total.tokens = total.clone();
                        self.base = Some(total);
                    }
                }
                self.raw_base = Some(raw.clone());
                data.usage_checkpoint = Some(raw);
            } else {
                let base = self.base.get_or_insert_with(|| ensure(data).session_total.tokens.clone()).clone();
                if self.raw_base.is_none() {
                    // 旧版本会话没有基线：线程累计可恢复全部历史，本轮则不能伪造差值。
                    ensure(data).session_total.tokens = raw.clone();
                    ensure(data).session_total.coverage = "partial".into();
                    self.missing_turn_base = true;
                    self.base = Some(raw.clone());
                    self.raw_base = Some(raw.clone());
                } else {
                    if !self.observed && self.raw_base.as_ref().is_some_and(|before| raw.before(before)) {
                        // 部分 CLI 恢复后累计从 0 开始，开启新统计区间，保留应用已有累计。
                        self.raw_base = Some(AiTokenUsage::default());
                    }
                    let high_water = self.high_water.get_or_insert_with(AiTokenUsage::default);
                    high_water.merge(&raw);
                    let delta = high_water.minus(self.raw_base.as_ref().unwrap());
                    if self.missing_turn_base {
                        // 累计仍可跟进，但不能把缺少起点的差值冒充完整本轮统计。
                        ensure(data).session_total.tokens = base.plus(&delta);
                    } else {
                        store_turn(data, &base, delta, "provisional");
                    }
                }
                self.observed = true;
                data.usage_checkpoint = Some(self.high_water.clone().unwrap_or(raw));
            }
        }
        let latest = &reported["last"];
        let latest_tokens = codex_tokens(latest);
        let used = number(latest, &["totalTokens", "total_tokens"])
            .or_else(|| add(latest_tokens.input_tokens, latest_tokens.output_tokens));
        let context = &mut ensure(data).context;
        // 空回合或恢复通知里的 0 不能覆盖已知上下文（同 Claude 侧，避免闪 0）。
        store_context_used(context, used, "inputAndOutput", "calculated");
        if let Some(window) = number(reported, &["modelContextWindow", "model_context_window"]).filter(|n| *n > 0) {
            context.window_tokens = Some(window);
            context.window_source = Some("cli".into());
        }
        true
    }
    pub(super) fn completed(&self, data: &mut AiSession) {
        end_turn(data);
        if let Some(turn) = ensure(data).last_turn.as_mut() {
            if self.observed && !self.missing_turn_base && turn.tokens.complete() { turn.state = "final".into(); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> crate::models::ai_chat::AiSession {
        crate::models::ai_chat::AiSession {
            id: "usage-test".into(), title: "t".into(), provider: "claude".into(),
            provider_id: None, provider_name: None, project_path: "/tmp".into(), model: None,
            status: "idle".into(), messages: Vec::new(), approvals: Vec::new(), error: None,
            created_at: 0, updated_at: 0, revision: 1, result_revision: 0, usage: Some(initial()),
            usage_checkpoint: None, owner: "o".into(), thread_id: None, request_ids: Vec::new(),
            pending_inputs: Vec::new(), slash_catalog: None, todos: Vec::new(), agents: Vec::new(), thinking: None,
            compactions: 0, desktop_open: false,
            config_options: Vec::new(),
        }
    }

    /// 回合之间不能把已知上下文清成 0，否则界面会在 0 与真实值之间跳。
    #[test]
    fn begin_turn_keeps_known_context_instead_of_resetting() {
        let mut data = session();
        {
            let context = &mut data.usage.as_mut().unwrap().context;
            context.used_tokens = Some(328_000);
            context.window_tokens = Some(500_000);
            context.window_source = Some("cli".into());
            context.updating = false;
        }
        begin_turn(&mut data);
        let context = &data.usage.as_ref().unwrap().context;
        assert_eq!(context.used_tokens, Some(328_000), "上一轮的数字应保留");
        assert!(context.updating, "保留数字但标记为待刷新");
        assert_eq!(context.window_tokens, Some(500_000));
    }

    /// 流式过程中反复写本轮统计时，必须保留开始时刻，速度计时才有效。
    #[test]
    fn store_turn_preserves_started_at_and_end_turn_stamps_end() {
        let mut data = session();
        begin_turn(&mut data);
        let started = data.usage.as_ref().unwrap().last_turn.as_ref().unwrap().started_at;
        assert!(started.is_some(), "开局应记录本轮开始时刻");
        store_turn(&mut data, &AiTokenUsage::default(),
            AiTokenUsage { input_tokens: Some(100), output_tokens: Some(20), ..Default::default() }, "provisional");
        let turn = data.usage.as_ref().unwrap().last_turn.as_ref().unwrap();
        assert_eq!(turn.started_at, started, "流式快照不能重置开始时刻");
        assert_eq!(turn.ended_at, None, "未收尾时不应有结束时刻");
        end_turn(&mut data);
        let turn = data.usage.as_ref().unwrap().last_turn.as_ref().unwrap();
        assert!(turn.ended_at.is_some(), "收尾后应补结束时刻");
    }

    /// 一次压缩会先来 status=compacting、再来 compact_boundary，只能计一次。
    #[test]
    fn compact_boundary_counts_once_per_compaction() {
        let mut data = session();
        let mut tracker = ClaudeUsageTracker::default();
        tracker.observe(&mut data, &serde_json::json!({
            "type": "system", "subtype": "status", "status": "compacting"
        }));
        assert_eq!(data.compactions, 0, "进入压缩中不计数");
        tracker.observe(&mut data, &serde_json::json!({
            "type": "system", "subtype": "compact_boundary"
        }));
        assert_eq!(data.compactions, 1, "压缩边界事件计一次");
    }

    /// 压缩后旧数字不准确，但保留并标记待更新，好过闪成 0。
    #[test]
    fn invalidate_context_keeps_last_value_and_flags_updating() {
        let mut data = session();
        {
            let context = &mut data.usage.as_mut().unwrap().context;
            context.used_tokens = Some(120_000);
            context.updating = false;
        }
        invalidate_context(&mut data);
        let context = &data.usage.as_ref().unwrap().context;
        assert_eq!(context.used_tokens, Some(120_000));
        assert!(context.updating);
    }

    /// 流式起步阶段代理先报 input_tokens: 0，不能把已知上下文冲成 0。
    #[test]
    fn claude_zero_input_keeps_known_context() {
        let mut data = session();
        {
            let context = &mut data.usage.as_mut().unwrap().context;
            context.used_tokens = Some(200_000);
            context.updating = true;
        }
        let mut tracker = ClaudeUsageTracker::default();
        tracker.observe(&mut data, &serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "message_start",
                "message": { "id": "msg-1", "model": "claude-test",
                    "usage": { "input_tokens": 0, "output_tokens": 0 } }
            }
        }));
        let context = &data.usage.as_ref().unwrap().context;
        assert_eq!(context.used_tokens, Some(200_000), "0 不能覆盖已知上下文");
        assert!(context.updating, "仍等待真实值，保持待更新标记");
    }

    /// 同一消息后续报告真实输入时，正常替换并结束待更新状态。
    #[test]
    fn claude_nonzero_input_replaces_context() {
        let mut data = session();
        let mut tracker = ClaudeUsageTracker::default();
        let start = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "message_start",
                "message": { "id": "msg-2", "model": "claude-test",
                    "usage": { "input_tokens": 0, "output_tokens": 0 } } }
        });
        tracker.observe(&mut data, &start);
        tracker.observe(&mut data, &serde_json::json!({
            "type": "assistant",
            "message": { "id": "msg-2", "model": "claude-test",
                "usage": { "input_tokens": 150_000, "output_tokens": 12 } }
        }));
        let context = &data.usage.as_ref().unwrap().context;
        assert_eq!(context.used_tokens, Some(150_000));
        assert!(!context.updating);
    }

    /// Codex 的 0 用量同样不能覆盖已知上下文。
    #[test]
    fn codex_zero_usage_keeps_known_context() {
        let mut data = session();
        {
            let context = &mut data.usage.as_mut().unwrap().context;
            context.used_tokens = Some(90_000);
        }
        let mut tracker = CodexUsageTracker::default();
        tracker.observe(&mut data, &serde_json::json!({
            "method": "thread/tokenUsage/updated",
            "params": { "tokenUsage": {
                "total": { "inputTokens": 0, "outputTokens": 0 },
                "last": { "totalTokens": 0 }
            } }
        }));
        let context = &data.usage.as_ref().unwrap().context;
        assert_eq!(context.used_tokens, Some(90_000));
    }

    /// 未配置显式容量时，不要抹掉 CLI 已报告过的窗口大小。
    #[test]
    fn configured_window_preserves_cli_reported_window() {
        let mut data = session();
        {
            let context = &mut data.usage.as_mut().unwrap().context;
            context.window_tokens = Some(328_000);
            context.window_source = Some("cli".into());
        }
        configured_window(&mut data, None);
        let context = &data.usage.as_ref().unwrap().context;
        assert_eq!(context.window_tokens, Some(328_000));
        assert_eq!(context.window_source.as_deref(), Some("cli"));

        // 显式配置仍然即时覆盖。
        configured_window(&mut data, Some(500_000));
        let context = &data.usage.as_ref().unwrap().context;
        assert_eq!(context.window_tokens, Some(500_000));
        assert_eq!(context.window_source.as_deref(), Some("configuration"));
    }
}
