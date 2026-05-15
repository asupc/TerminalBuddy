import { FC, useCallback, useRef, useState } from 'react';
import { TerminalInstance } from './TerminalInstance';
import type { SplitNode } from '../types';

interface SplitPaneProps {
  node: string | SplitNode;
  activeSessionId: string | null;
  onOutput: (sessionId: string, data: string) => void;
  colorThemes: Record<string, { background: string; foreground: string }>;
  onActivate: (sessionId: string) => void;
}

export const SplitPane: FC<SplitPaneProps> = ({ node, activeSessionId, onOutput, colorThemes, onActivate }) => {
  if (typeof node === 'string') {
    const sessionId = node;
    const isActive = activeSessionId === sessionId;
    return (
      <div
        className={`split-terminal-pane ${isActive ? 'split-active' : ''}`}
        onClick={() => onActivate(sessionId)}
      >
        <TerminalInstance
          terminalId={sessionId}
          colorTheme={colorThemes[sessionId]}
          onOutput={(data) => onOutput(sessionId, data)}
        />
      </div>
    );
  }

  return <SplitNodePane node={node} activeSessionId={activeSessionId} onOutput={onOutput} colorThemes={colorThemes} onActivate={onActivate} />;
};

interface SplitNodePaneProps {
  node: SplitNode;
  activeSessionId: string | null;
  onOutput: (sessionId: string, data: string) => void;
  colorThemes: Record<string, { background: string; foreground: string }>;
  onActivate: (sessionId: string) => void;
}

const SplitNodePane: FC<SplitNodePaneProps> = ({ node, activeSessionId, onOutput, colorThemes, onActivate }) => {
  const [ratio, setRatio] = useState(node.ratio);
  const dragging = useRef(false);
  const startPos = useRef(0);
  const startRatio = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startPos.current = node.direction === 'horizontal' ? e.clientX : e.clientY;
    startRatio.current = ratio;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const size = node.direction === 'horizontal' ? rect.width : rect.height;
      const delta = (node.direction === 'horizontal' ? ev.clientX : ev.clientY) - startPos.current;
      const newRatio = Math.max(0.15, Math.min(0.85, startRatio.current + delta / size));
      setRatio(newRatio);
    };

    const handleMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [node.direction, ratio]);

  const handleDoubleClick = useCallback(() => {
    setRatio(0.5);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`split-container split-${node.direction}`}
    >
      <div className="split-pane" style={{ flex: ratio }}>
        <SplitPane
          node={node.first}
          activeSessionId={activeSessionId}
          onOutput={onOutput}
          colorThemes={colorThemes}
          onActivate={onActivate}
        />
      </div>
      <div
        className={`split-handle split-handle-${node.direction}`}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      />
      <div className="split-pane" style={{ flex: 1 - ratio }}>
        <SplitPane
          node={node.second}
          activeSessionId={activeSessionId}
          onOutput={onOutput}
          colorThemes={colorThemes}
          onActivate={onActivate}
        />
      </div>
    </div>
  );
};
