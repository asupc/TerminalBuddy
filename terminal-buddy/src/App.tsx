import { lazy, Suspense, useEffect, useState, useRef, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { TitleBar } from './components/TitleBar';
import { ConfigNav } from './components/ConfigNav';
import { TerminalPanel } from './components/TerminalPanel';
import { FileNav } from './components/FileNav';
import { TabNav } from './components/TabNav';
import { ActivityBar, type SidebarPanel } from './components/ActivityBar';
import { AiDeliveryNav } from './components/AiDeliveryNav';
import { AiDeliveryWorkspace, type AiDeliveryConfigView } from './components/AiDeliveryWorkspace';
import { AiDeliveryFloatingButton } from './components/AiDeliveryFloatingButton';
import { ConfigEditDialog } from './components/ConfigEditDialog';
import { ExtraParamsDialog } from './components/ExtraParamsDialog';
import { ClaudeDecisionDialog } from './components/ClaudeDecisionDialog';
import { ConfirmDialog } from './components/Dialog';
import { GlobalDialogHost } from './components/GlobalDialogHost';
import { Toast } from './components/Toast';
import { initTheme, applyTheme, getAppSettings, initAppSettings, saveAppSettings, applyListSelectionStyle } from './utils/settings';
import { useAppStore, loadSavedTabs, saveTabsToStorage, initExtraParamPresets, initFileTreeNav } from './stores/appStore';
import { getAllProfiles, startTerminal, startBlankTerminal, updateProfileLastUsed, createProfile, updateProfile, windowExitApp, getFileSize, startMstsc, getBackendAppSettings, writeToTerminal, closeTerminal, getClaudeSessionsForTerminals, checkAppUpdate, detectAiRuntimes, type UpdateInfo } from './services/tauri';
import { compareVersions } from './utils/version';
import { APP_VERSION } from './version';
import { initPersistedTemplates, initCmdOverrides, initCustomCommands } from './data/commandTemplates';
import { migrateLocalStorageToBackend } from './utils/migration';
import { TERMINAL_RESIZE_EVENT, type TerminalResizeDetail } from './utils/terminalResizeEvent';
import { initializeClaudeNotificationActions } from './services/claudeNotification';
import { showAlert } from './services/dialog';
import type { AiRuntimeProbe } from './types/aiDelivery';

const SettingsPage = lazy(() => import('./components/SettingsPage').then(module => ({ default: module.SettingsPage })));

/** Estimate terminal rows/cols from the .terminal-content container size. */
function estimateTerminalSize(): { rows: number; cols: number } {
  const content = document.querySelector('.terminal-content');
  if (!content) return { rows: 0, cols: 0 };
  const w = content.clientWidth;
  const h = content.clientHeight;
  const availW = w - 20; // .xterm padding: 10px each side
  const availH = h - 20;
  const cols = Math.max(2, Math.floor(availW / 8.4));
  const rows = Math.max(1, Math.floor(availH / 17));
  return { rows, cols };
}

function isLocalShellTerminal(terminalType: string): boolean {
  return terminalType === 'powershell' || terminalType === 'pwsh' || terminalType === 'cmd';
}

const RESTORE_TERMINAL_CONCURRENCY = 2;

// 启动探测在模块级缓存，避免 React Strict Mode 重挂载时重复执行。
let startupAiRuntimeProbe: Promise<AiRuntimeProbe[]> | null = null;

function getStartupAiRuntimeProbe(): Promise<AiRuntimeProbe[]> {
  if (!startupAiRuntimeProbe) startupAiRuntimeProbe = detectAiRuntimes();
  return startupAiRuntimeProbe;
}

function waitForNextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}
import type { Profile, TerminalSession } from './types';
import { PRESET_THEMES } from './types';

function App() {
  const setProfiles = useAppStore(s => s.setProfiles);
  const addSession = useAppStore(s => s.addSession);
  const resolveStartingSession = useAppStore(s => s.resolveStartingSession);
  const setSessionDirectory = useAppStore(s => s.setSessionDirectory);
  const setCurrentDirectory = useAppStore(s => s.setCurrentDirectory);
  const configPanelVisible = useAppStore(s => s.configPanelVisible);
  const fileTreeVisible = useAppStore(s => s.fileTreeVisible);
  const toggleConfigPanel = useAppStore(s => s.toggleConfigPanel);
  const toggleFileTree = useAppStore(s => s.toggleFileTree);
  const openSettingsDialog = useAppStore(s => s.openSettingsDialog);
  const settingsDialogOpen = useAppStore(s => s.settingsDialogOpen);
  const closeSettingsDialog = useAppStore(s => s.closeSettingsDialog);
  const profiles = useAppStore(s => s.profiles);
  const windowMode = useAppStore(s => s.windowMode);
  const cycleWindowMode = useAppStore(s => s.cycleWindowMode);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [defaultGroupForNewProfile, setDefaultGroupForNewProfile] = useState<string | undefined>();
  const [showExtraParamsDialog, setShowExtraParamsDialog] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState<{ sessionCount: number } | null>(null);
  const [enableTabNav, setEnableTabNav] = useState(true);
  const [uiStyle, setUiStyle] = useState(() => getAppSettings().uiStyle);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel | null>('config');
  const [aiDeliveryConfigView, setAiDeliveryConfigView] = useState<AiDeliveryConfigView | null>(null);
  const [aiDeliveryNotificationTargetId, setAiDeliveryNotificationTargetId] = useState('');
  const [aiRuntimeProbes, setAiRuntimeProbes] = useState<AiRuntimeProbe[]>([]);
  const [isAiRuntimeDetecting, setIsAiRuntimeDetecting] = useState(true);
  const [aiRuntimeDetectionError, setAiRuntimeDetectionError] = useState('');
  const closeConfirmedRef = useRef(false);
  const restoredRef = useRef(false);
  const applyAiRuntimeProbe = useCallback(async (probe: Promise<AiRuntimeProbe[]>) => {
    setIsAiRuntimeDetecting(true);
    try {
      setAiRuntimeDetectionError('');
      setAiRuntimeProbes(await probe);
    } catch (reason) {
      setAiRuntimeProbes([]);
      setAiRuntimeDetectionError(String(reason));
    } finally {
      setIsAiRuntimeDetecting(false);
    }
  }, []);

  const detectLocalAiRuntimes = useCallback(
    async () => applyAiRuntimeProbe(detectAiRuntimes()),
    [applyAiRuntimeProbe],
  );

  useEffect(() => {
    void applyAiRuntimeProbe(getStartupAiRuntimeProbe());
  }, [applyAiRuntimeProbe]);

  useEffect(() => {
    if (sidebarPanel !== 'aiDelivery') setAiDeliveryConfigView(null);
  }, [sidebarPanel]);

  useEffect(() => {
    if (sidebarPanel !== 'aiDelivery') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      setSidebarPanel('config');
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [sidebarPanel]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>('ai-delivery-notification-activated', (event) => {
      setAiDeliveryNotificationTargetId(event.payload);
      setSidebarPanel('aiDelivery');
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(() => {
    const v = localStorage.getItem('appUpdate.lastCheckedAt');
    return v ? Number(v) : null;
  });

  useEffect(() => {
    checkAppUpdate()
      .then(info => {
        const now = Date.now();
        setLastCheckedAt(now);
        if (!info) return;
        const dismissed = localStorage.getItem('appUpdate.dismissedVersion');
        if (info.version === dismissed) return;
        if (compareVersions(info.version, APP_VERSION) <= 0) return;
        setUpdateInfo(info);
      })
      .catch(() => {});
  }, []);

  // 预加载终端组件 chunk（xterm.js + addons），让 restoreTabs 时不需等待网络/IO
  useEffect(() => {
    void import('./components/TerminalInstance');
  }, []);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void initializeClaudeNotificationActions()
      .then(cleanup => {
        if (cancelled) cleanup();
        else dispose = cleanup;
      })
      .catch(error => console.error('初始化桌面通知失败:', error));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // F11 键监听：切换窗口模式
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F11') return;
      // 同一个 keydown 事件冒泡时会依次经过 document 和 window，两者上的监听器
      // 都会收到。若不去重，一次 F11 会触发两次 cycleWindowMode，导致切换失效。
      if ((e as any)._tbF11Handled) return;
      (e as any)._tbF11Handled = true;
      e.preventDefault();
      cycleWindowMode();
    };
    // 监听 window 和 document，确保全屏模式下也能响应
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [cycleWindowMode]);

  // 监听窗口 resize 事件，确保终端在全屏切换后能正确重绘
  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let raf1 = 0;
    let raf2 = 0;

    const unlisten = listen('tauri://resize', () => {
      // 清除之前的定时器，避免重复触发
      if (resizeTimer) clearTimeout(resizeTimer);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);

      // 使用双层 requestAnimationFrame + setTimeout 确保 CSS 网格布局已完成计算
      // 分屏模式下网格布局更复杂，需要更多时间稳定
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            const { sessions, splitMode, splitSlots, windowMode, terminalLayoutVersion } = useAppStore.getState();
            const terminalIds = splitMode === 'off'
              ? sessions.filter(s => s.sessionType !== 'editor' && s.owner !== 'web').map(s => s.id)
              : splitSlots.map(s => s.sessionId).filter((s): s is string => s !== null);
            if (terminalIds.length > 0) {
              const detail: TerminalResizeDetail = {
                terminalIds,
                layoutVersion: terminalLayoutVersion,
                splitMode,
                windowMode,
                reason: 'window-resize',
              };
              window.dispatchEvent(new CustomEvent(TERMINAL_RESIZE_EVENT, { detail }));
            }
          }, 50); // 额外 50ms 延迟确保布局完全稳定
        });
      });
    });
    return () => {
      unlisten.then(fn => fn());
      if (resizeTimer) clearTimeout(resizeTimer);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  // 应用列表选中样式：设置或主题变化时都重新计算内置配色。
  useEffect(() => {
    const apply = () => applyListSelectionStyle(getAppSettings());
    apply();
    window.addEventListener('app-settings-changed', apply);
    window.addEventListener('app-theme-changed', apply);
    return () => {
      window.removeEventListener('app-settings-changed', apply);
      window.removeEventListener('app-theme-changed', apply);
    };
  }, []);

  useEffect(() => {
    (async () => {
      await migrateLocalStorageToBackend();

      const theme = await initTheme();
      applyTheme(theme);
      await initAppSettings();
      await initFileTreeNav();
      await initExtraParamPresets();
      await initCmdOverrides();
      await initCustomCommands();

      const settings = getAppSettings();

      // Sync backend settings (source of truth) into frontend cache
      try {
        const backend = await getBackendAppSettings();
        const synced = {
          ...settings,
          closeBehavior: backend.closeBehavior,
          launchWindowMode: backend.launchWindowMode,
          enableTabNavigation: backend.enableTabNavigation,
          singleInstance: backend.singleInstance,
          claudeHookConfigDir: backend.claudeHookConfigDir ?? settings.claudeHookConfigDir,
        };
        saveAppSettings(synced);
        setEnableTabNav(synced.enableTabNavigation);
        useAppStore.setState({
          configPanelVisible: synced.configPanelAutoExpand,
          fileTreeVisible: synced.fileTreeAutoExpand,
        });
      } catch {
        setEnableTabNav(settings.enableTabNavigation);
        useAppStore.setState({
          configPanelVisible: settings.configPanelAutoExpand,
          fileTreeVisible: settings.fileTreeAutoExpand,
        });
      }

      initPersistedTemplates();
      await loadProfiles();

      if (!import.meta.env.DEV && settings.restoreTabsOnStartup && !restoredRef.current) {
        restoredRef.current = true;
        await restoreTabs();
        await useAppStore.getState().restoreDraftTabs();
      }
    })();
  }, []);

  // 退出前保存 Claude Code 终端的 session ID（仅在设置开启时）
  const saveClaudeSessionsBeforeExit = useCallback(async () => {
    const settings = getAppSettings();
    if (!settings.autoResumeClaudeSession) return;

    const store = useAppStore.getState();
    const { sessions, profiles } = store;
    if (sessions.length === 0) return;

    // 先筛选出 Claude 终端
    const claudeTerminalIds: string[] = [];
    for (const session of sessions) {
      if (session.sessionType === 'editor') continue;
      const profile = profiles.find(p => p.id === session.profileId);
      const startupCommands = profile?.startupCommands || [];
      const extraParams = session.extraParams || '';
      const hookIdentified = store.terminalActivities[session.id]?.runtimeKind === 'claude';
      const configuredClaude = [...startupCommands, extraParams]
        .some(command => /(^|[\s;&|])claude(?:\.(?:cmd|exe|ps1))?(?=$|\s)/i.test(command));
      const isClaudeTerminal = hookIdentified || configuredClaude;
      if (isClaudeTerminal) claudeTerminalIds.push(session.id);
    }

    if (claudeTerminalIds.length === 0) return;

    // 一次性批量获取所有 Claude 终端的 session ID（单次进程快照）
    let claudeIds: Record<string, string> = {};
    try {
      claudeIds = await getClaudeSessionsForTerminals(claudeTerminalIds);
    } catch {}

    if (Object.keys(claudeIds).length > 0) {
      useAppStore.setState(state => ({
        claudeSessionIds: { ...state.claudeSessionIds, ...claudeIds },
      }));
      // 保存标签（包含更新后的 claudeSessionIds）
      const { sessions: updatedSessions, activeSessionId } = useAppStore.getState();
      saveTabsToStorage(updatedSessions, activeSessionId);
    }
  }, []);

  const handleCloseConfirm = useCallback(async () => {
    closeConfirmedRef.current = true;
    setCloseConfirm(null);

    // 先保存 Claude 会话，然后再退出
    await saveClaudeSessionsBeforeExit();
    windowExitApp();
  }, [saveClaudeSessionsBeforeExit]);

  useEffect(() => {
    const handler = () => setEnableTabNav(getAppSettings().enableTabNavigation);
    window.addEventListener('tab-navigation-changed', handler);
    return () => window.removeEventListener('tab-navigation-changed', handler);
  }, []);

  useEffect(() => {
    const handler = () => setUiStyle(getAppSettings().uiStyle);
    window.addEventListener('app-settings-changed', handler);
    return () => window.removeEventListener('app-settings-changed', handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const terminalId = (event as CustomEvent<{ terminalId?: string }>).detail?.terminalId;
      if (!terminalId) return;
      const store = useAppStore.getState();
      if (!store.sessions.some((session) => session.id === terminalId)) return;
      store.setActiveSession(terminalId);
      setSidebarPanel(uiStyle === 'sidebar' && enableTabNav ? 'tabs' : 'config');
    };
    window.addEventListener('open-ai-attempt-terminal', handler);
    return () => window.removeEventListener('open-ai-attempt-terminal', handler);
  }, [enableTabNav, uiStyle]);

  // Listen for terminals created/closed via Web API to sync with desktop UI
  useEffect(() => {
    const unlistenCreated = listen<{ id: string; profileId: string; profileName: string; terminalType: string; owner: 'pc' | 'web'; groupId?: string; groupName?: string; extraParamTag?: string; extraParamTagColor?: string }>('terminal-created', (event) => {
      const { id, profileId, profileName, terminalType, owner, groupId, groupName, extraParamTag, extraParamTagColor } = event.payload;
      const store = useAppStore.getState();
      let resolvedGroupId = groupId || 'default';
      if (groupId && groupName) {
        const existingProjectGroup = store.groups.find((group) => group.id === groupId);
        const existingNamedGroup = store.groups.find((group) => group.name === groupName);
        resolvedGroupId = existingProjectGroup?.id || existingNamedGroup?.id || groupId;
        if (existingProjectGroup) {
          useAppStore.setState((state) => ({
            groups: state.groups.map((group) => group.id === groupId ? { ...group, name: groupName } : group),
          }));
        } else if (!existingNamedGroup) {
          useAppStore.setState((state) => ({
            groups: [...state.groups, { id: groupId, name: groupName, collapsed: false }],
          }));
        }
      }
      const profile = store.profiles.find((p) => p.id === profileId);
      const theme = PRESET_THEMES.find((t) => t.id === profile?.colorTheme) || PRESET_THEMES[0];
      const existingSession = useAppStore.getState().sessions.find((session) => session.id === id);
      if (existingSession) {
        store.updateSession(id, {
          profileName,
          groupId: groupId ? resolvedGroupId : existingSession.groupId,
          groupName: groupName ?? existingSession.groupName,
          extraParamTag,
          extraParamTagColor: extraParamTagColor ?? null,
        });
        return;
      }
      // Add session but do NOT auto-switch active tab — the terminal was
      // opened from the web, so the user is looking at the web, not here.
      store.addSession({
        id,
        profileId,
        profileName,
        terminalType: terminalType as any,
        colorTheme: { background: theme.background, foreground: theme.foreground },
        tabColor: profile?.tabColor || null,
        groupId: resolvedGroupId,
        groupName,
        owner,
        extraParamTag,
        extraParamTagColor: extraParamTagColor ?? null,
      }, true);
    });

    const unlistenClosed = listen<string>('terminal-closed', (event) => {
      useAppStore.getState().removeSession(event.payload);
    });

    // Listen for tray exit request to show confirmation dialog
    const unlistenTrayExit = listen('tray-exit-requested', () => {
      if (closeConfirmedRef.current) return;
      const { sessions } = useAppStore.getState();
      if (sessions.length > 0) {
        setCloseConfirm({ sessionCount: sessions.length });
      } else {
        // 无终端时也需要保存 Claude 会话
        saveClaudeSessionsBeforeExit().then(() => windowExitApp());
      }
    });

    return () => {
      unlistenCreated.then((f) => f());
      unlistenClosed.then((f) => f());
      unlistenTrayExit.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (closeConfirmedRef.current) return;
      const settings = getAppSettings();
      if (settings.closeBehavior === 'tray') return; // tray mode handled by Rust

      event.preventDefault();
      const { sessions } = useAppStore.getState();
      if (sessions.length > 0) {
        setCloseConfirm({ sessionCount: sessions.length });
      } else {
        // 无终端时也需要保存 Claude 会话
        await saveClaudeSessionsBeforeExit();
        windowExitApp();
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [saveClaudeSessionsBeforeExit]);

  const handleCloseCancel = useCallback(() => {
    setCloseConfirm(null);
  }, []);

  const restoreTabs = async () => {
    const { tabs, activeIndex } = await loadSavedTabs();
    if (tabs.length === 0) return;
    const store = useAppStore.getState();
    const restoredSessionIds: Array<string | undefined> = new Array(tabs.length);
    // 暂停逐次写入，恢复完后统一写一次
    useAppStore.setState({ _skipSaveTabs: true });
    try {
      const restoreTab = async (i: number) => {
        const tab = tabs[i];
        try {
          if (tab.sessionType === 'editor') {
            // Editor tabs don't need a PTY — create session directly
            store.ensureEditorGroup();
            try {
              await getFileSize(tab.profileId);
              const session: TerminalSession = {
                id: crypto.randomUUID(),
                profileId: tab.profileId,
                profileName: tab.profileName,
                terminalType: 'editor',
                colorTheme: tab.colorTheme,
                tabColor: tab.tabColor,
                groupId: 'editor-group',
                sessionType: 'editor',
                isDirty: false,
              };
              store.addSession(session, true);
              restoredSessionIds[i] = session.id;
              if (i === activeIndex || useAppStore.getState().activeSessionId === null) {
                store.setActiveSession(session.id);
              }
            } catch {
              // File no longer exists, skip this tab
            }
          } else {
            const { rows: estRows, cols: estCols } = estimateTerminalSize();
            // 清理 extraParams 中已有的 --resume 参数（防止历史数据叠加）
            const baseParams = (tab.extraParams || '')
              .replace(/--resume\s+[0-9a-fA-F-]+/g, '')
              .replace(/\s+/g, ' ')
              .trim();
            // 构建启动参数：临时追加 --resume（不存入 session，避免下次叠加）
            let launchParams = baseParams;
            if (tab.claudeSessionId && tab.profileId) {
              const settings = getAppSettings();
              if (settings.autoResumeClaudeSession) {
                const resumeParam = `--resume ${tab.claudeSessionId}`;
                launchParams = launchParams ? `${launchParams} ${resumeParam}` : resumeParam;
              }
            }
            const startupPath = tab.directory && isLocalShellTerminal(tab.terminalType)
              ? tab.directory
              : undefined;
            const terminalId = tab.profileId
              ? await startTerminal(tab.profileId, launchParams, estRows, estCols, tab.profileName, startupPath)
              : await startBlankTerminal(tab.terminalType as 'powershell' | 'pwsh' | 'cmd' | 'ssh' | 'docker' | 'k8s', estRows, estCols, startupPath, tab.profileName);
            store.addSession({
              id: terminalId,
              profileId: tab.profileId,
              profileName: tab.profileName,
              terminalType: tab.terminalType as any,
              colorTheme: tab.colorTheme,
              tabColor: tab.tabColor,
              groupId: tab.groupId || 'default',
              groupName: tab.groupName,
              owner: 'pc',
              extraParams: baseParams,
              extraParamTag: tab.extraParamTag,
              extraParamTagColor: tab.extraParamTagColor ?? null,
            }, true);
            restoredSessionIds[i] = terminalId;
            // 保存 claudeSessionId 到 store
            if (tab.claudeSessionId) {
              store.setClaudeSessionId(terminalId, tab.claudeSessionId);
            }
            // 恢复上次记录的目录：本地 shell 直接用启动 cwd，避免恢复时额外写入
            // 可见的 cd 命令与后端启动命令（powershell/claude）发生竞态。
            if (tab.directory) {
              store.setSessionDirectory(terminalId, tab.directory);
              if (!startupPath) {
                writeToTerminal(terminalId, `cd "${tab.directory}"\r`).catch(() => {});
              }
            }
            if (i === activeIndex || useAppStore.getState().activeSessionId === null) {
              store.setActiveSession(terminalId);
            }
          }
        } catch (err) {
          console.error('Failed to restore tab:', tab.profileName, err);
        }
      };

      // 优先恢复并展示上次活动标签，避免等待全部终端启动后才出现可操作界面。
      await restoreTab(activeIndex);

      const pendingIndexes = tabs
        .map((_, index) => index)
        .filter(index => index !== activeIndex);
      let nextPendingIndex = 0;
      const worker = async () => {
        while (nextPendingIndex < pendingIndexes.length) {
          const index = pendingIndexes[nextPendingIndex++];
          // 启动下一项前先让出一帧，并用 worker 上限控制重型组件的初始化峰值。
          await waitForNextFrame();
          await restoreTab(index);
        }
      };
      const workerCount = Math.min(RESTORE_TERMINAL_CONCURRENCY, pendingIndexes.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      // 并发完成顺序不稳定，恢复为保存时的标签顺序，同时保留恢复期间外部新建的会话。
      const restoredIdSet = new Set(restoredSessionIds.filter((id): id is string => id !== undefined));
      useAppStore.setState(state => {
        const sessionsById = new Map(state.sessions.map(session => [session.id, session]));
        const restoredSessions = restoredSessionIds
          .map(id => id ? sessionsById.get(id) : undefined)
          .filter((session): session is TerminalSession => session !== undefined);
        const otherSessions = state.sessions.filter(session => !restoredIdSet.has(session.id));
        return { sessions: [...restoredSessions, ...otherSessions] };
      });
      const restoredActiveId = restoredSessionIds[activeIndex]
        ?? restoredSessionIds.find((id): id is string => id !== undefined)
        ?? null;
      store.setActiveSession(restoredActiveId);
      useAppStore.setState({ _skipSaveTabs: false });
      const { sessions, activeSessionId } = useAppStore.getState();
      saveTabsToStorage(sessions, activeSessionId);
    }
  };

  const loadProfiles = useCallback(async () => {
    try {
      const data = await getAllProfiles();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to load profiles:', err);
    }
  }, [setProfiles]);

  const handleStartTerminal = useCallback(async (profile: Profile, extraParams?: string, _presetName?: string, tabName?: string, presetTag?: string, presetTagColor?: string | null) => {
    let startingId: string | null = null;
    try {
      if (profile.terminalType === 'mstsc') {
        await startMstsc(profile.id);
        await updateProfileLastUsed(profile.id);
        return;
      }
      // Split mode: when the grid is full, placeSessionInSplitSlot will auto-replace the oldest slot.
      const { rows, cols } = estimateTerminalSize();
      const resolvedTabName = tabName ?? profile.name;
      const theme = PRESET_THEMES.find(t => t.id === profile.colorTheme) || PRESET_THEMES[0];
      startingId = crypto.randomUUID();
      addSession({
        id: startingId,
        profileId: profile.id,
        profileName: resolvedTabName,
        terminalType: profile.terminalType,
        colorTheme: { background: theme.background, foreground: theme.foreground },
        tabColor: profile.tabColor || null,
        groupId: 'default',
        owner: 'pc',
        extraParams,
        extraParamTag: presetTag,
        extraParamTagColor: presetTagColor ?? null,
        starting: true,
      });
      const pendingStore = useAppStore.getState();
      if (pendingStore.splitMode !== 'off') pendingStore.placeSessionInSplitSlot(startingId);

      const terminalId = await startTerminal(profile.id, extraParams, rows, cols, resolvedTabName, undefined, presetTag, presetTagColor ?? null);
      if (!resolveStartingSession(startingId, terminalId)) {
        void closeTerminal(terminalId).catch(() => {});
        return;
      }
      void updateProfileLastUsed(profile.id).catch(err => console.error('Failed to update profile last used:', err));
      if (profile.startupPath) {
        setSessionDirectory(terminalId, profile.startupPath);
        setCurrentDirectory(profile.startupPath);
      }
    } catch (err) {
      const startingSessionVisible = startingId !== null
        && useAppStore.getState().sessions.some(session => session.id === startingId);
      if (startingId) useAppStore.getState().removeSession(startingId);
      if (startingSessionVisible) void showAlert('启动终端失败: ' + String(err), '启动失败');
    }
  }, [addSession, resolveStartingSession]);

  const handleEditProfile = useCallback((profile: Profile) => {
    setDefaultGroupForNewProfile(undefined);
    setEditingProfile(profile);
    setShowEditDialog(true);
  }, []);

  const handleCopyProfile = useCallback(async (profile: Profile) => {
    try {
      const newProfile = await createProfile(
        `${profile.name} (副本)`,
        profile.group,
        profile.terminalType as 'powershell' | 'pwsh' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'mstsc'
      );
      await updateProfile({
        ...newProfile,
        startupPath: profile.startupPath,
        startupCommands: profile.startupCommands,
        environmentVariables: profile.environmentVariables,
        colorTheme: profile.colorTheme,
        windowSize: profile.windowSize,
        sshHost: profile.sshHost,
        sshPort: profile.sshPort,
        sshUser: profile.sshUser,
        sshAuthType: profile.sshAuthType,
        sshKeyPath: profile.sshKeyPath,
        sshPassword: profile.sshPassword,
        dockerContainerId: profile.dockerContainerId,
        dockerContainerName: profile.dockerContainerName,
        k8sNamespace: profile.k8sNamespace,
        k8sPodName: profile.k8sPodName,
        k8sContainerName: profile.k8sContainerName,
        mstscHost: profile.mstscHost,
        mstscPort: profile.mstscPort,
        mstscUser: profile.mstscUser,
        mstscPassword: profile.mstscPassword,
        mstscResolution: profile.mstscResolution,
      });
      await loadProfiles();
    } catch (err) {
      console.error('Failed to copy profile:', err);
    }
  }, [loadProfiles]);

  const handleSettings = useCallback(() => {
    openSettingsDialog();
  }, [openSettingsDialog]);

  const handleStartBlankTerminal = useCallback(async (terminalType: 'powershell' | 'pwsh' | 'cmd') => {
    let startingId: string | null = null;
    try {
      const store = useAppStore.getState();
      if (store.splitMode !== 'off' && !store.splitSlots.some(s => s.sessionId === null)) {
        store.showToast('分屏模式已满，请先关闭某个分屏或退出分屏', 'info');
        return;
      }
      const name = terminalType === 'powershell' ? 'PowerShell' : terminalType === 'pwsh' ? 'PowerShell 7' : 'CMD';
      const { rows, cols } = estimateTerminalSize();
      startingId = crypto.randomUUID();
      addSession({
        id: startingId,
        profileId: '',
        profileName: name,
        terminalType,
        colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
        tabColor: null,
        groupId: 'default',
        owner: 'pc',
        starting: true,
      });
      const pendingStore = useAppStore.getState();
      if (pendingStore.splitMode !== 'off') pendingStore.placeSessionInSplitSlot(startingId);

      const terminalId = await startBlankTerminal(terminalType, rows, cols, undefined, name);
      if (!resolveStartingSession(startingId, terminalId)) {
        void closeTerminal(terminalId).catch(() => {});
      }
    } catch (err) {
      const startingSessionVisible = startingId !== null
        && useAppStore.getState().sessions.some(session => session.id === startingId);
      if (startingId) useAppStore.getState().removeSession(startingId);
      console.error('Failed to start blank terminal:', err);
      if (startingSessionVisible) void showAlert('启动终端失败: ' + String(err), '启动失败');
    }
  }, [addSession, resolveStartingSession]);

  const handleStartTextEditor = useCallback(() => {
    useAppStore.getState().openDraftSession();
  }, []);

  const handleAddProfile = useCallback((defaultGroup?: string) => {
    setDefaultGroupForNewProfile(defaultGroup);
    setEditingProfile(null);
    setShowEditDialog(true);
  }, []);

  const handleDialogSave = useCallback(() => {
    setShowEditDialog(false);
    loadProfiles();
  }, [loadProfiles]);

  const handleDialogClose = useCallback(() => {
    setShowEditDialog(false);
  }, []);

  const handlePromoteToUpdate = useCallback((info: UpdateInfo) => {
    const dismissed = localStorage.getItem('appUpdate.dismissedVersion');
    if (info.version === dismissed) return;
    if (compareVersions(info.version, APP_VERSION) <= 0) return;
    setUpdateInfo(info);
  }, []);

  const handleSidebarPanel = useCallback((panel: SidebarPanel) => {
    if (panel === 'config' || panel === 'tabs') {
      useAppStore.getState().setLastClickRegion(panel === 'config' ? 'config' : 'tab');
    } else {
      useAppStore.getState().setLastClickRegion(null);
    }

    setSidebarPanel(current => {
      if (panel === 'config' && !useAppStore.getState().configPanelVisible) {
        useAppStore.getState().toggleConfigPanel();
        return panel;
      }
      if (panel === 'files' && !useAppStore.getState().fileTreeVisible) {
        useAppStore.getState().toggleFileTree();
        return panel;
      }
      if (current === panel) return null;
      return panel;
    });
  }, []);

  const handleToggleAiDelivery = useCallback(() => {
    useAppStore.getState().setLastClickRegion(null);
    setSidebarPanel(current => current === 'aiDelivery' ? 'config' : 'aiDelivery');
  }, []);

  return (
    <div className={`app-container ui-style-${uiStyle}${windowMode === 'panels-hidden' ? ' panels-hidden' : ''}`} tabIndex={0}>
      <TitleBar
        uiStyle={uiStyle}
        onSettings={handleSettings}
        configPanelVisible={configPanelVisible}
        fileTreeVisible={fileTreeVisible}
        onToggleConfigPanel={toggleConfigPanel}
        onToggleFileTree={toggleFileTree}
        updateInfo={updateInfo}
        onUpdateDismiss={() => setUpdateInfo(null)}
        onPromoteToUpdate={handlePromoteToUpdate}
        lastCheckedAt={lastCheckedAt}
        onUpdateLastChecked={setLastCheckedAt}
      />
      <div className="main-content">
        {uiStyle === 'sidebar' && (
          <ActivityBar
            activePanel={sidebarPanel}
            tabNavigationEnabled={enableTabNav}
            onSelectPanel={handleSidebarPanel}
            onSettings={handleSettings}
          />
        )}
        {sidebarPanel !== 'aiDelivery' && (
          <div className={`nav-panel-slot nav-panel-config${sidebarPanel === 'config' ? ' active' : ''}`}>
            <ConfigNav
              isActive={windowMode !== 'panels-hidden' && (uiStyle !== 'sidebar' || sidebarPanel === 'config')}
              isSidebarMode={uiStyle === 'sidebar'}
              onStartTerminal={handleStartTerminal}
              onEditProfile={handleEditProfile}
              onCopyProfile={handleCopyProfile}
              onAddProfile={handleAddProfile}
              onManageExtraParams={() => setShowExtraParamsDialog(true)}
            />
          </div>
        )}
        {sidebarPanel === 'aiDelivery' && (
          <div className={`nav-panel-slot nav-panel-ai-delivery${sidebarPanel === 'aiDelivery' ? ' active' : ''}`}>
            <AiDeliveryNav
              runtimes={aiRuntimeProbes}
              isDetecting={isAiRuntimeDetecting}
              error={aiRuntimeDetectionError}
              onDetect={detectLocalAiRuntimes}
              onOpenConfiguration={setAiDeliveryConfigView}
            />
          </div>
        )}
        {sidebarPanel !== 'aiDelivery' && <div className={`nav-panel-slot nav-panel-files${sidebarPanel === 'files' ? ' active' : ''}`}>
          <FileNav isSidebarMode={uiStyle === 'sidebar'} />
        </div>}
        {sidebarPanel !== 'aiDelivery' && enableTabNav && (
          <div className={`nav-panel-slot nav-panel-tabs${sidebarPanel === 'tabs' ? ' active' : ''}`}>
            <TabNav
              isActive={windowMode !== 'panels-hidden' && (uiStyle !== 'sidebar' || sidebarPanel === 'tabs')}
              isSidebarMode={uiStyle === 'sidebar'}
              profiles={profiles}
              onStartTerminal={handleStartTerminal}
              onStartBlankTerminal={handleStartBlankTerminal}
              onStartTextEditor={handleStartTextEditor}
            />
          </div>
        )}
        {sidebarPanel === 'aiDelivery' ? (
          <AiDeliveryWorkspace
            runtimes={aiRuntimeProbes}
            isRuntimeDetecting={isAiRuntimeDetecting}
            notificationTargetDeliveryId={aiDeliveryNotificationTargetId}
            onNotificationTargetHandled={() => setAiDeliveryNotificationTargetId('')}
            configDialogView={aiDeliveryConfigView}
            onConfigDialogViewChange={setAiDeliveryConfigView}
          />
        ) : <TerminalPanel />}
      </div>
      <AiDeliveryFloatingButton
        active={sidebarPanel === 'aiDelivery'}
        onToggle={handleToggleAiDelivery}
      />
      {showEditDialog && (
        <ConfigEditDialog
          profile={editingProfile}
          onClose={handleDialogClose}
          onSave={handleDialogSave}
          defaultGroup={defaultGroupForNewProfile}
          profiles={profiles}
        />
      )}
      {showExtraParamsDialog && (
        <ExtraParamsDialog onClose={() => setShowExtraParamsDialog(false)} />
      )}
      {settingsDialogOpen && (
        <Suspense fallback={<div className="settings-dialog-loading">加载设置…</div>}>
          <SettingsPage onClose={closeSettingsDialog} />
        </Suspense>
      )}
      {closeConfirm && (
        <ConfirmDialog
          title="确认退出"
          message={`当前有 ${closeConfirm.sessionCount} 个终端正在运行，确定要退出吗？`}
          onClose={handleCloseCancel}
          onConfirm={handleCloseConfirm}
          confirmText="退出"
        />
      )}
      <ClaudeDecisionDialog />
      <Toast />
      <GlobalDialogHost />
    </div>
  );
}

export default App;
