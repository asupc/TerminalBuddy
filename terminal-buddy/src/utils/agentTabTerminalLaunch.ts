import { aiSessionGet, buildClaudeRefCommand, type AiSession } from '../services/tauri';
import { buildCodexRefCommand } from './codexLaunch';
import { currentAntigravityCommand, currentClaudeCommand, currentCodexCommand } from './agentCommands';
import { inheritableClaudeArgs } from './claudeLaunch';
import { openTerminalInDir } from './openTerminalInDir';
import { projectForDirectory } from './projectPath';
import { useAppStore, type NativeAgentTab } from '../stores/appStore';

/**
 * 原生会话快照里的 `providerId` 是目录 ID（`llm:` / `claude:` / `codex:` / `default:`），
 * 而终端命令里的引用标记只由 `llm_provider_service`（Claude，`llm:`）与
 * `codex_provider_service`（Codex，`codex:`）展开。
 * 因此只有这两种来源能原样复用；`claude:` 是 Docker 网页端旧供应商链路
 * （SQLite + 改写 settings.json）的 ID，终端没有对应展开实现，只能退回基础命令。
 */
function terminalRef(session: AiSession): { providerId: string; modelId: string } | null {
  const providerId = session.providerId ?? '';
  const sep = providerId.indexOf(':');
  if (sep <= 0) return null;
  const source = providerId.slice(0, sep);
  const id = providerId.slice(sep + 1);
  const modelId = session.model ?? '';
  // 引用展开要求 modelId 非空，否则拒绝启动；空模型按「服务端默认」处理。
  if (!id || !modelId.trim()) return null;
  if (session.provider === 'codex') return source === 'codex' ? { providerId: id, modelId } : null;
  return source === 'llm' ? { providerId: id, modelId } : null;
}

/**
 * 说明「以此配置新建终端」实际会沿用什么。返回 `exact=false` 表示该供应商
 * 无法映射为终端引用（如 Docker 旧链路的 `claude:`），只能按 Agent 基础命令启动。
 */
export function describeAgentLaunchConfig(session: AiSession | null): { exact: boolean; hint: string } {
  if (!session) return { exact: false, hint: '会话已不可读取，将按 Agent 基础命令启动' };
  if (terminalRef(session)) return { exact: true, hint: '沿用该会话的供应商与模型启动（不续接原会话）' };
  return { exact: false, hint: '该供应商仅支持原生会话，终端将按 Agent 基础命令启动' };
}

/** Agent 管理里配置的基础启动命令（未配置时是内置默认命令）。 */
function baseAgentCommand(provider: 'claude' | 'codex' | 'antigravity'): string | undefined {
  const raw = provider === 'codex'
    ? currentCodexCommand()
    : provider === 'antigravity'
      ? currentAntigravityCommand()
      : currentClaudeCommand();
  const command = raw.trim();
  return command || undefined;
}

/**
 * 以原生会话的配置（项目目录 + 供应商 + 模型）新开一个终端标签。
 * 只复用启动配置，不续接原会话（不带 --resume / resume）。
 */
export async function launchTerminalFromAgentTab(tab: NativeAgentTab): Promise<void> {
  const store = useAppStore.getState();
  // 会话可能已被删除：拿不到快照时退回标签里保存的项目目录与 Agent 类型。
  const session = await aiSessionGet(tab.sessionId).catch(() => null);
  const projectPath = session?.projectPath ?? tab.projectPath;
  const provider = session?.provider ?? tab.provider;
  const project = projectPath ? projectForDirectory(store.projects, projectPath) : undefined;
  const ref = session ? terminalRef(session) : null;
  const command = ref
    ? provider === 'codex'
      ? buildCodexRefCommand(ref.providerId, ref.modelId, currentCodexCommand())
      : buildClaudeRefCommand(ref.providerId, ref.modelId, inheritableClaudeArgs(undefined, currentClaudeCommand()))
    : baseAgentCommand(provider);
  try {
    await openTerminalInDir(projectPath || undefined, {
      command,
      name: project?.name || (provider === 'codex' ? 'Codex' : provider === 'antigravity' ? 'Antigravity' : 'Claude Code'),
      groupName: project?.name,
    });
  } catch (error) {
    useAppStore.getState().showToast('启动终端失败：' + String(error), 'error');
  }
}
