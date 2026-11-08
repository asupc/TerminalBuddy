use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use crate::models::TerminalViewport;

pub type OutputData = Arc<str>;

/// 订阅条目：(订阅 id, 事件发送端, 是否因慢客户端溢出被断开)。
/// 溢出标记让 WS handler 能区分「PTY 退出」与「队列满被限流」，前者发 Exited
/// 让客户端永久关闭页签，后者应发可重连的错误帧（复核 #4）。
type Subscriber = (String, mpsc::Sender<WebTerminalEvent>, Arc<AtomicBool>);

#[derive(Clone)]
pub enum WebTerminalEvent {
    Output(OutputData),
    Viewport(TerminalViewport),
}

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

/// 单个订阅者的输出事件队列上限。慢客户端（TCP 背压导致 send_task 停止消费）
/// 积压超限即被断开，防止无界增长拖垮进程（审查 M-3）。
/// 正常客户端的消费速度下该队列毫秒级清空，256 足以缓冲偶发的瞬时卡顿。
const MAX_SUBSCRIBER_QUEUE: usize = 256;

pub struct WebServiceState {
    pub output_subscribers:
        Arc<Mutex<HashMap<String, Vec<Subscriber>>>>,
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
    ) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Subscriber>>>
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
    ) -> Option<(String, mpsc::Receiver<WebTerminalEvent>, Arc<AtomicBool>)> {
        let sub_id = self.next_id();
        // 有界通道：慢客户端积压超限时由 broadcast_event 断开（审查 M-3）。
        let (tx, rx) = mpsc::channel(MAX_SUBSCRIBER_QUEUE);
        let overflowed = Arc::new(AtomicBool::new(false));
        let mut subs = self.lock_subscribers();
        let senders = subs.entry(terminal_id.to_string()).or_default();
        if senders.len() >= max_per_terminal {
            // 该终端此前没有订阅者时不要留下空 entry，否则 unsubscribe 语义会被污染。
            if senders.is_empty() {
                subs.remove(terminal_id);
            }
            return None;
        }
        senders.push((sub_id.clone(), tx, overflowed.clone()));
        Some((sub_id, rx, overflowed))
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
        senders.retain(|(id, _, _)| id != sub_id);
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
        self.broadcast_event(terminal_id, WebTerminalEvent::Output(data.clone()));
    }

    pub fn broadcast_viewport(&self, terminal_id: &str, viewport: TerminalViewport) {
        self.broadcast_event(terminal_id, WebTerminalEvent::Viewport(viewport));
    }

    fn broadcast_event(&self, terminal_id: &str, event: WebTerminalEvent) {
        let mut subs = self.lock_subscribers();
        let Some(senders) = subs.get_mut(terminal_id) else {
            return;
        };
        let mut dead = false;
        for (_, tx, overflowed) in senders.iter() {
            // Arc clone is cheap — no string copy per subscriber。
            // try_send：队列满（慢客户端积压超限）或接收端已关都断开该订阅者。
            if tx.try_send(event.clone()).is_err() {
                // 接收端仍打开却发不进去 = 只可能是队列满：标记为「限流断开」，
                // 让 WS handler 发可重连的错误帧而不是永久的 Exited。
                if !tx.is_closed() {
                    overflowed.store(true, Ordering::Release);
                }
                dead = true;
            }
        }
        if dead {
            // 只移除已关闭或已标记溢出的订阅者；容量恰好为 0 但本次发送成功的
            // 客户端并未溢出，不能连带误删（复核 #4）。
            senders.retain(|(_, tx, overflowed)| {
                !tx.is_closed() && !overflowed.load(Ordering::Acquire)
            });
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
        let (a, _ra, _oa) = state.subscribe_within_limit("t1", 5).unwrap();
        let (b, _rb, _ob) = state.subscribe_within_limit("t1", 5).unwrap();
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
        let (a, _ra, _oa) = state.subscribe_within_limit("t1", 5).unwrap();
        let (b, _rb, _ob) = state.subscribe_within_limit("t1", 5).unwrap();
        state.close_all("t1");
        assert_eq!(state.unsubscribe("t1", &a), UnsubscribeOutcome::NotFound);
        assert_eq!(state.unsubscribe("t1", &b), UnsubscribeOutcome::NotFound);
    }

    #[test]
    fn broadcast_drops_closed_subscribers() {
        let state = WebServiceState::new();
        let (_a, ra, _oa) = state.subscribe_within_limit("t1", 5).unwrap();
        drop(ra);
        state.broadcast("t1", &Arc::from("hello"));
        assert_eq!(state.get_subscriber_count("t1"), 0);
    }
}
