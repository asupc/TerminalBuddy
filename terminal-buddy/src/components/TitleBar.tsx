import { FC } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import appIcon from '../assets/app-icon.png';
import './TitleBar.css';

interface TitleBarProps {
  onSettings: () => void;
}

export const TitleBar: FC<TitleBarProps> = ({ onSettings }) => {
  const appWindow = getCurrentWindow();

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
          onClick={() => appWindow.minimize()}
          title="最小化"
        >
          ─
        </button>
        <button
          className="titlebar-btn"
          onClick={() => appWindow.toggleMaximize()}
          title="最大化"
        >
          □
        </button>
        <button
          className="titlebar-btn titlebar-close-btn"
          onClick={() => appWindow.close()}
          title="关闭"
        >
          ✕
        </button>
      </div>
    </div>
  );
};
