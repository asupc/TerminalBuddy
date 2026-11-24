import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UnlistenFn } from './../../services/remoteWorkspace/events';
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  Check,
  Clock3,
  Folder,
  History,
  Info,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Terminal,
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

type TaskFilter = 'all' | 'enabled' | 'running' | 'failed' | 'paused';

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
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [search, setSearch] = useState('');
  const pageRef = useRef<HTMLDivElement>(null);
  const loadSeqRef = useRef(0);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      loadSeqRef.current += 1;
    };
  }, []);

  const loadTasks = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      const list = await scheduledTaskList();
      if (unmountedRef.current || seq !== loadSeqRef.current) return;
      setTasks(list);
      setError(null);
    } catch (reason) {
      if (unmountedRef.current || seq !== loadSeqRef.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!unmountedRef.current && seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const loadOptions = useCallback(async () => {
    try {
      const next = await scheduledTaskOptions();
      if (!unmountedRef.current) setOptions(next);
    } catch (reason) {
      if (!unmountedRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    void loadOptions();
    // 与后端 30 秒调度 tick 对齐；页面隐藏时跳过轮询，事件到达时立即刷新。
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadTasks();
    }, 30_000);
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
  }, [loadOptions, loadTasks]);

  // 状态栏入口打开页面后把焦点交给页面，键盘用户可以直接 Tab 到任务操作。
  useEffect(() => {
    const frame = requestAnimationFrame(() => pageRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const enabledCount = tasks.filter(task => task.enabled).length;
  // runningRunId 来自后端内存中的活动表；lastRun 里的 running 可能是重启前的历史快照。
  const runningCount = tasks.filter(task => Boolean(task.runningRunId)).length;
  const waitingApprovalCount = tasks.filter(
    task => Boolean(task.runningRunId) && task.lastRun?.status === 'waitingApproval',
  ).length;
  const failedCount = tasks.filter(
    task => !task.runningRunId
      && (task.lastRun?.status === 'failed' || task.lastRun?.status === 'timeout'),
  ).length;
  const pausedCount = tasks.length - enabledCount;
  const todayCount = tasks.filter(task => task.lastRun && isToday(task.lastRun.startedAt)).length;
  const nextRunAt = useMemo(() => tasks
    .filter(task => task.enabled && task.nextRunAt)
    .reduce<number | null>((earliest, task) => {
      if (!task.nextRunAt) return earliest;
      return earliest === null ? task.nextRunAt : Math.min(earliest, task.nextRunAt);
    }, null), [tasks]);

  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tasks.filter(task => {
      const running = Boolean(task.runningRunId);
      const failed = !running && (task.lastRun?.status === 'failed' || task.lastRun?.status === 'timeout');
      if (filter === 'enabled' && !task.enabled) return false;
      if (filter === 'running' && !running) return false;
      if (filter === 'failed' && !failed) return false;
      if (filter === 'paused' && task.enabled) return false;
      if (!query) return true;
      const haystack = [
        task.name,
        taskProjectName(task),
        describeTarget(task, options?.profiles, options?.catalog),
        formatSchedule(task),
        task.timezone,
        task.lastRun?.message ?? '',
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [tasks, filter, search, options]);

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
    const waitingApproval = running && lastRun?.status === 'waitingApproval';
    const failed = !running && (lastRun?.status === 'failed' || lastRun?.status === 'timeout');
    const lastStatus = lastRun ? formatRunStatus(lastRun.status) : null;
    const busy = busyId === task.id;
    const isAgent = task.target.kind === 'agentPrompt';
    const targetSummary = describeTarget(task, options?.profiles, options?.catalog);
    return (
      <article
        key={task.id}
        className={`st-task-card${waitingApproval ? ' is-attention' : running ? ' is-running' : ''}${failed ? ' is-failed' : ''}${task.enabled ? '' : ' is-off'}`}
      >
        <span className="st-task-rail" aria-hidden="true" />
        <div className="st-task-main">
          <div className="st-task-top">
            <div className="st-task-identity">
              <div className={`st-type-avatar${isAgent ? '' : ' profile'}`} aria-hidden="true">
                {isAgent ? <Bot /> : <Terminal />}
              </div>
              <div className="st-task-title-row">
                <span className="st-task-name" title={task.name}>{task.name}</span>
                <span className={`st-badge ${isAgent ? 'agent' : 'project'}`}>
                  {targetKindLabel(task)}
                </span>
                {!task.enabled && <span className="st-badge off">已暂停</span>}
                {running && (
                  <span className={`st-status-pill ${waitingApproval ? 'warn' : 'running'}`}>
                    <span className="st-pulse" aria-hidden="true" />
                    {waitingApproval ? '等待确认' : '运行中'}
                  </span>
                )}
              </div>
            </div>
            <div className="st-task-controls">
              <div className="st-task-actions">
                <button
                  type="button"
                  className="st-icon-btn"
                  title={running ? '运行中' : '立即运行'}
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
                  className="st-icon-btn st-icon-btn-labeled"
                  title="运行记录"
                  aria-label={`查看 ${task.name} 的运行记录`}
                  onClick={() => setRunsTask(task)}
                ><History aria-hidden="true" /><span>记录</span></button>
                <button
                  type="button"
                  className="st-icon-btn danger"
                  title="删除"
                  aria-label={`删除 ${task.name}`}
                  disabled={busy}
                  onClick={() => setDeleteTask(task)}
                ><Trash2 aria-hidden="true" /></button>
              </div>
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
            </div>
          </div>

          <div className="st-task-meta-row">
            <div className="st-task-meta">
              <span className="st-meta-chip"><Folder aria-hidden="true" />{taskProjectName(task)}</span>
              <span className="st-meta-chip" title={targetSummary}>
                <span className="st-meta-chip-text">{targetSummary}</span>
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
          </div>

          {lastRun && lastStatus && (
            <div className="st-task-last">
              <div className="st-task-last-left">
                <span className={`st-status-pill ${lastStatus.tone}`}>
                  {isRunActive(lastRun) ? <span className="st-pulse" aria-hidden="true" /> : null}
                  {lastStatus.label}
                </span>
                <span
                  className={`st-last-text${lastRun.status === 'failed' || lastRun.status === 'timeout' ? ' fail' : ''}`}
                  title={lastRun.message ?? undefined}
                >
                  {lastRun.message || '—'}
                </span>
              </div>
              <div className="st-task-last-right">
                <span className="st-last-time">
                  {formatRunTime(lastRun.startedAt)}
                  {lastRun.finishedAt ? ` · ${formatDuration(lastRun.finishedAt - lastRun.startedAt)}` : ''}
                </span>
                <button
                  type="button"
                  className="st-link-btn"
                  onClick={() => setRunsTask(task)}
                >
                  {running ? '查看运行详情 →' : failed ? '查看错误' : '运行记录'}
                </button>
              </div>
            </div>
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="scheduled-tasks-page" ref={pageRef} tabIndex={-1} aria-label="定时任务">
      <header className="st-page-header">
        <div className="st-header-left">
          <div className="st-header-icon" aria-hidden="true">
            <CalendarClock />
          </div>
          <div className="st-header-text">
            <h1>
              定时任务
              <span className={`st-scheduler-pill${error ? ' error' : ''}`}>
                <i aria-hidden="true" />
                {error ? '状态异常' : '调度器运行中'}
              </span>
            </h1>
            <p>按计划自动启动项目终端环境，或派发 Claude / Codex 执行自动化任务。</p>
          </div>
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
          <div className="st-notice-left">
            <Info aria-hidden="true" />
            <span>
              任务随 TerminalBuddy 进程运行：桌面端退出后停止；需要 7×24 执行请部署
              <strong> Docker 服务端</strong>。调度按任务自身时区计算。
            </span>
          </div>
          <span className="st-notice-meta">Tick 周期 30s</span>
        </div>

        {error && (
          <div className="st-error-banner" role="alert">
            <AlertTriangle aria-hidden="true" />{error}
          </div>
        )}

        <div className="st-kpi-grid">
          <div className="st-kpi-card success">
            <div className="st-kpi-meta">
              <div className="st-kpi-label">已启用任务</div>
              <div className="st-kpi-value">
                {enabledCount}
                <small> / {tasks.length}</small>
              </div>
            </div>
            <div className="st-kpi-icon" aria-hidden="true"><Check /></div>
          </div>
          <div className="st-kpi-card running">
            <div className="st-kpi-meta">
              <div className="st-kpi-label">当前活动</div>
              <div className="st-kpi-value">
                {runningCount}
                {waitingApprovalCount > 0 && <small> ({waitingApprovalCount} 待确认)</small>}
              </div>
            </div>
            <div className="st-kpi-icon" aria-hidden="true"><Play /></div>
          </div>
          <div className="st-kpi-card">
            <div className="st-kpi-meta">
              <div className="st-kpi-label">今日已执行</div>
              <div className="st-kpi-value">{todayCount}</div>
            </div>
            <div className="st-kpi-icon" aria-hidden="true"><History /></div>
          </div>
          <div className="st-kpi-card">
            <div className="st-kpi-meta">
              <div className="st-kpi-label">最近下次触发</div>
              <div className={`st-kpi-value${nextRunAt ? ' accent' : ' muted'}`}>
                {nextRunAt ? formatNextRun(nextRunAt) : '暂无计划'}
              </div>
            </div>
            <div className="st-kpi-icon" aria-hidden="true"><Clock3 /></div>
          </div>
        </div>

        {loading ? (
          <div className="st-page-loading"><LoaderCircle className="st-spin" aria-hidden="true" />正在加载定时任务…</div>
        ) : tasks.length === 0 ? (
          <div className="st-empty-state">
            <div className="st-empty-illustration"><CalendarClock aria-hidden="true" /></div>
            <h4>还没有定时任务</h4>
            <p>创建一个定时计划，让终端环境在上班前自启，或让 Claude / Codex / Antigravity 定时为你巡检代码。</p>
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
                className="btn-primary"
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
          <>
            <div className="st-filter-bar">
              <div className="st-filter-chips" role="tablist" aria-label="按任务状态筛选">
                {(
                  [
                    ['all', '全部', tasks.length],
                    ['enabled', '已启用', enabledCount],
                    ['running', '运行中', runningCount],
                    ['failed', '最近异常', failedCount],
                    ['paused', '已暂停', pausedCount],
                  ] as const
                ).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={filter === key}
                    className={`st-filter-chip${filter === key ? ' active' : ''}`}
                    onClick={() => setFilter(key)}
                  >
                    {label}
                    <span>{count}</span>
                  </button>
                ))}
              </div>
              <div className="st-search-box">
                <Search aria-hidden="true" />
                <input
                  type="text"
                  className="tb-input"
                  value={search}
                  placeholder="搜索任务名 / 项目 / 模型…"
                  aria-label="搜索定时任务"
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            </div>

            {filteredTasks.length === 0 ? (
              <div className="st-filter-empty">
                <p>没有匹配当前筛选条件的定时任务。</p>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => { setFilter('all'); setSearch(''); }}
                >
                  清除筛选条件
                </button>
              </div>
            ) : (
              <div className="st-task-list">{filteredTasks.map(renderTask)}</div>
            )}
          </>
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
