import { memo } from 'react';
import { CalendarClock } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useScheduledTasksStatus } from '../../hooks/useScheduledTasksStatus';
import { formatNextRun } from '../../utils/scheduledTaskFormat';
import './ScheduledTasksStatusEntry.css';

/**
 * 底部状态栏「定时」入口：显示启用数量 / 下次运行 / 运行中状态。
 * 点击直接打开定时任务独立工作区页面，不弹浮层；运行、停止等操作全部在页面内完成。
 */
export const ScheduledTasksStatusEntry = memo(function ScheduledTasksStatusEntry() {
  const { tasks, error } = useScheduledTasksStatus(true);
  const openScheduledTasksPage = useAppStore(state => state.openScheduledTasksPage);
  const active = useAppStore(state => state.activeSpecialTab === 'scheduled-tasks');

  const enabledTasks = tasks.filter(task => task.enabled);
  const runningCount = tasks.filter(task => Boolean(task.runningRunId)).length;
  const approvalCount = tasks.filter(
    task => task.runningRunId && task.lastRun?.status === 'waitingApproval',
  ).length;
  const failureCount = tasks.filter(
    task => !task.runningRunId
      && (task.lastRun?.status === 'failed' || task.lastRun?.status === 'timeout'),
  ).length;
  const nextRunAt = enabledTasks.reduce<number | null>((earliest, task) => {
    if (!task.nextRunAt) return earliest;
    return earliest === null ? task.nextRunAt : Math.min(earliest, task.nextRunAt);
  }, null);

  const details = [`定时任务`, `${enabledTasks.length} 个启用`];
  if (runningCount > 0) details.push(`${runningCount} 个运行中`);
  if (approvalCount > 0) details.push(`${approvalCount} 个任务等待确认`);
  if (failureCount > 0) details.push(`${failureCount} 个任务最近执行失败`);
  if (nextRunAt) details.push(`下次${formatNextRun(nextRunAt)}`);
  details.push('点击打开管理');
  if (error) details.push('状态暂不可用');
  const title = details.join(' · ');

  return (
    <button
      type="button"
      className={`app-statusbar-item app-statusbar-clickable scheduled-status-entry${active ? ' active' : ''}${tasks.length === 0 ? ' is-empty' : ''}`}
      title={title}
      aria-label="打开定时任务管理"
      aria-current={active ? 'page' : undefined}
      onClick={openScheduledTasksPage}
    >
      <CalendarClock className="app-statusbar-icon" aria-hidden="true" />
      {runningCount > 0 ? (
        <span className="app-statusbar-dot scheduled-status-dot running" aria-hidden="true" />
      ) : approvalCount > 0 ? (
        <span className="app-statusbar-dot scheduled-status-dot approval" aria-hidden="true" />
      ) : failureCount > 0 ? (
        <span className="app-statusbar-dot scheduled-status-dot failed" aria-hidden="true" />
      ) : null}
      <span className="app-statusbar-label scheduled-status-label">定时</span>
      {enabledTasks.length > 0 && (
        <span className="app-statusbar-badge scheduled-status-count">{enabledTasks.length}</span>
      )}
      {runningCount > 0 ? (
        <span className="app-statusbar-mono scheduled-status-next">运行中</span>
      ) : nextRunAt ? (
        <span className="app-statusbar-mono scheduled-status-next">{formatNextRun(nextRunAt)}</span>
      ) : null}
    </button>
  );
});
