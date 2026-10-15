//! Docker 内的 CLI 检测与安装。安装为固定的官方流程，不接受客户端命令或下载地址。
use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::web::{auth::ClaimsFromRequest, error::ApiError, server::AppState};

const INSTALLER_URL: &str = "https://claude.ai/install.sh";

#[derive(Default)]
struct Installation {
    running: bool,
    error: Option<String>,
}

fn installation() -> &'static Mutex<Installation> {
    static STATE: OnceLock<Mutex<Installation>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Installation::default()))
}

pub fn is_docker_runtime() -> bool {
    !cfg!(feature = "desktop")
        && cfg!(target_os = "linux")
        && (std::env::var("TERMINAL_BUDDY_DEPLOYMENT").as_deref() == Ok("docker")
            || Path::new("/.dockerenv").is_file())
}

fn ensure_docker() -> Result<(), ApiError> {
    if is_docker_runtime() {
        Ok(())
    } else {
        Err(ApiError::Forbidden("容器环境管理仅适用于 Docker 版本".into()))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    claude: ClaudeStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatus {
    status: &'static str,
    version: Option<String>,
    message: Option<String>,
}

fn home() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("容器 HOME 目录未正确配置")?;
    Ok(home)
}

fn version_from_output(output: &Output) -> Option<String> {
    if !output.status.success() { return None; }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|line| line.contains("(Claude Code)"))?;
    let version = line.split_whitespace().next()?;
    let parts: Vec<_> = version.split('.').collect();
    (parts.len() >= 3 && parts.iter().take(3).all(|part| part.parse::<u32>().is_ok()))
        .then(|| version.to_string())
}

fn prepare_command(command: &mut Command) {
    command.stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

fn stop_process(child: &mut Child) {
    // 官方安装器会启动 curl 等子进程，超时或服务退出不能留下孤儿下载任务。
    #[cfg(unix)]
    let _ = Command::new("bash")
        .args(["-c", "kill -KILL -- -\"$1\"", "claude-install", &child.id().to_string()])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_for_child(child: &mut Child, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                stop_process(child);
                return Err("操作超时，请检查容器网络后重试".into());
            }
            Err(error) => {
                stop_process(child);
                return Err(format!("读取安装进程状态失败：{error}"));
            }
        }
    }
}

fn detect_claude() -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(home) = home() { candidates.push(home.join(".local/bin/claude")); }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("claude")));
    }
    for path in candidates.into_iter().filter(|path| path.is_file()) {
        let mut command = Command::new(path);
        prepare_command(&mut command);
        let Ok(mut child) = command.arg("--version")
            .stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { continue; };
        if wait_for_child(&mut child, Duration::from_secs(5)).is_err() { continue; }
        if let Ok(output) = child.wait_with_output() {
            if let Some(version) = version_from_output(&output) { return Some(version); }
        }
    }
    None
}

fn environment() -> Result<Environment, String> {
    let (running, error) = {
        let state = installation().lock().map_err(|_| "安装状态不可用")?;
        (state.running, state.error.clone())
    };
    if running {
        return Ok(Environment { claude: ClaudeStatus { status: "installing", version: None, message: None } });
    }
    let version = detect_claude();
    let status = if version.is_some() { "installed" } else if error.is_some() { "failed" } else { "notInstalled" };
    Ok(Environment { claude: ClaudeStatus { status, version, message: error } })
}

pub async fn status(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<Json<Environment>, ApiError> {
    ensure_docker()?;
    tokio::task::spawn_blocking(environment).await
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .map(Json).map_err(ApiError::Internal)
}

pub async fn install(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<(StatusCode, Json<Environment>), ApiError> {
    ensure_docker()?;
    {
        let mut state = installation().lock().map_err(|_| ApiError::Internal("安装状态不可用".into()))?;
        if state.running { return Err(ApiError::Conflict("Claude 正在安装，请等待完成".into())); }
        state.running = true;
        state.error = None;
    }
    // HTTP 立即返回，下载和安装不占用 30 秒请求超时窗口；关闭弹框也不会打断安装。
    tokio::spawn(async {
        let result = tokio::task::spawn_blocking(run_install).await
            .unwrap_or_else(|error| Err(format!("安装任务异常：{error}")));
        if let Ok(mut state) = installation().lock() {
            state.running = false;
            state.error = result.err();
        }
    });
    Ok((StatusCode::ACCEPTED, Json(Environment {
        claude: ClaudeStatus { status: "installing", version: None, message: None },
    })))
}

struct InstallDirectory(PathBuf);
impl Drop for InstallDirectory {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn log_tail(path: &Path) -> String {
    let Ok(mut file) = File::open(path) else { return String::new(); };
    let _ = file.seek(SeekFrom::End(-2048)).or_else(|_| file.seek(SeekFrom::Start(0)));
    let mut bytes = Vec::new();
    let _ = file.take(2048).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn run_logged(command: &mut Command, log: &Path, timeout: Duration) -> Result<(), String> {
    let file = File::create(log).map_err(|error| format!("无法创建安装日志：{error}"))?;
    prepare_command(command);
    command.stdout(file.try_clone().map_err(|error| error.to_string())?).stderr(file);
    let mut child = command.spawn().map_err(|error| format!("无法启动安装程序：{error}"))?;
    wait_for_child(&mut child, timeout)?;
    let status = child.wait().map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("Claude 安装失败：{}", log_tail(log)));
    }
    Ok(())
}

fn run_install() -> Result<(), String> {
    if detect_claude().is_some() { return Ok(()); }
    let home = home()?;
    fs::create_dir_all(home.join(".local/bin")).map_err(|error| format!("安装目录不可写：{error}"))?;
    let path = std::env::temp_dir().join(format!("terminal-buddy-claude-{}", uuid::Uuid::new_v4()));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&path).map_err(|error| error.to_string())?;
    let dir = InstallDirectory(path);
    let script = dir.0.join("install.sh");
    let log = dir.0.join("install.log");
    run_logged(Command::new("curl").args([
        "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
        "--connect-timeout", "15", "--max-time", "90", "--retry", "2", "--output",
    ]).arg(&script).arg(INSTALLER_URL), &log, Duration::from_secs(120))?;
    run_logged(Command::new("bash").arg(&script).arg("stable"), &log, Duration::from_secs(600))?;
    detect_claude().ok_or_else(|| "安装程序已结束，但 Claude 未能正常运行，请检查容器环境后重试".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_accepts_a_successful_claude_version() {
        #[cfg(unix)]
        {
            let output = Command::new("sh").args(["-c", "printf '2.1.299 (Claude Code)\\n'"]).output().unwrap();
            assert_eq!(version_from_output(&output).as_deref(), Some("2.1.299"));
            let failed = Command::new("sh").args(["-c", "printf '2.1.299 (Claude Code)\\n'; exit 1"]).output().unwrap();
            assert!(version_from_output(&failed).is_none());
            let unrelated = Command::new("sh").args(["-c", "printf 'claude: command not found\\n'"]).output().unwrap();
            assert!(version_from_output(&unrelated).is_none());
        }
    }

    #[test]
    fn a_stuck_process_is_terminated() {
        #[cfg(unix)]
        {
            let mut command = Command::new("sh");
            prepare_command(&mut command);
            let mut child = command.args(["-c", "sleep 30"]).spawn().unwrap();
            assert!(wait_for_child(&mut child, Duration::from_millis(50)).is_err());
            assert!(child.try_wait().unwrap().is_some());
        }
    }
}
