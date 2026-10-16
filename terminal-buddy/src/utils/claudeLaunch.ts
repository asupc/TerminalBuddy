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
