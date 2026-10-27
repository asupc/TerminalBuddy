/** extraParams 里历史遗留的 --resume 参数；UUID 至少 8 位才按会话 ID 处理。 */
export const SAVED_RESUME_RE = /--resume\s+([0-9a-fA-F-]{8,64})/;

/** Pi 的 --session 值可能是 UUID、路径或带引号路径。 */
const SAVED_PI_SESSION_RE = /--session(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/;

/** Codex 的 `codex resume <id>`。 */
const SAVED_CODEX_RESUME_RE = /\bcodex(?:\.cmd|\.exe|\.bat)?(?:\s+[^\s;&|]+)*\s+resume\s+([a-zA-Z0-9_-]{1,128})/;

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

export interface StrippedPiSessionArgs {
  params: string;
  session?: string;
}

/** 剥除 Pi 的 --session 恢复参数。 */
export function stripPiSessionArgs(params: string): StrippedPiSessionArgs {
  const match = params.match(SAVED_PI_SESSION_RE);
  const session = match ? (match[1] ?? match[2] ?? match[3]) : undefined;
  if (!session) return { params };
  return { params: params.replace(/--session(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/g, ''), session };
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
    params: params.replace(/\s*resume\s+[a-zA-Z0-9_-]{1,128}/, ''),
    sessionId,
  };
}

/** 剥除所有 Agent 的会话恢复参数（Claude `--resume`、Pi `--session`、Codex `resume <id>`）
 * 并压缩多余空格；入参为空或剥空后返回 undefined。「以此配置新建终端」等场景要的是
 * 全新会话，恢复页签 extraParams 里的旧会话引用必须全部剥除。 */
export function withoutResumeArgs(params: string | undefined | null): string | undefined {
  if (!params) return undefined;
  const stripped = stripCodexResumeArgs(stripPiSessionArgs(stripResumeArgs(params).params).params).params
    .replace(/\s+/g, ' ').trim();
  return stripped || undefined;
}
