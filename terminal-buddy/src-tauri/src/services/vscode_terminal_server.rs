use crate::runtime::AppHandle;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VsCodeTerminalSupport {
    pub available: bool,
    pub reason: String,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
}

pub struct VsCodeTerminalProcess;
impl VsCodeTerminalProcess {
    pub fn probe_support(_app: &AppHandle) -> VsCodeTerminalSupport {
        VsCodeTerminalSupport {
            available: false,
            reason: "独立服务端使用系统 PTY，无需桌面终端插件".to_string(),
            node_path: None,
            node_version: None,
        }
    }
}
