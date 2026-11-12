import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Boxes,
  Clock3,
  Container,
  Cpu,
  FileText,
  Folder,
  Globe2,
  MemoryStick,
  Monitor,
  Server,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import type { Profile, SessionHistoryProvider, TerminalType } from '../../types';
import { isTerminalWorking, useAppStore } from '../../stores/appStore';
import { useAgentAvailability } from '../../hooks/useAgentAvailability';
import { useSystemResources } from '../../hooks/useSystemResources';
import { FileManagerDialog } from '../file-explorer/FileManagerDialog';
import { GitNavBar } from '../git/GitNavBar';
import { AgentIcon } from '../agent-chat/AgentIcon';
import { AgentHistoryPopover } from './AgentHistoryPopover';
import { ResourceTrendPopover } from './ResourceTrendPopover';
import { getWebApiStatus } from '../../services/tauri';
import { isBrowserClient } from '../../services/platform';
import { isClaudeLaunchProfile } from '../../utils/claudeLaunch';
import { getTaskLaunchInfo } from '../../utils/taskLaunchInfo';
import { projectForDirectory } from '../../utils/projectPath';
import { APP_VERSION } from '../../version';
import './AppStatusBar.css';

const TYPE_ICONS: Record<TerminalType, LucideIcon> = {
  powershell: SquareTerminal,
  pwsh: SquareTerminal,
  cmd: SquareTerminal,
  bash: SquareTerminal,
  sh: SquareTerminal,
  zsh: SquareTerminal,
  ssh: Server,
  docker: Container,
  k8s: Boxes,
  mstsc: Monitor,
  editor: FileText,
};

const TYPE_LABELS: Record<TerminalType, string> = {
  powershell: 'PowerShell',
  pwsh: 'PowerShell 7',
  cmd: 'CMD',
  bash: 'Bash',
  sh: 'Sh',
  zsh: 'Zsh',
  ssh: 'SSH',
  docker: 'Docker',
  k8s: 'K8s',
  mstsc: '远程桌面',
  editor: '编辑器',
};

const browserClient = isBrowserClient();

/** 历史入口固定按 Claude / Codex 排序，切换标签时位置不会跳动。 */
const AGENT_KINDS: readonly SessionHistoryProvider[] = ['claude', 'codex'];

function agentHistoryLabel(provider: SessionHistoryProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
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
  const claudeSessionIds = useAppStore(s => s.claudeSessionIds);
  const agentSessionBindings = useAppStore(s => s.agentSessionBindings);
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

  const session = activeSessionId ? sessions.find(item => item.id === activeSessionId) : undefined;
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
  // 只有本地 Shell 的目录属于本机文件系统；远程会话路径在远端，点击仍复制路径。
  const canBrowseLocal = Boolean(
    session && directory && isTerminal && LOCAL_SHELL_TYPES.has(session.terminalType),
  );
  const web = useWebApiBarStatus();
  const working = isTerminal && session ? isTerminalWorking(terminalActivities[session.id]) : false;

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
    const provider = binding?.provider
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
    terminalActivities, agentSessionBindings, claudeReplayTab, session, directory,
    profile, projects, claudeSessionIds,
  ]);

  const agentProvider = agentTarget?.provider;
  const agentProjectDir = agentTarget?.projectDir;

  // 本机装了哪些 Agent：装了几个就列几个历史入口，当前会话的 Agent 始终保留。
  // 没有打开任何 Agent 时入口依然在，projectDir 为 null 表示展开全部项目的最近会话。
  const agentAvailability = useAgentAvailability();
  const agentTargets = useMemo<{ provider: SessionHistoryProvider; projectDir: string | null }[]>(() => {
    const available = agentAvailability
      ? AGENT_KINDS.filter(kind => agentAvailability[kind])
      : [...AGENT_KINDS];
    if (!agentProvider || !agentProjectDir) {
      return available.map(provider => ({ provider, projectDir: null }));
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

  const type = session?.terminalType;
  const TypeIcon = type ? TYPE_ICONS[type] : SquareTerminal;
  const typeLabel = type ? TYPE_LABELS[type] : '';
  const detail = connectionDetail(profile);

  return (
    <div className="app-statusbar" role="group" aria-label="应用状态栏">
      {session && type ? (
        <>
          <span
            className="app-statusbar-item"
            title={detail ? `${typeLabel} · ${detail}` : typeLabel}
          >
            <TypeIcon className="app-statusbar-icon" aria-hidden="true" />
            <span>{typeLabel}</span>
          </span>

          {isTerminal && (
            <span
              className="app-statusbar-item"
              title={working ? 'Claude / Codex 正在执行任务' : '当前会话空闲'}
            >
              <span className={`app-statusbar-dot${working ? ' running' : ' idle'}`} aria-hidden="true" />
              <span>{working ? '运行中' : '空闲'}</span>
            </span>
          )}

          <span
            className="app-statusbar-item app-statusbar-session app-statusbar-optional"
            title={detail ? `${session.profileName} · ${detail}` : session.profileName}
          >
            <span className="app-statusbar-label">{session.profileName}</span>
            {session.owner === 'web' && <span className="app-statusbar-badge">Web</span>}
          </span>
        </>
      ) : (
        <span className="app-statusbar-item app-statusbar-idle" title="当前没有活动的终端会话">
          <span className="app-statusbar-dot idle" aria-hidden="true" />
          <span>无活动会话</span>
        </span>
      )}

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

      {isTerminal && directory && (
        <>
          <span className="app-statusbar-divider app-statusbar-optional" aria-hidden="true" />
          <button
            type="button"
            className="app-statusbar-item app-statusbar-clickable"
            title={canBrowseLocal ? `打开文件管理 · ${directory}（右键复制路径）` : `复制路径 ${directory}`}
            onClick={() => {
              if (canBrowseLocal) setFileManagerOpen(true);
              else copyDirectory(directory);
            }}
            onContextMenu={event => {
              if (!canBrowseLocal) return;
              event.preventDefault();
              copyDirectory(directory);
            }}
          >
            <Folder className="app-statusbar-icon" aria-hidden="true" />
            <span className="app-statusbar-path-full">{directory}</span>
            <span className="app-statusbar-path-short">{shortenPath(directory)}</span>
          </button>

          {gitDirectory && (
            <GitNavBar variant="statusbar" currentDirectory={gitDirectory} />
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

        <StatusBarResources />

        <StatusBarClock />

        <span className="app-statusbar-item" title={`当前版本 v${APP_VERSION}`}>
          <span className="app-statusbar-mono">v{APP_VERSION}</span>
        </span>
      </span>

      {directory && (
        <FileManagerDialog
          open={fileManagerOpen}
          initialPath={directory}
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
