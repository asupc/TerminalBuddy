import { invoke } from './../remoteWorkspace/core';
import type { ClaudeHistoryScanResult, ClaudeSessionItem, ClaudeSearchHit, ClaudeReplayPage } from './claudeHistory';

export function rescanCodexHistory(): Promise<ClaudeHistoryScanResult> {
  return invoke('codex_history_rescan');
}

export function listCodexHistory(
  includeArchived: boolean,
  projectDir?: string,
): Promise<ClaudeSessionItem[]> {
  return invoke('codex_history_list', { includeArchived, projectDir: projectDir ?? null });
}

export function searchCodexHistory(
  query: string,
  projectDir?: string,
): Promise<ClaudeSearchHit[]> {
  return invoke('codex_history_search', { query, projectDir: projectDir ?? null });
}

export function getCodexReplay(sessionId: string, offset: number, limit: number): Promise<ClaudeReplayPage> {
  return invoke('codex_history_get_replay', { sessionId, offset, limit });
}

export function renameCodexSessionRecord(sessionId: string, title: string): Promise<void> {
  return invoke('codex_history_rename', { sessionId, title });
}

export function setCodexSessionFlags(
  sessionId: string,
  options: { starred?: boolean; archived?: boolean },
): Promise<void> {
  return invoke('codex_history_set_flags', {
    sessionId,
    starred: options.starred ?? null,
    archived: options.archived ?? null,
  });
}

export function deleteCodexSessionRecord(sessionId: string): Promise<void> {
  return invoke('codex_history_delete', { sessionId });
}

export function deleteCodexSessionRecords(sessionIds: string[]): Promise<void> {
  return invoke('codex_history_delete_many', { sessionIds });
}

export function exportCodexSession(
  sessionId: string,
  format: 'markdown' | 'jsonl',
  destPath: string,
): Promise<void> {
  return invoke('codex_history_export', { sessionId, format, destPath });
}
