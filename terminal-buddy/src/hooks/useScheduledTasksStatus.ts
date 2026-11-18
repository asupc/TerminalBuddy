import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from './../services/remoteWorkspace/events';
import { listenTauri, scheduledTaskList } from '../services/tauri';
import {
  SCHEDULED_TASK_RUN_EVENT,
  SCHEDULED_TASKS_CHANGED_EVENT,
  type ScheduledTaskView,
} from '../types/scheduledTask';

export interface ScheduledTasksStatusState {
  tasks: ScheduledTaskView[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * 状态栏「定时」入口的数据源：挂载时加载一次、每 30 秒轮询、任务变化事件立即刷新。
 * 只承担图标 / 数量 / 下次运行时间，不承担定时任务页面的完整数据。
 */
export function useScheduledTasksStatus(enabled = true): ScheduledTasksStatusState {
  const [tasks, setTasks] = useState<ScheduledTaskView[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  // 快速切换（重连、事件风暴）时丢弃过期响应，避免旧快照覆盖新快照。
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++requestRef.current;
    try {
      const next = await scheduledTaskList();
      if (request !== requestRef.current) return;
      setTasks(next);
      setError(null);
    } catch (reason) {
      if (request !== requestRef.current) return;
      // 请求失败静默保留上次数据，只在 tooltip 提示状态暂不可用。
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    void refresh();
    // 与后端调度 tick（30 秒）对齐。
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    const subscribe = (event: string) => {
      void listenTauri(event, () => { void refresh(); }).then(unlisten => {
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
  }, [enabled, refresh]);

  return { tasks, loading, error, refresh };
}
