import { useState } from 'react';

interface Props {
  onSend: (data: string) => void;
}

/** 手机上难输入的常用键，点击直接发送转义序列（易输入的符号走输入框） */
const SPECIAL_KEYS: { label: string; data: string }[] = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl+C', data: '\x03' },
  { label: 'Ctrl+D', data: '\x04' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '→', data: '\x1b[C' },
  { label: '←', data: '\x1b[D' },
  { label: '/', data: '/' },
  { label: '-', data: '-' },
];

/**
 * 「先输入后发送」输入栏：写完一行点发送（默认补回车）；
 * + 特殊键芯片直接发转义序列。规避手机 IME 逐键捕获问题。
 */
export default function InputBar({ onSend }: Props) {
  const [value, setValue] = useState('');
  const [autoEnter, setAutoEnter] = useState(true);

  const submit = () => {
    if (!value) return;
    onSend(value + (autoEnter ? '\r' : ''));
    setValue('');
  };

  return (
    <div className="input-bar">
      <div className="row">
        <input
          className="line"
          value={value}
          placeholder="输入命令…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          className={`btn auto-enter${autoEnter ? ' active' : ''}`}
          onClick={() => setAutoEnter((v) => !v)}
          title="发送后自动补回车（再次点击关闭，用于 vim 等）"
        >
          ↵{autoEnter ? '' : '✗'}
        </button>
        <button className="btn primary" onClick={submit}>
          发送
        </button>
      </div>
      <div className="special-keys">
        {SPECIAL_KEYS.map((k) => (
          <button key={k.label} className="key" onClick={() => onSend(k.data)}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
