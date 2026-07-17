//! 机器人扫码配置（设备码授权流程）。
//!
//! 支持飞书、钉钉与个人微信：用户用对应 App 扫描二维码后，自动获取平台凭证
//! （App ID / App Secret），免去手动到开发者后台创建应用。
//! 流程参考 hermes-agent 的 feishu / dingtalk 实现：
//! - 飞书：accounts.feishu.cn/oauth/v1/app/registration（init / begin / poll）
//! - 钉钉：oapi.dingtalk.com/app/registration/{init,begin,poll}
//! - 微信：ilinkai.weixin.qq.com/ilink/bot/{get_bot_qrcode,get_qrcode_status}

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

const FEISHU_REG_URL: &str = "https://accounts.feishu.cn/oauth/v1/app/registration";
const DINGTALK_BASE: &str = "https://oapi.dingtalk.com";
const DINGTALK_SOURCE: &str = "openClaw";
const WEIXIN_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const WEIXIN_APP_CLIENT_VERSION: &str = "131584";
const WEIXIN_SCAN_EXPIRE_SECONDS: u32 = 480;

#[derive(Debug, Clone)]
struct WeixinScanState {
    qr_code: String,
    base_url: String,
    expires_at: Instant,
}

fn weixin_scans() -> &'static Mutex<HashMap<String, WeixinScanState>> {
    static SCANS: OnceLock<Mutex<HashMap<String, WeixinScanState>>> = OnceLock::new();
    SCANS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanBeginResult {
    pub platform: String,
    /// 二维码内容，前端渲染成二维码图片。
    pub qr_url: String,
    /// 轮询句柄（device_code）。
    pub handle: String,
    /// 轮询间隔（秒）。
    pub interval: u32,
    /// 过期时间（秒）。
    pub expire_in: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCredentials {
    pub app_id: String,
    pub app_secret: String,
    /// 默认接收目标：飞书为扫码人的 open_id；钉钉为空（需手填 userId）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    /// 微信 iLink API 地址；其他平台为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPollResult {
    /// waiting | success | expired | failed
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<ScanCredentials>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败: {}", error))
}

pub async fn begin_scan(platform: &str) -> Result<ScanBeginResult, String> {
    match platform {
        "feishu" => feishu_begin().await,
        "dingtalk" => dingtalk_begin().await,
        "weixin" => weixin_begin().await,
        other => Err(format!("不支持扫码的平台: {}", other)),
    }
}

pub async fn poll_scan(begin: &ScanBeginResult) -> Result<ScanPollResult, String> {
    match begin.platform.as_str() {
        "feishu" => feishu_poll(&begin.handle).await,
        "dingtalk" => dingtalk_poll(&begin.handle).await,
        "weixin" => weixin_poll(&begin.handle).await,
        other => Err(format!("不支持扫码的平台: {}", other)),
    }
}

// ════════════════════════ 飞书 ════════════════════════

async fn feishu_post(form: &[(&str, &str)]) -> Result<Value, String> {
    let client = http_client()?;
    let response = client
        .post(FEISHU_REG_URL)
        .form(form)
        .send()
        .await
        .map_err(|error| format!("请求飞书扫码服务失败: {}", error))?;
    // 飞书在 pending 时返回 4xx，但 body 仍是 JSON，统一按 body 解析。
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("解析飞书扫码响应失败: {}", error))
}

async fn feishu_begin() -> Result<ScanBeginResult, String> {
    // 1. init：确认环境支持 client_secret 认证。
    let init = feishu_post(&[("action", "init")]).await?;
    let supported = init
        .get("supported_auth_methods")
        .and_then(Value::as_array)
        .map(|methods| methods.iter().any(|v| v.as_str() == Some("client_secret")))
        .unwrap_or(false);
    if !supported {
        return Err("飞书扫码环境不支持 client_secret 认证".to_string());
    }
    // 2. begin：获取 device_code 与二维码地址。
    let begin = feishu_post(&[
        ("action", "begin"),
        ("archetype", "PersonalAgent"),
        ("auth_method", "client_secret"),
        ("request_user_info", "open_id"),
    ])
    .await?;
    let device_code = begin
        .get("device_code")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "飞书扫码未返回 device_code".to_string())?;
    let qr_url = begin
        .get("verification_uri_complete")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "飞书扫码未返回二维码地址".to_string())?
        .to_string();
    let interval = begin.get("interval").and_then(Value::as_u64).unwrap_or(5) as u32;
    let expire_in = begin
        .get("expire_in")
        .and_then(Value::as_u64)
        .unwrap_or(600) as u32;
    Ok(ScanBeginResult {
        platform: "feishu".to_string(),
        qr_url,
        handle: device_code.to_string(),
        interval: interval.max(2),
        expire_in,
    })
}

async fn feishu_poll(device_code: &str) -> Result<ScanPollResult, String> {
    let res = feishu_post(&[
        ("action", "poll"),
        ("device_code", device_code),
        ("tp", "ob_app"),
    ])
    .await?;
    if let (Some(app_id), Some(app_secret)) = (
        res.get("client_id").and_then(Value::as_str),
        res.get("client_secret").and_then(Value::as_str),
    ) {
        let open_id = res
            .pointer("/user_info/open_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        return Ok(ScanPollResult {
            status: "success".to_string(),
            credentials: Some(ScanCredentials {
                app_id: app_id.to_string(),
                app_secret: app_secret.to_string(),
                target_id: open_id,
                base_url: None,
            }),
            error: None,
        });
    }
    match res.get("error").and_then(Value::as_str) {
        Some("access_denied") => Ok(ScanPollResult {
            status: "failed".to_string(),
            credentials: None,
            error: Some("用户拒绝授权".to_string()),
        }),
        Some("expired_token") => Ok(ScanPollResult {
            status: "expired".to_string(),
            credentials: None,
            error: None,
        }),
        // authorization_pending 或其他 → 继续等待。
        _ => Ok(ScanPollResult {
            status: "waiting".to_string(),
            credentials: None,
            error: None,
        }),
    }
}

// ════════════════════════ 钉钉 ════════════════════════

async fn dingtalk_post(path: &str, body: Value) -> Result<Value, String> {
    let client = http_client()?;
    let response = client
        .post(format!("{}{}", DINGTALK_BASE, path))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("请求钉钉扫码服务失败: {}", error))?;
    let data: Value = response
        .json()
        .await
        .map_err(|error| format!("解析钉钉扫码响应失败: {}", error))?;
    if data.get("errcode").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        let errmsg = data
            .get("errmsg")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!("钉钉扫码服务返回错误: {}", errmsg));
    }
    Ok(data)
}

async fn dingtalk_begin() -> Result<ScanBeginResult, String> {
    // 1. init → nonce。
    let init = dingtalk_post(
        "/app/registration/init",
        json!({ "source": DINGTALK_SOURCE }),
    )
    .await?;
    let nonce = init
        .get("nonce")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "钉钉扫码未返回 nonce".to_string())?;
    // 2. begin → device_code + 二维码地址。
    let begin = dingtalk_post("/app/registration/begin", json!({ "nonce": nonce })).await?;
    let device_code = begin
        .get("device_code")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "钉钉扫码未返回 device_code".to_string())?;
    let qr_url = begin
        .get("verification_uri_complete")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "钉钉扫码未返回二维码地址".to_string())?
        .to_string();
    let interval = begin.get("interval").and_then(Value::as_u64).unwrap_or(3) as u32;
    let expire_in = begin
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(7200) as u32;
    Ok(ScanBeginResult {
        platform: "dingtalk".to_string(),
        qr_url,
        handle: device_code.to_string(),
        interval: interval.max(2),
        expire_in,
    })
}

async fn dingtalk_poll(device_code: &str) -> Result<ScanPollResult, String> {
    let res = dingtalk_post(
        "/app/registration/poll",
        json!({ "device_code": device_code }),
    )
    .await?;
    match res
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_uppercase()
        .as_str()
    {
        "SUCCESS" => {
            let client_id = res.get("client_id").and_then(Value::as_str).unwrap_or("");
            let client_secret = res
                .get("client_secret")
                .and_then(Value::as_str)
                .unwrap_or("");
            if client_id.is_empty() || client_secret.is_empty() {
                return Ok(ScanPollResult {
                    status: "failed".to_string(),
                    credentials: None,
                    error: Some("钉钉授权成功但凭证缺失".to_string()),
                });
            }
            Ok(ScanPollResult {
                status: "success".to_string(),
                credentials: Some(ScanCredentials {
                    app_id: client_id.to_string(),
                    app_secret: client_secret.to_string(),
                    target_id: None,
                    base_url: None,
                }),
                error: None,
            })
        }
        "WAITING" => Ok(ScanPollResult {
            status: "waiting".to_string(),
            credentials: None,
            error: None,
        }),
        "EXPIRED" => Ok(ScanPollResult {
            status: "expired".to_string(),
            credentials: None,
            error: None,
        }),
        other => Ok(ScanPollResult {
            status: "failed".to_string(),
            credentials: None,
            error: Some(format!("钉钉授权失败: {}", other)),
        }),
    }
}

// ======================== 个人微信 iLink Bot ========================

fn weixin_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(40))
        .build()
        .map_err(|error| format!("创建微信扫码客户端失败: {}", error))
}

async fn weixin_get(client: &Client, base_url: &str, endpoint: &str) -> Result<Value, String> {
    let response = client
        .get(format!("{}/{}", base_url.trim_end_matches('/'), endpoint))
        .header("iLink-App-Id", "bot")
        .header("iLink-App-ClientVersion", WEIXIN_APP_CLIENT_VERSION)
        .send()
        .await
        .map_err(|error| format!("请求微信 iLink 扫码服务失败: {}", error))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取微信 iLink 扫码响应失败: {}", error))?;
    if !status.is_success() {
        return Err(format!("微信 iLink 扫码服务返回 HTTP {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|error| format!("解析微信 iLink 扫码响应失败: {}", error))
}

fn normalize_weixin_base_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let normalized = if value.is_empty() {
        WEIXIN_BASE_URL.to_string()
    } else if value.starts_with("https://") {
        value.to_string()
    } else {
        format!("https://{}", value.trim_start_matches("http://"))
    };
    let parsed = reqwest::Url::parse(&normalized)
        .map_err(|error| format!("微信 iLink API 地址无效: {}", error))?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https" || (host != "weixin.qq.com" && !host.ends_with(".weixin.qq.com"))
    {
        return Err("微信 iLink 扫码服务返回了不受信任的 API 地址".to_string());
    }
    Ok(normalized)
}

async fn weixin_begin() -> Result<ScanBeginResult, String> {
    let response = weixin_get(
        &weixin_http_client()?,
        WEIXIN_BASE_URL,
        "ilink/bot/get_bot_qrcode?bot_type=3",
    )
    .await?;
    let qr_code = response
        .get("qrcode")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "微信扫码服务未返回二维码句柄".to_string())?;
    let qr_url = response
        .get("qrcode_img_content")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(qr_code)
        .to_string();
    let handle = uuid::Uuid::new_v4().to_string();
    let mut scans = weixin_scans()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let now = Instant::now();
    scans.retain(|_, state| state.expires_at > now);
    scans.insert(
        handle.clone(),
        WeixinScanState {
            qr_code: qr_code.to_string(),
            base_url: WEIXIN_BASE_URL.to_string(),
            expires_at: Instant::now() + Duration::from_secs(WEIXIN_SCAN_EXPIRE_SECONDS.into()),
        },
    );
    drop(scans);
    Ok(ScanBeginResult {
        platform: "weixin".to_string(),
        qr_url,
        handle,
        interval: 1,
        expire_in: WEIXIN_SCAN_EXPIRE_SECONDS,
    })
}

async fn weixin_poll(handle: &str) -> Result<ScanPollResult, String> {
    let state = weixin_scans()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(handle)
        .cloned()
        .ok_or_else(|| "微信扫码会话不存在或已过期".to_string())?;
    if Instant::now() >= state.expires_at {
        weixin_scans()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(handle);
        return Ok(ScanPollResult {
            status: "expired".to_string(),
            credentials: None,
            error: None,
        });
    }

    let endpoint = format!(
        "ilink/bot/get_qrcode_status?qrcode={}",
        urlencoding::encode(&state.qr_code)
    );
    let response = weixin_get(&weixin_http_client()?, &state.base_url, &endpoint).await?;
    match response
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("wait")
    {
        "confirmed" => {
            let account_id = response
                .get("ilink_bot_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let token = response
                .get("bot_token")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if account_id.is_empty() || token.is_empty() {
                return Ok(ScanPollResult {
                    status: "failed".to_string(),
                    credentials: None,
                    error: Some("微信已确认登录，但返回的 Bot 凭证不完整".to_string()),
                });
            }
            weixin_scans()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(handle);
            Ok(ScanPollResult {
                status: "success".to_string(),
                credentials: Some(ScanCredentials {
                    app_id: account_id.to_string(),
                    app_secret: token.to_string(),
                    target_id: response
                        .get("ilink_user_id")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                    base_url: Some(normalize_weixin_base_url(
                        response
                            .get("baseurl")
                            .and_then(Value::as_str)
                            .unwrap_or(&state.base_url),
                    )?),
                }),
                error: None,
            })
        }
        "scaned_but_redirect" => {
            if let Some(redirect_host) = response
                .get("redirect_host")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                if let Ok(base_url) = normalize_weixin_base_url(redirect_host) {
                    if let Some(current) = weixin_scans()
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .get_mut(handle)
                    {
                        current.base_url = base_url;
                    }
                }
            }
            Ok(ScanPollResult {
                status: "waiting".to_string(),
                credentials: None,
                error: None,
            })
        }
        "expired" => {
            weixin_scans()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(handle);
            Ok(ScanPollResult {
                status: "expired".to_string(),
                credentials: None,
                error: None,
            })
        }
        _ => Ok(ScanPollResult {
            status: "waiting".to_string(),
            credentials: None,
            error: None,
        }),
    }
}
