//! 本机（运行 TerminalBuddy 后端的那台机器）的 CPU 与内存占用。
//! 桌面端直接读本机；浏览器端经 `/api/desktop/invoke` 转发，拿到的同样是服务端宿主机数据。

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use sysinfo::System;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemResources {
    /// 全局 CPU 使用率（0–100）。
    pub cpu_usage: f64,
    pub cpu_count: usize,
    /// 已用内存（字节）。
    pub memory_used: u64,
    /// 物理内存总量（字节）。
    pub memory_total: u64,
    /// 内存使用率（0–100）。
    pub memory_usage: f64,
}

fn usage_percent(used: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    (used as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
}

/// 进程内只保留一份 `System`：CPU 使用率取两次采样之间的差值，
/// 每次新建实例会让第一次读数恒为 0。
fn system() -> Result<&'static Mutex<System>, String> {
    static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();
    if let Some(system) = SYSTEM.get() {
        return Ok(system);
    }
    let mut system = System::new().map_err(|error| format!("系统资源初始化失败：{error}"))?;
    // 建好基准采样，前端第一次查询就能拿到真实值，而不是 0%。
    system.refresh_cpu_usage();
    Ok(SYSTEM.get_or_init(|| Mutex::new(system)))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_system_resources() -> Result<SystemResources, String> {
    let mut system = system()?.lock().unwrap_or_else(|error| error.into_inner());
    system.refresh_cpu_usage();
    system.refresh_memory();

    let total = system.total_memory();
    let used = system.used_memory();
    Ok(SystemResources {
        cpu_usage: f64::from(system.global_cpu_usage()).clamp(0.0, 100.0),
        cpu_count: system.cpus().len(),
        memory_used: used,
        memory_total: total,
        memory_usage: usage_percent(used, total),
    })
}

#[cfg(test)]
mod tests {
    use super::{get_system_resources, usage_percent, SystemResources};

    #[test]
    fn usage_percent_handles_zero_and_bounds() {
        assert_eq!(usage_percent(0, 0), 0.0);
        assert_eq!(usage_percent(50, 100), 50.0);
        assert_eq!(usage_percent(120, 100), 100.0);
    }

    #[test]
    fn resources_are_sane() {
        let resources: SystemResources = get_system_resources().expect("应能读取本机资源");
        assert!(resources.cpu_usage >= 0.0 && resources.cpu_usage <= 100.0);
        assert!(resources.memory_usage >= 0.0 && resources.memory_usage <= 100.0);
        assert!(resources.memory_used <= resources.memory_total);
    }
}
