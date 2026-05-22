import React, { FC, useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { deleteProfile as deleteProfileCmd, getAllProfiles, updateProfile } from '../services/tauri';
import type { Profile } from '../types';
import { TreeView, type TreeItem } from './TreeView';
import './ConfigPanel.css';

const TYPE_ICONS: Record<string, string> = {
  powershell: 'PS', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S',
};

interface ConfigPanelProps {
  onStartTerminal: (profile: Profile, extraParams?: string) => void;
  onEditProfile: (profile: Profile) => void;
  onCopyProfile: (profile: Profile) => void;
  onAddProfile: () => void;
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
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);

  // Build tree items: groups -> profiles
  const treeItems = useMemo(() => {
    const groupMap = new Map<string, Profile[]>();
    let filtered = profiles;

    if (configSearchQuery.trim()) {
      const query = configSearchQuery.toLowerCase();
      filtered = profiles.filter(p => p.name.toLowerCase().includes(query));
    }

    filtered.forEach((p) => {
      const group = p.group || '默认';
      if (!groupMap.has(group)) groupMap.set(group, []);
      groupMap.get(group)!.push(p);
    });

    // Sort profiles within each group
    groupMap.forEach((groupProfiles) => {
      groupProfiles.sort((a, b) => {
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
    });

    return Array.from(groupMap.entries())
      .sort(([a], [b]) => a.localeCompare(b, 'zh'))
      .map(([groupName, groupProfiles]): TreeItem => ({
        id: groupName,
        label: groupName,
        isGroup: true,
        children: groupProfiles.map((p): TreeItem => ({
          id: p.id,
          label: p.name,
          icon: <span className="config-icon-type">{TYPE_ICONS[p.terminalType] || p.terminalType.toUpperCase()}</span>,
          color: p.tabColor || undefined,
          data: p,
        })),
      }));
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

  const handleStartRename = (group: string) => {
    setRenamingGroup(group);
    setNewGroupName(group);
    setGroupContextMenu(null);
  };

  const handleFinishRename = async (oldGroup: string) => {
    const trimmed = newGroupName.trim();
    setRenamingGroup(null);
    if (!trimmed || trimmed === oldGroup) return;
    try {
      for (const p of profiles) {
        if ((p.group || '默认') === oldGroup) {
          await updateProfile({ ...p, group: trimmed });
        }
      }
      const data = await getAllProfiles();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to rename group:', err);
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
        {renamingGroup ? (
          <div className="config-group-rename-row">
            <input
              className="tree-rename-input"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleFinishRename(renamingGroup);
                if (e.key === 'Escape') setRenamingGroup(null);
              }}
              onBlur={() => handleFinishRename(renamingGroup)}
              autoFocus
            />
          </div>
        ) : (
          <TreeView
            items={treeItems}
            expandedIds={expandedGroups}
            onToggle={handleToggle}
            selectedId={selectedProfileId}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleItemContextMenu}
          />
        )}
        {profiles.length === 0 && (
          <div className="empty-state">暂无连接，点击新建</div>
        )}
      </div>

      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => {
            onStartTerminal(profiles.find((p) => p.id === contextMenu.profileId)!);
            closeContextMenu();
          }}>启动</div>
          {extraParamPresets.map((preset) => (
            <div key={preset.id} className="context-menu-item" onClick={() => {
              onStartTerminal(profiles.find((p) => p.id === contextMenu.profileId)!, preset.params);
              closeContextMenu();
            }}>
              启动[<span style={{ color: '#FFD700' }}>{preset.name}</span>]
            </div>
          ))}
          <div className="context-menu-item" onClick={() => {
            onEditProfile(profiles.find((p) => p.id === contextMenu.profileId)!);
            closeContextMenu();
          }}>编辑</div>
          <div className="context-menu-item" onClick={() => {
            onCopyProfile(profiles.find((p) => p.id === contextMenu.profileId)!);
            closeContextMenu();
          }}>复制</div>
          <div className="context-menu-item danger" onClick={() => {
            handleDeleteProfile(contextMenu.profileId);
            closeContextMenu();
          }}>删除</div>
        </div>
      )}

      {groupContextMenu && (
        <div className="context-menu" style={{ left: groupContextMenu.x, top: groupContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => { onAddProfile(); closeContextMenu(); }}>
            添加连接
          </div>
          <div className="context-menu-item" onClick={() => handleStartRename(groupContextMenu.group)}>
            重命名分组
          </div>
        </div>
      )}

      {blankContextMenu && (
        <div className="context-menu" style={{ left: blankContextMenu.x, top: blankContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => { onAddProfile(); closeContextMenu(); }}>
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
