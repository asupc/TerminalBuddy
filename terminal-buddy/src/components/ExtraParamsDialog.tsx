import { FC, useState } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { Dialog } from './Dialog';
import './ExtraParamsDialog.css';

interface ExtraParamsDialogProps {
  onClose: () => void;
}

export const ExtraParamsDialog: FC<ExtraParamsDialogProps> = ({ onClose }) => {
  const { extraParamPresets, addExtraParamPreset, removeExtraParamPreset } = useAppStore();
  const [name, setName] = useState('');
  const [params, setParams] = useState('');
  const handleAdd = () => {
    if (!name.trim() || !params.trim()) return;
    addExtraParamPreset(name.trim(), params.trim());
    setName('');
    setParams('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <Dialog
      title="管理额外参数"
      className="extra-params-dialog"
      bodyClassName="extra-params-dialog-content"
      onClose={onClose}
    >
          <div className="extra-params-input-section">
            <div className="form-row">
              <div className="form-group" style={{ flex: '0 0 120px' }}>
                <label>名称</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="如：百度"
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>参数</label>
                <input
                  value={params}
                  onChange={(e) => setParams(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={'如：--settings "E:\\config\\baidu.json"'}
                  style={{ fontFamily: 'monospace' }}
                />
              </div>
            </div>
            <button
              className="btn-primary"
              onClick={handleAdd}
              disabled={!name.trim() || !params.trim()}
              style={{ marginTop: 8 }}
            >
              添加
            </button>
          </div>

          <div className="extra-params-list">
            <label style={{ display: 'block', marginBottom: 8 }}>
              已有预设 ({extraParamPresets.length})
            </label>
            {extraParamPresets.length === 0 && (
              <div className="extra-params-empty">暂无预设</div>
            )}
            {extraParamPresets.map((preset) => (
              <div key={preset.id} className="extra-param-item">
                <span className="extra-param-name">{preset.name}</span>
                <span className="extra-param-params">{preset.params}</span>
                <button
                  className="extra-param-delete"
                  onClick={() => removeExtraParamPreset(preset.id)}
                  title="删除"
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
    </Dialog>
  );
};
