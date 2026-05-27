import { FC, useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { closeTerminal as closeTerminalCmd, saveEnableTabNavigation } from '../services/tauri';
import { getAppSettings, saveAppSettings } from '../utils/settings';
import { getWorkingDotColor } from '../utils/tabColor';
import './TerminalTabBar.css';

export const TerminalTabBar: FC = () => {
  const sessions = useAppStore(s => s.sessions);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const removeSession = useAppStore(s => s.removeSession);
  const setActiveSession = useAppStore(s => s.setActiveSession);
  const renameSession = useAppStore(s => s.renameSession);
  const workingSessions = useAppStore(s => s.workingSessions);
  const settingsVersion = useAppStore(s => s.settingsVersion);
  const openSettingsTab = useAppStore(s => s.openSettingsTab);
  const closeSettingsTab = useAppStore(s => s.closeSettingsTab);
  const settingsTabOpen = useAppStore(s => s.settingsTabOpen);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleCloseTerminal = useCallback(async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session?.sessionType === 'editor') {
      if (session.isDirty) {
        setConfirmDialog({
          title: '未保存的更改',
          message: `文件「${session.profileName}」有未保存的更改，确定要关闭吗？`,
          onConfirm: () => {
            setConfirmDialog(null);
            removeSession(sessionId);
          },
        });
        return;
      }
      removeSession(sessionId);
    } else {
      try { await closeTerminalCmd(sessionId); } catch (err) { console.error(err); }
      removeSession(sessionId);
    }
  }, [sessions, removeSession]);

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
    <div className="terminal-tab-bar" key={settingsVersion}>
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
          {session.sessionType === 'editor' ? (
            <span className="tab-file-icon">📄</span>
          ) : (
            <span
              className={`terminal-tab-dot${workingSessions[session.id] ? ' working' : ''}`}
              style={{ background: getWorkingDotColor(workingSessions[session.id], session.tabColor) }}
            />
          )}
          {session.isDirty && <span className="tab-dirty-dot" />}
          {renamingSessionId === session.id ? (
            <input
              ref={renameInputRef}
              className="tab-bar-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => {
                const trimmed = renameValue.trim();
                if (trimmed && trimmed !== session.profileName) {
                  renameSession(session.id, trimmed);
                }
                setRenamingSessionId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const trimmed = renameValue.trim();
                  if (trimmed && trimmed !== session.profileName) {
                    renameSession(session.id, trimmed);
                  }
                  setRenamingSessionId(null);
                } else if (e.key === 'Escape') {
                  setRenamingSessionId(null);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span className="terminal-tab-name" style={session.tabColor ? { color: session.tabColor } : undefined}>{session.profileName}</span>
              {session.owner === 'web' && <span className="terminal-owner-badge">Web</span>}
            </>
          )}
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
      {/* Settings tab */}
      {settingsTabOpen && (
        <div
          className="terminal-tab active"
          onClick={() => openSettingsTab()}
          title="设置"
        >
          <span style={{ fontSize: '12px' }}>⚙️</span>
          <span className="terminal-tab-name">设置</span>
          <button
            className="terminal-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              closeSettingsTab();
            }}
            title="关闭"
          >×</button>
        </div>
      )}
      {contextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setContextMenu(null)} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <div className="context-menu-item" onClick={() => {
              const session = sessions.find(s => s.id === contextMenu.sessionId);
              if (session) {
                setRenameValue(session.profileName);
                setRenamingSessionId(session.id);
                setTimeout(() => renameInputRef.current?.select(), 0);
              }
              setContextMenu(null);
            }}>重命名</div>
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
              saveEnableTabNavigation(true).catch(console.error);
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
      {confirmDialog && (
        <div className="confirm-dialog-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{confirmDialog.title}</div>
            <div className="confirm-dialog-message">{confirmDialog.message}</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={() => setConfirmDialog(null)}>取消</button>
              <button className="btn-danger" onClick={confirmDialog.onConfirm}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};