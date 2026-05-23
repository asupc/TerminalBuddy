use serde::Serialize;
use std::sync::OnceLock;
use chrono::Datelike;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn get_http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Serialize)]
pub struct QianfanTier {
    pub name: String,
    pub utilization: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize)]
pub struct QianfanResult {
    pub success: bool,
    pub tiers: Vec<QianfanTier>,
    pub error: Option<String>,
}

// --- DeepSeek types ---

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

#[tauri::command]
pub async fn fetch_qianfan_usage(cookie: String) -> QianfanResult {
    let client = get_http_client();
    let resp = match client
        .get("https://console.bce.baidu.com/api/qianfan/charge/codingPlan/resourceList")
        .header("Accept", "application/json;charset=UTF-8")
        .header("Content-Type", "application/json")
        .header("Referer", "https://console.bce.baidu.com/qianfan/resource/subscribe")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Cookie", &cookie)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return QianfanResult {
                success: false,
                tiers: vec![],
                error: Some(format!("网络错误: {}", e)),
            }
        }
    };

    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return QianfanResult {
            success: false,
            tiers: vec![],
            error: Some("Cookie 无效或已过期".into()),
        };
    }

    let body: serde_json::Value = match resp.json().await {
        Ok(b) => b,
        Err(e) => {
            return QianfanResult {
                success: false,
                tiers: vec![],
                error: Some(format!("解析响应失败: {}", e)),
            }
        }
    };

    let success = body.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    if !success {
        let msg = body
            .get("message")
            .or_else(|| body.get("error_msg"))
            .and_then(|v| v.as_str())
            .unwrap_or("接口返回错误");
        return QianfanResult {
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
            return QianfanResult {
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
                let utilization = if limit > 0.0 { (used / limit * 100.0).min(100.0) } else { 0.0 };
                let resets_at = q.get("resetAt").and_then(|v| v.as_str()).map(|s| s.to_string());

                tiers.push(QianfanTier {
                    name: label.to_string(),
                    utilization,
                    resets_at,
                });
            }
        }
    }

    if tiers.is_empty() {
        return QianfanResult {
            success: false,
            tiers: vec![],
            error: Some("未找到用量数据".into()),
        };
    }

    QianfanResult {
        success: true,
        tiers,
        error: None,
    }
}

fn parse_f64(v: &serde_json::Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0.0)
}

fn parse_i64(v: &serde_json::Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

fn sum_usage(models: &[serde_json::Value]) -> (i64, i64, i64, i64, i64) {
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

fn sum_cost(models: &[serde_json::Value]) -> f64 {
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

fn extract_day_data(days: &[serde_json::Value], target: &str) -> Option<Vec<serde_json::Value>> {
    for d in days {
        if d.get("date").and_then(|v| v.as_str()) == Some(target) {
            return d.get("data").and_then(|v| v.as_array()).cloned();
        }
    }
    None
}

fn today_str() -> String {
    let now = chrono::Local::now();
    format!("{}", now.format("%Y-%m-%d"))
}

fn yesterday_str() -> String {
    let now = chrono::Local::now() - chrono::Duration::days(1);
    format!("{}", now.format("%Y-%m-%d"))
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

    // Extract wallets
    let mut normal_wallets = Vec::new();
    let mut bonus_wallets = Vec::new();

    if let Some(sd) = summary_data {
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
                let bal = parse_f64(
                    w.get("balance")
                        .unwrap_or(&serde_json::Value::Null),
                );
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
    }

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

    let today = if let Some(days) = amount_days {
        if let Some(models) = extract_day_data(days, &today_s) {
            let (req, hit, miss, resp, total) = sum_usage(&models);
            let cost = cost_days
                .and_then(|d| extract_day_data(d, &today_s))
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
        } else {
            None
        }
    } else {
        None
    };

    let yesterday = if let Some(days) = amount_days {
        if let Some(models) = extract_day_data(days, &yesterday_s) {
            let (req, hit, miss, resp, total) = sum_usage(&models);
            let cost = cost_days
                .and_then(|d| extract_day_data(d, &yesterday_s))
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
        } else {
            None
        }
    } else {
        None
    };

    // Monthly
    let month_usage = if let Some(total_models) = amount_total {
        let (_req, _hit, _miss, _resp, total) = sum_usage(
            &total_models
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
        let cost_total = cost_data
            .as_ref()
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
    } else {
        None
    };

    // Weekly
    let week_usage = if let Some(days) = amount_days {
        let mut req = 0i64;
        let mut hit = 0i64;
        let mut miss = 0i64;
        let mut resp = 0i64;
        for d in days {
            let date = d.get("date").and_then(|v| v.as_str()).unwrap_or("");
            if date >= week_start_s.as_str() && date <= today_s.as_str() {
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
                if date >= week_start_s.as_str() && date <= today_s.as_str() {
                    if let Some(models) = d.get("data").and_then(|v| v.as_array()) {
                        week_cost += sum_cost(models);
                    }
                }
            }
        }
        if total > 0 || req > 0 {
            Some(DeepseekWeekUsage {
                start_date: week_start_s,
                end_date: today_s,
                request: req,
                total_token: total,
                cost: week_cost,
            })
        } else {
            None
        }
    } else {
        None
    };

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

// --- MiniMax types ---

#[derive(Serialize)]
pub struct MinimaxTier {
    pub name: String,
    pub utilization: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize)]
pub struct MinimaxUsageResult {
    pub success: bool,
    pub tiers: Vec<MinimaxTier>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn fetch_minimax_usage(api_key: String) -> MinimaxUsageResult {
    let client = get_http_client();
    let resp = match client
        .get("https://api.minimax.chat/v1/api/openplatform/coding_plan/remains")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return MinimaxUsageResult {
                success: false,
                tiers: vec![],
                error: Some(format!("网络错误: {}", e)),
            }
        }
    };

    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return MinimaxUsageResult {
            success: false,
            tiers: vec![],
            error: Some("API Key 无效".into()),
        };
    }

    let body: serde_json::Value = match resp.json().await {
        Ok(b) => b,
        Err(e) => {
            return MinimaxUsageResult {
                success: false,
                tiers: vec![],
                error: Some(format!("解析响应失败: {}", e)),
            }
        }
    };

    let base_resp = match body.get("base_resp").and_then(|v| v.as_object()) {
        Some(br) => br,
        None => {
            return MinimaxUsageResult {
                success: false,
                tiers: vec![],
                error: Some("响应格式异常".into()),
            }
        }
    };

    let status_code = base_resp.get("status_code").and_then(|v| v.as_i64()).unwrap_or(-1);
    let status_msg = base_resp.get("status_msg").and_then(|v| v.as_str()).unwrap_or("未知错误");

    if status_code != 0 {
        return MinimaxUsageResult {
            success: false,
            tiers: vec![],
            error: Some(status_msg.to_string()),
        };
    }

    // 使用 category_remains 中的 text_generation（文本生成）数据作为主要用量指标
    let category_remains = body.get("category_remains").and_then(|v| v.as_array());

    if let Some(categories) = category_remains {
        for cat in categories {
            let cat_name = cat.get("category").and_then(|v| v.as_str()).unwrap_or("");
            if cat_name == "text_generation" {
                let total = cat.get("current_interval_total_count").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let used = cat.get("current_interval_usage_count").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let weekly_total = cat.get("current_weekly_total_count").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let weekly_used = cat.get("current_weekly_usage_count").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let reset_ts = cat.get("end_time").and_then(|v| v.as_i64()).unwrap_or(0);
                let weekly_reset_ts = cat.get("weekly_end_time").and_then(|v| v.as_i64()).unwrap_or(0);

                let mut tiers = Vec::new();

                if total > 0.0 {
                    let utilization = ((total - used) / total * 100.0).min(100.0);
                    let resets_at = if reset_ts > 0 {
                        Some(chrono::DateTime::from_timestamp(reset_ts / 1000, 0)
                            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                            .unwrap_or_default())
                    } else {
                        None
                    };
                    tiers.push(MinimaxTier {
                        name: "5小时".to_string(),
                        utilization,
                        resets_at,
                    });
                }

                if weekly_total > 0.0 {
                    let utilization = ((weekly_total - weekly_used) / weekly_total * 100.0).min(100.0);
                    let resets_at = if weekly_reset_ts > 0 {
                        Some(chrono::DateTime::from_timestamp(weekly_reset_ts / 1000, 0)
                            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                            .unwrap_or_default())
                    } else {
                        None
                    };
                    tiers.push(MinimaxTier {
                        name: "每周".to_string(),
                        utilization,
                        resets_at,
                    });
                }

                if !tiers.is_empty() {
                    return MinimaxUsageResult {
                        success: true,
                        tiers,
                        error: None,
                    };
                }
            }
        }

        // 如果没有 text_generation，使用第一个有数据的分类
        for cat in categories {
            let total = cat.get("current_interval_total_count").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let used = cat.get("current_interval_usage_count").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let weekly_total = cat.get("current_weekly_total_count").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let weekly_used = cat.get("current_weekly_usage_count").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let display_name = cat.get("display_name").and_then(|v| v.as_str()).unwrap_or("用量");
            let reset_ts = cat.get("end_time").and_then(|v| v.as_i64()).unwrap_or(0);
            let weekly_reset_ts = cat.get("weekly_end_time").and_then(|v| v.as_i64()).unwrap_or(0);

            if total > 0.0 || weekly_total > 0.0 {
                let mut tiers = Vec::new();

                if total > 0.0 {
                    let utilization = ((total - used) / total * 100.0).min(100.0);
                    let resets_at = if reset_ts > 0 {
                        Some(chrono::DateTime::from_timestamp(reset_ts / 1000, 0)
                            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                            .unwrap_or_default())
                    } else {
                        None
                    };
                    tiers.push(MinimaxTier {
                        name: format!("{} 5小时", display_name),
                        utilization,
                        resets_at,
                    });
                }

                if weekly_total > 0.0 {
                    let utilization = ((weekly_total - weekly_used) / weekly_total * 100.0).min(100.0);
                    let resets_at = if weekly_reset_ts > 0 {
                        Some(chrono::DateTime::from_timestamp(weekly_reset_ts / 1000, 0)
                            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                            .unwrap_or_default())
                    } else {
                        None
                    };
                    tiers.push(MinimaxTier {
                        name: format!("{} 每周", display_name),
                        utilization,
                        resets_at,
                    });
                }

                if !tiers.is_empty() {
                    return MinimaxUsageResult {
                        success: true,
                        tiers,
                        error: None,
                    };
                }
            }
        }
    }

    MinimaxUsageResult {
        success: false,
        tiers: vec![],
        error: Some("未找到用量数据".into()),
    }
}
