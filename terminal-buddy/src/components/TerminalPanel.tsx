import { FC } from 'react';
import { TerminalInstance } from './TerminalInstance';
import { SplitPane } from './SplitPane';
import { TerminalTabBar } from './TerminalTabBar';
import { SettingsPage } from './SettingsPage';
import { useAppStore } from '../stores/appStore';
import { writeToTerminal } from '../services/tauri';
import { getAppSettings } from '../utils/settings';
import './TerminalPanel.css';

export const TerminalPanel: FC = () => {
  const { sessions, activeSessionId, setActiveSession,
          groups, groupLayouts, settingsTabOpen, closeSettingsTab } = useAppStore();
  const settings = getAppSettings();

  const handleTerminalInput = async (sessionId: string, data: string) => {
    try {
      await writeToTerminal(sessionId, data);
    } catch (err) {
      console.error('Failed to write to terminal:', err);
    }
  };

  const colorThemes = Object.fromEntries(
    sessions.map(s => [s.id, s.colorTheme])
  );

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
        ) : (() => {
          const activeGroup = groups.find(g => {
            const groupSessions = sessions.filter(s => s.groupId === g.id);
            return groupSessions.some(s => s.id === activeSessionId);
          });
          const activeGroupId = activeGroup?.id || 'default';
          const layout = groupLayouts[activeGroupId];

          if (layout) {
            return (
              <SplitPane
                node={layout}
                activeSessionId={activeSessionId}
                onOutput={handleTerminalInput}
                colorThemes={colorThemes}
                onActivate={(id) => setActiveSession(id)}
              />
            );
          }

          return sessions.map((session) => (
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
          ));
        })()}
      </div>
    </div>
  );
};
