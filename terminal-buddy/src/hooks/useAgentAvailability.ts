import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';

export type AgentKind = 'claude' | 'codex' | 'antigravity';

export type AgentAvailability = Record<AgentKind, boolean>;

/** 与 HistoryPanel 一致的可用判定：安装中 / 更新中同样视作可用。 */
const isAvailableStatus = (status?: string) =>
  status === 'installed' || status === 'updating' || status === 'installing';

/** 订阅启动时加载、由设置变更事件更新的环境缓存，组件挂载时不再发起检测。 */
export function useAgentAvailability(): AgentAvailability | null {
  const environment = useAppStore(state => state.agentCliEnvironment);
  return useMemo(() => environment ? {
    claude: isAvailableStatus(environment.claude.status),
    codex: isAvailableStatus(environment.codex.status),
    antigravity: isAvailableStatus(environment.antigravity.status),
  } : null, [environment]);
}
