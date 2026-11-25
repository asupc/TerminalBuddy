import { bootLog } from './bootLog';

/**
 * 渲染进程内存安全阀。
 *
 * 背景（2026-11）：WebView2 渲染进程曾多次因 V8 堆涨到约 4GB 而 OOM 崩溃，
 * 崩溃后 Tauri 在 Windows 上用 `ExecuteScript` 投递的事件仍会在浏览器进程里
 * 无界排队，实测单个浏览器进程私有内存涨到 10.8GB 且只有完整重启应用才释放。
 *
 * 这里做三级处置：
 * 1. 超过 PRESSURE 水位：广播 `terminal-memory-pressure`，各终端先把回滚历史
 *    从 5 万行压到 4 千行（单个 237 列终端约释放 90MB）。
 * 2. 回落到 RELIEF 水位：广播 `terminal-memory-relief`，恢复回滚容量。
 * 3. 仍超过 RELOAD 水位：记录日志后整页刷新。页面状态（会话、标签、草稿）都在
 *    后端持久化，终端会通过 drain 快照重新挂载，远好于让进程 OOM 把 10GB 留在
 *    浏览器进程里。刷新带冷却时间，避免崩溃循环。
 *
 * 浏览器没有暴露 `performance.memory` 时（非 Chromium、隐私模式）自动降级为无操作。
 */

interface ChromiumPerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

type PerformanceWithMemory = Performance & { memory?: ChromiumPerformanceMemory };

const PRESSURE_BYTES = 600 * 1024 * 1024;
const RELIEF_BYTES = 350 * 1024 * 1024;
const RELOAD_BYTES = 1800 * 1024 * 1024;
const SAMPLE_INTERVAL_MS = 5_000;
const RELOAD_GRACE_MS = 2_000;
const LOG_COOLDOWN_MS = 60_000;
const RELOAD_COOLDOWN_MS = 5 * 60_000;
const RELOAD_MARKER_KEY = 'terminalbuddy.rendererReloadAt';

const megabytes = (bytes: number): number => Math.round(bytes / (1024 * 1024));

function memorySnapshot(): ChromiumPerformanceMemory | null {
  const memory = (performance as PerformanceWithMemory).memory;
  if (!memory || typeof memory.usedJSHeapSize !== 'number') return null;
  return memory;
}

function lastReloadAt(): number {
  try {
    const raw = sessionStorage.getItem(RELOAD_MARKER_KEY);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function markReload(): void {
  try {
    sessionStorage.setItem(RELOAD_MARKER_KEY, String(Date.now()));
  } catch {
    // 隐私模式下无法记录冷却时间，仍允许刷新一次。
  }
}

export function installRendererMemoryGuard(): void {
  if (typeof window === 'undefined' || typeof setInterval !== 'function') return;
  let pressure = false;
  let lastLogAt = 0;
  let reloadScheduled = false;

  const log = (message: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastLogAt < LOG_COOLDOWN_MS) return;
    lastLogAt = now;
    void bootLog(`[memory-guard] ${message}`);
  };

  const sample = () => {
    const memory = memorySnapshot();
    if (!memory) return;
    const used = memory.usedJSHeapSize;

    if (used >= PRESSURE_BYTES && !pressure) {
      pressure = true;
      log(`JS 堆 ${megabytes(used)}MB，压缩终端回滚历史`);
      window.dispatchEvent(new Event('terminal-memory-pressure'));
      return;
    }
    if (used <= RELIEF_BYTES && pressure) {
      pressure = false;
      log(`JS 堆回落到 ${megabytes(used)}MB，恢复终端回滚容量`);
      window.dispatchEvent(new Event('terminal-memory-relief'));
      return;
    }

    if (used >= RELOAD_BYTES && !reloadScheduled) {
      const sinceReload = Date.now() - lastReloadAt();
      if (sinceReload < RELOAD_COOLDOWN_MS) {
        log(`JS 堆 ${megabytes(used)}MB，但 ${Math.round(sinceReload / 1000)}s 前刚刷新过，暂不重复刷新`, true);
        return;
      }
      reloadScheduled = true;
      log(`JS 堆 ${megabytes(used)}MB，超过 ${megabytes(RELOAD_BYTES)}MB 上限，准备刷新页面`, true);
      window.dispatchEvent(new Event('terminal-memory-pressure'));
      // 给日志与一次回滚压缩留出执行时间，再确认内存没有明显回落才刷新。
      window.setTimeout(() => {
        const latest = memorySnapshot()?.usedJSHeapSize ?? used;
        if (latest < RELOAD_BYTES * 0.85) {
          reloadScheduled = false;
          log(`刷新前内存回落到 ${megabytes(latest)}MB，取消刷新`, true);
          return;
        }
        markReload();
        window.location.reload();
      }, RELOAD_GRACE_MS);
    }
  };

  sample();
  setInterval(sample, SAMPLE_INTERVAL_MS);
}
