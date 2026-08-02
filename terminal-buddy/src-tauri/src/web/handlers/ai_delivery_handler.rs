use axum::{
    extract::{Path, State},
    Json,
};
use serde::Serialize;

use crate::commands::TerminalService;
use crate::models::CreateAiDeliveryInput;
use tauri::Manager;

use crate::models::{
    AiAttempt, AiDecisionRequest, AiDelivery, AiDeliveryEvent, AiProject,
    AiReviewGate, AiTaskNode, AiMergeRecord,
};
use crate::services::AiDeliveryService;
use crate::web::auth::ClaimsFromRequest;
use crate::web::error::ApiError;
use crate::web::server::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverySnapshot {
    pub delivery: AiDelivery,
    pub tasks: Vec<AiTaskNode>,
    pub attempts: Vec<AiAttempt>,
    pub review_gates: Vec<AiReviewGate>,
    pub decisions: Vec<AiDecisionRequest>,
    pub merge_records: Vec<AiMergeRecord>,
    pub events: Vec<AiDeliveryEvent>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerDecisionBody {
    pub answer: String,
}

pub async fn projects(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Vec<AiProject>>, ApiError> {
    AiDeliveryService::get_all_projects()
        .map(Json)
        .map_err(ApiError::Internal)
}

pub async fn deliveries(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<AiDelivery>>, ApiError> {
    AiDeliveryService::get_all_deliveries(Some(&project_id))
        .map(Json)
        .map_err(ApiError::Internal)
}

pub async fn snapshot(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<DeliverySnapshot>, ApiError> {
    let delivery = AiDeliveryService::get_delivery(&id).map_err(ApiError::NotFound)?;
    Ok(Json(DeliverySnapshot {
        tasks: AiDeliveryService::get_task_nodes(&id).map_err(ApiError::Internal)?,
        attempts: AiDeliveryService::get_all_attempts(Some(&id)).map_err(ApiError::Internal)?,
        review_gates: AiDeliveryService::get_review_gates(Some(&id)).map_err(ApiError::Internal)?,
        decisions: AiDeliveryService::get_decision_requests(Some(&id))
            .map_err(ApiError::Internal)?,
        merge_records: AiDeliveryService::get_merge_records(Some(&id))
            .map_err(ApiError::Internal)?,
        events: AiDeliveryService::get_delivery_events(&id).map_err(ApiError::Internal)?,
        delivery,
    }))
}

/// Web 端只能批准已生成的任务图，不能派发 Runtime、执行命令或合并代码。
pub async fn approve(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<AiDelivery>, ApiError> {
    let delivery = AiDeliveryService::approve_delivery(&id).map_err(ApiError::BadRequest)?;
    // 批准后自动派发就绪任务
    let app = state.app_handle.clone();
    let terminal_service = app
        .state::<TerminalService>()
        .inner()
        .clone();
    for attempt in AiDeliveryService::dispatch_ready_tasks(&id).unwrap_or_default() {
        let _ = AiDeliveryService::start_attempt(
            &attempt.id,
            app.clone(),
            terminal_service.clone(),
        );
    }
    Ok(Json(delivery))
}

pub async fn answer_decision(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
    Json(body): Json<AnswerDecisionBody>,
) -> Result<Json<AiDecisionRequest>, ApiError> {
    let request = AiDeliveryService::answer_decision_request(&id, &body.answer)
        .map_err(ApiError::BadRequest)?;
    let delivery_id = request.delivery_id.clone();
    if AiDeliveryService::get_delivery(&delivery_id)
        .map(|d| d.state == "running")
        .unwrap_or(false)
    {
        let app = state.app_handle.clone();
        let terminal_service = app.state::<TerminalService>().inner().clone();
        for attempt in AiDeliveryService::dispatch_ready_tasks(&delivery_id).unwrap_or_default() {
            let _ = AiDeliveryService::start_attempt(&attempt.id, app.clone(), terminal_service.clone());
        }
    }
    Ok(Json(request))
}

/// 创建交付任务（远程可触发）
pub async fn create_delivery(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Json(input): Json<CreateAiDeliveryInput>,
) -> Result<Json<AiDelivery>, ApiError> {
    AiDeliveryService::create_delivery(input)
        .map(Json)
        .map_err(ApiError::BadRequest)
}

/// 触发管理者 Agent 规划任务图
pub async fn plan(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<Vec<AiTaskNode>>, ApiError> {
    let app = state.app_handle.clone();
    let terminal_service = app
        .state::<TerminalService>()
        .inner()
        .clone();
    let manager_attempt =
        AiDeliveryService::begin_delivery_planning(&id).map_err(ApiError::BadRequest)?;
    let planning_id = id.clone();
    let manager_attempt_id = manager_attempt.id;
    match tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::plan_delivery_with_manager(
            &planning_id,
            &manager_attempt_id,
            app,
            terminal_service,
        )
    })
    .await
    {
        Ok(result) => result.map(Json).map_err(ApiError::Internal),
        Err(error) => {
            let message = format!("管理者任务图生成线程失败: {}", error);
            let _ = AiDeliveryService::fail_delivery_planning(&id, &message);
            Err(ApiError::Internal(message))
        }
    }
}

/// 手动确认任务完成（用于 Agent 进程不退出但已产出成果的场景）
pub async fn complete_attempt(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<Vec<AiAttempt>>, ApiError> {
    let app = state.app_handle.clone();
    let terminal_service = app
        .state::<TerminalService>()
        .inner()
        .clone();
    let _delivery = AiDeliveryService::get_delivery(&id).map_err(ApiError::NotFound)?;
    let tasks = AiDeliveryService::get_task_nodes(&id).map_err(ApiError::Internal)?;
    let mut completed = Vec::new();
    for task in &tasks {
        if task.state == "running" {
            if let Some(att_id) = task.attempt_ids.last() {
                if let Err(error) = AiDeliveryService::ensure_manual_completion_allowed(att_id) {
                    eprintln!("[WebAPI] manual complete skipped {}: {}", att_id, error);
                    continue;
                }
                match AiDeliveryService::complete_attempt(att_id, app.clone(), terminal_service.clone()) {
                    Ok(a) => completed.push(a),
                    Err(e) => eprintln!("[WebAPI] complete_attempt failed {}: {}", att_id, e),
                }
            }
        }
    }
    // 完成后自动派发后续任务
    for attempt in AiDeliveryService::dispatch_ready_tasks(&id).unwrap_or_default() {
        let _ = AiDeliveryService::start_attempt(&attempt.id, app.clone(), terminal_service.clone());
    }
    Ok(Json(completed))
}

/// 本地合并交付到目标分支
pub async fn merge(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<AiMergeRecord>, ApiError> {
    let _ = &state.app_handle;
    tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::merge_delivery_locally(&id)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("本地合并执行线程失败: {}", e)))?
    .map(Json)
    .map_err(ApiError::BadRequest)
}

/// 清理合并集成工作区
pub async fn cleanup_integration(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _ = &state.app_handle;
    tauri::async_runtime::spawn_blocking(move || {
        AiDeliveryService::cleanup_delivery_integration(&id)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("清理线程失败: {}", e)))?
    .map(|_| Json(serde_json::json!({"ok": true})))
    .map_err(ApiError::BadRequest)
}

/// 重试失败的任务节点
pub async fn retry_task(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<Vec<AiAttempt>>, ApiError> {
    let app = state.app_handle.clone();
    let terminal_service = app
        .state::<TerminalService>()
        .inner()
        .clone();
    // 重试所有失败的任务
    let tasks = AiDeliveryService::get_task_nodes(&id).map_err(ApiError::Internal)?;
    let mut retried = Vec::new();
    for task in tasks.iter().filter(|t| t.state == "failed" || t.state == "rework") {
        match AiDeliveryService::retry_task_node(&task.id) {
            Ok(_) => {
                let attempts = AiDeliveryService::dispatch_ready_tasks(&id)
                    .map_err(ApiError::BadRequest)?;
                for attempt in attempts {
                    match AiDeliveryService::start_attempt(
                        &attempt.id,
                        app.clone(),
                        terminal_service.clone(),
                    ) {
                        Ok(a) => retried.push(a),
                        Err(e) => eprintln!("[WebAPI] 重试启动失败 {}: {}", attempt.id, e),
                    }
                }
            }
            Err(e) => eprintln!("[WebAPI] 重试任务失败 {}: {}", task.id, e),
        }
    }
    Ok(Json(retried))
}

/// 批准任务图并派发就绪任务
pub async fn dispatch(
    State(state): State<AppState>,
    _claims: ClaimsFromRequest,
    Path(id): Path<String>,
) -> Result<Json<Vec<AiAttempt>>, ApiError> {
    let app = state.app_handle.clone();
    let terminal_service = app
        .state::<TerminalService>()
        .inner()
        .clone();
    // 先批准（如果尚未批准）
    let delivery = AiDeliveryService::get_delivery(&id).map_err(ApiError::NotFound)?;
    if delivery.state == "draft" || delivery.state == "drafting" {
        AiDeliveryService::approve_delivery(&id).map_err(ApiError::BadRequest)?;
    }
    let attempts =
        AiDeliveryService::dispatch_ready_tasks(&id).map_err(ApiError::BadRequest)?;
    let mut started = Vec::new();
    for attempt in attempts {
        match AiDeliveryService::start_attempt(
            &attempt.id,
            app.clone(),
            terminal_service.clone(),
        ) {
            Ok(a) => started.push(a),
            Err(e) => {
                eprintln!("[WebAPI] 启动任务尝试失败 {}: {}", attempt.id, e);
            }
        }
    }
    Ok(Json(started))
}
