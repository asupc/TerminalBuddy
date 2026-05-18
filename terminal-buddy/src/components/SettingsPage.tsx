import { FC, useState, useEffect, useRef, useMemo } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getAllThemes, createTheme, updateTheme, deleteTheme, getBackendAppSettings, saveCloseBehavior, saveEnableTabNavigation, saveSingleInstance, getDataPath, setDataPath as setDataPathCmd, exportAllData, importAllData, deleteProfile as deleteProfileCmd, getAllProfiles, createProfile, updateProfile } from '../services/tauri';
import { useAppStore } from '../stores/appStore';
import { PRESET_THEMES, type CustomTheme, type Profile } from '../types';
import { type ThemeMode, type AppSettings, getAppSettings, saveAppSettings, getStoredTheme, applyTheme } from '../utils/settings';
import { ConfigEditDialog } from './ConfigEditDialog';
import { getCmdOverrides, saveCmdOverrides, getCustomCommands, saveCustomCommands, getEffectiveTemplates, type CmdOverride, type CommandItem, type HistoryEntry, getCommandHistory, loadCommandHistory, deleteCommandFromHistory, updateCommandInHistory, updateCommandNote, clearCommandHistory } from '../data/commandTemplates';
import './SettingsPage.css';

interface SettingsPageProps {
  onClose: () => void;
}

const SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'profiles', label: '连接管理' },
  { id: 'commands', label: '命令模板' },
  { id: 'themes', label: '主题管理' },
  { id: 'history', label: '命令历史' },
  { id: 'exclusions', label: '文件排除' },
] as const;

export const SettingsPage: FC<SettingsPageProps> = ({ onClose }) => {
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const [settings, setSettings] = useState<AppSettings>(getAppSettings);
  const [cmdSearch, setCmdSearch] = useState('');
  const [activeCmdTab, setActiveCmdTab] = useState<string | null>(null);
  const [cmdContextMenu, setCmdContextMenu] = useState<{ x: number; y: number; cmd: CommandItem; category: string } | null>(null);
  const [cmdOverrides, setCmdOverrides] = useState<Record<string, CmdOverride>>(getCmdOverrides);
  const [customCmds, setCustomCmds] = useState<CommandItem[]>(getCustomCommands);
  const [editingCmd, setEditingCmd] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState('');
  const [addingCustom, setAddingCustom] = useState(false);
  const [newCmd, setNewCmd] = useState({ name: '', command: '', desc: '' });
  const [dataPath, setDataPath] = useState('');
  const [pendingDataPath, setPendingDataPath] = useState('');
  const [isMigrating, setIsMigrating] = useState(false);
  const [activeSection, setActiveSection] = useState('general');
  const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  const [editingHistoryIdx, setEditingHistoryIdx] = useState<number | null>(null);
  const [editHistoryValue, setEditHistoryValue] = useState('');
  const [editNoteValue, setEditNoteValue] = useState('');
  const [historyContextMenu, setHistoryContextMenu] = useState<{ x: number; y: number; entry: HistoryEntry; idx: number } | null>(null);
  const [newPattern, setNewPattern] = useState('');
  const [exclusionContextMenu, setExclusionContextMenu] = useState<{ x: number; y: number; idx: number } | null>(null);
  const [profileSearch, setProfileSearch] = useState('');
  const [profileGroupTab, setProfileGroupTab] = useState('');
  const [showProfileDialog, setShowProfileDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [profileContextMenu, setProfileContextMenu] = useState<{ x: number; y: number; profile: Profile } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);

  const askConfirm = (message: string, onConfirm: () => void) => {
    setConfirmDialog({ message, onConfirm });
  };

  const { customThemes, setCustomThemes, addCustomTheme, updateCustomTheme, removeCustomTheme, exclusionPatterns, setExclusionPatterns, profiles, setProfiles } = useAppStore();
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [editingTheme, setEditingTheme] = useState<CustomTheme | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  const effectiveTemplates = useMemo(() => getEffectiveTemplates(), [cmdOverrides, customCmds]);

  useEffect(() => {
    if (!activeCmdTab && effectiveTemplates.length > 0) {
      setActiveCmdTab(effectiveTemplates[0].category);
    }
  }, [effectiveTemplates, activeCmdTab]);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('terminalbuddy_theme', theme);
  }, [theme]);

  useEffect(() => {
    saveAppSettings(settings);
  }, [settings]);

  useEffect(() => {
    getBackendAppSettings().then(backend => {
      const synced = {
        ...getAppSettings(),
        closeBehavior: backend.closeBehavior,
        enableTabNavigation: backend.enableTabNavigation,
        singleInstance: backend.singleInstance,
      };
      setSettings(synced);
      saveAppSettings(synced);
    }).catch(() => {});
    getDataPath().then(setDataPath).catch(() => {});
  }, []);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      saveAppSettings(next);
      return next;
    });
  };

  useEffect(() => {
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme('system');
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
  }, [theme]);

  useEffect(() => {
    getAllThemes().then(setCustomThemes).catch(console.error);
    loadCommandHistory().then(() => setHistoryList(getCommandHistory())).catch(() => {});
  }, []);

  // Close profile context menu on outside click
  useEffect(() => {
    if (!profileContextMenu) return;
    const handleClick = () => setProfileContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [profileContextMenu]);

  // IntersectionObserver for section highlighting
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { root: content, rootMargin: '-10% 0px -80% 0px' }
    );

    for (const section of SECTIONS) {
      const el = sectionRefs.current[section.id];
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  const scrollToSection = (id: string) => {
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleCreateTheme = async () => {
    try {
      const newTheme = await createTheme('新主题');
      addCustomTheme(newTheme);
      setEditingTheme(newTheme);
      setSelectedThemeId(newTheme.id);
    } catch (err) {
      console.error('Failed to create theme:', err);
    }
  };

  const handleSaveTheme = async () => {
    if (!editingTheme) return;
    try {
      await updateTheme(editingTheme);
      updateCustomTheme(editingTheme);
      setEditingTheme(null);
    } catch (err) {
      console.error('Failed to save theme:', err);
    }
  };

  const handleDeleteTheme = (id: string) => {
    askConfirm('确定要删除此主题吗？正在使用此主题的连接将回退到默认主题。', async () => {
      setConfirmDialog(null);
      try {
        await deleteTheme(id);
        removeCustomTheme(id);
        if (selectedThemeId === id) setSelectedThemeId(null);
        if (editingTheme?.id === id) setEditingTheme(null);
      } catch (err) {
        console.error('Failed to delete theme:', err);
      }
    });
  };

  const handleColorChange = (field: keyof CustomTheme, value: string) => {
    if (!editingTheme) return;
    setEditingTheme({ ...editingTheme, [field]: value });
  };

  const allThemes = [...PRESET_THEMES, ...customThemes];

  const profileGroups = useMemo(() => {
    const names = new Set(profiles.map(p => p.group || '默认'));
    return Array.from(names);
  }, [profiles]);

  const filteredProfiles = useMemo(() => {
    let result = profiles;
    if (profileGroupTab && !profileSearch) {
      result = result.filter(p => (p.group || '默认') === profileGroupTab);
    }
    if (profileSearch) {
      const q = profileSearch.toLowerCase();
      result = result.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.group || '默认').toLowerCase().includes(q) ||
        (p.terminalType || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [profiles, profileGroupTab, profileSearch]);

  // Set default group tab when profiles load
  useEffect(() => {
    if (profileGroups.length > 0 && !profileGroupTab) {
      setProfileGroupTab(profileGroups[0]);
    }
  }, [profileGroups, profileGroupTab]);

  const loadProfiles = async () => {
    try {
      const data = await getAllProfiles();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to load profiles:', err);
    }
  };

  const handleSave = () => {
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  return (
    <div className="settings-page">
      <div className="settings-nav">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`settings-nav-item ${activeSection === s.id ? 'active' : ''}`}
            onClick={() => scrollToSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="settings-body">
        <button className="settings-close-btn" onClick={onClose} title="关闭设置">×</button>
        <div className="settings-content" ref={contentRef}>
          {/* General Section */}
          <section
            id="general"
            ref={(el) => { sectionRefs.current['general'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">通用</h3>
            <div className="settings-general">
              <div className="settings-section">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.restoreTabsOnStartup}
                    onChange={(e) => updateSetting('restoreTabsOnStartup', e.target.checked)}
                  />
                  <span>启动时恢复标签</span>
                </label>
                <p className="settings-desc">关闭程序时自动保存打开的终端标签，下次启动时自动恢复</p>
              </div>
              <div className="settings-section">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.configPanelAutoExpand}
                    onChange={(e) => updateSetting('configPanelAutoExpand', e.target.checked)}
                  />
                  <span>启动时显示连接导航</span>
                </label>
                <p className="settings-desc">程序启动时自动显示左侧连接面板</p>
              </div>
              <div className="settings-section">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.fileTreeAutoExpand}
                    onChange={(e) => updateSetting('fileTreeAutoExpand', e.target.checked)}
                  />
                  <span>启动时显示文件导航</span>
                </label>
                <p className="settings-desc">程序启动时自动显示左侧文件树面板</p>
              </div>
              <div className="settings-section">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.closeBehavior === 'tray'}
                    onChange={(e) => {
                      const value = e.target.checked ? 'tray' : 'exit';
                      updateSetting('closeBehavior', value);
                      saveCloseBehavior(value).catch(console.error);
                    }}
                  />
                  <span>关闭时最小化到托盘</span>
                </label>
                <p className="settings-desc">关闭窗口时应用将隐藏到系统托盘，双击托盘图标或右键选择"打开窗口"可重新显示</p>
              </div>
              <div className="settings-section">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.enableTabNavigation}
                    onChange={(e) => {
                      const value = e.target.checked;
                      updateSetting('enableTabNavigation', value);
                      saveEnableTabNavigation(value).catch(console.error);
                    }}
                  />
                  <span>开启标签导航</span>
                </label>
                <p className="settings-desc">开启后在左侧显示标签导航面板，关闭后标签将以选项卡形式显示在终端上方</p>
              </div>
              <div className="settings-section">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.rightClickPaste}
                    onChange={(e) => {
                      updateSetting('rightClickPaste', e.target.checked);
                    }}
                  />
                  <span>右键粘贴</span>
                </label>
                <p className="settings-desc">右键时若无选中文本，直接粘贴剪贴板内容到终端</p>
              </div>
              <div className="settings-section">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.singleInstance}
                    onChange={(e) => {
                      const value = e.target.checked;
                      updateSetting('singleInstance', value);
                      saveSingleInstance(value).catch(console.error);
                    }}
                  />
                  <span>只允许运行一个实例</span>
                </label>
                <p className="settings-desc">开启后再次启动应用时会激活已打开的窗口，而非打开新窗口。更改需重启应用生效</p>
              </div>
              <div className="settings-section">
                <label className="settings-label">主题</label>
                <div className="theme-options">
                  {(['dark', 'light', 'system'] as ThemeMode[]).map((mode) => (
                    <label key={mode} className={`theme-option ${theme === mode ? 'active' : ''}`}>
                      <input
                        type="radio"
                        name="theme"
                        value={mode}
                        checked={theme === mode}
                        onChange={() => setTheme(mode)}
                      />
                      <span className="theme-label">
                        {mode === 'dark' ? '🌙 暗黑' : mode === 'light' ? '☀️ 浅色' : '💻 跟随系统'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="settings-section">
                <label className="settings-label">数据存储路径</label>
                <div className="data-path-row">
                  <input
                    className="data-path-input"
                    type="text"
                    value={pendingDataPath || dataPath}
                    readOnly
                  />
                  <button
                    className="btn-secondary"
                    disabled={isMigrating}
                    onClick={async () => {
                      try {
                        const selected = await open({ directory: true, title: '选择数据存储目录' });
                        if (selected) setPendingDataPath(selected as string);
                      } catch {}
                    }}
                  >浏览</button>
                  {pendingDataPath && pendingDataPath !== dataPath && (
                    <button
                      className="btn-primary"
                      disabled={isMigrating}
                      onClick={() => {
                        askConfirm(`将把数据迁移到:\n${pendingDataPath}\n\n原数据不会删除。确定继续？`, async () => {
                          setConfirmDialog(null);
                          setIsMigrating(true);
                          try {
                            await setDataPathCmd(pendingDataPath);
                            setDataPath(pendingDataPath);
                            setPendingDataPath('');
                          } catch (err) {
                            alert('迁移失败: ' + String(err));
                          }
                          setIsMigrating(false);
                        });
                      }}
                    >{isMigrating ? '迁移中...' : '应用'}</button>
                  )}
                </div>
                <p className="settings-desc">修改路径后数据将自动复制到新位置，原数据保留</p>
              </div>
              <div className="settings-section">
                <label className="settings-label">数据导入/导出</label>
                <div className="data-path-row">
                  <button className="btn-secondary" onClick={async () => {
                    try {
                      const selected = await save({
                        filters: [{ name: 'JSON', extensions: ['json'] }],
                        title: '选择导出文件路径',
                      });
                      if (selected) {
                        await exportAllData(selected as string);
                        alert('数据导出成功');
                      }
                    } catch (err) {
                      alert('导出失败: ' + String(err));
                    }
                  }}>导出全部数据</button>
                  <button className="btn-secondary" onClick={async () => {
                    try {
                      const selected = await open({
                        multiple: false,
                        filters: [{ name: 'JSON', extensions: ['json'] }],
                        title: '选择导入文件',
                      });
                      if (selected) {
                        askConfirm('导入将覆盖现有数据，确定继续？', async () => {
                          setConfirmDialog(null);
                          try {
                            await importAllData(selected as string);
                            alert('数据导入成功，部分设置需要重启后生效');
                          } catch (err) {
                            alert('导入失败: ' + String(err));
                          }
                        });
                      }
                    } catch (err) {
                      alert('导入失败: ' + String(err));
                    }
                  }}>导入全部数据</button>
                </div>
                <p className="settings-desc">将所有数据（连接、主题、历史记录、命令模板等）导出为单个 JSON 文件，导入时同理</p>
              </div>
            </div>
          </section>

          {/* Profiles Section */}
          <section
            id="profiles"
            ref={(el) => { sectionRefs.current['profiles'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">连接管理</h3>
            <div className="commands-panel">
              <div className="commands-toolbar">
                <input
                  className="commands-search"
                  type="text"
                  placeholder="搜索连接..."
                  value={profileSearch}
                  onChange={(e) => setProfileSearch(e.target.value)}
                />
                <button className="cmd-add-btn" onClick={() => { setEditingProfile(null); setShowProfileDialog(true); }}>
                  + 新建连接
                </button>
              </div>
              {!profileSearch && profileGroups.length > 0 && (
                <div className="cmd-tabs">
                  {profileGroups.map(group => (
                    <button
                      key={group}
                      className={`cmd-tab ${profileGroupTab === group ? 'active' : ''}`}
                      onClick={() => setProfileGroupTab(group)}
                    >
                      {group}
                      <span className="cmd-tab-count">{profiles.filter(p => (p.group || '默认') === group).length}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="commands-list" style={{ maxHeight: 400 }}>
                {filteredProfiles.map(profile => (
                  <div key={profile.id} className={`cmd-cat-item ${profileContextMenu?.profile.id === profile.id ? 'selected' : ''}`} onContextMenu={(e) => {
                    e.preventDefault();
                    setProfileContextMenu({ x: e.clientX, y: e.clientY, profile });
                  }}>
                    <span style={{ fontSize: 10, fontWeight: 'bold', padding: '2px 4px', background: 'var(--bg-primary)', borderRadius: 2, marginRight: 6, color: 'var(--text-secondary)' }}>
                      {{ powershell: 'PS', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S' }[profile.terminalType]}
                    </span>
                    <code className="cmd-cat-cmd" style={{ color: profile.tabColor || undefined, minWidth: 'auto', flexShrink: 0 }}>{profile.name}</code>
                    <span className="cmd-cat-desc" style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {profile.terminalType === 'ssh' ? (profile.sshHost || '未配置主机') :
                       profile.terminalType === 'docker' ? (profile.dockerContainerName || '未配置容器') :
                       profile.terminalType === 'k8s' ? (profile.k8sNamespace || '未配置命名空间') :
                       (profile.startupPath || 'C:\\')}
                    </span>
                    <div className="cmd-cat-actions" style={{ opacity: 1 }}>
                      <button className="cmd-action-btn" title="编辑" onClick={() => { setEditingProfile(profile); setShowProfileDialog(true); }}>✎</button>
                      <button className="cmd-action-btn danger" title="删除" onClick={() => {
                        askConfirm(`确定删除连接「${profile.name}」？`, async () => {
                          setConfirmDialog(null);
                          try {
                            await deleteProfileCmd(profile.id);
                            loadProfiles();
                          } catch (err) {
                            alert('删除失败: ' + String(err));
                          }
                        });
                      }}>×</button>
                    </div>
                  </div>
                ))}
                {filteredProfiles.length === 0 && (
                  <div style={{ padding: '12px 8px', color: 'var(--text-secondary)', fontSize: 13 }}>
                    {profileSearch ? '没有找到匹配的连接' : '暂无连接'}
                  </div>
                )}
              </div>
              {profileContextMenu && (
                <div className="context-menu-overlay" onClick={() => setProfileContextMenu(null)} />
              )}
              {profileContextMenu && (
                <div className="context-menu" style={{ left: profileContextMenu.x, top: profileContextMenu.y }}>
                  <div className="context-menu-item" onClick={async () => {
                    const p = profileContextMenu.profile;
                    setProfileContextMenu(null);
                    setEditingProfile(p);
                    setShowProfileDialog(true);
                  }}>编辑</div>
                  <div className="context-menu-item" onClick={async () => {
                    const p = profileContextMenu.profile;
                    setProfileContextMenu(null);
                    try {
                      const copied = await createProfile(`${p.name} (副本)`, p.group || '默认', p.terminalType as 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s');
                      await updateProfile({ ...p, id: copied.id, name: `${p.name} (副本)` });
                      loadProfiles();
                    } catch (err) {
                      alert('复制失败: ' + String(err));
                    }
                  }}>复制</div>
                  <div className="context-menu-separator" />
                  <div className="context-menu-item danger" onClick={() => {
                    const p = profileContextMenu.profile;
                    setProfileContextMenu(null);
                    askConfirm(`确定删除连接「${p.name}」？`, async () => {
                      setConfirmDialog(null);
                      try {
                        await deleteProfileCmd(p.id);
                        loadProfiles();
                      } catch (err) {
                        alert('删除失败: ' + String(err));
                      }
                    });
                  }}>删除</div>
                </div>
              )}
            </div>
            {showProfileDialog && (
              <ConfigEditDialog
                profile={editingProfile}
                onClose={() => setShowProfileDialog(false)}
                onSave={() => { setShowProfileDialog(false); loadProfiles(); }}
              />
            )}
          </section>

          {/* Commands Section */}
          <section
            id="commands"
            ref={(el) => { sectionRefs.current['commands'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">命令模板</h3>
            <div className="commands-panel">
              <div className="commands-toolbar">
                <input
                  className="commands-search"
                  type="text"
                  placeholder="搜索命令..."
                  value={cmdSearch}
                  onChange={(e) => setCmdSearch(e.target.value)}
                />
                <button
                  className="cmd-add-btn"
                  onClick={() => setAddingCustom(true)}
                >+ 自定义</button>
              </div>
              {addingCustom && (
                <div className="cmd-add-form">
                  <input placeholder="命令" value={newCmd.command} onChange={(e) => setNewCmd({ ...newCmd, command: e.target.value })} />
                  <input placeholder="说明" value={newCmd.desc} onChange={(e) => setNewCmd({ ...newCmd, desc: e.target.value })} />
                  <button className="btn-primary" onClick={() => {
                    if (!newCmd.command.trim()) return;
                    const updated = [...customCmds, { name: newCmd.command.trim(), command: newCmd.command.trim(), desc: newCmd.desc.trim() || '自定义命令' }];
                    setCustomCmds(updated);
                    saveCustomCommands(updated);
                    setNewCmd({ name: '', command: '', desc: '' });
                    setAddingCustom(false);
                  }}>添加</button>
                  <button className="btn-secondary" onClick={() => setAddingCustom(false)}>取消</button>
                </div>
              )}
              {!cmdSearch && (
                <div className="cmd-tabs">
                  {effectiveTemplates.map((cat) => (
                    <button
                      key={cat.category}
                      className={`cmd-tab ${activeCmdTab === cat.category ? 'active' : ''}`}
                      onClick={() => setActiveCmdTab(cat.category)}
                    >
                      {cat.category}
                      <span className="cmd-tab-count">{cat.commands.filter(c => !cmdOverrides[c.command]?.hidden).length}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="commands-list">
                {(() => {
                  const cats = cmdSearch
                    ? effectiveTemplates.map(cat => ({
                        ...cat,
                        commands: cat.commands.filter(c =>
                          c.command.toLowerCase().includes(cmdSearch.toLowerCase()) ||
                          c.desc.toLowerCase().includes(cmdSearch.toLowerCase())),
                      })).filter(cat => cat.commands.length > 0)
                    : effectiveTemplates.filter(cat => cat.category === activeCmdTab);

                  return cats.map((cat) => (
                    <div key={cat.category} className="cmd-cat-items">
                      {cat.commands.map((cmd) => {
                        const ov = cmdOverrides[cmd.command];
                        if (!cmdSearch && ov?.hidden) return null;
                        const effectiveDesc = ov?.desc !== undefined ? ov.desc : cmd.desc;
                        const isCustom = cat.category === '自定义';
                        const isEditing = editingCmd === cmd.command;
                        return (
                          <div key={cmd.command} className={`cmd-cat-item ${cmdContextMenu?.cmd.command === cmd.command ? 'selected' : ''}`} onContextMenu={(e) => {
                            e.preventDefault();
                            setCmdContextMenu({ x: e.clientX, y: e.clientY, cmd, category: cat.category });
                          }}>
                            <code className="cmd-cat-cmd">{cmd.command}</code>
                            {isEditing ? (
                              <input
                                className="cmd-edit-input"
                                value={editDesc}
                                onChange={(e) => setEditDesc(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const next = { ...cmdOverrides, [cmd.command]: { ...ov, desc: editDesc } };
                                    setCmdOverrides(next);
                                    saveCmdOverrides(next);
                                    setEditingCmd(null);
                                  } else if (e.key === 'Escape') {
                                    setEditingCmd(null);
                                  }
                                }}
                                onBlur={() => {
                                  const next = { ...cmdOverrides, [cmd.command]: { ...ov, desc: editDesc } };
                                  setCmdOverrides(next);
                                  saveCmdOverrides(next);
                                  setEditingCmd(null);
                                }}
                                autoFocus
                              />
                            ) : (
                              <span className="cmd-cat-desc">{effectiveDesc}</span>
                            )}
                            <div className="cmd-cat-actions">
                              <button
                                className="cmd-action-btn"
                                title="编辑说明"
                                onClick={() => { setEditingCmd(cmd.command); setEditDesc(effectiveDesc); }}
                              >✎</button>
                              {isCustom ? (
                                <button className="cmd-action-btn danger" title="删除" onClick={() => {
                                  askConfirm(`确定删除自定义命令「${cmd.command}」？`, () => {
                                    setConfirmDialog(null);
                                    const updated = customCmds.filter(c => c.command !== cmd.command);
                                    setCustomCmds(updated);
                                    saveCustomCommands(updated);
                                  });
                                }}>×</button>
                              ) : (
                                <button
                                  className={`cmd-action-btn ${ov?.hidden ? 'restore' : ''}`}
                                  title={ov?.hidden ? '恢复显示' : '隐藏'}
                                  onClick={() => {
                                    const next = { ...cmdOverrides };
                                    if (ov?.hidden) {
                                      delete next[cmd.command];
                                    } else {
                                      next[cmd.command] = { ...ov, hidden: true };
                                    }
                                    setCmdOverrides(next);
                                    saveCmdOverrides(next);
                                  }}
                                >{ov?.hidden ? '👁' : '⊘'}</button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ));
                })()}
              </div>
              {cmdContextMenu && (
                <div className="context-menu-overlay" onClick={() => setCmdContextMenu(null)} />
              )}
              {cmdContextMenu && (
                <div className="context-menu" style={{ left: cmdContextMenu.x, top: cmdContextMenu.y }}>
                  <div className="context-menu-item" onClick={() => {
                    const { cmd } = cmdContextMenu;
                    setCmdContextMenu(null);
                    setEditingCmd(cmd.command);
                    const ov = cmdOverrides[cmd.command];
                    setEditDesc(ov?.desc !== undefined ? ov.desc : cmd.desc);
                  }}>编辑</div>
                  {cmdContextMenu.category === '自定义' && (
                    <div className="context-menu-item danger" onClick={() => {
                      const cmd = cmdContextMenu.cmd;
                      setCmdContextMenu(null);
                      askConfirm(`确定删除自定义命令「${cmd.command}」？`, () => {
                        setConfirmDialog(null);
                        const updated = customCmds.filter(c => c.command !== cmd.command);
                        setCustomCmds(updated);
                        saveCustomCommands(updated);
                      });
                    }}>删除</div>
                  )}
                  {cmdContextMenu.category !== '自定义' && (
                    <div className="context-menu-item" onClick={() => {
                      const { cmd } = cmdContextMenu;
                      setCmdContextMenu(null);
                      const ov = cmdOverrides[cmd.command];
                      const next = { ...cmdOverrides };
                      if (ov?.hidden) {
                        delete next[cmd.command];
                      } else {
                        next[cmd.command] = { ...ov, hidden: true };
                      }
                      setCmdOverrides(next);
                      saveCmdOverrides(next);
                    }}>{cmdOverrides[cmdContextMenu.cmd.command]?.hidden ? '恢复显示' : '隐藏'}</div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Themes Section */}
          <section
            id="themes"
            ref={(el) => { sectionRefs.current['themes'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">主题管理</h3>
            <div className="theme-manager">
              <div className="theme-list">
                {allThemes.map((t) => {
                  const isCustom = 'cursor' in t;
                  return (
                    <div
                      key={t.id}
                      className={`theme-card ${selectedThemeId === t.id ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedThemeId(t.id);
                        if (isCustom && !editingTheme) setEditingTheme(t as CustomTheme);
                      }}
                    >
                      <div className="theme-swatch" style={{ background: t.background }} />
                      <span className="theme-card-name">{t.name}</span>
                      {isCustom ? (
                        <span className="theme-badge custom">自定义</span>
                      ) : (
                        <span className="theme-badge preset">预设</span>
                      )}
                      {isCustom && editingTheme?.id !== t.id && (
                        <button
                          className="theme-card-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteTheme(t.id);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
                <button className="theme-create-btn" onClick={handleCreateTheme}>
                  + 新建主题
                </button>
              </div>

              {editingTheme && (
                <div className="theme-editor">
                  <div className="theme-editor-header">
                    <input
                      className="theme-editor-name"
                      value={editingTheme.name}
                      onChange={(e) => handleColorChange('name', e.target.value)}
                    />
                    <div className="theme-editor-actions">
                      <button className="btn-primary" onClick={handleSaveTheme}>保存</button>
                      <button className="btn-secondary" onClick={() => setEditingTheme(null)}>取消</button>
                    </div>
                  </div>
                  <div className="color-slots">
                    {([
                      ['background', '背景'],
                      ['foreground', '前景'],
                      ['cursor', '光标'],
                      ['black', '黑色'],
                      ['red', '红色'],
                      ['green', '绿色'],
                      ['yellow', '黄色'],
                      ['blue', '蓝色'],
                      ['magenta', '品红'],
                      ['cyan', '青色'],
                      ['white', '白色'],
                    ] as [keyof CustomTheme, string][]).map(([field, label]) => (
                      <div key={field} className="color-slot">
                        <label>{label}</label>
                        <div className="color-input-wrap">
                          <input
                            type="color"
                            value={editingTheme[field] as string}
                            onChange={(e) => handleColorChange(field, e.target.value)}
                          />
                          <input
                            type="text"
                            value={editingTheme[field] as string}
                            onChange={(e) => handleColorChange(field, e.target.value)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="theme-preview" style={{ background: editingTheme.background, color: editingTheme.foreground }}>
                    <div>PS C:\Projects&gt; <span style={{ color: editingTheme.green }}>npm run dev</span></div>
                    <div style={{ color: editingTheme.cyan }}>  VITE v5.2.0  ready in 312 ms</div>
                    <div style={{ color: editingTheme.foreground }}>  ➜  Local:   http://localhost:1420/</div>
                    <div>PS C:\Projects&gt;<span style={{ background: editingTheme.cursor }}> </span></div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* History Section */}
          <section
            id="history"
            ref={(el) => { sectionRefs.current['history'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">命令历史</h3>
            <div className="commands-panel">
              <div className="commands-toolbar">
                <input
                  className="commands-search"
                  type="text"
                  placeholder="搜索历史命令..."
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                />
                <button
                  className="cmd-add-btn danger-btn"
                  onClick={() => {
                    askConfirm('确定清空所有命令历史？此操作不可恢复。', async () => {
                      setConfirmDialog(null);
                      await clearCommandHistory();
                      setHistoryList([]);
                    });
                  }}
                >清空</button>
              </div>
              <div className="commands-list" style={{ maxHeight: 400 }}>
                {historyList
                  .filter(entry => !historySearch || entry.command.toLowerCase().includes(historySearch.toLowerCase()) || entry.note.toLowerCase().includes(historySearch.toLowerCase()))
                  .map((entry, idx) => (
                    <div key={idx} className={`cmd-cat-item ${historyContextMenu?.entry.command === entry.command ? 'selected' : ''}`} onContextMenu={(e) => {
                      e.preventDefault();
                      setHistoryContextMenu({ x: e.clientX, y: e.clientY, entry, idx });
                    }}>
                      {editingHistoryIdx === idx ? (
                        <div className="history-edit-row">
                          <input
                            className="cmd-edit-input"
                            value={editHistoryValue}
                            onChange={(e) => setEditHistoryValue(e.target.value)}
                            placeholder="命令"
                            autoFocus
                          />
                          <input
                            className="cmd-edit-input"
                            value={editNoteValue}
                            onChange={(e) => setEditNoteValue(e.target.value)}
                            placeholder="备注"
                          />
                          <button className="btn-primary" style={{ padding: '2px 8px', fontSize: 12 }} onClick={async () => {
                            if (editHistoryValue.trim() && editHistoryValue !== entry.command) {
                              await updateCommandInHistory(entry.command, editHistoryValue);
                            }
                            if (editNoteValue !== entry.note) {
                              const targetCmd = editHistoryValue.trim() || entry.command;
                              await updateCommandNote(targetCmd, editNoteValue);
                            }
                            setHistoryList(getCommandHistory());
                            setEditingHistoryIdx(null);
                          }}>保存</button>
                          <button className="btn-secondary" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setEditingHistoryIdx(null)}>取消</button>
                        </div>
                      ) : (
                        <>
                          <code className="cmd-cat-cmd">{entry.command}</code>
                          <span className="cmd-cat-desc">{entry.note || '历史命令'}</span>
                        </>
                      )}
                      {editingHistoryIdx !== idx && (
                        <div className="cmd-cat-actions">
                          <button
                            className="cmd-action-btn"
                            title="编辑"
                            onClick={() => { setEditingHistoryIdx(idx); setEditHistoryValue(entry.command); setEditNoteValue(entry.note); }}
                          >✎</button>
                          <button
                            className="cmd-action-btn danger"
                            title="删除"
                            onClick={() => {
                              askConfirm(`确定删除历史命令「${entry.command}」？`, async () => {
                                setConfirmDialog(null);
                                await deleteCommandFromHistory(entry.command);
                                setHistoryList(getCommandHistory());
                              });
                            }}
                          >×</button>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
              {historyContextMenu && (
                <div className="context-menu-overlay" onClick={() => setHistoryContextMenu(null)} />
              )}
              {historyContextMenu && (
                <div className="context-menu" style={{ left: historyContextMenu.x, top: historyContextMenu.y }}>
                  <div className="context-menu-item" onClick={() => {
                    const { entry } = historyContextMenu;
                    const idx = historyContextMenu.idx;
                    setHistoryContextMenu(null);
                    setEditingHistoryIdx(idx);
                    setEditHistoryValue(entry.command);
                    setEditNoteValue(entry.note);
                  }}>编辑</div>
                  <div className="context-menu-separator" />
                  <div className="context-menu-item danger" onClick={() => {
                    const { entry } = historyContextMenu;
                    setHistoryContextMenu(null);
                    askConfirm(`确定删除历史命令「${entry.command}」？`, async () => {
                      setConfirmDialog(null);
                      await deleteCommandFromHistory(entry.command);
                      setHistoryList(getCommandHistory());
                    });
                  }}>删除</div>
                </div>
              )}
            </div>
          </section>

          {/* Exclusions Section */}
          <section
            id="exclusions"
            ref={(el) => { sectionRefs.current['exclusions'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">文件排除</h3>
            <div className="settings-general">
              <p className="settings-desc">配置文件导航中需要屏蔽的文件和文件夹规则</p>
              <div className="exclusion-list">
                {exclusionPatterns.map((pattern, idx) => (
                  <div key={idx} className="cmd-cat-item" onContextMenu={(e) => {
                    e.preventDefault();
                    setExclusionContextMenu({ x: e.clientX, y: e.clientY, idx });
                  }}>
                    <code className="cmd-cat-cmd">{pattern}</code>
                    <span className="cmd-cat-desc">
                      {pattern.startsWith('*.') ? '匹配后缀' : pattern.startsWith('**/') ? '匹配扩展名' : '精确匹配名称'}
                    </span>
                    <div className="cmd-cat-actions">
                      <button
                        className="cmd-action-btn danger"
                        title="删除"
                        onClick={() => {
                          askConfirm(`确定删除排除规则「${pattern}」？`, () => {
                            setConfirmDialog(null);
                            setExclusionPatterns(exclusionPatterns.filter((_, i) => i !== idx));
                          });
                        }}
                      >×</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="cmd-add-form">
                <input
                  placeholder="例: node_modules, *.log, **/*.html"
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newPattern.trim()) {
                      setExclusionPatterns([...exclusionPatterns, newPattern.trim()]);
                      setNewPattern('');
                    }
                  }}
                />
                <button className="btn-primary" onClick={() => {
                  if (newPattern.trim()) {
                    setExclusionPatterns([...exclusionPatterns, newPattern.trim()]);
                    setNewPattern('');
                  }
                }}>添加</button>
              </div>
              <button
                className="btn-secondary"
                style={{ marginTop: 8, alignSelf: 'flex-start' }}
                onClick={() => {
                  askConfirm('确定重置排除规则为默认？当前规则将被覆盖。', () => {
                    setConfirmDialog(null);
                    setExclusionPatterns(['node_modules', '.git']);
                  });
                }}
              >重置为默认</button>
              {exclusionContextMenu && (
                <div className="context-menu-overlay" onClick={() => setExclusionContextMenu(null)} />
              )}
              {exclusionContextMenu && (
                <div className="context-menu" style={{ left: exclusionContextMenu.x, top: exclusionContextMenu.y }}>
                  <div className="context-menu-item danger" onClick={() => {
                    const idx = exclusionContextMenu.idx;
                    const pattern = exclusionPatterns[idx];
                    setExclusionContextMenu(null);
                    askConfirm(`确定删除排除规则「${pattern}」？`, () => {
                      setConfirmDialog(null);
                      setExclusionPatterns(exclusionPatterns.filter((_, i) => i !== idx));
                    });
                  }}>删除</div>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="settings-footer">
          <button className="btn-secondary" onClick={handleCancel}>取消</button>
          <button className="btn-primary" onClick={handleSave}>保存</button>
        </div>
      </div>
      {confirmDialog && (
        <div className="confirm-dialog-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">确认操作</div>
            <div className="confirm-dialog-message">{confirmDialog.message}</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={() => setConfirmDialog(null)}>取消</button>
              <button className="btn-danger" onClick={confirmDialog.onConfirm}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
