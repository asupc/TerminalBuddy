pub mod app_notification_handler;
pub mod auth_handler;
pub mod claude_history_handler;
pub mod claude_hook_handler;
pub mod claude_settings_handler;
pub mod fs_handler;
pub mod git_handler;
pub mod history_handler;
pub mod llm_provider_handler;
pub mod profile_handler;
pub mod terminal_handler;
pub mod terminal_agent_handler;
pub mod desktop_handler;
pub mod container_environment;
pub mod claude_provider_handler;

use crate::web::error::ApiError;

pub fn is_docker_runtime() -> bool {
    !cfg!(feature = "desktop")
        && cfg!(target_os = "linux")
        && (std::env::var("TERMINAL_BUDDY_DEPLOYMENT").as_deref() == Ok("docker")
            || std::path::Path::new("/.dockerenv").is_file())
}

/// Web 端文件内容 / Git 的访问白名单：只允许已登记项目目录（含子目录）。
/// 只读目录浏览（list_directory / 文件管理器）不受此限制；其余文件操作仍收窄到
/// 项目范围，避免任意读取内容或写入文件。
/// 返回实际路径的规范化 key（Windows 忽略大小写，Linux 保留大小写），供仓库互斥使用。
pub(crate) fn ensure_project_scope(path: &str) -> Result<String, ApiError> {
    let key = canonical_scope_key(path)?;
    if key.is_empty() {
        return Err(ApiError::Forbidden("路径不能为空".to_string()));
    }
    let projects = crate::commands::profile::get_projects()
        .map_err(ApiError::Internal)?;
    let allowed = projects.iter().any(|project| {
        let base = canonical_scope_key(&project.path).unwrap_or_default();
        !base.is_empty() && (key == base || key.starts_with(&format!("{}/", base)))
    });
    if allowed {
        Ok(key)
    } else {
        Err(ApiError::Forbidden(
            "该路径不在已登记的项目目录内，请先在项目管理中登记目录".to_string(),
        ))
    }
}

fn normalize_scope_key(path: &str) -> String {
    let normalized = path.trim()
        .replace('\\', "/")
        .trim_end_matches('/').to_string();
    if cfg!(windows) { normalized.to_lowercase() } else { normalized }
}

fn canonical_scope_key(path: &str) -> Result<String, ApiError> {
    let mut candidate = std::path::PathBuf::from(path.trim());
    if !candidate.is_absolute() { return Err(ApiError::Forbidden("必须使用服务器绝对路径".to_string())); }
    let mut missing = Vec::new();
    while !candidate.exists() {
        let name = candidate.file_name().ok_or_else(|| ApiError::Forbidden("目录不可访问".to_string()))?.to_os_string();
        missing.push(name);
        if !candidate.pop() { return Err(ApiError::Forbidden("目录不可访问".to_string())); }
    }
    let mut real = candidate.canonicalize().map_err(|e| ApiError::BadRequest(e.to_string()))?;
    for name in missing.into_iter().rev() { real.push(name); }
    Ok(normalize_scope_key(&real.to_string_lossy()))
}

pub mod ai_chat_handler;
