import React, { FC, useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { deleteProfile as deleteProfileCmd, getAllProfiles, updateProfile, saveConfigNavWidth, getBackendAppSettings, openInExplorer } from '../services/tauri';
import { openTerminalInDir } from '../utils/openTerminalInDir';
import type { Profile } from '../types';
import { TreeView, type TreeItem } from './TreeView';
import { buildGroupTree, renameGroupInPath } from '../utils/groupTree';
import './ConfigNav.css';

const TYPE_ICONS: Record<string, string> = {
  powershell: 'PS', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S', mstsc: 'RDP',
};

/** 虚拟置顶分组 id：置顶的配置聚合到此分组，永远显示在列表最顶部 */
const PINNED_GROUP_ID = '__pinned__';
const CONTEXT_MENU_MARGIN = 8;

interface ConfigPanelProps {
  onStartTerminal: (profile: Profile, extraParams?: string, presetName?: string) => void;
  onEditProfile: (profile: Profile) => void;
  onCopyProfile: (profile: Profile) => void;
  onAddProfile: (defaultGroup?: string) => void;
  onManageExtraParams: () => void;
}

export const ConfigNav: FC<ConfigPanelProps> = ({
  onStartTerminal,
  onEditProfile,
  onCopyProfile,
  onAddProfile,
  onManageExtraParams,
}) => {
  const profiles = useAppStore(s => s.profiles);
  const selectedProfileId = useAppStore(s => s.selectedProfileId);
  const selectProfile = useAppStore(s => s.selectProfile);
  const removeProfile = useAppStore(s => s.removeProfile);
  const setProfiles = useAppStore(s => s.setProfiles);
  const configPanelVisible = useAppStore(s => s.configPanelVisible);
  const configSearchQuery = useAppStore(s => s.configSearchQuery);
  const configSortBy = useAppStore(s => s.configSortBy);
  const setConfigSearchQuery = useAppStore(s => s.setConfigSearchQuery);
  const setConfigSortBy = useAppStore(s => s.setConfigSortBy);
  const extraParamPresets = useAppStore(s => s.extraParamPresets);
  const setDragProfileId = useAppStore(s => s.setDragProfileId);
  const [width, setWidth] = useState(250);
  const widthRef = useRef(250);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  // 启动时从后端恢复宽度
  useEffect(() => {
    getBackendAppSettings().then(s => {
      const w = s.configNavWidth || 250;
      setWidth(w);
      widthRef.current = w;
    }).catch(() => {});
  }, []);
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
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [renamingProfileId, setRenamingProfileId] = useState<string | null>(null);
  const [renamingProfileName, setRenamingProfileName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);

  // Build tree items: hierarchical groups -> profiles
  const treeItems = useMemo(() => {
    let filtered = profiles;

    if (configSearchQuery.trim()) {
      const query = configSearchQuery.toLowerCase();
      filtered = profiles.filter(p => p.name.toLowerCase().includes(query));
    }

    // 置顶项单独抽出，聚合到永远位于最顶部的虚拟【置顶】分组
    const pinnedItems = filtered.filter(p => p.pinned);
    const normalItems = filtered.filter(p => !p.pinned);

    const sortProfiles = (items: Profile[]): Profile[] => {
      return items.sort((a, b) => {
        switch (configSortBy) {
          case 'name-asc': return a.name.localeCompare(b.name, 'zh');
          case 'name-desc': return b.name.localeCompare(a.name, 'zh');
          case 'recent': return (b.lastUsedAt || '').localeCompare(a.lastUsedAt || '');
          case 'oldest': return (a.lastUsedAt || '').localeCompare(b.lastUsedAt || '');
          case 'created-new': return b.createdAt.localeCompare(a.createdAt);
          case 'created-old': return a.createdAt.localeCompare(b.createdAt);
          default: return 0;
        }
      });
    };

    const toLeaf = (p: Profile): TreeItem => ({
      id: p.id,
      label: p.name,
      icon: <span className="config-nav-icon-type">{TYPE_ICONS[p.terminalType] || p.terminalType.toUpperCase()}</span>,
      color: p.tabColor || undefined,
      data: p,
    });

    const tree = buildGroupTree<Profile>(normalItems, p => p.group || '默认', sortProfiles);

    const toTreeItems = (nodes: ReturnType<typeof buildGroupTree<Profile>>): TreeItem[] =>
      nodes.map((node): TreeItem => ({
        id: node.path,
        label: node.name,
        isGroup: true,
        children: [
          ...toTreeItems(node.children),
          ...node.items.map(toLeaf),
        ],
      }));

    const result = toTreeItems(tree);

    // 置顶分组永远在最前
    if (pinnedItems.length > 0) {
      result.unshift({
        id: PINNED_GROUP_ID,
        label: '置顶',
        isGroup: true,
        children: sortProfiles([...pinnedItems]).map(toLeaf),
      });
    }

    return result;
  }, [profiles, configSearchQuery, configSortBy]);

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
    setSortDropdownOpen(false);
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
    setSortDropdownOpen(false);
  };

  const isLocalProfile = (p: Profile) => p.terminalType === 'powershell' || p.terminalType === 'cmd';
  const hasStartupPath = (p: Profile) => !!p.startupPath && p.startupPath.trim() !== '';

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
  }, [contextMenu, groupContextMenu, blankContextMenu, adjustContextMenuPosition]);

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

  const handleStartRename = (groupPath: string) => {
    if (groupPath === PINNED_GROUP_ID) return;
    setRenamingGroup(groupPath);
    setNewGroupName(groupPath);
    setGroupContextMenu(null);
  };

  const handleFinishRename = async (oldPath: string) => {
    const trimmed = newGroupName.trim();
    setRenamingGroup(null);
    if (!trimmed || trimmed === oldPath) return;
    const newPath = trimmed.includes('/') ? trimmed : trimmed;
    try {
      for (const p of profiles) {
        const group = p.group || '默认';
        const newGroup = renameGroupInPath(group, oldPath, newPath);
        if (newGroup !== group) {
          await updateProfile({ ...p, group: newGroup });
        }
      }
      const data = await getAllProfiles();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to rename group:', err);
    }
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
        if (newWidth >= 150 && newWidth <= 500) {
          setWidth(newWidth);
          widthRef.current = newWidth;
        }
      }
    });
  }, [isResizing]);

  const handleResizeMouseUp = useCallback(() => {
    setIsResizing(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    saveConfigNavWidth(widthRef.current).catch(() => {});
  }, []);

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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      const region = useAppStore.getState().lastClickRegion;
      if (region && region !== 'config') return;
      if (!selectedProfileId) return;
      const item = findTreeItemById(treeItems, selectedProfileId);
      if (item?.isGroup || (item?.children && item.children.length > 0)) {
        handleStartRename(selectedProfileId);
      } else if (item?.data) {
        const profile = item.data as Profile;
        setRenamingProfileId(profile.id);
        setRenamingProfileName(profile.name);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selectedProfileId, treeItems]);

  return (
    <div ref={containerRef} className={`config-nav ${!configPanelVisible ? 'collapsed' : ''}`} style={{ width }} onClick={closeContextMenu}>
      <div className="panel-titlebar">
        <span className="panel-title">配置</span>
        <span className="panel-title-count">{profiles.length}</span>
      </div>
      <div className="config-nav-search-bar">
        <input
          type="text"
          className="config-nav-search-input"
          placeholder="搜索配置..."
          value={configSearchQuery}
          onChange={(e) => setConfigSearchQuery(e.target.value)}
        />
        <div className="config-nav-sort-wrapper">
          <button
            className="config-nav-sort-btn"
            onClick={() => setSortDropdownOpen(!sortDropdownOpen)}
            title="排序"
          >
            ⇅
          </button>
          {sortDropdownOpen && (
            <div className="config-nav-sort-dropdown">
              {([
                ['name-asc', '名称 A-Z'], ['name-desc', '名称 Z-A'],
                ['recent', '最近使用'], ['oldest', '最久未用'],
                ['created-new', '创建 新→旧'], ['created-old', '创建 旧→新'],
              ] as const).map(([key, label]) => (
                <div
                  key={key}
                  className={`config-nav-sort-option ${configSortBy === key ? 'active' : ''}`}
                  onClick={() => { setConfigSortBy(key); setSortDropdownOpen(false); }}
                >
                  {label}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="config-nav-list" onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.tree-item')) return;
        e.preventDefault();
        setSortDropdownOpen(false);
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
          renamingId={renamingGroup}
          renameValue={newGroupName}
          onRenameValueChange={setNewGroupName}
          onRenameSubmit={(id) => handleFinishRename(id)}
          onRenameCancel={() => setRenamingGroup(null)}
          onGroupRename={(id) => handleStartRename(id)}
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
        {profiles.length === 0 && (
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
          {extraParamPresets.map((preset) => (
            <div key={preset.id} className="context-menu-item" onClick={() => {
              const target = profiles.find((p) => p.id === contextMenu.profileId);
              if (target) onStartTerminal(target, preset.params, preset.name);
              closeContextMenu();
            }}>
              启动[<span style={{ color: '#FFD700' }}>{preset.name}</span>]
            </div>
          ))}
          <div className="context-menu-item" onClick={async () => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            closeContextMenu();
            if (target) {
              try { await openTerminalInDir(target.startupPath?.trim() || undefined); }
              catch (err) { console.error(err); }
            }
          }}>命令行</div>
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
                    try { await openInExplorer(t.startupPath!); }
                    catch (err) { console.error(err); }
                  }
                }}>打开目录</div>
                <div className="context-menu-item" onClick={() => {
                  const t = profiles.find((p) => p.id === contextMenu.profileId);
                  if (t) navigator.clipboard.writeText(t.startupPath!).catch(() => {});
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
          <div className="context-menu-item" onClick={() => { onAddProfile(groupContextMenu.group); closeContextMenu(); }}>
            添加配置
          </div>
          <div className="context-menu-item" onClick={() => { onAddProfile(groupContextMenu.group + '/新分组'); closeContextMenu(); }}>
            添加子分组
          </div>
          <div className="context-menu-item" onClick={() => handleStartRename(groupContextMenu.group)}>
            重命名分组
          </div>
        </div>
      )}

      {blankContextMenu && (
        <div ref={contextMenuRef} className="context-menu" style={{ left: blankContextMenu.x, top: blankContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => { onAddProfile('默认'); closeContextMenu(); }}>
            添加配置
          </div>
          <div className="context-menu-item" onClick={() => { onManageExtraParams(); closeContextMenu(); }}>
            添加额外参数
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="confirm-dialog-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">确认删除</div>
            <div className="confirm-dialog-message">确定要删除此配置吗？</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="btn-danger" onClick={confirmDeleteProfile}>删除</button>
            </div>
          </div>
        </div>
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

function fitContextMenuToViewport(
  anchorX: number,
  anchorY: number,
  menuWidth: number,
  menuHeight: number
): { x: number; y: number } {
  let x = anchorX;
  let y = anchorY;

  if (x + menuWidth + CONTEXT_MENU_MARGIN > window.innerWidth) {
    x = window.innerWidth - menuWidth - CONTEXT_MENU_MARGIN;
  }

  if (y + menuHeight + CONTEXT_MENU_MARGIN > window.innerHeight) {
    y = anchorY - menuHeight;
  }

  const maxX = Math.max(CONTEXT_MENU_MARGIN, window.innerWidth - menuWidth - CONTEXT_MENU_MARGIN);
  const maxY = Math.max(CONTEXT_MENU_MARGIN, window.innerHeight - menuHeight - CONTEXT_MENU_MARGIN);

  return {
    x: Math.min(Math.max(CONTEXT_MENU_MARGIN, x), maxX),
    y: Math.min(Math.max(CONTEXT_MENU_MARGIN, y), maxY),
  };
}
