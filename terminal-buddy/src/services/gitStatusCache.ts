import {
  getGitRepositoryStatus,
  type GitRepositoryStatus,
} from './tauri';

const MAX_CACHE_ENTRIES = 100;

export interface CachedGitRepositoryStatus {
  status: GitRepositoryStatus | null;
  updatedAt: number;
}

interface GitRepositoryCacheOptions {
  /** 仅复用已检测过的目录，不把父仓库当作嵌套仓库的检测结果。 */
  exact?: boolean;
}

interface LoadGitRepositoryStatusOptions extends GitRepositoryCacheOptions {
  force?: boolean;
}

const statusCache = new Map<string, CachedGitRepositoryStatus>();
const pendingRequests = new Map<string, Promise<GitRepositoryStatus | null>>();
const statusListeners = new Set<() => void>();

function normalizePath(path: string): string {
  const normalized = path.trim().replace(/\//g, '\\');
  return normalized.replace(/\\+$/, '').toLowerCase();
}

function isPathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}\\`);
}

function areStatusesEqual(
  left: GitRepositoryStatus | null | undefined,
  right: GitRepositoryStatus | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.repoRoot === right.repoRoot
    && left.branch === right.branch
    && left.upstream === right.upstream
    && left.ahead === right.ahead
    && left.behind === right.behind
    && left.changedCount === right.changedCount
    && left.stagedCount === right.stagedCount
    && left.unstagedCount === right.unstagedCount
    && left.untrackedCount === right.untrackedCount
    && left.hasRemote === right.hasRemote;
}

function cacheEntry(path: string, entry: CachedGitRepositoryStatus): void {
  const key = normalizePath(path);
  if (!key) return;

  statusCache.delete(key);
  statusCache.set(key, entry);

  while (statusCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = statusCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    statusCache.delete(oldestKey);
  }
}

function notifyStatusListeners(): void {
  for (const listener of statusListeners) {
    listener();
  }
}

export function getCachedGitRepositoryStatus(
  path: string,
  options: GitRepositoryCacheOptions = {},
): CachedGitRepositoryStatus | undefined {
  const key = normalizePath(path);
  if (!key) return undefined;

  const exact = statusCache.get(key);
  // 非仓库也缓存；明确检测过的空结果不能被父目录的旧仓库状态覆盖。
  if (exact?.status === null) return exact;
  if (options.exact) {
    if (!exact?.status) return exact;
    // 目录归属已确认后，分支/远端/变更等状态跟随仓库根目录的最新缓存。
    return statusCache.get(normalizePath(exact.status.repoRoot)) ?? exact;
  }

  let newest: CachedGitRepositoryStatus | undefined;
  let longestRepoRoot = -1;
  for (const entry of statusCache.values()) {
    if (!entry.status) continue;
    const repoRoot = normalizePath(entry.status.repoRoot);
    const current = statusCache.get(repoRoot) ?? entry;
    if (!current.status || !isPathInside(key, repoRoot)) continue;
    if (repoRoot.length > longestRepoRoot) {
      newest = current;
      longestRepoRoot = repoRoot.length;
    } else if (repoRoot.length === longestRepoRoot && (!newest || current.updatedAt > newest.updatedAt)) {
      newest = current;
    }
  }
  return newest ?? exact;
}

export function subscribeGitRepositoryStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export async function loadGitRepositoryStatus(
  path: string,
  options: LoadGitRepositoryStatusOptions = {},
): Promise<GitRepositoryStatus | null> {
  const key = normalizePath(path);
  if (!key) return null;

  const cached = getCachedGitRepositoryStatus(path, options);
  if (!options.force && cached) {
    return cached.status;
  }

  // 检测按实际目录去重，避免父仓库的在途请求误充当嵌套目录的检测结果。
  const requestKey = key;
  const pending = pendingRequests.get(requestKey);
  if (pending) {
    if (!options.force) return pending;
    // A refresh after a Git mutation must run after any older lookup completes.
    await pending.catch(() => null);
    const newerPending = pendingRequests.get(requestKey);
    if (newerPending) return newerPending;
  }

  const request = getGitRepositoryStatus(path)
    .then((status) => {
      const currentEntry = getCachedGitRepositoryStatus(path, { exact: true });
      // 已检测过的目录（包括“不是仓库”）以精确缓存为准，不能用父仓库的旧状态冒充。
      const currentStatus = currentEntry
        ? currentEntry.status
        : getCachedGitRepositoryStatus(path)?.status;
      const nextStatus = areStatusesEqual(currentStatus, status) ? currentStatus ?? null : status;
      // 状态栏会定期校对：状态没变时复用缓存对象，不通知订阅者重渲染，
      // 也让调用方的 setState 因引用相同而跳过更新。
      const unchanged = currentEntry !== undefined && currentEntry.status === nextStatus;
      const entry = unchanged && currentEntry ? currentEntry : { status: nextStatus, updatedAt: 0 };
      entry.updatedAt = Date.now();
      cacheEntry(path, entry);
      if (nextStatus) cacheEntry(nextStatus.repoRoot, entry);
      if (!unchanged) notifyStatusListeners();
      return nextStatus;
    })
    .finally(() => {
      if (pendingRequests.get(requestKey) === request) {
        pendingRequests.delete(requestKey);
      }
    });

  pendingRequests.set(requestKey, request);
  return request;
}
