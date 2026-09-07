use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub type OutputData = Arc<str>;

/// `unsubscribe` 的结果，供 WS 收尾判断是否需要发送 takeover-ended。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsubscribeOutcome {
    /// 已移除，该终端还有其他订阅者。
    RemovedNotLast,
    /// 已移除，且是该终端最后一个订阅者。
    RemovedLast,
    /// 订阅已不存在：终端被 `close_all` 清空，或本次是重复收尾。
    NotFound,
}

pub struct WebServiceState {
    pub output_subscribers:
        Arc<Mutex<HashMap<String, Vec<(String, mpsc::UnboundedSender<OutputData>)>>>>,
    next_subscriber_id: Arc<Mutex<u64>>,
}

impl WebServiceState {
    pub fn new() -> Self {
        Self {
            output_subscribers: Arc::new(Mutex::new(HashMap::new())),
            next_subscriber_id: Arc::new(Mutex::new(0)),
        }
    }

    fn lock_subscribers(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, Vec<(String, mpsc::UnboundedSender<OutputData>)>>>
    {
        self.output_subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn next_id(&self) -> String {
        let mut id_counter = self
            .next_subscriber_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let sub_id = id_counter.to_string();
        *id_counter += 1;
        sub_id
    }

    /// 在同一个锁操作内完成「检查每终端连接上限」和「注册订阅」，
    /// 消除先查后写留下的并发超限窗口。超限时返回 `None`。
    pub fn subscribe_within_limit(
        &self,
        terminal_id: &str,
        max_per_terminal: usize,
    ) -> Option<(String, mpsc::UnboundedReceiver<OutputData>)> {
        let sub_id = self.next_id();
        let (tx, rx) = mpsc::unbounded_channel();
        let mut subs = self.lock_subscribers();
        let senders = subs.entry(terminal_id.to_string()).or_default();
        if senders.len() >= max_per_terminal {
            // 该终端此前没有订阅者时不要留下空 entry，否则 unsubscribe 语义会被污染。
            if senders.is_empty() {
                subs.remove(terminal_id);
            }
            return None;
        }
        senders.push((sub_id.clone(), tx));
        Some((sub_id, rx))
    }

    pub fn get_subscriber_count(&self, terminal_id: &str) -> usize {
        self.lock_subscribers()
            .get(terminal_id)
            .map_or(0, |v| v.len())
    }

    /// 移除一个订阅并报告它是否为最后一个。调用方据此决定是否发送
    /// takeover-ended：`NotFound` 表示终端已整体关闭，不应再发恢复事件。
    pub fn unsubscribe(&self, terminal_id: &str, sub_id: &str) -> UnsubscribeOutcome {
        let mut subs = self.lock_subscribers();
        let Some(senders) = subs.get_mut(terminal_id) else {
            return UnsubscribeOutcome::NotFound;
        };
        let before = senders.len();
        senders.retain(|(id, _)| id != sub_id);
        if senders.len() == before {
            // 本订阅已不在表中（例如被 broadcast 的死链清理顺带移除）。
            if senders.is_empty() {
                subs.remove(terminal_id);
            }
            return UnsubscribeOutcome::NotFound;
        }
        if senders.is_empty() {
            subs.remove(terminal_id);
            UnsubscribeOutcome::RemovedLast
        } else {
            UnsubscribeOutcome::RemovedNotLast
        }
    }

    /// 丢弃某终端的全部订阅者（drop 所有 sender）→ 各 receiver 的 recv() 返回 None，
    /// 使 WS handler 得知 PTY 已退出并向手机端发送 Exited。PTY EOF / 显式关闭时调用。
    pub fn close_all(&self, terminal_id: &str) {
        self.lock_subscribers().remove(terminal_id);
    }

    pub fn broadcast(&self, terminal_id: &str, data: &Arc<str>) {
        let mut subs = self.lock_subscribers();
        let Some(senders) = subs.get_mut(terminal_id) else {
            return;
        };
        let mut dead = false;
        for (_, tx) in senders.iter() {
            // Arc clone is cheap — no string copy per subscriber
            if tx.send(data.clone()).is_err() {
                dead = true;
            }
        }
        if dead {
            senders.retain(|(_, tx)| !tx.is_closed());
            if senders.is_empty() {
                subs.remove(terminal_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribe_respects_the_per_terminal_limit_atomically() {
        let state = WebServiceState::new();
        let first = state.subscribe_within_limit("t1", 2);
        let second = state.subscribe_within_limit("t1", 2);
        assert!(first.is_some() && second.is_some());
        assert!(state.subscribe_within_limit("t1", 2).is_none());
        assert_eq!(state.get_subscriber_count("t1"), 2);
    }

    #[test]
    fn rejected_subscribe_does_not_leave_an_empty_entry() {
        let state = WebServiceState::new();
        assert!(state.subscribe_within_limit("t1", 0).is_none());
        assert_eq!(
            state.unsubscribe("t1", "0"),
            UnsubscribeOutcome::NotFound,
            "被拒绝的订阅不得留下 entry"
        );
    }

    #[test]
    fn unsubscribe_reports_last_only_once() {
        let state = WebServiceState::new();
        let (a, _ra) = state.subscribe_within_limit("t1", 5).unwrap();
        let (b, _rb) = state.subscribe_within_limit("t1", 5).unwrap();
        assert_eq!(
            state.unsubscribe("t1", &a),
            UnsubscribeOutcome::RemovedNotLast
        );
        assert_eq!(state.unsubscribe("t1", &b), UnsubscribeOutcome::RemovedLast);
        assert_eq!(state.unsubscribe("t1", &b), UnsubscribeOutcome::NotFound);
    }

    /// close_all 之后每个 WS 收尾都必须得到 NotFound，避免重复 takeover-ended。
    #[test]
    fn close_all_makes_every_later_unsubscribe_not_found() {
        let state = WebServiceState::new();
        let (a, _ra) = state.subscribe_within_limit("t1", 5).unwrap();
        let (b, _rb) = state.subscribe_within_limit("t1", 5).unwrap();
        state.close_all("t1");
        assert_eq!(state.unsubscribe("t1", &a), UnsubscribeOutcome::NotFound);
        assert_eq!(state.unsubscribe("t1", &b), UnsubscribeOutcome::NotFound);
    }

    #[test]
    fn broadcast_drops_closed_subscribers() {
        let state = WebServiceState::new();
        let (_a, ra) = state.subscribe_within_limit("t1", 5).unwrap();
        drop(ra);
        state.broadcast("t1", &Arc::from("hello"));
        assert_eq!(state.get_subscriber_count("t1"), 0);
    }
}
