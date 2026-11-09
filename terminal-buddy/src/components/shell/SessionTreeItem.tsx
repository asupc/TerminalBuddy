import { useTaskSummaryStore } from '../../stores/taskSummaryStore';
import { getTaskLaunchInfo } from '../../utils/taskLaunchInfo';
import { SessionTaskLabel } from './SessionTaskLabel';
import { FC } from 'react';
import { ChevronRight, Folder, FolderOpen, X } from 'lucide-react';
import { useAppStore, type NativeAgentTab } from '../../stores/appStore';
import { formatDuration } from '../../utils/formatDuration';
import { isDockerClient } from '../../services/platform';
import { getIndicatorLight, getIndicatorColor, getIndicatorTitle, getIndicatorClassName, type IndicatorLight } from '../../utils/claudeIndicator';
import type { TreeItem } from '../file-explorer/TreeView';
import type { TerminalSession } from '../../types';

interface SessionTreeItemProps {
  item: TreeItem;
  depth: number;
  collapsedGroups: Set<string>;
  onToggleCollapse: (id: string) => void;
  onCloseGroup: (groupName: string, groupSessions: TerminalSession[], groupAgentKeys: string[]) => void;
  renamingSessionId: string | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onRenameSubmit: (sessionId: string) => void;
  onRenameCancel: () => void;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onCloseSession: (sessionId: string) => void;
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void;
  /** 原生会话叶子（聊天标签）的右键菜单；与终端会话的菜单分开，因为数据源不同。 */
  onAgentContextMenu: (e: React.MouseEvent, tab: NativeAgentTab) => void;
}

/** 原生 AI 会话标签的叶子数据；与终端会话共用项目分组。 */
interface AgentLeafData { kind: 'agent'; tab: NativeAgentTab }
const agentLeafData = (data: unknown): AgentLeafData | undefined => (
  (data as AgentLeafData | undefined)?.kind === 'agent' ? data as AgentLeafData : undefined
);

/** 会话树递归渲染：分组节点 + 终端/编辑器叶子（含重命名输入 UI 与徽章）。 */
export const SessionTreeItem: FC<SessionTreeItemProps> = ({
  item,
  depth,
  collapsedGroups,
  onToggleCollapse,
  onCloseGroup,
  renamingSessionId,
  renameValue,
  onRenameValueChange,
  onRenameSubmit,
  onRenameCancel,
  renameInputRef,
  onCloseSession,
  onContextMenu,
  onAgentContextMenu,
}) => {
  const sessions = useAppStore(s => s.sessions);
  const profiles = useAppStore(s => s.profiles);
  const taskSummaries = useTaskSummaryStore(s => s.summaries);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const activeSpecialTab = useAppStore(s => s.activeSpecialTab);
  const terminalActivities = useAppStore(s => s.terminalActivities);
  const terminalWebTakeovers = useAppStore(s => s.terminalWebTakeovers);
  const agentTabs = useAppStore(s => s.agentTabs);
  const activeAgentTabKey = useAppStore(s => s.activeAgentTabKey);

  if (!item.isGroup && !item.children?.length) return null;
  const indent = 8 + depth * 12;
  const isCollapsed = collapsedGroups.has(item.id);

  const renderGroupEnd = (groupItem: TreeItem) => {
    if (!groupItem.isGroup || !groupItem.children) return null;
    // Recursively collect all leaf IDs from this group and its sub-groups
    const collectLeafIds = (treeItem: TreeItem): string[] => {
      const ids: string[] = [];
      if (!treeItem.isGroup && treeItem.id) ids.push(treeItem.id);
      for (const child of (treeItem.children || [])) {
        ids.push(...collectLeafIds(child));
      }
      return ids;
    };
    const allLeafIds = collectLeafIds(groupItem);
    const groupSessions = sessions.filter(s => allLeafIds.includes(s.id));
    const groupAgentKeys = agentTabs.filter(tab => tab.shape === 'native' && allLeafIds.includes(tab.key)).map(tab => tab.key);
    return (
      <span className="tree-item-end">
        <span className="tree-item-count">{groupSessions.length + groupAgentKeys.length}</span>
        <button
          className="tree-item-close"
          onClick={(e) => { e.stopPropagation(); onCloseGroup(groupItem.id, groupSessions, groupAgentKeys); }}
          title="关闭分组内所有标签"
        >
          <X aria-hidden="true" />
        </button>
      </span>
    );
  };

  // 灯点击语义：failed 长红点击清除；attention 点击跳终端处理
  const onLedClick = (e: React.MouseEvent, id: string, light: IndicatorLight) => {
    if (light !== 'failed' && light !== 'attention') return;
    e.stopPropagation();
    const store = useAppStore.getState();
    if (light === 'failed') {
      store.clearClaudeFailure(id);
    } else {
      store.setActiveSession(id);
    }
  };

  const renderLedDot = (id: string, tabColor?: string | null) => {
    const light = getIndicatorLight(terminalActivities[id]);
    return (
      <span
        className={`tab-nav-dot${getIndicatorClassName(light)}`}
        style={{ background: getIndicatorColor(light, tabColor) }}
        title={getIndicatorTitle(light, terminalActivities[id]?.provider) || undefined}
        onClick={(e) => onLedClick(e, id, light)}
      />
    );
  };

  return (
    <div>
      <div
        className="tree-item tree-group-item"
        style={{ paddingLeft: `${indent}px` }}
        onClick={() => onToggleCollapse(item.id)}
      >
        <span className={`tree-arrow${isCollapsed ? '' : ' expanded'}`}>
          <ChevronRight aria-hidden="true" />
        </span>
        <span className="tree-group-icon">
          {isCollapsed ? <Folder aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
        </span>
        <span className="tree-group-name">{item.label}</span>
        {renderGroupEnd(item)}
      </div>
      {!isCollapsed && item.children?.map((child) => {
        if (child.isGroup || (child.children && child.children.length > 0)) {
          return (
            <SessionTreeItem
              key={child.id}
              item={child}
              depth={depth + 1}
              collapsedGroups={collapsedGroups}
              onToggleCollapse={onToggleCollapse}
              onCloseGroup={onCloseGroup}
              renamingSessionId={renamingSessionId}
              renameValue={renameValue}
              onRenameValueChange={onRenameValueChange}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              renameInputRef={renameInputRef}
              onCloseSession={onCloseSession}
              onContextMenu={onContextMenu}
              onAgentContextMenu={onAgentContextMenu}
            />
          );
        }
        // Leaf node: 原生 AI 会话标签（与终端同组，点击打开聊天页）
        const agentLeaf = agentLeafData(child.data);
        if (agentLeaf) {
          const tab = agentLeaf.tab;
          const active = activeSpecialTab === 'agent-chat' && activeAgentTabKey === tab.key;
          return (
            <div
              key={child.id}
              className={`tree-item tab-nav-item${active ? ' active' : ''}`}
              style={{ paddingLeft: `${indent + 12}px` }}
              title={`${tab.provider === 'codex' ? 'Codex' : 'Claude Code'} · ${tab.title}`}
              onMouseDown={() => { useAppStore.getState().setLastClickRegion('tab'); }}
              onClick={() => {
                const store = useAppStore.getState();
                store.setLastClickRegion('tab');
                store.setActiveAgentTab(tab.key);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onAgentContextMenu(e, tab);
              }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); useAppStore.getState().closeAgentTab(tab.key); } }}
            >
              {child.icon}
              <span className="tree-name" title={tab.title}>{tab.title}</span>
              <span className="tree-item-end">
                <button
                  className="tree-item-close"
                  onClick={(e) => { e.stopPropagation(); useAppStore.getState().closeAgentTab(tab.key); }}
                  title="关闭"
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            </div>
          );
        }
        // Leaf node: session
        const childSession = child.data as TerminalSession | undefined;
        const task = childSession?.sessionType !== 'editor' ? taskSummaries[child.id] : undefined;
        const profile = profiles.find(profile => profile.id === childSession?.profileId);
        const launchInfo = childSession?.sessionType !== 'editor'
          ? getTaskLaunchInfo(childSession?.extraParams, profile?.startupCommands, childSession?.extraParamMode)
          : undefined;
        const provider = task?.provider ?? launchInfo?.provider;
        // 手动重命名过的会话固定显示手动名称；未取得摘要时回落到会话名。
        // 项目名只在分组标题展示，会话行不重复。
        const fallbackName = childSession?.manualTitle
          ? childSession.profileName
          : (childSession?.profileName || child.label);
        return (
          <div key={child.id}>
            {renamingSessionId === child.id ? (
              <div className="tree-item" style={{ paddingLeft: `${indent + 12}px` }}>
                {child.icon || renderLedDot(child.id, (child.data as TerminalSession | undefined)?.tabColor)}
                <input
                  ref={renameInputRef}
                  className="tree-rename-input"
                  value={renameValue}
                  onChange={(e) => onRenameValueChange(e.target.value)}
                  onBlur={() => onRenameSubmit(child.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      onRenameSubmit(child.id);
                    } else if (e.key === 'Escape') {
                      onRenameCancel();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            ) : (
              <div
                className={`tree-item tab-nav-item${provider ? ' tab-nav-task-item' : ''} ${activeSpecialTab === null && activeSessionId === child.id ? 'active' : ''}`}
                style={{ paddingLeft: `${indent + 12}px` }}
                title={provider && childSession?.createdAt ? `${childSession.profileName} · 运行 ${formatDuration(Date.now() - childSession.createdAt)}` : undefined}
                onMouseDown={() => { useAppStore.getState().setLastClickRegion('tab'); }}
                onClick={() => {
                  const store = useAppStore.getState();
                  store.setLastClickRegion('tab');
                  if (store.splitMode !== 'off') {
                    if (!store.splitSlots.some(slot => slot.sessionId === child.id)) {
                      store.placeSessionInSplitSlot(child.id);
                    } else {
                      store.setActiveSession(child.id);
                    }
                  } else {
                    store.setActiveSession(child.id);
                  }
                }}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseSession(child.id); } }}
                onContextMenu={(e) => onContextMenu(e, child.id)}
              >
                {child.icon || renderLedDot(child.id, (child.data as TerminalSession | undefined)?.tabColor)}
                {provider ? (
                  <SessionTaskLabel task={task} fallbackName={fallbackName} fallbackProvider={provider} fallbackModel={launchInfo?.model} color={childSession?.tabColor} manualTitle={childSession?.manualTitle} />
                ) : (
                <span className="tree-name" title={child.label} style={(child.data as any)?.tabColor ? { color: (child.data as any).tabColor } : undefined}>
                  {child.label}
                  {(() => {
                    const childSession = child.data as TerminalSession | undefined;
                    if (childSession && childSession.sessionType !== 'editor' && childSession.createdAt) {
                      return <span className="tab-nav-uptime"> · {formatDuration(Date.now() - childSession.createdAt)}</span>;
                    }
                    return null;
                  })()}
                </span>
                )}
                {(child.data as any)?.owner === 'web' && !isDockerClient() && <span className="tab-nav-owner-badge">Web</span>}
                {(child.data as any)?.owner !== 'web' && terminalWebTakeovers[child.id] && (
                  <span className="tab-nav-takeover-badge" title="当前终端正在被 Web 端接管">接管中</span>
                )}
                <span className="tree-item-end">
                  <button
                    className="tree-item-close"
                    onClick={(e) => { e.stopPropagation(); onCloseSession(child.id); }}
                    title="关闭"
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
