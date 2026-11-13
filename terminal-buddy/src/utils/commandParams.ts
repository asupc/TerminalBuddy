/** extraParams 里历史遗留的 --resume 参数；UUID 至少 8 位才按会话 ID 处理。 */
export const SAVED_RESUME_RE = /--resume\s+([0-9a-fA-F-]{8,64})/;

/** Codex 的 `codex resume <id>`；用供应商引用标记（`__TB_CODEX_REF__:<供应商>:<模型>`）
 * 启动的会话同样以 `resume <id>` 续接，剥离时必须一并识别，否则新建终端会恢复旧会话。 */
const SAVED_CODEX_RESUME_RE =
  /(?:__TB_CODEX_REF__:[^\s;&|]+|\bcodex(?:\.cmd|\.exe|\.bat)?)(?:\s+[^\s;&|]+)*\s+resume\s+([a-zA-Z0-9_-]{1,128})/;

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

export interface StrippedCodexResumeArgs {
  params: string;
  sessionId?: string;
}

/** 剥除 Codex 的 `resume <id>` 子命令。 */
export function stripCodexResumeArgs(params: string): StrippedCodexResumeArgs {
  const sessionId = params.match(SAVED_CODEX_RESUME_RE)?.[1];
  if (!sessionId) return { params };
  return {
    // 只删匹配到的那一处，避免误伤参数值里恰好出现的 resume 字样。
    params: params.replace(new RegExp(`\\s*resume\\s+${sessionId}`), ''),
    sessionId,
  };
}

/** 剥除所有 Agent 的会话恢复参数（Claude `--resume`、Codex `resume <id>`）
 * 并压缩多余空格；入参为空或剥空后返回 undefined。「以此配置新建终端」等场景要的是
 * 全新会话，恢复页签 extraParams 里的旧会话引用必须全部剥除。 */
export function withoutResumeArgs(params: string | undefined | null): string | undefined {
  if (!params) return undefined;
  const stripped = stripCodexResumeArgs(stripResumeArgs(params).params).params
    .replace(/\s+/g, ' ').trim();
  return stripped || undefined;
}
