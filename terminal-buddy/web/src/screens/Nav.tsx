import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { useMetaWs } from '../hooks/useMetaWs';
import type { Profile, TerminalType } from '../types';

const TYPE_ICON: Record<TerminalType, string> = {
  powershell: '⚡',
  cmd: '⚙',
  ssh: '🐧',
  docker: '🐳',
  k8s: '⚓',
  mstsc: '🪟',
};

export default function Nav() {
  const profiles = useStore((s) => s.profiles);
  const setProfiles = useStore((s) => s.setProfiles);
  const sessions = useStore((s) => s.sessions);
  const metaOnline = useStore((s) => s.metaOnline);
  const setView = useStore((s) => s.setView);
  const logout = useStore((s) => s.logout);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useMetaWs();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await api.getProfiles();
        if (!cancelled) setProfiles(p);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setProfiles]);

  // 按 group 分组（空 group 归入「默认」）
  const groups: Record<string, Profile[]> = {};
  for (const p of profiles) {
    const g = p.group || '默认';
    (groups[g] = groups[g] || []).push(p);
  }

  const openExisting = (id: string, name: string) =>
    setView({ screen: 'terminal', terminalId: id, profileName: name });

  const createNew = async (p: Profile) => {
    setBusyId(p.id);
    setErr('');
    try {
      const info = await api.createTerminal(p.id);
      setView({
        screen: 'terminal',
        terminalId: info.id,
        profileName: info.profileName || p.name,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '创建失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="screen">
      <div className="topbar">
        <span className={`dot ${metaOnline ? 'online' : 'offline'}`} />
        <span className="title">连接</span>
        <button className="btn" onClick={logout}>
          退出
        </button>
      </div>
      <div className="nav-body">
        {loading && <div className="empty-hint">加载中…</div>}
        {!loading && err && (
          <div className="empty-hint" style={{ color: 'var(--danger)' }}>
            {err}
          </div>
        )}
        {!loading && profiles.length === 0 && !err && (
          <div className="empty-hint">电脑端尚未配置连接</div>
        )}
        {Object.entries(groups).map(([g, ps]) => (
          <div key={g}>
            <div className="group-head">{g}</div>
            {ps.map((p) => {
              const insts = sessions.filter((s) => s.profileId === p.id);
              const isMstsc = p.terminalType === 'mstsc';
              return (
                <div className="profile-card" key={p.id}>
                  <div className="profile-row">
                    <span style={{ fontSize: 16 }}>{TYPE_ICON[p.terminalType]}</span>
                    <span className="pname">{p.name}</span>
                    <span className="type-tag">{p.terminalType}</span>
                    {isMstsc ? null : (
                      <button
                        className="add-btn"
                        disabled={busyId === p.id}
                        onClick={() => createNew(p)}
                        title="新建连接"
                      >
                        {busyId === p.id ? '…' : '+'}
                      </button>
                    )}
                  </div>
                  {insts.length > 0 && (
                    <div className="instances">
                      {insts.map((s) => (
                        <div
                          key={s.id}
                          className="instance-row"
                          onClick={() => openExisting(s.id, s.profileName || p.name)}
                        >
                          <span className="dot online" />
                          <span className="iname">{s.profileName || p.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
