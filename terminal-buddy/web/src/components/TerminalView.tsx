import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const isWindows = /Windows/i.test(
      (navigator as any).userAgentData?.platform || navigator.userAgent || ''
    );

    const term = new Terminal({
      cursorBlink: true,
      fontSize: isMobile ? 12 : 14,
      fontFamily: "Cascadia Code, Consolas, 'Courier New', monospace",
      theme: {
        background: '#0c0c1e',
        foreground: '#e0e0e0',
      },
      allowProposedApi: true,
      ...(isWindows ? { windowsPty: { backend: 'conpty' as const, buildNumber: 22000 } } : {}),
      ...(isMobile ? { devicePixelRatio: window.devicePixelRatio } : {}),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    // Intercept Shift+Enter / Ctrl+Enter to insert newline instead of submit
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type === 'keydown' && (event.shiftKey || event.ctrlKey) && event.key === 'Enter') {
        sendInput('\r');
        term.write('\r\n');
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

    const doFit = () => {
      fitAddon.fit();
      sendResize(term.cols, term.rows);
    };

    // ResizeObserver for container size changes
    const resizeObserver = new ResizeObserver(() => {
      doFit();
    });
    resizeObserver.observe(containerRef.current);

    // Window resize fallback
    const handleResize = () => doFit();
    window.addEventListener('resize', handleResize);

    // visualViewport for mobile virtual keyboard
    let vvHandler: (() => void) | null = null;
    if (window.visualViewport) {
      vvHandler = () => doFit();
      window.visualViewport.addEventListener('resize', vvHandler);
      window.visualViewport.addEventListener('scroll', vvHandler);
    }

    // Mobile: enable touch scrolling on xterm viewport
    if (isMobile) {
      const viewport = term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
      if (viewport) {
        viewport.style.touchAction = 'pan-y';
      }
    }

    // Double-fit to ensure stable layout
    requestAnimationFrame(() => {
      doFit();
    });

    return () => {
      if (pendingRafRef.current) {
        cancelAnimationFrame(pendingRafRef.current);
        pendingRafRef.current = null;
      }
      pendingChunksRef.current.length = 0;
      outputBufferRef.current.length = 0;
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      if (vvHandler && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', vvHandler);
        window.visualViewport.removeEventListener('scroll', vvHandler);
      }
      term.dispose();
      termRef.current = null;
    };
  }, [session.id]);

  // Re-fit when visibility changes
  useEffect(() => {
    if (!hidden && termRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit();
        const term = termRef.current;
        if (term) sendResize(term.cols, term.rows);
      }, 50);
    }
  }, [hidden]);

  const handleMobileSend = useCallback((text: string) => {
    sendInput(text + '\r');
  }, [sendInput]);

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: isMobile ? 'column' : 'unset',
    }}>
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          display: 'block',
          visibility: hidden ? 'hidden' : 'visible',
          pointerEvents: hidden ? 'none' : 'auto',
          minHeight: 0,
        }}
      />
      {isMobile && <MobileInputBar onSend={handleMobileSend} visible={!hidden} />}
    </div>
  );
};

export default TerminalView;
