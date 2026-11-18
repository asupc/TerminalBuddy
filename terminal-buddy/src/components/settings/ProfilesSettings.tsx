import { FC, type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { FolderCog, FolderPlus, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import {
  createProfile,
  deleteProfile as deleteProfileCmd,
  getAllProfiles,
  updateProfile,
} from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { effectiveProfilePath } from '../../utils/projectPath';
import type { Profile, Project } from '../../types';
import { ConfigEditDialog } from '../profile-config/ConfigEditDialog';
import { ProjectEditDialog } from '../shared/ProjectEditDialog';
import { ProjectDeleteDialog } from '../shared/ProjectDeleteDialog';
import { showAlert } from '../../services/dialog';

interface ProfilesSettingsProps {
  askConfirm: (message: string, onConfirm: () => void) => void;
  dismissConfirm: () => void;
}

const ALL_GROUPS_ID = '__all__';

const TYPE_BADGES: Record<Profile['terminalType'], string> = {
  powershell: 'PS',
  pwsh: 'PS7',
  cmd: 'CMD',
  bash: 'BASH',
  sh: 'SH',
  zsh: 'ZSH',
  ssh: 'SSH',
  docker: 'DK',
  k8s: 'K8S',
  editor: 'ED',
  mstsc: 'RDP',
};

function formatProfileTarget(profile: Profile, projects: Project[]): string {
  if (profile.terminalType === 'ssh') {
    if (!profile.sshHost) return '未配置主机';
    const userPrefix = profile.sshUser ? `${profile.sshUser}@` : '';
    const portSuffix = profile.sshPort && profile.sshPort !== 22 ? `:${profile.sshPort}` : '';
    return `${userPrefix}${profile.sshHost}${portSuffix}`;
  }
  if (profile.terminalType === 'mstsc') {
    if (!profile.mstscHost) return '未配置主机';
    const userPrefix = profile.mstscUser ? `${profile.mstscUser}@` : '';
    const portSuffix = profile.mstscPort && profile.mstscPort !== 3389 ? `:${profile.mstscPort}` : '';
    return `${userPrefix}${profile.mstscHost}${portSuffix}`;
  }
  if (profile.terminalType === 'docker') {
    return profile.dockerContainerName || '未配置容器';
  }
  if (profile.terminalType === 'k8s') {
    if (profile.k8sNamespace) {
      return profile.k8sPodName ? `${profile.k8sNamespace} / ${profile.k8sPodName}` : profile.k8sNamespace;
    }
    return profile.k8sPodName || '未配置命名空间';
  }
  return effectiveProfilePath(profile, projects) || '未设置项目路径';
}

function matchesProfileQuery(profile: Profile, query: string, projects: Project[]): boolean {
  const q = query.toLowerCase();
  const group = (profile.group || '默认').toLowerCase();
  const type = (profile.terminalType || '').toLowerCase();
  const badge = (TYPE_BADGES[profile.terminalType] || '').toLowerCase();
  const target = formatProfileTarget(profile, projects).toLowerCase();
  return (
    profile.name.toLowerCase().includes(q)
    || group.includes(q)
    || type.includes(q)
    || badge.includes(q)
    || target.includes(q)
  );
}

export const ProfilesSettings: FC<ProfilesSettingsProps> = ({ askConfirm, dismissConfirm }) => {
  const profiles = useAppStore(state => state.profiles);
  const projects = useAppStore(state => state.projects);
  const setProfiles = useAppStore(state => state.setProfiles);
  const [search, setSearch] = useState('');
  const [groupTab, setGroupTab] = useState<string>(ALL_GROUPS_ID);
  const [showDialog, setShowDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [defaultGroupForNew, setDefaultGroupForNew] = useState<string | undefined>(undefined);
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; profile: Profile } | null>(null);
  const [groupContextMenu, setGroupContextMenu] = useState<{ x: number; y: number; group: string } | null>(null);
  const groupButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const trimmedSearch = search.trim();

  const searchMatchedProfiles = useMemo(() => {
    if (!trimmedSearch) return profiles;
    return profiles.filter(profile => matchesProfileQuery(profile, trimmedSearch, projects));
  }, [profiles, projects, trimmedSearch]);

  const groupsWithCount = useMemo(() => {
    const names = new Set<string>();
    for (const project of projects) {
      if (project.name) names.add(project.name);
    }
    for (const profile of profiles) {
      names.add(profile.group || '默认');
    }
    const countMap = new Map<string, number>();
    for (const profile of searchMatchedProfiles) {
      const group = profile.group || '默认';
      countMap.set(group, (countMap.get(group) || 0) + 1);
    }
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }))
      .map(name => ({ name, count: countMap.get(name) || 0 }));
  }, [profiles, projects, searchMatchedProfiles]);

  const filteredProfiles = useMemo(() => {
    if (groupTab === ALL_GROUPS_ID) return searchMatchedProfiles;
    return searchMatchedProfiles.filter(profile => (profile.group || '默认') === groupTab);
  }, [groupTab, searchMatchedProfiles]);

  const selectedProject = useMemo(
    () => (groupTab === ALL_GROUPS_ID ? null : projects.find(project => project.name === groupTab) ?? null),
    [groupTab, projects],
  );

  const navOrder = useMemo(
    () => [ALL_GROUPS_ID, ...groupsWithCount.map(item => item.name)],
    [groupsWithCount],
  );

  useEffect(() => {
    if (groupTab !== ALL_GROUPS_ID && !groupsWithCount.some(group => group.name === groupTab)) {
      setGroupTab(ALL_GROUPS_ID);
    }
  }, [groupTab, groupsWithCount]);

  useEffect(() => {
    if (!contextMenu && !groupContextMenu) return;
    const closeMenus = () => {
      setContextMenu(null);
      setGroupContextMenu(null);
    };
    document.addEventListener('click', closeMenus);
    return () => document.removeEventListener('click', closeMenus);
  }, [contextMenu, groupContextMenu]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const nextTrimmed = value.trim();
    if (!nextTrimmed || groupTab === ALL_GROUPS_ID) return;
    const hasMatchInCurrentGroup = profiles.some(
      profile => (profile.group || '默认') === groupTab && matchesProfileQuery(profile, nextTrimmed, projects),
    );
    if (!hasMatchInCurrentGroup) {
      const hasAnyMatch = profiles.some(profile => matchesProfileQuery(profile, nextTrimmed, projects));
      if (hasAnyMatch) setGroupTab(ALL_GROUPS_ID);
    }
  };

  const handleGroupKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, currentId: string) => {
    const currentIndex = navOrder.indexOf(currentId);
    if (currentIndex === -1 || navOrder.length === 0) return;

    let targetIndex: number | null = null;
    if (event.key === 'ArrowDown') targetIndex = (currentIndex + 1) % navOrder.length;
    else if (event.key === 'ArrowUp') targetIndex = (currentIndex - 1 + navOrder.length) % navOrder.length;
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = navOrder.length - 1;
    if (targetIndex === null) return;

    event.preventDefault();
    const targetId = navOrder[targetIndex];
    setGroupTab(targetId);
    groupButtonRefs.current[targetId]?.focus();
  };

  const loadProfiles = async () => {
    try {
      setProfiles(await getAllProfiles());
    } catch (error) {
      console.error('Failed to load profiles:', error);
    }
  };

  const openEditor = (profile: Profile | null, preferredGroup?: string) => {
    setEditingProfile(profile);
    setDefaultGroupForNew(
      profile ? undefined : (preferredGroup ?? (groupTab !== ALL_GROUPS_ID ? groupTab : undefined)),
    );
    setShowDialog(true);
  };

  const confirmDelete = (profile: Profile) => {
    askConfirm(`确定删除连接「${profile.name}」？`, async () => {
      dismissConfirm();
      try {
        await deleteProfileCmd(profile.id);
        await loadProfiles();
      } catch (error) {
        void showAlert('删除失败: ' + String(error), '删除失败');
      }
    });
  };

  const showGroupTag = groupTab === ALL_GROUPS_ID || Boolean(trimmedSearch);

  return (
    <div className="commands-panel">
      <div className="commands-toolbar">
        <div className="commands-search-wrap">
          <Search size={13} aria-hidden="true" />
          <input
            className="tb-input commands-search"
            type="text"
            placeholder="搜索连接名 / 分组 / 主机 / 路径 / 类型…"
            value={search}
            onChange={event => handleSearchChange(event.target.value)}
          />
          {search && (
            <button
              className="commands-search-clear"
              type="button"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => setSearch('')}
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
        <button className="btn-primary" type="button" onClick={() => openEditor(null)}>
          <Plus size={15} aria-hidden="true" />
          新建连接
        </button>
      </div>

      <div className="settings-split-wrap">
        <div className="settings-card-group settings-list-card settings-split-card">
          <aside className="settings-split-sidebar" aria-label="项目与连接分组">
            <div className="settings-split-sidebar-header">
              <span className="settings-split-sidebar-title">项目分组</span>
              <button
                type="button"
                className="settings-split-icon-btn"
                title="新建项目"
                aria-label="新建项目"
                onClick={() => setEditingProject('')}
              >
                <FolderPlus size={14} aria-hidden="true" />
              </button>
            </div>

            <div className="settings-split-nav" role="tablist" aria-label="连接分组" aria-orientation="vertical">
              <button
                ref={el => { groupButtonRefs.current[ALL_GROUPS_ID] = el; }}
                className={`settings-split-nav-item ${groupTab === ALL_GROUPS_ID ? 'active' : ''}`}
                type="button"
                role="tab"
                aria-selected={groupTab === ALL_GROUPS_ID}
                tabIndex={groupTab === ALL_GROUPS_ID ? 0 : -1}
                onClick={() => setGroupTab(ALL_GROUPS_ID)}
                onKeyDown={event => handleGroupKeyDown(event, ALL_GROUPS_ID)}
              >
                <span className="settings-split-nav-label">全部连接</span>
                <span className="cmd-tab-count">{searchMatchedProfiles.length}</span>
              </button>

              {groupsWithCount.length > 0 && <div className="settings-split-nav-divider" role="separator" />}

              {groupsWithCount.map(({ name, count }) => {
                const isActive = groupTab === name;
                const isZero = Boolean(trimmedSearch) && count === 0;
                return (
                  <button
                    key={name}
                    ref={el => { groupButtonRefs.current[name] = el; }}
                    className={`settings-split-nav-item ${isActive ? 'active' : ''}${isZero ? ' is-zero' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    title={name}
                    onClick={() => setGroupTab(name)}
                    onKeyDown={event => handleGroupKeyDown(event, name)}
                    onContextMenu={event => {
                      event.preventDefault();
                      setContextMenu(null);
                      setGroupContextMenu({ x: event.clientX, y: event.clientY, group: name });
                    }}
                  >
                    <span className="settings-split-nav-label">{name}</span>
                    <span className="cmd-tab-count">{count}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="settings-split-main">
            <div className="settings-split-main-header">
              <div className="settings-split-main-title-wrap">
                <span className="settings-split-main-title">
                  {groupTab === ALL_GROUPS_ID ? '全部连接' : groupTab}
                </span>
                {selectedProject?.path && (
                  <span className="settings-split-main-sub mono" title={selectedProject.path}>
                    {selectedProject.path}
                  </span>
                )}
              </div>
              <div className="settings-split-main-meta">
                {groupTab !== ALL_GROUPS_ID && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm settings-split-header-btn"
                    title={selectedProject ? '编辑项目路径与 Agent' : '为该分组登记项目路径'}
                    onClick={() => setEditingProject(groupTab)}
                  >
                    <FolderCog size={13} aria-hidden="true" />
                    {selectedProject ? '编辑项目' : '配置项目'}
                  </button>
                )}
                <span className="settings-split-count-text">共 {filteredProfiles.length} 项</span>
              </div>
            </div>

            <div className="commands-list">
              {filteredProfiles.map(profile => {
                const badge = TYPE_BADGES[profile.terminalType] || profile.terminalType.toUpperCase();
                const isRemote = (
                  profile.terminalType === 'ssh'
                  || profile.terminalType === 'docker'
                  || profile.terminalType === 'k8s'
                  || profile.terminalType === 'mstsc'
                );
                const targetText = formatProfileTarget(profile, projects);
                const groupName = profile.group || '默认';
                return (
                  <div
                    key={profile.id}
                    className={`cmd-cat-item settings-list-row ${contextMenu?.profile.id === profile.id ? 'selected' : ''}`}
                    onDoubleClick={() => openEditor(profile)}
                    onContextMenu={event => {
                      event.preventDefault();
                      setGroupContextMenu(null);
                      setContextMenu({ x: event.clientX, y: event.clientY, profile });
                    }}
                  >
                    <span className={`profile-type-badge${isRemote ? ' is-remote' : ''}`}>
                      {badge}
                    </span>
                    <div className="profile-row-main">
                      <div className="profile-row-heading">
                        <span className="profile-row-name" style={{ color: profile.tabColor || undefined }}>
                          {profile.name}
                        </span>
                        {showGroupTag && (
                          <span className="profile-group-tag" title={`分组：${groupName}`}>
                            {groupName}
                          </span>
                        )}
                      </div>
                      <span className="profile-row-target mono" title={targetText}>{targetText}</span>
                    </div>
                    <div className="cmd-cat-actions visible-actions">
                      <button
                        className="btn-secondary btn-sm"
                        type="button"
                        title="编辑"
                        aria-label={`编辑连接 ${profile.name}`}
                        onClick={() => openEditor(profile)}
                      >
                        <Pencil size={13} aria-hidden="true" />
                        编辑
                      </button>
                      <button
                        className="btn-danger-outline btn-sm"
                        type="button"
                        title="删除"
                        aria-label={`删除连接 ${profile.name}`}
                        onClick={() => confirmDelete(profile)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
              {filteredProfiles.length === 0 && (
                <div className="settings-empty-state">
                  {trimmedSearch
                    ? '没有找到匹配的连接'
                    : groupTab !== ALL_GROUPS_ID
                      ? '该分组下暂无连接，可点击右上角「新建连接」添加'
                      : '暂无连接'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {(contextMenu || groupContextMenu) && (
        <div
          className="context-menu-overlay"
          onClick={() => {
            setContextMenu(null);
            setGroupContextMenu(null);
          }}
        />
      )}

      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <div className="context-menu-item" onClick={() => {
            const profile = contextMenu.profile;
            setContextMenu(null);
            openEditor(profile);
          }}>编辑</div>
          <div className="context-menu-item" onClick={async () => {
            const profile = contextMenu.profile;
            setContextMenu(null);
            try {
              const copied = await createProfile(`${profile.name} (副本)`, profile.group || '默认', profile.terminalType);
              await updateProfile({ ...profile, id: copied.id, name: `${profile.name} (副本)`, pinned: false });
              await loadProfiles();
            } catch (error) {
              void showAlert('复制失败: ' + String(error), '复制失败');
            }
          }}>复制</div>
          <div className="context-menu-separator" />
          <div className="context-menu-item danger" onClick={() => {
            const profile = contextMenu.profile;
            setContextMenu(null);
            confirmDelete(profile);
          }}>删除</div>
        </div>
      )}

      {groupContextMenu && (
        <div className="context-menu" style={{ left: groupContextMenu.x, top: groupContextMenu.y }}>
          <div className="context-menu-item" onClick={() => {
            const group = groupContextMenu.group;
            setGroupContextMenu(null);
            openEditor(null, group);
          }}>在此分组新建连接</div>
          <div className="context-menu-item" onClick={() => {
            const group = groupContextMenu.group;
            setGroupContextMenu(null);
            setEditingProject(group);
          }}>
            {projects.some(project => project.name === groupContextMenu.group) ? '编辑项目' : '配置项目路径'}
          </div>
          {projects.some(project => project.name === groupContextMenu.group) && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item danger" onClick={() => {
                const group = groupContextMenu.group;
                setGroupContextMenu(null);
                setDeletingProject(group);
              }}>删除项目</div>
            </>
          )}
        </div>
      )}

      {showDialog && (
        <ConfigEditDialog
          profile={editingProfile}
          defaultGroup={defaultGroupForNew}
          onClose={() => setShowDialog(false)}
          onSave={() => {
            setShowDialog(false);
            void loadProfiles();
          }}
          profiles={profiles}
        />
      )}

      {editingProject !== null && (
        <ProjectEditDialog
          targetName={editingProject || undefined}
          onClose={() => setEditingProject(null)}
        />
      )}

      {deletingProject !== null && (
        <ProjectDeleteDialog
          projectName={deletingProject}
          onClose={() => setDeletingProject(null)}
        />
      )}
    </div>
  );
};
