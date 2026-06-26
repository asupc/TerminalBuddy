import { FC, useCallback, useState, useEffect, useRef, lazy, Suspense } from 'react';
import type { CSSProperties } from 'react';
import type { TerminalSession } from '../types';
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
  const splitMode = useAppStore(s => s.splitMode);
  const splitSlots = useAppStore(s => s.splitSlots);
  const workingSessions = useAppStore(s => s.workingSessions);
  const setActiveSession = useAppStore(s => s.setActiveSession);
  const closeSplitPane = useAppStore(s => s.closeSplitPane);
  const swapSplitSlots = useAppStore(s => s.swapSplitSlots);
  const [settings, setSettings] = useState(() => getAppSettings());
  const [effectiveTheme, setEffectiveTheme] = useState<'dark' | 'light'>(() => getEffectiveThemeMode());

  // Drag-to-swap state (grid-internal two-cell swap only).
  const dragSrcRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Grid cell placement (explicit lines, don't rely on auto-flow with hidden siblings).
  const gridStyleFor = useCallback((mode: '2x1' | '2x2', i: number): CSSProperties => {
    if (mode === '2x1') return { gridColumn: i + 1, gridRow: 1 };
    return { gridColumn: (i % 2) + 1, gridRow: Math.floor(i / 2) + 1 };
  }, []);

  // Notify visible terminal panes to force-resize on layout changes (enter/exit/grow/fill).
  // Incidental window resizes are still handled by each pane's ResizeObserver.
  useEffect(() => {
    const ids = splitMode === 'off'
      ? sessions
          .filter(s => s.id === activeSessionId && s.sessionType !== 'editor')
          .map(s => s.id)
      : splitSlots.filter((s): s is string => s !== null);
    if (ids.length === 0) return;
    window.dispatchEvent(new CustomEvent('tb-split-resize', { detail: { terminalIds: ids } }));
  }, [splitMode, splitSlots, sessions, activeSessionId]);

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

  // Unified per-session renderer. CRITICAL for no-remount: the body wrapper always
  // carries key="body" and is present in EVERY mode, while the pane header (split only)
  // carries its own key="header". Entering/leaving split thus only adds/removes the
  // header sibling — the TerminalInstance subtree under key="body" is never remounted,
  // so canvas/scrollback/WebGL survive all layout transitions.
  const renderPane = (session: TerminalSession, opts: { slot?: number; active: boolean; hidden: boolean }) => {
    const { slot, active, hidden } = opts;
    const isSlot = slot !== undefined;
    const profile = profiles.find(p => p.id === session.profileId);
    const resolvedTheme = resolveTerminalColors(profile, effectiveTheme, settings.terminalFollowAppTheme);
    const isActivePane = active && !hidden;
    const containerClass = [
      'terminal-tab-content',
      isSlot ? 'split-cell' : '',
      active ? 'active' : '',
      hidden ? 'split-hidden' : '',
      isSlot && dragOverIndex === slot ? 'drag-over' : '',
    ].filter(Boolean).join(' ');
    return (
      <div
        key={session.id}
        className={containerClass}
        style={isSlot ? gridStyleFor(splitMode as '2x1' | '2x2', slot!) : undefined}
        onClick={isSlot ? () => setActiveSession(session.id) : undefined}
        onDragOver={isSlot ? (e) => e.preventDefault() : undefined}
        onDragEnter={isSlot ? () => setDragOverIndex(slot!) : undefined}
        onDragLeave={isSlot ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverIndex(prev => prev === slot ? null : prev); } : undefined}
        onDrop={isSlot ? (e) => {
          e.preventDefault();
          if (dragSrcRef.current !== null && dragSrcRef.current !== slot) swapSplitSlots(dragSrcRef.current, slot!);
          dragSrcRef.current = null;
          setDragOverIndex(null);
        } : undefined}
      >
        {isSlot && (
          <div
            key="header"
            className="pane-header"
            draggable
            onDragStart={() => { dragSrcRef.current = slot!; }}
            onDragEnd={() => { dragSrcRef.current = null; setDragOverIndex(null); }}
          >
            <span className={`pane-working-dot ${workingSessions[session.id] ? 'on' : ''}`} />
            <span className="pane-name" title={session.profileName}>{session.profileName}</span>
            <button
              className="pane-close"
              title="关闭分屏"
              onClick={(e) => { e.stopPropagation(); closeSplitPane(slot!); }}
            >✕</button>
          </div>
        )}
        <div key="body" className="pane-body">
          {session.sessionType === 'editor' ? (
            <Suspense fallback={hidden ? null : <div className="lazy-panel-loading">加载编辑器…</div>}>
              <TextEditor
                key="editor"
                filePath={session.profileId}
                isDirty={session.isDirty ?? false}
                onDirtyChange={(dirty) => updateSession(session.id, { isDirty: dirty })}
                isActive={isActivePane}
              />
            </Suspense>
          ) : (
            <Suspense fallback={hidden ? null : <div className="lazy-panel-loading">加载终端…</div>}>
              <TerminalInstance
                key="term"
                terminalId={session.id}
                colorTheme={resolvedTheme}
                onOutput={handleTerminalInput}
                isActive={isActivePane}
                readOnly={!settings.webApiShareSessions && session.owner === 'web'}
              />
            </Suspense>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="terminal-panel">
      {!settings.enableTabNavigation && sessions.length > 0 && splitMode === 'off' && (
        <TerminalTabBar />
      )}
      <div className={`terminal-content${splitMode !== 'off' ? ` split-grid split-${splitMode}` : ''}`}>
        {settingsTabOpen ? (
          <Suspense fallback={<div className="lazy-panel-loading">加载设置…</div>}>
            <SettingsPage onClose={closeSettingsTab} />
          </Suspense>
        ) : splitMode === 'off' ? (
          sessions.length === 0 ? (
            <div className="terminal-empty">
              <div className="empty-icon">⌨</div>
              <div className="empty-text">点击左侧连接启动终端</div>
            </div>
          ) : (
            sessions.map(session => renderPane(session, { active: activeSessionId === session.id, hidden: false }))
          )
        ) : (
          <>
            {/* Split slots, in order — filled cells keyed by session.id, blanks by index */}
            {splitSlots.map((sid, i) => {
              const session = sid ? sessions.find(s => s.id === sid) : undefined;
              if (!sid || !session) {
                return (
                  <div key={`blank-${i}`} className="split-cell split-blank" style={gridStyleFor(splitMode, i)}>
                    点击左侧连接打开终端
                  </div>
                );
              }
              return renderPane(session, { slot: i, active: activeSessionId === sid, hidden: false });
            })}
            {/* Non-slot sessions: keep mounted but hidden (display:none) so PTY/xterm state survives */}
            {sessions.filter(s => !splitSlots.includes(s.id)).map(session =>
              renderPane(session, { active: false, hidden: true })
            )}
          </>
        )}
      </div>
    </div>
  );
};
