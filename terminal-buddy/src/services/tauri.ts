import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Profile, CustomTheme, Workspace } from '../types';

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
  terminalType: 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s'
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
export async function startTerminal(profileId: string): Promise<string> {
  return invoke('start_terminal', { profileId });
}

export async function startBlankTerminal(terminalType: 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s'): Promise<string> {
  return invoke('start_blank_terminal', { terminalType });
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

// Clipboard Commands
export async function readClipboardFilePaths(): Promise<string[]> {
  return invoke('read_clipboard_file_paths');
}

// History Commands
export interface HistoryEntryFE {
  command: string;
  note: string;
}

export async function getCommandHistory(): Promise<HistoryEntryFE[]> {
  return invoke('get_command_history');
}

export async function addCommandToHistory(command: string): Promise<void> {
  return invoke('add_command_to_history', { command });
}

export async function deleteCommandFromHistory(command: string): Promise<void> {
  return invoke('delete_command_from_history', { command });
}

export async function updateCommandInHistory(oldCommand: string, newCommand: string): Promise<void> {
  return invoke('update_command_in_history', { oldCommand, newCommand });
}

export async function updateCommandNote(command: string, note: string): Promise<void> {
  return invoke('update_command_note', { command, note });
}

export async function clearCommandHistory(): Promise<void> {
  return invoke('clear_command_history');
}

export async function importCommandHistory(commands: string[]): Promise<void> {
  return invoke('import_command_history', { commands });
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
