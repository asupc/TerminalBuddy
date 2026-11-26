import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarClock, ChevronRight, FileText, Folder, FolderOpen, SlidersHorizontal, X } from 'lucide-react';
import { isDockerClient } from '../../services/platform';
import { readClientData, writeClientData } from '../../services/tauri';
import { sessionReplayTabKey, useAppStore, type NativeAgentTab } from '../../stores/appStore';
import { useTaskSummaryStore } from '../../stores/taskSummaryStore';
import type { ExtraParamMode, Profile, TerminalSession } from '../../types';
import { getIndicatorClassName, getIndicatorColor, getIndicatorTitle, getNativeAgentLight, getIndicatorLight } from '../../utils/claudeIndicator';
import { formatDuration } from '../../utils/formatDuration';
import {
  buildProjectTasksTree,
  PINNED_GROUP_ID,
  type ProjectTasksGroup,
  type SessionLeaf,
} from '../../utils/projectTasksTree';
import { getTaskLaunchInfo } from '../../utils/taskLaunchInfo';
import { AgentIcon } from '../agent-chat/AgentIcon';
import { AgentTabContextMenu } from '../shell/AgentTabContextMenu';
import { SessionTaskLabel } from '../shell/SessionTaskLabel';
import { TabContextMenu } from '../shell/TabContextMenu';
import '../file-explorer/TreeView.css';
import { onPageVisible } from '../../utils/visibility';
import '../shell/TabNav.css';

const TYPE_ICONS: Record<string, string> = {
  powershell: 'PS', pwsh: 'PS7', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S', mstsc: 'RDP',
};

type TaskSection = 'projects' | 'recent' | 'pinned';

interface ProjectTasksViewState {
  expandedIds: string[];
  collapsedConfigIds: string[];
  toolsCollapsed: boolean;
  projectsCollapsed: boolean;
  recentCollapsed: boolean;
  relayCollapsed: boolean;
  replayCollapsed: boolean;
}

interface ProjectTasksViewProps {
  isActive: boolean;
  startupRestoreComplete: boolean;
  searchQuery: string;
  selectedProfileId: string | null;
  renamingProfileId: string | null;
  renamingProfileName: string;
  onRenamingProfileChange: (value: string) => void;
  onRenamingProfileSubmit: () => void;
  onRenamingProfileCancel: () => void;
  onStartTerminal: (profile: Profile, extraParams?: string, tabName?: string, extraParamMode?: ExtraParamMode) => void;
  onProfileContextMenu: (e: React.MouseEvent, profileId: string) => void;
  onGroupContextMenu: (e: React.MouseEvent, groupId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onCloseGroup: (groupName: string, groupSessions: TerminalSession[], groupAgentKeys: string[]) => void;
  onCloseExternalMenus: () => void;
}

function sessionLeafKey(leaf: SessionLeaf): string {
  switch (leaf.kind) {
    case 'terminal':
      return `t:${leaf.session.id}`;
    case 'agent':
      return `a:${leaf.tab.key}`;
    case 'git-changes':
      return `gc:${leaf.tab.repoRoot}`;
    case 'git-history':
      return `gh:${leaf.tab.repoRoot}`;
  }
}

/**
 * 「项目与任务」统一树视图（实验性）：
 * 在同一棵树中按项目归类展示已打开的会话（保留完整呼吸灯与 Agent Logo）与项目「配置」子分组。
 */
export const ProjectTasksView: FC<ProjectTasksViewProps> = ({
  isActive,
  startupRestoreComplete,
  searchQuery,
  selectedProfileId,
  renamingProfileId,
  renamingProfileName,
  onRenamingProfileChange,
  onRenamingProfileSubmit,
  onRenamingProfileCancel,
  onStartTerminal,
  onProfileContextMenu,
  onGroupContextMenu,
  onCloseSession,
  onCloseGroup,
  onCloseExternalMenus,
}) => {
  const profiles = useAppStore(s => s.profiles);
  const projects = useAppStore(s => s.projects);
  const sessions = useAppStore(s => s.sessions);
  const tabGroups = useAppStore(s => s.groups);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const gitHistoryTab = useAppStore(s => s.gitHistoryTab);
  const gitChangesTab = useAppStore(s => s.gitChangesTab);
  const claudeReplayTab = useAppStore(s => s.claudeReplayTab);
  const claudeReplayTabs = useAppStore(s => s.claudeReplayTabs);
  const openClaudeReplayTab = useAppStore(s => s.openClaudeReplayTab);
  const closeClaudeReplayTab = useAppStore(s => s.closeClaudeReplayTab);
  const activeSpecialTab = useAppStore(s => s.activeSpecialTab);
  const scheduledTasksTabOpen = useAppStore(s => s.scheduledTasksTabOpen);
  const openScheduledTasksPage = useAppStore(s => s.openScheduledTasksPage);
  const closeScheduledTasksPage = useAppStore(s => s.closeScheduledTasksPage);
  const agentTabs = useAppStore(s => s.agentTabs);
  const activeAgentTabKey = useAppStore(s => s.activeAgentTabKey);
  const setActiveAgentTab = useAppStore(s => s.setActiveAgentTab);
  const closeAgentTab = useAppStore(s => s.closeAgentTab);
  const renameSession = useAppStore(s => s.renameSession);
  const removeSessions = useAppStore(s => s.removeSessions);
  const selectProfile = useAppStore(s => s.selectProfile);
  const setDragProfileId = useAppStore(s => s.setDragProfileId);
  const terminalActivities = useAppStore(s => s.terminalActivities);
  const terminalWebTakeovers = useAppStore(s => s.terminalWebTakeovers);
  const lastClickRegion = useAppStore(s => s.lastClickRegion);
  // 订阅 settingsVersion 以便指示灯自定义配色更改后立即重绘。
  useAppStore(s => s.settingsVersion);
  const taskSummaries = useTaskSummaryStore(s => s.summaries);
  const taskProviders = useTaskSummaryStore(s => s.providers);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set([
    PINNED_GROUP_ID,
    ...(isDockerClient() ? ['服务器工作区'] : []),
  ]));
  const [collapsedConfigIds, setCollapsedConfigIds] = useState<Set<string>>(() => new Set());
  const [viewStateLoaded, setViewStateLoaded] = useState(false);
  const [toolsCollapsed, setToolsCollapsed] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [recentCollapsed, setRecentCollapsed] = useState(true);
  const [selectionSection, setSelectionSection] = useState<TaskSection>('projects');
  const [relayCollapsed, setRelayCollapsed] = useState(false);
  const [replayCollapsed, setReplayCollapsed] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [agentTabMenu, setAgentTabMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBaseline, setRenameBaseline] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const prevSessionKeysRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readClientData('project_tasks_view').then(raw => {
      if (cancelled || !raw) return;
      const saved: Partial<ProjectTasksViewState> | null = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      if (Array.isArray(saved.expandedIds)) {
        setExpandedIds(new Set(saved.expandedIds.filter(id => typeof id === 'string')));
      }
      if (Array.isArray(saved.collapsedConfigIds)) {
        setCollapsedConfigIds(new Set(saved.collapsedConfigIds.filter(id => typeof id === 'string')));
      }
      if (typeof saved.toolsCollapsed === 'boolean') setToolsCollapsed(saved.toolsCollapsed);
      if (typeof saved.projectsCollapsed === 'boolean') setProjectsCollapsed(saved.projectsCollapsed);
      if (typeof saved.recentCollapsed === 'boolean') setRecentCollapsed(saved.recentCollapsed);
      if (typeof saved.relayCollapsed === 'boolean') setRelayCollapsed(saved.relayCollapsed);
      if (typeof saved.replayCollapsed === 'boolean') setReplayCollapsed(saved.replayCollapsed);
    }).catch(error => {
      console.error('读取项目与任务展开状态失败：', error);
    }).finally(() => {
      if (!cancelled) setViewStateLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!viewStateLoaded) return;
    const state: ProjectTasksViewState = {
      expandedIds: [...expandedIds],
      collapsedConfigIds: [...collapsedConfigIds],
      toolsCollapsed,
      projectsCollapsed,
      recentCollapsed,
      relayCollapsed,
      replayCollapsed,
    };
    void writeClientData('project_tasks_view', JSON.stringify(state)).catch(error => {
      console.error('保存项目与任务展开状态失败：', error);
    });
  }, [viewStateLoaded, expandedIds, collapsedConfigIds, toolsCollapsed, projectsCollapsed, recentCollapsed, relayCollapsed, replayCollapsed]);

  // 终端运行时长后缀每 60s 刷新一次（页面隐藏时暂停）
  const [, setUptimeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) setUptimeTick(t => t + 1);
    }, 60_000);
    const unlistenVisible = onPageVisible(() => setUptimeTick(t => t + 1));
    return () => {
      clearInterval(id);
      unlistenVisible();
    };
  }, []);

  const model = useMemo(() => buildProjectTasksTree({
    projects,
    profiles,
    sessions,
    agentTabs,
    tabGroups,
    gitChangesTab,
    gitHistoryTab,
    taskSummaries,
    searchQuery,
  }), [projects, profiles, sessions, agentTabs, tabGroups, gitChangesTab, gitHistoryTab, taskSummaries, searchQuery]);

  // 启动恢复的旧会话只建立快照，之后新打开的会话才自动展开所属项目。
  const fullModel = useMemo(() => (
    searchQuery.trim()
      ? buildProjectTasksTree({
        projects,
        profiles,
        sessions,
        agentTabs,
        tabGroups,
        gitChangesTab,
        gitHistoryTab,
        taskSummaries,
        searchQuery: '',
      })
      : model
  ), [searchQuery, model, projects, profiles, sessions, agentTabs, tabGroups, gitChangesTab, gitHistoryTab, taskSummaries]);

  useEffect(() => {
    if (!viewStateLoaded || !startupRestoreComplete) {
      prevSessionKeysRef.current = null;
      return;
    }
    const currentKeys = new Set<string>();
    const newlyActiveGroups = new Set<string>();

    for (const group of fullModel.groups) {
      for (const leaf of group.sessions) {
        const key = `${group.id}\0${sessionLeafKey(leaf)}`;
        currentKeys.add(key);
        if (prevSessionKeysRef.current && !prevSessionKeysRef.current.has(key)) {
          newlyActiveGroups.add(group.id);
        }
      }
    }

    prevSessionKeysRef.current = currentKeys;

    if (newlyActiveGroups.size > 0) {
      setExpandedIds(prev => {
        let changed = false;
        const next = new Set(prev);
        for (const id of newlyActiveGroups) {
          if (!next.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [fullModel, viewStateLoaded, startupRestoreComplete]);

  // F2 快速重命名会话（仅在焦点位于会话区域时响应；配置与项目 F2 由 ConfigNav 处理）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      if (!isActive) return;
      const region = useAppStore.getState().lastClickRegion;
      if (region && region !== 'tab') return;
      if (!activeSessionId) return;
      const session = sessions.find(s => s.id === activeSessionId);
      if (session && session.sessionType !== 'editor') {
        const displayed = session.manualTitle
          ? session.profileName
          : (useTaskSummaryStore.getState().summaries[session.id]?.summary?.trim() || session.profileName);
        setRenameValue(displayed);
        setRenameBaseline(displayed);
        setRenamingSessionId(activeSessionId);
        setTimeout(() => renameInputRef.current?.select(), 0);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isActive, activeSessionId, sessions]);

  useEffect(() => {
    if (renamingSessionId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingSessionId]);

  useEffect(() => {
    if (!tabContextMenu) return;
    const handler = () => setTabContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [tabContextMenu]);

  if (!viewStateLoaded) return null;

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleConfigExpand = (id: string) => {
    setCollapsedConfigIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRenameSubmit = (sessionId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== renameBaseline) renameSession(sessionId, trimmed);
    setRenamingSessionId(null);
  };

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const isSearching = trimmedQuery.length > 0;
  const isNodeExpanded = (id: string, forceWhenSearching = false) =>
    (isSearching && forceWhenSearching) || expandedIds.has(id);

  const relayAgentTabs = agentTabs.filter(tab => tab.shape === 'relay');
  const hasTopSpecialSections = scheduledTasksTabOpen || relayAgentTabs.length > 0 || claudeReplayTabs.length > 0;
  const hasMainSections =
    model.pinnedProfiles.length > 0 || model.pinnedSessions.length > 0 || model.groups.length > 0;

  const activateTerminalSession = (sessionId: string) => {
    const store = useAppStore.getState();
    store.setLastClickRegion('tab');
    store.selectProfile(null);
    if (store.splitMode !== 'off') {
      if (!store.splitSlots.some(slot => slot.sessionId === sessionId)) {
        store.placeSessionInSplitSlot(sessionId);
      } else {
        store.setActiveSession(sessionId);
      }
    } else {
      store.setActiveSession(sessionId);
    }
  };

  const renderProfileLeaf = (profile: Profile, paddingLeft: number, section: TaskSection = 'projects') => {
    const isSelected = selectionSection === section && lastClickRegion === 'config' && selectedProfileId === profile.id;
    const isRenaming = renamingProfileId === profile.id && selectionSection === section;
    return (
      <div
        key={profile.id}
        className={`tree-item project-tasks-profile-item${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: `${paddingLeft}px` }}
        draggable={!isRenaming}
        onDragStart={(e) => {
          setDragProfileId(profile.id);
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData('text/plain', profile.id);
        }}
        onDragEnd={() => setDragProfileId(null)}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          useAppStore.getState().setLastClickRegion('config');
          selectProfile(profile.id);
        }}
        onClick={() => {
          useAppStore.getState().setLastClickRegion('config');
          selectProfile(profile.id);
        }}
        onDoubleClick={() => {
          if (isRenaming) return;
          onStartTerminal(profile);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setTabContextMenu(null);
          setAgentTabMenu(null);
          setSelectionSection(section);
          useAppStore.getState().setLastClickRegion('config');
          selectProfile(profile.id);
          onProfileContextMenu(e, profile.id);
        }}
      >
        <span className="tree-icon">
          <span className="config-nav-icon-type">
            {TYPE_ICONS[profile.terminalType] || profile.terminalType.toUpperCase()}
          </span>
        </span>
        {isRenaming ? (
          <input
            className="tree-rename-input"
            value={renamingProfileName}
            onChange={(e) => onRenamingProfileChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') onRenamingProfileSubmit();
              if (e.key === 'Escape') onRenamingProfileCancel();
            }}
            onBlur={onRenamingProfileSubmit}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span className="tree-name" style={profile.tabColor ? { color: profile.tabColor } : undefined}>
            {profile.name}
          </span>
        )}
      </div>
    );
  };

  const renderTerminalSessionLeaf = (session: TerminalSession, paddingLeft: number, section: TaskSection = 'projects') => {
    const inRecent = section === 'recent';
    const active = selectionSection === section && lastClickRegion !== 'config'
      && activeSpecialTab === null && activeSessionId === session.id;
    const isEditor = session.sessionType === 'editor';
    if (isEditor) {
      return (
        <div
          key={session.id}
          className={`tree-item tab-nav-item${active ? ' active' : ''}`}
          style={{ paddingLeft: `${paddingLeft}px` }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            const store = useAppStore.getState();
            store.setLastClickRegion('tab');
            store.selectProfile(null);
          }}
          onClick={() => activateTerminalSession(session.id)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onCloseSession(session.id);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCloseExternalMenus();
            setAgentTabMenu(null);
            setTabContextMenu({ x: e.clientX, y: e.clientY, sessionId: session.id });
          }}
        >
          <span className="tab-nav-file-icon">
            {session.isDirty && <span className="tab-nav-dirty-dot" />}
            <FileText aria-hidden="true" />
          </span>
          <span className="tree-name" title={session.profileName} style={session.tabColor ? { color: session.tabColor } : undefined}>
            {session.profileName}
          </span>
          <span className="tree-item-end">
            <button
              type="button"
              className="tree-item-close"
              onClick={(e) => { e.stopPropagation(); onCloseSession(session.id); }}
              title="关闭"
            >
              <X aria-hidden="true" />
            </button>
          </span>
        </div>
      );
    }

    const light = getIndicatorLight(terminalActivities[session.id]);
    const activityProvider = terminalActivities[session.id]?.provider;
    const ledDot = (
      <span
        className={`tab-nav-dot${getIndicatorClassName(light)}`}
        style={{ background: getIndicatorColor(light, session.tabColor) }}
        title={getIndicatorTitle(light, activityProvider) || undefined}
        onClick={(e) => {
          if (light !== 'failed' && light !== 'attention') return;
          e.stopPropagation();
          const store = useAppStore.getState();
          if (light === 'failed') {
            store.clearClaudeFailure(session.id);
          } else {
            store.setActiveSession(session.id);
          }
        }}
      />
    );

    const task = taskSummaries[session.id];
    const profile = profiles.find(p => p.id === session.profileId);
    const launchInfo = getTaskLaunchInfo(session.extraParams, profile?.startupCommands, session.extraParamMode);
    const provider = task?.provider ?? taskProviders[session.id] ?? launchInfo?.provider;
    const fallbackName = session.profileName;

    if (renamingSessionId === session.id && selectionSection === section) {
      return (
        <div key={session.id} className="tree-item" style={{ paddingLeft: `${paddingLeft}px` }}>
          {inRecent ? <span className="project-tasks-session-icons">{ledDot}</span> : ledDot}
          <input
            ref={renameInputRef}
            className="tree-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => handleRenameSubmit(session.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameSubmit(session.id);
              else if (e.key === 'Escape') setRenamingSessionId(null);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      );
    }

    return (
      <div
        key={session.id}
        className={`tree-item tab-nav-item${active ? ' active' : ''}`}
        style={{ paddingLeft: `${paddingLeft}px` }}
        title={provider && session.createdAt ? `${session.profileName} · 运行 ${formatDuration(Date.now() - session.createdAt)}` : undefined}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const store = useAppStore.getState();
          store.setLastClickRegion('tab');
          store.selectProfile(null);
        }}
        onClick={() => activateTerminalSession(session.id)}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onCloseSession(session.id);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onCloseExternalMenus();
          setAgentTabMenu(null);
          setTabContextMenu({ x: e.clientX, y: e.clientY, sessionId: session.id });
        }}
      >
        {inRecent ? (
          <span className="project-tasks-session-icons">
            {ledDot}
            {provider && <AgentIcon provider={provider} className="tab-nav-agent-icon" />}
          </span>
        ) : ledDot}
        {provider ? (
          <SessionTaskLabel
            task={task}
            fallbackName={fallbackName}
            fallbackProvider={provider}
            color={session.tabColor}
            manualTitle={session.manualTitle}
            showProviderIcon={!inRecent}
          />
        ) : (
          <span className="tree-name" title={session.profileName} style={session.tabColor ? { color: session.tabColor } : undefined}>
            {session.profileName}
            {session.createdAt && (
              <span className="tab-nav-uptime"> · {formatDuration(Date.now() - session.createdAt)}</span>
            )}
          </span>
        )}
        {session.owner === 'web' && !isDockerClient() && <span className="tab-nav-owner-badge">Web</span>}
        {session.owner !== 'web' && terminalWebTakeovers[session.id] && (
          <span className="tab-nav-takeover-badge" title="当前终端正在被 Web 端接管">接管中</span>
        )}
        <span className="tree-item-end">
          <button
            type="button"
            className="tree-item-close"
            onClick={(e) => { e.stopPropagation(); onCloseSession(session.id); }}
            title="关闭"
          >
            <X aria-hidden="true" />
          </button>
        </span>
      </div>
    );
  };

  const renderNativeAgentLeaf = (tab: NativeAgentTab, paddingLeft: number, section: TaskSection = 'projects') => {
    const light = getNativeAgentLight(tab.status);
    const active = selectionSection === section && lastClickRegion !== 'config'
      && activeSpecialTab === 'agent-chat' && activeAgentTabKey === tab.key;
    return (
      <div
        key={tab.key}
        className={`tree-item tab-nav-item${active ? ' active' : ''}`}
        style={{ paddingLeft: `${paddingLeft}px` }}
        title={`${tab.provider === 'codex' ? 'Codex' : tab.provider === 'antigravity' ? 'Antigravity' : 'Claude Code'} · ${tab.title}`}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const store = useAppStore.getState();
          store.setLastClickRegion('tab');
          store.selectProfile(null);
        }}
        onClick={() => {
          const store = useAppStore.getState();
          store.setLastClickRegion('tab');
          store.selectProfile(null);
          store.setActiveAgentTab(tab.key);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onCloseExternalMenus();
          setTabContextMenu(null);
          setAgentTabMenu({ x: e.clientX, y: e.clientY, key: tab.key });
        }}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            closeAgentTab(tab.key);
          }
        }}
      >
        <span className="project-tasks-session-icons">
          <span
            className={`tab-nav-dot${getIndicatorClassName(light)}`}
            style={{ background: getIndicatorColor(light) }}
            title={getIndicatorTitle(light, tab.provider) || undefined}
            onClick={(e) => {
              if (light === 'failed') {
                e.stopPropagation();
                useAppStore.getState().updateAgentTab(tab.key, { status: 'idle' });
              } else if (light === 'attention') {
                e.stopPropagation();
                useAppStore.getState().setActiveAgentTab(tab.key);
              }
            }}
          />
          <AgentIcon provider={tab.provider} className="tab-nav-agent-icon" />
        </span>
        <span className="tree-name" title={tab.title}>{tab.title}</span>
        <span className="tree-item-end">
          <button
            type="button"
            className="tree-item-close"
            onClick={(e) => { e.stopPropagation(); closeAgentTab(tab.key); }}
            title="关闭"
          >
            <X aria-hidden="true" />
          </button>
        </span>
      </div>
    );
  };

  const renderSessionLeaf = (leaf: SessionLeaf, paddingLeft: number, section: TaskSection = 'projects') => {
    switch (leaf.kind) {
      case 'terminal':
        return renderTerminalSessionLeaf(leaf.session, paddingLeft, section);
      case 'agent':
        return renderNativeAgentLeaf(leaf.tab, paddingLeft, section);
      case 'git-changes':
        return (
          <div
            key="__git_changes__"
            className={`tree-item tab-nav-item${selectionSection === section && lastClickRegion !== 'config' && activeSpecialTab === 'git-changes' ? ' active' : ''}`}
            style={{ paddingLeft: `${paddingLeft}px` }}
            title={`${leaf.tab.repoRoot} - 未提交变更`}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const store = useAppStore.getState();
              store.setLastClickRegion('tab');
              store.selectProfile(null);
            }}
            onClick={() => {
              const store = useAppStore.getState();
              store.setLastClickRegion('tab');
              store.selectProfile(null);
              if (store.gitChangesTab) store.openGitChangesTab(store.gitChangesTab);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                useAppStore.getState().closeGitChangesTab();
              }
            }}
          >
            <span className="tab-nav-dot" style={{ background: '#55b988' }} />
            <span className="tree-name">未提交变更</span>
            <span className="tree-item-end">
              <button
                type="button"
                className="tree-item-close"
                onClick={(e) => { e.stopPropagation(); useAppStore.getState().closeGitChangesTab(); }}
                title="关闭"
              >
                <X aria-hidden="true" />
              </button>
            </span>
          </div>
        );
      case 'git-history':
        return (
          <div
            key="__git_history__"
            className={`tree-item tab-nav-item${selectionSection === section && lastClickRegion !== 'config' && activeSpecialTab === 'git-history' ? ' active' : ''}`}
            style={{ paddingLeft: `${paddingLeft}px` }}
            title={`${leaf.tab.repoRoot} - Git 历史记录`}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const store = useAppStore.getState();
              store.setLastClickRegion('tab');
              store.selectProfile(null);
            }}
            onClick={() => {
              const store = useAppStore.getState();
              store.setLastClickRegion('tab');
              store.selectProfile(null);
              if (store.gitHistoryTab) store.openGitHistoryTab(store.gitHistoryTab);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                useAppStore.getState().closeGitHistoryTab();
              }
            }}
          >
            <span className="tab-nav-dot" style={{ background: '#e6a23c' }} />
            <span className="tree-name">Git 历史记录</span>
            <span className="tree-item-end">
              <button
                type="button"
                className="tree-item-close"
                onClick={(e) => { e.stopPropagation(); useAppStore.getState().closeGitHistoryTab(); }}
                title="关闭"
              >
                <X aria-hidden="true" />
              </button>
            </span>
          </div>
        );
    }
  };

  const renderProjectGroup = (group: ProjectTasksGroup) => {
    const hasChildren = group.profiles.length > 0 || group.sessions.length > 0;
    const isExpanded = isNodeExpanded(group.id, hasChildren);
    const isSelected = selectionSection === 'projects' && lastClickRegion === 'config' && selectedProfileId === group.id;

    const groupTerminalSessions = group.sessions
      .filter((leaf): leaf is { kind: 'terminal'; session: TerminalSession } => leaf.kind === 'terminal')
      .map(leaf => leaf.session);
    const groupAgentKeys = group.sessions
      .filter((leaf): leaf is { kind: 'agent'; tab: NativeAgentTab } => leaf.kind === 'agent')
      .map(leaf => leaf.tab.key);
    const closableCount = groupTerminalSessions.length + groupAgentKeys.length;
    const sessionCount = group.sessions.length;

    const hasMatchedProfilesInSearch = isSearching && group.profiles.some(
      p => p.name.toLowerCase().includes(trimmedQuery),
    );
    const isConfigExpanded = hasMatchedProfilesInSearch || !collapsedConfigIds.has(group.configGroupId);

    return (
      <div key={group.id} className="tree-node project-tasks-project">
        <div
          className={`tree-item tree-group-item project-tasks-project-header${isSelected ? ' selected' : ''}`}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            useAppStore.getState().setLastClickRegion('config');
            selectProfile(group.id);
          }}
          onClick={() => {
            useAppStore.getState().setLastClickRegion('config');
            selectProfile(group.id);
            toggleExpand(group.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setTabContextMenu(null);
            setAgentTabMenu(null);
            onGroupContextMenu(e, group.id);
          }}
        >
          <span
            className={`tree-arrow${isExpanded ? ' expanded' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggleExpand(group.id); }}
          >
            <ChevronRight aria-hidden="true" />
          </span>
          <span className="tree-group-icon">
            {isExpanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
          </span>
          <span className="tree-group-name">{group.label}</span>
          {sessionCount > 0 && (
            <span className="tree-item-end">
              <span className="tree-item-count">{sessionCount}</span>
              {closableCount > 0 && (
                <button
                  type="button"
                  className="tree-item-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseGroup(group.id, groupTerminalSessions, groupAgentKeys);
                  }}
                  title="关闭项目内所有会话"
                >
                  <X aria-hidden="true" />
                </button>
              )}
            </span>
          )}
        </div>

        {hasChildren && (
          <div
            className={`project-tasks-collapse${isExpanded ? ' expanded' : ''}`}
            aria-hidden={!isExpanded}
            inert={!isExpanded}
          >
            <div className="project-tasks-collapse-content">
              <div className="tree-children project-tasks-project-children">
                {group.profiles.length > 0 && (
                  <div className="tree-node">
                    <div
                      className="tree-item project-tasks-config-group"
                      onClick={() => toggleConfigExpand(group.configGroupId)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setTabContextMenu(null);
                        setAgentTabMenu(null);
                        onGroupContextMenu(e, group.id);
                      }}
                    >
                      <span
                        className={`tree-arrow${isConfigExpanded ? ' expanded' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleConfigExpand(group.configGroupId); }}
                      >
                        <ChevronRight aria-hidden="true" />
                      </span>
                      <span className="project-tasks-config-icon">
                        <SlidersHorizontal aria-hidden="true" />
                      </span>
                      <span className="tree-name project-tasks-config-name">配置</span>
                      <span className="project-tasks-config-count">{group.profiles.length}</span>
                    </div>
                    {isConfigExpanded && (
                      <div className="tree-children project-tasks-config-children">
                        {group.profiles.map(profile => renderProfileLeaf(profile, 9))}
                      </div>
                    )}
                  </div>
                )}
                {group.sessions.map(leaf => renderSessionLeaf(leaf, 9))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="project-tasks-tree" onMouseDownCapture={(event) => {
      if (event.button !== 0) return;
      const section = (event.target as HTMLElement).closest<HTMLElement>('[data-task-section]')?.dataset.taskSection as TaskSection | undefined;
      if (section) setSelectionSection(section);
    }}>
      {scheduledTasksTabOpen && (
        <div className="tab-nav-group">
          <div
            className="tab-nav-group-header"
            onClick={() => setToolsCollapsed(v => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setToolsCollapsed(v => !v);
              }
            }}
          >
            <span className={`tab-nav-group-arrow${toolsCollapsed ? ' collapsed' : ''}`}>▾</span>
            <span className="tab-nav-group-name">工具</span>
          </div>
          {!toolsCollapsed && (
            <div
              className={`tab-nav-settings-btn tab-nav-replay-item${lastClickRegion !== 'config' && activeSpecialTab === 'scheduled-tasks' ? ' active' : ''}`}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                useAppStore.getState().setLastClickRegion('tab');
              }}
              onClick={openScheduledTasksPage}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeScheduledTasksPage();
                }
              }}
              title="定时任务 · 按计划启动项目环境或执行 Agent 任务"
            >
              <CalendarClock aria-hidden="true" style={{ width: 12, height: 12, flex: 'none' }} />
              <span className="tab-nav-name">定时任务</span>
              <button
                type="button"
                className="tree-item-close"
                onClick={event => { event.stopPropagation(); closeScheduledTasksPage(); }}
                title="关闭"
                aria-label="关闭定时任务"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}

      {relayAgentTabs.length > 0 && (
        <div className="tab-nav-group">
          <div
            className="tab-nav-group-header"
            onClick={() => setRelayCollapsed(v => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setRelayCollapsed(v => !v);
              }
            }}
          >
            <span className={`tab-nav-group-arrow${relayCollapsed ? ' collapsed' : ''}`}>▾</span>
            <span className="tab-nav-group-name">AI 会话</span>
            <span className="tab-nav-group-count">{relayAgentTabs.length}</span>
          </div>
          {!relayCollapsed && relayAgentTabs.map(tab => (
            <div
              key={tab.key}
              className={`tab-nav-settings-btn tab-nav-replay-item${lastClickRegion !== 'config' && activeSpecialTab === 'agent-chat' && activeAgentTabKey === tab.key ? ' active' : ''}`}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                useAppStore.getState().setLastClickRegion('tab');
              }}
              onClick={() => setActiveAgentTab(tab.key)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeAgentTab(tab.key);
                }
              }}
              title={`终端接力 · ${tab.title}`}
            >
              <span className="tab-nav-name">{tab.title}</span>
              <button
                type="button"
                className="tree-item-close"
                onClick={event => { event.stopPropagation(); closeAgentTab(tab.key); }}
                title="关闭"
                aria-label={`关闭 ${tab.title}`}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      {claudeReplayTabs.length > 0 && (
        <div className="tab-nav-group">
          <div
            className="tab-nav-group-header"
            onClick={() => setReplayCollapsed(v => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setReplayCollapsed(v => !v);
              }
            }}
          >
            <span className={`tab-nav-group-arrow${replayCollapsed ? ' collapsed' : ''}`}>▾</span>
            <span className="tab-nav-group-name">会话详情</span>
            <span className="tab-nav-group-count">{claudeReplayTabs.length}</span>
          </div>
          {!replayCollapsed && claudeReplayTabs.map(tab => (
            <div
              key={sessionReplayTabKey(tab)}
              className={`tab-nav-settings-btn tab-nav-replay-item${lastClickRegion !== 'config' && activeSpecialTab === 'claude-replay' && claudeReplayTab && sessionReplayTabKey(claudeReplayTab) === sessionReplayTabKey(tab) ? ' active' : ''}`}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                useAppStore.getState().setLastClickRegion('tab');
              }}
              onClick={() => openClaudeReplayTab(tab)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeClaudeReplayTab(tab.sessionId, tab.provider);
                }
              }}
              title={`${tab.provider === 'codex' ? 'Codex' : tab.provider === 'antigravity' ? 'Antigravity CLI' : 'Claude Code'} · ${tab.title}`}
            >
              <span className="tab-nav-name">{tab.title}</span>
              <button
                type="button"
                className="tree-item-close"
                onClick={event => { event.stopPropagation(); closeClaudeReplayTab(tab.sessionId, tab.provider); }}
                title="关闭"
                aria-label={`关闭 ${tab.title}`}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      {hasTopSpecialSections && hasMainSections && <div className="project-tasks-section-sep" />}

      {(model.pinnedProfiles.length > 0 || model.pinnedSessions.length > 0) && (() => {
        const pinnedExpanded = isNodeExpanded(PINNED_GROUP_ID, true);
        return (
          <div className="tree-node project-tasks-section" data-task-section="pinned">
            <div
              className="tree-item tree-group-item project-tasks-pinned-header"
              style={{ paddingLeft: '8px' }}
              onClick={() => toggleExpand(PINNED_GROUP_ID)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <span
                className={`tree-arrow${pinnedExpanded ? ' expanded' : ''}`}
                onClick={(e) => { e.stopPropagation(); toggleExpand(PINNED_GROUP_ID); }}
              >
                <ChevronRight aria-hidden="true" />
              </span>
              <span className="tree-group-icon">
                {pinnedExpanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
              </span>
              <span className="tree-group-name">置顶</span>
            </div>
            <div
              className={`project-tasks-collapse${pinnedExpanded ? ' expanded' : ''}`}
              aria-hidden={!pinnedExpanded}
              inert={!pinnedExpanded}
            >
              <div className="tree-children project-tasks-collapse-content">
                {model.pinnedProfiles.map(profile => renderProfileLeaf(profile, 22, 'pinned'))}
                {model.pinnedSessions.map(leaf => renderSessionLeaf(leaf, 22, 'pinned'))}
              </div>
            </div>
          </div>
        );
      })()}

      <section className="project-tasks-section" aria-label="项目">
        <button
          type="button"
          className="project-tasks-section-heading"
          aria-expanded={!projectsCollapsed}
          aria-controls="project-tasks-project-list"
          onClick={() => setProjectsCollapsed(value => !value)}
        >
          <span>项目</span>
          <ChevronRight className={`project-tasks-section-arrow${projectsCollapsed ? '' : ' expanded'}`} aria-hidden="true" />
          <span className="project-tasks-section-count">{model.groups.length}</span>
        </button>
        <div
          id="project-tasks-project-list"
          className={`project-tasks-collapse${projectsCollapsed ? '' : ' expanded'}`}
          data-task-section="projects"
          aria-hidden={projectsCollapsed}
          inert={projectsCollapsed}
        >
          <div className="project-tasks-collapse-content">
            {model.groups.map(renderProjectGroup)}
          </div>
        </div>
      </section>

      <section className="project-tasks-section project-tasks-recent-section" aria-label="最近会话">
        <button
          type="button"
          className="project-tasks-section-heading"
          aria-expanded={!recentCollapsed}
          aria-controls="project-tasks-recent-list"
          onClick={() => setRecentCollapsed(value => !value)}
        >
          <span>最近</span>
          <ChevronRight className={`project-tasks-section-arrow${recentCollapsed ? '' : ' expanded'}`} aria-hidden="true" />
          <span className="project-tasks-section-count">{model.recentItems.length}</span>
        </button>
        <div
          id="project-tasks-recent-list"
          className={`project-tasks-recent-list project-tasks-collapse${recentCollapsed ? '' : ' expanded'}`}
          data-task-section="recent"
          aria-hidden={recentCollapsed}
          inert={recentCollapsed}
        >
          <div className="project-tasks-collapse-content">
            {model.recentItems.map(item => {
              switch (item.kind) {
                case 'terminal': return renderTerminalSessionLeaf(item.session, 10, 'recent');
                case 'agent': return renderNativeAgentLeaf(item.tab, 10, 'recent');
              }
            })}
            {model.recentItems.length === 0 && !isSearching && (
              <div className="empty-state">暂无已打开的会话</div>
            )}
          </div>
        </div>
      </section>

      {isSearching && !hasMainSections && (
        <div className="empty-state">未找到匹配的项目、配置或会话</div>
      )}

      <div className="project-tasks-footer">
        <span>{fullModel.groups.length} 个项目</span>
        <span aria-hidden="true">·</span>
        <span>{fullModel.openSessionCount} 个已打开会话</span>
      </div>

      {tabContextMenu && createPortal(
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setTabContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setTabContextMenu(null); }}
          />
          <TabContextMenu
            x={tabContextMenu.x}
            y={tabContextMenu.y}
            sessionId={tabContextMenu.sessionId}
            sessions={sessions}
            profiles={profiles}
            onStartTerminal={onStartTerminal}
            onClose={() => setTabContextMenu(null)}
            onRename={(session) => {
              if (session) {
                const displayed = session.manualTitle
                  ? session.profileName
                  : (taskSummaries[session.id]?.summary?.trim() || session.profileName);
                setRenameValue(displayed);
                setRenameBaseline(displayed);
                setRenamingSessionId(session.id);
                setTimeout(() => renameInputRef.current?.select(), 0);
              }
            }}
            onCloseSession={onCloseSession}
            onTogglePin={(session) => {
              useAppStore.getState().updateSession(session.id, { pinned: !session.pinned });
              if (!session.pinned) {
                setSelectionSection('pinned');
                setExpandedIds(ids => new Set(ids).add(PINNED_GROUP_ID));
              }
            }}
            onCloseOthers={(sessionId) => {
              const editorSessions = sessions.filter(
                s => s.sessionType === 'editor' && s.id !== sessionId,
              );
              if (editorSessions.length > 0) {
                removeSessions(editorSessions.map(s => s.id));
              }
            }}
          />
        </>,
        document.body,
      )}

      {agentTabMenu && (() => {
        const tab = agentTabs.find(item => item.key === agentTabMenu.key && item.shape === 'native');
        if (!tab || tab.shape !== 'native') return null;
        return (
          <AgentTabContextMenu
            x={agentTabMenu.x}
            y={agentTabMenu.y}
            tab={tab}
            onTogglePin={() => {
              useAppStore.getState().updateAgentTab(tab.key, { pinned: !tab.pinned });
              if (!tab.pinned) {
                setSelectionSection('pinned');
                setExpandedIds(ids => new Set(ids).add(PINNED_GROUP_ID));
              }
            }}
            onClose={() => setAgentTabMenu(null)}
          />
        );
      })()}
    </div>
  );
};
