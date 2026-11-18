import { isRemoteWorkspace } from './config';

type Callback = (event: { event: string; id: number; payload: unknown }) => void;
const listeners = new Map<string, Set<Callback>>();
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;

export function emitRemoteEvent(event: string, payload: unknown): void {
  listeners.get(event)?.forEach(callback => callback({ event, id: 0, payload }));
}

function socketUrl(): string {
  const origin = new URL(window.location.href);
  origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  origin.pathname = '/__tb_remote/ws/events';
  origin.search = '';
  return origin.toString();
}

function connect(): void {
  if (socket || !isRemoteWorkspace() || listeners.size === 0) return;
  const current = new WebSocket(socketUrl());
  socket = current;
  current.onopen = () => {
    emitRemoteEvent('web-connected', null);
    emitRemoteEvent('web-resync', null);
  };
  current.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data)) as { event: string; payload: unknown };
      // 终端尺寸与输出保持同一 WebSocket 顺序，不从事件连接抢跑。
      if (message.event === 'terminal-web-resize' || message.event === 'terminal-web-takeover-ended') return;
      emitRemoteEvent(message.event, message.payload);
    } catch {
      console.warn('收到无法解析的远程服务端事件');
    }
  };
  current.onclose = () => {
    if (socket !== current) return;
    socket = null;
    if (listeners.size > 0) retry = setTimeout(connect, 1500);
  };
}

export async function listen<T>(event: string, callback: (event: { event: string; id: number; payload: T }) => void): Promise<() => void> {
  // Tauri 生命周期事件由本机窗口产生；业务事件才从远程服务端接收。
  if (event.startsWith('tauri://')) {
    const { listenNative } = await import('./native');
    return listenNative(event, callback);
  }
  let callbacks = listeners.get(event);
  if (!callbacks) {
    callbacks = new Set();
    listeners.set(event, callbacks);
  }
  const erased = callback as Callback;
  callbacks.add(erased);
  connect();
  return () => {
    callbacks?.delete(erased);
    if (callbacks?.size === 0) listeners.delete(event);
    if (listeners.size === 0) {
      clearTimeout(retry);
      const current = socket;
      socket = null;
      current?.close();
    }
  };
}
