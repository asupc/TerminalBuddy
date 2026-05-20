use tauri::AppHandle;
use crate::services::SettingsService;
use crate::web::auth::generate_jwt_secret;
use tokio::sync::watch;
use std::sync::Mutex;

/// Stores the shutdown signal sender so we can stop/restart the server
pub(crate) static SHUTDOWN_TX: Mutex<Option<watch::Sender<bool>>> = Mutex::new(None);
pub(crate) static JWT_SECRET: Mutex<Option<String>> = Mutex::new(None);

#[tauri::command]
pub async fn restart_web_server(app: AppHandle) -> Result<String, String> {
    let settings = SettingsService::get_settings();

    // Stop existing server
    if let Some(tx) = SHUTDOWN_TX.lock().unwrap().take() {
        let _ = tx.send(true);
    }

    if !settings.web_api_enabled || settings.web_api_password_hash.is_empty() {
        return Ok("Web API 已停止".into());
    }

    let jwt_secret = generate_jwt_secret();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    *SHUTDOWN_TX.lock().unwrap() = Some(shutdown_tx);
    *JWT_SECRET.lock().unwrap() = Some(jwt_secret.clone());

    let port = settings.web_api_port;
    tauri::async_runtime::spawn(crate::web::server::run_server(
        port,
        jwt_secret,
        app.clone(),
        shutdown_rx,
    ));

    Ok(format!("Web API 已启动，端口: {}", port))
}

#[tauri::command]
pub fn get_web_server_address() -> Result<String, String> {
    let settings = SettingsService::get_settings();
    if !settings.web_api_enabled {
        return Ok("Web API 未启用".into());
    }
    Ok(format!("http://localhost:{}", settings.web_api_port))
}
