//! Docker 内的 CLI 检测、安装与更新；只使用固定的官方版本源和安装器。
use axum::{extract::{Path as ApiPath, Query, State}, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use crate::services::cli_update_service::{check_update, compare_versions, refresh_update_state, CliUpdate};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::web::{auth::ClaimsFromRequest, error::ApiError, server::AppState};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliTool {
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

    fn package(self) -> &'static str {
        match self {
            Self::Claude => "@anthropic-ai/claude-code",
            Self::Codex => "@openai/codex",
        }
    }

    fn preview_tags(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["next"],
            Self::Codex => &[],
        }
    }

    fn installer_url(self) -> &'static str {
        match self {
            Self::Claude => "https://claude.ai/install.sh",
            Self::Codex => "https://chatgpt.com/codex/install.sh",
        }
    }

    fn installer_command(self, script: &Path, home: &Path, target: Option<&str>) -> Command {
        match self {
            Self::Claude => {
                let mut command = Command::new("bash");
                command.arg(script).arg(target.unwrap_or("stable"));
                command
            }
            Self::Codex => {
                let mut command = Command::new("sh");
                command.arg(script)
                    .env("CODEX_NON_INTERACTIVE", "1")
                    .env("CODEX_INSTALL_DIR", home.join(".local/bin"));
                if let Some(version) = target { command.arg("--release").arg(version); }
                command
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Operation {
    Install,
    Update,
}

#[derive(Default)]
struct Installation {
    operation: Option<Operation>,
    previous_version: Option<String>,
    error: Option<String>,
    update: Option<CliUpdate>,
    updated_version: Option<String>,
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
pub struct CliStatus {
    status: &'static str,
    version: Option<String>,
    message: Option<String>,
    update: Option<CliUpdate>,
    updated_version: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentQuery {
    #[serde(default)]
    check_updates: bool,
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

fn status_from_snapshot(
    operation: Option<Operation>,
    version: Option<String>,
    error: Option<String>,
    update: Option<CliUpdate>,
    updated_version: Option<String>,
) -> CliStatus {
    let status = match operation {
        Some(Operation::Install) => "installing",
        Some(Operation::Update) => "updating",
        None if version.is_some() => "installed",
        None if error.is_some() => "failed",
        None => "notInstalled",
    };
    let update = update.map(|value| refresh_update_state(value, version.as_deref()));
    CliStatus { status, version, message: error, update, updated_version }
}

fn cli_status(tool: CliTool) -> Result<CliStatus, String> {
    let (operation, previous_version, error, update, updated_version) = {
        let state = installation(tool).lock().map_err(|_| "工具状态不可用")?;
        (state.operation, state.previous_version.clone(), state.error.clone(), state.update.clone(), state.updated_version.clone())
    };
    let version = if operation.is_some() { previous_version } else { detect_cli(tool) };
    Ok(status_from_snapshot(operation, version, error, update, updated_version))
}

fn environment() -> Result<Environment, String> {
    Ok(Environment {
        claude: cli_status(CliTool::Claude)?,
        codex: cli_status(CliTool::Codex)?,
    })
}

async fn load_status(tool: CliTool, check_updates: bool) -> Result<CliStatus, ApiError> {
    let status = tokio::task::spawn_blocking(move || cli_status(tool)).await
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .map_err(ApiError::Internal)?;
    if !check_updates { return Ok(status); }
    if matches!(status.status, "installing" | "updating") {
        return Err(ApiError::Conflict(format!("{} 正在安装或更新，请等待完成", tool.name())));
    }
    let update = check_update(tool.package(), status.version.as_deref(), tool.preview_tags()).await;
    tokio::task::spawn_blocking(move || {
        {
            let mut state = installation(tool).lock().map_err(|_| "工具状态不可用".to_string())?;
            // 其他页面可能已启动更新，迟到的检查结果不能覆盖进行中的任务。
            if state.operation.is_none() { state.update = Some(update); }
        }
        cli_status(tool)
    }).await.map_err(|error| ApiError::Internal(error.to_string()))?
        .map_err(ApiError::Internal)
}

pub async fn status(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    Query(query): Query<EnvironmentQuery>,
) -> Result<Json<Environment>, ApiError> {
    ensure_docker()?;
    if query.check_updates {
        let (claude, codex) = tokio::try_join!(load_status(CliTool::Claude, true), load_status(CliTool::Codex, true))?;
        return Ok(Json(Environment { claude, codex }));
    }
    tokio::task::spawn_blocking(environment).await
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .map(Json).map_err(ApiError::Internal)
}

pub async fn tool_status(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    ApiPath(tool): ApiPath<CliTool>,
    Query(query): Query<EnvironmentQuery>,
) -> Result<Json<CliStatus>, ApiError> {
    ensure_docker()?;
    load_status(tool, query.check_updates).await.map(Json)
}

pub async fn install(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    ApiPath(tool): ApiPath<CliTool>,
) -> Result<(StatusCode, Json<CliStatus>), ApiError> {
    start_operation(tool, Operation::Install).await
}

pub async fn update(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
    ApiPath(tool): ApiPath<CliTool>,
) -> Result<(StatusCode, Json<CliStatus>), ApiError> {
    start_operation(tool, Operation::Update).await
}

fn update_target(current: Option<&str>, update: Option<&CliUpdate>) -> Result<String, ApiError> {
    let current = current.ok_or_else(|| ApiError::BadRequest("工具尚未安装，请先安装".into()))?;
    let target = update.and_then(|update| update.latest_version.as_deref())
        .ok_or_else(|| ApiError::Conflict("请先检查更新，再重试更新".into()))?;
    if compare_versions(target, current) != Some(std::cmp::Ordering::Greater) {
        return Err(ApiError::Conflict("当前版本已变化或没有可用更新，请重新检查更新".into()));
    }
    Ok(target.to_string())
}

async fn start_operation(tool: CliTool, operation: Operation) -> Result<(StatusCode, Json<CliStatus>), ApiError> {
    ensure_docker()?;
    let target = tokio::task::spawn_blocking(move || {
        let mut state = installation(tool).lock().map_err(|_| ApiError::Internal("工具状态不可用".into()))?;
        if state.operation.is_some() {
            return Err(ApiError::Conflict(format!("{} 正在安装或更新，请等待完成", tool.name())));
        }
        let current = detect_cli(tool);
        let target = if operation == Operation::Update {
            Some(update_target(current.as_deref(), state.update.as_ref())?)
        } else { None };
        state.operation = Some(operation);
        state.previous_version = current;
        state.error = None;
        state.updated_version = None;
        Ok(target)
    }).await.map_err(|error| ApiError::Internal(error.to_string()))??;
    // HTTP 立即返回，两个工具使用独立任务锁，下载与安装均在阻塞线程池中运行。
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || run_install(tool, target.as_deref())).await
            .unwrap_or_else(|error| Err(format!("工具任务异常：{error}")));
        if let Ok(mut state) = installation(tool).lock() {
            state.operation = None;
            match result {
                Ok(version) => {
                    if operation == Operation::Update { state.updated_version = Some(version); }
                }
                Err(error) => {
                    state.error = Some(if operation == Operation::Update { format!("更新失败：{error}") } else { error });
                }
            }
        }
    });
    let status = load_status(tool, false).await?;
    Ok((StatusCode::ACCEPTED, Json(status)))
}

struct InstallDirectory(PathBuf);
impl InstallDirectory {
    fn create(name: &str) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("terminal-buddy-{name}-{}", uuid::Uuid::new_v4()));
        #[cfg(unix)]
        let mut builder = fs::DirBuilder::new();
        #[cfg(not(unix))]
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|error| error.to_string())?;
        Ok(Self(path))
    }
}
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

fn run_logged(name: &str, command: &mut Command, log: &Path, timeout: Duration) -> Result<(), String> {
    let file = File::create(log).map_err(|error| format!("无法创建安装日志：{error}"))?;
    prepare_command(command);
    command.stdout(file.try_clone().map_err(|error| error.to_string())?).stderr(file);
    let mut child = command.spawn().map_err(|error| format!("无法启动安装程序：{error}"))?;
    wait_for_child(&mut child, timeout)?;
    let status = child.wait().map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("{name} 安装失败：{}", log_tail(log)));
    }
    Ok(())
}

fn validate_installed_version(tool: CliTool, version: Option<String>, target: Option<&str>) -> Result<String, String> {
    let version = version.ok_or_else(|| format!("安装程序已结束，但 {} 未能正常运行，请检查容器环境后重试", tool.name()))?;
    if let Some(target) = target {
        if !matches!(compare_versions(&version, target), Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)) {
            return Err(format!("{} 当前版本仍为 {version}，未达到目标版本 {target}，请重试", tool.name()));
        }
    }
    Ok(version)
}

fn run_install(tool: CliTool, target: Option<&str>) -> Result<String, String> {
    // 更新必须重新执行安装器，不能命中已安装时的快捷返回。
    if target.is_none() {
        if let Some(version) = detect_cli(tool) { return Ok(version); }
    }
    let home = home()?;
    fs::create_dir_all(home.join(".local/bin")).map_err(|error| format!("安装目录不可写：{error}"))?;
    let dir = InstallDirectory::create(tool.binary())?;
    let script = dir.0.join("install.sh");
    let log = dir.0.join("install.log");
    run_logged(tool.name(), Command::new("curl").args([
        "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
        "--connect-timeout", "15", "--max-time", "90", "--retry", "2", "--output",
    ]).arg(&script).arg(tool.installer_url()), &log, Duration::from_secs(120))?;
    run_logged(tool.name(), &mut tool.installer_command(&script, &home, target), &log, Duration::from_secs(600))?;
    // 只核验安装目录中的入口，避免从 PATH 中读到另一份旧安装而误报成功。
    let version = detect_candidates(tool, vec![home.join(".local/bin").join(tool.binary())]);
    validate_installed_version(tool, version, target)
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
        let command = CliTool::Codex.installer_command(Path::new("/tmp/install.sh"), home, None);
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
        let error = run_logged(CliTool::Codex.name(), Command::new("sh").args(["-c", "printf 'download failed'; exit 1"]), &dir.0.join("install.log"), Duration::from_secs(5)).unwrap_err();
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

    fn available_update(version: &str) -> CliUpdate {
        CliUpdate {
            latest_version: Some(version.into()),
            state: crate::services::cli_update_service::CliUpdateState::Available,
            message: None,
        }
    }

    #[test]
    fn updates_pin_the_checked_version_in_both_official_installers() {
        let home = Path::new("/home/test user");
        let script = Path::new("/tmp/test installer.sh");
        let claude = CliTool::Claude.installer_command(script, home, Some("2.1.302"));
        let codex = CliTool::Codex.installer_command(script, home, Some("0.163.0"));
        assert_eq!(claude.get_args().collect::<Vec<_>>(), [script.as_os_str(), std::ffi::OsStr::new("2.1.302")]);
        assert_eq!(codex.get_args().collect::<Vec<_>>(), [script.as_os_str(), std::ffi::OsStr::new("--release"), std::ffi::OsStr::new("0.163.0")]);
        let variables: std::collections::HashMap<_, _> = codex.get_envs().collect();
        assert_eq!(variables[std::ffi::OsStr::new("CODEX_NON_INTERACTIVE")], Some(std::ffi::OsStr::new("1")));
        assert_eq!(variables[std::ffi::OsStr::new("CODEX_INSTALL_DIR")], Some(home.join(".local/bin").as_os_str()));
    }

    #[test]
    fn update_requires_a_checked_version_newer_than_the_actual_installation() {
        let update = available_update("0.163.0");
        assert_eq!(update_target(Some("0.162.0"), Some(&update)).unwrap(), "0.163.0");
        assert!(matches!(update_target(None, Some(&update)), Err(ApiError::BadRequest(_))));
        assert!(matches!(update_target(Some("0.162.0"), None), Err(ApiError::Conflict(_))));
        for current in ["0.163.0", "0.164.0-alpha.1", "0.162.0+dev.1"] {
            assert!(matches!(update_target(Some(current), Some(&update)), Err(ApiError::Conflict(_))), "{current}");
        }
    }

    #[test]
    fn an_unchanged_or_missing_version_cannot_be_reported_as_a_successful_update() {
        assert!(validate_installed_version(CliTool::Codex, None, Some("0.163.0")).is_err());
        let error = validate_installed_version(CliTool::Codex, Some("0.162.0".into()), Some("0.163.0")).unwrap_err();
        assert!(error.contains("0.162.0"));
        assert!(error.contains("0.163.0"));
        for version in ["0.163.0", "0.164.0"] {
            assert_eq!(validate_installed_version(CliTool::Codex, Some(version.into()), Some("0.163.0")).unwrap(), version);
        }
    }

    #[test]
    fn update_status_preserves_the_previous_version_and_reports_the_verified_result() {
        use crate::services::cli_update_service::CliUpdateState;
        let running = status_from_snapshot(Some(Operation::Update), Some("0.162.0".into()), None, Some(available_update("0.163.0")), None);
        assert_eq!(running.status, "updating");
        assert_eq!(running.version.as_deref(), Some("0.162.0"));
        let done = status_from_snapshot(None, Some("0.163.0".into()), None, Some(available_update("0.163.0")), Some("0.163.0".into()));
        assert_eq!(done.status, "installed");
        assert_eq!(done.updated_version.as_deref(), Some("0.163.0"));
        assert_eq!(done.update.unwrap().state, CliUpdateState::UpToDate);
    }

    #[test]
    fn failed_updates_keep_the_working_version_and_expose_the_error_for_retry() {
        use crate::services::cli_update_service::CliUpdateState;
        let failed = status_from_snapshot(None, Some("0.162.0".into()), Some("更新失败：下载失败".into()), Some(available_update("0.163.0")), None);
        assert_eq!(failed.status, "installed");
        assert_eq!(failed.version.as_deref(), Some("0.162.0"));
        assert_eq!(failed.message.as_deref(), Some("更新失败：下载失败"));
        assert_eq!(failed.update.unwrap().state, CliUpdateState::Available);
        assert!(failed.updated_version.is_none());
    }

}
