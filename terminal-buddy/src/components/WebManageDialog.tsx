import { FC, useState, useEffect, useCallback, type FormEvent } from 'react';
import { Globe2 } from 'lucide-react';
import QRCode from 'qrcode';
import {
  getWebApiStatus,
  saveWebApiSettings,
  restartWebServer,
  getWebServerAddress,
  getWebQuickAccessUrl,
  readClientData,
  writeClientData,
} from '../services/tauri';
import { getAppSettings } from '../utils/settings';
import { Dialog } from './Dialog';
import './WebManageDialog.css';

interface WebManageDialogProps {
  onClose: () => void;
}

interface CustomEndpoint {
  host: string;
  port: number;
}

const CUSTOM_ENDPOINT_KEY = 'web_api_custom_endpoint';

const normalizeCustomHost = (value: string): string => {
  const host = value.trim();
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
};

const getCustomHostError = (value: string, required = false): string => {
  const host = normalizeCustomHost(value);
  if (!host) return required ? '请输入 IP 地址或域名' : '';
  if (/\s|[/?#@]/.test(host) || host.includes('://')) {
    return '请输入不含协议、端口和路径的 IP 地址或域名';
  }

  try {
    const urlHost = host.includes(':') ? `[${host}]` : host;
    const parsed = new URL(`http://${urlHost}`);
    if (!parsed.hostname || parsed.port || parsed.username || parsed.password) {
      return '请输入有效的 IP 地址或域名';
    }
  } catch {
    return '请输入有效的 IP 地址或域名';
  }

  return '';
};

const getCustomPortError = (value: string): string => {
  const port = Number(value);
  if (!value.trim()) return '请输入端口';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '端口范围应为 1-65535';
  }
  return '';
};

const formatCustomEndpoint = ({ host, port }: CustomEndpoint): string => {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
};

const replaceUrlEndpoint = (url: string, customEndpoint: CustomEndpoint | null): string => {
  if (!customEndpoint) return url;

  const parsedUrl = new URL(url);
  const urlHost = customEndpoint.host.includes(':') ? `[${customEndpoint.host}]` : customEndpoint.host;
  parsedUrl.hostname = new URL(`http://${urlHost}`).hostname;
  parsedUrl.port = String(customEndpoint.port);

  const replaced = parsedUrl.toString();
  const sourceHadBareOrigin = parsedUrl.pathname === '/' && !parsedUrl.search && !parsedUrl.hash && !url.endsWith('/');
  return sourceHadBareOrigin ? replaced.slice(0, -1) : replaced;
};

export const WebManageDialog: FC<WebManageDialogProps> = ({ onClose }) => {
  const [customEndpoint, setCustomEndpoint] = useState<CustomEndpoint | null>(null);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customHostDraft, setCustomHostDraft] = useState('');
  const [customPortDraft, setCustomPortDraft] = useState('');
  const [customHostError, setCustomHostError] = useState('');
  const [customPortError, setCustomPortError] = useState('');
  const [customSaveError, setCustomSaveError] = useState('');
  const [customSaving, setCustomSaving] = useState(false);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await readClientData(CUSTOM_ENDPOINT_KEY);
        if (!raw || cancelled) return;
        const saved = JSON.parse(raw) as CustomEndpoint | null;
        if (!saved || typeof saved.host !== 'string' || typeof saved.port !== 'number') return;
        if (getCustomHostError(saved.host, true) || getCustomPortError(String(saved.port))) return;
        setCustomEndpoint({ host: normalizeCustomHost(saved.host), port: saved.port });
      } catch {
        /* ignore invalid or unavailable saved data */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        const url = replaceUrlEndpoint(await getWebQuickAccessUrl(), customEndpoint);
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
  }, [customEndpoint, serverRunning]);

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

  const openCustomDialog = () => {
    setCustomHostDraft(customEndpoint?.host ?? '');
    setCustomPortDraft(String(customEndpoint?.port ?? port));
    setCustomHostError('');
    setCustomPortError('');
    setCustomSaveError('');
    setCustomDialogOpen(true);
  };

  const closeCustomDialog = () => {
    if (!customSaving) setCustomDialogOpen(false);
  };

  const handleSaveCustomEndpoint = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const hostError = getCustomHostError(customHostDraft, true);
    const portError = getCustomPortError(customPortDraft);
    setCustomHostError(hostError);
    setCustomPortError(portError);
    setCustomSaveError('');
    if (hostError || portError) return;

    const endpoint = {
      host: normalizeCustomHost(customHostDraft),
      port: Number(customPortDraft),
    };
    setCustomSaving(true);
    try {
      await writeClientData(CUSTOM_ENDPOINT_KEY, JSON.stringify(endpoint));
      setCustomEndpoint(endpoint);
      setCustomDialogOpen(false);
    } catch (error) {
      setCustomSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setCustomSaving(false);
    }
  };

  const handleClearCustomEndpoint = async () => {
    setCustomSaving(true);
    setCustomSaveError('');
    try {
      await writeClientData(CUSTOM_ENDPOINT_KEY, 'null');
      setCustomEndpoint(null);
      setCustomDialogOpen(false);
    } catch (error) {
      setCustomSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setCustomSaving(false);
    }
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

  const displayedServerAddress = serverRunning
    ? replaceUrlEndpoint(serverAddress, customEndpoint)
    : '已停止';

  return (
    <>
    <Dialog
      title="Web 远程管理"
      className="web-dialog"
      bodyClassName="web-dialog-body"
      onClose={onClose}
    >
          <div className="web-dialog-intro">
            <p className="web-dialog-desc">启用后可通过浏览器远程访问终端</p>
            <button
              type="button"
              className="web-custom-host-btn"
              onClick={openCustomDialog}
              title={customEndpoint ? formatCustomEndpoint(customEndpoint) : '设置自定义连接地址'}
            >
              <Globe2 aria-hidden="true" />
              <span>自定义 Host</span>
            </button>
          </div>

          <div className="web-field web-field-inline">
            <label className="web-label" htmlFor="web-api-port">端口</label>
            <input
              id="web-api-port"
              className="web-input"
              type="number"
              value={port}
              min={1024}
              max={65535}
              onChange={(e) => setPort(parseInt(e.target.value) || 9600)}
            />
          </div>

          <div className="web-field web-field-inline">
            <label className="web-label" htmlFor="web-api-username">用户名</label>
            <input
              id="web-api-username"
              className="web-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="web-field web-field-inline">
            <label className="web-label" htmlFor="web-api-password">密码</label>
            <input
              id="web-api-password"
              className="web-input"
              type="password"
              value={webPassword}
              placeholder={hasPassword ? '已设置，留空不修改' : '请输入密码'}
              onChange={(e) => setWebPassword(e.target.value)}
            />
          </div>

          <div className="web-status-row">
            <span className={`web-status-dot ${serverRunning ? 'on' : 'off'}`} />
            <span className="web-status-text">{displayedServerAddress}</span>
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
    </Dialog>

    {customDialogOpen && (
      <Dialog
        title="自定义 Host"
        className="web-custom-dialog"
        bodyClassName="web-custom-dialog-body"
        onClose={closeCustomDialog}
        closeDisabled={customSaving}
        onSubmit={handleSaveCustomEndpoint}
        autoFocus={false}
        footer={(
          <>
            {customEndpoint && (
              <button
                type="button"
                className="btn-danger web-custom-clear-btn"
                onClick={() => void handleClearCustomEndpoint()}
                disabled={customSaving}
              >
                恢复自动地址
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={closeCustomDialog} disabled={customSaving}>
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={customSaving}>
              {customSaving ? '保存中…' : '保存'}
            </button>
          </>
        )}
      >
        <div className="web-field">
          <label className="web-label" htmlFor="web-custom-host">IP / 域名</label>
          <input
            id="web-custom-host"
            className="web-input"
            type="text"
            value={customHostDraft}
            placeholder="例如 192.168.1.20 或 terminal.example.com"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            aria-invalid={Boolean(customHostError)}
            aria-describedby={customHostError ? 'web-custom-host-error' : undefined}
            onBlur={() => setCustomHostError(getCustomHostError(customHostDraft, true))}
            onChange={(event) => {
              setCustomHostDraft(event.target.value);
              if (customHostError) setCustomHostError(getCustomHostError(event.target.value, true));
            }}
          />
          {customHostError && (
            <div id="web-custom-host-error" className="web-field-error" role="alert">
              {customHostError}
            </div>
          )}
        </div>

        <div className="web-field">
          <label className="web-label" htmlFor="web-custom-port">连接端口</label>
          <input
            id="web-custom-port"
            className="web-input"
            type="number"
            min={1}
            max={65535}
            value={customPortDraft}
            aria-invalid={Boolean(customPortError)}
            aria-describedby={customPortError ? 'web-custom-port-error' : undefined}
            onBlur={() => setCustomPortError(getCustomPortError(customPortDraft))}
            onChange={(event) => {
              setCustomPortDraft(event.target.value);
              if (customPortError) setCustomPortError(getCustomPortError(event.target.value));
            }}
          />
          {customPortError && (
            <div id="web-custom-port-error" className="web-field-error" role="alert">
              {customPortError}
            </div>
          )}
        </div>

        <p className="web-custom-dialog-help">保存后仅替换连接地址和二维码，不改变服务监听端口。</p>
        {customSaveError && <div className="web-error" role="alert">{customSaveError}</div>}
      </Dialog>
    )}
    </>
  );
};
