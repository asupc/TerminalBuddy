import { FC } from 'react';
import { TerminalTab } from './TerminalTab';
import { TerminalInstance } from './TerminalInstance';
import { useAppStore, saveTabsToStorage } from '../stores/appStore';
import { writeToTerminal, closeTerminal as closeTerminalCmd } from '../services/tauri';
import './TerminalPanel.css';

export const TerminalPanel: FC = () => {
  const { sessions, activeSessionId, removeSession, setActiveSession, renameSession, updateSession } = useAppStore();

  const handleTerminalInput = async (sessionId: string, data: string) => {
    try {
      await writeToTerminal(sessionId, data);
    } catch (err) {
      console.error('Failed to write to terminal:', err);
    }
  };

  const handleCloseTerminal = async (sessionId: string) => {
    try {
      await closeTerminalCmd(sessionId);
    } catch (err) {
      console.error('Failed to close terminal:', err);
    }
    removeSession(sessionId);
  };

  const handleCloseOthers = async (keepId: string) => {
    const toClose = sessions.filter((s) => s.id !== keepId);
    for (const s of toClose) {
      try { await closeTerminalCmd(s.id); } catch {}
    }
    const currentState = useAppStore.getState();
    const keepSession = currentState.sessions.find((s) => s.id === keepId)!;
    useAppStore.setState({
      sessions: currentState.sessions.filter((s) => s.id === keepId),
      activeSessionId: keepId,
    });
    saveTabsToStorage([keepSession], keepId);
  };

  const handleCloseLeft = async (sessionId: string) => {
    const index = sessions.findIndex((s) => s.id === sessionId);
    if (index <= 0) return;
    const toClose = sessions.slice(0, index);
    for (const s of toClose) {
      try { await closeTerminalCmd(s.id); } catch {}
    }
    const remaining = sessions.slice(index);
    useAppStore.setState({
      sessions: remaining,
      activeSessionId: remaining.find((s) => s.id === activeSessionId)?.id || remaining[0]?.id || null,
    });
    saveTabsToStorage(remaining, remaining.find((s) => s.id === activeSessionId)?.id || remaining[0]?.id || null);
  };

  const handleCloseRight = async (sessionId: string) => {
    const index = sessions.findIndex((s) => s.id === sessionId);
    if (index < 0 || index >= sessions.length - 1) return;
    const toClose = sessions.slice(index + 1);
    for (const s of toClose) {
      try { await closeTerminalCmd(s.id); } catch {}
    }
    const remaining = sessions.slice(0, index + 1);
    useAppStore.setState({
      sessions: remaining,
      activeSessionId: remaining.find((s) => s.id === activeSessionId)?.id || remaining[remaining.length - 1]?.id || null,
    });
    saveTabsToStorage(remaining, remaining.find((s) => s.id === activeSessionId)?.id || remaining[remaining.length - 1]?.id || null);
  };

  const handleCloseAll = async () => {
    for (const s of sessions) {
      try { await closeTerminalCmd(s.id); } catch {}
    }
    useAppStore.setState({ sessions: [], activeSessionId: null });
    saveTabsToStorage([], null);
  };

  return (
    <div className="terminal-panel">
      {sessions.length > 0 && (
        <div className="terminal-tabs">
          {sessions.map((session) => (
            <TerminalTab
              key={session.id}
              id={session.id}
              name={session.profileName}
              color={session.tabColor || ''}
              isActive={activeSessionId === session.id}
              onClick={() => setActiveSession(session.id)}
              onClose={() => handleCloseTerminal(session.id)}
              onCloseOthers={() => handleCloseOthers(session.id)}
              onCloseLeft={() => handleCloseLeft(session.id)}
              onCloseRight={() => handleCloseRight(session.id)}
              onCloseAll={handleCloseAll}
              onRename={(name) => renameSession(session.id, name)}
              onChangeColor={(color) => updateSession(session.id, { tabColor: color || null })}
            />
          ))}
        </div>
      )}

      <div className="terminal-content">
        {sessions.length === 0 ? (
          <div className="terminal-empty">
            <div className="empty-icon">⌨</div>
            <div className="empty-text">点击左侧配置启动终端</div>
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`terminal-tab-content ${activeSessionId === session.id ? 'active' : ''}`}
            >
              <TerminalInstance
                terminalId={session.id}
                colorTheme={session.colorTheme}
                onOutput={(data) => handleTerminalInput(session.id, data)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
};
