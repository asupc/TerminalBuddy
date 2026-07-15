import { FC, FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CircleSlash2, GitBranch as GitBranchIcon, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import {
  gitCheckoutBranch,
  gitCommitPaths,
  gitGetChangedFiles,
  gitListBranches,
  gitPreviewPush,
  gitPull,
  gitPushWithOptions,
  listenGitPushOutput,
  type GitBranch,
  type GitChangedFile,
  type GitPushPreview,
  type GitPullResult,
  type GitPushOptions,
  type GitPushResult,
  type GitRepositoryStatus,
} from '../services/tauri';
import {
  GIT_STATUS_CACHE_TTL_MS,
  getCachedGitRepositoryStatus,
  loadGitRepositoryStatus,
} from '../services/gitStatusCache';
import { useAppStore } from '../stores/appStore';

type GitPopover = 'branches' | null;
type GitAction = 'checkout' | 'commit' | 'pull' | 'push' | null;
type PullDialogTab = 'log' | 'commits' | 'refs';
type GitToolbarIconName = 'pull' | 'commit' | 'push' | 'history';
type PullDialogState = {
  phase: 'running' | 'success' | 'error';
  command: string;
  output: string;
  activeTab: PullDialogTab;
  result?: GitPullResult;
  error?: string;
};

type PushPhase = 'form' | 'running' | 'success' | 'error';

interface PushDialogState {
  phase: PushPhase;
  remote: string;
  localBranch: string;
  remoteBranch: string;
  setUpstream: boolean;
  followTags: boolean;
  forceWithLease: boolean;
  command: string;
  output: string;
  error: string;
  result: GitPushResult | null;
  preview: GitPushPreview | null;
  previewLoading: boolean;
  previewError: string;
  operationId: string | null;
}

interface GitNavBarProps {
  currentDirectory: string;
  onRepositoryChanged?: () => void | Promise<void>;
}

function GitToolbarIcon({ name }: { name: GitToolbarIconName }) {
  if (name === 'pull') {
    return (
      <svg className="git-toolbar-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M14.5 5.5 7.5 12.5" />
        <path d="M7.5 12.5h5.5" />
        <path d="M7.5 12.5V7" />
      </svg>
    );
  }

  if (name === 'commit') {
    return (
      <svg className="git-toolbar-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="m4.5 10.5 3.4 3.4 7.6-7.6" />
      </svg>
    );
  }

  if (name === 'push') {
    return (
      <svg className="git-toolbar-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5.5 14.5 14.5 5.5" />
        <path d="M9.5 5.5h5v5" />
      </svg>
    );
  }

  return (
    <svg className="git-toolbar-icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 5.8V10l3.1 2" />
    </svg>
  );
}

function compactOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return '';
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}...` : trimmed;
}

function buildStatusTitle(status: GitRepositoryStatus): string {
  const parts = [`分支：${status.branch}`];
  if (status.upstream) parts.push(`上游：${status.upstream}`);
  if (status.behind > 0) parts.push(`落后 ${status.behind}`);
  if (status.ahead > 0) parts.push(`领先 ${status.ahead}`);
  if (status.changedCount > 0) {
    parts.push(`变更 ${status.changedCount}`);
    parts.push(`已暂存 ${status.stagedCount}`);
    parts.push(`未暂存 ${status.unstagedCount}`);
    parts.push(`未跟踪 ${status.untrackedCount}`);
  }
  return parts.join('，');
}

function shortHash(hash?: string | null): string {
  return hash ? hash.slice(0, 8) : '-';
}

// 解析 origin/master 这种 upstream，注意远端分支名可能含斜杠（如 upstream/feature/a）。
function parseUpstream(upstream?: string | null): { remote: string; branch: string } | null {
  if (!upstream) return null;
  const slash = upstream.indexOf('/');
  if (slash <= 0) return null;
  return {
    remote: upstream.slice(0, slash),
    branch: upstream.slice(slash + 1),
  };
}

function buildPushCommandPreview(dialog: PushDialogState): string {
  const parts = ['git.exe', 'push', '-v', '--progress'];
  if (dialog.setUpstream) parts.push('-u');
  if (dialog.followTags) parts.push('--follow-tags');
  if (dialog.forceWithLease) parts.push('--force-with-lease');
  parts.push(dialog.remote);
  parts.push(`${dialog.localBranch}:${dialog.remoteBranch}`);
  return parts.join(' ');
}

export const GitNavBar: FC<GitNavBarProps> = ({ currentDirectory, onRepositoryChanged }) => {
  const openGitHistoryTab = useAppStore(s => s.openGitHistoryTab);
  const [status, setStatus] = useState<GitRepositoryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [popover, setPopover] = useState<GitPopover>(null);
  const [action, setAction] = useState<GitAction>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [changedFiles, setChangedFiles] = useState<GitChangedFile[]>([]);
  const [selectedChangePaths, setSelectedChangePaths] = useState<Set<string>>(new Set());
  const [changesLoading, setChangesLoading] = useState(false);
  const [showUntracked, setShowUntracked] = useState(true);
  const [commitError, setCommitError] = useState('');
  const [commitNotice, setCommitNotice] = useState('');
  const [pullDialog, setPullDialog] = useState<PullDialogState | null>(null);
  const [pushDialog, setPushDialog] = useState<PushDialogState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pushLogRef = useRef<HTMLPreElement>(null);
  const currentDirectoryRef = useRef(currentDirectory);
  currentDirectoryRef.current = currentDirectory;

  useLayoutEffect(() => {
    let cancelled = false;
    const cached = getCachedGitRepositoryStatus(currentDirectory);
    const freshCached = cached && Date.now() - cached.updatedAt < GIT_STATUS_CACHE_TTL_MS
      ? cached
      : undefined;

    setPopover(null);
    setBranches([]);
    setLoadError('');
    if (!currentDirectory) {
      setStatus(null);
      setLoading(false);
      return;
    }

    if (freshCached) {
      setStatus(freshCached.status);
      setLoading(false);
      return;
    }

    setStatus(null);
    setLoading(true);
    loadGitRepositoryStatus(currentDirectory)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to load git status:', err);
          setStatus(null);
          setLoadError(String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory]);

  useEffect(() => {
    if (!popover) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setPopover(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopover(null);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [popover]);

  const refreshStatus = useCallback(async () => {
    if (!currentDirectory) {
      setStatus(null);
      setLoadError('');
      return null;
    }

    const requestedDirectory = currentDirectory;
    if (currentDirectoryRef.current === requestedDirectory) {
      setLoading(true);
      setLoadError('');
    }
    try {
      const next = await loadGitRepositoryStatus(requestedDirectory, { force: true });
      if (currentDirectoryRef.current === requestedDirectory) {
        setStatus(next);
      }
      return next;
    } catch (err) {
      console.error('Failed to refresh git status:', err);
      if (currentDirectoryRef.current === requestedDirectory) {
        setLoadError(String(err));
      }
      return null;
    } finally {
      if (currentDirectoryRef.current === requestedDirectory) {
        setLoading(false);
      }
    }
  }, [currentDirectory]);

  const runAction = useCallback(async (
    nextAction: GitAction,
    label: string,
    fn: (repoRoot: string) => Promise<string>,
    shouldRefreshFiles = false,
  ) => {
    if (!status) return false;

    setAction(nextAction);
    try {
      const output = await fn(status.repoRoot);
      await refreshStatus();
      if (shouldRefreshFiles) {
        await onRepositoryChanged?.();
      }
      setPopover(null);
      const extra = compactOutput(output);
      alert(extra ? `${label}完成\n\n${extra}` : `${label}完成`);
      return true;
    } catch (err) {
      alert(`${label}失败：${String(err)}`);
      return false;
    } finally {
      setAction(null);
    }
  }, [onRepositoryChanged, refreshStatus, status]);

  const startPull = useCallback(async () => {
    if (!status) return;

    const command = 'git.exe pull -v --progress';
    setPopover(null);
    setAction('pull');
    setPullDialog({
      phase: 'running',
      command,
      output: `${command}\n\n正在从远程仓库拉取...`,
      activeTab: 'log',
    });

    try {
      const result = await gitPull(status.repoRoot);
      await refreshStatus();
      await onRepositoryChanged?.();
      setPullDialog({
        phase: 'success',
        command: result.command || command,
        output: result.output || 'Already up to date.',
        activeTab: result.updatedCommits.length > 0 ? 'commits' : 'log',
        result,
      });
    } catch (err) {
      const message = String(err);
      setPullDialog({
        phase: 'error',
        command,
        output: message,
        activeTab: 'log',
        error: message,
      });
    } finally {
      setAction(null);
    }
  }, [onRepositoryChanged, refreshStatus, status]);

  const openPushDialog = useCallback(() => {
    if (!status || !status.hasRemote) return;

    setPopover(null);
    const localBranch = status.branch;
    const parsed = parseUpstream(status.upstream);
    const remote = parsed ? parsed.remote : 'origin';
    const remoteBranch = parsed ? parsed.branch : status.branch;
    // 没有 upstream 时默认勾选“设置上游分支”，有 upstream 时默认不勾选。
    const setUpstream = !parsed;

    setPushDialog({
      phase: 'form',
      remote,
      localBranch,
      remoteBranch,
      setUpstream,
      followTags: false,
      forceWithLease: false,
      command: '',
      output: '',
      error: '',
      result: null,
      preview: null,
      previewLoading: false,
      previewError: '',
      operationId: null,
    });
  }, [status]);

  useEffect(() => {
    if (!status || !pushDialog || pushDialog.phase !== 'form') return;

    const remote = pushDialog.remote.trim();
    const localBranch = pushDialog.localBranch.trim();
    const remoteBranch = pushDialog.remoteBranch.trim();
    if (!remote || !localBranch || !remoteBranch) {
      setPushDialog((current) => current && current.phase === 'form'
        ? { ...current, preview: null, previewLoading: false, previewError: '' }
        : current);
      return;
    }

    let cancelled = false;
    const options: GitPushOptions = {
      path: status.repoRoot,
      remote,
      localBranch,
      remoteBranch,
      setUpstream: pushDialog.setUpstream,
      followTags: pushDialog.followTags,
      forceWithLease: pushDialog.forceWithLease,
    };

    const matchesCurrentDialog = (current: PushDialogState | null) => {
      return Boolean(
        current &&
        current.phase === 'form' &&
        current.remote.trim() === remote &&
        current.localBranch.trim() === localBranch &&
        current.remoteBranch.trim() === remoteBranch &&
        current.setUpstream === options.setUpstream &&
        current.followTags === options.followTags &&
        current.forceWithLease === options.forceWithLease,
      );
    };

    setPushDialog((current) => matchesCurrentDialog(current)
      ? { ...current!, previewLoading: true, previewError: '' }
      : current);

    const timer = window.setTimeout(() => {
      gitPreviewPush(options)
        .then((preview) => {
          if (cancelled) return;
          setPushDialog((current) => matchesCurrentDialog(current)
            ? { ...current!, preview, previewLoading: false, previewError: '' }
            : current);
        })
        .catch((err) => {
          if (cancelled) return;
          setPushDialog((current) => matchesCurrentDialog(current)
            ? { ...current!, preview: null, previewLoading: false, previewError: String(err) }
            : current);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    pushDialog?.followTags,
    pushDialog?.forceWithLease,
    pushDialog?.localBranch,
    pushDialog?.phase,
    pushDialog?.remote,
    pushDialog?.remoteBranch,
    pushDialog?.setUpstream,
    status,
  ]);

  useEffect(() => {
    if (!pushDialog || pushDialog.phase === 'form') return;
    const element = pushLogRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [pushDialog?.output, pushDialog?.phase]);

  const submitPushDialog = useCallback(async () => {
    if (!status || !pushDialog) return;

    const remote = pushDialog.remote.trim();
    const localBranch = pushDialog.localBranch.trim();
    const remoteBranch = pushDialog.remoteBranch.trim();

    if (!remote) {
      setPushDialog({ ...pushDialog, error: '未配置远端仓库' });
      return;
    }
    if (!localBranch || !remoteBranch) {
      setPushDialog({ ...pushDialog, error: '分支名称不能为空' });
      return;
    }

    const options: GitPushOptions = {
      path: status.repoRoot,
      remote,
      localBranch,
      remoteBranch,
      setUpstream: pushDialog.setUpstream,
      followTags: pushDialog.followTags,
      forceWithLease: pushDialog.forceWithLease,
      operationId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    const operationId = options.operationId ?? null;
    const commandPreview = buildPushCommandPreview(pushDialog);
    let unlistenPushOutput: (() => void) | null = null;

    if (operationId) {
      unlistenPushOutput = await listenGitPushOutput(operationId, (chunk) => {
        setPushDialog((current) => current?.operationId === operationId
          ? { ...current, output: `${current.output}${chunk}` }
          : current);
      });
    }

    setAction('push');
    setPushDialog({
      ...pushDialog,
      phase: 'running',
      error: '',
      output: `${commandPreview}\n\n正在推送...\n`,
      command: commandPreview,
      result: null,
      operationId,
    });

    try {
      const result = await gitPushWithOptions(options);
      await refreshStatus();
      await onRepositoryChanged?.();
      setPopover(null);
      setPushDialog((current) => current?.operationId === operationId
        ? {
            ...current,
            phase: 'success',
            command: result.command,
            output: result.output || current.output || '推送完成。',
            result,
            error: '',
            operationId: null,
          }
        : {
            ...pushDialog,
            phase: 'success',
            command: result.command,
            output: result.output || '推送完成。',
            result,
            error: '',
            operationId: null,
          });
    } catch (err) {
      const message = String(err);
      setPushDialog((current) => current?.operationId === operationId
        ? {
            ...current,
            phase: 'error',
            command: current.command || commandPreview,
            output: current.output ? `${current.output}\n${message}` : message,
            error: message,
            result: null,
            operationId: null,
          }
        : {
            ...pushDialog,
            phase: 'error',
            command: commandPreview,
            output: message,
            error: message,
            result: null,
            operationId: null,
          });
    } finally {
      unlistenPushOutput?.();
      setAction(null);
    }
  }, [onRepositoryChanged, pushDialog, refreshStatus, status]);

  const loadBranches = useCallback(async () => {
    if (!status) return;
    setPopover((current) => current === 'branches' ? null : 'branches');
    setBranchesLoading(true);
    setBranches([]);
    try {
      setBranches(await gitListBranches(status.repoRoot));
    } catch (err) {
      alert(`读取分支失败：${String(err)}`);
    } finally {
      setBranchesLoading(false);
    }
  }, [status]);

  const loadHistory = useCallback(async () => {
    if (!status) return;
    setPopover(null);
    openGitHistoryTab({ repoRoot: status.repoRoot, branch: status.branch });
  }, [openGitHistoryTab, status]);

  const loadChangedFiles = useCallback(async () => {
    if (!status) return;

    setChangesLoading(true);
    setCommitError('');
    setCommitNotice('');
    setChangedFiles([]);
    setSelectedChangePaths(new Set());
    try {
      const files = await gitGetChangedFiles(status.repoRoot);
      setChangedFiles(files);
      setSelectedChangePaths(new Set(files.map((file) => file.path)));
      if (files.length === 0) {
        setCommitNotice('没有检测到可提交的变更。');
      }
    } catch (err) {
      setCommitError(`读取变更列表失败：${String(err)}`);
      setChangedFiles([]);
      setSelectedChangePaths(new Set());
    } finally {
      setChangesLoading(false);
    }
  }, [status]);

  const openCommitDialog = useCallback(() => {
    setPopover(null);
    setCommitDialogOpen(true);
    setCommitMessage('');
    setCommitError('');
    setCommitNotice('');
    loadChangedFiles();
  }, [loadChangedFiles]);

  const checkoutBranch = useCallback(async (branch: GitBranch) => {
    if (branch.isCurrent) {
      setPopover(null);
      return;
    }

    const ok = await runAction(
      'checkout',
      '切换分支',
      (repoRoot) => gitCheckoutBranch(repoRoot, branch.name),
      true,
    );
    if (ok) setBranches([]);
  }, [runAction]);

  const visibleChangedFiles = useMemo(() => {
    return showUntracked ? changedFiles : changedFiles.filter((file) => !file.untracked);
  }, [changedFiles, showUntracked]);

  const selectedVisibleCount = useMemo(() => {
    return visibleChangedFiles.filter((file) => selectedChangePaths.has(file.path)).length;
  }, [selectedChangePaths, visibleChangedFiles]);

  const toggleChangePath = useCallback((path: string) => {
    setSelectedChangePaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleAllVisibleChanges = useCallback(() => {
    setSelectedChangePaths((current) => {
      const allVisibleSelected = visibleChangedFiles.every((file) => current.has(file.path));
      const next = new Set(current);
      for (const file of visibleChangedFiles) {
        if (allVisibleSelected) next.delete(file.path);
        else next.add(file.path);
      }
      return next;
    });
  }, [visibleChangedFiles]);

  const addSignedOffBy = useCallback(() => {
    setCommitMessage((current) => {
      const suffix = 'Signed-off-by: ';
      if (current.includes(suffix)) return current;
      return `${current.trimEnd()}\n\n${suffix}`.trimStart();
    });
  }, []);

  const submitCommitDialog = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!status) return;

    const message = commitMessage.trim();
    const selectedPaths = visibleChangedFiles
      .filter((file) => selectedChangePaths.has(file.path))
      .map((file) => file.path);

    if (!message) {
      setCommitError('请输入提交说明。');
      return;
    }
    if (selectedPaths.length === 0) {
      setCommitError('请至少选择一个文件。');
      return;
    }

    setAction('commit');
    setCommitError('');
    setCommitNotice('');
    try {
      const output = await gitCommitPaths(currentDirectory || status.repoRoot, message, selectedPaths);
      await refreshStatus();
      await onRepositoryChanged?.();
      await loadChangedFiles();
      setCommitMessage('');
      setCommitNotice(compactOutput(output) || '提交完成。');
    } catch (err) {
      setCommitError(String(err));
    } finally {
      setAction(null);
    }
  }, [
    commitMessage,
    currentDirectory,
    loadChangedFiles,
    onRepositoryChanged,
    refreshStatus,
    selectedChangePaths,
    status,
    visibleChangedFiles,
  ]);

  const syncLabel = useMemo(() => {
    if (!status || (status.ahead === 0 && status.behind === 0)) return '';
    return [`↓${status.behind}`, `↑${status.ahead}`].join(' ');
  }, [status]);

  // 命令预览：和后端 git_push_with_options 的拼接规则保持一致。
  const pushCommandPreview = useMemo(() => {
    if (!pushDialog) return '';
    return buildPushCommandPreview(pushDialog);
  }, [pushDialog]);

  const pushStatusText = (() => {
    if (!pushDialog) return '';
    if (pushDialog.phase === 'running') return '推送中...';
    if (pushDialog.phase === 'error') return '推送失败';
    if (pushDialog.phase === 'success') {
      const count = pushDialog.result?.outgoingCommits.length ?? pushDialog.preview?.commits.length ?? 0;
      return `推送完成：${pushDialog.localBranch} -> ${pushDialog.remote}/${pushDialog.remoteBranch}，${count} 个提交`;
    }
    return '';
  })();

  const renderPushCommitPreview = (compact = false) => {
    if (!pushDialog) return null;

    const commits = pushDialog.result?.outgoingCommits ?? pushDialog.preview?.commits ?? [];
    const loading = pushDialog.phase === 'form' && pushDialog.previewLoading;
    const error = pushDialog.phase === 'form' ? pushDialog.previewError : '';
    const warning = pushDialog.preview?.warning;

    return (
      <div className={`git-push-preview ${compact ? 'compact' : ''}`}>
        <div className="git-push-preview-title">
          <span>待推送提交</span>
          <strong>{loading ? '计算中...' : `${commits.length} 个`}</strong>
        </div>
        {error && <div className="git-push-preview-message error">{error}</div>}
        {!error && warning && <div className="git-push-preview-message">{warning}</div>}
        {!loading && !error && commits.length === 0 && (
          <div className="git-push-preview-empty">没有待推送提交。</div>
        )}
        {!error && commits.length > 0 && (
          <div className="git-push-preview-table-wrap">
            <table className="git-push-preview-table">
              <thead>
                <tr>
                  <th>提交</th>
                  <th>作者</th>
                  <th>日期</th>
                  <th>消息</th>
                </tr>
              </thead>
              <tbody>
                {commits.map((commit) => (
                  <tr key={commit.hash} title={commit.hash}>
                    <td>{commit.shortHash}</td>
                    <td>{commit.author}</td>
                    <td>{commit.date}</td>
                    <td>{commit.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  if (!status) {
    const state = loading
      ? { kind: 'loading', label: '正在加载 Git 信息...', icon: LoaderCircle }
      : !currentDirectory
        ? { kind: 'empty', label: '请选择目录以检查 Git 仓库', icon: CircleSlash2 }
        : loadError
          ? { kind: 'error', label: 'Git 信息加载失败', icon: TriangleAlert }
          : { kind: 'empty', label: '当前目录不是 Git 仓库', icon: GitBranchIcon };
    const StateIcon = state.icon;

    return (
      <div
        ref={rootRef}
        className={`git-nav-bar git-nav-state ${state.kind}`}
        role="status"
        aria-live="polite"
        aria-busy={loading}
        title={loadError || currentDirectory || undefined}
      >
        <StateIcon className="git-nav-state-icon" aria-hidden="true" />
        <span>{state.label}</span>
      </div>
    );
  }

  const busy = action !== null || loading;
  const hasChanges = status.changedCount > 0;

  return (
    <div ref={rootRef} className="git-nav-bar">
      <button
        className="git-branch-button"
        onClick={loadBranches}
        disabled={busy}
        title={buildStatusTitle(status)}
      >
        <GitBranchIcon className="git-branch-icon" aria-hidden="true" />
        <span className="git-branch-name">{status.branch}</span>
      </button>
      {hasChanges && (
        <span
          className="git-change-badge"
          title={`变更 ${status.changedCount}，已暂存 ${status.stagedCount}，未暂存 ${status.unstagedCount}，未跟踪 ${status.untrackedCount}`}
        >
          {status.changedCount}
        </span>
      )}
      {syncLabel && <span className="git-sync-meta" title={buildStatusTitle(status)}>{syncLabel}</span>}
      <div className="git-actions">
        <button
          className="git-icon-btn pull"
          onClick={startPull}
          disabled={busy || !status.hasRemote}
          title="拉取最新代码"
        >
          <GitToolbarIcon name="pull" />
        </button>
        <button
          className="git-icon-btn commit"
          onClick={openCommitDialog}
          title="提交（打开后重新检测变更）"
        >
          <GitToolbarIcon name="commit" />
        </button>
        <button
          className="git-icon-btn push"
          onClick={openPushDialog}
          disabled={busy || !status.hasRemote}
          title={status.hasRemote ? '推送' : '未配置远端仓库'}
        >
          <GitToolbarIcon name="push" />
        </button>
        <button
          className="git-icon-btn history"
          onClick={loadHistory}
          disabled={busy}
          title="历史记录"
        >
          <GitToolbarIcon name="history" />
        </button>
      </div>

      {popover === 'branches' && (
        <div className="git-popover">
          <div className="git-popover-header">分支</div>
          <div className="git-popover-list">
            {branchesLoading && <div className="git-empty">加载中...</div>}
            {!branchesLoading && branches.length === 0 && <div className="git-empty">无分支</div>}
            {!branchesLoading && branches.map((branch) => (
              <button
                key={`${branch.isRemote ? 'remote' : 'local'}:${branch.name}`}
                className={`git-list-row ${branch.isCurrent ? 'current' : ''}`}
                onClick={() => checkoutBranch(branch)}
                title={branch.upstream ? `${branch.name} → ${branch.upstream}` : branch.name}
              >
                <span className="git-list-name">{branch.isCurrent ? `✓ ${branch.name}` : branch.name}</span>
                <span className="git-list-meta">{branch.isRemote ? '远程' : '本地'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {commitDialogOpen && (
        <div className="git-commit-dialog-backdrop" onMouseDown={(e) => {
          if (action !== 'commit' && e.target === e.currentTarget) {
            setCommitDialogOpen(false);
          }
        }}>
          <form
            className="git-commit-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Git 提交"
            onSubmit={submitCommitDialog}
          >
            <div className="git-commit-titlebar">
              <div className="git-commit-title">{status.repoRoot} - 提交</div>
              <button
                type="button"
                className="git-commit-window-close"
                onClick={() => setCommitDialogOpen(false)}
                disabled={action === 'commit'}
                title="关闭"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="git-commit-body">
              <div className="git-commit-target-row">
                <span>提交至:</span>
                <strong>{status.branch}</strong>
              </div>

              <label className="git-commit-message-label" htmlFor="git-commit-message">
                日志信息(M):
              </label>
              <textarea
                id="git-commit-message"
                className="git-commit-message-input"
                value={commitMessage}
                onChange={(e) => {
                  setCommitMessage(e.target.value);
                  setCommitError('');
                  setCommitNotice('');
                }}
                autoFocus
              />

              <div className="git-commit-message-tools">
                <label>
                  <input type="checkbox" disabled />
                  修改上次提交(L)
                </label>
                <button type="button" onClick={addSignedOffBy}>
                  添加 Signed-off-by(S)
                </button>
              </div>

              <div className="git-commit-changes">
                <div className="git-commit-changes-title">变更列表：</div>
                <div className="git-commit-filter-row">
                  <span>选中:</span>
                  <button type="button" onClick={toggleAllVisibleChanges}>全部(A)</button>
                  <button
                    type="button"
                    onClick={() => setSelectedChangePaths(new Set())}
                    disabled={selectedChangePaths.size === 0}
                  >
                    无(N)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const versioned = visibleChangedFiles
                        .filter((file) => !file.untracked)
                        .map((file) => file.path);
                      setSelectedChangePaths(new Set(versioned));
                    }}
                  >
                    已版本控制
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const untracked = visibleChangedFiles
                        .filter((file) => file.untracked)
                        .map((file) => file.path);
                      setSelectedChangePaths(new Set(untracked));
                    }}
                  >
                    未版本控制
                  </button>
                </div>

                <div className="git-commit-table-wrap">
                  {changesLoading && <div className="git-commit-empty">加载变更列表...</div>}
                  {!changesLoading && visibleChangedFiles.length === 0 && (
                    <div className="git-commit-empty">没有可提交的变更。</div>
                  )}
                  {!changesLoading && visibleChangedFiles.length > 0 && (
                    <table className="git-commit-table">
                      <thead>
                        <tr>
                          <th>
                            <input
                              type="checkbox"
                              checked={visibleChangedFiles.length > 0 && selectedVisibleCount === visibleChangedFiles.length}
                              onChange={toggleAllVisibleChanges}
                              aria-label="选择所有可见文件"
                            />
                          </th>
                          <th>路径</th>
                          <th>扩展名</th>
                          <th>状态</th>
                          <th>添加行数</th>
                          <th>删除行数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleChangedFiles.map((file) => (
                          <tr key={file.path} className={selectedChangePaths.has(file.path) ? 'selected' : ''}>
                            <td>
                              <input
                                type="checkbox"
                                checked={selectedChangePaths.has(file.path)}
                                onChange={() => toggleChangePath(file.path)}
                                aria-label={`选择 ${file.path}`}
                              />
                            </td>
                            <td title={file.path}>{file.path}</td>
                            <td>{file.extension}</td>
                            <td>{file.status}</td>
                            <td>{file.additions || ''}</td>
                            <td>{file.deletions || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div className="git-commit-options">
                  <label>
                    <input
                      type="checkbox"
                      checked={showUntracked}
                      onChange={(e) => setShowUntracked(e.target.checked)}
                    />
                    显示未版本控制的文件(U)
                  </label>
                  <button type="button" onClick={loadChangedFiles} disabled={changesLoading || action === 'commit'}>
                    刷新(F5)
                  </button>
                </div>
              </div>

              {commitError && <div className="git-commit-message error">{commitError}</div>}
              {commitNotice && <div className="git-commit-message success">{commitNotice}</div>}
            </div>

            <div className="git-commit-footer">
              <span>已选中 {selectedVisibleCount} 个文件，总计 {visibleChangedFiles.length} 个文件</span>
              <div className="git-commit-footer-actions">
                <button
                  type="submit"
                  disabled={
                    action === 'commit' ||
                    !commitMessage.trim() ||
                    selectedVisibleCount === 0 ||
                    visibleChangedFiles.length === 0
                  }
                >
                  {action === 'commit' ? '提交中...' : '提交(O)'}
                </button>
                <button type="button" onClick={() => setCommitDialogOpen(false)} disabled={action === 'commit'}>
                  取消
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {pullDialog && (
        <div className="git-pull-dialog-backdrop" onMouseDown={(e) => {
          if (pullDialog.phase !== 'running' && e.target === e.currentTarget) {
            setPullDialog(null);
          }
        }}>
          <div className="git-pull-dialog" role="dialog" aria-modal="true" aria-label="Git 拉取">
            <div className="git-pull-titlebar">
              <div className="git-pull-title">
                <span className={`git-pull-state-dot ${pullDialog.phase}`} />
                <span>{status.repoRoot} - Git拉取</span>
              </div>
              <button
                className="git-pull-window-close"
                onClick={() => setPullDialog(null)}
                disabled={pullDialog.phase === 'running'}
                title="关闭"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="git-pull-body">
              <div className="git-pull-top">
                <div className="git-pull-visual" aria-hidden="true">
                  <span className="git-pull-visual-remote" />
                  <span className={`git-pull-transfer ${pullDialog.phase === 'running' ? 'running' : ''}`} />
                  <span className="git-pull-visual-folder" />
                </div>
                <div className="git-pull-progress-track">
                  <div className={`git-pull-progress ${pullDialog.phase}`} />
                </div>
              </div>

              <div className="git-pull-command">{pullDialog.command}</div>

              <div className="git-pull-tabs">
                <button
                  className={pullDialog.activeTab === 'log' ? 'active' : ''}
                  onClick={() => setPullDialog({ ...pullDialog, activeTab: 'log' })}
                >
                  <span>日志</span>
                </button>
                <button
                  className={pullDialog.activeTab === 'commits' ? 'active' : ''}
                  onClick={() => setPullDialog({ ...pullDialog, activeTab: 'commits' })}
                >
                  <span>更新的提交</span>
                </button>
                <button
                  className={pullDialog.activeTab === 'refs' ? 'active' : ''}
                  onClick={() => setPullDialog({ ...pullDialog, activeTab: 'refs' })}
                >
                  <span>引用列表</span>
                </button>
              </div>

              <div className="git-pull-panel">
                {pullDialog.activeTab === 'log' && (
                  <pre className={`git-pull-log ${pullDialog.phase === 'error' ? 'error' : ''}`}>
                    {pullDialog.output}
                  </pre>
                )}

                {pullDialog.activeTab === 'commits' && (
                  <div className="git-pull-commits">
                    {!pullDialog.result?.updatedCommits.length && (
                      <div className="git-pull-empty">没有新的提交。</div>
                    )}
                    {!!pullDialog.result?.updatedCommits.length && (
                      <table>
                        <thead>
                          <tr>
                            <th>提交</th>
                            <th>作者</th>
                            <th>日期</th>
                            <th>消息</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pullDialog.result.updatedCommits.map((commit) => (
                            <tr key={commit.hash} title={commit.hash}>
                              <td>{commit.shortHash}</td>
                              <td>{commit.author}</td>
                              <td>{commit.date}</td>
                              <td>{commit.subject}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {pullDialog.activeTab === 'refs' && (
                  <div className="git-pull-refs">
                    <div className="git-pull-ref-row">
                      <span>本地分支</span>
                      <strong>{status.branch}</strong>
                    </div>
                    <div className="git-pull-ref-row">
                      <span>远端分支</span>
                      <strong>{status.upstream || '-'}</strong>
                    </div>
                    <div className="git-pull-ref-row">
                      <span>旧哈希</span>
                      <strong>{shortHash(pullDialog.result?.oldHead)}</strong>
                    </div>
                    <div className="git-pull-ref-row">
                      <span>新哈希</span>
                      <strong>{shortHash(pullDialog.result?.newHead)}</strong>
                    </div>
                    {pullDialog.error && (
                      <div className="git-pull-ref-error">{pullDialog.error}</div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="git-pull-footer">
              <span>
                {pullDialog.phase === 'running'
                  ? '正在拉取...'
                  : pullDialog.phase === 'error'
                    ? '拉取失败'
                    : `${pullDialog.result?.updatedCommits.length ?? 0} 个提交更新到 "${status.branch}"`}
              </span>
              <div className="git-pull-footer-actions">
                <button
                  onClick={startPull}
                  disabled={pullDialog.phase === 'running' || busy || !status.hasRemote}
                >
                  拉取(P)
                </button>
                <button
                  onClick={() => setPullDialog(null)}
                  disabled={pullDialog.phase === 'running'}
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pushDialog && (
        <div className="git-push-dialog-backdrop" onMouseDown={(e) => {
          if (pushDialog.phase !== 'running' && e.target === e.currentTarget) {
            setPushDialog(null);
          }
        }}>
          <div className="git-push-dialog" role="dialog" aria-modal="true" aria-label="Git 推送">
            <div className="git-push-titlebar">
              <div className="git-push-title">
                <span className={`git-push-state-dot ${pushDialog.phase}`} />
                <span>{status.repoRoot} - Git推送</span>
              </div>
              <button
                className="git-push-window-close"
                onClick={() => setPushDialog(null)}
                disabled={pushDialog.phase === 'running'}
                title="关闭"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="git-push-body">
              {pushDialog.phase === 'form' ? (
                <div className="git-push-form">
                  <div className="git-push-row">
                    <label className="git-push-label" htmlFor="git-push-local-branch">
                      本地分支(L):
                    </label>
                    <input
                      id="git-push-local-branch"
                      className="git-push-input"
                      value={pushDialog.localBranch}
                      readOnly
                      title="推送总是使用当前检出分支"
                    />
                  </div>
                  <div className="git-push-row">
                    <label className="git-push-label" htmlFor="git-push-remote-branch">
                      远端分支(R):
                    </label>
                    <input
                      id="git-push-remote-branch"
                      className="git-push-input"
                      value={pushDialog.remoteBranch}
                      onChange={(e) => setPushDialog({ ...pushDialog, remoteBranch: e.target.value, error: '' })}
                    />
                  </div>
                  <div className="git-push-row">
                    <label className="git-push-label" htmlFor="git-push-remote">
                      远端(U):
                    </label>
                    <input
                      id="git-push-remote"
                      className="git-push-input"
                      value={pushDialog.remote}
                      onChange={(e) => setPushDialog({ ...pushDialog, remote: e.target.value, error: '' })}
                    />
                  </div>

                  <div className="git-push-options">
                    <label>
                      <input
                        type="checkbox"
                        checked={pushDialog.setUpstream}
                        onChange={(e) => setPushDialog({ ...pushDialog, setUpstream: e.target.checked })}
                      />
                      设置上游分支(S)
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={pushDialog.followTags}
                        onChange={(e) => setPushDialog({ ...pushDialog, followTags: e.target.checked })}
                      />
                      推送标签(T)
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={pushDialog.forceWithLease}
                        onChange={(e) => setPushDialog({ ...pushDialog, forceWithLease: e.target.checked })}
                      />
                      强制推送(F)
                    </label>
                  </div>

                  {pushDialog.error && <div className="git-push-form-error">{pushDialog.error}</div>}

                  <div className="git-push-command" title={pushCommandPreview}>{pushCommandPreview}</div>
                  {renderPushCommitPreview()}
                </div>
              ) : (
                <div className="git-push-result">
                  <div className="git-push-top">
                    <div className="git-push-progress-track">
                      <div className={`git-push-progress ${pushDialog.phase}`} />
                    </div>
                  </div>
                  <div className="git-push-command" title={pushDialog.command || pushCommandPreview}>
                    {pushDialog.command || pushCommandPreview}
                  </div>
                  {renderPushCommitPreview(true)}
                  <pre
                    ref={pushLogRef}
                    className={`git-push-log ${pushDialog.phase === 'error' ? 'error' : ''}`}
                  >
                    {pushDialog.output}
                  </pre>
                </div>
              )}
            </div>

            <div className="git-push-footer">
              <span className="git-push-status-text">
                {pushDialog.phase === 'form'
                  ? pushDialog.previewLoading
                    ? '正在计算待推送提交'
                    : `准备推送 · ${pushDialog.preview?.commits.length ?? 0} 个提交`
                  : pushStatusText}
              </span>
              <div className="git-push-footer-actions">
                {pushDialog.phase === 'form' && (
                  <>
                    <button
                      onClick={submitPushDialog}
                      disabled={
                        !pushDialog.remote.trim() ||
                        !pushDialog.localBranch.trim() ||
                        !pushDialog.remoteBranch.trim()
                      }
                    >
                      推送(P)
                    </button>
                    <button onClick={() => setPushDialog(null)}>取消</button>
                  </>
                )}
                {pushDialog.phase === 'running' && (
                  <>
                    <button disabled>推送中...</button>
                    <button disabled>关闭</button>
                  </>
                )}
                {pushDialog.phase === 'success' && (
                  <>
                    <button onClick={submitPushDialog}>再次推送(R)</button>
                    <button onClick={() => setPushDialog(null)}>关闭</button>
                  </>
                )}
                {pushDialog.phase === 'error' && (
                  <>
                    <button onClick={() => setPushDialog({ ...pushDialog, phase: 'form', error: '' })}>
                      返回修改参数
                    </button>
                    <button onClick={() => setPushDialog(null)}>关闭</button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
