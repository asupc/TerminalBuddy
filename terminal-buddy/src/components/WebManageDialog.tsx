import { FC, useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import QRCode from 'qrcode';
import {
  getWebApiStatus,
  saveWebApiSettings,
  restartWebServer,
  getWebServerAddress,
  getWebQuickAccessUrl,
} from '../services/tauri';
import { getAppSettings } from '../utils/settings';
import './WebManageDialog.css';

interface WebManageDialogProps {
  onClose: () => void;
}

export const WebManageDialog: FC<WebManageDialogProps> = ({ onClose }) => {
  const [port, setPort] = useState(9600);
  const [username, setUsername] = useState('admin');
  const [webPassword, setWebPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [serverAddress, setServerAddress] = useState('');
  const [serverRunning, setServerRunning] = useState(false);
  const [serverError, setServerError] = useState('');
  const [serverLoading, setServerLoading] = useState(false);
  const [quickUrl, setQuickUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const status = await getWebApiStatus();
      setPort(status.port);
      setUsername(status.username);
      setHasPassword(status.hasPassword);
      const addr = await getWebServerAddress();
      setServerAddress(addr);
      setServerRunning(addr.startsWith('http'));
      setServerError('');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // 启动后拉取免密访问 URL 并生成二维码；停止时清空。
  useEffect(() => {
    if (!serverRunning) {
      setQuickUrl('');
      setQrDataUrl('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const url = await getWebQuickAccessUrl();
        if (cancelled) return;
        setQuickUrl(url);
        const dataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
        if (!cancelled) setQrDataUrl(dataUrl);
      } catch {
        if (!cancelled) setServerError('生成访问链接失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverRunning]);

  const handleToggleServer = async () => {
    setServerLoading(true);
    setServerError('');
    try {
      const shareSessions = getAppSettings().webApiShareSessions;
      if (serverRunning) {
        // 停止：关闭开关后 restart_web_server 会检测 enabled=false 并停止。
        await saveWebApiSettings(false, port, username, '', shareSessions);
        await restartWebServer();
        setServerRunning(false);
        setServerAddress('已停止');
      } else {
        if (!webPassword && !hasPassword) {
          setServerError('请先设置密码');
          setServerLoading(false);
          return;
        }
        await saveWebApiSettings(true, port, username, webPassword, shareSessions);
        const result = await restartWebServer();
        const addr = await getWebServerAddress();
        setServerAddress(addr);
        setServerRunning(addr.startsWith('http'));
        if (!addr.startsWith('http')) {
          setServerError(result || '服务启动失败');
        } else if (webPassword) {
          setWebPassword('');
          setHasPassword(true);
        }
      }
    } catch (e: any) {
      setServerError(e?.toString() || '操作失败');
      console.error('[WebAPI] 操作失败:', e);
    }
    setServerLoading(false);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(quickUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="web-dialog-overlay" onClick={onClose}>
      <div className="web-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="web-dialog-header">
          <h2 className="web-dialog-title">Web 远程管理</h2>
          <button className="web-dialog-close" onClick={onClose} title="关闭" aria-label="关闭">
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="web-dialog-body">
          <p className="web-dialog-desc">启用后可通过浏览器远程访问终端</p>

          <div className="web-field">
            <label className="web-label">端口</label>
            <input
              className="web-input"
              type="number"
              value={port}
              min={1024}
              max={65535}
              onChange={(e) => setPort(parseInt(e.target.value) || 9600)}
            />
          </div>

          <div className="web-field">
            <label className="web-label">用户名</label>
            <input
              className="web-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="web-field">
            <label className="web-label">
              密码
              {hasPassword && <span className="web-hint">（已设置，留空不修改）</span>}
            </label>
            <input
              className="web-input"
              type="password"
              value={webPassword}
              placeholder="留空则不修改"
              onChange={(e) => setWebPassword(e.target.value)}
            />
          </div>

          <div className="web-status-row">
            <span className={`web-status-dot ${serverRunning ? 'on' : 'off'}`} />
            <span className="web-status-text">
              {serverRunning ? serverAddress : '已停止'}
            </span>
          </div>

          {serverError && <div className="web-error">{serverError}</div>}

          {!serverRunning ? (
            <button className="web-btn primary" onClick={handleToggleServer} disabled={serverLoading}>
              {serverLoading ? '处理中…' : '启动服务'}
            </button>
          ) : (
            <>
              <button className="web-btn danger" onClick={handleToggleServer} disabled={serverLoading}>
                {serverLoading ? '处理中…' : '停止服务'}
              </button>

              <div className="web-access">
                <div className="web-access-title">扫码或点击下方链接免密访问</div>
                {qrDataUrl && (
                  <div className="web-qr-wrap">
                    <img className="web-qr" src={qrDataUrl} alt="访问二维码" />
                  </div>
                )}
                {quickUrl && (
                  <div className="web-link-row">
                    <a
                      className="web-link"
                      href={quickUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={quickUrl}
                    >
                      {quickUrl}
                    </a>
                    <button className="web-copy-btn" onClick={handleCopy}>
                      {copied ? '已复制' : '复制'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
