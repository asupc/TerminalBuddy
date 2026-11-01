type EventCallback = (event: { event: string; id: number; payload: unknown }) => void;

/**
 * invoke / REST 的结构化错误：响应体 { error, message, decisionId?, replyBlockedReason? }
 * 透传为 Error 子类，429 的 Retry-After 头并入 retryAfter。
 * 桌面 Tauri 构建 reject 的是同形状的纯对象（code 字段名一致），前端可用同名谓词统一识别。
 */
export class InvokeError extends Error {
  readonly code: string;
  readonly decisionId?: string;
  readonly retryAfter?: number;
  readonly replyBlockedReason?: string;

  constructor(options: {
    code: string;
    message: string;
    decisionId?: string;
    retryAfter?: number;
    replyBlockedReason?: string;
  }) {
    super(options.message);
    this.name = 'InvokeError';
    this.code = options.code;
    if (options.decisionId !== undefined) this.decisionId = options.decisionId;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    if (options.replyBlockedReason !== undefined) this.replyBlockedReason = options.replyBlockedReason;
  }
}

export function isInvokeError(error: unknown): error is InvokeError {
  return error instanceof InvokeError;
}

const callbacks = new Map<string, Set<EventCallback>>();
// 登录态存 localStorage 而非 sessionStorage：sessionStorage 的生命周期止于标签页/窗口，
// 关掉浏览器 token 就没了，用户每次重新打开都要登录——即使后端 JWT 还有 30 天有效期。
// localStorage 则在关闭浏览器、重启服务端（签名密钥持久化在数据目录 jwt.key）后依然保留，
// 只要 JWT 没到期就能直接恢复登录。
let token = localStorage.getItem('terminalBuddy.webToken') ?? '';
let eventSocket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
export let serverPlatform = 'windows';
export let windowsBuildNumber: number | null = null;
export let dockerRuntime = false;
export let serverUsername = 'admin';

export function getToken(): string { return token; }
export function setServerPlatform(platform: string): void { serverPlatform = platform; }
export function setWindowsBuildNumber(value: number | null): void { windowsBuildNumber = value; }
export function setDockerRuntime(value: boolean): void { dockerRuntime = value; }
export function setServerUsername(value: string): void { serverUsername = value; }
export function setToken(value: string): void {
  token = value;
  if (value) localStorage.setItem('terminalBuddy.webToken', value);
  else localStorage.removeItem('terminalBuddy.webToken');
  clearTimeout(retry);
  const previous = eventSocket;
  eventSocket = null;
  previous?.close();
}

// 免密快速访问：URL 带 ?token=<jwt> 时（PC 端生成的二维码 / 快捷链接携带）直接
// 登录，随后抹掉 URL 里的 token 防泄露，与手机 SPA（web/src/App.tsx）行为一致。
// 模块加载时执行一次，赶在 WebEntry 首帧读 token 之前，避免登录页闪烁；
// 桌面 Tauri 模式同样会加载本模块（platform.ts 引用），其页面无查询串，天然无操作。
function applyUrlTokenOnce(): void {
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (!urlToken) return;
  setToken(urlToken);
  window.history.replaceState({}, '', window.location.pathname);
}

applyUrlTokenOnce();

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
    // 响应体 { error, message, decisionId?, replyBlockedReason? } 透传为结构化 Error：
    // 终端 Agent 回复闸门的 decisionId、限流的 Retry-After 不能在 shim 侧被压扁成纯文本。
    const error = await response.json().catch(() => null) as {
      error?: string;
      message?: string;
      decisionId?: string;
      replyBlockedReason?: string;
    } | null;
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter = retryAfterHeader !== null && Number.isFinite(Number(retryAfterHeader))
      ? Math.ceil(Number(retryAfterHeader))
      : undefined;
    throw new InvokeError({
      code: error?.error ?? `http_${response.status}`,
      message: error?.message ?? `请求失败：${response.status}`,
      ...(error?.decisionId !== undefined ? { decisionId: error.decisionId } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      ...(error?.replyBlockedReason !== undefined ? { replyBlockedReason: error.replyBlockedReason } : {}),
    });
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
  // 只有连接（重新）建立时才可能是服务端/容器重启，页签恢复只认这个信号；
  // 终端增删引发的 web-resync 只做对账，否则关闭最后一个会话会立刻把它重建出来。
  socket.onopen = () => {
    emitLocal('web-connected', null);
    emitLocal('web-resync', null);
  };
  socket.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data)) as { event: string; payload: unknown };
      // 尺寸事件由终端自己的 WS 按输出顺序投递，避免跨连接迟到的事件抢回宽度。
      if (message.event === 'terminal-web-resize' || message.event === 'terminal-web-takeover-ended') return;
      emitLocal(message.event, message.payload);
    } catch { console.warn('收到无法解析的服务端事件'); }
  };
  socket.onclose = () => {
    if (eventSocket !== socket) return;
    eventSocket = null;
    if (token && callbacks.size) retry = setTimeout(connectEvents, 1500);
  };
}

/**
 * 事件桥轻量 ping：向 /ws/events 发送 {"type":"ping"} 文本帧。
 * 服务端把任何客户端帧都当 activity（30 秒无消息即断开），不解析业务语义、
 * 不改动终端 WS 协议。事件桥未建立 / 非打开态时静默跳过（桌面构建恒为 no-op）。
 */
export function pingEventBridge(): void {
  if (eventSocket && eventSocket.readyState === WebSocket.OPEN) {
    eventSocket.send('{"type":"ping"}');
  }
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
