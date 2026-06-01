import { FC, useMemo, useState, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { openInExplorer } from '../services/tauri';
import type { TransferItem } from '../types';

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const statusLabels: Record<TransferItem['status'], string> = {
  active: '传输中',
  completed: '已完成',
  failed: '失败',
};

interface TransferPanelProps {
  terminalId: string;
}

export const TransferPanel: FC<TransferPanelProps> = ({ terminalId }) => {
  const allTransfers = useAppStore((s) => s.transfers);
  const clearCompletedTransfers = useAppStore((s) => s.clearCompletedTransfers);
  const removeTransfer = useAppStore((s) => s.removeTransfer);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: TransferItem } | null>(null);

  const transfers = useMemo(
    () => allTransfers.filter((t) => t.terminalId === terminalId),
    [allTransfers, terminalId]
  );

  const sorted = useMemo(() =>
    [...transfers].sort((a, b) => {
    const order: Record<TransferItem['status'], number> = { active: 0, failed: 1, completed: 2 };
    return order[a.status] - order[b.status];
  }), [transfers]);

  const completedCount = transfers.filter((t) => t.status === 'completed').length;

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    document.addEventListener('wheel', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
      document.removeEventListener('wheel', close);
    };
  }, [contextMenu]);

  if (sorted.length === 0) {
    return (
      <div className="transfer-empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <span style={{ fontSize: 24, opacity: 0.4 }}>↓↑</span>
        <span>暂无传输记录</span>
        <span style={{ fontSize: 11, opacity: 0.6 }}>右键文件可下载，右键空白处可上传</span>
      </div>
    );
  }

  return (
    <div className="transfer-panel">
      {sorted.map((item) => (
        <div
          key={item.id}
          className={`transfer-item transfer-item-${item.status}`}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, item });
          }}
        >
          <div className="transfer-item-header">
            <span className="transfer-direction-icon">
              {item.direction === 'download' ? '↓' : '↑'}
            </span>
            <span className="transfer-item-name" title={item.remotePath}>
              {item.fileName}
            </span>
            <span className={`transfer-item-status transfer-status-${item.status}`}>
              {item.status === 'active'
                ? `${Math.round(item.percent)}%`
                : statusLabels[item.status]}
            </span>
          </div>
          {item.status === 'active' && (
            <div className="transfer-progress-bar">
              <div
                className="transfer-progress-fill"
                style={{ width: `${Math.min(item.percent, 100)}%` }}
              />
            </div>
          )}
          <div className="transfer-item-info">
            {item.status === 'active' && (
              <span>{formatSize(item.transferred)} / {formatSize(item.total)}</span>
            )}
            {item.status === 'completed' && (
              <span>{formatSize(item.total)}</span>
            )}
            {item.status === 'failed' && item.error && (
              <span className="transfer-error-text">{item.error}</span>
            )}
          </div>
          {(item.status === 'completed' || item.status === 'failed') && (
            <div className="transfer-item-actions">
              <button onClick={() => removeTransfer(item.id)}>移除</button>
            </div>
          )}
        </div>
      ))}
      {completedCount > 0 && (
        <div className="transfer-footer">
          <button className="transfer-clear-btn" onClick={() => clearCompletedTransfers(terminalId)}>
            清除已完成
          </button>
        </div>
      )}
      {contextMenu && contextMenu.item.status === 'completed' && contextMenu.item.direction === 'download' && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => {
            openInExplorer(contextMenu.item.localPath).catch(console.error);
            setContextMenu(null);
          }}>
            在资源管理器中打开
          </div>
        </div>
      )}
    </div>
  );
};
