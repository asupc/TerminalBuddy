import { useEffect, useState, useRef, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { TitleBar } from './components/TitleBar';
import { ConfigNav } from './components/ConfigNav';
import { TerminalPanel } from './components/TerminalPanel';
import { FileTree } from './components/FileTree';
import { TabNav } from './components/TabNav';
import { ConfigEditDialog } from './components/ConfigEditDialog';
import { ExtraParamsDialog } from './components/ExtraParamsDialog';
import { Toast } from './components/Toast';
import { initTheme, applyTheme, getAppSettings, initAppSettings, saveAppSettings, applyListSelectionStyle } from './utils/settings';
import { useAppStore, loadSavedTabs, saveTabsToStorage, initBookmarks, initExtraParamPresets, initBookmarkHeight, initFileTreeNav } from './stores/appStore';
import { getAllProfiles, startTerminal, startBlankTerminal, updateProfileLastUsed, createProfile, updateProfile, windowExitApp, getFileSize, startMstsc, getBackendAppSettings, writeToTerminal, getClaudeSessionsForTerminals } from './services/tauri';
import { initPersistedTemplates, initCmdOverrides, initCustomCommands } from './data/commandTemplates';
import { migrateLocalStorageToBackend } from './utils/migration';

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
import type { Profile, TerminalSession } from './types';
import { PRESET_THEMES } from './types';

function App() {
  const setProfiles = useAppStore(s => s.setProfiles);
  const addSession = useAppStore(s => s.addSession);
  const setSessionDirectory = useAppStore(s => s.setSessionDirectory);
  const setCurrentDirectory = useAppStore(s => s.setCurrentDirectory);
  const configPanelVisible = useAppStore(s => s.configPanelVisible);
  const fileTreeVisible = useAppStore(s => s.fileTreeVisible);
  const toggleConfigPanel = useAppStore(s => s.toggleConfigPanel);
  const toggleFileTree = useAppStore(s => s.toggleFileTree);
  const openSettingsTab = useAppStore(s => s.openSettingsTab);
  const profiles = useAppStore(s => s.profiles);
  const windowMode = useAppStore(s => s.windowMode);
  const cycleWindowMode = useAppStore(s => s.cycleWindowMode);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [defaultGroupForNewProfile, setDefaultGroupForNewProfile] = useState<string | undefined>();
  const [showExtraParamsDialog, setShowExtraParamsDialog] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState<{ sessionCount: number } | null>(null);
  const [enableTabNav, setEnableTabNav] = useState(true);
  const closeConfirmedRef = useRef(false);
  const restoredRef = useRef(false);

  // 预加载终端组件 chunk（xterm.js + addons），让 restoreTabs 时不需等待网络/IO
  useEffect(() => {
    void import('./components/TerminalInstance');
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
            const { sessions, splitMode } = useAppStore.getState();
            const terminalIds = splitMode === 'off'
              ? sessions.filter(s => s.sessionType !== 'editor' && s.owner !== 'web').map(s => s.id)
              : sessions.map(s => s.id);
            if (terminalIds.length > 0) {
              window.dispatchEvent(new CustomEvent('tb-split-resize', {
                detail: { terminalIds }
              }));
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

  // 应用列表选中样式（连接/文件导航 .tree-item.selected 配色）：启动一次 + 设置变更时刷新
  useEffect(() => {
    const apply = () => applyListSelectionStyle(getAppSettings());
    apply();
    window.addEventListener('app-settings-changed', apply);
    return () => window.removeEventListener('app-settings-changed', apply);
  }, []);

  useEffect(() => {
    (async () => {
      await migrateLocalStorageToBackend();

      const theme = await initTheme();
      applyTheme(theme);
      await initAppSettings();
      await initBookmarks();
      await initBookmarkHeight();
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
          enableTabNavigation: backend.enableTabNavigation,
          singleInstance: backend.singleInstance,
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
      loadProfiles();

      if (!import.meta.env.DEV && settings.restoreTabsOnStartup && !restoredRef.current) {
        restoredRef.current = true;
        restoreTabs();
        useAppStore.getState().restoreDraftTabs();
      }
    })();
  }, []);

  // 退出前保存 Claude Code 终端的 session ID（仅在设置开启时）
  const saveClaudeSessionsBeforeExit = useCallback(async () => {
    const settings = getAppSettings();
    if (!settings.autoResumeClaudeSession) return;

    const { sessions, profiles } = useAppStore.getState();
    if (sessions.length === 0) return;

    // 先筛选出 Claude 终端
    const claudeTerminalIds: string[] = [];
    for (const session of sessions) {
      if (session.sessionType === 'editor') continue;
      const profile = profiles.find(p => p.id === session.profileId);
      const startupCommands = profile?.startupCommands || [];
      const extraParams = session.extraParams || '';
      const isClaudeTerminal = startupCommands.some(cmd => cmd.includes('claude')) || extraParams.includes('claude');
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

  // Listen for terminals created/closed via Web API to sync with desktop UI
  useEffect(() => {
    const unlistenCreated = listen<{ id: string; profileId: string; profileName: string; terminalType: string; owner: 'pc' | 'web' }>('terminal-created', (event) => {
      const { id, profileId, profileName, terminalType, owner } = event.payload;
      const store = useAppStore.getState();
      // Skip if already in sessions
      if (store.sessions.find((s) => s.id === id)) return;
      const profile = store.profiles.find((p) => p.id === profileId);
      const theme = PRESET_THEMES.find((t) => t.id === profile?.colorTheme) || PRESET_THEMES[0];
      // Add session but do NOT auto-switch active tab — the terminal was
      // opened from the web, so the user is looking at the web, not here.
      store.addSession({
        id,
        profileId,
        profileName,
        terminalType: terminalType as any,
        colorTheme: { background: theme.background, foreground: theme.foreground },
        tabColor: profile?.tabColor || null,
        groupId: 'default',
        owner,
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
    // 暂停逐次写入，恢复完后统一写一次
    useAppStore.setState({ _skipSaveTabs: true });
    try {
      for (let i = 0; i < tabs.length; i++) {
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
              if (i === activeIndex) {
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
            const terminalId = tab.profileId
              ? await startTerminal(tab.profileId, launchParams, estRows, estCols)
              : await startBlankTerminal(tab.terminalType as 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s', estRows, estCols);
            store.addSession({
              id: terminalId,
              profileId: tab.profileId,
              profileName: tab.profileName,
              terminalType: tab.terminalType as any,
              colorTheme: tab.colorTheme,
              tabColor: tab.tabColor,
              groupId: tab.groupId || 'default',
              owner: 'pc',
              extraParams: baseParams,
            });
            // 保存 claudeSessionId 到 store
            if (tab.claudeSessionId) {
              store.setClaudeSessionId(terminalId, tab.claudeSessionId);
            }
            // 恢复上次记录的目录：同步 sessionDirectories 并发送 cd 命令
            if (tab.directory) {
              store.setSessionDirectory(terminalId, tab.directory);
              writeToTerminal(terminalId, `cd "${tab.directory}"\r`).catch(() => {});
            }
            if (i === activeIndex) {
              store.setActiveSession(terminalId);
            }
          }
        } catch (err) {
          console.error('Failed to restore tab:', tab.profileName, err);
        }
        // 让出主线程，等待浏览器完成一帧绘制后再恢复下一个 tab
        if (i < tabs.length - 1) {
          await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        }
      }
    } finally {
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

  const handleStartTerminal = useCallback(async (profile: Profile, extraParams?: string, presetName?: string) => {
    try {
      if (profile.terminalType === 'mstsc') {
        await startMstsc(profile.id);
        await updateProfileLastUsed(profile.id);
        return;
      }
      // Split mode: when the grid is full, placeSessionInSplitSlot will auto-replace the oldest slot.
      const { rows, cols } = estimateTerminalSize();
      const terminalId = await startTerminal(profile.id, extraParams, rows, cols);
      await updateProfileLastUsed(profile.id);
      const theme = PRESET_THEMES.find(t => t.id === profile.colorTheme) || PRESET_THEMES[0];
      const tabName = presetName ? `${profile.name}[${presetName}]` : profile.name;
      addSession({
        id: terminalId,
        profileId: profile.id,
        profileName: tabName,
        terminalType: profile.terminalType,
        colorTheme: { background: theme.background, foreground: theme.foreground },
        tabColor: profile.tabColor || null,
        groupId: 'default',
        owner: 'pc',
        extraParams,
      });
      // Split mode: place the new session into the first blank slot (and focus it).
      const st = useAppStore.getState();
      if (st.splitMode !== 'off') st.placeSessionInSplitSlot(terminalId);
      if (profile.startupPath) {
        setSessionDirectory(terminalId, profile.startupPath);
        setCurrentDirectory(profile.startupPath);
      }
    } catch (err) {
      alert('启动终端失败: ' + String(err));
    }
  }, [addSession]);

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
        profile.terminalType as 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'mstsc'
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
    openSettingsTab();
  }, [openSettingsTab]);

  const handleStartBlankTerminal = useCallback(async (terminalType: 'powershell' | 'cmd') => {
    try {
      const store = useAppStore.getState();
      if (store.splitMode !== 'off' && !store.splitSlots.some(s => s.sessionId === null)) {
        store.showToast('分屏模式已满，请先关闭某个分屏或退出分屏', 'info');
        return;
      }
      const name = terminalType === 'powershell' ? 'PowerShell' : 'CMD';
      const { rows, cols } = estimateTerminalSize();
      const terminalId = await startBlankTerminal(terminalType, rows, cols);
      addSession({
        id: terminalId,
        profileId: '',
        profileName: name,
        terminalType,
        colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
        tabColor: null,
        groupId: 'default',
        owner: 'pc',
      });
      const st = useAppStore.getState();
      if (st.splitMode !== 'off') st.placeSessionInSplitSlot(terminalId);
    } catch (err) {
      console.error('Failed to start blank terminal:', err);
      alert('启动终端失败: ' + String(err));
    }
  }, [addSession]);

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

  return (
    <div className={`app-container${windowMode === 'panels-hidden' ? ' panels-hidden' : ''}`} tabIndex={0}>
      <TitleBar
        onSettings={handleSettings}
        configPanelVisible={configPanelVisible}
        fileTreeVisible={fileTreeVisible}
        onToggleConfigPanel={toggleConfigPanel}
        onToggleFileTree={toggleFileTree}
      />
      <div className="main-content">
        <ConfigNav
          onStartTerminal={handleStartTerminal}
          onEditProfile={handleEditProfile}
          onCopyProfile={handleCopyProfile}
          onAddProfile={handleAddProfile}
          onManageExtraParams={() => setShowExtraParamsDialog(true)}
        />
        <FileTree />
        {enableTabNav && (
          <TabNav
            profiles={profiles}
            onStartTerminal={handleStartTerminal}
            onStartBlankTerminal={handleStartBlankTerminal}
            onStartTextEditor={handleStartTextEditor}
          />
        )}
        <TerminalPanel />
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
      {closeConfirm && (
        <div className="confirm-dialog-overlay" onClick={handleCloseCancel}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">确认退出</div>
            <div className="confirm-dialog-message">当前有 {closeConfirm.sessionCount} 个终端正在运行，确定要退出吗？</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={handleCloseCancel}>取消</button>
              <button className="btn-danger" onClick={handleCloseConfirm}>退出</button>
            </div>
          </div>
        </div>
      )}
      <Toast />
    </div>
  );
}

export default App;
