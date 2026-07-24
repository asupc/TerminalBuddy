import { FC, useMemo } from 'react';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { Download, X } from 'lucide-react';
import type { UpdateInfo } from '../services/tauri';
import './UpdatePopover.css';

interface UpdatePopoverProps {
  info: UpdateInfo;
  onDismiss: () => void;
}

const md = new MarkdownIt({ html: false, linkify: true });

export const UpdatePopover: FC<UpdatePopoverProps> = ({ info, onDismiss }) => {
  const html = useMemo(() => {
    const rendered = md.render(info.changelogMd || '');
    return DOMPurify.sanitize(rendered);
  }, [info.changelogMd]);

  const handleDownload = () => {
    window.open(info.downloadUrl, '_blank', 'noopener,noreferrer');
  };

  const handleIgnore = () => {
    localStorage.setItem('appUpdate.dismissedVersion', info.version);
    onDismiss();
  };

  return (
    <div className="update-popover" role="dialog" aria-label="新版本提示">
      <div className="update-popover-header">
        <div className="update-popover-title">
          <Download size={14} aria-hidden="true" />
          <span>发现新版本 v{info.version}</span>
        </div>
        <button
          type="button"
          className="update-popover-close"
          onClick={onDismiss}
          title="关闭"
          aria-label="关闭新版本提示"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="update-popover-meta">发布于 {info.releaseDate}</div>
      <div
        className="update-popover-changelog"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div className="update-popover-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={handleDownload}
        >
          前往 Gitee 下载
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleIgnore}
          title="本次启动不再提示此版本"
        >
          忽略本次
        </button>
      </div>
    </div>
  );
};