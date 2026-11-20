import type { Profile, Project, TerminalType } from '../types';
import type { AiCatalog } from '../services/tauri/aiChat';
import type {
  ScheduledRun,
  ScheduledRunStatus,
  ScheduledRunTone,
  ScheduledTask,
  TaskSchedule,
} from '../types/scheduledTask';

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localDate(ms: number): Date {
  return new Date(ms);
}

function dateKey(value: Date): string {
  return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
}

export function formatTime(ms: number): string {
  const date = localDate(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 今天 HH:mm / 明天 HH:mm / MM-DD HH:mm。 */
export function formatNextRun(ms: number | null | undefined): string {
  if (!ms) return '';
  const target = localDate(ms);
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const time = formatTime(ms);
  if (dateKey(target) === dateKey(now)) return `今天 ${time}`;
  if (dateKey(target) === dateKey(tomorrow)) return `明天 ${time}`;
  return `${pad(target.getMonth() + 1)}-${pad(target.getDate())} ${time}`;
}

/** 按指定 IANA 时区格式化「MM-DD HH:mm」，用于任务时区下的执行预览。 */
export function formatInTimezone(ms: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms));
    const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
    return `${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
  } catch {
    return formatNextRun(ms);
  }
}

/** 运行记录时间：今天 / 昨天 / MM-DD HH:mm:ss。 */
export function formatRunTime(ms: number): string {
  const target = localDate(ms);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const time = `${pad(target.getHours())}:${pad(target.getMinutes())}:${pad(target.getSeconds())}`;
  if (dateKey(target) === dateKey(now)) return `今天 ${time}`;
  if (dateKey(target) === dateKey(yesterday)) return `昨天 ${time}`;
  return `${pad(target.getMonth() + 1)}-${pad(target.getDate())} ${time}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function isNumber(value: string): boolean {
  return /^\d+$/.test(value);
}

function weekdayLabel(day: number): string {
  if (day === 7) return WEEKDAY_LABELS[0];
  return WEEKDAY_LABELS[day] ?? `周${day}`;
}

function describeWeekdays(field: string): string | null {
  const normalized = field.trim();
  if (normalized === '1-5' || normalized === '1,2,3,4,5') return '工作日';
  if (isNumber(normalized)) {
    const day = Number(normalized);
    if (day >= 0 && day <= 7) return `每${weekdayLabel(day)}`;
  }
  return null;
}

/** 把 Cron 表达式翻译成中文文案；无法识别的表达式回退为原始写法。 */
function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  // 6 段表达式带秒；只解释「0 秒」的常见写法。
  if (fields.length === 6) {
    if (fields[0] !== '0') return `Cron ${expression.trim()}`;
    fields.shift();
  }
  if (fields.length !== 5) return `Cron ${expression.trim()}`;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*') return `Cron ${expression.trim()}`;

  if (hour === '*') {
    if (minute === '*') return '每分钟';
    if (minute.startsWith('*/')) return `每 ${minute.slice(2)} 分钟`;
    if (isNumber(minute)) return `每小时第 ${Number(minute)} 分`;
    return `Cron ${expression.trim()}`;
  }
  if (hour.startsWith('*/')) {
    return isNumber(minute) ? `每 ${hour.slice(2)} 小时第 ${Number(minute)} 分` : `Cron ${expression.trim()}`;
  }
  if (!isNumber(minute) || !isNumber(hour)) return `Cron ${expression.trim()}`;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (dayOfWeek === '*') return `每天 ${time}`;
  const weekdays = describeWeekdays(dayOfWeek);
  if (weekdays) return `${weekdays} ${time}`;
  if (/^[0-7](,[0-7])+$/.test(dayOfWeek)) {
    const labels = dayOfWeek.split(',').map(day => weekdayLabel(Number(day))).join('、');
    return `每${labels} ${time}`;
  }
  return `Cron ${expression.trim()}`;
}

export function formatSchedule(task: Pick<ScheduledTask, 'schedule'>): string {
  const schedule: TaskSchedule = task.schedule;
  if (schedule.kind === 'once') {
    const value = schedule.runAt.replace('T', ' ');
    return `仅一次 · ${value.slice(0, 16)}`;
  }
  return describeCron(schedule.expression);
}

export function formatRunStatus(status: ScheduledRunStatus | string): {
  label: string;
  tone: ScheduledRunTone;
} {
  switch (status) {
    case 'running':
      return { label: '运行中', tone: 'running' };
    case 'waitingApproval':
      return { label: '等待确认', tone: 'warn' };
    case 'completed':
      return { label: '已完成', tone: 'success' };
    case 'failed':
      return { label: '失败', tone: 'danger' };
    case 'timeout':
      return { label: '超时', tone: 'danger' };
    case 'stopped':
      return { label: '已停止', tone: 'idle' };
    case 'started':
      return { label: '已启动', tone: 'success' };
    case 'skipped':
      return { label: '已跳过', tone: 'idle' };
    default:
      return { label: status || '未知', tone: 'idle' };
  }
}

export function formatTrigger(trigger: string): string {
  return trigger === 'manual' ? '手动' : '计划';
}

export function agentLabel(agent: string | null | undefined): string {
  if (agent === 'codex') return 'Codex';
  if (agent === 'claude') return 'Claude';
  if (agent === 'antigravity') return 'Antigravity';
  return agent || 'Agent';
}

/** 目标摘要：`TerminalBuddy · 开发环境` / `Claude · DeepSeek · deepseek-chat`。 */
export function describeTarget(
  task: Pick<ScheduledTask, 'target'>,
  profiles: Profile[] = [],
  catalog?: AiCatalog | null,
): string {
  const target = task.target;
  if (target.kind === 'projectProfile') {
    const profile = profiles.find(item => item.id === target.profileId);
    return [target.projectName, profile?.name ?? '配置已删除'].filter(Boolean).join(' · ');
  }
  // Antigravity 固定使用 Google 账号登录，没有供应商 / 模型可选。
  if (target.agent === 'antigravity') return agentLabel(target.agent);
  const provider = catalog?.providers.find(item => item.id === target.providerId)
    ?? (target.providerId ? undefined : catalog?.providers.find(item => item.id === `default:${target.agent}`));
  const providerName = provider?.name
    ?? (target.providerId ? '供应商已删除' : '服务端默认配置');
  const parts = [agentLabel(target.agent), providerName];
  if (target.model) parts.push(target.model);
  return parts.join(' · ');
}

export function targetKindLabel(task: Pick<ScheduledTask, 'target'>): string {
  return task.target.kind === 'agentPrompt' ? 'Agent 任务' : '项目配置';
}

export function taskProjectName(task: Pick<ScheduledTask, 'target'>): string {
  return task.target.projectName;
}

/** 项目下的终端配置：空 group 视为「默认」，与后端校验一致。 */
export function profilesForProject(profiles: Profile[], projectName: string): Profile[] {
  return profiles.filter(profile => {
    const group = profile.group.trim() || '默认';
    return group === projectName;
  });
}

/** 配置卡片上的终端类型说明。 */
export function terminalTypeLabel(type: TerminalType | string): string {
  switch (type) {
    case 'ssh': return 'SSH';
    case 'docker': return 'Docker';
    case 'k8s': return 'K8s';
    case 'mstsc': return '远程桌面';
    case 'editor': return '编辑器';
    default: return type || '终端';
  }
}

export function runTokenTotal(run: Pick<ScheduledRun, 'inputTokens' | 'outputTokens'>): number {
  return (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
}

/** 项目名去重后的排序列表，供下拉框使用。 */
export function projectOptions(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}
