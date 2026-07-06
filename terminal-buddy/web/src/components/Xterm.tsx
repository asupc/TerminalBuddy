import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { useTerminalWs } from '../hooks/useTerminalWs';
import InputBar from './InputBar';

interface Props {
  terminalId: string;
  onStateChange?: (connected: boolean) => void;
  onExited?: () => void;
}

/**
 * xterm.js 封装 + 终端 WS。模式移植自旧 web/src/components/TerminalView.tsx：
 * - FitAddon + Unicode11Addon；初始化后立即 fit + 首帧 resize（触发后端回放历史）
 * - requestAnimationFrame 合批输出；初始化前到期的 output 先入缓冲
 * - ResizeObserver 去重发 resize（横屏/地址栏变化）
 * - ConPTY buildNumber 从 UA 解析
 * - xterm-viewport 开触摸滚动
 */
export default function Xterm({ terminalId, onStateChange, onExited }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pendingRef = useRef<string[]>([]);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef<string[]>([]);
  const onStateRef = useRef(onStateChange);
  onStateRef.current = onStateChange;
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  const flushPending = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingRef.current.length) {
      const combined = pendingRef.current.join('');
      pendingRef.current.length = 0;
      termRef.current?.write(combined);
    }
  }, []);

  const writeOutput = useCallback(
    (data: string) => {
      const term = termRef.current;
      if (!term) {
        bufRef.current.push(data);
        return;
      }
      pendingRef.current.push(data);
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const combined = pendingRef.current.join('');
          pendingRef.current.length = 0;
          termRef.current?.write(combined);
        });
      }
    },
    [],
  );

  const { sendInput, sendResize } = useTerminalWs(terminalId, {
    onOutput: writeOutput,
    onExited: () => {
      flushPending();
      termRef.current?.writeln('\r\n\n[连接已结束]');
      onExitedRef.current?.();
    },
    onConnected: () => onStateRef.current?.(true),
    onClose: () => onStateRef.current?.(false),
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const ua = (navigator as { userAgentData?: { platform?: string }; userAgent: string });
    const isWindows = /Windows/i.test(ua.userAgentData?.platform || ua.userAgent || '');
    let buildNumber: number | null = null;
    if (isWindows) {
      const m = ua.userAgent.match(/Build\/(\d+)/);
      if (m) buildNumber = parseInt(m[1], 10);
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "Cascadia Code, Consolas, 'Courier New', monospace",
      scrollback: 1000,
      theme: { background: '#0c0c1e', foreground: '#e0e0e0' },
      allowProposedApi: true,
      ...(isWindows && buildNumber
        ? { windowsPty: { backend: 'conpty' as const, buildNumber } }
        : isWindows
          ? { windowsPty: { backend: 'conpty' as const, buildNumber: 22000 } }
          : {}),
    });

    const fit = new FitAddon();
    const uni = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(uni);
    term.unicode.activeVersion = '11';
    term.open(containerRef.current);
    fit.fit();
    sendResize(term.cols, term.rows); // 首帧 resize → 触发后端回放历史输出

    let lastCols = term.cols;
    let lastRows = term.rows;
    const doFit = () => {
      if (!termRef.current || !fitRef.current) return;
      fitRef.current.fit();
      if (termRef.current.cols !== lastCols || termRef.current.rows !== lastRows) {
        lastCols = termRef.current.cols;
        lastRows = termRef.current.rows;
        sendResize(lastCols, lastRows);
      }
    };
    const ro = new ResizeObserver(() => doFit());
    ro.observe(containerRef.current);

    term.onData((d) => sendInput(d));

    termRef.current = term;
    fitRef.current = fit;

    // flush 初始化前缓冲的输出
    if (bufRef.current.length) {
      term.write(bufRef.current.join(''));
      bufRef.current.length = 0;
    }

    const viewport = term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
    if (viewport) viewport.style.touchAction = 'auto';

    return () => {
      ro.disconnect();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pendingRef.current = [];
      bufRef.current = [];
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, sendResize, sendInput, writeOutput]);

  // 地址栏/横屏变化时重新 fit（visualViewport 触发 doFit 经 ResizeObserver）
  useEffect(() => {
    const onResize = () => fitRef.current?.fit();
    window.visualViewport?.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.visualViewport?.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  return (
    <>
      <div ref={containerRef} className="xterm-container" />
      <InputBar onSend={sendInput} />
    </>
  );
}
