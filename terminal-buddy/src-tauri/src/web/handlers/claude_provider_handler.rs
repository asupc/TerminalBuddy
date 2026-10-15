use axum::{extract::Path, http::{header, HeaderValue}, response::{IntoResponse, Response}, Json};
use crate::services::claude_provider_service::{self, ProviderAction, ProviderError, ProviderInput};
use crate::web::{auth::ClaimsFromRequest, error::ApiError};
use super::container_environment::ensure_docker;

async fn run(action: ProviderAction) -> Result<Response, ApiError> {
    ensure_docker()?;
    let result = tokio::task::spawn_blocking(move || claude_provider_service::execute(action)).await
        .map_err(|_| ApiError::Internal("模型配置任务异常".into()))?
        .map_err(|error| match error {
            ProviderError::Invalid(message) => ApiError::BadRequest(message),
            ProviderError::NotFound => ApiError::NotFound("模型配置不存在，请刷新后重试".into()),
            ProviderError::Conflict(message) => ApiError::Conflict(message),
            ProviderError::Storage(message) => ApiError::Internal(message),
        })?;
    let mut response = Json(result).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
pub async fn list(_claims: ClaimsFromRequest) -> Result<Response, ApiError> { run(ProviderAction::List).await }
pub async fn create(_claims: ClaimsFromRequest, Json(input): Json<ProviderInput>) -> Result<Response, ApiError> {
    run(ProviderAction::Create(input)).await
}
pub async fn update(_claims: ClaimsFromRequest, Path(id): Path<String>, Json(input): Json<ProviderInput>) -> Result<Response, ApiError> {
    run(ProviderAction::Update(id,input)).await
}
pub async fn activate(_claims: ClaimsFromRequest, Path(id): Path<String>) -> Result<Response, ApiError> { run(ProviderAction::Activate(id)).await }
pub async fn remove(_claims: ClaimsFromRequest, Path(id): Path<String>) -> Result<Response, ApiError> { run(ProviderAction::Delete(id)).await }
pub async fn import_current(_claims: ClaimsFromRequest) -> Result<Response, ApiError> { run(ProviderAction::ImportCurrent).await }
pub async fn deactivate(_claims: ClaimsFromRequest) -> Result<Response, ApiError> { run(ProviderAction::Deactivate).await }
