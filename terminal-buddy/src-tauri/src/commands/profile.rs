use crate::models::Profile;
use crate::services::ProfileService;
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
pub fn create_profile(name: String, group: String, terminal_type: String) -> Result<Profile, String> {
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
