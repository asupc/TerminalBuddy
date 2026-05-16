use std::fs;
use serde::Serialize;
use tauri::command;

fn should_exclude(name: &str, patterns: Option<&Vec<String>>) -> bool {
    if let Some(pats) = patterns {
        for pattern in pats {
            if pattern.starts_with("**/*.") {
                // **/*.ext -> match files ending with .ext
                let suffix = &pattern[3..]; // "*.ext"
                if name.ends_with(&suffix[1..]) { // ".ext"
                    return true;
                }
            } else if pattern.starts_with('*') {
                // *.ext -> match files ending with .ext
                let suffix = &pattern[1..]; // ".ext"
                if name.ends_with(suffix) {
                    return true;
                }
            } else {
                // Exact name match
                if name == pattern {
                    return true;
                }
            }
        }
    }
    false
}

#[derive(Serialize)]
pub struct FileNode {
    name: String,
    path: String,
    is_directory: bool,
}

#[command]
pub fn list_directory(path: String, exclusions: Option<Vec<String>>) -> Result<Vec<FileNode>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut nodes: Vec<FileNode> = entries
        .filter_map(|entry| {
            entry.ok().map(|e| {
                let file_path = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if should_exclude(&name, exclusions.as_ref()) {
                    return None;
                }
                Some(FileNode {
                    name,
                    path: file_path.to_string_lossy().to_string(),
                    is_directory: file_path.is_dir(),
                })
            })
        })
        .flatten()
        .collect();

    // Sort: directories first, then files, both alphabetically
    nodes.sort_by(|a, b| {
        match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(nodes)
}

#[command]
pub fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| format!("Failed to open: {}", e))?;
    Ok(())
}

#[command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    if fs::metadata(&path).map_or(false, |m| m.is_dir()) {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    } else {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    Ok(())
}

#[command]
pub fn delete_path(path: String) -> Result<(), String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to access: {}", e))?;
    if meta.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete directory: {}", e))?;
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))?;
    }
    Ok(())
}

#[command]
pub fn rename_path(path: String, new_name: String) -> Result<(), String> {
    let parent = std::path::Path::new(&path)
        .parent()
        .ok_or("Invalid path")?;
    let new_path = parent.join(&new_name);
    fs::rename(&path, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(())
}