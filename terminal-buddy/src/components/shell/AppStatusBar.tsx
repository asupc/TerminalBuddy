import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Boxes,
  Clock3,
  Container,
  Cpu,
  FileText,
  Folder,
  GitBranch,
  Globe2,
  MemoryStick,
  Monitor,
  Server,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import type { Profile, TerminalType } from '../../types';
import { isTerminalWorking, useAppStore } from '../../stores/appStore';
import { useGitRepositoryStatus } from '../../hooks/useGitRepositoryStatus';
import { useSystemResources } from '../../hooks/useSystemResources';
import { ResourceTrendPopover } from './ResourceTrendPopover';
import { getWebApiStatus, type GitRepositoryStatus } from '../../services/tauri';
import { isBrowserClient } from '../../services/platform';
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

function gitStatusTitle(status: GitRepositoryStatus): string {
  const sync = [
    status.ahead > 0 ? `领先 ${status.ahead}` : '',
    status.behind > 0 ? `落后 ${status.behind}` : '',
  ].filter(Boolean).join(' · ');
  const changes = status.changedCount > 0 ? `${status.changedCount} 处未提交变更` : '工作区干净';
  const action = status.changedCount > 0 ? '点击查看变更文件' : '点击打开 Git 历史';
  return [`Git · ${status.branch}`, sync, changes, action].filter(Boolean).join(' · ');
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
  const openGitHistoryTab = useAppStore(s => s.openGitHistoryTab);
  const openGitChangesTab = useAppStore(s => s.openGitChangesTab);
  const openSettingsDialog = useAppStore(s => s.openSettingsDialog);
  const showToast = useAppStore(s => s.showToast);

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
  // Git 只对本地 Shell 有意义：SSH / 容器路径不是本机仓库。
  const git = useGitRepositoryStatus(
    session && isTerminal && LOCAL_SHELL_TYPES.has(session.terminalType) ? directory : null,
  );
  const web = useWebApiBarStatus();
  const working = isTerminal && session ? isTerminalWorking(terminalActivities[session.id]) : false;

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

      {isTerminal && directory && (
        <>
          <span className="app-statusbar-divider app-statusbar-optional" aria-hidden="true" />
          <button
            type="button"
            className="app-statusbar-item app-statusbar-clickable"
            title={`复制路径 ${directory}`}
            onClick={() => copyDirectory(directory)}
          >
            <Folder className="app-statusbar-icon" aria-hidden="true" />
            <span className="app-statusbar-path-full">{directory}</span>
            <span className="app-statusbar-path-short">{shortenPath(directory)}</span>
          </button>

          {git && (
            <button
              type="button"
              className="app-statusbar-item app-statusbar-clickable app-statusbar-optional"
              title={gitStatusTitle(git)}
              onClick={() => {
                if (git.changedCount > 0) {
                  openGitChangesTab({ repoRoot: git.repoRoot, branch: git.branch });
                } else {
                  openGitHistoryTab({ repoRoot: git.repoRoot, branch: git.branch });
                }
              }}
            >
              <GitBranch className="app-statusbar-icon" aria-hidden="true" />
              <span>{git.branch}</span>
              {git.ahead > 0 && <span className="app-statusbar-sync">↑{git.ahead}</span>}
              {git.behind > 0 && <span className="app-statusbar-sync">↓{git.behind}</span>}
              {git.changedCount > 0 && (
                <span className="app-statusbar-changes">{git.changedCount} 处变更</span>
              )}
            </button>
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
    </div>
  );
});
