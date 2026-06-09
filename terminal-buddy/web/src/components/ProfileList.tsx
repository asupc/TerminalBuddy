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
    mstsc: { bg: '#3a1a1a', color: '#e04040', label: 'RDP' },
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

    // mstsc (远程桌面) is a GUI application, cannot run in web terminal
    if (profile.terminalType === 'mstsc') {
      alert('远程桌面 (RDP) 需要从桌面客户端启动，Web 端无法使用');
      return;
    }

    try {
      const info = await startTerminal(profile.id);
      useWebAppStore.getState().addSession({
        id: info.id,
        profileId: info.profileId,
        profileName: info.profileName,
        terminalType: info.terminalType as any,
        owner: info.owner as any,
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
            fontSize: 10, color: '#6a6a8a', padding: '4px 6px 2px',
            letterSpacing: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3,
            userSelect: 'none', paddingLeft: 6 + depth * 14,
          }}
        >
          <span style={{ fontSize: 9, transition: 'transform 0.2s', display: 'inline-block',
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
                    padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 1,
                    paddingLeft: 20 + depth * 14,
                  }}
                >
                  <div style={{
                    width: 26, height: 26, borderRadius: 5, background: icon.bg,
                    color: icon.color, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', fontSize: 11, flexShrink: 0, position: 'relative',
                  }}>
                    {icon.label}
                    {isRunning && (
                      <div style={{
                        position: 'absolute', bottom: -2, right: -2, width: 8, height: 8,
                        borderRadius: '50%', background: '#4caf50', border: '1.5px solid #16162e',
                      }} />
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#d0d0e0', lineHeight: 1.3 }}>{profile.name}</div>
                    <div style={{ fontSize: 10, color: '#6a6a8a', lineHeight: 1.3 }}>
                      {profile.terminalType === 'ssh' ? profile.sshHost :
                       profile.terminalType === 'docker' ? profile.dockerContainerName :
                       profile.terminalType === 'k8s' ? profile.k8sPodName :
                       profile.terminalType === 'mstsc' ? profile.mstscHost : '本地'}
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
    <div style={{ flex: 1, overflow: 'auto', padding: '4px 6px' }}>
      {/* Running terminals that can be connected */}
      {activeTerminals.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: '#6a6a8a', padding: '6px 8px 2px', letterSpacing: 1 }}>
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
                  padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 1,
                }}
              >
                <div style={{
                  width: 26, height: 26, borderRadius: 5, background: icon.bg,
                  color: icon.color, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 11, flexShrink: 0, position: 'relative',
                }}>
                  {icon.label}
                  <div style={{
                    position: 'absolute', bottom: -2, right: -2, width: 8, height: 8,
                    borderRadius: '50%', background: '#4caf50', border: '1.5px solid #16162e',
                  }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: '#d0d0e0', display: 'flex', alignItems: 'center', gap: 4, lineHeight: 1.3 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.profileName}</span>
                    <span className={`terminal-owner-badge ${t.owner}`}>
                      {t.owner === 'pc' ? 'PC' : 'Web'}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: '#4caf50', lineHeight: 1.3 }}>运行中 - 点击连接</div>
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
