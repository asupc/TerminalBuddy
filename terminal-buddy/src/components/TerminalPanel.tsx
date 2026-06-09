import { FC, useCallback, useState, useEffect } from 'react';
import { TerminalInstance } from './TerminalInstance';
import { TextEditor } from './TextEditor';
import { TerminalTabBar } from './TerminalTabBar';
import { SettingsPage } from './SettingsPage';
import { useAppStore } from '../stores/appStore';
import { writeToTerminal } from '../services/tauri';
import { getAppSettings } from '../utils/settings';
import './TerminalPanel.css';

export const TerminalPanel: FC = () => {
  const sessions = useAppStore(s => s.sessions);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const settingsTabOpen = useAppStore(s => s.settingsTabOpen);
  const closeSettingsTab = useAppStore(s => s.closeSettingsTab);
  const updateSession = useAppStore(s => s.updateSession);
  const [settings, setSettings] = useState(() => getAppSettings());

  useEffect(() => {
    const handler = () => setSettings(getAppSettings());
    window.addEventListener('tab-navigation-changed', handler);
    window.addEventListener('app-settings-changed', handler);
    return () => {
      window.removeEventListener('tab-navigation-changed', handler);
      window.removeEventListener('app-settings-changed', handler);
    };
  }, []);

  const handleTerminalInput = useCallback(async (sessionId: string, data: string) => {
    try {
      await writeToTerminal(sessionId, data);
    } catch (err) {
      console.error('Failed to write to terminal:', err);
    }
  }, []);

  return (
    <div className="terminal-panel">
      {!settings.enableTabNavigation && sessions.length > 0 && (
        <TerminalTabBar />
      )}
      <div className="terminal-content">
        {settingsTabOpen ? (
          <SettingsPage onClose={closeSettingsTab} />
        ) : sessions.length === 0 ? (
          <div className="terminal-empty">
            <div className="empty-icon">⌨</div>
            <div className="empty-text">点击左侧连接启动终端</div>
          </div>
        ) : sessions.map((session) => (
          <div
            key={session.id}
            className={`terminal-tab-content ${activeSessionId === session.id ? 'active' : ''}`}
          >
            {session.sessionType === 'editor' ? (
              <TextEditor
                filePath={session.profileId}
                isDirty={session.isDirty ?? false}
                onDirtyChange={(dirty) => updateSession(session.id, { isDirty: dirty })}
                isActive={activeSessionId === session.id}
              />
            ) : (
              <TerminalInstance
                terminalId={session.id}
                colorTheme={session.colorTheme}
                onOutput={handleTerminalInput}
                isActive={activeSessionId === session.id}
                readOnly={!settings.webApiShareSessions && session.owner === 'web'}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
