import type { TerminalTaskSummary } from '../types';

/** 拼接式标题：摘要 · 名称；手动重命名过的会话只显示手动名称。 */
export function terminalTaskTitle(name: string, task?: TerminalTaskSummary, manualTitle?: boolean): string {
  return !manualTitle && task?.summary ? `${task.summary} · ${name}` : name;
}

export interface TaskLaunchInfo {
  provider: 'claude' | 'codex';
  model?: string;
}

/** 摘要尚未返回时，从实际启动命令识别工具和模型；独立命令不继承配置。 */
export function getTaskLaunchInfo(
  extraParams = '',
  startupCommands: string[] = [],
  mode?: 'append' | 'independent',
): TaskLaunchInfo | undefined {
  const commands = mode === 'independent' && extraParams.trim()
    ? [extraParams]
    : startupCommands.length > 0
      ? startupCommands.map(command => `${command} ${extraParams}`)
      : [extraParams];

  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    const reference = command.trimStart().match(/^__TB_(CLAUDE|CODEX)_REF__:[^:\s]+:([^\s]+)/);
    const executable = command.match(/(?:^|[\s"'=/\\;&|])(claude|codex)(?:\.(?:cmd|exe|bat|ps1))?(?=$|[\s"';&|])/i);
    const tool = reference?.[1] || executable?.[1];
    if (!tool) continue;

    let model = reference?.[2];
    for (const option of command.matchAll(/(?:^|\s)(?:--model|-m)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g)) {
      model = option.slice(1).find(Boolean);
    }
    return { provider: tool.toLowerCase() === 'codex' ? 'codex' : 'claude', model };
  }
  return undefined;
}
