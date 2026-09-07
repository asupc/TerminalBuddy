import { invoke } from '@tauri-apps/api/core';

// Settings Commands
export interface VsCodeTerminalSupport {
  available: boolean;
  reason: string;
  nodePath: string | null;
  nodeVersion: string | null;
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
  singleInstance: boolean;
  claudeHookConfigDir: string | null;
}> {
  return invoke('get_app_settings');
}

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
