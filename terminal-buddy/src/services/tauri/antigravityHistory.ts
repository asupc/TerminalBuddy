import { invoke } from '@tauri-apps/api/core';
import type { ClaudeHistoryScanResult, ClaudeSessionItem, ClaudeSearchHit, ClaudeReplayPage } from './claudeHistory';

export function rescanAntigravityHistory(): Promise<ClaudeHistoryScanResult> {
  return invoke('antigravity_history_rescan');
}

export function listAntigravityHistory(
  includeArchived: boolean,
  projectDir?: string,
): Promise<ClaudeSessionItem[]> {
  return invoke('antigravity_history_list', { includeArchived, projectDir: projectDir ?? null });
}

export function searchAntigravityHistory(
  query: string,
  projectDir?: string,
): Promise<ClaudeSearchHit[]> {
  return invoke('antigravity_history_search', { query, projectDir: projectDir ?? null });
}

export function getAntigravityReplay(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<ClaudeReplayPage> {
  return invoke('antigravity_history_get_replay', { sessionId, offset, limit });
}

export function renameAntigravitySessionRecord(sessionId: string, title: string): Promise<void> {
  return invoke('antigravity_history_rename', { sessionId, title });
}

export function setAntigravitySessionFlags(
  sessionId: string,
  options: { starred?: boolean; archived?: boolean },
): Promise<void> {
  return invoke('antigravity_history_set_flags', {
    sessionId,
    starred: options.starred ?? null,
    archived: options.archived ?? null,
  });
}

export function deleteAntigravitySessionRecord(sessionId: string): Promise<void> {
  return invoke('antigravity_history_delete', { sessionId });
}

export function deleteAntigravitySessionRecords(sessionIds: string[]): Promise<void> {
  return invoke('antigravity_history_delete_many', { sessionIds });
}

export function exportAntigravitySession(
  sessionId: string,
  format: 'markdown' | 'jsonl',
  destPath: string,
): Promise<void> {
  return invoke('antigravity_history_export', { sessionId, format, destPath });
}
