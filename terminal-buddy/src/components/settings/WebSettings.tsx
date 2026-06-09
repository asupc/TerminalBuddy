import { FC } from 'react';
import { saveWebApiShareSessions } from '../../services/tauri';
import type { AppSettings } from '../../utils/settings';

interface WebSettingsProps {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  webPassword: string;
  setWebPassword: (v: string) => void;
  serverRunning: boolean;
  serverAddress: string;
  serverError: string;
  serverLoading: boolean;
  handleToggleServer: () => void;
}

export const WebSettings: FC<WebSettingsProps> = ({
  settings, setSettings, updateSetting,
  webPassword, setWebPassword,
  serverRunning, serverAddress, serverError, serverLoading,
  handleToggleServer,
}) => {
  return (
    <div className="settings-general">
      <p className="settings-desc" style={{ marginLeft: 0 }}>启用后可通过浏览器远程访问终端</p>

      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.webApiEnabled}
            onChange={(e) => setSettings({ ...settings, webApiEnabled: e.target.checked })}
          />
          <span>启用远程访问</span>
        </label>
      </div>

      {settings.webApiEnabled && (
        <>
          <div className="settings-section">
            <label className="settings-label">端口</label>
            <div className="data-path-row">
              <input
                className="data-path-input"
                type="number"
                value={settings.webApiPort}
                min={1024}
                max={65535}
                onChange={(e) => setSettings({ ...settings, webApiPort: parseInt(e.target.value) || 9600 })}
                style={{ flex: 1 }}
              />
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-label">用户名</label>
            <div className="data-path-row">
              <input
                className="data-path-input"
                type="text"
                value={settings.webApiUsername}
                onChange={(e) => setSettings({ ...settings, webApiUsername: e.target.value })}
                style={{ flex: 1 }}
              />
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-label">密码</label>
            <div className="data-path-row">
              <input
                className="data-path-input"
                type="password"
                value={webPassword}
                onChange={(e) => setWebPassword(e.target.value)}
                placeholder="留空则不修改密码"
                style={{ flex: 1 }}
              />
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.webApiShareSessions ?? false}
                onChange={(e) => {
                  const value = e.target.checked;
                  updateSetting('webApiShareSessions', value);
                  saveWebApiShareSessions(value).catch(console.error);
                }}
              />
              <span>共享会话窗口</span>
            </label>
            <p className="settings-desc">开启后 Web 端和 PC 端可以看到并操作所有终端；关闭后 Web 端只能看到自己创建的终端，PC 端可以看到 Web 端创建的终端但不能操作</p>
          </div>

          <div className="settings-section">
            <label className="settings-label">服务状态</label>
            <div className="data-path-row" style={{ alignItems: 'center', gap: 12 }}>
              <span style={{ color: serverRunning ? '#4caf50' : '#8a8aaa', fontSize: 13 }}>
                ● {serverRunning ? serverAddress : '已停止'}
              </span>
              <button
                onClick={handleToggleServer}
                disabled={serverLoading}
                style={{
                  padding: '8px 20px',
                  border: 'none',
                  borderRadius: 6,
                  background: serverRunning ? '#d32f2f' : '#4a4aaa',
                  color: '#fff',
                  fontSize: 13,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {serverLoading ? '处理中...' : serverRunning ? '停止服务' : '启动服务'}
              </button>
            </div>
            {serverError && (
              <div style={{ color: '#ff6b6b', fontSize: 12, marginTop: 6 }}>
                {serverError}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
