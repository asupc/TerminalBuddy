import type { TerminalActivityState } from '../stores/appStore';
import { getWorkingDotColor } from './tabColor';

/**
 * 会话活动指示灯状态机（标签小灯 / 总览卡片共用）：
 * - 首个 hook 事件（无论类型）→ runtimeKind=claude，「会话在场」点亮
 * - UserPromptSubmit → running 绿闪「Claude 执行中」
 * - permission_prompt / 决策 → attention 黄闪「等待你的确认」
 * - Stop → completed 绿亮「任务完成」
 * - StopFailure → failed 红长亮「错误停止」（点击清除；不受 30min 过期影响）
 * - SessionEnd → 会话在场熄灭（runtimeKind 回 shell）
 */
export type IndicatorLight = 'none' | 'presence' | 'running' | 'attention' | 'completed' | 'failed';

export function getIndicatorLight(activity: TerminalActivityState | undefined): IndicatorLight {
  if (!activity || activity.runtimeKind !== 'claude') return 'none';
  switch (activity.phase) {
    case 'running': return 'running';
    case 'attention': return 'attention';
    case 'failed': return 'failed';
    case 'completed': return 'completed';
    default: return 'presence';
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
  presence: 'Claude 会话在场 · 空闲',
  running: 'Claude 执行中',
  attention: '等待你的确认（点击处理）',
  completed: '任务完成',
  failed: '错误停止（点击清除）',
};

export function getIndicatorTitle(light: IndicatorLight): string {
  return LIGHT_TITLE[light];
}

/** 灯的附加样式类（动画定义在 global.css） */
export function getIndicatorClassName(light: IndicatorLight): string {
  return light === 'none' ? '' : ` led-${light}`;
}
