interface Props {
  onSend: (data: string) => void;
}

/** 手机上难输入的常用控制键与易出错的符号键，点击直接发送转义序列或字符 */
const SPECIAL_KEYS: { label: string; data: string }[] = [
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  // 方向键后置的符号键：因输入框已下线，点击即直接送字符到终端
  { label: '/', data: '/' },
  { label: 'Enter', data: '\r' },
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
];

/**
 * 终端快捷键工具栏：仅提供方向键、Enter、Esc、Tab 等控制序列 chips，
 * 不再提供命令输入框（PC 端接管场景下直接落到 xterm）。
 */
export default function InputBar({ onSend }: Props) {
  return (
    <div className="special-keys">
      {SPECIAL_KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          className="key"
          onClick={() => onSend(k.data)}
          aria-label={`发送 ${k.label}`}
          title={`发送 ${k.label}`}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
