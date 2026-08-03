// AI 交付错误分类与本地化提示
export interface ClassifiedError {
  category: string;
  message: string;
  hint: string;
}

/** 将任意异常分类为「网络/超时/资源缺失/后端错误」，并给出可操作的修复提示 */
export function classifyAiError(err: unknown): ClassifiedError {
  const raw = err instanceof Error ? err.message : String(err);
  if (/network|fetch|failed to fetch|ECONN|disconnected/i.test(raw)) {
    return { category: "网络", message: raw, hint: "检查网络连接后重试" };
  }
  if (/timeout|超时/i.test(raw)) {
    return { category: "超时", message: raw, hint: "任务仍在运行或已超时，可查看事件列表确认" };
  }
  if (/not found|不存在|no such/i.test(raw)) {
    return { category: "资源缺失", message: raw, hint: "目标已删除或路径失效，请刷新后重试" };
  }
  return { category: "后端错误", message: raw, hint: "查看事件列表定位原因" };
}
