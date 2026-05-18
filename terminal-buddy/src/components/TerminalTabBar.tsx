import { FC, useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { closeTerminal as closeTerminalCmd, saveEnableTabNavigation } from '../services/tauri';
import { getAppSettings, saveAppSettings } from '../utils/settings';
import './TerminalTabBar.css';

export const TerminalTabBar: FC = () => {
  const { sessions, activeSessionId, removeSession, setActiveSession } = useAppStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);

  const handleCloseTerminal = async (sessionId: string) => {
    try { await closeTerminalCmd(sessionId); } catch (err) { console.error(err); }
    removeSession(sessionId);
  };

  const closeOthers = useCallback((sessionId: string) => {
    for (const s of sessions) {
      if (s.id !== sessionId) {
        closeTerminalCmd(s.id).catch(() => {});
        removeSession(s.id);
      }
    }
  }, [sessions, removeSession]);

  const closeLeft = useCallback((sessionId: string) => {
    const idx = sessions.findIndex(s => s.id === sessionId);
    for (let i = 0; i < idx; i++) {
      const s = sessions[i];
      closeTerminalCmd(s.id).catch(() => {});
      removeSession(s.id);
    }
  }, [sessions, removeSession]);

  const closeRight = useCallback((sessionId: string) => {
    const idx = sessions.findIndex(s => s.id === sessionId);
    for (let i = idx + 1; i < sessions.length; i++) {
      const s = sessions[i];
      closeTerminalCmd(s.id).catch(() => {});
      removeSession(s.id);
    }
  }, [sessions, removeSession]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  const sessionIdx = (id: string) => sessions.findIndex(s => s.id === id);

  return (
    <div className="terminal-tab-bar">
      {sessions.map((session) => (
        <div
          key={session.id}
          className={`terminal-tab ${activeSessionId === session.id ? 'active' : ''}`}
          onClick={() => setActiveSession(session.id)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              handleCloseTerminal(session.id);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, sessionId: session.id });
          }}
        >
          <span
            className="terminal-tab-dot"
            style={{ background: session.tabColor || 'var(--accent)' }}
          />
          <span className="terminal-tab-name">{session.profileName}</span>
          <button
            className="terminal-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              handleCloseTerminal(session.id);
            }}
            title="关闭"
          >×</button>
        </div>
      ))}
      {contextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setContextMenu(null)} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <div
              className={`context-menu-item ${sessionIdx(contextMenu.sessionId) <= 0 ? 'disabled' : ''}`}
              onClick={() => {
                if (sessionIdx(contextMenu.sessionId) > 0) {
                  closeLeft(contextMenu.sessionId);
                }
                setContextMenu(null);
              }}
            >关闭左侧</div>
            <div
              className={`context-menu-item ${sessionIdx(contextMenu.sessionId) >= sessions.length - 1 ? 'disabled' : ''}`}
              onClick={() => {
                if (sessionIdx(contextMenu.sessionId) < sessions.length - 1) {
                  closeRight(contextMenu.sessionId);
                }
                setContextMenu(null);
              }}
            >关闭右侧</div>
            <div
              className={`context-menu-item ${sessions.length <= 1 ? 'disabled' : ''}`}
              onClick={() => {
                if (sessions.length > 1) {
                  closeOthers(contextMenu.sessionId);
                }
                setContextMenu(null);
              }}
            >关闭其他</div>
            <div className="context-menu-item" onClick={() => {
              setContextMenu(null);
              const s = getAppSettings();
              saveAppSettings({ ...s, enableTabNavigation: true });
              saveEnableTabNavigation(true).catch(() => {});
              window.dispatchEvent(new CustomEvent('tab-navigation-changed'));
            }}>启用标签导航</div>
            <div className="context-menu-separator" />
            <div className="context-menu-item danger" onClick={() => {
              handleCloseTerminal(contextMenu.sessionId);
              setContextMenu(null);
            }}>关闭</div>
          </div>
        </>
      )}
    </div>
  );
};
