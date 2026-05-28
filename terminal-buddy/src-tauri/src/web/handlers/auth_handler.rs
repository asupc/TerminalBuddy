use axum::{extract::State, Json};
use crate::models::web_api::{ApiStatusResponse, LoginRequest, LoginResponse};
use crate::services::SettingsService;
use crate::web::auth::generate_jwt;
use crate::web::error::ApiError;
use bcrypt::verify;

pub async fn login(
    State(state): State<crate::web::server::AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let settings = SettingsService::get_settings();

    if !settings.web_api_enabled {
        return Err(ApiError::BadRequest("Web API 未启用".into()));
    }

    if settings.web_api_password_hash.is_empty() {
        return Err(ApiError::BadRequest("未设置 Web API 密码".into()));
    }

    if req.username != settings.web_api_username {
        return Err(ApiError::Unauthorized("用户名或密码错误".into()));
    }

    let valid = verify(&req.password, &settings.web_api_password_hash)
        .map_err(|e| {
            eprintln!("[WebAPI] bcrypt verify error: {}", e);
            ApiError::Unauthorized("用户名或密码错误".to_string())
        })?;
    if !valid {
        return Err(ApiError::Unauthorized("用户名或密码错误".into()));
    }

    let token = generate_jwt(&req.username, &state.jwt_secret)
        .map_err(|e| ApiError::Internal(e))?;

    Ok(Json(LoginResponse {
        token,
        username: req.username,
    }))
}

pub async fn status() -> Json<ApiStatusResponse> {
    let settings = SettingsService::get_settings();
    Json(ApiStatusResponse {
        enabled: settings.web_api_enabled,
        port: settings.web_api_port,
    })
}
