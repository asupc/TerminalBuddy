import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminal } from '../hooks/useTerminal';
import type { WebTerminalSession } from '../types';

interface Props {
  session: WebTerminalSession;
}

const TerminalView: React.FC<Props> = ({ session }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const { sendInput, sendResize } = useTerminal(session.id, {
    onOutput: (data) => {
      termRef.current?.write(data);
    },
    onExited: (code) => {
      termRef.current?.writeln(`\r\n\n[进程已退出，退出码: ${code}]`);
    },
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

    // Initial resize after terminal is ready
    setTimeout(() => {
      fitAddon.fit();
      sendResize(term.cols, term.rows);
    }, 100);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      termRef.current = null;
    };
  }, [session.id, sendInput, sendResize]);

  return (
    <div ref={containerRef} style={{ height: '100%', padding: '8px' }} />
  );
};

export default TerminalView;
