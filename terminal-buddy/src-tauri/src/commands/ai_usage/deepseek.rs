//! DeepSeek 用量查询：汇总 + 日用量 + 成本三路并发，日/周/月统计聚合。

use super::{extract_day_data, get_http_client, parse_f64, parse_i64, sum_cost, sum_usage, today_str, yesterday_str};
use chrono::Datelike;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepseekBalanceWallet {
    pub balance: String,
    pub currency: String,
    pub token_estimation: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepseekDayUsage {
    pub request: i64,
    pub input_token: i64,
    pub cache_hit_token: i64,
    pub output_token: i64,
    pub total_token: i64,
    pub cost: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepseekMonthUsage {
    pub total_token: i64,
    pub total_cost: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepseekWeekUsage {
    pub start_date: String,
    pub end_date: String,
    pub request: i64,
    pub total_token: i64,
    pub cost: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepseekUsageResult {
    pub success: bool,
    pub normal_wallets: Vec<DeepseekBalanceWallet>,
    pub bonus_wallets: Vec<DeepseekBalanceWallet>,
    pub today: Option<DeepseekDayUsage>,
    pub yesterday: Option<DeepseekDayUsage>,
    pub week: Option<DeepseekWeekUsage>,
    pub month: Option<DeepseekMonthUsage>,
    pub error: Option<String>,
}

/// 解析余额钱包：normal 全量展示，bonus 仅保留正余额。
fn parse_wallets(
    summary_data: Option<&serde_json::Value>,
) -> (Vec<DeepseekBalanceWallet>, Vec<DeepseekBalanceWallet>) {
    let mut normal_wallets = Vec::new();
    let mut bonus_wallets = Vec::new();
    let Some(sd) = summary_data else {
        return (normal_wallets, bonus_wallets);
    };
    if let Some(ws) = sd.get("normal_wallets").and_then(|v| v.as_array()) {
        for w in ws {
            normal_wallets.push(DeepseekBalanceWallet {
                balance: w
                    .get("balance")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0.00")
                    .to_string(),
                currency: w
                    .get("currency")
                    .and_then(|v| v.as_str())
                    .unwrap_or("CNY")
                    .to_string(),
                token_estimation: parse_i64(
                    w.get("token_estimation")
                        .unwrap_or(&serde_json::Value::Null),
                ),
            });
        }
    }
    if let Some(ws) = sd.get("bonus_wallets").and_then(|v| v.as_array()) {
        for w in ws {
            let bal = parse_f64(w.get("balance").unwrap_or(&serde_json::Value::Null));
            if bal > 0.0 {
                bonus_wallets.push(DeepseekBalanceWallet {
                    balance: format!("{:.2}", bal),
                    currency: w
                        .get("currency")
                        .and_then(|v| v.as_str())
                        .unwrap_or("CNY")
                        .to_string(),
                    token_estimation: parse_i64(
                        w.get("token_estimation")
                            .unwrap_or(&serde_json::Value::Null),
                    ),
                });
            }
        }
    }
    (normal_wallets, bonus_wallets)
}

/// 按目标日期聚合当日用量与成本（today/yesterday 共用）。
fn parse_day_usage(
    amount_days: Option<&Vec<serde_json::Value>>,
    cost_days: Option<&Vec<serde_json::Value>>,
    target: &str,
) -> Option<DeepseekDayUsage> {
    let days = amount_days?;
    let models = extract_day_data(days, target)?;
    let (req, hit, miss, resp, total) = sum_usage(&models);
    let cost = cost_days
        .and_then(|d| extract_day_data(d, target))
        .map(|m| sum_cost(&m))
        .unwrap_or(0.0);
    Some(DeepseekDayUsage {
        request: req,
        input_token: hit + miss,
        cache_hit_token: hit,
        output_token: resp,
        total_token: total,
        cost,
    })
}

/// 聚合本周（周一起，不早于当月 1 号）用量与成本。
fn compute_week(
    amount_days: Option<&Vec<serde_json::Value>>,
    cost_days: Option<&Vec<serde_json::Value>>,
    week_start: &str,
    today: &str,
) -> Option<DeepseekWeekUsage> {
    let days = amount_days?;
    let mut req = 0i64;
    let mut hit = 0i64;
    let mut miss = 0i64;
    let mut resp = 0i64;
    for d in days {
        let date = d.get("date").and_then(|v| v.as_str()).unwrap_or("");
        if date >= week_start && date <= today {
            if let Some(models) = d.get("data").and_then(|v| v.as_array()) {
                let (r, h, m, s, _) = sum_usage(models);
                req += r;
                hit += h;
                miss += m;
                resp += s;
            }
        }
    }
    let total = hit + miss + resp;
    let mut week_cost = 0.0;
    if let Some(cdays) = cost_days {
        for d in cdays {
            let date = d.get("date").and_then(|v| v.as_str()).unwrap_or("");
            if date >= week_start && date <= today {
                if let Some(models) = d.get("data").and_then(|v| v.as_array()) {
                    week_cost += sum_cost(models);
                }
            }
        }
    }
    if total > 0 || req > 0 {
        Some(DeepseekWeekUsage {
            start_date: week_start.to_string(),
            end_date: today.to_string(),
            request: req,
            total_token: total,
            cost: week_cost,
        })
    } else {
        None
    }
}

/// 聚合整月用量与成本。
fn compute_month(
    amount_total: Option<&serde_json::Value>,
    cost_data: Option<&serde_json::Value>,
) -> Option<DeepseekMonthUsage> {
    let total_models = amount_total?;
    let (_req, _hit, _miss, _resp, total) =
        sum_usage(&total_models.as_array().cloned().unwrap_or_default());
    let cost_total = cost_data
        .and_then(|b| b.get("data"))
        .and_then(|d| d.get("biz_data"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            let mut sum = 0.0;
            for cur in arr {
                if let Some(t) = cur.get("total") {
                    if let Some(models) = t.as_array() {
                        sum += sum_cost(models);
                    }
                }
            }
            sum
        })
        .unwrap_or(0.0);
    if total > 0 {
        Some(DeepseekMonthUsage {
            total_token: total,
            total_cost: cost_total,
        })
    } else {
        None
    }
}

#[tauri::command]
pub async fn fetch_deepseek_usage(api_key: String) -> DeepseekUsageResult {
    let client = get_http_client();
    let base = "https://platform.deepseek.com";

    let headers = |req: reqwest::RequestBuilder| -> reqwest::RequestBuilder {
        req.header("Authorization", format!("Bearer {}", api_key))
            .header("Accept", "application/json")
            .header("Accept-Language", "zh-CN,zh;q=0.9")
            .header("Referer", format!("{}/", base))
            .header("Origin", base)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0")
    };

    // Parallel: summary + daily amount + daily cost
    let now = chrono::Local::now();
    let month = now.month() as u32;
    let year = now.year();

    let (summary_resp, amount_resp, cost_resp) = tokio::join!(
        headers(client.get(format!("{}/api/v0/users/get_user_summary", base))).send(),
        headers(client.get(format!(
            "{}/api/v0/usage/amount?month={}&year={}",
            base, month, year
        )))
        .send(),
        headers(client.get(format!(
            "{}/api/v0/usage/cost?month={}&year={}",
            base, month, year
        )))
        .send(),
    );

    // Parse summary
    let summary_body: Option<serde_json::Value> = match summary_resp {
        Ok(resp) if resp.status().is_success() => resp.json().await.ok(),
        Ok(resp) if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 => {
            return DeepseekUsageResult {
                success: false,
                normal_wallets: vec![],
                bonus_wallets: vec![],
                today: None,
                yesterday: None,
                week: None,
                month: None,
                error: Some("API Key 无效".into()),
            }
        }
        _ => None,
    };

    let summary_data = summary_body
        .as_ref()
        .and_then(|b| b.get("data"))
        .and_then(|d| d.get("biz_data"));

    let (normal_wallets, bonus_wallets) = parse_wallets(summary_data);

    // Parse amount data
    let amount_data: Option<serde_json::Value> = match amount_resp {
        Ok(resp) if resp.status().is_success() => resp.json().await.ok(),
        _ => None,
    };

    let amount_days = amount_data
        .as_ref()
        .and_then(|b| b.get("data"))
        .and_then(|d| d.get("biz_data"))
        .and_then(|d| d.get("days"))
        .and_then(|v| v.as_array());

    let amount_total = amount_data
        .as_ref()
        .and_then(|b| b.get("data"))
        .and_then(|d| d.get("biz_data"))
        .and_then(|d| d.get("total"));

    // Parse cost data
    let cost_data: Option<serde_json::Value> = match cost_resp {
        Ok(resp) if resp.status().is_success() => resp.json().await.ok(),
        _ => None,
    };

    let cost_days = cost_data
        .as_ref()
        .and_then(|b| b.get("data"))
        .and_then(|d| d.get("biz_data"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("days"))
        .and_then(|v| v.as_array());

    // Build today/yesterday usage
    let today_s = today_str();
    let yesterday_s = yesterday_str();
    let week_start_s = {
        let n = chrono::Local::now();
        let weekday = n.weekday().num_days_from_monday() as i64;
        let monday = n - chrono::Duration::days(weekday);
        let mut ws = format!("{}", monday.format("%Y-%m-%d"));
        let month_start = format!("{}-{:02}-01", year, month);
        if ws < month_start {
            ws = month_start;
        }
        ws
    };

    let today = parse_day_usage(amount_days, cost_days, &today_s);
    let yesterday = parse_day_usage(amount_days, cost_days, &yesterday_s);

    // Monthly
    let month_usage = compute_month(amount_total, cost_data.as_ref());

    // Weekly
    let week_usage = compute_week(amount_days, cost_days, &week_start_s, &today_s);

    DeepseekUsageResult {
        success: true,
        normal_wallets,
        bonus_wallets,
        today,
        yesterday,
        week: week_usage,
        month: month_usage,
        error: None,
    }
}
