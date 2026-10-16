import type { Profile } from '../types';

const LOCAL_SHELL_TYPES: string[] = ['powershell', 'pwsh', 'cmd'];

/** 引用可注入的本地 shell 类型全集（后端 ssh/docker/k8s 分支丢弃引用，不在此列）。 */
const REF_LOCAL_SHELL_TYPES: string[] = ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh'];

/** 该终端类型是否支持模型引用启动（仅本地 shell）。 */
export function isModelRefLocalType(terminalType: string): boolean {
  return REF_LOCAL_SHELL_TYPES.includes(terminalType);
}

/** 引用标记前缀：`__TB_CLAUDE_REF__:<providerId>:<modelId>`（与后端展开条件一致）。 */
export const CLAUDE_REF_PREFIX = '__TB_CLAUDE_REF__:';

/** 命令是否以引用标记开头（首个空白分隔 token 匹配，与后端展开条件一致）。 */
export function containsClaudeRef(command: string): boolean {
  const token = command.trimStart().split(/\s/, 1)[0] ?? '';
  return token.startsWith(CLAUDE_REF_PREFIX) && token.slice(CLAUDE_REF_PREFIX.length).includes(':');
}

/** 解析命令首 token 的模型引用（providerId/modelId 须非空，与后端一致），非引用命令返回 null。 */
export function parseClaudeRef(command: string): { providerId: string; modelId: string } | null {
  const token = command.trimStart().split(/\s/, 1)[0] ?? '';
  if (!token.startsWith(CLAUDE_REF_PREFIX)) return null;
  const rest = token.slice(CLAUDE_REF_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { providerId: rest.slice(0, sep), modelId: rest.slice(sep + 1) };
}

/** 命令里跑 claude：`claude`、`claude.cmd`、后面还带参数的都算。 */
export function isClaudeCommand(command: string): boolean {
  return /(?:^|[\s"'=])claude(?:\.cmd|\.exe|\.bat)?(?=$|[\s"'=])/i.test(command);
}

/**
 * 启动命令里跑 claude 的本地连接：`claude`、`claude.cmd`、后面还带参数的都算。
 * 远程连接不算——恢复会话要在本地目录里起 claude。
 */
export function isClaudeLaunchProfile(profile: Profile): boolean {
  if (!LOCAL_SHELL_TYPES.includes(profile.terminalType)) return false;
  return profile.startupCommands.some(isClaudeCommand);
}

/** 与引用展开冲突的参数：展开结果自带同名 flag，且 CLI 以后者为准会反超，须剔除。 */
const CLAUDE_REF_CONFLICT_ARG_RE = /(^|\s)--(model|settings|effort)(=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?/gi;

/** 提取命令中 claude 的参数部分：`claude --x` → `--x`；参数截到命令分隔符（&& / ; / |）为止。 */
function claudeArgsFromCommand(command: string): string {
  // 前后引号都须消耗掉（后瞻不消耗字符，闭引号会残留在参数开头）
  const match = command.match(/(?:[\s"'=]|^)claude(?:\.cmd|\.exe|\.bat)?["']?(?=$|\s)/i);
  if (!match || match.index === undefined) return '';
  const rest = command.slice(match.index + match[0].length);
  return (rest.split(/&&|\|\||;|\|/, 1)[0] ?? '').trim();
}

/** 剔除与引用展开冲突的参数（--model/--settings/--effort 及其值）。 */
function stripClaudeRefConflictArgs(args: string): string {
  return args.replace(CLAUDE_REF_CONFLICT_ARG_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 模型引用启动（independent 整条替换启动命令）时，从项目/连接的原启动命令里
 * 继承 claude 的参数（如 --dangerously-skip-permissions），冲突参数剔除。
 * 接受项目 startupCommand（string）或连接 startup_commands（string[]），无 claude 返回 ''。
 */
export function inheritableClaudeArgs(source: string | string[] | undefined): string {
  const commands = typeof source === 'string' ? [source] : (source ?? []);
  const claudeCommand = commands.find(isClaudeCommand);
  if (!claudeCommand) return '';
  return stripClaudeRefConflictArgs(claudeArgsFromCommand(claudeCommand));
}
