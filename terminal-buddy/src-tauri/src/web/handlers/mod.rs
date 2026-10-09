pub mod auth_handler;
pub mod bot_handler;
pub mod claude_history_handler;
pub mod claude_hook_handler;
pub mod fs_handler;
pub mod git_handler;
pub mod history_handler;
pub mod preset_handler;
pub mod profile_handler;
pub mod terminal_handler;

use crate::web::error::ApiError;

/// Web 端文件树 / Git 的访问白名单：只允许已登记项目目录（含子目录）。
/// 终端本身就有 shell 能力，但文件浏览接口仍收窄到项目范围，避免全盘暴露。
/// 返回规范化 key（小写、正斜杠、去尾分隔符），供按仓库互斥等场景使用。
pub(crate) fn ensure_project_scope(path: &str) -> Result<String, ApiError> {
    let key = normalize_scope_key(path);
    if key.is_empty() {
        return Err(ApiError::Forbidden("路径不能为空".to_string()));
    }
    let projects = crate::commands::profile::get_projects()
        .map_err(ApiError::Internal)?;
    let allowed = projects.iter().any(|project| {
        let base = normalize_scope_key(&project.path);
        !base.is_empty() && (key == base || key.starts_with(&format!("{}/", base)))
    });
    if allowed {
        Ok(key)
    } else {
        Err(ApiError::Forbidden(
            "该路径不在已登记的项目目录内，请先在桌面端登记项目".to_string(),
        ))
    }
}

fn normalize_scope_key(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}
