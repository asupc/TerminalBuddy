import { useEffect, useState } from 'react';
import type { GitRepositoryStatus } from '../services/tauri';
import {
  getCachedGitRepositoryStatus,
  loadGitRepositoryStatus,
  subscribeGitRepositoryStatus,
} from '../services/gitStatusCache';
import { gitRepositoryKey } from '../services/gitOperationState';

function statusForDirectory(status: GitRepositoryStatus | null | undefined, directory: string): GitRepositoryStatus | null {
  if (!status) return null;
  // 嵌套仓库或父仓库缓存不能冒充当前目录的仓库状态。
  return gitRepositoryKey(status.repoRoot) === gitRepositoryKey(directory) ? status : null;
}

/**
 * 订阅指定目录所属仓库的 Git 状态。
 * 与 GitNavBar 共用同一份缓存与订阅通道：命中缓存时不再发起检测，
 * 缓存刷新时自动跟随，状态栏因此不需要自己的轮询。
 */
export function useGitRepositoryStatus(directory: string | null | undefined): GitRepositoryStatus | null {
  const [status, setStatus] = useState<GitRepositoryStatus | null>(() => {
    if (!directory) return null;
    return statusForDirectory(getCachedGitRepositoryStatus(directory, { exact: true })?.status, directory);
  });

  useEffect(() => {
    if (!directory) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    const cached = getCachedGitRepositoryStatus(directory, { exact: true });
    setStatus(statusForDirectory(cached?.status, directory));

    const applyCachedStatus = () => {
      if (cancelled) return;
      const next = getCachedGitRepositoryStatus(directory, { exact: true });
      if (!next) return;
      setStatus(statusForDirectory(next.status, directory));
    };
    const unsubscribe = subscribeGitRepositoryStatus(applyCachedStatus);

    if (!cached) {
      loadGitRepositoryStatus(directory, { exact: true })
        .then(() => applyCachedStatus())
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [directory]);

  return status;
}
