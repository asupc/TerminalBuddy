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

#[derive(Clone, Copy)]
enum CliTool {
    Claude,
    Codex,
}

impl CliTool {
    fn binary(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex CLI",
        }
    }

    fn installer_url(self) -> &'static str {
        match self {
            Self::Claude => "https://claude.ai/install.sh",
            Self::Codex => "https://chatgpt.com/codex/install.sh",
        }
    }

    fn installer_command(self, script: &Path, home: &Path) -> Command {
        match self {
            Self::Claude => {
                let mut command = Command::new("bash");
                command.arg(script).arg("stable");
                command
            }
            Self::Codex => {
                let mut command = Command::new("sh");
                command.arg(script)
                    .env("CODEX_NON_INTERACTIVE", "1")
                    .env("CODEX_INSTALL_DIR", home.join(".local/bin"));
                command
            }
        }
    }
}

#[derive(Default)]
struct Installation {
    running: bool,
    error: Option<String>,
}

fn installation(tool: CliTool) -> &'static Mutex<Installation> {
    static CLAUDE: OnceLock<Mutex<Installation>> = OnceLock::new();
    static CODEX: OnceLock<Mutex<Installation>> = OnceLock::new();
    let state = match tool {
        CliTool::Claude => &CLAUDE,
        CliTool::Codex => &CODEX,
    };
    state.get_or_init(|| Mutex::new(Installation::default()))
}

pub fn is_docker_runtime() -> bool {
    !cfg!(feature = "desktop")
        && cfg!(target_os = "linux")
        && (std::env::var("TERMINAL_BUDDY_DEPLOYMENT").as_deref() == Ok("docker")
            || Path::new("/.dockerenv").is_file())
}

pub(crate) fn ensure_docker() -> Result<(), ApiError> {
    if is_docker_runtime() {
        Ok(())
    } else {
        Err(ApiError::Forbidden("容器环境管理仅适用于 Docker 版本".into()))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    claude: CliStatus,
    codex: CliStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliStatus {
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

fn version_from_output(tool: CliTool, output: &Output) -> Option<String> {
    if !output.status.success() { return None; }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().find_map(|line| {
        let version = match tool {
            CliTool::Claude if line.contains("(Claude Code)") => line.split_whitespace().next()?,
            CliTool::Codex => line.trim().strip_prefix("codex-cli ")?.trim(),
            _ => return None,
        };
        let core = version.split(['-', '+']).next()?;
        let parts: Vec<_> = core.split('.').collect();
        (parts.len() == 3 && parts.iter().all(|part| part.parse::<u32>().is_ok()))
            .then(|| version.to_string())
    })
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
        .args(["-c", "kill -KILL -- -\"$1\"", "cli-install", &child.id().to_string()])
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

fn detect_cli(tool: CliTool) -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(home) = home() { candidates.push(home.join(".local/bin").join(tool.binary())); }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(tool.binary())));
    }
    detect_candidates(tool, candidates)
}

fn detect_candidates(tool: CliTool, candidates: Vec<PathBuf>) -> Option<String> {
    for path in candidates.into_iter().filter(|path| path.is_file()) {
        let mut command = Command::new(path);
        prepare_command(&mut command);
        let Ok(mut child) = command.arg("--version")
            .stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { continue; };
        if wait_for_child(&mut child, Duration::from_secs(5)).is_err() { continue; }
        if let Ok(output) = child.wait_with_output() {
            if let Some(version) = version_from_output(tool, &output) { return Some(version); }
        }
    }
    None
}

fn cli_status(tool: CliTool) -> Result<CliStatus, String> {
    let (running, error) = {
        let state = installation(tool).lock().map_err(|_| "安装状态不可用")?;
        (state.running, state.error.clone())
    };
    if running {
        return Ok(CliStatus { status: "installing", version: None, message: None });
    }
    let version = detect_cli(tool);
    let status = if version.is_some() { "installed" } else if error.is_some() { "failed" } else { "notInstalled" };
    let message = if version.is_some() { None } else { error };
    Ok(CliStatus { status, version, message })
}

fn environment() -> Result<Environment, String> {
    Ok(Environment {
        claude: cli_status(CliTool::Claude)?,
        codex: cli_status(CliTool::Codex)?,
    })
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
    start_install(CliTool::Claude).await
}

pub async fn install_codex(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<(StatusCode, Json<Environment>), ApiError> {
    start_install(CliTool::Codex).await
}

async fn start_install(tool: CliTool) -> Result<(StatusCode, Json<Environment>), ApiError> {
    ensure_docker()?;
    {
        let mut state = installation(tool).lock().map_err(|_| ApiError::Internal("安装状态不可用".into()))?;
        if state.running { return Err(ApiError::Conflict(format!("{} 正在安装，请等待完成", tool.name()))); }
        state.running = true;
        state.error = None;
    }
    // HTTP 立即返回，下载和安装不占用 30 秒请求超时窗口；关闭弹框也不会打断安装。
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || run_install(tool)).await
            .unwrap_or_else(|error| Err(format!("安装任务异常：{error}")));
        if let Ok(mut state) = installation(tool).lock() {
            state.running = false;
            state.error = result.err();
        }
    });
    let environment = tokio::task::spawn_blocking(environment).await
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .map_err(ApiError::Internal)?;
    Ok((StatusCode::ACCEPTED, Json(environment)))
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

fn run_logged(tool: CliTool, command: &mut Command, log: &Path, timeout: Duration) -> Result<(), String> {
    let file = File::create(log).map_err(|error| format!("无法创建安装日志：{error}"))?;
    prepare_command(command);
    command.stdout(file.try_clone().map_err(|error| error.to_string())?).stderr(file);
    let mut child = command.spawn().map_err(|error| format!("无法启动安装程序：{error}"))?;
    wait_for_child(&mut child, timeout)?;
    let status = child.wait().map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("{} 安装失败：{}", tool.name(), log_tail(log)));
    }
    Ok(())
}

fn run_install(tool: CliTool) -> Result<(), String> {
    if detect_cli(tool).is_some() { return Ok(()); }
    let home = home()?;
    fs::create_dir_all(home.join(".local/bin")).map_err(|error| format!("安装目录不可写：{error}"))?;
    let path = std::env::temp_dir().join(format!("terminal-buddy-{}-{}", tool.binary(), uuid::Uuid::new_v4()));
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
    run_logged(tool, Command::new("curl").args([
        "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
        "--connect-timeout", "15", "--max-time", "90", "--retry", "2", "--output",
    ]).arg(&script).arg(tool.installer_url()), &log, Duration::from_secs(120))?;
    run_logged(tool, &mut tool.installer_command(&script, &home), &log, Duration::from_secs(600))?;
    detect_cli(tool).ok_or_else(|| format!("安装程序已结束，但 {} 未能正常运行，请检查容器环境后重试", tool.name()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(text: &str, success: bool) -> Output {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(if success { 0 } else { 1 }),
            stdout: text.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }

    #[test]
    fn only_accepts_a_successful_claude_version() {
        assert_eq!(version_from_output(CliTool::Claude, &output("2.1.299 (Claude Code)\n", true)).as_deref(), Some("2.1.299"));
        assert!(version_from_output(CliTool::Claude, &output("2.1.299 (Claude Code)\n", false)).is_none());
        assert!(version_from_output(CliTool::Claude, &output("claude: command not found\n", true)).is_none());
    }

    #[test]
    fn only_accepts_a_successful_codex_version() {
        for version in ["0.116.0", "0.116.0-alpha.1"] {
            let text = format!("codex-cli {version}\n");
            assert_eq!(version_from_output(CliTool::Codex, &output(&text, true)).as_deref(), Some(version));
            assert!(version_from_output(CliTool::Codex, &output(&text, false)).is_none());
        }
        for text in ["codex: command not found", "2.1.299 (Claude Code)", "codex-cli", "codex-cli 0.116", "codex-cli unknown", "codex-cli 0.116.0 extra"] {
            assert!(version_from_output(CliTool::Codex, &output(text, true)).is_none(), "{text}");
        }
    }

    #[test]
    fn codex_installer_is_non_interactive_and_uses_the_terminal_path() {
        let home = Path::new("/home/test user");
        let command = CliTool::Codex.installer_command(Path::new("/tmp/install.sh"), home);
        let variables: std::collections::HashMap<_, _> = command.get_envs().collect();
        assert_eq!(variables[std::ffi::OsStr::new("CODEX_NON_INTERACTIVE")], Some(std::ffi::OsStr::new("1")));
        assert_eq!(variables[std::ffi::OsStr::new("CODEX_INSTALL_DIR")], Some(home.join(".local/bin").as_os_str()));
    }

    #[test]
    fn cli_installations_have_independent_locks() {
        let _claude = installation(CliTool::Claude).lock().unwrap();
        assert!(installation(CliTool::Codex).try_lock().is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn detection_checks_executable_output_and_falls_back_to_other_paths() {
        use std::os::unix::fs::PermissionsExt;
        let dir = InstallDirectory(std::env::temp_dir().join(format!("cli-detection-test-{}", uuid::Uuid::new_v4())));
        fs::create_dir(&dir.0).unwrap();
        let broken = dir.0.join("broken-codex");
        let working = dir.0.join("codex");
        for (path, script) in [
            (&broken, "#!/bin/sh\nprintf 'codex-cli 0.116.0\\n'\nexit 1\n"),
            (&working, "#!/bin/sh\n[ \"$1\" = '--version' ] || exit 1\nprintf 'codex-cli 0.116.0\\n'\n"),
        ] {
            fs::write(path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert!(detect_candidates(CliTool::Codex, vec![broken.clone()]).is_none());
        assert_eq!(detect_candidates(CliTool::Codex, vec![dir.0.join("missing"), broken, working]).as_deref(), Some("0.116.0"));
    }

    #[cfg(unix)]
    #[test]
    fn installer_failure_includes_the_tool_and_log() {
        let dir = InstallDirectory(std::env::temp_dir().join(format!("cli-log-test-{}", uuid::Uuid::new_v4())));
        fs::create_dir(&dir.0).unwrap();
        let error = run_logged(CliTool::Codex, Command::new("sh").args(["-c", "printf 'download failed'; exit 1"]), &dir.0.join("install.log"), Duration::from_secs(5)).unwrap_err();
        assert!(error.contains("Codex CLI 安装失败"));
        assert!(error.contains("download failed"));
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
