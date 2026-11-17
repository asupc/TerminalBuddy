//! 本机（运行 TerminalBuddy 后端的那台机器）的 CPU 与内存占用。
//! 桌面端直接读本机；浏览器端经 `/api/desktop/invoke` 转发，拿到的同样是服务端宿主机数据。

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::System;

/// 两次 CPU 采样之间的最小间隔。
///
/// sysinfo 的 CPU 使用率来自相邻两次采样的差值：间隔过短（桌面端与 Web 端、多个
/// 浏览器标签同时轮询同一进程）会算出 0% / 100% 之类的噪声，并把假峰值写进趋势
/// 缓存。sysinfo 要求至少 200ms，这里取 500ms：既留足余量，又保证前端 600ms 的
/// 预热查询能拿到第二次（有效）采样。
const CPU_REFRESH_INTERVAL: Duration = Duration::from_millis(500);

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

/// 进程内只保留一份采样状态：CPU 使用率取两次采样之间的差值，
/// 每次新建实例会让第一次读数恒为 100%（没有可比较的上一帧）。
struct Monitor {
    system: System,
    /// 上一次真正执行 CPU 采样的时刻。
    last_cpu_refresh: Instant,
    /// 最近一次可用的 CPU 使用率（0–100）。
    cpu_usage: f64,
}

fn monitor() -> Result<&'static Mutex<Monitor>, String> {
    static MONITOR: OnceLock<Mutex<Monitor>> = OnceLock::new();
    if let Some(monitor) = MONITOR.get() {
        return Ok(monitor);
    }
    let mut system = System::new().map_err(|error| format!("系统资源初始化失败：{error}"))?;
    // 建好基准采样，之后的第一次查询（间隔够 500ms）就能拿到真实值。
    system.refresh_cpu_usage();
    Ok(MONITOR.get_or_init(|| Mutex::new(Monitor {
        system,
        last_cpu_refresh: Instant::now(),
        cpu_usage: 0.0,
    })))
}

fn cpu_refresh_due(last: Instant, now: Instant) -> bool {
    now.duration_since(last) >= CPU_REFRESH_INTERVAL
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_system_resources() -> Result<SystemResources, String> {
    let mut monitor = monitor()?.lock().unwrap_or_else(|error| error.into_inner());
    let now = Instant::now();
    // 多个客户端可能在同一时刻轮询：只有距上次采样足够久时才真正采样，
    // 其余请求复用上一次读数，避免用极短的窗口算出错误百分比。
    if cpu_refresh_due(monitor.last_cpu_refresh, now) {
        monitor.system.refresh_cpu_usage();
        monitor.last_cpu_refresh = now;
        monitor.cpu_usage = f64::from(monitor.system.global_cpu_usage()).clamp(0.0, 100.0);
    }
    monitor.system.refresh_memory();

    let total = monitor.system.total_memory();
    let used = monitor.system.used_memory();
    Ok(SystemResources {
        cpu_usage: monitor.cpu_usage,
        cpu_count: monitor.system.cpus().len(),
        memory_used: used,
        memory_total: total,
        memory_usage: usage_percent(used, total),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        cpu_refresh_due, get_system_resources, usage_percent, SystemResources,
        CPU_REFRESH_INTERVAL,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn usage_percent_handles_zero_and_bounds() {
        assert_eq!(usage_percent(0, 0), 0.0);
        assert_eq!(usage_percent(50, 100), 50.0);
        assert_eq!(usage_percent(120, 100), 100.0);
    }

    #[test]
    fn cpu_refresh_is_throttled() {
        let last = Instant::now();
        // 同一时刻的并发轮询（桌面端 + Web 端）不应再次采样。
        assert!(!cpu_refresh_due(last, last));
        assert!(!cpu_refresh_due(last, last + CPU_REFRESH_INTERVAL / 2));
        // 间隔够长才允许重新采样，此时差值才有意义。
        assert!(cpu_refresh_due(last, last + CPU_REFRESH_INTERVAL));
        assert!(cpu_refresh_due(
            last,
            last + CPU_REFRESH_INTERVAL + Duration::from_secs(1)
        ));
    }

    #[test]
    fn resources_are_sane() {
        let resources: SystemResources = get_system_resources().expect("应能读取本机资源");
        assert!(resources.cpu_usage >= 0.0 && resources.cpu_usage <= 100.0);
        assert!(resources.memory_usage >= 0.0 && resources.memory_usage <= 100.0);
        assert!(resources.memory_used <= resources.memory_total);
    }
}
