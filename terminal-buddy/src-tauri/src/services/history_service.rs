use crate::services::PathService;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const MAX_HISTORY: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub command: String,
    #[serde(default)]
    pub note: String,
}

impl HistoryEntry {
    pub fn new(command: &str) -> Self {
        Self {
            command: command.trim().to_string(),
            note: String::new(),
        }
    }
}

pub struct HistoryService;

impl HistoryService {
    fn get_history_path() -> PathBuf {
        let dir = PathService::get_data_dir();
        fs::create_dir_all(&dir).ok();
        dir.join("command_history.json")
    }

    pub fn get_history() -> Vec<HistoryEntry> {
        let path = Self::get_history_path();
        match fs::read_to_string(&path) {
            Ok(content) => {
                // Try parsing as Vec<HistoryEntry> first
                if let Ok(entries) = serde_json::from_str::<Vec<HistoryEntry>>(&content) {
                    return entries;
                }
                // Backward compatibility: parse as Vec<String> and auto-migrate
                if let Ok(strings) = serde_json::from_str::<Vec<String>>(&content) {
                    let entries: Vec<HistoryEntry> = strings.into_iter().map(|s| HistoryEntry::new(&s)).collect();
                    // Auto-migrate to new format
                    let _ = Self::save_history(&entries);
                    return entries;
                }
                Vec::new()
            }
            Err(_) => Vec::new(),
        }
    }

    fn save_history(history: &[HistoryEntry]) -> Result<(), String> {
        let path = Self::get_history_path();
        let content = serde_json::to_string_pretty(history)
            .map_err(|e| format!("序列化失败: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("写入失败: {}", e))
    }

    pub fn add_command(command: &str) -> Result<(), String> {
        let trimmed = command.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let mut history = Self::get_history();
        history.retain(|e| e.command != trimmed);
        history.insert(0, HistoryEntry::new(trimmed));
        history.truncate(MAX_HISTORY);
        Self::save_history(&history)
    }

    pub fn delete_command(command: &str) -> Result<(), String> {
        let mut history = Self::get_history();
        let before = history.len();
        history.retain(|e| e.command != command);
        if history.len() == before {
            return Err("命令未找到".to_string());
        }
        Self::save_history(&history)
    }

    pub fn update_command(old_command: &str, new_command: &str) -> Result<(), String> {
        let trimmed = new_command.trim();
        if trimmed.is_empty() {
            return Err("新命令不能为空".to_string());
        }
        let mut history = Self::get_history();
        if let Some(pos) = history.iter().position(|e| e.command == old_command) {
            history[pos].command = trimmed.to_string();
            Self::save_history(&history)
        } else {
            Err("命令未找到".to_string())
        }
    }

    pub fn update_command_note(command: &str, note: &str) -> Result<(), String> {
        let mut history = Self::get_history();
        if let Some(pos) = history.iter().position(|e| e.command == command) {
            history[pos].note = note.to_string();
            Self::save_history(&history)
        } else {
            Err("命令未找到".to_string())
        }
    }

    pub fn clear_history() -> Result<(), String> {
        Self::save_history(&[])
    }

    pub fn import_commands(commands: Vec<String>) -> Result<(), String> {
        let mut history = Self::get_history();
        for cmd in commands {
            let trimmed = cmd.trim().to_string();
            if !trimmed.is_empty() && !history.iter().any(|e| e.command == trimmed) {
                history.push(HistoryEntry::new(&trimmed));
            }
        }
        history.truncate(MAX_HISTORY);
        Self::save_history(&history)
    }
}
