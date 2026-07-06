import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import Xterm from '../components/Xterm';

interface Props {
  terminalId: string;
  profileName: string;
}

export default function Terminal({ terminalId, profileName }: Props) {
  const setView = useStore((s) => s.setView);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [exited, setExited] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const goBack = () => setView({ screen: 'nav' });

  const closeTerminal = async () => {
    setMenuOpen(false);
    try {
      await api.deleteTerminal(terminalId);
    } catch {
      /* 终端可能已退出，忽略 */
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
    <div className="screen">
      <div className="topbar">
        <button className="btn icon" onClick={goBack} title="返回">
          ‹
        </button>
        <span className={`dot ${connected ? 'online' : 'offline'}`} />
        <span className="title">{profileName}</span>
        <button className="btn icon" onClick={() => setMenuOpen((v) => !v)} title="菜单">
          ⋯
        </button>
      </div>

      {menuOpen && (
        <>
          <div
            onClick={() => setMenuOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 19 }}
          />
          <div
            style={{
              position: 'absolute',
              right: 8,
              top: 48,
              background: 'var(--bg-elev2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              zIndex: 20,
              overflow: 'hidden',
              minWidth: 130,
            }}
          >
            <button
              onClick={closeTerminal}
              style={{
                display: 'block',
                width: '100%',
                padding: '11px 16px',
                textAlign: 'left',
                color: 'var(--danger)',
              }}
            >
              关闭连接
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
