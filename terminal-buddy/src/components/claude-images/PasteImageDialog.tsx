import { FC, useEffect, useState } from 'react';
import { convertFileSrc } from './../../services/remoteWorkspace/core';
import { saveClipboardImageToClaudeCache } from '../../services/tauri';
import { Dialog } from '../shared/Dialog';
import './PasteImageDialog.css';

interface PasteImageDialogProps {
  onClose: () => void;
  /**
   * 插入文本到当前终端输入行。
   * send=false 仅进输入行（不回车）；send=true 追加 \r 提交。
   * 多行内容由调用方按粘贴规范处理行尾（LF→CR + 括号粘贴）。
   */
  onInsert: (text: string, send: boolean) => void;
}

/**
 * 图片粘贴辅助（Claude Code 专用）：
 * ConPTY + xterm 的剪贴板只有文本，图片进不了 PTY——
 * 这里把剪贴板图片转存为文件，以 `@<path>` 引用插入输入行（备注作第二行）。
 */
export const PasteImageDialog: FC<PasteImageDialogProps> = ({ onClose, onInsert }) => {
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    saveClipboardImageToClaudeCache()
      .then(path => {
        if (!cancelled) setImagePath(path);
      })
      .catch(err => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const buildInsertText = (): string => {
    const trimmedNote = note.trim();
    // 备注作为第二行；多行文本交给调用方按 CR 规范发送
    return trimmedNote ? `@${imagePath}\n${trimmedNote}` : `@${imagePath}`;
  };

  const insert = (send: boolean) => {
    if (!imagePath) return;
    onInsert(buildInsertText(), send);
    onClose();
  };

  return (
    <Dialog
      title="粘贴图片"
      onClose={onClose}
      className="paste-image-dialog"
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn-secondary"
            disabled={!imagePath}
            onClick={() => insert(false)}
          >插入引用</button>
          <button
            type="button"
            className="btn-primary"
            disabled={!imagePath}
            onClick={() => insert(true)}
          >插入并发送</button>
        </>
      )}
    >
      {error ? (
        <div className="paste-image-error">
          读取剪贴板图片失败：{error}
          <small>先截图或复制一张图片，再打开本对话框</small>
        </div>
      ) : !imagePath ? (
        <div className="paste-image-loading">正在读取剪贴板图片…</div>
      ) : (
        <>
          <div className="paste-image-preview">
            {previewFailed ? (
              <div className="paste-image-fallback" title={imagePath}>🖼 {imagePath}</div>
            ) : (
              <img
                src={convertFileSrc(imagePath)}
                alt="剪贴板图片预览"
                onError={() => setPreviewFailed(true)}
              />
            )}
          </div>
          <label className="paste-image-note">
            备注（可选）
            <input
              type="text"
              value={note}
              placeholder="例如：这是报错截图"
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  insert(true);
                }
              }}
            />
          </label>
          <div className="paste-image-hint">
            输入行将插入：<code className="paste-image-path">@{imagePath}</code>
            <small>「插入引用」不回车，可继续补充；「插入并发送」直接提交</small>
          </div>
        </>
      )}
    </Dialog>
  );
};
