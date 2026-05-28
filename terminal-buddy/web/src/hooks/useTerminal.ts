import { useEffect, useRef, useCallback } from 'react';
import { useWebAppStore } from '../stores/appStore';

interface TerminalCallbacks {
  onOutput: (data: string) => void;
  onExited: (code: number) => void;
  onConnected?: () => void;
}

export function useTerminal(terminalId: string | null, callbacks: TerminalCallbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  // Queue the latest resize so it's sent as soon as WebSocket opens
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);

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

    const token = useWebAppStore.getState().token;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/terminal/${terminalId}?token=${token}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'output':
            callbacksRef.current.onOutput(msg.data);
            break;
          case 'exited':
            callbacksRef.current.onExited(msg.code);
            break;
          case 'error':
            callbacksRef.current.onOutput(`\r\n[错误] ${msg.message || '未知错误'}\r\n`);
            break;
        }
      } catch (e) {
        console.error('WebSocket 消息解析失败:', e);
      }
    };

    ws.onclose = () => {
      if (retryCountRef.current < 5) {
        retryCountRef.current++;
        const delay = Math.min(Math.pow(2, retryCountRef.current) * 1000, 16000);
        setTimeout(connect, delay);
      }
    };

    ws.onopen = () => {
      retryCountRef.current = 0;
      // Send any resize that was queued before WebSocket was ready
      flushPendingResize();
      callbacksRef.current.onConnected?.();
    };
  }, [terminalId, flushPendingResize]);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
    } else {
      // Queue for when WebSocket opens — TUI programs need correct dimensions
      pendingResizeRef.current = { cols, rows };
    }
  }, []);

  useEffect(() => {
    retryCountRef.current = 0;
    connect();
    return () => {
      retryCountRef.current = 99;
      wsRef.current?.close();
    };
  }, [connect]);

  return { sendInput, sendResize };
}
