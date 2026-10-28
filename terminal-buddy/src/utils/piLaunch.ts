import { parseClaudeRef } from './claudeLaunch';
import { parseCodexRef } from './codexLaunch';

/** Pi 默认信任已登记项目；可在 Agent 管理改回 `pi` 关闭。 */
export const DEFAULT_PI_COMMAND = 'pi --approve';

/** 引用标记前缀：`__TB_PI_REF__:<providerId>:<modelId>[:thinking]`。 */
export const PI_REF_PREFIX = '__TB_PI_REF__:';

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function isPiCommand(command: string): boolean {
  return /(?:^|[\s"'=])pi(?:\.cmd|\.exe|\.bat)?(?=$|[\s"'=])/i.test(command);
}

/** 解析 Pi 模型引用；thinking 缺省时返回 undefined。
 * 模型 ID 可能自带冒号（如 `cn:mimo-v2.6-pro`）：provider 取首个冒号前，
 * 仅当末段恰为合法思考级别时才剥离为 thinking，其余冒号段全部归 model。 */
export function parsePiRef(command: string): { providerId: string; modelId: string; thinking?: string } | null {
  const token = command.trimStart().split(/\s/, 1)[0] ?? '';
  if (!token.startsWith(PI_REF_PREFIX)) return null;
  const rest = token.slice(PI_REF_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  const providerId = rest.slice(0, sep);
  let modelId = rest.slice(sep + 1);
  let thinking: string | undefined;
  const tail = modelId.lastIndexOf(':');
  const level = tail > 0 ? modelId.slice(tail + 1) : '';
  if (PI_THINKING_LEVELS.includes(level)) {
    thinking = level;
    modelId = modelId.slice(0, tail);
  }
  return { providerId, modelId, thinking };
}

/** 与模型引用展开冲突的参数：展开结果自带同名 flag，须从基础命令中剔除。 */
const PI_CONFLICT_ARG_RE = /(^|\s)--(model|provider|thinking|models|api-key)(=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?/gi;

function piArgsFromCommand(command: string): string {
  const match = command.match(/(?:[\s"'=]|^)pi(?:\.cmd|\.exe|\.bat)?["']?(?=$|\s)/i);
  if (!match || match.index === undefined) return '';
  const rest = command.slice(match.index + match[0].length);
  return (rest.split(/&&|\|\||;|\|/, 1)[0] ?? '').trim();
}

function stripPiConflictArgs(args: string): string {
  return args.replace(PI_CONFLICT_ARG_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** 从项目/连接启动命令里继承 Pi 参数（如 `--approve`），冲突参数剔除。 */
export function inheritablePiArgs(source: string | string[] | undefined, fallbackCommand = ''): string {
  const commands = typeof source === 'string' ? [source] : source ?? [];
  const command = commands.find(isPiCommand) ?? fallbackCommand;
  if (!command) return '';
  return stripPiConflictArgs(piArgsFromCommand(command));
}

/** 构造 Pi 模型引用命令；真正展开为 `--provider/--model/--thinking` 在后端启动时完成。 */
export function buildPiRefCommand(
  providerId: string,
  modelId: string,
  thinking?: string,
  source?: string | string[],
): string {
  const inherited = inheritablePiArgs(source);
  const marker = `${PI_REF_PREFIX}${providerId}:${modelId}${thinking ? `:${thinking}` : ''}`;
  return [marker, inherited].filter(Boolean).join(' ');
}

/** 历史恢复命令：没有模型引用时继承基础命令；有引用时由后端展开。 */
export function buildPiResumeCommand(
  sessionIdOrFile: string,
  source?: string | string[],
  vendorRef?: { providerId: string; modelId: string; thinking?: string },
  extraParams?: string,
): string {
  const trimmed = sessionIdOrFile.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) throw new Error('Pi 会话路径无效');
  const head = vendorRef
    ? buildPiRefCommand(vendorRef.providerId, vendorRef.modelId, vendorRef.thinking, source)
    : (() => {
        const commands = typeof source === 'string' ? [source] : source ?? [];
        // 恢复快照里可能只保留了 Pi 模型引用命令；保留引用标记，交给后端启动时展开。
        const reference = commands.find(command => parsePiRef(command));
        if (reference) {
          return reference.trim().split(/&&|\|\||;|\|/, 1)[0].trim();
        }
        const base = commands.find(isPiCommand) ?? DEFAULT_PI_COMMAND;
        // 只保留 pi 及其同一条命令内的参数，避免把 shell 分隔符后的命令带进来。
        const args = stripPiConflictArgs(piArgsFromCommand(base));
        return [base.trimStart().split(/\s/, 1)[0], args].filter(Boolean).join(' ');
      })();
  return [head, '--session', JSON.stringify(trimmed), extraParams?.trim()].filter(Boolean).join(' ');
}

/** 从命令中读取 Pi 的 `--session` 值（用于判断某会话是否已在终端中运行）。 */
export function resumedPiSessionId(command?: string): string | undefined {
  if (!command || (!isPiCommand(command) && !parsePiRef(command))) return undefined;
  const match = command.match(/(?:^|\s)--session(?:\s+|=)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/);
  if (!match) return undefined;
  return match[1].replace(/^['"]|['"]$/g, '');
}

/** 从命令中提取 Pi 模型（`--model` 或引用标记），供标签 chip 使用。 */
export function piModelFromCommand(command?: string): string | undefined {
  if (!command) return undefined;
  const ref = parsePiRef(command);
  if (ref) return ref.modelId;
  if (!isPiCommand(command)) return undefined;
  return command.match(/(?:^|\s)--model(?:\s+|=)("[^"]+"|'[^']+'|[^\s]+)/)?.[1]?.replace(/^['"]|['"]$/g, '');
}

/** 与 Claude/Codex 共用标签解析时识别 Pi 模型。 */
export function parseAnyModelRef(command?: string): { providerId: string; modelId: string } | null {
  if (!command) return null;
  const pi = parsePiRef(command);
  if (pi) return { providerId: pi.providerId, modelId: pi.modelId };
  return parseCodexRef(command) ?? parseClaudeRef(command);
}
