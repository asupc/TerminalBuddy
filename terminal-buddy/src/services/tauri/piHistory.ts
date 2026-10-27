import { invoke } from '@tauri-apps/api/core';
import type { ClaudeHistoryScanResult, ClaudeSessionItem, ClaudeSearchHit, ClaudeReplayPage } from './claudeHistory';

export function rescanPiHistory(): Promise<ClaudeHistoryScanResult> {
  return invoke('pi_history_rescan');
}

export function listPiHistory(
  includeArchived: boolean,
  projectDir?: string,
): Promise<ClaudeSessionItem[]> {
  return invoke('pi_history_list', { includeArchived, projectDir: projectDir ?? null });
}

export function searchPiHistory(
  query: string,
  projectDir?: string,
): Promise<ClaudeSearchHit[]> {
  return invoke('pi_history_search', { query, projectDir: projectDir ?? null });
}

export function getPiReplay(sessionId: string, offset: number, limit: number): Promise<ClaudeReplayPage> {
  return invoke('pi_history_get_replay', { sessionId, offset, limit });
}

export function renamePiSessionRecord(sessionId: string, title: string): Promise<void> {
  return invoke('pi_history_rename', { sessionId, title });
}

export function setPiSessionFlags(
  sessionId: string,
  options: { starred?: boolean; archived?: boolean },
): Promise<void> {
  return invoke('pi_history_set_flags', {
    sessionId,
    starred: options.starred ?? null,
    archived: options.archived ?? null,
  });
}

export function deletePiSessionRecord(sessionId: string): Promise<void> {
  return invoke('pi_history_delete', { sessionId });
}

export function deletePiSessionRecords(sessionIds: string[]): Promise<void> {
  return invoke('pi_history_delete_many', { sessionIds });
}

export function exportPiSession(
  sessionId: string,
  format: 'markdown' | 'jsonl',
  destPath: string,
): Promise<void> {
  return invoke('pi_history_export', { sessionId, format, destPath });
}

export interface PiModel {
  id: string;
  thinking: string[];
  /** TerminalBuddy 卡片配置的默认思考级别；直接启动时作为 --thinking 传入。 */
  defaultThinking?: string;
}

export interface PiModelProvider {
  provider: string;
  /** 是否为 TerminalBuddy 设置的默认供应商（右键菜单平铺其模型）。 */
  isDefault?: boolean;
  models: PiModel[];
}

export function getPiModels(force = false): Promise<PiModelProvider[]> {
  return invoke('get_pi_models', { force });
}

export interface PiExtensionState {
  installed: boolean;
  path: string;
  globallyInstalled: boolean;
}

export function getPiExtensionState(): Promise<PiExtensionState> {
  return invoke('get_pi_extension_state');
}

export function installPiExtension(): Promise<void> {
  return invoke('install_pi_extension');
}

export function uninstallPiExtension(): Promise<void> {
  return invoke('uninstall_pi_extension');
}

export function savePiToolApprovalEnabled(enabled: boolean): Promise<void> {
  return invoke('save_pi_tool_approval_enabled', { enabled });
}
