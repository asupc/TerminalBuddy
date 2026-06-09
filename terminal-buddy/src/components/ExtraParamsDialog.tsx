import { FC, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useDraggable } from '../hooks/useDraggable';
import './ExtraParamsDialog.css';

interface ExtraParamsDialogProps {
  onClose: () => void;
}

export const ExtraParamsDialog: FC<ExtraParamsDialogProps> = ({ onClose }) => {
  const { extraParamPresets, addExtraParamPreset, removeExtraParamPreset } = useAppStore();
  const [name, setName] = useState('');
  const [params, setParams] = useState('');
  const { offset: dialogOffset, dragHandleProps } = useDraggable('.extra-params-dialog-content');

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
    <div className="dialog-overlay">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ transform: `translate(${dialogOffset.x}px, ${dialogOffset.y}px)` }}
        onMouseDown={dragHandleProps.onMouseDown}
      >
        <div className="dialog-header dialog-drag-handle">
          <h3>管理额外参数</h3>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>

        <div className="extra-params-dialog-content">
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
                  &times;
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
