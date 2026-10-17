import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, File, Folder, GitBranch, FolderGit2 } from 'lucide-react';
import { api } from '../api';
import { Dialog } from '../components/Dialog';
import { useStore } from '../store';
import { normalizePath } from '../utils/projects';
import type { FileNode, GitBranch as GitBranchInfo, GitOperationStatus, GitRepositoryStatus } from '../types';

const directoryKey = (path: string) => normalizePath(path, /^(?:[a-z]:|\\\\)/i.test(path));

/** 目录加载态：children 已载入；expanded 由上层 Set 管理 */
interface DirState {
  loading: boolean;
  children: FileNode[];
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * 项目文件树（Web 版）：只读浏览已登记项目目录 + 仓库级 Git 操作
 * （切换分支 / 提交全部变更 / 拉取 / 推送，长操作后台执行、轮询进度）。
 */
export default function Files({ initialPath }: { initialPath?: string }) {
  const projects = useStore((state) => state.projects);

  // 每个已展开目录的 children 缓存（含项目根）
  const [dirs, setDirs] = useState<Map<string, DirState>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const focusedDirectory = useRef<HTMLDivElement>(null);

  const loadDir = useCallback(async (path: string) => {
    setDirs((prev) => {
      const next = new Map(prev);
      next.set(directoryKey(path), { loading: true, children: prev.get(directoryKey(path))?.children ?? [] });
      return next;
    });
    try {
      const children = await api.getFsList(path);
      setDirs((prev) => {
        const next = new Map(prev);
        next.set(directoryKey(path), { loading: false, children });
        return next;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取目录失败');
      setDirs((prev) => {
        const next = new Map(prev);
        next.set(directoryKey(path), { loading: false, children: [] });
        return next;
      });
    }
  }, []);

  // 从项目菜单进入时，展开目标路径的全部父目录。
  useEffect(() => {
    if (!initialPath) return;
    const windows = /^(?:[a-z]:|\\\\)/i.test(initialPath);
    const path = normalizePath(initialPath, windows);
    const project = projects.filter(p => {
      const root = normalizePath(p.path, windows);
      return p.path && (path === root || path.startsWith(root.replace(/\/$/, '') + '/'));
    }).sort((a, b) => b.path.length - a.path.length)[0];
    if (!project) { setError('该目录尚未登记到项目，请先添加对应的项目目录'); return; }
    let current = project.path;
    const paths = [current];
    const relative = path.slice(normalizePath(project.path, windows).length).replace(/^\/+/, '');
    for (const segment of relative.split('/').filter(Boolean)) {
      current = current.replace(/[\\/]+$/, '') + '/' + segment;
      paths.push(current);
    }
    setExpanded(new Set(paths.map(directoryKey)));
    for (const directory of paths) void loadDir(directory);
  }, [initialPath, projects, loadDir]);

  useEffect(() => { focusedDirectory.current?.scrollIntoView({ block: 'nearest' }); }, [initialPath, dirs]);

  const isFocused = (path: string) => !!initialPath && directoryKey(path) === directoryKey(initialPath);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        const key = directoryKey(path);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      // 首次展开才加载；之后用缓存（Git 操作完成后可整树刷新）
      if (!dirs.has(directoryKey(path))) void loadDir(path);
    },
    [dirs, loadDir],
  );

  /** Git 操作成功后刷新整棵已展开的树（脏数据最多） */
  const refreshTree = useCallback(() => {
    for (const path of expanded) void loadDir(path);
  }, [expanded, loadDir]);

  const renderNodes = (parentPath: string, depth: number) => {
    const state = dirs.get(directoryKey(parentPath));
    if (!state || state.loading) {
      return depth === 0 ? null : <div className="files-loading" style={{ paddingLeft: depth * 14 + 20 }}>读取中…</div>;
    }
    return state.children.map((node) => {
      const isOpen = expanded.has(directoryKey(node.path));
      return (
        <div key={node.path}>
          <div
            ref={isFocused(node.path) ? focusedDirectory : undefined}
            className={`tree-item files-item${isFocused(node.path) ? ' selected' : ''}`}
            style={{ paddingLeft: Math.min(depth, 8) * 14 + 20 }}
            role="button"
            tabIndex={0}
            onClick={() => node.is_directory && toggleDir(node.path)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && node.is_directory) toggleDir(node.path);
            }}
            aria-expanded={node.is_directory ? isOpen : undefined}
          >
            {node.is_directory ? (
              <span className={`tree-arrow${isOpen ? ' expanded' : ''}`} aria-hidden="true">
                <ChevronRight size={12} />
              </span>
            ) : (
              <span className="tree-arrow-placeholder" aria-hidden="true" />
            )}
            <span className="files-icon" aria-hidden="true">
              {node.is_directory ? <Folder size={14} /> : <File size={14} />}
            </span>
            <span className="tree-name">{node.name}</span>
            {!node.is_directory && (
              <span className="tree-item-end">
                <span className="claude-history-meta">{formatSize(node.size)}</span>
              </span>
            )}
          </div>
          {node.is_directory && isOpen && renderNodes(node.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="files-screen">
      {error && <div className="nav-error" role="alert">{error}</div>}
      {projects.filter((p) => p.path).length === 0 ? (
        <div className="claude-history-empty">暂无已登记项目，请先在“项目与命令”中添加项目</div>
      ) : (
        projects
          .filter((p) => p.path)
          .map((project) => {
            const isOpen = expanded.has(directoryKey(project.path));
            return (
              <div key={project.path} className="files-project">
                <div
                  ref={isFocused(project.path) ? focusedDirectory : undefined}
                  className={`tree-item files-root${isFocused(project.path) ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => toggleDir(project.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') toggleDir(project.path);
                  }}
                >
                  <span className={`tree-arrow${isOpen ? ' expanded' : ''}`} aria-hidden="true">
                    <ChevronRight size={12} />
                  </span>
                  <span className="files-icon" aria-hidden="true">
                    <FolderGit2 size={15} />
                  </span>
                  <span className="tree-name">{project.name}</span>
                  <span className="tree-item-end">
                    <span className="claude-history-meta" title={project.path}>{project.path}</span>
                  </span>
                </div>
                {isOpen && (
                  <>
                    <GitPanel repoRoot={project.path} onChanged={refreshTree} />
                    {renderNodes(project.path, 0)}
                  </>
                )}
              </div>
            );
          })
      )}
    </div>
  );
}

/** 仓库级 Git 面板：状态摘要 + 操作按钮 + 轮询中的操作输出 */
function GitPanel({ repoRoot, onChanged }: { repoRoot: string; onChanged: () => void }) {
  const [status, setStatus] = useState<GitRepositoryStatus | null>(null);
  /** null 既表示非仓库也表示加载中，用 loaded 区分 */
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [operation, setOperation] = useState<GitOperationStatus | null>(null);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef<number | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.getGitStatus(repoRoot));
      setStatusLoaded(true);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'Git 状态查询失败');
    }
  }, [repoRoot]);

  useEffect(() => {
    setStatus(null);
    setStatusLoaded(false);
    setOperation(null);
    void loadStatus();
  }, [loadStatus]);

  /** 轮询操作直到终态；结束后刷新仓库状态与文件树 */
  const startPolling = useCallback(() => {
    if (pollRef.current !== null) return;
    const poll = async () => {
      try {
        const op = await api.getGitOperation(repoRoot);
        setOperation(op);
        if (op.status === 'running') return;
        // 终态：停轮询，刷新
        if (pollRef.current !== null) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
        await loadStatus();
        onChanged();
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : '查询操作进度失败');
        if (pollRef.current !== null) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    };
    pollRef.current = window.setInterval(() => void poll(), 1200);
    void poll();
  }, [repoRoot, loadStatus, onChanged]);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setError('');
      try {
        await action();
        startPolling();
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : '操作启动失败');
      }
    },
    [startPolling],
  );

  const busy = operation?.status === 'running';

  if (!statusLoaded) {
    return error ? <div className="nav-error" role="alert">{error}</div> : null;
  }
  // 非 Git 仓库（getGitStatus 返回 null）不显示 Git 面板
  if (!status) {
    return null;
  }

  return (
    <div className="git-panel">
      <div className="git-panel-row">
        <span className="git-branch-chip" title={status.upstream ?? undefined}>
          <GitBranch size={13} aria-hidden="true" />
          {status.branch}
        </span>
        {status.upstream && (status.ahead > 0 || status.behind > 0) && (
          <span className="git-count">↑{status.ahead} ↓{status.behind}</span>
        )}
        {status.changedCount > 0 && (
          <span className="git-count changed" title={`暂存 ${status.stagedCount} / 未暂存 ${status.unstagedCount} / 未跟踪 ${status.untrackedCount}`}>
            {status.changedCount} 变更
          </span>
        )}
        <span className="git-panel-actions">
          <button type="button" className="btn small" disabled={busy} onClick={() => setBranchesOpen(true)}>
            分支
          </button>
          <button type="button" className="btn small" disabled={busy} onClick={() => setCommitOpen(true)}>
            提交
          </button>
          <button
            type="button"
            className="btn small"
            disabled={busy || !status.hasRemote}
            title={status.hasRemote ? undefined : '仓库没有配置远程'}
            onClick={() => void runAction(() => api.gitPull(repoRoot))}
          >
            {busy && operation?.action === '拉取' ? '拉取中…' : '拉取'}
          </button>
          <button
            type="button"
            className="btn small"
            disabled={busy || !status.hasRemote}
            title={status.hasRemote ? undefined : '仓库没有配置远程'}
            onClick={() => void runAction(() => api.gitPush(repoRoot))}
          >
            {busy && operation?.action === '推送' ? '推送中…' : '推送'}
          </button>
        </span>
      </div>
      {error && <div className="nav-error" role="alert">{error}</div>}
      {operation && operation.status !== 'idle' && operation.output && (
        <details className="git-operation-output" open={operation.status !== 'done'}>
          <summary>
            {operation.action}
            {operation.status === 'running' && ' · 执行中…'}
            {operation.status === 'done' && ' · 完成'}
            {operation.status === 'failed' && ' · 失败'}
          </summary>
          <pre>{operation.output}</pre>
        </details>
      )}
      {branchesOpen && (
        <BranchDialog
          repoRoot={repoRoot}
          currentBranch={status.branch}
          onClose={() => setBranchesOpen(false)}
          onCheckout={(branch) => {
            setBranchesOpen(false);
            void runAction(() => api.gitCheckout(repoRoot, branch));
          }}
        />
      )}
      {commitOpen && (
        <CommitDialog
          repoRoot={repoRoot}
          changedCount={status.changedCount}
          onClose={() => setCommitOpen(false)}
          onCommit={(message) => {
            setCommitOpen(false);
            void runAction(() => api.gitCommit(repoRoot, message));
          }}
        />
      )}
    </div>
  );
}

function BranchDialog({
  repoRoot,
  currentBranch,
  onClose,
  onCheckout,
}: {
  repoRoot: string;
  currentBranch: string;
  onClose: () => void;
  onCheckout: (branch: string) => void;
}) {
  const [branches, setBranches] = useState<GitBranchInfo[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getGitBranches(repoRoot)
      .then((list) => {
        // 本地在前，其余按名称排序；远程分支带 origin/ 前缀原样展示
        setBranches(
          [...list].sort((a, b) => {
            if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
            return a.name.localeCompare(b.name);
          }),
        );
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : '加载分支失败'));
  }, [repoRoot]);

  return (
    <Dialog title="切换分支" onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
      {error && <div className="nav-error" role="alert">{error}</div>}
      {branches === null && !error && <div className="claude-history-empty">加载中…</div>}
      <div className="git-branch-list">
        {branches?.map((branch) => (
          <button
            type="button"
            key={branch.name}
            className={`git-branch-item${branch.isCurrent ? ' current' : ''}`}
            disabled={branch.isCurrent}
            onClick={() => onCheckout(branch.name)}
          >
            <span className="git-branch-item-name">
              {branch.name}
              {branch.isRemote && <span className="git-branch-remote-tag">远程</span>}
            </span>
            {branch.isCurrent && <span className="git-branch-current-tag">当前</span>}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function CommitDialog({
  repoRoot,
  changedCount,
  onClose,
  onCommit,
}: {
  repoRoot: string;
  changedCount: number;
  onClose: () => void;
  onCommit: (message: string) => void;
}) {
  const [message, setMessage] = useState('');

  return (
    <Dialog
      title="提交变更"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!message.trim() || changedCount === 0}
            onClick={() => onCommit(message)}
          >
            提交
          </button>
        </>
      )}
    >
      <div className="web-dialog-desc">
        将提交仓库内全部 {changedCount} 处变更（git add -A）。文件级提交请在桌面端操作。
      </div>
      <textarea
        className="git-commit-message"
        rows={4}
        placeholder="提交说明"
        value={message}
        autoFocus
        onChange={(e) => setMessage(e.target.value)}
        aria-label="提交说明"
      />
    </Dialog>
  );
}
