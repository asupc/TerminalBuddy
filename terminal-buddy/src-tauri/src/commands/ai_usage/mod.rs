//! AI 用量查询：按厂商拆分的 HTTP 客户端（qianfan/deepseek/ark/minimax）
//! + 共享的解析与错误处理层。

pub mod ark;
pub mod deepseek;
pub mod minimax;
pub mod qianfan;
pub use ark::*;
pub use deepseek::*;
pub use minimax::*;
pub use qianfan::*;

use serde::Serialize;
use std::sync::OnceLock;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub(crate) fn get_http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(reqwest::Client::new)
}

/// 各厂商共用的套餐档位结构（qianfan/ark/minimax 字段完全相同）。
#[derive(Serialize)]
pub struct Tier {
    pub name: String,
    pub utilization: f64,
    pub resets_at: Option<String>,
}

/// 各厂商共用的套餐余量结果（qianfan/ark/minimax 形状一致）。
#[derive(Serialize)]
pub struct TierUsageResult {
    pub success: bool,
    pub tiers: Vec<Tier>,
    pub error: Option<String>,
}

pub(crate) fn parse_f64(v: &serde_json::Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0.0)
}

pub(crate) fn parse_i64(v: &serde_json::Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

pub(crate) fn sum_usage(models: &[serde_json::Value]) -> (i64, i64, i64, i64, i64) {
    let mut request = 0i64;
    let mut cache_hit = 0i64;
    let mut cache_miss = 0i64;
    let mut response = 0i64;
    for model in models {
        let usages = match model.get("usage").and_then(|v| v.as_array()) {
            Some(a) => a,
            None => continue,
        };
        for u in usages {
            let amount = parse_i64(u.get("amount").unwrap_or(&serde_json::Value::Null));
            let typ = u.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match typ {
                "REQUEST" => request += amount,
                "PROMPT_CACHE_HIT_TOKEN" => cache_hit += amount,
                "PROMPT_CACHE_MISS_TOKEN" => cache_miss += amount,
                "RESPONSE_TOKEN" => response += amount,
                _ => {}
            }
        }
    }
    let total = cache_hit + cache_miss + response;
    (request, cache_hit, cache_miss, response, total)
}

pub(crate) fn sum_cost(models: &[serde_json::Value]) -> f64 {
    let mut total = 0.0;
    for model in models {
        let usages = match model.get("usage").and_then(|v| v.as_array()) {
            Some(a) => a,
            None => continue,
        };
        for u in usages {
            let amount = parse_f64(u.get("amount").unwrap_or(&serde_json::Value::Null));
            total += amount;
        }
    }
    total
}

pub(crate) fn extract_day_data(
    days: &[serde_json::Value],
    target: &str,
) -> Option<Vec<serde_json::Value>> {
    for d in days {
        if d.get("date").and_then(|v| v.as_str()) == Some(target) {
            return d.get("data").and_then(|v| v.as_array()).cloned();
        }
    }
    None
}

fn date_str(days_ago: i64) -> String {
    let now = chrono::Local::now() - chrono::Duration::days(days_ago);
    format!("{}", now.format("%Y-%m-%d"))
}

pub(crate) fn today_str() -> String {
    date_str(0)
}

pub(crate) fn yesterday_str() -> String {
    date_str(1)
}

/// 发送用量请求并统一错误映射：网络错误 / 401/403 / JSON 解析失败。
pub(crate) async fn send_usage_request(
    request: reqwest::RequestBuilder,
    auth_error: &str,
) -> Result<serde_json::Value, String> {
    let resp = request
        .send()
        .await
        .map_err(|error| format!("网络错误: {}", error))?;
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(auth_error.to_string());
    }
    resp.json()
        .await
        .map_err(|error| format!("解析响应失败: {}", error))
}

/// 秒级时间戳 → ISO 字符串（0/负值视为无重置时间）。
pub(crate) fn format_timestamp(seconds: i64) -> Option<String> {
    if seconds > 0 {
        chrono::DateTime::from_timestamp(seconds, 0)
            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
    } else {
        None
    }
}
