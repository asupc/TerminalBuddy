// 终端 Agent 面板的展示辅助：阶段 / 供应商文案与相对时间（界面文案一律简体中文）。
import type { TerminalAgentPhase } from '../../services/terminalAgent';

/** 阶段中文文案（§5.2：正在执行 / 等待确认 / 空闲 / 已完成 / 失败 / 已结束 / 未知）。 */
export const AGENT_PHASE_LABEL: Record<TerminalAgentPhase, string> = {
  attention: '等待确认',
  running: '正在执行',
  idle: '空闲',
  completed: '已完成',
  failed: '失败',
  ended: '已结束',
  unknown: '未知',
};

/** 阶段对应的 CSS 修饰类（TerminalAgentPanel.css 里的 ta-phase-*）。 */
export const AGENT_PHASE_CLASS: Record<TerminalAgentPhase, string> = {
  attention: 'attention',
  running: 'running',
  idle: 'idle',
  completed: 'completed',
  failed: 'failed',
  ended: 'ended',
  unknown: 'unknown',
};

export function phaseLabel(phase: string | undefined | null): string {
  if (!phase) return AGENT_PHASE_LABEL.unknown;
  return AGENT_PHASE_LABEL[phase as TerminalAgentPhase] ?? phase;
}

export function phaseClass(phase: string | undefined | null): string {
  if (!phase) return AGENT_PHASE_CLASS.unknown;
  return AGENT_PHASE_CLASS[phase as TerminalAgentPhase] ?? 'unknown';
}

export function providerLabel(provider: string | undefined | null): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'pi') return 'Pi';
  return provider || 'Agent';
}

/** 镜像不可用原因 → 引导文案；未知 reason 原样展示机器码。 */
export function mirrorReasonText(reason: string | null | undefined): string {
  if (reason === 'transcript_unreadable') return '会话转录暂时无法读取，可稍后刷新或打开终端查看';
  if (reason === 'transcript_too_large') return '会话转录过大，已停止镜像，请打开终端或历史页查看';
  return reason ? `镜像不可用：${reason}` : '镜像不可用';
}

/** 相对时间：null 返回空串（展示「活动时间未知」，不编造时间）。 */
export function formatRelativeTime(millis: number | null | undefined, now = Date.now()): string {
  if (typeof millis !== 'number' || !Number.isFinite(millis)) return '';
  const diff = Math.max(0, now - millis);
  if (diff < 30_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

/** 列表 / 会话标题：无标题回退 sessionId 前缀（§4.2 第 3 条）。 */
export function agentSessionTitle(title: string | null | undefined, sessionId: string | undefined | null): string {
  if (title && title.trim()) return title;
  if (sessionId) return `会话 ${sessionId.slice(0, 8)}`;
  return '未命名会话';
}
