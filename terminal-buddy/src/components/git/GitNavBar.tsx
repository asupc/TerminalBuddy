import { FormEvent, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { CircleSlash2, GitBranch as GitBranchIcon, RefreshCw, TriangleAlert } from 'lucide-react';
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
  type GitPushOptions,
  type GitRepositoryStatus,
} from '../../services/tauri';
import {
  getCachedGitRepositoryStatus,
  loadGitRepositoryStatus,
  subscribeGitRepositoryStatus,
} from '../../services/gitStatusCache';
import { useAppStore } from '../../stores/appStore';
import { showAlert } from '../../services/dialog';
import { GitPopover, GitAction, PullDialogState, PushDialogState, GitNavBarProps, GitToolbarIcon, compactOutput, buildStatusTitle, parseUpstream, buildPushCommandPreview } from './navbar-utils';
import { CommitDialog, PullDialog, PushDialog } from "./GitDialogs";
import { finishGitOperation, getGitOperation, gitRepositoryKey, subscribeGitOperations, tryBeginGitOperation } from '../../services/gitOperationState';

/** 状态栏兜底校对间隔：终端外部（其他工具、另一台机器）切换分支时也能跟上。 */
const STATUS_BAR_REFRESH_MS = 10_000;
/** 终端里回车后等命令执行完再校对，避免读到 git checkout 执行中的旧分支。 */
const STATUS_BAR_ACTIVITY_REFRESH_MS = 1_200;

export interface GitNavBarHandle {
  refreshStatus: () => Promise<GitRepositoryStatus | null>;
  loadBranches: () => Promise<void>;
  startPull: () => Promise<void>;
  openCommitDialog: () => void;
  openPushDialog: () => void;
  loadHistory: () => Promise<void>;
  showOperationDialog: () => void;
}

export const GitNavBar = forwardRef<GitNavBarHandle, GitNavBarProps>(
  ({ currentDirectory, showToolbar = true, onRepositoryChanged, variant = 'panel', terminalActivityAt }, ref) => {
  const isStatusBar = variant === 'statusbar';
  const openGitHistoryTab = useAppStore(s => s.openGitHistoryTab);
  const openGitChangesTab = useAppStore(s => s.openGitChangesTab);
  const initialCachedStatus = getCachedGitRepositoryStatus(currentDirectory, { exact: true });
  const initialStatus = initialCachedStatus?.status;
  const [status, setStatus] = useState<GitRepositoryStatus | null>(initialStatus
    && gitRepositoryKey(initialStatus.repoRoot) === gitRepositoryKey(currentDirectory) ? initialStatus : null);
  const [statusResolved, setStatusResolved] = useState(Boolean(initialCachedStatus));
  const [loadError, setLoadError] = useState('');
  const [popover, setPopover] = useState<GitPopover>(null);
  const operation = useSyncExternalStore(
    subscribeGitOperations,
    useCallback(() => getGitOperation(currentDirectory), [currentDirectory]),
  );
  const action: GitAction = operation?.action ?? null;
  const [lastOperation, setLastOperation] = useState<GitAction>(null);
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
  const [pullDialogVisible, setPullDialogVisible] = useState(false);
  const [pushDialog, setPushDialog] = useState<PushDialogState | null>(null);
  const [pushDialogVisible, setPushDialogVisible] = useState(false);
  const lastStatusRef = useRef(status);
  if (status) lastStatusRef.current = status;
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  /** 状态栏模式下分支浮层的锚点（浮层 portal 到 body，向上弹出）。 */
  const [popoverAnchor, setPopoverAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const pushLogRef = useRef<HTMLPreElement>(null);
  const currentDirectoryRef = useRef(currentDirectory);
  currentDirectoryRef.current = currentDirectory;

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedGitRepositoryStatus(currentDirectory, { exact: true });

    setPopover(null);
    setBranches([]);
    setLoadError('');
    setStatus(cached?.status && gitRepositoryKey(cached.status.repoRoot) === gitRepositoryKey(currentDirectory)
      ? cached.status : null);
    setStatusResolved(Boolean(cached));
    if (!currentDirectory) {
      return;
    }

    const applyCachedStatus = () => {
      const nextCached = getCachedGitRepositoryStatus(currentDirectory, { exact: true });
      if (!nextCached || cancelled) return;
      // 旧的嵌套仓库被移除后，不能把其父仓库状态塞进旧控制器并误执行操作。
      setStatus(nextCached.status && gitRepositoryKey(nextCached.status.repoRoot) === gitRepositoryKey(currentDirectory)
        ? nextCached.status : null);
      setStatusResolved(true);
      setLoadError('');
    };
    const unsubscribe = subscribeGitRepositoryStatus(applyCachedStatus);

    if (!cached) {
      loadGitRepositoryStatus(currentDirectory, { exact: true })
        .then(() => applyCachedStatus())
        .catch((err) => {
          if (!cancelled) {
            console.error('Failed to load git status:', err);
            setLoadError(String(err));
          }
        });
    }

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [currentDirectory]);

  useEffect(() => {
    if (!popover) return;

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
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
      setStatusResolved(true);
      setLoadError('');
      return null;
    }

    const requestedDirectory = currentDirectory;
    if (currentDirectoryRef.current === requestedDirectory) setLoadError('');
    try {
      const next = await loadGitRepositoryStatus(requestedDirectory, { force: true, exact: true });
      const matchingStatus = next && gitRepositoryKey(next.repoRoot) === gitRepositoryKey(requestedDirectory) ? next : null;
      if (currentDirectoryRef.current === requestedDirectory) {
        setStatus(matchingStatus);
        setStatusResolved(true);
      }
      return matchingStatus;
    } catch (err) {
      console.error('Failed to refresh git status:', err);
      if (currentDirectoryRef.current === requestedDirectory) {
        setLoadError(String(err));
      }
      return null;
    }
  }, [currentDirectory]);

  // 终端里直接敲 git checkout / git switch 不会经过本组件，状态栏分支会停在旧值。
  // 页面可见时定期校对一次，窗口重新获得焦点时立即补一次；操作进行中交给操作结束后的刷新。
  useEffect(() => {
    if (!isStatusBar) return;
    let stopped = false;

    const refreshIfIdle = () => {
      if (stopped || action !== null) return;
      if (document.visibilityState === 'hidden') return;
      void refreshStatus();
    };

    const timer = window.setInterval(refreshIfIdle, STATUS_BAR_REFRESH_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') refreshIfIdle();
    };
    window.addEventListener('focus', handleVisibilityChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleVisibilityChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [action, isStatusBar, refreshStatus]);

  // 终端里敲回车后延迟校对一次：git checkout / switch 通常几百毫秒内结束，
  // 不必等下一轮轮询。连续回车只会保留最后一次。
  useEffect(() => {
    if (!isStatusBar || terminalActivityAt === undefined) return;
    const timer = window.setTimeout(() => {
      if (action !== null || document.visibilityState === 'hidden') return;
      void refreshStatus();
    }, STATUS_BAR_ACTIVITY_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [action, isStatusBar, refreshStatus, terminalActivityAt]);

  const runAction = useCallback(async (
    nextAction: Exclude<GitAction, null>,
    label: string,
    fn: (repoRoot: string) => Promise<string>,
    shouldRefreshFiles = false,
  ) => {
    if (!status) return false;

    const token = tryBeginGitOperation(status.repoRoot, nextAction);
    if (!token) return false;
    setLastOperation(nextAction);
    try {
      const output = await fn(status.repoRoot);
      await refreshStatus();
      if (shouldRefreshFiles) {
        await onRepositoryChanged?.();
      }
      setPopover(null);
      const extra = compactOutput(output);
      void showAlert(extra ? `${label}完成\n\n${extra}` : `${label}完成`, `${label}完成`);
      return true;
    } catch (err) {
      void showAlert(`${label}失败：${String(err)}`, `${label}失败`);
      return false;
    } finally {
      finishGitOperation(token);
    }
  }, [onRepositoryChanged, refreshStatus, status]);

  const startPull = useCallback(async () => {
    if (!status || !status.hasRemote) return;
    const token = tryBeginGitOperation(status.repoRoot, 'pull');
    if (!token) return;

    const command = 'git.exe pull -v --progress';
    setPopover(null);
    setLastOperation('pull');
    setPullDialogVisible(true);
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
      setPullDialog((current) => current?.phase === 'running'
        ? {
            phase: 'success',
            command: result.command || command,
            output: result.output || 'Already up to date.',
            activeTab: result.updatedCommits.length > 0 ? 'commits' : 'log',
            result,
          }
        : current);
    } catch (err) {
      const message = String(err);
      setPullDialog((current) => current?.phase === 'running'
        ? {
            phase: 'error',
            command,
            output: message,
            activeTab: 'log',
            error: message,
          }
        : current);
    } finally {
      finishGitOperation(token);
    }
  }, [onRepositoryChanged, refreshStatus, status]);

  const openPushDialog = useCallback(() => {
    if (!status || !status.hasRemote || getGitOperation(status.repoRoot)) return;

    setPopover(null);
    setPushDialogVisible(true);
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
    if (!status || !pushDialog || !pushDialogVisible || pushDialog.phase !== 'form') return;

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
    pushDialogVisible,
    status,
  ]);

  useEffect(() => {
    if (!pushDialog || pushDialog.phase === 'form') return;
    const element = pushLogRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [pushDialog?.output, pushDialog?.phase, pushDialogVisible]);

  const submitPushDialog = useCallback(async () => {
    if (!status || !pushDialog || !status.hasRemote || pushDialog.phase === 'running') return;

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

    const token = tryBeginGitOperation(status.repoRoot, 'push');
    if (!token) return;
    setLastOperation('push');
    setPushDialogVisible(true);
    setPushDialog({
      ...pushDialog, phase: 'running', error: '',
      output: `${commandPreview}\n\n正在推送...\n`, command: commandPreview,
      result: null, operationId,
    });

    try {
      // 输出监听也属于任务启动阶段：先取得互斥令牌，再执行第一个 await。
      if (operationId) {
        unlistenPushOutput = await listenGitPushOutput(operationId, (chunk) => {
          setPushDialog((current) => current?.operationId === operationId
            ? { ...current, output: `${current.output}${chunk}` }
            : current);
        });
      }

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
        : current);
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
        : current);
    } finally {
      try { unlistenPushOutput?.(); }
      finally { finishGitOperation(token); }
    }
  }, [onRepositoryChanged, pushDialog, refreshStatus, status]);

  const loadBranches = useCallback(async () => {
    if (!status || getGitOperation(status.repoRoot)) return;
    const nextOpen = popover !== 'branches';
    if (nextOpen && isStatusBar) {
      // 状态栏在窗口底部，浮层固定定位到状态栏上方，避免被 overflow: hidden 裁剪。
      const rect = rootRef.current?.getBoundingClientRect();
      setPopoverAnchor(rect
        ? {
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 228)),
            bottom: Math.max(8, window.innerHeight - rect.top + 4),
          }
        : null);
    }
    setPopover(nextOpen ? 'branches' : null);
    setBranchesLoading(true);
    setBranches([]);
    try {
      setBranches(await gitListBranches(status.repoRoot));
    } catch (err) {
      void showAlert(`读取分支失败：${String(err)}`, '读取分支失败');
    } finally {
      setBranchesLoading(false);
    }
  }, [isStatusBar, popover, status]);

  const loadHistory = useCallback(async () => {
    if (!status || getGitOperation(status.repoRoot)) return;
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
    if (!status || getGitOperation(status.repoRoot)) return;
    setPopover(null);
    setCommitDialogOpen(true);
    setCommitMessage('');
    setCommitError('');
    setCommitNotice('');
    loadChangedFiles();
  }, [loadChangedFiles, status]);

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

    const token = tryBeginGitOperation(status.repoRoot, 'commit');
    if (!token) return;
    setLastOperation('commit');
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
      finishGitOperation(token);
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

  const showOperationDialog = useCallback(() => {
    const kind = getGitOperation(currentDirectory)?.action ?? lastOperation;
    if (kind === 'pull' && pullDialog) setPullDialogVisible(true);
    else if (kind === 'push' && pushDialog) setPushDialogVisible(true);
    else if (kind === 'commit') setCommitDialogOpen(true);
    else if (kind === 'checkout') void showAlert('当前仓库正在切换分支，请等待操作完成。', 'Git 操作进度');
  }, [currentDirectory, lastOperation, pullDialog, pushDialog]);

  useImperativeHandle(ref, () => ({
    refreshStatus,
    loadBranches,
    startPull,
    openCommitDialog,
    openPushDialog,
    loadHistory,
    showOperationDialog,
  }), [refreshStatus, loadBranches, startPull, openCommitDialog, openPushDialog, loadHistory, showOperationDialog]);

  const busy = action !== null;
  const dialogStatus = status ?? lastStatusRef.current;
  const operationDialogs = dialogStatus && (
    <>
      {commitDialogOpen && (
        <CommitDialog
          status={dialogStatus} commitMessage={commitMessage} setCommitMessage={setCommitMessage}
          commitError={commitError} setCommitError={setCommitError}
          commitNotice={commitNotice} setCommitNotice={setCommitNotice}
          visibleChangedFiles={visibleChangedFiles} changesLoading={changesLoading}
          selectedChangePaths={selectedChangePaths} setSelectedChangePaths={setSelectedChangePaths}
          onClose={() => setCommitDialogOpen(false)}
          onSubmit={submitCommitDialog}
          onToggleAllVisibleChanges={toggleAllVisibleChanges} onAddSignedOffBy={addSignedOffBy}
          action={action} showUntracked={showUntracked} setShowUntracked={setShowUntracked}
          selectedVisibleCount={selectedVisibleCount} toggleChangePath={toggleChangePath}
          loadChangedFiles={loadChangedFiles}
        />
      )}
      {pullDialog && pullDialogVisible && (
        <PullDialog
          pullDialog={pullDialog} setPullDialog={setPullDialog} status={dialogStatus} busy={busy} startPull={startPull}
          onClose={() => setPullDialogVisible(false)}
        />
      )}
      {pushDialog && pushDialogVisible && (
        <PushDialog
          pushDialog={pushDialog} setPushDialog={setPushDialog} pushCommandPreview={pushCommandPreview} pushStatusText={pushStatusText} pushLogRef={pushLogRef} submitPushDialog={submitPushDialog} renderPushCommitPreview={renderPushCommitPreview}
          status={dialogStatus} onClose={() => setPushDialogVisible(false)}
        />
      )}
    </>
  );

  // 隐藏的仓库只隐藏工具栏，不卸载任务或清除结果；Dialog 通过 portal 独立展示。
  if (!showToolbar) return <>{operationDialogs}</>;

  if (!status) {
    // 状态栏不展示“不是仓库/加载中”的占位，只保留可能仍在进行中的操作弹窗。
    if (isStatusBar) return <>{operationDialogs}</>;
    const state = !currentDirectory
        ? { kind: 'empty', label: '请选择目录以检查 Git 仓库', icon: CircleSlash2 }
        : loadError
          ? { kind: 'error', label: 'Git 信息加载失败', icon: TriangleAlert }
          : statusResolved
            ? { kind: 'empty', label: '当前目录不是 Git 仓库', icon: GitBranchIcon }
            : { kind: 'pending', label: 'Git', icon: GitBranchIcon };
    const StateIcon = state.icon;

    return (
      <>
      <div
        ref={rootRef}
        className={`git-nav-bar git-nav-state ${state.kind}`}
        role="status"
        aria-live="polite"
        title={loadError || currentDirectory || undefined}
      >
        <StateIcon className="git-nav-state-icon" aria-hidden="true" />
        <span>{state.label}</span>
      </div>
      {operationDialogs}
      </>
    );
  }

  const hasChanges = status.changedCount > 0;

  // 面板模式浮层贴在工具栏下方；状态栏模式 portal 到 body 并向上弹出。
  const branchPopover = popover === 'branches' ? (
    <div
      ref={popoverRef}
      className={`git-popover${isStatusBar ? ' git-popover-floating' : ''}`}
      style={isStatusBar && popoverAnchor
        ? { position: 'fixed', left: popoverAnchor.left, bottom: popoverAnchor.bottom }
        : undefined}
    >
      <div className="git-popover-header">分支</div>
      <div className="git-popover-list">
        {branchesLoading && <div className="git-empty">加载中...</div>}
        {!branchesLoading && branches.length === 0 && <div className="git-empty">无分支</div>}
        {!branchesLoading && branches.map((branch) => (
          <button
            key={`${branch.isRemote ? 'remote' : 'local'}:${branch.name}`}
            className={`git-list-row ${branch.isCurrent ? 'current' : ''}`}
            onClick={() => checkoutBranch(branch)}
            disabled={busy}
            title={branch.upstream ? `${branch.name} → ${branch.upstream}` : branch.name}
          >
            <span className="git-list-name">{branch.isCurrent ? `✓ ${branch.name}` : branch.name}</span>
            <span className="git-list-meta">{branch.isRemote ? '远程' : '本地'}</span>
          </button>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={`git-nav-bar${isStatusBar ? ' git-nav-bar-statusbar' : ''}`}>
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
        <button
          type="button"
          className="git-change-badge"
          title={`变更 ${status.changedCount}，已暂存 ${status.stagedCount}，未暂存 ${status.unstagedCount}，未跟踪 ${status.untrackedCount} · 点击查看变更文件`}
          onClick={() => openGitChangesTab({ repoRoot: status.repoRoot, branch: status.branch })}
        >
          {status.changedCount}
        </button>
      )}
      {(action || lastOperation === 'pull' || lastOperation === 'push' || lastOperation === 'commit') && (
        <button type="button" className="git-operation-status" onClick={showOperationDialog} title="查看 Git 操作进度或上次结果">
          {action ? `${({ pull: '拉取', push: '推送', commit: '提交', checkout: '切换' })[action]}中…` : '操作结果'}
        </button>
      )}
      {syncLabel && !action && <span className="git-sync-meta" title={buildStatusTitle(status)}>{syncLabel}</span>}
      <div className="git-actions">
        {isStatusBar && (
          <button
            className="git-icon-btn refresh"
            onClick={() => void refreshStatus()}
            disabled={busy}
            title="刷新 Git 状态"
          >
            <RefreshCw className="git-toolbar-icon" aria-hidden="true" />
          </button>
        )}
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
          disabled={busy}
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

      {isStatusBar
        ? branchPopover && createPortal(branchPopover, document.body)
        : branchPopover}

      {operationDialogs}
    </div>
  );
  },
);

GitNavBar.displayName = 'GitNavBar';
