import { FC } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Server } from 'lucide-react';
import { saveSshDownloadDir, saveServerMonitorInterval } from '../../services/tauri';
import type { AppSettings } from '../../utils/settings';

interface SshSettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const SshSettings: FC<SshSettingsProps> = ({ settings, updateSetting }) => {
  return (
    <div className="settings-general">
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">
            <Server size={14} aria-hidden="true" />
            SFTP 传输与监控
          </span>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">远程文件下载目录</div>
            <p className="settings-row-desc">
              默认保存路径：<code className="tb-inline-code">{settings.sshDownloadDir || '系统下载文件夹'}</code>
            </p>
          </div>
          <div className="settings-row-ctrl">
            <button
              type="button"
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
            >
              <FolderOpen size={15} aria-hidden="true" />
              更改目录
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">服务器负载监控刷新间隔</div>
            <p className="settings-row-desc">
              CPU / 内存 / 磁盘实时探针轮询频率，设为「关闭」可停止自动刷新
            </p>
          </div>
          <div className="settings-row-ctrl">
            <select
              className="tb-select"
              style={{ width: 124 }}
              aria-label="服务器负载监控刷新间隔"
              value={settings.serverMonitorInterval}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
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
        </div>
      </div>
    </div>
  );
};
