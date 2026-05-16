import { FC, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { closeTerminal as closeTerminalCmd, saveTabSidebarWidth, getBackendAppSettings, saveEnableTabNavigation } from '../services/tauri';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { getAppSettings, saveAppSettings } from '../utils/settings';
import type { Profile } from '../types';
import './TabSidebar.css';

interface SubmenuItem {
  label: string;
  profile?: Profile;
  terminalType?: 'powershell' | 'cmd';
  isGroupHeader?: boolean;
}

interface TabSidebarProps {
  profiles: Profile[];
  onStartTerminal: (profile: Profile) => void;
  onStartBlankTerminal: (terminalType: 'powershell' | 'cmd') => void;
}

export const TabSidebar: FC<TabSidebarProps> = ({ profiles, onStartTerminal, onStartBlankTerminal }) => {
  const { sessions, activeSessionId, removeSession, setActiveSession } = useAppStore();
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  const { width, setWidth, isResizing, resizeHandleProps } = useResizablePanel({
    defaultWidth: 200,
    minWidth: 150,
    maxWidth: 400,
    onResizeEnd: (w) => { saveTabSidebarWidth(w).catch(console.error); },
  });

  useEffect(() => {
    getBackendAppSettings().then(s => setWidth(s.tabSidebarWidth || 200)).catch(() => {});
  }, []);

  const profileGroups = useMemo(() => {
    const groupMap = new Map<string, { name: string; sessions: typeof sessions }>();
    const profileGroupNames = new Set(profiles.map(p => p.group || '默认'));

    for (const name of profileGroupNames) {
      groupMap.set(name, { name, sessions: [] });
    }

    for (const session of sessions) {
      const profile = profiles.find(p => p.id === session.profileId);
      const groupName = profile?.group || '默认';
      if (!groupMap.has(groupName)) {
        groupMap.set(groupName, { name: groupName, sessions: [] });
      }
      groupMap.get(groupName)!.sessions.push(session);
    }

    return Array.from(groupMap.values()).filter(g => g.sessions.length > 0);
  }, [sessions, profiles]);

  const filteredGroups = useMemo(() => {
    if (!search) return profileGroups;
    const q = search.toLowerCase();
    return profileGroups.map(g => ({
      ...g,
      sessions: g.sessions.filter(s => s.profileName.toLowerCase().includes(q)),
    })).filter(g => g.sessions.length > 0);
  }, [profileGroups, search]);

  const menuProfileGroups = useMemo(() => {
    const map = new Map<string, Profile[]>();
    for (const p of profiles) {
      const g = p.group || '默认';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(p);
    }
    return Array.from(map.entries()).map(([name, profs]) => ({ name, profiles: profs }));
  }, [profiles]);

  // Flatten submenu items for keyboard navigation
  const submenuItems = useMemo<SubmenuItem[]>(() => {
    const items: SubmenuItem[] = [
      { label: 'PowerShell', terminalType: 'powershell' },
      { label: 'CMD', terminalType: 'cmd' },
    ];
    for (const group of menuProfileGroups) {
      items.push({ label: group.name, isGroupHeader: true });
      for (const profile of group.profiles) {
        items.push({ label: profile.name, profile });
      }
    }
    return items;
  }, [menuProfileGroups]);

  // Only actionable items (not group headers)
  const actionableItems = useMemo(() => submenuItems.filter(i => !i.isGroupHeader), [submenuItems]);

  const handleCloseTerminal = async (sessionId: string) => {
    try { await closeTerminalCmd(sessionId); } catch (err) { console.error(err); }
    removeSession(sessionId);
  };

  const handleCloseGroup = async (group: { name: string; sessions: typeof sessions }) => {
    setConfirmDialog({
      title: '确认关闭分组',
      message: `确定要关闭分组「${group.name}」中的所有 ${group.sessions.length} 个终端吗？`,
      onConfirm: async () => {
        setConfirmDialog(null);
        for (const session of group.sessions) {
          try { await closeTerminalCmd(session.id); } catch (err) { console.error(err); }
          removeSession(session.id);
        }
      },
    });
  };

  const handleCloseAllTabs = () => {
    if (sessions.length === 0) return;
    setConfirmDialog({
      title: '确认关闭所有标签',
      message: `确定关闭所有 ${sessions.length} 个标签吗？`,
      onConfirm: async () => {
        setConfirmDialog(null);
        for (const session of sessions) {
          try { await closeTerminalCmd(session.id); } catch (err) { console.error(err); }
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
  };

  // Execute a submenu action
  const executeSubmenuItem = useCallback((item: SubmenuItem) => {
    if (item.terminalType) {
      onStartBlankTerminal(item.terminalType);
    } else if (item.profile) {
      onStartTerminal(item.profile);
    }
    setShowContextMenu(false);
  }, [onStartTerminal, onStartBlankTerminal]);

  // Close context menu on outside mouse/keyboard/wheel
  useEffect(() => {
    if (!showContextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.context-menu')) return;
      setShowContextMenu(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowContextMenu(false);
        return;
      }
      // Arrow keys / Enter for submenu navigation
      if (['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
        e.preventDefault();
        if (e.key === 'ArrowDown') {
          setHighlightedIndex(prev => {
            let next = prev + 1;
            while (next < actionableItems.length && actionableItems[next]?.isGroupHeader) next++;
            return next >= actionableItems.length ? 0 : next;
          });
        } else if (e.key === 'ArrowUp') {
          setHighlightedIndex(prev => {
            let next = prev - 1;
            while (next >= 0 && actionableItems[next]?.isGroupHeader) next--;
            return next < 0 ? actionableItems.length - 1 : next;
          });
        } else if (e.key === 'Enter' && highlightedIndex >= 0 && highlightedIndex < actionableItems.length) {
          executeSubmenuItem(actionableItems[highlightedIndex]);
        }
        return;
      }
      // Any other key closes the menu
      setShowContextMenu(false);
    };
    const handleWheel = (e: WheelEvent) => {
      // Allow scrolling inside the submenu
      if ((e.target as HTMLElement).closest('.context-submenu')) return;
      setShowContextMenu(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('wheel', handleWheel);
    };
  }, [showContextMenu, highlightedIndex, actionableItems, executeSubmenuItem]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex < 0 || !submenuRef.current) return;
    const actionable = submenuRef.current.querySelectorAll('.context-menu-item:not(.submenu-group-header)');
    const el = actionable[highlightedIndex] as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  if (sessions.length === 0) return null;

  // Map actionable index back to submenu index for rendering
  let actionIdx = 0;

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
      </div>
      <div className="tab-sidebar-content" onContextMenu={handleContentContextMenu}>
        {filteredGroups.map((group) => {
          const isCollapsed = collapsedGroups.has(group.name);
          return (
          <div key={group.name} className="tab-sidebar-group">
            <div
              className="tab-sidebar-group-header"
              onClick={() => {
                setCollapsedGroups(prev => {
                  const next = new Set(prev);
                  if (next.has(group.name)) next.delete(group.name);
                  else next.add(group.name);
                  return next;
                });
              }}
            >
              <span className={`tab-sidebar-group-arrow ${isCollapsed ? 'collapsed' : ''}`}>▾</span>
              <span className="tab-sidebar-group-name">{group.name}</span>
              <span className="tab-sidebar-group-count">{group.sessions.length}</span>
              <button
                className="tab-sidebar-group-close"
                onClick={(e) => { e.stopPropagation(); handleCloseGroup(group); }}
                title="关闭分组内所有终端"
              >
                ×
              </button>
            </div>
            {!isCollapsed && group.sessions.map((session) => (
              <div
                key={session.id}
                className={`tab-sidebar-item ${activeSessionId === session.id ? 'active' : ''}`}
                onClick={() => setActiveSession(session.id)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); handleCloseTerminal(session.id); } }}
              >
                <span
                  className="tab-sidebar-dot"
                  style={{ background: session.tabColor || 'var(--accent)' }}
                />
                <span className="tab-sidebar-name">{session.profileName}</span>
                <button
                  className="tab-sidebar-close"
                  onClick={(e) => { e.stopPropagation(); handleCloseTerminal(session.id); }}
                  title="关闭"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          );
        })}
      </div>
      <div
        className={`tab-sidebar-resize ${isResizing ? 'active' : ''}`}
        onMouseDown={resizeHandleProps.onMouseDown}
      />
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
                {submenuItems.map((item, idx) => {
                  if (item.isGroupHeader) {
                    return (
                      <div key={`sep-${item.label}`}>
                        <div className="context-menu-separator" />
                        <div className="context-menu-item submenu-group-header">{item.label}</div>
                      </div>
                    );
                  }
                  const currentActionIdx = actionIdx++;
                  return (
                    <div
                      key={item.profile?.id || item.terminalType || idx}
                      className={`context-menu-item ${highlightedIndex === currentActionIdx ? 'highlighted' : ''}`}
                      onClick={() => executeSubmenuItem(item)}
                      onMouseEnter={() => setHighlightedIndex(currentActionIdx)}
                    >
                      {item.label}
                    </div>
                  );
                })}
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
              saveEnableTabNavigation(false).catch(() => {});
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
