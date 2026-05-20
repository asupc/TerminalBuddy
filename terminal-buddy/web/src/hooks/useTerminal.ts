import { useEffect, useRef, useCallback } from 'react';
import { useWebAppStore } from '../stores/appStore';

interface TerminalCallbacks {
  onOutput: (data: string) => void;
  onExited: (code: number) => void;
}

export function useTerminal(terminalId: string | null, callbacks: TerminalCallbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

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
        if (msg.type === 'output') {
          callbacksRef.current.onOutput(msg.data);
        } else if (msg.type === 'exited') {
          callbacksRef.current.onExited(msg.code);
        }
      } catch {}
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
    };
  }, [terminalId]);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
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
