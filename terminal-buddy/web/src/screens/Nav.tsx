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
  ChevronRight,
  Command,
  KeyRound,
  LogOut,
  Monitor,
  Network,
  Server,
  Settings,
  SquareTerminal,
  TerminalSquare,
  X,
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

interface PropertyRow {
  label: string;
  value: string;
}

/** 根据 profile 类型抽取可展示的属性行（与 PC 端 ConfigEditDialog 的字段顺序对齐） */
function buildPropertyRows(profile: Profile): PropertyRow[] {
  const rows: PropertyRow[] = [
    { label: '分组', value: profile.group?.trim() || '默认' },
    { label: '终端类型', value: getTypeInfo(profile.terminalType).label },
  ];
  switch (profile.terminalType) {
    case 'ssh':
      if (profile.sshHost) rows.push({ label: '主机地址', value: profile.sshHost });
      if (profile.sshPort) rows.push({ label: '端口', value: String(profile.sshPort) });
      if (profile.sshUser) rows.push({ label: '用户名', value: profile.sshUser });
      if (profile.sshAuthType) {
        rows.push({
          label: '认证方式',
          value: profile.sshAuthType === 'key' ? '密钥认证' : '密码认证',
        });
      }
      if (profile.sshKeyPath) rows.push({ label: '密钥路径', value: profile.sshKeyPath });
      break;
    case 'docker':
      if (profile.dockerContainerName) rows.push({ label: '容器名称', value: profile.dockerContainerName });
      if (profile.dockerContainerId) rows.push({ label: '容器 ID', value: profile.dockerContainerId });
      break;
    case 'k8s':
      if (profile.k8sNamespace) rows.push({ label: 'Namespace', value: profile.k8sNamespace });
      if (profile.k8sPodName) rows.push({ label: 'Pod 名称', value: profile.k8sPodName });
      if (profile.k8sContainerName) rows.push({ label: 'Container 名称', value: profile.k8sContainerName });
      break;
    case 'powershell':
    case 'cmd': {
      if (profile.startupPath?.trim()) rows.push({ label: '起始路径', value: profile.startupPath });
      const cmds = (profile.startupCommands || []).filter((c) => c.trim());
      if (cmds.length > 0) rows.push({ label: '启动命令', value: cmds.join('\n') });
      const envCount = Object.keys(profile.environmentVariables || {}).length;
      if (envCount > 0) rows.push({ label: '环境变量', value: `${envCount} 项` });
      break;
    }
    // mstsc 不在 Web 端出现；其它类型无额外属性
  }
  return rows;
}

function ProfileProperties({ profile }: { profile: Profile }) {
  const rows = useMemo(() => buildPropertyRows(profile), [profile]);
  if (rows.length === 0) {
    return <div className="profile-properties profile-properties-empty">无额外属性</div>;
  }
  return (
    <dl className="profile-properties">
      {rows.map((row) => (
        <div className="profile-prop" key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
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
  const view = useStore((state) => state.view);
  const hasHover = useHasHover();

  const [tab, setTab] = useState<'sessions' | 'profiles'>('sessions');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<TerminalInfo | null>(null);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // 「连接」tab 中各 profile 的属性面板展开状态，默认全部折叠
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  // 「会话」tab 中各分组的折叠状态，默认全部展开（与 PC 端 TabNav 行为一致）
  const [collapsedSessionGroups, setCollapsedSessionGroups] = useState<Set<string>>(() => new Set());

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
    setView({ screen: 'terminal', terminalId: session.id, profileName: name, owner: 'web' });
  };

  // 关闭会话：仅 Web 拥有的会话可关（后端会校验 owner），meta WS 收到推送后自动更新列表
  const handleCloseSession = useCallback(async (sessionId: string) => {
    setError('');
    try {
      await api.deleteTerminal(sessionId);
    } catch (closeError) {
      setError(closeError instanceof Error ? closeError.message : '关闭连接失败');
    }
  }, []);

  // 切换 profile 属性面板折叠
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 切换 session 分组折叠
  const toggleSessionGroup = useCallback((name: string) => {
    setCollapsedSessionGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const activeTerminalId = view.screen === 'terminal' ? view.terminalId : null;

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
                <div className="connection-groups session-tree-groups" aria-label="已打开的连接">
                  {sessionGroups.map((group) => {
                    const isCollapsed = collapsedSessionGroups.has(group.name);
                    return (
                      <section key={group.name} className="session-group">
                        <header
                          className="session-group-header"
                          role="button"
                          tabIndex={0}
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleSessionGroup(group.name)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggleSessionGroup(group.name);
                            }
                          }}
                        >
                          <ChevronRight
                            className={`session-group-arrow${isCollapsed ? ' collapsed' : ''}`}
                            size={14}
                            aria-hidden="true"
                          />
                          <h2 className="session-group-name">{group.name}</h2>
                          <span className="session-group-count">{group.items.length}</span>
                        </header>
                        {!isCollapsed && (
                          <ul className="session-tree" role="list">
                            {group.items.map((session) => {
                              const type = getTypeInfo(session.terminalType);
                              const TypeIcon = type.icon;
                              const name = session.profileName || type.label;
                              const isActive = activeTerminalId === session.id;
                              const canClose = session.owner === 'web';
                              return (
                                <li key={session.id}>
                                  <div
                                    role="button"
                                    tabIndex={0}
                                    className={`session-row${isActive ? ' active' : ''}`}
                                    onClick={() => openSession(session)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        openSession(session);
                                      }
                                    }}
                                    aria-label={`${name}，${session.owner === 'pc' ? '桌面端，接管' : '网页端，继续'}`}
                                  >
                                    <span className="session-row-icon" aria-hidden="true"><TypeIcon /></span>
                                    <span className="session-row-name">
                                      <span className="session-row-title">{name}</span>
                                      {session.extraParamTag && (
                                        <span
                                          className="session-tag-chip"
                                          style={session.extraParamTagColor ? { backgroundColor: session.extraParamTagColor } : undefined}
                                        >
                                          {session.extraParamTag}
                                        </span>
                                      )}
                                    </span>
                                    <span className={`session-row-owner ${session.owner}`}>
                                      {session.owner === 'pc' ? 'PC' : 'WEB'}
                                    </span>
                                    <span className="session-row-action">
                                      {session.owner === 'pc' ? '接管' : '继续'}
                                    </span>
                                    {canClose && (
                                      <button
                                        type="button"
                                        className="session-row-close"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void handleCloseSession(session.id);
                                        }}
                                        aria-label="关闭"
                                        title="关闭"
                                      >
                                        <X size={14} aria-hidden="true" />
                                      </button>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </section>
                    );
                  })}
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
                          const isExpanded = expandedIds.has(profile.id);
                          return (
                            <div className="profile-card" key={profile.id}>
                              <div className="profile-row-header">
                                <button
                                  type="button"
                                  className="profile-toggle"
                                  aria-expanded={isExpanded}
                                  aria-label={isExpanded ? '收起属性' : '展开属性'}
                                  onClick={() => toggleExpanded(profile.id)}
                                >
                                  <ChevronRight
                                    size={14}
                                    className={isExpanded ? 'expanded' : ''}
                                    aria-hidden="true"
                                  />
                                </button>
                                <button
                                  type="button"
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
                              </div>
                              {isExpanded && <ProfileProperties profile={profile} />}
                            </div>
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
