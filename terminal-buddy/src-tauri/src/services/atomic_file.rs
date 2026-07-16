use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn unique_temp_path(path: &Path) -> io::Result<PathBuf> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "目标文件名无效"))?
        .to_string_lossy();
    Ok(parent.join(format!(
        ".{}.terminalbuddy-{}.tmp",
        file_name,
        uuid::Uuid::new_v4()
    )))
}

#[cfg(windows)]
fn replace_existing(path: &Path, temp: &Path) -> io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS};

    let path_wide = path
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let temp_wide = temp
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        ReplaceFileW(
            PCWSTR(path_wide.as_ptr()),
            PCWSTR(temp_wide.as_ptr()),
            PCWSTR::null(),
            REPLACE_FILE_FLAGS::default(),
            None,
            None,
        )
    }
    .map_err(io::Error::other)
}

#[cfg(not(windows))]
fn replace_existing(path: &Path, temp: &Path) -> io::Result<()> {
    fs::rename(temp, path)
}

pub fn atomic_write(path: &Path, content: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temp = unique_temp_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(content)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);

        if path.exists() {
            replace_existing(path, &temp)
        } else {
            fs::rename(&temp, path)
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::atomic_write;
    use std::fs;

    #[test]
    fn atomic_write_replaces_existing_file_without_temp_residue() {
        let dir = std::env::temp_dir().join(format!(
            "terminal-buddy-atomic-write-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }
}
