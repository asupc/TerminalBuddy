import { FC } from 'react';
import { windowMinimize, windowToggleMaximize, windowClose } from '../services/tauri';
import appIcon from '../assets/app-icon.png';
import './TitleBar.css';

interface TitleBarProps {
  onSettings: () => void;
  configPanelVisible: boolean;
  fileTreeVisible: boolean;
  onToggleConfigPanel: () => void;
  onToggleFileTree: () => void;
}

export const TitleBar: FC<TitleBarProps> = ({
  onSettings,
  configPanelVisible,
  fileTreeVisible,
  onToggleConfigPanel,
  onToggleFileTree,
}) => {
  return (
    <div className="titlebar" data-tauri-drag-region="deep">
      <div className="titlebar-left">
        <img className="titlebar-logo" src={appIcon} alt="" draggable={false} />
        <span className="titlebar-title">TerminalBuddy</span>
        <div className="titlebar-nav-btns">
          <button
            className={`titlebar-nav-btn ${configPanelVisible ? 'active' : ''}`}
            onClick={onToggleConfigPanel}
            title={configPanelVisible ? '隐藏连接导航' : '显示连接导航'}
          >
            ☰
          </button>
          <button
            className={`titlebar-nav-btn ${fileTreeVisible ? 'active' : ''}`}
            onClick={onToggleFileTree}
            title={fileTreeVisible ? '隐藏文件导航' : '显示文件导航'}
          >
            📁
          </button>
        </div>
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
