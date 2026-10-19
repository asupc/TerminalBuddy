import type { TerminalTaskSummary } from '../types';

export function terminalTaskTitle(name: string, task?: TerminalTaskSummary): string {
  return task?.summary ? `${task.summary} · ${name}` : name;
}

/** 运行记录尚未返回模型时，补充启动参数里明确选择的模型。 */
export function taskLaunchModel(command?: string): string | undefined {
  if (!command) return undefined;
  const reference = command.trimStart().match(/^__TB_(?:CLAUDE|CODEX)_REF__:[^:\s]+:([^\s]+)/);
  if (reference) return reference[1];
  const option = command.match(/(?:^|\s)(?:--model|-m)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return option?.slice(1).find(Boolean);
}
