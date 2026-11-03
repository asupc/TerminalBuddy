import { parseClaudeRef } from './claudeLaunch';
import { parseCodexRef } from './codexLaunch';

export interface TaskLaunchInfo {
  provider: 'claude' | 'codex';
  model?: string;
}

/** 引用标记前缀（工具名在首段）。 */
const REF_PREFIX_RE = /^__TB_(CLAUDE|CODEX)_REF__:/;

/** 命令里直接跑 claude/codex 的可执行文件。 */
const EXECUTABLE_RE = /(?:^|[\s"'=/\\;&|])(claude|codex)(?:\.(?:cmd|exe|bat|ps1))?(?=$|[\s"';&|])/i;

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
    // 模型 ID 可能自带冒号（如 `cn:mimo-v2.6-pro`），不能按冒号硬切，统一交给引用解析。
    const prefix = command.trimStart().match(REF_PREFIX_RE);
    const reference = prefix
      ? (parseCodexRef(command) ?? parseClaudeRef(command))
      : null;
    const executable = command.match(EXECUTABLE_RE);
    const tool = reference ? prefix?.[1] : executable?.[1];
    if (!tool) continue;

    let model = reference?.modelId;
    for (const option of command.matchAll(/(?:^|\s)(?:--model|-m)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g)) {
      model = option.slice(1).find(Boolean);
    }
    return { provider: tool.toLowerCase() === 'codex' ? 'codex' : 'claude', model };
  }
  return undefined;
}
