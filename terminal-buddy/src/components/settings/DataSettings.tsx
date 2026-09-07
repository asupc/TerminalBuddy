import { FC, useEffect, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Download, FolderOpen, Upload } from 'lucide-react';
import {
  getDataPathStatus,
  setDataPath as setDataPathCmd,
  exportAllData,
  importAllData,
  type DataPathStatus,
} from '../../services/tauri';
import { showAlert } from '../../services/dialog';

interface DataSettingsProps {
  dataPath: string;
  askConfirm: (message: string, onConfirm: () => void) => void;
  setConfirmDialog: (v: null) => void;
}

export const DataSettings: FC<DataSettingsProps> = ({ dataPath, askConfirm, setConfirmDialog }) => {
  const [pendingDataPath, setPendingDataPath] = useState('');
  const [isMigrating, setIsMigrating] = useState(false);
  const [dirStatus, setDirStatus] = useState<DataPathStatus | null>(null);

  useEffect(() => {
    getDataPathStatus().then(setDirStatus).catch(() => {});
  }, []);

  return (
    <div className="settings-general">
      <div className="settings-section">
        <label className="settings-label">数据存储路径</label>
        {dirStatus?.kind === 'unavailable' && (
          <p className="settings-desc" style={{ color: '#e5484d' }}>
            {dirStatus.summary}
          </p>
        )}
        <div className="data-path-row">
          <input
            className="data-path-input"
            type="text"
            value={pendingDataPath || dataPath}
            readOnly
          />
          <button
            className="btn-secondary"
            disabled={isMigrating}
            onClick={async () => {
              try {
                const selected = await open({ directory: true, title: '选择数据存储目录' });
                if (selected) setPendingDataPath(selected as string);
              } catch {}
            }}
          >
            <FolderOpen size={15} aria-hidden="true" />
            浏览
          </button>
          {pendingDataPath && pendingDataPath !== dataPath && (
            <button
              className="btn-primary"
              disabled={isMigrating}
              onClick={() => {
                askConfirm(`将把数据迁移到:\n${pendingDataPath}\n\n原数据不会删除。确定继续？`, async () => {
                  setConfirmDialog(null);
                  setIsMigrating(true);
                  try {
                    await setDataPathCmd(pendingDataPath);
                    setPendingDataPath('');
                  } catch (err) {
                    void showAlert('迁移失败: ' + String(err), '迁移失败');
                  }
                  setIsMigrating(false);
                });
              }}
            >{isMigrating ? '迁移中...' : '应用'}</button>
          )}
        </div>
        <p className="settings-desc">修改路径后数据将自动复制到新位置，原数据保留</p>
      </div>
      <div className="settings-section">
        <label className="settings-label">数据导入/导出</label>
        <div className="data-path-row">
          <button className="btn-secondary" onClick={async () => {
            try {
              const selected = await save({
                filters: [{ name: 'JSON', extensions: ['json'] }],
                title: '选择导出文件路径',
              });
              if (selected) {
                await exportAllData(selected as string);
                void showAlert('数据导出成功', '导出完成');
              }
            } catch (err) {
              void showAlert('导出失败: ' + String(err), '导出失败');
            }
          }}>
            <Download size={15} aria-hidden="true" />
            导出全部数据
          </button>
          <button className="btn-secondary" onClick={async () => {
            try {
              const selected = await open({
                multiple: false,
                filters: [{ name: 'JSON', extensions: ['json'] }],
                title: '选择导入文件',
              });
              if (selected) {
                askConfirm('导入将覆盖现有数据，确定继续？', async () => {
                  setConfirmDialog(null);
                  try {
                    await importAllData(selected as string);
                    void showAlert('数据导入成功，部分设置需要重启后生效', '导入完成');
                  } catch (err) {
                    void showAlert('导入失败: ' + String(err), '导入失败');
                  }
                });
              }
            } catch (err) {
              void showAlert('导入失败: ' + String(err), '导入失败');
            }
          }}>
            <Upload size={15} aria-hidden="true" />
            导入全部数据
          </button>
        </div>
        <p className="settings-desc">将所有数据（连接、主题、命令模板等）导出为单个 JSON 文件，导入时同理</p>
      </div>
    </div>
  );
};
