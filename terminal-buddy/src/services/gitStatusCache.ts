import {
  getGitRepositoryStatus,
  type GitRepositoryStatus,
} from './tauri';

export const GIT_STATUS_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;

export interface CachedGitRepositoryStatus {
  status: GitRepositoryStatus | null;
  updatedAt: number;
}

interface LoadGitRepositoryStatusOptions {
  force?: boolean;
}

const statusCache = new Map<string, CachedGitRepositoryStatus>();
const pendingRequests = new Map<string, Promise<GitRepositoryStatus | null>>();

function normalizePath(path: string): string {
  const normalized = path.trim().replace(/\//g, '\\');
  return normalized.replace(/\\+$/, '').toLowerCase();
}

function isPathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}\\`);
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

export function getCachedGitRepositoryStatus(path: string): CachedGitRepositoryStatus | undefined {
  const key = normalizePath(path);
  if (!key) return undefined;

  const exact = statusCache.get(key);
  let newest: CachedGitRepositoryStatus | undefined;
  let longestRepoRoot = -1;
  for (const entry of statusCache.values()) {
    if (!entry.status) continue;
    const repoRoot = normalizePath(entry.status.repoRoot);
    if (!isPathInside(key, repoRoot)) continue;
    if (repoRoot.length > longestRepoRoot) {
      newest = entry;
      longestRepoRoot = repoRoot.length;
    } else if (repoRoot.length === longestRepoRoot && (!newest || entry.updatedAt > newest.updatedAt)) {
      newest = entry;
    }
  }
  return newest ?? exact;
}

export async function loadGitRepositoryStatus(
  path: string,
  options: LoadGitRepositoryStatusOptions = {},
): Promise<GitRepositoryStatus | null> {
  const key = normalizePath(path);
  if (!key) return null;

  const cached = getCachedGitRepositoryStatus(path);
  if (!options.force && cached && Date.now() - cached.updatedAt < GIT_STATUS_CACHE_TTL_MS) {
    return cached.status;
  }

  const requestKey = cached?.status ? normalizePath(cached.status.repoRoot) : key;
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
      const entry = { status, updatedAt: Date.now() };
      cacheEntry(path, entry);
      if (status) cacheEntry(status.repoRoot, entry);
      return status;
    })
    .finally(() => {
      if (pendingRequests.get(requestKey) === request) {
        pendingRequests.delete(requestKey);
      }
    });

  pendingRequests.set(requestKey, request);
  return request;
}
