use std::path::PathBuf;
use clipboard_win::raw;

#[tauri::command]
pub fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    raw::open().map_err(|e| format!("Failed to open clipboard: {}", e))?;
    let result = (|| -> Result<Vec<String>, String> {
        let mut paths: Vec<PathBuf> = Vec::new();
        raw::get_file_list_path(&mut paths)
            .map_err(|e| format!("Failed to read clipboard file list: {}", e))?;
        Ok(paths.iter().filter_map(|p| p.to_str().map(String::from)).collect())
    })();
    let _ = raw::close();
    result
}
