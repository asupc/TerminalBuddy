import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { isTokenExpired } from '../api';
import type { TerminalInfo } from '../types';

const MAX_RETRIES = 20;

/**
 * meta WebSocket：App 级单连接。
 * 连上立即收到当前会话列表；之后任意一方开/关终端，服务端推 {type:"sessions",terminals}。
 * 界面一据此实时渲染"已打开"的实例，无需轮询。
 *
 * 与 useTerminalWs 使用同一套认证失效策略：token 过期立即登出（不再重试），
 * 其余断线按指数退避重试；重试耗尽置「连接失败」终态（UI 提供重试入口）。
 */
export function useMetaWs() {
  const token = useStore((s) => s.token);
  const setSessions = useStore((s) => s.setSessions);
  const setMetaOnline = useStore((s) => s.setMetaOnline);
  const reconnectNonce = useStore((s) => s.reconnectNonce);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const disposedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!token) return;
    // token 已过期：直接登出回登录页，不做无意义重试
    if (isTokenExpired(token)) {
      useStore.getState().setConnectionFatal({ kind: 'expired' });
      useStore.getState().logout();
      return;
    }
    disposedRef.current = false;

    const connect = () => {
      if (disposedRef.current || !useStore.getState().token) return;
      const currentToken = useStore.getState().token as string;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/meta?token=${currentToken}`);
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        useStore.getState().setConnectionFatal(null);
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
        if (disposedRef.current) return;
        // token 在连接期间被 401 处理器清掉：登出已完成，不再重试
        if (!useStore.getState().token) return;
        if (retryRef.current >= MAX_RETRIES) {
          useStore.getState().setConnectionFatal({
            kind: 'failed',
            message: '与电脑端的连接已断开，多次重连失败。请检查电脑端 TerminalBuddy 是否在运行。',
          });
          return;
        }
        retryRef.current += 1;
        const delay = Math.min(Math.pow(2, retryRef.current) * 500, 8000);
        timerRef.current = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        // 触发 onclose 走统一重连/判定路径；401 判定交给 api.ts 的 REST 401 处理器
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
  }, [token, setSessions, setMetaOnline, reconnectNonce]);
}
