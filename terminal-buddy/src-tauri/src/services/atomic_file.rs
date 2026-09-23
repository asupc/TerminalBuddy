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
    use windows::Win32::Storage::FileSystem::{
        ReplaceFileW, REPLACE_FILE_FLAGS, REPLACEFILE_WRITE_THROUGH,
    };

    const PARTIAL_REPLACE_HRESULT_RANGE: std::ops::RangeInclusive<i32> =
        (0x8007_0497u32 as i32)..=(0x8007_0499u32 as i32);

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

    // ReplaceFileW 的三个「部分完成」错误码（Win32 1175/1176/1177 =
    // UNABLE_TO_REMOVE_REPLACED / UNABLE_TO_MOVE_REPLACEMENT(_2)）：触发时另一个
    // 写入者正对同一目标做替换，本次替换处于中间态。短暂退避后重试等对方完成；
    // 重试耗尽则向上返回 Err，由 atomic_write 的错误路径清理 temp，
    // 目标保持上一次的完整内容。
    let mut attempts = 0u64;
    loop {
        attempts += 1;
        let result = unsafe {
            ReplaceFileW(
                PCWSTR(path_wide.as_ptr()),
                PCWSTR(temp_wide.as_ptr()),
                PCWSTR::null(),
                // WRITE_THROUGH：替换落盘后再返回，与外层 sync_all 的持久化强度匹配
                REPLACE_FILE_FLAGS(REPLACEFILE_WRITE_THROUGH.0),
                None,
                None,
            )
        };
        match result {
            Ok(()) => return Ok(()),
            Err(e)
                if PARTIAL_REPLACE_HRESULT_RANGE.contains(&e.code().0) && attempts < 8 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(5 * attempts));
            }
            Err(e) => return Err(io::Error::other(e)),
        }
    }
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

        replace_target(path, &temp)
    })();
    if result.is_err() {
        // 清理可能被并发 ReplaceFileW 消费掉而失败——删不存在是 ENOENT，忽略即可
        let _ = fs::remove_file(&temp);
    }
    result
}

/// 把写好的 temp 文件落到目标位置。
///
/// 竞态处理：`path.exists()` 与 replace/rename 之间目标可能出现或消失。
/// - 目标看似不存在 → `rename`；但 Windows 上 rename 对已存在的目标报
///   `AlreadyExists`，说明目标刚被别人创建，改走 `ReplaceFileW` 完成替换。
/// - 目标看似存在 → `ReplaceFileW`；但目标可能刚被删掉（`NotFound`），回退
///   `rename` 直接占位。两条回退只走一层，避免并发翻转导致活锁。
///
/// 属性语义（有意为之）：`ReplaceFileW` 保留**原文件**的属性/ACL（替换语义），
/// 全新文件继承目录默认属性。本应用的配置类 JSON 不依赖可执行位等元数据，
/// 两种结果的差异可以接受。
fn replace_target(path: &Path, temp: &Path) -> io::Result<()> {
    if path.exists() {
        match replace_existing(path, temp) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => fs::rename(temp, path),
            other => other,
        }
    } else {
        match fs::rename(temp, path) {
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => replace_existing(path, temp),
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::atomic_write;
    use std::fs;

    fn tmp_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "terminal-buddy-atomic-write-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn atomic_write_replaces_existing_file_without_temp_residue() {
        let dir = tmp_dir();
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_write_creates_new_file() {
        let dir = tmp_dir();
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("nested").join("new.json");

        atomic_write(&path, b"data").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"data");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_write_keeps_original_content_and_cleans_temp() {
        let dir = tmp_dir();
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keep.json");
        atomic_write(&path, b"original").unwrap();

        // 用一个必然失败的写入（目标是目录）验证：原文件完整、temp 无残留
        let target = dir.join("as_dir");
        fs::create_dir_all(&target).unwrap();
        assert!(atomic_write(&target, b"boom").is_err());

        assert_eq!(fs::read(&path).unwrap(), b"original");
        let residue: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(residue.is_empty(), "temp 残留: {:?}", residue);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn concurrent_writers_leave_one_complete_file() {
        use std::sync::Arc;
        let dir = tmp_dir();
        fs::create_dir_all(&dir).unwrap();
        let path = Arc::new(dir.clone());

        // 8 个写入者竞争同一目标：atomic_write 的合同是「每个调用要么成功、
        // 要么返回明确错误，目标始终是某一次完整写入」——并发替换同一文件
        // 在 Windows ReplaceFileW 下可能因共享冲突耗尽重试而报错，这属于
        // 稳定可解释的结果，不算损坏。
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let target = path.join("contended.json");
                    atomic_write(&target, format!("writer-{}", i).as_bytes())
                })
            })
            .collect();
        let mut succeeded = 0;
        for handle in handles {
            if handle.join().unwrap().is_ok() {
                succeeded += 1;
            }
        }
        assert!(succeeded >= 1, "至少一个写入者应成功");

        // 目标必须是某一个写入者的完整内容，不能交织截断
        let content = fs::read_to_string(dir.join("contended.json")).unwrap();
        assert!(
            (0..8).any(|i| content == format!("writer-{}", i)),
            "文件内容损坏: {:?}",
            content
        );

        // 没有写崩的 temp 文件泄漏（写入者自己的 temp 清理路径必须生效；
        // 被并发 ReplaceFileW 消费掉的 temp 不算泄漏——它已成为目标或备份）
        let tmp_residue: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".terminalbuddy-") && name.ends_with(".tmp"))
            .collect();
        assert!(tmp_residue.is_empty(), "temp 泄漏: {:?}", tmp_residue);
        let _ = fs::remove_dir_all(dir);
    }
}
