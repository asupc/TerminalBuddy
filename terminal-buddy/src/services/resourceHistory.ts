import type { SystemResources } from './tauri';

/** 一次 CPU / 内存采样。 */
export interface ResourceSample {
  /** 采样时间戳（毫秒）。 */
  t: number;
  /** CPU 使用率（0–100）。 */
  cpu: number;
  /** 内存使用率（0–100）。 */
  mem: number;
}

/** 趋势图缓存窗口：近 2 小时。 */
export const RESOURCE_HISTORY_WINDOW_MS = 2 * 60 * 60 * 1000;
/** 3 秒一次采样，2 小时约 2400 个点；留一点余量即可，超出按时间窗口裁剪。 */
const MAX_SAMPLES = 2_600;
const STORAGE_KEY = 'terminalbuddy.resourceHistory.v1';
const PERSIST_DELAY_MS = 15_000;

function sanitize(value: unknown, cutoff: number): ResourceSample | null {
  if (!value || typeof value !== 'object') return null;
  const { t, cpu, mem } = value as Partial<ResourceSample>;
  if (
    typeof t !== 'number' || !Number.isFinite(t) || t < cutoff
    || typeof cpu !== 'number' || !Number.isFinite(cpu) || cpu < 0 || cpu > 100
    || typeof mem !== 'number' || !Number.isFinite(mem) || mem < 0 || mem > 100
  ) {
    return null;
  }
  return { t, cpu, mem };
}

function loadPersisted(): ResourceSample[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - RESOURCE_HISTORY_WINDOW_MS;
    return parsed
      .map(item => sanitize(item, cutoff))
      .filter((item): item is ResourceSample => item !== null)
      .slice(-MAX_SAMPLES);
  } catch {
    // 隐私模式或存储损坏时从空历史开始，不影响采样本身。
    return [];
  }
}

let samples: ResourceSample[] = loadPersisted();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function persistSoon(): void {
  if (persistTimer !== undefined) return;
  // 每 3 秒落盘太频繁；攒 15 秒写一次，页面刷新最多丢十几个采样点。
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(samples));
    } catch {
      // 存储配额不足时放弃持久化，内存中的历史照常可用。
    }
  }, PERSIST_DELAY_MS);
}

function prune(now: number): void {
  const cutoff = now - RESOURCE_HISTORY_WINDOW_MS;
  if (samples.length > MAX_SAMPLES || (samples[0] && samples[0].t < cutoff)) {
    samples = samples.filter(sample => sample.t >= cutoff).slice(-MAX_SAMPLES);
  }
}

/** 记录一次采样并通知趋势图。 */
export function recordResourceSample(resources: SystemResources): void {
  const now = Date.now();
  samples.push({ t: now, cpu: resources.cpuUsage, mem: resources.memoryUsage });
  prune(now);
  persistSoon();
  listeners.forEach(listener => listener());
}

/** 只读快照；返回的数组不会被后续采样修改。 */
export function getResourceHistory(): ResourceSample[] {
  prune(Date.now());
  return samples.slice();
}

export function subscribeResourceHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
