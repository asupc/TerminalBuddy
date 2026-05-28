import React, { useEffect, useState, useMemo } from 'react';
import { listProfiles } from '../api/profiles';
import { listTerminals, startTerminal } from '../api/terminals';
import { useWebAppStore } from '../stores/appStore';
import ProfileDialog from './ProfileDialog';
import type { Profile, TerminalInfo } from '../types';
import { buildGroupTree, extractGroupPaths, type GroupNode } from '../utils/groupTree';

const ProfileList: React.FC = () => {
  const profiles = useWebAppStore((s) => s.profiles);
  const setProfiles = useWebAppStore((s) => s.setProfiles);
  const sessions = useWebAppStore((s) => s.sessions);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [runningTerminals, setRunningTerminals] = useState<TerminalInfo[]>([]);

  useEffect(() => { loadProfiles(); loadRunningTerminals(); }, []);

  const loadProfiles = async () => {
    try {
      const result = await listProfiles();
      setProfiles(result);
      // 默认折叠所有分组（包括中间路径）
      const paths = extractGroupPaths(result, p => p.group || '默认');
      setCollapsedGroups(new Set(paths));
    } catch (err) { console.error('加载连接列表失败', err); }
  };

  const loadRunningTerminals = async () => {
    try {
      const result = await listTerminals();
      setRunningTerminals(result);
    } catch (err) { console.error('加载终端列表失败', err); }
  };

  const groupTree = useMemo(() => {
    return buildGroupTree<Profile>(profiles, p => p.group || '默认');
  }, [profiles]);

  const typeIcon: Record<string, { bg: string; color: string; label: string }> = {
    powershell: { bg: '#012456', color: '#01a4ef', label: 'PS' },
    cmd: { bg: '#2a2a2a', color: '#c0c0c0', label: '>' },
    ssh: { bg: '#1a3a1a', color: '#4caf50', label: 'SSH' },
    docker: { bg: '#1a2a3a', color: '#2496ed', label: 'DK' },
    k8s: { bg: '#1a1a3a', color: '#326ce5', label: 'K8' },
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const handleStartOrConnect = async (profile: Profile) => {
    // Close sidebar on mobile
    if (useWebAppStore.getState().isMobile) {
      useWebAppStore.getState().setSidebarOpen(false);
    }

    // Check if a terminal for this profile is already running (in our local sessions)
    const existingSession = sessions.find((s) => s.profileId === profile.id);
    if (existingSession) {
      useWebAppStore.getState().setActiveSession(existingSession.id);
      return;
    }

    // Check from server list
    const existingTerminal = runningTerminals.find((t) => t.profileId === profile.id);
    if (existingTerminal) {
      useWebAppStore.getState().addSession({
        id: existingTerminal.id,
        profileId: existingTerminal.profileId,
        profileName: existingTerminal.profileName,
        terminalType: existingTerminal.terminalType as any,
        owner: existingTerminal.owner,
      });
      return;
    }

    try {
      const info = await startTerminal(profile.id);
      setRunningTerminals((prev) => [...prev, info]);
      useWebAppStore.getState().addSession({
        id: info.id,
        profileId: info.profileId,
        profileName: info.profileName,
        terminalType: info.terminalType as any,
        owner: info.owner,
      });
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || '启动终端失败';
      alert(msg);
    }
  };

  // Show running terminals not yet in local sessions
  const activeTerminals = runningTerminals.filter(
    (rt) => !sessions.find((s) => s.id === rt.id)
  );

  // 递归渲染分组节点
  const renderGroupNode = (node: GroupNode<Profile>, depth: number): React.ReactNode => {
    const isCollapsed = collapsedGroups.has(node.path);
    const totalCount = node.items.length + node.children.reduce((sum, c) => {
      const countItems = (n: GroupNode<Profile>): number => n.items.length + n.children.reduce((s, ch) => s + countItems(ch), 0);
      return sum + countItems(c);
    }, 0);

    return (
      <div key={node.path}>
        <div
          onClick={() => toggleGroup(node.path)}
          style={{
            fontSize: 11, color: '#6a6a8a', padding: '8px 8px 4px',
            letterSpacing: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
            userSelect: 'none', paddingLeft: 8 + depth * 16,
          }}
        >
          <span style={{ fontSize: 10, transition: 'transform 0.2s', display: 'inline-block',
            transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0)' }}>
            ▼
          </span>
          {node.name} ({totalCount})
        </div>
        {!isCollapsed && (
          <>
            {node.children.map((child) => renderGroupNode(child, depth + 1))}
            {node.items.map((profile) => {
              const icon = typeIcon[profile.terminalType] || typeIcon.powershell;
              const isRunning = sessions.find((s) => s.profileId === profile.id);
              return (
                <div
                  key={profile.id}
                  onClick={() => handleStartOrConnect(profile)}
                  onContextMenu={(e) => { e.preventDefault(); setEditingProfile(profile); setDialogOpen(true); }}
                  style={{
                    padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2,
                    paddingLeft: 24 + depth * 16,
                  }}
                >
                  <div style={{
                    width: 32, height: 32, borderRadius: 6, background: icon.bg,
                    color: icon.color, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', fontSize: 14, flexShrink: 0, position: 'relative',
                  }}>
                    {icon.label}
                    {isRunning && (
                      <div style={{
                        position: 'absolute', bottom: -2, right: -2, width: 10, height: 10,
                        borderRadius: '50%', background: '#4caf50', border: '2px solid #16162e',
                      }} />
                    )}
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
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
      {/* Running terminals that can be connected */}
      {activeTerminals.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: '#6a6a8a', padding: '8px 8px 4px', letterSpacing: 1 }}>
            运行中 ({activeTerminals.length})
          </div>
          {activeTerminals.map((t) => {
            const profile = profiles.find((p) => p.id === t.profileId);
            const icon = typeIcon[t.terminalType] || typeIcon.powershell;
            return (
              <div
                key={t.id}
                onClick={() => {
                  useWebAppStore.getState().addSession({
                    id: t.id,
                    profileId: t.profileId,
                    profileName: t.profileName,
                    terminalType: t.terminalType as any,
                    owner: t.owner,
                  });
                }}
                style={{
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2,
                }}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: 6, background: icon.bg,
                  color: icon.color, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 14, flexShrink: 0, position: 'relative',
                }}>
                  {icon.label}
                  <div style={{
                    position: 'absolute', bottom: -2, right: -2, width: 10, height: 10,
                    borderRadius: '50%', background: '#4caf50', border: '2px solid #16162e',
                  }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: '#d0d0e0', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.profileName}</span>
                    <span className={`terminal-owner-badge ${t.owner}`}>
                      {t.owner === 'pc' ? 'PC' : 'Web'}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#4caf50' }}>运行中 - 点击连接</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {groupTree.map((node) => renderGroupNode(node, 0))}
      {dialogOpen && editingProfile && (
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
