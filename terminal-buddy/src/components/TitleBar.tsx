import { FC, useState, useRef, useEffect, useCallback } from 'react';
import { windowMinimize, windowToggleMaximize, windowClose, getWebApiStatus, saveWebApiSettings, restartWebServer, getWebServerAddress } from '../services/tauri';
import { AiUsagePanel } from './AiUsagePanel';
import appIcon from '../assets/app-icon.png';
import './TitleBar.css';
import { getStoredTheme, applyTheme, getAppSettings } from '../utils/settings';

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
  const [aiUsageHover, setAiUsageHover] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) {
        clearTimeout(hoverTimer.current);
      }
    };
  }, []);
  const [webRunning, setWebRunning] = useState(false);
  const [webToggling, setWebToggling] = useState(false);
  const [theme, setTheme] = useState(getStoredTheme);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  };

  const checkWebStatus = useCallback(async () => {
    try {
      const addr = await getWebServerAddress();
      setWebRunning(addr.startsWith('http'));
    } catch { setWebRunning(false); }
  }, []);

  useEffect(() => {
    checkWebStatus();
    const interval = setInterval(checkWebStatus, 30000);
    return () => clearInterval(interval);
  }, [checkWebStatus]);

  const handleToggleWeb = useCallback(async () => {
    setWebToggling(true);
    try {
      const status = await getWebApiStatus();
      if (webRunning) {
        await saveWebApiSettings(false, status.port, status.username, '', getAppSettings().webApiShareSessions);
        await restartWebServer();
        setWebRunning(false);
      } else {
        await saveWebApiSettings(true, status.port, status.username, '', getAppSettings().webApiShareSessions);
        await restartWebServer();
        const addr = await getWebServerAddress();
        setWebRunning(addr.startsWith('http'));
      }
    } catch (e) {
      console.error('Web服务切换失败:', e);
    }
    setWebToggling(false);
  }, [webRunning]);

  const handleMouseEnter = () => {
    clearTimeout(hoverTimer.current);
    setAiUsageHover(true);
  };

  const handleMouseLeave = () => {
    hoverTimer.current = setTimeout(() => setAiUsageHover(false), 200);
  };

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
            className="titlebar-nav-btn"
            onClick={handleToggleWeb}
            disabled={webToggling}
            title={webRunning ? 'Web管理已启动 - 点击停止' : 'Web管理已停止 - 点击启动'}
            style={{ position: 'relative' }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.2" fill="none"/>
              <circle cx="8" cy="8" r="3" fill={webRunning ? '#4caf50' : '#666'}/>
            </svg>
          </button>
          <div
            className="ai-usage-trigger"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <button className="titlebar-nav-btn">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1.5" y="1.5" width="13" height="13" rx="3" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="4" y="9" width="2" height="3.5" rx="0.5" fill="currentColor"/>
                <rect x="7" y="6" width="2" height="6.5" rx="0.5" fill="currentColor"/>
                <rect x="10" y="3.5" width="2" height="9" rx="0.5" fill="currentColor"/>
              </svg>
            </button>
            {aiUsageHover && <AiUsagePanel />}
          </div>
        </div>
      </div>
      <div className="titlebar-right">
        <button
          className="titlebar-btn titlebar-action-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
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
