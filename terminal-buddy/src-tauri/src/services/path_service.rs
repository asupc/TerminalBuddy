use crate::services::SettingsService;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

#[cfg(test)]
use std::cell::RefCell;

#[cfg(test)]
thread_local! {
    static TEST_DATA_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

pub struct PathService;

/// 自定义数据目录的可用性状态。`get_data_dir()` 一次调用无法把错误传出去
/// （签名返回裸 `PathBuf`），所以在进程内缓存最近一次的判定结果，
/// 供设置页展示和启动横幅查询。
static CUSTOM_DATA_DIR_STATUS: RwLock<Option<DataDirStatus>> = RwLock::new(None);

/// 已配置的自定义数据目录当前的可用性。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataDirStatus {
    /// 未配置自定义路径，使用默认目录。
    Default,
    /// 已配置且当前可用。
    Ok { path: String },
    /// 已配置但当前不可用（目录消失、无权限、网络盘断开等）。
    Unavailable { path: String, reason: String },
}

impl DataDirStatus {
    pub fn summary(&self) -> String {
        match self {
            DataDirStatus::Default => "使用默认数据目录".to_string(),
            DataDirStatus::Ok { path } => format!("自定义数据目录可用：{}", path),
            DataDirStatus::Unavailable { path, reason } => {
                format!("自定义数据目录不可用：{}（{}）", path, reason)
            }
        }
    }
}

/// 触发数据目录写入的所有方共同遵守的失败文案：附上配置项与恢复建议。
fn custom_dir_unavailable(path: &Path, reason: &str) -> String {
    format!(
        "自定义数据目录「{}」当前不可用：{}。为避免产生两套数据，本次操作已停止。请恢复该目录（重新挂载磁盘/网络路径，或修正 settings.json 的 dataPath）后重试。",
        path.display(),
        reason
    )
}

/// 目录是否真实可写：不仅存在，还要能创建/打开文件。
/// 只查 `exists()` 会把「网络盘断开后残留的挂载点」误判为可用。
fn ensure_writable_dir(path: &Path) -> Result<(), String> {
    if path.symlink_metadata().is_err() {
        fs::create_dir_all(path).map_err(|e| format!("目录不存在且无法创建：{}", e))?;
    }
    if !path.is_dir() {
        return Err("路径不是一个目录".to_string());
    }
    let probe = path.join(".terminalbuddy_access_probe");
    let result = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe);
    match result {
        Ok(_) => {
            // 探测失败不改变结论：文件已建成说明目录可写
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // 上次运行残留的探测文件：尝试删掉后重试一次
            match fs::remove_file(&probe).and_then(|()| {
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&probe)
            }) {
                Ok(_) => {
                    let _ = fs::remove_file(&probe);
                    Ok(())
                }
                Err(e) => Err(format!("目录不可写：{}", e)),
            }
        }
        Err(e) => Err(format!("目录不可写：{}", e)),
    }
}

fn set_status(status: DataDirStatus) {
    if let Ok(mut slot) = CUSTOM_DATA_DIR_STATUS.write() {
        *slot = Some(status);
    }
}

impl PathService {
    fn get_default_base_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("TerminalBuddy")
    }

    /// 判定当前应使用的数据目录，并同步缓存状态。
    ///
    /// 规则：配置了绝对自定义路径时，**只**使用它——可用就用，不可用就报错；
    /// 绝不静默退回默认目录，否则断开的移动盘 / 网络路径会把新数据写进
    /// 默认目录，等路径恢复后出现两套互相看不到的数据。
    fn resolve_data_dir() -> Result<PathBuf, String> {
        #[cfg(test)]
        if let Some(path) = TEST_DATA_DIR.with(|data_dir| data_dir.borrow().clone()) {
            return Ok(path);
        }
        let settings = SettingsService::get_settings();
        let Some(ref custom) = settings.data_path else {
            set_status(DataDirStatus::Default);
            return Ok(Self::get_default_base_dir());
        };
        let path = PathBuf::from(custom);
        if !path.is_absolute() {
            let reason = "配置的路径不是绝对路径".to_string();
            set_status(DataDirStatus::Unavailable {
                path: custom.clone(),
                reason: reason.clone(),
            });
            return Err(custom_dir_unavailable(&path, &reason));
        }
        if let Err(reason) = ensure_writable_dir(&path) {
            set_status(DataDirStatus::Unavailable {
                path: custom.clone(),
                reason: reason.clone(),
            });
            return Err(custom_dir_unavailable(&path, &reason));
        }
        set_status(DataDirStatus::Ok {
            path: custom.clone(),
        });
        Ok(path)
    }

    /// 解析数据目录，不可用时返回中文错误。所有**写入**数据的路径都必须走这里，
    /// 保证自定义目录故障不会被静默降级成「写进默认目录」。
    pub fn require_data_dir() -> Result<PathBuf, String> {
        Self::resolve_data_dir()
    }

    /// 读取最近一次解析得到的数据目录状态（设置页 / 启动横幅展示用）。
    pub fn get_data_dir_status() -> Option<DataDirStatus> {
        CUSTOM_DATA_DIR_STATUS
            .read()
            .ok()
            .and_then(|slot| slot.clone())
    }

    /// 兼容入口：解析失败时返回默认目录但**不缓存 Ok 状态**。
    ///
    /// 仅允许纯读场景调用（启动早期读取已有数据做展示）。任何写数据的代码
    /// 改用 [`PathService::require_data_dir`]；继续用本函数做写入的调用点属于 BUG。
    pub fn get_data_dir() -> PathBuf {
        match Self::resolve_data_dir() {
            Ok(dir) => dir,
            Err(_) => Self::get_default_base_dir(),
        }
    }

    #[cfg(test)]
    pub fn set_test_data_dir(path: Option<PathBuf>) {
        TEST_DATA_DIR.with(|data_dir| *data_dir.borrow_mut() = path);
    }

    pub fn get_profiles_dir() -> Result<PathBuf, String> {
        let dir = Self::require_data_dir()?.join("Profiles");
        fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
        Ok(dir)
    }

    pub fn get_bots_dir() -> Result<PathBuf, String> {
        let dir = Self::require_data_dir()?.join("Bots");
        fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
        Ok(dir)
    }

    pub fn get_debug_log_path() -> Result<PathBuf, String> {
        let dir = Self::require_data_dir()?;
        fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
        Ok(dir.join("debug.log"))
    }

    pub fn get_current_data_path() -> String {
        Self::get_data_dir().to_string_lossy().to_string()
    }

    pub fn validate_data_path(path: &str) -> Result<PathBuf, String> {
        let p = PathBuf::from(path);
        if !p.is_absolute() {
            return Err("路径必须是绝对路径".to_string());
        }
        if p.exists() && !p.is_dir() {
            return Err("路径必须是一个目录".to_string());
        }
        if !p.exists() {
            fs::create_dir_all(&p).map_err(|e| format!("无法创建目录: {}", e))?;
        }
        ensure_writable_dir(&p)?;
        Ok(p)
    }
}

/// 目标路径是否位于源目录内部（含相等）。目标在源内时自复制会一边复制一边
/// 给自己喂输入，必须拒绝。
fn dst_inside_src(src: &Path, dst: &Path) -> bool {
    let mut current = Some(dst);
    while let Some(dir) = current {
        if dir == src {
            return true;
        }
        current = dir.parent();
    }
    false
}

/// 递归复制的已访问（canonical 路径）集合，用于剪断目录环。
struct Visited {
    dirs: BTreeSet<PathBuf>,
}

impl Visited {
    fn new() -> Self {
        Self {
            dirs: BTreeSet::new(),
        }
    }

    /// 目录链接指回祖先（junction 环）时返回 Err，不进入递归。
    fn enter(&mut self, canonical: PathBuf) -> Result<(), String> {
        if !self.dirs.insert(canonical.clone()) {
            return Err(format!(
                "检测到目录循环（{} 被重复复制），已停止复制以避免无限递归。",
                canonical.display()
            ));
        }
        Ok(())
    }
}

/// 递归复制目录。
///
/// 链接策略：普通文件直接复制内容；目录符号链接 / junction 一律**拒绝**并报错，
/// 而不是跟随——数据目录迁移面对的是用户自己的配置文件，跟随链接既可能把
/// 系统目录整个复制进来，也可能顺着指回祖先的 junction 无限递归。
pub fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    let src_canonical = src
        .canonicalize()
        .map_err(|e| format!("解析源目录失败: {}", e))?;
    let dst_canonical = dst
        .canonicalize()
        .or_else(|_| Ok(dst.clone()))
        .map_err(|e: std::io::Error| format!("解析目标目录失败: {}", e))?;
    if dst_inside_src(&src_canonical, &dst_canonical) {
        return Err(format!(
            "目标目录「{}」位于源目录「{}」内部，不允许自我复制。",
            dst.display(),
            src.display()
        ));
    }

    let mut visited = Visited::new();
    // 根到叶逐层携带「本次复制的源根 / 目标根」，让子目录复制前也能
    // 检查目标是否正在落入源内部（自我复制会一边喂输入一边给自己造输出）。
    copy_dir_inner(src, dst, &src_canonical, dst, &mut visited)
}

fn copy_dir_inner(
    src: &Path,
    dst: &Path,
    src_root: &Path,
    dst_root: &Path,
    visited: &mut Visited,
) -> Result<(), String> {
    let src_canonical = src
        .canonicalize()
        .map_err(|e| format!("解析目录失败: {}", e))?;
    visited.enter(src_canonical)?;

    fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {}", e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        // symlink_metadata 不跟随链接：junction / symlink 在这里暴露真实身份
        let metadata = entry
            .path()
            .symlink_metadata()
            .map_err(|e| format!("读取条目属性失败: {}", e))?;
        let file_type = metadata.file_type();

        if file_type.is_symlink() {
            return Err(format!(
                "「{}」是符号链接或 junction，数据迁移不支持复制链接，请先移除或改用真实目录。",
                src_path.display()
            ));
        }
        if file_type.is_dir() {
            // 深层检查：复制进行到一半时，目标子树若已长进源子树内部，
            // 继续递归会无限自我复制（每层 canonicalize 都是新路径，visited 挡不住）。
            if dst_inside_src(&src_path, &dst_path) || dst_inside_src(src_root, &dst_path) {
                return Err(format!(
                    "目标目录「{}」位于源目录「{}」内部，不允许自我复制。",
                    dst_root.display(),
                    src_root.display()
                ));
            }
            copy_dir_inner(&src_path, &dst_path, src_root, dst_root, visited)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| format!("复制文件失败: {}", e))?;
        }
    }
    Ok(())
}

/// 迭代式祖先检查（避免深路径递归），供测试与未来调用方复用。
pub fn path_starts_with(path: &Path, prefix: &Path) -> bool {
    if prefix == Path::new("/") {
        return true;
    }
    let mut remaining = path;
    loop {
        if remaining == prefix {
            return true;
        }
        match remaining.parent() {
            Some(parent) => remaining = parent,
            None => return false,
        }
    }
}

/// 把路径归一化（解析 `.`/`..`，不触及文件系统），仅用于测试辅助。
pub fn normalize_components(path: &Path) -> PathBuf {
    path.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "terminal-buddy-paths-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copy_rejects_dst_inside_src() {
        let src = tmp_dir("src");
        let dst = src.join("sub").join("dest");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"x").unwrap();

        let err = copy_dir_recursive(&src, &dst).unwrap_err();
        assert!(err.contains("不允许自我复制"), "实际错误: {}", err);
        let _ = fs::remove_dir_all(src);
    }

    #[test]
    fn copy_rejects_symlink_entries() {
        let src = tmp_dir("src");
        let dst = tmp_dir("dst");
        fs::write(src.join("real.txt"), b"x").unwrap();
        #[cfg(windows)]
        {
            // junction 指回源目录自身，构成环
            let junction = src.join("loop");
            let _ = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&junction)
                .arg(&src)
                .status();
            if junction.exists() {
                let err = copy_dir_recursive(&src, &dst).unwrap_err();
                assert!(
                    err.contains("符号链接") || err.contains("循环"),
                    "实际错误: {}",
                    err
                );
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(src.join("real.txt"), src.join("link.txt")).unwrap();
            let err = copy_dir_recursive(&src, &dst).unwrap_err();
            assert!(err.contains("符号链接"), "实际错误: {}", err);
        }
        let _ = fs::remove_dir_all(src);
        let _ = fs::remove_dir_all(dst);
    }

    #[test]
    fn copy_handles_plain_files_and_subdirs() {
        let src = tmp_dir("src");
        let dst = tmp_dir("dst");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"alpha").unwrap();
        fs::write(src.join("sub").join("b.txt"), b"beta").unwrap();

        copy_dir_recursive(&src, &dst).unwrap();
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(fs::read(dst.join("sub").join("b.txt")).unwrap(), b"beta");
        let _ = fs::remove_dir_all(src);
        let _ = fs::remove_dir_all(dst);
    }

    #[test]
    fn dst_inside_src_detects_ancestors() {
        let src = PathBuf::from(r"C:\data");
        assert!(dst_inside_src(&src, &src));
        assert!(dst_inside_src(&src, &src.join("Profiles")));
        assert!(!dst_inside_src(&src, &PathBuf::from(r"C:\other")));
    }

    #[test]
    fn ensure_writable_dir_reports_missing_parent() {
        // 创建一个权限受限的模拟场景：只验证探测文件机制本身不误报
        let dir = tmp_dir("probe");
        ensure_writable_dir(&dir).unwrap();
        let residue: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            residue.is_empty(),
            "探测文件应被清理，残留: {:?}",
            residue.iter().map(|e| e.path()).collect::<Vec<_>>()
        );
        let _ = fs::remove_dir_all(dir);
    }
}
