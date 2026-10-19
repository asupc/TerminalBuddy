import { request } from './connection';
import {
  getTerminalBuddyUpdate,
  markTerminalUpdating,
  setTerminalBuddyUpdate,
  type TerminalBuddyUpdatePhase,
  type TerminalBuddyUpdateStatus,
} from './updateState';

interface TerminalBuddyUpdateMarker {
  phase: TerminalBuddyUpdatePhase;
  id: string;
}

export interface TerminalBuddyUpdateStatusResponse {
  updateId: string;
  status: TerminalBuddyUpdateStatus;
  log: string;
}

const markerPattern = /\x1b\]7777;terminal-buddy-update;(start|switch|end|failed);([A-Za-z0-9_.-]+)(?:\x07|\x1b\\)/g;
const pendingOutput = new Map<string, string>();

export function parseTerminalBuddyUpdateMarkers(buffer: string): TerminalBuddyUpdateMarker[] {
  return Array.from(buffer.matchAll(markerPattern), match => ({
    phase: match[1] as TerminalBuddyUpdatePhase,
    id: match[2],
  }));
}

export function terminalBuddyUpdateText(output: string): string {
  return output
    .replace(markerPattern, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** 在传输层收集日志，旧 PTY 卸载后监视窗口仍然存活。 */
export function handleTerminalBuddyUpdateOutput(terminalId: string, output: string): void {
  const previous = getTerminalBuddyUpdate();
  let collectOutput = !!previous && previous.terminalId === terminalId && !previous.reconnected;
  const combined = (pendingOutput.get(terminalId) ?? '') + output;
  const oscStart = combined.lastIndexOf('\x1b]');
  const incompleteOsc = oscStart >= 0 && !/(?:\x07|\x1b\\)/.test(combined.slice(oscStart));
  const pendingStart = incompleteOsc ? oscStart : combined.endsWith('\x1b') ? combined.length - 1 : combined.length;
  const complete = combined.slice(0, pendingStart);
  pendingOutput.set(terminalId, combined.slice(pendingStart));

  for (const marker of parseTerminalBuddyUpdateMarkers(complete)) {
    let current = getTerminalBuddyUpdate();
    if (marker.phase === 'start' && current?.id !== marker.id) {
      if (current) markTerminalUpdating(current.terminalId, false);
      collectOutput = true;
      current = {
        id: marker.id, terminalId, phase: 'start', status: 'running',
        localLog: '', serverLog: '', online: true, reconnected: false,
      };
    }
    if (!current || current.id !== marker.id) continue;
    // 重连回放可能包含旧的 start/switch 标记，不能倒退已经结束的状态。
    if (current.reconnected || current.phase === 'end' || current.phase === 'failed') continue;
    if (marker.phase === 'start' && current.phase === 'switch') continue;
    const finished = marker.phase === 'end' || marker.phase === 'failed';
    markTerminalUpdating(terminalId, !finished);
    setTerminalBuddyUpdate({
      ...current,
      phase: marker.phase,
      status: finished ? marker.phase === 'failed' ? 'failed' : 'updated' : current.status,
      reconnected: finished,
      serverLog: finished ? '' : current.serverLog,
    });
  }

  const current = getTerminalBuddyUpdate();
  if (!current || current.terminalId !== terminalId || !collectOutput) return;
  const text = terminalBuddyUpdateText(complete);
  if (text) setTerminalBuddyUpdate({ ...current, localLog: current.localLog + text });
}

export function forgetTerminalBuddyUpdateOutput(terminalId: string): void {
  pendingOutput.delete(terminalId);
}

export async function getTerminalBuddyUpdateStatus(id: string): Promise<TerminalBuddyUpdateStatusResponse> {
  return request<TerminalBuddyUpdateStatusResponse>(`/api/update/status?id=${encodeURIComponent(id)}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
}
