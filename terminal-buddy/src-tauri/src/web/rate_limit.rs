//! 登录接口的暴力破解防护。
//!
//! 两道闸门：
//! 1. 按客户端 IP 的失败计数 + 滑动时间窗 + 指数退避封禁，避免离线字典攻击；
//! 2. 全局 bcrypt 校验并发上限。bcrypt 是刻意设计成 CPU 密集的，放任并发校验会把
//!    CPU 吃满，本机的终端 I/O 会跟着卡死，所以宁可让多余的登录请求排队或直接 429。
//!
//! 判定逻辑全部把 `now` 作为显式参数（`*_at` 系列），便于单元测试推进时间。

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::{Semaphore, SemaphorePermit};

/// 失败计数的时间窗：窗口内没有新的失败，此前的计数与退避轮次一起作废。
pub const LOGIN_FAILURE_WINDOW: Duration = Duration::from_secs(300);
/// 触发封禁的失败次数。
pub const LOGIN_FAILURE_THRESHOLD: u32 = 5;
/// 首次封禁时长，之后每再次触发翻倍。
pub const LOGIN_BAN_BASE: Duration = Duration::from_secs(30);
/// 封禁时长上限。
pub const LOGIN_BAN_MAX: Duration = Duration::from_secs(600);
/// 跟踪的 IP 数上限，超过后先清理已过期条目，避免伪造源 IP 把表撑爆。
const MAX_TRACKED_IPS: usize = 1024;

/// 同时进行的 bcrypt 校验上限。
const MAX_CONCURRENT_PASSWORD_VERIFY: usize = 2;
/// 排不到校验槽位就放弃的等待时限。
const PASSWORD_VERIFY_WAIT: Duration = Duration::from_secs(3);
/// 校验槽位耗尽时告知客户端的重试间隔（秒）。
pub const PASSWORD_VERIFY_RETRY_AFTER_SECS: u64 = 5;

static PASSWORD_VERIFY_SLOTS: Semaphore = Semaphore::const_new(MAX_CONCURRENT_PASSWORD_VERIFY);

/// 申请一个 bcrypt 校验槽位；等待超过 [`PASSWORD_VERIFY_WAIT`] 返回 `None`，
/// 调用方应据此返回 429 而不是继续排队占住连接。
pub async fn acquire_password_verify_slot() -> Option<SemaphorePermit<'static>> {
    tokio::time::timeout(PASSWORD_VERIFY_WAIT, PASSWORD_VERIFY_SLOTS.acquire())
        .await
        .ok()?
        .ok()
}

/// 一次登录尝试的限流判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginAttempt {
    Allow,
    /// 已被封禁，`retry_after` 是剩余封禁时长。
    Reject { retry_after: Duration },
}

#[derive(Debug)]
struct IpRecord {
    /// 当前退避轮次内累计的失败次数。
    failures: u32,
    /// 最近一次失败时间，用于判断时间窗是否已过。
    last_failure: Instant,
    banned_until: Option<Instant>,
    /// 已触发过几轮封禁，用于指数退避。
    ban_rounds: u32,
}

impl IpRecord {
    fn new(now: Instant) -> Self {
        Self {
            failures: 0,
            last_failure: now,
            banned_until: None,
            ban_rounds: 0,
        }
    }

    /// 封禁已解除、且此后整个时间窗内再无失败 —— 整条记录可以丢弃（等价于该 IP 从未失败过）。
    ///
    /// 计时起点取「封禁结束」与「最后一次失败」中较晚的那个：封禁时长可能超过时间窗，
    /// 若从失败时刻起算，攻击者只要熬完长封禁就能把退避轮次清零。
    fn is_expired(&self, now: Instant) -> bool {
        let quiet_since = match self.banned_until {
            // 封禁中的记录永不过期，避免被表清理顺手放行
            Some(until) if until > now => return false,
            Some(until) => until.max(self.last_failure),
            None => self.last_failure,
        };
        now.saturating_duration_since(quiet_since) >= LOGIN_FAILURE_WINDOW
    }
}

/// 第 `rounds` 轮封禁的时长：`LOGIN_BAN_BASE` 逐轮翻倍，封顶 [`LOGIN_BAN_MAX`]。
fn ban_duration(rounds: u32) -> Duration {
    let factor = 1u32 << rounds.min(16);
    (LOGIN_BAN_BASE * factor).min(LOGIN_BAN_MAX)
}

/// 按客户端 IP 记录登录失败的限流器。
#[derive(Debug, Default)]
pub struct LoginThrottle {
    entries: Mutex<HashMap<IpAddr, IpRecord>>,
}

impl LoginThrottle {
    pub fn new() -> Self {
        Self::default()
    }

    /// 锁中毒时继续使用内部数据：限流表本身没有跨字段不变量，脏读也不会放大损失，
    /// 而 panic 会让登录接口彻底不可用。
    fn lock(&self) -> MutexGuard<'_, HashMap<IpAddr, IpRecord>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 校验密码之前先问一次：该 IP 现在是否允许尝试。
    pub fn check(&self, ip: IpAddr) -> LoginAttempt {
        self.check_at(ip, Instant::now())
    }

    fn check_at(&self, ip: IpAddr, now: Instant) -> LoginAttempt {
        let mut entries = self.lock();
        let Some(record) = entries.get(&ip) else {
            return LoginAttempt::Allow;
        };
        if let Some(until) = record.banned_until {
            if until > now {
                return LoginAttempt::Reject {
                    retry_after: until.saturating_duration_since(now),
                };
            }
        }
        if record.is_expired(now) {
            entries.remove(&ip);
        }
        LoginAttempt::Allow
    }

    /// 记一次失败，返回记完之后的状态：`Reject` 说明这次失败刚好触发封禁。
    pub fn record_failure(&self, ip: IpAddr) -> LoginAttempt {
        self.record_failure_at(ip, Instant::now())
    }

    fn record_failure_at(&self, ip: IpAddr, now: Instant) -> LoginAttempt {
        let mut entries = self.lock();
        if entries.len() >= MAX_TRACKED_IPS {
            entries.retain(|_, record| !record.is_expired(now));
        }
        let record = entries.entry(ip).or_insert_with(|| IpRecord::new(now));
        if record.is_expired(now) {
            *record = IpRecord::new(now);
        }
        record.failures += 1;
        record.last_failure = now;
        if record.failures >= LOGIN_FAILURE_THRESHOLD {
            let ban = ban_duration(record.ban_rounds);
            record.ban_rounds = record.ban_rounds.saturating_add(1);
            record.failures = 0;
            record.banned_until = Some(now + ban);
            return LoginAttempt::Reject { retry_after: ban };
        }
        LoginAttempt::Allow
    }

    /// 登录成功：清掉该 IP 的失败历史，正常用户输错几次不会留下长期影响。
    pub fn record_success(&self, ip: IpAddr) {
        self.lock().remove(&ip);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(last: u8) -> IpAddr {
        IpAddr::from([192, 168, 1, last])
    }

    /// 未达阈值放行，第 `LOGIN_FAILURE_THRESHOLD` 次失败触发封禁，封禁期内 check 直接拒绝。
    #[test]
    fn ban_triggers_at_threshold() {
        let throttle = LoginThrottle::new();
        let start = Instant::now();
        let client = ip(10);

        for i in 1..LOGIN_FAILURE_THRESHOLD {
            assert_eq!(
                throttle.record_failure_at(client, start),
                LoginAttempt::Allow,
                "第 {} 次失败不应封禁",
                i
            );
            assert_eq!(throttle.check_at(client, start), LoginAttempt::Allow);
        }

        assert_eq!(
            throttle.record_failure_at(client, start),
            LoginAttempt::Reject {
                retry_after: LOGIN_BAN_BASE
            }
        );
        assert_eq!(
            throttle.check_at(client, start + Duration::from_secs(1)),
            LoginAttempt::Reject {
                retry_after: LOGIN_BAN_BASE - Duration::from_secs(1)
            }
        );
    }

    /// 封禁到期后放行；到期后继续失败会以翻倍时长再次封禁，并封顶在 LOGIN_BAN_MAX。
    #[test]
    fn ban_backoff_doubles_and_caps() {
        let throttle = LoginThrottle::new();
        let client = ip(11);
        let mut now = Instant::now();
        let mut expected = LOGIN_BAN_BASE;

        for _ in 0..8 {
            for _ in 1..LOGIN_FAILURE_THRESHOLD {
                assert_eq!(throttle.record_failure_at(client, now), LoginAttempt::Allow);
            }
            assert_eq!(
                throttle.record_failure_at(client, now),
                LoginAttempt::Reject {
                    retry_after: expected
                }
            );
            // 封禁到期，立即放行，但失败历史仍在时间窗内
            now += expected + Duration::from_secs(1);
            assert_eq!(throttle.check_at(client, now), LoginAttempt::Allow);
            expected = (expected * 2).min(LOGIN_BAN_MAX);
        }
        assert_eq!(expected, LOGIN_BAN_MAX, "退避时长应封顶");
    }

    /// 时间窗内无失败，退避轮次归零：正常用户隔天再输错不会立刻吃到长封禁。
    #[test]
    fn window_expiry_resets_backoff() {
        let throttle = LoginThrottle::new();
        let client = ip(12);
        let start = Instant::now();

        for _ in 0..LOGIN_FAILURE_THRESHOLD {
            throttle.record_failure_at(client, start);
        }
        // 封禁解除 + 整个时间窗内没有新的失败
        let later = start + LOGIN_BAN_BASE + LOGIN_FAILURE_WINDOW + Duration::from_secs(1);
        assert_eq!(throttle.check_at(client, later), LoginAttempt::Allow);

        for _ in 1..LOGIN_FAILURE_THRESHOLD {
            assert_eq!(
                throttle.record_failure_at(client, later),
                LoginAttempt::Allow
            );
        }
        assert_eq!(
            throttle.record_failure_at(client, later),
            LoginAttempt::Reject {
                retry_after: LOGIN_BAN_BASE
            },
            "时间窗过期后应从最短封禁重新开始"
        );
    }

    /// 不同 IP 的计数互不影响。
    #[test]
    fn counters_are_isolated_per_ip() {
        let throttle = LoginThrottle::new();
        let now = Instant::now();
        let banned = ip(13);
        let other = ip(14);

        for _ in 0..LOGIN_FAILURE_THRESHOLD {
            throttle.record_failure_at(banned, now);
        }
        assert!(matches!(
            throttle.check_at(banned, now),
            LoginAttempt::Reject { .. }
        ));
        assert_eq!(throttle.check_at(other, now), LoginAttempt::Allow);
        assert_eq!(throttle.record_failure_at(other, now), LoginAttempt::Allow);
    }

    /// 登录成功清空该 IP 的失败历史。
    #[test]
    fn success_clears_failures() {
        let throttle = LoginThrottle::new();
        let now = Instant::now();
        let client = ip(15);

        for _ in 1..LOGIN_FAILURE_THRESHOLD {
            throttle.record_failure_at(client, now);
        }
        throttle.record_success(client);
        assert!(throttle.lock().is_empty());

        for _ in 1..LOGIN_FAILURE_THRESHOLD {
            assert_eq!(throttle.record_failure_at(client, now), LoginAttempt::Allow);
        }
    }

    /// 表达到上限时清理过期条目，仍在计数/封禁中的记录必须保留。
    #[test]
    fn oversized_table_prunes_expired_entries() {
        let throttle = LoginThrottle::new();
        let start = Instant::now();

        // 填到上限前一格，这些条目此后不再有失败
        for i in 0..(MAX_TRACKED_IPS - 1) {
            throttle.record_failure_at(IpAddr::from((i as u32).to_be_bytes()), start);
        }
        assert_eq!(throttle.lock().len(), MAX_TRACKED_IPS - 1);

        // 时间窗过去之后换一个 IP 来敲门：第一次失败把表顶到上限
        let mid = start + LOGIN_FAILURE_WINDOW + Duration::from_secs(1);
        let attacker = IpAddr::from([10, 0, 0, 1]);
        assert_eq!(throttle.record_failure_at(attacker, mid), LoginAttempt::Allow);
        assert_eq!(throttle.lock().len(), MAX_TRACKED_IPS);

        // 第二次失败触发清理：旧条目全部过窗，自己不过窗必须留下
        let mut outcome = throttle.record_failure_at(attacker, mid);
        {
            let entries = throttle.lock();
            assert_eq!(entries.len(), 1, "过期条目应被清理");
            assert!(entries.contains_key(&attacker), "计数中的条目必须保留");
        }

        // 清理不能吃掉已累计的失败次数：补到阈值仍应封禁
        for _ in 3..=LOGIN_FAILURE_THRESHOLD {
            outcome = throttle.record_failure_at(attacker, mid);
        }
        assert_eq!(
            outcome,
            LoginAttempt::Reject {
                retry_after: LOGIN_BAN_BASE
            }
        );
    }

    #[test]
    fn ban_duration_is_monotonic_and_capped() {
        assert_eq!(ban_duration(0), LOGIN_BAN_BASE);
        assert_eq!(ban_duration(1), LOGIN_BAN_BASE * 2);
        assert_eq!(ban_duration(u32::MAX), LOGIN_BAN_MAX);
    }
}
