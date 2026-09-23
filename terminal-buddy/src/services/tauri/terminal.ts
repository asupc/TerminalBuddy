import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listenTauri } from './events';
import type { ExtraParamMode } from '../../types';

// Terminal Commands
export async function startTerminal(profileId: string, extraStartupParams?: string, initialRows?: number, initialCols?: number, displayName?: string, startupPath?: string, extraParamTag?: string, extraParamTagColor?: string | null, extraStartupMode?: ExtraParamMode): Promise<string> {
  return invoke('start_terminal', { profileId, displayName: displayName || null, extraStartupParams: extraStartupParams || null, extraStartupMode: extraStartupMode || null, initialRows: initialRows || 0, initialCols: initialCols || 0, startupPath: startupPath || null, extraParamTag: extraParamTag || null, extraParamTagColor: extraParamTagColor ?? null });
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

export async function startBlankTerminal(terminalType: 'powershell' | 'pwsh' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor' | 'mstsc', initialRows?: number, initialCols?: number, startupPath?: string, displayName?: string): Promise<string> {
  return invoke('start_blank_terminal', { terminalType, displayName: displayName || null, initialRows: initialRows || 0, initialCols: initialCols || 0, startupPath: startupPath || null });
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
  return listenTauri<string>(`terminal_output_${terminalId}`, callback);
}
