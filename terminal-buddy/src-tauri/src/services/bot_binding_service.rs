use crate::models::DecisionBinding;
use crate::services::DatabaseService;
use chrono::Utc;
use std::sync::{Mutex, OnceLock};

const DECISION_BATCH_WINDOW_MS: u64 = 10_000;

// cancel() 在决策从未发送（无真实 binding）时会插入一条占位条目以备后续 add() 的复活守卫使用。
// 历史上 channel_id/external_message_id 都填空串，导致 PK("","") 重复撞 UNIQUE 约束。
// 这里改用魔术 channel + decision_id 作为 message_id，保证 PK 唯一；select_reply_binding_index
// 等下游匹配仍走真实 channel_id，不会命中 sentinel。
const CANCEL_SENTINEL_CHANNEL: &str = "__cancel_sentinel__";

fn binding_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn binding_created_at(binding: &DecisionBinding) -> i64 {
    if binding.created_at > 0 {
        binding.created_at
    } else {
        // Older persisted bindings did not store createdAt. Their shared TTL keeps
        // expiresAt in the same relative order, so it remains a usable fallback.
        binding.expires_at
    }
}

fn select_reply_binding_index(
    bindings: &[DecisionBinding],
    channel_id: &str,
    sender_id: &str,
    conversation_id: &str,
    reply_to_message_id: Option<&str>,
) -> Option<usize> {
    let exact = reply_to_message_id.and_then(|message_id| {
        bindings.iter().rposition(|binding| {
            binding.channel_id == channel_id && binding.external_message_id == message_id
        })
    });
    exact.or_else(|| {
        let matches_reply = |binding: &DecisionBinding| {
            binding.channel_id == channel_id
                && (binding.target_id == sender_id || binding.target_id == conversation_id)
                && binding.status == "pending"
        };
        let latest_index = bindings.iter().rposition(matches_reply)?;
        let latest_created_at = binding_created_at(&bindings[latest_index]);
        bindings
            .iter()
            .enumerate()
            .find(|(_, binding)| {
                matches_reply(binding)
                    && binding_created_at(binding).abs_diff(latest_created_at)
                        <= DECISION_BATCH_WINDOW_MS
            })
            .map(|(index, _)| index)
    })
}

pub struct BotBindingService;

impl BotBindingService {
    fn read() -> Vec<DecisionBinding> {
        DatabaseService::list_decision_bindings().unwrap_or_default()
    }

    fn write(bindings: &[DecisionBinding]) -> Result<(), String> {
        DatabaseService::save_decision_bindings(bindings)
    }

    fn prune(bindings: &mut Vec<DecisionBinding>) {
        let now = Utc::now().timestamp_millis();
        for binding in bindings.iter_mut() {
            if matches!(binding.status.as_str(), "pending" | "processing")
                && binding.expires_at <= now
            {
                binding.status = "expired".to_string();
            }
        }
        let retention = now - 7 * 24 * 60 * 60 * 1_000;
        bindings.retain(|binding| binding.status == "pending" || binding.expires_at >= retention);
    }

    pub fn add(binding: DecisionBinding) -> Result<(), String> {
        let _guard = binding_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut bindings = Self::read();
        Self::prune(&mut bindings);
        if bindings.iter().any(|item| {
            item.decision_id == binding.decision_id
                && !matches!(item.status.as_str(), "pending" | "processing")
        }) {
            return Ok(());
        }
        bindings.retain(|item| {
            !(item.channel_id == binding.channel_id
                && item.external_message_id == binding.external_message_id)
        });
        bindings.push(binding);
        Self::write(&bindings)
    }

    pub fn cancel(decision_id: &str) -> Result<(), String> {
        let _guard = binding_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut bindings = Self::read();
        let mut changed = false;
        for binding in &mut bindings {
            if binding.decision_id == decision_id
                && matches!(binding.status.as_str(), "pending" | "processing")
            {
                binding.status = "cancelled".to_string();
                changed = true;
            }
        }
        if !bindings
            .iter()
            .any(|binding| binding.decision_id == decision_id)
        {
            bindings.push(DecisionBinding {
                decision_id: decision_id.to_string(),
                terminal_id: String::new(),
                terminal_name: String::new(),
                channel_id: CANCEL_SENTINEL_CHANNEL.to_string(),
                target_id: String::new(),
                external_message_id: decision_id.to_string(),
                custom_option_down_count: None,
                option_move_counts: Vec::new(),
                option_labels: Vec::new(),
                initial_selected_move_counts: Vec::new(),
                recommended_move_count: None,
                multi_select: false,
                submit_move_count: None,
                created_at: Utc::now().timestamp_millis(),
                status: "cancelled".to_string(),
                expires_at: Utc::now().timestamp_millis() + 24 * 60 * 60 * 1_000,
            });
            changed = true;
        }
        if changed {
            Self::write(&bindings)?;
        }
        Ok(())
    }

    fn consume_selected_with<F, S>(
        select: S,
        not_found_message: &str,
        write: F,
    ) -> Result<DecisionBinding, String>
    where
        F: FnOnce(&DecisionBinding) -> Result<(), String>,
        S: FnOnce(&[DecisionBinding]) -> Option<usize>,
    {
        let binding = {
            let _guard = binding_lock()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let mut bindings = Self::read();
            Self::prune(&mut bindings);
            let index = select(&bindings).ok_or_else(|| not_found_message.to_string())?;
            let binding = bindings[index].clone();
            match binding.status.as_str() {
                "pending" => {}
                "processing" => return Err("该决策正在处理".to_string()),
                "consumed" => return Err("该决策已经处理".to_string()),
                "expired" => return Err("该决策已经过期".to_string()),
                _ => return Err("该决策已经取消".to_string()),
            }
            if binding.expires_at <= Utc::now().timestamp_millis() {
                bindings[index].status = "expired".to_string();
                Self::write(&bindings)?;
                return Err("该决策已经过期".to_string());
            }
            bindings[index].status = "processing".to_string();
            Self::write(&bindings)?;
            binding
        };

        let result = write(&binding);
        let _guard = binding_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut bindings = Self::read();
        Self::prune(&mut bindings);
        match &result {
            Ok(()) => {
                for item in &mut bindings {
                    if item.decision_id == binding.decision_id
                        && matches!(item.status.as_str(), "pending" | "processing")
                    {
                        item.status = "consumed".to_string();
                    }
                }
            }
            Err(_) => {
                if let Some(item) = bindings.iter_mut().find(|item| {
                    item.channel_id == binding.channel_id
                        && item.external_message_id == binding.external_message_id
                        && item.status == "processing"
                }) {
                    item.status = "pending".to_string();
                }
            }
        }
        Self::write(&bindings)?;
        result?;
        Ok(binding)
    }

    pub fn consume_with<F>(
        channel_id: &str,
        external_message_id: &str,
        write: F,
    ) -> Result<DecisionBinding, String>
    where
        F: FnOnce(&DecisionBinding) -> Result<(), String>,
    {
        Self::consume_selected_with(
            |bindings| {
                bindings.iter().position(|binding| {
                    binding.channel_id == channel_id
                        && binding.external_message_id == external_message_id
                })
            },
            "未找到被引用的待决策消息",
            write,
        )
    }

    pub fn consume_reply_with<F>(
        channel_id: &str,
        sender_id: &str,
        conversation_id: &str,
        reply_to_message_id: Option<&str>,
        write: F,
    ) -> Result<DecisionBinding, String>
    where
        F: FnOnce(&DecisionBinding) -> Result<(), String>,
    {
        Self::consume_selected_with(
            |bindings| {
                select_reply_binding_index(
                    bindings,
                    channel_id,
                    sender_id,
                    conversation_id,
                    reply_to_message_id,
                )
            },
            "当前没有可回复的待决策消息",
            write,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::select_reply_binding_index;
    use crate::models::DecisionBinding;

    fn binding_at(
        message_id: &str,
        target_id: &str,
        status: &str,
        created_at: i64,
    ) -> DecisionBinding {
        DecisionBinding {
            decision_id: format!("decision-{}", message_id),
            terminal_id: "terminal".to_string(),
            terminal_name: "终端".to_string(),
            channel_id: "weixin".to_string(),
            target_id: target_id.to_string(),
            external_message_id: message_id.to_string(),
            custom_option_down_count: None,
            option_move_counts: vec![0, 1],
            option_labels: vec!["一".to_string(), "二".to_string()],
            initial_selected_move_counts: Vec::new(),
            recommended_move_count: Some(0),
            multi_select: false,
            submit_move_count: None,
            created_at,
            status: status.to_string(),
            expires_at: i64::MAX,
        }
    }

    #[test]
    fn direct_reply_selects_latest_pending_binding() {
        let bindings = vec![
            binding_at("first", "user", "pending", 1_000),
            binding_at("second", "user", "pending", 12_000),
        ];
        assert_eq!(
            select_reply_binding_index(&bindings, "weixin", "user", "user", None),
            Some(1)
        );
    }

    #[test]
    fn ten_second_batch_processes_bindings_in_event_order() {
        let bindings = vec![
            binding_at("first", "user", "pending", 1_000),
            binding_at("second", "user", "pending", 11_000),
        ];
        assert_eq!(
            select_reply_binding_index(&bindings, "weixin", "user", "user", None),
            Some(0)
        );
    }

    #[test]
    fn ten_second_batch_advances_after_first_binding_is_consumed() {
        let bindings = vec![
            binding_at("first", "user", "consumed", 1_000),
            binding_at("second", "user", "pending", 11_000),
        ];
        assert_eq!(
            select_reply_binding_index(&bindings, "weixin", "user", "user", None),
            Some(1)
        );
    }

    #[test]
    fn unknown_mobile_quote_falls_back_to_latest_pending_binding() {
        let bindings = vec![
            binding_at("first-client-id", "user", "pending", 1_000),
            binding_at("second-client-id", "user", "pending", 12_000),
        ];
        assert_eq!(
            select_reply_binding_index(&bindings, "weixin", "user", "user", Some("server-msg-id"),),
            Some(1)
        );
    }

    #[test]
    fn cancel_sentinel_channel_is_non_empty() {
        // 防止有人把 sentinel channel 改回空串：那样 cancel() 多次为不同 decision_id
        // 插入占位条目时会撞 PK(channel_id="", external_message_id=decision_id) 的同一行，
        // 触发 UNIQUE constraint failed。
        use super::CANCEL_SENTINEL_CHANNEL;
        assert!(!CANCEL_SENTINEL_CHANNEL.is_empty());
    }
}
