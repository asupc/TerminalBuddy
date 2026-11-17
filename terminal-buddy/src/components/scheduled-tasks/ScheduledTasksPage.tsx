import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  Clock3,
  Folder,
  History,
  Info,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { ConfirmDialog } from '../shared/Dialog';
import { useAppStore } from '../../stores/appStore';
import {
  listenTauri,
  scheduledTaskDelete,
  scheduledTaskList,
  scheduledTaskOptions,
  scheduledTaskRunNow,
  scheduledTaskSetEnabled,
} from '../../services/tauri';
import {
  describeTarget,
  formatDuration,
  formatNextRun,
  formatRunStatus,
  formatRunTime,
  formatSchedule,
  targetKindLabel,
  taskProjectName,
} from '../../utils/scheduledTaskFormat';
import {
  SCHEDULED_TASK_RUN_EVENT,
  SCHEDULED_TASKS_CHANGED_EVENT,
  isRunActive,
  type ScheduledTaskOptions,
  type ScheduledTaskView,
} from '../../types/scheduledTask';
import { ScheduledTaskDialog, type ScheduledTaskPreset } from './ScheduledTaskDialog';
import { ScheduledTaskRunsDialog } from './ScheduledTaskRunsDialog';
import './ScheduledTasksPage.css';

interface ScheduledTasksPageProps {
  onClose: () => void;
}

interface DialogState {
  task: ScheduledTaskView | null;
  preset?: ScheduledTaskPreset;
}

const SAMPLE_AGENT_PROMPT = '汇总今天本项目的 git 提交，按模块列出改动要点，不要修改任何文件。';

function isToday(ms: number): boolean {
  return new Date(ms).toDateString() === new Date().toDateString();
}

const EMPTY_OPTIONS: ScheduledTaskOptions = {
  projects: [],
  profiles: [],
  catalog: { providers: [] },
};

export function ScheduledTasksPage({ onClose }: ScheduledTasksPageProps) {
  const showToast = useAppStore(state => state.showToast);
  const [tasks, setTasks] = useState<ScheduledTaskView[]>([]);
  const [options, setOptions] = useState<ScheduledTaskOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [runsTask, setRunsTask] = useState<ScheduledTaskView | null>(null);
  const [deleteTask, setDeleteTask] = useState<ScheduledTaskView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);

  const loadTasks = useCallback(async () => {
    try {
      const list = await scheduledTaskList();
      setTasks(list);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOptions = useCallback(async () => {
    try {
      setOptions(await scheduledTaskOptions());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    void loadOptions();
    // 与后端 30 秒调度 tick 对齐；事件到达时立即刷新。
    const timer = window.setInterval(() => { void loadTasks(); }, 30_000);
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const subscribe = (event: string) => {
      void listenTauri(event, () => { void loadTasks(); }).then(unlisten => {
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      });
    };
    subscribe(SCHEDULED_TASK_RUN_EVENT);
    subscribe(SCHEDULED_TASKS_CHANGED_EVENT);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unlisteners.forEach(unlisten => unlisten());
    };
  }, [loadTasks]);

  // 状态栏入口打开页面后把焦点交给页面，键盘用户可以直接 Tab 到任务操作。
  useEffect(() => {
    const frame = requestAnimationFrame(() => pageRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const enabledCount = tasks.filter(task => task.enabled).length;
  // runningRunId 来自后端内存中的活动表；lastRun 里的 running 可能是重启前的历史快照。
  const runningCount = tasks.filter(task => Boolean(task.runningRunId)).length;
  const todayCount = tasks.filter(task => task.lastRun && isToday(task.lastRun.startedAt)).length;
  const nextRunAt = useMemo(() => tasks
    .filter(task => task.enabled && task.nextRunAt)
    .reduce<number | null>((earliest, task) => {
      if (!task.nextRunAt) return earliest;
      return earliest === null ? task.nextRunAt : Math.min(earliest, task.nextRunAt);
    }, null), [tasks]);

  const activeRunsTask = runsTask
    ? tasks.find(task => task.id === runsTask.id) ?? runsTask
    : null;

  const toggleAll = async () => {
    const target = enabledCount > 0 ? false : true;
    const affected = tasks.filter(task => task.enabled !== target);
    if (affected.length === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(affected.map(task => scheduledTaskSetEnabled(task.id, target)));
      showToast(`已${target ? '启用' : '暂停'} ${affected.length} 个任务`, 'success');
      await loadTasks();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const toggleTask = async (task: ScheduledTaskView) => {
    setBusyId(task.id);
    try {
      const updated = await scheduledTaskSetEnabled(task.id, !task.enabled);
      setTasks(previous => previous.map(item => item.id === updated.id ? updated : item));
      showToast(updated.enabled ? '任务已启用' : '任务已暂停', 'success');
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const runTask = async (task: ScheduledTaskView) => {
    setBusyId(task.id);
    try {
      const run = await scheduledTaskRunNow(task.id);
      if (run.status === 'skipped') {
        showToast(run.message ?? '本次已跳过', 'info');
      } else {
        showToast('任务已开始运行', 'success');
      }
      await loadTasks();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    const task = deleteTask;
    if (!task) return;
    setDeleteTask(null);
    setBusyId(task.id);
    try {
      await scheduledTaskDelete(task.id);
      showToast('任务已删除', 'success');
      await loadTasks();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const openEditor = async (state: DialogState) => {
    // 打开编辑器前刷新项目 / 配置 / 供应商目录，避免使用页面挂载时的旧快照。
    // 首次打开时等目录就绪，否则空下拉无法在弹窗内自动恢复。
    if (!options) await loadOptions();
    else void loadOptions();
    setDialog(state);
  };

  const handleSaved = (_saved: ScheduledTaskView, ranNow: boolean) => {
    setDialog(null);
    showToast(ranNow ? '任务已保存并开始运行' : '任务已保存', 'success');
    void loadTasks();
  };

  const renderTask = (task: ScheduledTaskView) => {
    const lastRun = task.lastRun;
    const running = Boolean(task.runningRunId);
    const failed = lastRun?.status === 'failed' || lastRun?.status === 'timeout';
    const lastStatus = lastRun ? formatRunStatus(lastRun.status) : null;
    const busy = busyId === task.id;
    return (
      <div
        key={task.id}
        className={`st-task-card${running ? ' is-running' : ''}${failed ? ' is-failed' : ''}${task.enabled ? '' : ' is-off'}`}
      >
        <span className="st-task-rail" aria-hidden="true" />
        <div className="st-task-main">
          <div className="st-task-top">
            <div className="st-task-title-row">
              <span className="st-task-name" title={task.name}>{task.name}</span>
              <span className={`st-badge ${task.target.kind === 'agentPrompt' ? 'agent' : 'project'}`}>
                {task.target.kind === 'agentPrompt'
                  ? <Bot aria-hidden="true" />
                  : <Folder aria-hidden="true" />}
                {targetKindLabel(task)}
              </span>
              {!task.enabled && <span className="st-badge off">已暂停</span>}
              {running && (
                <span className="st-status-pill running">
                  <span className="st-pulse" aria-hidden="true" />
                  {lastRun?.status === 'waitingApproval' ? '等待确认' : '运行中'}
                </span>
              )}
            </div>
            <div className="st-task-controls">
              <button
                type="button"
                role="switch"
                aria-checked={task.enabled}
                aria-label={task.enabled ? `暂停任务 ${task.name}` : `启用任务 ${task.name}`}
                title={task.enabled ? '暂停任务' : '启用任务'}
                className={`st-switch${task.enabled ? ' checked' : ''}`}
                disabled={busy}
                onClick={() => void toggleTask(task)}
              ><span /></button>
              <div className="st-task-actions">
                <button
                  type="button"
                  className="st-icon-btn"
                  title="立即运行"
                  aria-label={`立即运行 ${task.name}`}
                  disabled={busy || running}
                  onClick={() => void runTask(task)}
                >
                  {busy ? <LoaderCircle className="st-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="st-icon-btn"
                  title="编辑"
                  aria-label={`编辑 ${task.name}`}
                  disabled={busy}
                  onClick={() => void openEditor({ task })}
                ><Pencil aria-hidden="true" /></button>
                <button
                  type="button"
                  className="st-icon-btn"
                  title="运行记录"
                  aria-label={`查看 ${task.name} 的运行记录`}
                  onClick={() => setRunsTask(task)}
                ><History aria-hidden="true" /></button>
                <button
                  type="button"
                  className="st-icon-btn danger"
                  title="删除"
                  aria-label={`删除 ${task.name}`}
                  disabled={busy}
                  onClick={() => setDeleteTask(task)}
                ><Trash2 aria-hidden="true" /></button>
              </div>
            </div>
          </div>

          <div className="st-task-meta">
            <span className="st-meta-item"><Folder aria-hidden="true" />{taskProjectName(task)}</span>
            <span className="st-meta-dot" aria-hidden="true" />
            <span className="st-meta-item" title={describeTarget(task, options?.profiles, options?.catalog)}>
              {describeTarget(task, options?.profiles, options?.catalog)}
            </span>
          </div>

          <div className="st-task-schedule">
            <span className="st-schedule-main"><Clock3 aria-hidden="true" />{formatSchedule(task)}</span>
            <span className="st-tz">{task.timezone}</span>
            <span className={`st-next-run${task.enabled && task.nextRunAt ? '' : ' is-muted'}`}>
              {running
                ? '正在执行'
                : task.enabled && task.nextRunAt
                  ? <>下次 <b>{formatNextRun(task.nextRunAt)}</b></>
                  : '已暂停'}
            </span>
          </div>

          {lastRun && lastStatus && (
            <div className="st-task-last">
              <span className={`st-status-pill ${lastStatus.tone}`}>
                {isRunActive(lastRun) ? <span className="st-pulse" aria-hidden="true" /> : null}
                {lastStatus.label}
              </span>
              <span className="st-last-text" title={lastRun.message ?? undefined}>
                {lastRun.message || '—'}
              </span>
              <span className="st-last-time">
                {formatRunTime(lastRun.startedAt)}
                {lastRun.finishedAt ? ` · ${formatDuration(lastRun.finishedAt - lastRun.startedAt)}` : ''}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="scheduled-tasks-page" ref={pageRef} tabIndex={-1} aria-label="定时任务">
      <header className="st-page-header">
        <div>
          <h1><CalendarClock aria-hidden="true" />定时任务</h1>
          <p>按计划自动启动项目环境，或让 Agent 执行一段任务描述。</p>
        </div>
        <div className="st-page-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={bulkBusy || tasks.length === 0}
            onClick={() => void toggleAll()}
          >
            {bulkBusy
              ? <LoaderCircle className="st-spin" aria-hidden="true" />
              : enabledCount > 0 ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {enabledCount > 0 ? '全部暂停' : '全部启用'}
          </button>
          <button type="button" className="btn-primary" onClick={() => void openEditor({ task: null })}>
            <Plus aria-hidden="true" />新建任务
          </button>
          <button type="button" className="st-icon-btn st-close-page" title="关闭定时任务页面" aria-label="关闭定时任务页面" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="st-scroll">
        <div className="st-notice">
          <Info aria-hidden="true" />
          <span>
            定时任务随 TerminalBuddy 进程运行：桌面端退出后停止，需要 7×24 执行请使用
            <strong> Docker 服务端</strong>。调度按任务自身时区计算，不受容器 UTC 影响。
          </span>
        </div>

        {error && (
          <div className="st-error-banner" role="alert">
            <AlertTriangle aria-hidden="true" />{error}
          </div>
        )}

        <div className="st-summary-strip">
          <span>启用 <b>{enabledCount}</b></span>
          <span className="st-summary-divider" aria-hidden="true" />
          <span>运行中 <b>{runningCount}</b></span>
          <span className="st-summary-divider" aria-hidden="true" />
          <span>今日执行 <b>{todayCount}</b></span>
          <span className="st-summary-divider" aria-hidden="true" />
          <span className="st-summary-next">下次触发 <b>{nextRunAt ? formatNextRun(nextRunAt) : '—'}</b></span>
        </div>

        {loading ? (
          <div className="st-page-loading"><LoaderCircle className="st-spin" aria-hidden="true" />正在加载定时任务…</div>
        ) : tasks.length === 0 ? (
          <div className="st-empty-state">
            <div className="st-empty-illustration"><CalendarClock aria-hidden="true" /></div>
            <h4>还没有定时任务</h4>
            <p>创建一个任务，让终端环境或 Agent 按计划自动工作。任务只在 TerminalBuddy 运行时执行。</p>
            <div className="st-empty-samples">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void openEditor({
                  task: null,
                  preset: { name: '晨间开发环境', targetKind: 'profile', scheduleMode: 'daily', time: '09:30' },
                })}
              >每天 09:30 启动开发环境</button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void openEditor({
                  task: null,
                  preset: {
                    name: '每日提交汇总',
                    targetKind: 'agent',
                    scheduleMode: 'weekdays',
                    time: '18:00',
                    prompt: SAMPLE_AGENT_PROMPT,
                  },
                })}
              >工作日 18:00 用 Agent 汇总提交</button>
            </div>
          </div>
        ) : (
          <div className="st-task-list">{tasks.map(renderTask)}</div>
        )}
      </div>

      {dialog && (
        <ScheduledTaskDialog
          task={dialog.task}
          preset={dialog.preset}
          options={options ?? EMPTY_OPTIONS}
          onClose={() => setDialog(null)}
          onSaved={handleSaved}
        />
      )}

      {activeRunsTask && (
        <ScheduledTaskRunsDialog
          task={activeRunsTask}
          onClose={() => setRunsTask(null)}
          onChanged={() => { void loadTasks(); }}
        />
      )}

      {deleteTask && (
        <ConfirmDialog
          title="删除定时任务"
          message={`确定删除「${deleteTask.name}」吗？运行记录也会一并删除。`}
          confirmText="删除"
          onClose={() => setDeleteTask(null)}
          onConfirm={() => { void confirmDelete(); }}
        />
      )}
    </div>
  );
}
