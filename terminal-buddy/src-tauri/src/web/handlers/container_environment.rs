//! Docker 内的 CLI 检测、安装及系统依赖管理；仅执行固定的安装流程，不接受客户端命令或下载地址。
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

#[derive(Clone, Copy)]
enum InstallTarget {
    Cli(CliTool),
    Procps,
}

impl InstallTarget {
    fn name(self) -> &'static str {
        match self { Self::Cli(tool) => tool.name(), Self::Procps => "procps" }
    }

    fn state(self) -> &'static Mutex<Installation> {
        match self {
            Self::Cli(tool) => installation(tool),
            Self::Procps => {
                static PROCPS: OnceLock<Mutex<Installation>> = OnceLock::new();
                PROCPS.get_or_init(|| Mutex::new(Installation::default()))
            }
        }
    }

    fn run(self) -> Result<(), String> {
        match self { Self::Cli(tool) => run_install(tool), Self::Procps => run_procps_install() }
    }
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
    procps: CliStatus,
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

// 查询服务进程本身，验证 ps 确实支持 Codex 后台服务需要的进程查询参数。
fn probe_ps(command: &mut Command) -> Result<bool, String> {
    let pid = std::process::id().to_string();
    prepare_command(command);
    let mut child = match command.args(["-p", pid.as_str(), "-o", "pid=,ppid=,args="])
        .stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法运行 ps：{error}")),
    };
    wait_for_child(&mut child, Duration::from_secs(5))
        .map_err(|error| format!("ps 进程查询失败：{error}"))?;
    let output = child.wait_with_output().map_err(|error| format!("无法读取 ps 查询结果：{error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || text.split_whitespace().next() != Some(pid.as_str()) {
        return Err("ps 无法正常查询进程，请安装或修复 procps 后重新检测".into());
    }
    Ok(true)
}

fn procps_status() -> Result<CliStatus, String> {
    let (running, error) = {
        let state = InstallTarget::Procps.state().lock().map_err(|_| "安装状态不可用")?;
        (state.running, state.error.clone())
    };
    if running {
        return Ok(CliStatus { status: "installing", version: None, message: None });
    }
    let (status, message) = match probe_ps(&mut Command::new("ps")) {
        Ok(true) => ("installed", "ps 进程查询正常，Codex 后台服务可使用该依赖。".to_string()),
        Ok(false) => match error {
            Some(error) => ("failed", error),
            None => ("notInstalled", "缺少 ps 命令，Codex 后台服务无法启动，请安装 procps。".to_string()),
        },
        Err(message) => ("failed", error.unwrap_or(message)),
    };
    Ok(CliStatus { status, version: None, message: Some(message) })
}

fn environment() -> Result<Environment, String> {
    Ok(Environment {
        claude: cli_status(CliTool::Claude)?,
        codex: cli_status(CliTool::Codex)?,
        procps: procps_status()?,
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
    start_install(InstallTarget::Cli(CliTool::Claude)).await
}

pub async fn install_codex(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<(StatusCode, Json<Environment>), ApiError> {
    start_install(InstallTarget::Cli(CliTool::Codex)).await
}

pub async fn install_procps(
    State(_state): State<AppState>,
    _claims: ClaimsFromRequest,
) -> Result<(StatusCode, Json<Environment>), ApiError> {
    start_install(InstallTarget::Procps).await
}

async fn start_install(target: InstallTarget) -> Result<(StatusCode, Json<Environment>), ApiError> {
    ensure_docker()?;
    {
        let mut state = target.state().lock().map_err(|_| ApiError::Internal("安装状态不可用".into()))?;
        if state.running { return Err(ApiError::Conflict(format!("{} 正在安装，请等待完成", target.name()))); }
        state.running = true;
        state.error = None;
    }
    // HTTP 立即返回，下载和安装不占用 30 秒请求超时窗口；关闭弹框也不会打断安装。
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || target.run()).await
            .unwrap_or_else(|error| Err(format!("安装任务异常：{error}")));
        if let Ok(mut state) = target.state().lock() {
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
impl InstallDirectory {
    fn create(name: &str) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("terminal-buddy-{name}-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
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

fn run_install(tool: CliTool) -> Result<(), String> {
    if detect_cli(tool).is_some() { return Ok(()); }
    let home = home()?;
    fs::create_dir_all(home.join(".local/bin")).map_err(|error| format!("安装目录不可写：{error}"))?;
    let dir = InstallDirectory::create(tool.binary())?;
    let script = dir.0.join("install.sh");
    let log = dir.0.join("install.log");
    run_logged(tool.name(), Command::new("curl").args([
        "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
        "--connect-timeout", "15", "--max-time", "90", "--retry", "2", "--output",
    ]).arg(&script).arg(tool.installer_url()), &log, Duration::from_secs(120))?;
    run_logged(tool.name(), &mut tool.installer_command(&script, &home), &log, Duration::from_secs(600))?;
    detect_cli(tool).ok_or_else(|| format!("安装程序已结束，但 {} 未能正常运行，请检查容器环境后重试", tool.name()))?;
    Ok(())
}

fn is_container_id(value: &str) -> bool {
    (12..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn local_docker_command() -> Command {
    let mut command = Command::new("docker");
    // 系统依赖只允许安装到当前宿主机上的本容器，忽略用户选择的远程 context。
    command.args(["--host", "unix:///var/run/docker.sock"]).env_remove("DOCKER_CONTEXT");
    command
}

fn current_container_id() -> Result<String, String> {
    let mut candidates = Vec::new();
    if let Ok(hostname) = fs::read_to_string("/etc/hostname") { candidates.push(hostname.trim().to_string()); }
    if let Ok(hostname) = std::env::var("HOSTNAME") { candidates.push(hostname); }
    if let Ok(cgroup) = fs::read_to_string("/proc/self/cgroup") {
        candidates.extend(cgroup.split(|ch: char| !ch.is_ascii_hexdigit())
            .filter(|part| part.len() == 64).map(str::to_string));
    }
    // cgroup v2 可能隐藏容器 ID；hostname 的挂载源仍可标识自定义 hostname 的容器。
    if let Ok(mounts) = fs::read_to_string("/proc/self/mountinfo") {
        for line in mounts.lines().filter(|line| line.split_whitespace().nth(4) == Some("/etc/hostname")) {
            candidates.extend(line.split(|ch: char| !ch.is_ascii_hexdigit())
                .filter(|part| part.len() == 64).map(str::to_string));
        }
    }
    let mut checked = Vec::new();
    let mut failure = "无法自动识别当前容器，请使用手动安装方法。".to_string();
    for candidate in candidates.into_iter().filter(|value| is_container_id(value)) {
        if checked.contains(&candidate) { continue; }
        checked.push(candidate.clone());
        let mut command = local_docker_command();
        prepare_command(&mut command);
        let mut child = command.args(["inspect", "--type", "container", "--format", "{{.Id}}", &candidate])
            .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
            .map_err(|error| format!("无法运行 Docker 命令：{error}。请使用手动安装方法。"))?;
        wait_for_child(&mut child, Duration::from_secs(10))?;
        let output = child.wait_with_output().map_err(|error| error.to_string())?;
        let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && id.len() == 64 && is_container_id(&id) && id.starts_with(&candidate) {
            return Ok(id);
        }
        failure = format!("无法通过 Docker 访问当前容器，请确认 Docker socket 已挂载且账号有访问权限。{}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Err(failure)
}

fn procps_installer_command(container_id: &str) -> Command {
    let mut command = local_docker_command();
    command.args([
        "exec", "--user", "root", "--env", "DEBIAN_FRONTEND=noninteractive", container_id,
        // Docker exec 的客户端退出不会结束容器内进程，因此在容器内限制安装时长。
        "/usr/bin/timeout", "--kill-after=15s", "600s", "/bin/sh", "-c",
        "apt-get update && apt-get install -y --no-install-recommends procps",
    ]);
    command
}

fn run_procps_install() -> Result<(), String> {
    if probe_ps(&mut Command::new("ps")).unwrap_or(false) { return Ok(()); }
    let container_id = current_container_id()?;
    let directory = InstallDirectory::create("procps")?;
    run_logged("procps", &mut procps_installer_command(&container_id),
        &directory.0.join("install.log"), Duration::from_secs(660))?;
    if !probe_ps(&mut Command::new("ps"))? {
        return Err("安装程序已结束，但 ps 仍不可用，请检查安装日志后重试。".into());
    }
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
        assert!(InstallTarget::Procps.state().try_lock().is_ok());
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
    fn container_identity_only_accepts_docker_id_prefixes() {
        assert!(is_container_id("0e721bb56d50"));
        assert!(is_container_id(&"a".repeat(64)));
        for value in ["", "terminal-buddy", "12345678901", "../0e721bb56d50", "0e721bb56d50;id"] {
            assert!(!is_container_id(value), "{value}");
        }
        assert!(!is_container_id(&"a".repeat(65)));
    }

    #[test]
    fn procps_install_targets_the_local_container_as_root_with_a_timeout() {
        let id = "a".repeat(64);
        let command = procps_installer_command(&id);
        let arguments: Vec<_> = command.get_args().map(|arg| arg.to_str().unwrap()).collect();
        assert_eq!(arguments, vec![
            "--host", "unix:///var/run/docker.sock", "exec", "--user", "root", "--env",
            "DEBIAN_FRONTEND=noninteractive", id.as_str(), "/usr/bin/timeout", "--kill-after=15s",
            "600s", "/bin/sh", "-c", "apt-get update && apt-get install -y --no-install-recommends procps",
        ]);
        assert!(command.get_envs().any(|(key, value)| key == std::ffi::OsStr::new("DOCKER_CONTEXT") && value.is_none()));
    }

    #[test]
    fn ps_probe_reports_a_missing_binary() {
        let missing = std::env::temp_dir().join(format!("missing-ps-{}", uuid::Uuid::new_v4()));
        assert!(!probe_ps(&mut Command::new(missing)).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn ps_probe_requires_a_successful_query_for_the_server_pid() {
        use std::os::unix::fs::PermissionsExt;
        let dir = InstallDirectory(std::env::temp_dir().join(format!("ps-detection-test-{}", uuid::Uuid::new_v4())));
        fs::create_dir(&dir.0).unwrap();
        let arguments = "#!/bin/sh\n[ \"$1\" = '-p' ] && [ \"$3\" = '-o' ] && [ \"$4\" = 'pid=,ppid=,args=' ] || exit 1\n";
        for (name, query, available) in [
            ("working", "printf '%s 1 terminal-buddy-server\\n' \"$2\"\n", true),
            ("failed", "printf '%s 1 terminal-buddy-server\\n' \"$2\"\nexit 1\n", false),
            ("wrong-pid", "printf '0 1 terminal-buddy-server\\n'\n", false),
        ] {
            let path = dir.0.join(name);
            fs::write(&path, format!("{arguments}{query}")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            let result = probe_ps(&mut Command::new(path));
            if available { assert!(result.unwrap()); } else { assert!(result.is_err()); }
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
