import { useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CornerDownLeft, Send, Trash2 } from 'lucide-react';

interface Props {
  onSend: (data: string) => void;
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

/**
 * 「先输入后发送」输入栏：写完一行点发送（默认补回车）；
 * + 特殊键芯片直接发转义序列。规避手机 IME 逐键捕获问题。
 */
export default function InputBar({ onSend }: Props) {
  const [value, setValue] = useState('');
  const [autoEnter, setAutoEnter] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();

  const resizeInput = (element: HTMLTextAreaElement) => {
    element.style.height = '44px';
    element.style.height = `${Math.min(element.scrollHeight, 112)}px`;
  };

  const submit = () => {
    if (!value) return;
    const text = value;
    onSend(text + (autoEnter ? '\r' : ''));
    setValue('');
    if (inputRef.current) inputRef.current.style.height = '44px';
    inputRef.current?.focus();
  };

  const insertAtCursor = (text: string) => {
    const input = inputRef.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    setValue((current) => current.slice(0, start) + text + current.slice(end));
    requestAnimationFrame(() => {
      const nextCursor = start + text.length;
      input.focus();
      input.setSelectionRange(nextCursor, nextCursor);
      resizeInput(input);
    });
  };

  const preserveInputFocus = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (document.activeElement === inputRef.current) event.preventDefault();
  };

  return (
    <div className="input-bar">
      <div className="input-row">
        <label className="sr-only" htmlFor={inputId}>命令输入</label>
        <div className="command-input-shell">
          <textarea
            id={inputId}
            ref={inputRef}
            className="command-line"
            value={value}
            placeholder="输入命令…"
            rows={1}
            onChange={(e) => {
              setValue(e.target.value);
              resizeInput(e.target);
            }}
            onKeyDown={(e) => {
              // Safari 确认中文候选时可能已清掉 isComposing，但仍发送 keyCode 229。
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
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
              setValue('');
              if (inputRef.current) inputRef.current.style.height = '44px';
              inputRef.current?.focus();
            }}
            disabled={!value}
            title="清空输入"
            aria-label="清空输入"
          >
            <Trash2 size={18} />
          </button>
        </div>
        <button
          className={`composer-button auto-enter${autoEnter ? ' active' : ''}`}
          type="button"
          onPointerDown={preserveInputFocus}
          onClick={() => setAutoEnter((v) => !v)}
          title={autoEnter ? '发送后自动回车' : '发送时不回车'}
          aria-label={autoEnter ? '自动回车已开启' : '自动回车已关闭'}
          aria-pressed={autoEnter}
        >
          <CornerDownLeft size={19} />
        </button>
        <button
          className="send-button"
          type="button"
          onPointerDown={preserveInputFocus}
          onClick={submit}
          disabled={!value}
          title="发送命令"
          aria-label="发送命令"
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
            onClick={() => k.mode === 'insert' ? insertAtCursor(k.data) : onSend(k.data)}
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
