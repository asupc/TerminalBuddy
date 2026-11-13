import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listenTauri } from './events';
import { isBrowserClient } from '../platform';
import type { ExtraParamMode } from '../../types';
import type { AiTokenUsage } from './aiChat';

// Terminal Commands
export async function startTerminal(profileId: string, extraStartupParams?: string, initialRows?: number, initialCols?: number, displayName?: string, startupPath?: string, extraParamTag?: string, extraParamTagColor?: string | null, extraStartupMode?: ExtraParamMode, injectClaudeHooks?: boolean): Promise<string> {
  return invoke('start_terminal', { profileId, displayName: displayName || null, extraStartupParams: extraStartupParams || null, extraStartupMode: extraStartupMode || null, initialRows: initialRows || 0, initialCols: initialCols || 0, startupPath: startupPath || null, extraParamTag: extraParamTag || null, extraParamTagColor: extraParamTagColor ?? null, injectClaudeHooks: injectClaudeHooks ?? null });
}

export async function updateTerminalDisplayName(id: string, displayName: string): Promise<void> {
  return invoke('update_terminal_display_name', { id, displayName });
}

export async function startMstsc(profileId: string): Promise<void> {
  return invoke('start_mstsc', { profileId });
}

export async function getClaudeSessionsForTerminals(terminalIds: string[]): Promise<Record<string, string>> {
  return invoke('get_claude_sessions_for_terminals', { terminalIds });
}

export async function getAgentSessionsForTerminals(
  terminalIds: string[],
): Promise<Record<string, import('../../types').AgentSessionRecord>> {
  return invoke('get_agent_sessions_for_terminals', { terminalIds });
}

/** 终端内 Agent 的实时用量快照（来自 CLI transcript）；终端没有绑定 Agent 时返回 null。 */
export interface TerminalAgentUsage {
  provider: 'claude' | 'codex' | string;
  model: string | null;
  effort: string | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  total: AiTokenUsage;
  updatedAt: number;
}

export async function getTerminalAgentUsage(terminalId: string): Promise<TerminalAgentUsage | null> {
  return invoke('terminal_agent_usage', { terminalId });
}

export async function showClaudeCodeNotification(
  terminalId: string,
  terminalName: string,
  notificationKind: 'confirmation' | 'question' | 'completed' | 'failed',
  customTitle?: string,
  customSummary?: string,
): Promise<void> {
  return invoke('show_claude_code_notification', {
    terminalId,
    terminalName,
    notificationKind,
    customTitle: customTitle || null,
    customSummary: customSummary || null,
  });
}

export async function onClaudeNotificationActivated(callback: (terminalId: string) => void): Promise<UnlistenFn> {
  return listenTauri<string>('claude-notification-activated', callback);
}

export async function startBlankTerminal(terminalType: 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh' | 'ssh' | 'docker' | 'k8s' | 'editor' | 'mstsc', initialRows?: number, initialCols?: number, startupPath?: string, displayName?: string, initialCommand?: string, extraParamTag?: string, extraParamTagColor?: string | null, groupName?: string, injectClaudeHooks?: boolean): Promise<string> {
  // groupName 写入后端分组（项目启动传项目名），容器重启恢复后手机端才能按项目分组。
  return invoke('start_blank_terminal', { terminalType, displayName: displayName || null, initialRows: initialRows || 0, initialCols: initialCols || 0, startupPath: startupPath || null, initialCommand: initialCommand || null, extraParamTag: extraParamTag || null, extraParamTagColor: extraParamTagColor ?? null, groupOverride: groupName || null, injectClaudeHooks: injectClaudeHooks ?? null });
}

/** 后端存活终端（与 Rust `TerminalInfo` 的 camelCase 序列化一致）。 */
export interface BackendTerminalInfo {
  id: string;
  profileId: string;
  profileName: string;
  group: string;
  /** 无 profile 的会话（默认终端 handoff、空白终端）为空串。 */
  terminalType: string;
  loadingMode: string;
  owner: 'pc' | 'web';
  extraParamTag?: string;
  extraParamTagColor?: string;
  extraStartupParams?: string;
  extraStartupMode?: ExtraParamMode;
  /** 会话当前目录（启动目录或最近 cd 上报），跨端跟随文件导航/会话历史用。 */
  directory?: string | null;
}

/** 列出后端当前存活的终端会话，供桌面端启动后与页签对账。 */
export async function listTerminals(): Promise<BackendTerminalInfo[]> {
  return invoke('list_terminals');
}

/** 把检测到的会话目录上报给后端：后端存为权威值并广播给所有端。 */
export async function reportSessionDirectory(id: string, directory: string): Promise<void> {
  return invoke('report_session_directory', { id, directory });
}

export async function writeToTerminal(id: string, data: string): Promise<void> {
  return invoke('write_to_terminal', { id, data });
}

export async function resizeTerminal(
  id: string,
  rows: number,
  cols: number
): Promise<void> {
  return invoke('resize_terminal', { id, rows, cols });
}

export async function closeTerminal(id: string): Promise<void> {
  return invoke('close_terminal', { id });
}

export async function drainTerminalOutput(id: string): Promise<string> {
  return invoke('drain_terminal_output', { id });
}

export async function onTerminalOutput(
  terminalId: string,
  callback: (output: string) => void
): Promise<UnlistenFn> {
  if (isBrowserClient()) {
    const { subscribeTerminal } = await import('../browser/core');
    return subscribeTerminal(terminalId, callback);
  }
  return listenTauri<string>(`terminal_output_${terminalId}`, callback);
}
