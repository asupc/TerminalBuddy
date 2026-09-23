import { FC, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  gitGetHistory,
  gitGetHistoryFileDiff,
  gitGetHistoryFiles,
  type GitCommit,
  type GitHistoryFile,
  type GitHistoryFileDiff,
  type GitHistoryRef,
  type GitHistoryResult,
} from '../../services/tauri';
import { HistoryGraphSvg } from './HistoryGraphSvg';
import {
  INCOMING_HISTORY_ITEM_ID,
  OUTGOING_HISTORY_ITEM_ID,
  SWIMLANE_WIDTH,
  buildHistoryGraph,
  getHistoryItemIndex,
  sortHistoryRefs,
  type HistoryGraphViewModel,
} from './gitHistoryGraph';
import './GitHistoryPage.css';

const GitHistoryDiffPreview = lazy(() =>
  import('./GitHistoryDiffPreview').then((module) => ({ default: module.GitHistoryDiffPreview })),
);

interface GitHistoryPageProps {
  repoRoot: string;
  branch: string;
  onClose: () => void;
}

interface HistoryRange {
  key: string;
  fromRevision: string | null;
  toRevision: string;
}

interface HistoryFilesState {
  loading: boolean;
  error: string;
  files: GitHistoryFile[];
}

interface SelectedHistoryFile {
  range: HistoryRange;
  file: GitHistoryFile;
}

function GitHistoryToolbarIcon({ name }: { name: 'branch' | 'target' | 'refresh' }) {
  if (name === 'branch') {
    return (
      <svg className="git-history-toolbar-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="4" cy="3.5" r="1.4" />
        <circle cx="4" cy="12.5" r="1.4" />
        <circle cx="12" cy="6.5" r="1.4" />
        <path d="M4 4.9v6.2M5.2 11.8C9.1 11.8 12 9.9 12 7.9" />
      </svg>
    );
  }

  if (name === 'target') {
    return (
      <svg className="git-history-toolbar-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="2" />
      </svg>
    );
  }

  return (
    <svg className="git-history-toolbar-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 4.5A5.3 5.3 0 1 0 14 8" />
      <path d="M13 2.2v2.9h-2.9" />
    </svg>
  );
}

function GitHistoryRefIcon({ historyRef }: { historyRef: GitHistoryRef }) {
  if (historyRef.isUpstream || historyRef.kind === 'remote') {
    return (
      <svg className="git-history-ref-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5.2 11.2H12a2.2 2.2 0 0 0 .2-4.4 3.6 3.6 0 0 0-6.8-1.4A2.9 2.9 0 0 0 5.2 11.2Z" />
      </svg>
    );
  }

  if (historyRef.isBase || historyRef.kind === 'base') {
    return (
      <svg className="git-history-ref-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.2" />
        <circle cx="8" cy="8" r="1.7" />
      </svg>
    );
  }

  if (historyRef.kind === 'tag') {
    return (
      <svg className="git-history-ref-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2.8 3.2h4.6l5.8 5.8-4.2 4.2-5.8-5.8V3.2Z" />
        <circle cx="5.4" cy="5.8" r="0.9" />
      </svg>
    );
  }

  return (
    <svg className="git-history-ref-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="6.5" r="1.5" />
      <path d="M4 5v6M5.2 11.5c3.9 0 6.8-1.8 6.8-4" />
    </svg>
  );
}

function refBadgeClass(ref: GitHistoryRef): string {
  if (ref.isCurrent) return 'current';
  if (ref.isUpstream) return 'upstream';
  if (ref.kind === 'remote') return 'remote';
  if (ref.kind === 'tag') return 'tag';
  if (ref.kind === 'base') return 'base';
  return 'local';
}

function refsTitle(refs: GitHistoryRef[]): string {
  return refs.map((ref) => `${ref.name} (${ref.fullName})`).join('\n');
}

function historyRowTitle(commit: GitCommit, refs: GitHistoryRef[]): string {
  const parts = [`${commit.shortHash ? `${commit.shortHash} ` : ''}${commit.subject}`];
  if (commit.author) parts.push(`作者：${commit.author}`);
  if (commit.date) parts.push(`时间：${commit.date}`);
  if (refs.length > 0) parts.push(`引用：${refs.map((ref) => ref.name).join(', ')}`);
  return parts.join('\n');
}

function historyRangeForCommit(commit: GitCommit, result: GitHistoryResult | null): HistoryRange | null {
  if (commit.hash === OUTGOING_HISTORY_ITEM_ID) {
    if (!result?.mergeBase || !result.currentRef?.revision) return null;
    return { key: OUTGOING_HISTORY_ITEM_ID, fromRevision: result.mergeBase, toRevision: result.currentRef.revision };
  }

  if (commit.hash === INCOMING_HISTORY_ITEM_ID) {
    if (!result?.mergeBase || !result.upstreamRef?.revision) return null;
    return { key: INCOMING_HISTORY_ITEM_ID, fromRevision: result.mergeBase, toRevision: result.upstreamRef.revision };
  }

  return {
    key: `${commit.parents[0] ?? 'root'}..${commit.hash}`,
    fromRevision: commit.parents[0] ?? null,
    toRevision: commit.hash,
  };
}

function historyFileStats(file: GitHistoryFile): string {
  if (file.binary) return '二进制';
  if (file.additions === 0 && file.deletions === 0) return '';
  return `+${file.additions} -${file.deletions}`;
}

function historyFileTitle(file: GitHistoryFile): string {
  const path = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} -> ${file.path}` : file.path;
  return [path, file.status, historyFileStats(file)].filter(Boolean).join('\n');
}

function historyFileIndent(viewModel: HistoryGraphViewModel): number {
  const laneCount = Math.max(
    viewModel.inputSwimlanes.length,
    viewModel.outputSwimlanes.length,
    getHistoryItemIndex(viewModel) + 1,
    1,
  );
  return 10 + SWIMLANE_WIDTH * (laneCount + 1) + 20;
}

export const GitHistoryPage: FC<GitHistoryPageProps> = ({ repoRoot, branch, onClose }) => {
  const [historyResult, setHistoryResult] = useState<GitHistoryResult | null>(null);
  const [selectedHistoryHash, setSelectedHistoryHash] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(true);
  const [expandedHistoryKeys, setExpandedHistoryKeys] = useState<Set<string>>(new Set());
  const [historyFilesByKey, setHistoryFilesByKey] = useState<Record<string, HistoryFilesState>>({});
  const [selectedHistoryFile, setSelectedHistoryFile] = useState<SelectedHistoryFile | null>(null);
  const [historyPreviewOpen, setHistoryPreviewOpen] = useState(false);
  const [historyGraphWidth, setHistoryGraphWidth] = useState<number | null>(null);
  const [isHistoryDividerDragging, setIsHistoryDividerDragging] = useState(false);
  const [historyDiff, setHistoryDiff] = useState<GitHistoryFileDiff | null>(null);
  const [historyDiffLoading, setHistoryDiffLoading] = useState(false);
  const [historyDiffError, setHistoryDiffError] = useState('');
  const historyGraphRef = useRef<HTMLDivElement>(null);
  const historyBodyRef = useRef<HTMLDivElement>(null);
  const historyLoadRequestRef = useRef(0);
  const historyDiffRequestRef = useRef('');
  const historyResizeStartRef = useRef({ x: 0, width: 0 });

  const loadHistory = useCallback(async () => {
    const requestId = ++historyLoadRequestRef.current;
    setHistoryLoading(true);
    setHistoryError('');
    setExpandedHistoryKeys(new Set());
    setHistoryFilesByKey({});
    setSelectedHistoryFile(null);
    setHistoryPreviewOpen(false);
    setHistoryDiff(null);
    setHistoryDiffError('');
    setHistoryDiffLoading(false);
    setHistoryLoadingMore(false);
    setHistoryHasMore(true);

    try {
      const result = await gitGetHistory(repoRoot, 200);
      if (historyLoadRequestRef.current !== requestId) return;
      setHistoryResult(result);
      setHistoryHasMore(result.commits.length >= 200);
      setSelectedHistoryHash(
        result.ahead > 0 && result.currentRef?.revision && result.currentRef.revision !== result.mergeBase
          ? OUTGOING_HISTORY_ITEM_ID
          : result.currentRef?.revision ?? result.commits[0]?.hash ?? null,
      );
    } catch (err) {
      if (historyLoadRequestRef.current !== requestId) return;
      setHistoryError(`读取历史记录失败：${String(err)}`);
      setHistoryResult(null);
      setSelectedHistoryHash(null);
    } finally {
      if (historyLoadRequestRef.current === requestId) setHistoryLoading(false);
    }
  }, [repoRoot]);

  const loadMoreHistory = useCallback(async () => {
    if (!historyResult || historyLoading || historyLoadingMore || !historyHasMore) return;

    const skip = historyResult.commits.length;
    setHistoryLoadingMore(true);
    try {
      const result = await gitGetHistory(repoRoot, 200, skip);
      if (result.commits.length === 0) {
        setHistoryHasMore(false);
        return;
      }
      setHistoryResult((current) => {
        if (!current) return current;
        const existing = new Set(current.commits.map((commit) => commit.hash));
        const appended = result.commits.filter((commit) => !existing.has(commit.hash));
        if (appended.length === 0) return current;
        return { ...current, commits: [...current.commits, ...appended] };
      });
      setHistoryHasMore(result.commits.length >= 200);
    } catch (err) {
      setHistoryError(`加载更多历史记录失败：${String(err)}`);
    } finally {
      setHistoryLoadingMore(false);
    }
  }, [historyResult, historyLoading, historyLoadingMore, historyHasMore, repoRoot]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    const element = historyGraphRef.current;
    if (!element) return;

    const handleScroll = () => {
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - 80) {
        void loadMoreHistory();
      }
    };
    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [loadMoreHistory]);

  const historyGraph = useMemo(() => buildHistoryGraph(historyResult), [historyResult]);

  useEffect(() => {
    if (!isHistoryDividerDragging) return;

    const handleMouseMove = (event: MouseEvent) => {
      const body = historyBodyRef.current;
      if (!body) return;

      const minimumGraphWidth = 280;
      const minimumPreviewWidth = 360;
      const maximumGraphWidth = Math.max(minimumGraphWidth, body.clientWidth - minimumPreviewWidth - 6);
      const nextWidth = historyResizeStartRef.current.width + event.clientX - historyResizeStartRef.current.x;
      setHistoryGraphWidth(Math.max(minimumGraphWidth, Math.min(maximumGraphWidth, nextWidth)));
    };

    const handleMouseUp = () => setIsHistoryDividerDragging(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isHistoryDividerDragging]);

  const startHistoryDividerResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !historyGraphRef.current) return;
    event.preventDefault();
    historyResizeStartRef.current = {
      x: event.clientX,
      width: historyGraphRef.current.getBoundingClientRect().width,
    };
    setIsHistoryDividerDragging(true);
  }, []);

  const ensureHistoryFiles = useCallback(async (range: HistoryRange) => {
    const existing = historyFilesByKey[range.key];
    if (existing?.loading || (existing && !existing.error)) return;

    setHistoryFilesByKey((current) => ({
      ...current,
      [range.key]: { loading: true, error: '', files: current[range.key]?.files ?? [] },
    }));

    try {
      const files = await gitGetHistoryFiles(repoRoot, range.fromRevision, range.toRevision);
      setHistoryFilesByKey((current) => ({
        ...current,
        [range.key]: { loading: false, error: '', files },
      }));
    } catch (err) {
      setHistoryFilesByKey((current) => ({
        ...current,
        [range.key]: { loading: false, error: String(err), files: [] },
      }));
    }
  }, [historyFilesByKey, repoRoot]);

  const toggleHistoryFiles = useCallback((commit: GitCommit) => {
    const range = historyRangeForCommit(commit, historyResult);
    if (!range) return;

    setSelectedHistoryHash(commit.hash);
    let shouldLoad = false;
    setExpandedHistoryKeys((current) => {
      const next = new Set(current);
      if (next.has(range.key)) next.delete(range.key);
      else {
        next.add(range.key);
        shouldLoad = true;
      }
      return next;
    });

    if (shouldLoad) void ensureHistoryFiles(range);
  }, [ensureHistoryFiles, historyResult]);

  const selectHistoryFile = useCallback((commit: GitCommit, file: GitHistoryFile) => {
    const range = historyRangeForCommit(commit, historyResult);
    if (!range) return;

    historyDiffRequestRef.current = '';
    setSelectedHistoryHash(commit.hash);
    setSelectedHistoryFile({ range, file });
    setHistoryDiff(null);
    setHistoryDiffError('');
    setHistoryDiffLoading(false);
  }, [historyResult]);

  const openHistoryFile = useCallback(async (commit: GitCommit, file: GitHistoryFile) => {
    const range = historyRangeForCommit(commit, historyResult);
    if (!range) return;

    const requestKey = `${range.key}:${file.oldPath ?? ''}:${file.path}`;
    historyDiffRequestRef.current = requestKey;
    setSelectedHistoryHash(commit.hash);
    setSelectedHistoryFile({ range, file });
    setHistoryPreviewOpen(true);
    setHistoryDiff(null);
    setHistoryDiffError('');

    if (file.binary) {
      setHistoryDiff({
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        statusCode: file.statusCode,
        oldRevision: range.fromRevision ?? '',
        newRevision: range.toRevision,
        oldContent: '',
        newContent: '',
        binary: true,
      });
      setHistoryDiffLoading(false);
      return;
    }

    setHistoryDiffLoading(true);
    try {
      const diff = await gitGetHistoryFileDiff(
        repoRoot,
        range.fromRevision,
        range.toRevision,
        file.path,
        file.oldPath,
        file.statusCode,
        file.binary,
      );
      if (historyDiffRequestRef.current === requestKey) {
        setHistoryDiff(diff);
        setHistoryDiffError('');
      }
    } catch (err) {
      if (historyDiffRequestRef.current === requestKey) {
        setHistoryDiff(null);
        setHistoryDiffError(String(err));
      }
    } finally {
      if (historyDiffRequestRef.current === requestKey) setHistoryDiffLoading(false);
    }
  }, [historyResult, repoRoot]);

  const closeHistoryPreview = useCallback(() => {
    historyDiffRequestRef.current = '';
    setHistoryPreviewOpen(false);
    setHistoryDiff(null);
    setHistoryDiffError('');
    setHistoryDiffLoading(false);
  }, []);

  const locateCurrentHistory = useCallback(() => {
    const targetHash = historyResult?.currentRef?.revision ?? historyResult?.commits[0]?.hash;
    if (!targetHash) return;
    setSelectedHistoryHash(targetHash);
    window.requestAnimationFrame(() => {
      historyGraphRef.current
        ?.querySelector<HTMLElement>(`[data-commit-hash="${targetHash}"]`)
        ?.scrollIntoView({ block: 'center' });
    });
  }, [historyResult]);

  return (
    <div className="git-history-page" aria-label="Git 历史记录">
      <div className="git-history-titlebar">
        <div className="git-history-title">{repoRoot} - 历史记录</div>
        <button className="git-history-window-close" onClick={onClose} title="关闭历史记录" aria-label="关闭历史记录">
          <X aria-hidden="true" />
        </button>
      </div>

      <div className="git-history-toolbar">
        <div className="git-history-heading">
          <span className="git-history-chevron">v</span>
          <span>GRAPH</span>
        </div>
        <div className="git-history-toolbar-actions">
          <span className="git-history-auto">
            <GitHistoryToolbarIcon name="branch" />
            <span>Auto</span>
          </span>
          <button onClick={locateCurrentHistory} disabled={historyLoading || historyGraph.viewModels.length === 0} title="定位当前 HEAD" aria-label="定位当前 HEAD">
            <GitHistoryToolbarIcon name="target" />
          </button>
          <button onClick={() => void loadHistory()} disabled={historyLoading} title="刷新" aria-label="刷新历史记录">
            <GitHistoryToolbarIcon name="refresh" />
          </button>
        </div>
      </div>

      <div className={`git-history-body${historyPreviewOpen ? ' with-preview' : ''}`} ref={historyBodyRef}>
        <div
          className="git-history-graph"
          ref={historyGraphRef}
          style={historyPreviewOpen && historyGraphWidth !== null
            ? { width: historyGraphWidth, flexBasis: historyGraphWidth }
            : undefined}
        >
          {historyLoading && <div className="git-history-empty">加载中...</div>}
          {!historyLoading && historyError && <div className="git-history-empty error">{historyError}</div>}
          {!historyLoading && !historyError && historyGraph.viewModels.length === 0 && <div className="git-history-empty">暂无历史记录</div>}
          {!historyLoading && !historyError && historyGraph.viewModels.map((viewModel) => {
            const { commit } = viewModel;
            const refs = sortHistoryRefs(commit.refs);
            const visibleRefs = refs.slice(0, 3);
            const hiddenRefs = refs.slice(3);
            const range = historyRangeForCommit(commit, historyResult);
                  const fileState = range ? historyFilesByKey[range.key] : undefined;
                  const fileIndent = historyFileIndent(viewModel);
            const isExpanded = Boolean(range && expandedHistoryKeys.has(range.key));
            const isSelected = selectedHistoryHash === commit.hash;
            const rowClassName = [
              'git-history-graph-row',
              viewModel.kind,
              isSelected ? 'selected' : '',
              commit.parents.length > 1 ? 'merge' : '',
            ].filter(Boolean).join(' ');

            return (
              <div key={commit.hash} className="git-history-entry">
                <div
                  className={rowClassName}
                  data-commit-hash={commit.hash}
                  onClick={() => setSelectedHistoryHash(commit.hash)}
                  onDoubleClick={() => toggleHistoryFiles(commit)}
                  title={historyRowTitle(commit, refs)}
                >
                  <div className={`git-history-graph-cell ${viewModel.kind}`}>
                    <HistoryGraphSvg viewModel={viewModel} />
                  </div>
                  <button
                    type="button"
                    className={`git-history-expand ${isExpanded ? 'expanded' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleHistoryFiles(commit);
                    }}
                    title={isExpanded ? '收起文件' : '展开文件'}
                    aria-label={isExpanded ? '收起文件' : '展开文件'}
                  >
                    &gt;
                  </button>
                  <div className="git-history-row-main">
                    <span className="git-history-row-subject">{commit.subject}</span>
                    {commit.author && <span className="git-history-row-author">{commit.author}</span>}
                  </div>
                  <div className="git-history-row-refs" title={refsTitle(refs)}>
                    {visibleRefs.map((ref, index) => (
                      <span
                        key={`${ref.fullName}:${ref.revision}`}
                        className={`git-history-ref ${refBadgeClass(ref)} ${index === 0 ? 'primary' : 'icon-only'}`}
                        title={`${ref.fullName}\n${ref.revision}`}
                      >
                        <GitHistoryRefIcon historyRef={ref} />
                        {index === 0 && <span className="git-history-ref-label">{ref.name}</span>}
                      </span>
                    ))}
                    {hiddenRefs.length > 0 && <span className="git-history-ref more" title={refsTitle(hiddenRefs)}>+{hiddenRefs.length}</span>}
                  </div>
                </div>
                {isExpanded && (
                  <div className="git-history-files">
                    {fileState?.loading && <div className="git-history-file-message" style={{ paddingLeft: fileIndent }}>加载文件中...</div>}
                    {fileState?.error && <div className="git-history-file-message error" style={{ paddingLeft: fileIndent }}>{fileState.error}</div>}
                    {fileState && !fileState.loading && !fileState.error && fileState.files.length === 0 && (
                      <div className="git-history-file-message" style={{ paddingLeft: fileIndent }}>没有文件变更</div>
                    )}
                    {range && fileState?.files.map((file) => {
                      const isFileSelected = selectedHistoryFile?.range.key === range.key
                        && selectedHistoryFile.file.path === file.path
                        && selectedHistoryFile.file.oldPath === file.oldPath;
                      return (
                        <button
                          key={`${file.oldPath ?? ''}:${file.path}:${file.statusCode}`}
                          type="button"
                          className={`git-history-file-row ${isFileSelected ? 'selected' : ''}`}
                          style={{ paddingLeft: fileIndent }}
                          onClick={(event) => {
                            event.stopPropagation();
                            selectHistoryFile(commit, file);
                          }}
                          onDoubleClick={(event) => {
                            event.stopPropagation();
                            void openHistoryFile(commit, file);
                          }}
                          title={historyFileTitle(file)}
                        >
                          <span className={`git-history-file-status ${file.statusCode}`}>{file.statusCode}</span>
                          <span className="git-history-file-path">{file.path}</span>
                          <span className="git-history-file-stat">{historyFileStats(file)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {!historyLoading && !historyError && historyGraph.viewModels.length > 0 && (
            <div className="git-history-load-more">
              {historyLoadingMore ? '加载中...' : historyHasMore ? '向下滚动加载更多' : '已加载全部历史'}
            </div>
          )}
        </div>

        {historyPreviewOpen && (
          <div
            className={`git-history-divider${isHistoryDividerDragging ? ' dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整历史列表与差异预览宽度"
            onMouseDown={startHistoryDividerResize}
          />
        )}
        {historyPreviewOpen && (
          <div className="git-history-preview">
            <button
              type="button"
              className="git-history-preview-close"
              onClick={closeHistoryPreview}
              title="关闭差异预览"
              aria-label="关闭差异预览"
            >
              <X aria-hidden="true" />
            </button>
            <Suspense fallback={<div className="git-history-diff-empty">加载中...</div>}>
              <GitHistoryDiffPreview
                selectedFile={selectedHistoryFile?.file ?? null}
                diff={historyDiff}
                loading={historyDiffLoading}
                error={historyDiffError}
              />
            </Suspense>
          </div>
        )}
      </div>

      <div className="git-history-footer">
        <span>{historyResult?.commits.length ?? 0} 个提交</span>
        <span>
          {historyResult ? `${branch}${historyResult.ahead > 0 ? ` ↑${historyResult.ahead}` : ''}${historyResult.behind > 0 ? ` ↓${historyResult.behind}` : ''}` : branch}
        </span>
      </div>
    </div>
  );
};
