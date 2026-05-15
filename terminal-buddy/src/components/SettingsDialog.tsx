import { FC, useState, useEffect, useRef, useCallback } from 'react';
import { getAllThemes, createTheme, updateTheme, deleteTheme } from '../services/tauri';
import { useAppStore } from '../stores/appStore';
import { PRESET_THEMES, type CustomTheme } from '../types';
import { getCmdOverrides, saveCmdOverrides, getCustomCommands, saveCustomCommands, getEffectiveTemplates, type CmdOverride, type CommandItem } from '../data/commandTemplates';
import './SettingsDialog.css';

export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppSettings {
  restoreTabsOnStartup: boolean;
  configPanelAutoExpand: boolean;
  fileTreeAutoExpand: boolean;
}

const THEME_STORAGE_KEY = 'terminalbuddy_theme';
const SETTINGS_STORAGE_KEY = 'terminalbuddy_settings';

const DEFAULT_SETTINGS: AppSettings = {
  restoreTabsOnStartup: true,
  configPanelAutoExpand: true,
  fileTreeAutoExpand: true,
};

export const getAppSettings = (): AppSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
};

export const saveAppSettings = (settings: AppSettings) => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
};

interface SettingsDialogProps {
  onClose: () => void;
}

export const getStoredTheme = (): ThemeMode => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return (stored as ThemeMode) || 'dark';
  } catch {
    return 'dark';
  }
};

export const applyTheme = (theme: ThemeMode) => {
  const root = document.documentElement;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }
};

type TabId = 'general' | 'commands' | 'themes';

export const SettingsDialog: FC<SettingsDialogProps> = ({ onClose }) => {
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const [settings, setSettings] = useState<AppSettings>(getAppSettings);
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [cmdSearch, setCmdSearch] = useState('');
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [cmdOverrides, setCmdOverrides] = useState<Record<string, CmdOverride>>(getCmdOverrides);
  const [customCmds, setCustomCmds] = useState<CommandItem[]>(getCustomCommands);
  const [editingCmd, setEditingCmd] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState('');
  const [addingCustom, setAddingCustom] = useState(false);
  const [newCmd, setNewCmd] = useState({ name: '', command: '', desc: '' });
  const [dialogOffset, setDialogOffset] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  const { customThemes, setCustomThemes, addCustomTheme, updateCustomTheme, removeCustomTheme } = useAppStore();
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [editingTheme, setEditingTheme] = useState<CustomTheme | null>(null);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    saveAppSettings(settings);
  }, [settings]);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
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
  }, []);

  const handleDialogMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.dialog-content')) return;
    isDragging.current = true;
    dragStartPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleDialogMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const dx = e.clientX - dragStartPos.current.x;
      const dy = e.clientY - dragStartPos.current.y;
      setDialogOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      dragStartPos.current = { x: e.clientX, y: e.clientY };
    });
  }, []);

  const handleDialogMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

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

  const handleDeleteTheme = async (id: string) => {
    if (!confirm('确定要删除此主题吗？正在使用此主题的配置将回退到默认主题。')) return;
    try {
      await deleteTheme(id);
      removeCustomTheme(id);
      if (selectedThemeId === id) setSelectedThemeId(null);
      if (editingTheme?.id === id) setEditingTheme(null);
    } catch (err) {
      console.error('Failed to delete theme:', err);
    }
  };

  const handleColorChange = (field: keyof CustomTheme, value: string) => {
    if (!editingTheme) return;
    setEditingTheme({ ...editingTheme, [field]: value });
  };

  const allThemes = [...PRESET_THEMES, ...customThemes];

  return (
    <div className="dialog-overlay">
      <div
        className="dialog settings-dialog"
        style={{ transform: `translate(${dialogOffset.x}px, ${dialogOffset.y}px)` }}
        onMouseDown={handleDialogMouseDown}
        onMouseMove={handleDialogMouseMove}
        onMouseUp={handleDialogMouseUp}
      >
        <div className="dialog-header dialog-drag-handle">
          <h3>设置</h3>
          <button className="dialog-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            通用
          </button>
          <button
            className={`settings-tab ${activeTab === 'commands' ? 'active' : ''}`}
            onClick={() => setActiveTab('commands')}
          >
            命令模板
          </button>
          <button
            className={`settings-tab ${activeTab === 'themes' ? 'active' : ''}`}
            onClick={() => setActiveTab('themes')}
          >
            主题管理
          </button>
        </div>

        <div className="dialog-content">
          {activeTab === 'general' && (
            <div className="settings-general">
              <div className="settings-section">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.restoreTabsOnStartup}
                    onChange={(e) => updateSetting('restoreTabsOnStartup', e.target.checked)}
                  />
                  <span>启动时恢复上次打开的标签</span>
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
                  <span>启动时展开配置导航</span>
                </label>
                <p className="settings-desc">程序启动时自动显示左侧配置面板</p>
              </div>
              <div className="settings-section">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.fileTreeAutoExpand}
                    onChange={(e) => updateSetting('fileTreeAutoExpand', e.target.checked)}
                  />
                  <span>启动时展开文件导航</span>
                </label>
                <p className="settings-desc">程序启动时自动显示左侧文件树面板</p>
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
            </div>
          )}

          {activeTab === 'commands' && (
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
              <div className="commands-list">
                {(() => {
                  const templates = getEffectiveTemplates();
                  return templates.map((cat) => {
                    const filtered = cmdSearch
                      ? cat.commands.filter(c =>
                          c.command.toLowerCase().includes(cmdSearch.toLowerCase()) ||
                          c.desc.toLowerCase().includes(cmdSearch.toLowerCase()))
                      : cat.commands;
                    if (filtered.length === 0) return null;
                    const isExpanded = expandedCats.has(cat.category) || !!cmdSearch;
                    return (
                      <div key={cat.category} className="cmd-cat">
                        <div
                          className="cmd-cat-header"
                          onClick={() => {
                            const next = new Set(expandedCats);
                            if (next.has(cat.category)) next.delete(cat.category);
                            else next.add(cat.category);
                            setExpandedCats(next);
                          }}
                        >
                          <span className="cmd-cat-arrow">{isExpanded ? '▼' : '▶'}</span>
                          <span className="cmd-cat-name">{cat.category}</span>
                          <span className="cmd-cat-count">{filtered.length}</span>
                        </div>
                        {isExpanded && (
                          <div className="cmd-cat-items">
                            {filtered.map((cmd) => {
                              const isEditing = editingCmd === cmd.command;
                              const ov = cmdOverrides[cmd.command];
                              const effectiveDesc = ov?.desc !== undefined ? ov.desc : cmd.desc;
                              const isCustom = cat.category === '自定义';
                              return (
                                <div key={cmd.command} className="cmd-cat-item">
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
                                        const updated = customCmds.filter(c => c.command !== cmd.command);
                                        setCustomCmds(updated);
                                        saveCustomCommands(updated);
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
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          {activeTab === 'themes' && (
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
          )}
        </div>

        <div className="dialog-footer dialog-footer-right">
          <button className="btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
