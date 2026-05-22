import { FC, useCallback } from 'react';
import { TerminalInstance } from './TerminalInstance';
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
  const settings = getAppSettings();

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
            <TerminalInstance
              terminalId={session.id}
              colorTheme={session.colorTheme}
              onOutput={handleTerminalInput}
              isActive={activeSessionId === session.id}
            />
          </div>
        ))}
      </div>
    </div>
  );
};
