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
    /// 资源忙碌（如同一仓库已有 Git 操作在执行），409
    Conflict(String),
    /// 409 + 可选业务字段（decisionId / replyBlockedReason），用于终端 Agent 回复闸门。
    /// 不另建错误码注册表：`error` 仍是变体名，业务字段按需附带。
    ConflictGate {
        message: String,
        decision_id: Option<String>,
        reply_blocked_reason: Option<String>,
    },
    Internal(String),
}

impl From<crate::services::terminal_agent_relay::RelayError> for ApiError {
    fn from(error: crate::services::terminal_agent_relay::RelayError) -> Self {
        match error {
            crate::services::terminal_agent_relay::RelayError::BadRequest(message) => Self::BadRequest(message),
            crate::services::terminal_agent_relay::RelayError::NotFound(message) => Self::NotFound(message),
            crate::services::terminal_agent_relay::RelayError::Forbidden(message) => Self::Forbidden(message),
            crate::services::terminal_agent_relay::RelayError::Conflict { message, decision_id, reply_blocked_reason } => {
                Self::ConflictGate { message, decision_id, reply_blocked_reason }
            }
            crate::services::terminal_agent_relay::RelayError::TooManyRequests { message, retry_after_secs } => {
                Self::TooManyRequests { message, retry_after_secs }
            }
            crate::services::terminal_agent_relay::RelayError::Internal(message) => Self::Internal(message),
        }
    }
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
            ApiError::Conflict(msg) => (StatusCode::CONFLICT, "conflict", msg),
            ApiError::ConflictGate { message, decision_id, reply_blocked_reason } => {
                let mut body = json!({ "error": "conflict", "message": message });
                if let Some(decision_id) = decision_id {
                    body["decisionId"] = json!(decision_id);
                }
                if let Some(reason) = reply_blocked_reason {
                    body["replyBlockedReason"] = json!(reason);
                }
                return (StatusCode::CONFLICT, Json(body)).into_response();
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
