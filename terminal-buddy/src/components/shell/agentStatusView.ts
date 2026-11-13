import type { AiContextUsage, AiTokenUsage } from '../../services/tauri';

/**
 * 状态栏 Agent 条目的统一视图：原生会话与终端里启动的 Agent 共用同一份数据口径，
 * 由 AppStatusBar 负责把两种来源映射成这个结构。
 */
export interface AgentStatusView {
  provider: 'claude' | 'codex' | string;
  providerLabel: string;
  providerName: string | null;
  model: string | null;
  effort: string | null;
  /** 原生会话的运行状态；终端 Agent 没有推送通道，恒为 null。 */
  status: string | null;
  context: AiContextUsage | null;
  sessionTotal: AiTokenUsage | null;
  lastTurn: AiTokenUsage | null;
  source: 'native' | 'terminal';
  /** 终端来源最近一次读到 transcript 的时间。 */
  updatedAt: number | null;
}

/** 目录里的思考强度是 CLI 使用的英文枚举，状态栏按中文习惯展示。 */
const EFFORT_LABELS: Record<string, string> = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};

export function agentEffortLabel(effort: string | null | undefined): string | null {
  if (!effort) return null;
  return EFFORT_LABELS[effort] ?? effort;
}

/** 上下文告警级别：超过 60% 转黄，超过 80% 转红。 */
export function contextLevel(percent: number | null): 'warn' | 'critical' | null {
  if (percent == null) return null;
  if (percent > 80) return 'critical';
  if (percent > 60) return 'warn';
  return null;
}
