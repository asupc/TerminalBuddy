import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listenTauri } from './events';

export interface ClaudeHookOption {
  label: string;
  description?: string;
}

export interface ClaudeHookQuestion {
  question: string;
  header: string;
  options: ClaudeHookOption[];
  multiSelect: boolean;
}

export interface ClaudeHookDecisionEvent {
  decisionId: string;
  terminalId: string;
  questions: ClaudeHookQuestion[];
  expiresAt: number;
  occurredAt: number;
}

export interface ClaudeHookDecisionLifecycleEvent {
  decisionId: string;
  terminalId: string;
  occurredAt: number;
  resolution?: 'answered' | 'continueInTerminal';
}

export type ClaudeHookTerminalPhase = 'idle' | 'running' | 'attention' | 'completed' | 'failed' | 'ended';

export interface ClaudeHookTerminalEvent {
  eventId: string;
  terminalId: string;
  sessionId: string;
  eventName: string;
  phase: ClaudeHookTerminalPhase;
  occurredAt: number;
  notificationType?: 'permission_prompt' | 'idle_prompt' | string;
  title?: string;
  message?: string;
  taskTitle?: string;
  summary?: string;
}

export interface ClaudeHookSettingsStatus {
  configDir: string;
  settingsPath: string;
  status: 'notInstalled' | 'partialInstalled' | 'installed' | 'invalid';
  installedEvents: string[];
  missingEvents: string[];
  serverRunning: boolean;
  serverPort: number;
  error?: string;
}

export async function answerClaudeHookDecision(decisionId: string, answers: Record<string, string>): Promise<void> {
  return invoke('answer_claude_hook_decision', { decisionId, answers });
}

export async function continueClaudeHookInTerminal(decisionId: string): Promise<void> {
  return invoke('continue_claude_hook_in_terminal', { decisionId });
}

export async function getPendingClaudeHookDecisions(): Promise<ClaudeHookDecisionEvent[]> {
  return invoke('get_pending_claude_hook_decisions');
}

export async function sendClaudeHookDecisionNotification(decisionId: string): Promise<void> {
  return invoke('send_claude_hook_decision_notification', { decisionId });
}

export async function onClaudeHookDecision(callback: (payload: ClaudeHookDecisionEvent) => void): Promise<UnlistenFn> {
  return listenTauri<ClaudeHookDecisionEvent>('claude-hook-decision', callback);
}

export async function onClaudeHookDecisionExpired(callback: (payload: ClaudeHookDecisionLifecycleEvent) => void): Promise<UnlistenFn> {
  return listenTauri<ClaudeHookDecisionLifecycleEvent>('claude-hook-decision-expired', callback);
}

export async function onClaudeHookDecisionResolved(callback: (payload: ClaudeHookDecisionLifecycleEvent) => void): Promise<UnlistenFn> {
  return listenTauri<ClaudeHookDecisionLifecycleEvent>('claude-hook-decision-resolved', callback);
}

export async function onClaudeHookTerminalEvent(callback: (payload: ClaudeHookTerminalEvent) => void): Promise<UnlistenFn> {
  return listenTauri<ClaudeHookTerminalEvent>('claude-hook-terminal-event', callback);
}

export async function getClaudeHookSettingsStatus(selectedDir?: string): Promise<ClaudeHookSettingsStatus> {
  return invoke('get_claude_hook_settings_status', { selectedDir: selectedDir || null });
}

export async function saveClaudeHookConfigDir(selectedDir?: string): Promise<void> {
  return invoke('save_claude_hook_config_dir', { selectedDir: selectedDir || null });
}

export async function installClaudeHooks(selectedDir?: string): Promise<ClaudeHookSettingsStatus> {
  return invoke('install_claude_hooks', { selectedDir: selectedDir || null });
}

export async function repairClaudeHooks(selectedDir?: string): Promise<ClaudeHookSettingsStatus> {
  return invoke('repair_claude_hooks', { selectedDir: selectedDir || null });
}

export async function uninstallClaudeHooks(selectedDir?: string): Promise<ClaudeHookSettingsStatus> {
  return invoke('uninstall_claude_hooks', { selectedDir: selectedDir || null });
}
