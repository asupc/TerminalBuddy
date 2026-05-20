import React, { useEffect, useState } from 'react';
import { listProfiles } from '../api/profiles';
import { useWebAppStore } from '../stores/appStore';
import ProfileDialog from './ProfileDialog';
import type { Profile } from '../types';

const ProfileList: React.FC = () => {
  const profiles = useWebAppStore((s) => s.profiles);
  const setProfiles = useWebAppStore((s) => s.setProfiles);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);

  useEffect(() => { loadProfiles(); }, []);

  const loadProfiles = async () => {
    try {
      const result = await listProfiles();
      setProfiles(result);
    } catch (err) { console.error('加载连接列表失败', err); }
  };

  const grouped = profiles.reduce<Record<string, Profile[]>>((acc, p) => {
    const g = p.group || '默认';
    if (!acc[g]) acc[g] = [];
    acc[g].push(p);
    return acc;
  }, {});

  const typeIcon: Record<string, { bg: string; color: string; label: string }> = {
    powershell: { bg: '#012456', color: '#01a4ef', label: 'PS' },
    cmd: { bg: '#2a2a2a', color: '#c0c0c0', label: '>' },
    ssh: { bg: '#1a3a1a', color: '#4caf50', label: 'SSH' },
    docker: { bg: '#1a2a3a', color: '#2496ed', label: 'DK' },
    k8s: { bg: '#1a1a3a', color: '#326ce5', label: 'K8' },
  };

  const handleStartTerminal = async (profile: Profile) => {
    try {
      const { startTerminal } = await import('../api/terminals');
      const info = await startTerminal(profile.id);
      useWebAppStore.getState().addSession({
        id: info.id,
        profileId: info.profileId,
        profileName: info.profileName,
        terminalType: info.terminalType as any,
      });
    } catch (err) { console.error('启动终端失败', err); }
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group}>
          <div style={{ fontSize: 11, color: '#6a6a8a', padding: '8px 8px 4px', textTransform: 'uppercase', letterSpacing: 1 }}>
            {group}
          </div>
          {items.map((profile) => {
            const icon = typeIcon[profile.terminalType] || typeIcon.powershell;
            return (
              <div
                key={profile.id}
                onClick={() => handleStartTerminal(profile)}
                onContextMenu={(e) => { e.preventDefault(); setEditingProfile(profile); setDialogOpen(true); }}
                style={{
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2,
                }}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: 6, background: icon.bg,
                  color: icon.color, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 14, flexShrink: 0,
                }}>
                  {icon.label}
                </div>
                <div>
                  <div style={{ fontSize: 13, color: '#d0d0e0' }}>{profile.name}</div>
                  <div style={{ fontSize: 11, color: '#6a6a8a' }}>
                    {profile.terminalType === 'ssh' ? profile.sshHost :
                     profile.terminalType === 'docker' ? profile.dockerContainerName :
                     profile.terminalType === 'k8s' ? profile.k8sPodName : '本地'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <button
        onClick={() => { setEditingProfile(null); setDialogOpen(true); }}
        style={{
          width: '100%', padding: '10px', marginTop: 8, borderRadius: 8,
          border: '1px dashed #3a3a5a', background: 'transparent', color: '#8a8aaa', fontSize: 13,
        }}
      >
        + 新建连接
      </button>
      {dialogOpen && (
        <ProfileDialog
          profile={editingProfile}
          onClose={() => setDialogOpen(false)}
          onSaved={() => { setDialogOpen(false); loadProfiles(); }}
        />
      )}
    </div>
  );
};

export default ProfileList;
