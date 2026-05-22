use serde::Serialize;
use std::sync::OnceLock;

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
