//! 原生 Claude 会话复用桌面端 HTTP Hook，按启动实例隔离投递，不向桌面广播手机问题。
use super::{ClaudeHookDecisionEvent, ClaudeHookService};
use std::{collections::HashMap, process::Command, sync::{mpsc, Mutex, OnceLock}};

const TARGET_PREFIX: &str = "ai-session:";

pub(crate) enum NativeHookEvent {
    Decision(ClaudeHookDecisionEvent),
    Settled(String),
}

fn targets() -> &'static Mutex<HashMap<String, mpsc::Sender<NativeHookEvent>>> {
    static TARGETS: OnceLock<Mutex<HashMap<String, mpsc::Sender<NativeHookEvent>>>> = OnceLock::new();
    TARGETS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn is_native_target(target: &str) -> bool { target.starts_with(TARGET_PREFIX) }

pub(crate) fn publish(target: &str, event: NativeHookEvent) -> Result<(), String> {
    targets().lock().map_err(|_| "Claude 决策通道不可用")?.get(target).ok_or("Claude 会话已结束")?
        .send(event).map_err(|_| "Claude 会话已结束".into())
}

pub(super) struct NativeClaudeHooks {
    target: String,
    token: String,
    pub receiver: mpsc::Receiver<NativeHookEvent>,
}
impl NativeClaudeHooks {
    pub fn register() -> Result<Self, String> {
        if ClaudeHookService::server_port() == 0 {
            return Err("Claude 决策 Hook 服务未启动，请重启服务端后重试".into());
        }
        let target = format!("{TARGET_PREFIX}{}", uuid::Uuid::new_v4());
        let (sender, receiver) = mpsc::channel();
        let mut targets = targets().lock().map_err(|_| "Claude 决策通道不可用")?;
        let token = ClaudeHookService::register_terminal(&target);
        targets.insert(target.clone(), sender);
        Ok(Self { target, token, receiver })
    }

    pub fn configure(&self, command: &mut Command) {
        command.env("TERMINAL_BUDDY_TERMINAL_ID", &self.target)
            .env("TERMINAL_BUDDY_HOOK_TOKEN", &self.token);
    }
}
impl Drop for NativeClaudeHooks {
    fn drop(&mut self) {
        if let Ok(mut targets) = targets().lock() { targets.remove(&self.target); }
        ClaudeHookService::unregister_terminal(&self.target);
    }
}
