import { FC, useCallback, useState, useEffect, lazy, Suspense } from 'react';
import { TerminalTabBar } from './TerminalTabBar';
import { useAppStore } from '../stores/appStore';
import { writeToTerminal } from '../services/tauri';
import { getAppSettings, getEffectiveThemeMode } from '../utils/settings';
import { resolveTerminalColors } from '../utils/terminalTheme';
import './TerminalPanel.css';

// 懒加载重型组件：避免 xterm.js / monaco-editor 等被全量打进首屏 bundle。
// 此前主 bundle 达 4.69MB，启动时需全部解析执行，是白屏卡顿主因。
// 现仅在用户真正打开终端/编辑器/设置页时才按需加载对应 chunk。
const TerminalInstance = lazy(() => import('./TerminalInstance').then(m => ({ default: m.TerminalInstance })));
const TextEditor = lazy(() => import('./TextEditor').then(m => ({ default: m.TextEditor })));
const SettingsPage = lazy(() => import('./SettingsPage').then(m => ({ default: m.SettingsPage })));

export const TerminalPanel: FC = () => {
  const sessions = useAppStore(s => s.sessions);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const settingsTabOpen = useAppStore(s => s.settingsTabOpen);
  const closeSettingsTab = useAppStore(s => s.closeSettingsTab);
  const updateSession = useAppStore(s => s.updateSession);
  const profiles = useAppStore(s => s.profiles);
  const [settings, setSettings] = useState(() => getAppSettings());
  const [effectiveTheme, setEffectiveTheme] = useState<'dark' | 'light'>(() => getEffectiveThemeMode());

  useEffect(() => {
    const onSettings = () => setSettings(getAppSettings());
    const onTheme = (e: Event) => {
      const mode = (e as CustomEvent<{ mode: 'dark' | 'light' }>).detail?.mode;
      if (mode === 'dark' || mode === 'light') setEffectiveTheme(mode);
    };
    window.addEventListener('tab-navigation-changed', onSettings);
    window.addEventListener('app-settings-changed', onSettings);
    window.addEventListener('app-theme-changed', onTheme);
    return () => {
      window.removeEventListener('tab-navigation-changed', onSettings);
      window.removeEventListener('app-settings-changed', onSettings);
      window.removeEventListener('app-theme-changed', onTheme);
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
          <Suspense fallback={<div className="lazy-panel-loading">加载设置…</div>}>
            <SettingsPage onClose={closeSettingsTab} />
          </Suspense>
        ) : sessions.length === 0 ? (
          <div className="terminal-empty">
            <div className="empty-icon">⌨</div>
            <div className="empty-text">点击左侧连接启动终端</div>
          </div>
        ) : sessions.map((session) => {
          const profile = profiles.find(p => p.id === session.profileId);
          const resolvedTheme = resolveTerminalColors(profile, effectiveTheme, settings.terminalFollowAppTheme);
          return (
          <div
            key={session.id}
            className={`terminal-tab-content ${activeSessionId === session.id ? 'active' : ''}`}
          >
            {session.sessionType === 'editor' ? (
              <Suspense fallback={<div className="lazy-panel-loading">加载编辑器…</div>}>
                <TextEditor
                  filePath={session.profileId}
                  isDirty={session.isDirty ?? false}
                  onDirtyChange={(dirty) => updateSession(session.id, { isDirty: dirty })}
                  isActive={activeSessionId === session.id}
                />
              </Suspense>
            ) : (
              <Suspense fallback={<div className="lazy-panel-loading">加载终端…</div>}>
                <TerminalInstance
                  terminalId={session.id}
                  colorTheme={resolvedTheme}
                  onOutput={handleTerminalInput}
                  isActive={activeSessionId === session.id}
                  readOnly={!settings.webApiShareSessions && session.owner === 'web'}
                />
              </Suspense>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
};
