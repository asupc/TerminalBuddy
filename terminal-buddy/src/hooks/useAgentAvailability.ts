import { useEffect, useState } from 'react';
import { getAgentCliEnvironment } from '../services/agentCli';

export type AgentKind = 'claude' | 'codex' | 'antigravity';

export type AgentAvailability = Record<AgentKind, boolean>;

type EnvironmentLike = Partial<Record<AgentKind, { status?: string } | undefined>>;

/** 与 HistoryPanel 一致的可用判定：安装中 / 更新中同样视作可用。 */
const isAvailableStatus = (status?: string) =>
  status === 'installed' || status === 'updating' || status === 'installing';

/**
 * Agent CLI 环境检测结果（claude / codex / antigravity 是否可用）。
 * 挂载时查一次，并跟随设置页「Agent 管理」派发的 agent-cli-status-changed 事件刷新。
 * 检测返回前或检测失败时返回 null，调用方应视为「全部可用」，避免菜单项闪烁或整块消失。
 */
export function useAgentAvailability(): AgentAvailability | null {
  const [availability, setAvailability] = useState<AgentAvailability | null>(null);

  useEffect(() => {
    let cancelled = false;
    const apply = (environment: EnvironmentLike | null | undefined) => {
      if (cancelled || !environment) return;
      setAvailability({
        claude: isAvailableStatus(environment.claude?.status),
        codex: isAvailableStatus(environment.codex?.status),
        antigravity: isAvailableStatus(environment.antigravity?.status),
      });
    };
    void getAgentCliEnvironment().then(apply).catch(() => {});
    const onChange = (event: Event) => {
      apply((event as CustomEvent<EnvironmentLike>).detail);
    };
    window.addEventListener('agent-cli-status-changed', onChange);
    return () => {
      cancelled = true;
      window.removeEventListener('agent-cli-status-changed', onChange);
    };
  }, []);

  return availability;
}
