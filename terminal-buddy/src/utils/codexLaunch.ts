import { parseClaudeRef } from './claudeLaunch';

export const DEFAULT_CODEX_COMMAND = 'codex --dangerously-bypass-approvals-and-sandbox';

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

/** 保留 Codex 的权限/沙箱参数；跨工具启动使用默认命令，模型与配置由本次选择决定。 */
export function buildCodexRefCommand(providerId: string, modelId: string, source?: string | string[]): string {
  const commands = typeof source === 'string' ? [source] : source ?? [];
  const command = commands.find(isCodexCommand) ?? DEFAULT_CODEX_COMMAND;
  const match = command.match(/(?:[\s"'=]|^)codex(?:\.cmd|\.exe|\.bat)?["']?(?=$|\s)/i);
  const args = match?.index === undefined ? '' : command.slice(match.index + match[0].length).split(/&&|\|\||;|\|/, 1)[0];
  const inherited = args.replace(/(^|\s)(?:--(?:model|profile|config|local-provider|remote|remote-auth-token-env)|-[mpc])(?==|\s|$)(?:=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?/gi, ' ').replace(/(^|\s)--oss(?=$|\s)/gi, ' ').trim();
  return [`${CODEX_REF_PREFIX}${providerId}:${modelId}`, inherited].filter(Boolean).join(' ');
}

/** 历史恢复只继承原命令的选项，去掉旧的子命令/会话 ID；不额外放宽权限。 */
export function buildCodexResumeCommand(
  sessionId: string,
  source?: string | string[],
  vendorRef?: { providerId: string; modelId: string },
  extraParams?: string,
): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Codex 会话 ID 无效');
  const commands = typeof source === 'string' ? [source] : source ?? [];
  const original = commands.find(command => isCodexCommand(command) || parseCodexRef(command)) ?? 'codex';
  const reference = parseCodexRef(original);
  const match = original.match(/(?:[\s"'=]|^)codex(?:\.cmd|\.exe|\.bat)?["']?(?=$|\s)/i);
  const head = reference ? original.trimStart().split(/\s/, 1)[0] : 'codex';
  const rest = reference ? original.trimStart().slice(head.length) : match?.index === undefined ? '' : original.slice(match.index + match[0].length);
  // 分词保留引号，避免模型配置值中的空格、分号被截断。
  const tokens = rest.match(/(?:[^\s"';&|]+|"(?:[^"\\]|\\.)*"|'[^']*')+|&&|\|\||[;&|]/g) ?? [];
  const options: string[] = [];
  const takesValue = /^(?:--(?:model|profile|config|sandbox|ask-for-approval|local-provider|cd|add-dir|enable|disable|image|remote|remote-auth-token-env)|-[mpcsaiC])$/;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (['--', '--last', '--all', '--fork'].includes(token)) break;
    if (!token.startsWith('-') || /^(?:&&|\|\||[;|])/.test(token)) break;
    const value = takesValue.test(token) && tokens[index + 1] ? tokens[++index] : undefined;
    if (/^(?:--(?:cd|image)|-[Ci])(?:=|$)/.test(token)) continue;
    if (vendorRef && /^(?:--(?:model|profile|config|local-provider|remote|remote-auth-token-env|oss)|-[mpc])(?:=|$)/.test(token)) continue;
    options.push(token);
    if (value !== undefined) options.push(value);
  }
  const commandHead = vendorRef ? `${CODEX_REF_PREFIX}${vendorRef.providerId}:${vendorRef.modelId}` : head;
  const command = [commandHead, ...options].join(' ');
  return [command, 'resume', sessionId, extraParams?.trim()].filter(Boolean).join(' ');
}


export function resumedCodexSessionId(command?: string): string | undefined {
  if (!command || (!isCodexCommand(command) && !parseCodexRef(command))) return undefined;
  return command.match(/(?:^|\s)resume\s+([a-zA-Z0-9_-]+)(?:\s|$)/)?.[1];
}
