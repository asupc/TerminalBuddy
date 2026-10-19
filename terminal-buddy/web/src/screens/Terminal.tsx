import { terminalTaskTitle } from '../utils/terminalTaskTitle';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, MoreHorizontal, Unplug } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import type { TerminalLoadingMode } from '../types';
import Xterm from '../components/Xterm';
import { Dialog } from '../components/Dialog';
import { resolveTheme } from '../types';

interface Props {
  terminalId: string;
  profileName: string;
  loadingMode: TerminalLoadingMode;
  owner: 'pc' | 'web';
}

export default function Terminal({ terminalId, profileName, loadingMode, owner }: Props) {
  const setView = useStore((s) => s.setView);
  const task = useStore(state => state.taskSummaries[terminalId]);
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
  // 关闭连接前的确认弹窗（会杀掉 PTY 进程，防菜单误触）
  const [confirmClose, setConfirmClose] = useState(false);

  const goBack = () => setView({ screen: 'nav' });

  // Web 池会话均可关闭，与创建端设备无关。
  const canClose = owner === 'web';
  const displayTitle = terminalTaskTitle(session?.profileName || profileName, task);

  useEffect(() => {
    if (!task) return;
    const previous = document.title;
    document.title = `${displayTitle} — ${previous}`;
    return () => { document.title = previous; };
  }, [displayTitle, task]);

  const closeTerminal = () => {
    setMenuOpen(false);
    if (canClose) setConfirmClose(true);
  };

  const performClose = async () => {
    setConfirmClose(false);
    if (canClose) {
      // 关闭 Web 池终端（杀掉 PTY）
      try {
        await api.deleteTerminal(terminalId);
      } catch {
        /* 终端可能已退出，忽略 */
      }
    }
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
          <span className="title" title={displayTitle}>{displayTitle}</span>
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
        {owner === 'web' && session?.creator === 'desktop' && (
          <span className="owner-badge">接管中</span>
        )}
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
            {canClose ? (
              <button
                className="terminal-menu-danger"
                onClick={closeTerminal}
              >
                <Unplug size={17} />
                关闭连接
              </button>
            ) : (
              <button
                className="terminal-menu-danger"
                onClick={() => {
                  setMenuOpen(false);
                  goBack();
                }}
              >
                <Unplug size={17} />
                断开接管
              </button>
            )}
          </div>
        </>
      )}

      {/* 关闭确认：与连接列表的确认弹窗保持一致 */}
      {confirmClose && (
        <Dialog
          title="关闭连接？"
          onClose={() => setConfirmClose(false)}
          footer={(
            <>
              <button className="btn" onClick={() => setConfirmClose(false)}>取消</button>
              <button className="btn primary" onClick={() => void performClose()}>关闭</button>
            </>
          )}
        >
          <div className="web-dialog-desc">
            「{profileName}」的会话进程将被终止，且无法恢复。确定关闭吗？
          </div>
        </Dialog>
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
