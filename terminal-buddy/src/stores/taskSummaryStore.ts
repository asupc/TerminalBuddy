import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { applyTerminalEvent } from '../services/claudeNotification';
import type { ClaudeHookTerminalEvent } from '../services/tauri/claudeHook';

export type TaskSummaryProvider = 'claude' | 'codex' | 'antigravity';

export interface TerminalTaskSummary {
  provider: TaskSummaryProvider;
  sessionId: string;
  summary: string;
  model?: string;
}

interface TaskSummaryState {
  enabled: boolean;
  summaries: Record<string, TerminalTaskSummary>;
  providers: Record<string, TaskSummaryProvider>;
  saving: boolean;
  error: string | null;
}

export const useTaskSummaryStore = create<TaskSummaryState>(() => ({
  enabled: false,
  summaries: {},
  providers: {},
  saving: false,
  error: null,
}));

let settingsRevision = 0;

export async function refreshTaskSummaries(terminalIds: string[]): Promise<void> {
  const revision = settingsRevision;
  const result = await invoke<
    Pick<TaskSummaryState, 'enabled' | 'summaries'> & {
      activities?: Record<string, ClaudeHookTerminalEvent>;
      providers?: Record<string, TaskSummaryProvider>;
    }
  >('get_terminal_task_summaries', { terminalIds });
  // 状态恢复独立于摘要设置；快照只恢复灯态，不重发历史完成通知。
  for (const event of Object.values(result.activities ?? {})) {
    if (terminalIds.includes(event.terminalId)) applyTerminalEvent(event, false);
  }
  if (revision !== settingsRevision || useTaskSummaryStore.getState().saving) return;
  const previous = useTaskSummaryStore.getState();
  const nextSummaries = result.enabled ? result.summaries : {};
  const nextProviders = result.providers ?? {};
  if (
    previous.enabled !== result.enabled
    || JSON.stringify(previous.summaries) !== JSON.stringify(nextSummaries)
    || JSON.stringify(previous.providers) !== JSON.stringify(nextProviders)
  ) {
    useTaskSummaryStore.setState({ enabled: result.enabled, summaries: nextSummaries, providers: nextProviders });
  }
}

export async function setTaskSummaryEnabled(enabled: boolean): Promise<void> {
  if (useTaskSummaryStore.getState().saving) return;
  settingsRevision += 1;
  useTaskSummaryStore.setState({ saving: true, error: null });
  try {
    await invoke('save_show_task_summary', { enabled });
    settingsRevision += 1;
    useTaskSummaryStore.setState({ enabled, ...(!enabled ? { summaries: {} } : {}) });
  } catch (error) {
    useTaskSummaryStore.setState({ error: `保存任务摘要设置失败：${String(error)}` });
  } finally {
    useTaskSummaryStore.setState({ saving: false });
    window.dispatchEvent(new Event('terminal-task-summary-changed'));
  }
}

/** 横向会话标签只显示摘要，未取得摘要时显示原名称；手动重命名过的会话固定显示手动名称。 */
export function terminalTabTitle(name: string, task?: TerminalTaskSummary, manualTitle?: boolean): string {
  return !manualTitle && task?.summary ? task.summary : name;
}

/** 活动窗口和分屏标题保留原名称作为上下文；手动重命名过的会话不再附带摘要。 */
export function terminalDisplayTitle(name: string, task?: TerminalTaskSummary, manualTitle?: boolean): string {
  return !manualTitle && task?.summary ? `${task.summary} · ${name}` : name;
}
