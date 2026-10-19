import type { TerminalTaskSummary } from '../types';

export function terminalTaskTitle(name: string, task?: TerminalTaskSummary): string {
  return task?.summary ? `${task.summary} · ${name}` : name;
}
