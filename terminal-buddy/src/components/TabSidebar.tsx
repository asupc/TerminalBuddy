import { FC, useState, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { closeTerminal as closeTerminalCmd, saveTabSidebarWidth, getBackendAppSettings, saveEnableTabNavigation } from '../services/tauri';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { getAppSettings, saveAppSettings } from '../utils/settings';
import { getWorkingDotColor } from '../utils/tabColor';
import { TreeView, type TreeItem } from './TreeView';
import type { Profile } from '../types';
import './TabSidebar.css';

interface TabSidebarProps {
  profiles: Profile[];
  onStartTerminal: (profile: Profile) => void;
  onStartBlankTerminal: (terminalType: 'powershell' | 'cmd') => void;
}

export const TabSidebar: FC<TabSidebarProps> = ({ profiles, onStartTerminal, onStartBlankTerminal }) => {
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
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  highlightedIndexRef.current = highlightedIndex;
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [submenuExpandedGroups, setSubmenuExpandedGroups] = useState<Set<string>>(new Set());
  const [, setSettingsTick] = useState(0);
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

  // Build tree for active sessions grouped by profile group
  const sessionTree = useMemo(() => {
    const groupMap = new Map<string, typeof sessions>();
    for (const session of sessions) {
      let groupName: string;
      if (session.sessionType === 'editor') {
        groupName = '文本编辑';
      } else {
        const profile = profiles.find(p => p.id === session.profileId);
        groupName = profile?.group || '默认';
      }
      if (!groupMap.has(groupName)) groupMap.set(groupName, []);
      groupMap.get(groupName)!.push(session);
    }
    return Array.from(groupMap.entries())
      .filter(([, s]) => s.length > 0)
      .sort(([a], [b]) => a.localeCompare(b, 'zh'))
      .map(([groupName, groupSessions]): TreeItem => ({
        id: groupName,
        label: groupName,
        isGroup: true,
        children: groupSessions.map((session): TreeItem => {
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
      }));
  }, [sessions, profiles, workingSessions, settingsVersion]);

  // Build submenu tree: PowerShell/CMD always visible, then groups collapsed
  const submenuTree = useMemo(() => {
    const groupMap = new Map<string, Profile[]>();
    for (const p of profiles) {
      const g = p.group || '默认';
      if (!groupMap.has(g)) groupMap.set(g, []);
      groupMap.get(g)!.push(p);
    }
    const groups = Array.from(groupMap.entries())
      .sort(([a], [b]) => a.localeCompare(b, 'zh'))
      .map(([groupName, groupProfiles]): TreeItem => ({
        id: groupName,
        label: groupName,
        isGroup: true,
        children: groupProfiles.map((p): TreeItem => ({
          id: p.id,
          label: p.name,
          data: p,
        })),
      }));

    // Prepend PowerShell/CMD items (not in a group)
    return groups;
  }, [profiles]);

  // Flatten expanded items for keyboard nav
  const visibleSubmenuItems = useMemo(() => {
    const result: TreeItem[] = [];
    // PowerShell
    result.push({ id: 'powershell', label: 'PowerShell', data: { terminalType: 'powershell' as const } });
    // CMD
    result.push({ id: 'cmd', label: 'CMD', data: { terminalType: 'cmd' as const } });
    // Groups and their children
    for (const group of submenuTree) {
      result.push(group);
      if (submenuExpandedGroups.has(group.id)) {
        for (const child of (group.children || [])) {
          result.push(child);
        }
      }
    }
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

  const handleCloseGroup = async (groupName: string, groupSessions: typeof sessions) => {
    setConfirmDialog({
      title: '确认关闭分组',
      message: `确定要关闭分组「${groupName}」中的所有 ${groupSessions.length} 个终端吗？`,
      onConfirm: async () => {
        setConfirmDialog(null);
        for (const session of groupSessions) {
          try { await closeTerminalCmd(session.id); } catch (err) { console.error(err); }
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
        for (const session of sessions) {
          if (session.sessionType !== 'editor') {
            try { await closeTerminalCmd(session.id); } catch (err) { console.error(err); }
          }
        }
        useAppStore.getState().setSessions([]);
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
    const groupSessions = sessions.filter(s =>
      item.children!.some(c => c.id === s.id)
    );
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

  return (
    <div className="tab-sidebar" style={{ width }}>
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
        {sessionTree.map((group) => (
          <div key={group.id}>
            <div
              className="tree-item"
              style={{ paddingLeft: '8px' }}
              onClick={() => {
                setCollapsedGroups(prev => {
                  const next = new Set(prev);
                  if (next.has(group.id)) next.delete(group.id);
                  else next.add(group.id);
                  return next;
                });
              }}
            >
              <span className={`tree-arrow${collapsedGroups.has(group.id) ? '' : ' expanded'}`}>
                ▶
              </span>
              <span className="tree-name" style={{ fontWeight: 600 }}>{group.label}</span>
              {renderGroupEnd(group)}
            </div>
            {!collapsedGroups.has(group.id) && group.children?.map((child) => (
              <div key={child.id}>
                {renamingSessionId === child.id ? (
                  <div className="tree-item" style={{ paddingLeft: '20px' }}>
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
                    style={{ paddingLeft: '20px' }}
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
            ))}
          </div>
        ))}
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
            <div className="context-menu-item has-submenu">
              <span>添加连接</span>
              <span className="submenu-arrow">›</span>
              <div
                className="context-submenu"
                ref={submenuRef}
                style={{ maxHeight: `${Math.max(200, window.innerHeight - contextMenuPos.y - 16)}px` }}
              >
                {/* PowerShell / CMD — always at top */}
                <div
                  className={`context-menu-item submenu-item ${highlightedIndex === 0 ? 'highlighted' : ''}`}
                  onClick={() => { onStartBlankTerminal('powershell'); setShowContextMenu(false); }}
                  onMouseEnter={() => setHighlightedIndex(0)}
                >
                  PowerShell
                </div>
                <div
                  className={`context-menu-item submenu-item ${highlightedIndex === 1 ? 'highlighted' : ''}`}
                  onClick={() => { onStartBlankTerminal('cmd'); setShowContextMenu(false); }}
                  onMouseEnter={() => setHighlightedIndex(1)}
                >
                  CMD
                </div>
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
    </div>
  );
};
