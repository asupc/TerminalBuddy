import { invoke } from '@tauri-apps/api/core';

// Settings Commands
export interface VsCodeTerminalSupport {
  available: boolean;
  reason: string;
  nodePath: string | null;
  nodeVersion: string | null;
}

/** Agent 管理中的基础启动命令；空串表示使用内置默认。 */
export interface AgentCommands {
  claude: string;
  codex: string;
}

export type AgentDownloadSource = 'npmmirror' | 'official';

export const saveAgentDownloadSource = (source: AgentDownloadSource) =>
  invoke<void>('save_agent_download_source', { source });

/** Agent 历史会话自动归档一次执行的结果（按 Agent 分类的实际归档数量）。 */
export interface AgentAutoArchiveResult {
  claude: number;
  codex: number;
  days: number;
}

export async function getBackendAppSettings(): Promise<{
  closeBehavior: 'exit' | 'tray';
  launchWindowMode: 'windowed' | 'maximized';
  terminalLoadingMode: 'default' | 'vsCode';
  dataPath: string | null;
  tabSidebarWidth: number;
  configNavWidth: number;
  fileNavWidth: number;
  enableTabNavigation: boolean;
  showTaskSummary: boolean;
  singleInstance: boolean;
  claudeHookConfigDir: string | null;
  agentCommands: AgentCommands;
  agentDownloadSource?: AgentDownloadSource;
  /** 新会话形态：true = 原生会话，false = 终端接力（默认）。 */
  nativeChatSessions?: boolean;
  /** Agent 历史会话自动归档：开启后把超过 N 天未使用的会话标记为已归档。 */
  agentAutoArchiveEnabled?: boolean;
  agentAutoArchiveDays?: number;
}> {
  return invoke('get_app_settings');
}

export async function saveAgentCommands(claude: string, codex: string): Promise<void> {
  return invoke('save_agent_commands', { claude, codex });
}

/** 新会话形态：true = 原生会话，false = 终端接力（默认）。只影响之后新建的会话。 */
export const saveNativeChatSessions = (enabled: boolean) =>
  invoke<void>('save_native_chat_sessions', { enabled });

/** 保存自动归档设置；开启时会立即按新阈值执行一次，返回实际归档数量。 */
export const saveAgentAutoArchive = (enabled: boolean, days: number) =>
  invoke<AgentAutoArchiveResult>('save_agent_auto_archive', { enabled, days });

/** 按当前设置立即执行一次自动归档。 */
export const runAgentAutoArchive = () =>
  invoke<AgentAutoArchiveResult>('run_agent_auto_archive');

export async function saveCloseBehavior(behavior: 'exit' | 'tray'): Promise<void> {
  return invoke('save_close_behavior', { behavior });
}

export async function saveLaunchWindowMode(mode: 'windowed' | 'maximized'): Promise<void> {
  return invoke('save_launch_window_mode', { mode });
}

export async function saveTerminalLoadingMode(mode: 'default' | 'vsCode'): Promise<void> {
  return invoke('save_terminal_loading_mode', { mode });
}

export async function getVsCodeTerminalSupport(): Promise<VsCodeTerminalSupport> {
  return invoke('get_vscode_terminal_support');
}

export async function acknowledgeTerminalOutput(id: string, charCount: number): Promise<void> {
  return invoke('acknowledge_terminal_output', { id, charCount });
}

export async function getTerminalLoadingMode(id: string): Promise<'default' | 'vsCode'> {
  return invoke('get_terminal_loading_mode', { id });
}

export async function getDataPath(): Promise<string> {
  return invoke('get_data_path');
}

export interface DataPathStatus {
  kind: 'default' | 'ok' | 'unavailable';
  summary: string;
}

export async function getDataPathStatus(): Promise<DataPathStatus | null> {
  return invoke('get_data_path_status');
}

export async function setDataPath(newPath: string): Promise<void> {
  return invoke('set_data_path', { newPath });
}

export async function saveTabSidebarWidth(width: number): Promise<void> {
  return invoke('save_tab_sidebar_width', { width });
}

export async function saveConfigNavWidth(width: number): Promise<void> {
  return invoke('save_config_nav_width', { width });
}

export async function saveFileNavWidth(width: number): Promise<void> {
  return invoke('save_file_nav_width', { width });
}

export async function saveEnableTabNavigation(enabled: boolean): Promise<void> {
  return invoke('save_enable_tab_navigation', { enabled });
}

export async function saveSingleInstance(enabled: boolean): Promise<void> {
  return invoke('save_single_instance', { enabled });
}

export async function saveLaunchAtLogin(enabled: boolean): Promise<void> {
  return invoke('save_launch_at_login', { enabled });
}

export async function syncLaunchAtLogin(): Promise<boolean> {
  return invoke('sync_launch_at_login');
}
