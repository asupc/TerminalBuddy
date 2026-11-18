import { invoke } from './../remoteWorkspace/core';
import type { UnlistenFn } from './../remoteWorkspace/events';
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
  provider?: 'claude';
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
  provider?: 'claude' | 'codex';
  notificationType?: 'permission_prompt' | 'idle_prompt' | string;
  title?: string;
  message?: string;
  taskTitle?: string;
  summary?: string;
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
