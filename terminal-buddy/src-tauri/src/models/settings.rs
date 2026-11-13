use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehavior {
    Exit,
    Tray,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LaunchWindowMode {
    Windowed,
    Maximized,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalLoadingMode {
    Default,
    VsCode,
}

/// 默认终端开关开启前的委托注册表旧值备份（None = 当时不存在，关闭时删除恢复）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefaultTerminalBackup {
    #[serde(default)]
    pub delegation_console: Option<String>,
    #[serde(default)]
    pub delegation_terminal: Option<String>,
}

fn default_close_behavior() -> CloseBehavior {
    CloseBehavior::Exit
}

fn default_launch_window_mode() -> LaunchWindowMode {
    LaunchWindowMode::Windowed
}

fn default_terminal_loading_mode() -> TerminalLoadingMode {
    TerminalLoadingMode::Default
}

fn default_tab_sidebar_width() -> u32 {
    200
}

fn default_config_nav_width() -> u32 {
    250
}

fn default_file_nav_width() -> u32 {
    250
}

fn default_enable_tab_navigation() -> bool {
    true
}

fn default_single_instance() -> bool {
    true
}

/// Agent 版本检查与安装下载源；国内镜像通过 npm 分发官方发布的包。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentDownloadSource {
    #[default]
    Npmmirror,
    Official,
}

impl AgentDownloadSource {
    pub fn registry(self) -> &'static str {
        match self {
            Self::Npmmirror => "https://registry.npmmirror.com",
            Self::Official => "https://registry.npmjs.org",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_close_behavior")]
    pub close_behavior: CloseBehavior,
    #[serde(default = "default_launch_window_mode")]
    pub launch_window_mode: LaunchWindowMode,
    #[serde(default = "default_terminal_loading_mode")]
    pub terminal_loading_mode: TerminalLoadingMode,
    #[serde(default)]
    pub data_path: Option<String>,
    #[serde(default = "default_tab_sidebar_width")]
    pub tab_sidebar_width: u32,
    #[serde(default = "default_config_nav_width")]
    pub config_nav_width: u32,
    #[serde(default = "default_file_nav_width")]
    pub file_nav_width: u32,
    #[serde(default = "default_enable_tab_navigation")]
    pub enable_tab_navigation: bool,
    #[serde(default)]
    pub show_task_summary: bool,
    #[serde(default = "default_single_instance")]
    pub single_instance: bool,
    #[serde(default = "default_web_api_enabled")]
    pub web_api_enabled: bool,
    #[serde(default = "default_web_api_port")]
    pub web_api_port: u16,
    #[serde(default = "default_web_api_username")]
    pub web_api_username: String,
    #[serde(default = "default_web_api_password_hash")]
    pub web_api_password_hash: String,
    /// Docker 网页主页标题（浏览器标签 + 登录页大标题），空串 = 默认「TerminalBuddy」/「终端伙伴」。
    #[serde(default)]
    pub web_page_title: String,
    #[serde(default)]
    pub ssh_download_dir: Option<String>,
    #[serde(default = "default_server_monitor_interval")]
    pub server_monitor_interval: u32,
    #[serde(default)]
    pub web_api_share_sessions: bool,
    /// 新会话形态：true = 原生会话，false = 终端接力（默认）。
    /// 只影响之后新建的会话；已打开的会话保持创建时的形态。
    #[serde(default = "default_native_chat_sessions")]
    pub native_chat_sessions: bool,
    #[serde(default = "default_launch_at_login")]
    pub launch_at_login: bool,
    #[serde(default)]
    pub claude_hook_config_dir: Option<String>,
    #[serde(default)]
    pub default_terminal_enabled: bool,
    /// 开启接管时备份的旧委托值；仅在 None 时写入，保证开→关→开→关回到最初值。
    #[serde(default)]
    pub default_terminal_backup: Option<DefaultTerminalBackup>,
    /// Agent 管理中配置的 Agent 基础启动命令；空串 = 使用内置默认命令。
    #[serde(default)]
    pub agent_commands: AgentCommands,
    #[serde(default)]
    pub agent_download_source: AgentDownloadSource,
    /// Agent 历史会话自动归档：开启后把超过 N 天未使用的 Claude / Codex 会话标记为已归档。
    #[serde(default)]
    pub agent_auto_archive_enabled: bool,
    #[serde(default = "default_agent_auto_archive_days")]
    pub agent_auto_archive_days: u32,
}

/// Agent（Claude Code / Codex）的基础启动命令，供项目模型启动与历史恢复继承参数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommands {
    /// Claude Code 基础命令，默认 `claude --dangerously-skip-permissions`。
    #[serde(default)]
    pub claude: String,
    /// Codex 基础命令，默认 `codex --dangerously-bypass-approvals-and-sandbox`。
    #[serde(default)]
    pub codex: String,
}

impl Default for AgentCommands {
    fn default() -> Self {
        Self { claude: String::new(), codex: String::new() }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Exit,
            launch_window_mode: LaunchWindowMode::Windowed,
            terminal_loading_mode: TerminalLoadingMode::Default,
            data_path: None,
            tab_sidebar_width: 200,
            config_nav_width: 250,
            file_nav_width: 250,
            enable_tab_navigation: true,
            show_task_summary: false,
            single_instance: true,
            // 默认开启：浏览器模式需要经 /api/desktop/invoke 调用桌面命令。
            // 未设置密码时 HTTP 服务不会启动（should_run_http_server 要求密码非空），无暴露窗口。
            web_api_enabled: true,
            web_api_port: 9600,
            web_api_username: "admin".to_string(),
            web_api_password_hash: String::new(),
            web_page_title: String::new(),
            ssh_download_dir: None,
            server_monitor_interval: 3,
            web_api_share_sessions: false,
            native_chat_sessions: false,
            launch_at_login: false,
            claude_hook_config_dir: None,
            default_terminal_enabled: false,
            default_terminal_backup: None,
            agent_commands: AgentCommands::default(),
            agent_download_source: AgentDownloadSource::default(),
            agent_auto_archive_enabled: false,
            agent_auto_archive_days: default_agent_auto_archive_days(),
        }
    }
}

fn default_agent_auto_archive_days() -> u32 {
    30
}

fn default_web_api_enabled() -> bool {
    true
}

fn default_native_chat_sessions() -> bool {
    false
}

fn default_web_api_port() -> u16 {
    9600
}

fn default_web_api_username() -> String {
    "admin".to_string()
}

fn default_web_api_password_hash() -> String {
    String::new()
}

fn default_server_monitor_interval() -> u32 {
    3
}

fn default_launch_at_login() -> bool {
    false
}
