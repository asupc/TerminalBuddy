use serde::Serialize;
use std::fs;
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
                if name.ends_with(&suffix[1..]) {
                    // ".ext"
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
pub fn list_directory(
    path: String,
    exclusions: Option<Vec<String>>,
) -> Result<Vec<FileNode>, String> {
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
        } else {
            // 路径不存在时逐级向上查找最近的存在的父目录，
            // 避免传入不存在的路径让 Explorer 打开到无关的默认位置（如文档目录）。
            let mut current = std::path::Path::new(&path).parent();
            let mut found = None;
            while let Some(candidate) = current {
                if candidate.as_os_str().is_empty() {
                    break;
                }
                if fs::metadata(candidate).map_or(false, |m| m.is_dir()) {
                    found = Some(candidate.to_string_lossy().into_owned());
                    break;
                }
                current = candidate.parent();
            }
            match found {
                Some(dir) => dir,
                None => return Err(format!("Path not found: {}", path)),
            }
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
        return Err(format!(
            "Failed to open explorer (code {}): {}",
            result as isize, params
        ));
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

/// Windows 保留设备名：即使带扩展名也会被系统当成设备解析，不能用作文件名。
const WINDOWS_RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 校验重命名目标：只接受同目录下的单个文件名。
///
/// `rename_path` 不承担移动文件的职责，因此任何路径分隔符、父目录组件、
/// 盘符 / UNC 前缀都必须被拒绝；如果将来需要移动，应新增独立 command 并单独
/// 设计权限与覆盖策略。纯函数，便于单元测试。
fn validate_new_file_name(new_name: &str) -> Result<&str, String> {
    if new_name.is_empty() {
        return Err("新名称不能为空。".to_string());
    }
    if new_name.contains('/') || new_name.contains('\\') {
        return Err(
            "新名称不能包含路径分隔符 / 或 \\：重命名只修改当前条目的名称，不能移动到其他目录。"
                .to_string(),
        );
    }
    // 必须恰好解析出一个普通组件，从而排除绝对路径、盘符 / UNC 前缀、`.` 和 `..`。
    let mut components = std::path::Path::new(new_name).components();
    let name = match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(name)), None) => name
            .to_str()
            .ok_or_else(|| "新名称包含无法识别的字符。".to_string())?,
        _ => {
            return Err(
                "新名称必须是单个文件名，不能是绝对路径、盘符、UNC 路径、「.」或「..」。"
                    .to_string(),
            )
        }
    };
    if let Some(invalid) = name
        .chars()
        .find(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err(format!(
            "新名称不能包含字符 {:?}，请去掉后重试。",
            invalid
        ));
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err("Windows 不允许文件名以空格或点结尾，请去掉结尾的空格或点。".to_string());
    }
    let stem = name.split('.').next().unwrap_or(name);
    if WINDOWS_RESERVED_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        return Err(format!(
            "「{}」是 Windows 保留设备名，不能用作文件名，请换一个名称。",
            stem
        ));
    }
    Ok(name)
}

#[command]
pub fn rename_path(path: String, new_name: String) -> Result<(), String> {
    let source = std::path::Path::new(&path);
    let name = validate_new_file_name(&new_name)?;
    // 保持源路径的 parent 不变：目标只能落在同一目录下。
    let parent = source
        .parent()
        .ok_or("无法定位所在目录，请确认选中的是具体文件或文件夹。")?;
    let new_path = parent.join(name);
    // Windows 文件系统不区分大小写，仅改大小写属于合法重命名，不能被「已存在」挡下。
    let case_only_change = source
        .file_name()
        .is_some_and(|current| current.eq_ignore_ascii_case(name));
    if !case_only_change && new_path.exists() {
        return Err(format!("目标名称「{}」已存在，请换一个名称。", name));
    }
    fs::rename(source, &new_path).map_err(|e| format!("重命名失败：{}", e))?;
    Ok(())
}

const MAX_READ_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10MB

#[command]
pub fn read_file_content(path: String) -> Result<String, String> {
    let metadata =
        fs::metadata(&path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if metadata.len() > MAX_READ_FILE_SIZE {
        return Err(format!(
            "文件过大 ({}MB)，最大支持 10MB",
            metadata.len() / 1024 / 1024
        ));
    }
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[command]
pub fn write_file_content(path: String, content: String) -> Result<bool, String> {
    // 原子写：临时文件 + flush + sync + 替换。直接 fs::write 会在崩溃或磁盘满时
    // 把用户编辑的文件截断成半截内容。
    crate::services::atomic_write(std::path::Path::new(&path), content.as_bytes())
        .map_err(|e| format!("写入文件失败: {}", e))?;
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

#[cfg(test)]
mod tests {
    use super::validate_new_file_name;

    /// 普通中英文名称、多重扩展名、点开头的隐藏文件都应通过，并原样返回。
    #[test]
    fn accepts_plain_file_names() {
        for name in [
            "notes.txt",
            "项目说明.md",
            "archive.tar.gz",
            ".gitignore",
            "a",
            "带 空格 的名字.log",
        ] {
            assert_eq!(
                validate_new_file_name(name),
                Ok(name),
                "「{}」应当被接受",
                name
            );
        }
    }

    /// 任何形式的路径都必须被拒绝：rename 只改名，不移动。
    #[test]
    fn rejects_paths_and_traversal() {
        for name in [
            "../x",
            "..\\x",
            "C:\\x",
            "\\\\server\\share\\x",
            "a/b",
            "a\\b",
            "/x",
            "./x",
            "..",
            ".",
        ] {
            assert!(
                validate_new_file_name(name).is_err(),
                "「{}」应当被拒绝",
                name
            );
        }
    }

    #[test]
    fn rejects_empty_name() {
        assert!(validate_new_file_name("").is_err());
    }

    /// Windows 非法字符与控制字符；`a:b` 同时挡掉 NTFS 备用数据流写法。
    #[test]
    fn rejects_invalid_characters() {
        for name in [
            "a<b", "a>b", "a:b", "a\"b", "a|b", "a?b", "a*b", "a\tb", "a\nb", "a\0b",
        ] {
            assert!(
                validate_new_file_name(name).is_err(),
                "「{}」应当被拒绝",
                name.escape_debug()
            );
        }
    }

    /// Windows 会静默去掉结尾的空格和点，导致重命名结果与用户输入不一致。
    #[test]
    fn rejects_trailing_space_or_dot() {
        for name in ["notes.txt ", "notes.", "folder "] {
            assert!(
                validate_new_file_name(name).is_err(),
                "「{}」应当被拒绝",
                name
            );
        }
    }

    /// 保留设备名不区分大小写，且带扩展名时同样被系统当成设备。
    #[test]
    fn rejects_windows_reserved_device_names() {
        for name in ["CON", "con", "NUL.txt", "com1", "LPT9.log", "aux"] {
            assert!(
                validate_new_file_name(name).is_err(),
                "「{}」应当被拒绝",
                name
            );
        }
        // 仅前缀相同的名字不是保留名，必须放行。
        for name in ["console.txt", "com10", "nulls.md"] {
            assert_eq!(validate_new_file_name(name), Ok(name));
        }
    }

    /// 错误信息必须是可执行的中文提示，而不是英文调试串。
    #[test]
    fn errors_are_actionable_chinese_text() {
        let err = validate_new_file_name("../x").unwrap_err();
        assert!(err.contains("路径分隔符"), "实际错误：{}", err);
        let err = validate_new_file_name("CON").unwrap_err();
        assert!(err.contains("保留设备名"), "实际错误：{}", err);
        let err = validate_new_file_name("notes.").unwrap_err();
        assert!(err.contains("空格或点结尾"), "实际错误：{}", err);
    }
}
