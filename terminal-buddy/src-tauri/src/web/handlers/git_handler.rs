//! Web 端 Git 集成：状态 / 分支 / 切换 / 提交 / 拉取 / 推送。
//! 与 PC 端共用 `commands::git` 的实现；所有路径先过项目白名单。
//!
//! 长操作（pull/push 可能超过 REST 30s 超时）用「立即返回 + 轮询」模型：
//! POST 启动后台任务（同仓库同时仅一个操作，忙碌返回 409），
//! 前端轮询 `GET /api/git/operation` 展示进度与输出。

use crate::commands::git::{
    get_git_repository_status_impl, git_checkout_branch_impl, git_commit_all_impl,
    git_list_branches_impl, git_pull_text_impl, git_push_text_impl, GitBranch,
    GitRepositoryStatus,
};
use crate::models::web_api::{GitCheckoutRequest, GitCommitRequest, GitRepoRequest};
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::handlers::ensure_project_scope;
use crate::web::server::AppState;
use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoQuery {
    pub repo: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationStatus {
    pub action: String,
    /// running | done | failed；不存在记录时返回 idle
    pub status: String,
    pub output: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

fn operations() -> &'static Mutex<HashMap<String, GitOperationStatus>> {
    static OPERATIONS: OnceLock<Mutex<HashMap<String, GitOperationStatus>>> = OnceLock::new();
    OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 完整网页界面与轻量 REST 共用同一张仓库互斥表。
pub(crate) struct DesktopGitLease { repo: String }
impl DesktopGitLease {
    pub(crate) fn finish(self, outcome: &Result<serde_json::Value, String>) {
        if let Ok(mut map) = operations().lock() {
            if let Some(operation) = map.get_mut(&self.repo) {
                operation.status = if outcome.is_ok() { "done" } else { "failed" }.to_string();
                operation.output = outcome.as_ref().err().cloned().unwrap_or_default();
                operation.finished_at = Some(now_millis());
            }
        }
    }
}
impl Drop for DesktopGitLease {
    fn drop(&mut self) {
        if let Ok(mut map) = operations().lock() {
            if let Some(operation) = map.get_mut(&self.repo) {
                if operation.status == "running" {
                    operation.status = "failed".to_string();
                    operation.output = "操作已中断".to_string();
                    operation.finished_at = Some(now_millis());
                }
            }
        }
    }
}
pub(crate) fn reserve_desktop_operation(path: &str, action: &str) -> Result<DesktopGitLease, ApiError> {
    let repo = ensure_project_scope(path)?;
    let mut map = operations().lock().map_err(|_| ApiError::Internal("Git 操作锁不可用".to_string()))?;
    if map.get(&repo).is_some_and(|operation| operation.status == "running") {
        return Err(ApiError::Conflict("该仓库有操作正在执行，请稍后重试".to_string()));
    }
    map.insert(repo.clone(), GitOperationStatus { action: action.to_string(), status: "running".to_string(), output: String::new(), started_at: now_millis(), finished_at: None });
    Ok(DesktopGitLease { repo })
}

/// 启动后台 Git 操作：同仓库忙碌返回 409，任务结束后把输出写回轮询记录。
/// 接收 String（而非 &str）：闭包要 move 同一份数据进后台任务，避免借用冲突。
fn start_operation(
    repo: String,
    action: &'static str,
    task: impl FnOnce() -> Result<String, String> + Send + 'static,
) -> Result<(), ApiError> {
    let key = ensure_project_scope(&repo)?;
    {
        let mut ops = operations().lock().unwrap_or_else(|e| e.into_inner());
        if ops
            .get(&key)
            .is_some_and(|record| record.status == "running")
        {
            return Err(ApiError::Conflict(format!(
                "该仓库正在执行「{}」，请等待完成后再操作",
                ops.get(&key).map(|r| r.action.as_str()).unwrap_or(action)
            )));
        }
        ops.insert(
            key.clone(),
            GitOperationStatus {
                action: action.to_string(),
                status: "running".to_string(),
                output: String::new(),
                started_at: now_millis(),
                finished_at: None,
            },
        );
    }
    tokio::task::spawn_blocking(move || {
        let result = task();
        let mut ops = operations().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(record) = ops.get_mut(&key) {
            match result {
                Ok(output) => {
                    record.status = "done".into();
                    record.output = output;
                }
                Err(error) => {
                    record.status = "failed".into();
                    record.output = error;
                }
            }
            record.finished_at = Some(now_millis());
        }
    });
    Ok(())
}

/// 仓库状态摘要（当前分支 / 上下游 / 变更计数）；非 Git 目录返回 null。
pub async fn status(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Query(q): Query<GitRepoQuery>,
) -> Result<Json<Option<GitRepositoryStatus>>, ApiError> {
    ensure_project_scope(&q.repo)?;
    let path = q.repo;
    let status = tokio::task::spawn_blocking(move || get_git_repository_status_impl(path))
        .await
        .map_err(|error| ApiError::Internal(format!("状态查询任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    Ok(Json(status))
}

/// 本地 + 远程分支列表（本地在前，含当前标记）。
pub async fn branches(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Query(q): Query<GitRepoQuery>,
) -> Result<Json<Vec<GitBranch>>, ApiError> {
    ensure_project_scope(&q.repo)?;
    let path = q.repo;
    let list = tokio::task::spawn_blocking(move || git_list_branches_impl(path))
        .await
        .map_err(|error| ApiError::Internal(format!("分支查询任务执行失败: {}", error)))?
        .map_err(ApiError::Internal)?;
    Ok(Json(list))
}

/// 轮询当前操作状态；从未操作过返回 idle。
pub async fn operation(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Query(q): Query<GitRepoQuery>,
) -> Result<Json<GitOperationStatus>, ApiError> {
    let key = ensure_project_scope(&q.repo)?;
    let ops = operations().lock().unwrap_or_else(|e| e.into_inner());
    Ok(Json(ops.get(&key).cloned().unwrap_or(GitOperationStatus {
        action: String::new(),
        status: "idle".to_string(),
        output: String::new(),
        started_at: 0,
        finished_at: None,
    })))
}

pub async fn checkout(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<GitCheckoutRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let repo = req.repo.clone();
    let branch = req.branch;
    start_operation(repo.clone(), "切换分支", move || {
        git_checkout_branch_impl(repo, branch)
    })?;
    Ok(Json(serde_json::json!({ "started": true })))
}

/// 提交全部变更（Web 文件树第一版没有文件级选择；文件级提交走 PC 端）。
pub async fn commit(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<GitCommitRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let repo = req.repo.clone();
    let message = req.message;
    start_operation(repo.clone(), "提交变更", move || {
        git_commit_all_impl(repo, message)
    })?;
    Ok(Json(serde_json::json!({ "started": true })))
}

pub async fn pull(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<GitRepoRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let repo = req.repo;
    start_operation(repo.clone(), "拉取", move || git_pull_text_impl(repo))?;
    Ok(Json(serde_json::json!({ "started": true })))
}

/// 默认推送当前分支（遵循仓库 push 配置与上游）；高级推送选项走 PC 端。
pub async fn push(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(req): Json<GitRepoRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let repo = req.repo;
    start_operation(repo.clone(), "推送", move || git_push_text_impl(repo))?;
    Ok(Json(serde_json::json!({ "started": true })))
}
