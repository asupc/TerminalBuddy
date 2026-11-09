import { useTerminalTaskSummaries } from './hooks/useTerminalTaskSummaries';
import { useAgentTabStatusSync } from './hooks/useAgentTabStatusSync';
﻿import { lazy, Suspense, useEffect, useState, useCallback, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { TitleBar } from "./components/shell/TitleBar";
import { ConfigNav } from "./components/profile-config/ConfigNav";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { FileNav } from "./components/file-explorer/FileNav";
import { HistoryPanel } from "./components/claude-history/HistoryPanel";
import { TabNav } from "./components/shell/TabNav";
import { ActivityBar, type SidebarPanel } from "./components/shell/ActivityBar";
import { effectiveProfilePath } from './utils/projectPath';
import { containsClaudeRef } from './utils/claudeLaunch';
import { ConfigEditDialog } from "./components/profile-config/ConfigEditDialog";
import { ExtraParamsDialog } from "./components/profile-config/ExtraParamsDialog";
import { ClaudeDecisionDialog } from "./components/shared/ClaudeDecisionDialog";
import { ConfirmDialog } from "./components/shared/Dialog";
import { GlobalDialogHost } from "./components/shared/GlobalDialogHost";
import { Toast } from "./components/shared/Toast";
import { initTheme, applyTheme, getAppSettings, initAppSettings, saveAppSettings, applyListSelectionStyle } from './utils/settings';
import { useAppStore, saveTabsToStorage, initExtraParamPresets, initFileTreeNav } from './stores/appStore';
import { flushPendingSaveTabs } from './stores/slices/sessionsSlice';
import { getAllProfiles, getProjects, startTerminal, startBlankTerminal, updateProfileLastUsed, createProfile, updateProfile, windowExitApp, startMstsc, getBackendAppSettings, getClaudeSessionsForTerminals, getAgentSessionsForTerminals, checkAppUpdate, readClientData, type UpdateInfo } from './services/tauri';
import { compareVersions } from './utils/version';
import { APP_VERSION } from './version';
import { initPersistedTemplates, initCmdOverrides, initCustomCommands } from './data/commandTemplates';
import { migrateLocalStorageToBackend } from './utils/migration';
import { TERMINAL_RESIZE_EVENT, type TerminalResizeDetail } from './utils/terminalResizeEvent';
import { initializeClaudeNotificationActions } from './services/claudeNotification';
import { initAppHotkeys, registerHotkeyAction } from './services/hotkeys';
import { restoreTabs, launchTerminalSession, reconcileBackendSessions, markStartupRestoreComplete, scheduleBrowserResync, restoreAgentChatTabs } from './services/sessionRestore';
import { useExitConfirm } from './hooks/useExitConfirm';
import { clientTerminalOwner, isBrowserClient } from './services/platform';

const SettingsPage = lazy(() => import('./components/settings/SettingsPage').then(module => ({ default: module.SettingsPage })));

/**
 * 启动恢复的单次初始化守卫：dev 与 prod 行为一致。
 * - 模块级 Promise 只创建一次，React StrictMode 的 mount → unmount → remount
 *   会共享同一次恢复，不会重复创建已恢复的终端；
 * - 失败时把 Promise 清空，允许下一次完整应用启动重试，不会永久卡在半完成标记。
 */
let restoreTabsPromise: Promise<void> | null = null;
function restoreTabsOnce(): Promise<void> {
  if (!restoreTabsPromise) {
    restoreTabsPromise = restoreTabs().catch((error) => {
      console.error('Startup tab restore failed:', error);
      restoreTabsPromise = null;
    });
  }
  return restoreTabsPromise;
}


import type { ExtraParamMode, Profile, TerminalSession } from './types';
import { PRESET_THEMES } from './types';

function App() {
  useTerminalTaskSummaries();
  useAgentTabStatusSync();
  const setProfiles = useAppStore(s => s.setProfiles);
  const setProjects = useAppStore(s => s.setProjects);
  const addSession = useAppStore(s => s.addSession);
  const resolveStartingSession = useAppStore(s => s.resolveStartingSession);
  const setSessionDirectory = useAppStore(s => s.setSessionDirectory);
  const setCurrentDirectory = useAppStore(s => s.setCurrentDirectory);
  const configPanelVisible = useAppStore(s => s.configPanelVisible);
  const fileTreeVisible = useAppStore(s => s.fileTreeVisible);
  const historyPanelVisible = useAppStore(s => s.historyPanelVisible);
  const toggleConfigPanel = useAppStore(s => s.toggleConfigPanel);
  const toggleFileTree = useAppStore(s => s.toggleFileTree);
  const toggleHistoryPanel = useAppStore(s => s.toggleHistoryPanel);
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
  const [enableTabNav, setEnableTabNav] = useState(true);
  const [uiStyle, setUiStyle] = useState(() => getAppSettings().uiStyle);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel | null>('config');
  // 侧栏风格下面板互斥：历史 / Claude 面板首次点开才挂载（挂载后常驻，保留编辑态）。
  // 两者一挂载就会扫 ~/.claude 与历史索引库，不该压在启动路径上。
  const [everOpened, setEverOpened] = useState({ history: false });
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(() => {
    const v = localStorage.getItem('appUpdate.lastCheckedAt');
    return v ? Number(v) : null;
  });

  useEffect(() => {
    const onOpenEdit = (e: any) => {
      setEditingProfile(e.detail?.profile || profiles[0] || null);
      setShowEditDialog(true);
    };
    const onOpenExtra = () => setShowExtraParamsDialog(true);
    window.addEventListener('mock-open-profile-edit', onOpenEdit);
    window.addEventListener('mock-open-extra-params', onOpenExtra);
    return () => {
      window.removeEventListener('mock-open-profile-edit', onOpenEdit);
      window.removeEventListener('mock-open-extra-params', onOpenExtra);
    };
  }, [profiles]);

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
    void import('./components/terminal/TerminalInstance');
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
              ? sessions.filter(s => s.sessionType !== 'editor' && s.owner === clientTerminalOwner()).map(s => s.id)
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
    void (async () => {
      await migrateLocalStorageToBackend();

      const theme = await initTheme();
      applyTheme(theme);
      await initAppSettings();
      await initFileTreeNav();
      await initExtraParamPresets();
      await initCmdOverrides();
      await initCustomCommands();

      // 文件排除规则回读（审查 H-9）：持久化在 ClientData/exclusion_patterns，
      // 读取失败或无记录时保持默认规则。直接 setState，避免触发 action 里的写回。
      try {
        const rawExclusions = await readClientData('exclusion_patterns');
        if (rawExclusions) {
          const parsed = JSON.parse(rawExclusions);
          // 空数组是用户明确清空规则的结果，必须原样恢复；只有「无记录」才保持默认。
          if (Array.isArray(parsed) && parsed.every(p => typeof p === 'string')) {
            useAppStore.setState({ exclusionPatterns: parsed });
          }
        }
      } catch { /* 保持默认规则 */ }

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
        // Agent 基础启动命令（后端为数据源；浏览器模式在 WebEntry 里经 /api/runtime 提前写入）
        const commands = backend.agentCommands ?? { claude: '', codex: '' };
        useAppStore.getState().setAgentCommands({
          claude: commands.claude ?? '',
          codex: commands.codex ?? '',
        });
        saveAppSettings(synced);
        setEnableTabNav(synced.enableTabNavigation);
        useAppStore.setState({
          configPanelVisible: synced.configPanelAutoExpand,
          fileTreeVisible: synced.fileTreeAutoExpand,
          historyPanelVisible: synced.historyPanelAutoExpand,
        });
      } catch {
        setEnableTabNav(settings.enableTabNavigation);
        useAppStore.setState({
          configPanelVisible: settings.configPanelAutoExpand,
          fileTreeVisible: settings.fileTreeAutoExpand,
          historyPanelVisible: settings.historyPanelAutoExpand,
        });
      }

      initPersistedTemplates();
      await loadProfiles();

      // dev（Vite 开发服务器）下不自动恢复：改代码重启频繁，恢复会连带拉起一堆
      // claude --resume 会话。设置项语义不变，发布版照旧按开关执行。
      if (settings.restoreTabsOnStartup && !import.meta.env.DEV) {
        await restoreTabsOnce();
        await useAppStore.getState().restoreDraftTabs();
      } else {
        // 聊天标签不拉起任何进程；即使用户关闭了终端页签恢复，也保留上次打开的 AI 会话。
        await restoreAgentChatTabs();
      }
      // 恢复完成后补一次账：启动期间（WebView 就绪前）建立的会话没有 terminal-created
      // 事件可收，默认终端 handoff 冷启动就属于这一类。
      await reconcileBackendSessions();
    })().finally(() => {
      // 启动流程结束（成功或失败）后才允许 web-resync 走重启恢复，避免与初始恢复并发。
      markStartupRestoreComplete();
    });
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
      const configuredCommands = session.extraParamMode === 'independent'
        ? [extraParams]
        : [...startupCommands, extraParams];
      const configuredClaude = configuredCommands
        .some(command => /(^|[\s;&|])claude(?:\.(?:cmd|exe|ps1))?(?=$|\s)/i.test(command) || containsClaudeRef(command));
      const isClaudeTerminal = hookIdentified || configuredClaude;
      if (isClaudeTerminal) claudeTerminalIds.push(session.id);
    }

    // 一次性批量获取所有 Claude 终端的 session ID（单次进程快照）
    let claudeIds: Record<string, string> = {};
    if (claudeTerminalIds.length > 0) {
      try {
        claudeIds = await getClaudeSessionsForTerminals(claudeTerminalIds);
      } catch {}
    }

    if (Object.keys(claudeIds).length > 0) {
      useAppStore.setState(state => ({
        claudeSessionIds: { ...state.claudeSessionIds, ...claudeIds },
      }));
    }
    // 统一 Agent 绑定（含 Codex）一并落盘，容器重启后按 provider 拼恢复命令。
    try {
      const ids = sessions.filter(session => session.sessionType !== 'editor').map(session => session.id);
      const bindings = await getAgentSessionsForTerminals(ids);
      useAppStore.setState(state => {
        const agentSessionBindings = { ...state.agentSessionBindings };
        for (const [terminalId, record] of Object.entries(bindings)) {
          agentSessionBindings[terminalId] = {
            provider: record.provider,
            sessionId: record.sessionId,
            sessionFile: record.sessionFile,
            cwd: record.cwd,
          };
        }
        return { agentSessionBindings };
      });
    } catch {}
    {
      // 保存标签（包含更新后的 claudeSessionIds / agentSessionBindings）
      const { sessions: updatedSessions, activeSessionId } = useAppStore.getState();
      saveTabsToStorage(updatedSessions, activeSessionId);
    }
  }, []);

  const { closeConfirm, requestExit, confirmExit, cancelExit } = useExitConfirm(async () => {
    // 先保存 Claude 会话，然后等 300ms 防抖保存立即落盘（读取退出时刻的最新快照），
    // 最后才退出：不 await 的话未 settle 的 invoke 会随进程结束丢失最后一次变更。
    await saveClaudeSessionsBeforeExit();
    try {
      await flushPendingSaveTabs();
    } catch (error) {
      console.error('Failed to flush tabs before exit:', error);
    }
    windowExitApp();
  });

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

  // 侧栏模式下切换/隐藏导航面板只改本地 sidebarPanel，不经过 store toggle，
  // 终端区宽度随之变化但 TUI 下 ResizeObserver 不重排。这里 bump 布局版本，
  // 走与 F11/分屏同款的强制 fit 链路。首帧跳过，避免干扰初始布局。
  const sidebarLayoutMountedRef = useRef(false);
  useEffect(() => {
    if (!sidebarLayoutMountedRef.current) {
      sidebarLayoutMountedRef.current = true;
      return;
    }
    useAppStore.getState().bumpTerminalLayout();
  }, [sidebarPanel, uiStyle]);

  // Listen for terminals created/closed via Web API to sync with desktop UI
  useEffect(() => {
    const unlistenCreated = listen<{ id: string; profileId: string; profileName: string; terminalType: string; owner: 'pc' | 'web'; groupId?: string; groupName?: string; group?: string; extraParamTag?: string; extraParamTagColor?: string; extraStartupParams?: string; extraStartupMode?: ExtraParamMode; activate?: boolean }>('terminal-created', (event) => {
      const { id, profileId, profileName, terminalType, owner, groupId, groupName = event.payload.group, extraStartupParams, extraStartupMode, extraParamTag, extraParamTagColor, activate } = event.payload;
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
          owner,
          groupId: groupId ? resolvedGroupId : existingSession.groupId,
          groupName: groupName ?? existingSession.groupName,
          extraParams: extraStartupParams ?? existingSession.extraParams,
          extraParamMode: extraStartupMode ?? existingSession.extraParamMode,
          extraParamTag: extraParamTag ?? existingSession.extraParamTag,
          extraParamTagColor: extraParamTagColor ?? existingSession.extraParamTagColor,
          // 旧版后端对空白终端广播过空 terminalType（已存进页签快照），
          // 会话已存在时事件不会重建，这里有值就回填，让空值不再流传。
          ...(existingSession.terminalType
            ? {}
            : terminalType ? { terminalType: terminalType as TerminalSession['terminalType'] } : {}),
        });
        return;
      }
      // Web 端创建的终端不抢焦点（用户在看手机）；默认终端 handoff 会话
      // （activate=true）是用户刚发起的本地动作，建 tab 后立即激活。
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
        extraParams: extraStartupParams,
        extraParamMode: extraStartupMode,
        extraParamTag,
        extraParamTagColor,
      }, !activate);
    });

    const unlistenClosed = listen<string>('terminal-closed', (event) => {
      useAppStore.getState().removeSession(event.payload);
    });
    // 会话目录变化（任一端 cd 后由后端广播）：写入本地 store，让文件导航与会话历史
    // 在浏览器端也能跟随其他端的目录，skipRemoteSync 防止再次上报形成回环。
    const unlistenDirectory = listen<{ terminalId: string; directory: string }>('session-directory-changed', (event) => {
      useAppStore.getState().setSessionDirectory(event.payload.terminalId, event.payload.directory, { skipRemoteSync: true });
    });
    const unlistenResync = isBrowserClient()
      ? listen('web-resync', () => { scheduleBrowserResync(); })
      : Promise.resolve(() => {});
    // 事件连接（重新）建立只可能发生在页面加载或容器重启后：此时才允许按保存的页签恢复。
    const unlistenConnected = isBrowserClient()
      ? listen('web-connected', () => { scheduleBrowserResync({ allowRestore: true }); })
      : Promise.resolve(() => {});

    // Listen for tray exit request to show confirmation dialog
    const unlistenTrayExit = listen('tray-exit-requested', () => {
      requestExit();
    });

    // 托盘不可用时 closeBehavior=tray 已降级为直接退出；给用户一次性的说明
    const unlistenTrayFallback = listen('tray-unavailable-exit', () => {
      import('./services/dialog').then(({ showAlert }) =>
        showAlert(
          '系统托盘不可用，「关闭时最小化到托盘」已临时失效。本次关闭将直接退出应用。',
          '托盘不可用',
        ),
      ).catch(() => {});
    });

    return () => {
      unlistenCreated.then((f) => f());
      unlistenClosed.then((f) => f());
      unlistenDirectory.then((f) => f());
      unlistenResync.then((f) => f());
      unlistenConnected.then((f) => f());
      unlistenTrayExit.then((f) => f());
      unlistenTrayFallback.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (isBrowserClient()) return;
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      const settings = getAppSettings();
      if (settings.closeBehavior === 'tray') return; // tray mode handled by Rust

      // 已确认过（confirmExit 已触发）则放行窗口关闭，否则拦截并弹确认框。
      if (!requestExit()) return;
      event.preventDefault();
    });
    return () => { unlisten.then(fn => fn()); };
  }, [requestExit]);

  const loadProfiles = useCallback(async () => {
    try {
      const data = await getAllProfiles();
      setProfiles(data);
      setProjects(await getProjects());
    } catch (err) {
      console.error('Failed to load profiles:', err);
    }
  }, [setProfiles, setProjects]);

  const handleStartTerminal = useCallback(async (profile: Profile, extraParams?: string, _presetName?: string, tabName?: string, presetTag?: string, presetTagColor?: string | null, extraParamMode?: ExtraParamMode) => {
    if (profile.terminalType === 'mstsc') {
      try {
        await startMstsc(profile.id);
        await updateProfileLastUsed(profile.id);
      } catch (err) {
        console.error('Failed to start mstsc:', err);
        import('./services/dialog').then(({ showAlert }) =>
          showAlert(String(err), '远程桌面启动失败'),
        ).catch(() => {});
      }
      return;
    }
    // Split mode: when the grid is full, placeSessionInSplitSlot will auto-replace the oldest slot.
    const resolvedTabName = tabName ?? profile.name;
    const theme = PRESET_THEMES.find(t => t.id === profile.colorTheme) || PRESET_THEMES[0];
    await launchTerminalSession({
      addSession,
      resolveStartingSession,
      errorLogPrefix: 'Failed to start terminal:',
      makeSession: (startingId) => ({
        id: startingId,
        profileId: profile.id,
        profileName: resolvedTabName,
        terminalType: profile.terminalType,
        colorTheme: { background: theme.background, foreground: theme.foreground },
        tabColor: profile.tabColor || null,
        groupId: 'default',
        owner: clientTerminalOwner(),
        extraParams,
        extraParamMode,
        extraParamTag: presetTag,
        extraParamTagColor: presetTagColor ?? null,
        starting: true,
      }),
      start: (rows, cols) => startTerminal(profile.id, extraParams, rows, cols, resolvedTabName, undefined, presetTag, presetTagColor ?? null, extraParamMode),
      onStarted: (terminalId) => {
        void updateProfileLastUsed(profile.id).catch(err => console.error('Failed to update profile last used:', err));
        const path = effectiveProfilePath(profile, useAppStore.getState().projects);
        if (path) {
          setSessionDirectory(terminalId, path);
          setCurrentDirectory(path);
        }
      },
    });
  }, [addSession, resolveStartingSession, setSessionDirectory, setCurrentDirectory]);

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
        profile.terminalType as 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh' | 'ssh' | 'docker' | 'k8s' | 'mstsc'
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

  const handleStartBlankTerminal = useCallback(async (terminalType: 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh') => {
    const store = useAppStore.getState();
    if (store.splitMode !== 'off' && !store.splitSlots.some(s => s.sessionId === null)) {
      store.showToast('分屏模式已满，请先关闭某个分屏或退出分屏', 'info');
      return;
    }
    const name = terminalType === 'powershell' ? 'PowerShell' : terminalType === 'pwsh' ? 'PowerShell 7' : terminalType === 'cmd' ? 'CMD' : terminalType;
    await launchTerminalSession({
      addSession,
      resolveStartingSession,
      errorLogPrefix: 'Failed to start blank terminal:',
      makeSession: (startingId) => ({
        id: startingId,
        profileId: '',
        profileName: name,
        terminalType,
        colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
        tabColor: null,
        groupId: 'default',
        owner: clientTerminalOwner(),
        starting: true,
      }),
      start: (rows, cols) => startBlankTerminal(terminalType, rows, cols, undefined, name),
    });
  }, [addSession, resolveStartingSession]);

  // 统一快捷键系统:注册应用内分发与全局快捷键;newTerminal 依赖 App 上下文,在此注册执行器
  useEffect(() => {
    registerHotkeyAction('newTerminal', () => { void handleStartBlankTerminal('powershell'); });
    return initAppHotkeys();
  }, [handleStartBlankTerminal]);

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
    if (panel === 'history') {
      setEverOpened(prev => (prev[panel] ? prev : { ...prev, [panel]: true }));
    }
    if (panel === 'config' || panel === 'tabs') {
      useAppStore.getState().setLastClickRegion(panel === 'config' ? 'config' : 'tab');
    } else if (panel === 'history') {
      useAppStore.getState().setLastClickRegion('history');
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
      if (panel === 'history' && !useAppStore.getState().historyPanelVisible) {
        useAppStore.getState().toggleHistoryPanel();
        return panel;
      }
      if (current === panel) return null;
      return panel;
    });
  }, []);

  // 默认风格下 Claude Code 会话是常驻列，没有「点开」这一步，因此照旧立即挂载。
  const slowPanelMounted = () => uiStyle !== 'sidebar' || everOpened.history;

  return (
    <div className={`app-container ui-style-${uiStyle}${windowMode === 'panels-hidden' ? ' panels-hidden' : ''}`} tabIndex={0}>
      <TitleBar
        uiStyle={uiStyle}
        onSettings={handleSettings}
        configPanelVisible={configPanelVisible}
        fileTreeVisible={fileTreeVisible}
        historyPanelVisible={historyPanelVisible}
        onToggleConfigPanel={toggleConfigPanel}
        onToggleFileTree={toggleFileTree}
        onToggleHistoryPanel={toggleHistoryPanel}
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
        <div className={`nav-panel-slot nav-panel-files${sidebarPanel === 'files' ? ' active' : ''}`}>
          <FileNav isSidebarMode={uiStyle === 'sidebar'} />
        </div>
        <div className={`nav-panel-slot nav-panel-history${sidebarPanel === 'history' ? ' active' : ''}`}>
          {slowPanelMounted() && (
            <HistoryPanel
              isSidebarMode={uiStyle === 'sidebar'}
              isActive={windowMode !== 'panels-hidden'
                && (uiStyle === 'sidebar' ? sidebarPanel === 'history' : historyPanelVisible)}
            />
          )}
        </div>
        {enableTabNav && (
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
        <TerminalPanel />
      </div>
      <div className="cartoon-anime1-overlay" aria-hidden="true">
        <span className="cartoon-anime1-left" />
        <span className="cartoon-anime1-center" />
        <span className="cartoon-anime1-hero" />
      </div>
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
          onClose={cancelExit}
          onConfirm={confirmExit}
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
