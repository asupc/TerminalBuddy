use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tokio::sync::mpsc;

pub struct WebServiceState {
    pub output_subscribers: Arc<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>>,
}

impl WebServiceState {
    pub fn new() -> Self {
        Self {
            output_subscribers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn subscribe(&self, terminal_id: &str) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut subs = self.output_subscribers.lock().unwrap();
        subs.entry(terminal_id.to_string()).or_default().push(tx);
        rx
    }

    pub fn unsubscribe(&self, terminal_id: &str) {
        let mut subs = self.output_subscribers.lock().unwrap();
        subs.remove(terminal_id);
    }

    pub fn broadcast(&self, terminal_id: &str, data: &str) {
        let subs = self.output_subscribers.lock().unwrap();
        if let Some(senders) = subs.get(terminal_id) {
            let mut dead = false;
            for tx in senders {
                if tx.send(data.to_string()).is_err() {
                    dead = true;
                }
            }
            if dead {
                drop(subs);
                let mut subs = self.output_subscribers.lock().unwrap();
                if let Some(senders) = subs.get_mut(terminal_id) {
                    senders.retain(|tx| !tx.is_closed());
                }
            }
        }
    }
}
