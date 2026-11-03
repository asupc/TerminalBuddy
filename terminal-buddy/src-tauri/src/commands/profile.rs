use crate::models::Profile;
use crate::services::{ProfileService, PathService};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_all_profiles() -> Result<Vec<Profile>, String> {
    ProfileService::get_all_profiles()
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_profile(id: String) -> Result<Profile, String> {
    ProfileService::get_profile(&id)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn create_profile(
    name: String,
    group: String,
    terminal_type: String,
) -> Result<Profile, String> {
    ProfileService::create_profile(&name, &group, &terminal_type)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn update_profile(profile: Profile) -> Result<(), String> {
    ProfileService::update_profile(&profile)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn delete_profile(id: String) -> Result<(), String> {
    ProfileService::delete_profile(&id)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn update_profile_last_used(id: String) -> Result<(), String> {
    ProfileService::update_last_used(&id)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn export_all_profiles(path: String) -> Result<(), String> {
    ProfileService::export_all_profiles(&path)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn import_all_profiles(path: String) -> Result<Vec<Profile>, String> {
    ProfileService::import_profiles(&path)
}


#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub path: String,
    /// 旧版项目的启动命令：仅用于兼容读取旧 projects.json，保存时空值不落盘。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub startup_command: String,
    /// 项目右键菜单可启动的 Agent（Claude Code / Codex），默认全部启用。
    #[serde(default)]
    pub enabled_agents: EnabledAgents,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnabledAgents {
    #[serde(default = "default_true")]
    pub claude: bool,
    #[serde(default = "default_true")]
    pub codex: bool,
}

/// 与 serde 缺省保持一致：未配置的旧项目全部 Agent 都启用。
impl Default for EnabledAgents {
    fn default() -> Self {
        Self { claude: true, codex: true }
    }
}

fn projects_file() -> Result<std::path::PathBuf, String> {
    Ok(PathService::require_data_dir()?.join("projects.json"))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_projects() -> Result<Vec<Project>, String> {
    let file = PathService::get_data_dir().join("projects.json");
    let mut projects: Vec<Project> = if file.exists() {
        serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else { Vec::new() };
    // Existing installations only stored group names on profiles. Seed a project for
    // each group without mutating or discarding the existing profile data.
    for profile in ProfileService::get_all_profiles()? {
        let name = if profile.group.trim().is_empty() { "默认" } else { profile.group.trim() };
        if !projects.iter().any(|p| p.name == name) {
            projects.push(Project {
                name: name.to_string(),
                startup_command: String::new(),
                enabled_agents: EnabledAgents::default(),
                path: if Path::new(&profile.startup_path).is_absolute() {
                    profile.startup_path.clone()
                } else { String::new() },
            });
        }
    }
    Ok(projects)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_projects(projects: Vec<Project>) -> Result<(), String> {
    let mut names = std::collections::HashSet::new();
    for project in &projects {
        if project.name.trim().is_empty() || project.path.trim().is_empty()
            || !Path::new(project.path.trim()).is_absolute() {
            return Err("项目名称及绝对路径不能为空".into());
        }
        if !names.insert(project.name.trim().to_lowercase()) {
            return Err("项目名称不能重复".into());
        }
    }
    let file = projects_file()?;
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&projects).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(tmp, file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_project_json_keeps_all_agents_enabled_by_default() {
        // 旧版 projects.json 只有 name/path/startupCommand，读取后所有 Agent 默认启用。
        let legacy = r#"[{"name":"demo","path":"C:\\demo","startupCommand":"claude"}]"#;
        let projects: Vec<Project> = serde_json::from_str(legacy).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].startup_command, "claude");
        assert_eq!(projects[0].enabled_agents, EnabledAgents { claude: true, codex: true });

        // enabledAgents 部分字段缺失时，缺的字段按启用处理。
        let partial = r#"[{"name":"demo","path":"/demo","enabledAgents":{"claude":false}}]"#;
        let projects: Vec<Project> = serde_json::from_str(partial).unwrap();
        assert!(!projects[0].enabled_agents.claude);
        assert!(projects[0].enabled_agents.codex);
    }

    #[test]
    fn empty_startup_command_is_not_written_back() {
        let project = Project {
            name: "demo".into(),
            path: "/demo".into(),
            startup_command: String::new(),
            enabled_agents: EnabledAgents { claude: false, codex: true },
        };
        let json = serde_json::to_value(&project).unwrap();
        assert!(json.get("startupCommand").is_none());
        assert_eq!(json["enabledAgents"]["claude"], false);
        assert_eq!(json["enabledAgents"]["codex"], true);
        // round-trip 保持一致。
        let restored: Project = serde_json::from_value(json).unwrap();
        assert_eq!(restored.enabled_agents, project.enabled_agents);
    }
}
