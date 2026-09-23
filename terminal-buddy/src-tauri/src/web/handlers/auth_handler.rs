use crate::models::web_api::{ApiStatusResponse, LoginRequest, LoginResponse};
use crate::services::SettingsService;
use crate::web::auth::generate_jwt;
use crate::web::error::ApiError;
use crate::web::rate_limit::{
    acquire_password_verify_slot, LoginAttempt, LoginThrottle, PASSWORD_VERIFY_RETRY_AFTER_SECS,
};
use axum::{
    extract::{ConnectInfo, State},
    Json,
};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

pub async fn login(
    State(state): State<crate::web::server::AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let settings = SettingsService::get_settings();

    if !settings.web_api_enabled {
        return Err(ApiError::BadRequest("Web API 未启用".into()));
    }

    if settings.web_api_password_hash.is_empty() {
        return Err(ApiError::BadRequest("未设置 Web API 密码".into()));
    }

    // 先看限流，别让被封禁的 IP 有机会消耗 bcrypt
    let client_ip = peer.ip();
    if let LoginAttempt::Reject { retry_after } = state.login_throttle.check(client_ip) {
        return Err(too_many_login_attempts(retry_after));
    }

    // 用户名不匹配同样计入失败次数，否则枚举用户名不受限流约束
    if req.username != settings.web_api_username {
        return Err(record_failed_login(&state.login_throttle, client_ip));
    }

    // bcrypt 是 CPU 密集的：拿不到并发槽位就直接 429，避免登录风暴拖垮本机终端
    let Some(_verify_slot) = acquire_password_verify_slot().await else {
        eprintln!("[WebAPI] 密码校验并发已达上限，限流登录请求，ip={}", client_ip);
        return Err(ApiError::TooManyRequests {
            message: format!(
                "服务器正忙，请在 {} 秒后重试。",
                PASSWORD_VERIFY_RETRY_AFTER_SECS
            ),
            retry_after_secs: PASSWORD_VERIFY_RETRY_AFTER_SECS,
        });
    };

    // 校验放到阻塞线程池，避免占住 async worker
    let password = req.password;
    let password_hash = settings.web_api_password_hash.clone();
    let valid = tokio::task::spawn_blocking(move || bcrypt::verify(password, &password_hash))
        .await
        .map_err(|e| ApiError::Internal(format!("密码校验任务异常终止: {}", e)))?
        .map_err(|e| {
            eprintln!("[WebAPI] bcrypt verify error: {}", e);
            ApiError::Unauthorized("用户名或密码错误".to_string())
        })?;

    if !valid {
        return Err(record_failed_login(&state.login_throttle, client_ip));
    }

    state.login_throttle.record_success(client_ip);

    let token =
        generate_jwt(&req.username, &state.jwt_secret).map_err(|e| ApiError::Internal(e))?;

    Ok(Json(LoginResponse {
        token,
        username: req.username,
    }))
}

/// 记一次登录失败：刚好触发封禁就回 429，否则回原来的 401。
fn record_failed_login(throttle: &LoginThrottle, client_ip: IpAddr) -> ApiError {
    match throttle.record_failure(client_ip) {
        LoginAttempt::Allow => ApiError::Unauthorized("用户名或密码错误".to_string()),
        LoginAttempt::Reject { retry_after } => {
            eprintln!(
                "[WebAPI] 登录失败次数过多，暂时封禁 ip={}，时长 {} 秒",
                client_ip,
                retry_after.as_secs()
            );
            too_many_login_attempts(retry_after)
        }
    }
}

fn too_many_login_attempts(retry_after: Duration) -> ApiError {
    let retry_after_secs = (retry_after.as_secs_f32().ceil() as u64).max(1);
    ApiError::TooManyRequests {
        message: format!("登录失败次数过多，请在 {} 秒后重试。", retry_after_secs),
        retry_after_secs,
    }
}

pub async fn status() -> Json<ApiStatusResponse> {
    let settings = SettingsService::get_settings();
    Json(ApiStatusResponse {
        enabled: settings.web_api_enabled,
        port: settings.web_api_port,
    })
}
