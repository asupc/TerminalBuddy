import { FC, useState, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
import {
  getWebApiStatus,
  saveWebApiSettings,
  restartWebServer,
  getWebServerAddress,
  getWebQuickAccessUrl,
  readClientData,
  writeClientData,
  openUrl,
} from '../../services/tauri';
import { getAppSettings } from '../../utils/settings';
import './WebManageDialog.css';

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

// 解析 "地址:端口" 格式的内联输入；返回 null 表示格式不合法。
const parseCustomEndpointInput = (value: string): CustomEndpoint | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // IPv6 方括号写法：[::1]:9600
  const ipv6Match = trimmed.match(/^\[([^\]]+)\]:(\d{1,5})$/);
  if (ipv6Match) {
    const port = parseInt(ipv6Match[2], 10);
    if (port < 1 || port > 65535) return null;
    const host = ipv6Match[1].trim();
    if (!host || getCustomHostError(host, true)) return null;
    return { host, port };
  }
  // 通用写法：以最后一个冒号分隔 host 与 port
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === trimmed.length - 1) return null;
  const host = trimmed.slice(0, lastColon).trim();
  const portStr = trimmed.slice(lastColon + 1).trim();
  if (!host || !portStr) return null;
  const port = parseInt(portStr, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (getCustomHostError(host, true)) return null;
  return { host, port };
};

const getCustomEndpointInputError = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!parseCustomEndpointInput(trimmed)) {
    return '请输入 "地址:端口" 格式，例如 192.168.1.10:9600';
  }
  return '';
};

const replaceUrlEndpoint = (url: string, customEndpoint: CustomEndpoint | null): string => {
  if (!customEndpoint) return url;

  try {
    const parsedUrl = new URL(url);
    const urlHost = customEndpoint.host.includes(':') ? `[${customEndpoint.host}]` : customEndpoint.host;
    const newHostname = new URL(`http://${urlHost}`).hostname;
    if (!newHostname) return url;
    parsedUrl.hostname = newHostname;
    parsedUrl.port = String(customEndpoint.port);
    const replaced = parsedUrl.toString();
    const sourceHadBareOrigin = parsedUrl.pathname === '/' && !parsedUrl.search && !parsedUrl.hash && !url.endsWith('/');
    return sourceHadBareOrigin ? replaced.slice(0, -1) : replaced;
  } catch {
    // 自定义 host 无法嵌入 URL（如历史脏数据）时回退到原始地址，避免渲染崩溃。
    return url;
  }
};

export const WebManageSettings: FC = () => {
  const [customEndpoint, setCustomEndpoint] = useState<CustomEndpoint | null>(null);
  const [customEndpointDraft, setCustomEndpointDraft] = useState('');
  const [customEndpointError, setCustomEndpointError] = useState('');
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
        if (!saved) {
          if (!cancelled) setCustomEndpointDraft('');
          return;
        }
        if (typeof saved.host !== 'string' || typeof saved.port !== 'number') return;
        if (getCustomHostError(saved.host, true) || getCustomPortError(String(saved.port))) return;
        if (cancelled) return;
        const endpoint = { host: normalizeCustomHost(saved.host), port: saved.port };
        setCustomEndpoint(endpoint);
        setCustomEndpointDraft(formatCustomEndpoint(endpoint));
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

  const handleCustomEndpointBlur = async () => {
    const trimmed = customEndpointDraft.trim();
    if (!trimmed) {
      setCustomEndpointError('');
      if (customEndpoint) {
        try {
          await writeClientData(CUSTOM_ENDPOINT_KEY, 'null');
        } catch {
          /* ignore */
        }
        setCustomEndpoint(null);
      }
      return;
    }
    const error = getCustomEndpointInputError(trimmed);
    setCustomEndpointError(error);
    if (error) return;
    const parsed = parseCustomEndpointInput(trimmed);
    if (!parsed) return;
    try {
      await writeClientData(CUSTOM_ENDPOINT_KEY, JSON.stringify(parsed));
      setCustomEndpoint(parsed);
    } catch {
      /* ignore */
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
    <div className="web-manage-settings">
          <div className="web-dialog-intro">
            <p className="web-dialog-desc">启用后可通过浏览器远程访问终端</p>
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

          {serverRunning && (
            <div className="web-field web-field-inline">
              <label className="web-label" htmlFor="web-api-custom-endpoint">自定义 Host</label>
              <input
                id="web-api-custom-endpoint"
                className="web-input"
                type="text"
                value={customEndpointDraft}
                placeholder="地址:端口，留空使用自动地址"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={Boolean(customEndpointError)}
                aria-describedby={customEndpointError ? 'web-api-custom-endpoint-error' : undefined}
                onChange={(event) => {
                  setCustomEndpointDraft(event.target.value);
                  if (customEndpointError) setCustomEndpointError(getCustomEndpointInputError(event.target.value));
                }}
                onBlur={handleCustomEndpointBlur}
              />
              {customEndpointError && (
                <div id="web-api-custom-endpoint-error" className="web-field-error" role="alert">
                  {customEndpointError}
                </div>
              )}
            </div>
          )}

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
                      onClick={(e) => {
                        e.preventDefault();
                        void openUrl(quickUrl);
                      }}
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
  );
};
