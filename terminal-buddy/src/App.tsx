import { useEffect, useState, useRef, useCallback } from 'react';
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

const FLOAT_POS_KEY = 'terminalbuddy_float_pos';

function getSavedFloatPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(FLOAT_POS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { x: 8, y: window.innerHeight / 2 - 36 };
}

function saveFloatPos(pos: { x: number; y: number }) {
  try {
    localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(pos));
  } catch {}
}

function App() {
  const { setProfiles, addSession, configPanelVisible, fileTreeVisible, toggleConfigPanel, toggleFileTree } = useAppStore();
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const floatPosRef = useRef(getSavedFloatPos());
  const [floatPos, setFloatPos] = useState(floatPosRef.current);
  const floatDragging = useRef(false);
  const floatStart = useRef({ x: 0, y: 0 });
  const floatOrigin = useRef({ x: 0, y: 0 });

  const handleFloatMouseDown = useCallback((e: React.MouseEvent) => {
    floatDragging.current = true;
    floatStart.current = { x: e.clientX, y: e.clientY };
    floatOrigin.current = { x: floatPosRef.current.x, y: floatPosRef.current.y };
  }, []);

  const handleFloatMouseMove = useCallback((e: React.MouseEvent) => {
    if (!floatDragging.current) return;
    const dx = e.clientX - floatStart.current.x;
    const dy = e.clientY - floatStart.current.y;
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    const next = {
      x: Math.max(0, Math.min(window.innerWidth - 40, floatOrigin.current.x + dx)),
      y: Math.max(0, Math.min(window.innerHeight - 80, floatOrigin.current.y + dy)),
    };
    floatPosRef.current = next;
    setFloatPos(next);
  }, []);

  const handleFloatMouseUp = useCallback(() => {
    if (!floatDragging.current) return;
    floatDragging.current = false;
    saveFloatPos(floatPosRef.current);
  }, []);

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
    const { addSession, setActiveSession } = useAppStore.getState();
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      try {
        const terminalId = tab.profileId
          ? await startTerminal(tab.profileId)
          : await startBlankTerminal(tab.terminalType);
        addSession({
          id: terminalId,
          profileId: tab.profileId,
          profileName: tab.profileName,
          terminalType: tab.terminalType,
          colorTheme: tab.colorTheme,
          tabColor: tab.tabColor,
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
        <div
          className="floating-buttons"
          style={{ left: floatPos.x, top: floatPos.y, transform: 'none' }}
          onMouseDown={handleFloatMouseDown}
          onMouseMove={handleFloatMouseMove}
          onMouseUp={handleFloatMouseUp}
          onMouseLeave={handleFloatMouseUp}
        >
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
