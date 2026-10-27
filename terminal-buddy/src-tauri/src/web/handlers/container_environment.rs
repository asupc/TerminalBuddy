//! Agent CLI 检测、安装与更新的 REST 壳：平台无关逻辑在 services/agent_cli_service.rs，
//! 桌面端 Tauri 命令与这里共用同一核心。
use axum::{extract::{Path as ApiPath, Query, State}, http::StatusCode, Json};
use serde::Deserialize;

use crate::services::agent_cli_service::{self, AgentCliError, CliStatus, CliTool, Environment, Operation};
use crate::web::{auth::ClaimsFromRequest, error::ApiError, server::AppState};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliToolParam {
    Claude,
    Codex,
    Pi,
}

impl From<CliToolParam> for CliTool {
    fn from(value: CliToolParam) -> Self {
        match value {
            CliToolParam::Claude => Self::Claude,
            CliToolParam::Codex => Self::Codex,
            CliToolParam::Pi => Self::Pi,
        }
    }
}

pub fn is_docker_runtime() -> bool {
    !cfg!(feature = "desktop")
        && cfg!(target_os = "linux")
        && (std::env::var("TERMINAL_BUDDY_DEPLOYMENT").as_deref() == Ok("docker")
            || std::path::Path::new("/.dockerenv").is_file())
}

/// 旧版 Docker 容器 Claude 供应商链路（SQLite 存储）仍为容器专属功能。
pub(crate) fn ensure_docker() -> Result<(), ApiError> {
    if is_docker_runtime() {
        Ok(())
    } else {
        Err(ApiError::Forbidden("该功能仅适用于 Docker 版本".into()))
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentQuery {
    #[serde(default)]
    check_updates: bool,
}

fn map_error(error: AgentCliError) -> ApiError {
    match error {
        AgentCliError::Conflict(message) => ApiError::Conflict(message),
        AgentCliError::Failure(message) => ApiError::Internal(message),
    }
}

pub async fn status(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Query(query): Query<EnvironmentQuery>,
) -> Result<Json<Environment>, ApiError> {
    if query.check_updates {
        let (claude, codex, pi) = tokio::try_join!(
            agent_cli_service::load_status(CliTool::Claude, true),
            agent_cli_service::load_status(CliTool::Codex, true),
            agent_cli_service::load_status(CliTool::Pi, true),
        ).map_err(map_error)?;
        return Ok(Json(Environment { claude, codex, pi }));
    }
    tokio::task::spawn_blocking(agent_cli_service::environment).await
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .map(Json).map_err(ApiError::Internal)
}

pub async fn tool_status(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    ApiPath(tool): ApiPath<CliToolParam>,
    Query(query): Query<EnvironmentQuery>,
) -> Result<Json<CliStatus>, ApiError> {
    agent_cli_service::load_status(tool.into(), query.check_updates).await
        .map(Json).map_err(map_error)
}

pub async fn install(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    ApiPath(tool): ApiPath<CliToolParam>,
) -> Result<(StatusCode, Json<CliStatus>), ApiError> {
    let status = agent_cli_service::start_operation(tool.into(), Operation::Install).await.map_err(map_error)?;
    Ok((StatusCode::ACCEPTED, Json(status)))
}

pub async fn update(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    ApiPath(tool): ApiPath<CliToolParam>,
) -> Result<(StatusCode, Json<CliStatus>), ApiError> {
    let status = agent_cli_service::start_operation(tool.into(), Operation::Update).await.map_err(map_error)?;
    Ok((StatusCode::ACCEPTED, Json(status)))
}
