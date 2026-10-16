import React, { FC, useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useAppStore } from '../../stores/appStore';
import { buildClaudeRefCommand, deleteProfile as deleteProfileCmd, getAllProfiles, updateProfile, saveConfigNavWidth, getBackendAppSettings, openInExplorer } from '../../services/tauri';
import { openProjectTerminal, openTerminalInDir } from '../../utils/openTerminalInDir';
import { matchingStartupPresets } from '../../utils/startupPresets';
import { fitContextMenuToViewport } from '../../utils/contextMenu';
import { notifyTerminalPanelResize } from '../../utils/terminalResizeEvent';
import { isModelRefLocalType } from '../../utils/claudeLaunch';
import type { ExtraParamMode, Profile } from '../../types';
import { TreeView, type TreeItem } from '../file-explorer/TreeView';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import { ClaudeModelMenuSection } from '../shared/ClaudeModelMenuSection';
import { open as openDirectory } from '@tauri-apps/plugin-dialog';
import { saveProjects } from '../../services/tauri';
import type { Project } from '../../types';
import { effectiveProfilePath, normalizeProjectPath } from '../../utils/projectPath';
import './ConfigNav.css';

const TYPE_ICONS: Record<string, string> = {
  powershell: 'PS', pwsh: 'PS7', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S', mstsc: 'RDP',
};

/** 虚拟置顶分组 id：置顶的配置聚合到此分组，永远显示在列表最顶部 */
const PINNED_GROUP_ID = '__pinned__';

interface ConfigPanelProps {
  isActive: boolean;
  isSidebarMode: boolean;
  onStartTerminal: (profile: Profile, extraParams?: string, presetName?: string, tabName?: string, presetTag?: string, presetTagColor?: string | null, extraParamMode?: ExtraParamMode) => void;
  onEditProfile: (profile: Profile) => void;
  onCopyProfile: (profile: Profile) => void;
  onAddProfile: (defaultGroup?: string) => void;
  onManageExtraParams: () => void;
}

export const ConfigNav: FC<ConfigPanelProps> = ({
  isActive,
  isSidebarMode,
  onStartTerminal,
  onEditProfile,
  onCopyProfile,
  onAddProfile,
  onManageExtraParams,
}) => {
  const profiles = useAppStore(s => s.profiles);
  const projects = useAppStore(s => s.projects);
  const setProjects = useAppStore(s => s.setProjects);
  const selectedProfileId = useAppStore(s => s.selectedProfileId);
  const selectProfile = useAppStore(s => s.selectProfile);
  const removeProfile = useAppStore(s => s.removeProfile);
  const setProfiles = useAppStore(s => s.setProfiles);
  const configPanelVisible = useAppStore(s => s.configPanelVisible);
  const configSearchQuery = useAppStore(s => s.configSearchQuery);
  const setConfigSearchQuery = useAppStore(s => s.setConfigSearchQuery);
  const extraParamPresets = useAppStore(s => s.extraParamPresets);
  const setDragProfileId = useAppStore(s => s.setDragProfileId);
  const openSettingsDialog = useAppStore(s => s.openSettingsDialog);
  const showToast = useAppStore(s => s.showToast);
  const refreshClaudeLaunchTargets = useAppStore(s => s.refreshClaudeLaunchTargets);
  const [width, setWidth] = useState(250);
  const widthRef = useRef(250);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  // 模型菜单数据源：挂载时加载，右键打开时用缓存。
  useEffect(() => {
    void refreshClaudeLaunchTargets();
  }, [refreshClaudeLaunchTargets]);

  // 启动时从后端恢复宽度
  useEffect(() => {
    getBackendAppSettings().then(s => {
      const w = s.configNavWidth || 250;
      setWidth(w);
      widthRef.current = w;
    }).catch(() => {});
  }, [isSidebarMode]);

  useEffect(() => {
    if (!isSidebarMode) return;
    const syncWidth = (event: Event) => {
      const width = (event as CustomEvent<number>).detail;
      if (Number.isFinite(width)) {
        setWidth(width);
        widthRef.current = width;
      }
    };
    window.addEventListener('navigation-width-changed', syncWidth);
    return () => window.removeEventListener('navigation-width-changed', syncWidth);
  }, [isSidebarMode]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set([PINNED_GROUP_ID]));
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; profileId: string;
  } | null>(null);
  const [groupContextMenu, setGroupContextMenu] = useState<{
    x: number; y: number; group: string;
  } | null>(null);
  const [blankContextMenu, setBlankContextMenu] = useState<{
    x: number; y: number;
  } | null>(null);
  const [renamingProfileId, setRenamingProfileId] = useState<string | null>(null);
  const [renamingProfileName, setRenamingProfileName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null | undefined>();
  const [projectName, setProjectName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [projectStartupCommand, setProjectStartupCommand] = useState('');
  const [projectError, setProjectError] = useState('');

  // Build project nodes and their profiles
  const treeItems = useMemo(() => {
    let filtered = profiles;

    if (configSearchQuery.trim()) {
      const query = configSearchQuery.toLowerCase();
      filtered = profiles.filter(p => p.name.toLowerCase().includes(query));
    }

    // 置顶项单独抽出，聚合到永远位于最顶部的虚拟【置顶】分组
    const pinnedItems = filtered.filter(p => p.pinned);
    const normalItems = filtered.filter(p => !p.pinned);

    const toLeaf = (p: Profile): TreeItem => ({
      id: p.id,
      label: p.name,
      icon: <span className="config-nav-icon-type">{TYPE_ICONS[p.terminalType] || p.terminalType.toUpperCase()}</span>,
      color: p.tabColor || undefined,
      data: p,
    });

    // Projects are flat entities; unlike legacy groups their names are not slash-separated paths.
    const result: TreeItem[] = projects
      .filter(project => !configSearchQuery.trim() || normalItems.some(p => p.group === project.name))
      .map(project => ({
        id: project.name, label: project.name, isGroup: true,
        children: normalItems.filter(p => p.group === project.name).map(toLeaf),
      }));
    // Keep legacy groups visible until their project path has been configured.
    for (const group of new Set(normalItems.map(p => p.group || '默认'))) {
      if (!result.some(item => item.id === group)) {
        result.push({ id: group, label: group, isGroup: true,
          children: normalItems.filter(p => (p.group || '默认') === group).map(toLeaf) });
      }
    }

    // 项目（含旧分组）按名称自然排序，项目内配置保持原有顺序。
    result.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true, sensitivity: 'base' }));

    // 置顶分组永远在最前
    if (pinnedItems.length > 0) {
      result.unshift({
        id: PINNED_GROUP_ID,
        label: '置顶',
        isGroup: true,
        children: [...pinnedItems].map(toLeaf),
      });
    }

    return result;
  }, [profiles, projects, configSearchQuery]);

  const handleToggle = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const handleSelect = useCallback((item: TreeItem) => {
    if (item.data) {
      selectProfile((item.data as Profile).id);
    } else if (item.isGroup) {
      selectProfile(item.id);
    }
  }, [selectProfile]);

  const handleDoubleClick = useCallback((item: TreeItem) => {
    if (item.data) {
      onStartTerminal(item.data as Profile);
    }
  }, [onStartTerminal]);

  const handleItemContextMenu = useCallback((e: React.MouseEvent, item: TreeItem) => {
    e.preventDefault();
    if (item.data) {
      const profile = item.data as Profile;
      selectProfile(profile.id);
      setGroupContextMenu(null);
      setBlankContextMenu(null);
      setContextMenu({ x: e.clientX, y: e.clientY, profileId: profile.id });
    } else if (item.isGroup && item.id !== PINNED_GROUP_ID) {
      setContextMenu(null);
      setBlankContextMenu(null);
      setGroupContextMenu({ x: e.clientX, y: e.clientY, group: item.id });
    }
  }, [selectProfile]);

  const closeContextMenu = () => {
    setContextMenu(null);
    setGroupContextMenu(null);
    setBlankContextMenu(null);
  };

  const isLocalProfile = (p: Profile) => p.terminalType === 'powershell' || p.terminalType === 'pwsh' || p.terminalType === 'cmd';
  const hasStartupPath = (p: Profile) => !!effectiveProfilePath(p, projects);

  const adjustContextMenuPosition = useCallback(() => {
    const menu = contextMenuRef.current;
    if (!menu) return;

    const { width: menuWidth, height: menuHeight } = menu.getBoundingClientRect();

    if (contextMenu) {
      const next = fitContextMenuToViewport(contextMenu.x, contextMenu.y, menuWidth, menuHeight);
      if (next.x !== contextMenu.x || next.y !== contextMenu.y) {
        setContextMenu(prev => prev ? { ...prev, ...next } : prev);
      }
      return;
    }

    if (groupContextMenu) {
      const next = fitContextMenuToViewport(groupContextMenu.x, groupContextMenu.y, menuWidth, menuHeight);
      if (next.x !== groupContextMenu.x || next.y !== groupContextMenu.y) {
        setGroupContextMenu(prev => prev ? { ...prev, ...next } : prev);
      }
      return;
    }

    if (blankContextMenu) {
      const next = fitContextMenuToViewport(blankContextMenu.x, blankContextMenu.y, menuWidth, menuHeight);
      if (next.x !== blankContextMenu.x || next.y !== blankContextMenu.y) {
        setBlankContextMenu(prev => prev ? { ...prev, ...next } : prev);
      }
    }
  }, [contextMenu, groupContextMenu, blankContextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu && !groupContextMenu && !blankContextMenu) return;
    adjustContextMenuPosition();
  }, [contextMenu, groupContextMenu, blankContextMenu, adjustContextMenuPosition, extraParamPresets, projects, profiles]);

  useEffect(() => {
    if (!contextMenu && !groupContextMenu && !blankContextMenu) return;
    const close = () => closeContextMenu();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    document.addEventListener('wheel', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      document.removeEventListener('wheel', close);
    };
  }, [contextMenu, groupContextMenu, blankContextMenu]);

  useEffect(() => {
    if (!contextMenu && !groupContextMenu && !blankContextMenu) return;
    window.addEventListener('resize', adjustContextMenuPosition);
    return () => window.removeEventListener('resize', adjustContextMenuPosition);
  }, [contextMenu, groupContextMenu, blankContextMenu, adjustContextMenuPosition]);

  const handleDeleteProfile = async (profileId: string) => {
    setConfirmDelete(profileId);
  };

  const confirmDeleteProfile = async () => {
    if (!confirmDelete) return;
    const profileId = confirmDelete;
    setConfirmDelete(null);
    try {
      await deleteProfileCmd(profileId);
      removeProfile(profileId);
    } catch (err) {
      console.error('Failed to delete profile:', err);
    }
  };

  const editProject = (name?: string) => {
    const project = projects.find(p => p.name === name) || null;
    setEditingProject(project);
    setProjectName(project?.name || name || '');
    setProjectPath(project?.path || '');
    setProjectStartupCommand(project?.startupCommand || '');
    setProjectError('');
    closeContextMenu();
  };

  const saveProject = async () => {
    const name = projectName.trim();
    const path = projectPath.trim();
    if (!name || !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path)) {
      setProjectError('请输入项目名称和绝对路径'); return;
    }
    if (projects.some(p => p.name.toLowerCase() === name.toLowerCase() && p.name !== editingProject?.name)) {
      setProjectError('项目名称已存在'); return;
    }
    const updated = [...projects.filter(p => p.name !== editingProject?.name), { name, path, startupCommand: projectStartupCommand.trim() }];
    // Legacy projects with no inferred path remain visible until edited; only persist valid paths.
    try {
      await saveProjects(updated.filter(p => p.path.trim()));
      if (editingProject) {
        let changed = false;
        for (const profile of profiles.filter(p => (p.group || '默认') === editingProject.name)) {
          // Legacy profiles had their group's path copied into startupPath. Convert
          // only exact matches to inheritance; other directories remain overrides.
          const inherits = editingProject.path &&
            normalizeProjectPath(profile.startupPath) === normalizeProjectPath(editingProject.path);
          if (profile.group !== name || inherits) {
            await updateProfile({ ...profile, group: name, startupPath: inherits ? '' : profile.startupPath });
            changed = true;
          }
        }
        if (changed) setProfiles(await getAllProfiles());
      }
      setProjects(updated);
      setEditingProject(undefined);
    } catch (error) { setProjectError(String(error)); }
  };

  const startProject = async (project: Project, preset?: typeof extraParamPresets[number]) => {
    closeContextMenu();
    await openProjectTerminal(project, preset);
  };

  /** 叶子模型启动：引用命令整体替换 startup_commands（independent），shell/路径/env 仍生效。 */
  const startProfileWithModel = (profile: Profile, providerId: string, modelId: string) => {
    closeContextMenu();
    onStartTerminal(profile, buildClaudeRefCommand(providerId, modelId), undefined, undefined, undefined, undefined, 'independent');
  };

  /** 分组模型启动：走 blank 链（恒为本地 shell），引用命令整条注入。 */
  const startProjectWithModel = async (project: Project, providerId: string, modelId: string) => {
    closeContextMenu();
    try {
      await openTerminalInDir(project.path, {
        command: buildClaudeRefCommand(providerId, modelId),
        name: `${project.name} · ${modelId}`,
        groupName: project.name,
      });
    } catch (error) {
      showToast('模型启动失败：' + String(error), 'error');
    }
  };

  const gotoProvidersSettings = () => {
    closeContextMenu();
    openSettingsDialog('llm-providers');
  };

  const handleFinishRenameProfile = async () => {
    const trimmed = renamingProfileName.trim();
    const id = renamingProfileId;
    setRenamingProfileId(null);
    if (!trimmed || !id) return;
    const profile = profiles.find(p => p.id === id);
    if (!profile || profile.name === trimmed) return;
    try {
      await updateProfile({ ...profile, name: trimmed });
      const data = await getAllProfiles();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to rename profile:', err);
    }
  };

  const handleTogglePin = async (profile: Profile) => {
    try {
      await updateProfile({ ...profile, pinned: !profile.pinned });
      const data = await getAllProfiles();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to toggle pin:', err);
    }
  };

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleResizeMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const newWidth = e.clientX - rect.left;
        if (newWidth >= 150 && newWidth <= (isSidebarMode ? 400 : 500)) {
          setWidth(newWidth);
          widthRef.current = newWidth;
          notifyTerminalPanelResize();
        }
      }
    });
  }, [isResizing, isSidebarMode]);

  const handleResizeMouseUp = useCallback(() => {
    setIsResizing(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    saveConfigNavWidth(widthRef.current).catch(() => {});
    notifyTerminalPanelResize();
    if (isSidebarMode) {
      window.dispatchEvent(new CustomEvent('navigation-width-changed', { detail: widthRef.current }));
    }
  }, [isSidebarMode]);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleResizeMouseMove);
      document.addEventListener('mouseup', handleResizeMouseUp);
    }
    return () => {
      document.removeEventListener('mousemove', handleResizeMouseMove);
      document.removeEventListener('mouseup', handleResizeMouseUp);
    };
  }, [isResizing, handleResizeMouseMove, handleResizeMouseUp]);

  // 跟踪上次点击区域
  useEffect(() => {
    const panel = containerRef.current;
    if (!panel) return;
    const handler = (e: MouseEvent) => {
      if (e.button !== 0) return;
      useAppStore.getState().setLastClickRegion('config');
    };
    panel.addEventListener('mousedown', handler);
    return () => panel.removeEventListener('mousedown', handler);
  }, []);

  // F2 快速重命名分组/配置
  // 注意：TreeView 组件内部已经独立注册了 group 重命名的 onKeyDown（不检查 lastClickRegion）。
  // 我们这里不传 onGroupRename 给 TreeView，避免它在焦点残留时被错误触发。
  // ConfigNav 的 document 级 F2 handler 已统一处理 group 和 profile 两类重命名。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      if (!isActive) return;
      const region = useAppStore.getState().lastClickRegion;
      // 仅在 region 是 'config' 或尚未初始化（null）时响应；
      // 'tab'/'history' 等其他面板会把 region 设成自己的值，从而屏蔽此处。
      if (region && region !== 'config') return;
      if (!selectedProfileId) return;
      const item = findTreeItemById(treeItems, selectedProfileId);
      if (item?.isGroup || (item?.children && item.children.length > 0)) {
        editProject(selectedProfileId);
      } else if (item?.data) {
        const profile = item.data as Profile;
        setRenamingProfileId(profile.id);
        setRenamingProfileName(profile.name);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isActive, selectedProfileId, treeItems]);

  return (
    <div
      ref={containerRef}
      className={`config-nav${isSidebarMode ? ' sidebar-mode' : ''} ${!configPanelVisible ? 'collapsed' : ''}`}
      style={{ width }}
      onMouseDown={() => { useAppStore.getState().setLastClickRegion('config'); }}
      onClick={closeContextMenu}
    >
      <div className="panel-titlebar">
        <span className="panel-title">项目与命令</span>
        <span className="panel-title-count">{profiles.length}</span>
        <button type="button" className="config-nav-add-project" title="添加项目" onClick={() => editProject()}>+ 项目</button>
      </div>
      <div className="config-nav-search-bar">
        <input
          type="text"
          className="config-nav-search-input"
          placeholder="搜索配置..."
          value={configSearchQuery}
          onChange={(e) => setConfigSearchQuery(e.target.value)}
        />
      </div>
      <div className="config-nav-list" onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.tree-item')) return;
        e.preventDefault();
        setContextMenu(null);
        setGroupContextMenu(null);
        setBlankContextMenu({ x: e.clientX, y: e.clientY });
      }}>
        <TreeView
          items={treeItems}
          expandedIds={expandedGroups}
          onToggle={handleToggle}
          selectedId={selectedProfileId}
          onSelect={handleSelect}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleItemContextMenu}
          renamingProfileId={renamingProfileId}
          renamingProfileValue={renamingProfileName}
          onRenamingProfileChange={setRenamingProfileName}
          onRenamingProfileSubmit={handleFinishRenameProfile}
          onRenamingProfileCancel={() => setRenamingProfileId(null)}
          itemDraggable
          onItemDragStart={(e, item) => {
            const profile = item.data as Profile | undefined;
            if (!profile) return;
            setDragProfileId(profile.id);
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', profile.id);
          }}
          onItemDragEnd={() => setDragProfileId(null)}
        />
        {projects.length === 0 && profiles.length === 0 && (
          <div className="empty-state">暂无配置，点击新建</div>
        )}
      </div>

      {contextMenu && (
        <div ref={contextMenuRef} className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            if (target) onStartTerminal(target);
            closeContextMenu();
          }}>启动</div>
          {matchingStartupPresets(extraParamPresets,
            profiles.find(p => p.id === contextMenu.profileId)?.startupCommands || [])
            .map((preset) => (
            <div key={preset.id} className="context-menu-item" onClick={() => {
              const target = profiles.find((p) => p.id === contextMenu.profileId);
              if (target) onStartTerminal(target, preset.params, preset.name, undefined, preset.name, preset.tagColor, preset.mode);
              closeContextMenu();
            }}>
              启动<span
                className="config-nav-preset-chip"
                style={preset.tagColor ? { backgroundColor: preset.tagColor } : undefined}
              >
                {preset.name}
              </span>
            </div>
          ))}
          <div className="context-menu-item" onClick={async () => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            closeContextMenu();
            if (target) {
              try { await openTerminalInDir(effectiveProfilePath(target, projects) || undefined); }
              catch (err) { console.error(err); }
            }
          }}>命令行</div>
          {(() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            // 仅本地 shell 类型显示模型区：后端 ssh/docker/k8s 分支会丢弃引用。
            if (!target || !isModelRefLocalType(target.terminalType)) return null;
            return (
              <ClaudeModelMenuSection
                itemClassName="context-menu-item"
                separatorClassName="context-menu-separator"
                title="Claude 模型"
                onPickModel={(providerId, modelId) => startProfileWithModel(target, providerId, modelId)}
                onGotoProviders={gotoProvidersSettings}
              />
            );
          })()}
          <div className="context-menu-item" onClick={() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            closeContextMenu();
            if (target) onAddProfile(target.group || '默认');
          }}>添加配置</div>
          {(() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            if (!target || !isLocalProfile(target) || !hasStartupPath(target)) return null;
            return (
              <>
                <div className="context-menu-item" onClick={async () => {
                  const t = profiles.find((p) => p.id === contextMenu.profileId);
                  closeContextMenu();
                  if (t) {
                    try { await openInExplorer(effectiveProfilePath(t, projects)); }
                    catch (err) { console.error(err); }
                  }
                }}>打开目录</div>
                <div className="context-menu-item" onClick={() => {
                  const t = profiles.find((p) => p.id === contextMenu.profileId);
                  if (t) navigator.clipboard.writeText(effectiveProfilePath(t, projects)).catch(() => {});
                  closeContextMenu();
                }}>复制启动路径</div>
              </>
            );
          })()}
          <div className="context-menu-item" onClick={() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            if (target) onEditProfile(target);
            closeContextMenu();
          }}>编辑</div>
          <div className="context-menu-item" onClick={() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            if (target) handleTogglePin(target);
            closeContextMenu();
          }}>{profiles.find((p) => p.id === contextMenu.profileId)?.pinned ? '取消置顶' : '置顶'}</div>
          <div className="context-menu-item" onClick={() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            if (target) onCopyProfile(target);
            closeContextMenu();
          }}>复制</div>
          <div className="context-menu-item" onClick={() => {
            const profile = profiles.find((p) => p.id === contextMenu.profileId);
            if (profile) {
              setRenamingProfileId(profile.id);
              setRenamingProfileName(profile.name);
            }
            closeContextMenu();
          }}>重命名</div>
          <div className="context-menu-item danger" onClick={() => {
            handleDeleteProfile(contextMenu.profileId);
            closeContextMenu();
          }}>删除</div>
        </div>
      )}

      {groupContextMenu && (
        <div ref={contextMenuRef} className="context-menu" style={{ left: groupContextMenu.x, top: groupContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {(() => {
            const project = projects.find(item => item.name === groupContextMenu.group);
            if (!project?.path) return null;
            const command = project.startupCommand?.trim() || '';
            return <>
              <div className="context-menu-item" onClick={() => void startProject(project)}>启动项目</div>
              {matchingStartupPresets(extraParamPresets, [command]).map(preset => (
                <div key={preset.id} className="context-menu-item" onClick={() => void startProject(project, preset)}>
                  启动<span className="config-nav-preset-chip" style={preset.tagColor ? { backgroundColor: preset.tagColor } : undefined}>{preset.name}</span>
                </div>
              ))}
              <div className="context-menu-item" onClick={async () => {
                closeContextMenu();
                try { await openTerminalInDir(project.path); }
                catch (err) { console.error(err); }
              }}>命令行</div>
              <ClaudeModelMenuSection
                itemClassName="context-menu-item"
                separatorClassName="context-menu-separator"
                title="Claude 模型"
                onPickModel={(providerId, modelId) => void startProjectWithModel(project, providerId, modelId)}
                onGotoProviders={gotoProvidersSettings}
              />
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={async () => {
                closeContextMenu();
                try { await openInExplorer(project.path); }
                catch (err) { console.error(err); }
              }}>打开目录</div>
              <div className="context-menu-item" onClick={() => {
                navigator.clipboard.writeText(project.path).catch(() => {});
                closeContextMenu();
              }}>复制启动路径</div>
            </>;
          })()}
          <div className="context-menu-item" onClick={() => { onAddProfile(groupContextMenu.group); closeContextMenu(); }}>
            添加配置
          </div>
          <div className="context-menu-item" onClick={() => editProject(groupContextMenu.group)}>
            编辑项目
          </div>
          {!profiles.some(p => p.group === groupContextMenu.group) && (
            <div className="context-menu-item danger" onClick={() => {
              setConfirmDeleteProject(groupContextMenu.group); closeContextMenu();
            }}>删除项目</div>
          )}
        </div>
      )}

      {blankContextMenu && (
        <div ref={contextMenuRef} className="context-menu" style={{ left: blankContextMenu.x, top: blankContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => { onAddProfile(projects[0]?.name); closeContextMenu(); }}>
            添加配置
          </div>
          <div className="context-menu-item" onClick={() => editProject()}>添加项目</div>
          <div className="context-menu-item" onClick={() => { onManageExtraParams(); closeContextMenu(); }}>
            启动参数管理
          </div>
        </div>
      )}

      {editingProject !== undefined && (
        <Dialog
          title={editingProject ? '编辑项目' : '新建项目'}
          className="project-edit-dialog"
          onClose={() => setEditingProject(undefined)}
          footer={(
            <>
              <button type="button" className="btn-secondary" onClick={() => setEditingProject(undefined)}>取消</button>
              <button type="submit" form="project-edit-form" className="btn-primary">保存</button>
            </>
          )}
        >
          <form id="project-edit-form" onSubmit={event => { event.preventDefault(); void saveProject(); }}>
            <div className="form-group">
              <label htmlFor="project-edit-name">项目名称 *</label>
              <input id="project-edit-name" value={projectName} onChange={event => { setProjectName(event.target.value); setProjectError(''); }} placeholder="项目名称" autoFocus />
            </div>
            <div className="form-group">
              <label htmlFor="project-edit-path">项目路径 *</label>
              <div className="input-with-button">
                <input id="project-edit-path" value={projectPath} onChange={event => { setProjectPath(event.target.value); setProjectError(''); }} placeholder={'C:\\Projects\\MyProject'} />
                <button type="button" className="browse-btn" onClick={() => void openDirectory({ directory: true, multiple: false }).then(path => {
                  if (typeof path === 'string') { setProjectPath(path); setProjectError(''); }
                }).catch(error => setProjectError('浏览目录失败：' + String(error)))}>浏览</button>
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="project-edit-command">启动命令</label>
              <input id="project-edit-command" value={projectStartupCommand} onChange={event => setProjectStartupCommand(event.target.value)} placeholder="例如 claude 或 npm run dev" />
              <small>在项目目录的 PowerShell 中执行；右键菜单根据此命令匹配启动参数。留空仅打开终端。</small>
            </div>
            {projectError && <div className="error" role="alert">{projectError}</div>}
          </form>
        </Dialog>
      )}
      {confirmDeleteProject && (
        <ConfirmDialog title="删除项目" message={`确定删除项目「${confirmDeleteProject}」吗？`}
          onClose={() => setConfirmDeleteProject(null)}
          onConfirm={() => void (async () => {
            const updated = projects.filter(p => p.name !== confirmDeleteProject);
            try {
              await saveProjects(updated.filter(p => p.path.trim()));
              setProjects(updated);
              setConfirmDeleteProject(null);
            } catch (error) { console.error('删除项目失败:', error); }
          })()} confirmText="删除" />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="确认删除"
          message="确定要删除此配置吗？"
          onClose={() => setConfirmDelete(null)}
          onConfirm={confirmDeleteProfile}
          confirmText="删除"
        />
      )}
      <div
        className={`config-nav-resize-handle ${isResizing ? 'active' : ''}`}
        onMouseDown={handleResizeMouseDown}
      />
    </div>
  );
};

function findTreeItemById(items: TreeItem[], id: string): TreeItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children) {
      const found = findTreeItemById(item.children, id);
      if (found) return found;
    }
  }
  return null;
}
