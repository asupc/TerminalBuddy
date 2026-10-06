import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { effectiveProfilePath } from '../utils/projectPath';
import { isClaudeLaunchProfile } from '../utils/claudeLaunch';

/**
 * 目录是否指同一个项目。索引里的 cwd 由 Claude Code 上报，前端推算出的路径在大小写、
 * 分隔符与结尾斜杠上都可能不同 —— 规则与 Rust 侧 dir_key / normalized_dir_expr 一致。
 */
export function sameClaudeDir(a: string, b: string): boolean {
  const key = (value: string) => value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return key(a) === key(b);
}

/** 从项目列表里取出作用域对应的那一个；不在作用域内（或未限定作用域）时返回 undefined。 */
export function pickScopedProject<T extends { dir: string }>(
  list: T[],
  scopeDir?: string,
): T | undefined {
  return scopeDir ? list.find(item => sameClaudeDir(item.dir, scopeDir)) : undefined;
}

/**
 * 当前激活的 Claude Code 终端所属项目目录，作为各 Claude 面板的作用域。
 * 目录取会话内记录的（用户浏览或 cd 过），无记录时回退 profile 的启动目录 ——
 * 与 setActiveSession 给“文件与 Git”面板使用的同一套判据。
 * 没有激活终端、或激活的不是 claude 终端时返回 undefined，即回落全局视图。
 */
export function useClaudeProjectScope(): string | undefined {
  const activeSessionId = useAppStore(state => state.activeSessionId);
  const sessions = useAppStore(state => state.sessions);
  const profiles = useAppStore(state => state.profiles);
  const projects = useAppStore(state => state.projects);
  const sessionDirectories = useAppStore(state => state.sessionDirectories);
  const activity = useAppStore(state =>
    state.activeSessionId ? state.terminalActivities[state.activeSessionId] : undefined,
  );
  const claudeSessionId = useAppStore(state =>
    state.activeSessionId ? state.claudeSessionIds[state.activeSessionId] : undefined,
  );

  return useMemo(() => {
    if (!activeSessionId) return undefined;
    const session = sessions.find(item => item.id === activeSessionId);
    const profile = session
      ? profiles.find(item => item.id === session.profileId)
      : undefined;
    // 三条判据任一成立即算 claude 页签：hook 报过会话在场、hook 报过会话 ID，
    // 或它本就是用 claude 连接起的终端 —— 刚点开连接、hook 还没来得及上报时也要收窄。
    if (activity?.runtimeKind !== 'claude'
      && !claudeSessionId
      && !(profile && isClaudeLaunchProfile(profile))) {
      return undefined;
    }
    const recorded = sessionDirectories[activeSessionId];
    if (recorded) return recorded;
    return profile ? effectiveProfilePath(profile, projects) || undefined : undefined;
  }, [activeSessionId, activity, claudeSessionId, sessionDirectories, sessions, profiles, projects]);
}
