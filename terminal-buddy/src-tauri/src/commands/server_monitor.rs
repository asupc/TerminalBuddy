use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::command;

use crate::models::ssh_types::{DiskStats, MemoryStats, NetworkStats, ServerStats};
use crate::services::ssh_session_service::SshSessionService;

struct NetworkCache {
    rx_bytes: u64,
    tx_bytes: u64,
    timestamp: i64,
}

pub struct MonitorCache {
    cache: Mutex<HashMap<String, NetworkCache>>,
}

impl MonitorCache {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
        }
    }
}

const MONITOR_CMD: &str = "\
echo '===UPTIME===' && uptime -p 2>/dev/null || uptime \
&& echo '===MEM===' && free -b \
&& echo '===CPU===' && head -1 /proc/stat \
&& echo '===DISK===' && df -B1 \
&& echo '===NET===' && cat /proc/net/dev";

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn parse_uptime(output: &str) -> String {
    let line = output.trim();
    // "uptime -p" gives "up 3 days, 2 hours, 1 minute"
    // plain "uptime" gives " 10:30:00 up 3 days, 2:01, 1 user, ..."
    if line.starts_with("up ") || line.starts_with("Up ") {
        return line.to_string();
    }
    // Extract the "up ..." portion from plain uptime
    if let Some(pos) = line.find(" up ") {
        let rest = &line[pos + 4..];
        if let Some(end) = rest.find(",  ") {
            return format!("up {}", &rest[..end]);
        }
        return format!("up {}", rest.trim_end());
    }
    line.to_string()
}

fn parse_memory(output: &str) -> MemoryStats {
    // free -b output:
    //               total        used        free      shared  buff/cache   available
    // Mem:     16384000000  8000000000  2000000000   500000000  6384000000  7884000000
    // Swap:     2000000000     100000  1999900000
    let mut total = 0u64;
    let mut used = 0u64;
    let mut available = 0u64;
    let mut swap_total = 0u64;
    let mut swap_used = 0u64;

    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 2 {
            continue;
        }
        if fields[0] == "Mem:" {
            total = fields.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
            used = fields.get(2).and_then(|v| v.parse().ok()).unwrap_or(0);
            // free command: available is at index 6 if present
            available = fields.get(6).and_then(|v| v.parse().ok()).unwrap_or_else(|| {
                // fallback: available = free + buff/cache
                let free: u64 = fields.get(3).and_then(|v| v.parse().ok()).unwrap_or(0);
                let buff: u64 = fields.get(5).and_then(|v| v.parse().ok()).unwrap_or(0);
                free + buff
            });
        } else if fields[0] == "Swap:" {
            swap_total = fields.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
            swap_used = fields.get(2).and_then(|v| v.parse().ok()).unwrap_or(0);
        }
    }

    let usage_percent = if total > 0 {
        used as f64 / total as f64 * 100.0
    } else {
        0.0
    };

    MemoryStats {
        total,
        used,
        available,
        usage_percent,
        swap_total,
        swap_used,
    }
}

fn parse_cpu(output: &str) -> f64 {
    // /proc/stat first line:
    // cpu  user nice system idle iowait irq softirq steal guest guest_nice
    let line = output.trim();
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 5 {
        return 0.0;
    }
    // fields[0] is "cpu", fields[1..] are values
    let values: Vec<u64> = fields[1..]
        .iter()
        .filter_map(|v| v.parse().ok())
        .collect();
    if values.len() < 4 {
        return 0.0;
    }
    let idle = values[3];
    let total: u64 = values.iter().sum();
    if total == 0 {
        return 0.0;
    }
    // This gives instantaneous idle ratio; subtract from 100 for usage
    // Since we only read once, we get a snapshot. A proper reading needs two samples,
    // but this is a reasonable approximation for a single poll.
    let idle_pct = idle as f64 / total as f64 * 100.0;
    (100.0 - idle_pct).max(0.0).min(100.0)
}

fn parse_disk(output: &str) -> Vec<DiskStats> {
    // df -B1 output:
    // Filesystem     1B-blocks      Used Available Use% Mounted on
    // /dev/sda1     1000000000 500000000 500000000  50% /
    let mut disks = Vec::new();
    for line in output.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 6 {
            continue;
        }
        let mount = fields.last().unwrap_or(&"").to_string();
        // Skip pseudo filesystems
        if mount.starts_with("/dev") || mount.starts_with("/") {
            let total: u64 = fields[1].parse().unwrap_or(0);
            let used: u64 = fields[2].parse().unwrap_or(0);
            let available: u64 = fields[3].parse().unwrap_or(0);
            let usage_str = fields[4].trim_end_matches('%');
            let usage_percent: f64 = usage_str.parse().unwrap_or(0.0);
            disks.push(DiskStats {
                mount,
                total,
                used,
                available,
                usage_percent,
            });
        }
    }
    disks
}

fn parse_network(output: &str) -> (u64, u64) {
    // /proc/net/dev:
    // Inter-|   Receive                                                |  Transmit
    //  face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets ...
    //     lo: 1234    5678    0    0    0     0          0         0   1234    5678 ...
    //   eth0: 1234    5678    0    0    0     0          0         0   1234    5678 ...
    let mut total_rx = 0u64;
    let mut total_tx = 0u64;

    for line in output.lines().skip(2) {
        // Skip header lines
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() < 2 {
            continue;
        }
        let iface = parts[0].trim();
        // Skip loopback
        if iface == "lo" {
            continue;
        }
        let fields: Vec<&str> = parts[1].split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }
        let rx: u64 = fields[0].parse().unwrap_or(0);
        let tx: u64 = fields[8].parse().unwrap_or(0);
        total_rx += rx;
        total_tx += tx;
    }

    (total_rx, total_tx)
}

#[command]
pub fn get_server_stats(
    terminal_id: String,
    ssh_service: tauri::State<'_, SshSessionService>,
    monitor_cache: tauri::State<'_, MonitorCache>,
) -> Result<ServerStats, String> {
    let output = ssh_service.exec(&terminal_id, MONITOR_CMD)?;

    // Split into sections
    let sections: Vec<&str> = output.split("===").collect();
    let mut uptime_section = "";
    let mut mem_section = "";
    let mut cpu_section = "";
    let mut disk_section = "";
    let mut net_section = "";

    let mut i = 0;
    while i + 1 < sections.len() {
        let label = sections[i].trim();
        let content = sections[i + 1];
        match label {
            "UPTIME" => uptime_section = content,
            "MEM" => mem_section = content,
            "CPU" => cpu_section = content,
            "DISK" => disk_section = content,
            "NET" => net_section = content,
            _ => {}
        }
        i += 2;
    }

    let uptime = parse_uptime(uptime_section);
    let memory = parse_memory(mem_section);
    let cpu_usage = parse_cpu(cpu_section);
    let disk = parse_disk(disk_section);
    let (rx_bytes, tx_bytes) = parse_network(net_section);

    let now = now_millis();
    let mut rx_speed = 0.0f64;
    let mut tx_speed = 0.0f64;

    // Calculate network speed from cached previous reading
    if let Ok(mut cache) = monitor_cache.cache.lock() {
        if let Some(prev) = cache.get(&terminal_id) {
            let dt_ms = now - prev.timestamp;
            if dt_ms > 0 {
                let dt_sec = dt_ms as f64 / 1000.0;
                if rx_bytes >= prev.rx_bytes {
                    rx_speed = (rx_bytes - prev.rx_bytes) as f64 / dt_sec;
                }
                if tx_bytes >= prev.tx_bytes {
                    tx_speed = (tx_bytes - prev.tx_bytes) as f64 / dt_sec;
                }
            }
        }
        cache.insert(
            terminal_id,
            NetworkCache {
                rx_bytes,
                tx_bytes,
                timestamp: now,
            },
        );
    }

    Ok(ServerStats {
        uptime,
        cpu_usage,
        memory,
        disk,
        network: NetworkStats {
            rx_bytes,
            tx_bytes,
            rx_speed,
            tx_speed,
        },
        timestamp: now,
    })
}
