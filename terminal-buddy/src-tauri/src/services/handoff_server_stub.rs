//! 默认终端 handoff 的占位实现（非 Windows 平台）。
//!
//! handoff 依赖 Windows COM（`ITerminalHandoff3`）与 console 句柄语义，其他平台
//! 没有对应机制。这里保留与 Windows 实现一致的公开接口，保证调用方（`desktop.rs`、
//! `default_terminal_service`、`commands/terminal.rs`）在编译期一致，运行时给出
//! 明确的「不支持」结果。

use crate::runtime::AppHandle;

/// handoff 会话后端占位：非 Windows 平台不会真正创建此类会话。
pub struct HandoffPty;

impl HandoffPty {
    pub fn write_input(&mut self, _data: &[u8]) -> Result<(), String> {
        Err("默认终端 handoff 仅支持 Windows 桌面端".to_string())
    }

    pub fn resize(&mut self, _rows: u16, _cols: u16) -> Result<(), String> {
        Err("默认终端 handoff 仅支持 Windows 桌面端".to_string())
    }

    pub fn close(&mut self) -> Option<u32> {
        None
    }

    pub fn kill_without_wait(&mut self) {}

    pub fn process_id(&self) -> Option<u32> {
        None
    }

    pub fn acknowledge_output(&self) -> Result<(), String> {
        Ok(())
    }
}

pub fn set_app_handle(_app: AppHandle) {}

pub fn is_com_registered() -> bool {
    false
}

pub fn is_embedding_launch() -> bool {
    false
}

pub fn bootstrap_com_server() -> Result<(), String> {
    Err("默认终端 handoff 仅支持 Windows 桌面端".to_string())
}
