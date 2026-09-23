//! 百度千帆 Coding 套餐用量查询。

use super::{get_http_client, send_usage_request, Tier, TierUsageResult};

#[tauri::command]
pub async fn fetch_qianfan_usage(cookie: String) -> TierUsageResult {
    let body = match send_usage_request(
        get_http_client()
            .get("https://console.bce.baidu.com/api/qianfan/charge/codingPlan/resourceList")
            .header("Accept", "application/json;charset=UTF-8")
            .header("Content-Type", "application/json")
            .header(
                "Referer",
                "https://console.bce.baidu.com/qianfan/resource/subscribe",
            )
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Cookie", &cookie),
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

    let success = body
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !success {
        let msg = body
            .get("message")
            .or_else(|| body.get("error_msg"))
            .and_then(|v| v.as_str())
            .unwrap_or("接口返回错误");
        return TierUsageResult {
            success: false,
            tiers: vec![],
            error: Some(msg.to_string()),
        };
    }

    // response: { success: true, result: { totalCount, items: [{ quota: { fiveHour, week, month } }] } }
    let items = match body
        .get("result")
        .and_then(|r| r.get("items"))
        .and_then(|v| v.as_array())
    {
        Some(arr) => arr,
        None => {
            return TierUsageResult {
                success: false,
                tiers: vec![],
                error: Some("响应数据格式异常".into()),
            }
        }
    };

    let mut tiers = Vec::new();

    for item in items.iter() {
        let quota = match item.get("quota").and_then(|v| v.as_object()) {
            Some(q) => q,
            None => continue,
        };

        for (key, label) in [("fiveHour", "5小时"), ("week", "每周"), ("month", "每月")] {
            if let Some(q) = quota.get(key).and_then(|v| v.as_object()) {
                let used = q.get("used").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let limit = q.get("limit").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let utilization = if limit > 0.0 {
                    (used / limit * 100.0).min(100.0)
                } else {
                    0.0
                };
                let resets_at = q
                    .get("resetAt")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                tiers.push(Tier {
                    name: label.to_string(),
                    utilization,
                    resets_at,
                });
            }
        }
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
