import React, { useState, useRef, useCallback, useEffect } from 'react';

const HISTORY_KEY = 'terminalbuddy_cmd_history';
const MAX_HISTORY = 50;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory(history: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {}
}

interface Props {
  onSend: (data: string) => void;
  visible: boolean;
}

const MobileInputBar: React.FC<Props> = ({ onSend, visible }) => {
  const [value, setValue] = useState('');
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [ctrlActive, setCtrlActive] = useState(false);
  const historyRef = useRef(loadHistory());
  const draftRef = useRef('');
  const ctrlTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleSubmit = useCallback(() => {
    if (!value) {
      // Empty input = send carriage return (Enter key)
      onSend('\r');
      return;
    }
    const text = value.trim();
    if (!text) return;
    onSend(text);
    // Save to history
    const history = historyRef.current.filter((h) => h !== text);
    history.unshift(text);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    historyRef.current = history;
    saveHistory(history);
    setValue('');
    setHistoryIdx(-1);
    draftRef.current = '';
  }, [value, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      handleSubmit();
      return;
    }
    const history = historyRef.current;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      if (historyIdx === -1) {
        draftRef.current = value;
      }
      const next = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(next);
      setValue(history[next]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx === -1) return;
      const prev = historyIdx - 1;
      if (prev === -1) {
        setHistoryIdx(-1);
        setValue(draftRef.current);
      } else {
        setHistoryIdx(prev);
        setValue(history[prev]);
      }
      return;
    }
  }, [value, historyIdx, handleSubmit]);

  useEffect(() => {
    return () => {
      if (ctrlTimerRef.current) {
        clearTimeout(ctrlTimerRef.current);
        ctrlTimerRef.current = null;
      }
    };
  }, []);

  const handleKeyBtn = useCallback((key: string) => {
    const history = historyRef.current;

    if (key === 'ArrowUp') {
      if (history.length === 0) return;
      if (historyIdx === -1) {
        draftRef.current = value;
      }
      const next = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(next);
      setValue(history[next]);
      return;
    }

    if (key === 'ArrowDown') {
      if (historyIdx === -1) return;
      const prev = historyIdx - 1;
      if (prev === -1) {
        setHistoryIdx(-1);
        setValue(draftRef.current);
      } else {
        setHistoryIdx(prev);
        setValue(history[prev]);
      }
      return;
    }

    if (key === 'Ctrl') {
      if (ctrlActive) {
        if (ctrlTimerRef.current) {
          clearTimeout(ctrlTimerRef.current);
          ctrlTimerRef.current = null;
        }
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

    if (key === 'Enter') {
      if (ctrlActive) {
        onSend('\r');
        if (ctrlTimerRef.current) {
          clearTimeout(ctrlTimerRef.current);
          ctrlTimerRef.current = null;
        }
        setCtrlActive(false);
      } else {
        handleSubmit();
      }
      return;
    }

    // Other keys: Ctrl+combo or raw character
    if (ctrlActive) {
      if (key === 'Esc') {
        onSend('\x1b');
      } else if (key === 'Tab') {
        onSend('\t');
      } else {
        const code = key.toUpperCase().charCodeAt(0) - 64;
        onSend(String.fromCharCode(code));
      }
      if (ctrlTimerRef.current) {
        clearTimeout(ctrlTimerRef.current);
        ctrlTimerRef.current = null;
      }
      setCtrlActive(false);
    } else {
      const keyMap: Record<string, string> = { Tab: '\t', Esc: '\x1b' };
      const mapped = keyMap[key];
      if (mapped) onSend(mapped);
    }
  }, [ctrlActive, historyIdx, value, onSend, handleSubmit]);

  if (!visible) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      {/* Row 1: Input */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 8px', background: '#16162e',
      }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入命令..."
          style={{
            flex: 1, background: '#12122a', border: '1px solid #2a2a4a',
            borderRadius: 6, color: '#e0e0e0', padding: '8px 10px',
            fontSize: 14, outline: 'none',
          }}
        />
        <button
          onClick={handleSubmit}
          style={{
            width: 36, height: 36, borderRadius: 6, border: 'none',
            background: '#6a6ad5', color: '#fff', fontSize: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          ↑
        </button>
      </div>
      {/* Row 2: Special keys */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '3px 8px 3px', background: '#16162e',
        borderTop: '1px solid #2a2a4a',
      }}>
        {[
          { key: 'ArrowUp', label: '↑' },
          { key: 'ArrowDown', label: '↓' },
          { key: 'Tab', label: 'Tab' },
          { key: 'Ctrl', label: 'Ctrl' },
          { key: 'Esc', label: 'Esc' },
          { key: 'Enter', label: '⏎' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => handleKeyBtn(key)}
            style={{
              flex: 1, height: 30, borderRadius: 4,
              border: '1px solid #2a2a4a',
              background: ctrlActive && key === 'Ctrl' ? '#6a6ad5' : '#1e1e3a',
              color: ctrlActive && key === 'Ctrl' ? '#fff' : '#b0b0b0',
              fontSize: 13, fontWeight: 500,
              WebkitTapHighlightColor: 'transparent',
              userSelect: 'none', cursor: 'pointer',
              transition: 'opacity 0.1s',
            }}
            onMouseDown={(e) => (e.currentTarget.style.opacity = '0.7')}
            onMouseUp={(e) => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
            onTouchStart={(e) => (e.currentTarget.style.opacity = '0.7')}
            onTouchEnd={(e) => (e.currentTarget.style.opacity = '1')}
            onTouchCancel={(e) => (e.currentTarget.style.opacity = '1')}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MobileInputBar;
