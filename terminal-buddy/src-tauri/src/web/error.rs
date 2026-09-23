use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub enum ApiError {
    Unauthorized(String),
    Forbidden(String),
    BadRequest(String),
    NotFound(String),
    /// 被限流拦下，`retry_after_secs` 会写进 `Retry-After` 头
    TooManyRequests {
        message: String,
        retry_after_secs: u64,
    },
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            ApiError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "unauthorized", msg),
            ApiError::Forbidden(msg) => (StatusCode::FORBIDDEN, "forbidden", msg),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "bad_request", msg),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, "not_found", msg),
            // 429 需要额外带 Retry-After，单独构造响应
            ApiError::TooManyRequests {
                message,
                retry_after_secs,
            } => {
                let mut response = (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({ "error": "too_many_requests", "message": message })),
                )
                    .into_response();
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, HeaderValue::from(retry_after_secs));
                return response;
            }
            ApiError::Internal(msg) => {
                eprintln!("[WebAPI] Internal error: {}", msg);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "服务器内部错误".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": error, "message": message }))).into_response()
    }
}
