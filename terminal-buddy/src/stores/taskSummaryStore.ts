import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface TerminalTaskSummary {
  provider: 'claude' | 'codex';
  sessionId: string;
  summary: string;
}

interface TaskSummaryState {
  enabled: boolean;
  summaries: Record<string, TerminalTaskSummary>;
  saving: boolean;
  error: string | null;
}

export const useTaskSummaryStore = create<TaskSummaryState>(() => ({
  enabled: false,
  summaries: {},
  saving: false,
  error: null,
}));

let settingsRevision = 0;

export async function refreshTaskSummaries(terminalIds: string[]): Promise<void> {
  const revision = settingsRevision;
  const result = await invoke<Pick<TaskSummaryState, 'enabled' | 'summaries'>>('get_terminal_task_summaries', { terminalIds });
  if (revision !== settingsRevision || useTaskSummaryStore.getState().saving) return;
  const previous = useTaskSummaryStore.getState();
  if (previous.enabled !== result.enabled || JSON.stringify(previous.summaries) !== JSON.stringify(result.summaries)) {
    useTaskSummaryStore.setState({ enabled: result.enabled, summaries: result.enabled ? result.summaries : {} });
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

/** 摘要放在前面，窄侧栏也能区分同一项目的窗口；原名称保持独立。 */
export function terminalDisplayTitle(name: string, task?: TerminalTaskSummary): string {
  return task?.summary ? `${task.summary} · ${name}` : name;
}
