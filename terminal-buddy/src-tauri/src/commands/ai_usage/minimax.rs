//! MiniMax 编程套餐余量查询。

use super::{format_timestamp, get_http_client, send_usage_request, Tier, TierUsageResult};

#[tauri::command]
pub async fn fetch_minimax_usage(api_key: String) -> TierUsageResult {
    let body = match send_usage_request(
        get_http_client()
            .get("https://api.minimax.chat/v1/api/openplatform/coding_plan/remains")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json"),
        "API Key 无效",
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

    let base_resp = match body.get("base_resp").and_then(|v| v.as_object()) {
        Some(br) => br,
        None => {
            return TierUsageResult {
                success: false,
                tiers: vec![],
                error: Some("响应格式异常".into()),
            }
        }
    };

    let status_code = base_resp
        .get("status_code")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    let status_msg = base_resp
        .get("status_msg")
        .and_then(|v| v.as_str())
        .unwrap_or("未知错误");

    if status_code != 0 {
        return TierUsageResult {
            success: false,
            tiers: vec![],
            error: Some(status_msg.to_string()),
        };
    }

    // 新接口使用 model_remains 数组，筛选 model_name == "general" 的编程套餐
    let model_remains = body.get("model_remains").and_then(|v| v.as_array());

    if let Some(models) = model_remains {
        // 只取 model_name == "general" 的条目，跳过 video 等非编程模型
        if let Some(item) = models.iter().find(|item| {
            item.get("model_name")
                .and_then(|v| v.as_str())
                .map(|s| s == "general")
                .unwrap_or(false)
        }) {
            let mut tiers = Vec::new();

            // 5小时桶：剩余百分比 → 已用百分比
            if let Some(remain_pct) = item
                .get("current_interval_remaining_percent")
                .and_then(|v| v.as_f64())
            {
                let reset_ts = item.get("end_time").and_then(|v| v.as_i64()).unwrap_or(0);
                tiers.push(Tier {
                    name: "5小时".to_string(),
                    utilization: 100.0 - remain_pct,
                    resets_at: format_timestamp(reset_ts / 1000),
                });
            }

            // 周桶：仅当 current_weekly_status == 1 时激活
            if item.get("current_weekly_status").and_then(|v| v.as_i64()) == Some(1) {
                if let Some(remain_pct) = item
                    .get("current_weekly_remaining_percent")
                    .and_then(|v| v.as_f64())
                {
                    let weekly_reset_ts = item
                        .get("weekly_end_time")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    tiers.push(Tier {
                        name: "每周".to_string(),
                        utilization: 100.0 - remain_pct,
                        resets_at: format_timestamp(weekly_reset_ts / 1000),
                    });
                }
            }

            if !tiers.is_empty() {
                return TierUsageResult {
                    success: true,
                    tiers,
                    error: None,
                };
            }
        }
    }

    TierUsageResult {
        success: false,
        tiers: vec![],
        error: Some("未找到用量数据".into()),
    }
}
