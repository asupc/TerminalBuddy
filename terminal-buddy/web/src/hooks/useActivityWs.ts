import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { isTokenExpired } from '../api';

const MAX_RETRIES = 20;
/** running/attention 超过该时长无新事件即视为过期（对齐 PC 端活动到期思路）。 */
const ACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;

/** 服务端 /ws/events 的 hook 事件 payload（claude_hook_handler emit_terminal_event）。 */
interface HookEventPayload {
  terminalId: string;
  phase: string;
  occurredAt: number;
}

/**
 * 活动 WebSocket：订阅 /ws/events 的 `claude-hook-terminal-event`，驱动手机端会话呼吸灯。
 * 与 meta WS 分离：断线只影响呼吸灯，不影响会话列表；手机后台杀连接后回前台立即重连。
 * running/attention 超过 3 分钟无更新自动降级为静态色，避免假呼吸灯常亮。
 */
export function useActivityWs() {
  const token = useStore((s) => s.token);
  const reconnectNonce = useStore((s) => s.reconnectNonce);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const disposedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!token) return;
    if (isTokenExpired(token)) return; // meta WS 已负责登出，这里直接不连
    disposedRef.current = false;

    const connect = () => {
      if (disposedRef.current || !useStore.getState().token) return;
      const currentToken = useStore.getState().token as string;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/events?token=${currentToken}`);
      wsRef.current = ws;

      ws.onmessage = (e) => {
        try {
          const message = JSON.parse(e.data) as { event: string; payload: HookEventPayload };
          if (message.event !== 'claude-hook-terminal-event') return;
          const payload = message.payload;
          if (!payload?.terminalId) return;
          if (payload.phase === 'ended') {
            useStore.getState().clearTerminalActivity(payload.terminalId);
          } else {
            useStore.getState().applyTerminalActivity(payload.terminalId, payload.phase, payload.occurredAt);
          }
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        if (disposedRef.current) return;
        if (!useStore.getState().token) return;
        if (retryRef.current >= MAX_RETRIES) return; // 呼吸灯是弱依赖：静默放弃，meta WS 的终态提示已覆盖
        retryRef.current += 1;
        const delay = Math.min(Math.pow(2, retryRef.current) * 500, 8000);
        timerRef.current = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    // 手机切后台浏览器会挂起/杀掉 WS；回前台若连接已死立即重连。
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
      retryRef.current = 0;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
      connect();
    };
    document.addEventListener('visibilitychange', onVisible);

    // 过期活动清理：事件驱动之外兜底，防止 running 卡亮。
    const pruneTimer = window.setInterval(() => {
      useStore.getState().pruneExpiredActivities(ACTIVITY_TIMEOUT_MS);
    }, 30_000);

    return () => {
      disposedRef.current = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(pruneTimer);
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [token, reconnectNonce]);
}
