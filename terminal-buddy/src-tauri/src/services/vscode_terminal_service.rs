use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const FRAME_INPUT: u8 = 1;
const FRAME_RESIZE: u8 = 2;
const FRAME_KILL: u8 = 3;
const FRAME_ACK: u8 = 4;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchConfig<'a> {
    cols: u16,
    rows: u16,
    cwd: Option<&'a str>,
    env: std::collections::HashMap<&'a str, &'a str>,
    vs_code_version: &'static str,
}

pub struct VsCodeTerminalProcess {
    child: Child,
    stdin: ChildStdin,
    shell_pid: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VsCodeTerminalSupport {
    pub available: bool,
    pub reason: String,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeProbeResult {
    protocol: String,
    node_version: String,
    arch: String,
    node_pty_version: String,
}

impl VsCodeTerminalProcess {
    pub fn spawn(
        app: &AppHandle,
        rows: u16,
        cols: u16,
        cwd: Option<&str>,
        env_vars: &[(String, String)],
    ) -> Result<(Self, Box<dyn Read + Send>), String> {
        let host_path = resolve_plugin_host(app)?;
        let (node_path, _) = resolve_compatible_node(&host_path)?;
        let env = env_vars
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let launch_config = LaunchConfig {
            cols,
            rows,
            cwd,
            env,
            vs_code_version: "1.126.0",
        };
        let encoded_config = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&launch_config)
                .map_err(|error| format!("序列化 VS Code 终端配置失败: {}", error))?,
        );

        let mut command = Command::new(&node_path);
        command
            .arg(&host_path)
            .arg(encoded_config)
            .current_dir(
                host_path
                    .parent()
                    .ok_or("无法定位 VS Code 终端插件目录")?,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        let mut child = command.spawn().map_err(|error| {
            format!(
                "启动 VS Code 终端插件失败 ({}): {}",
                node_path.display(),
                error
            )
        })?;
        let stdin = child.stdin.take().ok_or("VS Code 终端插件 stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("VS Code 终端插件 stdout 不可用")?;
        let mut stderr = child.stderr.take();

        let (handshake_tx, handshake_rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut stdout = stdout;
            let mut handshake = [0u8; 8];
            let result = stdout
                .read_exact(&mut handshake)
                .map(|_| (stdout, handshake));
            let _ = handshake_tx.send(result);
        });
        let (stdout, handshake) = match handshake_rx.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                let details = terminate_and_collect_plugin_error(&mut child, stderr.take());
                return Err(format!("VS Code 终端插件握手失败: {}{}", error, details));
            }
            Err(_) => {
                let details = terminate_and_collect_plugin_error(&mut child, stderr.take());
                return Err(format!("VS Code 终端插件握手超时{}", details));
            }
        };
        if &handshake[..4] != b"TBP1" {
            let details = terminate_and_collect_plugin_error(&mut child, stderr.take());
            return Err(format!("VS Code 终端插件协议不匹配{}", details));
        }
        let shell_pid = u32::from_le_bytes(handshake[4..8].try_into().unwrap());
        if let Some(stderr) = stderr {
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    crate::boot_log(format!("VS Code terminal plugin: {}", line));
                }
            });
        }

        Ok((
            Self {
                child,
                stdin,
                shell_pid,
            },
            Box::new(stdout),
        ))
    }

    pub fn probe_support(app: &AppHandle) -> VsCodeTerminalSupport {
        let host_path = match resolve_plugin_host(app) {
            Ok(path) => path,
            Err(reason) => {
                return VsCodeTerminalSupport {
                    available: false,
                    reason,
                    node_path: None,
                    node_version: None,
                };
            }
        };
        match resolve_compatible_node(&host_path) {
            Ok((node_path, probe)) => VsCodeTerminalSupport {
                available: true,
                reason: format!(
                    "已检测到兼容的 Node.js {} ({})",
                    probe.node_version, probe.arch
                ),
                node_path: Some(node_path.to_string_lossy().into_owned()),
                node_version: Some(probe.node_version),
            },
            Err(reason) => VsCodeTerminalSupport {
                available: false,
                reason,
                node_path: None,
                node_version: None,
            },
        }
    }

    pub fn write_input(&mut self, data: &[u8]) -> Result<(), String> {
        self.write_frame(FRAME_INPUT, data)
    }

    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        let mut payload = [0u8; 4];
        payload[..2].copy_from_slice(&cols.to_le_bytes());
        payload[2..].copy_from_slice(&rows.to_le_bytes());
        self.write_frame(FRAME_RESIZE, &payload)
    }

    pub fn kill(&mut self) -> Result<(), String> {
        if self.write_frame(FRAME_KILL, &[]).is_err() {
            self.child
                .kill()
                .map_err(|error| format!("关闭 VS Code 终端插件失败: {}", error))?;
        }
        Ok(())
    }

    pub fn acknowledge_output(&mut self, char_count: u32) -> Result<(), String> {
        self.write_frame(FRAME_ACK, &char_count.to_le_bytes())
    }

    pub fn wait(&mut self) -> Result<(), String> {
        self.child
            .wait()
            .map(|_| ())
            .map_err(|error| format!("等待 VS Code 终端插件退出失败: {}", error))
    }

    pub fn process_id(&self) -> Option<u32> {
        Some(self.shell_pid)
    }

    fn write_frame(&mut self, frame_type: u8, payload: &[u8]) -> Result<(), String> {
        let length = u32::try_from(payload.len()).map_err(|_| "终端输入过大".to_string())?;
        self.stdin
            .write_all(&[frame_type])
            .and_then(|_| self.stdin.write_all(&length.to_le_bytes()))
            .and_then(|_| self.stdin.write_all(payload))
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("写入 VS Code 终端插件失败: {}", error))
    }
}

fn terminate_and_collect_plugin_error(
    child: &mut Child,
    stderr: Option<ChildStderr>,
) -> String {
    let _ = child.kill();
    let status = child.wait().ok();
    let mut message = String::new();
    if let Some(mut stderr) = stderr {
        let _ = stderr.read_to_string(&mut message);
    }
    let message = message.trim();
    match (status.and_then(|value| value.code()), message.is_empty()) {
        (Some(code), false) => format!("（插件退出码 {}：{}）", code, message),
        (Some(code), true) => format!("（插件退出码 {}）", code),
        (None, false) => format!("（{}）", message),
        (None, true) => String::new(),
    }
}

fn resolve_plugin_host(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("无法定位项目目录")?
            .to_path_buf();
        let host = root.join("plugins").join("vscode-terminal").join("host.cjs");
        if !host.exists() {
            return Err(format!("VS Code 终端插件不存在: {}", host.display()));
        }
        return Ok(normalize_path_for_child_process(&host));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录: {}", error))?;
    for plugin_dir in [
        resource_dir.join("vscode-terminal"),
        resource_dir.join("resources").join("vscode-terminal"),
    ] {
        let host = plugin_dir.join("host.cjs");
        if host.is_file() {
            return Ok(normalize_path_for_child_process(&host));
        }
    }
    Err("VS Code 终端插件资源不完整，请重新安装应用".to_string())
}

fn resolve_compatible_node(host_path: &Path) -> Result<(PathBuf, NodeProbeResult), String> {
    let candidates = find_node_candidates();
    if candidates.is_empty() {
        return Err(
            "未检测到 Node.js。请安装 64 位 Node.js 18 或更高版本，并重新打开设置页。"
                .to_string(),
        );
    }

    let mut failures = Vec::new();
    for node_path in candidates {
        match probe_node(&node_path, host_path) {
            Ok(probe) => return Ok((node_path, probe)),
            Err(reason) => failures.push(format!("{}：{}", node_path.display(), reason)),
        }
    }
    Err(format!(
        "检测到 Node.js，但无法加载 VS Code 终端插件。{}",
        failures.join("；")
    ))
}

fn find_node_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            candidates.push(directory.join("node.exe"));
        }
    }
    for variable in ["NVM_SYMLINK", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(variable) {
            let base = PathBuf::from(base);
            candidates.push(match variable {
                "LOCALAPPDATA" => base.join("Programs").join("nodejs").join("node.exe"),
                "ProgramFiles" => base.join("nodejs").join("node.exe"),
                _ => base.join("node.exe"),
            });
        }
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| path.is_file())
        .map(|path| normalize_path_for_child_process(&path))
        .filter(|path| seen.insert(path.to_string_lossy().to_lowercase()))
        .collect()
}

fn probe_node(node_path: &Path, host_path: &Path) -> Result<NodeProbeResult, String> {
    let mut command = Command::new(node_path);
    command
        .arg(host_path)
        .arg("--probe")
        .current_dir(
            host_path
                .parent()
                .ok_or("无法定位 VS Code 终端插件目录")?,
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|error| format!("无法启动 Node.js：{}", error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("探测进程退出码 {:?}", output.status.code())
        } else {
            stderr
        });
    }
    let probe: NodeProbeResult = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("无法解析 Node.js 探测结果：{}", error))?;
    if probe.protocol != "TBP-PROBE-1" {
        return Err("终端插件探测协议不匹配".to_string());
    }
    let major = probe
        .node_version
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or("无法识别 Node.js 版本")?;
    if major < 18 {
        return Err(format!(
            "Node.js {} 版本过低，需要 18 或更高版本",
            probe.node_version
        ));
    }
    let expected_arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        value => value,
    };
    if probe.arch != expected_arch {
        return Err(format!(
            "Node.js 架构为 {}，应用需要 {}",
            probe.arch, expected_arch
        ));
    }
    if probe.node_pty_version != "1.2.0-beta.13" {
        return Err(format!(
            "node-pty 版本为 {}，需要 1.2.0-beta.13",
            probe.node_pty_version
        ));
    }
    Ok(probe)
}

fn normalize_path_for_child_process(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        const VERBATIM_PREFIX: &[u16] = &[92, 92, 63, 92];
        const VERBATIM_UNC_PREFIX: &[u16] = &[92, 92, 63, 92, 85, 78, 67, 92];

        let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.starts_with(VERBATIM_UNC_PREFIX) {
            let normalized: Vec<u16> = [92, 92]
                .into_iter()
                .chain(wide[VERBATIM_UNC_PREFIX.len()..].iter().copied())
                .collect();
            return PathBuf::from(OsString::from_wide(&normalized));
        }
        if wide.starts_with(VERBATIM_PREFIX) {
            return PathBuf::from(OsString::from_wide(&wide[VERBATIM_PREFIX.len()..]));
        }
    }

    path.to_path_buf()
}

#[cfg(all(test, windows))]
mod tests {
    use super::normalize_path_for_child_process;
    use std::path::Path;

    #[test]
    fn normalizes_verbatim_drive_path_for_node() {
        assert_eq!(
            normalize_path_for_child_process(Path::new(
                r"\\?\C:\TerminalBuddy\resources\vscode-terminal\host.cjs"
            )),
            Path::new(r"C:\TerminalBuddy\resources\vscode-terminal\host.cjs")
        );
    }

    #[test]
    fn normalizes_verbatim_unc_path_for_node() {
        assert_eq!(
            normalize_path_for_child_process(Path::new(
                r"\\?\UNC\server\share\vscode-terminal\host.cjs"
            )),
            Path::new(r"\\server\share\vscode-terminal\host.cjs")
        );
    }
}
