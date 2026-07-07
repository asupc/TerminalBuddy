import { FC, useState, useRef, useEffect, useCallback } from 'react';
import { windowMinimize, windowToggleMaximize, windowClose, getWebServerAddress } from '../services/tauri';
import { AiUsagePanel } from './AiUsagePanel';
import { AboutDialog } from './AboutDialog';
import { WebManageDialog } from './WebManageDialog';
import { APP_VERSION } from '../version';
import appIcon from '../assets/app-icon.png';
import './TitleBar.css';
import { getEffectiveThemeMode, applyTheme, saveTheme } from '../utils/settings';
import { useAppStore } from '../stores/appStore';
import { TERMINAL_SPLIT_TRANSITION_GUARD_MS } from '../utils/terminalResizeEvent';

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
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const splitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) {
        clearTimeout(hoverTimer.current);
      }
      if (splitTimer.current) {
        clearTimeout(splitTimer.current);
      }
    };
  }, []);
  const [webRunning, setWebRunning] = useState(false);
  const [showWebDialog, setShowWebDialog] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(getEffectiveThemeMode);
  const splitMode = useAppStore(s => s.splitMode);

  // 监听应用主题变化。App 启动时 initTheme() 是异步的，applyTheme 会晚于本组件
  // 首次渲染执行，并派发 app-theme-changed。若不订阅，白板启动时按钮的内部 state
  // 会停在默认 'dark'，而已被 applyTheme 切成 light 的 DOM 与之不同步，
  // 导致第一次点击只是在「对齐 state」、界面不变，需点两次才真正切换。
  useEffect(() => {
    const onTheme = (e: Event) => {
      const mode = (e as CustomEvent<{ mode: 'dark' | 'light' }>).detail?.mode;
      if (mode === 'dark' || mode === 'light') setTheme(state => (state === mode ? state : mode));
    };
    window.addEventListener('app-theme-changed', onTheme);
    return () => window.removeEventListener('app-theme-changed', onTheme);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    saveTheme(next);
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

  const handleMouseEnter = () => {
    clearTimeout(hoverTimer.current);
    setAiUsageHover(true);
  };

  const handleMouseLeave = () => {
    hoverTimer.current = setTimeout(() => setAiUsageHover(false), 200);
  };

  const handleSplitClick = () => {
    if (splitBusy) return;
    setSplitBusy(true);
    useAppStore.getState().cycleSplitMode();
    if (splitTimer.current) clearTimeout(splitTimer.current);
    splitTimer.current = setTimeout(() => {
      splitTimer.current = null;
      setSplitBusy(false);
    }, TERMINAL_SPLIT_TRANSITION_GUARD_MS);
  };

  return (
    <div className="titlebar" data-tauri-drag-region="deep">
      <div className="titlebar-left">
        <img className="titlebar-logo" src={appIcon} alt="" draggable={false} />
        <span className="titlebar-title">TerminalBuddy</span>
        <span className="titlebar-version">v{APP_VERSION}</span>
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
            onClick={() => setShowWebDialog(true)}
            title={webRunning ? 'Web管理已启动 - 点击打开' : 'Web管理已停止 - 点击打开'}
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
          className={`titlebar-btn titlebar-action-btn titlebar-split-btn ${splitMode !== 'off' ? 'split-active' : ''}`}
          onClick={handleSplitClick}
          disabled={splitBusy}
          title={splitBusy ? '分屏切换中...' : splitMode === 'off' ? '分屏：2×1' : splitMode === '2x1' ? '分屏：2×2' : '退出分屏'}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            {splitMode === '2x2' ? (
              <>
                <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
                <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
                <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" />
                <rect x="9" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" />
              </>
            ) : (
              <>
                <rect x="1.5" y="1.5" width="5.5" height="13" rx="1" fill="currentColor" />
                <rect x="9" y="1.5" width="5.5" height="13" rx="1" fill="currentColor" />
              </>
            )}
          </svg>
        </button>
        <button
          className="titlebar-btn titlebar-action-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <button
          className="titlebar-btn titlebar-action-btn"
          onClick={() => setShowAboutDialog(true)}
          title="关于 TerminalBuddy"
        >
          ℹ
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

      {showAboutDialog && (
        <AboutDialog onClose={() => setShowAboutDialog(false)} />
      )}

      {showWebDialog && (
        <WebManageDialog
          onClose={() => {
            setShowWebDialog(false);
            checkWebStatus();
          }}
        />
      )}
    </div>
  );
};
