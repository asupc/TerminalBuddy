use std::path::PathBuf;
use terminal_buddy_lib::{commands, runtime::AppHandle, services::{PathService, SettingsService}, web};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = std::env::var_os("TERMINAL_BUDDY_DATA_DIR")
        .map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().unwrap().join("server-data"));
    if !data_dir.is_absolute() { return Err("数据目录必须为绝对路径".into()); }
    std::fs::create_dir_all(&data_dir)?;
    std::env::set_var("TERMINAL_BUDDY_DATA_DIR", &data_dir);
    PathService::require_data_dir()?;

    let settings_path = SettingsService::get_settings_path();
    // 已有文件损坏时停止启动，避免被误判为首次启动并覆盖管理员密码。
    if settings_path.try_exists()? {
        serde_json::from_slice::<terminal_buddy_lib::models::AppSettings>(&std::fs::read(&settings_path)?)?;
    }
    let mut settings = SettingsService::get_settings();
    let password = if settings.web_api_password_hash.is_empty() {
        match std::env::var("TERMINAL_BUDDY_PASSWORD_FILE") {
            Ok(path) => Some(std::fs::read_to_string(path)?.trim_end_matches(['\r', '\n']).to_string()),
            Err(_) => std::env::var("TERMINAL_BUDDY_PASSWORD").ok(),
        }
    } else { None };
    std::env::remove_var("TERMINAL_BUDDY_PASSWORD");
    if let Some(password) = password {
        web::auth::validate_admin_password(&password)?;
        settings.web_api_password_hash = bcrypt::hash(password, bcrypt::DEFAULT_COST)?;
    }
    if settings.web_api_password_hash.is_empty() {
        println!("首次启动：请打开网页创建管理员密码，初始化完成前业务接口需要认证。");
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
            enabled_agents: commands::profile::EnabledAgents::default(),
        }])?;
    }

    let app = AppHandle::new();
    // 原生 AI 会话的实时推送走统一事件通道（浏览器 / WS 事件订阅）。
    terminal_buddy_lib::services::ai_chat_service::set_app_handle(app.clone());
    terminal_buddy_lib::services::codex_activity_service::start(app.clone());
    // Agent 历史会话自动归档：启动后延时执行，之后每 6 小时按设置检查一次。
    terminal_buddy_lib::services::session_auto_archive_service::start(app.clone());
    // 周期性登记存活终端的 Claude 会话 ID：即使用户关闭了浏览器，容器重启后
    // 也能按旧 terminal ID 找回会话并执行 claude --resume。
    {
        let registry_app = app.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(10));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let app = registry_app.clone();
                match tokio::task::spawn_blocking(move || {
                    commands::claude_session::refresh_claude_session_registry(&app)
                }).await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => eprintln!("Claude 会话登记失败：{}", error),
                    Err(error) => eprintln!("Claude 会话登记任务失败：{}", error),
                }
            }
        });
    }
    match web::claude_hook_server::bind() {
        Ok(listener) => { tokio::spawn(web::claude_hook_server::run(app.clone(), listener)); }
        Err(error) => eprintln!("Claude Hook 服务未启动：{}", error),
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
        // 退出前再登记一次，覆盖“刚启动不久、还没等到周期扫描”的 Claude 会话；
        // 此时 PTY 尚未 teardown，进程树仍然可见。
        let registry_app = shutdown_app.clone();
        let _ = tokio::task::spawn_blocking(move || {
            commands::claude_session::refresh_claude_session_registry(&registry_app)
        }).await;
        terminal_buddy_lib::runtime::shutdown(&shutdown_app);
        let _ = shutdown_tx.send(true);
    });
    // 密钥持久化在数据目录（容器内 /data），重建容器 / 重启服务后已登录设备仍保持登录。
    let jwt_secret = web::auth::load_or_create_jwt_secret()?;
    web::server::run_server(settings.web_api_port, jwt_secret, app, shutdown_rx).await?;
    Ok(())
}
