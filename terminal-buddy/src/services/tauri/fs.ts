import { invoke } from '@tauri-apps/api/core';

// File System Commands
export interface FileNode {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  lastModified: number;
}

export async function listDirectory(path: string, exclusions?: string[]): Promise<FileNode[]> {
  return invoke('list_directory', { path, exclusions: exclusions ?? null });
}

export async function openPath(path: string): Promise<void> {
  return invoke('open_path', { path });
}

// 在 Tauri WebView 中，window.open 与 target="_blank" 不会拉起系统浏览器。
// 统一走 open_path，ShellExecuteW(..., "open", https_url, ...) 在 Windows 上
// 会调用默认浏览器打开链接。
export async function openUrl(url: string): Promise<void> {
  return invoke('open_path', { path: url });
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
