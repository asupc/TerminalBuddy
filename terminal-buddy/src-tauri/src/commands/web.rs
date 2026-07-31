use crate::services::BotSettingsService;
use crate::services::SettingsService;
use crate::web::auth::generate_jwt_secret;
use std::sync::Mutex;
use tauri::AppHandle;
use tokio::sync::watch;

/// Stores the shutdown signal sender so we can stop/restart the server
pub(crate) static SHUTDOWN_TX: Mutex<Option<watch::Sender<bool>>> = Mutex::new(None);
pub(crate) static JWT_SECRET: Mutex<Option<String>> = Mutex::new(None);

fn should_run_http_server() -> bool {
    let settings = SettingsService::get_settings();
    (settings.web_api_enabled && !settings.web_api_password_hash.is_empty())
        || BotSettingsService::requires_callback_server()
}

fn start_http_server(app: AppHandle) {
    let settings = SettingsService::get_settings();
    let jwt_secret = generate_jwt_secret();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    *SHUTDOWN_TX.lock().unwrap() = Some(shutdown_tx);
    *JWT_SECRET.lock().unwrap() = Some(jwt_secret.clone());
    tauri::async_runtime::spawn(crate::web::server::run_server(
        settings.web_api_port,
        jwt_secret,
        app,
        shutdown_rx,
    ));
}

pub fn sync_http_server_for_bot(app: AppHandle) -> Result<(), String> {
    let running = SHUTDOWN_TX.lock().unwrap().is_some();
    let should_run = should_run_http_server();
    if should_run && !running {
        start_http_server(app);
    } else if !should_run && running {
        if let Some(tx) = SHUTDOWN_TX.lock().unwrap().take() {
            let _ = tx.send(true);
        }
        *JWT_SECRET.lock().unwrap() = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn restart_web_server(app: AppHandle) -> Result<String, String> {
    let settings = SettingsService::get_settings();

    // Stop existing server
    if let Some(tx) = SHUTDOWN_TX.lock().unwrap().take() {
        let _ = tx.send(true);
    }

    if !should_run_http_server() {
        return Ok("HTTP 服务已停止".into());
    }
    start_http_server(app);
    Ok(format!("HTTP 服务已启动，端口: {}", settings.web_api_port))
}

#[tauri::command]
pub fn get_web_server_address() -> Result<String, String> {
    let settings = SettingsService::get_settings();
    if !settings.web_api_enabled {
        return Ok("Web API 未启用".into());
    }
    // 手机端通过局域网访问，优先返回出站主网卡 IPv4；取不到则回退 localhost。
    let host = lan_ipv4().unwrap_or_else(|| "localhost".to_string());
    Ok(format!("http://{}:{}", host, settings.web_api_port))
}

/// 生成免密快速访问 URL：用当前服务 jwt_secret 签发一个与正常登录等价的 JWT，
/// 拼成 `http://<局域网IP>:<端口>/?token=<jwt>`。手机扫码 / PC 点击均可跳过登录直接进入。
/// 复用本文件已有的 JWT_SECRET 与 lan_ipv4()。
#[tauri::command]
pub fn get_web_quick_access_url() -> Result<String, String> {
    let settings = SettingsService::get_settings();
    if !settings.web_api_enabled {
        return Err("Web API 未启用".into());
    }
    let jwt_secret = JWT_SECRET
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Web 服务未启动".to_string())?;
    let token = crate::web::auth::generate_jwt(&settings.web_api_username, &jwt_secret)?;
    let host = lan_ipv4().unwrap_or_else(|| "localhost".to_string());
    Ok(format!(
        "http://{}:{}/?token={}",
        host, settings.web_api_port, token
    ))
}

/// 用 UDP「连接」技巧取本机出站主 IPv4：connect 只设置目的地址、不真正发包，
/// local_addr() 返回操作系统为该路由选用的源 IP。无网络时返回 None。
fn lan_ipv4() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip().to_string())
}
