import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import { CircleSlash2, GitBranch, TriangleAlert } from 'lucide-react';
import { getCachedGitRepositoryStatus, loadGitRepositoryStatus, subscribeGitRepositoryStatus } from '../../services/gitStatusCache';
import { gitRepositoryKey } from '../../services/gitOperationState';
import { showAlert } from '../../services/dialog';
import { GitNavBar, type GitNavBarHandle } from './GitNavBar';

export type GitContextAction = 'refresh' | 'branches' | 'commit' | 'pull' | 'push' | 'history' | 'operation';

export interface GitOperationsHostHandle {
  runAction: (repoRoot: string, action: GitContextAction) => void;
}

interface GitOperationsHostProps {
  currentDirectory: string;
  visible: boolean;
  onRepositoryChanged: () => void;
}

interface PendingAction {
  repoRoot: string;
  action: GitContextAction;
}

function dispatch(handle: GitNavBarHandle, action: GitContextAction): void {
  if (action === 'refresh') void handle.refreshStatus();
  else if (action === 'branches') void handle.loadBranches();
  else if (action === 'commit') handle.openCommitDialog();
  else if (action === 'pull') void handle.startPull();
  else if (action === 'push') handle.openPushDialog();
  else if (action === 'history') void handle.loadHistory();
  else handle.showOperationDialog();
}

/**
 * 按仓库根目录保存控制器，而不是按当前浏览目录重建组件。
 * 隐藏面板/切换 SSH 或其他仓库时，已有任务、输出监听与对话框数据仍常驻。
 */
export const GitOperationsHost = forwardRef<GitOperationsHostHandle, GitOperationsHostProps>(
  ({ currentDirectory, visible, onRepositoryChanged }, ref) => {
    const entry = useSyncExternalStore(
      subscribeGitRepositoryStatus,
      useCallback(() => getCachedGitRepositoryStatus(currentDirectory, { exact: true }), [currentDirectory]),
    );
    const activeRepoRoot = entry?.status?.repoRoot;
    const activeKey = activeRepoRoot ? gitRepositoryKey(activeRepoRoot) : '';
    const [retainedRoots, setRetainedRoots] = useState<string[]>([]);
    const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
    const [loadError, setLoadError] = useState('');
    const handles = useRef(new Map<string, GitNavBarHandle>());
    const lastDispatched = useRef<PendingAction | null>(null);

    useEffect(() => {
      setLoadError('');
      if (!visible || !currentDirectory || entry) return;
      let cancelled = false;
      void loadGitRepositoryStatus(currentDirectory, { exact: true }).catch(error => {
        if (!cancelled) setLoadError(String(error));
      });
      return () => { cancelled = true; };
    }, [currentDirectory, entry, visible]);

    useEffect(() => {
      const roots = [activeRepoRoot, pendingAction?.repoRoot].filter((root): root is string => Boolean(root));
      setRetainedRoots(current => {
        const next = [...current];
        for (const root of roots) {
          if (!next.some(item => gitRepositoryKey(item) === gitRepositoryKey(root))) next.push(root);
        }
        return next.length === current.length ? current : next;
      });
    }, [activeRepoRoot, pendingAction?.repoRoot]);

    const runAction = useCallback((repoRoot: string, action: GitContextAction) => {
      const status = getCachedGitRepositoryStatus(repoRoot, { exact: true })?.status;
      if (!status || gitRepositoryKey(status.repoRoot) !== gitRepositoryKey(repoRoot)) {
        void showAlert('Git 仓库已变化，请刷新目录后重试。', 'Git 操作未执行');
        return;
      }
      const handle = handles.current.get(gitRepositoryKey(repoRoot));
      if (handle) dispatch(handle, action);
      else setPendingAction({ repoRoot, action });
    }, []);

    useImperativeHandle(ref, () => ({ runAction }), [runAction]);

    // 首次从另一仓库右键执行时，等该仓库的控制器完成挂载后再分发。
    useEffect(() => {
      if (!pendingAction || lastDispatched.current === pendingAction) return;
      const handle = handles.current.get(gitRepositoryKey(pendingAction.repoRoot));
      if (!handle) return;
      lastDispatched.current = pendingAction;
      dispatch(handle, pendingAction.action);
      setPendingAction(current => current === pendingAction ? null : current);
    }, [pendingAction]);

    const roots = [...retainedRoots];
    for (const root of [activeRepoRoot, pendingAction?.repoRoot]) {
      if (root && !roots.some(item => gitRepositoryKey(item) === gitRepositoryKey(root))) roots.push(root);
    }

    const placeholder = !currentDirectory
      ? { kind: 'empty', label: '请选择目录以检查 Git 仓库', icon: CircleSlash2 }
      : loadError
        ? { kind: 'error', label: 'Git 信息加载失败', icon: TriangleAlert }
        : entry
          ? { kind: 'empty', label: '当前目录不是 Git 仓库', icon: GitBranch }
          : { kind: 'pending', label: 'Git', icon: GitBranch };
    const StateIcon = placeholder.icon;

    return (
      <>
        {visible && !activeRepoRoot && (
          <div className={`git-nav-bar git-nav-state ${placeholder.kind}`} role="status" aria-live="polite" title={loadError || currentDirectory || undefined}>
            <StateIcon className="git-nav-state-icon" aria-hidden="true" />
            <span>{placeholder.label}</span>
          </div>
        )}
        {roots.map(repoRoot => (
          <GitNavBar
            key={gitRepositoryKey(repoRoot)}
            ref={handle => {
              const key = gitRepositoryKey(repoRoot);
              if (handle) handles.current.set(key, handle);
              else handles.current.delete(key);
            }}
            currentDirectory={repoRoot}
            showToolbar={visible && gitRepositoryKey(repoRoot) === activeKey}
            onRepositoryChanged={onRepositoryChanged}
          />
        ))}
      </>
    );
  },
);

GitOperationsHost.displayName = 'GitOperationsHost';
