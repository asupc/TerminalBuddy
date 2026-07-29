use std::fs;
use serde::Serialize;
use tauri::command;

#[derive(Serialize)]
pub struct FileMeta {
    last_modified: u64,
    size: u64,
}

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
    size: u64,
    last_modified: u64,
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
                let meta = e.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let last_modified = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Some(FileNode {
                    name,
                    path: file_path.to_string_lossy().to_string(),
                    // 复用界面所需的元数据，避免 Path::is_dir 再次查询文件系统。
                    is_directory: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                    size,
                    last_modified,
                })
            })
        })
        .flatten()
        .collect();

    // Sort: directories first, then files, both alphabetically
    nodes.sort_by_cached_key(|node| (!node.is_directory, node.name.to_lowercase()));

    Ok(nodes)
}

#[command]
pub fn open_path(path: String) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut std::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_cmd: i32,
        ) -> *mut std::ffi::c_void;
    }

    let operation: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let file: Vec<u16> = std::ffi::OsStr::new(&path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let directory: Vec<u16> = std::path::Path::new(&path)
        .parent()
        .map(|p| {
            std::ffi::OsStr::new(p)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        })
        .unwrap_or_default();

    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            ptr::null(),
            if directory.is_empty() {
                ptr::null()
            } else {
                directory.as_ptr()
            },
            1, // SW_SHOWNORMAL
        )
    };

    // ShellExecuteW returns a value > 32 on success
    if result as isize <= 32 {
        return Err(format!("Failed to open: {}", path));
    }

    Ok(())
}

#[command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    // Launch explorer.exe directly via ShellExecuteW. We deliberately do NOT use
    // std::process::Command here: Rust's Command applies CRT argument escaping,
    // which corrupts Windows paths (trailing backslashes, the "/select,\"...\""
    // form) and makes Explorer open the wrong folder. ShellExecuteW's lpParameters
    // is passed verbatim to the target program, so explorer.exe receives the path
    // exactly as built below.
    //
    // We always launch explorer.exe (rather than relying on the "explore" shell
    // verb) because that verb is not guaranteed to be registered on every system,
    // and a missing verb makes ShellExecuteW fail silently.
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut std::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_cmd: i32,
        ) -> *mut std::ffi::c_void;
    }

    let path = path.replace('/', "\\");

    // Build the parameter string explorer.exe expects:
    //   - directory          -> just the path
    //   - existing file      -> /select,"<path>"  (highlights the file in its folder)
    //   - missing path       -> the parent directory (best-effort)
    let params: String = {
        if fs::metadata(&path).map_or(false, |m| m.is_dir()) {
            path
        } else if fs::metadata(&path).is_ok() {
            format!("/select,\"{}\"", path)
        } else if let Some(parent) = std::path::Path::new(&path).parent() {
            parent.to_string_lossy().into_owned()
        } else {
            return Err(format!("Path not found: {}", path));
        }
    };

    let file_wide: Vec<u16> = std::ffi::OsStr::new("explorer.exe")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let params_wide: Vec<u16> = std::ffi::OsStr::new(&params)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            ptr::null(), // default verb ("open")
            file_wide.as_ptr(),
            params_wide.as_ptr(),
            ptr::null(),
            1, // SW_SHOWNORMAL
        )
    };

    // ShellExecuteW returns a value > 32 on success
    if result as isize <= 32 {
        return Err(format!("Failed to open explorer (code {}): {}",
            result as isize, params));
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

const MAX_READ_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10MB

#[command]
pub fn read_file_content(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if metadata.len() > MAX_READ_FILE_SIZE {
        return Err(format!("文件过大 ({}MB)，最大支持 10MB", metadata.len() / 1024 / 1024));
    }
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[command]
pub fn write_file_content(path: String, content: String) -> Result<bool, String> {
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(true)
}

#[command]
pub fn get_file_size(path: String) -> Result<u64, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to get file size: {}", e))?;
    Ok(meta.len())
}

#[command]
pub fn get_file_meta(path: String) -> Result<FileMeta, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to get file meta: {}", e))?;
    let last_modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileMeta {
        last_modified,
        size: meta.len(),
    })
}
