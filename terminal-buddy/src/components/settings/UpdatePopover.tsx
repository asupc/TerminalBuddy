import { FC } from 'react';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { Check, Download, RefreshCw, X } from 'lucide-react';
import type { UpdateInfo } from '../../services/tauri';
import { openUrl } from '../../services/tauri';
import { formatRelativeTime } from '../../utils/format';
import './UpdatePopover.css';

const md = new MarkdownIt({ html: false, linkify: true });

export type UpdateCheckStatus = 'idle' | 'checking' | 'up-to-date' | 'has-update';

interface UpdatePopoverProps {
  status: UpdateCheckStatus;
  info: UpdateInfo | null;
  lastCheckedAt: number | null;
  currentVersion: string;
  onCheckNow: () => void;
  onDismiss: () => void;
  onIgnore: () => void;
}

export const UpdatePopover: FC<UpdatePopoverProps> = ({
  status,
  info,
  lastCheckedAt,
  currentVersion,
  onCheckNow,
  onDismiss,
  onIgnore,
}) => {
  const html = status === 'has-update' && info
    ? DOMPurify.sanitize(md.render(info.changelogMd || ''))
    : '';

  const handleDownload = () => {
    if (!info) return;
    void openUrl(info.downloadUrl);
  };

  const handleIgnore = () => {
    if (!info) return;
    localStorage.setItem('appUpdate.dismissedVersion', info.version);
    onIgnore();
  };

  return (
    <div className="update-popover" role="dialog" aria-label="更新检查">
      <div className="update-popover-header">
        <div className="update-popover-title">{renderTitle(status, info)}</div>
        <button
          type="button"
          className="update-popover-close"
          onClick={onDismiss}
          title="关闭"
          aria-label="关闭更新检查面板"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {renderBody(status, info, html, lastCheckedAt, currentVersion)}

      <div className="update-popover-actions">
        {renderActions(status, onCheckNow, onDismiss, handleDownload, handleIgnore)}
      </div>
    </div>
  );
};

function renderTitle(status: UpdateCheckStatus, info: UpdateInfo | null) {
  switch (status) {
    case 'idle':
    case 'checking':
      return <span>检查更新</span>;
    case 'up-to-date':
      return (
        <>
          <Check size={14} aria-hidden="true" className="update-popover-check" />
          <span>当前已是最新</span>
        </>
      );
    case 'has-update':
      return (
        <>
          <Download size={14} aria-hidden="true" />
          <span>发现新版本 v{info?.version}</span>
        </>
      );
  }
}

function renderBody(
  status: UpdateCheckStatus,
  info: UpdateInfo | null,
  html: string,
  lastCheckedAt: number | null,
  currentVersion: string,
) {
  switch (status) {
    case 'idle':
      return (
        <>
          <div className="update-popover-meta">
            点击下方按钮立即检查最新版本
          </div>
          <div className="update-popover-meta">
            最后检查：{formatRelativeTime(lastCheckedAt)}
          </div>
        </>
      );
    case 'checking':
      return (
        <>
          <div className="update-popover-meta update-popover-checking">
            <RefreshCw size={12} aria-hidden="true" className="update-popover-spinner" />
            正在检查最新版本…
          </div>
        </>
      );
    case 'up-to-date':
      return (
        <>
          <div className="update-popover-meta">v{currentVersion} 是最新版本</div>
          <div className="update-popover-meta">最后检查：{formatRelativeTime(lastCheckedAt)}</div>
        </>
      );
    case 'has-update':
      return (
        <>
          <div className="update-popover-meta">发布于 {info?.releaseDate}</div>
          <div
            className="update-popover-changelog"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </>
      );
  }
}

function renderActions(
  status: UpdateCheckStatus,
  onCheckNow: () => void,
  onDismiss: () => void,
  handleDownload: () => void,
  handleIgnore: () => void,
) {
  switch (status) {
    case 'idle':
      return (
        <button type="button" className="btn-primary" onClick={onCheckNow}>
          检查更新
        </button>
      );
    case 'checking':
      return (
        <button type="button" className="btn-secondary" disabled>
          检查中…
        </button>
      );
    case 'up-to-date':
      return (
        <>
          <button type="button" className="btn-primary" onClick={onCheckNow}>
            重新检查
          </button>
          <button type="button" className="btn-secondary" onClick={onDismiss}>
            关闭
          </button>
        </>
      );
    case 'has-update':
      return (
        <>
          <button type="button" className="btn-primary" onClick={handleDownload}>
            前往 Gitee 下载
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleIgnore}
            title="忽略此版本，下次发布新版前不再提示"
          >
            忽略此版本
          </button>
        </>
      );
  }
}
