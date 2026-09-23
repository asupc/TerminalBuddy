import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { RemoteFileEntry, ServerStats } from '../../types';
import { listenTauri } from './events';

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

export interface TransferProgressEvent {
  transferId: string;
  terminalId: string;
  transferred: number;
  total: number;
  percent: number;
  direction: string;
}

export async function onTransferProgress(
  callback: (progress: TransferProgressEvent) => void
): Promise<UnlistenFn> {
  return listenTauri<TransferProgressEvent>('remote_transfer_progress', callback);
}

export interface TransferErrorEvent {
  transferId: string;
  error: string;
}

export async function onTransferError(
  callback: (error: TransferErrorEvent) => void
): Promise<UnlistenFn> {
  return listenTauri<TransferErrorEvent>('remote_transfer_error', callback);
}
