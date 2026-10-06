import { invoke } from '@tauri-apps/api/core';

export interface ClaudeSessionItem {
  sessionId: string;
  projectDir: string;
  filePath: string;
  title: string;
  customTitle: string | null;
  startedAt: number | null;
  updatedAt: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  starred: boolean;
  archived: boolean;
}

export interface ClaudeSearchHit {
  sessionId: string;
  title: string;
  projectDir: string;
  snippet: string;
  seq: number;
  timestamp: number | null;
  updatedAt: number;
}

export interface ClaudeReplayTool {
  name: string;
  summary: string;
}

export interface ClaudeReplayMessage {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  timestamp: number | null;
  text: string;
  tools: ClaudeReplayTool[];
  toolName: string | null;
}

export interface ClaudeReplayPage {
  total: number;
  messages: ClaudeReplayMessage[];
  title: string;
  projectDir: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: number | null;
  updatedAt: number;
}

export interface ClaudeHistoryScanResult {
  scanned: number;
  updated: number;
  total: number;
  /** 本批之后仍需索引的会话数；>0 表示后台补齐任务还在跑 */
  pending: number;
}

export function rescanClaudeHistory(): Promise<ClaudeHistoryScanResult> {
  return invoke('claude_history_rescan');
}

export function listClaudeHistory(
  includeArchived: boolean,
  projectDir?: string,
): Promise<ClaudeSessionItem[]> {
  return invoke('claude_history_list', { includeArchived, projectDir: projectDir ?? null });
}

export function searchClaudeHistory(
  query: string,
  projectDir?: string,
): Promise<ClaudeSearchHit[]> {
  return invoke('claude_history_search', { query, projectDir: projectDir ?? null });
}

export function getClaudeReplay(sessionId: string, offset: number, limit: number): Promise<ClaudeReplayPage> {
  return invoke('claude_history_get_replay', { sessionId, offset, limit });
}

export function renameClaudeSessionRecord(sessionId: string, title: string): Promise<void> {
  return invoke('claude_history_rename', { sessionId, title });
}

export function setClaudeSessionFlags(
  sessionId: string,
  options: { starred?: boolean; archived?: boolean },
): Promise<void> {
  return invoke('claude_history_set_flags', {
    sessionId,
    starred: options.starred ?? null,
    archived: options.archived ?? null,
  });
}

export function deleteClaudeSessionRecord(sessionId: string): Promise<void> {
  return invoke('claude_history_delete', { sessionId });
}

export function deleteClaudeSessionRecords(sessionIds: string[]): Promise<void> {
  return invoke('claude_history_delete_many', { sessionIds });
}

export function exportClaudeSession(
  sessionId: string,
  format: 'markdown' | 'jsonl',
  destPath: string,
): Promise<void> {
  return invoke('claude_history_export', { sessionId, format, destPath });
}
