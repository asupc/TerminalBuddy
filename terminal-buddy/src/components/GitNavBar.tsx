import { FC, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getGitRepositoryStatus,
  gitCheckoutBranch,
  gitCommitPaths,
  gitGetChangedFiles,
  gitGetHistory,
  gitListBranches,
  gitPull,
  gitPushWithOptions,
  type GitBranch,
  type GitChangedFile,
  type GitCommit,
  type GitPullResult,
  type GitPushOptions,
  type GitPushResult,
  type GitRepositoryStatus,
} from '../services/tauri';

type GitPopover = 'branches' | null;
type GitAction = 'checkout' | 'commit' | 'pull' | 'push' | null;
type PullDialogTab = 'log' | 'commits' | 'refs';
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
}

interface GitNavBarProps {
  currentDirectory: string;
  onRepositoryChanged?: () => void | Promise<void>;
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

function refBadgeClass(ref: string): string {
  if (ref.startsWith('tag:')) return 'tag';
  if (ref.startsWith('origin/') || ref.includes('/')) return 'remote';
  return 'local';
}

function refLabel(ref: string): string {
  return ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
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

export const GitNavBar: FC<GitNavBarProps> = ({ currentDirectory, onRepositoryChanged }) => {
  const [status, setStatus] = useState<GitRepositoryStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [popover, setPopover] = useState<GitPopover>(null);
  const [action, setAction] = useState<GitAction>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [history, setHistory] = useState<GitCommit[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyError, setHistoryError] = useState('');
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

  useEffect(() => {
    let cancelled = false;

    setPopover(null);
    setBranches([]);
    setHistory([]);
    setStatus(null);
    if (!currentDirectory) return;

    setLoading(true);
    getGitRepositoryStatus(currentDirectory)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to load git status:', err);
          setStatus(null);
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
      return null;
    }

    setLoading(true);
    try {
      const next = await getGitRepositoryStatus(currentDirectory);
      setStatus(next);
      return next;
    } catch (err) {
      console.error('Failed to refresh git status:', err);
      setStatus(null);
      return null;
    } finally {
      setLoading(false);
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
    });
  }, [status]);

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
    };

    setAction('push');
    setPushDialog({
      ...pushDialog,
      phase: 'running',
      error: '',
      output: '',
      command: '',
      result: null,
    });

    try {
      const result = await gitPushWithOptions(options);
      await refreshStatus();
      await onRepositoryChanged?.();
      setPopover(null);
      setPushDialog({
        ...pushDialog,
        phase: 'success',
        command: result.command,
        output: result.output || '推送完成。',
        result,
        error: '',
      });
    } catch (err) {
      const message = String(err);
      setPushDialog({
        ...pushDialog,
        phase: 'error',
        command: '',
        output: message,
        error: message,
        result: null,
      });
    } finally {
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
    setHistoryDialogOpen(true);
    setHistoryLoading(true);
    setHistoryError('');
    try {
      setHistory(await gitGetHistory(status.repoRoot, 120));
    } catch (err) {
      setHistoryError(`读取历史记录失败：${String(err)}`);
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [status]);

  const loadChangedFiles = useCallback(async () => {
    if (!status) return;

    setChangesLoading(true);
    setCommitError('');
    try {
      const files = await gitGetChangedFiles(status.repoRoot);
      setChangedFiles(files);
      setSelectedChangePaths(new Set(files.map((file) => file.path)));
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
      const output = await gitCommitPaths(status.repoRoot, message, selectedPaths);
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
    const parts = ['git.exe', 'push', '-v', '--progress'];
    if (pushDialog.setUpstream) parts.push('-u');
    if (pushDialog.followTags) parts.push('--follow-tags');
    if (pushDialog.forceWithLease) parts.push('--force-with-lease');
    parts.push(pushDialog.remote);
    parts.push(`${pushDialog.localBranch}:${pushDialog.remoteBranch}`);
    return parts.join(' ');
  }, [pushDialog]);

  const pushStatusText = (() => {
    if (!pushDialog) return '';
    if (pushDialog.phase === 'running') return '推送中...';
    if (pushDialog.phase === 'error') return '推送失败';
    if (pushDialog.phase === 'success') {
      return `推送完成：${pushDialog.localBranch} -> ${pushDialog.remote}/${pushDialog.remoteBranch}`;
    }
    return '';
  })();

  if (!status) {
    return null;
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
        <span className="git-branch-icon">⑂</span>
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
          className="git-icon-btn"
          onClick={startPull}
          disabled={busy || !status.hasRemote}
          title="拉取最新代码"
        >
          {action === 'pull' ? '...' : '↓'}
        </button>
        <button
          className="git-icon-btn"
          onClick={openCommitDialog}
          disabled={busy || !hasChanges}
          title="提交"
        >
          ✓
        </button>
        <button
          className="git-icon-btn"
          onClick={openPushDialog}
          disabled={busy || !status.hasRemote}
          title={status.hasRemote ? '推送' : '未配置远端仓库'}
        >
          {action === 'push' ? '...' : '↑'}
        </button>
        <button
          className="git-icon-btn"
          onClick={loadHistory}
          disabled={busy}
          title="历史记录"
        >
          ≡
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

      {historyDialogOpen && (
        <div className="git-history-dialog-backdrop" onMouseDown={(e) => {
          if (!historyLoading && e.target === e.currentTarget) {
            setHistoryDialogOpen(false);
          }
        }}>
          <div className="git-history-dialog" role="dialog" aria-modal="true" aria-label="Git 历史记录">
            <div className="git-history-titlebar">
              <div className="git-history-title">{status.repoRoot} - 历史记录</div>
              <button
                className="git-history-window-close"
                onClick={() => setHistoryDialogOpen(false)}
                disabled={historyLoading}
                title="关闭"
              >
                ×
              </button>
            </div>

            <div className="git-history-toolbar">
              <div className="git-history-heading">
                <span className="git-history-chevron">⌄</span>
                <span>GRAPH</span>
              </div>
              <div className="git-history-toolbar-actions">
                <span className="git-history-auto">Auto</span>
                <button onClick={loadHistory} disabled={historyLoading} title="刷新">↻</button>
                <button onClick={startPull} disabled={busy || !status.hasRemote} title="拉取">↓</button>
                <button
                  onClick={openPushDialog}
                  disabled={busy || !status.hasRemote}
                  title={status.hasRemote ? '推送' : '未配置远端仓库'}
                >
                  ↑
                </button>
              </div>
            </div>

            <div className="git-history-graph">
              {historyLoading && <div className="git-history-empty">加载中...</div>}
              {!historyLoading && historyError && <div className="git-history-empty error">{historyError}</div>}
              {!historyLoading && !historyError && history.length === 0 && (
                <div className="git-history-empty">暂无历史记录</div>
              )}
              {!historyLoading && !historyError && history.map((commit, index) => {
                const isHead = index === 0;
                const isMerge = commit.parents.length > 1;
                const lane = isMerge ? 'merge' : index % 5 === 0 ? 'accent' : 'main';

                return (
                  <div key={commit.hash} className={`git-history-graph-row ${isHead ? 'head' : ''}`}>
                    <div className={`git-history-lane ${lane}`}>
                      <span className="git-history-line" />
                      {isMerge && <span className="git-history-merge-line" />}
                      <span className={`git-history-node ${isMerge ? 'merge' : ''} ${isHead ? 'head' : ''}`} />
                    </div>
                    <div className="git-history-row-main" title={`${commit.shortHash} ${commit.subject}`}>
                      <span className="git-history-row-subject">{commit.subject}</span>
                      <span className="git-history-row-author">{commit.author}</span>
                      <span className="git-history-row-date">{commit.date}</span>
                    </div>
                    <div className="git-history-row-refs">
                      {commit.refs.slice(0, 3).map((ref) => (
                        <span key={ref} className={`git-history-ref ${refBadgeClass(ref)}`}>
                          {refLabel(ref)}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="git-history-footer">
              <span>{history.length} 个提交</span>
              <span>{status.branch}</span>
            </div>
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
                ×
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
                ×
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
                ×
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
                  <pre className={`git-push-log ${pushDialog.phase === 'error' ? 'error' : ''}`}>
                    {pushDialog.output}
                  </pre>
                </div>
              )}
            </div>

            <div className="git-push-footer">
              <span className="git-push-status-text">
                {pushDialog.phase === 'form' ? '准备推送' : pushStatusText}
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
