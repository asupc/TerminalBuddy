import type { AgentTab, GitChangesTab, GitHistoryTab, NativeAgentTab } from '../stores/appStore';
import type { TerminalTaskSummary } from '../stores/taskSummaryStore';
import type { Profile, Project, TabGroup, TerminalSession } from '../types';
import { projectForDirectory } from './projectPath';

export const PINNED_GROUP_ID = '__pinned__';
export const EDITOR_GROUP_ID = '__editors__';
export const projectConfigGroupId = (groupName: string): string => `__project_configs__:${groupName}`;

export type SessionLeaf =
  | { kind: 'terminal'; session: TerminalSession }
  | { kind: 'agent'; tab: NativeAgentTab }
  | { kind: 'git-changes'; tab: GitChangesTab }
  | { kind: 'git-history'; tab: GitHistoryTab };

export interface ProjectTasksGroup {
  id: string;
  label: string;
  configGroupId: string;
  profiles: Profile[];
  sessions: SessionLeaf[];
}

export interface ProjectTasksTreeModel {
  pinnedProfiles: Profile[];
  editorSessions: TerminalSession[];
  groups: ProjectTasksGroup[];
  /** 已打开会话总数（终端 + 编辑器 + 原生 AI 会话），与会话标签面板标题计数口径一致。 */
  openSessionCount: number;
}

export interface BuildProjectTasksTreeInput {
  projects: Project[];
  profiles: Profile[];
  sessions: TerminalSession[];
  agentTabs: AgentTab[];
  tabGroups: TabGroup[];
  gitChangesTab: GitChangesTab | null;
  gitHistoryTab: GitHistoryTab | null;
  taskSummaries: Record<string, TerminalTaskSummary>;
  searchQuery?: string;
}

/** 推导会话叶子所属的项目/分组名，保持与 TabNav 一致的归类口径。 */
export function resolveSessionLeafGroup(
  leaf: SessionLeaf,
  projects: Project[],
  profiles: Profile[],
  tabGroups: TabGroup[],
): string {
  if (leaf.kind === 'git-changes' || leaf.kind === 'git-history') {
    return projectForDirectory(projects, leaf.tab.repoRoot)?.name || '默认';
  }
  if (leaf.kind === 'agent') {
    return projectForDirectory(projects, leaf.tab.projectPath)?.name || '默认';
  }
  const session = leaf.session;
  const explicitGroup = session.groupId && session.groupId !== 'default'
    ? tabGroups.find(group => group.id === session.groupId)
    : undefined;
  if (explicitGroup) return explicitGroup.name;
  if (session.groupName) return session.groupName;
  const profile = profiles.find(p => p.id === session.profileId);
  return profile?.group || '默认';
}

function sessionLeafMatchesQuery(
  leaf: SessionLeaf,
  query: string,
  taskSummaries: Record<string, TerminalTaskSummary>,
): boolean {
  switch (leaf.kind) {
    case 'terminal': {
      if (leaf.session.profileName.toLowerCase().includes(query)) return true;
      const summary = taskSummaries[leaf.session.id]?.summary;
      return summary ? summary.toLowerCase().includes(query) : false;
    }
    case 'agent':
      return leaf.tab.title.toLowerCase().includes(query);
    case 'git-changes':
      return '未提交变更'.includes(query);
    case 'git-history':
      return 'git 历史记录'.includes(query);
  }
}

/**
 * 构建「项目与任务」树模型：
 * - 置顶配置单独抽到顶层「置顶」分组；
 * - 编辑器会话单独归入顶层「文本编辑」分组；
 * - 项目节点直接承载该项目下所有已打开会话（终端 / 原生 AI / Git 视图），
 *   该项目下的未置顶命令配置统一收纳到「配置」子分组（仅当存在配置时展示）。
 */
export function buildProjectTasksTree({
  projects,
  profiles,
  sessions,
  agentTabs,
  tabGroups,
  gitChangesTab,
  gitHistoryTab,
  taskSummaries,
  searchQuery = '',
}: BuildProjectTasksTreeInput): ProjectTasksTreeModel {
  const query = searchQuery.trim().toLowerCase();

  const allPinnedProfiles = profiles.filter(p => p.pinned);
  const normalProfiles = profiles.filter(p => !p.pinned);
  const allEditorSessions = sessions.filter(s => s.sessionType === 'editor');
  const terminalSessions = sessions.filter(s => s.sessionType !== 'editor');
  const nativeTabs = agentTabs.filter((tab): tab is NativeAgentTab => tab.shape === 'native');

  const allLeaves: SessionLeaf[] = [
    ...(gitChangesTab ? [{ kind: 'git-changes' as const, tab: gitChangesTab }] : []),
    ...(gitHistoryTab ? [{ kind: 'git-history' as const, tab: gitHistoryTab }] : []),
    ...terminalSessions.map(session => ({ kind: 'terminal' as const, session })),
    ...nativeTabs.map(tab => ({ kind: 'agent' as const, tab })),
  ];

  const profilesByGroup = new Map<string, Profile[]>();
  const sessionsByGroup = new Map<string, SessionLeaf[]>();
  const groupOrder: string[] = [];

  const ensureGroup = (rawName: string): string => {
    const name = rawName || '默认';
    if (!profilesByGroup.has(name)) {
      profilesByGroup.set(name, []);
      sessionsByGroup.set(name, []);
      groupOrder.push(name);
    }
    return name;
  };

  for (const project of projects) {
    ensureGroup(project.name);
  }
  for (const profile of normalProfiles) {
    const groupName = ensureGroup(profile.group || '默认');
    profilesByGroup.get(groupName)!.push(profile);
  }
  for (const leaf of allLeaves) {
    const groupName = ensureGroup(resolveSessionLeafGroup(leaf, projects, profiles, tabGroups));
    sessionsByGroup.get(groupName)!.push(leaf);
  }

  const pinnedProfiles = query
    ? allPinnedProfiles.filter(p => p.name.toLowerCase().includes(query))
    : allPinnedProfiles;

  const editorSessions = query
    ? allEditorSessions.filter(s => s.profileName.toLowerCase().includes(query))
    : allEditorSessions;

  const groups: ProjectTasksGroup[] = [];
  for (const groupName of groupOrder) {
    const groupProfiles = profilesByGroup.get(groupName)!;
    const groupSessions = sessionsByGroup.get(groupName)!;

    if (!query) {
      groups.push({
        id: groupName,
        label: groupName,
        configGroupId: projectConfigGroupId(groupName),
        profiles: groupProfiles,
        sessions: groupSessions,
      });
      continue;
    }

    const groupMatched = groupName.toLowerCase().includes(query);
    const matchedProfiles = groupMatched
      ? groupProfiles
      : groupProfiles.filter(p => p.name.toLowerCase().includes(query));
    const matchedSessions = groupMatched
      ? groupSessions
      : groupSessions.filter(leaf => sessionLeafMatchesQuery(leaf, query, taskSummaries));

    if (groupMatched || matchedProfiles.length > 0 || matchedSessions.length > 0) {
      groups.push({
        id: groupName,
        label: groupName,
        configGroupId: projectConfigGroupId(groupName),
        profiles: matchedProfiles,
        sessions: matchedSessions,
      });
    }
  }

  groups.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true, sensitivity: 'base' }));

  return {
    pinnedProfiles,
    editorSessions,
    groups,
    openSessionCount: sessions.length + nativeTabs.length,
  };
}
