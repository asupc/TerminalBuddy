//! 火山方舟 Coding 套餐用量查询。

use super::{format_timestamp, get_http_client, send_usage_request, Tier, TierUsageResult};

#[tauri::command]
pub async fn fetch_ark_usage(cookie: String) -> TierUsageResult {
    if cookie.trim().is_empty() {
        return TierUsageResult {
            success: false,
            tiers: vec![],
            error: Some("Cookie 为空".into()),
        };
    }

    // 从 cookie 字符串里提取 csrfToken
    let csrf_token = cookie.split(';').map(|s| s.trim()).find_map(|kv| {
        let mut it = kv.splitn(2, '=');
        let k = it.next()?.trim();
        let v = it.next()?.trim();
        if k.eq_ignore_ascii_case("csrfToken") {
            Some(v.to_string())
        } else {
            None
        }
    });

    let csrf_token = match csrf_token {
        Some(t) if !t.is_empty() => t,
        _ => {
            return TierUsageResult {
                success: false,
                tiers: vec![],
                error: Some("Cookie 中未找到 csrfToken，请重新复制完整 Cookie".into()),
            }
        }
    };

    let body = match send_usage_request(
        get_http_client()
            .post("https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage")
            .header("Cookie", &cookie)
            .header("X-Csrf-Token", &csrf_token)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/plain, */*")
            .header("Referer", "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe")
            .header("Origin", "https://console.volcengine.com")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36")
            .body("{}"),
        "Cookie 无效或已过期",
    )
    .await
    {
        Ok(body) => body,
        Err(error) => {
            return TierUsageResult {
                success: false,
                tiers: vec![],
                error: Some(error),
            }
        }
    };

    // 错误形态:{"ResponseMetadata":{...,"Error":{"Code":"...","Message":"..."}}}
    if let Some(err) = body.get("ResponseMetadata").and_then(|m| m.get("Error")) {
        let msg = err
            .get("Message")
            .or_else(|| err.get("CodeN"))
            .and_then(|v| v.as_str())
            .unwrap_or("接口返回错误");
        return TierUsageResult {
            success: false,
            tiers: vec![],
            error: Some(msg.to_string()),
        };
    }

    let quota_usage = match body
        .get("Result")
        .and_then(|r| r.get("QuotaUsage"))
        .and_then(|v| v.as_array())
    {
        Some(arr) => arr,
        None => {
            return TierUsageResult {
                success: false,
                tiers: vec![],
                error: Some("未找到用量数据（未订阅 Coding 套餐？）".into()),
            }
        }
    };

    let mut tiers = Vec::new();
    for item in quota_usage {
        let level = item.get("Level").and_then(|v| v.as_str()).unwrap_or("");
        let percent = item.get("Percent").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let reset_ts = item
            .get("ResetTimestamp")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let name = match level {
            "session" => "5小时",
            "weekly" => "每周",
            "monthly" => "每月",
            other => other,
        };
        tiers.push(Tier {
            name: name.to_string(),
            utilization: percent,
            resets_at: format_timestamp(reset_ts),
        });
    }

    if tiers.is_empty() {
        return TierUsageResult {
            success: false,
            tiers: vec![],
            error: Some("未找到用量数据".into()),
        };
    }

    TierUsageResult {
        success: true,
        tiers,
        error: None,
    }
}
