import { useEffect, useState } from 'react';
import { ArrowLeft, MoreHorizontal, Unplug } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import Xterm from '../components/Xterm';

interface Props {
  terminalId: string;
  profileName: string;
  owner: 'pc' | 'web';
}

export default function Terminal({ terminalId, profileName, owner }: Props) {
  const setView = useStore((s) => s.setView);
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

      <div className="term-body">
        {!exited && !connected && (
          <div className="banner info">{everConnected ? '重连中…' : '连接中…'}</div>
        )}
        {exited && (
          <div className="overlay">
            <div>连接已结束</div>
          </div>
        )}
        <Xterm
          terminalId={terminalId}
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
