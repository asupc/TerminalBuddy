import { useEffect, useState } from 'react';
import {
  Box,
  Command,
  KeyRound,
  LogOut,
  Monitor,
  Network,
  Plus,
  Server,
  SquareTerminal,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { useMetaWs } from '../hooks/useMetaWs';
import { Dialog } from '../components/Dialog';
import type { Profile, TerminalType } from '../types';

const TYPE_INFO: Record<TerminalType, { icon: LucideIcon; label: string }> = {
  powershell: { icon: SquareTerminal, label: 'PowerShell' },
  cmd: { icon: Command, label: 'CMD' },
  ssh: { icon: KeyRound, label: 'SSH' },
  docker: { icon: Box, label: 'Docker' },
  k8s: { icon: Network, label: 'Kubernetes' },
  mstsc: { icon: Monitor, label: '远程桌面' },
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

  const [takeover, setTakeover] = useState<{ id: string; name: string } | null>(null);

  const openExisting = (id: string, name: string, owner: 'pc' | 'web') =>
    setView({ screen: 'terminal', terminalId: id, profileName: name, owner });

  const createNew = async (p: Profile) => {
    setBusyId(p.id);
    setErr('');
    try {
      const info = await api.createTerminal(p.id);
      setView({
        screen: 'terminal',
        terminalId: info.id,
        profileName: info.profileName || p.name,
        owner: 'web',
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '创建失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="screen nav-screen">
      <header className="topbar app-topbar">
        <div className="topbar-brand">
          <span className="brand-mark" aria-hidden="true">
            <TerminalSquare size={20} />
          </span>
          <span className="brand-name">Terminal Buddy</span>
        </div>
        <div className={`status-pill ${metaOnline ? 'online' : 'offline'}`}>
          <span className="dot" aria-hidden="true" />
          <span>{metaOnline ? '服务在线' : '等待连接'}</span>
        </div>
        <button className="icon-button" onClick={logout} title="退出登录" aria-label="退出登录">
          <LogOut size={19} />
        </button>
      </header>
      <main className="nav-body" id="main-content">
        <div className="nav-shell">
          <section className="nav-heading" aria-labelledby="connections-title">
            <div>
              <p className="eyebrow">远程工作台</p>
              <h1 id="connections-title">连接</h1>
            </div>
            <div className="nav-counts" aria-label="连接统计">
              <span><strong>{profiles.length}</strong> 个配置</span>
              <span><strong>{sessions.length}</strong> 个会话</span>
            </div>
          </section>

          {loading && <div className="empty-state">正在加载连接…</div>}
          {!loading && err && <div className="empty-state error-state">{err}</div>}
          {!loading && profiles.length === 0 && !err && (
            <div className="empty-state">
              <Server size={28} aria-hidden="true" />
              <span>电脑端尚未配置连接</span>
            </div>
          )}

          <div className="connection-groups">
            {Object.entries(groups).map(([g, ps], groupIndex) => (
              <section className="connection-group" key={g} aria-labelledby={`group-${groupIndex}`}>
                <div className="group-head">
                  <h2 id={`group-${groupIndex}`}>{g}</h2>
                  <span>{ps.length}</span>
                </div>
                <div className="profile-grid">
                  {ps.map((p) => {
                    const insts = sessions.filter((s) => s.profileId === p.id);
                    const isMstsc = p.terminalType === 'mstsc';
                    const TypeIcon = TYPE_INFO[p.terminalType].icon;
                    return (
                      <article className="profile-card" key={p.id}>
                        <div className="profile-row">
                          <span className="profile-type-icon" aria-hidden="true">
                            <TypeIcon size={20} strokeWidth={1.8} />
                          </span>
                          <div className="profile-copy">
                            <h3>{p.name}</h3>
                            <span>{TYPE_INFO[p.terminalType].label}</span>
                          </div>
                          {!isMstsc && (
                            <button
                              className="new-session-button"
                              disabled={busyId === p.id}
                              onClick={() => createNew(p)}
                              title="新建连接"
                              aria-label={`新建 ${p.name} 连接`}
                            >
                              {busyId === p.id ? (
                                <span className="button-progress">…</span>
                              ) : (
                                <Plus size={20} />
                              )}
                            </button>
                          )}
                        </div>
                        {insts.length > 0 ? (
                          <div className="instances">
                            {insts.map((s) => {
                              const name = s.profileName || p.name;
                              const isPc = s.owner === 'pc';
                              return (
                                <button
                                  type="button"
                                  key={s.id}
                                  className="instance-row"
                                  onClick={() =>
                                    isPc
                                      ? setTakeover({ id: s.id, name })
                                      : openExisting(s.id, name, 'web')
                                  }
                                >
                                  <span className={`dot ${isPc ? 'takeover' : 'online'}`} aria-hidden="true" />
                                  <span className="iname">{name}</span>
                                  <span className={`session-action ${isPc ? 'takeover' : ''}`}>
                                    {isPc ? '接管' : '继续'}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="profile-idle">暂无运行中的会话</div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>

      {takeover && (
        <Dialog
          title="接管 PC 端终端？"
          onClose={() => setTakeover(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setTakeover(null)}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const t = takeover;
                  setTakeover(null);
                  openExisting(t.id, t.name, 'pc');
                }}
              >
                接管
              </button>
            </>
          )}
        >
          <div className="web-dialog-desc">
            「{takeover.name}」正在电脑端运行。接管后终端会切到手机尺寸，电脑端视图会随之重排跟随。
          </div>
        </Dialog>
      )}
    </div>
  );
}
