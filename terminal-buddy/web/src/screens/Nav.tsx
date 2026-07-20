import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type TouchEvent,
} from 'react';
import {
  Box,
  Command,
  KeyRound,
  LogOut,
  Monitor,
  Network,
  Server,
  Settings,
  SquareTerminal,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../api';
import { Dialog } from '../components/Dialog';
import { ExtraParamsDialog } from '../components/ExtraParamsDialog';
import { useMetaWs } from '../hooks/useMetaWs';
import { useHasHover } from '../hooks/useMediaQuery';
import { useStore } from '../store';
import type { ExtraParamPreset, Profile, TerminalInfo, TerminalType } from '../types';

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

interface ContextMenuState {
  profileId: string;
  x: number;
  y: number;
}

export default function Nav({ variant = 'fullscreen' }: { variant?: 'fullscreen' | 'sidebar' }) {
  const profiles = useStore((state) => state.profiles);
  const setProfiles = useStore((state) => state.setProfiles);
  const sessions = useStore((state) => state.sessions);
  const metaOnline = useStore((state) => state.metaOnline);
  const setView = useStore((state) => state.setView);
  const logout = useStore((state) => state.logout);
  const extraParamPresets = useStore((state) => state.extraParamPresets);
  const loadExtraParamPresets = useStore((state) => state.loadExtraParamPresets);
  const hasHover = useHasHover();

  const [tab, setTab] = useState<'sessions' | 'profiles'>('sessions');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<TerminalInfo | null>(null);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);

  useEffect(() => {
    void loadExtraParamPresets();
  }, [loadExtraParamPresets]);

  const loadProfiles = useCallback(async () => {
    setError('');
    try {
      setProfiles(await api.getProfiles());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载连接配置失败');
    }
  }, [setProfiles]);

  // 进入「连接」tab 时加载 profiles
  useEffect(() => {
    if (tab === 'profiles') void loadProfiles();
  }, [tab, loadProfiles]);

  useMetaWs();

  const sessionGroups = useMemo(() => {
    const grouped = new Map<string, TerminalInfo[]>();
    for (const session of sessions) {
      const group = session.group?.trim() || '默认';
      const items = grouped.get(group);
      if (items) items.push(session);
      else grouped.set(group, [session]);
    }
    return Array.from(grouped, ([name, items]) => ({ name, items })).sort((a, b) => {
      if (a.name === '默认') return -1;
      if (b.name === '默认') return 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [sessions]);

  const profileGroups = useMemo(() => {
    const grouped = new Map<string, Profile[]>();
    for (const profile of profiles) {
      if (profile.terminalType === 'mstsc') continue; // mstsc 仅桌面端，Web 无法启动
      const group = profile.group?.trim() || '默认';
      const items = grouped.get(group);
      if (items) items.push(profile);
      else grouped.set(group, [profile]);
    }
    return Array.from(grouped, ([name, items]) => ({
      name,
      items: items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    })).sort((a, b) => {
      if (a.name === '默认') return -1;
      if (b.name === '默认') return 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [profiles]);

  const openSession = (session: TerminalInfo) => {
    const name = session.profileName || getTypeInfo(session.terminalType).label;
    if (session.owner === 'pc') {
      setTakeover(session);
      return;
    }
    setView({
      screen: 'terminal',
      terminalId: session.id,
      profileName: name,
      loadingMode: session.loadingMode,
      owner: 'web',
    });
  };

  const createNew = useCallback(
    async (profile: Profile, preset?: ExtraParamPreset) => {
      setBusyId(profile.id);
      setError('');
      try {
        const info = await api.createTerminal(
          profile.id,
          preset
            ? {
                extraStartupParams: preset.params,
                extraParamTag: preset.name,
                extraParamTagColor: preset.tagColor,
              }
            : undefined,
        );
        setView({
          screen: 'terminal',
          terminalId: info.id,
          profileName: info.profileName || profile.name,
          loadingMode: info.loadingMode,
          owner: 'web',
        });
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : '创建连接失败');
      } finally {
        setBusyId(null);
      }
    },
    [setView],
  );

  // ===== profile 启动与菜单交互 =====
  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const showMenuFor = (profileId: string, x: number, y: number) => {
    // 防止菜单溢出视口右下边缘
    const clampedX = Math.min(x, window.innerWidth - 220);
    const clampedY = Math.min(y, window.innerHeight - 240);
    setContextMenu({ profileId, x: Math.max(8, clampedX), y: Math.max(8, clampedY) });
  };

  const handleProfileClick = (profile: Profile) => {
    if (longPressFired.current) {
      // 长按刚触发了菜单，拦截紧随其来的 click，避免又启动
      longPressFired.current = false;
      return;
    }
    // 移动端：单击启动；桌面端：单击不启动（等双击）
    if (!hasHover) void createNew(profile);
  };

  const handleProfileDoubleClick = (profile: Profile) => {
    if (hasHover) void createNew(profile);
  };

  const handleProfileContextMenu = (e: MouseEvent, profile: Profile) => {
    e.preventDefault(); // 始终阻止系统右键菜单
    if (!hasHover) return; // 触摸端由长按处理
    showMenuFor(profile.id, e.clientX, e.clientY);
  };

  const handleProfileTouchStart = (e: TouchEvent, profile: Profile) => {
    longPressFired.current = false;
    const touch = e.touches[0];
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      showMenuFor(profile.id, touch.clientX, touch.clientY);
    }, 500);
  };

  const handleProfileTouchEnd = () => {
    clearLongPress();
  };

  const handleProfileTouchMove = () => {
    clearLongPress();
  };

  // 点击外部 / 滚动 关闭菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close, { passive: true });
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  // 启动参数预设匹配（commandMatch：预设的匹配串被某条启动命令包含才显示）
  const matchingPresets = useMemo(() => {
    if (!contextMenu) return [];
    const profile = profiles.find((p) => p.id === contextMenu.profileId);
    return extraParamPresets.filter((preset) => {
      if (!preset.commandMatch) return true;
      const match = preset.commandMatch.toLowerCase();
      return (profile?.startupCommands || []).some((cmd) => cmd.toLowerCase().includes(match));
    });
  }, [contextMenu, profiles, extraParamPresets]);

  const menuProfile = contextMenu ? profiles.find((p) => p.id === contextMenu.profileId) : null;

  return (
    <div className={`screen nav-screen${variant === 'sidebar' ? ' sidebar-variant' : ''}`}>
      <header className="topbar app-topbar">
        <div className="topbar-brand">
          <span className="brand-mark" aria-hidden="true"><TerminalSquare size={20} /></span>
          <span className="brand-name">Terminal Buddy</span>
        </div>
        <div className={`status-pill ${metaOnline ? 'online' : 'offline'}`}>
          <span className="dot" aria-hidden="true" />
          <span>{metaOnline ? '服务在线' : '等待连接'}</span>
        </div>
        <button
          className="icon-button"
          onClick={() => setPresetDialogOpen(true)}
          title="启动参数预设"
          aria-label="管理启动参数预设"
        >
          <Settings size={19} />
        </button>
        <button className="icon-button" onClick={logout} title="退出登录" aria-label="退出登录">
          <LogOut size={19} />
        </button>
      </header>

      <div className="nav-tabs" role="tablist" aria-label="导航视图">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sessions'}
          className={`nav-tab${tab === 'sessions' ? ' active' : ''}`}
          onClick={() => setTab('sessions')}
        >
          会话
          {sessions.length > 0 && <span className="nav-tab-badge">{sessions.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'profiles'}
          className={`nav-tab${tab === 'profiles' ? ' active' : ''}`}
          onClick={() => setTab('profiles')}
        >
          连接
        </button>
      </div>

      <main className="nav-body" id="main-content">
        <div className="nav-shell">
          {error && <div className="nav-error" role="alert">{error}</div>}

          {tab === 'sessions'
            ? sessions.length === 0
              ? (
                <div className="session-empty-state">
                  <Server aria-hidden="true" />
                  <strong>暂无打开的连接</strong>
                  <button type="button" className="btn" onClick={() => setTab('profiles')}>
                    去连接列表启动
                  </button>
                </div>
              )
              : (
                <div className="connection-groups" aria-label="已打开的连接">
                  {sessionGroups.map((group) => (
                    <section key={group.name}>
                      <div className="group-head"><h2>{group.name}</h2></div>
                      <div className="open-session-grid">
                        {group.items.map((session) => {
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
                                <strong>
                                  {name}
                                  {session.extraParamTag && (
                                    <span
                                      className="session-tag-chip"
                                      style={session.extraParamTagColor ? { backgroundColor: session.extraParamTagColor } : undefined}
                                    >
                                      {session.extraParamTag}
                                    </span>
                                  )}
                                </strong>
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
                    </section>
                  ))}
                </div>
              )
            : profiles.length === 0
              ? (
                <div className="session-empty-state">
                  <Server aria-hidden="true" />
                  <strong>暂无连接配置</strong>
                  <small>请在桌面端 Terminal Buddy 添加连接</small>
                </div>
              )
              : (
                <div className="connection-groups" aria-label="所有连接">
                  {profileGroups.map((group) => (
                    <section key={group.name}>
                      <div className="group-head"><h2>{group.name}</h2></div>
                      <div className="profile-list">
                        {group.items.map((profile) => {
                          const type = TYPE_INFO[profile.terminalType] ?? FALLBACK_TYPE;
                          const TypeIcon = type.icon;
                          const isBusy = busyId === profile.id;
                          return (
                            <button
                              type="button"
                              key={profile.id}
                              className="profile-row"
                              disabled={busyId !== null}
                              onClick={() => handleProfileClick(profile)}
                              onDoubleClick={() => handleProfileDoubleClick(profile)}
                              onContextMenu={(e) => handleProfileContextMenu(e, profile)}
                              onTouchStart={(e) => handleProfileTouchStart(e, profile)}
                              onTouchEnd={handleProfileTouchEnd}
                              onTouchMove={handleProfileTouchMove}
                              aria-busy={isBusy || undefined}
                              aria-label={profile.name}
                            >
                              <span className="profile-row-icon" aria-hidden="true"><TypeIcon /></span>
                              <span className="profile-row-copy">
                                <strong>{profile.name}</strong>
                                <small>{type.label}</small>
                              </span>
                              <span className="profile-row-action">
                                {isBusy ? '连接中…' : hasHover ? '双击启动' : '启动'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              )}
        </div>
      </main>

      {contextMenu && menuProfile && (
        <div
          className="profile-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              void createNew(menuProfile);
              setContextMenu(null);
            }}
          >
            启动
          </button>
          {matchingPresets.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className="context-menu-item context-menu-item-preset"
              onClick={() => {
                void createNew(menuProfile, preset);
                setContextMenu(null);
              }}
            >
              启动
              <span
                className="context-menu-tag-chip"
                style={preset.tagColor ? { backgroundColor: preset.tagColor } : undefined}
              >
                {preset.name}
              </span>
            </button>
          ))}
          <div className="context-menu-separator" />
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              setContextMenu(null);
              setPresetDialogOpen(true);
            }}
          >
            管理启动参数
          </button>
        </div>
      )}

      {presetDialogOpen && <ExtraParamsDialog onClose={() => setPresetDialogOpen(false)} />}

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
                    loadingMode: session.loadingMode,
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
