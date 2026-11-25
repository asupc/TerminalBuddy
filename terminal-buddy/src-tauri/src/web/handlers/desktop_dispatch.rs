// 显式白名单：仅向已认证的个人服务账号开放下列业务命令。
use super::{argument, data, result};
use crate::{runtime::{AppHandle, Manager}, web::error::ApiError};
use serde::Serialize;
use serde_json::Value;

/// 原生 AI 会话命令的阻塞任务包装：命令层返回的 `String` 错误统一映射为 400。
async fn run<T: Serialize + Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<Value, ApiError> {
    let value = crate::runtime::async_runtime::spawn_blocking(job).await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    data(value.map_err(ApiError::BadRequest)?)
}

async fn run_api<T: Serialize + Send + 'static>(job: impl FnOnce() -> Result<T, ApiError> + Send + 'static) -> Result<Value, ApiError> {
    let value = crate::runtime::async_runtime::spawn_blocking(job).await
        .map_err(|e| ApiError::Internal(e.to_string()))??;
    data(value)
}

pub async fn dispatch(command: &str, args: Value, app: AppHandle, owner: &str) -> Result<Value, ApiError> {
    match command {
        // 原生 AI 会话：owner 取登录账号，项目范围在创建与发送时把关。
        "ai_session_list" => {
            let owner = owner.to_string();
            run(move || crate::services::ai_chat_service::list(&owner)).await
        }
        "ai_session_get" => {
            let (owner, id) = (owner.to_string(), argument::<String>(&args, "id")?);
            run(move || crate::services::ai_chat_service::get(&id, &owner)).await
        }
        "ai_session_create" => {
            let owner = owner.to_string();
            let mut input: crate::models::ai_chat::CreateAiSession = argument(&args, "input")?;
            run_api(move || {
                // 恢复历史时项目以历史会话所在目录为准，与 REST 创建路径一致。
                if input.resume_session_id.as_deref().is_some_and(|id| !id.trim().is_empty()) {
                    let page = crate::services::ai_chat_service::replay_page(&input.provider,
                        input.resume_session_id.as_deref().unwrap_or(""), 0, 1).map_err(ApiError::BadRequest)?;
                    input.project_path = page.project_dir;
                }
                input.project_path = super::super::ai_chat_handler::ensure_agent_project(&input.project_path, &input.provider)?;
                crate::services::ai_chat_service::create(&owner, input).map_err(ApiError::BadRequest)
            }).await
        }
        "ai_session_send" => {
            let (owner, id) = (owner.to_string(), argument::<String>(&args, "id")?);
            let input: crate::models::ai_chat::SendAiMessage = argument(&args, "input")?;
            run_api(move || {
                let session = crate::services::ai_chat_service::metadata(&id, &owner).map_err(ApiError::BadRequest)?;
                crate::web::handlers::ensure_project_scope(&session.project_path)?;
                crate::services::ai_chat_service::send(&id, &owner, input).map_err(ApiError::BadRequest)
            }).await
        }
        "ai_session_stop" => {
            let (owner, id) = (owner.to_string(), argument::<String>(&args, "id")?);
            run(move || crate::services::ai_chat_service::stop(&id, &owner)).await
        }
        "ai_session_force_stop" => {
            let (owner, id) = (owner.to_string(), argument::<String>(&args, "id")?);
            run(move || crate::services::ai_chat_service::force_stop(&id, &owner)).await
        }
        "ai_session_switch_model" => {
            let (owner, id) = (owner.to_string(), argument::<String>(&args, "id")?);
            let (provider_id, model) = (argument::<String>(&args, "providerId")?, argument::<String>(&args, "model")?);
            run(move || crate::services::ai_chat_service::switch_model(&id, &owner, &provider_id, &model)).await
        }
        "ai_session_set_config_option" => {
            let (owner, id) = (owner.to_string(), argument::<String>(&args, "id")?);
            let (config_id, value) = (argument::<String>(&args, "configId")?, argument::<String>(&args, "value")?);
            run(move || crate::services::ai_chat_service::set_config_option(&id, &owner, &config_id, &value)).await
        }
        "ai_session_answer" => {
            let (owner, id) = (owner.to_string(), argument::<String>(&args, "id")?);
            let input: crate::models::ai_chat::AnswerAiApproval = argument(&args, "input")?;
            run(move || crate::services::ai_chat_service::answer(&id, &owner, input)).await
        }
        "ai_session_delete" => {
            let (owner, id) = (owner.to_string(), argument::<String>(&args, "id")?);
            run(move || crate::services::ai_chat_service::delete(&id, &owner)).await
        }
        "ai_session_pending_update" => {
            let (owner, id, request_id, text) = (owner.to_string(), argument::<String>(&args, "id")?,
                argument::<String>(&args, "requestId")?, argument::<String>(&args, "text")?);
            run_api(move || {
                let session = crate::services::ai_chat_service::metadata(&id, &owner).map_err(ApiError::BadRequest)?;
                crate::web::handlers::ensure_project_scope(&session.project_path)?;
                crate::services::ai_chat_service::update_pending_input(&id, &owner, &request_id, text).map_err(ApiError::BadRequest)
            }).await
        }
        "ai_session_pending_delete" => {
            let (owner, id, request_id) = (owner.to_string(), argument::<String>(&args, "id")?,
                argument::<String>(&args, "requestId")?);
            run(move || crate::services::ai_chat_service::delete_pending_input(&id, &owner, &request_id)).await
        }
        "ai_session_flush" => {
            let (owner, id) = (owner.to_string(), argument::<String>(&args, "id")?);
            let request_id: Option<String> = serde_json::from_value(args.get("requestId").cloned().unwrap_or(Value::Null)).unwrap_or(None);
            run_api(move || {
                let session = crate::services::ai_chat_service::metadata(&id, &owner).map_err(ApiError::BadRequest)?;
                crate::web::handlers::ensure_project_scope(&session.project_path)?;
                crate::services::ai_chat_service::flush(&id, &owner, request_id.as_deref()).map_err(ApiError::BadRequest)
            }).await
        }
        "ai_catalog" => run(crate::services::ai_catalog_service::catalog).await,
        // 定时任务：桌面端与浏览器共用同一服务层，项目范围在保存时校验。
        "scheduled_task_list" => run(crate::services::scheduled_task_service::list).await,
        "scheduled_task_save" => {
            let input: crate::models::scheduled_task::ScheduledTaskInput = argument(&args, "input")?;
            let app = app.clone();
            run(move || crate::services::scheduled_task_service::save(&app, input)).await
        }
        "scheduled_task_delete" => {
            let (id, app2) = (argument::<String>(&args, "id")?, app.clone());
            run(move || crate::services::scheduled_task_service::delete(&app2, &id)).await
        }
        "scheduled_task_set_enabled" => {
            let (id, enabled, app2) = (argument::<String>(&args, "id")?, argument::<bool>(&args, "enabled")?, app.clone());
            run(move || crate::services::scheduled_task_service::set_enabled(&app2, &id, enabled)).await
        }
        "scheduled_task_run_now" => {
            let (id, app2) = (argument::<String>(&args, "id")?, app.clone());
            run(move || crate::services::scheduled_task_service::run_now(&app2, &id)).await
        }
        "scheduled_task_stop" => {
            let (id, app2) = (argument::<String>(&args, "id")?, app.clone());
            run(move || crate::services::scheduled_task_service::stop(&app2, &id)).await
        }
        "scheduled_task_runs" => {
            let id: String = argument(&args, "id")?;
            let limit = args.get("limit").and_then(Value::as_u64).map(|value| value as usize);
            run(move || crate::services::scheduled_task_service::runs(&id, limit)).await
        }
        "scheduled_task_options" => run(crate::services::scheduled_task_service::options).await,
        "scheduled_task_preview" => {
            let expression: String = argument(&args, "expression")?;
            let timezone: String = argument(&args, "timezone")?;
            let count = args.get("count").and_then(Value::as_u64).map(|value| value as usize);
            data(crate::services::scheduled_task_service::preview(&expression, &timezone, count.unwrap_or(5)))
        }
        "ai_session_history" => {
            let agent: String = argument(&args, "agent")?;
            let include_archived: bool = argument(&args, "includeArchived")?;
            let project_dir = args.get("projectDir").and_then(Value::as_str).map(str::to_string);
            run(move || crate::services::ai_chat_service::list_history(&agent, include_archived, project_dir.as_deref())).await
        }
        "ai_session_resume_history" => {
            let (owner, agent, session_id) = (owner.to_string(), argument::<String>(&args, "agent")?,
                argument::<String>(&args, "sessionId")?);
            let provider_id = args.get("providerId").and_then(Value::as_str).map(str::to_string);
            let model = args.get("model").and_then(Value::as_str).map(str::to_string);
            run_api(move || match agent.as_str() {
                "claude" => {
                    let page = crate::services::ai_chat_service::replay_page("claude", &session_id, 0, 1)
                        .map_err(ApiError::BadRequest)?;
                    let project_path = super::super::ai_chat_handler::ensure_agent_project(&page.project_dir, "claude")?;
                    crate::services::ai_chat_service::create(&owner, crate::models::ai_chat::CreateAiSession {
                        provider: "claude".into(), provider_id, project_path, model,
                        resume_session_id: Some(session_id),
                    }).map_err(ApiError::BadRequest)
                }
                "codex" => {
                    let history = crate::services::codex_history_service::get_replay(&session_id, 0, usize::MAX)
                        .map_err(ApiError::BadRequest)?;
                    let project_dir = super::super::ai_chat_handler::ensure_agent_project(&history.project_dir, "codex")?;
                    crate::services::ai_chat_service::resume_codex_history(&owner, &session_id, project_dir,
                        crate::models::ai_chat::ResumeCodexHistory { provider_id, model }, history).map_err(ApiError::BadRequest)
                }
                _ => Err(ApiError::BadRequest("未知 Agent，请选择 Claude 或 Codex".into())),
            }).await
        }
        "list_claude_assets" => result(crate::commands::claude_assets::list_claude_assets(argument(&args, "projectDir")?).await),
        "deploy_claude_asset" => result(crate::commands::claude_assets::deploy_claude_asset(argument(&args, "kind")?, argument(&args, "name")?, argument(&args, "scope")?, argument(&args, "projectDir")?).await),
        "undeploy_claude_asset" => result(crate::commands::claude_assets::undeploy_claude_asset(argument(&args, "kind")?, argument(&args, "name")?, argument(&args, "scope")?, argument(&args, "projectDir")?).await),
        "sync_claude_asset" => result(crate::commands::claude_assets::sync_claude_asset(argument(&args, "kind")?, argument(&args, "name")?, argument(&args, "direction")?, argument(&args, "scope")?, argument(&args, "projectDir")?).await),
        "import_claude_asset" => result(crate::commands::claude_assets::import_claude_asset(argument(&args, "kind")?, argument(&args, "scope")?, argument(&args, "projectDir")?, argument(&args, "name")?).await),
        "list_importable_claude_assets" => result(crate::commands::claude_assets::list_importable_claude_assets(argument(&args, "scope")?, argument(&args, "projectDir")?).await),
        "delete_claude_asset" => result(crate::commands::claude_assets::delete_claude_asset(argument(&args, "kind")?, argument(&args, "name")?).await),
        "create_claude_asset" => result(crate::commands::claude_assets::create_claude_asset(argument(&args, "kind")?, argument(&args, "name")?, argument(&args, "description")?).await),
        "read_claude_asset" => result(crate::commands::claude_assets::read_claude_asset(argument(&args, "kind")?, argument(&args, "name")?).await),
        "write_claude_asset" => result(crate::commands::claude_assets::write_claude_asset(argument(&args, "kind")?, argument(&args, "name")?, argument(&args, "content")?).await),
        "list_claude_projects" => result(crate::commands::claude_config::list_claude_projects().await),
        "list_claude_memory_files" => result(crate::commands::claude_config::list_claude_memory_files(argument(&args, "projectDir")?).await),
        "read_claude_memory_file" => result(crate::commands::claude_config::read_claude_memory_file(argument(&args, "projectDir")?, argument(&args, "name")?).await),
        "write_claude_memory_file" => result(crate::commands::claude_config::write_claude_memory_file(argument(&args, "projectDir")?, argument(&args, "name")?, argument(&args, "content")?).await),
        "create_claude_memory_file" => result(crate::commands::claude_config::create_claude_memory_file(argument(&args, "projectDir")?, argument(&args, "name")?, argument(&args, "memoryType")?, argument(&args, "description")?).await),
        "delete_claude_memory_file" => result(crate::commands::claude_config::delete_claude_memory_file(argument(&args, "projectDir")?, argument(&args, "name")?).await),
        "read_claude_md" => result(crate::commands::claude_config::read_claude_md(argument(&args, "kind")?, argument(&args, "projectDir")?).await),
        "write_claude_md" => result(crate::commands::claude_config::write_claude_md(argument(&args, "kind")?, argument(&args, "projectDir")?, argument(&args, "content")?).await),
        "read_claude_settings" => result(crate::commands::claude_config::read_claude_settings().await),
        "write_claude_settings" => result(crate::commands::claude_config::write_claude_settings(argument(&args, "content")?).await),
        "list_claude_settings_backups" => result(crate::commands::claude_config::list_claude_settings_backups().await),
        "restore_claude_settings_backup" => result(crate::commands::claude_config::restore_claude_settings_backup(argument(&args, "id")?).await),
        "list_llm_providers" => result(crate::commands::llm_provider::list_llm_providers().await),
        "save_llm_provider" => result(crate::commands::llm_provider::save_llm_provider(argument(&args, "input")?).await),
        "delete_llm_provider" => result(crate::commands::llm_provider::delete_llm_provider(argument(&args, "id")?).await),
        "set_default_llm_provider" => result(crate::commands::llm_provider::set_default_llm_provider(argument(&args, "id")?).await),
        "update_llm_provider_order" => result(crate::commands::llm_provider::update_llm_provider_order(argument(&args, "ids")?).await),
        "fetch_llm_provider_models" => result(crate::commands::llm_provider::fetch_llm_provider_models(argument(&args, "baseUrl")?, argument(&args, "apiKey")?, argument(&args, "modelsUrl")?, argument(&args, "providerId")?).await),
        "list_claude_launch_targets" => result(crate::commands::llm_provider::list_claude_launch_targets().await),
        "get_codex_provider_state" => result(crate::commands::codex_provider::get_codex_provider_state().await),
        "save_codex_provider" => result(crate::commands::codex_provider::save_codex_provider(argument(&args, "input")?, argument(&args, "activate")?).await),
        "activate_codex_provider" => result(crate::commands::codex_provider::activate_codex_provider(argument(&args, "id")?).await),
        "clear_default_codex_provider" => result(crate::commands::codex_provider::clear_default_codex_provider().await),
        "delete_codex_provider" => result(crate::commands::codex_provider::delete_codex_provider(argument(&args, "id")?).await),
        "import_codex_provider" => result(crate::commands::codex_provider::import_codex_provider().await),
        "fetch_codex_provider_models" => result(crate::commands::codex_provider::fetch_codex_provider_models(argument(&args, "baseUrl")?, argument(&args, "apiKey")?, argument(&args, "providerId")?).await),
        "get_antigravity_account_state" => result(crate::commands::antigravity_account::get_antigravity_account_state().await),
        "save_antigravity_account_token" => result(crate::commands::antigravity_account::save_antigravity_account_token(argument(&args, "input")?).await),
        "import_local_antigravity_account" => result(crate::commands::antigravity_account::import_local_antigravity_account().await),
        "set_default_antigravity_account" => result(crate::commands::antigravity_account::set_default_antigravity_account(argument(&args, "id")?).await),
        "rename_antigravity_account" => result(crate::commands::antigravity_account::rename_antigravity_account(argument(&args, "id")?, argument(&args, "alias")?).await),
        "delete_antigravity_account" => result(crate::commands::antigravity_account::delete_antigravity_account(argument(&args, "id")?).await),
        "start_antigravity_oauth_login" => result(crate::commands::antigravity_account::start_antigravity_oauth_login().await),
        "complete_antigravity_oauth_login" => result(crate::commands::antigravity_account::complete_antigravity_oauth_login(argument(&args, "input")?).await),
        "cancel_antigravity_oauth_login" => result(crate::commands::antigravity_account::cancel_antigravity_oauth_login(argument(&args, "loginId")?).await),
        "claude_history_rescan" => result(crate::commands::claude_history::claude_history_rescan(app.clone()).await),
        "claude_history_list" => result(crate::commands::claude_history::claude_history_list(argument(&args, "includeArchived")?, argument(&args, "projectDir")?).await),
        "claude_history_search" => result(crate::commands::claude_history::claude_history_search(argument(&args, "query")?, argument(&args, "projectDir")?).await),
        "claude_history_get_replay" => result(crate::commands::claude_history::claude_history_get_replay(argument(&args, "sessionId")?, argument(&args, "offset")?, argument(&args, "limit")?).await),
        "claude_history_rename" => result(crate::commands::claude_history::claude_history_rename(argument(&args, "sessionId")?, argument(&args, "title")?).await),
        "claude_history_set_flags" => result(crate::commands::claude_history::claude_history_set_flags(argument(&args, "sessionId")?, argument(&args, "starred")?, argument(&args, "archived")?).await),
        "claude_history_delete" => result(crate::commands::claude_history::claude_history_delete(argument(&args, "sessionId")?).await),
        "claude_history_delete_many" => result(crate::commands::claude_history::claude_history_delete_many(argument(&args, "sessionIds")?).await),
        "claude_history_export" => result(crate::commands::claude_history::claude_history_export(argument(&args, "sessionId")?, argument(&args, "format")?, argument(&args, "destPath")?).await),
        "codex_history_rescan" => result(crate::commands::codex_history::codex_history_rescan(app.clone()).await),
        "codex_history_list" => result(crate::commands::codex_history::codex_history_list(argument(&args, "includeArchived")?, argument(&args, "projectDir")?).await),
        "codex_history_search" => result(crate::commands::codex_history::codex_history_search(argument(&args, "query")?, argument(&args, "projectDir")?).await),
        "codex_history_get_replay" => result(crate::commands::codex_history::codex_history_get_replay(argument(&args, "sessionId")?, argument(&args, "offset")?, argument(&args, "limit")?).await),
        "codex_history_rename" => result(crate::commands::codex_history::codex_history_rename(argument(&args, "sessionId")?, argument(&args, "title")?).await),
        "codex_history_set_flags" => result(crate::commands::codex_history::codex_history_set_flags(argument(&args, "sessionId")?, argument(&args, "starred")?, argument(&args, "archived")?).await),
        "codex_history_delete" => result(crate::commands::codex_history::codex_history_delete(argument(&args, "sessionId")?).await),
        "codex_history_delete_many" => result(crate::commands::codex_history::codex_history_delete_many(argument(&args, "sessionIds")?).await),
        "codex_history_export" => result(crate::commands::codex_history::codex_history_export(argument(&args, "sessionId")?, argument(&args, "format")?, argument(&args, "destPath")?).await),
        "antigravity_history_rescan" => result(crate::commands::antigravity_history::antigravity_history_rescan(app.clone()).await),
        "antigravity_history_list" => result(crate::commands::antigravity_history::antigravity_history_list(argument(&args, "includeArchived")?, argument(&args, "projectDir")?).await),
        "antigravity_history_search" => result(crate::commands::antigravity_history::antigravity_history_search(argument(&args, "query")?, argument(&args, "projectDir")?).await),
        "antigravity_history_get_replay" => result(crate::commands::antigravity_history::antigravity_history_get_replay(argument(&args, "sessionId")?, argument(&args, "offset")?, argument(&args, "limit")?).await),
        "antigravity_history_rename" => result(crate::commands::antigravity_history::antigravity_history_rename(argument(&args, "sessionId")?, argument(&args, "title")?).await),
        "antigravity_history_set_flags" => result(crate::commands::antigravity_history::antigravity_history_set_flags(argument(&args, "sessionId")?, argument(&args, "starred")?, argument(&args, "archived")?).await),
        "antigravity_history_delete" => result(crate::commands::antigravity_history::antigravity_history_delete(argument(&args, "sessionId")?).await),
        "antigravity_history_delete_many" => result(crate::commands::antigravity_history::antigravity_history_delete_many(argument(&args, "sessionIds")?).await),
        "antigravity_history_export" => result(crate::commands::antigravity_history::antigravity_history_export(argument(&args, "sessionId")?, argument(&args, "format")?, argument(&args, "destPath")?).await),
        "list_claude_mcp_servers" => result(crate::commands::claude_mcp::list_claude_mcp_servers(argument(&args, "scope")?, argument(&args, "projectDir")?).await),
        "save_claude_mcp_server" => result(crate::commands::claude_mcp::save_claude_mcp_server(argument(&args, "scope")?, argument(&args, "projectDir")?, argument(&args, "name")?, argument(&args, "config")?).await),
        "delete_claude_mcp_server" => result(crate::commands::claude_mcp::delete_claude_mcp_server(argument(&args, "scope")?, argument(&args, "projectDir")?, argument(&args, "name")?).await),
        "get_claude_mcp_config_path" => result(crate::commands::claude_mcp::get_claude_mcp_config_path(argument(&args, "scope")?, argument(&args, "projectDir")?).await),
        "probe_claude_mcp" => result(crate::commands::claude_mcp::probe_claude_mcp(argument(&args, "timeoutSecs")?).await),
        "get_terminal_task_summaries" => result(crate::commands::claude_session::get_terminal_task_summaries(argument(&args, "terminalIds")?, app.state::<crate::commands::TerminalService>()).await),
        "save_show_task_summary" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_show_task_summary(argument(&args, "enabled")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_agent_commands" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_agent_commands(argument(&args, "claude")?, argument(&args, "codex")?, argument(&args, "antigravity")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_agent_download_source" => result(crate::commands::agent_cli::save_agent_download_source(argument(&args, "source")?).await),
        "get_claude_sessions_for_terminals" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::claude_session::get_claude_sessions_for_terminals(argument(&args, "terminalIds")?, app.state::<crate::commands::TerminalService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_agent_sessions_for_terminals" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::claude_session::get_agent_sessions_for_terminals(argument(&args, "terminalIds")?, app.state::<crate::commands::TerminalService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "terminal_agent_usage" => {
            let terminal_id: String = argument(&args, "terminalId")?;
            run(move || crate::services::agent_usage_service::usage(&terminal_id)).await
        }
        "claim_web_session_restore" => data(crate::commands::session_restore::claim_web_session_restore()),
        "release_web_session_restore" => data(crate::commands::session_restore::release_web_session_restore()),
        "read_client_data" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::client_data::read_client_data(argument(&args, "key")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "write_client_data" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::client_data::write_client_data(argument(&args, "key")?, argument(&args, "content")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "list_directory" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::fs::list_directory(argument(&args, "path")?, argument(&args, "exclusions")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "delete_path" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::fs::delete_path(argument(&args, "path")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "rename_path" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::fs::rename_path(argument(&args, "path")?, argument(&args, "newName")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "read_file_content" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::fs::read_file_content(argument(&args, "path")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "write_file_content" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::fs::write_file_content(argument(&args, "path")?, argument(&args, "content")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_file_size" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::fs::get_file_size(argument(&args, "path")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_file_meta" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::fs::get_file_meta(argument(&args, "path")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_git_repository_status" => result(crate::commands::git::get_git_repository_status(argument(&args, "path")?).await),
        "git_list_branches" => result(crate::commands::git::git_list_branches(argument(&args, "path")?).await),
        "git_checkout_branch" => result(crate::commands::git::git_checkout_branch(argument(&args, "path")?, argument(&args, "branch")?).await),
        "git_pull" => result(crate::commands::git::git_pull(argument(&args, "path")?).await),
        "git_preview_push" => result(crate::commands::git::git_preview_push(argument(&args, "options")?).await),
        "git_push_with_options" => result(crate::commands::git::git_push_with_options(app.clone(), argument(&args, "options")?).await),
        "git_get_changed_files" => result(crate::commands::git::git_get_changed_files(argument(&args, "path")?).await),
        "git_get_history_files" => result(crate::commands::git::git_get_history_files(argument(&args, "path")?, argument(&args, "fromRevision")?, argument(&args, "toRevision")?).await),
        "git_get_history_file_diff" => result(crate::commands::git::git_get_history_file_diff(argument(&args, "path")?, argument(&args, "fromRevision")?, argument(&args, "toRevision")?, argument(&args, "filePath")?, argument(&args, "oldPath")?, argument(&args, "statusCode")?, argument(&args, "binary")?).await),
        "git_get_worktree_file_diff" => result(crate::commands::git::git_get_worktree_file_diff(argument(&args, "path")?, argument(&args, "filePath")?, argument(&args, "oldPath")?).await),
        "git_commit_paths" => result(crate::commands::git::git_commit_paths(argument(&args, "path")?, argument(&args, "message")?, argument(&args, "paths")?).await),
        "git_get_history" => result(crate::commands::git::git_get_history(argument(&args, "path")?, argument(&args, "limit")?, argument(&args, "skip")?).await),
        "get_all_profiles" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::profile::get_all_profiles())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_profile" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::profile::get_profile(argument(&args, "id")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "create_profile" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::profile::create_profile(argument(&args, "name")?, argument(&args, "group")?, argument(&args, "terminalType")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "update_profile" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::profile::update_profile(argument(&args, "profile")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "delete_profile" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::profile::delete_profile(argument(&args, "id")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "update_profile_last_used" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::profile::update_profile_last_used(argument(&args, "id")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_projects" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::profile::get_projects())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_projects" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::profile::save_projects(argument(&args, "projects")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "connect_ssh_session" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::connect_ssh_session(argument(&args, "terminalId")?, argument(&args, "profileId")?, app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_list_dir" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_list_dir(argument(&args, "terminalId")?, argument(&args, "path")?, app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_create_dir" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_create_dir(argument(&args, "terminalId")?, argument(&args, "path")?, app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_create_file" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_create_file(argument(&args, "terminalId")?, argument(&args, "path")?, app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_remove" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_remove(argument(&args, "terminalId")?, argument(&args, "path")?, argument(&args, "isDir")?, app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_rename" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_rename(argument(&args, "terminalId")?, argument(&args, "from")?, argument(&args, "to")?, app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_move" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_move(argument(&args, "terminalId")?, argument(&args, "from")?, argument(&args, "to")?, app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_copy" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_copy(argument(&args, "terminalId")?, argument(&args, "from")?, argument(&args, "to")?, app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_chmod" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_chmod(argument(&args, "terminalId")?, argument(&args, "path")?, argument(&args, "mode")?, app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_download" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_download(argument(&args, "terminalId")?, argument(&args, "remotePath")?, argument(&args, "localPath")?, argument(&args, "transferId")?, argument(&args, "profileId")?, app.clone(), app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_download_dir" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_download_dir(argument(&args, "terminalId")?, argument(&args, "remotePath")?, argument(&args, "localPath")?, argument(&args, "transferId")?, argument(&args, "profileId")?, app.clone(), app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "remote_upload" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::remote_upload(argument(&args, "terminalId")?, argument(&args, "localPath")?, argument(&args, "remotePath")?, argument(&args, "transferId")?, argument(&args, "profileId")?, app.clone(), app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_ssh_home_dir" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::get_ssh_home_dir(argument(&args, "terminalId")?, app.state::<crate::services::SshSessionService>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_ssh_temp_directory" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::get_ssh_temp_directory())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "ensure_dir" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::remote_file::ensure_dir(argument(&args, "path")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_server_stats" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::server_monitor::get_server_stats(argument(&args, "terminalId")?, app.state::<crate::services::SshSessionService>(), app.state::<crate::commands::MonitorCache>()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_system_resources" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::system_monitor::get_system_resources())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_app_settings" => crate::runtime::async_runtime::spawn_blocking(move || data(crate::commands::settings::get_app_settings())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_close_behavior" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_close_behavior(argument(&args, "behavior")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_launch_window_mode" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_launch_window_mode(argument(&args, "mode")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_vscode_terminal_support" => crate::runtime::async_runtime::spawn_blocking(move || data(crate::commands::settings::get_vscode_terminal_support(app.clone()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_terminal_loading_mode" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_terminal_loading_mode(argument(&args, "mode")?, app.clone()))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_data_path" => crate::runtime::async_runtime::spawn_blocking(move || data(crate::commands::settings::get_data_path())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_data_path_status" => crate::runtime::async_runtime::spawn_blocking(move || data(crate::commands::settings::get_data_path_status())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_enable_tab_navigation" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_enable_tab_navigation(argument(&args, "enabled")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_tab_sidebar_width" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_tab_sidebar_width(argument(&args, "width")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_config_nav_width" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_config_nav_width(argument(&args, "width")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_file_nav_width" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_file_nav_width(argument(&args, "width")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_single_instance" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_single_instance(argument(&args, "enabled")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_downloads_directory" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::get_downloads_directory())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_ssh_download_dir" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_ssh_download_dir(argument(&args, "dir")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_server_monitor_interval" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_server_monitor_interval(argument(&args, "interval")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_web_api_share_sessions" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_web_api_share_sessions(argument(&args, "enabled")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_native_chat_sessions" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_native_chat_sessions(argument(&args, "enabled")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_agent_auto_archive" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_agent_auto_archive(argument(&args, "enabled")?, argument(&args, "days")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_agent_idle_recycle" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_agent_idle_recycle(argument(&args, "enabled")?, argument(&args, "hours")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "run_agent_auto_archive" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::run_agent_auto_archive())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_web_api_status" => crate::runtime::async_runtime::spawn_blocking(move || data(crate::commands::settings::get_web_api_status())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "change_web_admin_password" => result(crate::commands::settings::change_web_admin_password(argument(&args, "oldPassword")?, argument(&args, "newPassword")?).await),
        "save_web_page_title" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::settings::save_web_page_title(argument(&args, "title")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_command_templates" => crate::runtime::async_runtime::spawn_blocking(move || data(crate::commands::templates::get_command_templates())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "save_command_templates" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::templates::save_command_templates(argument(&args, "content")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "init_command_templates" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::templates::init_command_templates(argument(&args, "defaultContent")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "check_app_update" => data(crate::commands::update::check_app_update().await),
        "get_all_workspaces" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::workspace::get_all_workspaces())).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_workspace" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::workspace::get_workspace(argument(&args, "id")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "create_workspace" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::workspace::create_workspace(argument(&args, "name")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "update_workspace" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::workspace::update_workspace(argument(&args, "workspace")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "delete_workspace" => crate::runtime::async_runtime::spawn_blocking(move || result(crate::commands::workspace::delete_workspace(argument(&args, "id")?))).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "fetch_ark_usage" => data(crate::commands::ai_usage::fetch_ark_usage(argument(&args, "cookie")?).await),
        "fetch_deepseek_usage" => data(crate::commands::ai_usage::fetch_deepseek_usage(argument(&args, "apiKey")?).await),
        "fetch_minimax_usage" => data(crate::commands::ai_usage::fetch_minimax_usage(argument(&args, "apiKey")?).await),
        "fetch_qianfan_usage" => data(crate::commands::ai_usage::fetch_qianfan_usage(argument(&args, "cookie")?).await),
        "answer_claude_hook_decision" => crate::runtime::async_runtime::spawn_blocking({ let app = app.clone(); move || result(crate::web::handlers::claude_hook_handler::answer_decision_for_web(&app, &argument::<String>(&args, "decisionId")?, argument(&args, "answers")?)) }).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "continue_claude_hook_in_terminal" => crate::runtime::async_runtime::spawn_blocking({ let app = app.clone(); move || result(crate::web::handlers::claude_hook_handler::continue_decision_for_web(&app, &argument::<String>(&args, "decisionId")?)) }).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        "get_pending_claude_hook_decisions" => crate::runtime::async_runtime::spawn_blocking({ let app = app.clone(); move || data(crate::web::handlers::claude_hook_handler::pending_decisions_for_web(&app)) }).await.map_err(|e| ApiError::Internal(e.to_string()))?,
        // 终端 Agent 会话接力：浏览器以 Web 身份调用共享 use case（与桌面 Pc 入口
        // 分离，权限随身份判定）。禁止把 Pc 命令函数原样暴露给浏览器。
        "terminal_agent_list" => data(crate::services::terminal_agent_relay::sessions_for(&app, crate::models::TerminalActor::Web).await),
        "terminal_agent_messages" => {
            let request: crate::commands::terminal_agent::AgentMessagesArgs = serde_json::from_value(args.clone()).map_err(|e| ApiError::BadRequest(e.to_string()))?;
            crate::services::terminal_agent_relay::page_for(&app, crate::models::TerminalActor::Web, &request.terminal_id, request.after_seq, request.revision, request.limit)
                .await
                .map_err(ApiError::from)
                .and_then(data)
        }
        "terminal_agent_reply" => {
            let request: crate::commands::terminal_agent::AgentReplyArgs = serde_json::from_value(args.clone()).map_err(|e| ApiError::BadRequest(e.to_string()))?;
            crate::services::terminal_agent_relay::reply(&app, crate::models::TerminalActor::Web, &request.terminal_id, &request.text, &request.request_id)
                .await
                .map_err(ApiError::from)
                .and_then(data)
        }
        "terminal_agent_subscribe" => {
            let terminal_id: String = argument(&args, "terminalId")?;
            let (outcome, _receiver) = crate::services::terminal_agent_relay::subscribe(&app, crate::models::TerminalActor::Web, &terminal_id, false)
                .await
                .map_err(ApiError::from)?;
            data(outcome)
        }
        "terminal_agent_unsubscribe" => {
            let request: crate::commands::terminal_agent::AgentUnsubscribeArgs = serde_json::from_value(args.clone()).map_err(|e| ApiError::BadRequest(e.to_string()))?;
            crate::services::terminal_agent_relay::unsubscribe(&request.terminal_id, &request.subscription_id);
            Ok(Value::Null)
        }
        "terminal_agent_heartbeat" => {
            let request: crate::commands::terminal_agent::AgentHeartbeatArgs = serde_json::from_value(args.clone()).map_err(|e| ApiError::BadRequest(e.to_string()))?;
            data(crate::services::terminal_agent_relay::HeartbeatOutcome {
                alive: crate::services::terminal_agent_relay::heartbeat(crate::models::TerminalActor::Web, &request.subscriptions),
            })
        }
        _ => Err(ApiError::BadRequest(format!("网页端暂不支持此操作：{}", command))),
    }
}
