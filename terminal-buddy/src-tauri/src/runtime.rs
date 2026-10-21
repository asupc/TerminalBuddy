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

impl Emitter for AppHandle {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String> {
        let message = RuntimeEvent {
            event: event.to_string(),
            payload: serde_json::to_value(&payload).map_err(|e| e.to_string())?,
        };
        let _ = self.state::<EventBus>().0.send(message);
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
    }

    impl Manager for AppHandle {
        fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
            State(self.0.get(&TypeId::of::<T>()).and_then(|v| v.downcast_ref())
                .expect("运行时状态必须在启动时注册"))
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
