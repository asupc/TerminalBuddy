import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, MoreHorizontal, Unplug } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import type { TerminalLoadingMode } from '../types';
import Xterm from '../components/Xterm';
import { resolveTheme } from '../types';

interface Props {
  terminalId: string;
  profileName: string;
  loadingMode: TerminalLoadingMode;
  owner: 'pc' | 'web';
}

export default function Terminal({ terminalId, profileName, loadingMode, owner }: Props) {
  const setView = useStore((s) => s.setView);
  const session = useStore((s) => s.sessions.find((x) => x.id === terminalId));
  const connectionFatal = useStore((s) => s.connectionFatal);
  const retryFailedConnection = useStore((s) => s.retryFailedConnection);
  const token = useStore((s) => s.token);
  // 从 store 中按 session.profileId 查 profile；profiles 在「连接」tab 进入时已加载，
  // 这里若未加载则退回到默认主题；xterm 的色彩仍由 profile.colorTheme 决定。
  const profile = useStore((s) =>
    session ? s.profiles.find((p) => p.id === session.profileId) : undefined,
  );
  const theme = useMemo(() => resolveTheme(profile?.colorTheme), [profile?.colorTheme]);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [exited, setExited] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const goBack = () => setView({ screen: 'nav' });

  const closeTerminal = async () => {
    setMenuOpen(false);
    if (owner === 'web') {
      // 自己的终端：真正关闭（杀掉 PTY）
      try {
        await api.deleteTerminal(terminalId);
      } catch {
        /* 终端可能已退出，忽略 */
      }
    }
    // 接管 PC 端的终端：只断开（电脑端继续运行），不关闭
    goBack();
  };

  // PTY 退出后 1.5s 自动返回导航
  useEffect(() => {
    if (!exited) return;
    const t = setTimeout(goBack, 1500);
    return () => clearTimeout(t);
  }, [exited]);

  return (
    <div className="screen terminal-screen">
      <header className="topbar terminal-topbar">
        <button className="icon-button" onClick={goBack} title="返回" aria-label="返回连接列表">
          <ArrowLeft size={20} />
        </button>
        <div className="terminal-title">
          <span className="title">{profileName}</span>
          {session?.extraParamTag && (
            <span
              className="session-tag-chip"
              style={
                session.extraParamTagColor
                  ? { backgroundColor: session.extraParamTagColor }
                  : undefined
              }
            >
              {session.extraParamTag}
            </span>
          )}
          <span className={`terminal-status ${connected ? 'online' : 'offline'}`}>
            <span className="dot" aria-hidden="true" />
            {connected ? '已连接' : everConnected ? '正在重连' : '正在连接'}
          </span>
        </div>
        {owner === 'pc' && <span className="owner-badge">PC 接管</span>}
        <button
          className="icon-button"
          onClick={() => setMenuOpen((v) => !v)}
          title="会话菜单"
          aria-label="会话菜单"
          aria-expanded={menuOpen}
        >
          <MoreHorizontal size={21} />
        </button>
      </header>

      {menuOpen && (
        <>
          <div className="terminal-menu-mask" onClick={() => setMenuOpen(false)} />
          <div className="terminal-menu">
            <button
              className="terminal-menu-danger"
              onClick={closeTerminal}
            >
              <Unplug size={17} />
              {owner === 'web' ? '关闭连接' : '断开接管'}
            </button>
          </div>
        </>
      )}

      <div className="term-body" style={{ background: theme.background }}>
        {!exited && !connected && !connectionFatal && (
          <div className="banner info">{everConnected ? '重连中…' : '连接中…'}</div>
        )}
        {exited && (
          <div className="overlay">
            <div>连接已结束</div>
          </div>
        )}
        {/* 重试耗尽 / 登录过期的终态：给出明确原因和可操作入口，不再显示「正在重连」 */}
        {connectionFatal && (
          <div className="overlay">
            <div className="fatal-panel">
              <div className="fatal-title">
                {connectionFatal.kind === 'expired' ? '登录已过期' : '连接失败'}
              </div>
              <div className="fatal-message">
                {connectionFatal.kind === 'expired'
                  ? '登录状态已过期，请重新登录。'
                  : connectionFatal.message}
              </div>
              <div className="fatal-actions">
                {connectionFatal.kind === 'expired' ? (
                  <button className="fatal-button primary" onClick={goBack}>
                    重新登录
                  </button>
                ) : (
                  <button
                    className="fatal-button primary"
                    onClick={() => {
                      if (token) retryFailedConnection();
                      else goBack();
                    }}
                  >
                    立即重试
                  </button>
                )}
                <button className="fatal-button" onClick={goBack}>
                  返回列表
                </button>
              </div>
            </div>
          </div>
        )}
        <Xterm
          terminalId={terminalId}
          theme={theme}
          loadingMode={loadingMode}
          onStateChange={(c) => {
            setConnected(c);
            if (c) setEverConnected(true);
          }}
          onExited={() => setExited(true)}
        />
      </div>
    </div>
  );
}
