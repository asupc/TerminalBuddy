import React, { FC, useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { Plus } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { buildClaudeRefCommand, deleteProfile as deleteProfileCmd, getAllProfiles, updateProfile, saveConfigNavWidth, getBackendAppSettings, openInExplorer } from '../../services/tauri';
import { openTerminalInDir } from '../../utils/openTerminalInDir';
import { fitContextMenuToViewport } from '../../utils/contextMenu';
import { notifyTerminalPanelResize } from '../../utils/terminalResizeEvent';
import { buildCodexRefCommand, isCodexCommand } from '../../utils/codexLaunch';
import { inheritableClaudeArgs, isClaudeCommand, isModelRefLocalType } from '../../utils/claudeLaunch';
import { currentClaudeCommand } from '../../utils/agentCommands';
import type { ExtraParamMode, Profile } from '../../types';
import { TreeView, type TreeItem } from '../file-explorer/TreeView';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import { ClaudeModelMenuSection } from '../shared/ClaudeModelMenuSection';
import { ProjectContextMenu } from '../shared/ProjectContextMenu';
import { ProjectEditDialog } from '../shared/ProjectEditDialog';
import { ProjectDeleteDialog } from '../shared/ProjectDeleteDialog';
import { ProjectTasksView } from './ProjectTasksView';
import { ConfiguredTerminalMenuItem } from '../shell/NewTerminalMenu';
import { useSessionCloseActions } from '../../hooks/useSessionCloseActions';
import { effectiveProfilePath } from '../../utils/projectPath';
import { defaultShellType, isDockerClient, serverUsesWindowsPaths, supportsSystemExplorerOpen } from '../../services/platform';
import './ConfigNav.css';

const TYPE_ICONS: Record<string, string> = {
  powershell: 'PS', pwsh: 'PS7', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S', mstsc: 'RDP',
};

/** 虚拟置顶分组 id：置顶的配置聚合到此分组，永远显示在列表最顶部 */
const PINNED_GROUP_ID = '__pinned__';

interface ConfigPanelProps {
  isActive: boolean;
  isSidebarMode: boolean;
  experimentalProjectTasks?: boolean;
  startupRestoreComplete: boolean;
  onStartTerminal: (profile: Profile, extraParams?: string, tabName?: string, extraParamMode?: ExtraParamMode) => void;
  onStartBlankTerminal?: (terminalType: 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh') => void;
  onStartTextEditor?: () => void;
  onEditProfile: (profile: Profile) => void;
  onCopyProfile: (profile: Profile) => void;
  onAddProfile: (defaultGroup?: string) => void;
}

export const ConfigNav: FC<ConfigPanelProps> = ({
  isActive,
  isSidebarMode,
  experimentalProjectTasks = false,
  startupRestoreComplete,
  onStartTerminal,
  onStartBlankTerminal,
  onStartTextEditor,
  onEditProfile,
  onCopyProfile,
  onAddProfile,
}) => {
  const profiles = useAppStore(s => s.profiles);
  const projects = useAppStore(s => s.projects);
  const sessions = useAppStore(s => s.sessions);
  const agentTabs = useAppStore(s => s.agentTabs);
  const gitChangesTab = useAppStore(s => s.gitChangesTab);
  const gitHistoryTab = useAppStore(s => s.gitHistoryTab);
  const scheduledTasksTabOpen = useAppStore(s => s.scheduledTasksTabOpen);
  const claudeReplayTabs = useAppStore(s => s.claudeReplayTabs);
  const selectedProfileId = useAppStore(s => s.selectedProfileId);
  const selectProfile = useAppStore(s => s.selectProfile);
  const removeProfile = useAppStore(s => s.removeProfile);
  const setProfiles = useAppStore(s => s.setProfiles);
  const configPanelVisible = useAppStore(s => s.configPanelVisible);
  const configSearchQuery = useAppStore(s => s.configSearchQuery);
  const setConfigSearchQuery = useAppStore(s => s.setConfigSearchQuery);
  const setDragProfileId = useAppStore(s => s.setDragProfileId);
  const openSettingsDialog = useAppStore(s => s.openSettingsDialog);
  const refreshCodexLaunchTargets = useAppStore(s => s.refreshCodexLaunchTargets);
  const refreshClaudeLaunchTargets = useAppStore(s => s.refreshClaudeLaunchTargets);
  const {
    confirmDialog: sessionConfirmDialog,
    setConfirmDialog: setSessionConfirmDialog,
    draftCloseDialog,
    setDraftCloseDialog,
    handleCloseTerminal,
    handleDraftSaveAs,
    handleDraftDiscard,
    handleCloseGroup,
    handleCloseAllTabs,
  } = useSessionCloseActions();
  const [width, setWidth] = useState(250);
  const widthRef = useRef(250);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const newTerminalSubmenuRef = useRef<HTMLDivElement>(null);
  const [submenuExpandedGroups, setSubmenuExpandedGroups] = useState<Set<string>>(() => new Set());
  const rafRef = useRef<number | null>(null);

  // 模型菜单数据源：挂载时加载，右键打开时用缓存。
  useEffect(() => {
    void refreshClaudeLaunchTargets();
    void refreshCodexLaunchTargets();
  }, [refreshClaudeLaunchTargets, refreshCodexLaunchTargets]);

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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set([
    PINNED_GROUP_ID,
    ...(isDockerClient() ? ['服务器工作区'] : []),
  ]));
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
  // 项目编辑对话框目标名：null 关闭；空字符串新建；否则编辑 / 按该名称新建。
  const [editingProject, setEditingProject] = useState<string | null>(null);

  // Build project nodes and their profiles
  const treeItems = useMemo(() => {
    let filtered = profiles;

    if (!experimentalProjectTasks && configSearchQuery.trim()) {
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
      .filter(project => experimentalProjectTasks || !configSearchQuery.trim() || normalItems.some(p => p.group === project.name))
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
  }, [profiles, projects, configSearchQuery, experimentalProjectTasks]);

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

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setGroupContextMenu(null);
    setBlankContextMenu(null);
  }, []);

  const handleTaskProfileContextMenu = useCallback((e: React.MouseEvent, profileId: string) => {
    selectProfile(profileId);
    setGroupContextMenu(null);
    setBlankContextMenu(null);
    setContextMenu({ x: e.clientX, y: e.clientY, profileId });
  }, [selectProfile]);

  const handleTaskGroupContextMenu = useCallback((e: React.MouseEvent, groupId: string) => {
    setContextMenu(null);
    setBlankContextMenu(null);
    setGroupContextMenu({ x: e.clientX, y: e.clientY, group: groupId });
  }, []);

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

    if (blankContextMenu) {
      const next = fitContextMenuToViewport(blankContextMenu.x, blankContextMenu.y, menuWidth, menuHeight);
      if (next.x !== blankContextMenu.x || next.y !== blankContextMenu.y) {
        setBlankContextMenu(prev => prev ? { ...prev, ...next } : prev);
      }
    }
  }, [contextMenu, blankContextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu && !blankContextMenu) return;
    adjustContextMenuPosition();
  }, [contextMenu, blankContextMenu, adjustContextMenuPosition, projects, profiles]);

  useEffect(() => {
    if (!contextMenu && !blankContextMenu) return;
    const close = () => closeContextMenu();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    document.addEventListener('wheel', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      document.removeEventListener('wheel', close);
    };
  }, [contextMenu, blankContextMenu]);

  useEffect(() => {
    if (!contextMenu && !blankContextMenu) return;
    window.addEventListener('resize', adjustContextMenuPosition);
    return () => window.removeEventListener('resize', adjustContextMenuPosition);
  }, [contextMenu, blankContextMenu, adjustContextMenuPosition]);

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
    // 命中已登记项目时进入编辑，否则以该名称预填新建（与右键菜单的行为一致）。
    setEditingProject(name ?? '');
    closeContextMenu();
  };

  /** 叶子模型启动：引用命令整体替换 startup_commands（independent），shell/路径/env 仍生效，
   * 原 claude 命令的参数（如 --dangerously-skip-permissions）继承到引用命令后。 */
  const startProfileWithModel = (profile: Profile, providerId: string, modelId: string) => {
    closeContextMenu();
    onStartTerminal(profile, buildClaudeRefCommand(providerId, modelId, inheritableClaudeArgs(profile.startupCommands, currentClaudeCommand())), undefined, 'independent');
  };

  const startProfileWithCodexModel = (profile: Profile, providerId: string, modelId: string) => {
    closeContextMenu();
    onStartTerminal(profile, buildCodexRefCommand(providerId, modelId, profile.startupCommands), undefined, 'independent');
  };

  const gotoProvidersSettings = (source: 'claude' | 'codex' = 'claude') => {
    useAppStore.getState().setProviderSettingsTab(source);
    closeContextMenu();
    openSettingsDialog('llm-providers');
  };

  // 连接配置按启动命令内容推导模型区：当前工具的供应商排在前面，其他工具用于直接切换启动。
  const commandModelSources = (commands: string[]): Array<'claude' | 'codex'> =>
    commands.some(isClaudeCommand) ? ['claude', 'codex']
      : commands.some(isCodexCommand) ? ['codex', 'claude'] : [];

  const modelMenuSections = (
    sources: Array<'claude' | 'codex'>,
    onPickModel: (source: 'claude' | 'codex', providerId: string, modelId: string) => void,
  ) => {
    return sources.map(source => (
      <ClaudeModelMenuSection
        key={source}
        source={source}
        itemClassName="context-menu-item"
        separatorClassName="context-menu-separator"
        title={source === 'claude' ? 'Claude 模型' : 'Codex 模型'}
        onPickModel={(providerId, modelId) => onPickModel(source, providerId, modelId)}
        onGotoProviders={() => gotoProvidersSettings(source)}
      />
    ));
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

  // 跟踪上次点击区域（项目与任务模式下点击会话条目/配置子分组时由子元素自行控制，不覆盖为 config）
  useEffect(() => {
    const panel = containerRef.current;
    if (!panel) return;
    const handler = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('.tab-nav-item, .tab-nav-settings-btn, .project-tasks-config-group, .context-menu, .context-menu-overlay')) {
        return;
      }
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
      if (experimentalProjectTasks) {
        const profile = profiles.find(p => p.id === selectedProfileId);
        if (profile) {
          setRenamingProfileId(profile.id);
          setRenamingProfileName(profile.name);
          return;
        }
        const hasProjectOrGroup =
          projects.some(p => p.name === selectedProfileId)
          || profiles.some(p => (p.group || '默认') === selectedProfileId);
        if (hasProjectOrGroup) {
          editProject(selectedProfileId);
        }
        return;
      }
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
  }, [isActive, selectedProfileId, treeItems, experimentalProjectTasks, profiles, projects]);

  const nativeAgentTabCount = agentTabs.filter(tab => tab.shape === 'native').length;
  const openSessionCount = sessions.length + nativeAgentTabCount;
  const hasAnyProjectTasksContent =
    projects.length > 0
    || profiles.length > 0
    || sessions.length > 0
    || agentTabs.length > 0
    || Boolean(gitChangesTab)
    || Boolean(gitHistoryTab)
    || scheduledTasksTabOpen
    || claudeReplayTabs.length > 0;

  const profilePinMenuItem = contextMenu && (
    <div className="context-menu-item" onClick={() => {
      const target = profiles.find(profile => profile.id === contextMenu.profileId);
      if (target) handleTogglePin(target);
      closeContextMenu();
    }}>{profiles.find(profile => profile.id === contextMenu.profileId)?.pinned ? '取消置顶' : '置顶'}</div>
  );

  return (
    <div
      ref={containerRef}
      className={`config-nav${experimentalProjectTasks ? ' project-tasks-mode' : ''}${isSidebarMode ? ' sidebar-mode' : ''} ${!configPanelVisible ? 'collapsed' : ''}`}
      style={{ width }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest('.tab-nav-item, .tab-nav-settings-btn, .project-tasks-config-group, .context-menu, .context-menu-overlay')) {
          return;
        }
        useAppStore.getState().setLastClickRegion('config');
      }}
      onClick={closeContextMenu}
    >
      <div className="panel-titlebar">
        <span className="panel-title">{experimentalProjectTasks ? '项目与任务' : '项目与命令'}</span>
        <span className="panel-title-count">{experimentalProjectTasks ? openSessionCount : profiles.length}</span>
        <button type="button" className="config-nav-add-project" title="添加项目" onClick={() => editProject()}>
          {experimentalProjectTasks ? <><Plus aria-hidden="true" /><span>项目</span></> : '+ 项目'}
        </button>
      </div>
      {!experimentalProjectTasks && (
        <div className="config-nav-search-bar">
          <input
            type="text"
            className="config-nav-search-input"
            placeholder="搜索配置..."
            value={configSearchQuery}
            onChange={(e) => setConfigSearchQuery(e.target.value)}
          />
        </div>
      )}
      <div className="config-nav-list" onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.tree-item, .tab-nav-settings-btn')) return;
        e.preventDefault();
        setContextMenu(null);
        setGroupContextMenu(null);
        setBlankContextMenu({ x: e.clientX, y: e.clientY });
      }}>
        {experimentalProjectTasks ? (
          <>
            {!hasAnyProjectTasksContent && (
              <div className="empty-state">暂无项目或会话，点击新建</div>
            )}
            <ProjectTasksView
              isActive={isActive}
              startupRestoreComplete={startupRestoreComplete}
              searchQuery=""
              selectedProfileId={selectedProfileId}
              renamingProfileId={renamingProfileId}
              renamingProfileName={renamingProfileName}
              onRenamingProfileChange={setRenamingProfileName}
              onRenamingProfileSubmit={handleFinishRenameProfile}
              onRenamingProfileCancel={() => setRenamingProfileId(null)}
              onStartTerminal={onStartTerminal}
              onProfileContextMenu={handleTaskProfileContextMenu}
              onGroupContextMenu={handleTaskGroupContextMenu}
              onCloseSession={handleCloseTerminal}
              onCloseGroup={handleCloseGroup}
              onCloseExternalMenus={closeContextMenu}
            />
          </>
        ) : (
          <>
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
              showEmptyGroupArrow
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
          </>
        )}
      </div>

      {contextMenu && (
        <div ref={contextMenuRef} className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            if (target) onStartTerminal(target);
            closeContextMenu();
          }}>启动</div>
          {experimentalProjectTasks && profilePinMenuItem}
          <div className="context-menu-item" onClick={async () => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            closeContextMenu();
            if (target) {
              // 空白终端没有 profile 可回退分组，必须显式带上所属项目，
              // 否则会话标签会落到“默认”分组。
              // 启动后焦点转到新会话，状态栏不再跟随面板选中项。
              useAppStore.getState().setLastClickRegion('tab');
              try { await openTerminalInDir(effectiveProfilePath(target, projects) || undefined, { groupName: target.group || undefined }); }
              catch (err) { console.error(err); }
            }
          }}>命令行</div>
          {(() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            // 仅本地 shell 类型显示模型区：后端 ssh/docker/k8s 分支会丢弃引用；
            // Claude / Codex 引用命令会整体替换 startup_commands。
            if (!target || !isModelRefLocalType(target.terminalType)) return null;
            return modelMenuSections(commandModelSources(target.startupCommands), (source, providerId, modelId) => {
              if (source === 'claude') startProfileWithModel(target, providerId, modelId);
              else startProfileWithCodexModel(target, providerId, modelId);
            });
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
                {supportsSystemExplorerOpen() && (
                  <div className="context-menu-item" onClick={async () => {
                    const t = profiles.find((p) => p.id === contextMenu.profileId);
                    closeContextMenu();
                    if (t) {
                      try { await openInExplorer(effectiveProfilePath(t, projects)); }
                      catch (err) { console.error(err); }
                    }
                  }}>打开目录</div>
                )}
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
          {!experimentalProjectTasks && profilePinMenuItem}
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
        <ProjectContextMenu
          x={groupContextMenu.x}
          y={groupContextMenu.y}
          groupName={groupContextMenu.group}
          onStartTerminal={onStartTerminal}
          onAddProfile={onAddProfile}
          onEditProject={editProject}
          onDeleteProject={setConfirmDeleteProject}
          onClose={closeContextMenu}
        />
      )}

      {blankContextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: blankContextMenu.x, top: blankContextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => { onAddProfile(projects[0]?.name); closeContextMenu(); }}>
            添加配置
          </div>
          <div className="context-menu-item" onClick={() => editProject()}>添加项目</div>
          {experimentalProjectTasks && (
            <>
              <div className="context-menu-separator" />
              {onStartBlankTerminal && (
                <>
                  <div className="context-menu-item" onClick={() => { onStartBlankTerminal(defaultShellType()); closeContextMenu(); }}>
                    {serverUsesWindowsPaths() ? 'PowerShell' : 'Bash'}
                  </div>
                  <div className="context-menu-item" onClick={() => { onStartBlankTerminal(serverUsesWindowsPaths() ? 'cmd' : 'sh'); closeContextMenu(); }}>
                    {serverUsesWindowsPaths() ? 'CMD' : 'Shell'}
                  </div>
                </>
              )}
              {onStartTextEditor && (
                <div className="context-menu-item" onClick={() => { onStartTextEditor(); closeContextMenu(); }}>
                  文本编辑器
                </div>
              )}
              <ConfiguredTerminalMenuItem
                submenuTree={treeItems}
                expandedGroups={submenuExpandedGroups}
                onToggleGroup={id => {
                  setSubmenuExpandedGroups(prev => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }}
                menuRef={contextMenuRef}
                submenuRef={newTerminalSubmenuRef}
                onStartTerminal={(profile, extraParams, tabName, extraParamMode) => {
                  useAppStore.getState().setLastClickRegion('tab');
                  onStartTerminal(profile, extraParams, tabName, extraParamMode);
                }}
                onClose={closeContextMenu}
              />
              {openSessionCount > 0 && (
                <>
                  <div className="context-menu-separator" />
                  <div className="context-menu-item danger" onClick={() => {
                    closeContextMenu();
                    handleCloseAllTabs();
                  }}>
                    关闭所有会话
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {editingProject !== null && (
        <ProjectEditDialog targetName={editingProject || undefined} onClose={() => setEditingProject(null)} />
      )}
      {confirmDeleteProject && (
        <ProjectDeleteDialog projectName={confirmDeleteProject} onClose={() => setConfirmDeleteProject(null)} />
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
      {sessionConfirmDialog && (
        <ConfirmDialog
          title={sessionConfirmDialog.title}
          message={sessionConfirmDialog.message}
          onClose={() => setSessionConfirmDialog(null)}
          onConfirm={sessionConfirmDialog.onConfirm}
        />
      )}
      {draftCloseDialog && (
        <Dialog
          title="草稿有未保存的内容"
          role="alertdialog"
          className="tb-confirm-dialog"
          onClose={() => setDraftCloseDialog(null)}
          footer={(
            <>
              <button className="btn-secondary" onClick={() => setDraftCloseDialog(null)}>取消</button>
              <button className="btn-danger" onClick={handleDraftDiscard}>不保存</button>
              <button className="btn-primary" onClick={handleDraftSaveAs}>另存为...</button>
            </>
          )}
        >
          <div className="tb-confirm-message">是否保存此草稿？</div>
        </Dialog>
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
