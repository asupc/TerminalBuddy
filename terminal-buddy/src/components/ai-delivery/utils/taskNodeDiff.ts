/** 任务字段 diff 展示：与后端 build_task_diff 的 `field: '旧值' → '新值'` 风格一致。
 *  后端 taskNodeEdited 事件 message 即该风格拼接的 diff 字符串，前端按 message 直接展示。 */
export function formatFieldDiff(field: string, before: string | null, after: string | null): string {
  const fmt = (v: string | null) => (v === null ? "空" : `'${v}'`);
  return `${field}: ${fmt(before)} → ${fmt(after)}`;
}
