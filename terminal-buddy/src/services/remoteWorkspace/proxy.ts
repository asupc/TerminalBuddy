import { emitRemoteEvent } from './event';
import { remoteProxyOrigin } from './config';
import { getRemoteWorkspaceQuickAccessUrl } from './native';
import { remoteRequest, remoteRequestUrl, remoteSocketUrl } from './http';
import {
  getDefaultTerminalStatus, getWindowsBuildNumber, openLocalUrl, readClipboardFilePaths,
  readClipboardImageAsFile, saveClipboardImageToClaudeCache, showDesktopNotification, syncLaunchAtLogin,
} from './localHost';

export { remoteRequest, remoteRequestUrl, remoteSocketUrl };

const INITIAL_RECONNECT_DELAY_MS = 1500;
const MAX_RECONNECT_DELAY_MS = 15000;
const JOB_POLL_TIMEOUT_MS = 10 * 60 * 1000;

interface TerminalConnection {
  socket: WebSocket;
  callbacks: Set<(output: string) => void>;
  rows: number;
  cols: number;
  retry?: ReturnType<typeof setTimeout>;
  backoffMs: number;
  closed: boolean;
}
const terminals = new Map<string, TerminalConnection>();

export async function subscribeRemoteTerminal(id: string, callback: (output: string) => void): Promise<() => void> {
  let connection = terminals.get(id);
  if (!connection) {
    connection = {
      socket: new WebSocket(remoteSocketUrl(`/ws/terminal/${encodeURIComponent(id)}?viewport=1&takeover=0`)),
      callbacks: new Set(), rows: 30, cols: 100, backoffMs: INITIAL_RECONNECT_DELAY_MS, closed: false,
    };
    terminals.set(id, connection);
    attach(id, connection);
  }
  connection.callbacks.add(callback);
  const current = connection;
  return () => {
    current.callbacks.delete(callback);
    if (current.callbacks.size) return;
    current.closed = true;
    clearTimeout(current.retry);
    current.socket.close();
    terminals.delete(id);
  };
}

function attach(id: string, connection: TerminalConnection): void {
  const socket = connection.socket;
  socket.onopen = () => {
    connection.backoffMs = INITIAL_RECONNECT_DELAY_MS;
    // 服务端 viewport 模式收到首条 resize 后才回放历史输出；
    // 终端初始化时尺寸可能已被去重，连接建立时必须再声明一次当前尺寸。
    socket.send(JSON.stringify({ type: 'resize', rows: connection.rows, cols: connection.cols }));
  };
  socket.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        data?: string;
        message?: string;
        rows?: number;
        cols?: number;
        takeover?: boolean;
      };
      if (message.type === 'viewport') {
        emitRemoteEvent(message.takeover ? 'terminal-web-resize' : 'terminal-web-takeover-ended',
          message.takeover ? { terminalId: id, rows: message.rows, cols: message.cols } : id);
      } else if (message.type === 'output') {
        connection.callbacks.forEach(callback => callback(message.data ?? ''));
      } else if (message.type === 'error') {
        console.error(message.message);
      } else if (message.type === 'exited') {
        connection.closed = true;
        emitRemoteEvent('terminal-closed', id);
      }
    } catch {
      console.warn('收到无法解析的远程终端消息');
    }
  };
  socket.onclose = () => {
    if (connection.closed || connection.socket !== socket || !isConnected()) return;
    const delay = connection.backoffMs;
    connection.backoffMs = Math.min(connection.backoffMs * 2, MAX_RECONNECT_DELAY_MS);
    clearTimeout(connection.retry);
    connection.retry = setTimeout(() => {
      if (connection.closed || connection.socket !== socket || !isConnected()) return;
      connection.callbacks.forEach(callback => callback('\x1bc'));
      connection.socket = new WebSocket(remoteSocketUrl(`/ws/terminal/${encodeURIComponent(id)}?viewport=1&takeover=0`));
      attach(id, connection);
    }, delay);
  };
}

function isConnected(): boolean {
  return remoteProxyOrigin().length > 0;
}

export async function remoteInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if ((command === 'read_client_data' || command === 'write_client_data') && args.key === 'saved_tabs') {
    args = { ...args, key: 'web_saved_tabs' };
  }
  const id = String(args.id ?? '');
  const connection = terminals.get(id);
  if (command === 'drain_terminal_output') return '' as T;
  if (command === 'resize_terminal' && connection) {
    connection.rows = Number(args.rows);
    connection.cols = Number(args.cols);
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify({ type: 'resize', rows: args.rows, cols: args.cols }));
    }
    return undefined as T;
  }
  if (command === 'write_to_terminal' && connection) {
    if (connection.socket.readyState !== WebSocket.OPEN) throw new Error('远程终端连接尚未恢复，请稍后输入');
    connection.socket.send(JSON.stringify({ type: 'input', data: args.data }));
    return undefined as T;
  }
  if (command === 'acknowledge_terminal_output') return undefined as T;
  if (command === 'get_web_quick_access_url') return await getRemoteWorkspaceQuickAccessUrl() as T;
  if (command === 'get_web_server_address') {
    const { getRemoteWorkspaceState } = await import('./native');
    return (await getRemoteWorkspaceState()).connection?.server as T;
  }
  if (command === 'read_clipboard_file_paths') return await readClipboardFilePaths() as T;
  if (command === 'read_clipboard_image_as_file') return await readClipboardImageAsFile() as T;
  if (command === 'save_clipboard_image_to_claude_cache') return await saveClipboardImageToClaudeCache() as T;
  if (command === 'get_windows_build_number') return await getWindowsBuildNumber() as T;
  if (command === 'get_default_terminal_status') return await getDefaultTerminalStatus() as T;
  if (command === 'sync_launch_at_login') return await syncLaunchAtLogin() as T;
  if (command === 'show_claude_code_notification') return await showDesktopNotification(args) as T;
  if (command === 'get_vscode_terminal_support') return {
    available: false, reason: '远程工作区使用服务端终端，不启用本机 VS Code 终端加载模式',
    nodePath: null, nodeVersion: null,
  } as T;
  if (command === 'open_path' && /^https?:\/\//i.test(String(args.path ?? ''))) {
    // 链接始终交给 Windows 默认浏览器，远程服务端的路径不参与。
    await openLocalUrl(String(args.path));
    return undefined as T;
  }
  if (command === 'open_in_explorer') {
    throw new Error('远程工作区没有本机资源管理器，请在左侧文件面板中浏览远程目录');
  }
  if (command === 'open_path') {
    // 远程路径属于 Linux 容器，不能用 ShellExecute 在本机打开；下载后再由本机处理。
    throw new Error('远程文件不能直接用本机程序打开，请先在文件面板中下载到本机');
  }
  if (command === 'start_blank_terminal' && ['powershell', 'pwsh', 'cmd'].includes(String(args.terminalType))) {
    const { serverPlatform } = await import('../browser/connection');
    if (serverPlatform !== 'windows') args = { ...args, terminalType: 'bash' };
  }
  const response = await remoteRequest<T | { $jobId: string }>(
    `/api/desktop/invoke/${encodeURIComponent(command)}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) },
  );
  if (response && typeof response === 'object' && '$jobId' in response) {
    const jobId = String(response.$jobId);
    const deadline = Date.now() + JOB_POLL_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error('远程后台操作等待超时，请稍后重试');
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      const job = await remoteRequest<{ status: string; value?: T; message?: string }>(`/api/desktop/jobs/${encodeURIComponent(jobId)}`);
      if (job.status === 'done') return job.value as T;
      if (job.status === 'failed') throw new Error(job.message ?? '远程后台操作失败');
    }
  }
  return response as T;
}

/** 远程文件预览地址：不携带 token，鉴权由本机代理注入。 */
export function remoteFileUrl(path: string): string {
  return remoteRequestUrl(`/api/desktop/file?${new URLSearchParams({ path })}`);
}
