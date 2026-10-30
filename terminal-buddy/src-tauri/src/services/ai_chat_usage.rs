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
    ensure(data).last_turn = Some(AiTurnUsage { state: "provisional".into(), ..Default::default() });
}
pub(super) fn finish_turn(data: &mut AiSession) {
    let Some(usage) = data.usage.as_mut() else { return; };
    if let Some(turn) = usage.last_turn.as_mut() {
        if turn.state != "final" || !turn.tokens.complete() {
            turn.state = "partial".into();
            if usage.session_total.coverage == "complete" { usage.session_total.coverage = "partial".into(); }
        }
    }
}
pub(super) fn configured_window(data: &mut AiSession, window: Option<u64>) {
    let context = &mut ensure(data).context;
    // 显式配置即时生效；默认配置沿用最近的 CLI 报告，下一份报告到达后再校正。
    // 会话的供应商和模型不变，因此无需在每次发送时把已知容量变回未知。
    if let Some(window) = window.filter(|n| *n > 0 && *n <= i64::MAX as u64) {
        context.window_tokens = Some(window);
        context.window_source = Some("configuration".into());
    } else if context.window_source.as_deref() != Some("cli") {
        context.window_tokens = None;
        context.window_source = None;
    }
}
fn store_turn(data: &mut AiSession, base: &AiTokenUsage, tokens: AiTokenUsage, state: &str) {
    let usage = ensure(data);
    usage.session_total.tokens = base.plus(&tokens);
    usage.last_turn = Some(AiTurnUsage { tokens, state: state.into() });
}
pub(super) fn invalidate_context(data: &mut AiSession) {
    let context = &mut ensure(data).context;
    context.used_tokens = None;
    context.used_source = None;
    context.updating = true;
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
                if let Some(input) = record.input_tokens {
                    let context = &mut ensure(data).context;
                    context.used_tokens = Some(input);
                    context.basis = "input".into();
                    context.used_source = Some("cliUsage".into());
                    context.updating = false;
                }
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
        if method == "thread/compacted" || (method == "item/started" && value["params"]["item"]["type"] == "contextCompaction") {
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
        if let Some(used) = used {
            context.used_tokens = Some(used);
            context.basis = "inputAndOutput".into();
            context.used_source = Some("calculated".into());
            context.updating = false;
        }
        if let Some(window) = number(reported, &["modelContextWindow", "model_context_window"]).filter(|n| *n > 0) {
            context.window_tokens = Some(window);
            context.window_source = Some("cli".into());
        }
        true
    }
    pub(super) fn completed(&self, data: &mut AiSession) {
        if let Some(turn) = ensure(data).last_turn.as_mut() {
            if self.observed && !self.missing_turn_base && turn.tokens.complete() { turn.state = "final".into(); }
        }
    }
}

/// Pi 的 `usage.input` 不含缓存（与 Claude 相同），`reasoning` 已包含在 `output` 中。
fn pi_tokens(value: &Value) -> AiTokenUsage {
    let fresh = number(value, &["input"]);
    let cached = number(value, &["cacheRead"]);
    let created = number(value, &["cacheWrite"]);
    AiTokenUsage {
        input_tokens: add(add(fresh, cached), created),
        output_tokens: number(value, &["output"]),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: created,
        reasoning_output_tokens: number(value, &["reasoning"]),
    }
}

#[derive(Default)]
pub(super) struct PiUsageTracker {
    base: Option<AiTokenUsage>,
    // Pi 消息没有稳定 id，按回合内序号累计；`message_update.usage` 是单条响应内的累计。
    messages: HashMap<u64, AiTokenUsage>,
}
impl PiUsageTracker {
    pub(super) fn start(&mut self, data: &mut AiSession) {
        self.base = Some(ensure(data).session_total.tokens.clone());
        self.messages.clear();
    }
    pub(super) fn observe(&mut self, data: &mut AiSession, index: u64, value: &Value) -> bool {
        let tokens = pi_tokens(value);
        if !tokens.reported() { return false; }
        let base = self.base.get_or_insert_with(|| ensure(data).session_total.tokens.clone()).clone();
        self.messages.entry(index).or_default().merge(&tokens);
        let total = self.messages.values().fold(AiTokenUsage::default(), |sum, usage| sum.plus(usage));
        store_turn(data, &base, total, "provisional");
        true
    }
    /// 回合结束后用 `get_session_stats` 的全会话累计做权威结算，覆盖工具嵌套的模型消耗。
    pub(super) fn settled(&mut self, data: &mut AiSession, stats: &Value) {
        let tokens = pi_tokens(&stats["tokens"]);
        if tokens.reported() {
            let base = self.base.get_or_insert_with(|| ensure(data).session_total.tokens.clone()).clone();
            let state = if tokens.complete() { "final" } else { "partial" };
            store_turn(data, &base, tokens.minus(&base), state);
        } else if let Some(turn) = ensure(data).last_turn.as_mut() { turn.state = "partial".into(); }
        let context = &mut ensure(data).context;
        let usage = &stats["contextUsage"];
        if let Some(used) = number(usage, &["tokens"]) {
            context.used_tokens = Some(used);
            context.basis = "input".into();
            context.used_source = Some("cliUsage".into());
            context.updating = false;
        }
        if let Some(window) = number(usage, &["contextWindow"]).filter(|n| *n > 0) {
            context.window_tokens = Some(window);
            context.window_source = Some("cli".into());
        }
    }
}
