import { FC } from 'react';
import './Toolbar.css';

interface ToolbarProps {
  onSettings: () => void;
}

export const Toolbar: FC<ToolbarProps> = ({ onSettings }) => {
  return (
    <div className="toolbar">
      <div className="toolbar-spacer" />
      <button className="toolbar-btn" onClick={onSettings} title="设置">
        <span className="toolbar-icon">⚙</span>设置
      </button>
    </div>
  );
};
