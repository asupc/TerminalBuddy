import type { GitRepositoryStatus, GitPullResult, GitPushResult, GitPushPreview } from '../../services/tauri';

export type GitPopover = 'branches' | null;
export type GitAction = 'checkout' | 'commit' | 'pull' | 'push' | null;
export type PullDialogTab = 'log' | 'commits' | 'refs';
export type GitToolbarIconName = 'pull' | 'commit' | 'push' | 'history';
export type PullDialogState = {
  phase: 'running' | 'success' | 'error';
  command: string;
  output: string;
  activeTab: PullDialogTab;
  result?: GitPullResult;
  error?: string;
};
export type PushPhase = 'form' | 'running' | 'success' | 'error';
export interface PushDialogState {
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
export interface GitNavBarProps {
  currentDirectory: string;
  onRepositoryChanged?: () => void | Promise<void>;
}
export function GitToolbarIcon({ name }: { name: GitToolbarIconName }) {
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
export function compactOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return '';
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}...` : trimmed;
}
export function buildStatusTitle(status: GitRepositoryStatus): string {
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
export function shortHash(hash?: string | null): string {
  return hash ? hash.slice(0, 8) : '-';
}
export function parseUpstream(upstream?: string | null): { remote: string; branch: string } | null {
  if (!upstream) return null;
  const slash = upstream.indexOf('/');
  if (slash <= 0) return null;
  return {
    remote: upstream.slice(0, slash),
    branch: upstream.slice(slash + 1),
  };
}
export function buildPushCommandPreview(dialog: PushDialogState): string {
  const parts = ['git.exe', 'push', '-v', '--progress'];
  if (dialog.setUpstream) parts.push('-u');
  if (dialog.followTags) parts.push('--follow-tags');
  if (dialog.forceWithLease) parts.push('--force-with-lease');
  parts.push(dialog.remote);
  parts.push(`${dialog.localBranch}:${dialog.remoteBranch}`);
  return parts.join(' ');
}
