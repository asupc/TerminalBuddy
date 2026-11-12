import { FC, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import {
  gitGetChangedFiles,
  gitGetWorktreeFileDiff,
  type GitChangedFile,
  type GitWorktreeFileDiff,
} from '../../services/tauri';
import { getCachedGitRepositoryStatus, subscribeGitRepositoryStatus } from '../../services/gitStatusCache';
import { gitRepositoryKey } from '../../services/gitOperationState';
import { getMonacoLanguage } from '../../utils/fileExtensions';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import './GitChangesPage.css';

const LIST_WIDTH_KEY = 'gitChanges.listWidth';
const DEFAULT_LIST_WIDTH = 420;

/** 文件导航宽度按浏览器本地偏好保存；非法值回落到默认宽度。 */
function readListWidth(): number {
  try {
    const stored = Number(localStorage.getItem(LIST_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_LIST_WIDTH;
  } catch {
    return DEFAULT_LIST_WIDTH;
  }
}

interface GitChangesPageProps {
  repoRoot: string;
  branch: string;
}

type GitChangeTreeNode =
  | { kind: 'dir'; name: string; path: string; children: GitChangeTreeNode[] }
  | { kind: 'file'; name: string; path: string; file: GitChangedFile };

/** 把 Git 返回的仓库内相对路径按 `/`（兼容 `\`）拆开，构建成文件夹树。 */
function buildGitChangeTree(files: GitChangedFile[]): GitChangeTreeNode[] {
  const roots: GitChangeTreeNode[] = [];
  const directories = new Map<string, Extract<GitChangeTreeNode, { kind: 'dir' }>>();

  for (const file of files) {
    const segments = file.path.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0) continue;
    let children = roots;
    let prefix = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index];
      let directory = directories.get(prefix);
      if (!directory) {
        directory = { kind: 'dir', name: segments[index], path: prefix, children: [] };
        directories.set(prefix, directory);
        children.push(directory);
      }
      children = directory.children;
    }
    children.push({
      kind: 'file',
      name: segments[segments.length - 1],
      path: file.path,
      file,
    });
  }

  // 目录在前、文件在后，同层按名称排序，保证树形结构稳定。
  const sortNodes = (nodes: GitChangeTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    for (const node of nodes) {
      if (node.kind === 'dir') sortNodes(node.children);
    }
  };
  sortNodes(roots);
  return roots;
}


/** 由中文状态标签推导单字母状态码，与历史页的状态徽标保持同一套配色。 */
function statusCodeOf(file: GitChangedFile): string {
  if (file.untracked) return 'A';
  switch (file.status) {
    case '冲突': return 'U';
    case '已添加': return 'A';
    case '已删除': return 'D';
    case '已重命名': return 'R';
    case '已复制': return 'C';
    default: return 'M';
  }
}

function statusTitle(file: GitChangedFile): string {
  const staged = file.untracked ? '' : file.staged ? ' · 已暂存' : ' · 未暂存';
  return `${file.status}${staged}\n${file.path}`;
}

/**
 * 未提交变更页：左侧列出工作区变更文件，右侧用 Monaco 对比 HEAD 与工作区内容。
 * 只在打开期间读取，不轮询；Git 状态缓存刷新（如提交 / 切换分支后）会自动重新拉取列表。
 */
export const GitChangesPage: FC<GitChangesPageProps> = ({ repoRoot, branch }) => {
  const [files, setFiles] = useState<GitChangedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitWorktreeFileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  // 记录被折叠的目录（默认全部展开），切换文件或刷新列表时保留用户的折叠状态。
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [initialListWidth] = useState(readListWidth);
  // 文件导航宽度可拖拽，拖动结束后写入本地偏好。
  const { width: listWidth, isResizing, resizeHandleProps } = useResizablePanel({
    defaultWidth: initialListWidth,
    minWidth: 220,
    maxWidth: 760,
    onResizeEnd: (width) => {
      try {
        localStorage.setItem(LIST_WIDTH_KEY, String(width));
      } catch {
        // 隐私模式下写入失败不影响本次会话。
      }
    },
  });

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await gitGetChangedFiles(repoRoot);
      setFiles(next);
      setSelectedPath((current) => (
        current && next.some((file) => file.path === current) ? current : next[0]?.path ?? null
      ));
      setRefreshVersion((version) => version + 1);
    } catch (err) {
      setError(String(err));
      setFiles([]);
      setSelectedPath(null);
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  // 文件面板 / 提交弹窗触发的 Git 状态刷新会更新这份缓存；状态变了就重新读一遍变更列表。
  useEffect(() => {
    const unsubscribe = subscribeGitRepositoryStatus(() => {
      const cached = getCachedGitRepositoryStatus(repoRoot, { exact: true });
      if (cached?.status && gitRepositoryKey(cached.status.repoRoot) === gitRepositoryKey(repoRoot)) {
        void loadFiles();
      }
    });
    return unsubscribe;
  }, [loadFiles, repoRoot]);

  useEffect(() => {
    if (!selectedPath) {
      setDiff(null);
      setDiffError('');
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError('');
    setDiff(null);
    gitGetWorktreeFileDiff(repoRoot, selectedPath, null)
      .then((next) => { if (!cancelled) setDiff(next); })
      .catch((err) => { if (!cancelled) setDiffError(String(err)); })
      .finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [repoRoot, selectedPath, refreshVersion]);

  const totals = useMemo(() => files.reduce(
    (acc, file) => ({
      count: acc.count + 1,
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { count: 0, additions: 0, deletions: 0 },
  ), [files]);

  const tree = useMemo(() => buildGitChangeTree(files), [files]);

  const toggleDirectory = useCallback((path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const renderNodes = (nodes: GitChangeTreeNode[], depth: number): ReactElement[] => nodes.map((node) => {
    const indent = 10 + depth * 14;
    if (node.kind === 'dir') {
      const collapsed = collapsedDirs.has(node.path);
      return (
        <div key={`dir:${node.path}`} className="git-changes-tree-group">
          <button
            type="button"
            className="git-changes-dir"
            style={{ paddingLeft: indent }}
            onClick={() => toggleDirectory(node.path)}
            title={node.path}
            aria-expanded={!collapsed}
          >
            {collapsed
              ? <ChevronRight className="git-changes-dir-chevron" aria-hidden="true" />
              : <ChevronDown className="git-changes-dir-chevron" aria-hidden="true" />}
            {collapsed
              ? <Folder className="git-changes-dir-icon" aria-hidden="true" />
              : <FolderOpen className="git-changes-dir-icon" aria-hidden="true" />}
            <span className="git-changes-dir-name">{node.name}</span>
          </button>
          {!collapsed && renderNodes(node.children, depth + 1)}
        </div>
      );
    }
    const { file } = node;
    const code = statusCodeOf(file);
    return (
      <button
        key={`file:${file.path}`}
        type="button"
        className={`git-changes-row${file.path === selectedPath ? ' selected' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={() => setSelectedPath(file.path)}
        title={statusTitle(file)}
      >
        <span className={`git-changes-status ${code}`}>{code}</span>
        <span className="git-changes-path">{node.name}</span>
        <span className="git-changes-counts">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">-{file.deletions}</span>}
        </span>
        {file.untracked && <span className="git-changes-tag">未跟踪</span>}
        {!file.untracked && file.staged && <span className="git-changes-tag staged">已暂存</span>}
      </button>
    );
  });

  return (
    <div className="git-changes-page" aria-label="Git 未提交变更">
      <div className="git-changes-titlebar">
        <div className="git-changes-title" title={repoRoot}>{repoRoot} · 未提交变更</div>
        <div className="git-changes-actions">
          <button
            type="button"
            onClick={() => void loadFiles()}
            disabled={loading}
            title="刷新变更列表"
            aria-label="刷新变更列表"
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="git-changes-summary">
        <span className="git-changes-branch" title="当前分支">{branch}</span>
        <span>{totals.count} 个文件</span>
        {totals.additions > 0 && <span className="add">+{totals.additions}</span>}
        {totals.deletions > 0 && <span className="del">-{totals.deletions}</span>}
      </div>

      <div className="git-changes-body">
        <div className="git-changes-list" style={{ width: listWidth, flexBasis: listWidth }}>
          {loading && files.length === 0 && <div className="git-changes-empty">加载中...</div>}
          {!loading && error && <div className="git-changes-empty error">{error}</div>}
          {!loading && !error && files.length === 0 && (
            <div className="git-changes-empty">工作区没有未提交变更</div>
          )}
          {renderNodes(tree, 0)}
        </div>

        <div
          className={`git-changes-resize${isResizing ? ' active' : ''}`}
          {...resizeHandleProps}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整文件导航宽度"
          title="拖动调整文件导航宽度"
        />

        <div className="git-changes-diff">
          {!selectedPath && <div className="git-changes-empty">选择左侧文件查看变更</div>}
          {selectedPath && diffLoading && <div className="git-changes-empty">加载中...</div>}
          {selectedPath && !diffLoading && diffError && (
            <div className="git-changes-empty error">{diffError}</div>
          )}
          {selectedPath && !diffLoading && !diffError && diff?.binary && (
            <div className="git-changes-empty">二进制文件暂不支持文本预览。</div>
          )}
          {selectedPath && !diffLoading && !diffError && diff && !diff.binary && (
            <DiffEditor
              key={`${diff.path}:${refreshVersion}`}
              height="100%"
              language={getMonacoLanguage(diff.path)}
              original={diff.oldContent}
              modified={diff.newContent}
              theme="vs-dark"
              loading={<div className="git-changes-empty">加载编辑器...</div>}
              options={{
                readOnly: true,
                originalEditable: false,
                automaticLayout: true,
                renderSideBySide: true,
                minimap: { enabled: false },
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
