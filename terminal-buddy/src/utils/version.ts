/**
 * 与 Rust 端 update_service::compare_versions 规则一致。
 * - 支持可选 `v` 前缀（`v1.4.0` 等价 `1.4.0`）。
 * - 必须点分三段全数字，否则视为解析失败 → 返回 0（保守不提示）。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (s: string): number[] | null => {
    const trimmed = s.replace(/^v/, '');
    const parts = trimmed.split('.');
    if (parts.length !== 3) return null;
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return null;
      nums.push(Number(p));
    }
    return nums;
  };
  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  return 0;
}
