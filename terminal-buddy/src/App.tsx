import { useEffect, useState, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { TitleBar } from './components/TitleBar';
import { ConfigPanel } from './components/ConfigPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { FileTree } from './components/FileTree';
import { TabSidebar } from './components/TabSidebar';
import { ConfigEditDialog } from './components/ConfigEditDialog';
import { getStoredTheme, applyTheme, getAppSettings } from './utils/settings';
import { useAppStore } from './stores/appStore';
import { loadSavedTabs } from './stores/appStore';
import { getAllProfiles, startTerminal, startBlankTerminal, updateProfileLastUsed, createProfile, updateProfile, windowExitApp } from './services/tauri';
import { loadCommandHistory, migrateLocalStorageHistory, initPersistedTemplates } from './data/commandTemplates';
import type { Profile } from './types';
import { PRESET_THEMES } from './types';

function App() {
  const { setProfiles, addSession, configPanelVisible, fileTreeVisible, toggleConfigPanel, toggleFileTree, openSettingsTab, profiles } = useAppStore();
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [closeConfirm, setCloseConfirm] = useState<{ sessionCount: number } | null>(null);
  const [, setTabNavVersion] = useState(0);
  const closeConfirmedRef = useRef(false);

  useEffect(() => {
    applyTheme(getStoredTheme());
    initPersistedTemplates();
    loadProfiles();
    if (getAppSettings().restoreTabsOnStartup) {
      restoreTabs();
    }
    migrateLocalStorageHistory().then(() => loadCommandHistory());
  }, []);

  useEffect(() => {
    const handler = () => setTabNavVersion(v => v + 1);
    window.addEventListener('tab-navigation-changed', handler);
    return () => window.removeEventListener('tab-navigation-changed', handler);
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

  const handleCloseConfirm = () => {
    closeConfirmedRef.current = true;
    setCloseConfirm(null);
    windowExitApp();
  };

  const handleCloseCancel = () => {
    setCloseConfirm(null);
  };

  const restoreTabs = async () => {
    const { tabs, activeIndex } = loadSavedTabs();
    if (tabs.length === 0) return;
    const { addSession, setActiveSession } = useAppStore.getState();
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      try {
        const terminalId = tab.profileId
          ? await startTerminal(tab.profileId)
          : await startBlankTerminal(tab.terminalType as 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s');
        addSession({
          id: terminalId,
          profileId: tab.profileId,
          profileName: tab.profileName,
          terminalType: tab.terminalType as any,
          colorTheme: tab.colorTheme,
          tabColor: tab.tabColor,
          groupId: tab.groupId || 'default',
        });
        if (i === activeIndex) {
          setActiveSession(terminalId);
        }
      } catch (err) {
        console.error('Failed to restore tab:', tab.profileName, err);
      }
    }
  };

  const loadProfiles = async () => {
    try {
      const data = await getAllProfiles();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to load profiles:', err);
    }
  };

  const handleStartTerminal = async (profile: Profile) => {
    try {
      console.log('[DEBUG] startTerminal called, profileId:', profile.id);
      const terminalId = await startTerminal(profile.id);
      console.log('[DEBUG] startTerminal returned:', terminalId);
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
      });
    } catch (err) {
      console.error('[DEBUG] startTerminal FAILED:', err);
      alert('启动终端失败: ' + String(err));
    }
  };

  const handleEditProfile = (profile: Profile) => {
    setEditingProfile(profile);
    setShowEditDialog(true);
  };

  const handleCopyProfile = async (profile: Profile) => {
    try {
      const newProfile = await createProfile(
        `${profile.name} (副本)`,
        profile.group,
        profile.terminalType as 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s'
      );
      await updateProfile({
        ...newProfile,
        startupPath: profile.startupPath,
        startupCommands: profile.startupCommands,
        environmentVariables: profile.environmentVariables,
        colorTheme: profile.colorTheme,
        windowSize: profile.windowSize,
      });
      await loadProfiles();
    } catch (err) {
      console.error('Failed to copy profile:', err);
    }
  };

  const handleSettings = () => {
    openSettingsTab();
  };

  const handleStartBlankTerminal = async (terminalType: 'powershell' | 'cmd') => {
    try {
      const name = terminalType === 'powershell' ? 'PowerShell' : 'CMD';
      const terminalId = await startBlankTerminal(terminalType);
      addSession({
        id: terminalId,
        profileId: '',
        profileName: name,
        terminalType,
        colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
        tabColor: null,
        groupId: 'default',
      });
    } catch (err) {
      console.error('Failed to start blank terminal:', err);
      alert('启动终端失败: ' + String(err));
    }
  };

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
          onAddProfile={() => {
            setEditingProfile(null);
            setShowEditDialog(true);
          }}
        />
        <FileTree />
        {getAppSettings().enableTabNavigation && (
          <TabSidebar
            profiles={profiles}
            onStartTerminal={handleStartTerminal}
            onStartBlankTerminal={handleStartBlankTerminal}
          />
        )}
        <TerminalPanel />
      </div>
      {showEditDialog && (
        <ConfigEditDialog
          profile={editingProfile}
          onClose={() => setShowEditDialog(false)}
          onSave={() => {
            setShowEditDialog(false);
            loadProfiles();
          }}
        />
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
