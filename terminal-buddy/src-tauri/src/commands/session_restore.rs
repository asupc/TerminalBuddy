//! 服务端重启后浏览器页签恢复的一次性租约。
//!
//! 多个浏览器可能同时打开：只允许一个客户端重建 PTY（以及执行 `claude --resume`），
//! 否则会重复创建终端、甚至让两个进程同时 resume 同一个会话。租约带 TTL，
//! 客户端恢复途中断线时其他客户端在 TTL 后仍可重试。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 0 表示空闲；否则是抢占时刻（Unix 毫秒）。
static CLAIM_AT_MS: AtomicU64 = AtomicU64::new(0);
/// 租约有效期。正常流程会在恢复成功后立即释放，TTL 只用于客户端异常断线的兜底。
const CLAIM_TTL_MS: u64 = 120_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 租约空闲或已过期时用 CAS 抢占；纯函数便于单测。
fn try_claim(slot: &AtomicU64, now: u64, ttl: u64) -> bool {
    let previous = slot.load(Ordering::Acquire);
    if previous != 0 && now.saturating_sub(previous) < ttl {
        return false;
    }
    slot.compare_exchange(previous, now, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

/// 首个调用者返回 true；恢复结束后应调用 [`release_web_session_restore`]。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn claim_web_session_restore() -> bool {
    try_claim(&CLAIM_AT_MS, now_ms(), CLAIM_TTL_MS)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn release_web_session_restore() {
    CLAIM_AT_MS.store(0, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_is_exclusive_until_release() {
        let slot = AtomicU64::new(0);
        assert!(try_claim(&slot, 1_000, 120_000));
        assert!(!try_claim(&slot, 2_000, 120_000));
        slot.store(0, Ordering::Release);
        assert!(try_claim(&slot, 3_000, 120_000));
    }

    #[test]
    fn expired_lease_can_be_reclaimed() {
        let slot = AtomicU64::new(1_000);
        assert!(!try_claim(&slot, 60_000, 120_000));
        assert!(try_claim(&slot, 121_000, 120_000));
        // 重新抢占后的租约同样排斥并发调用者。
        assert!(!try_claim(&slot, 122_000, 120_000));
    }
}
