import type { TerminalActivityState } from '../stores/appStore';
import { getWorkingDotColor } from './tabColor';

/**
 * 会话活动指示灯状态机（标签小灯 / 总览卡片共用）：
 * - 首个 hook 事件（无论类型）→ runtimeKind=claude，「会话在场」点亮
 * - UserPromptSubmit → running 绿闪「Claude 执行中」
 * - permission_prompt / 决策 → attention 黄闪「等待你的确认」
 * - 用户中断（转录标记）→ idle 灰灯「会话在场 · 空闲」
 * - Stop → completed 绿亮「任务完成」
 * - StopFailure → failed 红长亮「错误停止」（点击清除；不受 30min 过期影响）
 * - SessionEnd → 会话在场熄灭（runtimeKind 回 shell）
 */
export type IndicatorLight = 'none' | 'presence' | 'running' | 'attention' | 'completed' | 'failed';

export function getIndicatorLight(activity: TerminalActivityState | undefined): IndicatorLight {
  if (!activity || activity.runtimeKind === 'shell') return 'none';
  switch (activity.phase) {
    case 'running': return 'running';
    case 'attention': return 'attention';
    case 'failed': return 'failed';
    case 'completed': return 'completed';
    default: return 'presence';
  }
}

/**
 * 原生 AI 会话（独立 CLI 进程）的指示灯：状态来自服务端 `AiSession.status`，
 * 与终端 hook 状态机相互独立（原生会话没有 hook 的 Stop / presence 事件）。
 * - running / background / stopping → 呼吸
 * - approval → 黄闪「等待你的确认」
 * - error → 红长亮
 * - idle / interrupted / 未知 → 灰点「会话在场」
 */
export function getNativeAgentLight(status: string | undefined): IndicatorLight {
  switch (status) {
    case 'running':
    case 'background':
    case 'stopping':
      return 'running';
    case 'approval':
      return 'attention';
    case 'error':
      return 'failed';
    default:
      return 'presence';
  }
}

/** 灯色：running 尊重呼吸灯自定义色；attention/failed/completed 用固定语义色；presence 灰 */
export function getIndicatorColor(light: IndicatorLight, tabColor?: string | null): string {
  switch (light) {
    case 'running': return getWorkingDotColor(true, tabColor);
    case 'attention': return '#e6a23c';
    case 'failed': return '#f14c4c';
    case 'completed': return '#56d364';
    case 'presence': return 'var(--text-tertiary)';
    case 'none': return getWorkingDotColor(false, tabColor);
  }
}

const LIGHT_TITLE: Record<IndicatorLight, string> = {
  none: '',
  presence: '会话在场 · 空闲',
  running: 'Agent 执行中',
  attention: '等待你的确认（点击处理）',
  completed: '任务完成',
  failed: '错误停止（点击清除）',
};

export function getIndicatorTitle(light: IndicatorLight, provider?: 'claude' | 'codex'): string {
  const name = provider === 'codex' ? 'Codex' : 'Claude';
  const title = LIGHT_TITLE[light];
  if (!title) return title;
  return title
    .replace('会话在场', `${name} 会话在场`)
    .replace('Agent 执行中', `${name} 执行中`);
}

/** 灯的附加样式类（动画定义在 global.css） */
export function getIndicatorClassName(light: IndicatorLight): string {
  return light === 'none' ? '' : ` led-${light}`;
}
