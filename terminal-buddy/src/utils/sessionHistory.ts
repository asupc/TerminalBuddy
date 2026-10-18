import type { SessionHistoryProvider } from '../types';

export function sessionReplayTabKey(tab: { sessionId: string; provider?: SessionHistoryProvider }): string {
  return `${tab.provider ?? 'claude'}:${tab.sessionId}`;
}
