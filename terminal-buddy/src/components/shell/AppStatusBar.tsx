import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Clock3,
  Cpu,
  Folder,
  FolderTree,
  Globe2,
  MemoryStick,
  SquareTerminal,
} from 'lucide-react';
import type { Profile, SessionHistoryProvider, TerminalType } from '../../types';
import { useAppStore } from '../../stores/appStore';
import { useTaskSummaryStore } from '../../stores/taskSummaryStore';
import { useActiveAgentStats, useAgentEffort, useTerminalAgentUsage } from '../../hooks/useActiveAgentStats';
import { useAgentAvailability } from '../../hooks/useAgentAvailability';
import { useSystemResources } from '../../hooks/useSystemResources';
import { FileManagerDialog } from '../file-explorer/FileManagerDialog';
import { GitNavBar } from '../git/GitNavBar';
import { AgentIcon } from '../agent-chat/AgentIcon';
import { AgentHistoryPopover } from './AgentHistoryPopover';
import { ResourceTrendPopover } from './ResourceTrendPopover';
import { ScheduledTasksStatusEntry } from './ScheduledTasksStatusEntry';
import { StatusBarAgent } from './StatusBarAgent';
import type { AgentStatusView } from './agentStatusView';
import { getWebApiStatus } from '../../services/tauri';
import { isBrowserClient } from '../../services/platform';
import { isClaudeLaunchProfile } from '../../utils/claudeLaunch';
import { getTaskLaunchInfo } from '../../utils/taskLaunchInfo';
import { effectiveProfilePath, projectForDirectory } from '../../utils/projectPath';
import './AppStatusBar.css';

const browserClient = isBrowserClient();

/** 历史入口固定按 Claude / Codex / Antigravity 排序，切换标签时位置不会跳动。 */
const AGENT_KINDS: readonly SessionHistoryProvider[] = ['claude', 'codex', 'antigravity'];

function agentProviderLabel(provider: string): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'antigravity') return 'Antigravity CLI';
  return 'Claude Code';
}

function terminalProviderName(provider: string): string | null {
  return provider === 'antigravity' ? 'Google 账号' : null;
}

function agentHistoryLabel(provider: SessionHistoryProvider): string {
  return agentProviderLabel(provider);
}

/** 只有本地 Shell 的启动目录才是本地路径，SSH / 容器路径不能拿来检测本地 Git。 */
const LOCAL_SHELL_TYPES: ReadonlySet<TerminalType> = new Set([
  'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh',
]);

/** 当前会话的连接详情，仅用于状态栏条目的悬浮说明。 */
function connectionDetail(profile: Profile | undefined): string | undefined {
  if (!profile) return undefined;
  switch (profile.terminalType) {
    case 'ssh': {
      const target = [profile.sshUser, profile.sshHost].filter(Boolean).join('@');
      if (!target) return undefined;
      return profile.sshPort ? `${target}:${profile.sshPort}` : target;
    }
    case 'docker':
      return profile.dockerContainerName || profile.dockerContainerId || undefined;
    case 'k8s':
      return [profile.k8sNamespace, profile.k8sPodName].filter(Boolean).join(' / ') || undefined;
    case 'mstsc': {
      const target = [profile.mstscUser, profile.mstscHost].filter(Boolean).join('@');
      return target || undefined;
    }
    default:
      return profile.startupPath || undefined;
  }
}

/** 「项目与命令」面板的选中项：项目节点或某个具体命令。 */
interface SidebarSelection {
  kind: 'project' | 'profile';
  name: string;
  /** 连接详情或项目路径，仅用于悬浮说明。 */
  detail?: string;
  /** 状态栏展示的目录；本地命令可浏览 / 检测 Git，远程命令只展示并复制路径。 */
  directory: string | null;
  /** 目录是否属于本机文件系统。 */
  isLocalDirectory: boolean;
  /** 选中命令时从启动命令识别出的 Agent；项目本身不限定 Agent。 */
  provider: SessionHistoryProvider | null;
}

/** 窄屏下只保留路径末尾两段，完整路径放在条目 tooltip 里。 */
function shortenPath(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…${separator}${parts.slice(-2).join(separator)}`;
}

interface WebApiBarStatus {
  enabled: boolean;
  port: number;
}

/** Web 服务状态：挂载时查一次，设置变更后重新查询，不额外轮询。 */
function useWebApiBarStatus(): WebApiBarStatus | null {
  const [status, setStatus] = useState<WebApiBarStatus | null>(null);

  useEffect(() => {
    if (browserClient) return;
    let cancelled = false;
    const refresh = () => {
      getWebApiStatus()
        .then(info => {
          if (!cancelled) setStatus({ enabled: info.enabled, port: info.port });
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    };
    refresh();
    window.addEventListener('app-settings-changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('app-settings-changed', refresh);
    };
  }, []);

  return status;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 时钟独立刷新，避免每分钟重渲染整条状态栏。 */
const StatusBarClock = memo(function StatusBarClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const date = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
  return (
    <span className="app-statusbar-item" title={`本地时间 · ${date}`}>
      <Clock3 className="app-statusbar-icon" aria-hidden="true" />
      <span className="app-statusbar-mono">{time}</span>
    </span>
  );
});

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 GB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** 占用较高时用警示色，避免只在悬浮提示里才看得到。 */
function resourceLevel(percent: number): string {
  if (percent >= 90) return ' critical';
  if (percent >= 75) return ' warn';
  return '';
}

/** CPU / 内存独立轮询，避免每次读数刷新整条状态栏；点击条目打开近 2 小时趋势图。 */
const StatusBarResources = memo(function StatusBarResources() {
  const resources = useSystemResources();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null);
  const groupRef = useRef<HTMLSpanElement>(null);

  const openTrend = useCallback(() => {
    const rect = groupRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.top + 6,
    });
    setOpen(true);
  }, []);
  const closeTrend = useCallback(() => setOpen(false), []);
  const toggleTrend = useCallback(() => {
    if (open) setOpen(false);
    else openTrend();
  }, [open, openTrend]);

  if (!resources) return null;

  const cpu = Math.round(resources.cpuUsage);
  const memory = Math.round(resources.memoryUsage);
  const memoryDetail = `${formatBytes(resources.memoryUsed)} / ${formatBytes(resources.memoryTotal)}`;
  return (
    <span className="app-statusbar-resource-group" ref={groupRef}>
      <button
        type="button"
        className="app-statusbar-item"
        onClick={toggleTrend}
        title={`CPU 使用率 ${cpu}%${resources.cpuCount > 0 ? ` · ${resources.cpuCount} 个逻辑核心` : ''} · 点击查看近 2 小时趋势`}
      >
        <Cpu className="app-statusbar-icon" aria-hidden="true" />
        <span className={`app-statusbar-mono app-statusbar-resource${resourceLevel(cpu)}`}>{cpu}%</span>
      </button>
      <button
        type="button"
        className="app-statusbar-item"
        onClick={toggleTrend}
        title={`内存 ${memoryDetail} · ${memory}% · 点击查看近 2 小时趋势`}
      >
        <MemoryStick className="app-statusbar-icon" aria-hidden="true" />
        <span className={`app-statusbar-mono app-statusbar-resource${resourceLevel(memory)}`}>{memory}%</span>
      </button>
      {open && anchor && createPortal(
        <ResourceTrendPopover anchor={anchor} anchorRef={groupRef} onClose={closeTrend} />,
        document.body,
      )}
    </span>
  );
});

/**
 * 窗口底部状态栏：当前会话身份、工作目录、Git 与 Web 服务状态。
 * 所有数据来自现有 store 与缓存；取不到的条目直接不渲染，不占位。
 */export const AppStatusBar = memo(function AppStatusBar() {
  const sessions = useAppStore(s => s.sessions);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const sessionDirectories = useAppStore(s => s.sessionDirectories);
  const currentDirectory = useAppStore(s => s.currentDirectory);
  const terminalActivities = useAppStore(s => s.terminalActivities);
  const profiles = useAppStore(s => s.profiles);
  const projects = useAppStore(s => s.projects);
  const selectedProfileId = useAppStore(s => s.selectedProfileId);
  const configPanelVisible = useAppStore(s => s.configPanelVisible);
  const lastClickRegion = useAppStore(s => s.lastClickRegion);
  const claudeSessionIds = useAppStore(s => s.claudeSessionIds);
  const agentSessionBindings = useAppStore(s => s.agentSessionBindings);
  const taskSummaries = useTaskSummaryStore(s => s.summaries);
  const taskProviders = useTaskSummaryStore(s => s.providers);
  const activeSpecialTab = useAppStore(s => s.activeSpecialTab);
  const activeAgentTabKey = useAppStore(s => s.activeAgentTabKey);
  const agentTabs = useAppStore(s => s.agentTabs);
  const claudeReplayTab = useAppStore(s => s.claudeReplayTab);
  const openSettingsDialog = useAppStore(s => s.openSettingsDialog);
  const showToast = useAppStore(s => s.showToast);
  const [fileManagerOpen, setFileManagerOpen] = useState(false);
  // 可能同时列出多个 Agent 的历史入口，记住当前展开的是哪一个。
  const [agentHistoryOpen, setAgentHistoryOpen] = useState<SessionHistoryProvider | null>(null);
  const [agentHistoryAnchor, setAgentHistoryAnchor] = useState<{ left: number; bottom: number } | null>(null);
  // 触发浮层的按钮，供浮层判断「点的是入口本身」而不是外部点击。
  const agentHistoryRef = useRef<HTMLElement | null>(null);

  // 选中的聊天标签：原生会话展示 Agent 状态，接力标签沿用背后的终端会话。
  const activeAgentTab = activeSpecialTab === 'agent-chat'
    ? agentTabs.find(item => item.key === activeAgentTabKey)
    : undefined;
  const activeNativeAgentTab = activeAgentTab?.shape === 'native' ? activeAgentTab : undefined;
  // 原生聊天页没有底层终端；终端身份只在终端 / Git 等以终端为上下文的页面展示。
  const statusSessionId = activeNativeAgentTab
    ? null
    : activeAgentTab?.shape === 'relay' ? activeAgentTab.terminalId : activeSessionId;
  const session = statusSessionId ? sessions.find(item => item.id === statusSessionId) : undefined;
  const profile = session?.profileId ? profiles.find(item => item.id === session.profileId) : undefined;
  const isEditor = session?.sessionType === 'editor';
  const isTerminal = Boolean(session) && !isEditor;
  // 会话记录目录 → 会话启动目录 → 配置里的本地启动目录 → 远程路径 → 全局最近目录。
  const directory = session
    ? sessionDirectories[session.id]
      || session.startupPath
      || (profile && LOCAL_SHELL_TYPES.has(profile.terminalType) ? profile.startupPath : '')
      || session.sshRemotePath
      || (isTerminal ? currentDirectory : '')
      || null
    : null;
  // Git 操作直接平铺在状态栏：只对本地 Shell 有意义，SSH / 容器路径不是本机仓库。
  const gitDirectory = session && isTerminal && LOCAL_SHELL_TYPES.has(session.terminalType)
    ? directory
    : null;
  // 终端每次回车都会刷新活动时间戳：交给状态栏 Git 条目在校对时使用，
  // 这样在终端里执行 git checkout / switch 后分支能尽快跟上。
  const terminalActivityAt = session ? terminalActivities[session.id]?.updatedAt : undefined;
  // 只有本地 Shell 的目录属于本机文件系统；远程会话路径在远端，点击仍复制路径。
  const canBrowseLocal = Boolean(
    session && directory && isTerminal && LOCAL_SHELL_TYPES.has(session.terminalType),
  );

  // 「项目与命令」面板获得焦点时，状态栏切换到选中项目 / 命令的上下文；
  // 点击终端或会话标签后焦点离开面板，状态栏恢复跟随活动会话。
  const selection = useMemo<SidebarSelection | null>(() => {
    if (!configPanelVisible || lastClickRegion !== 'config' || !selectedProfileId) return null;

    // 项目节点：面板里用项目名作为树节点 id。
    const selectedProject = projects.find(item => item.name === selectedProfileId);
    if (selectedProject) {
      const dir = selectedProject.path.trim() || null;
      return {
        kind: 'project',
        name: selectedProject.name,
        detail: dir ?? '未配置项目路径',
        directory: dir,
        isLocalDirectory: Boolean(dir),
        provider: null,
      };
    }

    // 命令节点：本地 Shell 允许相对启动路径叠加项目根，远程命令的路径本身就是远端目录。
    const selected = profiles.find(item => item.id === selectedProfileId);
    if (!selected) return null;
    const isLocal = LOCAL_SHELL_TYPES.has(selected.terminalType);
    const dir = isLocal
      ? effectiveProfilePath(selected, projects) || null
      : selected.startupPath.trim() || null;
    const launch = getTaskLaunchInfo('', selected.startupCommands);
    return {
      kind: 'profile',
      name: selected.name,
      detail: isLocal ? dir ?? undefined : connectionDetail(selected) ?? dir ?? undefined,
      directory: dir,
      isLocalDirectory: isLocal && Boolean(dir),
      provider: launch?.provider ?? (isClaudeLaunchProfile(selected) ? 'claude' : null),
    };
  }, [configPanelVisible, lastClickRegion, selectedProfileId, projects, profiles]);

  // 状态栏的工作上下文：面板有选中项时跟随选中项，否则跟随活动终端会话或原生 AI 会话的项目目录。
  const nativeProjectDir = activeNativeAgentTab?.projectPath?.trim() || null;
  const contextDirectory = selection
    ? selection.directory
    : (isTerminal ? directory : nativeProjectDir);
  const contextCanBrowseLocal = selection
    ? selection.isLocalDirectory
    : (isTerminal ? canBrowseLocal : Boolean(nativeProjectDir));
  const contextGitDirectory = selection
    ? (selection.isLocalDirectory ? selection.directory : null)
    : (isTerminal ? gitDirectory : nativeProjectDir);
  const contextTerminalActivityAt = selection ? undefined : terminalActivityAt;

  const web = useWebApiBarStatus();
  // 选中原生会话时展示模型 / 思考强度 / 上下文 / Token / 缓存命中率。
  const agentStats = useActiveAgentStats(activeNativeAgentTab?.sessionId ?? null);
  const agentModel = agentStats?.model ?? activeNativeAgentTab?.model ?? null;
  const agentEffort = useAgentEffort(agentStats?.providerId, agentModel);
  const terminalLaunch = session && isTerminal
    ? getTaskLaunchInfo(session.extraParams, profile?.startupCommands, session.extraParamMode)
    : undefined;
  // 终端里启动的 Agent 没有推送通道：按终端轮询 transcript 快照。服务端发现的 provider、
  // 任务摘要、绑定、claude 会话 ID 或 hook 活动任一存在就说明这是 Agent 终端，而不仅是普通 shell。
  const terminalAgentProvider = session && isTerminal ? (
    taskProviders[session.id]
    ?? taskSummaries[session.id]?.provider
    ?? agentSessionBindings[session.id]?.provider
    ?? (terminalActivities[session.id] && terminalActivities[session.id].runtimeKind !== 'shell'
      ? terminalActivities[session.id].runtimeKind
      : undefined)
    ?? (claudeSessionIds[session.id] ? 'claude' : undefined)
  ) : undefined;
  const terminalUsage = useTerminalAgentUsage(terminalAgentProvider && session ? session.id : null);

  // 原生会话与终端 Agent 都收敛成同一种视图，交给 StatusBarAgent 统一展示。
  const agentStatusView: AgentStatusView | null = activeNativeAgentTab ? {
    provider: activeNativeAgentTab.provider,
    providerLabel: agentHistoryLabel(activeNativeAgentTab.provider),
    providerName: agentStats?.providerName ?? null,
    model: agentModel,
    effort: agentEffort,
    status: agentStats?.status ?? null,
    context: agentStats?.usage?.context ?? null,
    sessionTotal: agentStats?.usage?.sessionTotal ?? null,
    lastTurn: agentStats?.usage?.lastTurn ?? null,
    source: 'native',
    updatedAt: null,
  } : terminalUsage ? {
    provider: terminalUsage.provider,
    providerLabel: agentProviderLabel(terminalUsage.provider),
    providerName: terminalProviderName(terminalUsage.provider),
    model: terminalUsage.model ?? (terminalLaunch?.provider === terminalUsage.provider ? terminalLaunch.model ?? null : null),
    effort: terminalUsage.effort ?? (terminalLaunch?.provider === terminalUsage.provider ? terminalLaunch.effort ?? null : null),
    status: null,
    context: terminalUsage.contextUsedTokens != null || terminalUsage.contextWindowTokens != null ? {
      usedTokens: terminalUsage.contextUsedTokens,
      windowTokens: terminalUsage.contextWindowTokens,
      basis: '',
      updating: false,
    } : null,
    sessionTotal: terminalUsage.total,
    lastTurn: null,
    source: 'terminal',
    updatedAt: terminalUsage.updatedAt,
  } : terminalAgentProvider ? {
    provider: terminalAgentProvider,
    providerLabel: agentProviderLabel(terminalAgentProvider),
    providerName: terminalProviderName(terminalAgentProvider),
    model: terminalLaunch?.provider === terminalAgentProvider ? terminalLaunch.model ?? null : null,
    effort: terminalLaunch?.provider === terminalAgentProvider ? terminalLaunch.effort ?? null : null,
    status: null,
    context: null,
    sessionTotal: null,
    lastTurn: null,
    source: 'terminal',
    updatedAt: null,
  } : null;

  // 状态栏的 Agent 历史入口：识别当前标签页背后的 Agent 与项目。
  // 原生聊天 / 回放标签有明确的 provider 与项目路径；普通终端则依次看
  // Agent 绑定、hook 活动、启动命令，最终回退到「用 Claude 连接启动」的配置。
  const agentTarget = useMemo<{ provider: SessionHistoryProvider; projectDir: string } | null>(() => {
    const scopeDir = (dir: string | undefined | null) => {
      if (!dir) return undefined;
      return projectForDirectory(projects, dir)?.path ?? dir;
    };

    if (activeSpecialTab === 'agent-chat') {
      const tab = agentTabs.find(item => item.key === activeAgentTabKey);
      if (tab?.shape === 'native') {
        const dir = scopeDir(tab.projectPath);
        return dir ? { provider: tab.provider, projectDir: dir } : null;
      }
      if (tab?.shape === 'relay') {
        const relaySession = sessions.find(item => item.id === tab.terminalId);
        const dir = scopeDir(sessionDirectories[tab.terminalId] || relaySession?.startupPath);
        const provider = tab.provider
          ?? terminalActivities[tab.terminalId]?.provider
          ?? agentSessionBindings[tab.terminalId]?.provider;
        return dir && provider ? { provider, projectDir: dir } : null;
      }
      return null;
    }

    if (activeSpecialTab === 'claude-replay' && claudeReplayTab) {
      const dir = scopeDir(claudeReplayTab.projectDir);
      return dir ? { provider: claudeReplayTab.provider ?? 'claude', projectDir: dir } : null;
    }

    // Git 历史等特殊标签仍以当前终端会话为准。
    if (!session || session.sessionType === 'editor') return null;
    // Agent 历史库在本机：SSH / Docker / K8s 的目录不是本地路径，不提供入口。
    if (!LOCAL_SHELL_TYPES.has(session.terminalType) || !directory) return null;
    const activity = terminalActivities[session.id];
    const binding = agentSessionBindings[session.id];
    const launch = getTaskLaunchInfo(session.extraParams, profile?.startupCommands, session.extraParamMode);
    const provider = taskProviders[session.id]
      ?? taskSummaries[session.id]?.provider
      ?? binding?.provider
      ?? activity?.provider
      ?? (activity && activity.runtimeKind !== 'shell' ? activity.runtimeKind : undefined)
      ?? launch?.provider
      ?? (claudeSessionIds[session.id] ? 'claude' : undefined)
      ?? (profile && isClaudeLaunchProfile(profile) ? 'claude' : undefined);
    if (!provider) return null;
    const dir = scopeDir(directory);
    return dir ? { provider, projectDir: dir } : null;
  }, [
    activeSpecialTab, agentTabs, activeAgentTabKey, sessions, sessionDirectories,
    terminalActivities, agentSessionBindings, taskProviders, taskSummaries, claudeReplayTab,
    session, directory, profile, projects, claudeSessionIds,
  ]);

  // 面板选中项优先：选中项目时列出该项目下所有可用 Agent 的历史；
  // 选中远程命令时没有本地历史索引，退回各 Agent 最近的会话。
  const agentProvider = selection ? selection.provider ?? undefined : agentTarget?.provider;
  const agentProjectDir = selection
    ? (selection.isLocalDirectory ? selection.directory : null)
    : agentTarget?.projectDir;

  // 本机装了哪些 Agent：装了几个就列几个历史入口，当前会话的 Agent 始终保留。
  // 没有打开任何 Agent 时入口依然在，projectDir 为 null 表示展开全部项目的最近会话。
  const agentAvailability = useAgentAvailability();
  const agentTargets = useMemo<{ provider: SessionHistoryProvider; projectDir: string | null }[]>(() => {
    const available = agentAvailability
      ? AGENT_KINDS.filter(kind => agentAvailability[kind])
      : [...AGENT_KINDS];
    if (!agentProjectDir) {
      return available.map(provider => ({ provider, projectDir: null }));
    }
    // 选中项目本身：不限定 Agent，统一按项目根过滤历史会话。
    if (!agentProvider) {
      return available.map(provider => ({ provider, projectDir: agentProjectDir }));
    }
    const providers = agentAvailability
      ? AGENT_KINDS.filter(kind => kind === agentProvider || agentAvailability[kind])
      : [agentProvider];
    return providers.map(provider => ({ provider, projectDir: agentProjectDir }));
  }, [agentProvider, agentProjectDir, agentAvailability]);
  const openAgentTarget = agentHistoryOpen
    ? agentTargets.find(target => target.provider === agentHistoryOpen) ?? null
    : null;

  // 切换标签或 Agent 后，旧浮层的项目上下文已失效。
  useEffect(() => { setAgentHistoryOpen(null); }, [agentProvider, agentProjectDir]);

  const toggleAgentHistory = useCallback((
    provider: SessionHistoryProvider,
    trigger: HTMLElement,
  ) => {
    if (agentHistoryOpen === provider) {
      setAgentHistoryOpen(null);
      return;
    }
    agentHistoryRef.current = trigger;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(400, window.innerWidth - 16);
    setAgentHistoryAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - rect.top + 6,
    });
    setAgentHistoryOpen(provider);
  }, [agentHistoryOpen]);

  const copyDirectory = useCallback((path: string) => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(path)
        .then(() => showToast('已复制路径', 'success'))
        .catch(() => showToast(`路径：${path}`, 'info'));
    } else {
      showToast(`路径：${path}`, 'info');
    }
  }, [showToast]);

  const detail = connectionDetail(profile);

  return (
    <div className="app-statusbar" role="group" aria-label="应用状态栏">
      {selection ? (
        <span
          className="app-statusbar-item app-statusbar-session"
          title={`已选中${selection.kind === 'project' ? '项目' : '命令'} · ${selection.name}${selection.detail ? ` · ${selection.detail}` : ''}`}
        >
          {selection.kind === 'project' ? (
            <FolderTree className="app-statusbar-icon" aria-hidden="true" />
          ) : (
            <SquareTerminal className="app-statusbar-icon" aria-hidden="true" />
          )}
          <span className="app-statusbar-label">{selection.name}</span>
          <span className="app-statusbar-badge">{selection.kind === 'project' ? '项目' : '命令'}</span>
        </span>
      ) : session ? (
        <span
          className="app-statusbar-item app-statusbar-session app-statusbar-optional"
          title={detail ? `${session.profileName} · ${detail}` : session.profileName}
        >
          <span className="app-statusbar-label">{session.profileName}</span>
          {session.owner === 'web' && <span className="app-statusbar-badge">Web</span>}
        </span>
      ) : activeNativeAgentTab ? (
        <span
          className="app-statusbar-item app-statusbar-session"
          title={`${agentHistoryLabel(activeNativeAgentTab.provider)} · ${activeNativeAgentTab.projectPath}`}
        >
          <AgentIcon
            provider={activeNativeAgentTab.provider}
            className={`app-statusbar-agent-logo provider-${activeNativeAgentTab.provider}`}
          />
          <span className="app-statusbar-label">{activeNativeAgentTab.title}</span>
        </span>
      ) : (
        <span className="app-statusbar-item app-statusbar-idle" title="当前没有活动的终端会话">
          <span className="app-statusbar-dot idle" aria-hidden="true" />
          <span>无活动会话</span>
        </span>
      )}

      {/* 选中项目 / 命令时展示的是该项目上下文，不显示活动会话的模型与用量。 */}
      {!selection && agentStatusView && <StatusBarAgent view={agentStatusView} />}

      {agentTargets.length > 0 && (
        <>
          <span className="app-statusbar-divider app-statusbar-optional" aria-hidden="true" />
          {agentTargets.map(target => {
            const open = agentHistoryOpen === target.provider;
            return (
              <button
                key={target.provider}
                type="button"
                className={`app-statusbar-item app-statusbar-clickable${open ? ' active' : ''}`}
                title={target.projectDir
                  ? `查看 ${agentHistoryLabel(target.provider)} 在当前项目的历史会话`
                  : `查看 ${agentHistoryLabel(target.provider)} 最近的会话历史`}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={event => toggleAgentHistory(target.provider, event.currentTarget)}
              >
                <AgentIcon
                  provider={target.provider}
                  className={`app-statusbar-agent-logo provider-${target.provider}`}
                />
                <span className="app-statusbar-agent-history-label">历史</span>
              </button>
            );
          })}
        </>
      )}

      {contextDirectory && (
        <>
          <span className="app-statusbar-divider app-statusbar-optional" aria-hidden="true" />
          <button
            type="button"
            className="app-statusbar-item app-statusbar-clickable"
            title={contextCanBrowseLocal ? `打开文件管理 · ${contextDirectory}（右键复制路径）` : `复制路径 ${contextDirectory}`}
            onClick={() => {
              if (contextCanBrowseLocal) setFileManagerOpen(true);
              else copyDirectory(contextDirectory);
            }}
            onContextMenu={event => {
              if (!contextCanBrowseLocal) return;
              event.preventDefault();
              copyDirectory(contextDirectory);
            }}
          >
            <Folder className="app-statusbar-icon" aria-hidden="true" />
            <span className="app-statusbar-path-full">{contextDirectory}</span>
            <span className="app-statusbar-path-short">{shortenPath(contextDirectory)}</span>
          </button>

          {contextGitDirectory && (
            <GitNavBar
              variant="statusbar"
              currentDirectory={contextGitDirectory}
              terminalActivityAt={contextTerminalActivityAt}
            />
          )}
        </>
      )}

      <span className="app-statusbar-right">
        {browserClient ? (
          <span className="app-statusbar-item app-statusbar-optional" title="已连接到 TerminalBuddy 服务端">
            <span className="app-statusbar-dot" aria-hidden="true" />
            <span>已连接</span>
          </span>
        ) : web ? (
          <button
            type="button"
            className="app-statusbar-item app-statusbar-clickable app-statusbar-optional"
            title={web.enabled ? `Web 服务已启用 · 端口 ${web.port} · 点击打开 Web 管理` : 'Web 服务未启用 · 点击打开 Web 管理'}
            onClick={() => openSettingsDialog('web-management')}
          >
            <Globe2 className="app-statusbar-icon" aria-hidden="true" />
            <span>Web</span>
            {web.enabled ? (
              <>
                <span className="app-statusbar-mono">:{web.port}</span>
                <span className="app-statusbar-dot" aria-hidden="true" />
              </>
            ) : (
              <span className="app-statusbar-muted">未启用</span>
            )}
          </button>
        ) : null}

        <ScheduledTasksStatusEntry />

        <StatusBarResources />

        <StatusBarClock />
      </span>

      {contextDirectory && fileManagerOpen && (
        <FileManagerDialog
          open
          initialPath={contextDirectory}
          onClose={() => setFileManagerOpen(false)}
        />
      )}

      {openAgentTarget && agentHistoryAnchor && createPortal(
        <AgentHistoryPopover
          key={`${openAgentTarget.provider}\u0000${openAgentTarget.projectDir ?? '*'}`}
          provider={openAgentTarget.provider}
          projectDir={openAgentTarget.projectDir}
          anchor={agentHistoryAnchor}
          anchorRef={agentHistoryRef}
          onClose={() => setAgentHistoryOpen(null)}
        />,
        document.body,
      )}
    </div>
  );
});
