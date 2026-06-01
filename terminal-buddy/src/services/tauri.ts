import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Profile, CustomTheme, Workspace, RemoteFileEntry, ServerStats } from '../types';

// Profile Commands
export async function getAllProfiles(): Promise<Profile[]> {
  return invoke('get_all_profiles');
}

export async function getProfile(id: string): Promise<Profile> {
  return invoke('get_profile', { id });
}

export async function createProfile(
  name: string,
  group: string,
  terminalType: 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor' | 'mstsc'
): Promise<Profile> {
  return invoke('create_profile', { name, group, terminalType });
}

export async function updateProfile(profile: Profile): Promise<void> {
  return invoke('update_profile', { profile });
}

export async function deleteProfile(id: string): Promise<void> {
  return invoke('delete_profile', { id });
}

export async function updateProfileLastUsed(id: string): Promise<void> {
  return invoke('update_profile_last_used', { id });
}

export async function exportAllProfiles(path: string): Promise<void> {
  return invoke('export_all_profiles', { path });
}

export async function importAllProfiles(path: string): Promise<Profile[]> {
  return invoke('import_all_profiles', { path });
}

// Terminal Commands
export async function startTerminal(profileId: string, extraStartupParams?: string, initialRows?: number, initialCols?: number): Promise<string> {
  return invoke('start_terminal', { profileId, extraStartupParams: extraStartupParams || null, initialRows: initialRows || 0, initialCols: initialCols || 0 });
}

export async function startMstsc(profileId: string): Promise<void> {
  return invoke('start_mstsc', { profileId });
}

export async function startBlankTerminal(terminalType: 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor' | 'mstsc', initialRows?: number, initialCols?: number): Promise<string> {
  return invoke('start_blank_terminal', { terminalType, initialRows: initialRows || 0, initialCols: initialCols || 0 });
}

export async function writeToTerminal(id: string, data: string): Promise<void> {
  return invoke('write_to_terminal', { id, data });
}

export async function resizeTerminal(
  id: string,
  rows: number,
  cols: number
): Promise<void> {
  return invoke('resize_terminal', { id, rows, cols });
}

export async function closeTerminal(id: string): Promise<void> {
  return invoke('close_terminal', { id });
}

export async function drainTerminalOutput(id: string): Promise<string> {
  return invoke('drain_terminal_output', { id });
}

// Events
export async function onTerminalOutput(
  terminalId: string,
  callback: (output: string) => void
): Promise<UnlistenFn> {
  return listen(`terminal_output_${terminalId}`, (event) => {
    callback(event.payload as string);
  });
}

// File System Commands
export interface FileNode {
  name: string;
  path: string;
  is_directory: boolean;
}

export async function listDirectory(path: string, exclusions?: string[]): Promise<FileNode[]> {
  return invoke('list_directory', { path, exclusions: exclusions ?? null });
}

export async function openPath(path: string): Promise<void> {
  return invoke('open_path', { path });
}

export async function openInExplorer(path: string): Promise<void> {
  return invoke('open_in_explorer', { path });
}

export async function deletePath(path: string): Promise<void> {
  return invoke('delete_path', { path });
}

export async function renamePath(path: string, newName: string): Promise<void> {
  return invoke('rename_path', { path, newName });
}

export const readFileContent = (path: string) => invoke<string>('read_file_content', { path });
export const writeFileContent = (path: string, content: string) => invoke<boolean>('write_file_content', { path, content });
export const getFileSize = (path: string) => invoke<number>('get_file_size', { path });
export const getFileMeta = (path: string) => invoke<{ lastModified: number; size: number }>('get_file_meta', { path });

// Theme Commands
export async function getAllThemes(): Promise<CustomTheme[]> {
  return invoke('get_all_themes');
}

export async function createTheme(name: string): Promise<CustomTheme> {
  return invoke('create_theme', { name });
}

export async function updateTheme(theme: CustomTheme): Promise<void> {
  return invoke('update_theme', { theme });
}

export async function deleteTheme(id: string): Promise<void> {
  return invoke('delete_theme', { id });
}

// Workspace Commands
export async function getAllWorkspaces(): Promise<Workspace[]> {
  return invoke('get_all_workspaces');
}

export async function getWorkspace(id: string): Promise<Workspace> {
  return invoke('get_workspace', { id });
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return invoke('create_workspace', { name });
}

export async function updateWorkspace(workspace: Workspace): Promise<void> {
  return invoke('update_workspace', { workspace });
}

export async function deleteWorkspace(id: string): Promise<void> {
  return invoke('delete_workspace', { id });
}

// Settings Commands
export async function getBackendAppSettings(): Promise<{
  closeBehavior: 'exit' | 'tray';
  dataPath: string | null;
  tabSidebarWidth: number;
  enableTabNavigation: boolean;
  singleInstance: boolean;
}> {
  return invoke('get_app_settings');
}

export async function saveCloseBehavior(behavior: 'exit' | 'tray'): Promise<void> {
  return invoke('save_close_behavior', { behavior });
}

export async function getDataPath(): Promise<string> {
  return invoke('get_data_path');
}

export async function setDataPath(newPath: string): Promise<void> {
  return invoke('set_data_path', { newPath });
}

export async function saveTabSidebarWidth(width: number): Promise<void> {
  return invoke('save_tab_sidebar_width', { width });
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

// Clipboard Commands
export async function readClipboardFilePaths(): Promise<string[]> {
  return invoke('read_clipboard_file_paths');
}

export async function readClipboardImageAsFile(): Promise<string> {
  return invoke('read_clipboard_image_as_file');
}

// Template Commands
export async function getCommandTemplates(): Promise<string> {
  return invoke('get_command_templates');
}

export async function saveCommandTemplates(content: string): Promise<void> {
  return invoke('save_command_templates', { content });
}

export async function initCommandTemplates(defaultContent: string): Promise<boolean> {
  return invoke('init_command_templates', { defaultContent });
}

// System Commands
let _windowsBuildNumber: number | null | undefined = undefined;

export async function getWindowsBuildNumber(): Promise<number | null> {
  if (_windowsBuildNumber !== undefined) return _windowsBuildNumber;
  try {
    _windowsBuildNumber = await invoke<number>('get_windows_build_number');
  } catch {
    _windowsBuildNumber = null;
  }
  return _windowsBuildNumber;
}

// Window Commands (bypass ACL bug)
export async function windowMinimize(): Promise<void> {
  return invoke('window_minimize');
}

export async function windowToggleMaximize(): Promise<void> {
  return invoke('window_toggle_maximize');
}

export async function windowClose(): Promise<void> {
  return invoke('window_close');
}

export async function windowExitApp(): Promise<void> {
  return invoke('window_exit_app');
}

// Full Data Import/Export
export async function exportAllData(filePath: string): Promise<void> {
  return invoke('export_all_data', { filePath });
}

export async function importAllData(filePath: string): Promise<void> {
  return invoke('import_all_data', { filePath });
}

// Web API Commands
export async function saveWebApiSettings(
  enabled: boolean,
  port: number,
  username: string,
  password: string,
  shareSessions: boolean
): Promise<void> {
  return invoke('save_web_api_settings', { enabled, port, username, password, shareSessions });
}

export async function getWebApiStatus(): Promise<{
  enabled: boolean;
  port: number;
  username: string;
  hasPassword: boolean;
}> {
  return invoke('get_web_api_status');
}

export async function restartWebServer(): Promise<string> {
  return invoke('restart_web_server');
}

export async function getWebServerAddress(): Promise<string> {
  return invoke('get_web_server_address');
}

// Client Data Commands
export async function readClientData(key: string): Promise<string | null> {
  return invoke<string | null>('read_client_data', { key });
}

export async function writeClientData(key: string, content: string): Promise<void> {
  return invoke('write_client_data', { key, content });
}

// SSH Settings Commands
export async function getDownloadsDirectory(): Promise<string> {
  return invoke('get_downloads_directory');
}

export async function saveSshDownloadDir(dir: string): Promise<void> {
  return invoke('save_ssh_download_dir', { dir });
}

export async function saveServerMonitorInterval(interval: number): Promise<void> {
  return invoke('save_server_monitor_interval', { interval });
}

export async function saveWebApiShareSessions(enabled: boolean): Promise<void> {
  return invoke('save_web_api_share_sessions', { enabled });
}

// ============ SSH Remote File Commands ============

export async function connectSshSession(terminalId: string, profileId: string): Promise<void> {
  return invoke('connect_ssh_session', { terminalId, profileId });
}

export async function getSshHomeDir(terminalId: string): Promise<string> {
  return invoke('get_ssh_home_dir', { terminalId });
}

export async function getSshTempDirectory(): Promise<string> {
  return invoke('get_ssh_temp_directory');
}

export async function ensureDir(path: string): Promise<void> {
  return invoke('ensure_dir', { path });
}

export async function remoteListDir(terminalId: string, path: string): Promise<RemoteFileEntry[]> {
  return invoke('remote_list_dir', { terminalId, path });
}

export async function remoteCreateDir(terminalId: string, path: string): Promise<void> {
  return invoke('remote_create_dir', { terminalId, path });
}

export async function remoteCreateFile(terminalId: string, path: string): Promise<void> {
  return invoke('remote_create_file', { terminalId, path });
}

export async function remoteRemove(terminalId: string, path: string, isDir: boolean): Promise<void> {
  return invoke('remote_remove', { terminalId, path, isDir });
}

export async function remoteRename(terminalId: string, from: string, to: string): Promise<void> {
  return invoke('remote_rename', { terminalId, from, to });
}

export async function remoteMove(terminalId: string, from: string, to: string): Promise<void> {
  return invoke('remote_move', { terminalId, from, to });
}

export async function remoteCopy(terminalId: string, from: string, to: string): Promise<void> {
  return invoke('remote_copy', { terminalId, from, to });
}

export async function remoteChmod(terminalId: string, path: string, mode: number): Promise<void> {
  return invoke('remote_chmod', { terminalId, path, mode });
}

export async function remoteUpload(terminalId: string, localPath: string, remotePath: string, transferId: string, profileId: string): Promise<void> {
  return invoke('remote_upload', { terminalId, localPath, remotePath, transferId, profileId });
}

export async function remoteDownload(terminalId: string, remotePath: string, localPath: string, transferId: string, profileId: string): Promise<void> {
  return invoke('remote_download', { terminalId, remotePath, localPath, transferId, profileId });
}

export async function remoteDownloadDir(terminalId: string, remotePath: string, localPath: string, transferId: string, profileId: string): Promise<void> {
  return invoke('remote_download_dir', { terminalId, remotePath, localPath, transferId, profileId });
}

export async function getServerStats(terminalId: string): Promise<ServerStats> {
  return invoke('get_server_stats', { terminalId });
}

export async function onTransferProgress(
  callback: (progress: { transferId: string; terminalId: string; transferred: number; total: number; percent: number; direction: string }) => void
): Promise<UnlistenFn> {
  return listen('remote_transfer_progress', (event) => {
    callback(event.payload as any);
  });
}

export async function onTransferError(
  callback: (error: { transferId: string; error: string }) => void
): Promise<UnlistenFn> {
  return listen('remote_transfer_error', (event) => {
    callback(event.payload as any);
  });
}
