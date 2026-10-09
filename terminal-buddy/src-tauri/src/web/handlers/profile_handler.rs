use crate::commands::profile::{get_projects, Project};
use crate::models::Profile;
use crate::services::ProfileService;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;
use axum::{extract::State, Json};

/// 只读连接列表：手机端照搬电脑端已配置的导航，不在此增删改 profile。
pub async fn list(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<Profile>>, ApiError> {
    ProfileService::get_all_profiles()
        .map(Json)
        .map_err(ApiError::Internal)
}

/// 只读项目列表：Web 端「启动项目」按项目目录 + 自定义启动命令开 PowerShell，
/// 不在 Web 端管理项目。复用 PC 端 get_projects（含按分组补种项目的逻辑）。
pub async fn list_projects(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<Project>>, ApiError> {
    get_projects().map(Json).map_err(ApiError::Internal)
}
