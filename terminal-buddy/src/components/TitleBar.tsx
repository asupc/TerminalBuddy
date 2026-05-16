import { FC } from 'react';
import { windowMinimize, windowToggleMaximize, windowClose } from '../services/tauri';
import appIcon from '../assets/app-icon.png';
import './TitleBar.css';

interface TitleBarProps {
  onSettings: () => void;
}

export const TitleBar: FC<TitleBarProps> = ({ onSettings }) => {
  return (
    <div className="titlebar" data-tauri-drag-region="deep">
      <div className="titlebar-left">
        <img className="titlebar-logo" src={appIcon} alt="" draggable={false} />
        <span className="titlebar-title">TerminalBuddy</span>
      </div>
      <div className="titlebar-right">
        <button className="titlebar-btn titlebar-action-btn" onClick={onSettings} title="设置">
          ⚙
        </button>
        <button
          className="titlebar-btn"
          onClick={() => windowMinimize()}
          title="最小化"
        >
          ─
        </button>
        <button
          className="titlebar-btn"
          onClick={() => windowToggleMaximize()}
          title="最大化"
        >
          □
        </button>
        <button
          className="titlebar-btn titlebar-close-btn"
          onClick={() => windowClose()}
          title="关闭"
        >
          ✕
        </button>
      </div>
    </div>
  );
};
