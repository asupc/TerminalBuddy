use crate::services::ClientDataService;

#[tauri::command]
pub fn read_client_data(key: String) -> Result<Option<String>, String> {
    ClientDataService::read(&key)
}

#[tauri::command]
pub fn write_client_data(key: String, content: String) -> Result<(), String> {
    ClientDataService::write(&key, &content)
}
