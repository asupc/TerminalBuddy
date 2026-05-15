import React, { FC, useRef } from 'react';
import { TerminalTab } from './TerminalTab';
import { TerminalInstance } from './TerminalInstance';
import { useAppStore, saveTabsToStorage } from '../stores/appStore';
import { onTerminalOutput, writeToTerminal, closeTerminal as closeTerminalCmd } from '../services/tauri';
import './TerminalPanel.css';

// Match CMD prompt line ending with >: C:\Users\...>
// Match PowerShell prompt line ending with >: PS C:\Users\...>
// Requires trailing > to avoid matching executable paths in output
const PROMPT_REGEX = /(?:PS )?([A-Za-z]:\\[^\s>]*)>/g;

export const TerminalPanel: FC = () => {
  const { sessions, activeSessionId, removeSession, setActiveSession, renameSession, updateSession, setCurrentDirectory, setSessionDirectory } = useAppStore();

  // Use ref for activeSessionId so directory detection uses the latest value
  // without triggering listener re-registration on tab switch
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // Only re-register listeners when the set of session IDs changes,
  // not on every state update (rename, color change, etc.)
  const sessionIdsKey = sessions.map(s => s.id).join(',');

  // Set up event listeners for terminal output
  React.useEffect(() => {
    let cancelled = false;
    const unlisteners: (() => void)[] = [];

    sessions.forEach((session) => {
      onTerminalOutput(session.id, (output) => {
        const writeFn = (window as any)[`xterm_write_${session.id}`];
        if (writeFn) writeFn(output);

        // Detect directory from prompt lines ending with >
        if (activeSessionIdRef.current === session.id) {
          const matches = [...output.matchAll(PROMPT_REGEX)];
          if (matches.length > 0) {
            const detectedPath = matches[matches.length - 1][1];
            if (detectedPath.length >= 3 && detectedPath.includes('\\')) {
              setCurrentDirectory(detectedPath);
              setSessionDirectory(session.id, detectedPath);
            }
          }
        }
      }).then((unlisten) => {
        if (cancelled) {
          // Effect already cleaned up — immediately unregister to prevent leaks
          unlisten();
        } else {
          unlisteners.push(unlisten);
        }
      });
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [sessionIdsKey, setCurrentDirectory, setSessionDirectory]);

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

  const activeSession = sessions.find((s) => s.id === activeSessionId);

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
        ) : activeSession ? (
          <div className="terminal-tab-content active">
            <TerminalInstance
              key={activeSession.id}
              terminalId={activeSession.id}
              colorTheme={activeSession.colorTheme}
              onOutput={(data) => handleTerminalInput(activeSession.id, data)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};
