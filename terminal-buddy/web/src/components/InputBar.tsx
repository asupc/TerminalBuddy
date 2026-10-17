import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Send, Trash2 } from 'lucide-react';
import { diffTerminalInput } from '../utils/terminalInput';
import { installInputKeyboardGuard } from '../utils/terminalKeyboard';

interface Props {
  connected: boolean;
  onSend: (data: string) => boolean;
  onText: (text: string) => boolean;
}

/** 手机上难输入的常用键，点击直接发送转义序列（易输入的符号走输入框） */
const SPECIAL_KEYS: { label: string; data: string; mode?: 'insert' }[] = [
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: 'Enter', data: '\r' },
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl+C', data: '\x03' },
  { label: 'Backspace', data: '\x7f' },
  { label: 'Ctrl+D', data: '\x04' },
  { label: 'Ctrl+Z', data: '\x1a' },
  { label: 'Ctrl+L', data: '\x0c' },
  { label: 'Home', data: '\x1b[H' },
  { label: 'End', data: '\x1b[F' },
  { label: '|', data: '|', mode: 'insert' },
  { label: '/', data: '/', mode: 'insert' },
  { label: '\\', data: '\\', mode: 'insert' },
  { label: '~', data: '~', mode: 'insert' },
  { label: '-', data: '-', mode: 'insert' },
  { label: '_', data: '_', mode: 'insert' },
];

/** 输入即同步到终端；中文候选确认后同步，发送按钮只提交 Enter。 */
export default function InputBar({ connected, onSend, onText }: Props) {
  const [value, setValue] = useState('');
  const valueRef = useRef('');
  const syncedRef = useRef('');
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();

  useEffect(() => {
    const input = inputRef.current;
    if (input) return installInputKeyboardGuard(input);
  }, []);

  const resizeInput = (element: HTMLTextAreaElement) => {
    element.style.height = '44px';
    element.style.height = `${Math.min(element.scrollHeight, 112)}px`;
  };

  const syncInput = (next: string): boolean => {
    if (!connected || composingRef.current) return false;
    const { erase, text } = diffTerminalInput(syncedRef.current, next);
    if (erase) {
      if (!onSend('\x7f'.repeat(erase))) return false;
      syncedRef.current = Array.from(syncedRef.current).slice(0, -erase).join('');
    }
    if (text && !onText(text)) return false;
    syncedRef.current = next;
    return true;
  };

  const updateValue = (next: string) => {
    valueRef.current = next;
    setValue(next);
    syncInput(next);
  };

  // 提交或导航后只清空本地跟踪，不能再把已经提交的文本从终端删掉。
  const resetInput = () => {
    valueRef.current = '';
    syncedRef.current = '';
    setValue('');
    if (inputRef.current) inputRef.current.style.height = '44px';
  };

  const submit = () => {
    if (!syncInput(inputRef.current?.value ?? valueRef.current)) return;
    if (!onSend('\r')) return;
    resetInput();
  };

  const insertAtCursor = (text: string) => {
    const input = inputRef.current;
    if (!input || !connected || composingRef.current) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    updateValue(valueRef.current.slice(0, start) + text + valueRef.current.slice(end));
    requestAnimationFrame(() => {
      const nextCursor = start + text.length;
      input.setSelectionRange(nextCursor, nextCursor);
      resizeInput(input);
    });
  };

  const sendKey = (data: string) => {
    if (data === '\r') {
      submit();
      return;
    }
    const input = inputRef.current;
    if (input && valueRef.current && ['\x1b[D', '\x1b[C', '\x1b[H', '\x1b[F'].includes(data)) {
      if (!connected || composingRef.current) return;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const previous = Array.from(valueRef.current.slice(0, start)).pop() ?? '';
      const next = Array.from(valueRef.current.slice(end))[0] ?? '';
      const position = data === '\x1b[H' ? 0
        : data === '\x1b[F' ? valueRef.current.length
          : data === '\x1b[D' ? start === end ? start - previous.length : start
            : start === end ? end + next.length : end;
      input.setSelectionRange(position, position);
      return;
    }
    if (data === '\x7f' && valueRef.current) {
      const input = inputRef.current;
      if (!input || composingRef.current) return;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const previous = Array.from(valueRef.current.slice(0, start)).pop() ?? '';
      const from = start === end ? start - previous.length : start;
      updateValue(valueRef.current.slice(0, from) + valueRef.current.slice(end));
      requestAnimationFrame(() => {
        input.setSelectionRange(from, from);
        resizeInput(input);
      });
      return;
    }
    if (!syncInput(valueRef.current) || !onSend(data)) return;
    // 历史、补全和导航可能改变终端的编辑内容或光标，下一次输入从当前位置开始跟踪。
    if (data !== '\x0c') resetInput();
  };

  const preserveInputFocus = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (document.activeElement === inputRef.current) event.preventDefault();
  };

  return (
    <div className="input-bar">
      <div className="input-row">
        <label className="sr-only" htmlFor={inputId}>终端同步输入</label>
        <div className="command-input-shell">
          <textarea
            id={inputId}
            ref={inputRef}
            className="command-line"
            value={value}
            disabled={!connected}
            rows={1}
            onChange={(e) => {
              updateValue(e.target.value);
              resizeInput(e.target);
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              updateValue(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              // Safari 确认中文候选时可能已清掉 isComposing，但仍发送 keyCode 229。
              if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                e.preventDefault();
                submit();
              }
            }}
            enterKeyHint="send"
            inputMode="text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            className="clear-command"
            type="button"
            onPointerDown={preserveInputFocus}
            onClick={() => {
              if (composingRef.current) return;
              updateValue('');
              if (inputRef.current) inputRef.current.style.height = '44px';
            }}
            disabled={!connected || !value}
            title="清空同步输入"
            aria-label="清空同步输入"
          >
            <Trash2 size={18} />
          </button>
        </div>
        <button
          className="send-button"
          type="button"
          onPointerDown={preserveInputFocus}
          onClick={submit}
          disabled={!connected}
          title="发送回车，提交终端输入"
          aria-label="发送回车，提交终端输入"
        >
          <Send size={18} />
          <span>发送</span>
        </button>
      </div>
      <div className="special-keys">
        {SPECIAL_KEYS.map((k) => (
          <button
            key={k.label}
            className={`key${k.mode === 'insert' ? ' symbol' : ''}`}
            type="button"
            onPointerDown={preserveInputFocus}
            onClick={() => k.mode === 'insert' ? insertAtCursor(k.data) : sendKey(k.data)}
            disabled={!connected}
            aria-label={k.mode === 'insert' ? `插入 ${k.label}` : `发送 ${k.label}`}
            title={k.mode === 'insert' ? `插入 ${k.label}` : `发送 ${k.label}`}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
