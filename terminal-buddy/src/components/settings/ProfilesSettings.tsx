import { FC, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  createProfile,
  deleteProfile as deleteProfileCmd,
  getAllProfiles,
  updateProfile,
} from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import type { Profile } from '../../types';
import { ConfigEditDialog } from '../profile-config/ConfigEditDialog';
import { showAlert } from '../../services/dialog';

interface ProfilesSettingsProps {
  askConfirm: (message: string, onConfirm: () => void) => void;
  dismissConfirm: () => void;
}

export const ProfilesSettings: FC<ProfilesSettingsProps> = ({ askConfirm, dismissConfirm }) => {
  const profiles = useAppStore(state => state.profiles);
  const setProfiles = useAppStore(state => state.setProfiles);
  const [search, setSearch] = useState('');
  const [groupTab, setGroupTab] = useState('');
  const [showDialog, setShowDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; profile: Profile } | null>(null);

  const groupsWithCount = useMemo(() => {
    const countMap = new Map<string, number>();
    for (const profile of profiles) {
      const group = profile.group || '默认';
      countMap.set(group, (countMap.get(group) || 0) + 1);
    }
    return Array.from(countMap.entries()).map(([name, count]) => ({ name, count }));
  }, [profiles]);

  const filteredProfiles = useMemo(() => {
    let result = profiles;
    if (groupTab && !search) {
      result = result.filter(profile => (profile.group || '默认') === groupTab);
    }
    if (search) {
      const query = search.toLowerCase();
      result = result.filter(profile =>
        profile.name.toLowerCase().includes(query) ||
        (profile.group || '默认').toLowerCase().includes(query) ||
        (profile.terminalType || '').toLowerCase().includes(query)
      );
    }
    return result;
  }, [groupTab, profiles, search]);

  useEffect(() => {
    if (groupsWithCount.length > 0 && !groupTab) {
      setGroupTab(groupsWithCount[0].name);
    }
  }, [groupTab, groupsWithCount]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeContextMenu = () => setContextMenu(null);
    document.addEventListener('click', closeContextMenu);
    return () => document.removeEventListener('click', closeContextMenu);
  }, [contextMenu]);

  const loadProfiles = async () => {
    try {
      setProfiles(await getAllProfiles());
    } catch (error) {
      console.error('Failed to load profiles:', error);
    }
  };

  const openEditor = (profile: Profile | null) => {
    setEditingProfile(profile);
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

  return (
    <div className="commands-panel">
      <div className="commands-toolbar">
        <input
          className="commands-search"
          type="text"
          placeholder="搜索连接..."
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <button className="settings-add-btn" type="button" onClick={() => openEditor(null)}>
          <Plus size={15} aria-hidden="true" />
          新建连接
        </button>
      </div>

      {!search && groupsWithCount.length > 0 && (
        <div className="cmd-tabs">
          {groupsWithCount.map(({ name, count }) => (
            <button
              key={name}
              className={`cmd-tab ${groupTab === name ? 'active' : ''}`}
              type="button"
              onClick={() => setGroupTab(name)}
            >
              {name}
              <span className="cmd-tab-count">{count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="commands-list" style={{ maxHeight: 400 }}>
        {filteredProfiles.map(profile => (
          <div
            key={profile.id}
            className={`cmd-cat-item ${contextMenu?.profile.id === profile.id ? 'selected' : ''}`}
            onContextMenu={event => {
              event.preventDefault();
              setContextMenu({ x: event.clientX, y: event.clientY, profile });
            }}
          >
            <span className="profile-type-badge">
              {{ powershell: 'PS', pwsh: 'PS7', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S', editor: 'ED', mstsc: 'RDP' }[profile.terminalType]}
            </span>
            <code className="cmd-cat-cmd profile-name" style={{ color: profile.tabColor || undefined }}>{profile.name}</code>
            <span className="cmd-cat-desc profile-target">
              {profile.terminalType === 'ssh' ? (profile.sshHost || '未配置主机') :
               profile.terminalType === 'docker' ? (profile.dockerContainerName || '未配置容器') :
               profile.terminalType === 'k8s' ? (profile.k8sNamespace || '未配置命名空间') :
               (profile.startupPath || 'C:\\')}
            </span>
            <div className="cmd-cat-actions visible-actions">
              <button className="cmd-action-btn" type="button" title="编辑" aria-label={`编辑连接 ${profile.name}`} onClick={() => openEditor(profile)}>
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button className="cmd-action-btn danger" type="button" title="删除" aria-label={`删除连接 ${profile.name}`} onClick={() => confirmDelete(profile)}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
        {filteredProfiles.length === 0 && (
          <div className="settings-empty-state">
            {search ? '没有找到匹配的连接' : '暂无连接'}
          </div>
        )}
      </div>

      {contextMenu && <div className="context-menu-overlay" onClick={() => setContextMenu(null)} />}
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
              const copied = await createProfile(`${profile.name} (副本)`, profile.group || '默认', profile.terminalType as 'powershell' | 'pwsh' | 'cmd' | 'ssh' | 'docker' | 'k8s');
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

      {showDialog && (
        <ConfigEditDialog
          profile={editingProfile}
          onClose={() => setShowDialog(false)}
          onSave={() => {
            setShowDialog(false);
            void loadProfiles();
          }}
          profiles={profiles}
        />
      )}
    </div>
  );
};
