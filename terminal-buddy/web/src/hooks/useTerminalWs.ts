import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import { isTokenExpired, probeAuth } from '../api';

interface Callbacks {
  onOutput: (data: string) => void;
  onExited: (code: number) => void;
  onConnected?: () => void;
  onClose?: () => void;
}

const MAX_RETRIES = 5;

/**
 * 每终端一个 WebSocket。移植自旧 web/src/hooks/useTerminal.ts：
 * - 指数退避重连（2^n*1s，封顶 16s，最多 5 次）
 * - WS 未 open 时 resize 进队列，open 后 flush（首帧 resize 触发后端回放历史输出）
 * - 收到 exited 后不再重连
 * - disposedRef 防止卸载后重连
 *
 * 认证失效策略（与 useMetaWs 一致）：
 * - 建连前先查 JWT exp，已过期直接置「登录过期」终态，不发起无意义重试；
 * - 握手失败后用受控 REST 探测区分「未授权」与「暂时离线」；
 *   未授权同样立即进入过期终态，不再消耗重试次数；
 * - 重试耗尽保存 final error 终态（不再永久显示「正在重连」），
 *   由 UI 提供「重新登录」和「立即重试」入口。
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
  // 「立即重试」计数：递增时下面的 effect 依赖变化，重建连接
  const reconnectNonce = useStore((s) => s.reconnectNonce);

  const flushPendingResize = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && pendingResizeRef.current) {
      const { cols, rows } = pendingResizeRef.current;
      pendingResizeRef.current = null;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  const connect = useCallback(async () => {
    if (!terminalId || disposedRef.current) return;
    const { token, logout, setConnectionFatal } = useStore.getState();
    // 建连前检查 JWT：明确过期就不要带着死 token 重试 5 次
    if (isTokenExpired(token)) {
      setConnectionFatal({ kind: 'expired' });
      logout();
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${terminalId}?token=${token}`);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      if (wsRef.current !== ws || disposedRef.current) return;
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
      if (wsRef.current !== ws || disposedRef.current) return;
      retryRef.current = 0;
      useStore.getState().setConnectionFatal(null);
      flushPendingResize();
      cbRef.current.onConnected?.();
    };

    ws.onclose = () => {
      // An older socket can finish closing after a new StrictMode/retry connection
      // has already replaced it. It must not update state or schedule another retry.
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      cbRef.current.onClose?.();
      if (disposedRef.current || exitedRef.current) return;

      if (retryRef.current >= MAX_RETRIES) {
        // 重试耗尽：存终态，不再永久「正在重连」；UI 提供手动重试/重新登录
        useStore.getState().setConnectionFatal({
          kind: 'failed',
          message: '连接已断开，多次重试失败。请检查电脑端是否在运行。',
        });
        return;
      }
      retryRef.current += 1;
      const delay = Math.min(Math.pow(2, retryRef.current) * 1000, 16000);
      timerRef.current = setTimeout(() => {
        void connect();
      }, delay);
    };

    ws.onerror = () => {
      // onerror 不单独判定 401：认证失败在浏览器里只能靠握手结果 + REST 探测识别。
      // 这里只负责触发 onclose 走统一重连/判定路径。
      if (wsRef.current === ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    // CONNECTING 阶段就被拒绝（握手 401/403）：WebSocket 只会触发 onerror + onclose，
    // close 事件里无法区分原因。用 REST 探测做一次受控判定（不自动登出）。
    if (ws.readyState === WebSocket.CONNECTING) {
      void probeAuth().then((result) => {
        if (disposedRef.current || wsRef.current !== ws) return;
        if (result === 'unauthorized') {
          retryRef.current = MAX_RETRIES; // 阻止 onclose 再排一次重试
          useStore.getState().setConnectionFatal({ kind: 'expired' });
          useStore.getState().logout();
          ws.close();
        }
      });
    }
  }, [terminalId, flushPendingResize]);

  useEffect(() => {
    retryRef.current = 0;
    disposedRef.current = false;
    exitedRef.current = false;
    void connect();
    return () => {
      disposedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [connect, reconnectNonce]);

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
