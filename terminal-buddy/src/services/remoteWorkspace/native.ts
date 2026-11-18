// 这些静态导入始终指向真实 Tauri 模块，不受浏览器模式的 Vite 别名影响。
import { invoke } from '@tauri-apps/api/core';
import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';

export interface RemoteConnectionInfo {
  id: string;
  name: string;
  server: string;
  username: string;
  platform: string;
  isDocker: boolean;
}

export interface RemoteWorkspaceState {
  active: boolean;
  connection: RemoteConnectionInfo | null;
}

export function nativeInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>(command, args);
}

export async function listenNative<T>(event: string, callback: (event: Event<T>) => void): Promise<UnlistenFn> {
  return listen<T>(event, callback);
}

export function getRemoteWorkspaceState(): Promise<RemoteWorkspaceState> {
  return nativeInvoke<RemoteWorkspaceState>('get_remote_workspace_state');
}

export function getRemoteWorkspaceProxy(): Promise<string> {
  return nativeInvoke<string>('get_remote_workspace_proxy');
}

export function connectRemoteWorkspace(input: {
  name?: string;
  server: string;
  username: string;
  password: string;
}): Promise<RemoteWorkspaceState> {
  return nativeInvoke('connect_remote_workspace', { input });
}

export function authenticateRemoteWorkspace(input: {
  username: string;
  password: string;
  setup?: boolean;
  confirmPassword?: string;
}): Promise<RemoteWorkspaceState> {
  return nativeInvoke('authenticate_remote_workspace', { input });
}

export function disconnectRemoteWorkspace(): Promise<void> {
  return nativeInvoke('disconnect_remote_workspace');
}

export function getRemoteWorkspaceQuickAccessUrl(): Promise<string> {
  return nativeInvoke('get_remote_workspace_quick_access_url');
}

export function uploadRemoteWorkspaceFiles(paths: string[]): Promise<string[]> {
  return nativeInvoke('upload_remote_workspace_files', { paths });
}

export function downloadRemoteWorkspaceFile(path: string, destination: string): Promise<void> {
  return nativeInvoke('download_remote_workspace_file', { path, destination });
}
