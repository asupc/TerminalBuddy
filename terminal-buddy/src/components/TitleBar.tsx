import { FC } from 'react';
import { windowMinimize, windowToggleMaximize, windowClose } from '../services/tauri';
import appIcon from '../assets/app-icon.png';
import './TitleBar.css';

interface TitleBarProps {
  onSettings: () => void;
  configPanelVisible: boolean;
  fileTreeVisible: boolean;
  aiUsageVisible: boolean;
  onToggleConfigPanel: () => void;
  onToggleFileTree: () => void;
  onToggleAiUsage: () => void;
}

export const TitleBar: FC<TitleBarProps> = ({
  onSettings,
  configPanelVisible,
  fileTreeVisible,
  aiUsageVisible,
  onToggleConfigPanel,
  onToggleFileTree,
  onToggleAiUsage,
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
          <button
            className={`titlebar-nav-btn ${aiUsageVisible ? 'active' : ''}`}
            onClick={onToggleAiUsage}
            title={aiUsageVisible ? '隐藏AI用量' : '显示AI用量'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1.5" y="1.5" width="13" height="13" rx="3" stroke="currentColor" strokeWidth="1.2"/>
              <rect x="4" y="9" width="2" height="3.5" rx="0.5" fill="currentColor"/>
              <rect x="7" y="6" width="2" height="6.5" rx="0.5" fill="currentColor"/>
              <rect x="10" y="3.5" width="2" height="9" rx="0.5" fill="currentColor"/>
            </svg>
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
