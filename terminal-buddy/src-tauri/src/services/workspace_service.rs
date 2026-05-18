use crate::models::workspace::Workspace;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
}

pub struct WorkspaceService;

impl WorkspaceService {
    fn get_workspaces_dir() -> PathBuf {
        let base = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("TerminalBuddy")
            .join("Workspaces");
        fs::create_dir_all(&base).ok();
        base
    }

    pub fn get_all_workspaces() -> Result<Vec<Workspace>, String> {
        let dir = Self::get_workspaces_dir();
        let mut workspaces = Vec::new();

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map_or(false, |e| e == "json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(workspace) = serde_json::from_str::<Workspace>(&content) {
                            workspaces.push(workspace);
                        }
                    }
                }
            }
        }

        workspaces.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
        Ok(workspaces)
    }

    pub fn get_workspace(id: &str) -> Result<Workspace, String> {
        let workspaces = Self::get_all_workspaces()?;
        workspaces.into_iter()
            .find(|w| w.id == id)
            .ok_or_else(|| format!("Workspace not found: {}", id))
    }

    pub fn create_workspace(name: &str) -> Result<Workspace, String> {
        let workspace = Workspace {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            icon: None,
            groups: Vec::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            last_used_at: chrono::Utc::now().to_rfc3339(),
        };

        let path = Self::get_workspaces_dir().join(format!("{}.json", sanitize_filename(&workspace.name)));
        let content = serde_json::to_string_pretty(&workspace)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        Ok(workspace)
    }

    pub fn update_workspace(workspace: &Workspace) -> Result<(), String> {
        if let Ok(old) = Self::get_workspace(&workspace.id) {
            if old.name != workspace.name {
                let old_path = Self::get_workspaces_dir().join(format!("{}.json", sanitize_filename(&old.name)));
                fs::remove_file(&old_path).ok();
            }
        }

        let path = Self::get_workspaces_dir().join(format!("{}.json", sanitize_filename(&workspace.name)));
        let content = serde_json::to_string_pretty(workspace)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))
    }

    pub fn delete_workspace(id: &str) -> Result<(), String> {
        let workspace = Self::get_workspace(id)?;
        let path = Self::get_workspaces_dir().join(format!("{}.json", sanitize_filename(&workspace.name)));
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete workspace: {}", e))
    }
}
