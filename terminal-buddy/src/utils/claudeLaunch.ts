import type { Profile } from '../types';

const LOCAL_SHELL_TYPES: string[] = ['powershell', 'pwsh', 'cmd'];

/**
 * 启动命令里跑 claude 的本地连接：`claude`、`claude.cmd`、后面还带参数的都算。
 * 远程连接不算——恢复会话要在本地目录里起 claude。
 */
export function isClaudeLaunchProfile(profile: Profile): boolean {
  if (!LOCAL_SHELL_TYPES.includes(profile.terminalType)) return false;
  return profile.startupCommands.some(command =>
    /(?:^|[\s"'=])claude(?:\.cmd|\.exe|\.bat)?(?=$|[\s"'=])/i.test(command));
}
