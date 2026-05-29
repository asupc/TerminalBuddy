import { FC } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { saveSshDownloadDir, saveServerMonitorInterval } from '../../services/tauri';
import type { AppSettings } from '../../utils/settings';

interface SshSettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const SshSettings: FC<SshSettingsProps> = ({ settings, updateSetting }) => {
  return (
    <div className="settings-general">
      <div className="settings-section">
        <label className="settings-label">下载目录</label>
        <div className="data-path-row">
          <input
            className="data-path-input"
            type="text"
            value={settings.sshDownloadDir}
            readOnly
          />
          <button
            className="btn-secondary"
            onClick={async () => {
              try {
                const selected = await open({ directory: true, title: '选择 SSH 下载目录' });
                if (selected) {
                  updateSetting('sshDownloadDir', selected as string);
                  saveSshDownloadDir(selected as string).catch(console.error);
                }
              } catch {}
            }}
          >浏览</button>
        </div>
        <p className="settings-desc">SSH 远程文件下载的本地保存目录，默认为系统下载文件夹</p>
      </div>
      <div className="settings-section">
        <label className="settings-label">监控刷新间隔</label>
        <div className="data-path-row">
          <select
            className="data-path-input"
            value={settings.serverMonitorInterval}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              updateSetting('serverMonitorInterval', val);
              saveServerMonitorInterval(val).catch(console.error);
            }}
          >
            <option value={1}>1 秒</option>
            <option value={3}>3 秒</option>
            <option value={5}>5 秒</option>
            <option value={10}>10 秒</option>
            <option value={0}>关闭</option>
          </select>
        </div>
        <p className="settings-desc">SSH 远程服务器状态监控的自动刷新间隔，设为"关闭"可停止自动刷新</p>
      </div>
    </div>
  );
};
