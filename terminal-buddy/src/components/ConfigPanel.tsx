import React, { FC, useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { deleteProfile as deleteProfileCmd, getAllProfiles, updateProfile } from '../services/tauri';
import type { Profile } from '../types';
import './ConfigPanel.css';

interface ConfigPanelProps {
  onStartTerminal: (profile: Profile) => void;
  onEditProfile: (profile: Profile) => void;
  onCopyProfile: (profile: Profile) => void;
  onAddProfile: () => void;
}

export const ConfigPanel: FC<ConfigPanelProps> = ({
  onStartTerminal,
  onEditProfile,
  onCopyProfile,
  onAddProfile,
}) => {
  const { profiles, selectedProfileId, selectProfile, removeProfile, setProfiles, configPanelVisible, configSearchQuery, configSortBy, setConfigSearchQuery, setConfigSortBy } = useAppStore();
  const [width, setWidth] = useState(250);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(['默认'])
  );
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    profileId: string;
  } | null>(null);
  const [groupContextMenu, setGroupContextMenu] = useState<{
    x: number;
    y: number;
    group: string;
  } | null>(null);
  const [blankContextMenu, setBlankContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);

  const groupedProfiles = useMemo(() => {
    const groups: Record<string, Profile[]> = {};
    let filtered = profiles;

    if (configSearchQuery.trim()) {
      const query = configSearchQuery.toLowerCase();
      filtered = profiles.filter(p => p.name.toLowerCase().includes(query));
    }

    filtered.forEach((p) => {
      const group = p.group || '默认';
      if (!groups[group]) groups[group] = [];
      groups[group].push(p);
    });

    Object.values(groups).forEach(groupProfiles => {
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

    return groups;
  }, [profiles, configSearchQuery, configSortBy]);

  const toggleGroup = (group: string) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(group)) {
      newExpanded.delete(group);
    } else {
      newExpanded.add(group);
    }
    setExpandedGroups(newExpanded);
  };

  const handleContextMenu = (e: React.MouseEvent, profileId: string) => {
    e.preventDefault();
    selectProfile(profileId);
    setContextMenu({ x: e.clientX, y: e.clientY, profileId });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
    setGroupContextMenu(null);
    setBlankContextMenu(null);
    setSortDropdownOpen(false);
  };

  useEffect(() => {
    if (!contextMenu && !groupContextMenu && !blankContextMenu) return;
    const close = () => closeContextMenu();
    const handleClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.context-menu')) return;
      close();
    };
    const handleKey = () => close();
    const handleWheel = () => close();
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    document.addEventListener('wheel', handleWheel);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('wheel', handleWheel);
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

  const cancelDeleteProfile = () => {
    setConfirmDelete(null);
  };

  const handleGroupContextMenu = (e: React.MouseEvent, group: string) => {
    e.preventDefault();
    e.stopPropagation();
    setGroupContextMenu({ x: e.clientX, y: e.clientY, group });
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
      const groupProfiles = groupedProfiles[oldGroup] || [];
      for (const profile of groupProfiles) {
        await updateProfile({ ...profile, group: trimmed });
      }
      const data = await getAllProfiles();
      setProfiles(data);
      // Update expanded groups key
      const newExpanded = new Set(expandedGroups);
      if (newExpanded.has(oldGroup)) {
        newExpanded.delete(oldGroup);
        newExpanded.add(trimmed);
      }
      setExpandedGroups(newExpanded);
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
        if (newWidth >= 150 && newWidth <= 500) {
          setWidth(newWidth);
        }
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
                ['name-asc', '名称 A-Z'],
                ['name-desc', '名称 Z-A'],
                ['recent', '最近使用'],
                ['oldest', '最久未用'],
                ['created-new', '创建 新→旧'],
                ['created-old', '创建 旧→新'],
              ] as const).map(([key, label]) => (
                <div
                  key={key}
                  className={`config-sort-option ${configSortBy === key ? 'active' : ''}`}
                  onClick={() => {
                    setConfigSortBy(key);
                    setSortDropdownOpen(false);
                  }}
                >
                  {label}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="config-list" onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.config-item') || (e.target as HTMLElement).closest('.group-header')) return;
        e.preventDefault();
        setBlankContextMenu({ x: e.clientX, y: e.clientY });
      }}>
        {Object.entries(groupedProfiles).sort(([a], [b]) => a.localeCompare(b, 'zh')).map(([group, groupProfiles]) => (
          <div key={group} className="config-group">
            <div
              className="group-header"
              onClick={() => toggleGroup(group)}
              onContextMenu={(e) => handleGroupContextMenu(e, group)}
            >
              <span className="group-icon">
                {expandedGroups.has(group) ? '▼' : '▶'}
              </span>
              {renamingGroup === group ? (
                <input
                  className="group-rename-input"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleFinishRename(group);
                    if (e.key === 'Escape') setRenamingGroup(null);
                  }}
                  onBlur={() => handleFinishRename(group)}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="group-name">{group}</span>
              )}
              <span className="group-count">{groupProfiles.length}</span>
            </div>
            {expandedGroups.has(group) && (
              <div className="group-items">
                {groupProfiles.map((profile) => (
                  <div
                    key={profile.id}
                    className={`config-item ${
                      selectedProfileId === profile.id ? 'selected' : ''
                    }`}
                    onClick={() => selectProfile(profile.id)}
                    onDoubleClick={() => onStartTerminal(profile)}
                    onContextMenu={(e) => handleContextMenu(e, profile.id)}
                  >
                    <span className="config-icon">
                      {{ powershell: 'PS', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S' }[profile.terminalType] || profile.terminalType.toUpperCase()}
                    </span>
                    <span className="config-name" style={profile.tabColor ? { color: profile.tabColor } : undefined}>{profile.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {profiles.length === 0 && (
          <div className="empty-state">暂无连接，点击新建</div>
        )}
      </div>

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              onStartTerminal(profiles.find((p) => p.id === contextMenu.profileId)!);
              closeContextMenu();
            }}
          >
            启动
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onEditProfile(profiles.find((p) => p.id === contextMenu.profileId)!);
              closeContextMenu();
            }}
          >
            编辑
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onCopyProfile(profiles.find((p) => p.id === contextMenu.profileId)!);
              closeContextMenu();
            }}
          >
            复制
          </div>
          <div
            className="context-menu-item danger"
            onClick={() => {
              handleDeleteProfile(contextMenu.profileId);
              closeContextMenu();
            }}
          >
            删除
          </div>
        </div>
      )}

      {groupContextMenu && (
        <div
          className="context-menu"
          style={{ left: groupContextMenu.x, top: groupContextMenu.y }}
        >
          <div
            className="context-menu-item"
            onClick={() => handleStartRename(groupContextMenu.group)}
          >
            重命名分组
          </div>
        </div>
      )}

      {blankContextMenu && (
        <div
          className="context-menu"
          style={{ left: blankContextMenu.x, top: blankContextMenu.y }}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              onAddProfile();
              closeContextMenu();
            }}
          >
            添加连接
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="confirm-dialog-overlay" onClick={cancelDeleteProfile}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">确认删除</div>
            <div className="confirm-dialog-message">确定要删除此连接吗？</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={cancelDeleteProfile}>
                取消
              </button>
              <button className="btn-danger" onClick={confirmDeleteProfile}>
                删除
              </button>
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
