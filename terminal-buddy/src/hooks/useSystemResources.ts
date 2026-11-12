import { useEffect, useState } from 'react';
import { getSystemResources, type SystemResources } from '../services/tauri';
import { recordResourceSample } from '../services/resourceHistory';

/** 状态栏资源读数刷新间隔：远大于 sysinfo 的 CPU 采样窗口，又足够及时。 */
const POLL_INTERVAL_MS = 3_000;

/**
 * 轮询本机 CPU / 内存占用。
 * 页面隐藏时暂停轮询，回到前台立即补一次读数；失败时保留上一次值，状态栏不会闪空。
 * 浏览器模式下读到的是服务端宿主机数据。
 */
export function useSystemResources(enabled = true): SystemResources | null {
  const [resources, setResources] = useState<SystemResources | null>(null);

  useEffect(() => {
    if (!enabled) {
      setResources(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const refresh = async () => {
      try {
        const next = await getSystemResources();
        if (cancelled) return;
        setResources(next);
        // 趋势图共用这份采样：保留近 2 小时，页面刷新后仍可查看。
        recordResourceSample(next);
      } catch {
        // 服务端暂时不可达时静默重试。
      }
    };
    const start = () => {
      clearInterval(timer);
      timer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearInterval(timer);
        timer = undefined;
        return;
      }
      void refresh();
      start();
    };

    void refresh();
    // 首次调用可能离基准采样不足 sysinfo 的最小更新窗口，600ms 后补一次，避免先闪 0%。
    const warmup = setTimeout(() => { void refresh(); }, 600);
    start();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(warmup);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled]);

  return resources;
}
