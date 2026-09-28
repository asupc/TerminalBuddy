use crate::models::Profile;
use crate::services::{ProfileService, PathService};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::command;

#[command]
pub fn get_all_profiles() -> Result<Vec<Profile>, String> {
    ProfileService::get_all_profiles()
}

#[command]
pub fn get_profile(id: String) -> Result<Profile, String> {
    ProfileService::get_profile(&id)
}

#[command]
pub fn create_profile(
    name: String,
    group: String,
    terminal_type: String,
) -> Result<Profile, String> {
    ProfileService::create_profile(&name, &group, &terminal_type)
}

#[command]
pub fn update_profile(profile: Profile) -> Result<(), String> {
    ProfileService::update_profile(&profile)
}

#[command]
pub fn delete_profile(id: String) -> Result<(), String> {
    ProfileService::delete_profile(&id)
}

#[command]
pub fn update_profile_last_used(id: String) -> Result<(), String> {
    ProfileService::update_last_used(&id)
}

#[command]
pub fn export_all_profiles(path: String) -> Result<(), String> {
    ProfileService::export_all_profiles(&path)
}

#[command]
pub fn import_all_profiles(path: String) -> Result<Vec<Profile>, String> {
    ProfileService::import_profiles(&path)
}


#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub path: String,
}

fn projects_file() -> Result<std::path::PathBuf, String> {
    Ok(PathService::require_data_dir()?.join("projects.json"))
}

#[command]
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
                path: if Path::new(&profile.startup_path).is_absolute() {
                    profile.startup_path.clone()
                } else { String::new() },
            });
        }
    }
    Ok(projects)
}

#[command]
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
