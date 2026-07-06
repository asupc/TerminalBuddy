import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';

interface Callbacks {
  onOutput: (data: string) => void;
  onExited: (code: number) => void;
  onConnected?: () => void;
  onClose?: () => void;
}

/**
 * 每终端一个 WebSocket。移植自旧 web/src/hooks/useTerminal.ts：
 * - 指数退避重连（2^n*1s，封顶 16s，最多 5 次）
 * - WS 未 open 时 resize 进队列，open 后 flush（首帧 resize 触发后端回放历史输出）
 * - 收到 exited 后不再重连
 * - disposedRef 防止卸载后重连
 */
export function useTerminalWs(terminalId: string | null, cb: Callbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const disposedRef = useRef(false);
  const exitedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb;

  const flushPendingResize = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && pendingResizeRef.current) {
      const { cols, rows } = pendingResizeRef.current;
      pendingResizeRef.current = null;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  const connect = useCallback(() => {
    if (!terminalId) return;
    const token = useStore.getState().token;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${terminalId}?token=${token}`);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        switch (m.type) {
          case 'output':
            cbRef.current.onOutput(m.data);
            break;
          case 'exited':
            exitedRef.current = true;
            cbRef.current.onExited(m.code ?? 0);
            break;
          case 'error':
            cbRef.current.onOutput(`\r\n[错误] ${m.message || '未知错误'}\r\n`);
            break;
        }
      } catch {
        /* ignore */
      }
    };

    ws.onopen = () => {
      retryRef.current = 0;
      flushPendingResize();
      cbRef.current.onConnected?.();
    };

    ws.onclose = () => {
      cbRef.current.onClose?.();
      if (!disposedRef.current && !exitedRef.current && retryRef.current < 5) {
        retryRef.current += 1;
        const delay = Math.min(Math.pow(2, retryRef.current) * 1000, 16000);
        timerRef.current = setTimeout(connect, delay);
      }
    };
  }, [terminalId, flushPendingResize]);

  useEffect(() => {
    retryRef.current = 0;
    disposedRef.current = false;
    exitedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
    } else {
      pendingResizeRef.current = { cols, rows };
    }
  }, []);

  return { sendInput, sendResize };
}
