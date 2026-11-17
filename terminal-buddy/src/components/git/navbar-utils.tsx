import {
  ArrowDownToLine,
  ArrowUpFromLine,
  GitCommitHorizontal,
  History as HistoryIcon,
  type LucideIcon,
} from 'lucide-react';
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
  showToolbar?: boolean;
  onRepositoryChanged?: () => void | Promise<void>;
  /** statusbar：底部状态栏的紧凑平铺布局，分支浮层从状态栏向上弹出。 */
  variant?: 'panel' | 'statusbar';
  /**
   * statusbar：终端输入活动时间戳（每次回车更新）。
   * 变化后延迟校对一次 Git 状态，用来捕捉终端里执行的 git checkout / switch。
   */
  terminalActivityAt?: number;
}
/** 工具栏图标统一走 Lucide：拉取向下、推送向上、提交用 Git 提交节点。 */
const GIT_TOOLBAR_ICONS: Record<GitToolbarIconName, LucideIcon> = {
  pull: ArrowDownToLine,
  push: ArrowUpFromLine,
  commit: GitCommitHorizontal,
  history: HistoryIcon,
};
export function GitToolbarIcon({ name }: { name: GitToolbarIconName }) {
  const Icon = GIT_TOOLBAR_ICONS[name];
  return <Icon className="git-toolbar-icon" aria-hidden="true" />;
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
