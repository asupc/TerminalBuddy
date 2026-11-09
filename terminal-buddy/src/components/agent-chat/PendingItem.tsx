import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Pencil, Trash2, X, Zap } from 'lucide-react';
import type { PendingInput } from '../../services/tauri';

/**
 * 排队中的消息条目：可原地编辑、插话、移出队列。
 *
 * 排队消息是「已经发出、等当前回合结束后自动发送」的内容。以前只能整条删掉重发，
 * 想改一个错字就得重新输入；这里改为行内编辑——点铅笔把文本换成输入框，
 * Enter 保存、Esc 取消、Shift+Enter 换行，与主输入框的按键习惯保持一致。
 */

/** 与其他按钮一致的单行自增高上限：排队消息通常是短句，超长时内部滚动。 */
const MAX_EDIT_ROWS = 6;

interface Props {
  item: PendingInput;
  /** 保存编辑后的文本；返回 false 表示失败（失败时保持编辑态，用户可继续改）。 */
  onSave: (requestId: string, text: string) => Promise<boolean>;
  onFlush: (requestId: string) => void;
  onDelete: (requestId: string) => void;
}

export const PendingItem = memo(function PendingItem({ item, onSave, onFlush, onDelete }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 编辑期间服务端可能因别的客户端改动而推送新文本；只在非编辑态同步，
  // 否则用户正在打的字会被远端覆盖。
  useEffect(() => {
    if (!editing) setDraft(item.text);
  }, [item.text, editing]);

  const startEdit = useCallback(() => {
    setDraft(item.text);
    setError(null);
    setEditing(true);
  }, [item.text]);

  // 进入编辑态后聚焦并把光标放到末尾，改错字时不用再点一下。
  useEffect(() => {
    if (!editing) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [editing]);

  const cancel = useCallback(() => {
    setEditing(false);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    const text = draft.trim();
    if (!text) { setError('消息不能为空'); return; }
    // 没改动就直接退出编辑，避免无意义的请求与一次多余的会话版本自增。
    if (text === item.text) { setEditing(false); return; }
    setSaving(true);
    setError(null);
    const ok = await onSave(item.requestId, text);
    setSaving(false);
    if (ok) setEditing(false);
    else setError('保存失败，请重试');
  }, [draft, item.requestId, item.text, onSave]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }, [cancel, save]);

  if (editing) {
    return (
      <div className="agent-pending-item editing">
        <textarea
          ref={inputRef}
          className="agent-pending-edit"
          value={draft}
          rows={Math.min(MAX_EDIT_ROWS, Math.max(1, draft.split('\n').length))}
          disabled={saving}
          onChange={event => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
        />
        <button className="agent-btn small" title="保存（Enter）" aria-label="保存修改"
          disabled={saving} onClick={() => { void save(); }}>
          <Check aria-hidden="true" />
        </button>
        <button className="agent-btn small" title="取消（Esc）" aria-label="取消修改"
          disabled={saving} onClick={cancel}>
          <X aria-hidden="true" />
        </button>
        {error && <span className="agent-pending-error" role="alert">{error}</span>}
      </div>
    );
  }

  return (
    <div className="agent-pending-item">
      <span className="agent-pending-text" title={item.text}>{item.text}</span>
      <button className="agent-btn small" title="编辑这条排队消息" aria-label="编辑排队消息" onClick={startEdit}>
        <Pencil aria-hidden="true" />
      </button>
      <button className="agent-btn small" title="立即插话" onClick={() => onFlush(item.requestId)}>
        <Zap aria-hidden="true" />插话
      </button>
      <button className="agent-btn small" title="移出队列" aria-label="移出队列" onClick={() => onDelete(item.requestId)}>
        <Trash2 aria-hidden="true" />
      </button>
    </div>
  );
});
