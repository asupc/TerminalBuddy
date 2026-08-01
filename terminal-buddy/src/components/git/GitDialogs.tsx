import type { FC, FormEvent } from "react";
import type { GitChangedFile, GitRepositoryStatus } from "../../services/tauri";
import { Dialog } from "../shared/Dialog";
import { shortHash, type PullDialogState, type PushDialogState, type GitAction } from "./navbar-utils";

// ===== 提交对话框 =====
interface CommitDialogProps {
  status: GitRepositoryStatus;
  commitMessage: string;
  setCommitMessage: (value: string | ((prev: string) => string)) => void;
  commitError: string;
  setCommitError: (value: string) => void;
  commitNotice: string;
  setCommitNotice: (value: string) => void;
  visibleChangedFiles: GitChangedFile[];
  changesLoading: boolean;
  selectedChangePaths: Set<string>;
  setSelectedChangePaths: React.Dispatch<React.SetStateAction<Set<string>>>;
  action: GitAction;
  showUntracked: boolean;
  setShowUntracked: React.Dispatch<React.SetStateAction<boolean>>;
  selectedVisibleCount: number;
  toggleChangePath: (path: string) => void;
  loadChangedFiles: () => Promise<void>;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  onToggleAllVisibleChanges: () => void;
  onAddSignedOffBy: () => void;
}

export const CommitDialog: FC<CommitDialogProps> = ({
  status, commitMessage, setCommitMessage,
  commitError, setCommitError, commitNotice, setCommitNotice,
  visibleChangedFiles, changesLoading,
  selectedChangePaths, setSelectedChangePaths,
  action, showUntracked, setShowUntracked, selectedVisibleCount, toggleChangePath, loadChangedFiles, onClose, onSubmit,
  onToggleAllVisibleChanges, onAddSignedOffBy,
}) => {
  return (
  <Dialog
    title={`${status.repoRoot} - 提交`}
    ariaLabel="Git 提交"
    className="git-commit-dialog"
    headerClassName="git-commit-titlebar"
    titleClassName="git-commit-title"
    closeButtonClassName="git-commit-window-close"
    bodyClassName="git-dialog-layout"
    onClose={() => onClose()}
    onSubmit={onSubmit}
  >
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
          <button type="button" onClick={onAddSignedOffBy}>
            添加 Signed-off-by(S)
          </button>
        </div>

        <div className="git-commit-changes">
          <div className="git-commit-changes-title">变更列表：</div>
          <div className="git-commit-filter-row">
            <span>选中:</span>
            <button type="button" onClick={onToggleAllVisibleChanges}>全部(A)</button>
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
                        onChange={onToggleAllVisibleChanges}
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
          <button type="button" onClick={() => onClose()} disabled={action === 'commit'}>
            取消
          </button>
        </div>
      </div>
  </Dialog>
  );
};

// ===== 拉取对话框 =====
interface PullDialogProps {
  pullDialog: PullDialogState;
  setPullDialog: React.Dispatch<React.SetStateAction<PullDialogState | null>>;
  status: GitRepositoryStatus;
  busy: boolean | null;
  startPull: () => void;
}

export const PullDialog: FC<PullDialogProps> = ({
  pullDialog, setPullDialog, status, busy, startPull,
}) => {
  return (
  <Dialog
    title={(
      <>
        <span className={`git-pull-state-dot ${pullDialog.phase}`} />
        <span>{status.repoRoot} - Git拉取</span>
      </>
    )}
    ariaLabel="Git 拉取"
    className="git-pull-dialog"
    headerClassName="git-pull-titlebar"
    titleClassName="git-pull-title"
    closeButtonClassName="git-pull-window-close"
    bodyClassName="git-dialog-layout"
    onClose={() => setPullDialog(null)}
  >
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
  </Dialog>
  );
};

// ===== 推送对话框 =====
interface PushDialogProps {
  pushDialog: PushDialogState;
  setPushDialog: React.Dispatch<React.SetStateAction<PushDialogState | null>>;
  status: GitRepositoryStatus;
  pushCommandPreview: string;
  pushStatusText: string;
  pushLogRef: React.RefObject<HTMLPreElement | null>;
  submitPushDialog: (e: FormEvent) => void;
  renderPushCommitPreview: (compact?: boolean) => React.ReactNode;
}

export const PushDialog: FC<PushDialogProps> = ({
  pushDialog, setPushDialog, status, pushCommandPreview, pushStatusText, pushLogRef, submitPushDialog, renderPushCommitPreview,
}) => {
  return (
  <Dialog
    title={(
      <>
        <span className={`git-push-state-dot ${pushDialog.phase}`} />
        <span>{status.repoRoot} - Git推送</span>
      </>
    )}
    ariaLabel="Git 推送"
    className="git-push-dialog"
    headerClassName="git-push-titlebar"
    titleClassName="git-push-title"
    closeButtonClassName="git-push-window-close"
    bodyClassName="git-dialog-layout"
    onClose={() => setPushDialog(null)}
  >
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
  </Dialog>
  );
};