//! Agent CLI（Claude Code / Codex）检测、安装与更新。国内源通过 npm 安装官方包，
//! 官方源保留原生安装器；版本检查与 npm 安装使用同一个 registry。
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::models::AgentDownloadSource;
use crate::services::SettingsService;
use crate::services::cli_update_service::{check_update, compare_versions, refresh_update_state, CliUpdate};

#[derive(Debug)]
pub enum AgentCliError {
    /// 任务互斥冲突（正在安装或更新），HTTP 层映射 409。
    Conflict(String),
    /// 其他失败，HTTP 层映射 400/500。
    Failure(String),
}

impl AgentCliError {
    pub fn message(&self) -> &str {
        match self {
            Self::Conflict(message) | Self::Failure(message) => message,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CliTool {
    Claude,
    Codex,
}

impl CliTool {
    pub fn binary(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn name(self) -> &'static str {
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
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Operation {
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

/// 固定顺序持有各工具锁，防止切换源与启动安装交错；不打断已开始的下载。
pub fn save_download_source(source: AgentDownloadSource) -> Result<(), String> {
    let mut states = [CliTool::Claude, CliTool::Codex].into_iter()
        .map(|tool| installation(tool).lock().map_err(|_| "工具状态不可用".to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    if states.iter().any(|state| state.operation.is_some()) {
        return Err("正在安装或更新，请等待完成后再切换下载源".into());
    }
    SettingsService::mutate_settings(|settings| settings.agent_download_source = source)?;
    for state in &mut states {
        state.update = None;
        state.error = None;
        state.updated_version = None;
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub claude: CliStatus,
    pub codex: CliStatus,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub status: &'static str,
    pub version: Option<String>,
    pub message: Option<String>,
    pub update: Option<CliUpdate>,
    pub updated_version: Option<String>,
}

fn home() -> Result<PathBuf, String> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var_os(key).map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("用户主目录未正确配置")?;
    Ok(home)
}

/// 三段式 semver（可带预发布/构建后缀），返回原始 token。
fn semver_token(value: &str) -> Option<&str> {
    let token = value.trim();
    let core = token.split(['-', '+']).next()?;
    let parts: Vec<_> = core.split('.').collect();
    (parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.parse::<u32>().is_ok()))
        .then_some(token)
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
        semver_token(version).map(str::to_string)
    })
}

fn prepare_command(command: &mut Command) {
    command.stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 后台检测与安装绝不弹出控制台窗口。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Windows 的 npm shim（.cmd/.bat/.ps1）无法被 CreateProcess 直接执行：
/// .cmd/.bat 经 cmd.exe 代理，.ps1 经 PowerShell 执行；.exe 与无扩展名入口直接运行。
fn version_command(path: &Path) -> Command {
    #[cfg(windows)]
    {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        match extension.as_deref() {
            Some("cmd") | Some("bat") => {
                let mut command = Command::new("cmd.exe");
                command.arg("/C").arg(path).arg("--version");
                command
            }
            Some("ps1") => {
                let mut command = Command::new("powershell.exe");
                command
                    .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                    .arg(path)
                    .arg("--version");
                command
            }
            _ => {
                let mut command = Command::new(path);
                command.arg("--version");
                command
            }
        }
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new(path);
        command.arg("--version");
        command
    }
}

fn stop_process(child: &mut Child) {
    // 官方安装器会启动 curl 等子进程，超时或服务退出不能留下孤儿下载任务。
    #[cfg(unix)]
    let _ = Command::new("bash")
        .args(["-c", "kill -KILL -- -\"$1\"", "cli-install", &child.id().to_string()])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &child.id().to_string()])
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
                return Err("操作超时，请检查网络后重试".into());
            }
            Err(error) => {
                stop_process(child);
                return Err(format!("读取安装进程状态失败：{error}"));
            }
        }
    }
}

/// 同一工具在 Windows 上可能以 .exe（原生 / winget）或 .cmd/.bat/.ps1（npm shim）存在。
/// 逐个生成候选文件名；Unix 只有无扩展名入口。
fn executable_names(binary: &str, windows: bool) -> Vec<String> {
    if windows {
        vec![
            format!("{binary}.exe"),
            format!("{binary}.cmd"),
            format!("{binary}.bat"),
            format!("{binary}.ps1"),
            binary.to_string(),
        ]
    } else {
        vec![binary.to_string()]
    }
}

/// 常见但不一定在当前进程 PATH 里的安装目录（winget / npm / Volta / pnpm / bun / scoop）。
#[cfg(windows)]
fn windows_install_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |dir: PathBuf| {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };
    if let Ok(appdata) = std::env::var("APPDATA") {
        push(PathBuf::from(appdata).join("npm"));
    }
    if let Ok(prefix) = std::env::var("NPM_CONFIG_PREFIX") {
        push(PathBuf::from(prefix));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        push(local.join("Microsoft/WinGet/Links"));
        push(local.join("Microsoft/WinGet/Packages"));
        push(local.join("Programs"));
        push(local.join("Volta/bin"));
        push(local.join("pnpm"));
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        let program_files = PathBuf::from(program_files);
        push(program_files.join("WinGet/Links"));
        push(program_files.join("WinGet/Packages"));
    }
    if let Ok(home) = home() {
        push(home.join("scoop/shims"));
        push(home.join(".bun/bin"));
    }
    dirs
}

/// winget 便携包会把入口放在 `Packages/<包名>/`，部分包还会再嵌一层版本目录；
/// `%LOCALAPPDATA%\Programs` 下的常规安装同理。
#[cfg(windows)]
fn package_candidates(dir: &Path, names: &[String]) -> Vec<PathBuf> {
    let Ok(packages) = fs::read_dir(dir) else { return Vec::new(); };
    let mut candidates = Vec::new();
    for package in packages.flatten() {
        let package = package.path();
        if !package.is_dir() {
            continue;
        }
        for name in names {
            candidates.push(package.join(name));
        }
        let Ok(children) = fs::read_dir(&package) else { continue; };
        for child in children.flatten() {
            let child = child.path();
            if !child.is_dir() {
                continue;
            }
            for name in names {
                candidates.push(child.join(name));
            }
        }
    }
    candidates
}

fn dedupe_paths(candidates: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    candidates.into_iter().filter(|path| seen.insert(path.clone())).collect()
}

fn candidate_paths(tool: CliTool) -> Vec<PathBuf> {
    let names = executable_names(tool.binary(), cfg!(windows));
    let mut candidates = Vec::new();
    if let Ok(home) = home() {
        candidates.extend(names.iter().map(|name| home.join(".local/bin").join(name)));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.extend(names.iter().map(|name| dir.join(name)));
        }
    }
    // npm 全局安装前缀不一定进入当前进程 PATH。
    if let Ok(prefix) = std::env::var("NPM_CONFIG_PREFIX") {
        candidates.extend(names.iter().map(|name| PathBuf::from(&prefix).join("bin").join(name)));
        candidates.extend(names.iter().map(|name| PathBuf::from(&prefix).join(name)));
    }
    // 安装器写入的目录不一定已经进入当前进程的 PATH（尤其 winget 的 WinGet\Links），
    // 因此显式补查常见安装位置与 winget 包目录。
    #[cfg(windows)]
    for dir in windows_install_dirs() {
        candidates.extend(names.iter().map(|name| dir.join(name)));
        if dir.file_name().is_some_and(|name| {
            let name = name.to_string_lossy();
            name.eq_ignore_ascii_case("Packages") || name.eq_ignore_ascii_case("Programs")
        }) {
            candidates.extend(package_candidates(&dir, &names));
        }
    }
    dedupe_paths(candidates)
}

/// 按平台规则构造某个已定位入口的命令；Windows 的 .cmd/.ps1 shim 需要代理。
pub(crate) fn executable_command(path: &Path, args: &[&str]) -> Command {
    #[cfg(windows)]
    {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        match extension.as_deref() {
            Some("cmd") | Some("bat") => {
                let mut command = Command::new("cmd.exe");
                command.arg("/C").arg(path).args(args);
                command
            }
            Some("ps1") => {
                let mut command = Command::new("powershell.exe");
                command
                    .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                    .arg(path)
                    .args(args);
                command
            }
            _ => {
                let mut command = Command::new(path);
                command.args(args);
                command
            }
        }
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new(path);
        command.args(args);
        command
    }
}

/// 定位工具入口（不执行版本检测），供模型列表等只读命令复用。
pub(crate) fn resolve_binary(tool: CliTool) -> Option<PathBuf> {
    candidate_paths(tool).into_iter().find(|path| path.is_file())
}

fn detect_cli(tool: CliTool) -> Option<String> {
    detect_candidates(tool, candidate_paths(tool))
}

fn detect_candidates(tool: CliTool, candidates: Vec<PathBuf>) -> Option<String> {
    for path in candidates.into_iter().filter(|path| path.is_file()) {
        let mut command = version_command(&path);
        prepare_command(&mut command);
        let Ok(mut child) = command.stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { continue; };
        if wait_for_child(&mut child, Duration::from_secs(5)).is_err() { continue; }
        if let Ok(output) = child.wait_with_output() {
            if let Some(version) = version_from_output(tool, &output) {
                return Some(version);
            }
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

pub fn cli_status(tool: CliTool) -> Result<CliStatus, String> {
    let (operation, previous_version, error, update, updated_version) = {
        let state = installation(tool).lock().map_err(|_| "工具状态不可用".to_string())?;
        (state.operation, state.previous_version.clone(), state.error.clone(), state.update.clone(), state.updated_version.clone())
    };
    let version = if operation.is_some() { previous_version } else { detect_cli(tool) };
    Ok(status_from_snapshot(operation, version, error, update, updated_version))
}

pub fn environment() -> Result<Environment, String> {
    Ok(Environment {
        claude: cli_status(CliTool::Claude)?,
        codex: cli_status(CliTool::Codex)?,
    })
}

pub async fn load_status(tool: CliTool, check_updates: bool) -> Result<CliStatus, AgentCliError> {
    let status = tokio::task::spawn_blocking(move || cli_status(tool)).await
        .map_err(|error| AgentCliError::Failure(error.to_string()))?
        .map_err(AgentCliError::Failure)?;
    if !check_updates { return Ok(status); }
    if matches!(status.status, "installing" | "updating") {
        return Err(AgentCliError::Conflict(format!("{} 正在安装或更新，请等待完成", tool.name())));
    }
    let source = SettingsService::get_settings().agent_download_source;
    let update = check_update(tool.package(), status.version.as_deref(), tool.preview_tags(), source.registry()).await;
    tokio::task::spawn_blocking(move || {
        {
            let mut state = installation(tool).lock().map_err(|_| "工具状态不可用".to_string())?;
            // 其他页面可能已启动更新，迟到的检查结果不能覆盖进行中的任务。
            if state.operation.is_none() && SettingsService::get_settings().agent_download_source == source {
                state.update = Some(update);
            }
        }
        cli_status(tool)
    }).await.map_err(|error| AgentCliError::Failure(error.to_string()))?
        .map_err(AgentCliError::Failure)
}

fn update_target(current: Option<&str>, update: Option<&CliUpdate>) -> Result<String, AgentCliError> {
    let current = current.ok_or_else(|| AgentCliError::Failure("工具尚未安装，请先安装".into()))?;
    let target = update.and_then(|update| update.latest_version.as_deref())
        .ok_or_else(|| AgentCliError::Conflict("请先检查更新，再重试更新".into()))?;
    if compare_versions(target, current) != Some(std::cmp::Ordering::Greater) {
        return Err(AgentCliError::Conflict("当前版本已变化或没有可用更新，请重新检查更新".into()));
    }
    Ok(target.to_string())
}

/// 触发安装或更新：后台线程执行，立即返回当前状态（HTTP 层映射 202）。
pub async fn start_operation(tool: CliTool, operation: Operation) -> Result<CliStatus, AgentCliError> {
    let (target, source) = tokio::task::spawn_blocking(move || {
        let mut state = installation(tool).lock().map_err(|_| AgentCliError::Failure("工具状态不可用".into()))?;
        if state.operation.is_some() {
            return Err(AgentCliError::Conflict(format!("{} 正在安装或更新，请等待完成", tool.name())));
        }
        let current = detect_cli(tool);
        let target = if operation == Operation::Update {
            Some(update_target(current.as_deref(), state.update.as_ref())?)
        } else { None };
        state.operation = Some(operation);
        state.previous_version = current;
        state.error = None;
        state.updated_version = None;
        Ok((target, SettingsService::get_settings().agent_download_source))
    }).await.map_err(|error| AgentCliError::Failure(error.to_string()))??;
    // HTTP 立即返回，各工具使用独立任务锁，下载与安装均在阻塞线程池中运行。
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || run_install(tool, target.as_deref(), source)).await
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
    load_status(tool, false).await
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

/// 安装日志可能来自 curl（UTF-8）、PowerShell 重定向（中文 Windows 上通常是 GBK）
/// 或 UTF-16LE；先按 BOM / NUL 分布识别编码再解码，避免中文错误信息变成乱码。
fn decode_log(bytes: &[u8]) -> String {
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        encoding_rs::UTF_16LE.decode(&bytes[2..]).0.into_owned()
    } else if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else if bytes.len() >= 8 && bytes.iter().take(256).filter(|byte| **byte == 0).count() > 64 {
        // 没有 BOM 的 UTF-16LE：ASCII 字符之间夹着大量 NUL。
        encoding_rs::UTF_16LE.decode(bytes).0.into_owned()
    } else {
        match std::str::from_utf8(bytes) {
            Ok(text) => text.to_string(),
            Err(_) => encoding_rs::GBK.decode(bytes).0.into_owned(),
        }
    };
    text.replace('\0', "").replace("\r\n", "\n").trim().to_string()
}

/// 读取日志的首尾片段：安装器的关键错误通常在开头（脚本的 Write-Error）
/// 或结尾（子进程退出前的输出），大文件不必整份读入。
fn read_log(path: &Path) -> String {
    const CHUNK: u64 = 32 * 1024;
    let Ok(mut file) = File::open(path) else { return String::new(); };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let mut bytes = Vec::new();
    if len <= CHUNK * 2 {
        let _ = file.read_to_end(&mut bytes);
    } else {
        let _ = (&mut file).take(CHUNK).read_to_end(&mut bytes);
        bytes.extend(b"\n...\n");
        if file.seek(SeekFrom::End(-(CHUNK as i64))).is_ok() {
            let mut tail = Vec::new();
            let _ = (&mut file).take(CHUNK).read_to_end(&mut tail);
            bytes.extend(&tail);
        }
    }
    decode_log(&bytes)
}

fn log_excerpt(path: &Path) -> String {
    const HEAD: usize = 1000;
    const TAIL: usize = 500;
    let text = read_log(path);
    if text.chars().count() <= HEAD + TAIL {
        return text;
    }
    let chars: Vec<char> = text.chars().collect();
    let head: String = chars[..HEAD].iter().collect();
    let tail: String = chars[chars.len() - TAIL..].iter().collect();
    format!("{head}\n…\n{tail}")
}

/// 临时目录会随 `InstallDirectory` 一起删除，失败日志先转存到数据目录，
/// 便于用户在重试前自行查看完整内容。
fn persist_install_log(name: &str, log: &Path) -> Option<PathBuf> {
    let dir = crate::services::PathService::require_data_dir().ok()?.join("logs");
    fs::create_dir_all(&dir).ok()?;
    let file_name = format!("agent-{}-install.log", name.to_ascii_lowercase().replace([' ', '/', '\\'], "-"));
    let destination = dir.join(file_name);
    fs::copy(log, &destination).ok()?;
    Some(destination)
}

fn install_failure(name: &str, reason: &str, log: &Path) -> String {
    let excerpt = log_excerpt(log);
    let saved = persist_install_log(name, log);
    let mut message = format!("{name} 安装失败（{reason}）");
    if !excerpt.is_empty() {
        message.push_str(&format!("：\n{excerpt}"));
    }
    if let Some(path) = saved {
        message.push_str(&format!("\n完整日志：{}", path.display()));
    }
    message
}

fn run_logged(name: &str, command: &mut Command, log: &Path, timeout: Duration) -> Result<(), String> {
    let file = File::create(log).map_err(|error| format!("无法创建安装日志：{error}"))?;
    prepare_command(command);
    command.stdout(file.try_clone().map_err(|error| error.to_string())?).stderr(file);
    let mut child = command.spawn().map_err(|error| format!("无法启动安装程序：{error}"))?;
    let waited = wait_for_child(&mut child, timeout);
    let status = child.wait().map_err(|error| error.to_string())?;
    if let Err(error) = waited {
        return Err(install_failure(name, &error, log));
    }
    if !status.success() {
        let code = status.code().map(|value| value.to_string()).unwrap_or_else(|| "未知".into());
        return Err(install_failure(name, &format!("退出码 {code}"), log));
    }
    Ok(())
}

fn validate_installed_version(tool: CliTool, version: Option<String>, target: Option<&str>) -> Result<String, String> {
    let version = version.ok_or_else(|| format!("安装程序已结束，但 {} 未能正常运行，请检查环境后重试", tool.name()))?;
    if let Some(target) = target {
        if !matches!(compare_versions(&version, target), Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)) {
            return Err(format!("{} 当前版本仍为 {version}，未达到目标版本 {target}，请重试", tool.name()));
        }
    }
    Ok(version)
}

pub fn run_install(tool: CliTool, target: Option<&str>, source: AgentDownloadSource) -> Result<String, String> {
    // 更新必须重新执行安装器，不能命中已安装时的快捷返回。
    if target.is_none() {
        if let Some(version) = detect_cli(tool) { return Ok(version); }
    }
    if source == AgentDownloadSource::Npmmirror {
        return run_install_npm(tool, target, source);
    }
    #[cfg(unix)]
    return run_install_unix(tool, target);
    #[cfg(windows)]
    return run_install_windows(tool, target);
}

fn npm_install_command(npm: &Path) -> Command {
    let mut command = executable_command(npm, &["install", "--global"]);
    // 不依赖宿主机 npmrc 的 registry；生命周期脚本中的 npm 同样继承所选源。
    command.args([
        // 原生包体积较大，给下载留足时间；单次请求与重试仍有明确上限。
        "--fetch-timeout=120000", "--fetch-retries=1",
        "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=3000",
        "--no-audit", "--no-fund", "--include=optional", "--engine-strict",
    ]);
    command
}

fn npm_install_prefix() -> Result<PathBuf, String> {
    #[cfg(windows)]
    { Ok(home()?.join(".local/bin")) }
    #[cfg(not(windows))]
    { Ok(home()?.join(".local/share/terminal-buddy/npm")) }
}

/// npm 包确认可运行后才替换用户入口，避免原生安装器留下的旧版本抢占 PATH。
fn activate_npm_install(tool: CliTool, prefix: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let bin = home()?.join(".local/bin");
        fs::create_dir_all(&bin).map_err(|error| format!("安装目录不可写：{error}"))?;
        let staged = bin.join(format!(".{}-{}", tool.binary(), uuid::Uuid::new_v4()));
        symlink(prefix.join("bin").join(tool.binary()), &staged)
            .map_err(|error| format!("无法创建启动入口：{error}"))?;
        if let Err(error) = fs::rename(&staged, bin.join(tool.binary())) {
            let _ = fs::remove_file(&staged);
            return Err(format!("无法更新启动入口：{error}"));
        }
    }
    #[cfg(windows)]
    {
        // 同目录的 .exe 比 npm 的 .cmd 优先。保留旧原生版备份，之后由 npm shim 启动新版。
        let native = prefix.join(format!("{}.exe", tool.binary()));
        if native.is_file() {
            let backup = prefix.join(format!(".{}-native-{}.exe.bak", tool.binary(), uuid::Uuid::new_v4()));
            fs::rename(&native, &backup).map_err(|error| format!(
                "新版已下载，但无法替换旧版入口 {}，请关闭正在运行的 {} 后重试：{error}",
                native.display(), tool.name(),
            ))?;
        }
    }
    Ok(())
}

fn run_install_npm(tool: CliTool, target: Option<&str>, source: AgentDownloadSource) -> Result<String, String> {
    let npm = npm_command()?;
    let prefix = npm_install_prefix()?;
    let dir = InstallDirectory::create(tool.binary())?;
    let log = dir.0.join("install.log");
    let mut installer = npm_install_command(&npm);
    installer.arg(npm_package(tool, target))
        .arg("--prefix").arg(&prefix)
        .arg("--registry").arg(source.registry())
        // Claude 的 postinstall 必须执行，不能跳过安装脚本。
        .arg("--ignore-scripts=false")
        .env("NPM_CONFIG_PREFIX", &prefix)
        .env("NPM_CONFIG_REGISTRY", source.registry())
        .env("npm_config_registry", source.registry());
    run_logged(tool.name(), &mut installer, &log, Duration::from_secs(600))
        .map_err(|error| format!("下载源：{}\n{error}", source.registry()))?;
    #[cfg(windows)]
    let entry = prefix.join(format!("{}.cmd", tool.binary()));
    #[cfg(not(windows))]
    let entry = prefix.join("bin").join(tool.binary());
    validate_installed_version(tool, detect_candidates(tool, vec![entry]), target)?;
    activate_npm_install(tool, &prefix)?;
    validate_installed_version(tool, detect_cli(tool), target)
}

// ==================== Unix（Docker / Linux / macOS）：官方 install.sh ====================

#[cfg(unix)]
fn run_install_unix(tool: CliTool, target: Option<&str>) -> Result<String, String> {
    let installer_url = match tool {
        CliTool::Claude => "https://claude.ai/install.sh",
        CliTool::Codex => "https://chatgpt.com/codex/install.sh",
    };
    let home = home()?;
    fs::create_dir_all(home.join(".local/bin")).map_err(|error| format!("安装目录不可写：{error}"))?;
    let dir = InstallDirectory::create(tool.binary())?;
    let script = dir.0.join("install.sh");
    let log = dir.0.join("install.log");
    run_logged(tool.name(), Command::new("curl").args([
        "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
        "--connect-timeout", "15", "--max-time", "90", "--retry", "2", "--output",
    ]).arg(&script).arg(installer_url), &log, Duration::from_secs(120))?;
    let mut installer = match tool {
        CliTool::Claude => {
            let mut command = Command::new("bash");
            command.arg(&script).arg(target.unwrap_or("stable"));
            command
        }
        CliTool::Codex => {
            let mut command = Command::new("sh");
            command.arg(&script)
                .env("CODEX_NON_INTERACTIVE", "1")
                .env("CODEX_INSTALL_DIR", home.join(".local/bin"));
            if let Some(version) = target { command.arg("--release").arg(version); }
            command
        }
    };
    run_logged(tool.name(), &mut installer, &log, Duration::from_secs(600))?;
    // 只核验安装目录中的入口，避免从 PATH 中读到另一份旧安装而误报成功。
    let version = detect_candidates(tool, vec![home.join(".local/bin").join(tool.binary())]);
    validate_installed_version(tool, version, target)
}

// ==================== Windows：install.ps1（Claude）+ npm（Codex） ====================

#[cfg(windows)]
fn run_install_windows(tool: CliTool, target: Option<&str>) -> Result<String, String> {
    let home = home()?;
    let npm_dir = std::env::var("APPDATA").map(|appdata| PathBuf::from(appdata).join("npm")).unwrap_or_else(|_| home.join("AppData/Roaming/npm"));
    match tool {
        CliTool::Claude => run_claude_install_windows(target, &home, &npm_dir),
        CliTool::Codex => run_install_npm(tool, target, AgentDownloadSource::Official),
    }
}

#[cfg(windows)]
fn run_claude_install_windows(target: Option<&str>, home: &Path, npm_dir: &Path) -> Result<String, String> {
    let dir = InstallDirectory::create("claude")?;
    let script = dir.0.join("install.ps1");
    let log = dir.0.join("install.log");
    let url = "https://claude.ai/install.ps1";
    // Win10 1803+ 自带 curl.exe；缺失时退回 PowerShell 下载。
    let mut download = Command::new("curl.exe");
    download.args(["--fail", "--silent", "--show-error", "--location", "--output"]).arg(&script).arg(url);
    if run_logged("Claude", &mut download, &log, Duration::from_secs(120)).is_err() {
        let mut fallback = Command::new("powershell.exe");
        fallback.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
            .arg(format!("Invoke-WebRequest -Uri '{url}' -OutFile '{}' -UseBasicParsing", script.display()));
        run_logged("Claude", &mut fallback, &log, Duration::from_secs(120))?;
    }
    let mut installer = Command::new("powershell.exe");
    installer.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(write_installer_wrapper(&dir.0, &script)?);
    if let Some(target) = target { installer.arg(target); }
    run_logged("Claude", &mut installer, &log, Duration::from_secs(600))?;
    // 原生安装器写入 %USERPROFILE%\.local\bin；个别环境会经 npm shim 安装，两者都核验。
    let mut candidates = vec![home.join(".local/bin/claude.exe"), home.join(".local/bin/claude.cmd")];
    candidates.extend(executable_names(CliTool::Claude.binary(), true).into_iter().map(|name| npm_dir.join(name)));
    let version = detect_candidates(CliTool::Claude, candidates);
    validate_installed_version(CliTool::Claude, version, target)
}

/// Windows PowerShell 5.1 默认可能用 TLS 1.0 访问下载服务，并按系统代码页输出日志
/// （中文系统为 GBK，读回来就是乱码）。这里包一层脚本：强制 TLS 1.2、日志用 UTF-8，
/// 并把官方 install.ps1 的退出码原样带回。包装脚本保持纯 ASCII，避免无 BOM 时被
/// 按 ANSI 代码页解析。
#[cfg(windows)]
fn write_installer_wrapper(dir: &Path, script: &Path) -> Result<PathBuf, String> {
    let wrapper = dir.join("run-installer.ps1");
    let quoted = script.display().to_string().replace('\'', "''");
    let content = format!(
        "try {{ [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 }} catch {{ }}\n\
         try {{ [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false }} catch {{ }}\n\
         try {{\n    & '{quoted}' @args\n    if ($null -ne $LASTEXITCODE) {{ exit $LASTEXITCODE }}\n    exit 0\n}} catch {{\n    Write-Error $_\n    exit 1\n}}\n"
    );
    fs::write(&wrapper, content).map_err(|error| format!("无法写入安装脚本：{error}"))?;
    Ok(wrapper)
}

#[cfg(windows)]
fn npm_command() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("npm.cmd")));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(PathBuf::from(appdata).join("npm/npm.cmd"));
    }
    candidates.into_iter().find(|path| path.is_file())
        .ok_or_else(|| "未检测到 npm，请先安装 Node.js（https://nodejs.org）后重试".to_string())
}

#[cfg(not(windows))]
fn npm_command() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("npm")));
    }
    candidates.into_iter().find(|path| path.is_file())
        .ok_or_else(|| "未检测到 npm，请先安装 Node.js（https://nodejs.org）后重试".to_string())
}

fn npm_package(tool: CliTool, target: Option<&str>) -> String {
    match target {
        Some(version) => format!("{}@{version}", tool.package()),
        None => tool.package().to_string(),
    }
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
    fn cli_installations_have_independent_locks() {
        let _claude = installation(CliTool::Claude).lock().unwrap();
        assert!(installation(CliTool::Codex).try_lock().is_ok());
    }

    #[test]
    fn windows_detection_covers_native_and_shim_entrypoints() {
        assert_eq!(
            executable_names("claude", true),
            vec!["claude.exe", "claude.cmd", "claude.bat", "claude.ps1", "claude"]
        );
        assert_eq!(executable_names("codex", false), vec!["codex"]);
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
        crate::services::PathService::set_test_data_dir(Some(dir.0.join("data")));
        let error = run_logged(CliTool::Codex.name(), Command::new("sh").args(["-c", "printf 'download failed'; exit 1"]), &dir.0.join("install.log"), Duration::from_secs(5)).unwrap_err();
        assert!(error.contains("Codex CLI 安装失败"));
        assert!(error.contains("download failed"));
        // 失败日志必须转存到数据目录，临时目录删除后仍可排查。
        assert!(error.contains("完整日志"));
        assert!(dir.0.join("data/logs/agent-codex-cli-install.log").is_file());
    }

    #[test]
    fn install_logs_survive_powershell_encodings() {
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter()
            .chain("安装失败：网络不可用".encode_utf16().flat_map(|unit| unit.to_le_bytes()))
            .collect();
        assert_eq!(decode_log(&utf16), "安装失败：网络不可用");
        // 中文 Windows 上 PowerShell 重定向输出通常是 GBK。
        assert_eq!(decode_log(&[0xB0, 0xB2, 0xD7, 0xB0, 0xCA, 0xA7, 0xB0, 0xDC]), "安装失败");
        assert_eq!(decode_log(b"plain ascii\r\n"), "plain ascii");
        let utf16_no_bom: Vec<u8> = "install.ps1".encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
        assert_eq!(decode_log(&utf16_no_bom), "install.ps1");
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
    fn update_requires_a_checked_version_newer_than_the_actual_installation() {
        let update = available_update("0.163.0");
        assert_eq!(update_target(Some("0.162.0"), Some(&update)).unwrap(), "0.163.0");
        assert!(matches!(update_target(None, Some(&update)), Err(AgentCliError::Failure(_))));
        assert!(matches!(update_target(Some("0.162.0"), None), Err(AgentCliError::Conflict(_))));
        for current in ["0.163.0", "0.164.0-alpha.1", "0.162.0+dev.1"] {
            assert!(matches!(update_target(Some(current), Some(&update)), Err(AgentCliError::Conflict(_))), "{current}");
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

    #[test]
    fn update_pins_the_checked_version_into_the_npm_package() {
        assert_eq!(npm_package(CliTool::Codex, Some("0.163.0")), "@openai/codex@0.163.0");
        assert_eq!(npm_package(CliTool::Codex, None), "@openai/codex");
        assert_eq!(npm_package(CliTool::Claude, Some("2.1.0")), "@anthropic-ai/claude-code@2.1.0");
    }
}
