import React, { FC, useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { deleteProfile as deleteProfileCmd, getAllProfiles, updateProfile } from '../services/tauri';
import type { Profile } from '../types';
import { TreeView, type TreeItem } from './TreeView';
import { buildGroupTree, renameGroupInPath } from '../utils/groupTree';
import './ConfigPanel.css';

const TYPE_ICONS: Record<string, string> = {
  powershell: 'PS', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S', mstsc: 'RDP',
};

interface ConfigPanelProps {
  onStartTerminal: (profile: Profile, extraParams?: string) => void;
  onEditProfile: (profile: Profile) => void;
  onCopyProfile: (profile: Profile) => void;
  onAddProfile: (defaultGroup?: string) => void;
  onManageExtraParams: () => void;
}

export const ConfigPanel: FC<ConfigPanelProps> = ({
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
  const [width, setWidth] = useState(250);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
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

    const tree = buildGroupTree<Profile>(filtered, p => p.group || '默认', sortProfiles);

    const toTreeItems = (nodes: ReturnType<typeof buildGroupTree<Profile>>): TreeItem[] =>
      nodes.map((node): TreeItem => ({
        id: node.path,
        label: node.name,
        isGroup: true,
        children: [
          ...toTreeItems(node.children),
          ...node.items.map((p): TreeItem => ({
            id: p.id,
            label: p.name,
            icon: <span className="config-icon-type">{TYPE_ICONS[p.terminalType] || p.terminalType.toUpperCase()}</span>,
            color: p.tabColor || undefined,
            data: p,
          })),
        ],
      }));

    return toTreeItems(tree);
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
    if (item.data) {
      const profile = item.data as Profile;
      selectProfile(profile.id);
      setContextMenu({ x: e.clientX, y: e.clientY, profileId: profile.id });
    } else if (item.isGroup) {
      setGroupContextMenu({ x: e.clientX, y: e.clientY, group: item.id });
    }
  }, [selectProfile]);

  const closeContextMenu = () => {
    setContextMenu(null);
    setGroupContextMenu(null);
    setBlankContextMenu(null);
    setSortDropdownOpen(false);
  };

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
        if (newWidth >= 150 && newWidth <= 500) setWidth(newWidth);
      }
    });
  }, [isResizing]);

  const handleResizeMouseUp = useCallback(() => {
    setIsResizing(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
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

  // F2 快速重命名分组/连接
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
    <div ref={containerRef} className={`config-panel ${!configPanelVisible ? 'collapsed' : ''}`} style={{ width }} onClick={closeContextMenu}>
      <div className="panel-titlebar">
        <span className="panel-title">连接导航</span>
        <span className="panel-title-count">{profiles.length}</span>
      </div>
      <div className="config-search-bar">
        <input
          type="text"
          className="config-search-input"
          placeholder="搜索连接..."
          value={configSearchQuery}
          onChange={(e) => setConfigSearchQuery(e.target.value)}
        />
        <div className="config-sort-wrapper">
          <button
            className="config-sort-btn"
            onClick={() => setSortDropdownOpen(!sortDropdownOpen)}
            title="排序"
          >
            ⇅
          </button>
          {sortDropdownOpen && (
            <div className="config-sort-dropdown">
              {([
                ['name-asc', '名称 A-Z'], ['name-desc', '名称 Z-A'],
                ['recent', '最近使用'], ['oldest', '最久未用'],
                ['created-new', '创建 新→旧'], ['created-old', '创建 旧→新'],
              ] as const).map(([key, label]) => (
                <div
                  key={key}
                  className={`config-sort-option ${configSortBy === key ? 'active' : ''}`}
                  onClick={() => { setConfigSortBy(key); setSortDropdownOpen(false); }}
                >
                  {label}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="config-list" onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.tree-item')) return;
        e.preventDefault();
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
        />
        {profiles.length === 0 && (
          <div className="empty-state">暂无连接，点击新建</div>
        )}
      </div>

      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            if (target) onStartTerminal(target);
            closeContextMenu();
          }}>启动</div>
          {extraParamPresets.map((preset) => (
            <div key={preset.id} className="context-menu-item" onClick={() => {
              const target = profiles.find((p) => p.id === contextMenu.profileId);
              if (target) onStartTerminal(target, preset.params);
              closeContextMenu();
            }}>
              启动[<span style={{ color: '#FFD700' }}>{preset.name}</span>]
            </div>
          ))}
          <div className="context-menu-item" onClick={() => {
            const target = profiles.find((p) => p.id === contextMenu.profileId);
            if (target) onEditProfile(target);
            closeContextMenu();
          }}>编辑</div>
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
        <div className="context-menu" style={{ left: groupContextMenu.x, top: groupContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => { onAddProfile(groupContextMenu.group); closeContextMenu(); }}>
            添加连接
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
        <div className="context-menu" style={{ left: blankContextMenu.x, top: blankContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => { onAddProfile('默认'); closeContextMenu(); }}>
            添加连接
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
            <div className="confirm-dialog-message">确定要删除此连接吗？</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="btn-danger" onClick={confirmDeleteProfile}>删除</button>
            </div>
          </div>
        </div>
      )}
      <div
        className={`config-resize-handle ${isResizing ? 'active' : ''}`}
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
