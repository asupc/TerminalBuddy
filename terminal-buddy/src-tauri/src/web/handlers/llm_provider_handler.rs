//! 大模型供应商 REST：CRUD / 默认 / 排序 / 拉取模型 / 右键菜单数据源。
//! 与 PC 端 Tauri 命令共用 `services::llm_provider_service`；用户级数据，
//! 不套 `ensure_project_scope`，不做 `ensure_docker`。含 Key 的请求/响应加
//! `Cache-Control: no-store`。

use axum::extract::{Path, State};
use axum::http::header;
use axum::response::Response;
use axum::Json;
use serde::Deserialize;

use crate::models::llm_provider::LlmProviderInput;
use crate::services::llm_provider_service;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsRequest {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub models_url: String,
    #[serde(default)]
    pub provider_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderRequest {
    pub ids: Vec<String>,
}

fn no_store_json<T: serde::Serialize>(value: &T) -> Result<Response, ApiError> {
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

use axum::response::IntoResponse;

pub async fn list(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Response, ApiError> {
    let providers = tokio::task::spawn_blocking(llm_provider_service::list_providers)
        .await
        .map_err(|error| ApiError::Internal(format!("查询任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    no_store_json(&providers)
}

pub async fn create(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(input): Json<LlmProviderInput>,
) -> Result<Response, ApiError> {
    if !input.id.trim().is_empty() {
        return Err(ApiError::BadRequest("新建供应商不应携带 id".to_string()));
    }
    let view = tokio::task::spawn_blocking(move || llm_provider_service::save_provider(input))
        .await
        .map_err(|error| ApiError::Internal(format!("保存任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    no_store_json(&view)
}

pub async fn update(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
    Json(mut input): Json<LlmProviderInput>,
) -> Result<Response, ApiError> {
    input.id = id;
    let view = tokio::task::spawn_blocking(move || llm_provider_service::save_provider(input))
        .await
        .map_err(|error| ApiError::Internal(format!("保存任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    no_store_json(&view)
}

pub async fn remove(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let providers = tokio::task::spawn_blocking(move || llm_provider_service::delete_provider(&id))
        .await
        .map_err(|error| ApiError::Internal(format!("删除任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    no_store_json(&providers)
}

pub async fn set_default(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let providers =
        tokio::task::spawn_blocking(move || llm_provider_service::set_default_provider(&id))
            .await
            .map_err(|error| ApiError::Internal(format!("保存任务执行失败: {}", error)))?
            .map_err(ApiError::Internal)?;
    no_store_json(&providers)
}

/// 取消默认供应商：允许没有默认，右键菜单不再平铺任何模型。
pub async fn clear_default(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Response, ApiError> {
    let providers =
        tokio::task::spawn_blocking(llm_provider_service::clear_default_provider)
            .await
            .map_err(|error| ApiError::Internal(format!("保存任务执行失败: {}", error)))?
            .map_err(ApiError::Internal)?;
    no_store_json(&providers)
}

pub async fn update_order(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<OrderRequest>,
) -> Result<Response, ApiError> {
    let providers =
        tokio::task::spawn_blocking(move || llm_provider_service::update_provider_order(&req.ids))
            .await
            .map_err(|error| ApiError::Internal(format!("保存任务执行失败: {}", error)))?
            .map_err(ApiError::Internal)?;
    no_store_json(&providers)
}

/// 拉取模型列表：纯 async 网络请求，直接 await，不走阻塞池。
pub async fn fetch_models(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<FetchModelsRequest>,
) -> Result<Response, ApiError> {
    let models = llm_provider_service::fetch_provider_models(
        &req.base_url,
        &req.api_key,
        &req.models_url,
        req.provider_id.as_deref(),
    )
    .await
    .map_err(ApiError::Internal)?;
    no_store_json(&models)
}

pub async fn launch_targets(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<crate::models::llm_provider::LlmLaunchTarget>>, ApiError> {
    let targets = tokio::task::spawn_blocking(llm_provider_service::list_launch_targets)
        .await
        .map_err(|error| ApiError::Internal(format!("查询任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    Ok(Json(targets))
}
