//! Claude 资产库命令（skills / agents / commands：库 + 部署模型）。
//! 业务逻辑在 `services::claude_assets_service`，这里只做参数转接。

use super::claude_task;
use crate::services::claude_assets_service::{self, AssetEntry, AssetKind, ImportableAsset};

fn parse_kind(kind: &str) -> Result<AssetKind, String> {
    AssetKind::from_str(kind).ok_or_else(|| format!("未知资产类型: {}", kind))
}

#[tauri::command]
pub async fn list_claude_assets(
    project_dir: Option<String>,
) -> Result<Vec<AssetEntry>, String> {
    claude_task(move || claude_assets_service::list_assets(project_dir.as_deref())).await
}

#[tauri::command]
pub async fn deploy_claude_asset(
    kind: String,
    name: String,
    scope: String,
    project_dir: Option<String>,
) -> Result<(), String> {
    claude_task(move || {
        claude_assets_service::deploy(parse_kind(&kind)?, &name, &scope, project_dir.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn undeploy_claude_asset(
    kind: String,
    name: String,
    scope: String,
    project_dir: Option<String>,
) -> Result<(), String> {
    claude_task(move || {
        claude_assets_service::undeploy(
            parse_kind(&kind)?,
            &name,
            &scope,
            project_dir.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn sync_claude_asset(
    kind: String,
    name: String,
    direction: String,
    scope: String,
    project_dir: Option<String>,
) -> Result<(), String> {
    claude_task(move || {
        claude_assets_service::sync(
            parse_kind(&kind)?,
            &name,
            &direction,
            &scope,
            project_dir.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn import_claude_asset(
    kind: String,
    scope: String,
    project_dir: Option<String>,
    name: String,
) -> Result<(), String> {
    claude_task(move || {
        claude_assets_service::import_asset(
            parse_kind(&kind)?,
            &scope,
            project_dir.as_deref(),
            &name,
        )
    })
    .await
}

#[tauri::command]
pub async fn list_importable_claude_assets(
    scope: String,
    project_dir: Option<String>,
) -> Result<Vec<ImportableAsset>, String> {
    claude_task(move || {
        claude_assets_service::list_importable(&scope, project_dir.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn delete_claude_asset(kind: String, name: String) -> Result<(), String> {
    claude_task(move || claude_assets_service::delete_library_asset(parse_kind(&kind)?, &name))
        .await
}

#[tauri::command]
pub async fn create_claude_asset(
    kind: String,
    name: String,
    description: String,
) -> Result<String, String> {
    claude_task(move || {
        claude_assets_service::create_asset(parse_kind(&kind)?, &name, &description)
    })
    .await
}

#[tauri::command]
pub async fn read_claude_asset(kind: String, name: String) -> Result<String, String> {
    claude_task(move || claude_assets_service::read_asset(parse_kind(&kind)?, &name)).await
}

#[tauri::command]
pub async fn write_claude_asset(
    kind: String,
    name: String,
    content: String,
) -> Result<(), String> {
    claude_task(move || {
        claude_assets_service::write_asset(parse_kind(&kind)?, &name, &content)
    })
    .await
}
