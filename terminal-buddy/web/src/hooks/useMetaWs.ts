import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import type { TerminalInfo } from '../types';

/**
 * meta WebSocket：App 级单连接。
 * 连上立即收到当前会话列表；之后任意一方开/关终端，服务端推 {type:"sessions",terminals}。
 * 界面一据此实时渲染"已打开"的实例，无需轮询。
 */
export function useMetaWs() {
  const token = useStore((s) => s.token);
  const setSessions = useStore((s) => s.setSessions);
  const setMetaOnline = useStore((s) => s.setMetaOnline);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const disposedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!token) return;
    disposedRef.current = false;

    const connect = () => {
      if (disposedRef.current || !token) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/meta?token=${token}`);
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        setMetaOnline(true);
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'sessions') {
            setSessions((m.terminals as TerminalInfo[]) ?? []);
          }
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        setMetaOnline(false);
        if (!disposedRef.current && retryRef.current < 20) {
          retryRef.current += 1;
          const delay = Math.min(Math.pow(2, retryRef.current) * 500, 8000);
          timerRef.current = setTimeout(connect, delay);
        }
      };
      ws.onerror = () => {
        // 触发 onclose 走重连
        ws.close();
      };
    };

    connect();
    return () => {
      disposedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
      setMetaOnline(false);
    };
  }, [token, setSessions, setMetaOnline]);
}
