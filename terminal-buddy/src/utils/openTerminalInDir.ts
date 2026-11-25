import { useAppStore } from '../stores/appStore';
import { buildClaudeRefCommand, startBlankTerminal } from '../services/tauri';
import type { Project } from '../types';
import { defaultShellType } from '../services/platform';
import { projectForDirectory } from './projectPath';
import { inheritableClaudeArgs } from './claudeLaunch';
import { buildCodexRefCommand } from './codexLaunch';
import { buildAntigravityLaunchCommand } from './antigravityLaunch';
import { currentAntigravityCommand, currentClaudeCommand, currentCodexCommand } from './agentCommands';

/**
 * 打开一个 PowerShell 终端标签到指定目录，行为等同“文件与 Git”面板右键菜单中的“在当前目录打开命令窗口”。
 * dir 缺省或为空时使用后端默认目录，且不设置会话目录。
 * 未显式传 groupName 时，按 dir 匹配已登记项目（项目根或其子目录）：项目目录下打开的
 * 命令行会话统一归到该项目分组，各入口不必各自传分组名。
 */
export async function openTerminalInDir(dir?: string, options?: {
  command?: string;
  name?: string;
  groupName?: string;
}): Promise<void> {
  const store = useAppStore.getState();
  if (store.splitMode !== 'off' && !store.splitSlots.some(s => s.sessionId === null)) {
    store.showToast('分屏模式已满，请先关闭某个分屏或退出分屏', 'info');
    return;
  }
  const groupName = options?.groupName
    ?? (dir ? projectForDirectory(store.projects, dir)?.name : undefined);
  const content = document.querySelector('.terminal-content');
  let estRows = 0, estCols = 0;
  if (content) {
    estCols = Math.max(2, Math.floor((content.clientWidth - 20) / 8.4));
    estRows = Math.max(1, Math.floor((content.clientHeight - 20) / 17));
  }
  const terminalId = await startBlankTerminal(
    defaultShellType(), estRows, estCols, dir, options?.name, options?.command,
    // 项目启动时把项目名写进后端分组，手机端与重启恢复都依赖它。
    groupName,
  );
  useAppStore.getState().addSession({
    id: terminalId,
    profileId: '',
    profileName: options?.name || (defaultShellType() === 'bash' ? 'Bash' : 'PowerShell'),
    groupName,
    startupPath: dir,
    // 空白终端没有配置命令，保存完整启动命令，供会话右键再次启动。
    extraParams: options?.command,
    extraParamMode: options?.command !== undefined ? 'independent' : undefined,
    terminalType: defaultShellType(),
    colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
    tabColor: null,
    groupId: 'default',
  });
  const st = useAppStore.getState();
  if (st.splitMode !== 'off') st.placeSessionInSplitSlot(terminalId);
  if (dir) st.setSessionDirectory(terminalId, dir);
}

/** 项目启动统一入口：在项目目录打开空白终端（命令行入口），不创建持久化配置。 */
export async function openProjectTerminal(project: Project): Promise<void> {
  try {
    await openTerminalInDir(project.path, {
      name: project.name,
      groupName: project.name,
    });
  } catch (error) {
    useAppStore.getState().showToast('启动项目失败：' + String(error), 'error');
  }
}

/** 项目 Agent 模型启动（「项目与命令」右键与会话标签栏悬停菜单共用）：
 * 按 Agent 组装引用命令注入项目终端，Agent 管理的基础命令参数一并继承；
 * 失败时按 Agent 名称提示。 */
export async function openProjectAgentTerminal(
  project: Project,
  source: 'claude' | 'codex',
  providerId: string,
  modelId: string,
): Promise<void> {
  const command = source === 'claude'
    ? buildClaudeRefCommand(providerId, modelId, inheritableClaudeArgs(undefined, currentClaudeCommand()))
    : buildCodexRefCommand(providerId, modelId, currentCodexCommand());
  try {
    await openTerminalInDir(project.path, { command, name: project.name, groupName: project.name });
  } catch (error) {
    const label = source === 'claude' ? '模型' : 'Codex 模型';
    useAppStore.getState().showToast(`${label}启动失败：${String(error)}`, 'error');
  }
}

/** 项目 Antigravity CLI 启动：使用内置或自定义的 `agy` 基础命令在项目终端启动。 */
export async function openProjectAntigravityTerminal(project: Project, accountId?: string | null): Promise<void> {
  try {
    const command = buildAntigravityLaunchCommand(currentAntigravityCommand(), accountId);
    await openTerminalInDir(project.path, { command, name: project.name, groupName: project.name });
  } catch (error) {
    useAppStore.getState().showToast(`Antigravity CLI 启动失败：${String(error)}`, 'error');
  }
}
