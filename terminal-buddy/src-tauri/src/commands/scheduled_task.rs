//! 定时任务的 Tauri 命令层。
//!
//! 桌面端走 `invoke`；浏览器模式通过 `/api/desktop/invoke/:command` 的
//! `desktop_dispatch` 白名单调用同一组服务函数。所有阻塞操作都丢到阻塞线程池。
use super::claude_task;
use crate::models::scheduled_task::*;
use crate::runtime::AppHandle;
use crate::services::scheduled_task_service as service;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_list() -> Result<Vec<ScheduledTaskView>, String> {
    claude_task(service::list).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_save(
    app: AppHandle,
    input: ScheduledTaskInput,
) -> Result<ScheduledTaskView, String> {
    claude_task(move || service::save(&app, input)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_delete(app: AppHandle, id: String) -> Result<(), String> {
    claude_task(move || service::delete(&app, &id)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<ScheduledTaskView, String> {
    claude_task(move || service::set_enabled(&app, &id, enabled)).await
}

/// 只创建运行记录并异步派发，立即返回。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_run_now(app: AppHandle, id: String) -> Result<ScheduledRun, String> {
    claude_task(move || service::run_now(&app, &id)).await
}

/// 仅支持 Agent 运行；项目配置任务请关闭对应终端。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_stop(id: String) -> Result<(), String> {
    claude_task(move || service::stop(&id)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_runs(
    id: String,
    limit: Option<usize>,
) -> Result<Vec<ScheduledRun>, String> {
    claude_task(move || service::runs(&id, limit)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn scheduled_task_options() -> Result<ScheduledTaskOptions, String> {
    claude_task(service::options).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn scheduled_task_preview(
    expression: String,
    timezone: String,
    count: Option<usize>,
) -> Result<Vec<i64>, String> {
    service::preview(&expression, &timezone, count.unwrap_or(5))
}
