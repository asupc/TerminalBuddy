use std::path::PathBuf;
use terminal_buddy_lib::{commands, runtime::{AppHandle, Manager}, services::{ClaudeHookService, PathService, SettingsService}, web};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = std::env::var_os("TERMINAL_BUDDY_DATA_DIR")
        .map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().unwrap().join("server-data"));
    if !data_dir.is_absolute() { return Err("数据目录必须为绝对路径".into()); }
    std::fs::create_dir_all(&data_dir)?;
    std::env::set_var("TERMINAL_BUDDY_DATA_DIR", &data_dir);
    PathService::require_data_dir()?;

    let mut settings = SettingsService::get_settings();
    let password = match std::env::var("TERMINAL_BUDDY_PASSWORD_FILE") {
        Ok(path) => Some(std::fs::read_to_string(path)?.trim_end_matches(['\r', '\n']).to_string()),
        Err(_) => std::env::var("TERMINAL_BUDDY_PASSWORD").ok(),
    };
    std::env::remove_var("TERMINAL_BUDDY_PASSWORD");
    if let Some(password) = password {
        if password.is_empty() { return Err("服务端密码不能为空".into()); }
        settings.web_api_password_hash = bcrypt::hash(password, bcrypt::DEFAULT_COST)?;
    }
    if settings.web_api_password_hash.is_empty() {
        return Err("首次启动请设置 TERMINAL_BUDDY_PASSWORD 或 TERMINAL_BUDDY_PASSWORD_FILE".into());
    }
    settings.web_api_enabled = true;
    settings.web_api_username = std::env::var("TERMINAL_BUDDY_USERNAME").unwrap_or(settings.web_api_username);
    if settings.web_api_username.trim().is_empty() { settings.web_api_username = "admin".to_string(); }
    settings.web_api_port = std::env::var("TERMINAL_BUDDY_PORT").ok().map(|value| value.parse()).transpose()?.unwrap_or(9600);
    settings.terminal_loading_mode = terminal_buddy_lib::models::TerminalLoadingMode::Default;
    SettingsService::save_settings(&settings)?;

    let workspace = std::env::var_os("TERMINAL_BUDDY_WORKSPACE_DIR").map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let workspace = workspace.canonicalize()?;
    if commands::get_projects()?.is_empty() {
        commands::save_projects(vec![commands::profile::Project {
            name: "服务器工作区".to_string(), path: workspace.to_string_lossy().to_string(),
            startup_command: String::new(),
        }])?;
    }

    let app = AppHandle::new();
    match web::claude_hook_server::bind() {
        Ok(listener) => { tokio::spawn(web::claude_hook_server::run(app.clone(), listener)); }
        Err(error) => eprintln!("Claude Hook 服务未启动：{}", error),
    }
    if let Err(error) = terminal_buddy_lib::services::sync_bot_long_connections(app.clone()) {
        eprintln!("机器人连接启动失败：{}", error);
    }
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let shutdown_app = app.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("注册 SIGTERM");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        shutdown_app.state::<commands::TerminalService>().shutdown_all_terminals(&shutdown_app);
        ClaudeHookService::release_all_on_shutdown();
        let _ = shutdown_tx.send(true);
    });
    web::server::run_server(settings.web_api_port, web::auth::generate_jwt_secret(), app, shutdown_rx).await?;
    Ok(())
}
