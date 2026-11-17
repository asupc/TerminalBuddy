import type { Profile, Project } from './index';
import type { AiCatalog } from '../services/tauri/aiChat';

/** 运行记录状态；与后端 `ScheduledRun.status` 保持一致。 */
export type ScheduledRunStatus =
  | 'running'
  | 'waitingApproval'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'stopped'
  | 'started'
  | 'skipped';

export type ScheduledRunTone = 'success' | 'danger' | 'running' | 'warn' | 'idle';

export type TaskSchedule =
  | { kind: 'cron'; expression: string }
  /** 任务时区下的本地墙钟时间："2026-11-20T09:00" */
  | { kind: 'once'; runAt: string };

export type TaskTarget =
  | {
      kind: 'projectProfile';
      projectName: string;
      profileId: string;
      autoCloseMinutes: number;
    }
  | {
      kind: 'agentPrompt';
      projectName: string;
      agent: 'claude' | 'codex' | string;
      providerId?: string | null;
      model?: string | null;
      prompt: string;
    };

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  timezone: string;
  schedule: TaskSchedule;
  target: TaskTarget;
  notify: boolean;
  timeoutMinutes: number;
  createdAt: number;
  updatedAt: number;
  lastScheduledAt: number | null;
  lastRunAt: number | null;
}

export interface ScheduledTaskView extends ScheduledTask {
  nextRunAt: number | null;
  runningRunId: string | null;
  lastRun: ScheduledRun | null;
}

export interface ScheduledRun {
  id: string;
  taskId: string;
  taskName: string;
  /** scheduled | manual */
  trigger: string;
  status: ScheduledRunStatus;
  startedAt: number;
  finishedAt: number | null;
  message: string | null;
  terminalId: string | null;
  sessionId: string | null;
  agent: string | null;
  providerName: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ScheduledTaskInput {
  id?: string | null;
  name: string;
  enabled: boolean;
  timezone: string;
  schedule: TaskSchedule;
  target: TaskTarget;
  notify?: boolean;
  timeoutMinutes?: number;
}

export interface ScheduledTaskOptions {
  projects: Project[];
  profiles: Profile[];
  catalog: AiCatalog;
}

/** `scheduled-task-run` 事件载荷。 */
export interface ScheduledTaskRunEvent {
  taskId: string;
  run: ScheduledRun;
  task: ScheduledTask;
}

/** `scheduled-tasks-changed` 事件载荷。 */
export interface ScheduledTasksChangedEvent {
  taskId?: string | null;
  action: string;
}

export const SCHEDULED_TASK_RUN_EVENT = 'scheduled-task-run';
export const SCHEDULED_TASKS_CHANGED_EVENT = 'scheduled-tasks-changed';

export function isRunActive(run: ScheduledRun | null | undefined): boolean {
  return run?.status === 'running' || run?.status === 'waitingApproval';
}
