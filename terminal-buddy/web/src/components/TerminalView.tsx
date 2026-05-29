import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { useTerminal } from '../hooks/useTerminal';
import { useWebAppStore } from '../stores/appStore';
import MobileInputBar from './MobileInputBar';
import type { WebTerminalSession } from '../types';

interface Props {
  session: WebTerminalSession;
  hidden?: boolean;
}

const TerminalView: React.FC<Props> = ({ session, hidden }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pendingChunksRef = useRef<string[]>([]);
  const pendingRafRef = useRef<number | null>(null);
  const outputBufferRef = useRef<string[]>([]);
  const isMobile = useWebAppStore((s) => s.isMobile);
  const windowsBuildRef = useRef<number | null>(null);

  const handleOutput = useCallback((data: string) => {
    const term = termRef.current;
    if (!term) {
      // Buffer output until xterm.js is initialized
      outputBufferRef.current.push(data);
      return;
    }
    pendingChunksRef.current.push(data);
    if (!pendingRafRef.current) {
      pendingRafRef.current = requestAnimationFrame(() => {
        pendingRafRef.current = null;
        const combined = pendingChunksRef.current.join('');
        pendingChunksRef.current.length = 0;
        termRef.current?.write(combined);
      });
    }
  }, []);

  const handleExited = useCallback((code: number) => {
    // Flush pending output first
    if (pendingChunksRef.current.length > 0) {
      const combined = pendingChunksRef.current.join('');
      pendingChunksRef.current.length = 0;
      if (pendingRafRef.current) {
        cancelAnimationFrame(pendingRafRef.current);
        pendingRafRef.current = null;
      }
      termRef.current?.write(combined);
    }
    termRef.current?.writeln(`\r\n\n[进程已退出，退出码: ${code}]`);
  }, []);

  const { sendInput, sendResize } = useTerminal(session.id, {
    onOutput: handleOutput,
    onExited: handleExited,
    onConnected: () => {
      // Don't send resize here — the container may still be transitioning
      // (sidebar animation). ResizeObserver will fire doFit() once stable.
    },
  });

  const requestFocus = useCallback(() => {
    if (termRef.current) {
      termRef.current.focus();
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const isWindows = /Windows/i.test(
      (navigator as any).userAgentData?.platform || navigator.userAgent || ''
    );

    // Detect real Windows build number for accurate ConPTY workarounds
    if (isWindows && !windowsBuildRef.current) {
      const ua = navigator.userAgent;
      const m = ua.match(/Windows NT [\d.]+;.*?Build\/(\d+)/);
      if (m) windowsBuildRef.current = parseInt(m[1], 10);
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: isMobile ? 12 : 14,
      fontFamily: "Cascadia Code, Consolas, 'Courier New', monospace",
      theme: {
        background: '#0c0c1e',
        foreground: '#e0e0e0',
      },
      allowProposedApi: true,
      ...(isWindows && windowsBuildRef.current
        ? { windowsPty: { backend: 'conpty' as const, buildNumber: windowsBuildRef.current } }
        : isWindows
          ? { windowsPty: { backend: 'conpty' as const, buildNumber: 22000 } }
          : {}),
      ...(isMobile ? { devicePixelRatio: window.devicePixelRatio } : {}),
    });

    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = '11';
    term.open(containerRef.current);
    fitAddon.fit();
    // Send initial dimensions to PTY backend
    sendResize(term.cols, term.rows);

    // ResizeObserver: respond immediately to container size changes.
    // TUI programs need the PTY resize signal ASAP to re-render correctly.
    let lastSentCols = term.cols;
    let lastSentRows = term.rows;
    const doFit = () => {
      if (!termRef.current || !fitAddonRef.current) return;
      fitAddonRef.current.fit();
      if (termRef.current.cols !== lastSentCols || termRef.current.rows !== lastSentRows) {
        lastSentCols = termRef.current.cols;
        lastSentRows = termRef.current.rows;
        sendResize(lastSentCols, lastSentRows);
      }
    };
    const observer = new ResizeObserver(() => {
      doFit();
    });
    observer.observe(containerRef.current);

    // Intercept Shift+Enter / Ctrl+Enter to insert newline instead of submit
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type === 'keydown' && (event.shiftKey || event.ctrlKey) && event.key === 'Enter') {
        sendInput('\n');
        return false;
      }
      return true;
    });

    term.onData((data) => {
      sendInput(data);
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Flush buffered output that arrived before xterm was ready
    if (outputBufferRef.current.length > 0) {
      term.write(outputBufferRef.current.join(''));
      outputBufferRef.current.length = 0;
    }

    // Mobile: enable touch scrolling on xterm viewport
    if (isMobile) {
      const viewport = term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
      if (viewport) {
        viewport.style.touchAction = 'auto';
      }
    }

    return () => {
      observer.disconnect();
      if (pendingRafRef.current) {
        cancelAnimationFrame(pendingRafRef.current);
        pendingRafRef.current = null;
      }
      pendingChunksRef.current.length = 0;
      outputBufferRef.current.length = 0;
      term.dispose();
      termRef.current = null;
    };
  }, [session.id]);

  const handleContainerClick = useCallback(() => {
    if (isMobile) {
      requestFocus();
    }
  }, [isMobile, requestFocus]);

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
    }}>
      <div
        ref={containerRef}
        onClick={handleContainerClick}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'block',
          visibility: hidden ? 'hidden' : 'visible',
          pointerEvents: hidden ? 'none' : 'auto',
        }}
      />
      <MobileInputBar onSend={sendInput} visible={!hidden} />
    </div>
  );
};

export default TerminalView;
