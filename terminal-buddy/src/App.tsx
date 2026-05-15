import { useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { ConfigPanel } from './components/ConfigPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { FileTree } from './components/FileTree';
import { ConfigEditDialog } from './components/ConfigEditDialog';
import { SettingsDialog, getStoredTheme, applyTheme, getAppSettings } from './components/SettingsDialog';
import { useAppStore } from './stores/appStore';
import { loadSavedTabs } from './stores/appStore';
import { getAllProfiles, startTerminal, startBlankTerminal, updateProfileLastUsed, createProfile, updateProfile, exportAllProfiles, importAllProfiles } from './services/tauri';
import type { Profile } from './types';
import { PRESET_THEMES } from './types';

function App() {
  const { setProfiles, addSession, configPanelVisible, fileTreeVisible, toggleConfigPanel, toggleFileTree } = useAppStore();
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    applyTheme(getStoredTheme());
    loadProfiles();
    if (getAppSettings().restoreTabsOnStartup) {
      restoreTabs();
    }
  }, []);

  const restoreTabs = async () => {
    const { tabs, activeIndex } = loadSavedTabs();
    if (tabs.length === 0) return;
    const { addSession } = useAppStore.getState();
    const newSessions: { id: string; index: number }[] = [];
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      try {
        let terminalId: string;
        if (tab.profileId) {
          terminalId = await startTerminal(tab.profileId);
        } else {
          terminalId = await startBlankTerminal(tab.terminalType);
        }
        addSession({
          id: terminalId,
          profileId: tab.profileId,
          profileName: tab.profileName,
          terminalType: tab.terminalType,
          colorTheme: tab.colorTheme,
          tabColor: tab.tabColor,
        });
        newSessions.push({ id: terminalId, index: i });
      } catch (err) {
        console.error('Failed to restore tab:', tab.profileName, err);
      }
    }
    if (newSessions.length > 0 && activeIndex < newSessions.length) {
      useAppStore.getState().setActiveSession(newSessions[activeIndex].id);
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
        profile.terminalType as 'powershell' | 'cmd'
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

  const handleNew = () => {
    setEditingProfile(null);
    setShowEditDialog(true);
  };

  const handleImport = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false,
      });
      if (!path) return;
      await importAllProfiles(path as string);
      await loadProfiles();
    } catch (err) {
      console.error('Failed to import profiles:', err);
      alert('导入配置失败: ' + String(err));
    }
  };

  const handleExport = async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({
        defaultPath: 'terminalbuddy_profiles.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return;
      await exportAllProfiles(path as string);
    } catch (err) {
      console.error('Failed to export profiles:', err);
      alert('导出配置失败: ' + String(err));
    }
  };

  const handleSettings = () => {
    setShowSettings(true);
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
      });
    } catch (err) {
      console.error('Failed to start blank terminal:', err);
      alert('启动终端失败: ' + String(err));
    }
  };

  return (
    <div className="app-container">
      <Toolbar
        onNew={handleNew}
        onImport={handleImport}
        onExport={handleExport}
        onSettings={handleSettings}
        onNewPowershell={() => handleStartBlankTerminal('powershell')}
        onNewCmd={() => handleStartBlankTerminal('cmd')}
        onStartTerminal={handleStartTerminal}
      />
      <div className="main-content">
        <div className="floating-buttons">
          <button
            className={`float-btn ${configPanelVisible ? 'active' : ''}`}
            onClick={toggleConfigPanel}
            title={configPanelVisible ? '隐藏配置导航' : '显示配置导航'}
          >
            ☰
          </button>
          <button
            className={`float-btn ${fileTreeVisible ? 'active' : ''}`}
            onClick={toggleFileTree}
            title={fileTreeVisible ? '隐藏文件导航' : '显示文件导航'}
          >
            📁
          </button>
        </div>
        <ConfigPanel
          onStartTerminal={handleStartTerminal}
          onEditProfile={handleEditProfile}
          onCopyProfile={handleCopyProfile}
        />
        <FileTree />
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
      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

export default App;
