export const DEFAULT_ANTIGRAVITY_COMMAND = 'agy --dangerously-skip-permissions';

export const ANTIGRAVITY_EFFORT_OPTIONS = [
  { value: '', label: '跟随模型默认' },
  { value: 'low', label: 'low（低）' },
  { value: 'medium', label: 'medium（中）' },
  { value: 'high', label: 'high（高）' },
  { value: 'xhigh', label: 'xhigh（超高）' },
  { value: 'max', label: 'max（最大）' },
] as const;

const VALID_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function isValidAntigravityEffort(effort?: string | null): boolean {
  const normalized = effort?.trim().toLowerCase() ?? '';
  return normalized.length > 0 && VALID_EFFORT_LEVELS.has(normalized);
}

/** 优先单模型覆盖的 effort，否则回落到全局默认；均为空则返回 undefined（省略 --effort）。 */
export function resolveAntigravityEffort(
  entryEffort?: string | null,
  defaultEffort?: string | null,
): string | undefined {
  const own = entryEffort?.trim().toLowerCase() ?? '';
  if (own && VALID_EFFORT_LEVELS.has(own)) return own;
  const fallback = defaultEffort?.trim().toLowerCase() ?? '';
  if (fallback && VALID_EFFORT_LEVELS.has(fallback)) return fallback;
  return undefined;
}

/** 命令里跑 Antigravity CLI：`agy`、`agy.exe`、`agy.cmd`、`agy.bat` 及带参数的变体都算。 */
export function isAntigravityCommand(command: string): boolean {
  return /(?:^|[\s"'=])agy(?:\.cmd|\.exe|\.bat)?(?=$|[\s"'=])/i.test(command);
}

const ANTIGRAVITY_MODEL_ARG_RE =
  /(^|\s)(?:--model|-m)(?:=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?(?=$|\s)/gi;

const ANTIGRAVITY_EFFORT_ARG_RE =
  /(^|\s)--effort(?:=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?(?=$|\s)/gi;

const ANTIGRAVITY_CONVERSATION_ARG_RE =
  /(^|\s)--conversation(?:=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?(?=$|\s)/gi;

const ANTIGRAVITY_CONTINUE_ARG_RE =
  /(^|\s)(?:--continue|-c)(?=$|\s)/gi;

const VALID_MODEL_ID_RE = /^[a-zA-Z0-9._:/-]+$/;
const VALID_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

function splitCommandTail(command: string): { head: string; tail: string } {
  const sepMatch = command.match(/\s*(?:&&|\|\||;|\|)/);
  if (sepMatch?.index === undefined) return { head: command, tail: '' };
  return {
    head: command.slice(0, sepMatch.index),
    tail: command.slice(sepMatch.index),
  };
}

/**
 * 组装 Antigravity CLI 启动命令：
 * - 指定 `modelId` 时剔除基础命令里冲突的 `--model`/`-m`，再追加 `--model <modelId>`；
 * - 指定 `effort` 时剔除冲突的 `--effort`，再追加 `--effort <level>`；
 * - 都未指定时直接返回规范化后的基础命令。
 */
export function buildAntigravityLaunchCommand(
  baseCommand?: string,
  modelId?: string,
  effort?: string,
): string {
  const base = baseCommand?.trim() || DEFAULT_ANTIGRAVITY_COMMAND;
  const trimmedModelId = modelId?.trim() ?? '';
  const trimmedEffort = effort?.trim().toLowerCase() ?? '';
  if (trimmedModelId && !VALID_MODEL_ID_RE.test(trimmedModelId)) {
    throw new Error('Antigravity 模型 ID 无效');
  }
  if (trimmedEffort && !isValidAntigravityEffort(trimmedEffort)) {
    throw new Error(`Antigravity 推理等级无效：${effort}`);
  }
  if (!trimmedModelId && !trimmedEffort) return base;

  const { head, tail } = splitCommandTail(base);
  let cleanedHead = head;
  if (trimmedModelId) {
    cleanedHead = cleanedHead.replace(ANTIGRAVITY_MODEL_ARG_RE, ' ');
  }
  if (trimmedEffort) {
    cleanedHead = cleanedHead.replace(ANTIGRAVITY_EFFORT_ARG_RE, ' ');
  }
  cleanedHead = cleanedHead.replace(/\s+/g, ' ').trim() || 'agy';
  const extras: string[] = [];
  if (trimmedModelId) extras.push('--model', trimmedModelId);
  if (trimmedEffort) extras.push('--effort', trimmedEffort);
  return `${cleanedHead} ${extras.join(' ')}${tail}`;
}

/** 组装恢复历史对话的 Antigravity CLI 命令（`agy ... --conversation <sessionId>`）。 */
export function buildAntigravityResumeCommand(
  sessionId: string,
  baseCommand?: string,
  modelId?: string,
  effort?: string,
): string {
  const trimmedId = sessionId.trim();
  if (!trimmedId || !VALID_SESSION_ID_RE.test(trimmedId)) {
    throw new Error('Antigravity 会话 ID 无效');
  }
  const trimmedModelId = modelId?.trim() ?? '';
  const trimmedEffort = effort?.trim().toLowerCase() ?? '';
  if (trimmedModelId && !VALID_MODEL_ID_RE.test(trimmedModelId)) {
    throw new Error('Antigravity 模型 ID 无效');
  }
  if (trimmedEffort && !isValidAntigravityEffort(trimmedEffort)) {
    throw new Error(`Antigravity 推理等级无效：${effort}`);
  }

  const base = baseCommand?.trim() || DEFAULT_ANTIGRAVITY_COMMAND;
  const { head, tail } = splitCommandTail(base);
  let cleanedHead = head
    .replace(ANTIGRAVITY_CONVERSATION_ARG_RE, ' ')
    .replace(ANTIGRAVITY_CONTINUE_ARG_RE, ' ');
  if (trimmedModelId) cleanedHead = cleanedHead.replace(ANTIGRAVITY_MODEL_ARG_RE, ' ');
  if (trimmedEffort) cleanedHead = cleanedHead.replace(ANTIGRAVITY_EFFORT_ARG_RE, ' ');
  cleanedHead = cleanedHead.replace(/\s+/g, ' ').trim() || 'agy';

  const extras: string[] = [];
  if (trimmedModelId) extras.push('--model', trimmedModelId);
  if (trimmedEffort) extras.push('--effort', trimmedEffort);
  extras.push('--conversation', trimmedId);
  return `${cleanedHead} ${extras.join(' ')}${tail}`;
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
