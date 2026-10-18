import { parseClaudeRef } from './claudeLaunch';

export const CODEX_REF_PREFIX = '__TB_CODEX_REF__:';

export function isCodexCommand(command: string): boolean {
  return /(?:^|[\s"'=])codex(?:\.cmd|\.exe|\.bat)?(?=$|[\s"'=])/i.test(command);
}

export function parseCodexRef(command: string): { providerId: string; modelId: string } | null {
  const token = command.trimStart().split(/\s/, 1)[0] ?? '';
  if (!token.startsWith(CODEX_REF_PREFIX)) return null;
  const rest = token.slice(CODEX_REF_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { providerId: rest.slice(0, sep), modelId: rest.slice(sep + 1) };
}

export function parseModelRef(command: string): { providerId: string; modelId: string } | null {
  return parseCodexRef(command) ?? parseClaudeRef(command);
}

/** 保留 Codex 的权限/沙箱参数；模型、profile 和配置覆盖由本次选择决定。 */
export function buildCodexRefCommand(providerId: string, modelId: string, source?: string | string[]): string {
  const commands = typeof source === 'string' ? [source] : source ?? [];
  const command = commands.find(isCodexCommand) ?? '';
  const match = command.match(/(?:[\s"'=]|^)codex(?:\.cmd|\.exe|\.bat)?["']?(?=$|\s)/i);
  const args = match?.index === undefined ? '' : command.slice(match.index + match[0].length).split(/&&|\|\||;|\|/, 1)[0];
  const inherited = args.replace(/(^|\s)(?:--(?:model|profile|config|local-provider|remote|remote-auth-token-env)|-[mpc])(?==|\s|$)(?:=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?/gi, ' ').replace(/(^|\s)--oss(?=$|\s)/gi, ' ').trim();
  return [`${CODEX_REF_PREFIX}${providerId}:${modelId}`, inherited].filter(Boolean).join(' ');
}
