import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminal } from '../hooks/useTerminal';
import type { WebTerminalSession } from '../types';

interface Props {
  session: WebTerminalSession;
  hidden?: boolean;
}

const TerminalView: React.FC<Props> = ({ session, hidden }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const handleOutput = useCallback((data: string) => {
    termRef.current?.write(data);
  }, []);

  const handleExited = useCallback((code: number) => {
    termRef.current?.writeln(`\r\n\n[进程已退出，退出码: ${code}]`);
  }, []);

  const { sendInput, sendResize } = useTerminal(session.id, {
    onOutput: handleOutput,
    onExited: handleExited,
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Cascadia Code, Consolas, 'Courier New', monospace",
      theme: {
        background: '#0c0c1e',
        foreground: '#e0e0e0',
      },
      allowProposedApi: true,
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
        return false; // prevent default xterm handling
      }
      return true;
    });

    term.onData((data) => {
      sendInput(data);
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const handleResize = () => {
      fitAddon.fit();
      sendResize(term.cols, term.rows);
    };

    window.addEventListener('resize', handleResize);

    setTimeout(() => {
      fitAddon.fit();
      sendResize(term.cols, term.rows);
    }, 100);

    return () => {
      window.removeEventListener('resize', handleResize);
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

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', padding: '8px', display: hidden ? 'none' : 'block' }}
    />
  );
};

export default TerminalView;
