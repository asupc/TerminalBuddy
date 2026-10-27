//! Pi 扩展安装：随应用发布、写入应用数据目录，由 `prepare_launch` 通过
//! `--extension <path>` 注入。全局安装是可选增强（覆盖手动启动的 pi）。
use std::fs;
use std::path::PathBuf;

use super::PathService;

const EXTENSION_JS: &str = include_str!("../../resources/pi/terminal-buddy-extension.js");
const MANAGED_MARKER: &str = "TerminalBuddy Pi Agent 扩展";
pub const GLOBAL_EXTENSION_FILE: &str = "terminal-buddy.js";

/// 确保应用数据目录中的扩展文件是最新版，返回其路径。
pub fn ensure_extension() -> Result<PathBuf, String> {
    let dir = PathService::require_data_dir()?.join("PiAgent");
    fs::create_dir_all(&dir).map_err(|error| format!("创建 Pi 扩展目录失败：{error}"))?;
    let path = dir.join("terminal-buddy-extension.js");
    let needs_write = match fs::read_to_string(&path) {
        Ok(existing) => existing != EXTENSION_JS,
        Err(_) => true,
    };
    if needs_write {
        fs::write(&path, EXTENSION_JS).map_err(|error| format!("写入 Pi 扩展失败：{error}"))?;
    }
    Ok(path)
}

fn global_extension_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("用户主目录未正确配置")?;
    Ok(home.join(".pi/agent/extensions").join(GLOBAL_EXTENSION_FILE))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiExtensionState {
    pub installed: bool,
    pub path: String,
    pub globally_installed: bool,
}

pub fn state() -> Result<PiExtensionState, String> {
    let path = ensure_extension()?;
    let global = global_extension_path()?;
    let globally_installed = fs::read_to_string(&global)
        .map(|content| content.contains(MANAGED_MARKER))
        .unwrap_or(false);
    Ok(PiExtensionState {
        installed: path.is_file(),
        path: path.to_string_lossy().into_owned(),
        globally_installed,
    })
}

/// 安装到 `~/.pi/agent/extensions/terminal-buddy.js`；不覆盖不属于 TerminalBuddy 的同名文件。
pub fn install_global() -> Result<(), String> {
    let path = global_extension_path()?;
    if let Ok(existing) = fs::read_to_string(&path) {
        if !existing.contains(MANAGED_MARKER) {
            return Err(format!("{} 已存在且不属于 TerminalBuddy，未覆盖", path.display()));
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 Pi 扩展目录失败：{error}"))?;
    }
    fs::write(&path, EXTENSION_JS).map_err(|error| format!("安装 Pi 扩展失败：{error}"))
}

pub fn uninstall_global() -> Result<(), String> {
    let path = global_extension_path()?;
    if let Ok(existing) = fs::read_to_string(&path) {
        if existing.contains(MANAGED_MARKER) {
            fs::remove_file(&path).map_err(|error| format!("卸载 Pi 扩展失败：{error}"))?;
        }
    }
    Ok(())
}
