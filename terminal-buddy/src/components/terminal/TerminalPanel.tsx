import { FC, Fragment, useCallback, useState, useEffect, useRef, lazy, Suspense } from 'react';
import type { CSSProperties } from 'react';
import { LoaderCircle, SquareTerminal, X } from 'lucide-react';
import type { TerminalSession } from '../../types';
import { TerminalTabBar } from './TerminalTabBar';
import { isTerminalWorking, useAppStore } from '../../stores/appStore';
import { writeToTerminal } from '../../services/tauri';
import {
  APP_OPACITY_PREVIEW_EVENT,
  getAppOpacity,
  getAppSettings,
  getEffectiveThemeSkin,
  isThemeSkin,
} from '../../utils/settings';
import type {
  AppOpacityPreviewDetail,
  ThemeChangeDetail,
  ThemeSkin,
} from '../../utils/settings';
import { resolveTerminalColors } from '../../utils/terminalTheme';
import { getWorkingDotColor } from '../../utils/tabColor';
import {
  TERMINAL_RESIZE_EVENT,
  TERMINAL_SPLIT_LAYOUT_SETTLE_MS,
  type TerminalResizeDetail,
} from '../../utils/terminalResizeEvent';
import './TerminalPanel.css';

// 懒加载重型组件：避免 xterm.js / monaco-editor 等被全量打进首屏 bundle。
// 此前主 bundle 达 4.69MB，启动时需全部解析执行，是白屏卡顿主因。
// 现仅在用户真正打开终端/编辑器/设置页时才按需加载对应 chunk。
const TerminalInstance = lazy(() => import('./TerminalInstance').then(m => ({ default: m.TerminalInstance })));
const TextEditor = lazy(() => import('../text-editor/TextEditor').then(m => ({ default: m.TextEditor })));
const GitHistoryPage = lazy(() => import('../git/GitHistoryPage').then(m => ({ default: m.GitHistoryPage })));

export const TerminalPanel: FC = () => {
  const sessions = useAppStore(s => s.sessions);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const gitHistoryTab = useAppStore(s => s.gitHistoryTab);
  const closeGitHistoryTab = useAppStore(s => s.closeGitHistoryTab);
  const activeSpecialTab = useAppStore(s => s.activeSpecialTab);
  const updateSession = useAppStore(s => s.updateSession);
  const profiles = useAppStore(s => s.profiles);
  const splitMode = useAppStore(s => s.splitMode);
  const splitSlots = useAppStore(s => s.splitSlots);
  const terminalActivities = useAppStore(s => s.terminalActivities);
  const setActiveSession = useAppStore(s => s.setActiveSession);
  const windowMode = useAppStore(s => s.windowMode);
  const terminalLayoutVersion = useAppStore(s => s.terminalLayoutVersion);
  const closeSplitPane = useAppStore(s => s.closeSplitPane);
  const swapSplitSlots = useAppStore(s => s.swapSplitSlots);
  const [settings, setSettings] = useState(() => getAppSettings());
  const [effectiveTheme, setEffectiveTheme] = useState<ThemeSkin>(() => getEffectiveThemeSkin());

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
          .filter(s => s.sessionType !== 'editor' && s.owner !== 'web')
          .map(s => s.id)
      : splitSlots.map(s => s.sessionId).filter((s): s is string => s !== null);
    if (ids.length === 0) return;

    // 双层 rAF + 30ms 延迟确保 F11 切 panels-hidden 时 .terminal-content.split-grid
    // 的 grid 重排已完全落定后再派发事件，让 fit 拿到稳定尺寸（避免拿到过渡帧的 0
    // 尺寸把 xterm 推到 0×0 不可见状态——黑屏）。
    let raf1 = 0;
    let raf2 = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          timer = null;
          const detail: TerminalResizeDetail = {
            terminalIds: ids,
            layoutVersion: terminalLayoutVersion,
            splitMode,
            windowMode,
            reason: 'split-layout',
          };
          window.dispatchEvent(new CustomEvent(TERMINAL_RESIZE_EVENT, { detail }));
        }, TERMINAL_SPLIT_LAYOUT_SETTLE_MS);
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (timer) clearTimeout(timer);
    };
  }, [splitMode, splitSlots, sessions, activeSessionId, windowMode, terminalLayoutVersion]);

  useEffect(() => {
    const onSettings = () => setSettings(getAppSettings());
    const onTheme = (e: Event) => {
      const skin = (e as CustomEvent<ThemeChangeDetail>).detail?.skin;
      if (isThemeSkin(skin)) setEffectiveTheme(skin);
    };
    const onOpacityPreview = (e: Event) => {
      const detail = (e as CustomEvent<AppOpacityPreviewDetail>).detail;
      if (!detail) return;
      setSettings(current => ({
        ...current,
        appOpacityBySkin: {
          ...current.appOpacityBySkin,
          [detail.skin]: detail.opacity,
        },
      }));
    };
    window.addEventListener('tab-navigation-changed', onSettings);
    window.addEventListener('app-settings-changed', onSettings);
    window.addEventListener('app-theme-changed', onTheme);
    window.addEventListener(APP_OPACITY_PREVIEW_EVENT, onOpacityPreview);
    return () => {
      window.removeEventListener('tab-navigation-changed', onSettings);
      window.removeEventListener('app-settings-changed', onSettings);
      window.removeEventListener('app-theme-changed', onTheme);
      window.removeEventListener(APP_OPACITY_PREVIEW_EVENT, onOpacityPreview);
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
    const appOpacity = getAppOpacity(settings, effectiveTheme);
    const resolvedTheme = resolveTerminalColors(
      profile,
      effectiveTheme,
      settings.terminalFollowAppTheme,
      appOpacity,
    );
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
            <span
              className={`pane-working-dot ${isTerminalWorking(terminalActivities[session.id]) ? 'on' : ''}`}
              style={{ background: getWorkingDotColor(isTerminalWorking(terminalActivities[session.id]), session.tabColor) }}
            />
            <span className="pane-name" title={session.profileName}>{session.profileName}</span>
            <button
              className="pane-close"
              title="关闭分屏"
              aria-label={`关闭分屏 ${session.profileName}`}
              onClick={(e) => { e.stopPropagation(); closeSplitPane(slot!); }}
            ><X aria-hidden="true" /></button>
          </div>
        )}
        <div key="body" className="pane-body">
          {session.starting ? (
            <div className="terminal-starting" role="status" aria-live="polite">
              <LoaderCircle aria-hidden="true" />
              <span>正在启动 {session.profileName}…</span>
            </div>
          ) : session.sessionType === 'editor' ? (
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
                visible={!hidden}
                readOnly={!settings.webApiShareSessions && session.owner === 'web'}
                splitMode={splitMode}
              />
            </Suspense>
          )}
        </div>
      </div>
    );
  };

  const renderTerminalContent = () => {
    if (splitMode === 'off' && sessions.length === 0) {
      return (
        <div className="terminal-empty">
          <SquareTerminal className="empty-icon" aria-hidden="true" />
          <div className="empty-text">暂无终端会话</div>
        </div>
      );
    }

    return (
      <>
        {splitMode !== 'off' && (
          <Fragment key="split-blanks">
            {splitSlots.map((slot, i) => {
              const sessionExists = slot.sessionId && sessions.some(session => session.id === slot.sessionId);
              if (sessionExists) return null;
              return (
                <div key={`blank-${i}`} className="split-cell split-blank" style={gridStyleFor(splitMode, i)}>
                  暂无终端会话
                </div>
              );
            })}
          </Fragment>
        )}
        {/* Keep every session in this same keyed list across all layout modes. Moving a
            terminal between the hidden pool and a split slot must not remount xterm. */}
        <Fragment key="terminal-sessions">
          {sessions.map(session => {
            if (splitMode === 'off') {
              return renderPane(session, {
                active: activeSpecialTab === null && activeSessionId === session.id,
                hidden: false,
              });
            }
            const slot = splitSlots.findIndex(item => item.sessionId === session.id);
            return renderPane(session, {
              ...(slot >= 0 ? { slot } : {}),
              active: slot >= 0 && activeSpecialTab === null && activeSessionId === session.id,
              hidden: slot < 0,
            });
          })}
        </Fragment>
      </>
    );
  };

  return (
    <div className="terminal-panel">
      {!settings.enableTabNavigation && (sessions.length > 0 || gitHistoryTab) && (
        <TerminalTabBar />
      )}
      <div className={`terminal-content${splitMode !== 'off' ? ` split-grid split-${splitMode}` : ''}`}>
        {renderTerminalContent()}
        {gitHistoryTab && activeSpecialTab === 'git-history' && (
          <div className="git-history-tab-content">
            <Suspense fallback={<div className="lazy-panel-loading">加载 Git 历史记录…</div>}>
              <GitHistoryPage
                repoRoot={gitHistoryTab.repoRoot}
                branch={gitHistoryTab.branch}
                onClose={closeGitHistoryTab}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
};
