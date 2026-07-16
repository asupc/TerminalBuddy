use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tokio::sync::mpsc;

pub type OutputData = Arc<str>;

pub struct WebServiceState {
    pub output_subscribers: Arc<Mutex<HashMap<String, Vec<(String, mpsc::UnboundedSender<OutputData>)>>>>,
    next_subscriber_id: Arc<Mutex<u64>>,
}

impl WebServiceState {
    pub fn new() -> Self {
        Self {
            output_subscribers: Arc::new(Mutex::new(HashMap::new())),
            next_subscriber_id: Arc::new(Mutex::new(0)),
        }
    }

    pub fn subscribe(&self, terminal_id: &str) -> (String, mpsc::UnboundedReceiver<OutputData>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut id_counter = self.next_subscriber_id.lock().unwrap_or_else(|e| e.into_inner());
        let sub_id = id_counter.to_string();
        *id_counter += 1;
        drop(id_counter);

        let mut subs = self.output_subscribers.lock().unwrap_or_else(|e| e.into_inner());
        subs.entry(terminal_id.to_string()).or_default().push((sub_id.clone(), tx));
        (sub_id, rx)
    }

    pub fn get_subscriber_count(&self, terminal_id: &str) -> usize {
        if let Ok(subs) = self.output_subscribers.lock() {
            subs.get(terminal_id).map_or(0, |v| v.len())
        } else {
            0
        }
    }

    pub fn unsubscribe_and_notify_if_last<F>(&self, terminal_id: &str, sub_id: &str, on_last: F)
    where
        F: FnOnce(),
    {
        let mut subs = self.output_subscribers.lock().unwrap_or_else(|e| e.into_inner());
        let is_last = if let Some(senders) = subs.get_mut(terminal_id) {
            senders.retain(|(id, _)| id != sub_id);
            senders.is_empty()
        } else {
            true
        };
        if is_last {
            subs.remove(terminal_id);
            // Keep the subscriber lock until the event is queued so a reconnect
            // cannot publish its resize before this older connection's end event.
            on_last();
        }
    }

    /// 丢弃某终端的全部订阅者（drop 所有 sender）→ 各 receiver 的 recv() 返回 None，
    /// 使 WS handler 得知 PTY 已退出并向手机端发送 Exited。PTY EOF / 显式关闭时调用。
    pub fn close_all(&self, terminal_id: &str) {
        let mut subs = self.output_subscribers.lock().unwrap_or_else(|e| e.into_inner());
        subs.remove(terminal_id);
    }

    pub fn broadcast(&self, terminal_id: &str, data: &Arc<str>) {
        let subs = self.output_subscribers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(senders) = subs.get(terminal_id) {
            let mut dead = false;
            for (_, tx) in senders {
                // Arc clone is cheap — no string copy per subscriber
                if tx.send(data.clone()).is_err() {
                    dead = true;
                }
            }
            if dead {
                drop(subs);
                let mut subs = self.output_subscribers.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(senders) = subs.get_mut(terminal_id) {
                    senders.retain(|(_, tx)| !tx.is_closed());
                }
            }
        }
    }
}
