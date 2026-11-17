import { invoke } from '@tauri-apps/api/core';
import type {
  ScheduledRun,
  ScheduledTaskInput,
  ScheduledTaskOptions,
  ScheduledTaskView,
} from '../../types/scheduledTask';

export const scheduledTaskList = () => invoke<ScheduledTaskView[]>('scheduled_task_list');

export const scheduledTaskSave = (input: ScheduledTaskInput) =>
  invoke<ScheduledTaskView>('scheduled_task_save', { input });

export const scheduledTaskDelete = (id: string) => invoke<void>('scheduled_task_delete', { id });

export const scheduledTaskSetEnabled = (id: string, enabled: boolean) =>
  invoke<ScheduledTaskView>('scheduled_task_set_enabled', { id, enabled });

/** 只创建运行记录并异步派发，立即返回。 */
export const scheduledTaskRunNow = (id: string) =>
  invoke<ScheduledRun>('scheduled_task_run_now', { id });

export const scheduledTaskStop = (id: string) => invoke<void>('scheduled_task_stop', { id });

export const scheduledTaskRuns = (id: string, limit?: number) =>
  invoke<ScheduledRun[]>('scheduled_task_runs', { id, limit: limit ?? null });

export const scheduledTaskOptions = () => invoke<ScheduledTaskOptions>('scheduled_task_options');

/** 未来 N 次执行的 UTC 毫秒时间戳；非法表达式时抛出中文原因。 */
export const scheduledTaskPreview = (expression: string, timezone: string, count = 5) =>
  invoke<number[]>('scheduled_task_preview', { expression, timezone, count });
