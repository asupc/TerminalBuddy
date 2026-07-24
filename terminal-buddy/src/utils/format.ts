/**
 * 把 Unix 毫秒时间戳格式化为「最后检查 X」文案。
 * - null → "尚未检查"
 * - < 60s → "刚刚"
 * - < 60min → "X 分钟前"
 * - < 24h → "X 小时前"
 * - >= 24h 同年 → "MM-DD HH:mm"
 * - >= 24h 跨年 → "YYYY-MM-DD HH:mm"
 */
export function formatRelativeTime(ms: number | null): string {
  if (ms == null) return '尚未检查';
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚'; // 系统时间倒退保护
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === new Date().getFullYear()) return stamp;
  return `${d.getFullYear()}-${stamp}`;
}
