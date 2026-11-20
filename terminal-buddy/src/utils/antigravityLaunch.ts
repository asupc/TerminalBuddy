export const DEFAULT_ANTIGRAVITY_COMMAND = 'agy --dangerously-skip-permissions';

/** 命令里跑 Antigravity CLI：`agy`、`agy.exe`、`agy.cmd`、`agy.bat` 及带参数的变体都算。 */
export function isAntigravityCommand(command: string): boolean {
  return /(?:^|[\s"'=])agy(?:\.cmd|\.exe|\.bat)?(?=$|[\s"'=])/i.test(command);
}

const ANTIGRAVITY_CONVERSATION_ARG_RE =
  /(^|\s)--conversation(?:=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?(?=$|\s)/gi;

const ANTIGRAVITY_CONTINUE_ARG_RE =
  /(^|\s)(?:--continue|-c)(?=$|\s)/gi;

const VALID_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

function splitCommandTail(command: string): { head: string; tail: string } {
  const sepMatch = command.match(/\s*(?:&&|\|\||;|\|)/);
  if (sepMatch?.index === undefined) return { head: command, tail: '' };
  return {
    head: command.slice(0, sepMatch.index),
    tail: command.slice(sepMatch.index),
  };
}

/** 组装 Antigravity CLI 启动命令：返回规范化后的基础命令。 */
export function buildAntigravityLaunchCommand(baseCommand?: string): string {
  return baseCommand?.trim() || DEFAULT_ANTIGRAVITY_COMMAND;
}

/** 组装恢复历史对话的 Antigravity CLI 命令（`agy ... --conversation <sessionId>`）。 */
export function buildAntigravityResumeCommand(
  sessionId: string,
  baseCommand?: string,
): string {
  const trimmedId = sessionId.trim();
  if (!trimmedId || !VALID_SESSION_ID_RE.test(trimmedId)) {
    throw new Error('Antigravity 会话 ID 无效');
  }

  const base = baseCommand?.trim() || DEFAULT_ANTIGRAVITY_COMMAND;
  const { head, tail } = splitCommandTail(base);
  const cleanedHead = head
    .replace(ANTIGRAVITY_CONVERSATION_ARG_RE, ' ')
    .replace(ANTIGRAVITY_CONTINUE_ARG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'agy';

  return `${cleanedHead} --conversation ${trimmedId}${tail}`;
}

/** 从 Antigravity 启动命令提取 `--conversation <id>`（非 `agy` 命令返回 undefined）。 */
export function resumedAntigravitySessionId(command?: string): string | undefined {
  if (!command || !isAntigravityCommand(command)) return undefined;
  let sessionId: string | undefined;
  for (const match of command.matchAll(/(?:^|\s)--conversation(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    sessionId = match.slice(1).find(Boolean);
  }
  return sessionId?.trim() || undefined;
}
