import { FC, useState, useEffect, useRef, useMemo } from 'react';
import { getBackendAppSettings, syncLaunchAtLogin, getDataPath, deleteProfile as deleteProfileCmd, getAllProfiles, createProfile, updateProfile, saveWebApiSettings, getWebApiStatus, restartWebServer, getWebServerAddress, getDownloadsDirectory } from '../services/tauri';
import { useAppStore } from '../stores/appStore';
import { type Profile } from '../types';
import { type AppSettings, getAppSettings, saveAppSettings } from '../utils/settings';
import { ConfigEditDialog } from './ConfigEditDialog';
import { getCmdOverrides, saveCmdOverrides, getCustomCommands, saveCustomCommands, getEffectiveTemplates, type CmdOverride, type CommandItem } from '../data/commandTemplates';
import { SshSettings } from './settings/SshSettings';
import { AiUsageSettings } from './settings/AiUsageSettings';
import { BehaviorSettings } from './settings/BehaviorSettings';
import { DataSettings } from './settings/DataSettings';
import { ExclusionSettings } from './settings/ExclusionSettings';
import { ThemesSettings } from './settings/ThemesSettings';
import { WebSettings } from './settings/WebSettings';
import './SettingsPage.css';

interface SettingsPageProps {
  onClose: () => void;
}

const SECTIONS = [
  { id: 'behavior', label: '行为设置' },
  { id: 'data', label: '数据管理' },
  { id: 'profiles', label: '连接管理' },
  { id: 'commands', label: '命令模板' },
  { id: 'themes', label: '主题管理' },
  { id: 'exclusions', label: '文件排除' },
  { id: 'ai-usage', label: 'AI用量' },
  { id: 'web', label: 'Web管理' },
  { id: 'ssh', label: 'SSH 设置' },
] as const;

export const SettingsPage: FC<SettingsPageProps> = ({ onClose }) => {
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
  const [activeSection, setActiveSection] = useState('behavior');
  const [profileSearch, setProfileSearch] = useState('');
  const [profileGroupTab, setProfileGroupTab] = useState('');
  const [showProfileDialog, setShowProfileDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [profileContextMenu, setProfileContextMenu] = useState<{ x: number; y: number; profile: Profile } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [webPassword, setWebPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [serverAddress, setServerAddress] = useState('');
  const [serverRunning, setServerRunning] = useState(false);
  const [serverError, setServerError] = useState('');
  const [serverLoading, setServerLoading] = useState(false);

  const askConfirm = (message: string, onConfirm: () => void) => {
    setConfirmDialog({ message, onConfirm });
  };

  const profiles = useAppStore(s => s.profiles);
  const setProfiles = useAppStore(s => s.setProfiles);

  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  const effectiveTemplates = useMemo(() => getEffectiveTemplates(), [cmdOverrides, customCmds]);

  useEffect(() => {
    if (!activeCmdTab && effectiveTemplates.length > 0) {
      setActiveCmdTab(effectiveTemplates[0].category);
    }
  }, [effectiveTemplates, activeCmdTab]);

  useEffect(() => {
    const timer = setTimeout(() => saveAppSettings(settings), 300);
    return () => clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    getBackendAppSettings().then(backend => {
      const prev = getAppSettings();
      const synced = {
        ...prev,
        closeBehavior: backend.closeBehavior,
        enableTabNavigation: backend.enableTabNavigation,
        singleInstance: backend.singleInstance,
      };
      setSettings(synced);
      saveAppSettings(synced);
      if (synced.enableTabNavigation !== prev.enableTabNavigation) {
        window.dispatchEvent(new CustomEvent('tab-navigation-changed'));
      }
    }).catch(() => {});
    syncLaunchAtLogin().then(enabled => {
      const prev = getAppSettings();
      if (prev.launchAtLogin !== enabled) {
        const synced = { ...prev, launchAtLogin: enabled };
        setSettings(synced);
        saveAppSettings(synced);
      }
    }).catch(() => {});
    getDataPath().then(setDataPath).catch(() => {});
    // Load default downloads directory for SSH settings
    if (!getAppSettings().sshDownloadDir) {
      getDownloadsDirectory().then(dir => {
        updateSetting('sshDownloadDir', dir);
      }).catch(() => {});
    }
  }, []);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      saveAppSettings(next);
      return next;
    });
  };

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

  // Load web status on mount so state is correct when user navigates to Web section
  useEffect(() => { loadWebStatus(); }, []);

  useEffect(() => {
    if (activeSection === 'web') {
      loadWebStatus();
    }
  }, [activeSection]);

  const loadWebStatus = async () => {
    try {
      const status = await getWebApiStatus();
      setSettings(prev => ({ ...prev, webApiEnabled: status.enabled, webApiPort: status.port, webApiUsername: status.username }));
      setHasPassword(status.hasPassword);
      const addr = await getWebServerAddress();
      setServerAddress(addr);
      setServerRunning(addr.startsWith('http'));
      setServerError('');
    } catch {}
  };

  const scrollToSection = (id: string) => {
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const profileGroupsWithCount = useMemo(() => {
    const countMap = new Map<string, number>();
    for (const p of profiles) {
      const g = p.group || '默认';
      countMap.set(g, (countMap.get(g) || 0) + 1);
    }
    return Array.from(countMap.entries()).map(([name, count]) => ({ name, count }));
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
    if (profileGroupsWithCount.length > 0 && !profileGroupTab) {
      setProfileGroupTab(profileGroupsWithCount[0].name);
    }
  }, [profileGroupsWithCount, profileGroupTab]);

  const loadProfiles = async () => {
    try {
      const data = await getAllProfiles();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to load profiles:', err);
    }
  };

  const handleSave = async () => {
    try {
      await saveWebApiSettings(
        settings.webApiEnabled,
        settings.webApiPort,
        settings.webApiUsername,
        webPassword,
        settings.webApiShareSessions
      );
      if (webPassword) setWebPassword('');
    } catch (e) {
      console.error('[WebAPI] 保存失败:', e);
    }
    onClose();
  };

  const handleToggleServer = async () => {
    setServerLoading(true);
    setServerError('');
    try {
      if (serverRunning) {
        // 停止：先关闭开关，保存，再重启（restart_web_server 会检测 enabled=false 并停止）
        setSettings(prev => ({ ...prev, webApiEnabled: false }));
        await saveWebApiSettings(false, settings.webApiPort, settings.webApiUsername, '', settings.webApiShareSessions);
        const result = await restartWebServer();
        setServerRunning(false);
        setServerAddress('已停止');
        console.log('[WebAPI]', result);
      } else {
        if (!webPassword && !hasPassword) {
          setServerError('请先设置密码');
          setServerLoading(false);
          return;
        }
        // 确保开关打开
        if (!settings.webApiEnabled) {
          setSettings(prev => ({ ...prev, webApiEnabled: true }));
        }
        await saveWebApiSettings(true, settings.webApiPort, settings.webApiUsername, webPassword, settings.webApiShareSessions);
        const result = await restartWebServer();
        const addr = await getWebServerAddress();
        setServerAddress(addr);
        setServerRunning(addr.startsWith('http'));
        console.log('[WebAPI]', result);
        if (!addr.startsWith('http')) {
          setServerError(result || '服务启动失败');
        }
      }
    } catch (e: any) {
      setServerError(e?.toString() || '操作失败');
      console.error('[WebAPI] 操作失败:', e);
    }
    setServerLoading(false);
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
          {/* Behavior Section */}
          <section
            id="behavior"
            ref={(el) => { sectionRefs.current['behavior'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">行为设置</h3>
            <BehaviorSettings settings={settings} updateSetting={updateSetting} />
          </section>

          {/* Data Section */}
          <section
            id="data"
            ref={(el) => { sectionRefs.current['data'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">数据管理</h3>
            <DataSettings dataPath={dataPath} askConfirm={askConfirm} setConfirmDialog={setConfirmDialog} />
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
              {!profileSearch && profileGroupsWithCount.length > 0 && (
                <div className="cmd-tabs">
                  {profileGroupsWithCount.map(({ name, count }) => (
                    <button
                      key={name}
                      className={`cmd-tab ${profileGroupTab === name ? 'active' : ''}`}
                      onClick={() => setProfileGroupTab(name)}
                    >
                      {name}
                      <span className="cmd-tab-count">{count}</span>
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
                      {{ powershell: 'PS', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S', editor: 'ED', mstsc: 'RDP' }[profile.terminalType]}
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
                profiles={profiles}
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
            <ThemesSettings />
          </section>

          {/* Exclusions Section */}
          <section
            id="exclusions"
            ref={(el) => { sectionRefs.current['exclusions'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">文件排除</h3>
            <ExclusionSettings askConfirm={askConfirm} setConfirmDialog={setConfirmDialog} />
          </section>

          {/* AI Usage Section */}
          <section
            id="ai-usage"
            ref={(el) => { sectionRefs.current['ai-usage'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">AI用量</h3>
            <AiUsageSettings settings={settings} updateSetting={updateSetting} />
          </section>

          {/* Web Management Section */}
          <section
            id="web"
            ref={(el) => { sectionRefs.current['web'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">Web 远程管理</h3>
            <WebSettings
              settings={settings}
              setSettings={setSettings}
              updateSetting={updateSetting}
              webPassword={webPassword}
              setWebPassword={setWebPassword}
              serverRunning={serverRunning}
              serverAddress={serverAddress}
              serverError={serverError}
              serverLoading={serverLoading}
              handleToggleServer={handleToggleServer}
            />
          </section>

          {/* SSH Settings Section */}
          <section
            id="ssh"
            ref={(el) => { sectionRefs.current['ssh'] = el; }}
            className="settings-section-block"
          >
            <h3 className="settings-section-title">SSH 设置</h3>
            <SshSettings settings={settings} updateSetting={updateSetting} />
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
