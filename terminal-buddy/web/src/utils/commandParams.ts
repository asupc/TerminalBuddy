/** extraParams 里历史遗留的 --resume 参数；UUID 至少 8 位才按会话 ID 处理。 */
export const SAVED_RESUME_RE = /--resume\s+([0-9a-fA-F-]{8,64})/;

export interface StrippedResumeArgs {
  params: string;
  resumeId?: string;
}

/** 剥除 --resume 及其会话 ID（「以此配置新建终端」不应恢复旧会话），返回剩余参数与被剥出的 ID。
 * 只剥不压缩空格，由调用方按 append / independent 模式自行整理。 */
export function stripResumeArgs(params: string): StrippedResumeArgs {
  const resumeId = params.match(SAVED_RESUME_RE)?.[1];
  if (!resumeId) return { params };
  return { params: params.replace(/--resume\s+[0-9a-fA-F-]+/g, ''), resumeId };
}

/** 剥除 --resume 并压缩多余空格；入参为空或剥空后返回 undefined，适合直接作为启动参数。 */
export function withoutResumeArgs(params: string | undefined | null): string | undefined {
  if (!params) return undefined;
  const stripped = stripResumeArgs(params).params.replace(/\s+/g, ' ').trim();
  return stripped || undefined;
}
