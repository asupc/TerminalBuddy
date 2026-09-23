import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type TouchEvent,
} from 'react';
import {
  Box,
  ChevronRight,
  Command,
  KeyRound,
  ListTree,
  Monitor,
  Network,
  PanelLeftClose,
  Server,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import appIcon from '../assets/app-icon.png';
import { api, type CreateTerminalOptions } from '../api';
import { Dialog } from '../components/Dialog';
import { useMetaWs } from '../hooks/useMetaWs';
import { useHasHover } from '../hooks/useMediaQuery';
import { useStore } from '../store';
import type { ExtraParamPreset, Profile, TerminalInfo, TerminalType } from '../types';

const TYPE_INFO: Record<TerminalType, { icon: LucideIcon; label: string }> = {
  powershell: { icon: SquareTerminal, label: 'PowerShell' },
  pwsh: { icon: SquareTerminal, label: 'PowerShell 7' },
  cmd: { icon: Command, label: 'CMD' },
  ssh: { icon: KeyRound, label: 'SSH' },
  docker: { icon: Box, label: 'Docker' },
  k8s: { icon: Network, label: 'Kubernetes' },
  mstsc: { icon: Monitor, label: '远程桌面' },
};

/** PC 端 ConfigNav 类型徽标（PS/PS7/CMD/SSH/DK/K8S/RDP） */
const TYPE_BADGE: Record<TerminalType, string> = {
  powershell: 'PS',
  pwsh: 'PS7',
  cmd: 'CMD',
  ssh: 'SSH',
  docker: 'DK',
  k8s: 'K8S',
  mstsc: 'RDP',
};

const FALLBACK_TYPE = { icon: SquareTerminal, label: '终端' };

function getTypeInfo(type: string) {
  return TYPE_INFO[type as TerminalType] ?? FALLBACK_TYPE;
}

/** 会话行的呼吸灯底色：参考 PC 端 getWorkingDotColor；
 *  Web 暂未广播 working 状态，因此先按 profile.tabColor 计算底色，缺失时回退到主题强调色。 */
function getSessionDotColor(
  profiles: Profile[],
  profileId: string | undefined,
): CSSProperties {
  const profile = profileId ? profiles.find((p) => p.id === profileId) : undefined;
  const color = profile?.tabColor || 'var(--accent)';
  return { background: color };
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
    case 'pwsh':
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
    <div className="profile-properties" role="group" aria-label="连接属性">
      {rows.map((row) => (
        <div className="profile-prop" key={row.label}>
          <span className="profile-prop-label">{row.label}</span>
          <span className="profile-prop-value">{row.value}</span>
        </div>
      ))}
    </div>
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
  const connectionFatal = useStore((state) => state.connectionFatal);
  const setView = useStore((state) => state.setView);
  const extraParamPresets = useStore((state) => state.extraParamPresets);
  const loadExtraParamPresets = useStore((state) => state.loadExtraParamPresets);
  const view = useStore((state) => state.view);
  const navCollapsed = useStore((state) => state.navCollapsed);
  const toggleNavCollapsed = useStore((state) => state.toggleNavCollapsed);
  const hasHover = useHasHover();

  const [tab, setTab] = useState<'sessions' | 'profiles'>('sessions');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<TerminalInfo | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // 会话行右键菜单
  const [sessionContextMenu, setSessionContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  // 「连接」tab 中各 profile 的属性面板展开状态，默认全部折叠
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  // 「会话」tab 各分组的折叠状态，默认全部展开（与 PC 端 TabNav 行为一致）
  const [collapsedSessionGroups, setCollapsedSessionGroups] = useState<Set<string>>(() => new Set());
  // 「连接」tab 各分组的折叠状态：首次拿到 profileGroups 时全部折叠（按用户偏好），之后保留手动切换
  const [collapsedProfileGroups, setCollapsedProfileGroups] = useState<Set<string>>(() => new Set());
  const profileGroupsInitRef = useRef(false);

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

  // 「连接」tab 分组首次加载时全部折叠（仅首次，后续手动切换不重置）
  useEffect(() => {
    if (profileGroupsInitRef.current || profileGroups.length === 0) return;
    profileGroupsInitRef.current = true;
    setCollapsedProfileGroups(new Set(profileGroups.map((g) => g.name)));
  }, [profileGroups]);

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

  const activeTerminalId = view.screen === 'terminal' ? view.terminalId : null;

  const createNew = useCallback(
    async (profile: Profile, preset?: ExtraParamPreset, extra?: CreateTerminalOptions) => {
      setBusyId(profile.id);
      setError('');
      try {
        const options: CreateTerminalOptions | undefined = preset
          ? {
              extraStartupParams: preset.params,
              extraStartupMode: preset.mode,
              extraParamTag: preset.name,
              extraParamTagColor: preset.tagColor,
            }
          : extra;
        const info = await api.createTerminal(profile.id, options);
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

  // 关闭会话：仅 Web 拥有的会话可关（后端会校验 owner），meta WS 收到推送后自动更新列表
  const handleCloseSession = useCallback(async (sessionId: string) => {
    setError('');
    try {
      await api.deleteTerminal(sessionId);
    } catch (closeError) {
      setError(closeError instanceof Error ? closeError.message : '关闭连接失败');
    }
  }, []);

  // 显示会话右键菜单（防止溢出视口右下边缘）
  const showSessionMenu = useCallback((sessionId: string, x: number, y: number) => {
    const clampedX = Math.min(x, window.innerWidth - 220);
    const clampedY = Math.min(y, window.innerHeight - 220);
    setSessionContextMenu({ sessionId, x: Math.max(8, clampedX), y: Math.max(8, clampedY) });
  }, []);

  // 会话右键菜单动作：「以此配置新建终端」需要先确保 profiles 已加载
  const handleSessionMenuAction = useCallback(
    async (action: 'open' | 'new' | 'close', sessionId: string) => {
      setSessionContextMenu(null);
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      if (action === 'close') {
        if (session.owner !== 'web') return;
        await handleCloseSession(sessionId);
        return;
      }
      if (action === 'open') {
        if (session.owner === 'pc') setTakeover(session);
        else {
          const name = session.profileName || getTypeInfo(session.terminalType).label;
          setView({ screen: 'terminal', terminalId: session.id, profileName: name, loadingMode: session.loadingMode, owner: 'web' });
        }
        return;
      }
      // action === 'new'：按原 profile 起一个新终端
      if (!session.profileId) {
        setError('无法定位该终端的配置');
        return;
      }
      if (profiles.length === 0) await loadProfiles();
      const profile = useStore.getState().profiles.find((p) => p.id === session.profileId);
      if (!profile) {
        setError('配置已被删除，无法新建');
        return;
      }
      await createNew(profile, undefined, {
        extraStartupParams: session.extraStartupParams,
        extraStartupMode: session.extraStartupMode,
        extraParamTag: session.extraParamTag,
        extraParamTagColor: session.extraParamTagColor,
      });
    },
    [sessions, profiles.length, handleCloseSession, loadProfiles, createNew, setView],
  );

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

  // 切换「连接」tab 分组折叠
  const toggleProfileGroup = useCallback((name: string) => {
    setCollapsedProfileGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

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
    if (!contextMenu && !sessionContextMenu) return;
    const close = () => {
      setContextMenu(null);
      setSessionContextMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close, { passive: true });
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu, sessionContextMenu]);

  // 启动参数预设匹配（commandMatch：预设的匹配串被某条启动命令包含才显示）
  const matchingPresets = useMemo(() => {
    if (!contextMenu) return [];
    const profile = profiles.find((p) => p.id === contextMenu.profileId);
    return extraParamPresets.filter((preset) => {
      if (preset.enabled === false) return false;
      if (!preset.commandMatch) return true;
      const match = preset.commandMatch.toLowerCase();
      return (profile?.startupCommands || []).some((cmd) => cmd.toLowerCase().includes(match));
    });
  }, [contextMenu, profiles, extraParamPresets]);

  const menuProfile = contextMenu ? profiles.find((p) => p.id === contextMenu.profileId) : null;

  return (
    <div className={`screen nav-screen${variant === 'sidebar' ? ' sidebar-variant' : ''}${navCollapsed ? ' nav-collapsed' : ''}`}>
      <header className="topbar app-topbar">
        <div className="topbar-brand">
          <img className="brand-mark" src={appIcon} alt="" draggable={false} />
          <span className="brand-name">Terminal Buddy</span>
        </div>
        <div className={`status-pill ${metaOnline ? 'online' : 'offline'}`}>
          <span className="dot" aria-hidden="true" />
          <span>
            {metaOnline
              ? '服务在线'
              : connectionFatal?.kind === 'expired'
                ? '登录已过期'
                : connectionFatal
                  ? '连接失败'
                  : '等待连接'}
          </span>
        </div>
        <button
          className="icon-button nav-collapse-toggle"
          onClick={toggleNavCollapsed}
          title="折叠导航"
          aria-label="折叠导航"
          aria-pressed={navCollapsed}
        >
          <PanelLeftClose size={19} />
        </button>
        {/* 退出登录按钮已下线；token 失效由 api.ts 的 401 处理器自动清除 */}
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
                <div className="session-tree" aria-label="已打开的连接">
                  {sessionGroups.map((group) => {
                    const isCollapsed = collapsedSessionGroups.has(group.name);
                    return (
                      <div className="tree-node" key={group.name}>
                        <div
                          className="tree-item"
                          style={{ paddingLeft: 8 }}
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
                          <button
                            type="button"
                            className={`tree-arrow${isCollapsed ? '' : ' expanded'}`}
                            aria-label={isCollapsed ? '展开分组' : '折叠分组'}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSessionGroup(group.name);
                            }}
                            tabIndex={-1}
                          >
                            <ChevronRight size={12} aria-hidden="true" />
                          </button>
                          <span className="tree-name">{group.name}</span>
                          <span className="tree-item-end">
                            <span className="tree-item-count">{group.items.length}</span>
                          </span>
                        </div>
                        {!isCollapsed && (
                          <div className="tree-children">
                            {group.items.map((session) => {
                              const name = session.profileName || getTypeInfo(session.terminalType).label;
                              const isActive = activeTerminalId === session.id;
                              return (
                                <div className="tree-node" key={session.id}>
                                  <div
                                    className={`tree-item tab-nav-item${isActive ? ' active' : ''}`}
                                    style={{ paddingLeft: 20 }}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => openSession(session)}
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      showSessionMenu(session.id, e.clientX, e.clientY);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        openSession(session);
                                      }
                                    }}
                                    aria-label={`${name}，${session.owner === 'pc' ? '桌面端，接管' : '网页端，继续'}`}
                                  >
                                    <span className="tree-arrow-placeholder" aria-hidden="true" />
                                    <span
                                      className="tab-nav-dot"
                                      aria-hidden="true"
                                      style={getSessionDotColor(profiles, session.profileId)}
                                    />
                                    {session.extraParamTag && (
                                      <span
                                        className="tab-nav-tag-chip"
                                        style={session.extraParamTagColor ? { backgroundColor: session.extraParamTagColor } : undefined}
                                      >
                                        {session.extraParamTag}
                                      </span>
                                    )}
                                    <span className="tab-nav-name">{name}</span>
                                    {session.owner === 'web' && <span className="tab-nav-owner-badge">WEB</span>}
                                    <span className="tree-item-end">
                                      {session.owner === 'web' && (
                                        <button
                                          type="button"
                                          className="tab-nav-close"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void handleCloseSession(session.id);
                                          }}
                                          aria-label="关闭"
                                          title="关闭"
                                        >
                                          <X size={12} aria-hidden="true" />
                                        </button>
                                      )}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
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
                <div className="profile-tree" aria-label="所有连接">
                  {profileGroups.map((group) => {
                    const isGroupCollapsed = collapsedProfileGroups.has(group.name);
                    return (
                      <div className="tree-node" key={group.name}>
                        <div
                          className="tree-item"
                          style={{ paddingLeft: 8 }}
                          role="button"
                          tabIndex={0}
                          aria-expanded={!isGroupCollapsed}
                          onClick={() => toggleProfileGroup(group.name)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggleProfileGroup(group.name);
                            }
                          }}
                        >
                          <button
                            type="button"
                            className={`tree-arrow${isGroupCollapsed ? '' : ' expanded'}`}
                            aria-label={isGroupCollapsed ? '展开分组' : '折叠分组'}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleProfileGroup(group.name);
                            }}
                            tabIndex={-1}
                          >
                            <ChevronRight size={12} aria-hidden="true" />
                          </button>
                          <span className="tree-name">{group.name}</span>
                          <span className="tree-item-end">
                            <span className="tree-item-count">{group.items.length}</span>
                          </span>
                        </div>
                        {!isGroupCollapsed && (
                          <div className="tree-children">
                            {group.items.map((profile) => {
                              const type = TYPE_INFO[profile.terminalType] ?? FALLBACK_TYPE;
                              const badge = TYPE_BADGE[profile.terminalType] ?? profile.terminalType.toUpperCase();
                              const isBusy = busyId === profile.id;
                              const isExpanded = expandedIds.has(profile.id);
                              return (
                                <div className="tree-node" key={profile.id}>
                                  <div
                                    className="tree-item"
                                    style={{ paddingLeft: 20 }}
                                    role="button"
                                    tabIndex={0}
                                    aria-busy={isBusy || undefined}
                                    aria-label={profile.name}
                                    onClick={() => handleProfileClick(profile)}
                                    onDoubleClick={() => handleProfileDoubleClick(profile)}
                                    onContextMenu={(e) => handleProfileContextMenu(e, profile)}
                                    onTouchStart={(e) => handleProfileTouchStart(e, profile)}
                                    onTouchEnd={handleProfileTouchEnd}
                                    onTouchMove={handleProfileTouchMove}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        handleProfileClick(profile);
                                      }
                                    }}
                                  >
                                    <button
                                      type="button"
                                      className={`tree-arrow${isExpanded ? ' expanded' : ''}`}
                                      aria-label={isExpanded ? '收起属性' : '展开属性'}
                                      aria-expanded={isExpanded}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleExpanded(profile.id);
                                      }}
                                      tabIndex={-1}
                                    >
                                      <ChevronRight size={12} aria-hidden="true" />
                                    </button>
                                    <span className="config-nav-icon-type">{badge}</span>
                                    <span className="tree-name">{profile.name}</span>
                                    <span className="tree-item-end">
                                      {isBusy && (
                                        <span className="tree-item-count">连接中…</span>
                                      )}
                                    </span>
                                  </div>
                                  {isExpanded && <ProfileProperties profile={profile} />}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
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
        </div>
      )}

      {sessionContextMenu && (() => {
        const session = sessions.find((s) => s.id === sessionContextMenu.sessionId);
        if (!session) return null;
        const isPc = session.owner === 'pc';
        const canClose = session.owner === 'web';
        return (
          <div
            className="session-context-menu"
            style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            {isPc && (
              <button
                type="button"
                className="context-menu-item"
                onClick={() => handleSessionMenuAction('open', session.id)}
              >
                接管
              </button>
            )}
            <button
              type="button"
              className="context-menu-item"
              onClick={() => handleSessionMenuAction('new', session.id)}
            >
              以此配置新建终端
            </button>
            {canClose && <div className="context-menu-separator" />}
            {canClose && (
              <button
                type="button"
                className="context-menu-item danger"
                onClick={() => handleSessionMenuAction('close', session.id)}
              >
                关闭
              </button>
            )}
          </div>
        );
      })()}

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

      {/* 折叠态下的极简活动条：tab 切换 + 展开 + 登出；展开态由 CSS 隐藏 */}
      <nav className="nav-activity-bar" aria-label="导航活动条">
        {/* 顶部留一个 spacer 当占位；折叠态 logo 由 topbar 的 brand-mark 在缩小后顶上，activity-bar 居中堆叠切换按钮 */}
        <div className="activity-spacer" />
        {(
          [
            {
              key: 'sessions' as const,
              label: '会话',
              icon: ListTree,
              badge: sessions.length,
            },
            {
              key: 'profiles' as const,
              label: '连接',
              icon: Server,
              badge: 0,
            },
          ]
        ).map((entry) => {
          const Icon = entry.icon;
          const active = tab === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              className={`activity-btn${active ? ' active' : ''}`}
              onClick={() => {
                setTab(entry.key);
                if (navCollapsed) toggleNavCollapsed();
              }}
              aria-pressed={active}
              aria-label={entry.label}
              title={entry.label}
            >
              <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
              {entry.badge > 0 && <span className="activity-badge">{entry.badge}</span>}
            </button>
          );
        })}
        <div className="activity-spacer" />
      </nav>
    </div>
  );
}
