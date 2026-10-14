import { emitLocal, getToken, logout, request, serverPlatform, socketUrl, uploadFiles } from './connection';

interface TerminalConnection {
  socket: WebSocket;
  callbacks: Set<(output: string) => void>;
  rows: number;
  cols: number;
  retry?: ReturnType<typeof setTimeout>;
  closed: boolean;
}
const terminals = new Map<string, TerminalConnection>();

export async function subscribeTerminal(id: string, callback: (output: string) => void): Promise<() => void> {
  let connection = terminals.get(id);
  if (!connection) {
    connection = { socket: new WebSocket(socketUrl(`/ws/terminal/${encodeURIComponent(id)}`)), callbacks: new Set(), rows: 30, cols: 100, closed: false };
    terminals.set(id, connection);
    attach(id, connection);
  }
  connection.callbacks.add(callback);
  const current = connection;
  return () => {
    current.callbacks.delete(callback);
    if (current.callbacks.size) return;
    current.closed = true; clearTimeout(current.retry); current.socket.close(); terminals.delete(id);
  };
}

function attach(id: string, connection: TerminalConnection): void {
  const socket = connection.socket;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'resize', rows: connection.rows, cols: connection.cols }));
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as { type: string; data?: string; message?: string };
    if (message.type === 'output') connection.callbacks.forEach(callback => callback(message.data ?? ''));
    if (message.type === 'error') console.error(message.message);
    if (message.type === 'exited') { connection.closed = true; emitLocal('terminal-closed', id); }
  };
  socket.onclose = () => {
    if (connection.closed || !getToken()) return;
    connection.retry = setTimeout(() => {
      // 重连时重置画面，再接收服务器滚动历史，避免显示两份输出。
      connection.callbacks.forEach(callback => callback('\x1bc'));
      connection.socket = new WebSocket(socketUrl(`/ws/terminal/${encodeURIComponent(id)}`));
      attach(id, connection);
    }, 1500);
  };
}

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if ((command === 'read_client_data' || command === 'write_client_data') && args.key === 'saved_tabs') {
    args = { ...args, key: 'web_saved_tabs' };
  }
  const id = String(args.id ?? '');
  const connection = terminals.get(id);
  if (command === 'drain_terminal_output') return '' as T; // 历史由终端 WebSocket 回放。
  if (command === 'resize_terminal' && connection) {
    connection.rows = Number(args.rows); connection.cols = Number(args.cols);
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify({ type: 'resize', rows: args.rows, cols: args.cols }));
    return undefined as T;
  }
  if (command === 'write_to_terminal' && connection) {
    if (connection.socket.readyState !== WebSocket.OPEN) throw new Error('终端连接尚未恢复，请稍后输入');
    connection.socket.send(JSON.stringify({ type: 'input', data: args.data }));
    return undefined as T;
  }
  if (command === 'acknowledge_terminal_output') return undefined as T;
  if (command === 'get_windows_build_number') return null as T;
  if (command === 'window_toggle_maximize') {
    if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen();
    return undefined as T;
  }
  if (command === 'window_exit_app' || command === 'window_close') { logout(); return undefined as T; }
  if (command === 'window_minimize') throw new Error('浏览器窗口请使用浏览器的最小化按钮');
  if (command === 'open_path' || command === 'open_in_explorer') {
    const path = String(args.path ?? '');
    if (/^https?:\/\//i.test(path)) { window.open(path, '_blank', 'noopener,noreferrer'); return undefined as T; }
    if (command === 'open_in_explorer') throw new Error('请在左侧文件面板浏览服务器目录');
    window.open(convertFileSrc(path), '_blank', 'noopener,noreferrer'); return undefined as T;
  }
  if (command === 'read_clipboard_file_paths') return [] as T;
  if (command === 'read_clipboard_image_as_file' || command === 'save_clipboard_image_to_claude_cache') {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(value => value.startsWith('image/'));
      if (!type) continue;
      const paths = await uploadFiles([new File([await item.getType(type)], '粘贴图片.png', { type })]);
      return paths[0] as T;
    }
    throw new Error('剪贴板中没有图片');
  }
  if (command === 'show_claude_code_notification') {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(String(args.customTitle ?? args.terminalName ?? '终端通知'), { body: String(args.customSummary ?? '终端状态已更新') });
    return undefined as T;
  }
  if (command === 'get_default_terminal_status') return { enabled: false, state: 'notConfigured', description: '浏览器不支持 Windows 默认终端接管', comRegistered: false, localServerRegistered: false } as T;
  if (command === 'sync_launch_at_login') return false as T;
  if (command === 'start_blank_terminal' && serverPlatform !== 'windows' && ['powershell', 'cmd'].includes(String(args.terminalType))) {
    args = { ...args, terminalType: 'bash' };
  }
  const response = await request<T | { $jobId: string }>(`/api/desktop/invoke/${encodeURIComponent(command)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  if (response && typeof response === 'object' && '$jobId' in response) {
    const jobId = String(response.$jobId);
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const job = await request<{ status: string; value?: T; message?: string }>(`/api/desktop/jobs/${encodeURIComponent(jobId)}`);
      if (job.status === 'done') return job.value as T;
      if (job.status === 'failed') throw new Error(job.message ?? '后台操作失败');
    }
  }
  return response as T;
}

export function convertFileSrc(path: string): string {
  return `/api/desktop/file?${new URLSearchParams({ path, token: getToken() })}`;
}
