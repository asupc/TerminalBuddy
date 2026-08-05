import { invoke } from '@tauri-apps/api/core';
import { listenTauri } from './events';

// Git Commands
export interface GitRepositoryStatus {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changedCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  hasRemote: boolean;
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
}

export type GitHistoryRefKind = 'head' | 'local' | 'remote' | 'tag' | 'base';

export interface GitHistoryRef {
  name: string;
  fullName: string;
  revision: string;
  kind: GitHistoryRefKind;
  isCurrent: boolean;
  isUpstream: boolean;
  isBase: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  refs: GitHistoryRef[];
  author: string;
  date: string;
  subject: string;
}

export interface GitHistoryResult {
  commits: GitCommit[];
  refs: GitHistoryRef[];
  currentRef: GitHistoryRef | null;
  upstreamRef: GitHistoryRef | null;
  baseRef: GitHistoryRef | null;
  mergeBase: string | null;
  ahead: number;
  behind: number;
}

export interface GitPullResult {
  command: string;
  output: string;
  oldHead: string | null;
  newHead: string | null;
  updatedCommits: GitCommit[];
}

export interface GitPushOptions {
  path: string;
  remote: string;
  localBranch: string;
  remoteBranch: string;
  setUpstream: boolean;
  followTags: boolean;
  forceWithLease: boolean;
  operationId?: string | null;
}

export interface GitPushResult {
  command: string;
  output: string;
  remote: string;
  localBranch: string;
  remoteBranch: string;
  outgoingCommits: GitCommit[];
}

export interface GitPushPreview {
  command: string;
  remote: string;
  localBranch: string;
  remoteBranch: string;
  targetRef: string;
  targetExists: boolean;
  commits: GitCommit[];
  warning: string | null;
}

export interface GitPushOutputEvent {
  operationId: string;
  chunk: string;
}

export interface GitChangedFile {
  path: string;
  extension: string;
  status: string;
  additions: number;
  deletions: number;
  staged: boolean;
  untracked: boolean;
}

export interface GitHistoryFile {
  path: string;
  oldPath: string | null;
  extension: string;
  status: string;
  statusCode: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitHistoryFileDiff {
  path: string;
  oldPath: string | null;
  status: string;
  statusCode: string;
  oldRevision: string;
  newRevision: string;
  oldContent: string;
  newContent: string;
  binary: boolean;
}

export const getGitRepositoryStatus = (path: string) =>
  invoke<GitRepositoryStatus | null>('get_git_repository_status', { path });
export const gitListBranches = (path: string) =>
  invoke<GitBranch[]>('git_list_branches', { path });
export const gitCheckoutBranch = (path: string, branch: string) =>
  invoke<string>('git_checkout_branch', { path, branch });
export const gitPull = (path: string) => invoke<GitPullResult>('git_pull', { path });
export const gitPreviewPush = (options: GitPushOptions) =>
  invoke<GitPushPreview>('git_preview_push', { options });
export const gitPushWithOptions = (options: GitPushOptions) =>
  invoke<GitPushResult>('git_push_with_options', { options });
export const listenGitPushOutput = (
  operationId: string,
  callback: (chunk: string) => void,
) => listenTauri<GitPushOutputEvent>('git_push_output', (payload) => {
  if (payload.operationId === operationId) {
    callback(payload.chunk);
  }
});
export const gitGetChangedFiles = (path: string) =>
  invoke<GitChangedFile[]>('git_get_changed_files', { path });
export const gitCommitPaths = (path: string, message: string, paths: string[]) =>
  invoke<string>('git_commit_paths', { path, message, paths });
export const gitGetHistory = (path: string, limit?: number, skip?: number) =>
  invoke<GitHistoryResult>('git_get_history', { path, limit: limit ?? null, skip: skip ?? null });
export const gitGetHistoryFiles = (path: string, fromRevision: string | null, toRevision: string) =>
  invoke<GitHistoryFile[]>('git_get_history_files', { path, fromRevision, toRevision });
export const gitGetHistoryFileDiff = (
  path: string,
  fromRevision: string | null,
  toRevision: string,
  filePath: string,
  oldPath: string | null,
  statusCode: string,
  binary: boolean,
) =>
  invoke<GitHistoryFileDiff>('git_get_history_file_diff', {
    path,
    fromRevision,
    toRevision,
    filePath,
    oldPath,
    statusCode,
    binary,
  });
