type EventCallback = (event: { event: string; id: number; payload: unknown }) => void;
const callbacks = new Map<string, Set<EventCallback>>();
let token = sessionStorage.getItem('terminalBuddy.webToken') ?? '';
let eventSocket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
export let serverPlatform = 'windows';
export let windowsBuildNumber: number | null = null;

export function getToken(): string { return token; }
export function setServerPlatform(platform: string): void { serverPlatform = platform; }
export function setWindowsBuildNumber(value: number | null): void { windowsBuildNumber = value; }
export function setToken(value: string): void {
  token = value;
  if (value) sessionStorage.setItem('terminalBuddy.webToken', value);
  else sessionStorage.removeItem('terminalBuddy.webToken');
  clearTimeout(retry);
  const previous = eventSocket;
  eventSocket = null;
  previous?.close();
}

export function emitLocal(event: string, payload: unknown): void {
  callbacks.get(event)?.forEach(callback => callback({ event, id: 0, payload }));
}

export function logout(): void {
  setToken('');
  window.dispatchEvent(new Event('terminal-buddy-auth-expired'));
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) { logout(); throw new Error('登录已过期，请重新登录'); }
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message ?? `请求失败：${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function socketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

function connectEvents(): void {
  if (!token || eventSocket || !callbacks.size) return;
  const socket = new WebSocket(socketUrl('/ws/events'));
  eventSocket = socket;
  socket.onopen = () => emitLocal('web-resync', null);
  socket.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data)) as { event: string; payload: unknown };
      emitLocal(message.event, message.payload);
    } catch { console.warn('收到无法解析的服务端事件'); }
  };
  socket.onclose = () => {
    if (eventSocket !== socket) return;
    eventSocket = null;
    if (token && callbacks.size) retry = setTimeout(connectEvents, 1500);
  };
}

export async function listen<T>(event: string, callback: (event: { event: string; id: number; payload: T }) => void): Promise<() => void> {
  let listeners = callbacks.get(event);
  if (!listeners) { listeners = new Set(); callbacks.set(event, listeners); }
  const erased = callback as EventCallback;
  listeners.add(erased);
  connectEvents();
  return () => {
    listeners?.delete(erased);
    if (!listeners?.size) callbacks.delete(event);
    if (!callbacks.size) {
      clearTimeout(retry);
      const socket = eventSocket; eventSocket = null; socket?.close();
    }
  };
}

export async function uploadFiles(files: File[]): Promise<string[]> {
  const body = new FormData();
  files.forEach(file => body.append('files', file, file.name));
  return (await request<{ paths: string[] }>('/api/desktop/upload', { method: 'POST', body })).paths;
}
