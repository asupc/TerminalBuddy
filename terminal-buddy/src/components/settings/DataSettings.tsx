import { FC, useEffect, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Database, Download, FolderOpen, Upload } from 'lucide-react';
import {
  getDataPath,
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
  /** 迁移成功后通知父级刷新展示路径（审查 M-4：否则 UI 停留旧路径） */
  onDataPathChanged?: (path: string) => void;
}

export const DataSettings: FC<DataSettingsProps> = ({ dataPath, askConfirm, setConfirmDialog, onDataPathChanged }) => {
  const [pendingDataPath, setPendingDataPath] = useState('');
  const [isMigrating, setIsMigrating] = useState(false);
  const [dirStatus, setDirStatus] = useState<DataPathStatus | null>(null);

  useEffect(() => {
    getDataPathStatus().then(setDirStatus).catch(() => {});
  }, []);

  const hasPendingChange = Boolean(pendingDataPath && pendingDataPath !== dataPath);
  const isUnavailable = dirStatus?.kind === 'unavailable';

  return (
    <div className="settings-general">
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">
            <Database size={14} aria-hidden="true" />
            数据存储位置
          </span>
          <span className={`s-status-chip ${isUnavailable ? 'danger' : 'ok'}`}>
            {isUnavailable ? '目录不可用' : '目录可写'}
          </span>
        </div>

        <div className="settings-card-block">
          {isUnavailable && dirStatus && (
            <p className="settings-inline-alert" role="alert">
              {dirStatus.summary}
            </p>
          )}
          <div className="data-path-row">
            <input
              className="tb-input mono"
              type="text"
              value={pendingDataPath || dataPath}
              readOnly
            />
            <button
              type="button"
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
              浏览目录
            </button>
            {hasPendingChange && (
              <button
                type="button"
                className="btn-primary"
                disabled={isMigrating}
                onClick={() => {
                  askConfirm(`将把数据迁移到:\n${pendingDataPath}\n\n原数据不会删除。确定继续？`, async () => {
                    setConfirmDialog(null);
                    setIsMigrating(true);
                    try {
                      await setDataPathCmd(pendingDataPath);
                      setPendingDataPath('');
                      void showAlert('数据迁移完成', '迁移成功');
                      // 立即拉取新路径并通知父级刷新（审查 M-4），避免 UI 停留在旧路径
                      getDataPath().then(path => onDataPathChanged?.(path)).catch(() => {});
                    } catch (err) {
                      void showAlert('迁移失败: ' + String(err), '迁移失败');
                    }
                    setIsMigrating(false);
                  });
                }}
              >{isMigrating ? '迁移中...' : '迁移数据'}</button>
            )}
          </div>
          <p className="settings-row-desc">
            修改路径后会自动校验权限并复制 Profiles、SQLite 数据库与会话数据（原数据保留备份）。
          </p>
        </div>
      </div>

      <div className="settings-grid-2col">
        <div className="settings-card-group settings-grid-card">
          <div className="card-group-header">
            <span className="card-group-title">
              <Download size={14} aria-hidden="true" />
              导出全部数据
            </span>
          </div>
          <div className="settings-card-block settings-card-block-grow">
            <p className="settings-row-desc">
              将 Profiles、项目登记、命令历史与模板打包导出为单个 JSON 备份文件。
            </p>
            <div className="settings-card-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={async () => {
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
                }}
              >
                <Download size={15} aria-hidden="true" />
                导出备份 JSON
              </button>
            </div>
          </div>
        </div>

        <div className="settings-card-group settings-grid-card">
          <div className="card-group-header">
            <span className="card-group-title">
              <Upload size={14} aria-hidden="true" />
              从备份导入恢复
            </span>
          </div>
          <div className="settings-card-block settings-card-block-grow">
            <p className="settings-row-desc">
              导入历史导出的全量备份，自动校验连接字段与设置结构后覆盖恢复。
            </p>
            <div className="settings-card-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={async () => {
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
                }}
              >
                <Upload size={15} aria-hidden="true" />
                选择备份文件
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
