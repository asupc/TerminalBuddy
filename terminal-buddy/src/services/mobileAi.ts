import { getToken, request, socketUrl } from './browser/connection';
import type { IndicatorLight } from '../utils/claudeIndicator';

export interface MobileAiMessage {
  id: string;
  role: string;
  text: string;
  createdAt: number;
}

/** 沿用安卓原生 AI 会话接口；内部线程、账号归属和密钥均不会出现在响应中。 */
export interface MobileAiSession {
  id: string;
  title: string;
  provider: string;
  projectPath: string;
  model?: string | null;
  providerName?: string | null;
  status: string;
  updatedAt: number;
  revision: number;
  resultRevision?: number;
  messages: MobileAiMessage[];
  error?: string | null;
  pendingInputs?: Array<{ text: string; requestId: string }>;
}

export interface MobileAiTerminalResume {
  sessionId: string;
  title: string;
  projectDir: string;
  provider: 'claude' | 'codex';
  providerId?: string | null;
  model?: string | null;
}

export function getMobileAiTerminalResume(id: string): Promise<MobileAiTerminalResume> {
  return request(`/api/ai/sessions/${encodeURIComponent(id)}/terminal-resume`);
}

export type MobileAiFrame =
  | { type: 'sessions'; sessions: MobileAiSession[] }
  | { type: 'session'; session: MobileAiSession }
  | { type: 'update'; session: MobileAiSession; messages: MobileAiMessage[] };

export function mobileAiRunning(status: string): boolean {
  return ['running', 'approval', 'background', 'stopping'].includes(status);
}

/** 与服务端原生会话共用状态灯的颜色和动画。 */
export function mobileAiIndicator(status: string, resultRevision = 0): IndicatorLight {
  if (status === 'approval') return 'attention';
  if (status === 'error') return 'failed';
  if (mobileAiRunning(status)) return 'running';
  if (status === 'idle' && resultRevision > 0) return 'completed';
  return 'presence';
}

export function mobileAiStatus(status: string): string {
  return ({ running: '正在回复', approval: '等待确认', background: '后台任务执行中', stopping: '正在中断',
    error: '执行失败', interrupted: '已中断', idle: '等待输入' } as Record<string, string>)[status] ?? '等待输入';
}

/** 列表和正文共用的只读订阅：WS 增量、断线重连、REST 补偿与账号切换隔离。 */
export function watchMobileAi<T>(options: {
  path: string;
  socketPath: string;
  onSnapshot: (value: T) => void;
  onFrame: (frame: MobileAiFrame) => void;
  onError: (message: string) => void;
  onConnected?: (connected: boolean) => void;
  /** 列表有应用层心跳；正文空闲时只有浏览器自动处理的协议 Ping。 */
  expectHeartbeatFrames?: boolean;
}): () => void {
  const token = getToken();
  let disposed = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let connectTimeout: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let frames = 0;
  let attempts = 0;
  let lastFrameAt = 0;
  let lastRestAt = 0;
  let connected = false;
  const current = () => !disposed && getToken() === token;

  const refresh = async () => {
    if (!current() || controller) return;
    const abort = new AbortController();
    controller = abort;
    const observedFrames = frames;
    const timeout = setTimeout(() => abort.abort(), 15000);
    lastRestAt = Date.now();
    try {
      const value = await request<T>(options.path, { signal: abort.signal });
      // REST 在途期间收到过更新时，以实时流为准，避免旧列表覆盖新建会话。
      if (current() && frames === observedFrames) options.onSnapshot(value);
    } catch (error) {
      if (current() && frames === observedFrames) options.onError(abort.signal.aborted
        ? '同步超时，正在重新连接'
        : error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
      if (controller === abort) controller = null;
    }
  };

  const connect = () => {
    if (!current() || !token || socket) return;
    const next = new WebSocket(socketUrl(options.socketPath));
    socket = next;
    // 网络切换时握手可能长期停在 CONNECTING，主动关闭后走重连与快照补偿。
    connectTimeout = setTimeout(() => {
      if (current() && socket === next && next.readyState === WebSocket.CONNECTING) next.close();
    }, 15000);
    next.onopen = () => {
      if (!current() || socket !== next) { next.close(); return; }
      clearTimeout(connectTimeout);
      connected = true;
      attempts = 0;
      lastFrameAt = Date.now();
      options.onConnected?.(true);
    };
    next.onmessage = event => {
      if (!current() || socket !== next) return;
      try {
        const frame = JSON.parse(String(event.data)) as MobileAiFrame;
        if (!['sessions', 'session', 'update'].includes(frame.type)) return;
        frames += 1;
        lastFrameAt = Date.now();
        options.onFrame(frame);
      } catch {
        options.onError('无法读取会话更新，正在重新同步');
        next.close();
      }
    };
    next.onerror = () => next.close();
    next.onclose = () => {
      if (socket !== next) return;
      clearTimeout(connectTimeout);
      socket = null;
      connected = false;
      if (!current()) return;
      options.onConnected?.(false);
      void refresh();
      retry = setTimeout(connect, Math.min(1500 * 2 ** attempts++, 15000));
    };
  };

  const visible = () => {
    if (document.visibilityState !== 'visible' || !current()) return;
    void refresh();
    if (!socket) { clearTimeout(retry); connect(); }
  };
  const reset = () => {
    disposed = true;
    clearTimeout(retry);
    clearTimeout(connectTimeout);
    controller?.abort();
    const previous = socket;
    socket = null;
    previous?.close();
  };
  const timer = setInterval(() => {
    if (!current()) return;
    if (options.expectHeartbeatFrames && connected && Date.now() - lastFrameAt > 35000) socket?.close();
    if (Date.now() - lastRestAt >= (connected ? 30000 : 5000)) void refresh();
  }, 5000);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', visible);
  window.addEventListener('terminal-buddy-auth-expired', reset);
  void refresh();
  connect();
  return () => {
    reset();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('online', visible);
    window.removeEventListener('terminal-buddy-auth-expired', reset);
  };
}
