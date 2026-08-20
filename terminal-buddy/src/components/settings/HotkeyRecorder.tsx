import { FC, useEffect, useState } from 'react';
import { formatHotkey } from '../../utils/settings';

interface HotkeyRecorderProps {
  value: string;
  onRecord: (hotkey: string) => void;
}

// 快捷键录制按钮:点击进入录制,按组合键保存,Esc 取消
export const HotkeyRecorder: FC<HotkeyRecorderProps> = ({ value, onRecord }) => {
  const [recording, setRecording] = useState(false);

  // 录制期间在 window 捕获阶段拦截 Esc 取消录制；设置弹窗（Dialog）在 document
  // 捕获阶段监听 Esc 关闭整个弹窗，必须先于它阻止传播
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setRecording(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  return (
    <button
      className={`btn-secondary hotkey-recorder ${recording ? 'recording' : ''}`}
      type="button"
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();
        // Esc 取消录制由 window 捕获阶段监听统一处理（见上）
        const formatted = formatHotkey(e.nativeEvent);
        if (formatted) {
          onRecord(formatted);
          setRecording(false);
        }
      }}
    >
      {recording ? '请按下新快捷键…' : (value || '未设置')}
    </button>
  );
};
