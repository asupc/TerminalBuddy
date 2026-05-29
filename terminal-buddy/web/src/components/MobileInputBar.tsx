import React, { useState, useCallback, useEffect } from 'react';

interface Props {
  onSend: (data: string) => void;
  visible: boolean;
}

const KEY_BUTTONS = [
  { key: 'ArrowUp', label: '↑' },
  { key: 'ArrowDown', label: '↓' },
  { key: 'ArrowLeft', label: '←' },
  { key: 'ArrowRight', label: '→' },
  { key: 'Tab', label: 'Tab' },
  { key: 'Esc', label: 'Esc' },
  { key: 'Enter', label: '⏎' },
];

const MobileInputBar: React.FC<Props> = ({ onSend, visible }) => {
  const [panelBottom, setPanelBottom] = useState(10);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const bottomOfVisualViewport = vv.offsetTop + vv.height;
      setPanelBottom(Math.max(window.innerHeight - bottomOfVisualViewport + 10, 10));
      const kbHeight = window.innerHeight - vv.height - vv.offsetTop;
      setPanelOpen(kbHeight > 100);
    };

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  const handleKeyBtn = useCallback((key: string) => {
    const keyMap: Record<string, string> = {
      Tab: '\t', Esc: '\x1b', Enter: '\r',
      ArrowUp: '\x1b[A', ArrowDown: '\x1b[B',
      ArrowLeft: '\x1b[D', ArrowRight: '\x1b[C',
    };
    const mapped = keyMap[key];
    if (mapped) onSend(mapped);
  }, [onSend]);

  if (!visible || !panelOpen) return null;

  return (
    <div
      onTouchStart={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
      tabIndex={-1}
      style={{
        position: 'fixed',
        bottom: panelBottom,
        left: 8, right: 8,
        display: 'flex', gap: 4, padding: '6px 8px',
        background: '#16162e', border: '1px solid #2a2a4a',
        borderRadius: 8, zIndex: 999,
      }}
    >
      {KEY_BUTTONS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          tabIndex={-1}
          onClick={() => handleKeyBtn(key)}
          onTouchStart={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
          style={{
            flex: 1, height: 38, borderRadius: 6,
            border: '1px solid #2a2a4a',
            background: '#1e1e3a',
            color: '#b0b0b0',
            fontSize: 14, fontWeight: 500,
            WebkitTapHighlightColor: 'transparent',
            userSelect: 'none', cursor: 'pointer',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

export default MobileInputBar;
