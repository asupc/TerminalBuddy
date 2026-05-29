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

    pub fn unsubscribe(&self, terminal_id: &str, sub_id: &str) {
        let mut subs = self.output_subscribers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(senders) = subs.get_mut(terminal_id) {
            senders.retain(|(id, _)| id != sub_id);
            if senders.is_empty() {
                subs.remove(terminal_id);
            }
        }
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
