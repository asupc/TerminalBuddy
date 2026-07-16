import { useCallback, useState } from 'react';
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
import { ConnectionPickerDialog } from '../components/ConnectionPickerDialog';
import { Dialog } from '../components/Dialog';
import { useMetaWs } from '../hooks/useMetaWs';
import { useStore } from '../store';
import type { Profile, TerminalInfo, TerminalType } from '../types';

const TYPE_INFO: Record<TerminalType, { icon: LucideIcon; label: string }> = {
  powershell: { icon: SquareTerminal, label: 'PowerShell' },
  cmd: { icon: Command, label: 'CMD' },
  ssh: { icon: KeyRound, label: 'SSH' },
  docker: { icon: Box, label: 'Docker' },
  k8s: { icon: Network, label: 'Kubernetes' },
  mstsc: { icon: Monitor, label: '远程桌面' },
};

const FALLBACK_TYPE = { icon: SquareTerminal, label: '终端' };

function getTypeInfo(type: string) {
  return TYPE_INFO[type as TerminalType] ?? FALLBACK_TYPE;
}

export default function Nav() {
  const profiles = useStore((state) => state.profiles);
  const setProfiles = useStore((state) => state.setProfiles);
  const sessions = useStore((state) => state.sessions);
  const metaOnline = useStore((state) => state.metaOnline);
  const setView = useStore((state) => state.setView);
  const logout = useStore((state) => state.logout);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<TerminalInfo | null>(null);

  useMetaWs();

  const loadProfiles = useCallback(async () => {
    setProfilesLoading(true);
    setError('');
    try {
      setProfiles(await api.getProfiles());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载连接配置失败');
    } finally {
      setProfilesLoading(false);
    }
  }, [setProfiles]);

  const openPicker = () => {
    setPickerOpen(true);
    void loadProfiles();
  };

  const openSession = (session: TerminalInfo) => {
    const name = session.profileName || getTypeInfo(session.terminalType).label;
    if (session.owner === 'pc') {
      setTakeover(session);
      return;
    }
    setView({ screen: 'terminal', terminalId: session.id, profileName: name, owner: 'web' });
  };

  const createNew = async (profile: Profile) => {
    setBusyId(profile.id);
    setError('');
    try {
      const info = await api.createTerminal(profile.id);
      setPickerOpen(false);
      setView({
        screen: 'terminal',
        terminalId: info.id,
        profileName: info.profileName || profile.name,
        owner: 'web',
      });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建连接失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="screen nav-screen">
      <header className="topbar app-topbar">
        <div className="topbar-brand">
          <span className="brand-mark" aria-hidden="true"><TerminalSquare size={20} /></span>
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
          <section className="nav-heading" aria-labelledby="tabs-title">
            <div>
              <p className="eyebrow">远程工作台</p>
              <h1 id="tabs-title">选项卡</h1>
            </div>
            <div className="nav-heading-actions">
              <span className="open-session-count">{sessions.length} 个已打开</span>
              <button type="button" className="btn primary nav-new-button" onClick={openPicker}>
                <Plus aria-hidden="true" />
                新建
              </button>
            </div>
          </section>

          {sessions.length === 0 ? (
            <div className="session-empty-state">
              <Server aria-hidden="true" />
              <strong>暂无打开的连接</strong>
              <button type="button" className="btn" onClick={openPicker}>
                <Plus aria-hidden="true" />
                新建连接
              </button>
            </div>
          ) : (
            <div className="open-session-grid" aria-label="已打开的连接">
              {sessions.map((session) => {
                const type = getTypeInfo(session.terminalType);
                const TypeIcon = type.icon;
                const name = session.profileName || type.label;
                return (
                  <button
                    type="button"
                    className="open-session-tab"
                    key={session.id}
                    onClick={() => openSession(session)}
                    aria-label={`${name}，${session.owner === 'pc' ? '桌面端，接管' : '网页端，继续'}`}
                  >
                    <span className="open-session-icon" aria-hidden="true"><TypeIcon /></span>
                    <span className="open-session-copy">
                      <strong>{name}</strong>
                      <small>{type.label}</small>
                    </span>
                    <span className={`open-session-owner ${session.owner}`}>
                      {session.owner === 'pc' ? 'PC' : 'WEB'}
                    </span>
                    <span className="open-session-action">
                      {session.owner === 'pc' ? '接管' : '继续'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {pickerOpen && (
        <ConnectionPickerDialog
          profiles={profiles}
          loading={profilesLoading}
          error={error}
          busyId={busyId}
          onClose={() => setPickerOpen(false)}
          onSelect={createNew}
        />
      )}

      {takeover && (
        <Dialog
          title="接管 PC 端终端？"
          onClose={() => setTakeover(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setTakeover(null)}>取消</button>
              <button
                className="btn primary"
                onClick={() => {
                  const session = takeover;
                  setTakeover(null);
                  setView({
                    screen: 'terminal',
                    terminalId: session.id,
                    profileName: session.profileName || getTypeInfo(session.terminalType).label,
                    owner: 'pc',
                  });
                }}
              >
                接管
              </button>
            </>
          )}
        >
          <div className="web-dialog-desc">
            「{takeover.profileName || getTypeInfo(takeover.terminalType).label}」正在电脑端运行。接管后终端会切到当前网页尺寸。
          </div>
        </Dialog>
      )}
    </div>
  );
}
