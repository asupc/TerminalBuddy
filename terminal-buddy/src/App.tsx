import { useEffect, useState, useRef, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { TitleBar } from './components/TitleBar';
import { ConfigPanel } from './components/ConfigPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { FileTree } from './components/FileTree';
import { TabSidebar } from './components/TabSidebar';
import { ConfigEditDialog } from './components/ConfigEditDialog';
import { ExtraParamsDialog } from './components/ExtraParamsDialog';
import { initTheme, applyTheme, getAppSettings, initAppSettings, saveAppSettings } from './utils/settings';
import { useAppStore, loadSavedTabs, saveTabsToStorage, initBookmarks, initExtraParamPresets, initBookmarkHeight } from './stores/appStore';
import { getAllProfiles, startTerminal, startBlankTerminal, updateProfileLastUsed, createProfile, updateProfile, windowExitApp, getFileSize, startMstsc, getBackendAppSettings } from './services/tauri';
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
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [defaultGroupForNewProfile, setDefaultGroupForNewProfile] = useState<string | undefined>();
  const [showExtraParamsDialog, setShowExtraParamsDialog] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState<{ sessionCount: number } | null>(null);
  const [enableTabNav, setEnableTabNav] = useState(true);
  const closeConfirmedRef = useRef(false);
  const restoredRef = useRef(false);

  useEffect(() => {
    (async () => {
      await migrateLocalStorageToBackend();

      const theme = await initTheme();
      applyTheme(theme);
      await initAppSettings();
      await initBookmarks();
      await initBookmarkHeight();
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
        windowExitApp();
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
        windowExitApp();
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const handleCloseConfirm = useCallback(() => {
    closeConfirmedRef.current = true;
    setCloseConfirm(null);
    windowExitApp();
  }, []);

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
            const terminalId = tab.profileId
              ? await startTerminal(tab.profileId, undefined, estRows, estCols)
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
            });
            if (i === activeIndex) {
              store.setActiveSession(terminalId);
            }
          }
        } catch (err) {
          console.error('Failed to restore tab:', tab.profileName, err);
        }
        // 让出主线程，避免 UI 卡顿
        if (i < tabs.length - 1) {
          await new Promise(r => setTimeout(r, 100));
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

  const handleStartTerminal = useCallback(async (profile: Profile, extraParams?: string) => {
    try {
      if (profile.terminalType === 'mstsc') {
        await startMstsc(profile.id);
        await updateProfileLastUsed(profile.id);
        return;
      }
      const { rows, cols } = estimateTerminalSize();
      const terminalId = await startTerminal(profile.id, extraParams, rows, cols);
      await updateProfileLastUsed(profile.id);
      const theme = PRESET_THEMES.find(t => t.id === profile.colorTheme) || PRESET_THEMES[0];
      addSession({
        id: terminalId,
        profileId: profile.id,
        profileName: profile.name,
        terminalType: profile.terminalType,
        colorTheme: { background: theme.background, foreground: theme.foreground },
        tabColor: profile.tabColor || null,
        groupId: 'default',
        owner: 'pc',
      });
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
    <div className="app-container">
      <TitleBar
        onSettings={handleSettings}
        configPanelVisible={configPanelVisible}
        fileTreeVisible={fileTreeVisible}
        onToggleConfigPanel={toggleConfigPanel}
        onToggleFileTree={toggleFileTree}
      />
      <div className="main-content">
        <ConfigPanel
          onStartTerminal={handleStartTerminal}
          onEditProfile={handleEditProfile}
          onCopyProfile={handleCopyProfile}
          onAddProfile={handleAddProfile}
          onManageExtraParams={() => setShowExtraParamsDialog(true)}
        />
        <FileTree />
        {enableTabNav && (
          <TabSidebar
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
    </div>
  );
}

export default App;
