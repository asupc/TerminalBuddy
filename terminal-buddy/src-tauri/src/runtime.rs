//! 桌面与独立服务端共用的状态、事件和任务接口。
use serde::Serialize;
use tokio::sync::broadcast;

#[derive(Clone, serde::Serialize)]
pub struct RuntimeEvent {
    pub event: String,
    pub payload: serde_json::Value,
}

pub struct EventBus(pub broadcast::Sender<RuntimeEvent>);

#[cfg(not(feature = "desktop"))]
pub fn shutdown(app: &AppHandle) {
    crate::services::ai_chat_service::shutdown_all();
    crate::commands::git::stop_git_commands();
    app.state::<crate::commands::TerminalService>().shutdown_all_terminals(app);
    crate::services::ClaudeHookService::release_all_on_shutdown();
}

impl Default for EventBus {
    fn default() -> Self {
        Self(broadcast::channel(256).0)
    }
}

#[cfg(feature = "desktop")]
pub use tauri::{AppHandle, Manager, State, WebviewWindow};
#[cfg(feature = "desktop")]
pub use tauri::async_runtime;

#[cfg(not(feature = "desktop"))]
pub use headless::{AppHandle, Manager, State};
#[cfg(not(feature = "desktop"))]
pub mod async_runtime {
    pub use tokio::{spawn, task::{spawn_blocking, JoinHandle}};
}

pub trait Emitter {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String>;
}

fn publish_to_event_bus<S: Serialize>(
    bus: &broadcast::Sender<RuntimeEvent>,
    event: &str,
    payload: &S,
) -> Result<(), String> {
    // 浏览器 /ws/events 从不消费 terminal_output_*，且无订阅者时无需序列化进广播队列，
    // 避免高频终端输出把所有负载双份转成 serde_json::Value 并触发 Lagged 风暴。
    if !event.starts_with("terminal_output_") && bus.receiver_count() > 0 {
        let message = RuntimeEvent {
            event: event.to_string(),
            payload: serde_json::to_value(payload).map_err(|e| e.to_string())?,
        };
        let _ = bus.send(message);
    }
    Ok(())
}

impl Emitter for AppHandle {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String> {
        publish_to_event_bus(&self.state::<EventBus>().0, event, &payload)?;
        #[cfg(feature = "desktop")]
        tauri::Emitter::emit(self, event, payload).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(not(feature = "desktop"))]
mod headless {
    use std::{any::{Any, TypeId}, collections::HashMap, ops::Deref, sync::Arc};

    #[derive(Clone)]
    pub struct AppHandle(Arc<HashMap<TypeId, Box<dyn Any + Send + Sync>>>);

    impl AppHandle {
        pub fn new() -> Self {
            let mut states: HashMap<TypeId, Box<dyn Any + Send + Sync>> = HashMap::new();
            macro_rules! state {
                ($value:expr) => {{
                    let value = $value;
                    states.insert(value.type_id(), Box::new(value));
                }};
            }
            state!(super::EventBus::default());
            state!(crate::commands::TerminalService::new());
            state!(crate::services::SshSessionService::new());
            state!(crate::services::WebServiceState::new());
            state!(crate::commands::MonitorCache::new());
            Self(Arc::new(states))
        }
    }

    pub trait Manager {
        fn state<T: Send + Sync + 'static>(&self) -> State<'_, T>;
        /// 可选状态：未注册时返回 None，与桌面端 Tauri 的 `Manager::try_state` 对齐。
        fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>>;
    }

    impl Manager for AppHandle {
        fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
            State(self.0.get(&TypeId::of::<T>()).and_then(|v| v.downcast_ref())
                .expect("运行时状态必须在启动时注册"))
        }
        fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
            self.0.get(&TypeId::of::<T>()).and_then(|v| v.downcast_ref()).map(State)
        }
    }

    pub struct State<'a, T: Send + Sync + 'static>(&'a T);
    impl<'a, T: Send + Sync + 'static> State<'a, T> {
        pub fn inner(&self) -> &'a T { self.0 }
    }
    impl<T: Send + Sync + 'static> Deref for State<'_, T> {
        type Target = T;
        fn deref(&self) -> &T { self.0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_bus_skips_terminal_output_and_idle_channels() {
        let (tx, mut rx) = broadcast::channel(8);
        publish_to_event_bus(&tx, "terminal_output_abc", &"hello").unwrap();
        assert!(rx.try_recv().is_err(), "terminal_output_* 不应写入 EventBus");

        publish_to_event_bus(&tx, "other-event", &"world").unwrap();
        let received = rx.try_recv().expect("普通事件在有订阅者时应送达");
        assert_eq!(received.event, "other-event");
        assert_eq!(received.payload, serde_json::json!("world"));

        drop(rx);
        assert_eq!(tx.receiver_count(), 0);
        publish_to_event_bus(&tx, "other-event", &"ignored").unwrap();
    }
}
