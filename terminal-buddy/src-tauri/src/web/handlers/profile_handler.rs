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
