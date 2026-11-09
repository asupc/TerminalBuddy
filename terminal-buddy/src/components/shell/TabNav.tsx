import { useTaskSummaryStore } from '../../stores/taskSummaryStore';
import { defaultShellType, serverUsesWindowsPaths } from '../../services/platform';
import { FC, useState, useEffect, useMemo, useRef } from 'react';
import { FileText, X } from 'lucide-react';
import { isTerminalWorking, useAppStore, sessionReplayTabKey, type NativeAgentTab } from '../../stores/appStore';
import { closeTerminal as closeTerminalCmd, saveConfigNavWidth, saveTabSidebarWidth, getBackendAppSettings, writeFileContent, readFileContent } from '../../services/tauri';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { getIndicatorLight, getIndicatorClassName, getIndicatorColor, getIndicatorTitle } from '../../utils/claudeIndicator';
import { getTaskLaunchInfo } from '../../utils/taskLaunchInfo';
import { notifyTerminalPanelResize } from '../../utils/terminalResizeEvent';
import type { TreeItem } from '../file-explorer/TreeView';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import { buildGroupTree, type GroupNode } from '../../utils/groupTree';
import { projectForDirectory } from '../../utils/projectPath';
import type { ExtraParamMode, Profile, TerminalSession } from '../../types';
import { SessionTreeItem } from './SessionTreeItem';
import { TabContextMenu } from './TabContextMenu';
import { NewTerminalMenu } from './NewTerminalMenu';
import { AgentTabContextMenu } from './AgentTabContextMenu';
import { AgentIcon } from '../agent-chat/AgentIcon';
import './TabNav.css';

interface TabSidebarProps {
  isActive: boolean;
  isSidebarMode: boolean;
  profiles: Profile[];
  onStartTerminal: (profile: Profile, extraParams?: string, presetName?: string, tabName?: string, presetTag?: string, presetTagColor?: string | null, extraParamMode?: ExtraParamMode) => void;
  onStartBlankTerminal: (terminalType: 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh') => void;
  onStartTextEditor: () => void;
}

/**
 * 侧栏会话树的叶子：终端会话与原生 AI 会话标签共用同一套项目分组。
 * 原生会话按 `projectPath` 归到已登记项目下，与项目启动的终端同组。
 */
type SessionLeaf =
  | { kind: 'terminal'; session: TerminalSession }
  | { kind: 'agent'; tab: NativeAgentTab };

export const TabNav: FC<TabSidebarProps> = ({ isActive, isSidebarMode, profiles, onStartTerminal, onStartBlankTerminal, onStartTextEditor }) => {
  const sessions = useAppStore(s => s.sessions);
  const taskSummaries = useTaskSummaryStore(s => s.summaries);
  const projects = useAppStore(s => s.projects);
  const tabGroups = useAppStore(s => s.groups);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const gitHistoryTab = useAppStore(s => s.gitHistoryTab);
  const openGitHistoryTab = useAppStore(s => s.openGitHistoryTab);
  const closeGitHistoryTab = useAppStore(s => s.closeGitHistoryTab);
  const claudeReplayTab = useAppStore(s => s.claudeReplayTab);
  const claudeReplayTabs = useAppStore(s => s.claudeReplayTabs);
  const openClaudeReplayTab = useAppStore(s => s.openClaudeReplayTab);
  const closeClaudeReplayTab = useAppStore(s => s.closeClaudeReplayTab);
  const activeSpecialTab = useAppStore(s => s.activeSpecialTab);
  const agentTabs = useAppStore(s => s.agentTabs);
  const activeAgentTabKey = useAppStore(s => s.activeAgentTabKey);
  const setActiveAgentTab = useAppStore(s => s.setActiveAgentTab);
  const closeAgentTab = useAppStore(s => s.closeAgentTab);
  const removeSession = useAppStore(s => s.removeSession);
  const removeSessions = useAppStore(s => s.removeSessions);

  const renameSession = useAppStore(s => s.renameSession);
  const terminalActivities = useAppStore(s => s.terminalActivities);
  const settingsVersion = useAppStore(s => s.settingsVersion);
  const dragProfileId = useAppStore(s => s.dragProfileId);
  const setDragProfileId = useAppStore(s => s.setDragProfileId);
  const [dropActive, setDropActive] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const highlightedIndexRef = useRef(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  highlightedIndexRef.current = highlightedIndex;
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  // 原生会话叶子的右键菜单：数据源是聊天标签而非终端会话，单独保存一份。
  const [agentTabMenu, setAgentTabMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [draftCloseDialog, setDraftCloseDialog] = useState<{ sessionId: string; filePath: string } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // 打开重命名时的初始值：未改动就不落库，避免把摘要原样固化成名称
  const [renameBaseline, setRenameBaseline] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [submenuExpandedGroups, setSubmenuExpandedGroups] = useState<Set<string>>(new Set());
  // 终端运行时长后缀每 60s 刷新一次
  const [, setUptimeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setUptimeTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // F2 快速重命名标签
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      if (!isActive) return;
      // 仅在 region 是 'tab' 或尚未初始化（null）时响应；
      // 'config'/'history' 等其他面板会把 region 设成自己的值，从而屏蔽此处。
      const region = useAppStore.getState().lastClickRegion;
      if (region && region !== 'tab') return;
      if (!activeSessionId) return;
      const session = sessions.find(s => s.id === activeSessionId);
      if (session && session.sessionType !== 'editor') {
        // 编辑所见即所得：初始值取任务行当前显示的第一行标题（含摘要）
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

  // 跟踪上次点击区域
  useEffect(() => {
    const sidebar = containerRef.current;
    if (!sidebar) return;
    const handler = (e: MouseEvent) => {
      if (e.button !== 0) return;
      useAppStore.getState().setLastClickRegion('tab');
    };
    sidebar.addEventListener('mousedown', handler);
    return () => sidebar.removeEventListener('mousedown', handler);
  }, []);

  // F2 重命名时自动聚焦输入框
  useEffect(() => {
    if (renamingSessionId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingSessionId]);

  // Dismiss open dialogs when all sessions are closed
  useEffect(() => {
    if (sessions.length === 0) {
      setConfirmDialog(null);
      setDraftCloseDialog(null);
    }
  }, [sessions.length]);

  const { width, setWidth, isResizing, resizeHandleProps } = useResizablePanel({
    defaultWidth: isSidebarMode ? 250 : 200,
    minWidth: 150,
    maxWidth: 400,
    onResizeEnd: (w) => {
      const saveWidth = isSidebarMode ? saveConfigNavWidth : saveTabSidebarWidth;
      saveWidth(w).catch(console.error);
      notifyTerminalPanelResize();
      if (isSidebarMode) {
        window.dispatchEvent(new CustomEvent('navigation-width-changed', { detail: w }));
      }
    },
  });

  useEffect(() => {
    if (isResizing) notifyTerminalPanelResize();
  }, [isResizing, width]);

  useEffect(() => {
    getBackendAppSettings().then(s => setWidth(isSidebarMode ? s.configNavWidth || 250 : s.tabSidebarWidth || 200)).catch(() => {});
  }, [isSidebarMode, setWidth]);

  useEffect(() => {
    if (!isSidebarMode) return;
    const syncWidth = (event: Event) => {
      const width = (event as CustomEvent<number>).detail;
      if (Number.isFinite(width)) setWidth(width);
    };
    window.addEventListener('navigation-width-changed', syncWidth);
    return () => window.removeEventListener('navigation-width-changed', syncWidth);
  }, [isSidebarMode, setWidth]);

  // 会话显式标签分组优先；普通终端继续沿用 Profile 分组。
  // 原生会话标签与终端一样挂到所属项目分组下（终端接力标签仍单独放「AI 会话」组，
  // 因为它承载的终端本身已经在项目分组里，重复列出反而冗余）。
  const sessionTree = useMemo(() => {
    const editorSessions = sessions.filter(s => s.sessionType === 'editor');
    const terminalSessions = sessions.filter(s => s.sessionType !== 'editor');
    const nativeTabs = agentTabs.filter(tab => tab.shape === 'native');
    const leaves: SessionLeaf[] = [
      ...terminalSessions.map(session => ({ kind: 'terminal' as const, session })),
      ...nativeTabs.map(tab => ({ kind: 'agent' as const, tab })),
    ];

    const tree = buildGroupTree(leaves, leaf => {
      if (leaf.kind === 'agent') {
        // 原生会话记录的是项目目录；与终端一致，用已登记项目名作为分组。
        return projectForDirectory(projects, leaf.tab.projectPath)?.name || '默认';
      }
      const s = leaf.session;
      const explicitGroup = s.groupId && s.groupId !== 'default'
        ? tabGroups.find(group => group.id === s.groupId)
        : undefined;
      if (explicitGroup) return explicitGroup.name;
      if (s.groupName) return s.groupName;
      const profile = profiles.find(p => p.id === s.profileId);
      return profile?.group || '默认';
    });

    // Recursive helper: collect all terminal sessions under a node (including children)
    const collectAllSessions = (node: GroupNode<SessionLeaf>): typeof terminalSessions =>
      node.items.flatMap(item => item.kind === 'terminal' ? [item.session] : [])
        .concat(node.children.flatMap(collectAllSessions));

    // Convert GroupNode[] to TreeItem[] with recursive nesting
    const toTreeItems = (nodes: GroupNode<SessionLeaf>[]): TreeItem[] =>
      nodes.map(node => ({
        id: node.path,
        label: node.name,
        isGroup: true,
        data: { type: 'group' as const, allSessions: collectAllSessions(node) },
        children: [
          ...toTreeItems(node.children),
          ...node.items.map(leaf => {
            if (leaf.kind === 'agent') {
              const tab = leaf.tab;
              return {
                id: tab.key,
                label: tab.title,
                icon: <AgentIcon provider={tab.provider} className="tab-nav-agent-icon" />,
                data: { kind: 'agent' as const, tab },
              };
            }
            const session = leaf.session;
            const isEditor = session.sessionType === 'editor';
            const profile = profiles.find(profile => profile.id === session.profileId);
            const hasTaskLabel = !isEditor && Boolean(taskSummaries[session.id]
              || getTaskLaunchInfo(session.extraParams, profile?.startupCommands, session.extraParamMode));
            return {
              id: session.id,
              label: session.profileName,
              icon: (
                <>
                  {isEditor ? (
                    <span className="tab-nav-file-icon">
                      {session.isDirty && <span className="tab-nav-dirty-dot" />}
                      <FileText aria-hidden="true" />
                    </span>
                  ) : (
                    <>
                      {(() => {
                        const light = getIndicatorLight(terminalActivities[session.id]);
                        return (
                          <span
                            className={`tab-nav-dot${getIndicatorClassName(light)}`}
                            style={{ background: getIndicatorColor(light, session.tabColor) }}
                            title={getIndicatorTitle(light, terminalActivities[session.id]?.provider) || undefined}
                            onClick={(e) => {
                              if (light !== 'failed' && light !== 'attention') return;
                              e.stopPropagation();
                              if (light === 'failed') useAppStore.getState().clearClaudeFailure(session.id);
                            }}
                          />
                        );
                      })()}
                      {session.extraParamTag && !hasTaskLabel && (
                        <span
                          className="tab-nav-tag-chip"
                          style={session.extraParamTagColor ? { backgroundColor: session.extraParamTagColor } : undefined}
                          title="启动参数预设"
                        >
                          {session.extraParamTag}
                        </span>
                      )}
                    </>
                  )}
                </>
              ),
              data: session,
            };
          }),
        ],
      }));

    const items = toTreeItems(tree);

    // Editor sessions as a flat top-level group
    if (editorSessions.length > 0) {
      items.unshift({
        id: '文本编辑',
        label: '文本编辑',
        isGroup: true,
        children: editorSessions.map(session => ({
          id: session.id,
          label: session.profileName,
          icon: (
            <span className="tab-nav-file-icon">
              {session.isDirty && <span className="tab-nav-dirty-dot" />}
              <FileText aria-hidden="true" />
            </span>
          ),
          data: session,
        })),
      });
    }

    return items;
  }, [sessions, agentTabs, projects, profiles, tabGroups, terminalActivities, settingsVersion, taskSummaries]);

  // Mirror the project/profile grouping in the configuration navigation.
  const submenuTree = useMemo(() => {
    const profileItem = (profile: Profile): TreeItem => ({
      id: profile.id,
      label: profile.name,
      data: profile,
    });
    const normalProfiles = profiles.filter(profile => !profile.pinned);
    const items: TreeItem[] = projects.map(project => ({
      id: project.name,
      label: project.name,
      isGroup: true,
      children: normalProfiles.filter(profile => profile.group === project.name).map(profileItem),
    }));
    for (const group of new Set(normalProfiles.map(profile => profile.group || '默认'))) {
      if (!items.some(item => item.id === group)) {
        items.push({
          id: group,
          label: group,
          isGroup: true,
          children: normalProfiles.filter(profile => (profile.group || '默认') === group).map(profileItem),
        });
      }
    }
    // 与“项目与命令”面板保持一致：项目按名称自然排序，置顶分组仍在最前。
    items.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    const pinned = profiles.filter(profile => profile.pinned);
    if (pinned.length > 0) {
      items.unshift({ id: '__pinned__', label: '置顶', isGroup: true, children: pinned.map(profileItem) });
    }
    return items;
  }, [profiles, projects]);

  // Flatten expanded items for keyboard nav (recursive for nested groups)
  const visibleSubmenuItems = useMemo(() => {
    const result: TreeItem[] = [];
    result.push({ id: defaultShellType(), label: serverUsesWindowsPaths() ? 'PowerShell' : 'Bash', data: { terminalType: defaultShellType() } });
    result.push({ id: 'pwsh', label: 'PowerShell 7', data: { terminalType: 'pwsh' as const } });
    result.push({ id: 'cmd', label: serverUsesWindowsPaths() ? 'CMD' : 'Shell', data: { terminalType: serverUsesWindowsPaths() ? 'cmd' : 'sh' } });

    const flattenTree = (items: TreeItem[], expanded: Set<string>) => {
      for (const item of items) {
        result.push(item);
        if (expanded.has(item.id) && item.children) {
          flattenTree(item.children, expanded);
        }
      }
    };
    flattenTree(submenuTree, submenuExpandedGroups);

    return result;
  }, [submenuTree, submenuExpandedGroups]);

  // Refs for stable access in effect without causing re-registrations
  const visibleSubmenuItemsRef = useRef(visibleSubmenuItems);
  visibleSubmenuItemsRef.current = visibleSubmenuItems;
  const onStartTerminalRef = useRef(onStartTerminal);
  onStartTerminalRef.current = onStartTerminal;
  const onStartBlankTerminalRef = useRef(onStartBlankTerminal);
  onStartBlankTerminalRef.current = onStartBlankTerminal;

  const handleCloseTerminal = async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session?.sessionType === 'editor') {
      const isDraft = session.profileId.includes('\\drafts\\draft_') || session.profileId.includes('/drafts/draft_');
      if (isDraft) {
        // For drafts, check if file has content (even if not dirty in memory)
        try {
          const content = await readFileContent(session.profileId);
          if (content) {
            setDraftCloseDialog({ sessionId, filePath: session.profileId });
            return;
          }
        } catch {}
        // Empty draft, clean up directly
        useAppStore.getState().removeDraftFile(session.profileId);
        removeSession(sessionId);
        return;
      }
      if (session.isDirty) {
        setConfirmDialog({
          title: '未保存的更改',
          message: `文件「${session.profileName}」有未保存的更改，确定要关闭吗？`,
          onConfirm: async () => {
            setConfirmDialog(null);
            removeSession(sessionId);
          },
        });
        return;
      }
      removeSession(sessionId);
    } else if (session?.starting) {
      removeSession(sessionId);
    } else if (session) {
      // 活跃终端（正在执行任务）关闭前弹窗确认
      if (isTerminalWorking(terminalActivities[sessionId])) {
        setConfirmDialog({
          title: '终端正在执行任务',
          message: `终端「${session.profileName}」正在执行任务，确定要关闭吗？`,
          onConfirm: () => {
            setConfirmDialog(null);
            removeSession(sessionId);
            void closeTerminalCmd(sessionId).catch(err => console.error(err));
          },
        });
        return;
      }
      removeSession(sessionId);
      void closeTerminalCmd(sessionId).catch(err => console.error(err));
    }
  };

  const handleDraftSaveAs = async () => {
    if (!draftCloseDialog) return;
    const session = sessions.find(s => s.id === draftCloseDialog.sessionId);
    if (!session) { setDraftCloseDialog(null); return; }
    try {
      const content = await readFileContent(draftCloseDialog.filePath);
      const savedPath = await saveDialog({
        defaultPath: session.profileName + '.txt',
        filters: [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }],
      });
      if (savedPath) {
        await writeFileContent(savedPath, content);
        await useAppStore.getState().removeDraftFile(draftCloseDialog.filePath);
        removeSession(draftCloseDialog.sessionId);
        setDraftCloseDialog(null);
      }
      // If cancelled, dialog stays open
    } catch (err) {
      console.error('Save as failed:', err);
      setDraftCloseDialog(null);
    }
  };

  const handleDraftDiscard = async () => {
    if (!draftCloseDialog) return;
    await useAppStore.getState().removeDraftFile(draftCloseDialog.filePath);
    removeSession(draftCloseDialog.sessionId);
    setDraftCloseDialog(null);
  };

  // 批量关闭会话：清理 draft 文件索引 → 移除 store 会话 → 关闭后端 PTY。
  // 分组关闭与「关闭所有」共用。
  const closeSessionsWithBackend = async (targets: typeof sessions) => {
    const store = useAppStore.getState();
    const terminalIds = targets
      .filter(session => session.sessionType !== 'editor' && !session.starting)
      .map(session => session.id);
    for (const session of targets) {
      if (session.sessionType === 'editor') {
        const isDraft = session.profileId.includes('\\drafts\\draft_') || session.profileId.includes('/drafts/draft_');
        if (isDraft) void store.removeDraftFile(session.profileId);
      }
    }
    removeSessions(targets.map(session => session.id));
    void Promise.all(terminalIds.map(id => closeTerminalCmd(id).catch(err => console.error(err))));
  };

  const handleCloseGroup = async (groupName: string, groupSessions: typeof sessions, groupAgentKeys: string[] = []) => {
    const workingCount = groupSessions.filter(
      s => s.sessionType !== 'editor' && !s.starting && isTerminalWorking(terminalActivities[s.id])
    ).length;
    const total = groupSessions.length + groupAgentKeys.length;
    setConfirmDialog({
      title: '确认关闭分组',
      message: workingCount > 0
        ? `分组「${groupName}」中有 ${workingCount} 个终端正在执行任务，确定要关闭全部 ${total} 个标签吗？`
        : `确定要关闭分组「${groupName}」中的所有 ${total} 个标签吗？`,
      onConfirm: async () => {
        setConfirmDialog(null);
        // 原生会话标签只是聊天页签，关闭不删除服务端会话。
        for (const key of groupAgentKeys) closeAgentTab(key);
        await closeSessionsWithBackend(groupSessions);
      },
    });
  };

  const handleCloseAllTabs = () => {
    if (sessions.length === 0) return;
    const hasDirty = sessions.some(s => s.sessionType === 'editor' && s.isDirty);
    const workingCount = sessions.filter(
      s => s.sessionType !== 'editor' && !s.starting && isTerminalWorking(terminalActivities[s.id])
    ).length;
    let message: string;
    if (workingCount > 0 && hasDirty) {
      message = `有未保存的文件更改，且 ${workingCount} 个终端正在执行任务，确定关闭所有 ${sessions.length} 个选项卡吗？`;
    } else if (workingCount > 0) {
      message = `有 ${workingCount} 个终端正在执行任务，确定关闭所有 ${sessions.length} 个选项卡吗？`;
    } else if (hasDirty) {
      message = `有未保存的文件更改，确定关闭所有 ${sessions.length} 个选项卡吗？`;
    } else {
      message = `确定关闭所有 ${sessions.length} 个选项卡吗？`;
    }
    setConfirmDialog({
      title: '确认关闭所有选项卡',
      message,
      onConfirm: async () => {
        setConfirmDialog(null);
        await closeSessionsWithBackend(sessions);
        setShowContextMenu(false);
      },
    });
  };

  const handleContentContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.tab-nav-item')) return;
    e.preventDefault();
    setShowContextMenu(true);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setHighlightedIndex(-1);
    setSubmenuExpandedGroups(new Set());
  };

  // Close tab context menu on outside click
  useEffect(() => {
    if (!tabContextMenu) return;
    const handler = () => setTabContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [tabContextMenu]);

  // Close context menu on outside click/key/wheel
  useEffect(() => {
    if (!showContextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.context-menu')) return;
      setShowContextMenu(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setShowContextMenu(false); return; }
      if (['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
        e.preventDefault();
        const items = visibleSubmenuItemsRef.current;
        const idx = highlightedIndexRef.current;
        if (e.key === 'ArrowDown') {
          setHighlightedIndex(prev => (prev + 1) % items.length);
        } else if (e.key === 'ArrowUp') {
          setHighlightedIndex(prev => prev <= 0 ? items.length - 1 : prev - 1);
        } else if (e.key === 'Enter' && idx >= 0 && idx < items.length) {
          const item = items[idx];
          if (item.isGroup || (item.children && item.children.length > 0)) {
            setSubmenuExpandedGroups(prev => {
              const next = new Set(prev);
              if (next.has(item.id)) next.delete(item.id);
              else next.add(item.id);
              return next;
            });
          } else if (item.data) {
            const d = item.data as Record<string, unknown>;
            if ('group' in d) onStartTerminalRef.current(item.data as Profile);
            else if (d.terminalType) onStartBlankTerminalRef.current(d.terminalType as 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh');
            setShowContextMenu(false);
          }
        }
        return;
      }
      setShowContextMenu(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showContextMenu]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex < 0 || !submenuRef.current) return;
    const items = submenuRef.current.querySelectorAll('.submenu-tree .tree-item');
    const el = items[highlightedIndex] as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  if (sessions.length === 0 && !gitHistoryTab && claudeReplayTabs.length === 0 && agentTabs.length === 0) return null;

  // 终端接力标签是终端的对话视图，终端本身已在项目分组里；这里只保留接力标签的独立入口。
  const relayAgentTabs = agentTabs.filter(tab => tab.shape === 'relay');
  const nativeAgentTabCount = agentTabs.length - relayAgentTabs.length;

  const handleRenameSubmit = (sessionId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== renameBaseline) renameSession(sessionId, trimmed);
    setRenamingSessionId(null);
  };

  return (
    <div className={`tab-nav${isSidebarMode ? ' sidebar-mode' : ''}`} style={{ width }} ref={containerRef}>
      <div className="panel-titlebar">
        <span className="panel-title">会话标签</span>
        <span className="panel-title-count">{sessions.length + nativeAgentTabCount}</span>
      </div>
      <div className="tab-nav-header">
        {gitHistoryTab && (
          <div
            className={`tab-nav-settings-btn ${activeSpecialTab === 'git-history' ? 'active' : ''}`}
            onClick={() => openGitHistoryTab(gitHistoryTab)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                closeGitHistoryTab();
              }
            }}
            onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
            title={`${gitHistoryTab.repoRoot} - Git 历史记录`}
          >
            <span className="tab-nav-dot" style={{ background: '#e6a23c' }} />
            <span className="tab-nav-name">Git 历史记录</span>
            <button
              className="tree-item-close"
              onClick={(event) => {
                event.stopPropagation();
                closeGitHistoryTab();
              }}
              title="关闭"
              aria-label="关闭 Git 历史记录"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        )}

      </div>
      <div
        className={`tab-nav-content${dropActive ? ' drop-target' : ''}`}
        onContextMenu={handleContentContextMenu}
        onDragOver={(e) => {
          if (!dragProfileId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!dropActive) setDropActive(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false);
        }}
        onDrop={(e) => {
          if (!dragProfileId) return;
          e.preventDefault();
          setDropActive(false);
          const profile = profiles.find(p => p.id === dragProfileId);
          if (profile) onStartTerminal(profile);
          setDragProfileId(null);
        }}
      >
        {relayAgentTabs.length > 0 && (
          <div className="tab-nav-group">
            <div className="tab-nav-group-header" onClick={() => setCollapsedGroups(prev => {
              const next = new Set(prev);
              if (next.has("agent-group")) next.delete("agent-group"); else next.add("agent-group");
              return next;
            })} role="button" tabIndex={0} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.click(); } }}>
              <span className={`tab-nav-group-arrow${collapsedGroups.has("agent-group") ? " collapsed" : ""}`}>▾</span>
              <span className="tab-nav-group-name">AI 会话</span>
              <span className="tab-nav-group-count">{relayAgentTabs.length}</span>
            </div>
            {!collapsedGroups.has("agent-group") && relayAgentTabs.map(tab => (
              <div key={tab.key} className={`tab-nav-settings-btn tab-nav-replay-item ${activeSpecialTab === "agent-chat" && activeAgentTabKey === tab.key ? "active" : ""}`}
                onClick={() => setActiveAgentTab(tab.key)}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    closeAgentTab(tab.key);
                  }
                }}
                onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
                title={`终端接力 · ${tab.title}`}>
                <span className="tab-nav-name">{tab.title}</span>
                <button type="button" className="tree-item-close" onClick={event => { event.stopPropagation(); closeAgentTab(tab.key); }}
                  title="关闭" aria-label={`关闭 ${tab.title}`}><X aria-hidden="true" /></button>
              </div>
            ))}
          </div>
        )}
        {claudeReplayTabs.length > 0 && (
          <div className="tab-nav-group">
            <div className="tab-nav-group-header" onClick={() => setCollapsedGroups(prev => {
              const next = new Set(prev);
              if (next.has("replay-group")) next.delete("replay-group"); else next.add("replay-group");
              return next;
            })} role="button" tabIndex={0} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.click(); } }}>
              <span className={`tab-nav-group-arrow${collapsedGroups.has("replay-group") ? " collapsed" : ""}`}>▾</span>
              <span className="tab-nav-group-name">会话详情</span>
              <span className="tab-nav-group-count">{claudeReplayTabs.length}</span>
            </div>
            {!collapsedGroups.has("replay-group") && claudeReplayTabs.map(tab => (
              <div key={sessionReplayTabKey(tab)} className={`tab-nav-settings-btn tab-nav-replay-item ${activeSpecialTab === "claude-replay" && claudeReplayTab && sessionReplayTabKey(claudeReplayTab) === sessionReplayTabKey(tab) ? "active" : ""}`}
                onClick={() => openClaudeReplayTab(tab)}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    closeClaudeReplayTab(tab.sessionId, tab.provider);
                  }
                }}
                onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
                title={`${tab.provider === 'codex' ? 'Codex' : 'Claude Code'} · ${tab.title}`}>
                <span className="tab-nav-name">{tab.title}</span>
                <button type="button" className="tree-item-close" onClick={event => { event.stopPropagation(); closeClaudeReplayTab(tab.sessionId, tab.provider); }}
                  title="关闭" aria-label={`关闭 ${tab.title}`}><X aria-hidden="true" /></button>
              </div>
            ))}
          </div>
        )}
        {sessionTree.map((group) => (
          <SessionTreeItem
            key={group.id}
            item={group}
            depth={0}
            collapsedGroups={collapsedGroups}
            onToggleCollapse={(id) => {
              setCollapsedGroups(prev => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onCloseGroup={handleCloseGroup}
            renamingSessionId={renamingSessionId}
            renameValue={renameValue}
            onRenameValueChange={setRenameValue}
            onRenameSubmit={handleRenameSubmit}
            onRenameCancel={() => setRenamingSessionId(null)}
            renameInputRef={renameInputRef}
            onCloseSession={handleCloseTerminal}
            onContextMenu={(e, sessionId) => {
              e.preventDefault();
              setTabContextMenu({ x: e.clientX, y: e.clientY, sessionId });
            }}
            onAgentContextMenu={(e, tab) => {
              e.preventDefault();
              setAgentTabMenu({ x: e.clientX, y: e.clientY, key: tab.key });
            }}
          />
        ))}
      </div>
      <div
        className={`tab-nav-resize ${isResizing ? 'active' : ''}`}
        onMouseDown={resizeHandleProps.onMouseDown}
      />
      {tabContextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setTabContextMenu(null)} />
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
                // 编辑所见即所得：初始值取任务行当前显示的第一行标题（含摘要）
                const displayed = session.manualTitle
                  ? session.profileName
                  : (taskSummaries[session.id]?.summary?.trim() || session.profileName);
                setRenameValue(displayed);
                setRenameBaseline(displayed);
                setRenamingSessionId(session.id);
                setTimeout(() => renameInputRef.current?.select(), 0);
              }
            }}
            onCloseSession={handleCloseTerminal}
            onCloseOthers={(sessionId) => {
              const editorSessions = sessions.filter(
                s => s.sessionType === 'editor' && s.id !== sessionId
              );
              for (const s of editorSessions) {
                removeSession(s.id);
              }
            }}
          />
        </>
      )}
      {agentTabMenu && (() => {
        const tab = agentTabs.find(item => item.key === agentTabMenu.key && item.shape === 'native');
        if (!tab || tab.shape !== 'native') return null;
        return (
          <AgentTabContextMenu
            x={agentTabMenu.x}
            y={agentTabMenu.y}
            tab={tab}
            onClose={() => setAgentTabMenu(null)}
          />
        );
      })()}
      {showContextMenu && (
        <NewTerminalMenu
          x={contextMenuPos.x}
          y={contextMenuPos.y}
          submenuTree={submenuTree}
          expandedGroups={submenuExpandedGroups}
          onToggleGroup={(id) => {
            setSubmenuExpandedGroups(prev => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
          highlightedIndex={highlightedIndex}
          visibleSubmenuItems={visibleSubmenuItems}
          menuRef={contextMenuRef}
          submenuRef={submenuRef}
          onStartTerminal={onStartTerminal}
          onStartBlankTerminal={onStartBlankTerminal}
          onStartTextEditor={onStartTextEditor}
          onCloseAllTabs={handleCloseAllTabs}
          onClose={() => setShowContextMenu(false)}
        />
      )}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          onClose={() => setConfirmDialog(null)}
          onConfirm={confirmDialog.onConfirm}
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
    </div>
  );
};
