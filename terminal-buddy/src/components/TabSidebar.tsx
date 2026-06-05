import { FC, useState, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { closeTerminal as closeTerminalCmd, saveTabSidebarWidth, getBackendAppSettings, saveEnableTabNavigation, writeFileContent, readFileContent } from '../services/tauri';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { getAppSettings, saveAppSettings } from '../utils/settings';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { getWorkingDotColor } from '../utils/tabColor';
import { TreeView, type TreeItem } from './TreeView';
import { buildGroupTree, type GroupNode } from '../utils/groupTree';
import type { Profile } from '../types';
import './TabSidebar.css';

interface TabSidebarProps {
  profiles: Profile[];
  onStartTerminal: (profile: Profile) => void;
  onStartBlankTerminal: (terminalType: 'powershell' | 'cmd') => void;
  onStartTextEditor: () => void;
}

export const TabSidebar: FC<TabSidebarProps> = ({ profiles, onStartTerminal, onStartBlankTerminal, onStartTextEditor }) => {
  const sessions = useAppStore(s => s.sessions);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const settingsTabOpen = useAppStore(s => s.settingsTabOpen);
  const openSettingsTab = useAppStore(s => s.openSettingsTab);
  const removeSession = useAppStore(s => s.removeSession);
  const setActiveSession = useAppStore(s => s.setActiveSession);
  const renameSession = useAppStore(s => s.renameSession);
  const workingSessions = useAppStore(s => s.workingSessions);
  const settingsVersion = useAppStore(s => s.settingsVersion);
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const highlightedIndexRef = useRef(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  highlightedIndexRef.current = highlightedIndex;
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [draftCloseDialog, setDraftCloseDialog] = useState<{ sessionId: string; filePath: string } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [submenuExpandedGroups, setSubmenuExpandedGroups] = useState<Set<string>>(new Set());
  const [, setSettingsTick] = useState(0);

  // F2 快速重命名标签
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      const region = useAppStore.getState().lastClickRegion;
      if (region && region !== 'tab') return;
      if (!activeSessionId) return;
      const session = sessions.find(s => s.id === activeSessionId);
      if (session && session.sessionType !== 'editor') {
        setRenameValue(session.profileName);
        setRenamingSessionId(activeSessionId);
        setTimeout(() => renameInputRef.current?.select(), 0);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [activeSessionId, sessions]);

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

  useEffect(() => {
    const handler = () => setSettingsTick(t => t + 1);
    window.addEventListener('app-settings-changed', handler);
    return () => window.removeEventListener('app-settings-changed', handler);
  }, []);

  const { width, setWidth, isResizing, resizeHandleProps } = useResizablePanel({
    defaultWidth: 200,
    minWidth: 150,
    maxWidth: 400,
    onResizeEnd: (w) => { saveTabSidebarWidth(w).catch(console.error); },
  });

  useEffect(() => {
    getBackendAppSettings().then(s => setWidth(s.tabSidebarWidth || 200)).catch(() => {});
  }, []);

  // Build tree for active sessions grouped by profile group (hierarchical)
  const sessionTree = useMemo(() => {
    const editorSessions = sessions.filter(s => s.sessionType === 'editor');
    const terminalSessions = sessions.filter(s => s.sessionType !== 'editor');

    const tree = buildGroupTree(terminalSessions, s => {
      const profile = profiles.find(p => p.id === s.profileId);
      return profile?.group || '默认';
    });

    // Recursive helper: collect all sessions under a node (including children)
    const collectAllSessions = (node: GroupNode<typeof terminalSessions[0]>): typeof terminalSessions => {
      const result = [...node.items];
      for (const child of node.children) {
        result.push(...collectAllSessions(child));
      }
      return result;
    };

    // Convert GroupNode[] to TreeItem[] with recursive nesting
    const toTreeItems = (nodes: GroupNode<typeof terminalSessions[0]>[]): TreeItem[] =>
      nodes.map(node => ({
        id: node.path,
        label: node.name,
        isGroup: true,
        data: { type: 'group' as const, allSessions: collectAllSessions(node) },
        children: [
          ...toTreeItems(node.children),
          ...node.items.map(session => {
            const isEditor = session.sessionType === 'editor';
            return {
              id: session.id,
              label: session.profileName,
              icon: isEditor ? (
                <span className="tab-sidebar-file-icon">
                  {session.isDirty && <span className="tab-sidebar-dirty-dot" />}
                  📄
                </span>
              ) : (
                <span
                  className={`tab-sidebar-dot${workingSessions[session.id] ? ' working' : ''}`}
                  style={{ background: getWorkingDotColor(workingSessions[session.id], session.tabColor) }}
                />
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
            <span className="tab-sidebar-file-icon">
              {session.isDirty && <span className="tab-sidebar-dirty-dot" />}
              📄
            </span>
          ),
          data: session,
        })),
      });
    }

    return items;
  }, [sessions, profiles, workingSessions, settingsVersion]);

  // Build submenu tree: PowerShell/CMD always visible, then groups collapsed (hierarchical)
  const submenuTree = useMemo(() => {
    const tree = buildGroupTree(profiles, p => p.group || '默认');

    const toTreeItems = (nodes: GroupNode<Profile>[]): TreeItem[] =>
      nodes.map(node => ({
        id: node.path,
        label: node.name,
        isGroup: true,
        children: [
          ...toTreeItems(node.children),
          ...node.items.map(p => ({
            id: p.id,
            label: p.name,
            data: p,
          })),
        ],
      }));

    return toTreeItems(tree);
  }, [profiles]);

  // Flatten expanded items for keyboard nav (recursive for nested groups)
  const visibleSubmenuItems = useMemo(() => {
    const result: TreeItem[] = [];
    result.push({ id: 'powershell', label: 'PowerShell', data: { terminalType: 'powershell' as const } });
    result.push({ id: 'cmd', label: 'CMD', data: { terminalType: 'cmd' as const } });

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
    } else {
      try { await closeTerminalCmd(sessionId); } catch (err) { console.error(err); }
      removeSession(sessionId);
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

  const handleCloseGroup = async (groupName: string, groupSessions: typeof sessions) => {
    setConfirmDialog({
      title: '确认关闭分组',
      message: `确定要关闭分组「${groupName}」中的所有 ${groupSessions.length} 个终端吗？`,
      onConfirm: async () => {
        setConfirmDialog(null);
        const store = useAppStore.getState();
        for (const session of groupSessions) {
          if (session.sessionType !== 'editor') {
            try { await closeTerminalCmd(session.id); } catch (err) { console.error(err); }
          } else {
            const isDraft = session.profileId.includes('\\drafts\\draft_') || session.profileId.includes('/drafts/draft_');
            if (isDraft) store.removeDraftFile(session.profileId);
          }
          removeSession(session.id);
        }
      },
    });
  };

  const handleCloseAllTabs = () => {
    if (sessions.length === 0) return;
    const hasDirty = sessions.some(s => s.sessionType === 'editor' && s.isDirty);
    setConfirmDialog({
      title: '确认关闭所有标签',
      message: hasDirty
        ? `有未保存的文件更改，确定关闭所有 ${sessions.length} 个标签吗？`
        : `确定关闭所有 ${sessions.length} 个标签吗？`,
      onConfirm: async () => {
        setConfirmDialog(null);
        const store = useAppStore.getState();
        for (const session of sessions) {
          if (session.sessionType !== 'editor') {
            try { await closeTerminalCmd(session.id); } catch (err) { console.error(err); }
          } else {
            const isDraft = session.profileId.includes('\\drafts\\draft_') || session.profileId.includes('/drafts/draft_');
            if (isDraft) store.removeDraftFile(session.profileId);
          }
        }
        store.setSessions([]);
        setShowContextMenu(false);
      },
    });
  };

  const handleContentContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.tab-sidebar-item')) return;
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
            else if (d.terminalType) onStartBlankTerminalRef.current(d.terminalType as 'powershell' | 'cmd');
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
    const items = submenuRef.current.querySelectorAll('.submenu-item, .submenu-tree .tree-item');
    const el = items[highlightedIndex] as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  if (sessions.length === 0) return null;

  const renderGroupEnd = (item: TreeItem) => {
    if (!item.isGroup || !item.children) return null;
    // Recursively collect all session IDs from this group and its sub-groups
    const collectSessionIds = (treeItem: TreeItem): string[] => {
      const ids: string[] = [];
      if (!treeItem.isGroup && treeItem.id) ids.push(treeItem.id);
      for (const child of (treeItem.children || [])) {
        ids.push(...collectSessionIds(child));
      }
      return ids;
    };
    const allSessionIds = collectSessionIds(item);
    const groupSessions = sessions.filter(s => allSessionIds.includes(s.id));
    return (
      <span className="tree-item-end">
        <span className="tree-item-count">{groupSessions.length}</span>
        <button
          className="tree-item-close"
          onClick={(e) => { e.stopPropagation(); handleCloseGroup(item.id, groupSessions); }}
          title="关闭分组内所有终端"
        >
          ×
        </button>
      </span>
    );
  };

  const renderGroupRecursive = (item: TreeItem, depth: number) => {
    if (!item.isGroup && !item.children?.length) return null;
    const indent = 8 + depth * 12;
    const isCollapsed = collapsedGroups.has(item.id);

    return (
      <div key={item.id}>
        <div
          className="tree-item"
          style={{ paddingLeft: `${indent}px` }}
          onClick={() => {
            setCollapsedGroups(prev => {
              const next = new Set(prev);
              if (next.has(item.id)) next.delete(item.id);
              else next.add(item.id);
              return next;
            });
          }}
        >
          <span className={`tree-arrow${isCollapsed ? '' : ' expanded'}`}>
            ▶
          </span>
          <span className="tree-name" style={{ fontWeight: 600 }}>{item.label}</span>
          {renderGroupEnd(item)}
        </div>
        {!isCollapsed && item.children?.map((child) => {
          if (child.isGroup || (child.children && child.children.length > 0)) {
            return renderGroupRecursive(child, depth + 1);
          }
          // Leaf node: session
          return (
            <div key={child.id}>
              {renamingSessionId === child.id ? (
                <div className="tree-item" style={{ paddingLeft: `${indent + 12}px` }}>
                  {child.icon || (
                    <span
                      className={`tab-sidebar-dot${workingSessions[child.id] ? ' working' : ''}`}
                      style={{ background: getWorkingDotColor(workingSessions[child.id], (child.data as any)?.tabColor) }}
                    />
                  )}
                  <input
                    ref={renameInputRef}
                    className="tree-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => {
                      const trimmed = renameValue.trim();
                      if (trimmed && trimmed !== child.label) renameSession(child.id, trimmed);
                      setRenamingSessionId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const trimmed = renameValue.trim();
                        if (trimmed && trimmed !== child.label) renameSession(child.id, trimmed);
                        setRenamingSessionId(null);
                      } else if (e.key === 'Escape') {
                        setRenamingSessionId(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              ) : (
                <div
                  className={`tree-item tab-sidebar-item ${activeSessionId === child.id ? 'active' : ''}`}
                  style={{ paddingLeft: `${indent + 12}px` }}
                  onClick={() => setActiveSession(child.id)}
                  onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); handleCloseTerminal(child.id); } }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTabContextMenu({ x: e.clientX, y: e.clientY, sessionId: child.id });
                  }}
                >
                  {child.icon || (
                    <span
                      className={`tab-sidebar-dot${workingSessions[child.id] ? ' working' : ''}`}
                      style={{ background: getWorkingDotColor(workingSessions[child.id], (child.data as any)?.tabColor) }}
                    />
                  )}
                  <span className="tree-name" style={(child.data as any)?.tabColor ? { color: (child.data as any).tabColor } : undefined}>{child.label}</span>
                  {(child.data as any)?.owner === 'web' && <span className="tab-sidebar-owner-badge">Web</span>}
                  <span className="tree-item-end">
                    <button
                      className="tree-item-close"
                      onClick={(e) => { e.stopPropagation(); handleCloseTerminal(child.id); }}
                      title="关闭"
                    >
                      ×
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

  return (
    <div className="tab-sidebar" style={{ width }} ref={containerRef}>
      <div className="panel-titlebar">
        <span className="panel-title">标签导航</span>
        <span className="panel-title-count">{sessions.length}</span>
      </div>
      <div className="tab-sidebar-header">
        <input
          className="tab-sidebar-search"
          type="text"
          placeholder="搜索标签..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {settingsTabOpen && (
          <div
            className={`tab-sidebar-settings-btn active`}
            onClick={openSettingsTab}
            title="设置"
          >
            <span className="tab-sidebar-dot" style={{ background: 'var(--accent)' }} />
            <span className="tab-sidebar-name">设置</span>
          </div>
        )}
      </div>
      <div className="tab-sidebar-content" onContextMenu={handleContentContextMenu}>
        {sessionTree.map((group) => renderGroupRecursive(group, 0))}
      </div>
      <div
        className={`tab-sidebar-resize ${isResizing ? 'active' : ''}`}
        onMouseDown={resizeHandleProps.onMouseDown}
      />
      {tabContextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setTabContextMenu(null)} />
          <div className="context-menu" style={{ left: tabContextMenu.x, top: tabContextMenu.y }}>
            <div className="context-menu-item" onClick={() => {
              const session = sessions.find(s => s.id === tabContextMenu.sessionId);
              if (session) {
                setRenameValue(session.profileName);
                setRenamingSessionId(session.id);
                setTimeout(() => renameInputRef.current?.select(), 0);
              }
              setTabContextMenu(null);
            }}>重命名</div>
            <div className="context-menu-item danger" onClick={() => {
              handleCloseTerminal(tabContextMenu.sessionId);
              setTabContextMenu(null);
            }}>关闭</div>
            {sessions.find(s => s.id === tabContextMenu.sessionId)?.sessionType === 'editor' && (
              <div className="context-menu-item" onClick={() => {
                const editorSessions = sessions.filter(
                  s => s.sessionType === 'editor' && s.id !== tabContextMenu.sessionId
                );
                for (const s of editorSessions) {
                  removeSession(s.id);
                }
                setTabContextMenu(null);
              }}>关闭其它</div>
            )}
          </div>
        </>
      )}
      {showContextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setShowContextMenu(false)} />
          <div className="context-menu" ref={contextMenuRef} style={{ left: contextMenuPos.x, top: contextMenuPos.y }}>
            <div className="context-menu-item" onClick={() => { onStartBlankTerminal('powershell'); setShowContextMenu(false); }}>
              PowerShell
            </div>
            <div className="context-menu-item" onClick={() => { onStartBlankTerminal('cmd'); setShowContextMenu(false); }}>
              CMD
            </div>
            <div className="context-menu-item" onClick={() => { onStartTextEditor(); setShowContextMenu(false); }}>
              文本编辑器
            </div>
            <div className="context-menu-item has-submenu">
              <span>新建配置终端</span>
              <span className="submenu-arrow">›</span>
              <div
                className="context-submenu"
                ref={submenuRef}
                style={{ maxHeight: `${Math.max(200, window.innerHeight - contextMenuPos.y - 16)}px` }}
              >
                <TreeView
                  items={submenuTree}
                  expandedIds={submenuExpandedGroups}
                  onToggle={(id) => {
                    setSubmenuExpandedGroups(prev => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    });
                  }}
                  selectedId={highlightedIndex >= 0 ? visibleSubmenuItems[highlightedIndex]?.id : undefined}
                  onSelect={(item) => {
                    if (item.data) {
                      const d = item.data as Record<string, unknown>;
                      if ('group' in d) onStartTerminal(item.data as Profile);
                      else if (d.terminalType) onStartBlankTerminal(d.terminalType as 'powershell' | 'cmd');
                      setShowContextMenu(false);
                    }
                  }}
                  className="submenu-tree"
                  indent={12}
                />
              </div>
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item danger" onClick={handleCloseAllTabs}>
              关闭所有标签
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={() => {
              setShowContextMenu(false);
              const s = getAppSettings();
              saveAppSettings({ ...s, enableTabNavigation: false });
              saveEnableTabNavigation(false).catch(console.error);
              window.dispatchEvent(new CustomEvent('tab-navigation-changed'));
            }}>禁用标签导航</div>
          </div>
        </>
      )}
      {confirmDialog && (
        <div className="confirm-dialog-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{confirmDialog.title}</div>
            <div className="confirm-dialog-message">{confirmDialog.message}</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={() => setConfirmDialog(null)}>取消</button>
              <button className="btn-danger" onClick={confirmDialog.onConfirm}>确定</button>
            </div>
          </div>
        </div>
      )}
      {draftCloseDialog && (
        <div className="confirm-dialog-overlay" onClick={() => setDraftCloseDialog(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">草稿有未保存的内容</div>
            <div className="confirm-dialog-message">是否保存此草稿？</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={() => setDraftCloseDialog(null)}>取消</button>
              <button className="btn-danger" onClick={handleDraftDiscard}>不保存</button>
              <button className="btn-primary" onClick={handleDraftSaveAs}>另存为...</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
