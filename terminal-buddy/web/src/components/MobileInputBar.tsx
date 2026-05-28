import React, { useState, useCallback } from 'react';

interface Props {
  onSend: (data: string) => void;
  visible: boolean;
}

const KEY_BUTTONS = [
  { key: 'ArrowUp', label: '↑' },
  { key: 'ArrowDown', label: '↓' },
  { key: 'Tab', label: 'Tab' },
  { key: 'Ctrl', label: 'Ctrl' },
  { key: 'Esc', label: 'Esc' },
  { key: 'Enter', label: '⏎' },
];

const MobileInputBar: React.FC<Props> = ({ onSend, visible }) => {
  const [panelOpen, setPanelOpen] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const ctrlTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCtrlTimer = useCallback(() => {
    if (ctrlTimerRef.current) {
      clearTimeout(ctrlTimerRef.current);
      ctrlTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => () => clearCtrlTimer(), [clearCtrlTimer]);

  const handleKeyBtn = useCallback((key: string) => {
    if (key === 'Ctrl') {
      if (ctrlActive) {
        clearCtrlTimer();
        setCtrlActive(false);
      } else {
        setCtrlActive(true);
        ctrlTimerRef.current = setTimeout(() => {
          setCtrlActive(false);
          ctrlTimerRef.current = null;
        }, 5000);
      }
      return;
    }

    if (key === 'Enter' && ctrlActive) {
      onSend('\r');
      clearCtrlTimer();
      setCtrlActive(false);
      return;
    }

    if (ctrlActive) {
      if (key === 'Esc') onSend('\x1b');
      else if (key === 'Tab') onSend('\t');
      else {
        const code = key.toUpperCase().charCodeAt(0) - 64;
        onSend(String.fromCharCode(code));
      }
      clearCtrlTimer();
      setCtrlActive(false);
    } else {
      const keyMap: Record<string, string> = { Tab: '\t', Esc: '\x1b', Enter: '\r', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B' };
      const mapped = keyMap[key];
      if (mapped) onSend(mapped);
    }
  }, [ctrlActive, onSend, clearCtrlTimer]);

  if (!visible) return null;

  return (
    <>
      {/* Touch blocker when panel is open */}
      {panelOpen && (
        <div
          onTouchStart={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', inset: 0, zIndex: 998,
          }}
        />
      )}

      {/* Keys panel */}
      {panelOpen && (
        <div
          onTouchStart={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', bottom: 56, left: 8, right: 8,
            display: 'flex', gap: 4, padding: '6px 8px',
            background: '#16162e', border: '1px solid #2a2a4a',
            borderRadius: 8, zIndex: 999,
          }}
        >
          {KEY_BUTTONS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleKeyBtn(key)}
              onTouchStart={(e) => e.stopPropagation()}
              style={{
                flex: 1, height: 38, borderRadius: 6,
                border: '1px solid #2a2a4a',
                background: ctrlActive && key === 'Ctrl' ? '#6a6ad5' : '#1e1e3a',
                color: ctrlActive && key === 'Ctrl' ? '#fff' : '#b0b0b0',
                fontSize: 14, fontWeight: 500,
                WebkitTapHighlightColor: 'transparent',
                userSelect: 'none', cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* FAB */}
      <button
        onClick={() => setPanelOpen((o) => !o)}
        onTouchStart={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', bottom: 10, right: 10,
          width: 44, height: 44, borderRadius: 22,
          border: 'none',
          background: panelOpen ? '#6a6ad5' : '#2a2a4a',
          color: '#e0e0e0', fontSize: 22,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          zIndex: 1000,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        ⌨
      </button>
    </>
  );
};

export default MobileInputBar;
