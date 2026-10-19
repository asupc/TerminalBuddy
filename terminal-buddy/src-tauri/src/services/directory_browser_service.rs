//! 项目目录选择器的入口与只读目录浏览；不扩大项目文件 / Git 的访问范围。
use serde::Serialize;
use std::{collections::HashSet, fs, path::{Path, PathBuf}};

use super::PathService;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDirectory {
    pub name: String,
    pub path: String,
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", unc);
        }
        if let Some(local) = value.strip_prefix(r"\\?\") {
            return local.to_string();
        }
    }
    value
}

fn path_key(path: &Path) -> String {
    let value = display_path(path);
    if cfg!(windows) { value.to_lowercase() } else { value }
}

fn add_root(roots: &mut Vec<ServerDirectory>, seen: &mut HashSet<String>, name: String, path: &Path) {
    if !path.is_absolute() { return; }
    let Ok(real) = path.canonicalize() else { return; };
    if !real.is_dir() || !seen.insert(path_key(&real)) { return; }
    roots.push(ServerDirectory { name, path: display_path(&real) });
}

/// mountinfo 的第 5 列为容器内挂载点；空格、制表符、换行和反斜杠使用八进制转义。
fn mount_path(value: &str) -> PathBuf {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 3 < bytes.len() {
            let escaped = match &bytes[index + 1..index + 4] {
                b"040" => Some(b' '),
                b"011" => Some(b'\t'),
                b"012" => Some(b'\n'),
                b"134" => Some(b'\\'),
                _ => None,
            };
            if let Some(byte) = escaped {
                decoded.push(byte);
                index += 4;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    PathBuf::from(String::from_utf8_lossy(&decoded).into_owned())
}

fn mounted_directories() -> Vec<PathBuf> {
    let Ok(mountinfo) = fs::read_to_string("/proc/self/mountinfo") else { return Vec::new(); };
    let data_dir = PathService::get_data_dir().canonicalize().ok();
    let home_dir = dirs::home_dir().and_then(|path| path.canonicalize().ok());
    let mut paths: Vec<_> = mountinfo.lines()
        .filter_map(|line| line.split_whitespace().nth(4))
        .map(mount_path)
        .filter(|path| {
            // 系统挂载、应用数据卷和工具家目录不是项目浏览入口。
            path != Path::new("/")
                && !["/proc", "/sys", "/dev", "/etc", "/run", "/var/run", "/opt/terminal-buddy"]
                    .iter().any(|system| path.starts_with(system))
                && !data_dir.as_ref().is_some_and(|data| path.starts_with(data))
                && !home_dir.as_ref().is_some_and(|home| {
                    path == home || [".ssh", ".claude", ".codex"].iter().any(|name| path.starts_with(home.join(name)))
                })
        })
        .collect();
    paths.sort();
    paths
}

/// 浏览入口独立于已登记项目，新增项目不会限制后续的选择范围。
/// 显式目录使用容器内路径；Linux 用冒号分隔，Windows 用分号分隔。
pub fn browse_roots(projects: Vec<ServerDirectory>, docker_runtime: bool) -> Vec<ServerDirectory> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    if let Some(configured) = std::env::var_os("TERMINAL_BUDDY_BROWSE_ROOTS") {
        for path in std::env::split_paths(&configured) {
            add_root(&mut roots, &mut seen, "配置目录".into(), &path);
        }
    }
    if let Some(workspace) = std::env::var_os("TERMINAL_BUDDY_WORKSPACE_DIR") {
        add_root(&mut roots, &mut seen, "服务器工作区".into(), Path::new(&workspace));
    }
    if docker_runtime {
        for path in mounted_directories() {
            add_root(&mut roots, &mut seen, "挂载目录".into(), &path);
        }
    }
    for project in projects {
        add_root(&mut roots, &mut seen, project.name, Path::new(&project.path));
    }
    roots
}

fn within_roots(path: &Path, roots: &[ServerDirectory]) -> bool {
    let key = path_key(path);
    let separator = std::path::MAIN_SEPARATOR;
    roots.iter().any(|root| {
        let base = path_key(Path::new(&root.path));
        key == base || key.starts_with(&format!("{}{}", base.trim_end_matches(separator), separator))
    })
}

/// 对请求目录及其符号链接目标检查范围，不允许通过 .. 或链接跳出浏览入口。
pub fn resolve_directory(path: &str, roots: &[ServerDirectory]) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() { return Err("必须使用服务器绝对路径".into()); }
    let real = path.canonicalize().map_err(|e| format!("目录不可访问：{}", e))?;
    if !within_roots(&real, roots) { return Err("该目录不在可浏览目录范围内".into()); }
    if !real.is_dir() { return Err("请选择目录".into()); }
    Ok(real)
}

/// 选择器仅列出目录；文件内容仍通过原有的项目权限检查读取。
pub fn list_directories(path: &Path, roots: &[ServerDirectory]) -> Result<Vec<ServerDirectory>, String> {
    let entries = fs::read_dir(path).map_err(|e| format!("读取目录失败：{}", e))?;
    let mut directories = Vec::new();
    for entry in entries.flatten() {
        let child = entry.path();
        let Ok(real) = child.canonicalize() else { continue; };
        if !real.is_dir() || !within_roots(&real, roots) { continue; }
        directories.push(ServerDirectory {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: display_path(&child),
        });
    }
    directories.sort_by_cached_key(|directory| directory.name.to_lowercase());
    Ok(directories)
}
