use tauri::command;
use crate::services::{HistoryService, HistoryEntry};

#[command]
pub fn get_command_history() -> Vec<HistoryEntry> {
    HistoryService::get_history()
}

#[command]
pub fn add_command_to_history(command: String) -> Result<(), String> {
    HistoryService::add_command(&command)
}

#[command]
pub fn delete_command_from_history(command: String) -> Result<(), String> {
    HistoryService::delete_command(&command)
}

#[command]
pub fn update_command_in_history(old_command: String, new_command: String) -> Result<(), String> {
    HistoryService::update_command(&old_command, &new_command)
}

#[command]
pub fn update_command_note(command: String, note: String) -> Result<(), String> {
    HistoryService::update_command_note(&command, &note)
}

#[command]
pub fn clear_command_history() -> Result<(), String> {
    HistoryService::clear_history()
}

#[command]
pub fn import_command_history(commands: Vec<String>) -> Result<(), String> {
    HistoryService::import_commands(commands)
}
