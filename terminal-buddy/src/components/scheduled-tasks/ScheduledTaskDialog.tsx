import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  Bot,
  CalendarClock,
  Info,
  LoaderCircle,
  PencilLine,
  Play,
  Terminal,
} from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { useAppStore } from '../../stores/appStore';
import { projectEnabledAgents } from '../../types';
import {
  scheduledTaskPreview,
  scheduledTaskRunNow,
  scheduledTaskSave,
} from '../../services/tauri';
import { formatInTimezone, profilesForProject } from '../../utils/scheduledTaskFormat';
import { getAppSettings } from '../../utils/settings';
import type {
  ScheduledAgent,
  ScheduledTaskInput,
  ScheduledTaskOptions,
  ScheduledTaskView,
  TaskSchedule,
  TaskTarget,
} from '../../types/scheduledTask';

export type ScheduleMode = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom' | 'once';

/** 空状态示例按钮预填的轻量配置。 */
export interface ScheduledTaskPreset {
  name: string;
  targetKind: 'profile' | 'agent';
  prompt?: string;
  scheduleMode?: ScheduleMode;
  time?: string;
}

interface ScheduledTaskDialogProps {
  task: ScheduledTaskView | null;
  preset?: ScheduledTaskPreset;
  options: ScheduledTaskOptions;
  onClose: () => void;
  onSaved: (task: ScheduledTaskView, ranNow: boolean) => void;
}

const WEEKDAYS = [
  { value: 1, label: '周一', short: '一' },
  { value: 2, label: '周二', short: '二' },
  { value: 3, label: '周三', short: '三' },
  { value: 4, label: '周四', short: '四' },
  { value: 5, label: '周五', short: '五' },
  { value: 6, label: '周六', short: '六' },
  { value: 7, label: '周日', short: '日' },
];

const FALLBACK_TIMEZONES = [
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Hong_Kong', 'UTC',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'America/New_York',
  'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney',
];

const AUTO_CLOSE_OPTIONS = [
  { value: 0, label: '保持运行' },
  { value: 30, label: '30 分钟后关闭' },
  { value: 60, label: '1 小时后关闭' },
  { value: 120, label: '2 小时后关闭' },
];

const AGENT_LABELS: Record<ScheduledAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  antigravity: 'Antigravity CLI',
};

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

function timezoneOptions(current: string): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let supported: string[] = [];
  try {
    supported = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    supported = [];
  }
  const base = [browserTimezone(), ...FALLBACK_TIMEZONES, current].filter(Boolean);
  return Array.from(new Set([...base, ...supported])).sort((a, b) => a.localeCompare(b));
}

function splitTime(value: string): { hour: string; minute: string } {
  const [hour = '9', minute = '0'] = value.split(':');
  return { hour: hour.padStart(2, '0'), minute: minute.padStart(2, '0') };
}

function buildCron(
  mode: ScheduleMode,
  time: string,
  weekdays: number[],
  minute: number,
  custom: string,
): string | null {
  if (mode === 'custom') return custom.trim() || null;
  if (mode === 'hourly') return `${Math.max(0, Math.min(59, minute))} * * * *`;
  if (mode === 'once') return null;
  const { hour, minute: minuteValue } = splitTime(time);
  if (mode === 'daily') return `${Number(minuteValue)} ${Number(hour)} * * *`;
  if (mode === 'weekdays') return `${Number(minuteValue)} ${Number(hour)} * * 1-5`;
  if (weekdays.length === 0) return null;
  return `${Number(minuteValue)} ${Number(hour)} * * ${[...weekdays].sort((a, b) => a - b).join(',')}`;
}

function detectCronMode(expression: string): {
  mode: ScheduleMode;
  time: string;
  weekdays: number[];
  minute: number;
} {
  const fallback = { mode: 'custom' as ScheduleMode, time: '09:00', weekdays: [1, 2, 3, 4, 5], minute: 0 };
  const fields = expression.trim().split(/\s+/);
  if (fields.length === 6 && fields[0] === '0') fields.shift();
  if (fields.length !== 5) return fallback;
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*' || !/^\d+$/.test(minuteField)) return fallback;
  if (hourField === '*') return { ...fallback, mode: 'hourly', minute: Number(minuteField) };
  if (!/^\d+$/.test(hourField)) return fallback;
  const timeValue = `${hourField.padStart(2, '0')}:${minuteField.padStart(2, '0')}`;
  if (dayOfWeek === '*') return { ...fallback, mode: 'daily', time: timeValue };
  if (dayOfWeek === '1-5' || dayOfWeek === '1,2,3,4,5') {
    return { ...fallback, mode: 'weekdays', time: timeValue };
  }
  if (/^[0-7](,[0-7])*$/.test(dayOfWeek)) {
    const days = dayOfWeek.split(',').map(day => {
      const value = Number(day);
      return value === 0 ? 7 : value;
    });
    return { ...fallback, mode: 'weekly', time: timeValue, weekdays: days };
  }
  return fallback;
}

function defaultProvider(options: ScheduledTaskOptions, agent: Exclude<ScheduledAgent, 'antigravity'>) {
  const providers = options.catalog.providers.filter(provider => provider.agent === agent);
  const provider = providers.find(item => item.isDefault)
    ?? providers.find(item => item.id === `default:${agent}`)
    ?? providers[0];
  return { providerId: provider?.id ?? '', model: provider?.models[0]?.id ?? '' };
}

function initialTarget(task: ScheduledTaskView | null, preset: ScheduledTaskPreset | undefined, options: ScheduledTaskOptions) {
  const target = task?.target;
  const projectName = target?.projectName ?? options.projects[0]?.name ?? '';
  const targetKind: 'profile' | 'agent' = target?.kind === 'projectProfile'
    ? 'profile'
    : target?.kind === 'agentPrompt'
      ? 'agent'
      : (preset?.targetKind ?? 'agent');
  const project = options.projects.find(item => item.name === projectName);
  const enabled = projectEnabledAgents(project);
  const requestedAgent = target?.kind === 'agentPrompt' ? target.agent : '';
  const agent: ScheduledAgent = requestedAgent === 'codex'
    ? 'codex'
    : requestedAgent === 'claude'
      ? 'claude'
      : requestedAgent === 'antigravity'
        ? 'antigravity'
        : enabled.claude ? 'claude' : enabled.codex ? 'codex' : enabled.antigravity ? 'antigravity' : 'claude';
  const fallbackProvider = agent === 'antigravity'
    ? { providerId: '', model: '' }
    : defaultProvider(options, agent);
  // 已删除的供应商 / 停机模型回退到默认配置，避免下拉框显示与实际提交值不一致。
  // Antigravity 固定使用 Google 账号，不存在供应商 / 模型选择。
  const requestedProviderId = agent !== 'antigravity' && target?.kind === 'agentPrompt'
    ? target.providerId ?? null
    : null;
  const providerId = requestedProviderId
    && options.catalog.providers.some(provider => provider.id === requestedProviderId && provider.agent === agent)
    ? requestedProviderId
    : fallbackProvider.providerId;
  const chosenProvider = options.catalog.providers.find(provider => provider.id === providerId);
  const requestedModel = agent !== 'antigravity' && target?.kind === 'agentPrompt' ? target.model ?? '' : '';
  const model = requestedModel && chosenProvider?.models.some(option => option.id === requestedModel)
    ? requestedModel
    : (chosenProvider?.models[0]?.id ?? fallbackProvider.model);
  const profileId = target?.kind === 'projectProfile'
    ? target.profileId
    : profilesForProject(options.profiles, projectName)[0]?.id ?? '';
  return {
    projectName,
    targetKind,
    profileId,
    autoCloseMinutes: target?.kind === 'projectProfile' ? target.autoCloseMinutes : 0,
    agent,
    providerId,
    model,
    prompt: target?.kind === 'agentPrompt' ? target.prompt : (preset?.prompt ?? ''),
  };
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`st-switch${checked ? ' checked' : ''}`}
      onClick={() => onChange(!checked)}
    ><span /></button>
  );
}

function Section({ icon, title, description, bodyClassName, children }: {
  icon: ReactNode;
  title: string;
  description?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className="st-form-box">
      <div className="st-form-box-head">
        <div className="st-form-box-title">
          <span className="st-section-icon" aria-hidden="true">{icon}</span>
          <span>{title}</span>
        </div>
        {description && <span className="st-form-box-sub">{description}</span>}
      </div>
      <div className={bodyClassName ? `st-form-box-body ${bodyClassName}` : 'st-form-box-body'}>{children}</div>
    </section>
  );
}

export function ScheduledTaskDialog({ task, preset, options, onClose, onSaved }: ScheduledTaskDialogProps) {
  const showToast = useAppStore(state => state.showToast);
  const initial = useMemo(() => initialTarget(task, preset, options), [task, preset, options]);
  const [name, setName] = useState(task?.name ?? preset?.name ?? '');
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [notify, setNotify] = useState(task?.notify ?? true);
  const [projectName, setProjectName] = useState(initial.projectName);
  const [targetKind, setTargetKind] = useState<'profile' | 'agent'>(initial.targetKind);
  const [profileId, setProfileId] = useState(initial.profileId);
  const [autoCloseMinutes, setAutoCloseMinutes] = useState(initial.autoCloseMinutes);
  const [agent, setAgent] = useState<ScheduledAgent>(initial.agent);
  const [providerId, setProviderId] = useState(initial.providerId);
  const [model, setModel] = useState(initial.model);
  const [prompt, setPrompt] = useState(initial.prompt);
  // 超时是可选覆盖项：留空交给后端默认值（30 分钟）。
  const [timeoutMinutes, setTimeoutMinutes] = useState<number | null>(task?.timeoutMinutes ?? null);

  const cronMode = task?.schedule.kind === 'cron'
    ? detectCronMode(task.schedule.expression)
    : null;
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    preset?.scheduleMode ?? cronMode?.mode ?? (task?.schedule.kind === 'once' ? 'once' : 'daily'),
  );
  const [time, setTime] = useState(preset?.time ?? cronMode?.time ?? '09:00');
  const [weekdays, setWeekdays] = useState<number[]>(cronMode?.weekdays ?? [1, 2, 3, 4, 5]);
  const [minute, setMinute] = useState(cronMode?.minute ?? 0);
  const [cronExpression, setCronExpression] = useState(
    task?.schedule.kind === 'cron' ? task.schedule.expression : '0 9 * * *',
  );
  const [onceAt, setOnceAt] = useState(
    task?.schedule.kind === 'once' ? task.schedule.runAt.slice(0, 16) : '',
  );
  const [timezone, setTimezone] = useState(task?.timezone ?? browserTimezone());

  const [previewTimes, setPreviewTimes] = useState<number[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'save' | 'run' | null>(null);

  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);
  const project = options.projects.find(item => item.name === projectName);
  const enabledAgents = projectEnabledAgents(project);
  const agentChoices = (['claude', 'codex', 'antigravity'] as const).filter(item => enabledAgents[item]);
  const projectProfiles = profilesForProject(options.profiles, projectName);
  const providers = options.catalog.providers.filter(item => item.agent === agent);
  const provider = providers.find(item => item.id === providerId);
  const models = provider?.models ?? [];
  const cron = scheduleMode === 'once'
    ? null
    : buildCron(scheduleMode, time, weekdays, minute, cronExpression);

  useEffect(() => {
    if (scheduleMode === 'once' || !cron) {
      setPreviewTimes([]);
      setPreviewError(scheduleMode === 'weekly' && weekdays.length === 0 ? '请至少选择一个星期' : null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void scheduledTaskPreview(cron, timezone, 5)
        .then(times => {
          if (cancelled) return;
          setPreviewTimes(times);
          setPreviewError(null);
        })
        .catch(reason => {
          if (cancelled) return;
          setPreviewTimes([]);
          setPreviewError(reason instanceof Error ? reason.message : String(reason));
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cron, timezone, scheduleMode, weekdays.length]);

  const changeProject = (nextName: string) => {
    setProjectName(nextName);
    const firstProfile = profilesForProject(options.profiles, nextName)[0];
    setProfileId(firstProfile?.id ?? '');
    const nextProject = options.projects.find(item => item.name === nextName);
    const agents = projectEnabledAgents(nextProject);
    if (!agents[agent]) {
      const nextAgent: ScheduledAgent = agents.claude
        ? 'claude'
        : agents.codex ? 'codex' : agents.antigravity ? 'antigravity' : 'claude';
      setAgent(nextAgent);
      if (nextAgent === 'antigravity') {
        setProviderId('');
        setModel('');
      } else {
        const fallback = defaultProvider(options, nextAgent);
        setProviderId(fallback.providerId);
        setModel(fallback.model);
      }
    }
  };

  const changeAgent = (nextAgent: ScheduledAgent) => {
    setAgent(nextAgent);
    if (nextAgent === 'antigravity') {
      setProviderId('');
      setModel('');
      return;
    }
    const fallback = defaultProvider(options, nextAgent);
    setProviderId(fallback.providerId);
    setModel(fallback.model);
  };

  const changeProvider = (nextId: string) => {
    setProviderId(nextId);
    const nextProvider = options.catalog.providers.find(item => item.id === nextId);
    setModel(nextProvider?.models[0]?.id ?? '');
  };

  const toggleWeekday = (day: number) => {
    setWeekdays(previous => (
      previous.includes(day) ? previous.filter(value => value !== day) : [...previous, day]
    ));
  };

  const submit = async (runAfter: boolean) => {
    setSaveError(null);
    const trimmedName = name.trim();
    if (!trimmedName) { setSaveError('请填写任务名称'); return; }
    if (!projectName) { setSaveError('请选择项目'); return; }
    if (targetKind === 'profile' && !profileId) { setSaveError('请选择终端配置'); return; }
    if (targetKind === 'agent') {
      if (!prompt.trim()) { setSaveError('请填写任务描述'); return; }
      if (prompt.length > 8000) { setSaveError('任务描述不能超过 8000 个字符'); return; }
      if (timeoutMinutes !== null && (timeoutMinutes < 1 || timeoutMinutes > 240)) {
        setSaveError('超时需在 1–240 分钟之间，或留空使用默认值');
        return;
      }
    }
    if (scheduleMode === 'once' && !onceAt) { setSaveError('请选择执行时间'); return; }
    if (scheduleMode === 'weekly' && weekdays.length === 0) { setSaveError('请至少选择一个星期'); return; }
    if (!cron && scheduleMode !== 'once') { setSaveError('请填写有效的 Cron 表达式'); return; }
    if (previewError) { setSaveError(previewError); return; }

    const schedule: TaskSchedule = scheduleMode === 'once'
      ? { kind: 'once', runAt: onceAt }
      : { kind: 'cron', expression: cron! };
    const target: TaskTarget = targetKind === 'profile'
      ? { kind: 'projectProfile', projectName, profileId, autoCloseMinutes }
      : {
          kind: 'agentPrompt',
          projectName,
          agent,
          providerId: agent === 'antigravity' ? null : providerId || null,
          model: agent === 'antigravity' ? null : model || null,
          prompt: prompt.trim(),
        };
    const input: ScheduledTaskInput = {
      id: task?.id ?? null,
      name: trimmedName,
      enabled,
      timezone,
      schedule,
      target,
      notify,
      // 留空不传，后端按默认 30 分钟保存。
      timeoutMinutes: timeoutMinutes ?? undefined,
    };
    setSaving(runAfter ? 'run' : 'save');
    try {
      const saved = await scheduledTaskSave(input);
      let ranNow = false;
      if (runAfter) {
        try {
          await scheduledTaskRunNow(saved.id);
          ranNow = true;
        } catch (reason) {
          // 任务已经保存成功，只是立即运行失败：不把弹窗留在「保存失败」的错觉里。
          showToast(reason instanceof Error ? reason.message : String(reason), 'error');
        }
      }
      onSaved(saved, ranNow);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(null);
    }
  };

  // 调度表达式非法时就地报错并禁用保存，避免用户提交后才被后端拒绝。
  const scheduleBlocked = Boolean(previewError)
    || (scheduleMode === 'weekly' && weekdays.length === 0)
    || (scheduleMode === 'once' ? !onceAt : !cron);

  const previewBlock = scheduleMode !== 'once' && (
    <div className="st-preview-box">
      <div className="st-preview-title"><Activity aria-hidden="true" />未来 5 次预计触发时间</div>
      {previewError ? (
        <div className="st-preview-error"><AlertTriangle aria-hidden="true" />{previewError}</div>
      ) : previewTimes.length === 0 ? (
        <div className="st-preview-empty">正在计算…</div>
      ) : (
        <div className="st-preview-times">
          {previewTimes.map((value, index) => (
            <span key={`${value}-${index}`} className={index === 0 ? 'first' : undefined}>
              {formatInTimezone(value, timezone)}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  // 新会话形态决定 Agent 任务的执行方式：终端接力会真的开终端并自动输入任务描述。
  const nativeChatSessions = getAppSettings().nativeChatSessions;
  // 页脚给一条「下次执行」提示；仅一次任务按所选时间显示。
  const nextRunAt = scheduleMode === 'once'
    ? (onceAt ? new Date(onceAt).getTime() : null)
    : previewTimes[0] ?? null;
  const nextRunLabel = nextRunAt !== null && Number.isFinite(nextRunAt)
    ? formatInTimezone(nextRunAt, timezone)
    : null;

  return (
    <Dialog
      title={(
        <div className="st-dialog-title">
          <CalendarClock className="st-dialog-title-icon" aria-hidden="true" />
          <span>{task ? '编辑定时任务' : '新建定时任务'}</span>
          <small>保存后立即纳入调度</small>
        </div>
      )}
      onClose={onClose}
      className="st-dialog"
      closeDisabled={saving !== null}
      // 名称输入框自带 autoFocus；关闭 Dialog 的默认聚焦，避免焦点被关闭按钮抢走。
      autoFocus={false}
      footer={(
        <div className="st-dialog-footer">
          <span className="st-dialog-hint">
            <Info aria-hidden="true" />
            {nextRunLabel && <span className="st-dialog-next">下次 {nextRunLabel}</span>}
            <span className="st-dialog-hint-text">
              {targetKind === 'agent'
                ? (agent === 'antigravity'
                    ? 'Antigravity 固定使用终端接力：到点创建终端并自动输入任务描述，执行结束后终端保留。'
                    : nativeChatSessions
                      ? '当前将按「原生会话」模式启动；若需要确认，任务会停在等待确认。'
                      : '到点创建终端运行 Agent，任务描述会自动输入；执行结束后终端保留。')
                : '到点启动终端，不抢当前焦点。'}
            </span>
          </span>
          <div className="st-dialog-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving !== null}>取消</button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void submit(false)}
              disabled={saving !== null || scheduleBlocked}
            >
              {saving === 'save' ? <LoaderCircle className="st-spin" aria-hidden="true" /> : null}保存并关闭
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void submit(true)}
              disabled={saving !== null || scheduleBlocked}
            >
              {saving === 'run' ? <LoaderCircle className="st-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}保存并立即运行
            </button>
          </div>
        </div>
      )}
    >
      {saveError && (
        <div className="st-error-banner" role="alert"><AlertTriangle aria-hidden="true" />{saveError}</div>
      )}

      <Section icon={<PencilLine />} title="基础信息" description="命名与关联项目">
        <div className="st-field-row">
          <div className="st-field">
            <label className="st-field-label" htmlFor="st-task-name">
              <span className="st-label-text">任务名称<span className="st-required">*</span></span>
              <span className="st-char-count">{name.length} / 40</span>
            </label>
            <input
              id="st-task-name"
              className="st-input"
              value={name}
              maxLength={40}
              placeholder="例如：工作日晨间开发环境"
              onChange={event => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="st-field">
            <label className="st-field-label" htmlFor="st-project">
              <span className="st-label-text">所属项目<span className="st-required">*</span></span>
            </label>
            <select id="st-project" className="st-select" value={projectName} onChange={event => changeProject(event.target.value)}>
              {options.projects.length === 0 && <option value="">暂无已登记项目</option>}
              {options.projects.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
          </div>
        </div>
      </Section>

      <Section
        icon={<Bot />}
        title="执行目标"
        description="支持启动项目终端或自动派发 Agent"
      >
        <div className="st-target-cards" role="tablist" aria-label="任务类型">
          <button
            type="button"
            role="tab"
            aria-selected={targetKind === 'agent'}
            className={`st-target-card${targetKind === 'agent' ? ' active' : ''}`}
            onClick={() => setTargetKind('agent')}
          >
            <span className="st-target-card-ico" aria-hidden="true"><Bot /></span>
            <span className="st-target-card-text">
              <strong>AI Agent 任务</strong>
              <span>Claude / Codex 按「新会话形态」执行，Antigravity 固定终端接力</span>
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={targetKind === 'profile'}
            className={`st-target-card${targetKind === 'profile' ? ' active' : ''}`}
            onClick={() => setTargetKind('profile')}
          >
            <span className="st-target-card-ico" aria-hidden="true"><Terminal /></span>
            <span className="st-target-card-text">
              <strong>项目终端配置</strong>
              <span>到点自动打开所选 Profile 终端，可选定时自动关闭</span>
            </span>
          </button>
        </div>

        {targetKind === 'profile' ? (
          <div className="st-field-row">
            <div className="st-field">
              <label className="st-field-label" htmlFor="st-profile">
                <span className="st-label-text">终端配置 (Profile)<span className="st-required">*</span></span>
              </label>
              <select id="st-profile" className="st-select" value={profileId} onChange={event => setProfileId(event.target.value)}>
                {projectProfiles.length === 0 && <option value="">该项目下暂无配置</option>}
                {projectProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </div>
            <div className="st-field">
              <label className="st-field-label" htmlFor="st-auto-close">自动关闭终端</label>
              <select
                id="st-auto-close"
                className="st-select"
                value={autoCloseMinutes}
                onChange={event => setAutoCloseMinutes(Number(event.target.value))}
              >
                {AUTO_CLOSE_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <div className="st-field-hint">到点创建终端标签，且不会切走当前页面。</div>
            </div>
          </div>
        ) : (
          <>
            <div className="st-field-row st-agent-grid">
              <div className="st-field">
                <span className="st-field-label">选择助手</span>
                <div className="st-seg st-seg-block" role="group" aria-label="Agent">
                  {agentChoices.map(choice => (
                    <button
                      type="button"
                      key={choice}
                      className={`st-seg-btn${agent === choice ? ' active' : ''}`}
                      onClick={() => changeAgent(choice)}
                    >{AGENT_LABELS[choice]}</button>
                  ))}
                </div>
              </div>
              {agent === 'antigravity' ? (
                <div className="st-field st-field-grow">
                  <span className="st-field-label">账号</span>
                  <div className="st-field-hint">
                    Antigravity CLI 使用 Google 账号登录，按「Agent 管理」中的基础启动命令启动，无需选择供应商或模型。
                  </div>
                </div>
              ) : (
                <div className="st-field-row st-field-row-tight">
                  <div className="st-field">
                    <label className="st-field-label" htmlFor="st-provider">供应商</label>
                    <select id="st-provider" className="st-select" value={providerId} onChange={event => changeProvider(event.target.value)}>
                      {providers.length === 0 && <option value="">服务端默认配置</option>}
                      {providers.map(item => (
                        <option key={item.id} value={item.id}>
                          {item.name}{item.isDefault ? '（默认）' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="st-field">
                    <label className="st-field-label" htmlFor="st-model">模型</label>
                    <select id="st-model" className="st-select" value={model} onChange={event => setModel(event.target.value)}>
                      {models.length === 0 && <option value="">服务端默认模型</option>}
                      {models.map(item => (
                        <option key={item.id || 'default'} value={item.id}>{item.label || item.id || '服务端默认模型'}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
            <div className="st-field">
              <label className="st-field-label" htmlFor="st-prompt">
                <span className="st-label-text">任务描述（Prompt）<span className="st-required">*</span></span>
                <span className="st-char-count">{prompt.length} / 8000</span>
              </label>
              <textarea
                id="st-prompt"
                className="st-textarea"
                value={prompt}
                maxLength={8000}
                placeholder="例如：汇总今天本项目的 git 提交，按模块列出改动要点，不要修改任何文件。"
                onChange={event => setPrompt(event.target.value)}
              />
            </div>
          </>
        )}
      </Section>

      <Section icon={<CalendarClock />} title="触发计划与时区" description="支持标准 5 段 Cron 与单次定时">
        <div className="st-chips" role="tablist" aria-label="触发方式">
          {([
            ['daily', '每天'],
            ['weekdays', '工作日'],
            ['weekly', '按星期'],
            ['hourly', '每小时'],
            ['custom', '自定义 Cron'],
            ['once', '仅一次'],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={scheduleMode === mode}
              className={`st-chip${scheduleMode === mode ? ' active' : ''}`}
              onClick={() => setScheduleMode(mode)}
            >{label}</button>
          ))}
        </div>

        <div className="st-schedule-row">
          {scheduleMode === 'hourly' ? (
            <div className="st-field st-field-time">
              <label className="st-field-label" htmlFor="st-minute">每小时第</label>
              <div className="st-input-with-suffix">
                <input
                  id="st-minute"
                  className="st-input"
                  type="number"
                  min={0}
                  max={59}
                  value={minute}
                  onChange={event => setMinute(Number(event.target.value) || 0)}
                />
                <span className="st-input-suffix">分</span>
              </div>
            </div>
          ) : scheduleMode === 'custom' ? (
            <div className="st-field st-field-grow">
              <label className="st-field-label" htmlFor="st-cron">Cron 表达式</label>
              <input
                id="st-cron"
                className="st-input"
                value={cronExpression}
                placeholder="分 时 日 月 周，例如 0 9 * * 1-5"
                onChange={event => setCronExpression(event.target.value)}
                spellCheck={false}
              />
            </div>
          ) : scheduleMode === 'once' ? (
            <div className="st-field st-field-once">
              <label className="st-field-label" htmlFor="st-once">执行时间</label>
              <input
                id="st-once"
                className="st-input"
                type="datetime-local"
                value={onceAt}
                onChange={event => setOnceAt(event.target.value)}
              />
            </div>
          ) : (
            <div className="st-field st-field-time">
              <label className="st-field-label" htmlFor="st-time">触发时间</label>
              <input
                id="st-time"
                className="st-input"
                type="time"
                value={time}
                onChange={event => setTime(event.target.value || '09:00')}
              />
            </div>
          )}
          <div className="st-field st-field-tz">
            <label className="st-field-label" htmlFor="st-timezone">调度时区 (IANA)</label>
            <select id="st-timezone" className="st-select" value={timezone} onChange={event => setTimezone(event.target.value)}>
              {zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          </div>
        </div>

        {scheduleMode === 'weekly' && (
          <div className="st-weekdays">
            {WEEKDAYS.map(day => (
              <button
                key={day.value}
                type="button"
                className={`st-weekday${weekdays.includes(day.value) ? ' active' : ''}`}
                aria-pressed={weekdays.includes(day.value)}
                title={day.label}
                onClick={() => toggleWeekday(day.value)}
              >{day.short}</button>
            ))}
          </div>
        )}

        {scheduleMode === 'once'
          ? <div className="st-field-hint">按所选时区的本地时间执行一次；执行后任务自动停用。</div>
          : previewBlock}
      </Section>

      <Section icon={<Bell />} title="执行控制与通知" bodyClassName="compact">
        <div className="st-control-rows">
          <div className="st-switch-row">
            <div>
              <div className="st-switch-title">启用该任务</div>
              <div className="st-switch-desc">暂停后不再按计划触发，仍可手动「立即运行」。</div>
            </div>
            <Switch checked={enabled} onChange={setEnabled} label="启用任务" />
          </div>
          <div className="st-switch-row">
            <div>
              <div className="st-switch-title">执行完成或失败时发送通知</div>
              <div className="st-switch-desc">完成、失败或等待确认时推送到 App 与系统通知。</div>
            </div>
            <Switch checked={notify} onChange={setNotify} label="运行通知" />
          </div>
          {targetKind === 'agent' && (
            <div className="st-switch-row">
              <div>
                <div className="st-switch-title">
                  单次执行超时
                  <span className="st-optional">可选</span>
                </div>
                <div className="st-switch-desc">覆盖默认 30 分钟限制（1–240 分钟），超时会自动停止并记为超时。</div>
              </div>
              <div className="st-input-with-suffix st-input-narrow">
                <input
                  id="st-timeout"
                  className="st-input"
                  type="number"
                  min={1}
                  max={240}
                  inputMode="numeric"
                  placeholder="30"
                  aria-label="单次执行超时（分钟）"
                  value={timeoutMinutes ?? ''}
                  onChange={event => {
                    const raw = event.target.value.trim();
                    if (!raw) { setTimeoutMinutes(null); return; }
                    const value = Number(raw);
                    setTimeoutMinutes(Number.isFinite(value) ? value : null);
                  }}
                />
                <span className="st-input-suffix">分钟</span>
              </div>
            </div>
          )}
        </div>
      </Section>
    </Dialog>
  );
}
