/**
 * 把毫秒时长格式化为简短后缀：Xs / Xm / Xh / Xd。
 * < 60s → 秒；< 60m → 分；< 24h → 时；否则 → 天。
 */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
