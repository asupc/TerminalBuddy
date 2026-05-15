import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Profile, CustomTheme } from '../types';

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
  terminalType: 'powershell' | 'cmd'
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

export async function startBlankTerminal(terminalType: 'powershell' | 'cmd'): Promise<string> {
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

export async function listDirectory(path: string): Promise<FileNode[]> {
  return invoke('list_directory', { path });
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

// Settings Commands
export async function getBackendAppSettings(): Promise<{ closeBehavior: 'exit' | 'tray' }> {
  return invoke('get_app_settings');
}

export async function saveCloseBehavior(behavior: 'exit' | 'tray'): Promise<void> {
  return invoke('save_close_behavior', { behavior });
}

// Clipboard Commands
export async function readClipboardFilePaths(): Promise<string[]> {
  return invoke('read_clipboard_file_paths');
}
