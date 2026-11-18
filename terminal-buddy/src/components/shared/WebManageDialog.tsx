import { FC, useState, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Globe2, QrCode } from 'lucide-react';
import {
  getWebApiStatus,
  saveWebApiSettings,
  saveWebApiShareSessions,
  restartWebServer,
  getWebServerAddress,
  getWebQuickAccessUrl,
  readClientData,
  writeClientData,
  openUrl,
} from '../../services/tauri';
import { getAppSettings, saveAppSettings } from '../../utils/settings';
import { isBrowserClient } from '../../services/platform';
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
  const browserClient = isBrowserClient();
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
  const [shareSessions, setShareSessions] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const status = await getWebApiStatus();
      setPort(status.port);
      setUsername(status.username);
      setHasPassword(status.hasPassword);
      setShareSessions(Boolean(status.shareSessions));
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

  // 切换「与桌面共享终端会话」：设置独立保存、立即生效，无需重启服务。
  // 关闭共享会立刻断开 Web 端正在接入的桌面终端（WS 每 5 秒复核授权）。
  const handleToggleShare = async (enabled: boolean) => {
    if (shareBusy) return;
    setShareBusy(true);
    setServerError('');
    const previous = shareSessions;
    setShareSessions(enabled);
    try {
      await saveWebApiShareSessions(enabled);
      // 同步前端本地设置缓存：终端只读判定与服务器启停时的透传读取的都是它。
      saveAppSettings({ ...getAppSettings(), webApiShareSessions: enabled });
    } catch (e: any) {
      setShareSessions(previous);
      setServerError(e?.toString() || '保存共享设置失败');
      console.error('[WebAPI] 切换共享设置失败:', e);
    } finally {
      setShareBusy(false);
    }
  };

  const handleToggleServer = async () => {
    setServerLoading(true);
    setServerError('');
    try {
      // 共享开关独立保存（handleToggleShare），启停服务只透传当前值。
      const currentShare = shareSessions;
      if (serverRunning) {
        // 停止：使用已持久化的端口/用户名，避免把表单里未确认的修改一并写盘。
        const persisted = await getWebApiStatus();
        await saveWebApiSettings(false, persisted.port, persisted.username, '', currentShare);
        await restartWebServer();
        setServerRunning(false);
        setServerAddress('已停止');
      } else {
        const portError = getCustomPortError(String(port));
        if (portError) {
          setServerError(portError);
          setServerLoading(false);
          return;
        }
        if (!webPassword && !hasPassword) {
          setServerError('请先设置密码');
          setServerLoading(false);
          return;
        }
        await saveWebApiSettings(true, port, username, webPassword, currentShare);
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
      <div className="web-manage-grid">
        {/* 左栏：服务参数与会话策略 */}
        <div className="settings-card-group web-manage-card">
          <div className="card-group-header">
            <span className="card-group-title">
              <Globe2 size={14} aria-hidden="true" />
              服务参数与会话策略
            </span>
            <span className={`s-status-chip ${serverRunning ? 'ok' : 'muted'}`}>
              {serverRunning ? `运行中 · ${displayedServerAddress}` : '服务未启动'}
            </span>
          </div>

          {browserClient ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">浏览器访问说明</div>
                <p className="settings-row-desc">
                  在浏览器打开服务地址即可进入与桌面端一致的完整界面（手机浏览器同样进入完整界面），使用相同密码登录。
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="settings-row">
                <div className="settings-row-info">
                  <label className="settings-row-title" htmlFor="web-api-port">监听端口</label>
                  <p className="settings-row-desc">HTTP / WebSocket 服务绑定端口</p>
                </div>
                <div className="settings-row-ctrl">
                  <input
                    id="web-api-port"
                    className="tb-input mono"
                    type="number"
                    value={port}
                    min={1024}
                    max={65535}
                    style={{ width: 112 }}
                    onChange={(e) => setPort(parseInt(e.target.value, 10) || 9600)}
                  />
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-info">
                  <label className="settings-row-title" htmlFor="web-api-username">登录账号</label>
                  <p className="settings-row-desc">Web 与 App 登录用户名</p>
                </div>
                <div className="settings-row-ctrl">
                  <input
                    id="web-api-username"
                    className="tb-input"
                    type="text"
                    value={username}
                    style={{ width: 184 }}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-info">
                  <label className="settings-row-title" htmlFor="web-api-password">访问密码</label>
                  <p className="settings-row-desc">
                    {hasPassword ? '已设置（留空不修改，bcrypt 加密保存）' : '首次启动前请先设置访问密码'}
                  </p>
                </div>
                <div className="settings-row-ctrl">
                  <input
                    id="web-api-password"
                    className="tb-input"
                    type="password"
                    value={webPassword}
                    placeholder={hasPassword ? '留空保持当前密码' : '请输入密码'}
                    style={{ width: 184 }}
                    onChange={(e) => setWebPassword(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          {serverRunning && (
            <div className="settings-row settings-row--wrap-ctrl">
              <div className="settings-row-info">
                <label className="settings-row-title" htmlFor="web-api-custom-endpoint">自定义访问地址</label>
                <p className="settings-row-desc">适用于反代、域名或端口转发，格式为「地址:端口」，留空使用局域网自动地址</p>
                {customEndpointError && (
                  <div id="web-api-custom-endpoint-error" className="web-field-error" role="alert">
                    {customEndpointError}
                  </div>
                )}
              </div>
              <div className="settings-row-ctrl" style={{ width: 200 }}>
                <input
                  id="web-api-custom-endpoint"
                  className="tb-input mono"
                  type="text"
                  value={customEndpointDraft}
                  placeholder="例: 192.168.1.10:9600"
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
              </div>
            </div>
          )}

          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-title" id="web-api-share-sessions-label">与桌面共享终端会话</div>
              <p className="settings-row-desc">
                开启后，手机与网页端可查看并接管桌面端创建的终端（永远不能关闭桌面会话；关闭共享立即断开在途连接）
              </p>
            </div>
            <div className="settings-row-ctrl">
              <label className="settings-toggle" htmlFor="web-api-share-sessions">
                <input
                  id="web-api-share-sessions"
                  type="checkbox"
                  aria-labelledby="web-api-share-sessions-label"
                  checked={shareSessions}
                  disabled={shareBusy}
                  onChange={(e) => { void handleToggleShare(e.target.checked); }}
                />
                <span className="settings-sr-only">与桌面共享终端会话</span>
              </label>
            </div>
          </div>

          {!browserClient && (
            <div className="card-group-footer web-manage-footer">
              <div className="web-manage-footer-msg">
                {serverError ? (
                  <span className="web-error" role="alert">{serverError}</span>
                ) : (
                  <span className="settings-row-desc">修改端口、账号或密码后需重新启动服务生效</span>
                )}
              </div>
              <div className="web-manage-footer-actions">
                {serverRunning ? (
                  <button
                    type="button"
                    className="btn-danger-outline"
                    onClick={handleToggleServer}
                    disabled={serverLoading}
                  >
                    {serverLoading ? '处理中…' : '停止服务'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleToggleServer}
                    disabled={serverLoading}
                  >
                    {serverLoading ? '处理中…' : '启动服务'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右栏：手机 / 浏览器扫码直连 */}
        <div className="settings-card-group web-manage-card">
          <div className="card-group-header">
            <span className="card-group-title">
              <QrCode size={14} aria-hidden="true" />
              手机 / 浏览器扫码直连
            </span>
            <span className="card-group-extra">JWT 30 天免密</span>
          </div>

          {serverRunning ? (
            <div className="web-qr-card-body">
              {qrDataUrl && (
                <div className="web-qr-box">
                  <img className="web-qr" src={qrDataUrl} alt="访问二维码" />
                </div>
              )}
              {quickUrl && (
                <>
                  <div className="web-quick-link-bar">
                    <input
                      type="text"
                      className="tb-input mono"
                      readOnly
                      value={quickUrl}
                      title={quickUrl}
                      aria-label="免密访问地址"
                      onClick={(e) => e.currentTarget.select()}
                    />
                    <button type="button" className="btn-secondary" onClick={handleCopy}>
                      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                      {copied ? '已复制' : '复制'}
                    </button>
                  </div>
                  <a
                    className="web-link-open"
                    href={quickUrl}
                    onClick={(e) => {
                      e.preventDefault();
                      void openUrl(quickUrl);
                    }}
                    rel="noopener noreferrer"
                  >
                    在系统浏览器中打开直连地址 ↗
                  </a>
                </>
              )}
              <p className="settings-row-desc">
                打开链接即自动登录并清理 URL 查询参数，电脑与手机浏览器通用完整界面
              </p>
            </div>
          ) : (
            <div className="web-qr-empty">
              <div className="web-qr-empty-icon" aria-hidden="true">
                <QrCode size={28} />
              </div>
              <strong>Web 服务当前未启动</strong>
              <p className="settings-row-desc">
                {browserClient
                  ? '暂无可展示的局域网直连地址'
                  : '在左侧设置密码并启动服务后，将在此生成扫码直连二维码与免密地址'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
