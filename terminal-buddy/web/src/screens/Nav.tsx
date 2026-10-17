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
  FolderGit2,
  History,
  KeyRound,
  ListTree,
  Monitor,
  Network,
  PanelLeftClose,
  Server,
  SquareTerminal,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import appIcon from '../assets/app-icon.png';
import { api, type CreateTerminalOptions } from '../api';
import { Dialog } from '../components/Dialog';
import { useMetaWs } from '../hooks/useMetaWs';
import { useHasHover } from '../hooks/useMediaQuery';
import { useStore } from '../store';
import ClaudeHistory from './ClaudeHistory';
import Files from './Files';
import type { ExtraParamPreset, Profile, Project, TerminalInfo, TerminalType } from '../types';

const TYPE_INFO: Record<TerminalType, { icon: LucideIcon; label: string }> = {
  powershell: { icon: SquareTerminal, label: 'PowerShell' },
  pwsh: { icon: SquareTerminal, label: 'PowerShell 7' },
  cmd: { icon: Command, label: 'CMD' },
  bash: { icon: SquareTerminal, label: 'Bash' },
  sh: { icon: SquareTerminal, label: 'Shell' },
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
  bash: 'BASH',
  sh: 'SH',
  ssh: 'SSH',
  docker: 'DK',
  k8s: 'K8S',
  mstsc: 'RDP',
};

const FALLBACK_TYPE = { icon: SquareTerminal, label: '终端' };

function getTypeInfo(type: string) {
  return TYPE_INFO[type as TerminalType] ?? FALLBACK_TYPE;
}

/** 手机端能否关闭该会话：仅 Web 池里手机端自己创建的（creator === 'mobile'）
 * 可关；电脑端创建的（'desktop'）不可关。旧后端无 creator 字段时视为可关，
 * 保持与既有行为平滑兼容。PC 会话本来就不可关（后端矩阵拦截）。 */
function canCloseSession(session: TerminalInfo): boolean {
  return session.owner === 'web' && session.creator !== 'desktop';
}

function isDesktopSession(session: TerminalInfo): boolean {
  return session.owner === 'pc' || session.creator === 'desktop';
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
    case 'cmd':
    case 'bash':
    case 'sh': {
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
  const projects = useStore((state) => state.projects);
  const setProjects = useStore((state) => state.setProjects);
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

  const [tab, setTab] = useState<'sessions' | 'profiles' | 'history' | 'files'>('sessions');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<TerminalInfo | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // 项目分组启动菜单（⚡ 按钮或分组右键打开）
  const [groupMenu, setGroupMenu] = useState<{ projectName: string; x: number; y: number } | null>(null);
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
  // 会话行独立的长按状态（与 profile 行的模式一致），触屏长按 500ms 出菜单
  const sessionLongPressTimer = useRef<number | null>(null);
  const sessionLongPressFired = useRef(false);
  // 关闭会话前的确认弹窗（关闭会杀掉 PTY，防误触）
  const [confirmClose, setConfirmClose] = useState<TerminalInfo | null>(null);

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

  // 进入「项目与命令」/「历史」/「文件」tab 时加载 profiles 与项目列表
  // （项目加载失败仅降级为不显示启动入口，不打扰主流程）
  useEffect(() => {
    if (tab === 'profiles' || tab === 'history' || tab === 'files') {
      if (tab === 'profiles') void loadProfiles();
      api.getProjects().then(setProjects).catch((err) => console.error('加载项目列表失败', err));
    }
  }, [tab, loadProfiles, setProjects]);

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
    // Docker 中登记的项目可以没有连接配置，仍能进入项目目录启动 Shell。
    for (const project of projects) {
      if (project.path) grouped.set(project.name, []);
    }
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
  }, [profiles, projects]);

  // 「连接」tab 分组首次加载时全部折叠（仅首次，后续手动切换不重置）
  useEffect(() => {
    if (profileGroupsInitRef.current || profileGroups.length === 0) return;
    profileGroupsInitRef.current = true;
    setCollapsedProfileGroups(new Set(profileGroups.map((g) => g.name)));
  }, [profileGroups]);

  const openSession = (session: TerminalInfo) => {
    const name = session.profileName || getTypeInfo(session.terminalType).label;
    if (isDesktopSession(session)) {
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

  // 关闭会话：先弹确认（会杀掉 PTY 里正在运行的进程）。仅手机端可关的会话
  // （creator === 'mobile' 或旧后端的 web 会话）能走到这里；后端还会再校验一次。
  // meta WS 收到推送后自动更新列表。
  const requestCloseSession = useCallback((session: TerminalInfo) => {
    if (!canCloseSession(session)) return;
    setConfirmClose(session);
  }, []);

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

  // 会话右键/长按菜单动作：「以此配置新建终端」需要先确保 profiles 已加载
  const handleSessionMenuAction = useCallback(
    async (action: 'open' | 'new' | 'close', sessionId: string) => {
      setSessionContextMenu(null);
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      if (action === 'close') {
        requestCloseSession(session);
        return;
      }
      if (action === 'open') {
        if (isDesktopSession(session)) setTakeover(session);
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
    [sessions, profiles.length, requestCloseSession, loadProfiles, createNew, setView],
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

  // ===== 会话行长按菜单（触屏右键等价物）=====
  const clearSessionLongPress = () => {
    if (sessionLongPressTimer.current !== null) {
      window.clearTimeout(sessionLongPressTimer.current);
      sessionLongPressTimer.current = null;
    }
  };

  const handleSessionTouchStart = (e: TouchEvent, sessionId: string) => {
    sessionLongPressFired.current = false;
    const touch = e.touches[0];
    clearSessionLongPress();
    sessionLongPressTimer.current = window.setTimeout(() => {
      sessionLongPressFired.current = true;
      if (navigator.vibrate) navigator.vibrate(10);
      showSessionMenu(sessionId, touch.clientX, touch.clientY);
    }, 500);
  };

  const handleSessionTouchEnd = () => {
    clearSessionLongPress();
  };

  const handleSessionTouchMove = () => {
    clearSessionLongPress();
  };

  // 点击外部 / 滚动 关闭菜单
  useEffect(() => {
    if (!contextMenu && !sessionContextMenu && !groupMenu) return;
    const close = () => {
      setContextMenu(null);
      setSessionContextMenu(null);
      setGroupMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close, { passive: true });
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu, sessionContextMenu, groupMenu]);

  // 启动参数预设匹配（commandMatch：预设的匹配串被某条启动命令包含才显示）
  // 与 PC 端 matchingStartupPresets 同规则，配置与项目共用
  const matchPresets = useCallback(
    (commands: string[]) =>
      extraParamPresets.filter((preset) => {
        if (preset.enabled === false) return false;
        if (!preset.commandMatch) return true;
        const match = preset.commandMatch.toLowerCase();
        return commands.some((cmd) => cmd.toLowerCase().includes(match));
      }),
    [extraParamPresets],
  );

  const matchingPresets = useMemo(() => {
    if (!contextMenu) return [];
    const profile = profiles.find((p) => p.id === contextMenu.profileId);
    return matchPresets(profile?.startupCommands || []);
  }, [contextMenu, profiles, matchPresets]);

  // ===== 项目启动 =====
  // 登记了目录即可启动；未配置启动命令时进入该目录的默认 Shell。
  const projectForGroup = useCallback(
    (groupName: string) =>
      projects.find((p) => p.name === groupName && p.path),
    [projects],
  );

  // 与 PC 端 projectStartupCommand 一致：independent 直接替换，否则拼接项目启动命令
  const launchProject = useCallback(
    async (project: Project, preset?: ExtraParamPreset) => {
      setBusyId(`project:${project.name}`);
      setError('');
      try {
        const startupCommand = preset?.mode === 'independent'
          ? preset.params
          : [project.startupCommand?.trim(), preset?.params].filter(Boolean).join(' ');
        const info = await api.createTerminal('', {
          displayName: project.name,
          startupPath: project.path,
          startupGroup: project.name,
          startupCommand,
          extraParamTag: preset?.name,
          extraParamTagColor: preset?.tagColor,
        });
        setView({
          screen: 'terminal',
          terminalId: info.id,
          profileName: info.profileName || project.name,
          loadingMode: info.loadingMode,
          owner: 'web',
        });
      } catch (launchError) {
        setError(launchError instanceof Error ? launchError.message : '启动项目失败');
      } finally {
        setBusyId(null);
      }
    },
    [setView],
  );

  const showGroupMenu = useCallback((projectName: string, x: number, y: number) => {
    // 防止菜单溢出视口右下边缘
    const clampedX = Math.min(x, window.innerWidth - 220);
    const clampedY = Math.min(y, window.innerHeight - 240);
    setGroupMenu({ projectName, x: Math.max(8, clampedX), y: Math.max(8, clampedY) });
  }, []);

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
          项目与命令
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={`nav-tab${tab === 'history' ? ' active' : ''}`}
          onClick={() => setTab('history')}
        >
          历史
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'files'}
          className={`nav-tab${tab === 'files' ? ' active' : ''}`}
          onClick={() => setTab('files')}
        >
          文件
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
                                    onClick={() => {
                                      // 长按刚触发了菜单，拦截紧随其来的 click，避免又打开会话
                                      if (sessionLongPressFired.current) {
                                        sessionLongPressFired.current = false;
                                        return;
                                      }
                                      openSession(session);
                                    }}
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      showSessionMenu(session.id, e.clientX, e.clientY);
                                    }}
                                    onTouchStart={(e) => handleSessionTouchStart(e, session.id)}
                                    onTouchEnd={handleSessionTouchEnd}
                                    onTouchMove={handleSessionTouchMove}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        openSession(session);
                                      }
                                    }}
                                    aria-label={`${name}，${isDesktopSession(session) ? '电脑端，接管' : '网页端，继续'}`}
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
                                    {session.owner === 'web' && (
                                      <span className="tab-nav-owner-badge">
                                        {session.creator === 'mobile' ? '手机' : 'WEB'}
                                      </span>
                                    )}
                                    <span className="tree-item-end">
                                      {canCloseSession(session) && (
                                        <button
                                          type="button"
                                          className="tab-nav-close"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            requestCloseSession(session);
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
            : tab === 'profiles'
              ? profileGroups.length === 0
              ? (
                <div className="session-empty-state">
                  <Server aria-hidden="true" />
                  <strong>暂无连接配置</strong>
                  <small>请在电脑端添加连接或登记项目</small>
                </div>
              )
              : (
                <div className="profile-tree" aria-label="所有连接">
                  {profileGroups.map((group) => {
                    const isGroupCollapsed = collapsedProfileGroups.has(group.name);
                    const project = projectForGroup(group.name);
                    const isGroupBusy = busyId === `project:${group.name}`;
                    return (
                      <div className="tree-node" key={group.name}>
                        <div
                          className="tree-item"
                          style={{ paddingLeft: 8 }}
                          role="button"
                          tabIndex={0}
                          aria-expanded={!isGroupCollapsed}
                          onClick={() => toggleProfileGroup(group.name)}
                          onContextMenu={(e) => {
                            if (!project) return;
                            e.preventDefault();
                            showGroupMenu(project.name, e.clientX, e.clientY);
                          }}
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
                            {isGroupBusy && <span className="tree-item-count">连接中…</span>}
                            <span className="tree-item-count">{group.items.length}</span>
                            {project && (
                              <button
                                type="button"
                                className="tree-item-launch"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  showGroupMenu(project.name, e.clientX, e.clientY);
                                }}
                                aria-label={`启动项目 ${project.name}`}
                                title={`启动项目 ${project.name}`}
                              >
                                <Zap size={13} aria-hidden="true" />
                              </button>
                            )}
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
              )
              : tab === 'files'
                ? <Files />
                : <ClaudeHistory />}
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

      {groupMenu && (() => {
        const project = projects.find((p) => p.name === groupMenu.projectName);
        if (!project) return null;
        const presets = matchPresets([project.startupCommand || '']);
        return (
          <div
            className="profile-context-menu"
            style={{ left: groupMenu.x, top: groupMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                void launchProject(project);
                setGroupMenu(null);
              }}
            >
              启动项目
            </button>
            {presets.map((preset) => (
              <button
                type="button"
                key={preset.id}
                className="context-menu-item context-menu-item-preset"
                onClick={() => {
                  void launchProject(project, preset);
                  setGroupMenu(null);
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
        );
      })()}

      {sessionContextMenu && (() => {
        const session = sessions.find((s) => s.id === sessionContextMenu.sessionId);
        if (!session) return null;
        const isTakeover = isDesktopSession(session);
        const canClose = canCloseSession(session);
        return (
          <div
            className="session-context-menu"
            style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            {isTakeover && (
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
          title="接管电脑终端？"
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
                    owner: session.owner,
                  });
                }}
              >
                接管
              </button>
            </>
          )}
        >
          <div className="web-dialog-desc">
            「{takeover.profileName || getTypeInfo(takeover.terminalType).label}」正在电脑端运行。接管后终端会按手机宽度排版，断开接管后恢复电脑尺寸，任务继续运行。
          </div>
        </Dialog>
      )}

      {/* 关闭会话确认：关闭会杀掉 PTY 里正在运行的进程，误触代价高 */}
      {confirmClose && (
        <Dialog
          title="关闭连接？"
          onClose={() => setConfirmClose(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setConfirmClose(null)}>取消</button>
              <button
                className="btn primary"
                onClick={() => {
                  const session = confirmClose;
                  setConfirmClose(null);
                  void handleCloseSession(session.id);
                }}
              >
                关闭
              </button>
            </>
          )}
        >
          <div className="web-dialog-desc">
            「{confirmClose.profileName || getTypeInfo(confirmClose.terminalType).label}」的会话进程将被终止，且无法恢复。确定关闭吗？
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
              label: '项目与命令',
              icon: Server,
              badge: 0,
            },
            {
              key: 'history' as const,
              label: 'Claude 历史',
              icon: History,
              badge: 0,
            },
            {
              key: 'files' as const,
              label: '文件与 Git',
              icon: FolderGit2,
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
