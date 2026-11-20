// 本机宿主命令与远程业务命令分开，避免远程工作区误操作 Windows 本机。
import { nativeInvoke } from './native';

export function getWindowsBuildNumber(): Promise<number> {
  return nativeInvoke('get_windows_build_number');
}

export function getDefaultTerminalStatus(): Promise<unknown> {
  return nativeInvoke('get_default_terminal_status');
}

export function syncLaunchAtLogin(): Promise<boolean> {
  return nativeInvoke('sync_launch_at_login');
}

export function showDesktopNotification(args: Record<string, unknown>): Promise<void> {
  return nativeInvoke('show_claude_code_notification', args);
}

export function readClipboardFilePaths(): Promise<string[]> {
  return nativeInvoke('read_clipboard_file_paths');
}

export async function readClipboardImageAsFile(): Promise<string> {
  const localPath = await nativeInvoke<string>('read_clipboard_image_as_file');
  const { uploadRemoteWorkspaceFiles } = await import('./native');
  const paths = await uploadRemoteWorkspaceFiles([localPath]);
  return paths[0] ?? localPath;
}

export async function saveClipboardImageToClaudeCache(): Promise<string> {
  const localPath = await nativeInvoke<string>('save_clipboard_image_to_claude_cache');
  const { uploadRemoteWorkspaceFiles } = await import('./native');
  const paths = await uploadRemoteWorkspaceFiles([localPath]);
  return paths[0] ?? localPath;
}

export async function openLocalUrl(url: string): Promise<void> {
  await nativeInvoke('open_path', { path: url });
}
