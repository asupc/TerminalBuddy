import { FC, useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { exportClaudeSession } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { Dialog } from '../shared/Dialog';

interface ClaudeExportDialogProps {
  sessionId: string;
  title: string;
  onClose: () => void;
  onExported?: () => void;
}

/** 会话导出：Markdown（对话+工具摘要）/ JSONL（原始转录）。 */
export const ClaudeExportDialog: FC<ClaudeExportDialogProps> = ({ sessionId, title, onClose, onExported }) => {
  const showToast = useAppStore(s => s.showToast);
  const [format, setFormat] = useState<'markdown' | 'jsonl'>('markdown');
  const [busy, setBusy] = useState(false);
  const safeTitle = (title || '会话').replace(/[\\/:*?"<>|]/g, '_');

  const handleExport = async () => {
    if (busy) return;
    const defaultName = `${safeTitle}_${format === 'markdown' ? '对话.md' : '原始.jsonl'}`;
    const destPath = await saveDialog({
      defaultPath: defaultName,
      filters: format === 'markdown'
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : [{ name: 'JSONL', extensions: ['jsonl'] }],
    }).catch(() => null);
    if (!destPath) return;
    setBusy(true);
    try {
      await exportClaudeSession(sessionId, format, destPath);
      showToast('导出完成', 'success');
      onExported?.();
      onClose();
    } catch (error) {
      showToast(`导出失败: ${String(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="导出会话"
      onClose={onClose}
      className="claude-export-dialog"
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>取消</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void handleExport()}>
            {busy ? '导出中…' : '导出'}
          </button>
        </>
      )}
    >
      <div className="claude-export-options">
        <label className={`claude-export-option${format === 'markdown' ? ' selected' : ''}`}>
          <input
            type="radio"
            name="claude-export-format"
            checked={format === 'markdown'}
            onChange={() => setFormat('markdown')}
          />
          <span>
            <b>Markdown</b>
            <small>对话正文 + 工具调用摘要（可贴文档 / 周报）</small>
          </span>
        </label>
        <label className={`claude-export-option${format === 'jsonl' ? ' selected' : ''}`}>
          <input
            type="radio"
            name="claude-export-format"
            checked={format === 'jsonl'}
            onChange={() => setFormat('jsonl')}
          />
          <span>
            <b>JSONL</b>
            <small>原始转录（逐条保真）</small>
          </span>
        </label>
      </div>
    </Dialog>
  );
};
